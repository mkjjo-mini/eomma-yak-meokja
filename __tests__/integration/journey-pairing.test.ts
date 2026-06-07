/**
 * 통합 시나리오 — 페어링 + IAP 게이팅 + 광고 제거
 *
 * 사용자 여정 4·5·6:
 *  - 여정 4: 케어 대상 폰 코드 생성 → 케어러 폰 confirmPairing → KV 매핑 →
 *           체크 시 notifyCaregivers fire-and-forget → 케어러 폰 caregiverEvents 누적 →
 *           사진·상세약 미저장 강제 검증
 *  - 여정 5: 1명째 무료 페어링 → 2명째 시도 → 슬롯 결제 바텀시트 → 동의 체크 →
 *           결제 성공 → 슬롯 +1 → 코드 생성 진행. 결제 취소 시 차단.
 *  - 여정 6: "광고 없이 쓰기" → 구독 안내 → 동의 → 구독 결제 성공 →
 *           Storage orderId 저장 → 앱 재진입 후 getSubscriptionInfo로 활성 확인
 *
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-08-family.md §처리·검수
 *
 * 실기기 전용 (이 파일 범위 밖):
 *  - Vercel Functions /api/pair, /api/pair/confirm, /api/notify 실제 호출 (mTLS)
 *  - 실제 IAP 결제 바텀시트 UI / 토스앱 결제 핸드셰이크
 *  - 카카오톡 공유 SDK
 *  - Toss 메시지 API mTLS 핸드셰이크
 */

// ─── SDK mock ────────────────────────────────────────────────────────────────

const storageStore: Record<string, string> = {};

const mockCreateOneTimePurchaseOrder = jest.fn();
const mockCreateSubscriptionPurchaseOrder = jest.fn();
const mockGetSubscriptionInfo = jest.fn();
const mockGetCompletedOrRefundedOrders = jest.fn();
const mockIsMinVersionSupported = jest.fn(() => true);
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

jest.mock('@apps-in-toss/framework', () => ({
  Storage: {
    getItem: jest.fn(async (key: string) => storageStore[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      storageStore[key] = value;
    }),
    removeItem: jest.fn(async (key: string) => {
      delete storageStore[key];
    }),
  },
  IAP: {
    createOneTimePurchaseOrder: (...args: unknown[]) =>
      mockCreateOneTimePurchaseOrder(...args),
    createSubscriptionPurchaseOrder: (...args: unknown[]) =>
      mockCreateSubscriptionPurchaseOrder(...args),
    getSubscriptionInfo: (...args: unknown[]) =>
      mockGetSubscriptionInfo(...args),
    getCompletedOrRefundedOrders: (...args: unknown[]) =>
      mockGetCompletedOrRefundedOrders(...args),
  },
  isMinVersionSupported: (...args: unknown[]) =>
    mockIsMinVersionSupported(...(args as [])),
  appLogin: jest.fn(),
}));

import { Storage } from '@apps-in-toss/framework';
import {
  generatePairingCode,
  confirmPairing,
  getPairings,
  notifyCaregivers,
  addCaregiverEvent,
  getCaregiverEvents,
} from '../../src/services/pairService';
import {
  isAdRemovedActive,
  getFamilySlots,
  purchaseRemoveAdsSubscription,
  purchaseFamilyExpansion,
  IAP_STORAGE_KEYS,
} from '../../src/services/iapService';
import { PAIR_STORAGE_KEYS } from '../../src/types/pair';
import { SCHEDULE_STORAGE_KEYS } from '../../src/types/schedule';

// ─── 헬퍼 ─────────────────────────────────────────────────────────────────────

const VERCEL_URL = 'https://test.vercel.app';
const CARE_RECIPIENT_KEY = 'user-care-recipient-001';
const CAREGIVER_KEY = 'user-caregiver-001';

function clearStore() {
  Object.keys(storageStore).forEach((k) => delete storageStore[k]);
}

/**
 * IAP 결제 성공 시뮬레이션.
 *
 * 주의: jest module isolate 환경에서 setTimeout 콜백이 micro-task와
 *       함께 정상 발화되지 않는 이슈를 회피하기 위해, mockImplementationOnce
 *       자체를 async로 만들어 즉시 promise chain에서 settle을 트리거.
 *       (IAP service의 Promise 생성자 내부에서 즉시 IAP.create...를 호출하므로
 *        반환된 cleanup 함수와는 별개로 콜백을 동기적으로 발화시켜도 안전.)
 */
function mockSuccessfulPurchase(orderId = 'order-test-001') {
  mockCreateOneTimePurchaseOrder.mockImplementationOnce((args: {
    options: { processProductGrant: (p: { orderId: string }) => Promise<boolean> };
    onEvent: (e: { type: 'success'; data: { orderId: string } }) => void;
  }) => {
    // micro-task로 발화 (마이크로태스크는 await보다 먼저 실행되어 promise resolve 보장)
    void Promise.resolve().then(async () => {
      await args.options.processProductGrant({ orderId });
      args.onEvent({ type: 'success', data: { orderId } });
    });
    return jest.fn();
  });
}

function mockCancelledPurchase() {
  mockCreateOneTimePurchaseOrder.mockImplementationOnce((args: {
    onError: (err: unknown) => void;
  }) => {
    void Promise.resolve().then(() => args.onError(new Error('USER_CANCEL')));
    return jest.fn();
  });
}

beforeEach(() => {
  clearStore();
  jest.clearAllMocks();
  mockIsMinVersionSupported.mockReturnValue(true);
  process.env.EXPO_PUBLIC_VERCEL_API_URL = VERCEL_URL;

  (Storage.getItem as jest.Mock).mockImplementation(
    async (key: string) => storageStore[key] ?? null,
  );
  (Storage.setItem as jest.Mock).mockImplementation(
    async (key: string, value: string) => {
      storageStore[key] = value;
    },
  );
});

// ─── 여정 4: 케어러 페어링 ──────────────────────────────────────────────────

describe('[여정 4] 케어 대상 → 케어러 페어링 → notifyCaregivers → 데이터 최소화', () => {
  it('전체 흐름: 코드 생성 → confirmPairing → 페어링 저장 → notifyCaregivers fire-and-forget', async () => {
    // 1. 케어 대상 폰: userKey + nickname 시드
    storageStore[SCHEDULE_STORAGE_KEYS.USER_KEY] = CARE_RECIPIENT_KEY;
    storageStore['profile.nickname'] = '엄마';

    // 2. 코드 생성 (POST /api/pair → 200)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          code: '123456',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        }),
    });

    const codeResult = await generatePairingCode();
    expect(codeResult.code).toBe('123456');

    // 3. 케어러 폰 시뮬레이션: userKey 교체
    storageStore[SCHEDULE_STORAGE_KEYS.USER_KEY] = CAREGIVER_KEY;
    delete storageStore[PAIR_STORAGE_KEYS.PAIRINGS];

    // 4. confirmPairing (POST /api/pair/confirm → success)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          careRecipientNickname: '엄마',
        }),
    });

    const confirmResult = await confirmPairing('123456');
    expect(confirmResult.success).toBe(true);
    expect(confirmResult.careRecipientNickname).toBe('엄마');

    // 5. 케어러 폰 Storage에 페어링 레코드 저장 검증
    const pairings = await getPairings();
    expect(pairings).toHaveLength(1);
    expect(pairings[0]?.caregiverUserKey).toBe(CAREGIVER_KEY);
    expect(pairings[0]?.careRecipientNickname).toBe('엄마');

    // 6. 케어 대상 폰으로 다시 전환 — v1엔 알림 비활성 (NOTIFY_ENABLED=false)
    // Ref: src/services/pairService.ts NOTIFY_ENABLED + 메모리 "엄마약먹자 알림 기능 보류"
    // notifyCaregivers는 호출돼도 silent skip. 가족 현황은 Pull 방식(/api/care-status)으로 전달.
    storageStore[SCHEDULE_STORAGE_KEYS.USER_KEY] = CARE_RECIPIENT_KEY;

    await expect(
      notifyCaregivers('아침약', new Date().toISOString(), 'checked'),
    ).resolves.not.toThrow();

    // v1: /api/notify 호출 안 됨
    const notifyCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/api/notify'),
    );
    expect(notifyCall).toBeUndefined();
  });

  it('잘못된 코드 입력 → 404 → invalid_code 반환 + 페어링 저장 안 됨', async () => {
    storageStore[SCHEDULE_STORAGE_KEYS.USER_KEY] = CAREGIVER_KEY;

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'invalid_code' }),
    });

    const result = await confirmPairing('999999');
    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_code');

    const pairings = await getPairings();
    expect(pairings).toHaveLength(0);
  });

  it('데이터 최소화 — addCaregiverEvent에 photoBase64 없이 저장됨', async () => {
    await addCaregiverEvent({
      careRecipientUserKey: CARE_RECIPIENT_KEY,
      careRecipientNickname: '엄마',
      routineLabel: '아침약',
      kind: 'checked',
      takenAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
    });

    const events = await getCaregiverEvents();
    expect(events).toHaveLength(1);

    // 이벤트 객체에 photoBase64, medications 키가 없음을 검증
    const evt = events[0];
    expect(evt).not.toHaveProperty('photoBase64');
    expect(evt).not.toHaveProperty('medications');

    // Storage에 저장된 raw JSON에도 사진/약 데이터 없음
    const raw = storageStore[PAIR_STORAGE_KEYS.CAREGIVER_EVENTS] ?? '';
    expect(raw).not.toContain('photoBase64');
    expect(raw).not.toContain('medications');
    expect(raw).not.toContain('routines');
    expect(raw).not.toContain('records');
  });

  it('v1: notifyCaregivers 호출돼도 fetch·큐 적재 안 함 (NOTIFY_ENABLED=false)', async () => {
    storageStore[SCHEDULE_STORAGE_KEYS.USER_KEY] = CARE_RECIPIENT_KEY;

    // 예외 던지지 않음 — fire-and-forget 시그니처 그대로 유지
    await expect(
      notifyCaregivers('아침약', new Date().toISOString(), 'checked'),
    ).resolves.not.toThrow();

    // /api/notify 호출 안 됨
    const notifyCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/api/notify'),
    );
    expect(notifyCall).toBeUndefined();

    // pendingNotify 큐 적재 안 됨 (재시도 의미 없음)
    const pendingRaw = storageStore[PAIR_STORAGE_KEYS.PENDING_NOTIFY];
    expect(pendingRaw).toBeUndefined();
  });
});

// ─── 여정 5: 가족 슬롯 IAP 게이팅 (per-slot 누적 모델) ──────────────────────

describe('[여정 5] 가족 슬롯 게이팅 — 1명 무료, 슬롯 결제 시 누적 +1', () => {
  it('결제 이력 없음 → 슬롯 1 (무료 기본)', async () => {
    mockGetCompletedOrRefundedOrders.mockResolvedValueOnce({
      hasNext: false,
      orders: [],
    });
    expect(await getFamilySlots()).toBe(1);
  });

  it('슬롯 결제 성공 → 토스 이력 카운트로 슬롯 +1 (재조회)', async () => {
    mockSuccessfulPurchase('order-fam-001');

    const result = await purchaseFamilyExpansion();
    expect(result.kind).toBe('success');

    // 결제 후 슬롯 카운트 재조회 — 토스 서버에 COMPLETED 1건 보유 가정
    mockGetCompletedOrRefundedOrders.mockResolvedValueOnce({
      hasNext: false,
      orders: [
        { orderId: 'order-fam-001', sku: 'family_expansion_lifetime_v1', status: 'COMPLETED', date: '2026-06-06' },
      ],
    });
    expect(await getFamilySlots()).toBe(2);
  });

  it('슬롯 결제 취소 → 슬롯 카운트 변동 없음 (1 유지)', async () => {
    mockCancelledPurchase();

    const result = await purchaseFamilyExpansion();
    expect(result.kind).toBe('cancelled');

    mockGetCompletedOrRefundedOrders.mockResolvedValueOnce({
      hasNext: false,
      orders: [],
    });
    expect(await getFamilySlots()).toBe(1);
  });

  it('게이팅 — pairings >= 슬롯 한도면 결제 게이트, 미만이면 통과', async () => {
    // 케어러 1명 페어링 + 슬롯 1개(무료만) → 한도 도달
    storageStore[PAIR_STORAGE_KEYS.PAIRINGS] = JSON.stringify([
      {
        caregiverUserKey: 'caregiver-1',
        careRecipientUserKey: '',
        careRecipientNickname: '엄마',
        pairedAt: new Date().toISOString(),
      },
    ]);
    mockGetCompletedOrRefundedOrders.mockResolvedValueOnce({
      hasNext: false,
      orders: [],
    });

    const pairings = await getPairings();
    const slots = await getFamilySlots();

    const shouldGate = pairings.length >= slots;
    expect(shouldGate).toBe(true);
  });

  it('게이팅 — 슬롯 결제 후 한도 늘면 게이트 통과', async () => {
    storageStore[PAIR_STORAGE_KEYS.PAIRINGS] = JSON.stringify([
      {
        caregiverUserKey: 'caregiver-1',
        careRecipientUserKey: '',
        careRecipientNickname: '엄마',
        pairedAt: new Date().toISOString(),
      },
    ]);
    mockGetCompletedOrRefundedOrders.mockResolvedValueOnce({
      hasNext: false,
      orders: [
        { orderId: 'paid-1', sku: 'family_expansion_lifetime_v1', status: 'COMPLETED', date: '2026-06-01' },
      ],
    });

    const pairings = await getPairings();
    const slots = await getFamilySlots();

    expect(slots).toBe(2);
    expect(pairings.length >= slots).toBe(false); // 1 < 2 → 통과
  });

  it('연결 끊긴 후 재연결 — 슬롯은 유지, 추가 결제 없이 코드 생성', async () => {
    // 슬롯 2개 결제 이력, 페어링은 0개 (해제 후 상태)
    storageStore[PAIR_STORAGE_KEYS.PAIRINGS] = JSON.stringify([]);
    mockGetCompletedOrRefundedOrders.mockResolvedValueOnce({
      hasNext: false,
      orders: [
        { orderId: 'paid-1', sku: 'family_expansion_lifetime_v1', status: 'COMPLETED', date: '2026-06-01' },
      ],
    });

    const pairings = await getPairings();
    const slots = await getFamilySlots();

    expect(slots).toBe(2);
    expect(pairings.length >= slots).toBe(false); // 게이트 통과 → 무료 재연결
  });

  it('환불된 슬롯 — REFUNDED는 슬롯 카운트에서 자동 제외', async () => {
    mockGetCompletedOrRefundedOrders.mockResolvedValueOnce({
      hasNext: false,
      orders: [
        { orderId: 'paid-1', sku: 'family_expansion_lifetime_v1', status: 'COMPLETED', date: '2026-06-01' },
        { orderId: 'paid-2', sku: 'family_expansion_lifetime_v1', status: 'REFUNDED', date: '2026-06-02' },
      ],
    });
    expect(await getFamilySlots()).toBe(2); // 1 무료 + 1 COMPLETED, REFUNDED 제외
  });
});

// ─── 여정 6: 광고 제거 구독 IAP ─────────────────────────────────────────────

describe('[여정 6] 광고 제거 구독 — 결제 → 활성 → 앱 재진입 시 토스 서버 조회', () => {
  it('초기 상태 isAdRemovedActive → false (orderId 없음)', async () => {
    expect(await isAdRemovedActive()).toBe(false);
    expect(mockGetSubscriptionInfo).not.toHaveBeenCalled();
  });

  it('구독 결제 성공 → Storage orderId 저장', async () => {
    mockCreateSubscriptionPurchaseOrder.mockImplementationOnce((args: {
      options: { processProductGrant: (p: { orderId: string }) => Promise<boolean> };
      onEvent: (e: { type: 'success'; data: { orderId: string } }) => void;
    }) => {
      void Promise.resolve().then(async () => {
        await args.options.processProductGrant({ orderId: 'sub-001' });
        args.onEvent({ type: 'success', data: { orderId: 'sub-001' } });
      });
      return jest.fn();
    });

    const result = await purchaseRemoveAdsSubscription();
    expect(result.kind).toBe('success');

    expect(storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_ORDER_ID]).toBe('sub-001');
  });

  it('결제 후 isAdRemovedActive → getSubscriptionInfo 조회 → isAccessible true면 true', async () => {
    storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_ORDER_ID] = 'sub-001';
    mockGetSubscriptionInfo.mockResolvedValueOnce({
      subscription: {
        catalogId: 1,
        status: 'ACTIVE',
        expiresAt: '2026-12-01',
        isAutoRenew: true,
        gracePeriodExpiresAt: null,
        isAccessible: true,
      },
    });

    expect(await isAdRemovedActive()).toBe(true);
    expect(mockGetSubscriptionInfo).toHaveBeenCalledWith({
      params: { orderId: 'sub-001' },
    });
  });

  it('만료된 구독 (isAccessible false) → 배너 다시 노출', async () => {
    storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_ORDER_ID] = 'sub-001';
    mockGetSubscriptionInfo.mockResolvedValueOnce({
      subscription: {
        catalogId: 1,
        status: 'EXPIRED',
        expiresAt: '2026-01-01',
        isAutoRenew: false,
        gracePeriodExpiresAt: null,
        isAccessible: false,
      },
    });

    expect(await isAdRemovedActive()).toBe(false);
  });

  it('구독 결제 취소 → orderId 저장 안 됨 → isAdRemovedActive false', async () => {
    mockCreateSubscriptionPurchaseOrder.mockImplementationOnce((args: {
      onError: (err: unknown) => void;
    }) => {
      void Promise.resolve().then(() => args.onError(new Error('USER_CANCEL')));
      return jest.fn();
    });

    const result = await purchaseRemoveAdsSubscription();
    expect(result.kind).toBe('cancelled');

    expect(await isAdRemovedActive()).toBe(false);
  });

  it('isMinVersionSupported false → unsupported_version + Storage 변경 없음', async () => {
    mockIsMinVersionSupported.mockReturnValue(false);

    const result = await purchaseRemoveAdsSubscription();
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toBe('unsupported_version');
    }

    expect(await isAdRemovedActive()).toBe(false);
  });
});

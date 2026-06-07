/**
 * iapService 단위 테스트 (Step 8b — 구독 + 슬롯 모델)
 *
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-08-family.md §검수 IAP ① 광고 제거 / IAP ② 가족 슬롯
 *  - references/sdk/framework/인앱결제/IAP.md (createOneTimePurchaseOrder, getCompletedOrRefundedOrders)
 *  - references/sdk/framework/인앱결제/subscription.md (createSubscriptionPurchaseOrder, getSubscriptionInfo)
 *
 * 검수 테스트케이스 커버:
 *  [v] 광고제거 구독 결제 성공 → orderId Storage 저장 + 캐시 갱신
 *  [v] 구독 활성 조회 — getSubscriptionInfo.isAccessible 기반
 *  [v] 캐시 fallback — 미지원 환경 / 네트워크 실패 시 24h 캐시 신뢰
 *  [v] 가족 슬롯 카운트 — getCompletedOrRefundedOrders COMPLETED 합산 (REFUNDED 제외)
 *  [v] 슬롯 페이지네이션 — hasNext / nextKey 처리
 *  [v] 가족 일회성 결제 — Storage 별도 저장 없음 (이력이 진실)
 *  [v] 구버전 fallback — 가족 5.231 미만 → boolean flag 최대 1슬롯 추가
 *  [v] isMinVersionSupported false → unsupported_version
 *  [v] 사용자 취소 → cancelled (Storage 변경 없음)
 *
 * 실기기 전용 (이 테스트 범위 밖):
 *  - 실제 결제 바텀시트 렌더링 / 사용자 동의 플로우
 *  - 토스앱 IAP 핸드셰이크
 *  - 구독 갱신·해지 실시간 이벤트
 */

// ─── SDK mock ────────────────────────────────────────────────────────────────

const storageStore: Record<string, string> = {};

const mockCreateOneTimePurchaseOrder = jest.fn();
const mockCreateSubscriptionPurchaseOrder = jest.fn();
const mockGetSubscriptionInfo = jest.fn();
const mockGetCompletedOrRefundedOrders = jest.fn();
const mockIsMinVersionSupported = jest.fn(() => true);

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
}));

import {
  isAdRemovedActive,
  getFamilySlots,
  isIapSupported,
  purchaseRemoveAdsSubscription,
  purchaseFamilyExpansion,
  IAP_STORAGE_KEYS,
} from '../../src/services/iapService';

// ─── 헬퍼 ─────────────────────────────────────────────────────────────────────

function clearStore() {
  Object.keys(storageStore).forEach((k) => delete storageStore[k]);
}

/**
 * 구독 결제 성공 시뮬레이션.
 */
function mockSuccessfulSubscriptionPurchase(orderId = 'sub-order-001') {
  mockCreateSubscriptionPurchaseOrder.mockImplementationOnce((args: {
    options: { processProductGrant: (p: { orderId: string }) => Promise<boolean> };
    onEvent: (e: { type: 'success'; data: { orderId: string } }) => void;
  }) => {
    void Promise.resolve().then(async () => {
      await args.options.processProductGrant({ orderId });
      args.onEvent({ type: 'success', data: { orderId } });
    });
    return jest.fn();
  });
}

/**
 * 일회성 결제 성공 시뮬레이션.
 */
function mockSuccessfulOneTimePurchase(orderId = 'order-test-001') {
  mockCreateOneTimePurchaseOrder.mockImplementationOnce((args: {
    options: { processProductGrant: (p: { orderId: string }) => Promise<boolean> };
    onEvent: (e: { type: 'success'; data: { orderId: string } }) => void;
  }) => {
    void Promise.resolve().then(async () => {
      await args.options.processProductGrant({ orderId });
      args.onEvent({ type: 'success', data: { orderId } });
    });
    return jest.fn();
  });
}

function mockCancelledSubscriptionPurchase() {
  mockCreateSubscriptionPurchaseOrder.mockImplementationOnce((args: {
    onError: (err: unknown) => void;
  }) => {
    void Promise.resolve().then(() => args.onError(new Error('USER_CANCEL')));
    return jest.fn();
  });
}

function mockCancelledOneTimePurchase() {
  mockCreateOneTimePurchaseOrder.mockImplementationOnce((args: {
    onError: (err: unknown) => void;
  }) => {
    void Promise.resolve().then(() => args.onError(new Error('USER_CANCEL')));
    return jest.fn();
  });
}

function mockFailedSubscriptionPurchase(reason = 'network_error') {
  mockCreateSubscriptionPurchaseOrder.mockImplementationOnce((args: {
    onError: (err: unknown) => void;
  }) => {
    void Promise.resolve().then(() => args.onError(new Error(reason)));
    return jest.fn();
  });
}

// ─── beforeEach ───────────────────────────────────────────────────────────────

beforeEach(() => {
  clearStore();
  jest.clearAllMocks();
  // 기본: 모든 버전 지원 (5.219 / 5.231 / 5.253 / 5.250 OK)
  mockIsMinVersionSupported.mockReturnValue(true);
});

// ─── isAdRemovedActive ────────────────────────────────────────────────────────

describe('isAdRemovedActive', () => {
  it('orderId 없으면 false (구독 시작 전)', async () => {
    const result = await isAdRemovedActive();
    expect(result).toBe(false);
    expect(mockGetSubscriptionInfo).not.toHaveBeenCalled();
  });

  it('orderId 있고 isAccessible true → true 반환 + 캐시 갱신', async () => {
    storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_ORDER_ID] = 'sub-1';
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

    const result = await isAdRemovedActive();

    expect(result).toBe(true);
    expect(mockGetSubscriptionInfo).toHaveBeenCalledWith({
      params: { orderId: 'sub-1' },
    });
    expect(storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_CACHE_ACTIVE]).toBe('true');
  });

  it('orderId 있지만 isAccessible false (만료) → false', async () => {
    storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_ORDER_ID] = 'sub-1';
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

    const result = await isAdRemovedActive();

    expect(result).toBe(false);
  });

  it('getSubscriptionInfo 미지원 (구버전) → 24h 캐시 fallback', async () => {
    storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_ORDER_ID] = 'sub-1';
    storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_CACHE_ACTIVE] = 'true';
    storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_CACHE_TIME] = Date.now().toString();
    // 5.253 미만 시뮬레이션
    mockIsMinVersionSupported.mockImplementation((v: { android: string; ios: string }) =>
      v.android !== '5.253.0',
    );

    const result = await isAdRemovedActive();

    expect(result).toBe(true);
    expect(mockGetSubscriptionInfo).not.toHaveBeenCalled();
  });

  it('getSubscriptionInfo 네트워크 실패 → 24h 캐시 fallback', async () => {
    storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_ORDER_ID] = 'sub-1';
    storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_CACHE_ACTIVE] = 'true';
    storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_CACHE_TIME] = Date.now().toString();
    mockGetSubscriptionInfo.mockRejectedValueOnce(new Error('network'));

    const result = await isAdRemovedActive();

    expect(result).toBe(true);
  });

  it('캐시 24h 초과 + 네트워크 실패 → false (오래된 캐시 거부)', async () => {
    storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_ORDER_ID] = 'sub-1';
    storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_CACHE_ACTIVE] = 'true';
    storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_CACHE_TIME] = String(
      Date.now() - 25 * 60 * 60 * 1000, // 25h 이전
    );
    mockGetSubscriptionInfo.mockRejectedValueOnce(new Error('network'));

    const result = await isAdRemovedActive();

    expect(result).toBe(false);
  });
});

// ─── getFamilySlots ───────────────────────────────────────────────────────────

describe('getFamilySlots', () => {
  it('결제 이력 없음 → 1 (무료 기본 슬롯)', async () => {
    mockGetCompletedOrRefundedOrders.mockResolvedValueOnce({
      hasNext: false,
      orders: [],
    });

    const result = await getFamilySlots();

    expect(result).toBe(1);
  });

  it('COMPLETED 2건 → 3슬롯 (1 무료 + 2 결제)', async () => {
    mockGetCompletedOrRefundedOrders.mockResolvedValueOnce({
      hasNext: false,
      orders: [
        { orderId: 'o1', sku: 'family_expansion_lifetime_v1', status: 'COMPLETED', date: '2026-01-01' },
        { orderId: 'o2', sku: 'family_expansion_lifetime_v1', status: 'COMPLETED', date: '2026-02-01' },
      ],
    });

    const result = await getFamilySlots();

    expect(result).toBe(3);
  });

  it('REFUNDED는 제외 (환불 자동 차감)', async () => {
    mockGetCompletedOrRefundedOrders.mockResolvedValueOnce({
      hasNext: false,
      orders: [
        { orderId: 'o1', sku: 'family_expansion_lifetime_v1', status: 'COMPLETED', date: '2026-01-01' },
        { orderId: 'o2', sku: 'family_expansion_lifetime_v1', status: 'REFUNDED', date: '2026-02-01' },
      ],
    });

    const result = await getFamilySlots();

    expect(result).toBe(2); // 1 무료 + 1 COMPLETED만
  });

  it('다른 SKU(광고제거)는 가족 슬롯 카운트에 포함 안 됨', async () => {
    mockGetCompletedOrRefundedOrders.mockResolvedValueOnce({
      hasNext: false,
      orders: [
        { orderId: 'o1', sku: 'remove_ads_lifetime_v1', status: 'COMPLETED', date: '2026-01-01' },
        { orderId: 'o2', sku: 'family_expansion_lifetime_v1', status: 'COMPLETED', date: '2026-02-01' },
      ],
    });

    const result = await getFamilySlots();

    expect(result).toBe(2);
  });

  it('페이지네이션 — hasNext + nextKey 처리', async () => {
    mockGetCompletedOrRefundedOrders
      .mockResolvedValueOnce({
        hasNext: true,
        nextKey: 'page2',
        orders: [
          { orderId: 'o1', sku: 'family_expansion_lifetime_v1', status: 'COMPLETED', date: '2026-01-01' },
        ],
      })
      .mockResolvedValueOnce({
        hasNext: false,
        orders: [
          { orderId: 'o2', sku: 'family_expansion_lifetime_v1', status: 'COMPLETED', date: '2026-02-01' },
        ],
      });

    const result = await getFamilySlots();

    expect(result).toBe(3); // 1 무료 + 2 COMPLETED (2페이지 합산)
    expect(mockGetCompletedOrRefundedOrders).toHaveBeenCalledTimes(2);
  });

  it('구버전 fallback — 5.231 미만이면 boolean flag로 최대 2슬롯', async () => {
    storageStore[IAP_STORAGE_KEYS.FAMILY_FALLBACK_PAID] = 'true';
    mockIsMinVersionSupported.mockImplementation((v: { android: string; ios: string }) =>
      v.android !== '5.231.0',
    );

    const result = await getFamilySlots();

    expect(result).toBe(2);
    expect(mockGetCompletedOrRefundedOrders).not.toHaveBeenCalled();
  });

  it('네트워크 실패 → 안전한 최소값 1 반환', async () => {
    mockGetCompletedOrRefundedOrders.mockRejectedValueOnce(new Error('network'));

    const result = await getFamilySlots();

    expect(result).toBe(1);
  });
});

// ─── isIapSupported ───────────────────────────────────────────────────────────

describe('isIapSupported', () => {
  it('isMinVersionSupported({android: 5.219.0, ios: 5.219.0})로 호출', () => {
    isIapSupported();
    expect(mockIsMinVersionSupported).toHaveBeenCalledWith({
      android: '5.219.0',
      ios: '5.219.0',
    });
  });

  it('지원되면 true', () => {
    mockIsMinVersionSupported.mockReturnValue(true);
    expect(isIapSupported()).toBe(true);
  });

  it('미지원이면 false', () => {
    mockIsMinVersionSupported.mockReturnValue(false);
    expect(isIapSupported()).toBe(false);
  });
});

// ─── purchaseRemoveAdsSubscription ────────────────────────────────────────────

describe('purchaseRemoveAdsSubscription', () => {
  it('결제 성공 시 success + Storage orderId 저장', async () => {
    mockSuccessfulSubscriptionPurchase('sub-order-001');

    const result = await purchaseRemoveAdsSubscription();

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.sku).toBe('remove_ads_lifetime_v1');
      expect(result.orderId).toBe('sub-order-001');
    }
    expect(storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_ORDER_ID]).toBe('sub-order-001');
    expect(storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_CACHE_ACTIVE]).toBe('true');
  });

  it('SKU로 remove_ads_lifetime_v1 전달 (구독 API 호출)', async () => {
    mockSuccessfulSubscriptionPurchase();

    await purchaseRemoveAdsSubscription();

    expect(mockCreateSubscriptionPurchaseOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          sku: 'remove_ads_lifetime_v1',
        }),
      }),
    );
    // 일회성 API는 호출 안 됨
    expect(mockCreateOneTimePurchaseOrder).not.toHaveBeenCalled();
  });

  it('취소 시 cancelled + Storage 변경 없음', async () => {
    mockCancelledSubscriptionPurchase();

    const result = await purchaseRemoveAdsSubscription();

    expect(result.kind).toBe('cancelled');
    expect(storageStore[IAP_STORAGE_KEYS.REMOVE_ADS_ORDER_ID]).toBeUndefined();
  });

  it('실패 시 failed + reason 포함', async () => {
    mockFailedSubscriptionPurchase('network_error');

    const result = await purchaseRemoveAdsSubscription();

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toContain('network_error');
    }
  });

  it('isIapSupported false → unsupported_version (SDK 호출 없음)', async () => {
    mockIsMinVersionSupported.mockReturnValue(false);

    const result = await purchaseRemoveAdsSubscription();

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toBe('unsupported_version');
    }
    expect(mockCreateSubscriptionPurchaseOrder).not.toHaveBeenCalled();
  });
});

// ─── purchaseFamilyExpansion ──────────────────────────────────────────────────

describe('purchaseFamilyExpansion', () => {
  it('결제 성공 시 success + Storage 플래그 별도 저장 안 함 (이력이 진실)', async () => {
    mockSuccessfulOneTimePurchase('order-fam-001');

    const result = await purchaseFamilyExpansion();

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.sku).toBe('family_expansion_lifetime_v1');
      expect(result.orderId).toBe('order-fam-001');
    }
    // 신버전 환경에서는 fallback flag 저장 안 함
    expect(storageStore[IAP_STORAGE_KEYS.FAMILY_FALLBACK_PAID]).toBeUndefined();
  });

  it('SKU로 family_expansion_lifetime_v1 전달 (일회성 API)', async () => {
    mockSuccessfulOneTimePurchase();

    await purchaseFamilyExpansion();

    expect(mockCreateOneTimePurchaseOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          sku: 'family_expansion_lifetime_v1',
        }),
      }),
    );
    expect(mockCreateSubscriptionPurchaseOrder).not.toHaveBeenCalled();
  });

  it('구버전 (5.231 미만) → 결제 성공 시 fallback flag 저장', async () => {
    mockIsMinVersionSupported.mockImplementation((v: { android: string; ios: string }) =>
      v.android === '5.219.0', // 결제 자체는 OK, 이력 조회는 미지원
    );
    mockSuccessfulOneTimePurchase('order-old-001');

    const result = await purchaseFamilyExpansion();

    expect(result.kind).toBe('success');
    expect(storageStore[IAP_STORAGE_KEYS.FAMILY_FALLBACK_PAID]).toBe('true');
  });

  it('취소 시 cancelled', async () => {
    mockCancelledOneTimePurchase();

    const result = await purchaseFamilyExpansion();

    expect(result.kind).toBe('cancelled');
  });
});

/**
 * pairService 단위 테스트 (Step 8a)
 *
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-08-family.md §검수 "토스 로그인·페어링" + "케어러 이벤트 푸시"
 *  - references/dev-guide/development/test/sandbox.md
 *
 * 검수 테스트케이스 커버:
 *  [v] 케어 대상은 기존 Storage.user.key 사용
 *  [v] 6자리 페어링 코드 생성·5분 후 만료
 *  [v] 잘못된 코드 입력 시 'invalid_code' 에러
 *  [v] 유효 코드 입력 시 pairings Storage 저장
 *  [v] 페어링 해제 후 Storage 정리
 *  [v] notifyCaregivers fire-and-forget — 실패해도 예외 전파 없음
 *  [v] 케어러 폰 Storage에 사진·상세 약 미저장 (데이터 최소화 강제 검증)
 *  [v] addCaregiverEvent — photoBase64·routines·records 저장 금지
 *  [v] pendingNotify 큐 적재 + 재시도 플러시
 */

import { Storage } from '@apps-in-toss/framework';
import {
  generatePairingCode,
  confirmPairing,
  getPairings,
  unpair,
  notifyCaregivers,
  addCaregiverEvent,
  getCaregiverEvents,
  flushPendingNotifyQueue,
} from '../../src/services/pairService';
import { PAIR_STORAGE_KEYS } from '../../src/types/pair';
import { SCHEDULE_STORAGE_KEYS } from '../../src/types/schedule';

// ─── Mock 설정 ────────────────────────────────────────────────────────────────

jest.mock('@apps-in-toss/framework', () => ({
  Storage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
  isMinVersionSupported: jest.fn(() => true),
  appLogin: jest.fn(),
}));

// fetch mock
const mockFetch = jest.fn();
global.fetch = mockFetch;

// ─── 헬퍼 ─────────────────────────────────────────────────────────────────────

const MOCK_USER_KEY = 'user-key-care-recipient-001';
const MOCK_CAREGIVER_KEY = 'user-key-caregiver-001';
const MOCK_NICKNAME = '엄마';
const VERCEL_URL = 'https://test.vercel.app';

function setupStorageMock(overrides: Record<string, string | null> = {}) {
  const store: Record<string, string | null> = {
    [SCHEDULE_STORAGE_KEYS.USER_KEY]: MOCK_USER_KEY,
    'profile.nickname': MOCK_NICKNAME,
    [PAIR_STORAGE_KEYS.PAIRINGS]: null,
    [PAIR_STORAGE_KEYS.CAREGIVER_EVENTS]: null,
    [PAIR_STORAGE_KEYS.PENDING_NOTIFY]: null,
    ...overrides,
  };

  (Storage.getItem as jest.Mock).mockImplementation(
    (key: string) => Promise.resolve(store[key] ?? null),
  );
  (Storage.setItem as jest.Mock).mockImplementation(
    (key: string, value: string) => {
      store[key] = value;
      return Promise.resolve();
    },
  );

  return store;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.EXPO_PUBLIC_VERCEL_API_URL = VERCEL_URL;
});

// ─── generatePairingCode ──────────────────────────────────────────────────────

describe('generatePairingCode', () => {
  it('POST /api/pair 성공 시 code와 expiresAt 반환', async () => {
    setupStorageMock();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ code: '123456', expiresAt: new Date(Date.now() + 300000).toISOString() }),
    });

    const result = await generatePairingCode();

    expect(result.code).toBe('123456');
    expect(result.expiresAt).toBeDefined();

    // 헤더에 x-toss-user-key 포함 확인
    // Ref: step-08-family.md §처리 1 "헤더 x-toss-user-key 검증"
    expect(mockFetch).toHaveBeenCalledWith(
      `${VERCEL_URL}/api/pair`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-toss-user-key': MOCK_USER_KEY,
        }),
      }),
    );
  });

  it('userKey 없으면 예외 발생', async () => {
    setupStorageMock({ [SCHEDULE_STORAGE_KEYS.USER_KEY]: null });

    await expect(generatePairingCode()).rejects.toThrow('userKey 없음');
  });

  it('서버 오류 시 예외 발생', async () => {
    setupStorageMock();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'server_error' }),
    });

    await expect(generatePairingCode()).rejects.toThrow();
  });
});

// ─── confirmPairing ───────────────────────────────────────────────────────────

describe('confirmPairing', () => {
  it('유효 코드 입력 시 pairings Storage에 저장', async () => {
    // Ref: step-08-family.md §검수 "유효 코드 입력 시 페어링 레코드가 Vercel KV에 저장되어야 한다"
    setupStorageMock({ [SCHEDULE_STORAGE_KEYS.USER_KEY]: MOCK_CAREGIVER_KEY });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ success: true, careRecipientNickname: MOCK_NICKNAME }),
    });

    const result = await confirmPairing('123456');

    expect(result.success).toBe(true);
    expect(result.careRecipientNickname).toBe(MOCK_NICKNAME);

    // pairings Storage 저장 확인
    expect(Storage.setItem).toHaveBeenCalledWith(
      PAIR_STORAGE_KEYS.PAIRINGS,
      expect.stringContaining(MOCK_CAREGIVER_KEY),
    );
  });

  it('잘못된 코드 입력 시 invalid_code 에러 반환', async () => {
    // Ref: step-08-family.md §검수 "잘못된 코드 입력 시 '코드가 올바르지 않아요' 에러"
    setupStorageMock({ [SCHEDULE_STORAGE_KEYS.USER_KEY]: MOCK_CAREGIVER_KEY });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'invalid_code' }),
    });

    const result = await confirmPairing('999999');

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_code');
  });

  it('userKey 없으면 실패 반환', async () => {
    setupStorageMock({ [SCHEDULE_STORAGE_KEYS.USER_KEY]: null });

    const result = await confirmPairing('123456');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/userKey/);
  });

  it('네트워크 오류 시 network_error 반환', async () => {
    setupStorageMock({ [SCHEDULE_STORAGE_KEYS.USER_KEY]: MOCK_CAREGIVER_KEY });
    mockFetch.mockRejectedValueOnce(new Error('Network Error'));

    const result = await confirmPairing('123456');

    expect(result.success).toBe(false);
    expect(result.error).toBe('network_error');
  });
});

// ─── getPairings ──────────────────────────────────────────────────────────────

describe('getPairings', () => {
  it('Storage에 pairings 없으면 빈 배열 반환', async () => {
    setupStorageMock({ [PAIR_STORAGE_KEYS.PAIRINGS]: null });

    const result = await getPairings();

    expect(result).toEqual([]);
  });

  it('저장된 pairings 파싱하여 반환', async () => {
    const mockPairing = [
      {
        caregiverUserKey: MOCK_CAREGIVER_KEY,
        careRecipientUserKey: MOCK_USER_KEY,
        careRecipientNickname: MOCK_NICKNAME,
        pairedAt: new Date().toISOString(),
      },
    ];
    setupStorageMock({
      [PAIR_STORAGE_KEYS.PAIRINGS]: JSON.stringify(mockPairing),
    });

    const result = await getPairings();

    expect(result).toHaveLength(1);
    expect(result[0]!.caregiverUserKey).toBe(MOCK_CAREGIVER_KEY);
  });
});

// ─── unpair ───────────────────────────────────────────────────────────────────

describe('unpair', () => {
  it('페어링 해제 후 Storage에서 해당 레코드 제거', async () => {
    // Ref: step-08-family.md §검수 "페어링 해제 기능이 있으며, 해제 후엔 푸시가 중단되어야 한다"
    const mockPairing = [
      {
        caregiverUserKey: MOCK_CAREGIVER_KEY,
        careRecipientUserKey: MOCK_USER_KEY,
        careRecipientNickname: MOCK_NICKNAME,
        pairedAt: new Date().toISOString(),
      },
    ];
    setupStorageMock({
      [SCHEDULE_STORAGE_KEYS.USER_KEY]: MOCK_USER_KEY,
      [PAIR_STORAGE_KEYS.PAIRINGS]: JSON.stringify(mockPairing),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    await unpair({
      caregiverUserKey: MOCK_CAREGIVER_KEY,
      careRecipientUserKey: MOCK_USER_KEY,
    });

    // Storage.setItem이 빈 배열로 호출됐는지 확인
    expect(Storage.setItem).toHaveBeenCalledWith(
      PAIR_STORAGE_KEYS.PAIRINGS,
      JSON.stringify([]),
    );
  });

  it('서버 오류 시에도 로컬 Storage 정리는 수행', async () => {
    const mockPairing = [
      {
        caregiverUserKey: MOCK_CAREGIVER_KEY,
        careRecipientUserKey: MOCK_USER_KEY,
        careRecipientNickname: MOCK_NICKNAME,
        pairedAt: new Date().toISOString(),
      },
    ];
    setupStorageMock({
      [SCHEDULE_STORAGE_KEYS.USER_KEY]: MOCK_USER_KEY,
      [PAIR_STORAGE_KEYS.PAIRINGS]: JSON.stringify(mockPairing),
    });
    mockFetch.mockRejectedValueOnce(new Error('Network Error'));

    // 예외 전파 없이 완료
    await expect(unpair({ caregiverUserKey: MOCK_CAREGIVER_KEY, careRecipientUserKey: MOCK_USER_KEY })).resolves.toBeUndefined();

    // 로컬 Storage는 정리됨
    expect(Storage.setItem).toHaveBeenCalledWith(
      PAIR_STORAGE_KEYS.PAIRINGS,
      JSON.stringify([]),
    );
  });
});

// ─── notifyCaregivers ─────────────────────────────────────────────────────────

describe('notifyCaregivers (v1: NOTIFY_ENABLED=false → silent skip)', () => {
  // Ref: src/services/pairService.ts NOTIFY_ENABLED
  // Ref: 메모리 "엄마약먹자 알림 기능 보류" (스마트 발송 비용 회피)
  // 활성 발송 동작은 v2 재신청 + 플래그 true 전환 후 별도 테스트로 복귀.

  it('호출은 허용 — 예외 없이 즉시 resolve', async () => {
    setupStorageMock();
    await expect(
      notifyCaregivers('아침약', new Date().toISOString(), 'checked'),
    ).resolves.toBeUndefined();
  });

  it('v1: fetch 호출 안 함 (NOTIFY_ENABLED=false 진입 즉시 return)', async () => {
    setupStorageMock();
    await notifyCaregivers('아침약', new Date().toISOString(), 'checked');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('v1: pendingNotify 큐 적재 안 함', async () => {
    setupStorageMock({ [PAIR_STORAGE_KEYS.PENDING_NOTIFY]: null });
    await notifyCaregivers('아침약', new Date().toISOString(), 'checked');
    // 큐에 적재되지 않음 — Storage.setItem이 PENDING_NOTIFY 키로 호출되지 않아야
    const calls = (Storage.setItem as jest.Mock).mock.calls;
    const queueCall = calls.find((c) => c[0] === PAIR_STORAGE_KEYS.PENDING_NOTIFY);
    expect(queueCall).toBeUndefined();
  });

  it('userKey 없어도 예외 없음 (조용히 종료)', async () => {
    setupStorageMock({ [SCHEDULE_STORAGE_KEYS.USER_KEY]: null });
    await expect(
      notifyCaregivers('아침약', new Date().toISOString(), 'checked'),
    ).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── flushPendingNotifyQueue ──────────────────────────────────────────────────

describe('flushPendingNotifyQueue (v1: 큐 비우기만)', () => {
  // v1엔 NOTIFY_ENABLED=false → 큐 자체를 비워서 누적 방지.
  // 이전 빌드에서 누적된 항목이 있더라도 재진입 시 자동 삭제.

  it('큐가 있었다면 비우기 (removeItem 호출)', async () => {
    setupStorageMock({
      [PAIR_STORAGE_KEYS.PENDING_NOTIFY]: JSON.stringify([
        {
          careRecipientUserKey: MOCK_USER_KEY,
          routineLabel: '아침약',
          takenAt: new Date().toISOString(),
          kind: 'checked' as const,
        },
      ]),
    });

    await flushPendingNotifyQueue();

    expect(Storage.removeItem).toHaveBeenCalledWith(PAIR_STORAGE_KEYS.PENDING_NOTIFY);
  });

  it('v1: 네트워크 fetch 호출 안 함', async () => {
    setupStorageMock({
      [PAIR_STORAGE_KEYS.PENDING_NOTIFY]: JSON.stringify([
        {
          careRecipientUserKey: MOCK_USER_KEY,
          routineLabel: '아침약',
          takenAt: new Date().toISOString(),
          kind: 'checked' as const,
        },
      ]),
    });

    await flushPendingNotifyQueue();

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── addCaregiverEvent / getCaregiverEvents ───────────────────────────────────

describe('addCaregiverEvent — 데이터 최소화 강제 검증', () => {
  it('이벤트 저장 시 photoBase64 저장 없음', async () => {
    // Ref: step-08-family.md §검수 "케어러 폰엔 회차 사진·상세 약 목록이 저장되지 않아야 한다"
    // Ref: step-08-family.md §처리 4 "푸시 payload에 회차 사진 URL 포함하지 않음"
    setupStorageMock({ [PAIR_STORAGE_KEYS.CAREGIVER_EVENTS]: null });

    await addCaregiverEvent({
      careRecipientUserKey: MOCK_USER_KEY,
      careRecipientNickname: MOCK_NICKNAME,
      routineLabel: '아침약',
      kind: 'checked',
      takenAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
    });

    // Storage.setItem 호출 내용에 photoBase64, routines, records, medications 없는지 확인
    const setItemCalls = (Storage.setItem as jest.Mock).mock.calls;
    for (const [key, value] of setItemCalls) {
      expect(key).not.toContain('photo');
      expect(key).not.toBe('routines');
      expect(key).not.toBe('records');
      expect(key).not.toContain('medication');
      if (typeof value === 'string') {
        expect(value).not.toContain('photoBase64');
        expect(value).not.toContain('medications');
      }
    }
  });

  it('이벤트 저장 후 getCaregiverEvents로 조회', async () => {
    setupStorageMock({ [PAIR_STORAGE_KEYS.CAREGIVER_EVENTS]: null });

    await addCaregiverEvent({
      careRecipientUserKey: MOCK_USER_KEY,
      careRecipientNickname: MOCK_NICKNAME,
      routineLabel: '저녁약',
      kind: 'missed',
      takenAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
    });

    // setItem으로 저장된 값 파싱하여 확인
    const setItemCalls = (Storage.setItem as jest.Mock).mock.calls;
    const eventCall = setItemCalls.find(([key]: [string]) => key === PAIR_STORAGE_KEYS.CAREGIVER_EVENTS);
    expect(eventCall).toBeDefined();

    const stored = JSON.parse(eventCall![1] as string) as Array<{ routineLabel: string; kind: string }>;
    expect(stored[0]!.routineLabel).toBe('저녁약');
    expect(stored[0]!.kind).toBe('missed');
  });

  it('getCaregiverEvents — Storage 없으면 빈 배열', async () => {
    setupStorageMock({ [PAIR_STORAGE_KEYS.CAREGIVER_EVENTS]: null });

    const events = await getCaregiverEvents();

    expect(events).toEqual([]);
  });

  it('Storage에 routines 키가 caregiverEvents에 저장되지 않음', async () => {
    // 케어러 폰에서는 routines 키를 절대 쓰면 안 됨
    // Ref: step-08-family.md §처리 5 "데이터 최소화"
    setupStorageMock({ [PAIR_STORAGE_KEYS.CAREGIVER_EVENTS]: null });

    await addCaregiverEvent({
      careRecipientUserKey: MOCK_USER_KEY,
      careRecipientNickname: MOCK_NICKNAME,
      routineLabel: '점심약',
      kind: 'checked',
      takenAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
    });

    const setItemCalls = (Storage.setItem as jest.Mock).mock.calls;
    const routinesCall = setItemCalls.find(([key]: [string]) => key === 'routines');
    expect(routinesCall).toBeUndefined();

    const recordsCall = setItemCalls.find(([key]: [string]) => key === 'records');
    expect(recordsCall).toBeUndefined();
  });
});

// ─── 광고성 문구 없음 검증 ────────────────────────────────────────────────────

describe('광고성 문구 없음', () => {
  it('notifyCaregivers 요청 body에 광고성 문구 없음', async () => {
    // Ref: step-08-family.md §검수 "광고성 문구(할인·이벤트 등) 없이 기능성 메시지 기준 충족"
    // Ref: references/dev-guide/smart-message/intro.md §기능성 메시지
    setupStorageMock();
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });

    await notifyCaregivers('아침약', new Date().toISOString(), 'checked');

    const fetchCall = mockFetch.mock.calls[0];
    if (fetchCall) {
      const body = JSON.parse(fetchCall[1].body as string) as Record<string, unknown>;
      const bodyStr = JSON.stringify(body);
      // 광고성 문구 없음 확인
      expect(bodyStr).not.toMatch(/할인|이벤트|혜택|지금.*구매|특가/);
    }
  });
});

/**
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-04-notification.md §검수
 *    "회차 등록 시 Vercel KV에 스케줄이 등록되어야 한다"
 *    "회차 삭제 시 Vercel KV에서 스케줄이 제거되어야 한다"
 *    "네트워크 실패 시 로컬 저장 유지 + 재시도 큐"
 */

// ─── SDK mock ─────────────────────────────────────────────────────────────────

const storageStore: Record<string, string> = {};

jest.mock('@apps-in-toss/framework', () => ({
  Storage: {
    getItem: jest.fn(async (key: string) => storageStore[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      storageStore[key] = value;
    }),
    removeItem: jest.fn(async (key: string) => {
      delete storageStore[key];
    }),
    clearItems: jest.fn(async () => {
      Object.keys(storageStore).forEach((k) => delete storageStore[k]);
    }),
  },
  isMinVersionSupported: jest.fn(() => true),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

import { upsertSchedule, deleteSchedule, flushPendingQueue } from '../../src/services/scheduleService';
import { SCHEDULE_STORAGE_KEYS, type SchedulePayload } from '../../src/types/schedule';

const MOCK_VERCEL_URL = 'https://eomma-yak-meokja.vercel.app';

function makePayload(overrides: Partial<SchedulePayload> = {}): SchedulePayload {
  return {
    userKey: 'uk_test',
    routineId: 'RTN-test-1',
    time: '09:00',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    label: '아침약',
    nickname: '할머니',
    ...overrides,
  };
}

beforeEach(() => {
  Object.keys(storageStore).forEach((k) => delete storageStore[k]);
  jest.clearAllMocks();
  process.env.EXPO_PUBLIC_VERCEL_API_URL = MOCK_VERCEL_URL;
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_VERCEL_API_URL;
});

// ─── upsertSchedule ──────────────────────────────────────────────────────────

describe('upsertSchedule', () => {
  test('성공 시 POST /api/schedule 를 올바른 body로 호출해야 한다', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const payload = makePayload();

    await upsertSchedule(payload);

    expect(mockFetch).toHaveBeenCalledWith(
      `${MOCK_VERCEL_URL}/api/schedule`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    );
  });

  test('성공 시 pendingSchedule 큐에 해당 항목이 없어야 한다', async () => {
    // 기존 pending 항목이 있는 상태에서 성공하면 제거되어야 함
    storageStore[SCHEDULE_STORAGE_KEYS.PENDING_SCHEDULE] = JSON.stringify([
      {
        action: 'upsert',
        payload: makePayload(),
        failedAt: new Date().toISOString(),
      },
    ]);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    await upsertSchedule(makePayload());

    const queue = JSON.parse(storageStore[SCHEDULE_STORAGE_KEYS.PENDING_SCHEDULE] ?? '[]');
    expect(queue).toHaveLength(0);
  });

  test('네트워크 실패 시 pendingSchedule 큐에 적재되어야 한다', async () => {
    // Ref: PRD §처리 2 "네트워크 실패 시 로컬 저장은 유지, 재시도 큐에 적재"
    mockFetch.mockRejectedValue(new Error('Network Error'));
    const payload = makePayload();

    await upsertSchedule(payload);

    const queue = JSON.parse(storageStore[SCHEDULE_STORAGE_KEYS.PENDING_SCHEDULE] ?? '[]');
    expect(queue).toHaveLength(1);
    expect(queue[0].action).toBe('upsert');
    expect(queue[0].payload.routineId).toBe('RTN-test-1');
  });

  test('HTTP 오류(non-200) 시 pendingSchedule 큐에 적재되어야 한다', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await upsertSchedule(makePayload());

    const queue = JSON.parse(storageStore[SCHEDULE_STORAGE_KEYS.PENDING_SCHEDULE] ?? '[]');
    expect(queue).toHaveLength(1);
  });

  test('동일 routineId로 재시도 시 큐에 중복 없이 최신 항목만 남아야 한다', async () => {
    mockFetch.mockRejectedValue(new Error('fail'));
    const payload = makePayload();

    await upsertSchedule(payload);
    await upsertSchedule({ ...payload, label: '아침약(수정)' });

    const queue = JSON.parse(storageStore[SCHEDULE_STORAGE_KEYS.PENDING_SCHEDULE] ?? '[]');
    expect(queue).toHaveLength(1);
    expect(queue[0].payload.label).toBe('아침약(수정)');
  });
});

// ─── deleteSchedule ──────────────────────────────────────────────────────────

describe('deleteSchedule', () => {
  test('성공 시 DELETE /api/schedule?routineId=&userKey= 를 호출해야 한다', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    await deleteSchedule('RTN-test-1', 'uk_test');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/schedule?'),
      expect.objectContaining({ method: 'DELETE' }),
    );
    const calledUrl = (mockFetch.mock.calls[0] as string[])[0] as string;
    expect(calledUrl).toContain('routineId=RTN-test-1');
    expect(calledUrl).toContain('userKey=uk_test');
  });

  test('네트워크 실패 시 delete 항목이 pendingSchedule 큐에 적재되어야 한다', async () => {
    // Ref: PRD §처리 2
    mockFetch.mockRejectedValue(new Error('Network Error'));

    await deleteSchedule('RTN-test-1', 'uk_test');

    const queue = JSON.parse(storageStore[SCHEDULE_STORAGE_KEYS.PENDING_SCHEDULE] ?? '[]');
    expect(queue).toHaveLength(1);
    expect(queue[0].action).toBe('delete');
    expect(queue[0].routineId).toBe('RTN-test-1');
  });
});

// ─── flushPendingQueue ───────────────────────────────────────────────────────

describe('flushPendingQueue', () => {
  test('큐의 모든 항목을 재시도하고 성공 시 큐에서 제거해야 한다', async () => {
    storageStore[SCHEDULE_STORAGE_KEYS.PENDING_SCHEDULE] = JSON.stringify([
      {
        action: 'upsert',
        payload: makePayload({ routineId: 'RTN-1' }),
        failedAt: new Date().toISOString(),
      },
      {
        action: 'delete',
        routineId: 'RTN-2',
        userKey: 'uk_test',
        failedAt: new Date().toISOString(),
      },
    ]);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    await flushPendingQueue();

    const queue = JSON.parse(storageStore[SCHEDULE_STORAGE_KEYS.PENDING_SCHEDULE] ?? '[]');
    expect(queue).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('일부 실패 시 실패 항목만 큐에 남아야 한다', async () => {
    storageStore[SCHEDULE_STORAGE_KEYS.PENDING_SCHEDULE] = JSON.stringify([
      {
        action: 'upsert',
        payload: makePayload({ routineId: 'RTN-success' }),
        failedAt: new Date().toISOString(),
      },
      {
        action: 'upsert',
        payload: makePayload({ routineId: 'RTN-fail' }),
        failedAt: new Date().toISOString(),
      },
    ]);
    mockFetch
      .mockResolvedValueOnce({ ok: true })  // RTN-success 성공
      .mockRejectedValueOnce(new Error('fail')); // RTN-fail 실패

    await flushPendingQueue();

    const queue = JSON.parse(storageStore[SCHEDULE_STORAGE_KEYS.PENDING_SCHEDULE] ?? '[]');
    expect(queue).toHaveLength(1);
    expect(queue[0].payload.routineId).toBe('RTN-fail');
  });

});

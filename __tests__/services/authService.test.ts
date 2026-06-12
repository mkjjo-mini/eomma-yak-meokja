/**
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-04-notification.md §검수
 *    "appLogin으로 획득한 userKey가 Storage에 저장되어야 한다"
 *  - references/sdk/framework/로그인/appLogin.md
 *  - references/sdk/framework/환경확인/isMinVersionSupported.md
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
  appLogin: jest.fn(),
}));

// fetch mock
const mockFetch = jest.fn();
global.fetch = mockFetch;

import { Storage, appLogin, isMinVersionSupported } from '@apps-in-toss/framework';
import { getSavedUserKey, ensureUserKey } from '../../src/services/authService';
import { SCHEDULE_STORAGE_KEYS } from '../../src/types/schedule';

// ─── 환경변수 설정 ───────────────────────────────────────────────────────────

const MOCK_VERCEL_URL = 'https://eomma-yak-meokja.vercel.app';

beforeEach(() => {
  // Storage 초기화
  Object.keys(storageStore).forEach((k) => delete storageStore[k]);
  jest.clearAllMocks();

  // 기본 mock 설정
  (isMinVersionSupported as jest.Mock).mockReturnValue(true);
  process.env.EXPO_PUBLIC_VERCEL_API_URL = MOCK_VERCEL_URL;
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_VERCEL_API_URL;
});

// ─── getSavedUserKey ─────────────────────────────────────────────────────────

describe('getSavedUserKey', () => {
  test('저장된 userKey가 있으면 반환해야 한다', async () => {
    storageStore[SCHEDULE_STORAGE_KEYS.USER_KEY] = 'uk_test_123';
    const result = await getSavedUserKey();
    expect(result).toBe('uk_test_123');
  });

  test('저장된 userKey가 없으면 null을 반환해야 한다', async () => {
    const result = await getSavedUserKey();
    expect(result).toBeNull();
  });
});

// ─── ensureUserKey ───────────────────────────────────────────────────────────

describe('ensureUserKey', () => {
  test('이미 저장된 userKey가 있으면 appLogin을 호출하지 않아야 한다', async () => {
    storageStore[SCHEDULE_STORAGE_KEYS.USER_KEY] = 'uk_existing';
    const result = await ensureUserKey();
    expect(result).toBe('uk_existing');
    expect(appLogin).not.toHaveBeenCalled();
  });

  test('appLogin → 토큰 교환 성공 시 userKey가 Storage에 저장되어야 한다', async () => {
    // Ref: PRD §검수 "appLogin으로 획득한 userKey가 Storage에 저장되어야 한다"
    (appLogin as jest.Mock).mockResolvedValue({
      authorizationCode: 'code_abc',
      referrer: 'DEFAULT',
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ userKey: 'uk_new_123' }),
    });

    const result = await ensureUserKey();

    expect(result).toBe('uk_new_123');
    expect(Storage.setItem).toHaveBeenCalledWith(
      SCHEDULE_STORAGE_KEYS.USER_KEY,
      'uk_new_123',
    );
  });

  test('SDK 버전 미지원 시 null을 반환해야 한다', async () => {
    (isMinVersionSupported as jest.Mock).mockReturnValue(false);
    const result = await ensureUserKey();
    expect(result).toBeNull();
    expect(appLogin).not.toHaveBeenCalled();
  });

  test('토큰 교환 API 실패(non-200) 시 null을 반환해야 한다', async () => {
    (appLogin as jest.Mock).mockResolvedValue({
      authorizationCode: 'code_abc',
      referrer: 'DEFAULT',
    });
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const result = await ensureUserKey();
    expect(result).toBeNull();
    expect(Storage.setItem).not.toHaveBeenCalled();
  });

  test('네트워크 오류 시 null을 반환해야 한다 (사용자 흐름 차단 없음)', async () => {
    // Ref: references/dev-guide/design/consumer-ux-guide.md §강제 로그인 금지
    (appLogin as jest.Mock).mockResolvedValue({
      authorizationCode: 'code_abc',
      referrer: 'DEFAULT',
    });
    mockFetch.mockRejectedValue(new Error('Network Error'));

    const result = await ensureUserKey();
    expect(result).toBeNull();
  });

  test('appLogin 취소(예외) 시 null을 반환해야 한다', async () => {
    (appLogin as jest.Mock).mockRejectedValue(new Error('User cancelled'));
    const result = await ensureUserKey();
    expect(result).toBeNull();
  });
});

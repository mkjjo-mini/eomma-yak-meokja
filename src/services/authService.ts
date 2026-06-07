/**
 * Ref:
 *  - references/sdk/framework/로그인/appLogin.md
 *    "appLogin은 authorizationCode를 반환. 서버에서 토큰 교환 후 userKey 발급."
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-04-notification.md §처리 1
 *    "앱에서 appLogin 호출 → userKey 획득 + Storage 저장 (Step 4에서 최초 도입)"
 *  - references/dev-guide/design/consumer-ux-guide.md
 *    "다크패턴 방지: 강제 로그인 팝업 없음. 백그라운드 silent 시도."
 *
 * 주의:
 *  - appLogin()은 authorizationCode(10분 유효, 일회성)만 반환.
 *  - userKey는 Vercel /api/auth/exchange 에서 토큰 교환 후 받아 Storage에 저장.
 *  - 이미 user.key가 있으면 재로그인 불필요.
 *  - 로그인 실패는 조용히 처리 (사용자 흐름 차단 없음).
 */
import { appLogin, isMinVersionSupported, Storage } from '@apps-in-toss/framework';
import { SCHEDULE_STORAGE_KEYS } from '../types/schedule';
import { STORAGE_KEYS as ROUTINE_STORAGE_KEYS } from '../types/routine';
import { PAIR_STORAGE_KEYS } from '../types/pair';
import { IAP_STORAGE_KEYS } from './iapService';

/** 런타임 시점에 env 읽기 — 테스트에서 beforeEach 세팅 반영을 위해 함수로 */
function getVercelApiUrl(): string {
  return (
    (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_VERCEL_API_URL) ||
    (typeof process !== 'undefined' && process.env?.VERCEL_API_URL) ||
    ''
  );
}

/**
 * 저장된 userKey 조회.
 */
export async function getSavedUserKey(): Promise<string | null> {
  return Storage.getItem(SCHEDULE_STORAGE_KEYS.USER_KEY);
}

/**
 * 미니앱에 보관 중인 사용자 관련 Storage 키 목록.
 * 토스 로그인 해제 감지 시 일괄 삭제용.
 * Ref: 비게임 출시 가이드 §토스 로그인 — "연결 끊으면 사용자 데이터 미니앱에 남아 있지 않아요"
 */
const USER_DATA_STORAGE_KEYS: readonly string[] = [
  ROUTINE_STORAGE_KEYS.PROFILE_NICKNAME,
  ROUTINE_STORAGE_KEYS.ROUTINES,
  SCHEDULE_STORAGE_KEYS.USER_KEY,
  PAIR_STORAGE_KEYS.PAIRINGS,
  PAIR_STORAGE_KEYS.CAREGIVER_EVENTS,
  PAIR_STORAGE_KEYS.PENDING_NOTIFY,
  IAP_STORAGE_KEYS.REMOVE_ADS_ORDER_ID,
  IAP_STORAGE_KEYS.REMOVE_ADS_CACHE_ACTIVE,
  IAP_STORAGE_KEYS.REMOVE_ADS_CACHE_TIME,
  IAP_STORAGE_KEYS.FAMILY_FALLBACK_PAID,
  // 복약 기록·스트릭·배지·스케줄 큐 등 — 명시 키
  'records',
  'streak',
  'badges',
  'pendingSchedule',
  'caregiverEvents',
];

/**
 * 사용자 관련 Storage 전부 제거.
 * 토스 로그인 해제 감지 시 호출.
 */
export async function clearAllUserData(): Promise<void> {
  // SDK가 clearItems를 제공하면 한 방에 처리 (테스트 mock에서 확인됨)
  const sdkClear = (Storage as unknown as { clearItems?: () => Promise<void> })
    .clearItems;
  if (typeof sdkClear === 'function') {
    try {
      await sdkClear.call(Storage);
      return;
    } catch (err) {
      console.warn('[authService] Storage.clearItems 실패, 키별 fallback:', err);
    }
  }
  // fallback: 키별 removeItem
  for (const key of USER_DATA_STORAGE_KEYS) {
    try {
      await Storage.removeItem(key);
    } catch {
      // 개별 실패 silent — 다음 키 진행
    }
  }
}

/**
 * 진입 시점에 토스 로그인 해제 감지 + 데이터 클리어.
 * 가이드 §토스 로그인: "토스 앱에서 로그인 연결을 끊은 뒤 미니앱에 다시 접속하면
 * 다시 로그인을 요청하는 약관 화면이 노출돼요" / "연결을 끊으면 사용자 데이터가
 * 미니앱에 남아 있지 않아요"
 *
 * 동작:
 *  1. 저장된 userKey가 없으면 — 첫 진입이라 검증 불필요 (skip).
 *  2. 저장된 userKey가 있으면 — appLogin 호출 + 토큰 교환으로 현재 userKey 재발급.
 *  3. 결과 userKey가 저장된 것과 다르면 — 다른 계정으로 전환됐거나 연결 해제됨 → 전체 데이터 클리어 + 새 userKey 저장.
 *  4. appLogin/네트워크 실패는 silent — 일시 오프라인을 데이터 클리어로 오판하지 않음.
 *
 * fire-and-forget — 결과 무관하게 호출자는 다음 흐름 진행.
 */
export async function detectLogoutAndClear(): Promise<void> {
  const savedUserKey = await getSavedUserKey();
  if (!savedUserKey) return; // 첫 진입이면 검증할 게 없음

  if (!isMinVersionSupported({ android: 'always', ios: 'always' })) return;

  const vercelApiUrl = getVercelApiUrl();
  if (!vercelApiUrl) return;

  try {
    const { authorizationCode, referrer } = await appLogin();
    const response = await fetch(`${vercelApiUrl}/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorizationCode, referrer }),
    });
    if (!response.ok) return; // 일시 장애 가능성 — silent skip

    const data = (await response.json()) as { userKey?: string };
    if (!data.userKey) return;

    if (data.userKey !== savedUserKey) {
      // 다른 계정 또는 연결 해제 후 재로그인 — 기존 데이터 모두 클리어
      console.log('[authService] userKey 변경 감지 — 사용자 데이터 클리어');
      await clearAllUserData();
      await Storage.setItem(SCHEDULE_STORAGE_KEYS.USER_KEY, data.userKey);
    }
  } catch (err) {
    // 사용자 취소·네트워크 오류 등 — silent. 데이터 보존.
    console.warn('[authService] detectLogoutAndClear silent skip:', err);
  }
}

/**
 * Silent 로그인 시도.
 * - 이미 userKey가 있으면 즉시 반환.
 * - appLogin minVersion 확인 후 서버에서 토큰 교환.
 * - 실패 시 null 반환 — 사용자 흐름 차단 없음 (다크패턴 방지).
 *
 * Ref: references/dev-guide/design/consumer-ux-guide.md §강제 로그인 금지
 */
export async function ensureUserKey(): Promise<string | null> {
  // 이미 저장된 userKey가 있으면 재사용
  const saved = await getSavedUserKey();
  if (saved) return saved;

  // SDK 버전 확인
  // Ref: references/sdk/framework/환경확인/isMinVersionSupported.md
  // 시그니처: { android: 'X.Y.Z' | 'always' | 'never', ios: 'X.Y.Z' | 'always' | 'never' }
  if (!isMinVersionSupported({ android: 'always', ios: 'always' })) {
    // 대체 처리: 알림 기능 비활성화 (사용자 흐름 차단 없음)
    console.warn('[authService] Toss 앱 버전 미지원 — userKey 획득 불가');
    return null;
  }

  const vercelApiUrl = getVercelApiUrl();
  if (!vercelApiUrl) {
    console.warn('[authService] VERCEL_API_URL 미설정 — userKey 획득 불가');
    return null;
  }

  try {
    // Ref: references/sdk/framework/로그인/appLogin.md §예제
    const { authorizationCode, referrer } = await appLogin();

    // authorizationCode를 서버로 전송 → 토큰 교환 → userKey 반환
    // Ref: references/sdk/framework/로그인/appLogin.md
    //   "인가 코드를 받은 뒤의 토큰 교환은 반드시 서버에서 처리"
    const response = await fetch(`${vercelApiUrl}/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorizationCode, referrer }),
    });

    if (!response.ok) {
      console.warn('[authService] 토큰 교환 실패:', response.status);
      return null;
    }

    const data = (await response.json()) as { userKey?: string };
    if (!data.userKey) {
      console.warn('[authService] userKey 미포함 응답');
      return null;
    }

    // Storage에 영구 저장
    await Storage.setItem(SCHEDULE_STORAGE_KEYS.USER_KEY, data.userKey);
    return data.userKey;
  } catch (err) {
    // 네트워크 오류, 로그인 취소 등 — 조용히 처리
    console.warn('[authService] ensureUserKey 실패:', err);
    return null;
  }
}

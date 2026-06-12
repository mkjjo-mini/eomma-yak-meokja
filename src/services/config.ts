/**
 * 서비스 공통 설정.
 *
 * VERCEL_API_URL은 공개 API 엔드포인트라 비밀이 아님 → 상수로 하드코딩.
 * Granite 번들은 .env 파일을 자동 inline 하지 않아서 env 변수에 의존하면
 * 프로덕션 빌드에서 빈 문자열이 됨.
 *
 * env override는 테스트·로컬 디버깅 편의용. 런타임 시점에 함수로 읽어 테스트의
 * beforeEach 세팅을 반영.
 */

/** 프로덕션 Vercel 엔드포인트 — 미니앱 백엔드 */
const DEFAULT_VERCEL_API_URL = 'https://eomma-yak-meokja.vercel.app';

export function getVercelApiUrl(): string {
  if (typeof process !== 'undefined') {
    const override =
      process.env?.EXPO_PUBLIC_VERCEL_API_URL ||
      process.env?.VERCEL_API_URL;
    if (override) return override;
  }
  return DEFAULT_VERCEL_API_URL;
}

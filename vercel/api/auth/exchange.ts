/**
 * POST /api/auth/exchange
 *
 * Ref:
 *  - references/sdk/framework/로그인/appLogin.md
 *    "인가 코드를 받은 뒤의 토큰 교환은 반드시 서버에서 처리"
 *  - references/dev-guide/login/develop.md §토큰 교환 API
 *    POST /api-partner/v1/apps-in-toss/user/oauth2/generate-token
 *
 * 앱에서 받은 authorizationCode를 Toss 서버로 전송 → accessToken + userKey 획득.
 * mTLS 인증서 사용.
 *
 * 주의: Vercel runtime의 fetch(undici)는 agent 옵션을 무시·throw함. mTLS를
 * 거는 유일한 안정 경로는 native https.request. 이전 fetch+agent 방식이
 * silent fail 또는 throw → 500 원인이었음.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import https from 'https';

const TOSS_API_HOST = 'apps-in-toss-api.toss.im';
const TOSS_API_PATH = '/api-partner/v1/apps-in-toss/user/oauth2/generate-token';

/**
 * Toss 토큰 교환 응답 — 실제 응답 shape (실장비 진단으로 확인됨).
 *  - 성공: { resultType: 'SUCCESS', success: { userKey, accessToken }, error: null }
 *  - 실패: { resultType: 'FAIL', success: null, error: { errorCode, reason, ... } }
 */
type TossTokenResponse = {
  resultType?: 'SUCCESS' | 'FAIL';
  success?: { userKey?: string; accessToken?: string } | null;
  error?: { errorCode?: string; reason?: string } | null;
  // 호환: 혹시 평면으로 변경될 가능성 대비
  userKey?: string;
  accessToken?: string;
};

function postWithMtls(
  body: string,
  cert: string,
  key: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: TOSS_API_HOST,
        path: TOSS_API_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        cert,
        key,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { authorizationCode, referrer } = req.body as {
    authorizationCode?: string;
    referrer?: string;
  };

  if (!authorizationCode) {
    return res.status(400).json({ error: 'authorizationCode required' });
  }

  const cert = process.env.TOSS_MTLS_CERT;
  const key = process.env.TOSS_MTLS_KEY;

  if (!cert || !key) {
    console.warn('[auth/exchange] TOSS_MTLS_CERT 또는 TOSS_MTLS_KEY 미설정');
    return res.status(503).json({ error: 'mTLS 인증서 미설정' });
  }

  try {
    const { status, body } = await postWithMtls(
      JSON.stringify({ authorizationCode, referrer }),
      cert,
      key,
    );

    if (status < 200 || status >= 300) {
      console.error('[auth/exchange] 토큰 교환 실패:', status, body);
      return res.status(502).json({ error: '토큰 교환 실패', status });
    }

    let data: TossTokenResponse;
    try {
      data = JSON.parse(body) as TossTokenResponse;
    } catch {
      console.error('[auth/exchange] 응답 JSON 파싱 실패:', body);
      return res.status(502).json({ error: '응답 파싱 실패', rawBody: body.slice(0, 500) });
    }

    // resultType=FAIL이면 reason을 그대로 detail로 surface
    if (data.resultType === 'FAIL') {
      const reason = data.error?.reason ?? data.error?.errorCode ?? '알 수 없는 오류';
      console.error('[auth/exchange] Toss FAIL:', reason);
      return res.status(502).json({
        error: '토큰 교환 거절',
        rawBody: reason.slice(0, 500),
      });
    }

    // SUCCESS shape (success.userKey) 우선, 호환 위해 평면 userKey도 fallback
    const userKey = data.success?.userKey ?? data.userKey;

    if (!userKey) {
      console.error('[auth/exchange] userKey 미포함 응답:', body);
      return res.status(502).json({
        error: 'userKey 미포함 응답',
        rawBody: body.slice(0, 500),
      });
    }

    return res.status(200).json({ userKey });
  } catch (err) {
    console.error('[auth/exchange] 예외:', err);
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: 'Internal Server Error', detail: message });
  }
}

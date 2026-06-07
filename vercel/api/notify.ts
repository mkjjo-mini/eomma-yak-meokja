/**
 * POST /api/notify — 케어 대상 체크/MISSED 이벤트 → 케어러 푸시
 *
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-08-family.md §처리 3-4
 *  - references/dev-guide/smart-message/develop.md §메시지 발송 API
 *    POST /api-partner/v1/apps-in-toss/messenger/send-message
 *    헤더: x-toss-user-key: {caregiverUserKey}
 *  - references/dev-guide/smart-message/intro.md §기능성 메시지
 *    // [기능성] 복약 이벤트 알림 — 서비스 본연의 상태 알림
 *  - references/dev-guide/development/integration-process.md §mTLS
 *    "mTLS 인증서: TOSS_MTLS_CERT + TOSS_MTLS_KEY (동일 인증서 재사용)"
 *
 * mTLS 필요: 예 (Toss 메시지 API 호출)
 * Ref: references/dev-guide/development/integration-process.md
 *   "기능성 푸시, 알림 → 반드시 mTLS 인증서를 통한 통신 필요"
 *
 * Smart Message 분류:
 * // [기능성] — 복약 완료/놓침은 서비스 이용 필수 정보 전달
 * Ref: references/dev-guide/smart-message/intro.md §기능성 메시지
 *   "서비스 이용 과정에서 발생하는 필수 정보를 전달하는 메시지"
 *   "구매 유도, 서비스 이용 유도, 혜택 안내, 리텐션 목적의 마케팅 요소는 기능성으로 발송할 수 없어요"
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import https from 'https';
import { getRecipientCaregivers, getCaregiverPair } from '../lib/kv';
import type { TossMessageResponse } from '../lib/types';

const TOSS_API_BASE = 'https://apps-in-toss-api.toss.im';
const SEND_MESSAGE_PATH = '/api-partner/v1/apps-in-toss/messenger/send-message';

// ─── mTLS Agent ──────────────────────────────────────────────────────────────
// Ref: references/dev-guide/development/integration-process.md §API 요청 시 인증서 설정
// Step 4에서 이미 주입된 동일 인증서 재사용 — 재발급 불필요

function getMtlsAgent(): https.Agent | null {
  const cert = process.env.TOSS_MTLS_CERT;
  const key = process.env.TOSS_MTLS_KEY;

  if (!cert || !key) {
    console.warn('[notify] TOSS_MTLS_CERT 또는 TOSS_MTLS_KEY 미설정');
    return null;
  }

  return new https.Agent({ cert, key });
}

// ─── 케어러 푸시 발송 ─────────────────────────────────────────────────────────

/**
 * // [기능성] 케어 대상 복약 이벤트 → 케어러 Toss 푸시
 *
 * Ref: references/dev-guide/smart-message/intro.md §기능성 메시지
 * Ref: references/dev-guide/smart-message/develop.md §메시지 발송 API
 *
 * templateSetCode 분기:
 *  - checked → TOSS_TEMPLATE_CODE_FAMILY_CHECK (콘솔 캠페인: 가족체크_기능성, 승인됨)
 *  - missed  → 미발송 (콘솔 캠페인: 가족놓침_기능성, 반려됨 → v2 재신청 예정)
 */
async function sendCaregiverPush(params: {
  caregiverUserKey: string;
  careRecipientNickname: string;
  routineLabel: string;
  takenAt: string;
  kind: 'checked' | 'missed';
  agent: https.Agent;
}): Promise<boolean> {
  const { caregiverUserKey, careRecipientNickname, routineLabel, takenAt, kind, agent } = params;

  // 가족놓침(MISSED) 알림은 토스 콘솔 가족놓침_기능성 캠페인이 검수 반려되어
  // v1 출시 범위에서 제외, v2에서 재신청 예정. 호출돼도 silent skip.
  if (kind === 'missed') {
    console.log('[notify] MISSED 알림은 v1 범위 외 (콘솔 반려, v2 예정) — 스킵');
    return false;
  }

  // 가족체크(CHECKED) 알림 — 콘솔 가족체크_기능성 캠페인 (승인 완료)
  // Vercel 환경변수 이름은 토스 콘솔 등록 변수명 그대로 사용
  const templateSetCode = process.env.TOSS_TEMPLATE_CODE_FAMILY_CHECK;

  if (!templateSetCode) {
    console.warn('[notify] TOSS_TEMPLATE_CODE_FAMILY_CHECK 미설정 — 발송 스킵');
    return false;
  }

  try {
    const response = await fetch(`${TOSS_API_BASE}${SEND_MESSAGE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Ref: references/dev-guide/smart-message/develop.md §요청 헤더
        // "x-toss-user-key: 토스 로그인을 통해 획득한 userKey 값"
        // 케어러 userKey로 발송
        'x-toss-user-key': caregiverUserKey,
      },
      body: JSON.stringify({
        templateSetCode,
        // Ref: references/dev-guide/smart-message/develop.md §요청 파라미터
        // context: 등록된 템플릿의 변수 전달
        // 사진 URL 포함 금지 — 데이터 최소화 원칙
        // Ref: step-08-family.md §처리 4 "푸시 payload에 회차 사진 URL 포함하지 않음"
        context: {
          nickname: careRecipientNickname,
          routineLabel,
          takenAt,
        },
      }),
      // @ts-expect-error Node.js fetch agent 확장
      agent,
    });

    const data = (await response.json()) as TossMessageResponse;

    if (data.resultType === 'SUCCESS') {
      console.log(
        `[notify] 케어러 푸시 성공 caregiverKey=${caregiverUserKey} kind=${kind} label=${routineLabel}`,
      );
      return true;
    } else {
      // 발송 실패는 로그만 남기고 200으로 응답 — 케어 대상 폰의 로컬 체크는 별개
      // Ref: step-08-family.md §처리 3 "실패 케이스는 로그만 남기고 200으로 응답"
      console.warn(
        `[notify] 케어러 푸시 실패 caregiverKey=${caregiverUserKey} resultType=${data.resultType}`,
        data.error,
      );
      return false;
    }
  } catch (err) {
    // 네트워크 오류 — 로그만 남기고 체크 상태 유지
    // Ref: step-08-family.md §검수 "Vercel Functions 호출 실패해도 로컬 체크 유지"
    console.error(`[notify] 케어러 푸시 예외 caregiverKey=${caregiverUserKey}:`, err);
    return false;
  }
}

// ─── 핸들러 ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { careRecipientUserKey, routineLabel, takenAt, kind } = req.body as {
    careRecipientUserKey?: string;
    routineLabel?: string;
    takenAt?: string;
    kind?: 'checked' | 'missed';
  };

  if (!careRecipientUserKey || !routineLabel || !takenAt || !kind) {
    return res.status(400).json({ error: 'missing_params' });
  }

  if (kind !== 'checked' && kind !== 'missed') {
    return res.status(400).json({ error: 'invalid_kind' });
  }

  const agent = getMtlsAgent();
  if (!agent) {
    // mTLS 미설정 시 200으로 응답 — 케어 대상 폰의 로컬 체크는 별개
    // Ref: step-08-family.md §처리 3 "실패해도 200으로 응답"
    console.warn('[notify] mTLS 미설정 — 케어러 푸시 스킵');
    return res.status(200).json({ ok: true, skipped: true, reason: 'mTLS 미설정' });
  }

  // pair:recipient:{careRecipientUserKey} → 케어러 목록 조회
  // Ref: step-08-family.md §처리 3
  const caregiverKeys = await getRecipientCaregivers(careRecipientUserKey);

  if (caregiverKeys.length === 0) {
    return res.status(200).json({ ok: true, sent: 0, reason: '페어링된 케어러 없음' });
  }

  let sentCount = 0;

  for (const caregiverUserKey of caregiverKeys) {
    // 케어러 레코드에서 careRecipientNickname 조회
    // Ref: step-08-family.md §처리 3 "별명은 KV의 pair:caregiver:{caregiverUserKey}에서 조회"
    const caregiverRecord = await getCaregiverPair(caregiverUserKey);
    const careRecipientNickname = caregiverRecord?.careRecipientNickname ?? '';

    const success = await sendCaregiverPush({
      caregiverUserKey,
      careRecipientNickname,
      routineLabel,
      takenAt,
      kind,
      agent,
    });

    if (success) sentCount++;
  }

  return res.status(200).json({ ok: true, sent: sentCount, total: caregiverKeys.length });
}

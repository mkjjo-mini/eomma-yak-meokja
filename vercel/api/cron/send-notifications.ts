/**
 * GET /api/cron/send-notifications  — Vercel Cron 핸들러
 *
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-04-notification.md §처리 3-4
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-08-family.md §처리 4
 *    "MISSED 이벤트도 동일 경로로 전달 — kind: 'missed'"
 *  - references/dev-guide/smart-message/develop.md §메시지 발송 API
 *    POST /api-partner/v1/apps-in-toss/messenger/send-message
 *    헤더: x-toss-user-key
 *  - references/dev-guide/smart-message/intro.md §기능성 메시지
 *    "[기능성] 복약 시간 알림 — 서비스 이용 필수 정보"
 *
 * mTLS 인증서: TOSS_MTLS_CERT + TOSS_MTLS_KEY (Vercel env, Production만)
 * Step 4에서 이미 주입된 동일 인증서 재사용 — 재발급 불필요
 * templateSetCode: TOSS_TEMPLATE_CODE_NOTIFY (콘솔: 복약알림_기능성, 승인됨. 없으면 발송 스킵 + 로그)
 *
 * Step 8a 추가:
 *  - 리마인더 발송 후 → 케어러에게 MISSED kind 푸시 추가 발송
 *  - 중복 방지: notifiedCaregiver:{routineId}:{YYYYMMDD}:missed TTL 25h
 *  Ref: step-08-family.md §처리 2 "Vercel Cron 통합"
 *
 * Cron 주기: vercel.json의 schedule 필드로 제어.
 * 무료 플랜(일 1회) vs Pro(매분) → CRON_SCHEDULE env로 추상화.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import https from 'https';
import {
  getSchedulesByTime,
  hasSentToday,
  markSentToday,
  hasReminderSentToday,
  markReminderSentToday,
  getRecipientCaregivers,
  getCaregiverPair,
  hasCaregiverNotifiedToday,
  markCaregiverNotifiedToday,
} from '../../lib/kv';
import type { ScheduleEntry, TossMessageResponse } from '../../lib/types';

const TOSS_API_BASE = 'https://apps-in-toss-api.toss.im';
const SEND_MESSAGE_PATH =
  '/api-partner/v1/apps-in-toss/messenger/send-message';

// ─── KST 시각 유틸 ──────────────────────────────────────────────────────────

function getKSTNow(): { timeHHMM: string; weekday: number; dateStr: string } {
  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;
  const kst = new Date(now.getTime() + kstOffset);

  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  const timeHHMM = `${hh}:${mm}`;

  // PRD 기준 요일: 0=월 … 6=일 (JS UTC 0=일 → 변환)
  const jsDay = kst.getUTCDay();
  const weekday = jsDay === 0 ? 6 : jsDay - 1;

  const dateStr = kst.toISOString().slice(0, 10);

  return { timeHHMM, weekday, dateStr };
}

// ─── mTLS Agent ──────────────────────────────────────────────────────────────

function getMtlsAgent(): https.Agent | null {
  const cert = process.env.TOSS_MTLS_CERT;
  const key = process.env.TOSS_MTLS_KEY;

  if (!cert || !key) {
    console.warn('[cron] TOSS_MTLS_CERT 또는 TOSS_MTLS_KEY 미설정');
    return null;
  }

  return new https.Agent({ cert, key });
}

// ─── Toss 메시지 API 호출 ────────────────────────────────────────────────────

/**
 * // [기능성] 복약 시간 알림
 * Ref: references/dev-guide/smart-message/intro.md §기능성 메시지
 *   "서비스 이용 과정에서 발생하는 필수 정보를 전달하는 메시지"
 * Ref: references/dev-guide/smart-message/develop.md §메시지 발송 API
 */
async function sendTossMessage(
  entry: ScheduleEntry,
  agent: https.Agent,
  templateSetCode: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${TOSS_API_BASE}${SEND_MESSAGE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Ref: references/dev-guide/smart-message/develop.md §요청 헤더
        'x-toss-user-key': entry.userKey,
      },
      body: JSON.stringify({
        templateSetCode,
        // Ref: references/dev-guide/smart-message/develop.md §요청 파라미터
        // userName은 Toss가 자동 제공 — 전달 불필요
        context: {
          routineLabel: entry.label,
          nickname: entry.nickname,
        },
      }),
      // @ts-expect-error Node.js fetch agent 확장
      agent,
    });

    const data = (await response.json()) as TossMessageResponse;

    if (data.resultType === 'SUCCESS') {
      console.log(
        `[cron] 발송 성공 routineId=${entry.routineId} label=${entry.label}`,
      );
      return true;
    } else {
      console.warn(
        `[cron] 발송 실패 routineId=${entry.routineId} resultType=${data.resultType}`,
        data.error,
      );
      return false;
    }
  } catch (err) {
    console.error(`[cron] 발송 예외 routineId=${entry.routineId}:`, err);
    return false;
  }
}

// ─── 리마인더 발송 ────────────────────────────────────────────────────────────

/**
 * 복용 시간 + 30분 경과 여부 판단.
 * "HH:MM" 형식 두 값을 분 단위로 비교.
 *
 * Ref: PRD step-05 §처리 1
 *   "복용 시간 + 30분 경과 && 상태 = NOTIFIED"
 */
function isThirtyMinutesPast(scheduleTimeHHMM: string, nowHHMM: string): boolean {
  const [sh, sm] = scheduleTimeHHMM.split(':').map(Number);
  const [nh, nm] = nowHHMM.split(':').map(Number);
  if (sh === undefined || sm === undefined || nh === undefined || nm === undefined) {
    return false;
  }
  const scheduleMinutes = sh * 60 + sm;
  const nowMinutes = nh * 60 + nm;
  return nowMinutes >= scheduleMinutes + 30;
}

/**
 * // [기능성] 리마인더 메시지 발송
 * 복용 시간 + 30분 경과 후에도 NOTIFIED 상태인 회차에 1회 발송.
 *
 * Ref: PRD step-05 §처리 1
 *   "[별명], [회차 레이블] 아직 안 드셨어요"
 * Ref: references/dev-guide/smart-message/develop.md §메시지 발송 API
 * Ref: references/dev-guide/smart-message/intro.md §기능성 메시지
 */
async function sendReminderMessage(
  entry: ScheduleEntry,
  agent: https.Agent,
  templateSetCode: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${TOSS_API_BASE}${SEND_MESSAGE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Ref: references/dev-guide/smart-message/develop.md §요청 헤더
        'x-toss-user-key': entry.userKey,
      },
      body: JSON.stringify({
        // TOSS_TEMPLATE_CODE_REMINDER 사용 (콘솔: 복약리마인더_기능성, 승인됨)
        templateSetCode,
        // Ref: references/dev-guide/smart-message/develop.md §요청 파라미터
        context: {
          routineLabel: entry.label,
          nickname: entry.nickname,
        },
      }),
      // @ts-expect-error Node.js fetch agent 확장
      agent,
    });

    const data = (await response.json()) as TossMessageResponse;

    if (data.resultType === 'SUCCESS') {
      console.log(
        `[cron/reminder] 발송 성공 routineId=${entry.routineId} label=${entry.label}`,
      );
      return true;
    } else {
      console.warn(
        `[cron/reminder] 발송 실패 routineId=${entry.routineId} resultType=${data.resultType}`,
        data.error,
      );
      return false;
    }
  } catch (err) {
    console.error(`[cron/reminder] 발송 예외 routineId=${entry.routineId}:`, err);
    return false;
  }
}

// ─── 케어러 MISSED 푸시 (Step 8a) ────────────────────────────────────────────

/**
 * // [기능성] 리마인더 발송 후 케어러에게 MISSED 이벤트 푸시
 *
 * Ref: step-08-family.md §처리 4
 *   "MISSED 이벤트도 동일 경로로 전달 — mommed_missed_v1 템플릿 사용"
 * Ref: references/dev-guide/smart-message/intro.md §기능성 메시지
 *   "서비스 이용 과정에서 발생하는 필수 정보 전달"
 *   "광고성 문구 없음"
 *
 * 중복 방지: notifiedCaregiver:{routineId}:{YYYYMMDD}:missed TTL 25h
 * Ref: step-08-family.md §처리 2 "중복 방지"
 */
async function notifyCaregiversMissed(params: {
  entry: ScheduleEntry;
  dateStr: string;
  agent: https.Agent;
}): Promise<void> {
  const { entry, dateStr, agent } = params;

  // 중복 발송 방지
  const alreadyNotified = await hasCaregiverNotifiedToday(entry.routineId, dateStr, 'missed');
  if (alreadyNotified) {
    console.log(
      `[cron/caregiver-missed] 이미 발송 스킵 routineId=${entry.routineId}`,
    );
    return;
  }

  // 케어 대상 userKey → 연결된 케어러 목록 조회
  // Ref: step-08-family.md §처리 3 "pair:recipient:{careRecipientUserKey} 조회"
  const caregiverKeys = await getRecipientCaregivers(entry.userKey);
  if (caregiverKeys.length === 0) return;

  // 가족놓침(MISSED) 알림은 토스 콘솔 가족놓침_기능성 캠페인이 검수 반려되어
  // v1 출시 범위에서 제외, v2에서 재신청 예정. 환경변수 자체를 미등록 상태로 유지 → 자연스러운 skip.
  const missedTemplateCode = process.env.TOSS_MISSED_TEMPLATE_CODE;
  if (!missedTemplateCode) {
    console.log('[cron/caregiver-missed] MISSED 알림은 v1 범위 외 (콘솔 반려, v2 예정) — 스킵');
    return;
  }

  let anySent = false;

  for (const caregiverUserKey of caregiverKeys) {
    // 케어러 레코드에서 careRecipientNickname 조회
    // Ref: step-08-family.md §처리 3 "별명은 KV의 pair:caregiver:{caregiverUserKey}에서 조회"
    const caregiverRecord = await getCaregiverPair(caregiverUserKey);
    const nickname = caregiverRecord?.careRecipientNickname ?? entry.nickname;

    try {
      const response = await fetch(`${TOSS_API_BASE}${SEND_MESSAGE_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Ref: references/dev-guide/smart-message/develop.md §요청 헤더
          // 케어러 userKey로 발송
          'x-toss-user-key': caregiverUserKey,
        },
        body: JSON.stringify({
          // mommed_missed_v1 템플릿
          // Ref: step-08-family.md §검수 "MISSED 이벤트는 mommed_missed_v1 템플릿 사용"
          templateSetCode: missedTemplateCode,
          // 사진 URL 포함 금지 — 데이터 최소화 원칙
          // Ref: step-08-family.md §처리 4 "푸시 payload에 회차 사진 URL 포함하지 않음"
          context: {
            nickname,
            routineLabel: entry.label,
            takenAt: new Date().toISOString(),
          },
        }),
        // @ts-expect-error Node.js fetch agent 확장
        agent,
      });

      const data = (await response.json()) as TossMessageResponse;
      if (data.resultType === 'SUCCESS') {
        console.log(
          `[cron/caregiver-missed] 발송 성공 caregiverKey=${caregiverUserKey} routineId=${entry.routineId}`,
        );
        anySent = true;
      } else {
        console.warn(
          `[cron/caregiver-missed] 발송 실패 caregiverKey=${caregiverUserKey} resultType=${data.resultType}`,
        );
      }
    } catch (err) {
      console.error(`[cron/caregiver-missed] 예외 caregiverKey=${caregiverUserKey}:`, err);
    }
  }

  if (anySent) {
    // 중복 발송 방지 플래그 저장 TTL 25h
    // Ref: step-08-family.md §처리 2 "notifiedCaregiver:{routineId}:{YYYYMMDD}:{kind} TTL 25h"
    await markCaregiverNotifiedToday(entry.routineId, dateStr, 'missed');
  }
}

// ─── Cron 핸들러 ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel Cron은 GET으로 호출
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Vercel Cron 인증 헤더 검증
  // Ref: https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
  const authHeader = req.headers.authorization;
  if (
    process.env.NODE_ENV === 'production' &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 복약알림 (본인 폰) — 콘솔 복약알림_기능성 캠페인 (승인 완료)
  const templateSetCode = process.env.TOSS_TEMPLATE_CODE_NOTIFY;
  if (!templateSetCode) {
    // templateSetCode 없으면 발송 스킵 + 로그만
    // Ref: PRD §처리 "TOSS_TEMPLATE_CODE_NOTIFY가 없으면 발송 스킵 + 로그만 출력"
    console.warn('[cron] TOSS_TEMPLATE_CODE_NOTIFY 미설정 — 발송 스킵');
    return res.status(200).json({ skipped: true, reason: 'TOSS_TEMPLATE_CODE_NOTIFY 미설정' });
  }

  const agent = getMtlsAgent();
  if (!agent) {
    return res.status(503).json({ error: 'mTLS 인증서 미설정' });
  }

  const { timeHHMM, weekday, dateStr } = getKSTNow();
  console.log(`[cron] 실행 시각(KST): ${dateStr} ${timeHHMM} (요일=${weekday})`);

  // 현재 시각과 일치하는 스케줄 조회
  const schedules = await getSchedulesByTime(timeHHMM);
  console.log(`[cron] 대상 스케줄 수: ${schedules.length}`);

  let sentCount = 0;
  let skippedCount = 0;

  for (const entry of schedules) {
    // 요일 필터 (0=월 … 6=일, PRD 기준)
    // Ref: PRD §처리 "오늘 요일 필터 (weekdays 기준, KST)"
    if (!entry.weekdays.includes(weekday)) {
      console.log(`[cron] 요일 불일치 스킵 routineId=${entry.routineId}`);
      skippedCount++;
      continue;
    }

    // 중복 발송 방지 (하루 1회)
    // Ref: PRD §처리 "발송 완료 후 오늘자 중복 발송 방지 플래그 KV 저장"
    const alreadySent = await hasSentToday(entry.routineId, dateStr);
    if (alreadySent) {
      console.log(`[cron] 오늘 이미 발송 스킵 routineId=${entry.routineId}`);
      skippedCount++;
      continue;
    }

    // // [기능성] Toss 메시지 API 호출
    const success = await sendTossMessage(entry, agent, templateSetCode);

    if (success) {
      // 발송 완료 플래그 저장
      await markSentToday(entry.routineId, dateStr);
      sentCount++;
    }
  }

  // ─── 리마인더 체크 ────────────────────────────────────────────────────────
  // Ref: PRD step-05 §처리 1
  //   "복용 시간 + 30분 경과 && 상태 = NOTIFIED && 오늘 리마인더 미발송"
  //
  // 리마인더 대상: 오늘 기준 모든 스케줄 중 아직 체크 안 된(NOTIFIED) 회차.
  // Vercel은 Storage 직접 접근 불가 → NOTIFIED 상태를 KV의 sent 플래그로 추론:
  //   - hasSentToday = true  → 알림 발송됨 = NOTIFIED 가능성 있음
  //   - hasReminderSentToday = false → 리마인더 미발송
  //   - isThirtyMinutesPast(entry.time, timeHHMM) = true → 30분 경과

  // 복약 리마인더 (본인 폰) — 콘솔 복약리마인더_기능성 캠페인 (승인 완료)
  const reminderTemplateSetCode = process.env.TOSS_TEMPLATE_CODE_REMINDER;

  let reminderSentCount = 0;
  let reminderSkippedCount = 0;

  if (!reminderTemplateSetCode) {
    console.warn('[cron/reminder] TOSS_TEMPLATE_CODE_REMINDER 미설정 — 리마인더 스킵');
  } else {
    // 모든 스케줄 대상 (시각 무관하게 SCAN 후 30분 경과 여부로 필터)
    // 매분 실행 cron이므로 scan은 기존 getSchedulesByTime 대신 전체 조회 필요.
    // 단, getSchedulesByTime을 재활용하되 "모든 시각" 대상 = 별도 전체 scan.
    // 구현 단순화: schedules 배열(현재 분 조회 결과)과 무관하게
    // 전체 스케줄에서 리마인더 대상을 조회한다.
    // → 기존 kv.scan 패턴을 kv 모듈 내부에 두지 않고 여기서 직접 처리.
    const { Redis } = await import('@upstash/redis');
    const kv = Redis.fromEnv({ automaticDeserialization: false });
    const allSchedules: ScheduleEntry[] = [];
    let cursor = 0;
    do {
      const [nextCursor, keys] = await kv.scan(cursor, {
        match: 'schedule:*',
        count: 100,
      });
      cursor = Number(nextCursor);
      if (keys.length > 0) {
        const values = await kv.mget<string[]>(...keys);
        for (const raw of values) {
          if (!raw) continue;
          try {
            allSchedules.push(JSON.parse(raw) as ScheduleEntry);
          } catch {
            // 파싱 오류 무시
          }
        }
      }
    } while (cursor !== 0);

    for (const entry of allSchedules) {
      // 요일 필터
      if (!entry.weekdays.includes(weekday)) {
        reminderSkippedCount++;
        continue;
      }

      // 오늘 기본 알림 발송 완료 여부 확인 (= 알림을 받아 NOTIFIED 상태일 것으로 추론)
      const sentToday = await hasSentToday(entry.routineId, dateStr);
      if (!sentToday) {
        // 기본 알림 미발송 = 아직 복용 시간 전이거나 알림 스킵 → 리마인더 불필요
        reminderSkippedCount++;
        continue;
      }

      // 복용 시간 + 30분 경과 여부
      // Ref: PRD step-05 §처리 1 "복용 시간 + 30분 경과"
      if (!isThirtyMinutesPast(entry.time, timeHHMM)) {
        reminderSkippedCount++;
        continue;
      }

      // 오늘 리마인더 중복 발송 방지
      // Ref: PRD step-05 §처리 1 "리마인더 하루 1회만 발송"
      const reminderAlreadySent = await hasReminderSentToday(entry.routineId, dateStr);
      if (reminderAlreadySent) {
        console.log(`[cron/reminder] 오늘 이미 리마인더 발송 스킵 routineId=${entry.routineId}`);
        reminderSkippedCount++;
        continue;
      }

      // // [기능성] 리마인더 발송
      const success = await sendReminderMessage(entry, agent, reminderTemplateSetCode);

      if (success) {
        // Ref: PRD step-05 §처리 1 "발송 후 KV에 reminderSent 플래그 저장"
        await markReminderSentToday(entry.routineId, dateStr);
        reminderSentCount++;

        // Step 8a: 리마인더 발송 성공 후 → 케어러에게 MISSED 이벤트 푸시
        // Ref: step-08-family.md §처리 4 "MISSED 이벤트 푸시 (리마인더 지나고도 미체크)"
        // Ref: step-08-family.md §처리 2 "리마인더 발송 + MISSED 전이 후 → 페어링된 케어러에게 추가 푸시"
        // // [기능성] MISSED 이벤트 알림
        void notifyCaregiversMissed({ entry, dateStr, agent }).catch((err) => {
          console.warn('[cron] notifyCaregiversMissed 예외:', err);
        });
      }
    }
  }

  console.log(
    `[cron] 완료 — 발송: ${sentCount}, 스킵: ${skippedCount} | ` +
    `리마인더 발송: ${reminderSentCount}, 리마인더 스킵: ${reminderSkippedCount}`,
  );

  return res.status(200).json({
    ok: true,
    timeHHMM,
    dateStr,
    weekday,
    total: schedules.length,
    sent: sentCount,
    skipped: skippedCount,
    reminder: {
      sent: reminderSentCount,
      skipped: reminderSkippedCount,
    },
  });
}

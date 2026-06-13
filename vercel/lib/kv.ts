/**
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-04-notification.md §처리 2
 *    "Vercel KV에 저장: key = schedule:{routineId}"
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-08-family.md §처리 2
 *    "KV 키 설계: pair:code:*, pair:caregiver:*, pair:recipient:*"
 *
 * KV 래퍼. @vercel/kv가 deprecated되어 @upstash/redis로 마이그레이션 (2026-04-26).
 * Vercel Marketplace에서 Upstash Redis integration 설치 필요.
 * env: KV_REST_API_URL / KV_REST_API_TOKEN (Vercel Marketplace 기본 주입 이름).
 *      UPSTASH_REDIS_REST_URL / TOKEN (직접 Upstash 가입 케이스 fallback).
 *
 * automaticDeserialization: false 설정으로 기존 JSON.stringify/parse 코드 호환성 유지.
 */
import { Redis } from '@upstash/redis';
import type { ScheduleEntry, PairCodeEntry, CaregiverPairEntry } from './types';

const REDIS_URL =
  process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? '';
const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? '';

const kv = new Redis({
  url: REDIS_URL,
  token: REDIS_TOKEN,
  automaticDeserialization: false,
});

const SCHEDULE_PREFIX = 'schedule:';
const SENT_PREFIX = 'sent:';

/**
 * 스케줄 저장 (upsert).
 * key = schedule:{routineId}
 */
export async function setSchedule(routineId: string, entry: ScheduleEntry): Promise<void> {
  await kv.set(`${SCHEDULE_PREFIX}${routineId}`, JSON.stringify(entry));
}

/**
 * 스케줄 조회.
 */
export async function getSchedule(routineId: string): Promise<ScheduleEntry | null> {
  const raw = await kv.get<string>(`${SCHEDULE_PREFIX}${routineId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ScheduleEntry;
  } catch {
    return null;
  }
}

/**
 * 스케줄 삭제.
 */
export async function deleteScheduleEntry(routineId: string): Promise<void> {
  await kv.del(`${SCHEDULE_PREFIX}${routineId}`);
}

/**
 * HH:MM 시각에 발송해야 하는 스케줄 전체 조회.
 * SCAN으로 schedule:* 키를 조회 후 time 필터링.
 */
export async function getSchedulesByTime(timeHHMM: string): Promise<ScheduleEntry[]> {
  const results: ScheduleEntry[] = [];
  let cursor = 0;

  do {
    const [nextCursor, keys] = await kv.scan(cursor, {
      match: `${SCHEDULE_PREFIX}*`,
      count: 100,
    });
    cursor = Number(nextCursor);

    if (keys.length > 0) {
      const values = await kv.mget<string[]>(...keys);
      for (const raw of values) {
        if (!raw) continue;
        try {
          const entry = JSON.parse(raw) as ScheduleEntry;
          if (entry.time === timeHHMM) {
            results.push(entry);
          }
        } catch {
          // 파싱 오류 무시
        }
      }
    }
  } while (cursor !== 0);

  return results;
}

/**
 * 오늘 이미 발송했는지 확인.
 * key = sent:{routineId}:{YYYY-MM-DD}
 * Ref: PRD §처리 "발송 완료 후 오늘자 중복 발송 방지 플래그 KV 저장"
 */
export async function hasSentToday(routineId: string, dateStr: string): Promise<boolean> {
  const key = `${SENT_PREFIX}${routineId}:${dateStr}`;
  const val = await kv.get<string>(key);
  return val === 'sent';
}

/**
 * 오늘 발송 완료 플래그 저장 (25시간 TTL).
 */
export async function markSentToday(routineId: string, dateStr: string): Promise<void> {
  const key = `${SENT_PREFIX}${routineId}:${dateStr}`;
  await kv.set(key, 'sent', { ex: 25 * 60 * 60 });
}

// ─── 리마인더 KV 헬퍼 ────────────────────────────────────────────────────────
// Ref: PRD step-05 §처리 1 "중복 방지 플래그 저장"

const REMINDER_PREFIX = 'reminderSent:';

/**
 * 오늘 리마인더를 이미 발송했는지 확인.
 * key = reminderSent:{routineId}:{YYYY-MM-DD}
 */
export async function hasReminderSentToday(
  routineId: string,
  dateStr: string,
): Promise<boolean> {
  const key = `${REMINDER_PREFIX}${routineId}:${dateStr}`;
  const val = await kv.get<string>(key);
  return val === 'sent';
}

/**
 * 리마인더 발송 완료 플래그 저장 (25시간 TTL).
 */
export async function markReminderSentToday(
  routineId: string,
  dateStr: string,
): Promise<void> {
  const key = `${REMINDER_PREFIX}${routineId}:${dateStr}`;
  await kv.set(key, 'sent', { ex: 25 * 60 * 60 });
}

// ─── 페어링 KV 헬퍼 (Step 8a) ────────────────────────────────────────────────
// Ref: PRD step-08-family.md §처리 2
// KV 키 설계:
//   pair:code:{code}              → PairCodeEntry  TTL 300s (5분)
//   pair:caregiver:{cgUserKey}    → CaregiverPairEntry  영구
//   pair:recipient:{crUserKey}    → string[] (caregiverUserKey 배열)  영구

const PAIR_CODE_PREFIX = 'pair:code:';
const PAIR_CAREGIVER_PREFIX = 'pair:caregiver:';
const PAIR_RECIPIENT_PREFIX = 'pair:recipient:';

/**
 * 페어링 코드 임시 저장 (TTL 5분 = 300초).
 * Ref: step-08-family.md §처리 1 "TTL 5분"
 */
export async function setPairCode(code: string, entry: PairCodeEntry): Promise<void> {
  await kv.set(`${PAIR_CODE_PREFIX}${code}`, JSON.stringify(entry), { ex: 300 });
}

/**
 * 페어링 코드 조회.
 */
export async function getPairCode(code: string): Promise<PairCodeEntry | null> {
  const raw = await kv.get<string>(`${PAIR_CODE_PREFIX}${code}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PairCodeEntry;
  } catch {
    return null;
  }
}

/**
 * 페어링 코드 삭제 (확정 후 재사용 방지).
 * Ref: step-08-family.md §처리 1 "pair:code:{code} 삭제 (재사용 방지)"
 */
export async function deletePairCode(code: string): Promise<void> {
  await kv.del(`${PAIR_CODE_PREFIX}${code}`);
}

/**
 * 케어러 → 케어 대상 페어링 영구 저장.
 * key = pair:caregiver:{caregiverUserKey}
 * Ref: step-08-family.md §처리 1
 */
export async function setCaregiverPair(
  caregiverUserKey: string,
  entry: CaregiverPairEntry,
): Promise<void> {
  await kv.set(`${PAIR_CAREGIVER_PREFIX}${caregiverUserKey}`, JSON.stringify(entry));
}

/**
 * 케어러 페어링 레코드 조회.
 */
export async function getCaregiverPair(
  caregiverUserKey: string,
): Promise<CaregiverPairEntry | null> {
  const raw = await kv.get<string>(`${PAIR_CAREGIVER_PREFIX}${caregiverUserKey}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CaregiverPairEntry;
  } catch {
    return null;
  }
}

/**
 * 케어러 페어링 레코드 삭제.
 */
export async function deleteCaregiverPair(caregiverUserKey: string): Promise<void> {
  await kv.del(`${PAIR_CAREGIVER_PREFIX}${caregiverUserKey}`);
}

/**
 * 케어 대상 → 케어러 배열 조회.
 * key = pair:recipient:{careRecipientUserKey}
 * Ref: step-08-family.md §처리 1 "배열 — 가족 확장 IAP 대비. 8a에선 항상 1명만 추가"
 */
export async function getRecipientCaregivers(
  careRecipientUserKey: string,
): Promise<string[]> {
  const raw = await kv.get<string>(`${PAIR_RECIPIENT_PREFIX}${careRecipientUserKey}`);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

/**
 * 케어 대상 → 케어러 배열 영구 저장.
 */
export async function setRecipientCaregivers(
  careRecipientUserKey: string,
  caregiverUserKeys: string[],
): Promise<void> {
  await kv.set(
    `${PAIR_RECIPIENT_PREFIX}${careRecipientUserKey}`,
    JSON.stringify(caregiverUserKeys),
  );
}

/**
 * 케어 대상 → 케어러 배열 삭제.
 */
export async function deleteRecipientCaregivers(careRecipientUserKey: string): Promise<void> {
  await kv.del(`${PAIR_RECIPIENT_PREFIX}${careRecipientUserKey}`);
}

/**
 * 케어러 푸시 중복 방지 플래그 확인.
 * key = notifiedCaregiver:{routineId}:{YYYYMMDD}:{kind}  TTL 25h
 * Ref: step-08-family.md §처리 2 "중복 방지"
 */
export async function hasCaregiverNotifiedToday(
  routineId: string,
  dateStr: string,
  kind: 'checked' | 'missed',
): Promise<boolean> {
  const key = `notifiedCaregiver:${routineId}:${dateStr}:${kind}`;
  const val = await kv.get<string>(key);
  return val === 'sent';
}

/**
 * 케어러 푸시 중복 방지 플래그 저장 (TTL 25h).
 */
export async function markCaregiverNotifiedToday(
  routineId: string,
  dateStr: string,
  kind: 'checked' | 'missed',
): Promise<void> {
  const key = `notifiedCaregiver:${routineId}:${dateStr}:${kind}`;
  await kv.set(key, 'sent', { ex: 25 * 60 * 60 });
}

// ─── 케어 대상 오늘 상태 스냅샷 (Pull 방식) ───────────────────────────────────
// key = care:status:{careRecipientUserKey}:{YYYYMMDD}  TTL 48h
// Ref: step-08-family.md §처리 4 (Pull 방식 가족 현황)

const CARE_STATUS_PREFIX = 'care:status:';
const CARE_STATUS_TTL = 48 * 60 * 60; // 48h

/**
 * 케어 대상 오늘 복약 상태 저장.
 * 체크/언체크 시점에 케어 대상 폰이 호출.
 */
export async function setCareStatus(
  recipientUserKey: string,
  dateStr: string,
  entry: import('./types').CareStatusEntry,
): Promise<void> {
  const key = `${CARE_STATUS_PREFIX}${recipientUserKey}:${dateStr}`;
  await kv.set(key, JSON.stringify(entry), { ex: CARE_STATUS_TTL });
}

/**
 * 케어 대상 오늘 복약 상태 조회.
 * 케어러 폰이 미니앱 진입 시 호출.
 */
export async function getCareStatus(
  recipientUserKey: string,
  dateStr: string,
): Promise<import('./types').CareStatusEntry | null> {
  const key = `${CARE_STATUS_PREFIX}${recipientUserKey}:${dateStr}`;
  const raw = await kv.get<string>(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as import('./types').CareStatusEntry;
  } catch {
    return null;
  }
}

/**
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-04-notification.md §처리 2
 *    "회차 등록/수정/삭제 시 Vercel Functions /api/schedule에 스케줄 등록"
 *  - references/dev-guide/smart-message/develop.md §메시지 발송 API
 *  - references/sdk/framework/저장소/Storage.md (pendingSchedule 재시도 큐)
 *
 * 네트워크 실패 시: 로컬 저장 유지 + pendingSchedule 큐에 적재.
 * VERCEL_API_URL: EXPO_PUBLIC_VERCEL_API_URL 또는 VERCEL_API_URL env.
 */
import { Storage } from '@apps-in-toss/framework';
import {
  type SchedulePayload,
  type PendingScheduleItem,
  SCHEDULE_STORAGE_KEYS,
} from '../types/schedule';

import { getVercelApiUrl } from './config';

// ─── 재시도 큐 유틸 ──────────────────────────────────────────────────────────

async function getPendingQueue(): Promise<PendingScheduleItem[]> {
  const raw = await Storage.getItem(SCHEDULE_STORAGE_KEYS.PENDING_SCHEDULE);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as PendingScheduleItem[];
  } catch {
    return [];
  }
}

async function savePendingQueue(queue: PendingScheduleItem[]): Promise<void> {
  await Storage.setItem(SCHEDULE_STORAGE_KEYS.PENDING_SCHEDULE, JSON.stringify(queue));
}

async function addToPendingQueue(item: PendingScheduleItem): Promise<void> {
  const queue = await getPendingQueue();
  // 동일 routineId의 이전 항목 교체 (중복 방지)
  const filtered = queue.filter((q) => {
    if (q.action === 'upsert' && item.action === 'upsert') {
      return q.payload.routineId !== item.payload.routineId;
    }
    if (q.action === 'delete' && item.action === 'delete') {
      return q.routineId !== item.routineId;
    }
    return true;
  });
  await savePendingQueue([...filtered, item]);
}

async function removeFromPendingQueue(routineId: string): Promise<void> {
  const queue = await getPendingQueue();
  const filtered = queue.filter((q) => {
    if (q.action === 'upsert') return q.payload.routineId !== routineId;
    if (q.action === 'delete') return q.routineId !== routineId;
    return true;
  });
  await savePendingQueue(filtered);
}

// ─── 스케줄 등록/업데이트 ────────────────────────────────────────────────────

/**
 * 회차 등록/수정 시 Vercel KV에 스케줄 upsert.
 * 네트워크 실패 시 pendingSchedule 큐에 적재.
 *
 * Ref: PRD §처리 2 "{ userKey, routineId, time, weekdays, label, nickname }"
 */
export async function upsertSchedule(payload: SchedulePayload): Promise<void> {
  const url = getVercelApiUrl();
  if (!url) {
    console.warn('[scheduleService] VERCEL_API_URL 미설정 — 큐에 적재');
    await addToPendingQueue({
      action: 'upsert',
      payload,
      failedAt: new Date().toISOString(),
    });
    return;
  }

  try {
    const response = await fetch(`${url}/api/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // 성공 시 해당 routineId의 pending 항목 제거
    await removeFromPendingQueue(payload.routineId);
  } catch (err) {
    // 네트워크 실패 — 로컬 저장 유지, 재시도 큐 적재
    // Ref: PRD §처리 2 "네트워크 실패 시 로컬 저장은 유지, 재시도 큐에 적재"
    console.warn('[scheduleService] upsertSchedule 실패, 큐 적재:', err);
    await addToPendingQueue({
      action: 'upsert',
      payload,
      failedAt: new Date().toISOString(),
    });
  }
}

// ─── 스케줄 삭제 ─────────────────────────────────────────────────────────────

/**
 * 회차 삭제 시 Vercel KV에서 스케줄 제거.
 * 네트워크 실패 시 pendingSchedule 큐에 적재.
 *
 * Ref: PRD §처리 2 "DELETE /api/schedule?routineId={id}&userKey={key}"
 */
export async function deleteSchedule(routineId: string, userKey: string): Promise<void> {
  const url = getVercelApiUrl();
  if (!url) {
    console.warn('[scheduleService] VERCEL_API_URL 미설정 — 큐에 적재');
    await addToPendingQueue({
      action: 'delete',
      routineId,
      userKey,
      failedAt: new Date().toISOString(),
    });
    return;
  }

  try {
    const params = new URLSearchParams({ routineId, userKey });
    const response = await fetch(`${url}/api/schedule?${params.toString()}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    await removeFromPendingQueue(routineId);
  } catch (err) {
    console.warn('[scheduleService] deleteSchedule 실패, 큐 적재:', err);
    await addToPendingQueue({
      action: 'delete',
      routineId,
      userKey,
      failedAt: new Date().toISOString(),
    });
  }
}

// ─── 재시도 큐 처리 (앱 포그라운드 복귀 시 호출) ─────────────────────────────

/**
 * pendingSchedule 큐에 있는 항목을 순서대로 재시도.
 * 성공한 항목은 큐에서 제거. 실패한 항목은 유지.
 */
export async function flushPendingQueue(): Promise<void> {
  const url = getVercelApiUrl();
  if (!url) return;

  const queue = await getPendingQueue();
  if (queue.length === 0) return;

  const remaining: PendingScheduleItem[] = [];

  for (const item of queue) {
    try {
      if (item.action === 'upsert') {
        const response = await fetch(`${url}/api/schedule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.payload),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } else if (item.action === 'delete') {
        const params = new URLSearchParams({
          routineId: item.routineId,
          userKey: item.userKey,
        });
        const response = await fetch(`${url}/api/schedule?${params.toString()}`, {
          method: 'DELETE',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      }
    } catch {
      // 재시도 실패 → 큐에 남김
      remaining.push(item);
    }
  }

  await savePendingQueue(remaining);
}

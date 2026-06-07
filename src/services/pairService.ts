/**
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-08-family.md §처리 2-5
 *  - references/sdk/framework/로그인/appLogin.md §예제
 *    "appLogin은 authorizationCode를 반환. 서버에서 토큰 교환 후 userKey 발급."
 *  - references/dev-guide/smart-message/intro.md §기능성 메시지
 *    // [기능성] 복약 이벤트 알림
 *  - references/dev-guide/design/consumer-ux-guide.md §강제 로그인 금지
 *    "다크패턴 방지: notifyCaregivers 실패해도 로컬 체크 유지"
 *
 * 데이터 최소화 원칙:
 *  - 케어러 폰 Storage: pairings + caregiverEvents 만 저장
 *  - routines, records, photoBase64, medications 저장 금지
 *  Ref: step-08-family.md §처리 5
 *
 * mTLS 필요: 예 (/api/notify → Toss 메시지 API 호출)
 * Ref: references/dev-guide/development/integration-process.md
 */

import { Storage } from '@apps-in-toss/framework';
import { PAIR_STORAGE_KEYS } from '../types/pair';
import type { PairingRecord, CaregiverEvent } from '../types/pair';
import { SCHEDULE_STORAGE_KEYS } from '../types/schedule';

/**
 * 가족 알림 발송 활성화 플래그 (v1: false).
 *
 * Why false in v1:
 *  - 토스 스마트 발송만 가능 (로컬 알림 SDK 부재 — Apps-in-Toss 미지원)
 *  - 스마트 발송은 비즈월렛 차감(건당 약 2~5원) → 수익 검증 전엔 순비용
 *  - 가족 페어링 자체는 동작, 알림 푸시만 비활성
 *
 * v2 활성화 조건:
 *  - 수익 모델 검증 (광고/구독 매출 > 알림 비용)
 *  - 또는 IAP 구독자 전용 알림 정책 도입
 *  - 활성 시: 이 상수만 true로 바꾸면 됨 (큐·재시도 로직 그대로 사용 가능)
 */
const NOTIFY_ENABLED = false;

/** 런타임 시점에 env 읽기 */
function getVercelApiUrl(): string {
  return (
    (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_VERCEL_API_URL) ||
    (typeof process !== 'undefined' && process.env?.VERCEL_API_URL) ||
    ''
  );
}

// ─── 페어링 코드 생성 (케어 대상 폰) ──────────────────────────────────────────

/**
 * 케어 대상 폰에서 6자리 페어링 코드 생성.
 * POST /api/pair → { code, expiresAt }
 *
 * Ref: step-08-family.md §처리 2 "케어 대상 폰에서 코드 생성"
 */
export async function generatePairingCode(): Promise<{ code: string; expiresAt: string }> {
  const userKey = await Storage.getItem(SCHEDULE_STORAGE_KEYS.USER_KEY);
  const nickname = await Storage.getItem('profile.nickname') ?? '';

  if (!userKey) {
    throw new Error('userKey 없음 — 로그인 필요');
  }

  const vercelApiUrl = getVercelApiUrl();
  if (!vercelApiUrl) {
    throw new Error('VERCEL_API_URL 미설정');
  }

  const response = await fetch(`${vercelApiUrl}/api/pair`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Ref: step-08-family.md §처리 1 "헤더 x-toss-user-key 검증"
      'x-toss-user-key': userKey,
    },
    body: JSON.stringify({
      careRecipientUserKey: userKey,
      careRecipientNickname: nickname,
    }),
  });

  if (!response.ok) {
    const err = (await response.json()) as { error?: string };
    throw new Error(err.error ?? 'pair_create_failed');
  }

  const data = (await response.json()) as { code: string; expiresAt: string };
  return data;
}

// ─── 페어링 확정 (케어러 폰) ──────────────────────────────────────────────────

/**
 * 케어러 폰에서 6자리 코드 입력 → 페어링 확정.
 * POST /api/pair/confirm
 *
 * Ref: step-08-family.md §처리 2 "케어러 폰이 코드 입력"
 * Ref: references/sdk/framework/로그인/appLogin.md §appLogin
 *   "케어러는 8a에서 첫 진입 시 appLogin 호출 후 userKey 저장"
 */
export async function confirmPairing(
  code: string,
): Promise<{ success: boolean; careRecipientNickname?: string; error?: string }> {
  const caregiverUserKey = await Storage.getItem(SCHEDULE_STORAGE_KEYS.USER_KEY);

  if (!caregiverUserKey) {
    return { success: false, error: 'userKey 없음 — 로그인 필요' };
  }

  const vercelApiUrl = getVercelApiUrl();
  if (!vercelApiUrl) {
    return { success: false, error: 'VERCEL_API_URL 미설정' };
  }

  try {
    const response = await fetch(`${vercelApiUrl}/api/pair/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, caregiverUserKey }),
    });

    if (response.status === 404) {
      // Ref: step-08-family.md §검수 "잘못된 코드 입력 시 '코드가 올바르지 않아요'"
      return { success: false, error: 'invalid_code' };
    }

    if (!response.ok) {
      const err = (await response.json()) as { error?: string };
      return { success: false, error: err.error ?? 'confirm_failed' };
    }

    const data = (await response.json()) as {
      success: boolean;
      careRecipientNickname: string;
    };

    if (data.success) {
      // 케어러 폰 Storage에 페어링 레코드 저장
      // Ref: step-08-family.md §처리 2 "케어러 폰 Storage에 페어링 레코드 저장"
      // 데이터 최소화: pairings 키만 — routines/records 저장 금지
      const existing = await getPairings();

      // 중복 방지
      const alreadyPaired = existing.some(
        (p) => p.caregiverUserKey === caregiverUserKey,
      );

      if (!alreadyPaired) {
        const newRecord: PairingRecord = {
          caregiverUserKey,
          careRecipientUserKey: '', // 서버에서 관리, 클라이언트 불필요
          careRecipientNickname: data.careRecipientNickname,
          pairedAt: new Date().toISOString(),
        };
        existing.push(newRecord);
        await Storage.setItem(PAIR_STORAGE_KEYS.PAIRINGS, JSON.stringify(existing));
      }

      return { success: true, careRecipientNickname: data.careRecipientNickname };
    }

    return { success: false, error: 'confirm_failed' };
  } catch (err) {
    console.warn('[pairService] confirmPairing 예외:', err);
    return { success: false, error: 'network_error' };
  }
}

// ─── 페어링 목록 조회 ─────────────────────────────────────────────────────────

/**
 * 로컬 Storage에서 페어링 목록 조회.
 * Ref: step-08-family.md §처리 5 "Storage 키 pairings"
 */
export async function getPairings(): Promise<PairingRecord[]> {
  const raw = await Storage.getItem(PAIR_STORAGE_KEYS.PAIRINGS);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as PairingRecord[];
  } catch {
    return [];
  }
}

/**
 * 케어 대상(엄마) 폰 전용:
 * 자기 userKey로 서버 KV에 매핑된 케어러(자식) 목록을 가져와 로컬 Storage에 캐싱.
 *
 * v1 정책 (옵션 2 — 별명 미적용):
 *  - 자식 별명은 알 수 없음 → caregiverUserKey만 채움
 *  - 표시 시 fallback 라벨: "가족 1", "가족 2" 등
 *
 * Ref: vercel/api/pair/list.ts (GET /api/pair/list)
 */
export async function refreshRecipientPairings(): Promise<PairingRecord[]> {
  const recipientUserKey = await Storage.getItem(SCHEDULE_STORAGE_KEYS.USER_KEY);
  if (!recipientUserKey) return await getPairings();

  const vercelApiUrl = getVercelApiUrl();
  if (!vercelApiUrl) return await getPairings();

  try {
    const url = new URL(`${vercelApiUrl}/api/pair/list`);
    url.searchParams.set('recipientUserKey', recipientUserKey);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'x-toss-user-key': recipientUserKey },
    });

    if (!response.ok) {
      console.warn('[pairService] refreshRecipientPairings HTTP', response.status);
      return await getPairings();
    }

    const data = (await response.json()) as { caregivers: string[] };
    const serverCaregivers = Array.isArray(data.caregivers) ? data.caregivers : [];

    // 기존 로컬과 머지 (pairedAt 보존)
    const existing = await getPairings();
    const existingMap = new Map(existing.map((p) => [p.caregiverUserKey, p]));

    const merged: PairingRecord[] = serverCaregivers.map((caregiverUserKey) => {
      const prior = existingMap.get(caregiverUserKey);
      return (
        prior ?? {
          caregiverUserKey,
          careRecipientUserKey: recipientUserKey,
          // 케어 대상 폰이라 careRecipientNickname은 자기 별명. v1엔 미사용.
          pairedAt: new Date().toISOString(),
        }
      );
    });

    await Storage.setItem(PAIR_STORAGE_KEYS.PAIRINGS, JSON.stringify(merged));
    return merged;
  } catch (err) {
    console.warn('[pairService] refreshRecipientPairings 예외:', err);
    return await getPairings();
  }
}

// ─── 페어링 해제 ──────────────────────────────────────────────────────────────

/**
 * 페어링 해제.
 * DELETE /api/pair + 로컬 Storage 정리.
 *
 * Ref: step-08-family.md §처리 1 "DELETE /api/pair"
 * Ref: step-08-family.md §검수 "페어링 해제 후엔 푸시가 중단되어야 한다"
 */
export async function unpair(target: {
  caregiverUserKey?: string;
  careRecipientUserKey?: string;
}): Promise<void> {
  const { caregiverUserKey, careRecipientUserKey } = target;

  // 로컬 userKey로 careRecipientUserKey 보완
  const localUserKey = await Storage.getItem(SCHEDULE_STORAGE_KEYS.USER_KEY);

  const resolvedCaregiverKey = caregiverUserKey ?? localUserKey ?? '';
  const resolvedRecipientKey = careRecipientUserKey ?? localUserKey ?? '';

  const vercelApiUrl = getVercelApiUrl();

  if (vercelApiUrl && resolvedCaregiverKey && resolvedRecipientKey) {
    try {
      await fetch(`${vercelApiUrl}/api/pair`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caregiverUserKey: resolvedCaregiverKey,
          careRecipientUserKey: resolvedRecipientKey,
        }),
      });
    } catch (err) {
      console.warn('[pairService] unpair 서버 호출 실패:', err);
    }
  }

  // 로컬 Storage에서도 제거
  const existing = await getPairings();
  const updated = existing.filter(
    (p) =>
      p.caregiverUserKey !== resolvedCaregiverKey &&
      p.careRecipientUserKey !== resolvedRecipientKey,
  );
  await Storage.setItem(PAIR_STORAGE_KEYS.PAIRINGS, JSON.stringify(updated));
}

// ─── 케어러 푸시 발송 (케어 대상 폰 → fire-and-forget) ────────────────────────

/**
 * 케어 대상 체크/MISSED 이벤트 → 케어러 Toss 푸시 발송.
 * fire-and-forget — 실패해도 로컬 체크 유지.
 *
 * // [기능성] 복약 이벤트 알림
 * Ref: references/dev-guide/smart-message/intro.md §기능성 메시지
 *   "서비스 이용 과정에서 발생하는 필수 정보 전달"
 *   "광고성 문구 없음 — 할인·이벤트·마케팅 요소 없음"
 * Ref: step-08-family.md §처리 3 "notifyCaregivers는 fire-and-forget"
 * Ref: step-08-family.md §검수 "Vercel Functions 호출 실패해도 로컬 체크 유지"
 *
 * 네트워크 실패 시 pendingNotify 큐 적재 후 재시도.
 * Ref: step-08-family.md §처리 2 "pendingNotify 큐(Storage 키 pendingNotify)"
 */
export async function notifyCaregivers(
  routineLabel: string,
  takenAt: string,
  kind: 'checked' | 'missed',
): Promise<void> {
  // v1: 알림 비활성. 호출은 허용하되 발송 안 함 → 큐도 적재 안 함.
  if (!NOTIFY_ENABLED) return;

  const careRecipientUserKey = await Storage.getItem(SCHEDULE_STORAGE_KEYS.USER_KEY);
  if (!careRecipientUserKey) return;

  const vercelApiUrl = getVercelApiUrl();
  if (!vercelApiUrl) return;

  const body = {
    careRecipientUserKey,
    routineLabel,
    takenAt,
    kind,
  };

  try {
    const response = await fetch(`${vercelApiUrl}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      console.warn('[pairService] notifyCaregivers 실패, 큐 적재');
      await enqueuePendingNotify(body);
    }
  } catch (err) {
    // 네트워크 오류 — 큐 적재
    // Ref: step-08-family.md §처리 2 "pendingNotify 큐"
    console.warn('[pairService] notifyCaregivers 예외, 큐 적재:', err);
    await enqueuePendingNotify(body);
  }
}

/** pendingNotify 큐 적재 */
async function enqueuePendingNotify(item: {
  careRecipientUserKey: string;
  routineLabel: string;
  takenAt: string;
  kind: 'checked' | 'missed';
}): Promise<void> {
  try {
    const raw = await Storage.getItem(PAIR_STORAGE_KEYS.PENDING_NOTIFY);
    const queue: typeof item[] = raw ? (JSON.parse(raw) as typeof item[]) : [];
    queue.push(item);
    // 큐 최대 20개 유지 (오래된 것부터 제거)
    const trimmed = queue.slice(-20);
    await Storage.setItem(PAIR_STORAGE_KEYS.PENDING_NOTIFY, JSON.stringify(trimmed));
  } catch (err) {
    console.warn('[pairService] pendingNotify 큐 적재 실패:', err);
  }
}

/**
 * pendingNotify 큐 재시도 (앱 포그라운드 복귀 시 호출).
 * Step 4 flushPendingQueue 패턴 준수.
 */
export async function flushPendingNotifyQueue(): Promise<void> {
  // v1: 알림 비활성. 큐 자체를 비워서 누적 방지 (만약 이전 빌드에서 누적된 게 있다면).
  if (!NOTIFY_ENABLED) {
    try {
      await Storage.removeItem(PAIR_STORAGE_KEYS.PENDING_NOTIFY);
    } catch {
      // ignore
    }
    return;
  }

  const vercelApiUrl = getVercelApiUrl();
  if (!vercelApiUrl) return;

  try {
    const raw = await Storage.getItem(PAIR_STORAGE_KEYS.PENDING_NOTIFY);
    if (!raw) return;

    const queue = JSON.parse(raw) as Array<{
      careRecipientUserKey: string;
      routineLabel: string;
      takenAt: string;
      kind: 'checked' | 'missed';
    }>;

    if (queue.length === 0) return;

    const failed: typeof queue = [];

    for (const item of queue) {
      try {
        const response = await fetch(`${vercelApiUrl}/api/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item),
        });
        if (!response.ok) {
          failed.push(item);
        }
      } catch {
        failed.push(item);
      }
    }

    await Storage.setItem(PAIR_STORAGE_KEYS.PENDING_NOTIFY, JSON.stringify(failed));
  } catch (err) {
    console.warn('[pairService] flushPendingNotifyQueue 실패:', err);
  }
}

// ─── 케어러 이벤트 로그 ───────────────────────────────────────────────────────

/**
 * 케어러 폰 Storage에 이벤트 추가.
 * 푸시 탭 진입 시 호출.
 *
 * 데이터 최소화: kind + label + 시각만 저장. 사진 URL 저장 금지.
 * Ref: step-08-family.md §처리 4 "푸시 payload에 회차 사진 URL 포함하지 않음"
 * Ref: step-08-family.md §검수 "케어러 폰엔 회차 사진·상세 약 목록이 저장되지 않아야 한다"
 */
export async function addCaregiverEvent(event: Omit<CaregiverEvent, 'id'>): Promise<void> {
  try {
    const raw = await Storage.getItem(PAIR_STORAGE_KEYS.CAREGIVER_EVENTS);
    const events: CaregiverEvent[] = raw ? (JSON.parse(raw) as CaregiverEvent[]) : [];

    const newEvent: CaregiverEvent = {
      ...event,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    };

    events.push(newEvent);

    // 최대 100개 유지 (오래된 것부터 제거)
    const trimmed = events.slice(-100);
    await Storage.setItem(PAIR_STORAGE_KEYS.CAREGIVER_EVENTS, JSON.stringify(trimmed));
  } catch (err) {
    console.warn('[pairService] addCaregiverEvent 실패:', err);
  }
}

/**
 * 케어러 이벤트 로그 조회.
 */
export async function getCaregiverEvents(): Promise<CaregiverEvent[]> {
  try {
    const raw = await Storage.getItem(PAIR_STORAGE_KEYS.CAREGIVER_EVENTS);
    if (!raw) return [];
    return JSON.parse(raw) as CaregiverEvent[];
  } catch {
    return [];
  }
}

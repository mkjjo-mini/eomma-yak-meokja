/**
 * Care Status Service — Pull 방식 가족 현황 (v1 알림 비활성 대안)
 *
 * 케어 대상 폰: 약 체크/언체크 시점 + 진입 시 syncMyTodayStatus() → Vercel KV 저장
 * 가족 폰: 미니앱 진입 시 fetchCareRecipientTodayStatus() → KV에서 조회 → 화면 표시
 *
 * 비즈월렛 비용 0 (스마트 발송 안 씀, KV read/write만).
 *
 * 데이터 최소화 원칙:
 *  - routineLabel·scheduledTime·status·takenAt만 전송
 *  - 약 이름, 사진 URL, 상세 처방 절대 X
 *
 * Ref:
 *  - PRD step-08-family.md §처리 4 (Pull 방식)
 *  - 메모리 "엄마약먹자 알림 기능 보류"
 */

import { Storage } from '@apps-in-toss/framework';
import { SCHEDULE_STORAGE_KEYS } from '../types/schedule';
import { PAIR_STORAGE_KEYS } from '../types/pair';
import type { PairingRecord } from '../types/pair';

export type CareStatusItem = {
  routineId: string;
  routineLabel: string;
  /** 식전/식후 — 선택 */
  mealTiming?: 'before' | 'after';
  /** "HH:MM" KST */
  scheduledTime: string;
  status: 'PENDING' | 'CHECKED' | 'MISSED';
  /** 체크 완료 시각 (CHECKED인 경우만) — ISO */
  takenAt?: string;
  /** 회차 사진 base64 (선택). 500KB 초과 시 sync 단계에서 skip. */
  photoBase64?: string;
};

export type CareStatusEntry = {
  recipientUserKey: string;
  recipientNickname: string;
  /** YYYY-MM-DD KST */
  date: string;
  items: CareStatusItem[];
  /** 마지막 업데이트 시각 — ISO */
  updatedAt: string;
  /** 이번 달 복약률 (0~1) — 본인 폰이 미리 계산 */
  monthlyAdherence?: number;
  /** 이번 달 데이터 존재 여부 (false면 도넛 0% 미표시) */
  monthlyAdherenceHasData?: boolean;
  /** 연속 복약 일수 (스트릭) */
  streak?: number;
  /** 서버에 데이터 없음 (케어 대상이 오늘 아직 안 열었음) */
  empty?: boolean;
};

/** 사진 base64의 안전한 최대 사이즈 (전송·KV 보호). 초과 시 sync 단계에서 skip. */
const MAX_PHOTO_BASE64_BYTES = 500 * 1024;

/** 런타임 시점에 env 읽기 (pairService와 동일 패턴) */
function getVercelApiUrl(): string {
  return (
    (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_VERCEL_API_URL) ||
    (typeof process !== 'undefined' && process.env?.VERCEL_API_URL) ||
    ''
  );
}

// ─── 케어 대상 폰: 오늘 상태 KV 저장 ────────────────────────────────────────

/**
 * 케어 대상이 자신의 오늘 복약 상태를 KV에 저장.
 * fire-and-forget — 네트워크 실패해도 로컬 체크 유지.
 *
 * 호출 시점:
 *  - 매 체크/언체크 직후 (홈 화면)
 *  - 앱 진입 시 한 번 (오늘 첫 진입 시 PENDING 상태라도 등록되게)
 */
export async function syncMyTodayStatus(params: {
  nickname: string;
  date: string;
  items: CareStatusItem[];
  monthlyAdherence?: number;
  monthlyAdherenceHasData?: boolean;
  streak?: number;
}): Promise<void> {
  const userKey = await Storage.getItem(SCHEDULE_STORAGE_KEYS.USER_KEY);
  if (!userKey) return;

  const vercelApiUrl = getVercelApiUrl();
  if (!vercelApiUrl) return;

  // 사진 사이즈 안전망: 큰 사진은 사진 필드만 비우고 전송 (회차 자체는 sync)
  // base64 길이 = byte 길이의 대략 4/3. 보수적으로 length로 직접 비교.
  const sanitizedItems = params.items.map((it) => {
    if (it.photoBase64 && it.photoBase64.length > MAX_PHOTO_BASE64_BYTES) {
      const { photoBase64: _omitted, ...rest } = it;
      return rest;
    }
    return it;
  });

  try {
    await fetch(`${vercelApiUrl}/api/care-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-toss-user-key': userKey,
      },
      body: JSON.stringify({
        recipientUserKey: userKey,
        recipientNickname: params.nickname,
        date: params.date,
        items: sanitizedItems,
        ...(params.monthlyAdherence !== undefined && {
          monthlyAdherence: params.monthlyAdherence,
        }),
        ...(params.monthlyAdherenceHasData !== undefined && {
          monthlyAdherenceHasData: params.monthlyAdherenceHasData,
        }),
        ...(params.streak !== undefined && { streak: params.streak }),
      }),
    });
    // 실패해도 silent — 로컬 체크는 별개
  } catch (err) {
    console.warn('[careStatusService] syncMyTodayStatus 예외:', err);
  }
}

// ─── 가족 폰: 케어 대상 오늘 상태 조회 ────────────────────────────────────

/**
 * 첫번째 페어링된 케어 대상의 오늘 상태 조회.
 *
 * v1은 페어링 1명만 우선 지원 (가족 슬롯 다중 페어링도 1명만 표시).
 * 추후 다중 표시 필요 시 fetchAllCareRecipientStatuses() 추가.
 */
export async function fetchCareRecipientTodayStatus(
  date: string,
): Promise<CareStatusEntry | null> {
  const caregiverUserKey = await Storage.getItem(SCHEDULE_STORAGE_KEYS.USER_KEY);
  if (!caregiverUserKey) return null;

  // 가족 폰 Storage의 첫번째 pairing 조회
  const pairingsRaw = await Storage.getItem(PAIR_STORAGE_KEYS.PAIRINGS);
  if (!pairingsRaw) return null;

  let pairings: PairingRecord[] = [];
  try {
    pairings = JSON.parse(pairingsRaw) as PairingRecord[];
  } catch {
    return null;
  }
  if (pairings.length === 0) return null;

  const target = pairings[0];
  if (!target) return null;

  const vercelApiUrl = getVercelApiUrl();
  if (!vercelApiUrl) return null;

  try {
    const url = new URL(`${vercelApiUrl}/api/care-status`);
    url.searchParams.set('recipientUserKey', target.careRecipientUserKey);
    url.searchParams.set('date', date);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-toss-user-key': caregiverUserKey,
      },
    });

    if (!response.ok) {
      console.warn(
        '[careStatusService] fetchCareRecipientTodayStatus HTTP 에러',
        response.status,
      );
      return null;
    }

    const data = (await response.json()) as CareStatusEntry;
    return data;
  } catch (err) {
    console.warn('[careStatusService] fetchCareRecipientTodayStatus 예외:', err);
    return null;
  }
}

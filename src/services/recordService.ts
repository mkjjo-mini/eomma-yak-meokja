/**
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-03-home.md §처리 2-5
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-04-notification.md §처리 5
 *    "발송 후 해당 DoseRecord를 NOTIFIED 상태로 전이"
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-05-reminder.md §처리 2
 *    "자정 상태 전이: PENDING/NOTIFIED → MISSED, CHECKED 변경 없음"
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-05-reminder.md §처리 3
 *    "복약률 계산: 월간 CHECKED / (CHECKED + MISSED)"
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-06-streak.md §처리 1 (스트릭 계산)
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-06-streak.md §처리 3 (배지 지급)
 *  - references/sdk/framework/저장소/Storage.md §setItem/getItem
 *  - PRD: products/eomma-yak-meokja/prd/v1.md §엣지케이스 "날짜 기준은 KST 고정"
 *
 * 네트워크 호출 없음 — 로컬 only 계약.
 * Storage 쓰기 실패 시 throw — 호출부에서 에러 토스트 처리.
 */
import { Storage } from '@apps-in-toss/framework';
import { type DoseRecord, RECORD_STORAGE_KEY } from '../types/record';
import { type DoseRoutine } from '../types/routine';
import {
  type BadgeKind,
  BADGE_THRESHOLDS,
  BADGE_STORAGE_KEY,
} from '../types/badge';

// ─── KST 날짜 유틸 ────────────────────────────────────────────────────────────

/**
 * KST 기준 오늘 날짜 "YYYY-MM-DD" 반환.
 * Ref: PRD §엣지케이스 "날짜 기준은 KST 고정"
 */
export function getKSTDateString(date: Date = new Date()): string {
  // KST = UTC+9
  const kstOffset = 9 * 60 * 60 * 1000;
  const kst = new Date(date.getTime() + kstOffset);
  return kst.toISOString().slice(0, 10);
}

/**
 * KST 기준 현재 시각 "HH:MM" 반환.
 * 회차의 routine.time(HH:MM)과 사전 비교해 조기 체크를 가드하는 데 사용.
 */
export function getKSTTimeHHMM(date: Date = new Date()): string {
  const kstOffset = 9 * 60 * 60 * 1000;
  const kst = new Date(date.getTime() + kstOffset);
  return kst.toISOString().slice(11, 16);
}

/**
 * KST 기준 어제 날짜 "YYYY-MM-DD" 반환.
 */
export function getKSTYesterdayString(date: Date = new Date()): string {
  const kstOffset = 9 * 60 * 60 * 1000;
  const kst = new Date(date.getTime() + kstOffset - 24 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

/**
 * KST 기준 오늘 요일 반환 (0=월 … 6=일, PRD 도메인 기준).
 * JS Date.getDay()는 0=일 … 6=토 이므로 변환 필요.
 * 변환식: JS 0(일)→6, JS 1(월)→0, … JS 6(토)→5
 */
export function getKSTWeekday(date: Date = new Date()): number {
  const kstOffset = 9 * 60 * 60 * 1000;
  const kst = new Date(date.getTime() + kstOffset);
  const jsDay = kst.getUTCDay(); // 0=일 … 6=토
  // PRD 기준: 0=월 … 6=일
  return jsDay === 0 ? 6 : jsDay - 1;
}

// ─── Record ID 생성 ────────────────────────────────────────────────────────────

/**
 * DoseRecord ID 생성: REC-{routineId}-{YYYYMMDD}
 * Ref: PRD step-03 §도메인 모델
 */
export function buildRecordId(routineId: string, dateStr: string): string {
  const yyyymmdd = dateStr.replace(/-/g, '');
  return `REC-${routineId}-${yyyymmdd}`;
}

// ─── Storage CRUD ──────────────────────────────────────────────────────────────

/** 저장된 레코드 전체 조회 */
export async function getRecords(): Promise<DoseRecord[]> {
  const raw = await Storage.getItem(RECORD_STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as DoseRecord[];
  } catch {
    return [];
  }
}

/** 레코드 전체 저장 (덮어쓰기) */
async function saveRecords(records: DoseRecord[]): Promise<void> {
  await Storage.setItem(RECORD_STORAGE_KEY, JSON.stringify(records));
}

// ─── 오늘 레코드 조회 ─────────────────────────────────────────────────────────

/**
 * 특정 routineId + date 에 해당하는 레코드 조회.
 * 없으면 null 반환 (저장은 체크 시점에만).
 * Ref: PRD step-03 §처리 3 "조회 시 오늘자 레코드 없으면 PENDING 기본값 리턴"
 */
export async function getRecord(
  routineId: string,
  date: string,
): Promise<DoseRecord | null> {
  const records = await getRecords();
  return records.find((r) => r.routineId === routineId && r.date === date) ?? null;
}

/**
 * routineId + date 에 해당하는 레코드 조회.
 * 없으면 PENDING 상태의 가상 레코드 반환 (미저장).
 * Ref: PRD step-03 §처리 3
 */
export async function getOrCreatePendingRecord(
  routineId: string,
  date: string,
): Promise<DoseRecord> {
  const existing = await getRecord(routineId, date);
  if (existing) return existing;
  return {
    id: buildRecordId(routineId, date),
    routineId,
    date,
    status: 'PENDING',
  };
}

// ─── 체크 토글 ────────────────────────────────────────────────────────────────

/**
 * CHECKED ↔ PENDING 토글.
 * CHECKED → PENDING: checkedAt 제거.
 * PENDING/NOTIFIED → CHECKED: checkedAt = now ISO string.
 *
 * Ref: PRD step-03 §처리 5
 */
/**
 * 과거 날짜 보정 체크 가능 거리(일).
 * v1.1에서 보상형 광고 시청 후 확장 예정 — 그 전까지는 14일 고정.
 */
export const MAX_BACKFILL_DAYS = 14;

/**
 * 과거 날짜 보정 가능 여부 판정.
 * - 미래 날짜 / 오늘 / 등록일 이전 / 14일 초과 → false
 * - 위 조건 모두 통과 → true
 */
export function canBackfillDate(
  routineCreatedAt: string,
  targetDate: string,
  todayDate: string,
): boolean {
  if (targetDate >= todayDate) return false; // 미래·오늘 차단
  const createdDate = getKSTDateString(new Date(routineCreatedAt));
  if (targetDate < createdDate) return false; // 등록 전 차단

  // 일자 차이 계산
  const target = new Date(`${targetDate}T00:00:00+09:00`);
  const today = new Date(`${todayDate}T00:00:00+09:00`);
  const diffDays = Math.round(
    (today.getTime() - target.getTime()) / (24 * 60 * 60 * 1000),
  );
  return diffDays <= MAX_BACKFILL_DAYS;
}

/**
 * 과거 날짜 보정 토글.
 * MISSED ↔ CHECKED 사이만 전이. CHECKED 시 `checkedRetroactivelyAt` 마커 부착.
 *
 * 가드:
 *  - canBackfillDate 만족 필요. 그렇지 않으면 변경 없이 현재 레코드 반환(없으면 null).
 *
 * 부수 효과 없음:
 *  - 포인트 미지급 (오늘 회차 전체 완료 시에만 지급)
 *  - 케어러 푸시 미발송 (오늘 토글 시에만)
 */
export async function toggleCheckForDate(
  routineId: string,
  routineCreatedAt: string,
  date: string,
  todayDate: string,
): Promise<DoseRecord | null> {
  if (!canBackfillDate(routineCreatedAt, date, todayDate)) {
    const existing = (await getRecords()).find(
      (r) => r.routineId === routineId && r.date === date,
    );
    return existing ?? null;
  }

  const records = await getRecords();
  const idx = records.findIndex((r) => r.routineId === routineId && r.date === date);
  const nowIso = new Date().toISOString();

  let updated: DoseRecord;
  if (idx === -1) {
    updated = {
      id: buildRecordId(routineId, date),
      routineId,
      date,
      status: 'CHECKED',
      checkedAt: nowIso,
      checkedRetroactivelyAt: nowIso,
    };
    await saveRecords([...records, updated]);
  } else {
    const current = records[idx]!;
    if (current.status === 'CHECKED') {
      // 보정 해제 → MISSED로 환원 (과거 날짜 PENDING은 어차피 자정 후 MISSED로 전이됨)
      updated = {
        ...current,
        status: 'MISSED',
        checkedAt: undefined,
        checkedRetroactivelyAt: undefined,
      };
    } else {
      updated = {
        ...current,
        status: 'CHECKED',
        checkedAt: nowIso,
        checkedRetroactivelyAt: nowIso,
      };
    }
    const newRecords = records.map((r, i) => (i === idx ? updated : r));
    await saveRecords(newRecords);
  }

  return updated;
}

export async function toggleCheck(
  routineId: string,
  date: string,
): Promise<DoseRecord> {
  const records = await getRecords();
  const idx = records.findIndex((r) => r.routineId === routineId && r.date === date);

  let updated: DoseRecord;

  if (idx === -1) {
    // 레코드 없음 → CHECKED로 신규 생성
    updated = {
      id: buildRecordId(routineId, date),
      routineId,
      date,
      status: 'CHECKED',
      checkedAt: new Date().toISOString(),
    };
    await saveRecords([...records, updated]);
  } else {
    const current = records[idx]!;
    if (current.status === 'CHECKED') {
      // 체크 취소 → PENDING
      updated = { ...current, status: 'PENDING', checkedAt: undefined };
    } else {
      // PENDING / NOTIFIED / MISSED → CHECKED
      updated = {
        ...current,
        status: 'CHECKED',
        checkedAt: new Date().toISOString(),
      };
    }
    const newRecords = records.map((r, i) => (i === idx ? updated : r));
    await saveRecords(newRecords);
  }

  return updated;
}

// ─── 오늘 복용 회차 필터링 ────────────────────────────────────────────────────

/**
 * 회차 목록에서 오늘 복용해야 하는 회차만 필터링 후 시간 순 정렬.
 *
 * - frequency='daily' → 매일 포함
 * - frequency='weekly' → weekdays에 오늘 요일(KST, 0=월…6=일)이 포함될 때만
 *
 * Ref: PRD step-03 §처리 3 "오늘 복용 예정 회차 목록 조회"
 */
export function filterTodayRoutines(
  routines: DoseRoutine[],
  todayWeekday: number,
  todayDate?: string,
): DoseRoutine[] {
  return routines
    .filter((r) => {
      // 그만 보기 처리된 회차: discontinuedAt <= 오늘이면 미노출
      // todayDate 미전달 시 그만 보기 필터 건너뜀 (기존 호출처 호환)
      if (r.discontinuedAt && todayDate && todayDate >= r.discontinuedAt) {
        return false;
      }
      if (r.frequency === 'daily') return true;
      if (r.frequency === 'weekly') {
        return r.weekdays?.includes(todayWeekday) ?? false;
      }
      return false;
    })
    .sort((a, b) => a.time.localeCompare(b.time));
}

// ─── 어제 미체크 파생 로직 ────────────────────────────────────────────────────

/**
 * 어제 날짜 + PENDING/NOTIFIED 상태인 레코드를 MISSED처럼 표시하기 위한
 * 파생 함수. 실제 상태 전이(Storage 쓰기)는 Step 5에서 구현.
 *
 * Ref: PRD step-03 §처리 "읽는 시점에 '과거 날짜 + PENDING/NOTIFIED'를 MISSED처럼 표시하는 가벼운 파생 로직"
 */
export function deriveMissedStatus(record: DoseRecord, todayDate: string): DoseRecord {
  if (
    record.date < todayDate &&
    (record.status === 'PENDING' || record.status === 'NOTIFIED')
  ) {
    return { ...record, status: 'MISSED' };
  }
  return record;
}

/**
 * 어제 MISSED 표시가 필요한 회차 목록 조회.
 * 어제 날짜로 레코드를 조회해, 없으면 PENDING으로 가정하고 MISSED 파생.
 *
 * Ref: PRD step-03 §검수 "어제 미체크 회차는 오늘 MISSED로 표시되고, 오늘 목록엔 정상 포함"
 */
export async function getYesterdayMissedItems(
  todayRoutines: DoseRoutine[],
  yesterdayDate: string,
  todayDate: string,
): Promise<Array<{ routine: DoseRoutine; record: DoseRecord }>> {
  const records = await getRecords();

  return todayRoutines
    .filter((routine) => {
      // 등록일(KST) 이후 날짜만 "놓침" 판정 대상.
      // 오늘 등록한 회차의 어제는 존재하지 않았던 시간이므로 MISSED로 표시하지 않음.
      const createdDateKst = getKSTDateString(new Date(routine.createdAt));
      return createdDateKst <= yesterdayDate;
    })
    .map((routine) => {
      const existingRecord = records.find(
        (r) => r.routineId === routine.id && r.date === yesterdayDate,
      );
      const baseRecord: DoseRecord = existingRecord ?? {
        id: buildRecordId(routine.id, yesterdayDate),
        routineId: routine.id,
        date: yesterdayDate,
        status: 'PENDING',
      };
      const derived = deriveMissedStatus(baseRecord, todayDate);
      return { routine, record: derived };
    })
    .filter(({ record }) => record.status === 'MISSED');
}

// ─── 자정 MISSED 전이 (Step 5) ────────────────────────────────────────────────

/**
 * 앱 진입 시 호출. 오늘 KST 날짜 기준으로 과거 날짜의
 * PENDING/NOTIFIED 레코드를 MISSED로 실제 전이 + Storage 저장.
 *
 * 설계 근거 (옵션 A 채택):
 *   - Vercel Cron은 Storage에 직접 접근 불가.
 *   - 앱 포그라운드 진입 시 클라이언트가 처리 → 단순, 서버 불필요.
 *   - deriveMissedStatus(읽기 전용 파생)와 달리 Storage에 실제로 씀.
 *
 * Ref: PRD step-05 §처리 2
 *   "상태가 NOTIFIED 또는 PENDING이면 → MISSED, CHECKED이면 변경 없음"
 * Ref: PRD v1 §엣지케이스 "날짜 기준은 KST 고정"
 * Ref: PRD step-05 §테스트 주의사항
 *   "자정 전이 테스트는 jest.useFakeTimers() 사용"
 *   "시간대 테스트: UTC, KST, PST에서 모두 KST 00:00 기준으로 동작 확인"
 *
 * @param now - 테스트에서 주입 가능한 현재 시각 (기본값: new Date())
 */
export async function flushMissedRecords(now: Date = new Date()): Promise<void> {
  const todayDate = getKSTDateString(now);
  const records = await getRecords();

  let hasChange = false;
  const updated = records.map((record) => {
    // 오늘 날짜는 건드리지 않음 (복용 중)
    if (record.date >= todayDate) return record;
    // CHECKED는 자정 후에도 상태 유지
    // Ref: PRD step-05 §처리 2 "CHECKED이면 변경 없음"
    if (record.status === 'CHECKED') return record;
    // PENDING / NOTIFIED → MISSED
    if (record.status === 'PENDING' || record.status === 'NOTIFIED') {
      hasChange = true;
      return { ...record, status: 'MISSED' as const };
    }
    return record;
  });

  if (hasChange) {
    await Storage.setItem(RECORD_STORAGE_KEY, JSON.stringify(updated));
  }
}

// ─── 복약률 계산 (Step 5, UI는 Step 6에서 사용) ──────────────────────────────

/**
 * 이번 달 복약 순응도(Adherence) 계산 — "하루 단위 완료" 기준.
 *
 * 정의:
 *   - 그 날 예정된 회차가 1개 이상이고 전부 CHECKED → "완료한 날"
 *   - 그 외 (1개라도 미체크/MISSED) → "미완료한 날"
 *   - 회차 0개인 날(주간 회차 중 해당 요일 없음) → 분모에서도 제외
 *
 * 오늘 처리:
 *   - 오늘 100% CHECKED → 완료한 날(분자/분모 둘 다 +1)
 *   - 오늘 부분 완료 → "아직 진행 중" 으로 간주 (분모 미포함, 페널티 없음)
 *
 * 결과: CHECKED / (CHECKED + MISSED) (0~1).
 * 분모 0 → 0 반환.
 *
 * @param records - 전체 레코드 배열
 * @param year    - 연도 (예: 2026)
 * @param month   - 월 (1~12)
 */
export function calcMonthlyAdherence(
  records: DoseRecord[],
  year: number,
  month: number,
): number {
  const mm = String(month).padStart(2, '0');
  const prefix = `${year}-${mm}-`;
  const monthly = records.filter((r) => r.date.startsWith(prefix));
  const checked = monthly.filter((r) => r.status === 'CHECKED').length;
  const missed = monthly.filter((r) => r.status === 'MISSED').length;
  const total = checked + missed;
  if (total === 0) return 0;
  return checked / total;
}

/**
 * 스케줄 기반 복약률 계산.
 * 루틴 스케줄(요일·생성일)을 고려해 과거 예정 회차 중 실제 체크된 비율을 반환.
 * 캘린더의 markForDate 로직과 동일한 기준 적용.
 */
export function calcMonthlyAdherenceWithSchedule(
  routines: DoseRoutine[],
  records: DoseRecord[],
  year: number,
  month: number,
  today: Date = new Date(),
): number {
  const todayStr = getKSTDateString(today);
  const mm = String(month).padStart(2, '0');
  const daysInMonth = new Date(year, month, 0).getDate();

  let totalScheduled = 0;
  let totalChecked = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${mm}-${String(d).padStart(2, '0')}`;
    if (dateStr > todayStr) break;

    const prdWeekday = getKSTWeekday(new Date(`${dateStr}T12:00:00`));

    const dayRoutines = routines.filter((r) => {
      const createdDateKst = getKSTDateString(new Date(r.createdAt));
      if (dateStr < createdDateKst) return false;
      if (r.frequency === 'daily') return true;
      if (r.frequency === 'weekly') return r.weekdays?.includes(prdWeekday) ?? false;
      return false;
    });

    if (dayRoutines.length === 0) continue;

    const dayRecords = records.filter((r) => r.date === dateStr);

    for (const rt of dayRoutines) {
      totalScheduled++;
      const rec = dayRecords.find((r) => r.routineId === rt.id);
      if (rec?.status === 'CHECKED') totalChecked++;
    }
  }

  if (totalScheduled === 0) return 0;
  return totalChecked / totalScheduled;
}

/**
 * 가족 현황 표시용 — "X월 D일 ~ X월 D일 중 N일 체크" 계산.
 * 이번 달 1일 ~ 오늘 중 "그 날에 예정된 모든 회차를 CHECKED"한 일자 수.
 *
 * 반환:
 *  - startDate: 시작일 (이번 달 1일, 또는 그 이후의 첫 회차 등록일 중 늦은 것)
 *  - endDate: 오늘
 *  - fullCheckedDays: 그 기간 동안 "당일 모든 예정 회차 CHECKED" 일수
 *
 * Ref: PRD step-08-family.md §처리 5 — 가족 모드 도넛 옆 부가 문구
 */
export function calcThisMonthFullCheckedDays(
  routines: DoseRoutine[],
  records: DoseRecord[],
  today: Date = new Date(),
): { startDate: string; endDate: string; fullCheckedDays: number } {
  const todayKst = new Date(today.getTime() + 9 * 60 * 60 * 1000);
  const year = todayKst.getUTCFullYear();
  const month = todayKst.getUTCMonth() + 1;
  const mm = String(month).padStart(2, '0');
  const todayStr = getKSTDateString(today);

  // 회차 최초 등록일 중 가장 이른 것
  const earliestCreatedAt = routines.reduce<string | null>((acc, r) => {
    const d = getKSTDateString(new Date(r.createdAt));
    if (!acc) return d;
    return d < acc ? d : acc;
  }, null);
  const monthFirst = `${year}-${mm}-01`;
  const startDate =
    earliestCreatedAt && earliestCreatedAt > monthFirst
      ? earliestCreatedAt
      : monthFirst;

  const startDay = Number(startDate.slice(8, 10));
  const todayDay = Number(todayStr.slice(8, 10));

  let fullCheckedDays = 0;
  for (let d = startDay; d <= todayDay; d++) {
    const dateStr = `${year}-${mm}-${String(d).padStart(2, '0')}`;
    if (dateStr > todayStr) break;
    if (dateStr < startDate) continue;

    const prdWeekday = getKSTWeekday(new Date(`${dateStr}T12:00:00`));

    const dayRoutines = routines.filter((r) => {
      const createdDateKst = getKSTDateString(new Date(r.createdAt));
      if (dateStr < createdDateKst) return false;
      if (r.frequency === 'daily') return true;
      if (r.frequency === 'weekly') return r.weekdays?.includes(prdWeekday) ?? false;
      return false;
    });

    if (dayRoutines.length === 0) continue;

    const dayRecords = records.filter((r) => r.date === dateStr);
    const allChecked = dayRoutines.every((rt) => {
      const rec = dayRecords.find((rr) => rr.routineId === rt.id);
      return rec?.status === 'CHECKED';
    });
    if (allChecked) fullCheckedDays++;
  }

  return { startDate, endDate: todayStr, fullCheckedDays };
}

// ─── NOTIFIED 상태 전이 (Step 4) ──────────────────────────────────────────────

/**
 * Vercel Cron 발송 성공 후 앱 다음 진입 시 NOTIFIED 상태로 전이.
 * PENDING 상태인 레코드를 NOTIFIED로 변경.
 * 이미 CHECKED이면 변경하지 않음.
 *
 * Ref: PRD step-04 §처리 5
 *   "발송 후 해당 DoseRecord를 NOTIFIED 상태로 전이"
 */
export async function markAsNotified(
  routineId: string,
  date: string,
): Promise<DoseRecord> {
  const records = await getRecords();
  const idx = records.findIndex((r) => r.routineId === routineId && r.date === date);

  let updated: DoseRecord;

  if (idx === -1) {
    // 레코드 없음 → NOTIFIED로 신규 생성
    updated = {
      id: buildRecordId(routineId, date),
      routineId,
      date,
      status: 'NOTIFIED',
    };
    await saveRecords([...records, updated]);
  } else {
    const current = records[idx]!;
    // 이미 CHECKED이면 변경 없음
    if (current.status === 'CHECKED') {
      return current;
    }
    updated = { ...current, status: 'NOTIFIED' };
    const newRecords = records.map((r, i) => (i === idx ? updated : r));
    await saveRecords(newRecords);
  }

  return updated;
}

// ─── 스트릭 계산 (Step 6) ─────────────────────────────────────────────────────

/**
 * 오늘까지의 연속 완료일(스트릭)을 KST 기준으로 계산한다.
 *
 * 규칙 (PRD step-06 §처리 1):
 *   - 해당 날짜의 routines 중 오늘 요일에 해당하는 회차가 1개 이상 있고,
 *     전부 CHECKED → 그날 "완료" → 스트릭 +1
 *   - MISSED가 하나라도 있으면 → 스트릭 0 초기화
 *   - 해당 요일에 등록된 회차가 0개인 날 → 스트릭 유지 (리셋 아님)
 *
 * 알고리즘:
 *   어제(now - 1일)부터 역방향으로 날짜를 거슬러 올라가며,
 *   각 날짜의 결과를 판정한다.
 *   "완료"이면 count++, "MISSED 발생"이면 즉시 중단(break),
 *   "회차 0개"이면 건너뛰고 계속 진행.
 *   오늘 날짜는 아직 진행 중이므로 카운트에 포함하지 않고,
 *   오늘 전체 회차가 CHECKED 완료된 경우에 한해 +1을 추가한다.
 *
 * @param routines - 등록된 전체 회차 목록
 * @param records  - 저장된 전체 레코드 목록 (MISSED 전이 완료 상태 전제)
 * @param now      - 현재 시각 (테스트 주입용, 기본값: new Date())
 *
 * Ref: PRD step-06 §처리 1
 * Ref: PRD v1 §엣지케이스 "날짜 기준은 KST 고정"
 * Ref: references/sdk/framework/저장소/Storage.md
 */
export function calcStreak(
  routines: DoseRoutine[],
  records: DoseRecord[],
  now: Date = new Date(),
): number {
  // KST 기준 날짜 문자열 반환 헬퍼 (내부용)
  function kstDateOf(d: Date): string {
    const kstOffset = 9 * 60 * 60 * 1000;
    const kst = new Date(d.getTime() + kstOffset);
    return kst.toISOString().slice(0, 10);
  }

  // KST 기준 요일 반환 헬퍼 (0=월 … 6=일, PRD 도메인 기준)
  function kstWeekdayOf(d: Date): number {
    const kstOffset = 9 * 60 * 60 * 1000;
    const kst = new Date(d.getTime() + kstOffset);
    const jsDay = kst.getUTCDay(); // 0=일 … 6=토
    return jsDay === 0 ? 6 : jsDay - 1;
  }

  // 특정 날짜에 해당 요일에 속하는 회차 목록 반환
  // 회차 등록일(createdAt KST) 이전 날짜는 제외 — 등록 전 날짜는 스트릭 판정 대상이 아님
  function routinesForDate(dateStr: string): DoseRoutine[] {
    const d = new Date(dateStr + 'T00:00:00+09:00');
    const weekday = kstWeekdayOf(d);
    return routines.filter((r) => {
      const createdDateKst = kstDateOf(new Date(r.createdAt));
      if (dateStr < createdDateKst) return false;
      if (r.frequency === 'daily') return true;
      if (r.frequency === 'weekly') return r.weekdays?.includes(weekday) ?? false;
      return false;
    });
  }

  // 특정 날짜의 스트릭 판정 결과
  // 'complete'  : 해당 요일 회차 전부 CHECKED
  // 'broken'    : MISSED 1개 이상 존재
  // 'skip'      : 해당 요일 회차가 0개 (스트릭 유지)
  type DayResult = 'complete' | 'broken' | 'skip';

  function judgDay(dateStr: string): DayResult {
    const dayRoutines = routinesForDate(dateStr);
    if (dayRoutines.length === 0) return 'skip';

    const dayRecords = records.filter((r) => r.date === dateStr);

    // MISSED 하나라도 있으면 즉시 끊김
    const hasMissed = dayRoutines.some((rt) => {
      const rec = dayRecords.find((r) => r.routineId === rt.id);
      // 저장된 레코드가 없으면 PENDING (미체크) → MISSED 판정
      // flushMissedRecords 호출 후에는 과거 날짜 PENDING이 MISSED로 전이되어 있음
      // 단, 혹시 전이가 안 된 과거 날짜가 있을 수 있으므로 날짜 비교로 보호
      if (!rec) {
        // 과거 날짜에 레코드 없음 = 미체크 = MISSED
        return true;
      }
      return rec.status === 'MISSED';
    });
    if (hasMissed) return 'broken';

    const allChecked = dayRoutines.every((rt) => {
      const rec = dayRecords.find((r) => r.routineId === rt.id);
      return rec?.status === 'CHECKED';
    });
    return allChecked ? 'complete' : 'broken';
  }

  const todayStr = kstDateOf(now);
  let streak = 0;

  // 오늘 날짜 판정 — 오늘 전체 회차가 CHECKED이면 스트릭에 포함
  const todayResult = judgDay(todayStr);
  if (todayResult === 'complete') {
    streak = 1;
  } else if (todayResult === 'broken') {
    // 오늘 MISSED가 이미 발생했으면 스트릭 0
    return 0;
  }
  // todayResult === 'skip' → 오늘은 회차 없음, 어제부터 역산

  // 어제부터 역방향 탐색 (최대 366일 안전 상한)
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  for (let i = 1; i <= 366; i++) {
    const d = new Date(now.getTime() - i * MS_PER_DAY);
    const dateStr = kstDateOf(d);

    const result = judgDay(dateStr);
    if (result === 'complete') {
      streak += 1;
    } else if (result === 'broken') {
      break;
    }
    // 'skip' → 해당 요일 회차 없음, 스트릭 유지하며 계속
  }

  return streak;
}

// ─── 배지 지급 (Step 6) ───────────────────────────────────────────────────────

/**
 * 스트릭 달성 시 배지를 지급하고, 새로 지급된 배지 종류를 반환한다.
 * 이미 획득한 배지면 null 반환 (축하 화면 중복 방지).
 *
 * 저장 키: `badges` (BadgeKind[] JSON 배열)
 * 순서: streak7 → streak30 → streak100 (하나씩, 가장 낮은 미획득 배지만 반환)
 *
 * Ref: PRD step-06 §처리 3
 *   "7일·30일·100일 스트릭 달성 시 배지"
 *   "첫 달성 시 전면 축하 화면 1회 노출"
 * Ref: references/sdk/framework/저장소/Storage.md §setItem/getItem
 */
export async function unlockBadgeIfQualified(
  streak: number,
): Promise<BadgeKind | null> {
  // 현재 획득한 배지 목록 로드
  const raw = await Storage.getItem(BADGE_STORAGE_KEY);
  const earned: BadgeKind[] = raw
    ? (() => {
        try {
          return JSON.parse(raw) as BadgeKind[];
        } catch {
          return [];
        }
      })()
    : [];

  // 가장 낮은 미획득 배지 중 임계값 달성한 것 탐색
  for (const { kind, days } of BADGE_THRESHOLDS) {
    if (streak >= days && !earned.includes(kind)) {
      // 신규 배지 지급
      const updated = [...earned, kind];
      await Storage.setItem(BADGE_STORAGE_KEY, JSON.stringify(updated));
      return kind;
    }
  }

  return null;
}

/**
 * 획득한 배지 목록 조회.
 *
 * Ref: PRD step-06 §처리 3
 * Ref: references/sdk/framework/저장소/Storage.md §getItem
 */
export async function getEarnedBadges(): Promise<BadgeKind[]> {
  const raw = await Storage.getItem(BADGE_STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as BadgeKind[];
  } catch {
    return [];
  }
}

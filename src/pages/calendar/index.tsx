/**
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-06-streak.md §행동 "스트릭 탭 → 월간 캘린더"
 *  - references/sdk/framework/저장소/Storage.md (getRecords)
 *  - references/dev-guide/design/consumer-ux-guide.md (다크패턴 5종 방지)
 *  - references/dev-guide/design/ux-writing.md (해요체, 능동형)
 *
 * 이번 달 7×N 그리드. 각 날짜에 ✅/❌/빈 상태 표시.
 * 외부 라이브러리 없음. 뒤로가기로 홈 복귀.
 */
import { createRoute } from '@granite-js/react-native';
import React, { useEffect, useState } from 'react';
import {
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  canBackfillDate,
  getKSTDateString,
  getRecords,
  toggleCheckForDate,
  MAX_BACKFILL_DAYS,
} from '../../services/recordService';
import { getRoutines } from '../../services/storageService';
import type { DoseRecord } from '../../types/record';
import type { DoseRoutine } from '../../types/routine';

export const Route = createRoute('/calendar', {
  validateParams: (params) => params,
  component: CalendarPage,
});

// ─── 요일 레이블 (일~토, 그리드 표시 기준) ────────────────────────────────────
// 캘린더 그리드는 JS 관행(일=0 … 토=6) 기준으로 표시
const WEEK_LABELS = ['일', '월', '화', '수', '목', '금', '토'] as const;

// PRD 기준 weekday(0=월…6=일) → JS getDay()(0=일…6=토) 변환
function prdWeekdayToJsDay(prdDay: number): number {
  // prd: 0=월(JS=1) … 5=토(JS=6) … 6=일(JS=0)
  return prdDay === 6 ? 0 : prdDay + 1;
}

// JS Date 요일(0=일…6=토) → PRD 기준(0=월…6=일)
function jsDayToPrdWeekday(jsDay: number): number {
  return jsDay === 0 ? 6 : jsDay - 1;
}

// ─── 날짜별 판정 ──────────────────────────────────────────────────────────────

type DayMark = 'complete' | 'missed' | 'none';

function markForDate(
  dateStr: string,
  routines: DoseRoutine[],
  records: DoseRecord[],
  todayStr: string,
): DayMark {
  // 미래 날짜는 빈 상태
  if (dateStr > todayStr) return 'none';

  // 해당 날짜의 JS요일 → PRD weekday
  const d = new Date(dateStr + 'T12:00:00Z');
  const prdWeekday = jsDayToPrdWeekday(d.getUTCDay());

  // 해당 날짜에 해당하는 회차 목록
  // 회차 등록일(createdAt KST) 이전 날짜는 제외 — 등록 전 날짜는 "데이터 없음"
  const dayRoutines = routines.filter((r) => {
    const createdDateKst = getKSTDateString(new Date(r.createdAt));
    if (dateStr < createdDateKst) return false;
    if (r.frequency === 'daily') return true;
    if (r.frequency === 'weekly') return r.weekdays?.includes(prdWeekday) ?? false;
    return false;
  });

  if (dayRoutines.length === 0) return 'none';

  const dayRecords = records.filter((r) => r.date === dateStr);

  // MISSED 하나라도 있거나 레코드 자체가 없는 과거 날짜 → missed
  const hasMissed = dayRoutines.some((rt) => {
    const rec = dayRecords.find((r) => r.routineId === rt.id);
    if (!rec) return true; // 미체크 = missed
    return rec.status === 'MISSED';
  });
  if (hasMissed) return 'missed';

  const allChecked = dayRoutines.every((rt) => {
    const rec = dayRecords.find((r) => r.routineId === rt.id);
    return rec?.status === 'CHECKED';
  });
  return allChecked ? 'complete' : 'none';
}

// ─── 이번 달 날짜 그리드 생성 ─────────────────────────────────────────────────

function buildMonthGrid(year: number, month: number): (string | null)[] {
  // month: 1~12
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const firstJsDay = firstDay.getUTCDay(); // 0=일 … 6=토
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const cells: (string | null)[] = [];

  // 앞 빈 칸 (일요일 시작 그리드)
  for (let i = 0; i < firstJsDay; i++) {
    cells.push(null);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dd = String(d).padStart(2, '0');
    const mm = String(month).padStart(2, '0');
    cells.push(`${year}-${mm}-${dd}`);
  }

  // 마지막 행이 7개 미만이면 빈 셀로 패딩 — 컬럼 정렬 보장
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }

  return cells;
}

// ─── 메인 화면 ────────────────────────────────────────────────────────────────

function CalendarPage() {
  // 토스 nav 바 사용 — useNavigation 사용 X

  const [isLoading, setIsLoading] = useState(true);
  const [routines, setRoutines] = useState<DoseRoutine[]>([]);
  const [records, setRecords] = useState<DoseRecord[]>([]);
  // 보정 바텀시트가 열린 날짜. null이면 닫힘.
  const [sheetDate, setSheetDate] = useState<string | null>(null);

  const todayStr = getKSTDateString();
  const todayYear = Number(todayStr.slice(0, 4));
  const todayMonth = Number(todayStr.slice(5, 7));

  // 특정 날짜에 예정된 회차 (frequency + weekday + createdAt 가드)
  function routinesForDate(dateStr: string): DoseRoutine[] {
    const d = new Date(dateStr + 'T12:00:00Z');
    const prdWeekday = jsDayToPrdWeekday(d.getUTCDay());
    return routines.filter((r) => {
      const createdDateKst = getKSTDateString(new Date(r.createdAt));
      if (dateStr < createdDateKst) return false;
      if (r.frequency === 'daily') return true;
      if (r.frequency === 'weekly') return r.weekdays?.includes(prdWeekday) ?? false;
      return false;
    });
  }

  // 셀이 탭 가능한지 — 과거 + 회차 있음 + 14일 이내
  function isCellTappable(dateStr: string): boolean {
    if (dateStr >= todayStr) return false;
    const dayRoutines = routinesForDate(dateStr);
    if (dayRoutines.length === 0) return false;
    return dayRoutines.some((r) => canBackfillDate(r.createdAt, dateStr, todayStr));
  }

  function handleCellPress(dateStr: string) {
    if (!isCellTappable(dateStr)) return;
    setSheetDate(dateStr);
  }

  async function handleSheetToggle(routine: DoseRoutine, dateStr: string) {
    const updated = await toggleCheckForDate(
      routine.id,
      routine.createdAt,
      dateStr,
      todayStr,
    );
    if (!updated) return;
    setRecords((prev) => {
      const idx = prev.findIndex(
        (r) => r.routineId === routine.id && r.date === dateStr,
      );
      if (idx === -1) return [...prev, updated];
      return prev.map((r, i) => (i === idx ? updated : r));
    });
  }

  // 해당 날짜에 보정 체크된 레코드가 하나라도 있는지 (셀의 "지각" 마커용)
  function hasRetroactiveOnDate(dateStr: string): boolean {
    return records.some((r) => r.date === dateStr && r.checkedRetroactivelyAt);
  }

  useEffect(() => {
    async function load() {
      try {
        const [r, rec] = await Promise.all([getRoutines(), getRecords()]);
        setRoutines(r);
        setRecords(rec);
      } finally {
        setIsLoading(false);
      }
    }
    void load();
  }, []);

  const cells = buildMonthGrid(todayYear, todayMonth);
  const monthLabel = `${todayYear}년 ${todayMonth}월`;

  return (
    <View style={styles.container}>
      {/* ── 헤더 ── */}
      <View style={styles.header} testID="calendar-header">
        {/* 뒤로가기는 토스 nav 바가 제공 — 자체 ← 버튼 제거 (검수 가이드) */}
        <Text style={styles.headerTitle} accessibilityRole="header">
          {monthLabel} 복약 기록
        </Text>
      </View>

      {isLoading ? (
        <View style={styles.loadingContainer} testID="calendar-loading">
          <Text style={styles.loadingText}>불러오는 중이에요...</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          testID="calendar-scroll"
        >
          {/* 범례 */}
          <View style={styles.legend} testID="calendar-legend">
            <View style={styles.legendItem}>
              <Text style={styles.legendEmoji}>✅</Text>
              <Text style={styles.legendText}>전체 완료</Text>
            </View>
            <View style={styles.legendItem}>
              <Text style={styles.legendEmoji}>❌</Text>
              <Text style={styles.legendText}>놓친 회차 있음</Text>
            </View>
          </View>

          {/* 요일 헤더 */}
          <View style={styles.weekRow} testID="calendar-week-header">
            {WEEK_LABELS.map((label) => (
              <View key={label} style={styles.dayCell}>
                <Text style={styles.weekLabel}>{label}</Text>
              </View>
            ))}
          </View>

          {/* 날짜 그리드 — 7열을 row 단위로 chunk (RN flexbox width % 누적 오차 방지) */}
          <View testID="calendar-grid">
            {Array.from({ length: Math.ceil(cells.length / 7) }, (_, rowIdx) => (
              <View key={`row-${rowIdx}`} style={styles.weekRow}>
                {cells.slice(rowIdx * 7, rowIdx * 7 + 7).map((dateStr, colIdx) => {
                  if (!dateStr) {
                    return (
                      <View key={`empty-${rowIdx}-${colIdx}`} style={styles.dayCell} />
                    );
                  }

                  const dayNum = Number(dateStr.slice(8, 10));
                  const isToday = dateStr === todayStr;
                  const mark = markForDate(dateStr, routines, records, todayStr);
                  const tappable = isCellTappable(dateStr);
                  const showRetro = hasRetroactiveOnDate(dateStr);

                  return (
                    <TouchableOpacity
                      key={dateStr}
                      style={[styles.dayCell, isToday && styles.dayCellToday]}
                      activeOpacity={tappable ? 0.6 : 1}
                      disabled={!tappable}
                      onPress={() => handleCellPress(dateStr)}
                      accessibilityRole={tappable ? 'button' : undefined}
                      accessibilityLabel={
                        tappable ? `${dateStr} 보정 체크하기` : undefined
                      }
                      testID={`calendar-day-${dateStr}`}
                    >
                      <Text
                        style={[
                          styles.dayNumber,
                          isToday && styles.dayNumberToday,
                        ]}
                      >
                        {dayNum}
                      </Text>
                      {mark === 'complete' && (
                        <Text style={styles.markEmoji} testID={`mark-complete-${dateStr}`}>
                          ✅
                        </Text>
                      )}
                      {mark === 'missed' && (
                        <Text style={styles.markEmoji} testID={`mark-missed-${dateStr}`}>
                          ❌
                        </Text>
                      )}
                      {showRetro && (
                        <Text
                          style={styles.retroBadge}
                          testID={`mark-retro-${dateStr}`}
                        >
                          지각
                        </Text>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
          </View>
        </ScrollView>
      )}

      {/* 보정 체크 바텀시트 — 14일 이내 과거 날짜 탭 시 노출 */}
      <Modal
        visible={sheetDate !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setSheetDate(null)}
      >
        <View style={styles.sheetOverlay}>
          <View style={styles.sheetContent} testID="backfill-sheet">
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {sheetDate ? `${sheetDate} 보정 체크` : ''}
              </Text>
              <TouchableOpacity
                onPress={() => setSheetDate(null)}
                accessibilityRole="button"
                accessibilityLabel="바텀시트 닫기"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.sheetClose}>닫기</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.sheetCaption}>
              {`최대 ${MAX_BACKFILL_DAYS}일 이내 회차만 보정할 수 있어요`}
            </Text>

            {sheetDate &&
              routinesForDate(sheetDate).map((routine) => {
                const rec = records.find(
                  (r) => r.routineId === routine.id && r.date === sheetDate,
                );
                const isChecked = rec?.status === 'CHECKED';
                const isRetro = !!rec?.checkedRetroactivelyAt;
                return (
                  <TouchableOpacity
                    key={routine.id}
                    style={styles.sheetRow}
                    onPress={() => void handleSheetToggle(routine, sheetDate)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: isChecked }}
                    accessibilityLabel={`${routine.label} ${routine.time} ${isChecked ? '체크됨' : '미체크'}`}
                  >
                    <View style={styles.sheetRowMain}>
                      <Text style={styles.sheetRowLabel}>{routine.label}</Text>
                      <Text style={styles.sheetRowTime}>{routine.time}</Text>
                      {isRetro && (
                        <Text style={styles.sheetRowRetro}>지각 체크</Text>
                      )}
                    </View>
                    <Text style={styles.sheetRowStatus}>
                      {isChecked ? '✅' : '⭕️'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const CELL_SIZE = 44;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8F9FA',
  },
  header: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 56 : 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F2F4F6',
  },
  backButton: {
    marginBottom: 8,
    minHeight: 36,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  backText: {
    fontSize: 16,
    color: '#FF6B6B',
    fontWeight: '500',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#191F28',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    fontSize: 16,
    color: '#8B95A1',
  },
  content: {
    paddingHorizontal: 12,
    paddingTop: 16,
    paddingBottom: 40,
  },
  legend: {
    flexDirection: 'row',
    gap: 20,
    marginBottom: 16,
    paddingHorizontal: 4,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendEmoji: {
    fontSize: 14,
  },
  legendText: {
    fontSize: 13,
    color: '#6B7684',
  },
  weekRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  dayCell: {
    // flex: 1로 7개 셀이 부모 너비를 균등 분할 → wrap 누적 오차 없음
    flex: 1,
    minHeight: CELL_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  dayCellToday: {
    backgroundColor: '#FF6B6B11',
    borderRadius: 8,
  },
  weekLabel: {
    fontSize: 12,
    color: '#8B95A1',
    fontWeight: '500',
  },
  dayNumber: {
    fontSize: 14,
    color: '#191F28',
    fontWeight: '400',
    marginBottom: 2,
  },
  dayNumberToday: {
    color: '#FF6B6B',
    fontWeight: '700',
  },
  markEmoji: {
    fontSize: 14,
    lineHeight: 16,
  },
  retroBadge: {
    fontSize: 9,
    color: '#FF9F40',
    fontWeight: '600',
    marginTop: 1,
  },
  // 보정 바텀시트
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheetContent: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 12,
    paddingHorizontal: 24,
    paddingBottom: Platform.OS === 'ios' ? 40 : 28,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#E5E8EB',
    marginBottom: 16,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#191F28',
    flex: 1,
  },
  sheetClose: {
    fontSize: 15,
    fontWeight: '600',
    color: '#4E5968',
  },
  sheetCaption: {
    fontSize: 13,
    color: '#8B95A1',
    marginBottom: 16,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F2F4F6',
  },
  sheetRowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  sheetRowLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#191F28',
  },
  sheetRowTime: {
    fontSize: 14,
    color: '#6B7684',
  },
  sheetRowRetro: {
    fontSize: 11,
    color: '#FF9F40',
    fontWeight: '600',
    backgroundColor: '#FFF4E6',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  sheetRowStatus: {
    fontSize: 22,
    marginLeft: 12,
  },
});

// prdWeekdayToJsDay는 향후 확장용으로 export — 현재 calendar 내부 로직에서만 사용
export { prdWeekdayToJsDay };

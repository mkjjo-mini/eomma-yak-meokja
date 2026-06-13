/**
 * 전체 회차 보기 — 오늘 도래하지 않는 회차도 모두 노출해 편집·삭제 가능.
 *
 * 홈은 '오늘 복약'만 보여주므로, 주간 회차가 오늘 요일을 포함하지 않으면
 * 홈에서 사라져 보임. 사용자가 다음 도래 요일을 기다리지 않고도 회차를
 * 손볼 수 있게 별도 진입점 제공.
 *
 * 길게 누르기 → 수정·삭제 메뉴 (홈과 동일 패턴).
 */
import { Storage } from '@apps-in-toss/framework';
import { createRoute, useNavigation } from '@granite-js/react-native';
import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { getRoutines } from '../../services/storageService';
import { getRecords, getKSTDateString } from '../../services/recordService';
import { deleteSchedule } from '../../services/scheduleService';
import { getSavedUserKey } from '../../services/authService';
import type { DoseRoutine } from '../../types/routine';
import { WEEKDAY_LABELS, MEAL_TIMING_LABELS } from '../../types/routine';

export const Route = createRoute('/routines/list', {
  validateParams: (params) => params,
  component: RoutineListPage,
});

function formatFrequency(routine: DoseRoutine): string {
  if (routine.frequency === 'daily') return '매일';
  if (routine.frequency === 'weekly') {
    const days = (routine.weekdays ?? [])
      .slice()
      .sort((a, b) => a - b)
      .map((d) => WEEKDAY_LABELS[d])
      .join('·');
    return days ? `${days}요일` : '주간';
  }
  return '';
}

function RoutineListPage() {
  const navigation = useNavigation();
  const [routines, setRoutines] = useState<DoseRoutine[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // 길게 누르기 메뉴 + 삭제 확인 (홈과 동일 패턴)
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuRoutine, setMenuRoutine] = useState<DoseRoutine | null>(null);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [deleteTargetRoutine, setDeleteTargetRoutine] = useState<DoseRoutine | null>(null);

  // 토스트
  const [toastMessage, setToastMessage] = useState('');

  function showToast(message: string) {
    setToastMessage(message);
    setTimeout(() => setToastMessage(''), 2500);
  }

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const all = await getRoutines();
      const sorted = [...all].sort((a, b) => a.time.localeCompare(b.time));
      setRoutines(sorted);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function handleEdit(routine: DoseRoutine) {
    navigation.navigate('/routines/add', { routineId: routine.id });
  }

  function handleLongPress(routine: DoseRoutine) {
    setMenuRoutine(routine);
    setMenuVisible(true);
  }

  function handleMenuEdit() {
    setMenuVisible(false);
    if (!menuRoutine) return;
    navigation.navigate('/routines/add', { routineId: menuRoutine.id });
  }

  function handleMenuDelete() {
    setMenuVisible(false);
    if (!menuRoutine) return;
    setDeleteTargetRoutine(menuRoutine);
    setDeleteConfirmVisible(true);
  }

  async function handleDeleteConfirm() {
    if (!deleteTargetRoutine) return;
    setDeleteConfirmVisible(false);

    try {
      const all = await getRoutines();
      const updated = all.filter((r) => r.id !== deleteTargetRoutine.id);
      await Storage.setItem('routines', JSON.stringify(updated));

      // 해당 루틴의 레코드도 제거 (홈과 동일)
      const records = await getRecords();
      const updatedRecords = records.filter(
        (rec) => rec.routineId !== deleteTargetRoutine.id,
      );
      await Storage.setItem('records', JSON.stringify(updatedRecords));

      // Vercel KV 스케줄도 백그라운드 삭제
      void (async () => {
        try {
          const userKey = await getSavedUserKey();
          if (userKey) {
            await deleteSchedule(deleteTargetRoutine.id, userKey);
          }
        } catch (err) {
          console.warn('[list] 스케줄 삭제 동기화 실패 (재시도 큐 적재됨):', err);
        }
      })();

      showToast('회차를 삭제했어요');
      await load();
    } catch {
      showToast('삭제에 실패했어요. 다시 시도해요');
    }

    setDeleteTargetRoutine(null);
  }

  /**
   * 오늘부터 그만 보기 — soft delete. 과거 기록 보존.
   * discontinuedAt = 오늘(KST) → filterTodayRoutines가 자동 필터.
   */
  async function handleDiscontinueConfirm() {
    if (!deleteTargetRoutine) return;
    setDeleteConfirmVisible(false);

    try {
      const todayDate = getKSTDateString();
      const all = await getRoutines();
      const updated = all.map((r) =>
        r.id === deleteTargetRoutine.id ? { ...r, discontinuedAt: todayDate } : r,
      );
      await Storage.setItem('routines', JSON.stringify(updated));

      // 오늘 PENDING 레코드 정리 (체크된 건 보존)
      const records = await getRecords();
      const updatedRecords = records.filter(
        (rec) =>
          !(
            rec.routineId === deleteTargetRoutine.id &&
            rec.date === todayDate &&
            rec.status === 'PENDING'
          ),
      );
      await Storage.setItem('records', JSON.stringify(updatedRecords));

      void (async () => {
        try {
          const userKey = await getSavedUserKey();
          if (userKey) {
            await deleteSchedule(deleteTargetRoutine.id, userKey);
          }
        } catch (err) {
          console.warn('[list] 스케줄 삭제 동기화 실패 (재시도 큐 적재됨):', err);
        }
      })();

      showToast('오늘부터 안 보여요. 과거 기록은 보존돼요');
      await load();
    } catch {
      showToast('처리에 실패했어요. 다시 시도해요');
    }

    setDeleteTargetRoutine(null);
  }

  return (
    <View style={styles.container} testID="routine-list-page">
      <View style={styles.header}>
        <Text style={styles.headerTitle}>전체 회차</Text>
        <Text style={styles.headerSubtitle}>
          탭하면 수정해요. 더보기(⋯)로 삭제할 수 있어요.
        </Text>
      </View>

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>불러오는 중이에요...</Text>
        </View>
      ) : routines.length === 0 ? (
        <View style={styles.emptyContainer} testID="routine-list-empty">
          <Text style={styles.emptyIcon}>💊</Text>
          <Text style={styles.emptyText}>등록된 회차가 없어요</Text>
          <TouchableOpacity
            style={styles.emptyAction}
            onPress={() => navigation.navigate('/routines/add')}
            accessibilityRole="button"
            accessibilityLabel="회차 등록 화면으로 가요"
          >
            <Text style={styles.emptyActionText}>회차 등록하기</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={routines}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <TouchableOpacity
                style={styles.cardMain}
                onPress={() => handleEdit(item)}
                accessibilityRole="button"
                accessibilityLabel={`${item.label} 회차 수정`}
                testID={`routine-list-item-${item.id}`}
              >
                <View style={styles.cardTimeBlock}>
                  <Text style={styles.cardTime}>{item.time}</Text>
                  {item.mealTiming && (
                    <Text style={styles.cardMeal}>
                      {MEAL_TIMING_LABELS[item.mealTiming]}
                    </Text>
                  )}
                </View>
                <View style={styles.cardBody}>
                  <Text
                    style={[
                      styles.cardLabel,
                      item.discontinuedAt && styles.cardLabelDiscontinued,
                    ]}
                    numberOfLines={1}
                  >
                    {item.label}
                  </Text>
                  <Text style={styles.cardFrequency}>
                    {item.discontinuedAt
                      ? `그만 보는 중 · ${formatFrequency(item)}`
                      : formatFrequency(item)}
                  </Text>
                </View>
              </TouchableOpacity>
              {/* ⋯ 버튼 — 메뉴(수정/삭제) 열기. long-press 없이도 발견 가능. */}
              <TouchableOpacity
                style={styles.cardMoreButton}
                onPress={() => handleLongPress(item)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel={`${item.label} 더보기`}
                testID={`routine-list-more-${item.id}`}
              >
                <Text style={styles.cardMoreText}>⋯</Text>
              </TouchableOpacity>
            </View>
          )}
        />
      )}

      {/* 길게 누르기 메뉴 — 홈과 동일 다크패턴 방지 패턴 */}
      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}
        testID="long-press-menu-modal"
      >
        <TouchableWithoutFeedback onPress={() => setMenuVisible(false)}>
          <View style={styles.menuOverlay}>
            <TouchableWithoutFeedback>
              <View style={styles.menuContent}>
                <Text style={styles.menuTitle} numberOfLines={1}>
                  {menuRoutine?.label ?? ''}
                </Text>
                <TouchableOpacity
                  style={styles.menuItem}
                  onPress={handleMenuEdit}
                  accessibilityRole="button"
                >
                  <Text style={styles.menuItemText}>수정해요</Text>
                </TouchableOpacity>
                <View style={styles.menuDivider} />
                <TouchableOpacity
                  style={styles.menuItem}
                  onPress={handleMenuDelete}
                  accessibilityRole="button"
                >
                  <Text style={[styles.menuItemText, styles.menuItemDelete]}>
                    삭제해요
                  </Text>
                </TouchableOpacity>
                <View style={styles.menuDivider} />
                <TouchableOpacity
                  style={styles.menuItem}
                  onPress={() => setMenuVisible(false)}
                  accessibilityRole="button"
                >
                  <Text style={styles.menuItemClose}>닫기</Text>
                </TouchableOpacity>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* 삭제 확인 */}
      <Modal
        visible={deleteConfirmVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setDeleteConfirmVisible(false)}
        testID="delete-confirm-modal"
      >
        <TouchableWithoutFeedback onPress={() => setDeleteConfirmVisible(false)}>
          <View style={styles.menuOverlay}>
            <TouchableWithoutFeedback>
              <View style={styles.confirmContent}>
                <Text style={styles.confirmTitle}>
                  {`'${deleteTargetRoutine?.label ?? ''}' 회차를 어떻게 할까요?`}
                </Text>
                <TouchableOpacity
                  style={styles.discontinueAction}
                  onPress={() => void handleDiscontinueConfirm()}
                  accessibilityRole="button"
                  testID="action-discontinue"
                >
                  <Text style={styles.discontinueActionTitle}>오늘부터 그만 보기</Text>
                  <Text style={styles.discontinueActionSubtitle}>
                    과거 복약 기록과 통계는 그대로 유지돼요
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.deleteAllAction}
                  onPress={() => void handleDeleteConfirm()}
                  accessibilityRole="button"
                  testID="action-delete-all"
                >
                  <Text style={styles.deleteAllActionTitle}>전부 삭제하기</Text>
                  <Text style={styles.deleteAllActionSubtitle}>
                    과거 복약 기록까지 모두 사라져요. 통계에 영향이 있어요.
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.deleteCloseAction}
                  onPress={() => {
                    setDeleteConfirmVisible(false);
                    setDeleteTargetRoutine(null);
                  }}
                  accessibilityRole="button"
                >
                  <Text style={styles.deleteCloseActionText}>닫기</Text>
                </TouchableOpacity>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* 토스트 */}
      {toastMessage ? (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toastMessage}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F2F4F6',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#191F28',
  },
  headerSubtitle: {
    fontSize: 13,
    color: '#6B7684',
    marginTop: 4,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    color: '#8B95A1',
    fontSize: 14,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 16,
    color: '#4E5968',
    marginBottom: 20,
  },
  emptyAction: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#FF6B6B',
  },
  emptyActionText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  listContent: {
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    marginBottom: 10,
  },
  cardMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  cardMoreButton: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 44,
    minHeight: 44,
  },
  cardMoreText: {
    fontSize: 22,
    color: '#8B95A1',
    fontWeight: '700',
  },
  cardTimeBlock: {
    alignItems: 'center',
    marginRight: 14,
    minWidth: 56,
  },
  cardTime: {
    fontSize: 16,
    fontWeight: '700',
    color: '#191F28',
  },
  cardMeal: {
    fontSize: 11,
    color: '#8B95A1',
    marginTop: 2,
  },
  cardBody: {
    flex: 1,
  },
  cardLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#191F28',
  },
  cardLabelDiscontinued: {
    color: '#8B95A1',
    textDecorationLine: 'line-through',
  },
  cardFrequency: {
    fontSize: 12,
    color: '#6B7684',
    marginTop: 3,
  },
  // 메뉴 모달
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  menuContent: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    paddingVertical: 8,
  },
  menuTitle: {
    fontSize: 13,
    color: '#8B95A1',
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingVertical: 10,
    textAlign: 'center',
  },
  menuItem: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuItemText: {
    fontSize: 16,
    color: '#191F28',
    fontWeight: '500',
  },
  menuItemDelete: {
    color: '#F04438',
  },
  menuItemClose: {
    fontSize: 16,
    color: '#6B7684',
    fontWeight: '500',
  },
  menuDivider: {
    height: 1,
    backgroundColor: '#F2F4F6',
  },

  // 삭제 확인 (3옵션: 그만 보기 / 전부 삭제 / 닫기)
  confirmContent: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 22,
  },
  confirmTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#191F28',
    marginBottom: 18,
  },
  discontinueAction: {
    backgroundColor: '#F2F4F6',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 10,
  },
  discontinueActionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#191F28',
  },
  discontinueActionSubtitle: {
    fontSize: 13,
    color: '#6B7684',
    marginTop: 4,
  },
  deleteAllAction: {
    backgroundColor: '#FFF1F0',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 10,
  },
  deleteAllActionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#F04438',
  },
  deleteAllActionSubtitle: {
    fontSize: 13,
    color: '#B25344',
    marginTop: 4,
  },
  deleteCloseAction: {
    paddingVertical: 14,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  deleteCloseActionText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#6B7684',
  },

  // 토스트
  toast: {
    position: 'absolute',
    bottom: 80,
    alignSelf: 'center',
    backgroundColor: 'rgba(25, 31, 40, 0.92)',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 24,
  },
  toastText: {
    color: '#FFFFFF',
    fontSize: 14,
  },
});

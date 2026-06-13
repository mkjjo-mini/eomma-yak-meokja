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
import { getRecords } from '../../services/recordService';
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

  return (
    <View style={styles.container} testID="routine-list-page">
      <View style={styles.header}>
        <Text style={styles.headerTitle}>전체 회차</Text>
        <Text style={styles.headerSubtitle}>
          탭하면 수정해요. 길게 눌러서 삭제할 수 있어요.
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
            <TouchableOpacity
              style={styles.card}
              onPress={() => handleEdit(item)}
              onLongPress={() => handleLongPress(item)}
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
                <Text style={styles.cardLabel} numberOfLines={1}>
                  {item.label}
                </Text>
                <Text style={styles.cardFrequency}>{formatFrequency(item)}</Text>
              </View>
              <Text style={styles.cardArrow}>›</Text>
            </TouchableOpacity>
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
                  {`'${deleteTargetRoutine?.label ?? ''}' 회차를 삭제할까요?`}
                </Text>
                <Text style={styles.confirmSubtitle}>
                  이 회차와 관련된 기록도 함께 삭제돼요.
                </Text>
                <View style={styles.confirmActions}>
                  <TouchableOpacity
                    style={[styles.confirmButton, styles.confirmCancel]}
                    onPress={() => {
                      setDeleteConfirmVisible(false);
                      setDeleteTargetRoutine(null);
                    }}
                    accessibilityRole="button"
                  >
                    <Text style={styles.confirmCancelText}>닫기</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.confirmButton, styles.confirmDelete]}
                    onPress={() => void handleDeleteConfirm()}
                    accessibilityRole="button"
                  >
                    <Text style={styles.confirmDeleteText}>삭제해요</Text>
                  </TouchableOpacity>
                </View>
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
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 10,
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
  cardFrequency: {
    fontSize: 12,
    color: '#6B7684',
    marginTop: 3,
  },
  cardArrow: {
    fontSize: 20,
    color: '#B0B8C1',
    marginLeft: 8,
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

  // 삭제 확인
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
    textAlign: 'center',
  },
  confirmSubtitle: {
    fontSize: 13,
    color: '#6B7684',
    marginTop: 8,
    textAlign: 'center',
  },
  confirmActions: {
    flexDirection: 'row',
    marginTop: 20,
    gap: 8,
  },
  confirmButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  confirmCancel: {
    backgroundColor: '#F2F4F6',
  },
  confirmCancelText: {
    fontSize: 15,
    color: '#4E5968',
    fontWeight: '600',
  },
  confirmDelete: {
    backgroundColor: '#F04438',
  },
  confirmDeleteText: {
    fontSize: 15,
    color: '#FFFFFF',
    fontWeight: '600',
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

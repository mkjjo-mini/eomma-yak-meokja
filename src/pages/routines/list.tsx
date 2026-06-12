/**
 * 전체 회차 보기 — 오늘 도래하지 않는 회차도 모두 노출해 편집·삭제 가능.
 *
 * 홈은 '오늘 복약'만 보여주므로, 주간 회차가 오늘 요일을 포함하지 않으면
 * 홈에서 사라져 보임. 사용자가 다음 도래 요일을 기다리지 않고도 회차를
 * 손볼 수 있게 별도 진입점 제공.
 */
import { createRoute, useNavigation } from '@granite-js/react-native';
import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { getRoutines } from '../../services/storageService';
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

  return (
    <View style={styles.container} testID="routine-list-page">
      <View style={styles.header}>
        <Text style={styles.headerTitle}>전체 회차</Text>
        <Text style={styles.headerSubtitle}>
          탭하면 회차를 수정할 수 있어요
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
});

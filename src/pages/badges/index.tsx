/**
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-06-streak.md §행동 "배지 탭 → 배지 컬렉션 화면"
 *  - references/sdk/framework/저장소/Storage.md (getEarnedBadges)
 *  - references/dev-guide/design/consumer-ux-guide.md (다크패턴 5종 방지)
 *  - references/dev-guide/design/ux-writing.md (해요체, 능동형)
 *
 * 획득/미획득 배지 3종 슬롯 표시. 라이브러리 추가 없음.
 * 뒤로가기로 홈 복귀.
 */
import { createRoute } from '@granite-js/react-native';
import React, { useEffect, useState } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { getEarnedBadges } from '../../services/recordService';
import { type BadgeKind, BADGE_META, BADGE_THRESHOLDS } from '../../types/badge';

export const Route = createRoute('/badges', {
  validateParams: (params) => params,
  component: BadgesPage,
});

function BadgesPage() {
  // 토스 nav 바 사용 — useNavigation 사용 X
  const [earned, setEarned] = useState<BadgeKind[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getEarnedBadges()
      .then(setEarned)
      .catch(() => setEarned([]))
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <View style={styles.container}>
      {/* ── 헤더 ── */}
      {/* Ref: references/dev-guide/design/ux-writing.md §해요체·능동형 */}
      <View style={styles.header} testID="badges-header">
        {/* 뒤로가기는 토스 nav 바가 제공 — 자체 ← 버튼 제거 (검수 가이드) */}
        <Text style={styles.headerTitle} accessibilityRole="header">
          배지 컬렉션
        </Text>
      </View>

      {isLoading ? (
        <View style={styles.loadingContainer} testID="badges-loading">
          <Text style={styles.loadingText}>불러오는 중이에요...</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          testID="badges-scroll"
        >
          <Text style={styles.sectionDesc}>
            매일 꾸준히 약을 챙기면 배지를 받아요
          </Text>

          {/* ── 배지 슬롯 3개 ── */}
          {BADGE_THRESHOLDS.map(({ kind }) => {
            const meta = BADGE_META[kind];
            const isEarned = earned.includes(kind);
            return (
              <View
                key={kind}
                style={[styles.badgeCard, isEarned && styles.badgeCardEarned]}
                testID={`badge-card-${kind}`}
              >
                {/* 배지 아이콘 영역 */}
                <View
                  style={[
                    styles.badgeIconArea,
                    isEarned ? styles.badgeIconEarned : styles.badgeIconLocked,
                  ]}
                  testID={`badge-icon-${kind}`}
                >
                  {isEarned ? (
                    <Text style={styles.badgeEmoji}>{meta.emoji}</Text>
                  ) : (
                    // 미획득: 회색 잠금 아이콘
                    // Ref: PRD step-06 §출력 "미획득은 회색 잠금 아이콘"
                    <Text style={styles.lockEmoji} testID={`badge-locked-${kind}`}>
                      🔒
                    </Text>
                  )}
                </View>

                {/* 배지 설명 */}
                <View style={styles.badgeInfo}>
                  <Text
                    style={[
                      styles.badgeLabel,
                      !isEarned && styles.badgeLabelLocked,
                    ]}
                  >
                    {meta.label} 달성
                  </Text>
                  <Text
                    style={[
                      styles.badgeStatus,
                      isEarned ? styles.badgeStatusEarned : styles.badgeStatusLocked,
                    ]}
                    testID={`badge-status-${kind}`}
                  >
                    {isEarned ? '획득했어요' : `${meta.days}일 연속 복약 시 달성`}
                  </Text>
                </View>
              </View>
            );
          })}

          {/* 빈 상태 안내 */}
          {earned.length === 0 && (
            <View style={styles.emptyHint} testID="badges-empty-hint">
              <Text style={styles.emptyHintText}>
                매일 꾸준히 복약하면 7일 배지부터 받아요
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

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
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
  },
  sectionDesc: {
    fontSize: 15,
    color: '#6B7684',
    marginBottom: 20,
  },
  badgeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  badgeCardEarned: {
    borderWidth: 1.5,
    borderColor: '#FF6B6B33',
    backgroundColor: '#FFF5F5',
  },
  badgeIconArea: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  badgeIconEarned: {
    backgroundColor: '#FF6B6B22',
  },
  badgeIconLocked: {
    backgroundColor: '#F2F4F6',
  },
  badgeEmoji: {
    fontSize: 30,
  },
  lockEmoji: {
    fontSize: 24,
    opacity: 0.5,
  },
  badgeInfo: {
    flex: 1,
    gap: 4,
  },
  badgeLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#191F28',
  },
  badgeLabelLocked: {
    color: '#8B95A1',
  },
  badgeStatus: {
    fontSize: 14,
    fontWeight: '400',
  },
  badgeStatusEarned: {
    color: '#FF6B6B',
    fontWeight: '500',
  },
  badgeStatusLocked: {
    color: '#B0B8C1',
  },
  emptyHint: {
    marginTop: 8,
    alignItems: 'center',
    paddingVertical: 16,
  },
  emptyHintText: {
    fontSize: 14,
    color: '#8B95A1',
    textAlign: 'center',
  },
});

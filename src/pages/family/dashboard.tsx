/**
 * /family/dashboard — 케어러 홈: 케어 대상 오늘 복약 현황
 *
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-08-family.md §처리 5
 *  - references/sdk/framework/화면이동/routing.md §createRoute, useNavigation, useParams
 *  - references/dev-guide/design/consumer-ux-guide.md §다크패턴 5종 방지
 *  - references/dev-guide/design/ux-writing.md §해요체·능동형·긍정형
 *
 * 데이터 최소화 원칙:
 *  - Storage에 저장되는 항목: caregiverEvents 만
 *  - routines, records, photoBase64, medications 저장 금지
 *  Ref: step-08-family.md §처리 5 / §검수 "케어러 폰엔 회차 사진·상세 약 목록 저장 금지"
 *
 * 딥링크 수신:
 *  - 푸시 payload: intoss://eomma-yak-meokja/family/dashboard
 *  - 진입 시 caregiverEvents에 이벤트 추가
 *  Ref: step-08-family.md §처리 4
 *
 * 케어러 홈에서 회차 등록·수정 불가 (데이터 주인 원칙)
 * Ref: step-08-family.md §처리 5 "케어러 폰에선 회차 등록·수정 불가"
 */
import { createRoute, useNavigation } from '@granite-js/react-native';
import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import {
  addCaregiverEvent,
  getCaregiverEvents,
  getPairings,
  unpair,
} from '../../services/pairService';
import {
  fetchCareRecipientTodayStatus,
  type CareStatusEntry,
} from '../../services/careStatusService';
import type { CaregiverEvent, PairingRecord } from '../../types/pair';

export const Route = createRoute('/family/dashboard', {
  validateParams: (params) =>
    params as {
      /** 방금 페어링 완료한 경우 true */
      justPaired?: boolean;
      careRecipientNickname?: string;
      /** 푸시에서 넘어온 이벤트 (딥링크 파라미터) */
      pushRoutineLabel?: string;
      pushTakenAt?: string;
      pushKind?: 'checked' | 'missed';
      pushCareRecipientUserKey?: string;
      pushCareRecipientNickname?: string;
    },
  component: FamilyDashboardPage,
});

// ─── 시각 포맷 ───────────────────────────────────────────────────────────────

function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return '';
  }
}

// ─── 이벤트 카드 ─────────────────────────────────────────────────────────────

type EventCardProps = {
  event: CaregiverEvent;
};

function EventCard({ event }: EventCardProps) {
  const isChecked = event.kind === 'checked';

  return (
    <View
      style={[styles.eventCard, isChecked ? styles.eventCardChecked : styles.eventCardMissed]}
      testID={`event-card-${event.id}`}
    >
      <Text style={styles.eventNickname}>{event.careRecipientNickname}</Text>
      <Text style={styles.eventLabel}>{event.routineLabel}</Text>
      <View style={styles.eventStatusRow}>
        <Text style={[styles.eventStatus, isChecked ? styles.eventStatusChecked : styles.eventStatusMissed]}>
          {isChecked ? '드셨어요' : '놓치셨어요'}
        </Text>
        <Text style={styles.eventTime}>{formatTime(event.takenAt)}</Text>
      </View>
    </View>
  );
}

// ─── 메인 화면 ────────────────────────────────────────────────────────────────

function FamilyDashboardPage() {
  const navigation = useNavigation();
  const params = Route.useParams();

  const [events, setEvents] = useState<CaregiverEvent[]>([]);
  const [pairings, setPairings] = useState<PairingRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Pull 방식 가족 현황: 진입 시 케어 대상 오늘 상태 fetch
  // Ref: PRD step-08-family.md §처리 5 (Pull 방식)
  const [careStatus, setCareStatus] = useState<CareStatusEntry | null>(null);

  // 연결 해제 확인 모달
  const [unpairTarget, setUnpairTarget] = useState<PairingRecord | null>(null);
  const [unpairConfirmVisible, setUnpairConfirmVisible] = useState(false);

  // 토스트
  const [toastMessage, setToastMessage] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string) {
    setToastMessage(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMessage(''), 2500);
  }

  useEffect(() => {
    void initialize();
  }, []);

  async function initialize() {
    setIsLoading(true);
    try {
      // 푸시 탭으로 진입한 경우 이벤트 추가
      // Ref: step-08-family.md §처리 4 "진입 시 Storage caregiverEvents에 이벤트 추가"
      // 데이터 최소화: kind + label + 시각만 — 사진 URL 저장 금지
      // Ref: step-08-family.md §처리 4 "푸시 payload에 회차 사진 URL 포함하지 않음"
      if (
        params.pushRoutineLabel &&
        params.pushTakenAt &&
        params.pushKind &&
        params.pushCareRecipientUserKey
      ) {
        await addCaregiverEvent({
          careRecipientUserKey: params.pushCareRecipientUserKey,
          careRecipientNickname: params.pushCareRecipientNickname ?? '',
          routineLabel: params.pushRoutineLabel,
          kind: params.pushKind,
          takenAt: params.pushTakenAt,
          receivedAt: new Date().toISOString(),
        });
      }

      // justPaired 토스트
      // Ref: step-08-family.md §처리 2 "'{careRecipientNickname}님과 연결됐어요' 토스트"
      if (params.justPaired && params.careRecipientNickname) {
        showToast(`${params.careRecipientNickname}님과 연결됐어요`);
      }

      const todayStr = new Date().toISOString().slice(0, 10);

      const [evts, pairs, status] = await Promise.all([
        getCaregiverEvents(),
        getPairings(),
        fetchCareRecipientTodayStatus(todayStr),
      ]);

      // 오늘 이벤트만 필터링 (최신순 정렬)
      const todayEvents = evts
        .filter((e) => e.receivedAt.startsWith(todayStr))
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));

      setEvents(todayEvents);
      setPairings(pairs);
      setCareStatus(status);
    } finally {
      setIsLoading(false);
    }
  }

  // ─── 케어 대상 별명 ─────────────────────────────────────────────────────────

  const careRecipientNickname =
    params.careRecipientNickname ??
    pairings[0]?.careRecipientNickname ??
    '가족';

  // ─── 연결 해제 ─────────────────────────────────────────────────────────────

  async function handleUnpairConfirm() {
    if (!unpairTarget) return;
    setUnpairConfirmVisible(false);
    try {
      await unpair({ caregiverUserKey: unpairTarget.caregiverUserKey });
      showToast('연결을 해제했어요');
      const updatedPairs = await getPairings();
      setPairings(updatedPairs);
      // 페어링이 없으면 뒤로 이동
      if (updatedPairs.length === 0) {
        if (navigation.canGoBack()) navigation.goBack();
      }
    } catch {
      showToast('연결 해제에 실패했어요');
    }
    setUnpairTarget(null);
  }

  // ─── 렌더 ────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <View style={styles.loadingContainer} testID="loading-container">
        <Text style={styles.loadingText}>불러오는 중이에요...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* ── 헤더 ── */}
      {/* Ref: step-08-family.md §처리 5 "헤더: {careRecipientNickname}의 오늘 복약" */}
      {/* 내부 용어 "케어 대상" 노출 금지 — 사용자 입력 별명으로만 표시 */}
      {/* Ref: step-08-family.md §처리 3 */}
      <View style={styles.header}>
        {/* 뒤로가기는 토스 nav 바가 제공 — 자체 ← 버튼 제거 (검수 가이드) */}
        <Text style={styles.headerTitle} accessibilityRole="header" testID="dashboard-title">
          {`${careRecipientNickname}의 오늘 복약`}
        </Text>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── 오늘 복약 현황 (Pull 방식) ── */}
        {/* Ref: PRD step-08-family.md §처리 5 — 케어 대상 폰이 KV에 sync한 오늘 상태 표시 */}
        {careStatus && careStatus.items.length > 0 ? (
          <View style={styles.statusCard} testID="care-status-card">
            <Text style={styles.statusCardTitle}>
              {`오늘 복약 ${careStatus.items.filter((i) => i.status === 'CHECKED').length}/${careStatus.items.length}`}
            </Text>
            {careStatus.items.map((item) => (
              <View
                key={item.routineId}
                style={styles.statusItem}
                testID={`status-item-${item.routineId}`}
              >
                <View style={styles.statusItemLeft}>
                  <Text style={styles.statusItemLabel}>{item.routineLabel}</Text>
                  <Text style={styles.statusItemTime}>{item.scheduledTime}</Text>
                </View>
                <Text
                  style={[
                    styles.statusBadge,
                    item.status === 'CHECKED' && styles.statusBadgeChecked,
                    item.status === 'MISSED' && styles.statusBadgeMissed,
                    item.status === 'PENDING' && styles.statusBadgePending,
                  ]}
                >
                  {item.status === 'CHECKED'
                    ? '드셨어요'
                    : item.status === 'MISSED'
                      ? '놓치셨어요'
                      : '대기 중'}
                </Text>
              </View>
            ))}
            {careStatus.updatedAt && (
              <Text style={styles.statusUpdatedAt} testID="status-updated-at">
                {`${formatTime(careStatus.updatedAt)} 갱신`}
              </Text>
            )}
          </View>
        ) : (
          <View style={styles.emptyContainer} testID="empty-status">
            <Text style={styles.emptyIcon}>💊</Text>
            <Text style={styles.emptyText}>
              {careStatus?.empty
                ? `${careRecipientNickname}이/가 오늘 아직 앱을 안 여셨어요`
                : '아직 정보를 받아오지 못했어요'}
            </Text>
            <Text style={styles.emptySubtext}>
              {`${careRecipientNickname}이/가 회차를 등록하시면 여기에 표시돼요`}
            </Text>
          </View>
        )}

        {/* ── 이벤트 로그 (알림 활성 시 추가 표시. v1엔 항상 빈 상태) ── */}
        {events.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>최근 알림</Text>
            {events.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </>
        )}

        {/* ── 연결된 가족 목록 + 해제 버튼 ── */}
        {/* Ref: step-08-family.md §처리 5 "'연결 해제' 버튼" */}
        {pairings.length > 0 && (
          <View style={styles.pairingCard} testID="pairing-card">
            <Text style={styles.pairingCardTitle}>연결된 가족</Text>
            {pairings.map((p) => (
              <View key={p.caregiverUserKey} style={styles.pairingItem}>
                <Text style={styles.pairingNickname}>
                  {p.careRecipientNickname ?? careRecipientNickname}
                </Text>
                <TouchableOpacity
                  style={styles.unpairButton}
                  onPress={() => {
                    setUnpairTarget(p);
                    setUnpairConfirmVisible(true);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="연결 해제해요"
                  testID={`unpair-button-${p.caregiverUserKey}`}
                >
                  <Text style={styles.unpairButtonText}>연결 해제</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* 케어러 폰에서 회차 등록·수정 불가 안내 */}
        {/* Ref: step-08-family.md §처리 5 "케어러 폰에선 회차 등록·수정 불가" */}
        <View style={styles.infoCard}>
          <Text style={styles.infoText}>
            복약 정보는 {careRecipientNickname}의 기기에서만 관리해요
          </Text>
        </View>
      </ScrollView>

      {/* ── 연결 해제 확인 모달 ── */}
      {/* Ref: references/dev-guide/design/ux-writing.md §다이얼로그 왼쪽 "닫기" */}
      <Modal
        visible={unpairConfirmVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setUnpairConfirmVisible(false)}
        testID="unpair-confirm-modal"
      >
        <TouchableWithoutFeedback onPress={() => setUnpairConfirmVisible(false)}>
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback>
              <View style={styles.modalSheet} testID="unpair-confirm-sheet">
                <Text style={styles.modalTitle}>연결을 해제할까요?</Text>
                <Text style={styles.modalBody}>
                  해제하면 복약 알림을 받을 수 없어요
                </Text>
                <View style={styles.modalButtons}>
                  <TouchableOpacity
                    style={[styles.modalButton, styles.modalButtonClose]}
                    onPress={() => setUnpairConfirmVisible(false)}
                    accessibilityRole="button"
                    testID="unpair-cancel-button"
                  >
                    <Text style={styles.modalButtonCloseText}>닫기</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalButton, styles.modalButtonConfirm]}
                    onPress={() => void handleUnpairConfirm()}
                    accessibilityRole="button"
                    testID="unpair-confirm-button"
                  >
                    <Text style={styles.modalButtonConfirmText}>해제해요</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* ── 토스트 ── */}
      {toastMessage !== '' && (
        <View style={styles.toast} pointerEvents="none" testID="toast">
          <Text style={styles.toastText}>{toastMessage}</Text>
        </View>
      )}
    </View>
  );
}

// ─── 스타일 ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8F9FA',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F8F9FA',
  },
  loadingText: {
    fontSize: 16,
    color: '#8B95A1',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    paddingTop: Platform.OS === 'ios' ? 56 : 20,
    paddingBottom: 16,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F2F4F6',
    gap: 12,
  },
  backButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    fontSize: 22,
    color: '#191F28',
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: '#191F28',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    gap: 12,
    paddingBottom: 48,
  },
  // 이벤트 카드
  eventCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    gap: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  eventCardChecked: {
    borderLeftWidth: 4,
    borderLeftColor: '#1ED760',
  },
  eventCardMissed: {
    borderLeftWidth: 4,
    borderLeftColor: '#FF9F40',
  },
  eventNickname: {
    fontSize: 13,
    color: '#8B95A1',
    fontWeight: '500',
  },
  eventLabel: {
    fontSize: 17,
    fontWeight: '600',
    color: '#191F28',
  },
  eventStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  eventStatus: {
    fontSize: 15,
    fontWeight: '600',
  },
  eventStatusChecked: {
    color: '#1ED760',
  },
  eventStatusMissed: {
    color: '#FF9F40',
  },
  eventTime: {
    fontSize: 14,
    color: '#8B95A1',
  },
  // 빈 상태
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: 48,
    gap: 8,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#4E5968',
  },
  emptySubtext: {
    fontSize: 14,
    color: '#8B95A1',
    textAlign: 'center',
  },
  // 페어링 카드
  pairingCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  pairingCardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#191F28',
  },
  pairingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#F2F4F6',
  },
  pairingNickname: {
    fontSize: 15,
    color: '#191F28',
    fontWeight: '500',
  },
  unpairButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#F2F4F6',
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unpairButtonText: {
    fontSize: 13,
    color: '#4E5968',
    fontWeight: '500',
  },
  // 안내 카드
  infoCard: {
    backgroundColor: '#F2F4F6',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  infoText: {
    fontSize: 13,
    color: '#8B95A1',
    textAlign: 'center',
  },
  // 모달
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 28,
    paddingHorizontal: 24,
    paddingBottom: Platform.OS === 'ios' ? 40 : 28,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#191F28',
    marginBottom: 8,
  },
  modalBody: {
    fontSize: 15,
    color: '#6B7684',
    marginBottom: 28,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  modalButton: {
    flex: 1,
    height: 52,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalButtonClose: {
    backgroundColor: '#F2F4F6',
  },
  modalButtonConfirm: {
    backgroundColor: '#FF6B6B',
  },
  modalButtonCloseText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#4E5968',
  },
  modalButtonConfirmText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  // 토스트
  toast: {
    position: 'absolute',
    bottom: 40,
    left: 24,
    right: 24,
    backgroundColor: 'rgba(25,31,40,0.88)',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 20,
    alignItems: 'center',
    zIndex: 20,
  },
  toastText: {
    fontSize: 15,
    color: '#FFFFFF',
    fontWeight: '500',
  },
  // ─── Pull 방식 가족 현황 카드 ─────────────────────────────────────────
  statusCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 18,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  statusCardTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#191F28',
  },
  statusItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#F2F4F6',
  },
  statusItemLeft: {
    flex: 1,
    gap: 4,
  },
  statusItemLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#191F28',
  },
  statusItemTime: {
    fontSize: 13,
    color: '#8B95A1',
  },
  statusBadge: {
    fontSize: 13,
    fontWeight: '600',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    overflow: 'hidden',
  },
  statusBadgeChecked: {
    backgroundColor: '#E8F5E9',
    color: '#1ED760',
  },
  statusBadgeMissed: {
    backgroundColor: '#FFF3E0',
    color: '#FF9F40',
  },
  statusBadgePending: {
    backgroundColor: '#F2F4F6',
    color: '#8B95A1',
  },
  statusUpdatedAt: {
    fontSize: 12,
    color: '#8B95A1',
    textAlign: 'right',
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#4E5968',
    marginTop: 8,
    marginBottom: 4,
  },
});

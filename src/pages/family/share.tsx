/**
 * /family/share — 페어링 코드 생성 화면 (케어 대상 폰)
 *
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-08-family.md §처리 2, 5
 *  - references/sdk/framework/화면이동/routing.md §createRoute, useNavigation
 *  - references/dev-guide/design/consumer-ux-guide.md §다크패턴 5종 방지
 *    "거절 선택지 있음, 강제 팝업 없음, CTA 라벨 명확"
 *  - references/dev-guide/design/ux-writing.md §해요체·능동형·긍정형
 *  - references/sdk/framework/공유/share.md (카카오톡 공유)
 *
 * 다크패턴 체크:
 *  [v] 진입 즉시 전면 바텀시트 없음
 *  [v] 뒤로가기 차단 없음 (onRequestClose 처리)
 *  [v] 거절 선택지 있음 (닫기·연결 해제)
 *  [v] 예상치 못한 광고 없음
 *  [v] CTA 라벨 명확 ("코드 생성하기", "코드 다시 만들기")
 *
 * 2명째 페어링 시도 시점은 8a에선 그냥 허용 — 가족 확장 IAP 게이팅은 8b에서 추가.
 * Ref: step-08-family.md §범위 밖 "8b로"
 */
import { createRoute } from '@granite-js/react-native';
import { share } from '@apps-in-toss/framework';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import {
  generatePairingCode,
  refreshRecipientPairings,
  unpair,
} from '../../services/pairService';
import type { PairingRecord } from '../../types/pair';
import { getNickname } from '../../services/storageService';
import { ensureUserKey, ensureUserKeyWithDetails } from '../../services/authService';

function userKeyFailureMessage(
  result: Awaited<ReturnType<typeof ensureUserKeyWithDetails>>,
): string {
  switch (result.kind) {
    case 'unsupported':
      return '토스 앱이 최신 버전이 아니에요. 업데이트 후 다시 시도해주세요.';
    case 'no_api_url':
      return '서버 주소가 설정되어 있지 않아요. 잠시 후 다시 시도해주세요.';
    case 'login_failed':
      return `토스 로그인에 실패했어요: ${result.reason}`;
    case 'exchange_failed':
      return `서버 인증에 실패했어요 (${result.status}). 잠시 후 다시 시도해주세요.`;
    case 'no_user_key_in_response':
      return '계정 정보를 가져오지 못했어요. 잠시 후 다시 시도해주세요.';
    case 'ok':
      return '';
  }
}

export const Route = createRoute('/family/share', {
  validateParams: (params) => params,
  component: FamilySharePage,
});

// ─── 카운트다운 훅 ──────────────────────────────────────────────────────────

function useCountdown(expiresAt: string | null): string {
  const [remaining, setRemaining] = useState('');

  useEffect(() => {
    if (!expiresAt) {
      setRemaining('');
      return;
    }

    function update() {
      const diff = new Date(expiresAt!).getTime() - Date.now();
      if (diff <= 0) {
        setRemaining('만료됐어요');
        return;
      }
      const totalSecs = Math.floor(diff / 1000);
      const m = Math.floor(totalSecs / 60);
      const s = totalSecs % 60;
      setRemaining(`${m}분 ${String(s).padStart(2, '0')}초 남았어요`);
    }

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  return remaining;
}

// ─── 메인 화면 ────────────────────────────────────────────────────────────────

function FamilySharePage() {
  // 토스 nav 바 사용 — useNavigation 사용 X

  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [pairings, setPairings] = useState<PairingRecord[]>([]);

  // 연결 해제 확인 모달
  const [unpairTarget, setUnpairTarget] = useState<PairingRecord | null>(null);
  const [unpairConfirmVisible, setUnpairConfirmVisible] = useState(false);

  // v1 정책 (B안): 결제는 자식 폰에서. 엄마 폰에선 무제한 코드 생성 허용.
  // Ref: PRD step-08-family.md §처리 7 (B안 — 자식 결제 모델)

  // 토스트
  const [toastMessage, setToastMessage] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const countdown = useCountdown(expiresAt);
  const isExpired = expiresAt !== null && new Date(expiresAt).getTime() <= Date.now();

  useEffect(() => {
    void loadData();
  }, []);

  async function loadData() {
    await ensureUserKey();
    // 진입 시 서버에서 페어링 매핑 fetch (옵션 2 — 데이터 흐름 동기화)
    // Ref: vercel/api/pair/list.ts (GET /api/pair/list)
    const [nick, pairs] = await Promise.all([
      getNickname(),
      refreshRecipientPairings(),
    ]);
    setNickname(nick ?? '');
    setPairings(pairs);
  }

  function showToast(msg: string) {
    setToastMessage(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMessage(''), 2500);
  }

  // ─── 코드 생성 ─────────────────────────────────────────────────────────────

  // Step 8b: 가족 확장 IAP 게이팅 — 2명째부터 결제 필요
  // Ref: PRD step-08-family.md §처리 7
  // Ref: PRD step-08-family.md §검수 IAP ② "1명 무료, 2명째부터 결제"
  const doGenerateCode = useCallback(async () => {
    setIsGenerating(true);
    setErrorMessage('');
    try {
      // 코드 생성 직전에 userKey 보장 — 실패 시 reason별 메시지로 사용자 안내.
      const auth = await ensureUserKeyWithDetails();
      if (auth.kind !== 'ok') {
        setErrorMessage(userKeyFailureMessage(auth));
        return;
      }
      const result = await generatePairingCode();
      setCode(result.code);
      setExpiresAt(result.expiresAt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '알 수 없는 오류';
      setErrorMessage(`코드를 만들지 못했어요: ${msg}`);
    } finally {
      setIsGenerating(false);
    }
  }, []);

  const handleGenerateCode = useCallback(async () => {
    // v1 (B안): 결제는 자식 폰에서. 엄마는 무제한 코드 생성.
    await doGenerateCode();
  }, [doGenerateCode]);

  // ─── 카카오톡 공유 ─────────────────────────────────────────────────────────
  // Ref: references/sdk/framework/공유/share.md

  const handleShare = useCallback(async () => {
    if (!code) return;
    // Ref: references/sdk/framework/공유/share.md §시그니처
    // function share(message: { message: string }): Promise<void>
    // title·description·url 파라미터 없음 — message 단일 필드만 지원
    try {
      await share({
        message: `[엄마약먹자] 가족 연결 코드: ${code.split('').join(' ')}\n5분 내에 입력해요`,
      });
    } catch {
      showToast('공유하기를 이용할 수 없어요');
    }
  }, [code]);

  // ─── 연결 해제 ─────────────────────────────────────────────────────────────

  const handleUnpairConfirm = useCallback(async () => {
    if (!unpairTarget) return;
    setUnpairConfirmVisible(false);

    try {
      await unpair({
        caregiverUserKey: unpairTarget.caregiverUserKey,
        careRecipientUserKey: unpairTarget.careRecipientUserKey,
      });
      showToast('연결을 해제했어요');
      void loadData();
    } catch {
      showToast('연결 해제에 실패했어요');
    }

    setUnpairTarget(null);
  }, [unpairTarget]);

  // ─── 코드 표시 (자리 분리) ─────────────────────────────────────────────────

  function renderCode(c: string) {
    return c.split('').join(' ');
  }

  // ─── 렌더 ────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      {/* ── 헤더 ── */}
      {/* Ref: step-08-family.md §처리 2 "헤더: {별명}의 가족에게 알리기" */}
      <View style={styles.header}>
        {/* 뒤로가기는 토스 nav 바가 제공 — 자체 ← 버튼 제거 (검수 가이드) */}
        <Text style={styles.headerTitle} accessibilityRole="header">
          {nickname ? `${nickname}의 가족에게 알리기` : '가족에게 알리기'}
        </Text>
      </View>

      <View style={styles.content}>
        {/* ── 코드 영역 ── */}
        <View style={styles.codeCard} testID="code-card">
          {code && !isExpired ? (
            <>
              {/* 6자리 코드 표시 */}
              {/* Ref: step-08-family.md §처리 2 "각 자리 띄움" */}
              <Text style={styles.codeText} testID="pairing-code">
                {renderCode(code)}
              </Text>

              {/* 카운트다운 */}
              {/* Ref: step-08-family.md §처리 2 "5분 카운트다운 표시" */}
              <Text style={styles.countdownText} testID="countdown-text">
                {countdown}
              </Text>

              {/* 카카오톡 공유 버튼 */}
              {/* Ref: step-08-family.md §처리 2 "카카오톡으로 공유 버튼" */}
              <TouchableOpacity
                style={styles.shareButton}
                onPress={() => void handleShare()}
                accessibilityRole="button"
                accessibilityLabel="카카오톡으로 공유해요"
                testID="share-button"
              >
                <Text style={styles.shareButtonText}>카카오톡으로 공유해요</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.codeEmptyText}>
                {isExpired ? '코드가 만료됐어요' : '코드를 생성해요'}
              </Text>

              {/* 코드 생성/재생성 버튼 */}
              {/* Ref: step-08-family.md §처리 2 "+ 코드 생성하기" / "코드 다시 만들기" */}
              <TouchableOpacity
                style={[styles.generateButton, isGenerating && styles.generateButtonDisabled]}
                onPress={() => void handleGenerateCode()}
                disabled={isGenerating}
                accessibilityRole="button"
                accessibilityLabel={isExpired ? '코드 다시 만들기' : '코드 생성하기'}
                testID="generate-code-button"
              >
                {isGenerating ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.generateButtonText}>
                    {isExpired ? '코드 다시 만들기' : '+ 코드 생성하기'}
                  </Text>
                )}
              </TouchableOpacity>
            </>
          )}

          {/* 만료 후 재생성 버튼 */}
          {code && isExpired && (
            <TouchableOpacity
              style={[styles.generateButton, isGenerating && styles.generateButtonDisabled]}
              onPress={() => void handleGenerateCode()}
              disabled={isGenerating}
              accessibilityRole="button"
              accessibilityLabel="코드 다시 만들기"
              testID="regenerate-code-button"
            >
              {isGenerating ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.generateButtonText}>코드 다시 만들기</Text>
              )}
            </TouchableOpacity>
          )}

          {errorMessage !== '' && (
            <Text style={styles.errorText} testID="error-text">
              {errorMessage}
            </Text>
          )}
        </View>

        {/* ── 안내 문구 ── */}
        <View style={styles.guideCard}>
          <Text style={styles.guideTitle}>내 복약 상태 알리기</Text>
          <Text style={styles.guideText}>
            {'소중한 가족이 멀리 있어도 안심하고 챙길 수 있어요.\n\n'}
            {'• 여기서 6자리 코드를 만들고 가족에게 카톡으로 공유해요\n'}
            {'• 가족이 자기 앱에서 코드를 입력하면 연결돼요\n'}
            {'• 약을 드실 때마다 가족 앱에 오늘 복약 상태가 표시돼요\n'}
            {'• 회차 추가·수정·체크는 본인 폰에서만 할 수 있어요\n\n'}
            {'가족 1명까지는 무료예요. 2명째부터는 4,900원으로 슬롯을 추가할 수 있어요.\n\n'}
            {'반대로 내가 누군가의 복약을 챙기고 싶다면, 홈에서 👨‍👩‍👧 → "가족 코드 입력하기"로 시작해요.'}
          </Text>
        </View>

        {/* ── 연결된 가족 목록 ── */}
        {/* Ref: step-08-family.md §처리 2 "이미 페어링된 케어러 목록 표시" */}
        <View style={styles.pairingListCard} testID="pairing-list-card">
          <Text style={styles.pairingListTitle} testID="pairing-list-header">
            {`연결된 가족: ${pairings.length}명`}
          </Text>

          {pairings.length === 0 ? (
            <Text style={styles.pairingEmptyText}>아직 연결된 가족이 없어요</Text>
          ) : (
            pairings.map((p, idx) => (
              <View key={p.caregiverUserKey} style={styles.pairingItem} testID={`pairing-item-${p.caregiverUserKey}`}>
                <Text style={styles.pairingNickname}>
                  {/* v1엔 자식 별명을 모름 → "가족 1", "가족 2"로 표기 (옵션 2) */}
                  {`가족 ${idx + 1}`}
                </Text>
                {/* 거절 선택지: 연결 해제 버튼 */}
                {/* Ref: references/dev-guide/design/consumer-ux-guide.md §3 */}
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
            ))
          )}
        </View>
      </View>

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
                  해제하면 가족에게 복약 알림이 가지 않아요
                </Text>
                <View style={styles.modalButtons}>
                  {/* 왼쪽: 닫기 */}
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

      {/* v1 (B안): 결제 진입은 자식 폰(/family/connect)에서. 엄마 폰엔 결제 바텀시트 없음. */}

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
  content: {
    flex: 1,
    padding: 16,
    gap: 16,
  },
  // 코드 카드
  codeCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    gap: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  codeText: {
    fontSize: 42,
    fontWeight: '800',
    color: '#FF6B6B',
    letterSpacing: 4,
    textAlign: 'center',
  },
  countdownText: {
    fontSize: 15,
    color: '#6B7684',
  },
  codeEmptyText: {
    fontSize: 16,
    color: '#8B95A1',
    textAlign: 'center',
    paddingVertical: 8,
  },
  generateButton: {
    backgroundColor: '#FF6B6B',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 32,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  generateButtonDisabled: {
    opacity: 0.6,
  },
  generateButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  shareButton: {
    backgroundColor: '#F8F9FA',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    borderWidth: 1,
    borderColor: '#E5E8EB',
  },
  shareButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#4E5968',
  },
  errorText: {
    fontSize: 13,
    color: '#FF6B6B',
    textAlign: 'center',
  },
  // 안내 카드
  guideCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  guideTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#191F28',
  },
  guideText: {
    fontSize: 14,
    color: '#6B7684',
    lineHeight: 22,
  },
  // 연결된 가족 목록
  pairingListCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  pairingListTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#191F28',
  },
  pairingEmptyText: {
    fontSize: 14,
    color: '#8B95A1',
  },
  pairingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
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
    bottom: 80,
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
});

/**
 * 환불 불가 고지 바텀시트 컴포넌트 — Step 8b
 *
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-08-family.md §처리 8
 *    "결제 바텀시트에 '결제 후 환불이 불가합니다' 문구 + 체크박스 필수"
 *  - references/dev-guide/design/consumer-ux-guide.md §다크패턴 방지
 *    §1: 진입 즉시 전면 바텀시트 금지 → 사용자 명시적 탭 후 표시
 *    §2: 뒤로가기 차단 없음 (onRequestClose 처리)
 *    §3: 거절 선택지 있음 ("닫기" 버튼 왼쪽 배치)
 *    §5: CTA 라벨 명확 ("결제하기" → 다음 행동 예측 가능)
 *  - references/dev-guide/design/ux-writing.md §해요체·능동형·긍정형·다이얼로그 왼쪽 "닫기"
 *
 * 다크패턴 체크:
 *  [v] 진입 즉시 표시 안 함 (명시적 사용자 탭으로만 열림)
 *  [v] 뒤로가기 → 닫힘 (onRequestClose → onClose)
 *  [v] 닫기 버튼 왼쪽 배치 (UX 라이팅 규칙 준수)
 *  [v] 결제 버튼 동의 체크박스 미동의 시 비활성화 (회색)
 *  [v] 예상치 못한 광고 없음
 *  [v] CTA "결제하기" — 다음 행동(결제 진행) 명확
 */

import React, { useState } from 'react';
import {
  Linking,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import type { IapSku } from '../services/iapService';

// ─── Props ───────────────────────────────────────────────────────────────────

export type RefundNoticeBottomSheetProps = {
  /** 결제 대상 SKU */
  sku: IapSku;
  /** 화면에 표시할 상품명 */
  productName: string;
  /** 가격 (원 단위 숫자) */
  price: number;
  /** 동의 후 결제 버튼 탭 콜백 */
  onConfirm: () => void;
  /** 닫기 버튼 또는 외부 탭 콜백 */
  onClose: () => void;
  /** 바텀시트 표시 여부 */
  visible: boolean;
};

// ─── 컴포넌트 ────────────────────────────────────────────────────────────────

export function RefundNoticeBottomSheet({
  sku,
  productName,
  price,
  onConfirm,
  onClose,
  visible,
}: RefundNoticeBottomSheetProps) {
  // 환불 불가 동의 체크박스 상태
  // Ref: PRD step-08-family.md §처리 8 "체크박스 필수 체크 후 결제 버튼 활성화"
  const [agreed, setAgreed] = useState(false);

  // 결제 유형 분기 — 구독(광고제거) vs 일회성(가족 슬롯)
  // Ref: PRD step-08-family.md §처리 6 (구독) / §처리 7 (슬롯)
  const isSubscription = sku === 'remove_ads_lifetime_v1';

  const noticeMainText = isSubscription
    ? '월 자동 갱신 구독이에요.\n다음 갱신일까지 이용할 수 있고, 토스 결제 관리에서 언제든 해지할 수 있어요.'
    : '결제 후 환불이 불가합니다 (디지털 재화 즉시 사용 기준).\n슬롯은 영구 유지돼요. 연결을 해제해도 슬롯은 그대로예요.';

  const refundAnchor = isSubscription
    ? 'https://mkjjo-mini.github.io/eomma-yak-meokja/terms.html#refund-subscription'
    : 'https://mkjjo-mini.github.io/eomma-yak-meokja/terms.html#refund-onetime';

  const checkboxText = isSubscription
    ? '자동 갱신과 해지 방법을 확인했어요'
    : '위 내용에 동의해요';

  const ctaText = isSubscription ? '구독하기' : '결제하기';
  const ctaPendingLabel = isSubscription ? '확인 후 구독하기' : '동의 후 결제하기';

  // 바텀시트가 닫힐 때 체크박스 초기화
  function handleClose() {
    setAgreed(false);
    onClose();
  }

  function handleConfirm() {
    if (!agreed) return; // 미동의 시 결제 차단
    setAgreed(false);
    onConfirm();
  }

  const formattedPrice = price.toLocaleString('ko-KR');

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      // Ref: consumer-ux-guide.md §2 뒤로가기 차단 없음 — onRequestClose로 닫힘
      onRequestClose={handleClose}
      testID="refund-notice-modal"
    >
      {/* 외부 탭 → 닫힘 (거절 선택지 제공) */}
      {/* Ref: consumer-ux-guide.md §3 탈출구 필수 */}
      <TouchableWithoutFeedback onPress={handleClose} testID="refund-notice-backdrop">
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View style={styles.sheet} testID="refund-notice-sheet">
              {/* ── 상품 정보 ── */}
              <View style={styles.productSection}>
                <Text style={styles.productName} testID="refund-product-name">
                  {productName}
                </Text>
                <Text style={styles.productPrice} testID="refund-product-price">
                  {`${formattedPrice}원`}
                </Text>
              </View>

              <View style={styles.divider} />

              {/* ── 결제 유형별 고지 문구 ── */}
              {/* Ref: PRD step-08-family.md §처리 8 (구독·일회성 분기) */}
              <View style={styles.noticeSection} testID="refund-notice-text-section">
                <Text style={styles.noticeText} testID="refund-notice-main">
                  {noticeMainText}
                </Text>
                {/* 이용약관·환불 정책 링크 */}
                {/* Ref: references/dev-guide/design/consumer-ux-guide.md §외부 링크 허용 예외 */}
                <Text style={styles.noticeSubText}>
                  자세한 내용은{' '}
                  <Text
                    style={styles.noticeLink}
                    onPress={() => void Linking.openURL('https://mkjjo-mini.github.io/eomma-yak-meokja/terms.html')}
                    accessibilityRole="link"
                    testID="refund-terms-link"
                  >
                    이용약관
                  </Text>
                  {' 및 '}
                  <Text
                    style={styles.noticeLink}
                    onPress={() => void Linking.openURL(refundAnchor)}
                    accessibilityRole="link"
                    testID="refund-policy-link"
                  >
                    환불 정책
                  </Text>
                  을 참고해요
                </Text>
              </View>

              {/* ── 동의 체크박스 ── */}
              {/* Ref: PRD step-08-family.md §처리 8 "체크박스 '위 내용에 동의합니다' 필수" */}
              {/* Ref: consumer-ux-guide.md §3 사용자에게 선택권 부여 */}
              <TouchableOpacity
                style={styles.checkboxRow}
                onPress={() => setAgreed((prev) => !prev)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: agreed }}
                accessibilityLabel={checkboxText}
                testID="refund-agree-checkbox"
              >
                <View
                  style={[styles.checkbox, agreed && styles.checkboxChecked]}
                  testID="refund-checkbox-indicator"
                >
                  {agreed && (
                    <Text style={styles.checkboxMark}>✓</Text>
                  )}
                </View>
                <Text style={styles.checkboxLabel}>{checkboxText}</Text>
              </TouchableOpacity>

              {/* ── 버튼 영역 ── */}
              {/* Ref: references/dev-guide/design/ux-writing.md §다이얼로그 왼쪽 "닫기" */}
              <View style={styles.buttonRow}>
                {/* 왼쪽: 닫기 (거절 선택지) */}
                {/* Ref: consumer-ux-guide.md §3 탈출구 필수 — 닫기 왼쪽 배치 */}
                <TouchableOpacity
                  style={[styles.button, styles.buttonClose]}
                  onPress={handleClose}
                  accessibilityRole="button"
                  accessibilityLabel="닫기"
                  testID="refund-close-button"
                >
                  <Text style={styles.buttonCloseText}>닫기</Text>
                </TouchableOpacity>

                {/* 오른쪽: 결제하기 (동의 체크 시 활성화) */}
                {/* Ref: consumer-ux-guide.md §5 CTA 라벨 다음 행동 명확 */}
                <TouchableOpacity
                  style={[
                    styles.button,
                    styles.buttonConfirm,
                    !agreed && styles.buttonConfirmDisabled,
                  ]}
                  onPress={handleConfirm}
                  disabled={!agreed}
                  accessibilityRole="button"
                  accessibilityLabel={agreed ? ctaText : ctaPendingLabel}
                  accessibilityState={{ disabled: !agreed }}
                  testID="refund-confirm-button"
                >
                  <Text
                    style={[
                      styles.buttonConfirmText,
                      !agreed && styles.buttonConfirmTextDisabled,
                    ]}
                  >
                    {ctaText}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

// ─── 스타일 ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 28,
    paddingHorizontal: 24,
    paddingBottom: Platform.OS === 'ios' ? 44 : 28,
    gap: 0,
  },
  // 상품 정보
  productSection: {
    alignItems: 'center',
    paddingBottom: 20,
    gap: 6,
  },
  productName: {
    fontSize: 18,
    fontWeight: '700',
    color: '#191F28',
    textAlign: 'center',
  },
  productPrice: {
    fontSize: 24,
    fontWeight: '800',
    color: '#FF6B6B',
    textAlign: 'center',
  },
  divider: {
    height: 1,
    backgroundColor: '#F2F4F6',
    marginBottom: 20,
  },
  // 환불 불가 고지
  noticeSection: {
    backgroundColor: '#F8F9FA',
    borderRadius: 10,
    padding: 16,
    marginBottom: 20,
    gap: 8,
  },
  noticeText: {
    fontSize: 14,
    color: '#4E5968',
    lineHeight: 22,
  },
  noticeSubText: {
    fontSize: 12,
    color: '#8B95A1',
    lineHeight: 18,
  },
  noticeLink: {
    fontSize: 12,
    color: '#3182F6',
    fontWeight: '500',
    textDecorationLine: 'underline',
  },
  // 체크박스
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    marginBottom: 20,
    minHeight: 44,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#D1D6DB',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: '#FF6B6B',
    borderColor: '#FF6B6B',
  },
  checkboxMark: {
    fontSize: 13,
    color: '#FFFFFF',
    fontWeight: '700',
    lineHeight: 16,
  },
  checkboxLabel: {
    fontSize: 15,
    color: '#191F28',
    fontWeight: '500',
    flex: 1,
  },
  // 버튼
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  button: {
    flex: 1,
    height: 52,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  buttonClose: {
    backgroundColor: '#F2F4F6',
  },
  buttonCloseText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#4E5968',
  },
  buttonConfirm: {
    backgroundColor: '#FF6B6B',
  },
  buttonConfirmDisabled: {
    backgroundColor: '#D1D6DB', // 미동의 시 회색 — 다크패턴 아님 (정상 UX)
  },
  buttonConfirmText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  buttonConfirmTextDisabled: {
    color: '#8B95A1',
  },
});

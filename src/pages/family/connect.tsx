/**
 * /family/connect — 케어러 폰: 6자리 코드 입력 화면
 *
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-08-family.md §처리 2, 5
 *  - references/sdk/framework/로그인/appLogin.md §예제
 *    "케어러는 8a에서 첫 진입 시 appLogin 호출 후 userKey 저장"
 *  - references/sdk/framework/환경확인/isMinVersionSupported.md
 *  - references/dev-guide/design/consumer-ux-guide.md §다크패턴 5종 방지
 *  - references/dev-guide/design/ux-writing.md §해요체·능동형·긍정형
 *
 * appLogin 흐름:
 *  - 진입 시 Storage.user.key 확인 → 없으면 ensureUserKey() 호출
 *  - appLogin 실패 시에도 화면 유지 (강제 로그인 팝업 없음 — 다크패턴 방지)
 * Ref: references/dev-guide/design/consumer-ux-guide.md §강제 로그인 금지
 */
import { createRoute, useNavigation } from '@granite-js/react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { confirmPairing, getPairings } from '../../services/pairService';
import { ensureUserKey } from '../../services/authService';
import {
  getFamilySlots,
  purchaseFamilyExpansion,
} from '../../services/iapService';
import { RefundNoticeBottomSheet } from '../../components/RefundNoticeBottomSheet';

export const Route = createRoute('/family/connect', {
  validateParams: (params) => params,
  component: FamilyConnectPage,
});

// 코드 자릿수
const CODE_LENGTH = 6;

function FamilyConnectPage() {
  const navigation = useNavigation();

  const [code, setCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [isEnsuring, setIsEnsuring] = useState(false);
  const inputRef = useRef<TextInput>(null);

  // v1 (B안): 자식 폰에 슬롯 카운트 — "내가 케어할 수 있는 부모 수"
  // 1명 무료 + 결제마다 1명 추가. 한도 도달 시 코드 입력 후 결제 바텀시트.
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [slotSheetVisible, setSlotSheetVisible] = useState(false);

  // 케어러 폰 첫 진입 시 userKey 확보
  // Ref: step-08-family.md §처리 1 "케어러 폰: 미니앱 첫 진입 시 appLogin 호출"
  // Ref: references/sdk/framework/로그인/appLogin.md
  useEffect(() => {
    void ensureLogin();
  }, []);

  async function ensureLogin() {
    setIsEnsuring(true);
    try {
      await ensureUserKey();
    } catch {
      // 로그인 실패해도 화면 유지 — 강제 로그인 팝업 없음 (다크패턴 방지)
      // Ref: references/dev-guide/design/consumer-ux-guide.md §1
    } finally {
      setIsEnsuring(false);
    }
  }

  // ─── 코드 입력 처리 ─────────────────────────────────────────────────────────

  const handleCodeChange = useCallback((text: string) => {
    // 숫자만 허용
    const numeric = text.replace(/[^0-9]/g, '').slice(0, CODE_LENGTH);
    setCode(numeric);
    setErrorMessage('');

    // 6자리 완성 시 자동 확인
    if (numeric.length === CODE_LENGTH) {
      void handleConfirm(numeric);
    }
  }, []);

  // ─── 페어링 확정 ───────────────────────────────────────────────────────────

  // 슬롯 한도를 통과한 후 실제 페어링 진행
  const doConfirm = useCallback(async (codeValue: string) => {
    const trimmed = codeValue.trim();
    if (trimmed.length !== CODE_LENGTH) {
      setErrorMessage('6자리 코드를 입력해요');
      return;
    }

    setIsLoading(true);
    setErrorMessage('');

    try {
      const result = await confirmPairing(trimmed);

      if (result.success) {
        navigation.navigate('/family/dashboard', {
          justPaired: true,
          careRecipientNickname: result.careRecipientNickname ?? '',
        });
      } else {
        if (result.error === 'invalid_code') {
          setErrorMessage('코드가 올바르지 않아요');
        } else {
          setErrorMessage('연결에 실패했어요. 다시 시도해요');
        }
        setCode('');
        inputRef.current?.focus();
      }
    } catch {
      setErrorMessage('연결에 실패했어요. 다시 시도해요');
      setCode('');
    } finally {
      setIsLoading(false);
    }
  }, [navigation]);

  // v1 (B안) 게이팅: 자식 폰의 활성 페어링 수가 슬롯 한도에 도달하면 결제 바텀시트.
  // 결제 성공 시 doConfirm 진행. 결제 취소 시 페어링 중단 (이미 입력한 코드는 유지 시도 X).
  const handleConfirm = useCallback(async (codeValue: string) => {
    const trimmed = codeValue.trim();
    if (trimmed.length !== CODE_LENGTH) {
      setErrorMessage('6자리 코드를 입력해요');
      return;
    }

    setIsLoading(true);
    try {
      const [pairs, slots] = await Promise.all([getPairings(), getFamilySlots()]);
      if (pairs.length >= slots) {
        // 한도 도달 → 결제 진입 (자식 폰)
        setPendingCode(trimmed);
        setSlotSheetVisible(true);
        setIsLoading(false);
        return;
      }
    } catch {
      // 슬롯 조회 실패해도 페어링은 시도 (안전한 fallback)
    } finally {
      // setIsLoading은 doConfirm/슬롯 분기에서 명시적 관리
    }

    await doConfirm(trimmed);
  }, [doConfirm]);

  // 가족 슬롯 추가 결제 완료 후 페어링 진행
  const handleSlotPurchase = useCallback(async () => {
    setSlotSheetVisible(false);
    const target = pendingCode;
    setPendingCode(null);

    try {
      const result = await purchaseFamilyExpansion();
      if (result.kind === 'success') {
        if (target) await doConfirm(target);
      } else if (result.kind === 'cancelled') {
        // 사용자 취소 — 페어링 중단, 입력 초기화
        setCode('');
        setErrorMessage('');
      } else {
        const msg =
          result.reason === 'unsupported_version'
            ? '토스 앱을 최신 버전으로 업데이트해야 이용할 수 있어요'
            : '결제에 실패했어요. 다시 시도해 주세요';
        setErrorMessage(msg);
        setCode('');
      }
    } catch {
      setErrorMessage('결제에 실패했어요. 다시 시도해 주세요');
      setCode('');
    }
  }, [pendingCode, doConfirm]);

  // ─── 코드 박스 렌더 ────────────────────────────────────────────────────────

  function renderCodeBoxes() {
    return (
      <View style={styles.codeBoxRow} testID="code-box-row">
        {Array.from({ length: CODE_LENGTH }).map((_, i) => {
          const char = code[i] ?? '';
          const isFocused = i === code.length && !isLoading;
          return (
            <View
              key={i}
              style={[
                styles.codeBox,
                isFocused && styles.codeBoxFocused,
                errorMessage !== '' && styles.codeBoxError,
              ]}
              testID={`code-box-${i}`}
            >
              <Text style={styles.codeBoxText}>{char}</Text>
            </View>
          );
        })}
      </View>
    );
  }

  // ─── 렌더 ────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      {/* ── 헤더 ── */}
      {/* Ref: step-08-family.md §처리 2 "헤더: '가족 연결하기'" */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => {
            if (navigation.canGoBack()) navigation.goBack();
          }}
          accessibilityRole="button"
          accessibilityLabel="뒤로 가기"
          testID="back-button"
        >
          <Text style={styles.backButtonText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} accessibilityRole="header">
          가족 연결하기
        </Text>
      </View>

      <View style={styles.content}>
        {isEnsuring && (
          <View style={styles.ensuringRow}>
            <ActivityIndicator size="small" color="#FF6B6B" />
            <Text style={styles.ensuringText}>로그인 중이에요...</Text>
          </View>
        )}

        {/* ── 상세 안내 카드 ── */}
        <View style={styles.guideCard}>
          <Text style={styles.guideTitle}>소중한 사람 복약 챙기기</Text>
          <Text style={styles.guideCardBody}>
            {'멀리 있어도 매일 약 챙기시는지 확인할 수 있어요.\n\n'}
            {'• 가족 앱에서 만든 6자리 코드를 받아 아래에 입력해요\n'}
            {'• 가족의 오늘 복약 상태가 내 앱 홈 화면에 표시돼요\n'}
            {'• 회차 추가·수정·체크는 가족 본인 폰에서만 할 수 있어요\n\n'}
            {'가족 1명까지는 무료예요. 2명째부터는 4,900원으로 슬롯을 추가할 수 있어요.'}
          </Text>
        </View>

        <Text style={styles.guideText}>
          {'가족이 보내준 6자리 코드를 입력해요'}
        </Text>

        {/* ── 코드 입력 박스 6개 ── */}
        {/* Ref: step-08-family.md §처리 2 "한 자리씩 분리된 박스 6개" */}
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => inputRef.current?.focus()}
          accessibilityRole="none"
        >
          {renderCodeBoxes()}
        </TouchableOpacity>

        {/* 숨겨진 TextInput (실제 입력 처리) */}
        <TextInput
          ref={inputRef}
          style={styles.hiddenInput}
          value={code}
          onChangeText={handleCodeChange}
          keyboardType="number-pad"
          maxLength={CODE_LENGTH}
          editable={!isLoading}
          autoFocus
          testID="code-input"
        />

        {/* ── 인라인 에러 ── */}
        {errorMessage !== '' && (
          <Text style={styles.errorText} testID="error-text">
            {errorMessage}
          </Text>
        )}

        {/* ── 로딩 ── */}
        {isLoading && (
          <View style={styles.loadingRow} testID="loading-indicator">
            <ActivityIndicator color="#FF6B6B" />
            <Text style={styles.loadingText}>연결 중이에요...</Text>
          </View>
        )}

        {/* ── 확인 버튼 (수동 제출용) ── */}
        <TouchableOpacity
          style={[
            styles.confirmButton,
            (code.length < CODE_LENGTH || isLoading) && styles.confirmButtonDisabled,
          ]}
          onPress={() => void handleConfirm(code)}
          disabled={code.length < CODE_LENGTH || isLoading}
          accessibilityRole="button"
          accessibilityLabel="코드 확인해요"
          testID="confirm-button"
        >
          <Text style={styles.confirmButtonText}>확인해요</Text>
        </TouchableOpacity>
      </View>

      {/* v1 (B안): 자식 폰 슬롯 한도 초과 시 결제 바텀시트 (가족 슬롯 IAP) */}
      {/* Ref: PRD step-08-family.md §처리 7 — 결제 위치: 자식 폰 */}
      <RefundNoticeBottomSheet
        visible={slotSheetVisible}
        sku="family_expansion_lifetime_v1"
        productName="가족 슬롯 추가"
        price={4900}
        onConfirm={handleSlotPurchase}
        onClose={() => {
          setSlotSheetVisible(false);
          setPendingCode(null);
        }}
      />
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
    padding: 24,
    alignItems: 'center',
    gap: 24,
  },
  ensuringRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  ensuringText: {
    fontSize: 14,
    color: '#8B95A1',
  },
  guideText: {
    fontSize: 16,
    color: '#4E5968',
    textAlign: 'center',
    lineHeight: 24,
  },
  // 상세 안내 카드
  guideCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    gap: 10,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  guideTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#191F28',
  },
  guideCardBody: {
    fontSize: 14,
    color: '#6B7684',
    lineHeight: 22,
  },
  // 코드 박스
  codeBoxRow: {
    flexDirection: 'row',
    gap: 10,
  },
  codeBox: {
    width: 44,
    height: 56,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#E5E8EB',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeBoxFocused: {
    borderColor: '#FF6B6B',
  },
  codeBoxError: {
    borderColor: '#FF6B6B',
    backgroundColor: '#FFF5F5',
  },
  codeBoxText: {
    fontSize: 24,
    fontWeight: '700',
    color: '#191F28',
  },
  hiddenInput: {
    position: 'absolute',
    opacity: 0,
    width: 1,
    height: 1,
  },
  // 에러
  errorText: {
    fontSize: 14,
    color: '#FF6B6B',
    textAlign: 'center',
  },
  // 로딩
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  loadingText: {
    fontSize: 15,
    color: '#8B95A1',
  },
  // 확인 버튼
  confirmButton: {
    backgroundColor: '#FF6B6B',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    minHeight: 52,
  },
  confirmButtonDisabled: {
    opacity: 0.4,
  },
  confirmButtonText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});

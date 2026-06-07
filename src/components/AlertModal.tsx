/**
 * AlertModal — RN Alert.alert 대체용 커스텀 다이얼로그.
 *
 * Ref: 비게임 출시 가이드 §서비스 이용 동작 — "사용자 안내나 확인이 필요한 경우 TDS 모달을 사용"
 * Ref: references/dev-guide/design/ux-writing.md §다이얼로그 왼쪽 "닫기"
 *
 * Alert.alert는 OS 네이티브 다이얼로그라 디자인 통제·접근성 보장이 어려움.
 * 미니앱 자체 Modal로 통일해 UX 라이팅 규칙(해요체, 왼쪽 닫기) 준수.
 */
import React from 'react';
import {
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';

export type AlertButtonStyle = 'default' | 'cancel' | 'destructive';

export type AlertButton = {
  label: string;
  onPress?: () => void;
  style?: AlertButtonStyle;
};

export type AlertModalProps = {
  visible: boolean;
  title: string;
  message?: string;
  buttons: AlertButton[];
  /** 외부 탭 / 시스템 뒤로가기 시 호출 — 보통 가장 가까운 닫기 버튼과 동일 동작 */
  onRequestClose: () => void;
  testID?: string;
};

export function AlertModal({
  visible,
  title,
  message,
  buttons,
  onRequestClose,
  testID = 'alert-modal',
}: AlertModalProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onRequestClose}
      testID={testID}
    >
      <TouchableWithoutFeedback onPress={onRequestClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View style={styles.sheet} testID={`${testID}-sheet`}>
              <Text style={styles.title}>{title}</Text>
              {message ? <Text style={styles.message}>{message}</Text> : null}
              <View style={styles.buttonsRow}>
                {buttons.map((btn, idx) => (
                  <TouchableOpacity
                    key={`${btn.label}-${idx}`}
                    style={[
                      styles.button,
                      btn.style === 'cancel' && styles.buttonCancel,
                      btn.style === 'destructive' && styles.buttonDestructive,
                      (!btn.style || btn.style === 'default') && styles.buttonDefault,
                    ]}
                    onPress={() => {
                      btn.onPress?.();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={btn.label}
                    testID={`${testID}-btn-${idx}`}
                  >
                    <Text
                      style={[
                        styles.buttonText,
                        btn.style === 'cancel' && styles.buttonTextCancel,
                        btn.style === 'destructive' && styles.buttonTextDestructive,
                      ]}
                    >
                      {btn.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  sheet: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingVertical: 24,
    paddingHorizontal: 20,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 6,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: '#191F28',
    textAlign: 'center',
  },
  message: {
    fontSize: 14,
    color: '#4E5968',
    lineHeight: 22,
    textAlign: 'center',
  },
  buttonsRow: {
    flexDirection: 'column',
    gap: 8,
    marginTop: 8,
  },
  button: {
    minHeight: Platform.OS === 'ios' ? 48 : 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonDefault: {
    backgroundColor: '#FF6B6B',
  },
  buttonCancel: {
    backgroundColor: '#F2F4F6',
  },
  buttonDestructive: {
    backgroundColor: '#FFE5E5',
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  buttonTextCancel: {
    color: '#4E5968',
  },
  buttonTextDestructive: {
    color: '#FF6B6B',
  },
});

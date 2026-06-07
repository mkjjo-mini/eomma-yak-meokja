/**
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-02-registration.md §입력·처리·출력·행동
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-04-notification.md §처리 1-2
 *    "회차 등록 완료 직후 appLogin + 스케줄 Vercel 동기화"
 *  - references/sdk/framework/저장소/Storage.md (Storage.setItem, 로컬 only)
 *  - references/sdk/framework/카메라/openCamera.md (base64, OpenCameraPermissionError)
 *  - references/sdk/framework/사진/fetchAlbumPhotos.md (FetchAlbumPhotosPermissionError)
 *  - references/sdk/framework/환경확인/isMinVersionSupported.md (버전 fallback)
 *  - references/dev-guide/design/ux-writing.md (해요체, 능동형, 긍정형, 다이얼로그 왼쪽 "닫기")
 *  - references/dev-guide/design/consumer-ux-guide.md (다크패턴 방지: 뒤로가기 차단 없음)
 *
 * 관계 중립화 원칙:
 *  - 고정 카피에 "엄마" 금지. 별명 변수({nickname})로만 표시.
 *  - 시간대 자동 분류 아이콘(아침·점심·저녁·취침) UI 미노출.
 *
 * 네트워크(Vercel 스케줄): 로컬 저장 후 백그라운드 동기화. 실패 시 재시도 큐.
 */
import { createRoute, useNavigation, useBackEvent } from '@granite-js/react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Image,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import {
  generateRoutineId,
  generateMedId,
  getNickname,
  getRoutines,
  saveRoutine,
  updateRoutine,
  validateLabel,
  validateTime,
  validateWeekdays,
} from '../../services/storageService';
import {
  loadAd,
  showAd,
  REWARDED_AD_GROUP_ID,
} from '../../services/fullScreenAdService';
import { isAdRemovedActive } from '../../services/iapService';
import { isCameraSupported, takePhoto, pickFromAlbum } from '../../services/cameraService';
import { ensureUserKey } from '../../services/authService';
import { upsertSchedule } from '../../services/scheduleService';
import {
  COLOR_PALETTE,
  DEFAULT_COLOR,
  DEFAULT_ICON_EMOJI,
  ICON_EMOJI,
  ICON_TYPE_LABELS,
  WEEKDAY_LABELS,
  type DoseRoutine,
  type MedicationItem,
} from '../../types/routine';

export const Route = createRoute('/routines/add', {
  // 선택 파라미터: routineId가 있으면 수정 모드, 없으면 신규 등록 모드.
  // 타입은 useParams 측에서 좁힌다 (다른 string-only navigate 호출 호환 유지).
  validateParams: (params) => params,
  component: RoutineAddPage,
});

// ─── 타입 ───────────────────────────────────────────────────────────────────

type FormErrors = {
  label?: string;
  time?: string;
  weekdays?: string;
  medications?: string;
};

// ─── 메인 화면 ────────────────────────────────────────────────────────────────

function RoutineAddPage() {
  const navigation = useNavigation();
  // routineId가 있으면 수정 모드 — 기존 회차를 로드해 폼에 미리 채움.
  const params = Route.useParams() as { routineId?: string } | undefined;
  const editRoutineId = params?.routineId;
  const isEditMode = typeof editRoutineId === 'string' && editRoutineId.length > 0;

  // 별명 (온보딩에서 저장된 값)
  const [nickname, setNickname] = useState('');

  // 필수 필드
  const [label, setLabel] = useState('');
  const [time, setTime] = useState('');
  const [mealTiming, setMealTiming] = useState<'before' | 'after' | null>(null);
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('daily');
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>([]);

  // 선택 필드
  const [photoDataUri, setPhotoDataUri] = useState<string | null>(null);
  const [medications, setMedications] = useState<MedicationItem[]>([]);

  // UI 상태
  const [isAccordionOpen, setIsAccordionOpen] = useState(false);
  // 약 단위 색상·종류 바텀시트: 어느 행을 편집 중인지 (null = 닫힘)
  const [pickerOpenIndex, setPickerOpenIndex] = useState<number | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [showExitConfirm, setShowExitConfirm] = useState(false);

  // 보상형 광고: 화면 마운트 시 미리 로드, 구독자(광고제거) 또는 미지원 환경은 자동 스킵.
  // Ref: references/sdk/framework/광고/IntegratedAd.md §광고 로드 타이밍
  const [isRewardAdLoaded, setIsRewardAdLoaded] = useState(false);
  const [isAdRemoved, setIsAdRemovedState] = useState(false);
  const [isWatchingAd, setIsWatchingAd] = useState(false);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── 초기 로드 ────────────────────────────────────────────────────────────

  useEffect(() => {
    loadNickname();
  }, []);

  // 광고 제거 구독자 여부 + 보상형 광고 미리 로드
  // 구독자면 광고 자체를 띄우지 않음 (구독 가치 보호)
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void (async () => {
      const removed = await isAdRemovedActive();
      setIsAdRemovedState(removed);
      if (removed) return; // 구독자: 광고 미리 로드도 안 함
      const result = loadAd(
        REWARDED_AD_GROUP_ID,
        () => setIsRewardAdLoaded(true),
        (err) => console.warn('[add] 보상형 광고 로드 실패', err),
      );
      if (result.kind === 'loaded') {
        cleanup = result.cleanup;
      }
    })();
    return () => cleanup?.();
  }, []);

  // 수정 모드: 기존 회차를 폼에 prefill.
  useEffect(() => {
    if (!isEditMode || !editRoutineId) return;
    void (async () => {
      const routines = await getRoutines();
      const found = routines.find((r) => r.id === editRoutineId);
      if (!found) return;
      setLabel(found.label);
      setTime(found.time);
      setMealTiming(found.mealTiming ?? null);
      setFrequency(found.frequency);
      setSelectedWeekdays(found.weekdays ?? []);
      setPhotoDataUri(found.photoBase64 ?? null);
      setMedications(found.medications ?? []);
      // 선택 영역에 기존 데이터 있으면 펼친 상태로 시작
      const hasOptional =
        !!found.photoBase64 || (found.medications?.length ?? 0) > 0;
      if (hasOptional) setIsAccordionOpen(true);
    })();
  }, [isEditMode, editRoutineId]);

  async function loadNickname() {
    const saved = await getNickname();
    if (saved) setNickname(saved);
  }

  // ─── 토스트 ──────────────────────────────────────────────────────────────

  function showToast(message: string) {
    setToastMessage(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMessage(''), 2500);
  }

  // ─── 입력값 존재 여부 (뒤로가기 확인 판단용) ─────────────────────────────

  const hasInput = useCallback(() => {
    return (
      label.trim().length > 0 ||
      time.trim().length > 0 ||
      frequency === 'weekly' ||
      selectedWeekdays.length > 0 ||
      photoDataUri !== null ||
      medications.length > 0
    );
  }, [label, time, frequency, selectedWeekdays, photoDataUri, medications]);

  // ─── 뒤로가기 (다크패턴 금지: 차단 아닌 확인만) ─────────────────────────

  // Ref: references/dev-guide/design/consumer-ux-guide.md §뒤로가기
  // Ref: 비게임 출시 가이드 §내비게이션 바 — 토스 nav 바 뒤로가기 사용. 자체 ← 버튼 제거.
  // 토스 nav 바 백 누를 때도 미저장 데이터 보호되도록 useBackEvent로 wire.
  const backEvent = useBackEvent();
  function handleBackPress() {
    if (hasInput()) {
      setShowExitConfirm(true);
    } else {
      doGoBack();
    }
  }
  useEffect(() => {
    backEvent.addEventListener(handleBackPress);
    return () => backEvent.removeEventListener(handleBackPress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasInput, doGoBack]);

  function doGoBack() {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('/');
    }
  }

  // ─── 레이블 ──────────────────────────────────────────────────────────────

  function handleLabelChange(text: string) {
    if (text.length > 15) return;
    setLabel(text);
    if (errors.label) setErrors((e) => ({ ...e, label: undefined }));
  }

  // ─── 시간 ────────────────────────────────────────────────────────────────

  function handleTimeChange(text: string) {
    // 숫자와 ':' 만 허용, 자동 ':' 삽입
    const digits = text.replace(/[^0-9]/g, '');
    let formatted = digits;
    if (digits.length > 2) {
      formatted = digits.slice(0, 2) + ':' + digits.slice(2, 4);
    }
    setTime(formatted);
    if (errors.time) setErrors((e) => ({ ...e, time: undefined }));
  }

  // ─── 주기 ────────────────────────────────────────────────────────────────

  function handleFrequencySelect(value: 'daily' | 'weekly') {
    setFrequency(value);
    if (value === 'daily') setSelectedWeekdays([]);
    if (errors.weekdays) setErrors((e) => ({ ...e, weekdays: undefined }));
  }

  function handleWeekdayToggle(day: number) {
    setSelectedWeekdays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    );
    if (errors.weekdays) setErrors((e) => ({ ...e, weekdays: undefined }));
  }

  // ─── 사진 ────────────────────────────────────────────────────────────────

  // Ref: references/sdk/framework/카메라/openCamera.md
  // Ref: references/sdk/framework/사진/fetchAlbumPhotos.md
  function handlePhotoAreaPress() {
    if (!isCameraSupported()) {
      // isMinVersionSupported false → 대체 UI 안내
      Alert.alert(
        '카메라를 사용할 수 없어요',
        '토스 앱을 최신 버전으로 업데이트하면 사진을 추가할 수 있어요.',
        [{ text: '닫기' }],
      );
      return;
    }
    // Ref: references/dev-guide/design/ux-writing.md §다이얼로그 왼쪽 "닫기"
    Alert.alert('사진 추가', '사진을 어떻게 추가할까요?', [
      { text: '닫기', style: 'cancel' },
      { text: '카메라로 촬영해요', onPress: handleTakePhoto },
      { text: '갤러리에서 선택해요', onPress: handlePickAlbum },
    ]);
  }

  async function handleTakePhoto() {
    const result = await takePhoto();
    if (result.type === 'success') {
      setPhotoDataUri(result.dataUri);
    } else if (result.type === 'permission_denied') {
      // Ref: step-02 §처리6 "카메라 권한 거부 시 fetchAlbumPhotos fallback"
      showToast('카메라 권한이 없어서 갤러리로 이동해요');
      await handlePickAlbum();
    } else if (result.type === 'unsupported') {
      showToast('토스 앱을 업데이트하면 카메라를 사용할 수 있어요');
    } else if (result.type === 'error') {
      showToast('사진을 가져오지 못했어요');
    }
    // cancelled: 아무것도 하지 않음
  }

  async function handlePickAlbum() {
    const result = await pickFromAlbum();
    if (result.type === 'success') {
      setPhotoDataUri(result.dataUri);
    } else if (result.type === 'permission_denied') {
      showToast('갤러리 접근 권한이 필요해요');
    } else if (result.type === 'error') {
      showToast('앨범을 가져오지 못했어요');
    }
  }

  // ─── 상세 약 목록 ─────────────────────────────────────────────────────────

  function handleAddMedication() {
    const routineIdPlaceholder = 'new';
    const newItem: MedicationItem = {
      id: generateMedId(routineIdPlaceholder, medications.length + 1),
      name: '',
      // dose, iconType, colorTag는 undefined로 초기화 — 사용자가 선택할 때만 저장
    };
    setMedications((prev) => [...prev, newItem]);
  }

  // 약 단위 종류·색상 선택 (바텀시트에서 호출).
  // 같은 값을 다시 누르면 해제(undefined)하여 기본값으로 돌아간다.
  function handleMedIconSelect(index: number, selected: DoseRoutine['iconType']) {
    setMedications((prev) =>
      prev.map((item, i) =>
        i === index
          ? { ...item, iconType: item.iconType === selected ? undefined : selected }
          : item,
      ),
    );
  }

  function handleMedColorSelect(index: number, color: string) {
    setMedications((prev) =>
      prev.map((item, i) =>
        i === index
          ? { ...item, colorTag: item.colorTag === color ? undefined : color }
          : item,
      ),
    );
  }

  function handleMedNameChange(index: number, name: string) {
    setMedications((prev) =>
      prev.map((item, i) => (i === index ? { ...item, name } : item)),
    );
    if (errors.medications) setErrors((e) => ({ ...e, medications: undefined }));
  }

  function handleMedDoseChange(index: number, dose: string) {
    // 빈문자열은 undefined로 저장 — "용량 없음"과 동일하게 처리
    setMedications((prev) =>
      prev.map((item, i) =>
        i === index ? { ...item, dose: dose.trim() || undefined } : item,
      ),
    );
  }

  function handleRemoveMedication(index: number) {
    setMedications((prev) => prev.filter((_, i) => i !== index));
  }

  // ─── 저장 ────────────────────────────────────────────────────────────────

  // 보상형 광고 → 등록 — 사용자 자발 시청 (B안: 선택형)
  // 광고는 응원/노출 차원이며 등록의 게이트가 아님.
  // 시청 결과(완주/중단/실패/미지원)와 무관하게 등록은 항상 진행 → 다크패턴 회피.
  async function handleSaveWithAd() {
    if (isSaving || isWatchingAd) return;
    if (!isRewardAdLoaded) {
      // 아직 로드 안 됐으면 그냥 등록
      void handleSave();
      return;
    }
    setIsWatchingAd(true);
    let watchedToCompletion = false;
    try {
      // 광고 결과는 로깅만 — 등록은 무조건 진행
      const result = await showAd(REWARDED_AD_GROUP_ID);
      if (result.kind === 'failed') {
        console.warn('[add] 보상형 광고 표시 실패', result.reason);
      }
      if (result.kind === 'rewarded') {
        watchedToCompletion = true;
      }
    } finally {
      setIsWatchingAd(false);
      setIsRewardAdLoaded(false);
      // 광고 끝까지 시청 시 응원 메시지 — 명확한 보상으로 인지되게
      // Ref: 비게임 출시 가이드 §인앱 광고 "리워드 광고를 끝까지 시청하면 보상이 정상 지급"
      if (watchedToCompletion) {
        showToast('응원해주셔서 고마워요 🙏');
        // 응원 토스트가 등록 완료 토스트에 곧바로 덮이지 않게 잠시 대기
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      // 광고 결과와 무관하게 등록 진행 (B안: 선택형)
      await handleSave();
    }
  }

  async function handleSave() {
    // 유효성 검사
    const newErrors: FormErrors = {};

    const labelResult = validateLabel(label);
    if (!labelResult.valid) newErrors.label = labelResult.message;

    const timeResult = validateTime(time);
    if (!timeResult.valid) newErrors.time = timeResult.message;

    if (frequency === 'weekly') {
      const weekdaysResult = validateWeekdays(selectedWeekdays);
      if (!weekdaysResult.valid) newErrors.weekdays = weekdaysResult.message;
    }

    // 이름이 비어있는 행 제거 후 검증 (추가했지만 입력 안 한 빈 행 허용 안 함)
    const filledMeds = medications.filter((m) => m.name.trim().length > 0);
    const emptyNameMeds = medications.filter((m) => m.name.trim().length === 0 && medications.length > 0);
    if (emptyNameMeds.length > 0 && filledMeds.length < medications.length) {
      newErrors.medications = '약 이름을 입력하거나 행을 삭제해요';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setIsSaving(true);
    try {
      // 수정 모드면 기존 id·createdAt 유지, 신규는 새로 생성.
      let routineId: string;
      let createdAt: string;
      if (isEditMode && editRoutineId) {
        const existingRoutines = await getRoutines();
        const existing = existingRoutines.find((r) => r.id === editRoutineId);
        if (!existing) {
          // 어떤 이유로 사라진 경우엔 신규로 폴백.
          routineId = await generateRoutineId();
          createdAt = new Date().toISOString();
        } else {
          routineId = existing.id;
          createdAt = existing.createdAt;
        }
      } else {
        routineId = await generateRoutineId();
        createdAt = new Date().toISOString();
      }

      // 약 아이템 ID 재부여 (routineId 확정 후)
      const finalMeds = filledMeds.map((item, i) => ({
        ...item,
        id: generateMedId(routineId, i + 1),
      }));

      const routine: DoseRoutine = {
        id: routineId,
        label: label.trim(),
        time,
        ...(mealTiming && { mealTiming }),
        frequency,
        ...(frequency === 'weekly' && { weekdays: selectedWeekdays }),
        ...(photoDataUri && { photoBase64: photoDataUri }),
        // iconType, colorTag는 약 단위(MedicationItem)로 이동 — 회차 레벨에서는 더 이상 저장하지 않음
        ...(finalMeds.length > 0 && { medications: finalMeds }),
        createdAt,
      };

      // Ref: references/sdk/framework/저장소/Storage.md §setItem
      if (isEditMode) {
        await updateRoutine(routine);
      } else {
        await saveRoutine(routine);
      }

      // Step 4: 로컬 저장 완료 후 백그라운드에서 스케줄 동기화
      // Ref: PRD step-04 §처리 1-2 "appLogin + Vercel 스케줄 등록"
      // 다크패턴 방지: 로그인 팝업 없음, 백그라운드 silent 시도
      // Ref: references/dev-guide/design/consumer-ux-guide.md §강제 로그인 금지
      void (async () => {
        try {
          const userKey = await ensureUserKey();
          if (userKey) {
            await upsertSchedule({
              userKey,
              routineId: routine.id,
              time: routine.time,
              weekdays:
                routine.frequency === 'daily'
                  ? [0, 1, 2, 3, 4, 5, 6]
                  : (routine.weekdays ?? []),
              label: routine.label,
              nickname: nickname || 'unknown',
            });
          }
        } catch (err) {
          // 스케줄 동기화 실패는 로컬 저장에 영향 없음 — 재시도 큐가 처리
          console.warn('[add] 스케줄 동기화 실패 (재시도 큐 적재됨):', err);
        }
      })();

      showToast(isEditMode ? '수정했어요' : '등록 완료');
      // 저장 성공 → 홈으로 이동
      setTimeout(() => navigation.navigate('/'), 600);
    } catch {
      // Ref: step-02 §아키텍처 "Storage 쓰기 실패 시 에러 토스트 (크래시 없음)"
      showToast('저장에 실패했어요. 다시 시도해요');
    } finally {
      setIsSaving(false);
    }
  }

  // ─── 렌더 ────────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* 헤더 */}
      <View style={styles.header}>
        {/* 뒤로가기는 토스 nav 바가 제공 — 자체 ← 버튼 제거 (검수 가이드) */}
        <Text style={styles.headerTitle} numberOfLines={1}>
          {isEditMode
            ? '회차 수정'
            : nickname
              ? `${nickname}의 복용 회차 등록`
              : '복용 회차 등록'}
        </Text>
        <View style={styles.headerRight} />
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── 필수 영역 ── */}
        <SectionTitle text="필수 정보" />

        {/* 회차 레이블 */}
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>회차 이름</Text>
          <TextInput
            style={[styles.input, errors.label ? styles.inputError : null]}
            placeholder="예: 아침약, 자기 전 약, 점심 영양제"
            placeholderTextColor="#B0B8C1"
            value={label}
            onChangeText={handleLabelChange}
            maxLength={15}
            returnKeyType="next"
            accessibilityLabel="회차 이름 입력"
          />
          {errors.label ? (
            <Text style={styles.errorText}>{errors.label}</Text>
          ) : (
            <Text style={styles.charCount}>{label.length}/15</Text>
          )}
        </View>

        {/* 복용 시간
            시간대 자동 분류 아이콘(아침·점심·저녁·취침) 미노출
            Ref: step-02 §입력 "시간대 자동 분류 아이콘 없음 (사용자가 직접 입력)" */}
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>복용 시간</Text>
          <TextInput
            style={[styles.input, errors.time ? styles.inputError : null]}
            placeholder="09:00"
            placeholderTextColor="#B0B8C1"
            value={time}
            onChangeText={handleTimeChange}
            keyboardType="numeric"
            maxLength={5}
            returnKeyType="done"
            accessibilityLabel="복용 시간 입력 (HH:MM)"
          />
          {errors.time && <Text style={styles.errorText}>{errors.time}</Text>}
        </View>

        {/* 식전 / 식후 (선택) — 없으면 빈 상태 */}
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>식전 / 식후 (선택)</Text>
          <View style={styles.chipRow}>
            <FrequencyChip
              label="식전"
              selected={mealTiming === 'before'}
              onPress={() => setMealTiming(mealTiming === 'before' ? null : 'before')}
            />
            <FrequencyChip
              label="식후"
              selected={mealTiming === 'after'}
              onPress={() => setMealTiming(mealTiming === 'after' ? null : 'after')}
            />
          </View>
        </View>

        {/* 복용 주기 */}
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>복용 주기</Text>
          <View style={styles.chipRow}>
            <FrequencyChip
              label="매일"
              selected={frequency === 'daily'}
              onPress={() => handleFrequencySelect('daily')}
            />
            <FrequencyChip
              label="특정 요일"
              selected={frequency === 'weekly'}
              onPress={() => handleFrequencySelect('weekly')}
            />
          </View>

          {frequency === 'weekly' && (
            <View style={[styles.chipRow, styles.weekdayRow]}>
              {WEEKDAY_LABELS.map((day, index) => (
                <WeekdayChip
                  key={day}
                  label={day}
                  selected={selectedWeekdays.includes(index)}
                  onPress={() => handleWeekdayToggle(index)}
                />
              ))}
            </View>
          )}
          {errors.weekdays && <Text style={styles.errorText}>{errors.weekdays}</Text>}
        </View>

        {/* ── 선택 영역 (Accordion) ── */}
        <TouchableOpacity
          style={styles.accordionHeader}
          onPress={() => setIsAccordionOpen((prev) => !prev)}
          accessibilityRole="button"
          accessibilityLabel={isAccordionOpen ? '상세 추가하기 접기' : '상세 추가하기 열기'}
        >
          <Text style={styles.accordionTitle}>상세 추가하기</Text>
          <Text style={styles.accordionChevron}>{isAccordionOpen ? '▲' : '▼'}</Text>
        </TouchableOpacity>

        {isAccordionOpen && (
          <View style={styles.accordionBody}>
            {/* 회차 사진 */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>회차 사진 (선택)</Text>
              <TouchableOpacity
                style={styles.photoArea}
                onPress={handlePhotoAreaPress}
                accessibilityRole="button"
                accessibilityLabel="사진 추가하기"
              >
                {photoDataUri ? (
                  <Image
                    source={{ uri: photoDataUri }}
                    style={styles.photoPreview}
                    accessibilityLabel="선택한 회차 사진"
                  />
                ) : (
                  <View style={styles.photoPlaceholder}>
                    <Text style={styles.photoPlaceholderIcon}>📷</Text>
                    <Text style={styles.photoPlaceholderText}>
                      {isCameraSupported()
                        ? '탭해서 사진을 추가해요'
                        : '토스 앱 업데이트 후 사진을 추가할 수 있어요'}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
              {photoDataUri && (
                <TouchableOpacity
                  onPress={() => setPhotoDataUri(null)}
                  accessibilityRole="button"
                  accessibilityLabel="사진 삭제"
                >
                  <Text style={styles.removePhotoText}>사진 삭제해요</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* 상세 약 목록 — 약마다 색상·종류 개별 선택 */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>상세 약 목록 (선택)</Text>
              <Text style={styles.fieldHint}>
                동그라미를 눌러 약마다 종류·색상을 선택해요
              </Text>
              {medications.map((med, index) => (
                <MedicationRow
                  key={med.id}
                  name={med.name}
                  dose={med.dose ?? ''}
                  iconType={med.iconType}
                  colorTag={med.colorTag}
                  onSwatchPress={() => setPickerOpenIndex(index)}
                  onNameChange={(text) => handleMedNameChange(index, text)}
                  onDoseChange={(text) => handleMedDoseChange(index, text)}
                  onRemove={() => handleRemoveMedication(index)}
                />
              ))}
              {errors.medications && (
                <Text style={styles.errorText}>{errors.medications}</Text>
              )}
              <TouchableOpacity
                style={styles.addMedButton}
                onPress={handleAddMedication}
                accessibilityRole="button"
                accessibilityLabel="약 항목 추가하기"
              >
                <Text style={styles.addMedButtonText}>+ 약 추가해요</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* 미구독자: 광고 보고 등록 버튼만 노출 (광고 시청 결과와 무관하게 등록 진행) */}
        {!isEditMode && !isAdRemoved && (
          <TouchableOpacity
            style={[
              styles.adSaveButton,
              (isWatchingAd || isSaving) && styles.adSaveButtonDisabled,
            ]}
            onPress={() => void handleSaveWithAd()}
            disabled={isWatchingAd || isSaving}
            accessibilityRole="button"
            accessibilityLabel="회차 등록해요"
            testID="save-with-ad-button"
          >
            <Text style={styles.adSaveButtonText}>
              {isWatchingAd
                ? '광고 보는 중이에요…'
                : isSaving
                  ? '등록 중이에요…'
                  : '📺 광고 보고 등록하기'}
            </Text>
          </TouchableOpacity>
        )}

        {/* 구독자 또는 수정 모드: 일반 등록 버튼 */}
        {(isEditMode || isAdRemoved) && (
          <TouchableOpacity
            style={[styles.saveButton, isSaving && styles.saveButtonDisabled]}
            onPress={handleSave}
            disabled={isSaving}
            accessibilityRole="button"
            accessibilityLabel="회차 등록해요"
          >
            <Text style={styles.saveButtonText}>
              {isSaving
                ? isEditMode
                  ? '수정 중이에요...'
                  : '등록 중이에요...'
                : isEditMode
                  ? '수정해요'
                  : '등록해요'}
            </Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* 토스트 메시지 */}
      {toastMessage ? (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toastMessage}</Text>
        </View>
      ) : null}

      {/* 약 단위 종류·색상 선택 바텀시트 */}
      <Modal
        visible={pickerOpenIndex !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerOpenIndex(null)}
      >
        <View style={styles.sheetOverlay}>
          <View style={styles.sheetContent} testID="med-style-sheet">
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {pickerOpenIndex !== null && medications[pickerOpenIndex]?.name?.trim()
                  ? `${medications[pickerOpenIndex]?.name?.trim() ?? ''} 종류·색상`
                  : '약 종류·색상'}
              </Text>
              <TouchableOpacity
                onPress={() => setPickerOpenIndex(null)}
                accessibilityRole="button"
                accessibilityLabel="바텀시트 닫기"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.sheetClose}>닫기</Text>
              </TouchableOpacity>
            </View>

            {pickerOpenIndex !== null && (
              <>
                <Text style={styles.sheetSubLabel}>약 종류</Text>
                <View style={styles.chipRow}>
                  {(Object.keys(ICON_TYPE_LABELS) as Array<keyof typeof ICON_TYPE_LABELS>).map(
                    (key) => (
                      <IconChip
                        key={key}
                        label={`${ICON_EMOJI[key]} ${ICON_TYPE_LABELS[key]}`}
                        selected={medications[pickerOpenIndex]?.iconType === key}
                        onPress={() =>
                          handleMedIconSelect(pickerOpenIndex, key as DoseRoutine['iconType'])
                        }
                      />
                    ),
                  )}
                </View>

                <Text style={[styles.sheetSubLabel, styles.sheetSubLabelGap]}>색상 태그</Text>
                <View style={styles.colorRow}>
                  {COLOR_PALETTE.map((color) => (
                    <ColorChip
                      key={color}
                      color={color}
                      selected={medications[pickerOpenIndex]?.colorTag === color}
                      onPress={() => handleMedColorSelect(pickerOpenIndex, color)}
                    />
                  ))}
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* 나가기 확인 바텀시트 (뒤로가기 차단 아님, 확인만) */}
      <Modal
        visible={showExitConfirm}
        transparent
        animationType="fade"
        onRequestClose={() => setShowExitConfirm(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent} testID="exit-confirm-modal">
            <Text style={styles.modalTitle}>저장 안 하고 나갈까요?</Text>
            <Text style={styles.modalBody}>입력한 내용이 저장되지 않아요</Text>
            <View style={styles.modalButtons}>
              {/* 왼쪽: 닫기 — Ref: references/dev-guide/design/ux-writing.md §다이얼로그 왼쪽 "닫기" */}
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonClose]}
                onPress={() => setShowExitConfirm(false)}
                accessibilityRole="button"
              >
                <Text style={styles.modalButtonCloseText}>닫기</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonConfirm]}
                onPress={() => {
                  setShowExitConfirm(false);
                  doGoBack();
                }}
                accessibilityRole="button"
              >
                <Text style={styles.modalButtonConfirmText}>나가요</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// ─── 서브 컴포넌트 ────────────────────────────────────────────────────────────

function SectionTitle({ text }: { text: string }) {
  return <Text style={styles.sectionTitle}>{text}</Text>;
}

function FrequencyChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.chip, selected && styles.chipSelected]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </TouchableOpacity>
  );
}

function WeekdayChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.weekdayChip, selected && styles.chipSelected]}
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
    >
      <Text style={[styles.weekdayChipText, selected && styles.chipTextSelected]}>{label}</Text>
    </TouchableOpacity>
  );
}

function IconChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.chip, selected && styles.chipSelected]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </TouchableOpacity>
  );
}

function ColorChip({
  color,
  selected,
  onPress,
}: {
  color: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.colorChip, { backgroundColor: color }, selected && styles.colorChipSelected]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={`색상 ${color}`}
      accessibilityState={{ selected }}
    />
  );
}

function MedicationRow({
  name,
  dose,
  iconType,
  colorTag,
  onSwatchPress,
  onNameChange,
  onDoseChange,
  onRemove,
}: {
  name: string;
  dose: string;
  iconType: DoseRoutine['iconType'];
  colorTag?: string;
  onSwatchPress: () => void;
  onNameChange: (text: string) => void;
  onDoseChange: (text: string) => void;
  onRemove: () => void;
}) {
  // 미선택 시 기본값 미리보기 — 저장 시점엔 undefined 그대로
  const swatchColor = colorTag ?? DEFAULT_COLOR;
  const swatchEmoji = iconType ? ICON_EMOJI[iconType] : DEFAULT_ICON_EMOJI;

  return (
    <View style={styles.medRow}>
      <TouchableOpacity
        style={[styles.medSwatch, { backgroundColor: swatchColor + '22', borderColor: swatchColor }]}
        onPress={onSwatchPress}
        accessibilityRole="button"
        accessibilityLabel={`이 약의 종류·색상 선택해요 (현재 ${iconType ?? '기본'})`}
        hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
      >
        <Text style={styles.medSwatchEmoji}>{swatchEmoji}</Text>
      </TouchableOpacity>
      <TextInput
        style={[styles.medNameInput]}
        placeholder="약 이름"
        placeholderTextColor="#B0B8C1"
        value={name}
        onChangeText={onNameChange}
        returnKeyType="next"
        accessibilityLabel="약 이름 입력"
      />
      <TextInput
        style={styles.medDoseInput}
        placeholder="용량 (예: 1정)"
        placeholderTextColor="#B0B8C1"
        value={dose}
        onChangeText={onDoseChange}
        returnKeyType="done"
        accessibilityLabel="약 용량 입력 (선택)"
      />
      <TouchableOpacity
        style={styles.medRemoveButton}
        onPress={onRemove}
        accessibilityRole="button"
        accessibilityLabel="이 약 삭제해요"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={styles.medRemoveText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── 스타일 ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  // 헤더
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 52 : 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F2F4F6',
    backgroundColor: '#FFFFFF',
  },
  backButton: {
    width: 48,
    height: 48,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  backIcon: {
    fontSize: 22,
    color: '#191F28',
  },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    color: '#191F28',
    textAlign: 'center',
  },
  headerRight: {
    width: 48,
  },
  // 스크롤
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 48,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6B7684',
    marginBottom: 16,
    letterSpacing: 0.5,
  },
  // 필드
  fieldGroup: {
    marginBottom: 24,
  },
  fieldLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#191F28',
    marginBottom: 10,
  },
  input: {
    height: 52,
    borderWidth: 1.5,
    borderColor: '#E5E8EB',
    borderRadius: 10,
    paddingHorizontal: 16,
    fontSize: 17,
    color: '#191F28',
    backgroundColor: '#F9FAFB',
  },
  inputError: {
    borderColor: '#FF6B6B',
  },
  errorText: {
    marginTop: 6,
    fontSize: 13,
    color: '#FF6B6B',
  },
  charCount: {
    marginTop: 6,
    fontSize: 13,
    color: '#B0B8C1',
    textAlign: 'right',
  },
  // Chip
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  weekdayRow: {
    marginTop: 12,
  },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: '#E5E8EB',
    backgroundColor: '#F9FAFB',
    minHeight: 40,
    justifyContent: 'center',
  },
  chipSelected: {
    borderColor: '#FF6B6B',
    backgroundColor: '#FFF0F0',
  },
  chipText: {
    fontSize: 15,
    color: '#6B7684',
    fontWeight: '500',
  },
  chipTextSelected: {
    color: '#FF6B6B',
    fontWeight: '600',
  },
  weekdayChip: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: '#E5E8EB',
    backgroundColor: '#F9FAFB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekdayChipText: {
    fontSize: 14,
    color: '#6B7684',
    fontWeight: '500',
  },
  // Accordion
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: '#F2F4F6',
    marginBottom: 8,
  },
  accordionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#191F28',
  },
  accordionChevron: {
    fontSize: 14,
    color: '#6B7684',
  },
  accordionBody: {
    paddingTop: 8,
  },
  // 사진
  photoArea: {
    height: 140,
    borderWidth: 1.5,
    borderColor: '#E5E8EB',
    borderRadius: 12,
    borderStyle: 'dashed',
    overflow: 'hidden',
  },
  photoPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  photoPlaceholderIcon: {
    fontSize: 32,
  },
  photoPlaceholderText: {
    fontSize: 14,
    color: '#B0B8C1',
    textAlign: 'center',
    paddingHorizontal: 16,
  },
  photoPreview: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  removePhotoText: {
    marginTop: 8,
    fontSize: 14,
    color: '#FF6B6B',
    textAlign: 'right',
  },
  // 색상 칩
  colorRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  colorChip: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  colorChipSelected: {
    borderColor: '#191F28',
  },
  // 약 목록
  medRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  medNameInput: {
    flex: 2,
    height: 48,
    borderWidth: 1.5,
    borderColor: '#E5E8EB',
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 16,
    color: '#191F28',
    backgroundColor: '#F9FAFB',
  },
  medDoseInput: {
    flex: 1,
    height: 48,
    borderWidth: 1.5,
    borderColor: '#E5E8EB',
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 15,
    color: '#191F28',
    backgroundColor: '#F9FAFB',
  },
  medRemoveButton: {
    width: 36,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  medRemoveText: {
    fontSize: 16,
    color: '#8B95A1',
  },
  addMedButton: {
    height: 48,
    borderWidth: 1.5,
    borderColor: '#FF6B6B',
    borderRadius: 10,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  addMedButtonText: {
    fontSize: 15,
    color: '#FF6B6B',
    fontWeight: '500',
  },
  // 저장 버튼
  saveButton: {
    height: 56,
    backgroundColor: '#FF6B6B',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
  saveButtonDisabled: {
    backgroundColor: '#E5E8EB',
  },
  saveButtonText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  // 광고 보고 등록 (보상형 옵션, secondary)
  adSaveButton: {
    height: 52,
    backgroundColor: '#FFF5F5',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
    borderWidth: 1,
    borderColor: '#FFE5E5',
  },
  adSaveButtonDisabled: {
    opacity: 0.55,
  },
  adSaveButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FF6B6B',
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
  },
  toastText: {
    fontSize: 15,
    color: '#FFFFFF',
    fontWeight: '500',
  },
  // 나가기 확인 모달
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalContent: {
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
  // 약 행 swatch (종류·색상 미리보기 + 바텀시트 트리거)
  medSwatch: {
    width: 40,
    height: 48,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  medSwatchEmoji: {
    fontSize: 20,
  },
  // 안내 힌트
  fieldHint: {
    fontSize: 13,
    color: '#8B95A1',
    marginTop: -6,
    marginBottom: 10,
  },
  // 약 종류·색상 바텀시트
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
    marginBottom: 20,
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
  sheetSubLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6B7684',
    marginBottom: 10,
  },
  sheetSubLabelGap: {
    marginTop: 20,
  },
});

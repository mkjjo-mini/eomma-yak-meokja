/**
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-03-home.md §처리·출력·행동·검수
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-06-streak.md §처리·출력·행동·검수
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-07-points.md §처리·출력·행동·검수
 *  - references/sdk/framework/저장소/Storage.md (Storage.getItem, 로컬 only)
 *  - references/sdk/framework/비게임/promotion.md §grantPromotionReward (SDK 래퍼 via rewardService)
 *  - references/sdk/framework/광고/RN-BannerAd.md (InlineAd, isSupported, impressFallbackOnMount)
 *  - references/sdk/framework/화면제어/IOFlatList.md (IOFlatList + InView)
 *  - references/sdk/framework/인터렉션/interaction.md (generateHapticFeedback)
 *  - references/dev-guide/design/consumer-ux-guide.md (다크패턴 5종 방지)
 *  - references/dev-guide/design/ux-writing.md (해요체, 능동형, 긍정형)
 *
 * Step 8a 추가:
 *  - 헤더 우측 "가족" 아이콘 버튼 → /family/share
 *  - 회차 토글(CHECKED) 후 fire-and-forget notifyCaregivers 호출
 *  - 앱 포그라운드 복귀 시 flushPendingNotifyQueue 재시도
 *  Ref: PRD step-08-family.md §처리 2, 3
 *
 * Step 8b 추가:
 *  - "광고 없이 쓰기" 링크: RefundNoticeBottomSheet + purchaseRemoveAdsSubscription()
 *  - loadAll() 시 isAdRemovedActive() 호출 — 토스 서버 구독 상태 조회 (캐시 fallback)
 *  Ref: PRD step-08-family.md §처리 6
 *
 * 관계 중립화 원칙:
 *  - 고정 카피에 "엄마" 금지 (앱 이름 "엄마약먹자" 표시 제외)
 *  - 별명 변수({nickname})로만 표시
 *
 * 네트워크 호출 없음 — 로컬 only 계약.
 * 광고 SDK 내부 네트워크 호출은 InlineAd 컴포넌트가 직접 처리 (모킹 대상).
 *
 * Step 6 추가:
 *  - 헤더 스트릭 카운터 ("🔥 N일 연속")
 *  - 복약률 원형 프로그레스 카드 (SVG-free, border-radius 트릭)
 *  - 배지 축하 모달 (다크패턴 5종 위반 없음)
 *  - 스트릭 탭 → /calendar, 배지 탭 → /badges 라우팅
 *
 * Step 7 추가:
 *  - 모든 회차 완료 시 grantDailyReward 호출 (rewardService)
 *  - 완료 토스트에 포인트 문구 추가 (granted 시만)
 *  - 홈 하단 "이번 달 적립 {N}포인트" 카드 (RewardCard)
 *  - 예산 소진 / 적립 0 → 카드 숨김
 */
import { createRoute, useNavigation, IOFlatList } from '@granite-js/react-native';
import { InlineAd, generateHapticFeedback } from '@apps-in-toss/framework';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefundNoticeBottomSheet } from '../components/RefundNoticeBottomSheet';
import {
  isAdRemovedActive,
  purchaseRemoveAdsSubscription,
} from '../services/iapService';
import {
  Alert,
  Image,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { getNickname, getRoutines } from '../services/storageService';
import { getSavedUserKey } from '../services/authService';
import { deleteSchedule, flushPendingQueue } from '../services/scheduleService';
import { notifyCaregivers, flushPendingNotifyQueue } from '../services/pairService';
import { syncMyTodayStatus } from '../services/careStatusService';
import {
  grantDailyReward,
  getMonthlyGrantedPoints,
  isLatestResultBudgetExhausted,
} from '../services/rewardService';
import {
  calcMonthlyAdherenceWithSchedule,
  calcStreak,
  filterTodayRoutines,
  flushMissedRecords,
  getKSTDateString,
  getKSTTimeHHMM,
  getKSTWeekday,
  getKSTYesterdayString,
  getOrCreatePendingRecord,
  getRecords,
  getYesterdayMissedItems,
  toggleCheck,
  unlockBadgeIfQualified,
} from '../services/recordService';
import { Storage } from '@apps-in-toss/framework';
import {
  type DoseRoutine,
  ICON_EMOJI,
  DEFAULT_ICON_EMOJI,
  DEFAULT_COLOR,
} from '../types/routine';
import { type DoseRecord } from '../types/record';
import { type BadgeKind, BADGE_META } from '../types/badge';

export const Route = createRoute('/', {
  validateParams: (params) => params,
  component: HomePage,
});

class AdErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

// ─── 타입 ───────────────────────────────────────────────────────────────────

type RoutineWithRecord = {
  routine: DoseRoutine;
  record: DoseRecord;
  /** 어제 미체크로 인한 MISSED 표시 여부 */
  isMissedFromYesterday: boolean;
};

// 아이콘 이모지 매핑은 types/routine.ts로 이동 (약 단위 색상·종류 부여로 공유 필요)

// ─── 원형 프로그레스 컴포넌트 (SVG 기반) ────────────────────────────────────
// react-native-svg의 Circle + strokeDasharray 트릭으로 깔끔한 호 렌더링.
// 이전엔 border-radius + rotation 마스크 방식이었으나, 회전 경계에 시각적 잘림
// 현상이 있어 SVG로 전환 (회전 transform 없이 매끄러운 호).
// Ref: PRD step-06 §출력 "원형 프로그레스 UI 표시"

import Svg, { Circle } from 'react-native-svg';

const RING_SIZE = 80;
const RING_STROKE = 8;

type CircularProgressProps = {
  /** 0~1 사이의 진행률 */
  progress: number;
  /** 링 색상 */
  color: string;
  testID?: string;
};

function CircularProgress({ progress, color, testID }: CircularProgressProps) {
  const clampedProgress = Math.min(1, Math.max(0, progress));
  const radius = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clampedProgress);
  const center = RING_SIZE / 2;
  // 트랙(미완료 부분) 색 — 진행 컬러와 같은 계열 옅은 톤
  const track = '#FFE5E5';

  return (
    <View
      style={{
        width: RING_SIZE,
        height: RING_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
      }}
      testID={testID}
    >
      <Svg
        width={RING_SIZE}
        height={RING_SIZE}
        style={{ position: 'absolute', top: 0, left: 0 }}
      >
        {/* 트랙 (전체 원) */}
        <Circle
          cx={center}
          cy={center}
          r={radius}
          stroke={track}
          strokeWidth={RING_STROKE}
          fill="none"
        />
        {/* 진행 호 — 12시에서 시작해 시계 방향 */}
        <Circle
          cx={center}
          cy={center}
          r={radius}
          stroke={color}
          strokeWidth={RING_STROKE}
          fill="none"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
        />
      </Svg>
      <Text style={styles.ringPercent}>{Math.round(clampedProgress * 100)}</Text>
      <Text style={styles.ringPercentSign}>%</Text>
    </View>
  );
}

// ─── 메인 화면 ────────────────────────────────────────────────────────────────

function HomePage() {
  const navigation = useNavigation();

  const [nickname, setNickname] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [items, setItems] = useState<RoutineWithRecord[]>([]);
  const [showRemoveAds, setShowRemoveAds] = useState(false); // loadAll 완료 후 결정
  const [adFailed, setAdFailed] = useState(false);

  // ─── Step 8b: 광고 제거 IAP 바텀시트 ────────────────────────────────────
  // Ref: PRD step-08-family.md §처리 6 "링크 탭 → 결제 바텀시트"
  const [removeAdsSheetVisible, setRemoveAdsSheetVisible] = useState(false);

  // 토스트
  const [toastMessage, setToastMessage] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 완료 토스트 세션 내 1회만 표시 (동일 세션 중복 방지)
  const completionToastShown = useRef(false);

  // 카드 길게 누르기 메뉴
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuRoutine, setMenuRoutine] = useState<DoseRoutine | null>(null);

  // 삭제 확인 바텀시트
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [deleteTargetRoutine, setDeleteTargetRoutine] = useState<DoseRoutine | null>(null);

  // ─── Step 5: 어제 MISSED 소프트 배너 ─────────────────────────────────────
  // Ref: PRD step-05 §출력 "홈 화면 '어제 놓친 회차 N개' 소프트 알림 배너"
  // 다크패턴 아님: 닫기 버튼 포함, 강제 팝업 아님
  // Ref: references/dev-guide/design/consumer-ux-guide.md §1 (진입 즉시 전면 바텀시트 금지)
  const [missedBannerCount, setMissedBannerCount] = useState(0);
  const [missedBannerDismissed, setMissedBannerDismissed] = useState(false);

  // ─── Step 6: 스트릭 + 복약률 ─────────────────────────────────────────────
  // Ref: PRD step-06 §출력 "홈 상단 '🔥 N일 연속' 카운터"
  const [streak, setStreak] = useState(0);
  // Ref: PRD step-06 §출력 "이번 달 복약률 원형 그래프"
  const [adherence, setAdherence] = useState(0);
  const [hasAdherenceData, setHasAdherenceData] = useState(false);

  // ─── Step 6: 배지 축하 모달 ───────────────────────────────────────────────
  // Ref: PRD step-06 §처리 3 "첫 달성 시 전면 축하 화면 1회 노출"
  // 다크패턴 방지: 닫기 버튼 필수, 뒤로가기 차단 없음
  // Ref: references/dev-guide/design/consumer-ux-guide.md §3
  const [celebrateBadge, setCelebrateBadge] = useState<BadgeKind | null>(null);

  // ─── Step 7: 이번 달 포인트 적립 현황 ────────────────────────────────────
  // Ref: PRD step-07 §출력 "홈 하단 '이번 달 적립 {N}포인트' 표시"
  // Ref: PRD step-07 §출력 "예산 소진 상태 → 카드 숨김"
  const [monthlyPoints, setMonthlyPoints] = useState(0);
  const [isBudgetExhausted, setIsBudgetExhausted] = useState(false);

  // ─── 초기 로드 ──────────────────────────────────────────────────────────

  useEffect(() => {
    void loadAll().catch((err) => {
      console.warn('[HomePage] loadAll 실패:', err);
      setIsLoading(false);
    });
  }, []);

  /**
   * navigation.navigate 후 홈으로 복귀했을 때 데이터 갱신.
   * Ref: step-03 §검수 "체크 상태는 앱 재진입 후에도 유지"
   */
  useEffect(() => {
    const unsubscribe = navigation.addListener?.('focus', () => {
      if (!isLoading) void loadAll().catch((err) => {
        console.warn('[HomePage] loadAll(focus) 실패:', err);
        setIsLoading(false);
      });
    });
    return unsubscribe;
  }, [isLoading]);

  async function loadAll() {
    try {
      // 별명 조회 — 온보딩 게이트
      const saved = await getNickname();
      if (!saved) {
        navigation.navigate('/onboarding/name');
        return;
      }
      setNickname(saved);

      // IAP 광고 제거 구독 활성 여부 조회 — 토스 서버 getSubscriptionInfo가 진실
      // Ref: PRD step-08-family.md §처리 6 (구독 모델 전환)
      // Ref: references/sdk/framework/인앱결제/subscription.md §getSubscriptionInfo
      // 네트워크/구버전 환경: 24h 캐시 fallback, 실패 시 false
      const adRemoved = await isAdRemovedActive();
      setShowRemoveAds(!adRemoved);

      // Step 4: 앱 포그라운드 복귀 시 pendingSchedule 큐 재시도
      // Ref: PRD step-04 §처리 2 "네트워크 실패 시 재시도 큐에 적재"
      void flushPendingQueue().catch(() => {});

      // Step 8a: 앱 포그라운드 복귀 시 pendingNotify 큐 재시도
      // Ref: PRD step-08-family.md §처리 2 "pendingNotify 큐 재시도"
      void flushPendingNotifyQueue().catch(() => {});

      // Step 5: 앱 진입 시 과거 PENDING/NOTIFIED 레코드를 MISSED로 실제 전이
      // Ref: PRD step-05 §처리 2 "옵션 A: 앱 진입 시 flushMissedRecords() 호출"
      // Ref: PRD step-05 §검수 "flushMissedRecords 앱 진입 시 호출"
      void flushMissedRecords().catch(() => {});

      await loadTodayItems();
    } finally {
      setIsLoading(false);
    }
  }

  async function loadTodayItems() {
    const todayDate = getKSTDateString();
    const yesterdayDate = getKSTYesterdayString();
    const todayWeekday = getKSTWeekday();

    const routines = await getRoutines();
    const todayRoutines = filterTodayRoutines(routines, todayWeekday);

    // 오늘 레코드 조회 (없으면 PENDING 가상 반환)
    const todayItems: RoutineWithRecord[] = await Promise.all(
      todayRoutines.map(async (routine) => {
        const record = await getOrCreatePendingRecord(routine.id, todayDate);
        return { routine, record, isMissedFromYesterday: false };
      }),
    );

    // 어제 MISSED 항목 조회 (오늘 목록에 정상 포함, MISSED 표시)
    // Ref: step-03 §검수 "어제 미체크 회차는 오늘 MISSED로 표시되고, 오늘 목록엔 정상 포함"
    const yesterdayMissed = await getYesterdayMissedItems(
      todayRoutines,
      yesterdayDate,
      todayDate,
    );

    // 오늘 아이템에 MISSED 여부 병합
    const merged = todayItems.map((item) => {
      const wasMissed = yesterdayMissed.some(
        (m) => m.routine.id === item.routine.id,
      );
      return { ...item, isMissedFromYesterday: wasMissed };
    });

    // 시간 순 정렬 (filterTodayRoutines에서 이미 정렬되었지만 명시적 재정렬)
    merged.sort((a, b) => a.routine.time.localeCompare(b.routine.time));

    setItems(merged);

    // Step 5: 어제 MISSED 배너 카운트 갱신
    // Ref: PRD step-05 §출력 "어제 {N}개 회차를 놓쳤어요 (해당 없으면 미표시)"
    setMissedBannerCount(yesterdayMissed.length);
    setMissedBannerDismissed(false); // 앱 재진입 시 배너 초기화

    // Step 6: 스트릭 계산
    // Ref: PRD step-06 §처리 1
    const allRecords = await getRecords();
    const currentStreak = calcStreak(routines, allRecords);
    setStreak(currentStreak);

    // Step 6: 복약률 계산
    // Ref: PRD step-06 §처리 2 "이번 달 CHECKED / (CHECKED + MISSED) 비율"
    const now = new Date();
    const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const year = kstNow.getUTCFullYear();
    const month = kstNow.getUTCMonth() + 1;
    const adh = calcMonthlyAdherenceWithSchedule(routines, allRecords, year, month);
    const prefix = `${String(year)}-${String(month).padStart(2, '0')}`;
    const hasData = allRecords.some(
      (r) => r.date.startsWith(prefix) && (r.status === 'CHECKED' || r.status === 'MISSED'),
    );
    setAdherence(adh);
    setHasAdherenceData(hasData);

    // Step 7: 이번 달 적립 포인트 + 예산 소진 상태 갱신
    // Ref: PRD step-07 §출력 "이번 달 적립 {N}포인트"
    // Ref: PRD step-07 §출력 "예산 소진 상태 → 카드 숨김"
    const [points, budgetExhausted] = await Promise.all([
      getMonthlyGrantedPoints(),
      isLatestResultBudgetExhausted(),
    ]);
    setMonthlyPoints(points);
    setIsBudgetExhausted(budgetExhausted);
  }

  // ─── Pull 방식 가족 현황: items/nickname 변경 시 Vercel KV에 sync ─────
  // Ref: PRD step-08-family.md §처리 4 "Pull 방식 — 케어 대상이 체크 시 KV 갱신"
  // 알림(notify) 비활성 대안. 가족 폰이 미니앱 진입 시 fetch해서 표시.
  // 비즈월렛 비용 0 (스마트 발송 안 씀). fire-and-forget.
  useEffect(() => {
    if (!nickname || items.length === 0) return;
    const todayDate = getKSTDateString();
    void syncMyTodayStatus({
      nickname,
      date: todayDate,
      items: items.map((it) => ({
        routineId: it.routine.id,
        routineLabel: it.routine.label,
        scheduledTime: it.routine.time,
        status: it.record.status as 'PENDING' | 'CHECKED' | 'MISSED',
        ...(it.record.checkedAt ? { takenAt: it.record.checkedAt } : {}),
      })),
    }).catch(() => {
      // 네트워크 실패 silent — 로컬 체크는 별개
    });
  }, [items, nickname]);

  // ─── 토스트 ──────────────────────────────────────────────────────────────

  function showToast(message: string) {
    setToastMessage(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMessage(''), 2500);
  }

  // ─── 체크 토글 ────────────────────────────────────────────────────────────

  const handleCheck = useCallback(
    async (routine: DoseRoutine, currentRecord: DoseRecord) => {
      const todayDate = getKSTDateString();

      // 조기 체크 가드: 예정 시각 전이고 아직 미체크면 재확인 다이얼로그.
      // CHECKED → 체크 해제는 시간 무관 즉시 허용.
      if (currentRecord.status !== 'CHECKED' && getKSTTimeHHMM() < routine.time) {
        const confirmed = await new Promise<boolean>((resolve) => {
          Alert.alert(
            '아직 복용 시간 전이에요',
            `${routine.label} 예정 시각은 ${routine.time}이에요.\n지금 체크할까요?`,
            [
              { text: '취소', style: 'cancel', onPress: () => resolve(false) },
              { text: '체크할게요', onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
          );
        });
        if (!confirmed) return;
      }

      // 햅틱 피드백
      // Ref: references/sdk/framework/인터렉션/interaction.md §generateHapticFeedback
      generateHapticFeedback({ type: 'tickMedium' }).catch(() => {
        // 햅틱 미지원 환경 무시
      });

      try {
        const updated = await toggleCheck(routine.id, todayDate);

        // Step 8a: CHECKED 전환 시 케어러에게 fire-and-forget 푸시 발송
        // Ref: PRD step-08-family.md §처리 3
        //   "로컬 Storage에 CHECKED 기록 (Step 3 동작 유지)"
        //   "Vercel POST /api/notify — 실패해도 로컬 체크 유지"
        // // [기능성] 복약 완료 이벤트 알림
        // Ref: references/dev-guide/smart-message/intro.md §기능성 메시지
        if (updated.status === 'CHECKED') {
          void notifyCaregivers(
            routine.label,
            updated.checkedAt ?? new Date().toISOString(),
            'checked',
          ).catch(() => {
            // 실패해도 로컬 체크 유지 — fire-and-forget
            // Ref: step-08-family.md §검수 "Vercel Functions 호출 실패해도 로컬 체크 유지"
          });
        }

        // 모든 회차 CHECKED 달성 시 완료 토스트 1회 + 스트릭/배지 재계산
        // Ref: step-03 §검수 "모든 회차 체크 시 완료 토스트가 1회만 표시되어야 한다"
        setItems((currentItems) => {
          const updatedItems = currentItems.map((item) =>
            item.routine.id === routine.id ? { ...item, record: updated } : item,
          );
          const allDone =
            updatedItems.length > 0 &&
            updatedItems.every((item) => item.record.status === 'CHECKED');

          if (allDone && !completionToastShown.current) {
            completionToastShown.current = true;

            // Step 7: 완료 토스트 + 포인트 지급
            // Ref: PRD step-07 §출력 "오늘 약 다 챙겼어요! 🎉 +{N}포인트"
            // Ref: PRD step-07 §처리 1 "당일 전체 CHECKED → grantPromotionReward 1회 호출"
            // 포인트 지급은 배지/스트릭과 독립 실행 (실패해도 체크 상태 유지)
            void (async () => {
              try {
                const todayDateForReward = getKSTDateString();

                // Step 6: 스트릭 재계산 + 배지 지급
                // Ref: PRD step-06 §처리 1, 3
                const allRoutines = await getRoutines();
                const allRecords = await getRecords();
                const newStreak = calcStreak(allRoutines, allRecords);
                setStreak(newStreak);

                // 배지 지급 확인
                // Ref: PRD step-06 §처리 3 "첫 달성 시 전면 축하 화면 1회 노출"
                // 다크패턴 방지: 진입 즉시 팝업 아님 (모든 회차 완료 후 트리거)
                // Ref: references/dev-guide/design/consumer-ux-guide.md §1
                const newBadge = await unlockBadgeIfQualified(newStreak);
                if (newBadge) {
                  setCelebrateBadge(newBadge);
                }

                // Step 7: 포인트 지급
                // Ref: PRD step-07 §처리 1~4
                // Ref: references/sdk/framework/비게임/promotion.md §grantPromotionReward
                const rewardResult = await grantDailyReward(todayDateForReward);

                // 토스트 문구 분기
                // Ref: PRD step-07 §출력
                //   granted → "오늘 {별명} 약 다 챙겼어요! 🎉 +{N}포인트"
                //   그 외   → "오늘 {별명} 약 다 챙겼어요! 🎉" (포인트 문구 없음)
                setNickname((nick) => {
                  if (rewardResult.kind === 'granted') {
                    showToast(`오늘 ${nick ?? ''} 약 다 챙겼어요! 🎉 +${rewardResult.pointAmount}포인트`);
                  } else {
                    showToast(`오늘 ${nick ?? ''} 약 다 챙겼어요! 🎉`);
                  }
                  return nick;
                });

                // 포인트 지급 후 이번 달 합계 즉시 갱신
                // Ref: PRD step-07 §출력 "이번 달 적립 {N}포인트"
                const [newPoints, newBudgetExhausted] = await Promise.all([
                  getMonthlyGrantedPoints(),
                  isLatestResultBudgetExhausted(),
                ]);
                setMonthlyPoints(newPoints);
                setIsBudgetExhausted(newBudgetExhausted);
              } catch {
                // 스트릭·배지·포인트 로직 실패 시 조용히 무시
                // Ref: PRD step-07 §처리 "grantPromotionReward 실패해도 체크 상태 유지"
                setNickname((nick) => {
                  showToast(`오늘 ${nick ?? ''} 약 다 챙겼어요! 🎉`);
                  return nick;
                });
              }
            })();
          } else if (!allDone) {
            // 체크 취소 시 완료 플래그 리셋 (재완료 가능하게)
            completionToastShown.current = false;
          }

          return updatedItems;
        });

        // 매 토글마다 스트릭·복약률 재계산 — 체크 해제 시에도 카드가 stale하지 않도록.
        void (async () => {
          try {
            const allRoutines = await getRoutines();
            const allRecords = await getRecords();
            setStreak(calcStreak(allRoutines, allRecords));

            const now = new Date();
            const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
            const year = kstNow.getUTCFullYear();
            const month = kstNow.getUTCMonth() + 1;
            const adh = calcMonthlyAdherenceWithSchedule(allRoutines, allRecords, year, month);
            const prefix = `${String(year)}-${String(month).padStart(2, '0')}`;
            const hasData = allRecords.some(
              (r) => r.date.startsWith(prefix) && (r.status === 'CHECKED' || r.status === 'MISSED'),
            );
            setAdherence(adh);
            setHasAdherenceData(hasData);
          } catch {
            // 부수 계산 실패는 토글 결과에 영향 없음 — 다음 진입 시 재계산.
          }
        })();
      } catch {
        showToast('저장에 실패했어요. 다시 시도해요');
      }
    },
    [],
  );

  // ─── 카드 길게 누르기 ──────────────────────────────────────────────────────

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
      const routines = await getRoutines();
      const updated = routines.filter((r) => r.id !== deleteTargetRoutine.id);
      await Storage.setItem('routines', JSON.stringify(updated));

      // 해당 루틴의 레코드도 제거
      const records = await getRecords();
      const updatedRecords = records.filter(
        (rec) => rec.routineId !== deleteTargetRoutine.id,
      );
      await Storage.setItem('records', JSON.stringify(updatedRecords));

      // Step 4: 회차 삭제 시 Vercel KV 스케줄도 삭제
      // Ref: PRD step-04 §처리 2 "회차 삭제 시 DELETE /api/schedule"
      void (async () => {
        try {
          const userKey = await getSavedUserKey();
          if (userKey) {
            await deleteSchedule(deleteTargetRoutine.id, userKey);
          }
        } catch (err) {
          console.warn('[index] 스케줄 삭제 동기화 실패 (재시도 큐 적재됨):', err);
        }
      })();

      showToast('회차를 삭제했어요');
      await loadTodayItems();
    } catch {
      showToast('삭제에 실패했어요. 다시 시도해요');
    }

    setDeleteTargetRoutine(null);
  }

  // ─── Step 8b: 광고 제거 구독 IAP 핸들러 ────────────────────────────────
  // Ref: PRD step-08-family.md §처리 6 (구독 모델)
  //   "결제 성공 → 홈 배너 즉시 제거 + 토스트 '광고 없이 쓰기가 시작됐어요'"
  //   "결제 취소 → silent"
  //   "결제 실패 → 토스트 '결제에 실패했어요. 다시 시도해 주세요'"
  // Ref: references/sdk/framework/인앱결제/subscription.md §createSubscriptionPurchaseOrder
  // Ref: references/dev-guide/design/consumer-ux-guide.md §다크패턴 방지

  const handleRemoveAdsPurchase = useCallback(async () => {
    // 바텀시트 닫기 (onConfirm 시점에 호출됨)
    setRemoveAdsSheetVisible(false);

    try {
      const result = await purchaseRemoveAdsSubscription();

      if (result.kind === 'success') {
        // 결제 성공: 배너 즉시 제거 + 토스트
        // orderId·캐시 저장은 iapService 내부 processProductGrant에서 처리
        setShowRemoveAds(false);
        showToast('광고 없이 쓰기가 시작됐어요');
      } else if (result.kind === 'cancelled') {
        // 취소: silent — 기존 상태 유지
      } else {
        // 실패: 에러 토스트
        // Ref: PRD step-08-family.md §처리 6 "결제 실패 → 에러 안내"
        const msg =
          result.reason === 'unsupported_version'
            ? '토스 앱을 최신 버전으로 업데이트해야 이용할 수 있어요'
            : '결제에 실패했어요. 다시 시도해 주세요';
        showToast(msg);
      }
    } catch {
      showToast('결제에 실패했어요. 다시 시도해 주세요');
    }
  }, []);

  // ─── 광고 콜백 ───────────────────────────────────────────────────────────

  function handleAdRendered() {
    setAdFailed(false);
  }

  function handleAdFailed() {
    // 배너 로드 실패 시 빈 공간 없이 카드만 표시
    // Ref: step-03 §검수 "배너 광고 로드 실패 시 빈 공간 없이 카드 리스트만 표시"
    // onNoFill(재고 없음) / onAdFailedToRender(SDK 미지원·환경 미지원) 모두 동일 처리
    setAdFailed(true);
  }

  // ─── 통계 계산 ───────────────────────────────────────────────────────────

  const totalCount = items.length;
  const checkedCount = items.filter((i) => i.record.status === 'CHECKED').length;

  // ─── 광고 배너 높이 — 겹침 방지를 위한 paddingBottom 계산 ────────────────

  const AD_BANNER_HEIGHT = 96;
  const AD_LINK_HEIGHT = 36;
  const adAreaHeight =
    showRemoveAds && !adFailed ? AD_BANNER_HEIGHT + AD_LINK_HEIGHT + 16 : 0;

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
      {/* Ref: step-03 §출력 "상단: {별명}의 오늘 복약" */}
      {/* Ref: step-06 §출력 "헤더 영역에 스트릭 카운터 추가" */}
      <View style={styles.header} testID="home-header">
        <View style={styles.headerRow}>
          <View style={styles.headerTextArea}>
            <Text style={styles.headerTitle} accessibilityRole="header">
              {nickname ? `${nickname}의 오늘 복약` : '오늘 복약'}
            </Text>
            {totalCount > 0 && (
              <Text style={styles.headerSubtitle}>
                {`${totalCount}개 중 ${checkedCount}개 체크`}
              </Text>
            )}
          </View>

          {/* 가족 아이콘 버튼 → /family/share */}
          {/* Ref: PRD step-08-family.md §처리 2 "헤더 우측 또는 적절한 위치에 '가족' 아이콘/링크" */}
          <TouchableOpacity
            style={styles.badgeButton}
            onPress={() => navigation.navigate('/family/share')}
            accessibilityRole="button"
            accessibilityLabel="가족에게 알리기"
            testID="family-nav-button"
          >
            <Text style={styles.badgeButtonEmoji}>👨‍👩‍👧</Text>
          </TouchableOpacity>

          {/* 배지 아이콘 버튼 → /badges */}
          {/* Ref: PRD step-06 §행동 "배지 탭 → 배지 컬렉션 화면" */}
          <TouchableOpacity
            style={styles.badgeButton}
            onPress={() => navigation.navigate('/badges')}
            accessibilityRole="button"
            accessibilityLabel="배지 컬렉션 보기"
            testID="badge-nav-button"
          >
            <Text style={styles.badgeButtonEmoji}>🏅</Text>
          </TouchableOpacity>
        </View>

        {/* 스트릭 카운터 — N=0이면 톤 다운 */}
        {/* Ref: PRD step-06 §출력 "🔥 N일 연속 (N=0이면 표시 생략 또는 톤 다운)" */}
        {/* Ref: PRD step-06 §행동 "스트릭 탭 → 월간 캘린더" */}
        <TouchableOpacity
          style={styles.streakBadge}
          onPress={() => navigation.navigate('/calendar')}
          accessibilityRole="button"
          accessibilityLabel={streak > 0 ? `${streak}일 연속 복약, 캘린더 보기` : '캘린더 보기'}
          testID="streak-badge"
        >
          <Text
            style={[styles.streakText, streak === 0 && styles.streakTextZero]}
            testID="streak-count"
          >
            {streak > 0 ? `🔥 ${streak}일 연속` : '🔥 오늘부터 시작해요'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── Step 5: 어제 MISSED 소프트 배너 ── */}
      {/* Ref: PRD step-05 §출력 "홈 상단 '어제 N개 놓쳤어요' 배너 조건부 표시 (닫기 포함)" */}
      {/* 다크패턴 방지: 강제 팝업 아님, 닫기 버튼 있음 */}
      {/* Ref: references/dev-guide/design/consumer-ux-guide.md §1,3 */}
      {missedBannerCount > 0 && !missedBannerDismissed && (
        <View style={styles.missedBanner} testID="missed-banner">
          <Text style={styles.missedBannerText} testID="missed-banner-text">
            {`어제 ${missedBannerCount}개 회차를 놓쳤어요`}
          </Text>
          {/* 거절 선택지 필수 — 다크패턴 §3 "닫기 선택지 있음" */}
          <TouchableOpacity
            style={styles.missedBannerClose}
            onPress={() => setMissedBannerDismissed(true)}
            accessibilityRole="button"
            accessibilityLabel="배너 닫기"
            testID="missed-banner-close"
          >
            <Text style={styles.missedBannerCloseText}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── 카드 리스트 ── */}
      {/* Ref: references/sdk/framework/화면제어/IOFlatList.md */}
      {items.length === 0 ? (
        <View style={styles.emptyContainer} testID="empty-state">
          <Text style={styles.emptyIcon}>💊</Text>
          <Text style={styles.emptyText}>오늘 복용할 회차가 없어요</Text>
          <Text style={styles.emptySubtext}>아래 + 버튼으로 등록해요</Text>
        </View>
      ) : (
        <IOFlatList
          data={items}
          keyExtractor={(item) => `${item.routine.id}-${item.record.date}`}
          renderItem={({ item }) => (
            <RoutineCard
              item={item}
              onPress={() => void handleCheck(item.routine, item.record)}
              onLongPress={() => handleLongPress(item.routine)}
            />
          )}
          ListFooterComponent={
            <>
              {/* ── Step 6: 이번 달 복약률 카드 ── */}
              {/* Ref: PRD step-06 §출력 "홈 하단 이번 달 복약률 원형 그래프" */}
              <AdherenceCard
                adherence={adherence}
                hasData={hasAdherenceData}
                onPress={() => navigation.navigate('/calendar')}
              />
              {/* ── Step 7: 이번 달 적립 포인트 카드 ── */}
              {/* Ref: PRD step-07 §출력 "이번 달 적립 {N}포인트" */}
              {/* 예산 소진 / 적립 0 → 카드 숨김 (다크패턴 아님, 광고성 문구 없음) */}
              {/* Ref: references/dev-guide/design/consumer-ux-guide.md §4 */}
              <RewardCard
                monthlyPoints={monthlyPoints}
                isBudgetExhausted={isBudgetExhausted}
              />
            </>
          }
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: adAreaHeight + 80 }, // 광고 높이 + FAB 여백
          ]}
          showsVerticalScrollIndicator={false}
          testID="routine-list"
        />
      )}

      {/* 회차 없을 때도 복약률 카드 + 포인트 카드 표시 */}
      {items.length === 0 && (
        <View style={styles.adherenceCardWrapper}>
          <AdherenceCard adherence={adherence} hasData={hasAdherenceData} />
          {/* Step 7: 회차 없을 때도 포인트 카드 표시 */}
          {/* Ref: PRD step-07 §출력 */}
          <RewardCard
            monthlyPoints={monthlyPoints}
            isBudgetExhausted={isBudgetExhausted}
          />
        </View>
      )}

      {/* ── 하단 플로팅 "+" 버튼 ── */}
      {/* Ref: step-03 §출력 "하단 '+' 버튼 → 회차 등록 화면" */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => navigation.navigate('/routines/add')}
        accessibilityRole="button"
        accessibilityLabel="복용 회차 등록해요"
        testID="fab-add"
      >
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>

      {/* ── 하단 고정 광고 배너 (IAP 미결제 시만) ── */}
      {/* Ref: references/sdk/framework/광고/RN-BannerAd.md §레이아웃 가이드 */}
      {showRemoveAds && (
        <View
          style={[styles.adContainer, adFailed && styles.adContainerHidden]}
          testID="ad-banner-container"
        >
          <View style={styles.adBannerWrapper} testID="inline-ad-wrapper">
            <AdErrorBoundary>
              {/* 광고 그룹 ID — Apps-in-Toss 콘솔에서 발급 (배너·문구 강조) */}
              {/* Ref: 콘솔 → 배너광고 정보 → 광고 그룹 ID */}
              <InlineAd
                adGroupId="ait.v2.live.3014777cf0214ff6"
                theme="auto"
                tone="blackAndWhite"
                variant="expanded"
                onAdRendered={handleAdRendered}
                onNoFill={handleAdFailed}
                onAdFailedToRender={handleAdFailed}
              />
            </AdErrorBoundary>
          </View>

          {!adFailed && (
            <TouchableOpacity
              style={styles.removeAdsLink}
              onPress={() => setRemoveAdsSheetVisible(true)}
              accessibilityRole="button"
              accessibilityLabel="광고 없이 쓰기"
              testID="remove-ads-link"
            >
              <Text style={styles.removeAdsLinkText}>광고 없이 쓰기</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ── Step 8b: 광고 제거 IAP 바텀시트 ── */}
      {/* Ref: PRD step-08-family.md §처리 6·8 — 환불 불가 고지 + 동의 체크박스 필수 */}
      <RefundNoticeBottomSheet
        visible={removeAdsSheetVisible}
        sku="remove_ads_lifetime_v1"
        productName="광고 제거 (월 자동 갱신)"
        price={1900}
        onConfirm={handleRemoveAdsPurchase}
        onClose={() => setRemoveAdsSheetVisible(false)}
      />

      {/* ── 토스트 ── */}
      {toastMessage ? (
        <View style={styles.toast} pointerEvents="none" testID="toast">
          <Text style={styles.toastText}>{toastMessage}</Text>
        </View>
      ) : null}

      {/* ── 카드 길게 누르기 메뉴 ── */}
      {/* 다크패턴 방지: 뒤로가기 차단 없음, 거절 선택지 있음 */}
      {/* Ref: references/dev-guide/design/consumer-ux-guide.md §2,3 */}
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
              <View style={styles.menuContent} testID="long-press-menu">
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
                {/* 거절 선택지 필수 — 다크패턴 §3 */}
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

      {/* ── 삭제 확인 바텀시트 ── */}
      {/* Ref: references/dev-guide/design/ux-writing.md §다이얼로그 왼쪽 "닫기" */}
      <Modal
        visible={deleteConfirmVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setDeleteConfirmVisible(false)}
        testID="delete-confirm-modal"
      >
        <TouchableWithoutFeedback onPress={() => setDeleteConfirmVisible(false)}>
          <View style={styles.menuOverlay}>
            <TouchableWithoutFeedback>
              <View style={styles.deleteSheet} testID="delete-confirm-sheet">
                <Text style={styles.deleteTitle}>이 회차를 삭제할까요?</Text>
                <Text style={styles.deleteBody}>
                  {deleteTargetRoutine?.label} 회차와 복약 기록이 삭제돼요
                </Text>
                <View style={styles.deleteButtons}>
                  {/* 왼쪽: 닫기 */}
                  <TouchableOpacity
                    style={[styles.deleteButton, styles.deleteButtonClose]}
                    onPress={() => setDeleteConfirmVisible(false)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.deleteButtonCloseText}>닫기</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.deleteButton, styles.deleteButtonConfirm]}
                    onPress={() => void handleDeleteConfirm()}
                    accessibilityRole="button"
                  >
                    <Text style={styles.deleteButtonConfirmText}>삭제해요</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* ── Step 6: 배지 축하 모달 ── */}
      {/* Ref: PRD step-06 §처리 3 "첫 달성 시 전면 축하 화면 1회 노출" */}
      {/* 다크패턴 5종 방지:
           §1 진입 즉시 X (모든 회차 완료 후 트리거)
           §2 뒤로가기 시 닫힘 (onRequestClose)
           §3 닫기·확인 버튼 명확히 제공
           §4 예상치 못한 광고 없음
           §5 CTA "확인했어요" — 다음 행동 명확
          Ref: references/dev-guide/design/consumer-ux-guide.md §1~5 */}
      <Modal
        visible={celebrateBadge !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setCelebrateBadge(null)}
        testID="badge-celebrate-modal"
      >
        <View style={styles.celebrateOverlay}>
          <View style={styles.celebrateCard} testID="badge-celebrate-card">
            {/* 닫기 버튼 — 다크패턴 §3 "탈출구 필수" */}
            <TouchableOpacity
              style={styles.celebrateClose}
              onPress={() => setCelebrateBadge(null)}
              accessibilityRole="button"
              accessibilityLabel="닫기"
              testID="badge-celebrate-close"
            >
              <Text style={styles.celebrateCloseText}>✕</Text>
            </TouchableOpacity>

            {celebrateBadge && (
              <>
                <Text style={styles.celebrateEmoji} testID="badge-celebrate-emoji">
                  {BADGE_META[celebrateBadge].emoji}
                </Text>
                <Text style={styles.celebrateTitle} testID="badge-celebrate-title">
                  {`${nickname ?? ''}, ${BADGE_META[celebrateBadge].days}일 연속 챙겼어요!`}
                </Text>
                <Text style={styles.celebrateDesc}>
                  {`${BADGE_META[celebrateBadge].label} 배지를 받았어요`}
                </Text>
              </>
            )}

            {/* 확인 버튼 — CTA 라벨이 다음 행동 예측 가능 (다크패턴 §5) */}
            <TouchableOpacity
              style={styles.celebrateConfirm}
              onPress={() => setCelebrateBadge(null)}
              accessibilityRole="button"
              accessibilityLabel="축하 확인"
              testID="badge-celebrate-confirm"
            >
              <Text style={styles.celebrateConfirmText}>확인했어요</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── 복약률 카드 컴포넌트 ─────────────────────────────────────────────────────

// 복약률(0~1) 구간별 격려 카피.
// Ref: references/dev-guide/design/ux-writing.md (해요체, 능동형, 긍정형)
function adherenceLabelFor(adherence: number): string {
  const pct = Math.round(adherence * 100);
  if (pct >= 90) return '꾸준히 잘 챙기고 있어요';
  if (pct >= 70) return '잘 하고 있어요. 조금만 더 힘내요';
  if (pct >= 40) return '조금씩 챙겨가요';
  if (pct > 0) return '오늘부터 다시 챙겨봐요';
  return '아직 완료한 날이 없어요';
}

type AdherenceCardProps = {
  adherence: number;
  hasData: boolean;
  onPress?: () => void;
};

function AdherenceCard({ adherence, hasData, onPress }: AdherenceCardProps) {
  const body = (
    <>
      <View style={styles.adherenceHeader}>
        <Text style={styles.adherenceTitle}>이번 달 복약률</Text>
      </View>

      {hasData ? (
        <View style={styles.adherenceBody}>
          <CircularProgress
            progress={adherence}
            color="#FF6B6B"
            testID="adherence-progress"
          />
          <View style={styles.adherenceDesc}>
            <Text style={styles.adherencePercent} testID="adherence-percent">
              {`${Math.round(adherence * 100)}%`}
            </Text>
            <Text style={styles.adherenceLabel}>
              {adherenceLabelFor(adherence)}
            </Text>
          </View>
        </View>
      ) : (
        // 데이터 없음 빈 상태
        // Ref: PRD step-06 §출력 "데이터 0개면 '이번 달 데이터가 모이는 중이에요'"
        <View style={styles.adherenceEmpty} testID="adherence-empty">
          <Text style={styles.adherenceEmptyText}>
            이번 달 데이터가 모이는 중이에요
          </Text>
        </View>
      )}
    </>
  );

  if (onPress) {
    return (
      <TouchableOpacity
        style={styles.adherenceCard}
        onPress={onPress}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="이번 달 복약 기록 캘린더 열기"
        testID="adherence-card"
      >
        {body}
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.adherenceCard} testID="adherence-card">
      {body}
    </View>
  );
}

// ─── 포인트 카드 컴포넌트 (Step 7) ───────────────────────────────────────────

/**
 * 이번 달 적립 포인트 카드.
 *
 * 표시 조건:
 *  - monthlyPoints > 0 AND isBudgetExhausted === false → 적립 금액 표시
 *  - monthlyPoints === 0 AND isBudgetExhausted === false → 빈 상태 안내 ("꾸준히 챙겨서 포인트도 받아요")
 *  - isBudgetExhausted === true → 카드 자체 숨김 (포인트 안내 제거)
 *
 * UX 라이팅 규칙 준수: 해요체, 광고성 문구 없음, 다크패턴 아님
 * Ref: references/dev-guide/design/ux-writing.md
 * Ref: PRD step-07 §출력 "예산 소진 → 카드 숨김"
 * Ref: references/dev-guide/design/consumer-ux-guide.md §4 (예상치 못한 광고 없음)
 */
type RewardCardProps = {
  monthlyPoints: number;
  isBudgetExhausted: boolean;
};

function RewardCard({ monthlyPoints, isBudgetExhausted }: RewardCardProps) {
  // 예산 소진 시 카드 전체 숨김
  // Ref: PRD step-07 §출력 "예산 소진 상태 → 카드 자체 숨김"
  if (isBudgetExhausted) return null;

  return (
    <View style={styles.rewardCard} testID="reward-card">
      <View style={styles.rewardCardHeader}>
        <Text style={styles.rewardCardTitle}>이번 달 적립 포인트</Text>
      </View>

      {monthlyPoints > 0 ? (
        // 적립 금액 표시
        // Ref: PRD step-07 §출력 "이번 달 적립 {N}포인트"
        <View style={styles.rewardCardBody} testID="reward-card-amount">
          <Text style={styles.rewardPointAmount} testID="reward-point-value">
            {`+${monthlyPoints}`}
          </Text>
          <Text style={styles.rewardPointUnit}>포인트</Text>
        </View>
      ) : (
        // 적립 0 빈 상태 — 광고성 아님, 동기 부여 문구만
        // Ref: PRD step-07 §출력 "적립 0이면 '꾸준히 챙겨서 포인트도 받아요' 안내"
        // Ref: references/dev-guide/design/consumer-ux-guide.md §4 (다크패턴 아님)
        <View style={styles.rewardCardEmpty} testID="reward-card-empty">
          <Text style={styles.rewardCardEmptyText}>
            꾸준히 챙겨서 포인트도 받아요
          </Text>
        </View>
      )}
    </View>
  );
}

// ─── 회차 카드 컴포넌트 ───────────────────────────────────────────────────────

type RoutineCardProps = {
  item: RoutineWithRecord;
  onPress: () => void;
  onLongPress: () => void;
};

function RoutineCard({ item, onPress, onLongPress }: RoutineCardProps) {
  const { routine, record, isMissedFromYesterday } = item;
  const isChecked = record.status === 'CHECKED';
  const isMissed = isMissedFromYesterday && record.status !== 'CHECKED';

  // 약 단위 색상·종류가 있으면 첫 약을 대표값으로 사용. 없으면 회차 레벨(레거시) → 기본값.
  const firstMed = routine.medications?.find((m) => m.colorTag || m.iconType);
  const colorTag = firstMed?.colorTag ?? routine.colorTag ?? DEFAULT_COLOR;
  const iconKey = firstMed?.iconType ?? routine.iconType;
  const iconEmoji = iconKey ? ICON_EMOJI[iconKey] ?? DEFAULT_ICON_EMOJI : DEFAULT_ICON_EMOJI;

  return (
    <TouchableOpacity
      style={[
        styles.card,
        isChecked && styles.cardChecked,
        isMissed && styles.cardMissed,
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={500}
      accessibilityRole="button"
      accessibilityLabel={`${routine.label} ${routine.time} ${isChecked ? '체크됨' : isMissed ? '놓침' : '미체크'}`}
      accessibilityState={{ checked: isChecked }}
      testID={`routine-card-${routine.id}`}
    >
      {/* 색상 태그 띠 */}
      <View
        style={[styles.colorStripe, { backgroundColor: colorTag }]}
        testID={`color-stripe-${routine.id}`}
      />

      {/* 썸네일 또는 아이콘 */}
      <View style={styles.cardThumbnail} testID={`card-thumbnail-${routine.id}`}>
        {routine.photoBase64 ? (
          <Image
            source={{ uri: routine.photoBase64 }}
            style={styles.thumbnailImage}
            accessibilityLabel={`${routine.label} 사진`}
          />
        ) : (
          <View style={[styles.thumbnailIcon, { backgroundColor: colorTag + '22' }]}>
            <Text style={styles.thumbnailEmoji}>{iconEmoji}</Text>
          </View>
        )}
      </View>

      {/* 카드 본문 */}
      <View style={styles.cardBody}>
        <Text
          style={[styles.cardLabel, isChecked && styles.cardLabelChecked]}
          numberOfLines={1}
        >
          {routine.label}
        </Text>
        <Text style={[styles.cardTime, isChecked && styles.cardTimeChecked]}>
          {routine.time}
        </Text>
        {isMissed && (
          <Text style={styles.missedBadge} testID={`missed-badge-${routine.id}`}>
            어제 놓쳤어요
          </Text>
        )}
      </View>

      {/* 케밥 메뉴 — 꾹 누르기와 동일 메뉴 노출 (발견성 보강) */}
      <TouchableOpacity
        style={styles.cardMenuButton}
        onPress={onLongPress}
        accessibilityRole="button"
        accessibilityLabel={`${routine.label} 더보기 메뉴`}
        hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
        testID={`routine-menu-${routine.id}`}
      >
        <Text style={styles.cardMenuIcon}>⋮</Text>
      </TouchableOpacity>

      {/* 상태 뱃지 */}
      <View style={styles.cardStatus}>
        {isChecked ? (
          <Text style={styles.checkEmoji} testID={`check-done-${routine.id}`}>
            ✅
          </Text>
        ) : isMissed ? (
          <Text style={styles.missedEmoji}>⚠️</Text>
        ) : (
          <View
            style={styles.uncheckCircle}
            testID={`check-pending-${routine.id}`}
          />
        )}
      </View>
    </TouchableOpacity>
  );
}

// ─── 스타일 ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // 레이아웃
  container: {
    flex: 1,
    backgroundColor: '#F8F9FA',
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#F8F9FA',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    fontSize: 16,
    color: '#8B95A1',
  },

  // 헤더
  header: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 56 : 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F2F4F6',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  headerTextArea: {
    flex: 1,
    gap: 4,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#191F28',
  },
  headerSubtitle: {
    fontSize: 16,
    color: '#6B7684',
    fontWeight: '400',
  },

  // 배지 버튼 (헤더 우측)
  badgeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  badgeButtonEmoji: {
    fontSize: 26,
  },

  // 스트릭 배지
  // Ref: PRD step-06 §출력 "16px 이상, 브랜드 코랄 #FF6B6B"
  streakBadge: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 10,
    backgroundColor: '#FFF0F0',
    borderRadius: 20,
    minHeight: 32,
    justifyContent: 'center',
  },
  streakText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FF6B6B',
  },
  streakTextZero: {
    color: '#B0B8C1',
    fontWeight: '400',
    fontSize: 14,
  },

  // Step 5: 어제 MISSED 소프트 배너
  missedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF3E0',
    borderBottomWidth: 1,
    borderBottomColor: '#FFD8A8',
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: 44,
  },
  missedBannerText: {
    flex: 1,
    fontSize: 14,
    color: '#E07A00',
    fontWeight: '500',
  },
  missedBannerClose: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    minWidth: 36,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  missedBannerCloseText: {
    fontSize: 15,
    color: '#B36200',
    fontWeight: '600',
  },

  // 빈 상태
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingBottom: 100,
  },
  emptyIcon: {
    fontSize: 56,
    marginBottom: 16,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#4E5968',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptySubtext: {
    fontSize: 16,
    color: '#8B95A1',
    textAlign: 'center',
  },

  // 리스트
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },

  // 카드
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    marginBottom: 10,
    overflow: 'hidden',
    minHeight: 72,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  cardChecked: {
    opacity: 0.55,
  },
  cardMissed: {
    borderLeftWidth: 0,
    backgroundColor: '#FFF8F0',
  },
  colorStripe: {
    width: 6,
    alignSelf: 'stretch',
  },
  cardThumbnail: {
    marginLeft: 12,
    marginRight: 12,
  },
  thumbnailImage: {
    width: 48,
    height: 48,
    borderRadius: 10,
  },
  thumbnailIcon: {
    width: 48,
    height: 48,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnailEmoji: {
    fontSize: 26,
  },
  cardBody: {
    flex: 1,
    paddingVertical: 14,
    gap: 3,
  },
  cardLabel: {
    fontSize: 17,
    fontWeight: '600',
    color: '#191F28',
  },
  cardLabelChecked: {
    color: '#8B95A1',
    textDecorationLine: 'line-through',
  },
  cardTime: {
    fontSize: 15,
    color: '#6B7684',
  },
  cardTimeChecked: {
    color: '#B0B8C1',
  },
  missedBadge: {
    fontSize: 13,
    color: '#FF9F40',
    fontWeight: '500',
    marginTop: 2,
  },
  cardStatus: {
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 48,
    minHeight: 48,
  },
  checkEmoji: {
    fontSize: 24,
  },
  missedEmoji: {
    fontSize: 22,
  },
  uncheckCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: '#D1D6DB',
    backgroundColor: '#FFFFFF',
  },
  cardMenuButton: {
    width: 28,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 2,
  },
  cardMenuIcon: {
    fontSize: 22,
    color: '#8B95A1',
    fontWeight: '600',
    lineHeight: 24,
  },

  // FAB
  fab: {
    position: 'absolute',
    right: 20,
    bottom: Platform.OS === 'ios' ? 110 : 90,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#FF6B6B',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#FF6B6B',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 6,
    zIndex: 10,
  },
  fabText: {
    fontSize: 28,
    color: '#FFFFFF',
    fontWeight: '300',
    lineHeight: 32,
  },

  // 광고 배너
  adContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#F2F4F6',
    paddingBottom: Platform.OS === 'ios' ? 20 : 8,
  },
  adContainerHidden: {
    display: 'none',
  },
  adBannerWrapper: {
    width: '100%',
    height: 96,
    overflow: 'hidden',
  },
  removeAdsLink: {
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    minHeight: 36,
    justifyContent: 'center',
  },
  removeAdsLinkText: {
    fontSize: 13,
    color: '#8B95A1',
    textDecorationLine: 'underline',
  },

  // 토스트
  toast: {
    position: 'absolute',
    bottom: 160,
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

  // 길게 누르기 메뉴
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  menuContent: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 16,
    paddingBottom: Platform.OS === 'ios' ? 36 : 20,
  },
  menuTitle: {
    fontSize: 15,
    color: '#8B95A1',
    textAlign: 'center',
    paddingVertical: 8,
    paddingHorizontal: 20,
  },
  menuItem: {
    paddingVertical: 18,
    paddingHorizontal: 20,
    minHeight: 56,
    justifyContent: 'center',
  },
  menuItemText: {
    fontSize: 17,
    color: '#191F28',
    fontWeight: '500',
  },
  menuItemDelete: {
    color: '#FF6B6B',
  },
  menuItemClose: {
    fontSize: 17,
    color: '#6B7684',
    fontWeight: '500',
  },
  menuDivider: {
    height: 1,
    backgroundColor: '#F2F4F6',
    marginHorizontal: 0,
  },

  // 삭제 확인 바텀시트
  deleteSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 28,
    paddingHorizontal: 24,
    paddingBottom: Platform.OS === 'ios' ? 40 : 28,
  },
  deleteTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#191F28',
    marginBottom: 8,
  },
  deleteBody: {
    fontSize: 15,
    color: '#6B7684',
    marginBottom: 28,
  },
  deleteButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  deleteButton: {
    flex: 1,
    height: 52,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  deleteButtonClose: {
    backgroundColor: '#F2F4F6',
  },
  deleteButtonConfirm: {
    backgroundColor: '#FF6B6B',
  },
  deleteButtonCloseText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#4E5968',
  },
  deleteButtonConfirmText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },

  // ── Step 6: 복약률 카드 ──────────────────────────────────────────────────
  adherenceCardWrapper: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 100,
  },
  adherenceCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 20,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  adherenceHeader: {
    marginBottom: 16,
  },
  adherenceTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#191F28',
  },
  adherenceBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
  },
  adherenceDesc: {
    flex: 1,
    gap: 4,
  },
  adherencePercent: {
    fontSize: 28,
    fontWeight: '800',
    color: '#FF6B6B',
  },
  adherenceLabel: {
    fontSize: 14,
    color: '#6B7684',
  },
  adherenceEmpty: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  adherenceEmptyText: {
    fontSize: 14,
    color: '#8B95A1',
    textAlign: 'center',
  },

  // ── Step 7: 포인트 카드 ────────────────────────────────────────────────────
  // Ref: PRD step-07 §출력 "이번 달 적립 {N}포인트"
  rewardCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 20,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  rewardCardHeader: {
    marginBottom: 12,
  },
  rewardCardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#191F28',
  },
  rewardCardBody: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
  },
  rewardPointAmount: {
    fontSize: 28,
    fontWeight: '800',
    color: '#3182F6',
  },
  rewardPointUnit: {
    fontSize: 16,
    fontWeight: '600',
    color: '#3182F6',
  },
  rewardCardEmpty: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  rewardCardEmptyText: {
    fontSize: 14,
    color: '#8B95A1',
    textAlign: 'center',
  },

  // ── Step 6: 원형 프로그레스 ────────────────────────────────────────────────
  ringContainer: {
    position: 'relative',
  },
  ringBackground: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  ringHalfWrapper: {
    position: 'absolute',
    top: 0,
    overflow: 'hidden',
  },
  ringHalf: {
    position: 'absolute',
    top: 0,
    left: 0,
    // 오른쪽 절반만 보이도록 (왼쪽 절반은 wrapper overflow:hidden으로 clip)
    borderTopColor: 'transparent',
    borderLeftColor: 'transparent',
  },
  ringHalfLeft: {
    position: 'absolute',
    top: 0,
    right: 0,
    // 왼쪽 절반만 보이도록
    borderTopColor: 'transparent',
    borderRightColor: 'transparent',
  },
  ringInner: {
    position: 'absolute',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringPercent: {
    fontSize: 20,
    fontWeight: '800',
    color: '#191F28',
    lineHeight: 24,
  },
  ringPercentSign: {
    fontSize: 11,
    color: '#6B7684',
    lineHeight: 14,
  },

  // ── Step 6: 배지 축하 모달 ─────────────────────────────────────────────────
  // Ref: references/dev-guide/design/consumer-ux-guide.md §1~5 (다크패턴 5종 방지)
  celebrateOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  celebrateCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    paddingTop: 48,
    paddingBottom: 28,
    paddingHorizontal: 28,
    alignItems: 'center',
    width: '100%',
    maxWidth: 320,
  },
  celebrateClose: {
    position: 'absolute',
    top: 16,
    right: 16,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  celebrateCloseText: {
    fontSize: 18,
    color: '#8B95A1',
    fontWeight: '500',
  },
  celebrateEmoji: {
    fontSize: 56,
    marginBottom: 16,
  },
  celebrateTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#191F28',
    textAlign: 'center',
    marginBottom: 8,
    lineHeight: 28,
  },
  celebrateDesc: {
    fontSize: 15,
    color: '#6B7684',
    textAlign: 'center',
    marginBottom: 28,
  },
  celebrateConfirm: {
    backgroundColor: '#FF6B6B',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 40,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  celebrateConfirmText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});

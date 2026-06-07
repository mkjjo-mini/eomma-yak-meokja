/**
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-02-registration.md §도메인 모델
 *  - references/sdk/framework/저장소/Storage.md (Storage.setItem/getItem 문자열 직렬화)
 */

export type MedicationItem = {
  /** MED-{routineId}-{순번} */
  id: string;
  /** 약 이름 (입력 시 필수, 전체 배열은 선택) */
  name: string;
  /** 용량 (예: "1정", "5ml") — 선택 */
  dose?: string;
  /** 약 종류 아이콘 — 선택 (약마다 다를 수 있음) */
  iconType?: 'pill' | 'supplement' | 'syrup' | 'powder' | 'etc';
  /** 팔레트 색상 코드 — 선택 (약마다 다를 수 있음) */
  colorTag?: string;
};

export type MealTiming = 'before' | 'after';

export type DoseRoutine = {
  /** RTN-{profileId}-{순번} */
  id: string;
  /** 회차 레이블 (필수, ≤15자) */
  label: string;
  /** 복용 시간 "HH:MM" (필수) */
  time: string;
  /** 식전/식후 — 선택 (없으면 표시 안 함) */
  mealTiming?: MealTiming;
  frequency: 'daily' | 'weekly';
  /** 0-6 (월~일), frequency='weekly'일 때만 유효 */
  weekdays?: number[];
  /** data:image/jpeg;base64,... — 선택 */
  photoBase64?: string;
  /** 약 종류 아이콘 — 선택 */
  iconType?: 'pill' | 'supplement' | 'syrup' | 'powder' | 'etc';
  /** 팔레트 색상 코드 — 선택 */
  colorTag?: string;
  /** 구성 약 상세 — 선택 (0개도 OK) */
  medications?: MedicationItem[];
  createdAt: string;
};

export const MEAL_TIMING_LABELS: Record<MealTiming, string> = {
  before: '식전',
  after: '식후',
};

/** Storage key 상수 */
export const STORAGE_KEYS = {
  PROFILE_NICKNAME: 'profile.nickname',
  ROUTINES: 'routines',
} as const;

/** 색상 팔레트 8종 */
export const COLOR_PALETTE = [
  '#FF6B6B',
  '#FF9F40',
  '#FFD93D',
  '#6BCB77',
  '#4D96FF',
  '#845EC2',
  '#F9A8D4',
  '#94A3B8',
] as const;

export type ColorTag = (typeof COLOR_PALETTE)[number];

/** 약 종류 아이콘 5종 레이블 */
export const ICON_TYPE_LABELS: Record<DoseRoutine['iconType'] & string, string> = {
  pill: '알약',
  supplement: '영양제',
  syrup: '시럽',
  powder: '분말',
  etc: '기타',
};

/** 약 종류 아이콘 5종 이모지 */
export const ICON_EMOJI: Record<DoseRoutine['iconType'] & string, string> = {
  pill: '💊',
  supplement: '🧴',
  syrup: '🍶',
  powder: '🫙',
  etc: '🩹',
};

export const DEFAULT_ICON_EMOJI = '💊';
export const DEFAULT_COLOR = '#FF6B6B';

/** 요일 레이블 (0=월 ~ 6=일) */
export const WEEKDAY_LABELS = ['월', '화', '수', '목', '금', '토', '일'] as const;

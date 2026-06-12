/**
 * Step 5 — 홈 화면 소프트 배너 + flushMissedRecords 호출 테스트
 *
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-05-reminder.md §출력
 *    "홈 화면 '어제 놓친 회차 N개' 소프트 알림 배너 (상단)"
 *  - PRD step-05 §검수
 *    "홈 상단 '어제 N개 놓쳤어요' 배너 조건부 표시 (닫기 포함)"
 *    "flushMissedRecords 앱 진입 시 호출"
 *  - references/dev-guide/design/consumer-ux-guide.md §1,3
 *    (진입 즉시 전면 바텀시트 금지, 거절 선택지 있음)
 *  - references/dev-guide/design/ux-writing.md (해요체, 능동형)
 */

// ─── SDK / Navigation mock ────────────────────────────────────────────────────

const storageStore: Record<string, string> = {};

jest.mock('@apps-in-toss/framework', () => {
  const React = require('react');
  const { View } = require('react-native');

  const MockInlineAd = (props: {
    onAdRendered?: () => void;
    [key: string]: unknown;
  }) => {
    const { onAdRendered, ...rest } = props;
    React.useEffect(() => {
      onAdRendered?.();
    }, [onAdRendered]);
    return React.createElement(View, { testID: 'mock-inline-ad', ...rest });
  };
  MockInlineAd.displayName = 'InlineAd';

  return {
    Storage: {
      getItem: jest.fn(async (key: string) => storageStore[key] ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        storageStore[key] = value;
      }),
      removeItem: jest.fn(async (key: string) => {
        delete storageStore[key];
      }),
      clearItems: jest.fn(),
    },
    isMinVersionSupported: jest.fn(() => true),
    generateHapticFeedback: jest.fn(() => Promise.resolve()),
    InlineAd: MockInlineAd,
  };
});

const mockNavigate = jest.fn();
const mockAddListener = jest.fn(() => jest.fn());

jest.mock('@granite-js/react-native', () => {
  const React = require('react');
  const { FlatList } = require('react-native');

  const MockIOFlatList = (props: React.ComponentProps<typeof FlatList>) =>
    React.createElement(FlatList, props);
  MockIOFlatList.displayName = 'IOFlatList';

  return {
    createRoute: (_path: string, { component }: { component: unknown }) => ({
      component,
    }),
    useNavigation: () => ({
      navigate: mockNavigate,
      canGoBack: () => false,
      goBack: jest.fn(),
      addListener: mockAddListener,
    }),
    IOFlatList: MockIOFlatList,
  };
});

// ─── recordService mock ───────────────────────────────────────────────────────
// flushMissedRecords를 포함한 전체 mock.
// 기존 index.test.tsx와 동일한 패턴을 따르되 flushMissedRecords 추가.

jest.mock('../../src/services/recordService', () => ({
  getKSTDateString: jest.fn(() => '2026-04-25'),
  getKSTWeekday: jest.fn(() => 4),
  getKSTYesterdayString: jest.fn(() => '2026-04-24'),
  filterTodayRoutines: jest.fn((routines: unknown[]) => routines),
  getOrCreatePendingRecord: jest.fn(async (routineId: string, date: string) => ({
    id: `REC-${routineId}-${date.replace(/-/g, '')}`,
    routineId,
    date,
    status: 'PENDING',
  })),
  getRecords: jest.fn(async () => []),
  getYesterdayMissedItems: jest.fn(async () => []),
  toggleCheck: jest.fn(async (routineId: string, date: string) => ({
    id: `REC-${routineId}-${date.replace(/-/g, '')}`,
    routineId,
    date,
    status: 'CHECKED',
    checkedAt: new Date().toISOString(),
  })),
  buildRecordId: jest.fn(
    (routineId: string, dateStr: string) =>
      `REC-${routineId}-${dateStr.replace(/-/g, '')}`,
  ),
  // Step 5 신규 — jest.fn()으로 선언해야 mock 모듈 내에서 함수로 인식됨
  flushMissedRecords: jest.fn(async () => undefined),
  // Step 6 신규 — 스트릭·복약률·배지
  calcStreak: jest.fn(() => 0),
  calcMonthlyAdherence: jest.fn(() => 0),
  calcMonthlyAdherenceWithSchedule: jest.fn(() => 0),
  unlockBadgeIfQualified: jest.fn(async () => null),
  getEarnedBadges: jest.fn(async () => []),
}));

// ─── storageService mock ──────────────────────────────────────────────────────

jest.mock('../../src/services/storageService', () => ({
  getNickname: jest.fn(async () => '본인'),
  getRoutines: jest.fn(async () => []),
  saveRoutine: jest.fn(),
  generateRoutineId: jest.fn(async () => 'RTN-test-1'),
  generateMedId: jest.fn(),
  validateLabel: jest.fn(() => ({ valid: true })),
  validateTime: jest.fn(() => ({ valid: true })),
  validateWeekdays: jest.fn(() => ({ valid: true })),
}));

// ─── scheduleService mock ─────────────────────────────────────────────────────

jest.mock('../../src/services/scheduleService', () => ({
  flushPendingQueue: jest.fn(async () => undefined),
  deleteSchedule: jest.fn(async () => undefined),
  upsertSchedule: jest.fn(async () => undefined),
}));

// ─── imports ─────────────────────────────────────────────────────────────────

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { Route } from '../../src/pages/index';
import { getNickname, getRoutines } from '../../src/services/storageService';
import {
  filterTodayRoutines,
  getOrCreatePendingRecord,
  getYesterdayMissedItems,
  flushMissedRecords,
} from '../../src/services/recordService';
import type { DoseRoutine } from '../../src/types/routine';
import type { DoseRecord } from '../../src/types/record';

type RouteType = { component: React.ComponentType };

function renderHome() {
  const HomeComponent = (Route as unknown as RouteType).component;
  return render(<HomeComponent />);
}

function makeRoutine(overrides: Partial<DoseRoutine> = {}): DoseRoutine {
  return {
    id: 'RTN-test-1',
    label: '아침약',
    time: '09:00',
    frequency: 'daily',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── beforeEach ───────────────────────────────────────────────────────────────

beforeEach(() => {
  Object.keys(storageStore).forEach((k) => delete storageStore[k]);
  jest.clearAllMocks();
  mockNavigate.mockClear();

  (getNickname as jest.Mock).mockResolvedValue('본인');
  (getRoutines as jest.Mock).mockResolvedValue([]);
  (filterTodayRoutines as jest.Mock).mockImplementation((routines) => routines);
  (getOrCreatePendingRecord as jest.Mock).mockImplementation(
    async (routineId: string, date: string) => ({
      id: `REC-${routineId}-${date.replace(/-/g, '')}`,
      routineId,
      date,
      status: 'PENDING',
    }),
  );
  (getYesterdayMissedItems as jest.Mock).mockResolvedValue([]);
  (flushMissedRecords as jest.Mock).mockResolvedValue(undefined);
});

// ─── flushMissedRecords 호출 검증 ─────────────────────────────────────────────

describe('flushMissedRecords 앱 진입 시 호출', () => {
  // PRD step-05 §검수 "flushMissedRecords 앱 진입 시 호출"
  it('홈 화면 진입 시 flushMissedRecords가 호출되어야 한다', async () => {
    renderHome();
    await waitFor(() => {
      expect(flushMissedRecords).toHaveBeenCalled();
    });
  });

  it('flushMissedRecords 실패해도 홈 화면이 정상 렌더링되어야 한다', async () => {
    (flushMissedRecords as jest.Mock).mockRejectedValueOnce(new Error('Storage 오류'));
    renderHome();
    await waitFor(() => {
      expect(screen.getByTestId('home-header')).toBeTruthy();
    });
  });
});

// ─── 어제 MISSED 소프트 배너 ──────────────────────────────────────────────────

describe('어제 MISSED 소프트 배너', () => {
  // PRD step-05 §출력 "홈 화면 '어제 놓친 회차 N개' 소프트 알림 배너 (상단)"
  it('어제 MISSED 1개 이상이면 배너가 표시되어야 한다', async () => {
    const routine = makeRoutine();
    (getRoutines as jest.Mock).mockResolvedValue([routine]);

    const missedRecord: DoseRecord = {
      id: 'REC-RTN-test-1-20260424',
      routineId: 'RTN-test-1',
      date: '2026-04-24',
      status: 'MISSED',
    };
    (getYesterdayMissedItems as jest.Mock).mockResolvedValue([
      { routine, record: missedRecord },
    ]);

    renderHome();

    await waitFor(() => {
      expect(screen.getByTestId('missed-banner')).toBeTruthy();
    });
  });

  // PRD step-05 §검수 "어제 {N}개 회차를 놓쳤어요"
  it('배너 텍스트에 어제 놓친 개수(N)가 표시되어야 한다', async () => {
    const routines = [
      makeRoutine({ id: 'RTN-1', label: '아침약' }),
      makeRoutine({ id: 'RTN-2', label: '저녁약', time: '21:00' }),
    ];
    (getRoutines as jest.Mock).mockResolvedValue(routines);

    const missedRecords = routines.map((r) => ({
      routine: r,
      record: {
        id: `REC-${r.id}-20260424`,
        routineId: r.id,
        date: '2026-04-24',
        status: 'MISSED' as const,
      },
    }));
    (getYesterdayMissedItems as jest.Mock).mockResolvedValue(missedRecords);

    renderHome();

    await waitFor(() => {
      expect(screen.getByText('어제 2개 회차를 놓쳤어요')).toBeTruthy();
    });
  });

  // PRD step-05 §검수 "해당 없으면 미표시"
  it('어제 MISSED 없으면 배너가 표시되지 않아야 한다', async () => {
    (getYesterdayMissedItems as jest.Mock).mockResolvedValue([]);

    renderHome();

    await waitFor(() => {
      // 로딩 완료 대기
      expect(screen.queryByTestId('loading-container')).toBeNull();
    });
    expect(screen.queryByTestId('missed-banner')).toBeNull();
  });

  // PRD step-05 §검수 "닫기 포함" (다크패턴 방지 §3: 거절 선택지 있음)
  it('배너에 닫기 버튼이 있어야 한다', async () => {
    const routine = makeRoutine();
    (getRoutines as jest.Mock).mockResolvedValue([routine]);
    (getYesterdayMissedItems as jest.Mock).mockResolvedValue([
      {
        routine,
        record: {
          id: 'REC-RTN-test-1-20260424',
          routineId: 'RTN-test-1',
          date: '2026-04-24',
          status: 'MISSED' as const,
        },
      },
    ]);

    renderHome();

    await waitFor(() => {
      expect(screen.getByTestId('missed-banner-close')).toBeTruthy();
    });
  });

  // 다크패턴 방지: 닫기 시 배너 사라짐 (강제 팝업 아님)
  it('닫기 버튼 탭 시 배너가 사라져야 한다', async () => {
    const routine = makeRoutine();
    (getRoutines as jest.Mock).mockResolvedValue([routine]);
    (getYesterdayMissedItems as jest.Mock).mockResolvedValue([
      {
        routine,
        record: {
          id: 'REC-RTN-test-1-20260424',
          routineId: 'RTN-test-1',
          date: '2026-04-24',
          status: 'MISSED' as const,
        },
      },
    ]);

    renderHome();

    await waitFor(() => {
      expect(screen.getByTestId('missed-banner')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('missed-banner-close'));

    await waitFor(() => {
      expect(screen.queryByTestId('missed-banner')).toBeNull();
    });
  });

  // Ref: references/dev-guide/design/ux-writing.md (해요체, 능동형)
  it('배너 텍스트는 해요체("놓쳤어요")를 사용해야 한다', async () => {
    const routine = makeRoutine();
    (getRoutines as jest.Mock).mockResolvedValue([routine]);
    (getYesterdayMissedItems as jest.Mock).mockResolvedValue([
      {
        routine,
        record: {
          id: 'REC-RTN-test-1-20260424',
          routineId: 'RTN-test-1',
          date: '2026-04-24',
          status: 'MISSED' as const,
        },
      },
    ]);

    renderHome();

    await waitFor(() => {
      const bannerText = screen.getByTestId('missed-banner-text');
      expect(bannerText.props.children).toMatch(/놓쳤어요/);
    });
  });

  // 다크패턴 §1: 진입 즉시 전면 바텀시트 아님 — 인라인 배너만
  it('배너는 전면 팝업/바텀시트가 아닌 인라인 배너여야 한다', async () => {
    const routine = makeRoutine();
    (getRoutines as jest.Mock).mockResolvedValue([routine]);
    (getYesterdayMissedItems as jest.Mock).mockResolvedValue([
      {
        routine,
        record: {
          id: 'REC-RTN-test-1-20260424',
          routineId: 'RTN-test-1',
          date: '2026-04-24',
          status: 'MISSED' as const,
        },
      },
    ]);

    renderHome();

    await waitFor(() => {
      expect(screen.getByTestId('missed-banner')).toBeTruthy();
    });

    // 삭제 모달이나 메뉴 모달과 별개 (Modal 컴포넌트가 아닌 View)
    expect(screen.queryByTestId('long-press-menu-modal')).toBeNull();
    expect(screen.queryByTestId('delete-confirm-modal')).toBeNull();
  });

  it('배너 텍스트 탭 시 달력 화면으로 이동해야 한다', async () => {
    // PRD step-05 §행동 "홈 상단 배너 탭 → 어제 캘린더 뷰"
    const routine = makeRoutine();
    (getRoutines as jest.Mock).mockResolvedValue([routine]);
    (getYesterdayMissedItems as jest.Mock).mockResolvedValue([
      {
        routine,
        record: {
          id: 'REC-RTN-test-1-20260424',
          routineId: 'RTN-test-1',
          date: '2026-04-24',
          status: 'MISSED' as const,
        },
      },
    ]);

    renderHome();

    await waitFor(() => {
      expect(screen.getByTestId('missed-banner-text-button')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('missed-banner-text-button'));
    expect(mockNavigate).toHaveBeenCalledWith('/calendar');
  });
});

// ─── 기존 동작 회귀 방지 ─────────────────────────────────────────────────────

describe('Step 5 추가 후 기존 동작 회귀 없음', () => {
  it('별명이 없으면 여전히 온보딩으로 리다이렉트되어야 한다', async () => {
    (getNickname as jest.Mock).mockResolvedValue(null);
    renderHome();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/onboarding/name');
    });
  });

  it('회차가 없으면 빈 상태가 표시되어야 한다', async () => {
    (getRoutines as jest.Mock).mockResolvedValue([]);
    renderHome();
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toBeTruthy();
    });
  });

  it('FAB "+" 버튼이 정상 동작해야 한다', async () => {
    renderHome();
    await waitFor(() => {
      expect(screen.getByTestId('fab-add')).toBeTruthy();
    });
    fireEvent.press(screen.getByTestId('fab-add'));
    expect(mockNavigate).toHaveBeenCalledWith('/routines/add');
  });

  it('홈 화면 진입 시 fetch가 호출되지 않아야 한다 (로컬 only 계약 유지)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as never);
    renderHome();
    await waitFor(() => {
      expect(screen.queryByTestId('loading-container')).toBeNull();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

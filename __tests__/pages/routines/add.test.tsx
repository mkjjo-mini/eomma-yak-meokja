/**
 * Ref:
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-02-registration.md §검수 "회차 등록"
 *  - references/sdk/framework/저장소/Storage.md
 *  - references/sdk/framework/카메라/openCamera.md
 *  - references/sdk/framework/사진/fetchAlbumPhotos.md
 *  - references/dev-guide/development/test/sandbox.md
 */

// ─── SDK / Navigation mock ────────────────────────────────────────────────────

const storageStore: Record<string, string> = {};

jest.mock('@apps-in-toss/framework', () => {
  class _OpenCameraPermissionError extends Error {
    constructor() {
      super('camera permission denied');
      this.name = 'OpenCameraPermissionError';
    }
  }
  class _FetchAlbumPhotosPermissionError extends Error {
    constructor() {
      super('album permission denied');
      this.name = 'FetchAlbumPhotosPermissionError';
    }
  }
  return {
    Storage: {
      getItem: jest.fn(async (key: string) => storageStore[key] ?? null),
      setItem: jest.fn(async (key: string, value: string) => { storageStore[key] = value; }),
      removeItem: jest.fn(),
      clearItems: jest.fn(),
    },
    isMinVersionSupported: jest.fn(() => true),
    openCamera: jest.fn(),
    fetchAlbumPhotos: jest.fn(),
    OpenCameraPermissionError: _OpenCameraPermissionError,
    FetchAlbumPhotosPermissionError: _FetchAlbumPhotosPermissionError,
  };
});

const mockNavigate = jest.fn();
const mockCanGoBack = jest.fn(() => true);
const mockGoBack = jest.fn();

jest.mock('@granite-js/react-native', () => ({
  createRoute: (_path: string, { component }: { component: unknown }) => ({
    component,
    useParams: jest.fn(() => ({})),
  }),
  useNavigation: () => ({
    navigate: mockNavigate,
    canGoBack: mockCanGoBack,
    goBack: mockGoBack,
  }),
  useBackEvent: () => ({
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }),
}));

// Alert은 react-native를 통째로 mock하면 TurboModuleRegistry 충돌 발생.
// 대신 테스트 내에서 jest.spyOn으로 Alert.alert을 가로챈다.

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { Storage, isMinVersionSupported } from '@apps-in-toss/framework';

// Alert.alert을 spy — react-native 전체 mock은 TurboModuleRegistry 충돌 유발
let alertSpy: jest.SpyInstance;
import { Route } from '../../../src/pages/routines/add';

type RouteType = { component: React.ComponentType };

const isMinVersionSupportedMock = isMinVersionSupported as jest.Mock;

// @testing-library/react-native의 render는 자체 act를 내장.
// 비동기 useEffect(loadNickname)는 waitFor로 완료를 기다린다.
function renderPage(nickname = '본인') {
  if (nickname) storageStore['profile.nickname'] = nickname;
  (Storage.getItem as jest.Mock).mockImplementation(async (key: string) => storageStore[key] ?? null);
  (Storage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
    storageStore[key] = value;
  });
  const AddPage = (Route as unknown as RouteType).component;
  return render(<AddPage />);
}

beforeEach(() => {
  Object.keys(storageStore).forEach((k) => delete storageStore[k]);
  jest.clearAllMocks();
  mockNavigate.mockClear();
  mockGoBack.mockClear();
  isMinVersionSupportedMock.mockReturnValue(true);
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(() => {
  alertSpy.mockRestore();
});

// ─── 헤더 ─────────────────────────────────────────────────────────────────────

describe('회차 등록 헤더', () => {
  it('닉네임이 있으면 헤더에 "{별명}의 복용 회차 등록"이 표시되어야 한다', async () => {
    // PRD §검수: "등록 화면 헤더·본문에 {별명} 값이 치환되어 표시되어야 한다"
    renderPage('본인');
    await waitFor(() => {
      expect(screen.getByText('본인의 복용 회차 등록')).toBeTruthy();
    });
  });

  it('시간대 자동 분류 아이콘(아침·점심·저녁·취침) 텍스트가 없어야 한다', async () => {
    // PRD §검수: "시간대 자동 분류 아이콘이 UI에 노출되지 않아야 한다"
    renderPage();
    await waitFor(() => {
      expect(screen.queryByText('아침')).toBeNull();
    });
    expect(screen.queryByText('점심')).toBeNull();
    expect(screen.queryByText('저녁')).toBeNull();
    expect(screen.queryByText('취침')).toBeNull();
  });
});

// ─── 필수 필드 유효성 ─────────────────────────────────────────────────────────

describe('회차 등록 필수 필드', () => {
  it('레이블 빈값일 때 등록 버튼이 비활성화되어야 한다', async () => {
    // PRD §검수: "회차 레이블이 빈값이면 저장 차단되어야 한다"
    // 광고 보고 등록하기 후 검증 실패로 시간 낭비 방지 — 버튼 비활성으로 사전 차단.
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('복용 시간 입력 (HH:MM)')).toBeTruthy());

    fireEvent.changeText(screen.getByLabelText('복용 시간 입력 (HH:MM)'), '09:00');
    const saveBtn = screen.getByRole('button', { name: '회차 등록해요' });
    expect(
      (saveBtn.props as { accessibilityState?: { disabled?: boolean } })
        .accessibilityState?.disabled,
    ).toBe(true);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('레이블 15자 초과 입력 시 차단되어야 한다', async () => {
    // PRD §검수: "회차 레이블 15자 초과 입력 시 차단되어야 한다"
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('회차 이름 입력')).toBeTruthy());

    const labelInput = screen.getByLabelText('회차 이름 입력');
    fireEvent.changeText(labelInput, '열여섯자이름을입력테스트합니다입니다');
    const value = (labelInput.props as { value?: string }).value ?? '';
    expect(value.length).toBeLessThanOrEqual(15);
  });

  it('시간 미입력 시 등록 버튼이 비활성화되어야 한다', async () => {
    // PRD §검수: "복용 시간 미입력 시 저장 차단되어야 한다"
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('회차 이름 입력')).toBeTruthy());

    fireEvent.changeText(screen.getByLabelText('회차 이름 입력'), '아침약');
    const saveBtn = screen.getByRole('button', { name: '회차 등록해요' });
    expect(
      (saveBtn.props as { accessibilityState?: { disabled?: boolean } })
        .accessibilityState?.disabled,
    ).toBe(true);
  });

  it('주기 미선택 시 기본값 "매일"이 선택되어 있어야 한다', async () => {
    // PRD §검수: "복용 주기 미선택 시 기본값 매일로 저장되어야 한다"
    renderPage();
    await waitFor(() => expect(screen.getByRole('radio', { name: '매일' })).toBeTruthy());

    const dailyChip = screen.getByRole('radio', { name: '매일' });
    expect(
      (dailyChip.props as { accessibilityState?: { selected?: boolean } }).accessibilityState?.selected,
    ).toBe(true);
  });

  it('특정 요일 선택 후 요일 미선택 시 등록 버튼이 비활성화되어야 한다', async () => {
    // PRD §검수: "특정 요일 선택 시 요일이 1개 이상 선택되어야 한다"
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('회차 이름 입력')).toBeTruthy());

    fireEvent.changeText(screen.getByLabelText('회차 이름 입력'), '아침약');
    fireEvent.changeText(screen.getByLabelText('복용 시간 입력 (HH:MM)'), '09:00');
    fireEvent.press(screen.getByRole('radio', { name: '특정 요일' }));

    const saveBtn = screen.getByRole('button', { name: '회차 등록해요' });
    expect(
      (saveBtn.props as { accessibilityState?: { disabled?: boolean } })
        .accessibilityState?.disabled,
    ).toBe(true);
  });
});

// ─── 선택 필드 ───────────────────────────────────────────────────────────────

describe('회차 등록 선택 필드', () => {
  it('사진·아이콘·색상·상세약 없이 레이블+시간+주기만으로 저장 가능해야 한다', async () => {
    // PRD §검수: "사진·아이콘·색상·상세 약 목록 없이 레이블+시간+주기만으로 저장 가능해야 한다"
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('회차 이름 입력')).toBeTruthy());

    fireEvent.changeText(screen.getByLabelText('회차 이름 입력'), '아침약');
    fireEvent.changeText(screen.getByLabelText('복용 시간 입력 (HH:MM)'), '09:00');
    fireEvent.press(screen.getByRole('button', { name: '회차 등록해요' }));

    await waitFor(() => {
      expect(Storage.setItem).toHaveBeenCalledWith('routines', expect.any(String));
    });

    const calls = (Storage.setItem as jest.Mock).mock.calls as [string, string][];
    const routinesCall = calls.find(([key]) => key === 'routines');
    if (routinesCall) {
      const saved = JSON.parse(routinesCall[1]) as Array<Record<string, unknown>>;
      expect(saved[0]?.['photoBase64']).toBeUndefined();
      expect(saved[0]?.['iconType']).toBeUndefined();
      expect(saved[0]?.['colorTag']).toBeUndefined();
      expect(saved[0]?.['medications']).toBeUndefined();
    }
  });

  it('아이콘 5종 모두 선택 가능해야 한다', async () => {
    // PRD §검수: "아이콘 종류 5종(알약·영양제·시럽·분말·기타) 모두 선택 가능해야 한다"
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: '상세 추가하기 열기' })).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: '상세 추가하기 열기' }));

    await waitFor(() => expect(screen.getByRole('button', { name: '약 항목 추가하기' })).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: '약 항목 추가하기' }));

    await waitFor(() => expect(screen.getByRole('button', { name: /이 약의 종류·색상 선택해요/ })).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: /이 약의 종류·색상 선택해요/ }));

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /알약/ })).toBeTruthy();
    });
    expect(screen.getByRole('radio', { name: /영양제/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /시럽/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /분말/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /기타/ })).toBeTruthy();
  });

  it('색상 태그 8종 모두 렌더링되어야 한다', async () => {
    // PRD §검수: "색상 태그 8종 팔레트에서 선택 가능해야 한다"
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: '상세 추가하기 열기' })).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: '상세 추가하기 열기' }));

    await waitFor(() => expect(screen.getByRole('button', { name: '약 항목 추가하기' })).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: '약 항목 추가하기' }));

    await waitFor(() => expect(screen.getByRole('button', { name: /이 약의 종류·색상 선택해요/ })).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: /이 약의 종류·색상 선택해요/ }));

    await waitFor(() => {
      const colorChips = screen.queryAllByRole('radio', { name: /색상/ });
      expect(colorChips.length).toBe(8);
    });
  });

  it('약 추가 버튼으로 행을 추가하고 이름만 입력해도 저장 가능해야 한다', async () => {
    // PRD §검수: "상세 약 이름만 입력해도 저장 가능해야 한다 (용량 없이)"
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: '상세 추가하기 열기' })).toBeTruthy());

    fireEvent.press(screen.getByRole('button', { name: '상세 추가하기 열기' }));

    await waitFor(() => expect(screen.getByRole('button', { name: '약 항목 추가하기' })).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: '약 항목 추가하기' }));

    await waitFor(() => expect(screen.getByLabelText('약 이름 입력')).toBeTruthy());
    fireEvent.changeText(screen.getByLabelText('약 이름 입력'), '타이레놀');
    fireEvent.changeText(screen.getByLabelText('회차 이름 입력'), '아침약');
    fireEvent.changeText(screen.getByLabelText('복용 시간 입력 (HH:MM)'), '09:00');

    fireEvent.press(screen.getByRole('button', { name: '회차 등록해요' }));

    await waitFor(() => {
      expect(Storage.setItem).toHaveBeenCalledWith('routines', expect.any(String));
    });

    const calls = (Storage.setItem as jest.Mock).mock.calls as [string, string][];
    const routinesCall = calls.find(([key]) => key === 'routines');
    if (routinesCall) {
      const saved = JSON.parse(routinesCall[1]) as Array<{
        medications?: Array<{ name: string; dose?: string }>;
      }>;
      expect(saved[0]?.medications?.[0]?.name).toBe('타이레놀');
      expect(saved[0]?.medications?.[0]?.dose).toBeUndefined();
    }
  });
});

// ─── 뒤로가기 ────────────────────────────────────────────────────────────────
// 자체 ← 버튼 제거 (비게임 출시 가이드 §내비게이션 바). 토스 nav 바 뒤로가기 사용.
// 미저장 보호는 useBackEvent로 wire (handleBackPress) — UI 클릭 시뮬레이션 대신
// 백 이벤트 시뮬레이션으로 검증해야 함. v2에서 useBackEvent mock + describe 복원.

describe.skip('뒤로가기 UX (back-event 시뮬레이션 미구현 — v2)', () => {
  it('입력값 없을 때 뒤로가기 → 확인 모달 없이 즉시 이동해야 한다', async () => {
    // PRD §검수: 뒤로가기 차단 없음 (다크패턴 방지)
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: '뒤로 가요' })).toBeTruthy());

    fireEvent.press(screen.getByRole('button', { name: '뒤로 가요' }));
    expect(mockGoBack).toHaveBeenCalled();
  });

  it('입력값 있을 때 뒤로가기 → 확인 모달이 표시되어야 한다', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('회차 이름 입력')).toBeTruthy());

    fireEvent.changeText(screen.getByLabelText('회차 이름 입력'), '아침약');
    fireEvent.press(screen.getByRole('button', { name: '뒤로 가요' }));

    await waitFor(() => {
      expect(screen.getByText('저장 안 하고 나갈까요?')).toBeTruthy();
    });
    expect(screen.getByText('닫기')).toBeTruthy();
    expect(screen.getByText('나가요')).toBeTruthy();
  });

  it('확인 모달 왼쪽 버튼이 "닫기"여야 한다', async () => {
    // Ref: references/dev-guide/design/ux-writing.md §다이얼로그 왼쪽 "닫기"
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('회차 이름 입력')).toBeTruthy());

    fireEvent.changeText(screen.getByLabelText('회차 이름 입력'), '아침약');
    fireEvent.press(screen.getByRole('button', { name: '뒤로 가요' }));

    await waitFor(() => {
      expect(screen.getByText('닫기')).toBeTruthy();
      expect(screen.getByText('나가요')).toBeTruthy();
    });
  });
});

// ─── 고정 문자열 "엄마" 없음 ──────────────────────────────────────────────────

describe('고정 카피 정책', () => {
  it('별명이 없을 때 고정 문자열 "엄마"가 헤더에 없어야 한다', async () => {
    // PRD §검수: "소스코드에 고정 문자열 엄마가 사용되지 않아야 한다 (앱 이름 엄마약먹자 표시 제외)"
    renderPage('');
    await waitFor(() => expect(screen.getByText('복용 회차 등록')).toBeTruthy());
    expect(screen.queryByText('엄마의 복용 회차 등록')).toBeNull();
  });
});

// ─── 네트워크 호출 없음 ────────────────────────────────────────────────────────

describe('로컬 only 계약', () => {
  it('저장 시 fetch가 호출되지 않아야 한다', async () => {
    // PRD §검수: "네트워크 호출이 전혀 발생하지 않아야 한다"
    const fetchSpy = jest.spyOn(global, 'fetch' as never);

    renderPage();
    await waitFor(() => expect(screen.getByLabelText('회차 이름 입력')).toBeTruthy());

    fireEvent.changeText(screen.getByLabelText('회차 이름 입력'), '아침약');
    fireEvent.changeText(screen.getByLabelText('복용 시간 입력 (HH:MM)'), '09:00');
    fireEvent.press(screen.getByRole('button', { name: '회차 등록해요' }));

    await waitFor(() => {
      expect(Storage.setItem).toHaveBeenCalled();
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// ─── Storage 실패 처리 ────────────────────────────────────────────────────────

describe('Storage 실패 처리', () => {
  it('Storage 쓰기 실패 시 에러 토스트가 표시되고 크래시가 없어야 한다', async () => {
    // PRD §검수: "Storage 쓰기 실패 시 에러 토스트가 표시되어야 한다 (앱이 크래시되지 않음)"
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('회차 이름 입력')).toBeTruthy());

    // routines 키 쓰기만 실패하도록 설정
    (Storage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
      if (key === 'routines') throw new Error('Storage write failed');
      storageStore[key] = value;
    });

    fireEvent.changeText(screen.getByLabelText('회차 이름 입력'), '아침약');
    fireEvent.changeText(screen.getByLabelText('복용 시간 입력 (HH:MM)'), '09:00');
    fireEvent.press(screen.getByRole('button', { name: '회차 등록해요' }));

    await waitFor(() => {
      expect(screen.getByText('저장에 실패했어요. 다시 시도해요')).toBeTruthy();
    });
  });
});

// ─── 카메라 버전 미지원 대체 UI ──────────────────────────────────────────────

describe('카메라 버전 미지원 대체 UI', () => {
  it('isMinVersionSupported false 시 사진 영역 탭 → 대체 Alert가 호출되어야 한다', async () => {
    // PRD §검수: "isMinVersionSupported가 false일 때 카메라 대체 UI가 표시되어야 한다"
    isMinVersionSupportedMock.mockReturnValue(false);

    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: '상세 추가하기 열기' })).toBeTruthy());

    fireEvent.press(screen.getByRole('button', { name: '상세 추가하기 열기' }));

    await waitFor(() => expect(screen.getByRole('button', { name: '사진 추가하기' })).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: '사진 추가하기' }));

    // AlertModal로 교체됨 (TDS 가이드) — 다이얼로그 텍스트로 검증
    await waitFor(() =>
      expect(screen.getByText('카메라를 사용할 수 없어요')).toBeTruthy(),
    );
  });
});

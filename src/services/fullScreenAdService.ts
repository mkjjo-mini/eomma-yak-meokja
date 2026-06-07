/**
 * Full Screen Ad Service — 전면 광고 + 보상형 광고 통합 래퍼.
 *
 * Apps-in-Toss IntegratedAd SDK 사용:
 *  - 전면(Interstitial)·보상형(Rewarded) 동일 API (loadFullScreenAd / showFullScreenAd)
 *  - 광고 타입은 adGroupId로 자동 결정 (콘솔에서 발급)
 *
 * Ref: references/sdk/framework/광고/IntegratedAd.md
 *
 * 최소 버전:
 *  - 5.244.1+ : 토스 애즈 + AdMob 통합 (인앱 광고 2.0 ver2)
 *  - 5.227.0+ : AdMob 단독
 *  - 5.227.0 미만 : 미지원
 */

import {
  loadFullScreenAd,
  showFullScreenAd,
} from '@apps-in-toss/framework';

// ─── 광고 그룹 ID (콘솔 발급 라이브 ID) ─────────────────────────────────────

/** 보상형 광고 — 회차 등록 시 사용자 자발 시청 */
export const REWARDED_AD_GROUP_ID = 'ait.v2.live.ffabc7c4d9e04256';

/** 전면 광고 — 복약 체크 직후 자동 노출 */
export const INTERSTITIAL_AD_GROUP_ID = 'ait.v2.live.0bdff19530054060';

// ─── 지원 여부 ───────────────────────────────────────────────────────────

export function isFullScreenAdSupported(): boolean {
  return (
    typeof loadFullScreenAd !== 'undefined' &&
    typeof loadFullScreenAd.isSupported === 'function' &&
    loadFullScreenAd.isSupported()
  );
}

// ─── 광고 로드 ───────────────────────────────────────────────────────────

export type LoadAdResult =
  | { kind: 'loaded'; cleanup: () => void }
  | { kind: 'unsupported' }
  | { kind: 'failed'; reason: string };

/**
 * 광고를 미리 로드. 컴포넌트 마운트 시 호출하고 cleanup은 언마운트 시 호출.
 *
 * Ref: IntegratedAd.md §광고 로드 타이밍
 *   "광고는 표시하기 전에 미리 로드하는 것을 권장"
 */
export function loadAd(
  adGroupId: string,
  onLoaded: () => void,
  onError?: (err: unknown) => void,
): LoadAdResult {
  if (!isFullScreenAdSupported()) {
    return { kind: 'unsupported' };
  }
  try {
    const cleanup = loadFullScreenAd({
      options: { adGroupId },
      onEvent: (event) => {
        if (event.type === 'loaded') {
          onLoaded();
        }
      },
      onError: (err) => {
        onError?.(err);
      },
    });
    return { kind: 'loaded', cleanup };
  } catch (err) {
    return { kind: 'failed', reason: String(err) };
  }
}

// ─── 광고 표시 ───────────────────────────────────────────────────────────

export type ShowAdResult =
  | { kind: 'rewarded'; unitType: string; unitAmount: number }
  | { kind: 'dismissed' }
  | { kind: 'failed'; reason: string }
  | { kind: 'unsupported' };

/**
 * 로드된 광고를 표시. Promise 기반으로 결과를 한 번에 받음.
 *
 *  - 보상형: userEarnedReward 받으면 'rewarded', 그 후 dismissed
 *  - 전면형: dismissed만 발화 (보상 없음)
 *  - 실패: failedToShow 또는 onError → 'failed'
 *
 * Ref: IntegratedAd.md §리워드 광고 처리
 *   "userEarnedReward 이벤트가 발생했을 때만 리워드를 지급"
 *   "dismissed만으로는 지급하면 안 돼요"
 */
export function showAd(adGroupId: string): Promise<ShowAdResult> {
  if (
    !showFullScreenAd ||
    typeof showFullScreenAd.isSupported !== 'function' ||
    !showFullScreenAd.isSupported()
  ) {
    return Promise.resolve({ kind: 'unsupported' });
  }

  return new Promise<ShowAdResult>((resolve) => {
    let settled = false;
    let earnedReward: { unitType: string; unitAmount: number } | null = null;

    function settle(result: ShowAdResult) {
      if (settled) return;
      settled = true;
      cleanup?.();
      resolve(result);
    }

    const cleanup = showFullScreenAd({
      options: { adGroupId },
      onEvent: (event) => {
        switch (event.type) {
          case 'userEarnedReward':
            // 보상형: 리워드 정보 보관해뒀다가 dismissed 시 함께 반환
            earnedReward = event.data;
            break;
          case 'dismissed':
            if (earnedReward) {
              settle({
                kind: 'rewarded',
                unitType: earnedReward.unitType,
                unitAmount: earnedReward.unitAmount,
              });
            } else {
              settle({ kind: 'dismissed' });
            }
            break;
          case 'failedToShow':
            settle({ kind: 'failed', reason: 'failedToShow' });
            break;
          default:
            // requested / show / impression / clicked — 진행 중 이벤트, 별도 처리 없음
            break;
        }
      },
      onError: (err) => {
        settle({ kind: 'failed', reason: String(err) });
      },
    });
  });
}

/**
 * IAP(인앱결제) 서비스 — Step 8b (구독 + 슬롯 모델)
 *
 * BM 모델:
 *  - 광고 제거: 월 자동 갱신 구독 (SKU remove_ads_lifetime_v1, 1,900원/월)
 *    → createSubscriptionPurchaseOrder + getSubscriptionInfo 기반
 *    → 토스 서버가 source of truth (Storage는 캐시·orderId 보관)
 *  - 가족 슬롯: 일회성 누적 결제 (SKU family_expansion_lifetime_v1, 4,900원/슬롯)
 *    → createOneTimePurchaseOrder + getCompletedOrRefundedOrders 기반
 *    → 결제 이력 카운트로 슬롯 수 계산 (1 무료 + N 결제). 환불 시 자동 차감.
 *
 * Ref:
 *  - references/sdk/framework/인앱결제/IAP.md (createOneTimePurchaseOrder, getCompletedOrRefundedOrders)
 *  - references/sdk/framework/인앱결제/subscription.md (createSubscriptionPurchaseOrder, getSubscriptionInfo)
 *  - references/sdk/framework/환경확인/isMinVersionSupported.md
 *  - PRD: products/eomma-yak-meokja/prd/v1-steps/step-08-family.md §처리 6·7
 *
 * 최소 버전 가드:
 *  - IAP 자체: 토스앱 5.219.0
 *  - getCompletedOrRefundedOrders: 5.231.0 (안드/iOS)
 *  - getSubscriptionInfo: 안드 5.253.0 / iOS 5.250.0
 */

import { IAP, isMinVersionSupported, Storage } from '@apps-in-toss/framework';

// ─── 타입 ────────────────────────────────────────────────────────────────────

export type IapSku =
  | 'remove_ads_lifetime_v1'        // 월 자동 갱신 구독 (SKU 명칭은 콘솔 등록 그대로 유지)
  | 'family_expansion_lifetime_v1'; // 일회성 누적 슬롯 (per-slot 영구)

export type IapResult =
  | { kind: 'success'; sku: IapSku; orderId?: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason?: string };

// ─── Storage 키 ──────────────────────────────────────────────────────────────

export const IAP_STORAGE_KEYS = {
  /** 광고 제거 구독 주문 ID — getSubscriptionInfo 조회에 사용 */
  REMOVE_ADS_ORDER_ID: 'iap.remove_ads_order_id',
  /** 광고 제거 활성 여부 캐시 — 네트워크 실패/구버전 fallback */
  REMOVE_ADS_CACHE_ACTIVE: 'iap.remove_ads_cache_active',
  /** 캐시 갱신 시각 (ms) */
  REMOVE_ADS_CACHE_TIME: 'iap.remove_ads_cache_time',
  /** 가족 슬롯 fallback — getCompletedOrRefundedOrders 미지원 환경에서만 사용 */
  FAMILY_FALLBACK_PAID: 'iap.family_fallback_paid',
} as const;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — 네트워크 실패 시 캐시 신뢰 최대 기간

// ─── 버전 가드 ───────────────────────────────────────────────────────────────

/** IAP 결제 자체가 가능한 최소 버전 (createOneTime/SubscriptionPurchaseOrder) */
export function isIapSupported(): boolean {
  return isMinVersionSupported({ android: '5.219.0', ios: '5.219.0' });
}

/** getSubscriptionInfo 지원 최소 버전 — 미만 시 캐시 fallback */
function isSubscriptionInfoSupported(): boolean {
  return isMinVersionSupported({ android: '5.253.0', ios: '5.250.0' });
}

/** getCompletedOrRefundedOrders 지원 최소 버전 — 미만 시 boolean fallback */
function isOrdersQuerySupported(): boolean {
  return isMinVersionSupported({ android: '5.231.0', ios: '5.231.0' });
}

// ─── 광고 제거 (구독) 상태 조회 ──────────────────────────────────────────────

/**
 * 광고 제거 구독이 현재 활성인지 조회.
 * 토스 서버 (getSubscriptionInfo) = source of truth, Storage = 캐시.
 *
 * 동작:
 *  1. orderId 없음 → false
 *  2. getSubscriptionInfo 호출 → isAccessible 반환 (+ 캐시 갱신)
 *  3. 미지원/네트워크 실패 → 24h 캐시 fallback
 *
 * Ref: references/sdk/framework/인앱결제/subscription.md §getSubscriptionInfo
 *   "isAccessible: 현재 구독 상품을 이용할 수 있는지 여부"
 */
export async function isAdRemovedActive(): Promise<boolean> {
  const orderId = await safeGet(IAP_STORAGE_KEYS.REMOVE_ADS_ORDER_ID);
  if (!orderId) return false;

  if (
    !isSubscriptionInfoSupported() ||
    !IAP ||
    typeof IAP.getSubscriptionInfo !== 'function'
  ) {
    return readAdRemovedCache();
  }

  try {
    const response = await IAP.getSubscriptionInfo({ params: { orderId } });
    const active = response?.subscription?.isAccessible === true;
    await writeAdRemovedCache(active);
    return active;
  } catch {
    return readAdRemovedCache();
  }
}

async function readAdRemovedCache(): Promise<boolean> {
  const cached = await safeGet(IAP_STORAGE_KEYS.REMOVE_ADS_CACHE_ACTIVE);
  const cachedTimeStr = await safeGet(IAP_STORAGE_KEYS.REMOVE_ADS_CACHE_TIME);
  if (cached !== 'true' || !cachedTimeStr) return false;
  const age = Date.now() - Number(cachedTimeStr);
  if (Number.isNaN(age) || age > CACHE_TTL_MS) return false;
  return true;
}

async function writeAdRemovedCache(active: boolean): Promise<void> {
  await safeSet(IAP_STORAGE_KEYS.REMOVE_ADS_CACHE_ACTIVE, String(active));
  await safeSet(IAP_STORAGE_KEYS.REMOVE_ADS_CACHE_TIME, Date.now().toString());
}

// ─── 가족 슬롯 카운트 ────────────────────────────────────────────────────────

/**
 * 가족 슬롯 총 개수 = 1(무료) + 결제 완료된 family_expansion 슬롯 수.
 * getCompletedOrRefundedOrders로 토스 서버에서 직접 카운트 (환불은 자동 제외).
 *
 * 동작:
 *  - 5.231+ → 결제 이력 카운트 (페이지네이션 처리)
 *  - 5.231 미만 → boolean fallback Storage (최대 2슬롯까지만 지원)
 *
 * Ref: references/sdk/framework/인앱결제/IAP.md §getCompletedOrRefundedOrders
 */
export async function getFamilySlots(): Promise<number> {
  if (
    !isOrdersQuerySupported() ||
    !IAP ||
    typeof IAP.getCompletedOrRefundedOrders !== 'function'
  ) {
    // 구버전 fallback: boolean 플래그 → 최대 1슬롯만 추가 가능
    const fallback = await safeGet(IAP_STORAGE_KEYS.FAMILY_FALLBACK_PAID);
    return fallback === 'true' ? 2 : 1;
  }

  try {
    let totalPaid = 0;
    let key: string | null | undefined = undefined;
    // 페이지네이션 — IAP.md §getCompletedOrRefundedOrders "한 페이지당 최대 50개"
    do {
      const response = await IAP.getCompletedOrRefundedOrders(
        key ? { key } : undefined,
      );
      if (!response) break;
      totalPaid += response.orders.filter(
        (o) =>
          o.sku === 'family_expansion_lifetime_v1' && o.status === 'COMPLETED',
      ).length;
      key = response.hasNext ? response.nextKey : null;
    } while (key);

    return 1 + totalPaid;
  } catch {
    // 네트워크 실패 → 안전한 최소값 (1슬롯) 반환. 결제 시도는 가능.
    return 1;
  }
}

// ─── 결제 실행 공통부 ────────────────────────────────────────────────────────

type PurchaseCreator =
  | typeof IAP.createOneTimePurchaseOrder
  | typeof IAP.createSubscriptionPurchaseOrder;

function settleHelper(resolve: (r: IapResult) => void) {
  let settled = false;
  let cleanup: (() => void) | undefined;
  return {
    setCleanup(fn: () => void) {
      cleanup = fn;
    },
    settle(result: IapResult) {
      if (settled) return;
      settled = true;
      cleanup?.();
      resolve(result);
    },
  };
}

function classifyError(error: unknown): IapResult {
  const errStr = String(
    (error as { message?: string })?.message ?? error ?? '',
  );
  if (
    errStr.includes('cancel') ||
    errStr.includes('CANCEL') ||
    errStr.includes('USER_CANCEL')
  ) {
    return { kind: 'cancelled' };
  }
  return { kind: 'failed', reason: errStr || 'purchase_failed' };
}

// ─── 광고 제거 구독 결제 ─────────────────────────────────────────────────────

/**
 * 광고 제거 구독 결제.
 * SKU: remove_ads_lifetime_v1 (콘솔 등록: 자동 갱신 구독, 월 1,900원)
 * 결제 성공 → Storage에 orderId 저장 → 이후 isAdRemovedActive로 활성 여부 조회.
 *
 * Ref: references/sdk/framework/인앱결제/subscription.md §createSubscriptionPurchaseOrder
 *
 * 주의: SKU 이름은 `_lifetime_v1`이지만 실제 콘솔 등록 type은 SUBSCRIPTION.
 *   초기 일회성 모델로 등록했다가 구독으로 전환된 히스토리. v2에서 이름 정리 예정.
 */
export async function purchaseRemoveAdsSubscription(): Promise<IapResult> {
  if (!isIapSupported()) {
    return { kind: 'failed', reason: 'unsupported_version' };
  }
  if (
    !IAP ||
    typeof IAP.createSubscriptionPurchaseOrder !== 'function'
  ) {
    return { kind: 'failed', reason: 'iap_unavailable' };
  }

  return new Promise<IapResult>((resolve) => {
    const helper = settleHelper(resolve);

    const cleanup = IAP.createSubscriptionPurchaseOrder({
      options: {
        sku: 'remove_ads_lifetime_v1',
        processProductGrant: async ({ orderId }) => {
          // 구독 활성화: orderId 저장 → isAdRemovedActive가 이걸로 조회
          try {
            await Storage.setItem(IAP_STORAGE_KEYS.REMOVE_ADS_ORDER_ID, orderId);
            await writeAdRemovedCache(true);
          } catch {
            // Storage 실패해도 true 반환 → 토스 환불 페이지 방지
          }
          helper.settle({
            kind: 'success',
            sku: 'remove_ads_lifetime_v1',
            orderId,
          });
          return true;
        },
      },
      onEvent: (event) => {
        if (event.type === 'success') {
          helper.settle({
            kind: 'success',
            sku: 'remove_ads_lifetime_v1',
            orderId: event.data.orderId,
          });
        }
      },
      onError: (error) => {
        helper.settle(classifyError(error));
      },
    });

    helper.setCleanup(cleanup);
  });
}

// ─── 가족 슬롯 일회성 결제 ───────────────────────────────────────────────────

/**
 * 가족 슬롯 추가 결제 (일회성, 누적).
 * SKU: family_expansion_lifetime_v1 (콘솔 등록: 비소모성 NON_CONSUMABLE, 4,900원)
 * 결제 성공 → 토스 서버에 결제 이력 저장 → getFamilySlots가 다음 호출 시 +1.
 * Storage에 별도 플래그 저장 안 함 (이력 카운트가 진실).
 *
 * Ref: references/sdk/framework/인앱결제/IAP.md §createOneTimePurchaseOrder
 *
 * 5.231 미만 구버전 환경에서는 fallback flag도 함께 set — 최대 1슬롯 추가까지 보장.
 */
export async function purchaseFamilyExpansion(): Promise<IapResult> {
  if (!isIapSupported()) {
    return { kind: 'failed', reason: 'unsupported_version' };
  }
  if (!IAP || typeof IAP.createOneTimePurchaseOrder !== 'function') {
    return { kind: 'failed', reason: 'iap_unavailable' };
  }

  return new Promise<IapResult>((resolve) => {
    const helper = settleHelper(resolve);

    const cleanup = IAP.createOneTimePurchaseOrder({
      options: {
        sku: 'family_expansion_lifetime_v1',
        processProductGrant: async ({ orderId }) => {
          // 구버전 fallback flag만 set — 신버전은 getCompletedOrRefundedOrders로 동적 계산
          if (!isOrdersQuerySupported()) {
            await safeSet(IAP_STORAGE_KEYS.FAMILY_FALLBACK_PAID, 'true');
          }
          helper.settle({
            kind: 'success',
            sku: 'family_expansion_lifetime_v1',
            orderId,
          });
          return true;
        },
      },
      onEvent: (event) => {
        if (event.type === 'success') {
          helper.settle({
            kind: 'success',
            sku: 'family_expansion_lifetime_v1',
            orderId: event.data.orderId,
          });
        }
      },
      onError: (error) => {
        helper.settle(classifyError(error));
      },
    });

    helper.setCleanup(cleanup);
  });
}

// ─── Storage 안전 헬퍼 ───────────────────────────────────────────────────────

async function safeGet(key: string): Promise<string | null> {
  try {
    const v = await Storage.getItem(key);
    return v ?? null;
  } catch {
    return null;
  }
}

async function safeSet(key: string, value: string): Promise<void> {
  try {
    await Storage.setItem(key, value);
  } catch {
    // ignore
  }
}

import { useEffect, useRef, useState } from "react";
import { fetchWithAuth, useAuthStore } from "../../stores/auth";
import { formatCurrency } from "@/lib/i18n/format";

/** `GET /ai/usage`: the account's AI spend (every surface, not only Wisp). */
export interface AiUsageData {
  daily: { totalCostCents: number; messageCount: number };
  monthly: { totalCostCents: number; messageCount: number };
  budget: {
    enabled: boolean;
    monthlyBudgetCents: number | null;
    dailyBudgetCents: number | null;
    monthlyUsedCents: number;
    dailyUsedCents: number;
  } | null;
  /** #4388 W04: the partner's cached platform-credit balance. `null`/absent
   *  when BYOK, no partner id, or nothing cached yet. */
  credits?: { remaining: number; includedBalance: number; purchasedBalance: number; fetchedAt: string } | null;
}

/** A body the indicator can render; anything else keeps the previous value. */
function isUsage(body: unknown): body is AiUsageData {
  const monthly = (body as { monthly?: { totalCostCents?: unknown; messageCount?: unknown } } | null)?.monthly;
  return typeof monthly?.totalCostCents === "number" && typeof monthly.messageCount === "number";
}

/** "$X" this month, or "$X / $Y" against a monthly budget. */
export function aiMonthlyAmount(usage: AiUsageData): string {
  const used = formatCurrency(usage.monthly.totalCostCents / 100);
  const budget = usage.budget?.monthlyBudgetCents;
  return budget ? `${used} / ${formatCurrency(budget / 100)}` : used;
}

/** Platform credits are spent: hosted billing has nothing left to draw on. */
export function aiCreditsExhausted(usage: AiUsageData | null): boolean {
  return !!usage?.credits && usage.credits.remaining <= 0;
}

/**
 * Polls `/ai/usage` every 60 s while `enabled`, and once more right after a
 * turn finishes (`isStreaming` true → false) so a completed exchange shows at
 * once instead of on the next tick. Stops on 401/403 and after five failures.
 */
export function useAiUsage({ enabled = true, isStreaming }: { enabled?: boolean; isStreaming?: boolean }): AiUsageData | null {
  const [usage, setUsage] = useState<AiUsageData | null>(null);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const wasStreamingRef = useRef(false);

  // Kept apart from the polling effect so it doesn't disturb the poll
  // interval's lifecycle (401/error backoff, mount/unmount) on every
  // streaming-state change.
  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = !!isStreaming;
    if (!enabled || !isAuthenticated || !wasStreaming || isStreaming) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth("/ai/usage");
        if (res.ok && !cancelled) {
          const body: unknown = await res.json();
          if (isUsage(body)) setUsage(body);
        }
      } catch (err) {
        console.warn("[useAiUsage] post-turn usage refresh failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isStreaming, enabled, isAuthenticated]);

  useEffect(() => {
    if (!enabled || !isAuthenticated) {
      return;
    }

    let mounted = true;
    let failCount = 0;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const stopPolling = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    async function fetchUsage() {
      try {
        const res = await fetchWithAuth("/ai/usage");
        if (res.ok && mounted) {
          const body: unknown = await res.json();
          if (isUsage(body)) setUsage(body);
          failCount = 0;
        } else if (res.status === 401 || res.status === 403) {
          stopPolling();
        } else {
          failCount++;
        }
      } catch (err) {
        console.warn("[useAiUsage] fetch failed:", err);
        failCount++;
        if (failCount >= 5) stopPolling();
      }
    }

    intervalId = setInterval(fetchUsage, 60_000);
    void fetchUsage();
    return () => {
      mounted = false;
      stopPolling();
    };
  }, [enabled, isAuthenticated]);

  return enabled ? usage : null;
}

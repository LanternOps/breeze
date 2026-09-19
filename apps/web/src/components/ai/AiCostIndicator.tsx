import { useEffect, useRef, useState } from "react";
import { Coins } from "lucide-react";
import { fetchWithAuth, useAuthStore } from "../../stores/auth";
import { cn, widthPercentClass } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/i18n/format";
import { useTranslation } from "react-i18next";

interface UsageData {
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

interface AiCostIndicatorProps {
  enabled?: boolean;
  /**
   * True while an AI turn is actively streaming, false once it completes.
   * Used to trigger an immediate usage refetch on the true→false edge — the
   * indicator otherwise only refreshes on its 60s poll, which left the header
   * ("$0.00 this month" / "0 msgs") stale through an entire completed
   * exchange, including one with a tool call, until the next tick or a full
   * page reload. Omit this prop to keep the old poll-only behavior.
   */
  isStreaming?: boolean;
}

export default function AiCostIndicator({
  enabled = true,
  isStreaming,
}: AiCostIndicatorProps) {
  const { t } = useTranslation("ai");
  const [usage, setUsage] = useState<UsageData | null>(null);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const wasStreamingRef = useRef(false);

  // Refresh immediately when a turn just finished (true -> false), instead of
  // waiting up to 60s for the next poll tick. Kept as a separate effect from
  // the polling one below so it doesn't disturb the poll interval's lifecycle
  // (401/error backoff, mount/unmount) on every streaming-state change.
  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = !!isStreaming;
    if (!enabled || !isAuthenticated || !wasStreaming || isStreaming) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth("/ai/usage");
        if (res.ok && !cancelled) {
          setUsage(await res.json());
        }
      } catch (err) {
        console.warn("[AiCostIndicator] post-turn usage refresh failed:", err);
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
          setUsage(await res.json());
          failCount = 0;
        } else if (res.status === 401 || res.status === 403) {
          stopPolling();
        } else {
          failCount++;
        }
      } catch (err) {
        console.warn("[AiCostIndicator] fetch failed:", err);
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

  if (!enabled || !usage) return null;

  const monthlyBudget = usage.budget?.monthlyBudgetCents;
  const monthlyUsed = usage.monthly.totalCostCents;
  const percentage = monthlyBudget
    ? Math.min((monthlyUsed / monthlyBudget) * 100, 100)
    : 0;

  const costDisplay = (
    monthlyBudget
      ? `${formatCurrency(monthlyUsed / 100)} / ${formatCurrency(monthlyBudget / 100)}`
      : `${formatCurrency(monthlyUsed / 100)} this month`
  ) + (usage.credits ? ` · ${formatNumber(usage.credits.remaining)} credits` : '');

  const barColor =
    percentage > 90
      ? "bg-red-500"
      : percentage > 70
        ? "bg-yellow-500"
        : "bg-primary";

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b">
      <Coins className="h-3 w-3 text-muted-foreground" />
      <span className="text-[10px] text-muted-foreground">{costDisplay}</span>
      {monthlyBudget && (
        <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              barColor,
              widthPercentClass(percentage),
            )}
          />
        </div>
      )}
      <span className="text-[10px] text-gray-400 dark:text-gray-600">
        {t("aiCostIndicator.messageCount", {
          count: usage.monthly.messageCount,
        })}
      </span>
    </div>
  );
}

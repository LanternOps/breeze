import { Coins } from "lucide-react";
import { cn, widthPercentClass } from "@/lib/utils";
import { formatNumber } from "@/lib/i18n/format";
import { useTranslation } from "react-i18next";
import BuyCreditsLink from "./BuyCreditsLink";
import { aiMonthlyAmount, useAiUsage } from "./useAiUsage";

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
  const usage = useAiUsage({ enabled, isStreaming });

  if (!enabled || !usage) return null;

  const monthlyBudget = usage.budget?.monthlyBudgetCents;
  const monthlyUsed = usage.monthly.totalCostCents;
  const percentage = monthlyBudget
    ? Math.min((monthlyUsed / monthlyBudget) * 100, 100)
    : 0;

  const costDisplay = (
    monthlyBudget
      ? aiMonthlyAmount(usage)
      : t("aiCostIndicator.thisMonth", { amount: aiMonthlyAmount(usage) })
  ) + (usage.credits
    ? ` · ${t("aiCostIndicator.credits", {
        count: usage.credits.remaining,
        formatted: formatNumber(usage.credits.remaining),
      })}`
    : '');

  const barColor =
    percentage > 90
      ? "bg-red-500"
      : percentage > 70
        ? "bg-yellow-500"
        : "bg-primary";

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b">
      <Coins className="h-3 w-3 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">{costDisplay}</span>
      {usage.credits && (
        <BuyCreditsLink className="text-xs font-medium text-primary underline underline-offset-2 hover:opacity-80" />
      )}
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
      <span className="text-xs text-muted-foreground">
        {t("aiCostIndicator.messageCount", {
          count: usage.monthly.messageCount,
        })}
      </span>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Coins } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';

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
}

interface AiCostIndicatorProps {
  enabled?: boolean;
}

export default function AiCostIndicator({ enabled = true }: AiCostIndicatorProps) {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

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
        const res = await fetchWithAuth('/ai/usage');
        if (res.ok && mounted) {
          setUsage(await res.json());
          failCount = 0;
        } else if (res.status === 401 || res.status === 403) {
          stopPolling();
        }
      } catch {
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
  const percentage = monthlyBudget ? Math.min((monthlyUsed / monthlyBudget) * 100, 100) : 0;

  const costDisplay = monthlyBudget
    ? `$${(monthlyUsed / 100).toFixed(2)} / $${(monthlyBudget / 100).toFixed(2)}`
    : `$${(monthlyUsed / 100).toFixed(2)} this month`;

  const barColor = percentage > 90 ? 'bg-red-500' : percentage > 70 ? 'bg-yellow-500' : 'bg-purple-500';

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b border-gray-700/50">
      <Coins className="h-3 w-3 text-gray-500" />
      <span className="text-[10px] text-gray-500">{costDisplay}</span>
      {monthlyBudget && (
        <div className="flex-1 h-1 rounded-full bg-gray-800 overflow-hidden">
          <div
            className={`h-full rounded-full ${barColor} transition-all`}
            style={{ width: `${percentage}%` }}
          />
        </div>
      )}
      <span className="text-[10px] text-gray-600">{usage.monthly.messageCount} msgs</span>
    </div>
  );
}

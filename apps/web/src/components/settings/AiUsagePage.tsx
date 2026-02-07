import { useState, useEffect, useCallback } from 'react';
import { Bot, DollarSign, MessageSquare, Zap, Save, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

interface UsageData {
  daily: { inputTokens: number; outputTokens: number; totalCostCents: number; messageCount: number };
  monthly: { inputTokens: number; outputTokens: number; totalCostCents: number; messageCount: number };
  budget: {
    enabled: boolean;
    monthlyBudgetCents: number | null;
    dailyBudgetCents: number | null;
    monthlyUsedCents: number;
    dailyUsedCents: number;
  } | null;
}

interface SessionRow {
  id: string;
  userId: string;
  title: string | null;
  model: string;
  turnCount: number;
  totalCostCents: number;
  status: string;
  createdAt: string;
}

interface BudgetForm {
  enabled: boolean;
  monthlyBudgetDollars: string;
  dailyBudgetDollars: string;
  maxTurnsPerSession: string;
  messagesPerMinutePerUser: string;
  messagesPerHourPerOrg: string;
}

export default function AiUsagePage() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [budget, setBudget] = useState<BudgetForm>({
    enabled: true,
    monthlyBudgetDollars: '',
    dailyBudgetDollars: '',
    maxTurnsPerSession: '50',
    messagesPerMinutePerUser: '20',
    messagesPerHourPerOrg: '200'
  });

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [usageRes, sessionsRes] = await Promise.all([
        fetchWithAuth('/ai/usage'),
        fetchWithAuth('/ai/admin/sessions?limit=50')
      ]);

      if (usageRes.ok) {
        const data = await usageRes.json();
        setUsage(data);
        if (data.budget) {
          setBudget({
            enabled: data.budget.enabled,
            monthlyBudgetDollars: data.budget.monthlyBudgetCents ? (data.budget.monthlyBudgetCents / 100).toFixed(2) : '',
            dailyBudgetDollars: data.budget.dailyBudgetCents ? (data.budget.dailyBudgetCents / 100).toFixed(2) : '',
            maxTurnsPerSession: '50',
            messagesPerMinutePerUser: '20',
            messagesPerHourPerOrg: '200'
          });
        }
      }

      if (sessionsRes.ok) {
        const data = await sessionsRes.json();
        setSessions(data.data || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSaveBudget = async () => {
    setSaving(true);
    setSaveSuccess(false);
    try {
      const res = await fetchWithAuth('/ai/budget', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: budget.enabled,
          monthlyBudgetCents: budget.monthlyBudgetDollars ? Math.round(parseFloat(budget.monthlyBudgetDollars) * 100) : null,
          dailyBudgetCents: budget.dailyBudgetDollars ? Math.round(parseFloat(budget.dailyBudgetDollars) * 100) : null,
          maxTurnsPerSession: parseInt(budget.maxTurnsPerSession) || 50,
          messagesPerMinutePerUser: parseInt(budget.messagesPerMinutePerUser) || 20,
          messagesPerHourPerOrg: parseInt(budget.messagesPerHourPerOrg) || 200
        })
      });
      if (!res.ok) throw new Error('Failed to save budget');
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const formatCost = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const formatTokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">AI Usage & Budget</h1>
        <p className="text-muted-foreground">Monitor AI assistant usage and configure budget limits</p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Stats cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={DollarSign}
          label="Today's Cost"
          value={formatCost(usage?.daily.totalCostCents ?? 0)}
          sub={usage?.budget?.dailyBudgetCents ? `of ${formatCost(usage.budget.dailyBudgetCents)} limit` : undefined}
        />
        <StatCard
          icon={DollarSign}
          label="Monthly Cost"
          value={formatCost(usage?.monthly.totalCostCents ?? 0)}
          sub={usage?.budget?.monthlyBudgetCents ? `of ${formatCost(usage.budget.monthlyBudgetCents)} limit` : undefined}
        />
        <StatCard
          icon={MessageSquare}
          label="Messages Today"
          value={String(usage?.daily.messageCount ?? 0)}
        />
        <StatCard
          icon={Zap}
          label="Tokens This Month"
          value={formatTokens((usage?.monthly.inputTokens ?? 0) + (usage?.monthly.outputTokens ?? 0))}
          sub={`${formatTokens(usage?.monthly.inputTokens ?? 0)} in / ${formatTokens(usage?.monthly.outputTokens ?? 0)} out`}
        />
      </div>

      {/* Budget configuration */}
      <div className="rounded-lg border bg-card p-6">
        <h2 className="text-lg font-semibold mb-4">Budget Configuration</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block">
            <span className="text-sm text-muted-foreground">AI Enabled</span>
            <select
              value={budget.enabled ? 'true' : 'false'}
              onChange={(e) => setBudget({ ...budget, enabled: e.target.value === 'true' })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
          </label>
          <label className="block">
            <span className="text-sm text-muted-foreground">Monthly Budget ($)</span>
            <input
              type="number"
              step="0.01"
              value={budget.monthlyBudgetDollars}
              onChange={(e) => setBudget({ ...budget, monthlyBudgetDollars: e.target.value })}
              placeholder="No limit"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm text-muted-foreground">Daily Budget ($)</span>
            <input
              type="number"
              step="0.01"
              value={budget.dailyBudgetDollars}
              onChange={(e) => setBudget({ ...budget, dailyBudgetDollars: e.target.value })}
              placeholder="No limit"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm text-muted-foreground">Max Turns Per Session</span>
            <input
              type="number"
              value={budget.maxTurnsPerSession}
              onChange={(e) => setBudget({ ...budget, maxTurnsPerSession: e.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm text-muted-foreground">Msgs/Min Per User</span>
            <input
              type="number"
              value={budget.messagesPerMinutePerUser}
              onChange={(e) => setBudget({ ...budget, messagesPerMinutePerUser: e.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm text-muted-foreground">Msgs/Hr Per Org</span>
            <input
              type="number"
              value={budget.messagesPerHourPerOrg}
              onChange={(e) => setBudget({ ...budget, messagesPerHourPerOrg: e.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </label>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={handleSaveBudget}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Budget
          </button>
          {saveSuccess && <span className="text-sm text-green-500">Saved successfully</span>}
        </div>
      </div>

      {/* Session history */}
      <div className="rounded-lg border bg-card">
        <div className="border-b px-6 py-4">
          <h2 className="text-lg font-semibold">Recent Sessions</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">Title</th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">Model</th>
                <th className="px-4 py-2 text-right font-medium text-muted-foreground">Turns</th>
                <th className="px-4 py-2 text-right font-medium text-muted-foreground">Cost</th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">Created</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="px-4 py-2.5 truncate max-w-[200px]">{s.title || 'Untitled'}</td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs">{s.model.split('-').slice(0, 2).join(' ')}</td>
                  <td className="px-4 py-2.5 text-right">{s.turnCount}</td>
                  <td className="px-4 py-2.5 text-right">{formatCost(s.totalCostCents)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                      s.status === 'active' ? 'bg-green-500/20 text-green-400' :
                      s.status === 'closed' ? 'bg-gray-500/20 text-gray-400' :
                      'bg-yellow-500/20 text-yellow-400'
                    }`}>
                      {s.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs">
                    {new Date(s.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    No AI sessions yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub }: {
  icon: typeof Bot;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-bold">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

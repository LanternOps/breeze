import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback } from 'react';
import { Bot, Coins, DollarSign, Flag, MessageSquare, Zap, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { formatDate, formatDateTime } from '@/lib/dateTimeFormat';
import { formatCurrency, formatNumber } from '@/lib/i18n/format';
import {
  AI_BUDGET_FIELDS,
  aiBudgetSource,
  withAiBudgetDefaults,
  type AiBudgetField,
  type EffectiveAiBudget,
} from '@/lib/aiBudget';

/**
 * Literal keys per alert period, so the i18n key scanner can see them (a
 * `t(\`...${f.period}\`)` template is a dynamic key it cannot check).
 */
const PERIOD_LABEL_KEYS = {
  daily: 'aiUsagePage.periodLabel.daily',
  monthly: 'aiUsagePage.periodLabel.monthly',
} as const;

interface UsageData {
  daily: { inputTokens: number; outputTokens: number; totalCostCents: number; messageCount: number };
  monthly: { inputTokens: number; outputTokens: number; totalCostCents: number; messageCount: number };
  /** Who pays for LLM calls: the platform key or the partner's own Anthropic key (BYOK). */
  billedTo?: 'platform' | 'partner_key';
  /** Name of the catalog endpoint the org's most recent session used, when
   *  billed to the partner key via a platform-vetted third-party endpoint
   *  rather than direct Anthropic (#3922 W4). */
  catalogEndpointName?: string | null;
  /** #4388 W04: the partner's cached platform-credit balance. `null`/absent
   *  when BYOK, no partner id, or nothing cached yet. */
  credits?: { remaining: number; includedBalance: number; purchasedBalance: number; fetchedAt: string } | null;
  budget: {
    enabled: boolean;
    monthlyBudgetCents: number | null;
    dailyBudgetCents: number | null;
    monthlyUsedCents: number;
    dailyUsedCents: number;
    approvalMode: string;
    alertThresholdPercents?: number[];
  } | null;
  alerts?: {
    fired: Array<{ period: string; periodKey: string; thresholdPct: number; createdAt: string; deliveredAt: string | null }>;
  };
}

interface SessionRow {
  id: string;
  userId: string;
  title: string | null;
  model: string;
  turnCount: number;
  totalCostCents: number;
  status: string;
  flaggedAt: string | null;
  flaggedBy: string | null;
  flagReason: string | null;
  createdAt: string;
}

/** Where the partner-wide copies of these fields are edited. */
const PARTNER_AI_BUDGETS_HREF = '/settings/partner#ai-budgets';

/**
 * Literal label keys per budget field and per approval mode, for the same
 * reason as PERIOD_LABEL_KEYS above: a template key is invisible to the
 * i18n key scanner.
 */
const BUDGET_FIELD_LABEL_KEYS: Record<AiBudgetField, string> = {
  enabled: 'aiUsagePage.aIEnabled',
  monthlyBudgetCents: 'aiUsagePage.monthlyBudget',
  dailyBudgetCents: 'aiUsagePage.dailyBudget',
  maxTurnsPerSession: 'aiUsagePage.maxTurnsPerSession',
  messagesPerMinutePerUser: 'aiUsagePage.msgsMinPerUser',
  messagesPerHourPerOrg: 'aiUsagePage.msgsHrPerOrg',
  approvalMode: 'aiUsagePage.approvalMode',
  alertThresholdPercents: 'aiUsagePage.alertThresholds',
};

const APPROVAL_MODE_LABEL_KEYS: Record<string, string> = {
  per_step: 'aiUsagePage.perStepDefault',
  action_plan: 'aiUsagePage.actionPlan',
  auto_approve: 'aiUsagePage.autoApprove',
  hybrid_plan: 'aiUsagePage.hybridPlanAbort',
};

const SOURCE_LABEL_KEYS = {
  partner: 'aiUsagePage.sourcePartner',
  organization: 'aiUsagePage.sourceOrganization',
  default: 'aiUsagePage.sourceDefault',
} as const;

export default function AiUsagePage() {
  const { t } = useTranslation('settings');
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [locked, setLocked] = useState<string[]>([]);
  // The MERGED budget from effective-settings. The API never returns the raw
  // `ai_budgets` row, so provenance is derived from `locked` plus a comparison
  // against the shipped defaults — see `aiBudgetSource`.
  const [effectiveBudget, setEffectiveBudget] = useState<EffectiveAiBudget | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFlaggedOnly, setShowFlaggedOnly] = useState(false);
  const { currentOrgId } = useOrgStore();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const sessionsUrl = showFlaggedOnly
        ? '/ai/admin/sessions?limit=50&flagged=true'
        : '/ai/admin/sessions?limit=50';
      const [usageRes, sessionsRes, effRes] = await Promise.all([
        fetchWithAuth('/ai/usage'),
        fetchWithAuth(sessionsUrl),
        currentOrgId
          ? fetchWithAuth(`/orgs/organizations/${currentOrgId}/effective-settings`).catch((err) => {
              console.warn('[AiUsagePage] Error fetching effective settings:', err);
              return null;
            })
          : Promise.resolve(null),
      ]);

      if (usageRes.ok) {
        setUsage(await usageRes.json());
      }

      if (sessionsRes.ok) {
        const data = await sessionsRes.json();
        setSessions(data.data || []);
      }

      // Locked fields + the merged budget (effective-settings), fetched in
      // parallel above. Absent on All organizations: there is no org to merge.
      if (effRes && effRes.ok) {
        const effData = await effRes.json();
        setLocked(effData.locked || []);
        setEffectiveBudget(withAiBudgetDefaults(effData.effective?.aiBudgets ?? effData.aiBudgets));
      } else {
        setLocked([]);
        setEffectiveBudget(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('aiUsagePage.failedToLoadData'));
    } finally {
      setLoading(false);
    }
  }, [showFlaggedOnly, currentOrgId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const formatCost = (cents: number) => formatCurrency(cents / 100);

  /** The rendered effective value for one budget field. */
  const formatBudgetValue = (field: AiBudgetField, b: EffectiveAiBudget): string => {
    switch (field) {
      case 'enabled':
        return b.enabled ? t('aiUsagePage.enabled') : t('aiUsagePage.disabled');
      case 'approvalMode':
        return t(/* i18n-dynamic */ APPROVAL_MODE_LABEL_KEYS[b.approvalMode] ?? 'aiUsagePage.perStepDefault');
      case 'monthlyBudgetCents':
        return b.monthlyBudgetCents == null ? t('aiUsagePage.noLimit') : formatCost(b.monthlyBudgetCents);
      case 'dailyBudgetCents':
        return b.dailyBudgetCents == null ? t('aiUsagePage.noLimit') : formatCost(b.dailyBudgetCents);
      case 'alertThresholdPercents':
        return b.alertThresholdPercents.length === 0
          ? t('aiUsagePage.thresholdsOff')
          : b.alertThresholdPercents.map((n) => `${n}%`).join(', ');
      default:
        return formatNumber(b[field] as number);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const formatTokens = (n: number) => n >= 1_000_000 ? `${formatNumber(n / 1_000_000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M` : n >= 1_000 ? `${formatNumber(n / 1_000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}K` : formatNumber(n);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('aiUsagePage.aIUsageBudget')}</h1>
        <p className="text-muted-foreground">{t('aiUsagePage.monitorAIAssistantUsage')}</p>
        {usage?.billedTo === 'partner_key' && (
          <p className="mt-1 text-sm text-muted-foreground" data-testid="ai-usage-billed-to-note">
            {usage.catalogEndpointName
              ? t('aiUsagePage.billedToPartnerKeyViaEndpoint', { name: usage.catalogEndpointName })
              : t('aiUsagePage.billedToPartnerKey')}
          </p>
        )}
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
          sub={usage?.budget?.dailyBudgetCents ? t('aiUsagePage.ofLimit', { limit: formatCost(usage.budget.dailyBudgetCents) }) : undefined}
        />
        <StatCard
          icon={DollarSign}
          label="Monthly Cost"
          value={formatCost(usage?.monthly.totalCostCents ?? 0)}
          sub={usage?.budget?.monthlyBudgetCents ? t('aiUsagePage.ofLimit', { limit: formatCost(usage.budget.monthlyBudgetCents) }) : undefined}
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
          sub={t('aiUsagePage.tokensInOut', {
            input: formatTokens(usage?.monthly.inputTokens ?? 0),
            output: formatTokens(usage?.monthly.outputTokens ?? 0)
          })}
        />
        {usage?.credits && (
          <StatCard
            icon={Coins}
            label={t('aiUsagePage.creditsRemaining')}
            value={formatNumber(usage.credits.remaining)}
          />
        )}
      </div>

      {usage?.alerts?.fired?.length ? (
        <p data-testid="ai-budget-fired-rungs" className="text-xs text-muted-foreground">
          {usage.alerts.fired.map((f) => {
            const periodKey = PERIOD_LABEL_KEYS[f.period as keyof typeof PERIOD_LABEL_KEYS];
            return t('aiUsagePage.firedRung', {
              pct: f.thresholdPct,
              period: periodKey ? t(/* i18n-dynamic */ periodKey) : f.period,
              date: formatDate(f.createdAt),
            });
          }).join(' · ')}
        </p>
      ) : null}

      {/* Effective budget — read-only (#6004). The editor lives on the org
          settings AI tab; this panel only says what is in force and where it
          was set, so the page has no way to reach PUT /ai/budget at all. */}
      {!currentOrgId ? (
        <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="ai-usage-select-org-prompt">
          {t('aiUsagePage.selectOrgForEffectiveBudget')}{' '}
          <a href={PARTNER_AI_BUDGETS_HREF} className="font-medium text-primary hover:underline">
            {t('aiUsagePage.editPartnerWideDefaults')}
          </a>
        </p>
      ) : effectiveBudget ? (
        <div className="rounded-lg border bg-card p-6" data-testid="ai-effective-budget">
          <h2 className="text-lg font-semibold">{t('aiUsagePage.effectiveBudget')}</h2>
          <p className="mt-1 mb-4 text-sm text-muted-foreground">{t('aiUsagePage.effectiveBudgetHelp')}</p>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {AI_BUDGET_FIELDS.map((field) => {
              const source = aiBudgetSource(field, effectiveBudget, locked);
              const chipLabel = t(/* i18n-dynamic */ SOURCE_LABEL_KEYS[source]);
              const chipClass =
                source === 'partner'
                  ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                  : source === 'organization'
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground';
              const href =
                source === 'partner'
                  ? PARTNER_AI_BUDGETS_HREF
                  : source === 'organization' && currentOrgId
                    ? `/settings/organizations/${currentOrgId}#ai`
                    : null;
              const chipProps = {
                'data-testid': `ai-effective-budget-source-${field}`,
                className: `inline-block rounded-full px-2 py-0.5 text-xs ${chipClass}`,
              };
              return (
                <div key={field} data-testid={`ai-effective-budget-row-${field}`}>
                  <dt className="text-sm text-muted-foreground">
                    {t(/* i18n-dynamic */ BUDGET_FIELD_LABEL_KEYS[field])}
                  </dt>
                  <dd className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium" data-testid={`ai-effective-budget-value-${field}`}>
                      {formatBudgetValue(field, effectiveBudget)}
                    </span>
                    {href ? (
                      <a href={href} {...chipProps}>{chipLabel}</a>
                    ) : (
                      <span {...chipProps}>{chipLabel}</span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      ) : (
        // An org IS selected but effective-settings did not come back. Saying
        // "select an organization" here would be a lie, and rendering nothing
        // would hide a failed read — so name it.
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-sm text-destructive" data-testid="ai-effective-budget-unavailable">
          {t('aiUsagePage.effectiveBudgetUnavailable')}
        </p>
      )}

      {/* Session history */}
      <div className="rounded-lg border bg-card">
        <div className="border-b px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('aiUsagePage.recentSessions')}</h2>
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={showFlaggedOnly}
              onChange={(e) => setShowFlaggedOnly(e.target.checked)}
              className="rounded border-border"
            />
            {t('aiUsagePage.showFlaggedOnly')}</label>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2">{t('aiUsagePage.title')}</th>
                <th className="px-4 py-2">{t('aiUsagePage.model')}</th>
                <th className="px-4 py-2 text-right">{t('aiUsagePage.turns')}</th>
                <th className="px-4 py-2 text-right">{t('aiUsagePage.cost')}</th>
                <th className="px-4 py-2">{t('aiUsagePage.status')}</th>
                <th className="px-4 py-2">{t('aiUsagePage.flagged')}</th>
                <th className="px-4 py-2">{t('aiUsagePage.created')}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className={`border-b last:border-0 hover:bg-muted/20 ${s.flaggedAt ? 'border-l-2 border-l-amber-500' : ''}`}>
                  <td className="px-4 py-2.5 truncate max-w-[200px]">{s.title || t('aiUsagePage.untitled')}</td>
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
                  <td className="px-4 py-2.5">
                    {s.flaggedAt ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-400"
                        title={s.flagReason || 'Flagged'}
                      >
                        <Flag className="h-3 w-3" />
                        {t('aiUsagePage.flagged')}</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs">
                    {formatDateTime(s.createdAt)}
                  </td>
                </tr>
              ))}
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    {t('aiUsagePage.noAISessionsYet')}</td>
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

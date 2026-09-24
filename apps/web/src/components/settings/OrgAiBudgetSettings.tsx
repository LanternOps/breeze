import '@/lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Lock, Save, Wallet } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { useDefaultOwnerScope } from '@/hooks/useDefaultOwnerScope';
import { runAction, ActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';
import {
  AI_BUDGET_DEFAULTS,
  AI_BUDGET_FIELDS,
  TOOL_RATE_LIMIT_MULTIPLIER_MAX,
  TOOL_RATE_LIMIT_MULTIPLIER_MIN,
  aiBudgetSource,
  isAiBudgetFieldLocked,
  withAiBudgetDefaults,
  type AiBudgetField,
  type EffectiveAiBudget,
} from '@/lib/aiBudget';
import AiBudgetThresholdsInput from './AiBudgetThresholdsInput';

/** Where the partner-wide copies of these fields are edited. */
const PARTNER_AI_BUDGETS_HREF = '/settings/partner#ai-budgets';

type Props = {
  /** The organization being edited. `null` while the page has no org context. */
  orgId: string | null;
};

/** Draft text per field. `''` always means "leave as inherited". */
type Draft = Record<AiBudgetField, string>;

const EMPTY_DRAFT: Draft = {
  enabled: '',
  monthlyBudgetCents: '',
  dailyBudgetCents: '',
  maxTurnsPerSession: '',
  messagesPerMinutePerUser: '',
  messagesPerHourPerOrg: '',
  approvalMode: '',
  alertThresholdPercents: '',
  toolRateLimitMultiplier: '',
};

const APPROVAL_MODE_LABEL_KEYS = {
  per_step: 'aiUsagePage.perStepDefault',
  action_plan: 'aiUsagePage.actionPlan',
  auto_approve: 'aiUsagePage.autoApprove',
  hybrid_plan: 'aiUsagePage.hybridPlanAbort',
} as const;

const APPROVAL_MODE_HELP_KEYS = {
  per_step: 'aiUsagePage.eachToolRequiringApprovalBlocksUntilTheUserApprovesOrRej',
  action_plan: 'aiUsagePage.aIProposesAMultiStepPlanUserApprovesTheWholePlanAtOnceTh',
  auto_approve: 'aiUsagePage.tier2ToolsAutoExecuteWithAuditLoggingTier3ToolsStillRequ',
  hybrid_plan: 'aiUsagePage.likeActionPlanPlusLiveScreenshotsBetweenStepsAndAPersist',
} as const;

const centsToDollars = (cents: number | null): string => (cents == null ? '' : (cents / 100).toFixed(2));

/**
 * Org-side editor for the AI budget fields (#6004; #6476 added the per-tool
 * rate-limit multiplier).
 *
 * Moved here from `AiUsagePage` so it sits beside every other partner-enforced
 * org setting (Security, Event Logs, Notifications) and so the usage page can
 * never render a form it has no org to save (the "Organization context
 * required" 400).
 *
 * Two contracts this file exists to hold:
 *
 * 1. **Only touched fields are sent.** The payload can only tell us the MERGED
 *    budget, so an untouched control is showing whatever the org inherits.
 *    Sending it back would write the inherited value onto `ai_budgets` as an
 *    explicit choice — the #5592 / #4388 W03 class of bug. A field the user
 *    never edited is therefore absent from the PUT entirely, and a field whose
 *    effective value equals the shipped default renders EMPTY with a
 *    "Default (…)" placeholder rather than pre-filled.
 * 2. **Locked fields are never submitted.** `assertNotLocked` 403s a changed
 *    partner-enforced field; the control is disabled and excluded from the
 *    payload, and the amber note points at where the value actually lives.
 */
export default function OrgAiBudgetSettings({ orgId }: Props) {
  const { t } = useTranslation('settings');
  const { isPartnerScope } = useDefaultOwnerScope();
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
  const showPartnerLink = isPartnerScope && canManagePartnerWide;

  const [effective, setEffective] = useState<EffectiveAiBudget>(AI_BUDGET_DEFAULTS);
  const [locked, setLocked] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [touched, setTouched] = useState<AiBudgetField[]>([]);
  const [thresholds, setThresholds] = useState<number[] | undefined>(undefined);
  const [thresholdsValid, setThresholdsValid] = useState(true);
  const [loading, setLoading] = useState(true);
  // A failed read must NOT fall through to the form: `locked` would still be
  // `[]` and every draft empty, so a partner-managed field would render
  // unlocked and editable and the user would only learn otherwise from a 403
  // (silent-failure review, #6004). Block instead.
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetchWithAuth(`/orgs/organizations/${orgId}/effective-settings`);
      if (!res.ok) throw new Error(t('aiUsagePage.failedToLoadData'));
      const data = await res.json();
      const lockedList: string[] = data.locked ?? [];
      const merged = withAiBudgetDefaults(data.effective?.aiBudgets ?? data.aiBudgets);
      setLocked(lockedList);
      setEffective(merged);
      setTouched([]);
      // Seed only the fields that are NOT inherited: a control showing the
      // shipped default must look empty, or the next save pins it.
      const seeded: Draft = { ...EMPTY_DRAFT };
      for (const field of AI_BUDGET_FIELDS) {
        if (field === 'alertThresholdPercents') continue;
        const source = aiBudgetSource(field, merged, lockedList);
        if (source === 'default') continue;
        const value = merged[field];
        seeded[field] =
          field === 'monthlyBudgetCents' || field === 'dailyBudgetCents'
            ? centsToDollars(value as number | null)
            : String(value);
      }
      setDraft(seeded);
      setLoadFailed(false);
      setThresholds(
        aiBudgetSource('alertThresholdPercents', merged, lockedList) === 'default'
          ? undefined
          : merged.alertThresholdPercents,
      );
      setError(null);
    } catch (err) {
      setLoadFailed(true);
      setError(err instanceof Error ? err.message : t('aiUsagePage.failedToLoadData'));
    } finally {
      setLoading(false);
    }
  }, [orgId, t]);

  useEffect(() => { void load(); }, [load]);

  const isLocked = (field: AiBudgetField) => isAiBudgetFieldLocked(locked, field);
  const allFieldsLocked = AI_BUDGET_FIELDS.every(isLocked);

  const markTouched = (field: AiBudgetField) =>
    setTouched((prev) => (prev.includes(field) ? prev : [...prev, field]));

  const setField = (field: AiBudgetField, value: string) => {
    markTouched(field);
    setDraft((prev) => ({ ...prev, [field]: value }));
  };

  /**
   * `''` means "inherit". Only `monthlyBudgetCents`/`dailyBudgetCents` can
   * express that over the wire (`null` clears the column); the PUT schema has
   * no null for the others, so clearing one of those is a no-op rather than a
   * write that would pin the default back on.
   */
  const serialize = (field: AiBudgetField): unknown => {
    const raw = draft[field].trim();
    switch (field) {
      case 'enabled':
        return raw === '' ? undefined : raw === 'true';
      case 'approvalMode':
        return raw === '' ? undefined : raw;
      case 'monthlyBudgetCents':
      case 'dailyBudgetCents': {
        if (raw === '') return null;
        const dollars = parseFloat(raw);
        // Defence in depth, matching the integer branch below: `Math.round(NaN)`
        // survives the `!== undefined` filter and JSON.stringify writes it as
        // `null`, which would silently CLEAR the cap the user was setting.
        // Unreachable from the UI today — `<input type="number">` already
        // reports '' for unparseable text — so this guard is deliberately not
        // driven by a DOM test; it exists for the day the control changes.
        return Number.isNaN(dollars) ? undefined : Math.round(dollars * 100);
      }
      case 'alertThresholdPercents':
        return thresholds ?? null;
      default: {
        const n = parseInt(raw, 10);
        return raw === '' || Number.isNaN(n) ? undefined : n;
      }
    }
  };

  const handleSave = async () => {
    if (!orgId) return;
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const field of AI_BUDGET_FIELDS) {
        if (isLocked(field) || !touched.includes(field)) continue;
        const value = serialize(field);
        if (value !== undefined) payload[field] = value;
      }

      await runAction({
        request: () =>
          fetchWithAuth(`/ai/budget?orgId=${orgId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }),
        errorFallback: t('aiUsagePage.failedToSaveBudget'),
        successMessage: t('aiUsagePage.savedSuccessfully'),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('aiUsagePage.failedToSaveBudget') });
      }
      setError(err instanceof Error ? err.message : t('aiUsagePage.failedToSaveBudget'));
    } finally {
      setSaving(false);
    }
  };

  /** The "Default (…)" hint for an inherited field, or '' when it has a value. */
  const placeholderFor = (field: AiBudgetField): string => {
    const def = AI_BUDGET_DEFAULTS[field];
    if (def === null) return t('aiUsagePage.noLimit');
    return t('aiUsagePage.defaultValue', { value: String(def) });
  };

  const lockedNote = (field: AiBudgetField) =>
    isLocked(field) ? (
      <span
        data-testid={`org-ai-budget-locked-${field}`}
        className="mt-1 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 italic"
      >
        <Lock className="h-3 w-3" /> {t('aiUsagePage.managedByPartner')}
        {showPartnerLink && (
          <a href={PARTNER_AI_BUDGETS_HREF} className="font-medium text-primary hover:underline not-italic">
            {t('aiUsagePage.viewPartnerWideBudgets')}
          </a>
        )}
      </span>
    ) : null;

  const inputClass = (field: AiBudgetField) =>
    `mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm ${isLocked(field) ? 'opacity-60 cursor-not-allowed' : ''}`;

  if (!orgId) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="org-ai-budget-no-org">
        {t('orgAiBudgetSettings.selectOrganization')}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div
        data-testid="org-ai-budget-unavailable"
        className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-sm text-destructive"
      >
        {error ?? t('aiUsagePage.failedToLoadData')}
      </div>
    );
  }

  const approvalModeDefaultLabel = t(
    /* i18n-dynamic */ APPROVAL_MODE_LABEL_KEYS[AI_BUDGET_DEFAULTS.approvalMode],
  );
  const selectedApprovalMode = (draft.approvalMode || AI_BUDGET_DEFAULTS.approvalMode) as keyof typeof APPROVAL_MODE_HELP_KEYS;

  return (
    <section className="rounded-lg border bg-card p-6 shadow-xs" data-testid="org-ai-budget-settings">
      <div className="flex items-center gap-2">
        <Wallet className="h-5 w-5" />
        <h2 className="text-lg font-semibold">{t('orgAiBudgetSettings.title')}</h2>
      </div>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">{t('orgAiBudgetSettings.description')}</p>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          <span className="text-sm text-muted-foreground">{t('aiUsagePage.aIEnabled')}</span>
          <select
            data-testid="org-ai-budget-enabled"
            value={draft.enabled}
            onChange={(e) => setField('enabled', e.target.value)}
            disabled={isLocked('enabled')}
            className={inputClass('enabled')}
          >
            <option value="">
              {t('aiUsagePage.defaultValue', {
                value: AI_BUDGET_DEFAULTS.enabled ? t('aiUsagePage.enabled') : t('aiUsagePage.disabled'),
              })}
            </option>
            <option value="true">{t('aiUsagePage.enabled')}</option>
            <option value="false">{t('aiUsagePage.disabled')}</option>
          </select>
          {lockedNote('enabled')}
        </label>

        <label className="block">
          <span className="text-sm text-muted-foreground">{t('aiUsagePage.approvalMode')}</span>
          <select
            data-testid="org-ai-budget-approval-mode"
            value={draft.approvalMode}
            onChange={(e) => setField('approvalMode', e.target.value)}
            disabled={isLocked('approvalMode')}
            className={inputClass('approvalMode')}
          >
            <option value="">{t('aiUsagePage.defaultValue', { value: approvalModeDefaultLabel })}</option>
            <option value="per_step">{t('aiUsagePage.perStepDefault')}</option>
            <option value="action_plan">{t('aiUsagePage.actionPlan')}</option>
            <option value="auto_approve">{t('aiUsagePage.autoApprove')}</option>
            <option value="hybrid_plan">{t('aiUsagePage.hybridPlanAbort')}</option>
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(/* i18n-dynamic */ APPROVAL_MODE_HELP_KEYS[selectedApprovalMode])}
          </p>
          {lockedNote('approvalMode')}
        </label>

        <label className="block">
          <span className="text-sm text-muted-foreground">{t('aiUsagePage.monthlyBudget')}</span>
          <input
            data-testid="org-ai-budget-monthly"
            type="number"
            step="0.01"
            min={0}
            value={draft.monthlyBudgetCents}
            onChange={(e) => setField('monthlyBudgetCents', e.target.value)}
            placeholder={placeholderFor('monthlyBudgetCents')}
            disabled={isLocked('monthlyBudgetCents')}
            className={inputClass('monthlyBudgetCents')}
          />
          {lockedNote('monthlyBudgetCents')}
        </label>

        <label className="block">
          <span className="text-sm text-muted-foreground">{t('aiUsagePage.dailyBudget')}</span>
          <input
            data-testid="org-ai-budget-daily"
            type="number"
            step="0.01"
            min={0}
            value={draft.dailyBudgetCents}
            onChange={(e) => setField('dailyBudgetCents', e.target.value)}
            placeholder={placeholderFor('dailyBudgetCents')}
            disabled={isLocked('dailyBudgetCents')}
            className={inputClass('dailyBudgetCents')}
          />
          {lockedNote('dailyBudgetCents')}
        </label>

        <label className="block">
          <span className="text-sm text-muted-foreground">{t('aiUsagePage.alertThresholds')}</span>
          <AiBudgetThresholdsInput
            value={thresholds}
            onChange={(v) => { markTouched('alertThresholdPercents'); setThresholds(v); }}
            onValidityChange={setThresholdsValid}
            disabled={isLocked('alertThresholdPercents')}
            placeholder={effective.alertThresholdPercents.join(', ')}
            testId="org-ai-budget-thresholds"
          />
          {lockedNote('alertThresholdPercents')}
          <span className="mt-1 block text-xs text-muted-foreground">{t('aiUsagePage.alertThresholdsHelp')}</span>
        </label>

        <label className="block">
          <span className="text-sm text-muted-foreground">{t('aiUsagePage.maxTurnsPerSession')}</span>
          <input
            data-testid="org-ai-budget-max-turns"
            type="number"
            min={1}
            value={draft.maxTurnsPerSession}
            onChange={(e) => setField('maxTurnsPerSession', e.target.value)}
            placeholder={placeholderFor('maxTurnsPerSession')}
            disabled={isLocked('maxTurnsPerSession')}
            className={inputClass('maxTurnsPerSession')}
          />
          {lockedNote('maxTurnsPerSession')}
        </label>

        <label className="block">
          <span className="text-sm text-muted-foreground">{t('aiUsagePage.msgsMinPerUser')}</span>
          <input
            data-testid="org-ai-budget-messages-minute"
            type="number"
            min={1}
            value={draft.messagesPerMinutePerUser}
            onChange={(e) => setField('messagesPerMinutePerUser', e.target.value)}
            placeholder={placeholderFor('messagesPerMinutePerUser')}
            disabled={isLocked('messagesPerMinutePerUser')}
            className={inputClass('messagesPerMinutePerUser')}
          />
          {lockedNote('messagesPerMinutePerUser')}
        </label>

        <label className="block">
          <span className="text-sm text-muted-foreground">{t('aiUsagePage.msgsHrPerOrg')}</span>
          <input
            data-testid="org-ai-budget-messages-hour"
            type="number"
            min={1}
            value={draft.messagesPerHourPerOrg}
            onChange={(e) => setField('messagesPerHourPerOrg', e.target.value)}
            placeholder={placeholderFor('messagesPerHourPerOrg')}
            disabled={isLocked('messagesPerHourPerOrg')}
            className={inputClass('messagesPerHourPerOrg')}
          />
          {lockedNote('messagesPerHourPerOrg')}
        </label>

        <label className="block">
          <span className="text-sm text-muted-foreground">{t('aiUsagePage.toolRateLimitMultiplier')}</span>
          <input
            data-testid="org-ai-budget-tool-rate-limit-multiplier"
            type="number"
            step={1}
            min={TOOL_RATE_LIMIT_MULTIPLIER_MIN}
            max={TOOL_RATE_LIMIT_MULTIPLIER_MAX}
            value={draft.toolRateLimitMultiplier}
            onChange={(e) => setField('toolRateLimitMultiplier', e.target.value)}
            placeholder={placeholderFor('toolRateLimitMultiplier')}
            disabled={isLocked('toolRateLimitMultiplier')}
            className={inputClass('toolRateLimitMultiplier')}
          />
          {lockedNote('toolRateLimitMultiplier')}
          <span className="mt-1 block text-xs text-muted-foreground">{t('aiUsagePage.toolRateLimitMultiplierHelp')}</span>
        </label>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          data-testid="org-ai-budget-save"
          onClick={handleSave}
          disabled={saving || allFieldsLocked || !thresholdsValid}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {t('aiUsagePage.saveBudget')}
        </button>
        {allFieldsLocked && (
          <span className="text-sm text-amber-600 dark:text-amber-400 italic">
            {t('aiUsagePage.allBudgetSettingsAreManagedByYourPartner')}
          </span>
        )}
      </div>
    </section>
  );
}

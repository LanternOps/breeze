import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { InheritableAiBudgetSettings } from '@breeze/shared';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import AiBudgetThresholdsInput from './AiBudgetThresholdsInput';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import FieldLabel from './partnerSettings/FieldLabel';
import InheritanceLine from './partnerSettings/InheritanceLine';
import { TOOL_RATE_LIMIT_MULTIPLIER_MAX, TOOL_RATE_LIMIT_MULTIPLIER_MIN } from '@/lib/aiBudget';

/** The partner's AI switch for every organization: not set (orgs decide), on, or off. */
type AiAccess = '' | 'on' | 'off';

type Props = {
  /** Internal representation uses cents for budgets; this component displays dollars */
  data: InheritableAiBudgetSettings;
  onChange: (data: InheritableAiBudgetSettings) => void;
  /**
   * The alert-threshold box as typed (`null` until edited). The page owns it so
   * an unparseable ladder survives a tab switch and keeps Save blocked
   * (#4388 W03); validity is derived from it by the partners/me unit.
   */
  thresholdsText?: string | null;
  onThresholdsTextChange?: (text: string) => void;
};

export default function PartnerAiBudgetsTab({ data, onChange, thresholdsText, onThresholdsTextChange }: Props) {
  const { t } = useTranslation('settings');
  const set = (patch: Partial<InheritableAiBudgetSettings>) =>
    onChange({ ...data, ...patch });

  /** Convert cents to dollars for display; null/undefined → '' */
  const centsToDollars = (cents: number | null | undefined): string =>
    cents != null ? (cents / 100).toFixed(2) : '';

  /** Convert dollar input back to cents for storage */
  const dollarsToCents = (val: string): number | null | undefined =>
    val === '' ? undefined : Math.round(Number(val) * 100);

  // #9666: `enabled` is the AI on/off switch, not "budget enforcement". A
  // partner value wins over every organization's own AI switch and locks it,
  // so "not set" must leave the key out of the draft (the partner PATCH
  // replaces the stored block, which unlocks it) rather than write `false`.
  const aiAccess: AiAccess = data.enabled === true ? 'on' : data.enabled === false ? 'off' : '';
  const [confirmingOff, setConfirmingOff] = useState(false);

  const chooseAiAccess = (next: AiAccess) => {
    if (next === aiAccess) return;
    if (next === 'off') {
      // Staged until confirmed; the select keeps showing the current value.
      setConfirmingOff(true);
      return;
    }
    if (next === 'on') {
      set({ enabled: true });
      return;
    }
    const { enabled: _cleared, ...rest } = data;
    onChange(rest);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <FieldLabel htmlFor="partner-ai-budget-enabled" fieldId="aiBudgets.enabled">{t('partnerAiBudgets.aiAccess')}</FieldLabel>
        <select
          id="partner-ai-budget-enabled"
          data-testid="partner-ai-budget-enabled"
          value={aiAccess}
          onChange={e => chooseAiAccess(e.target.value as AiAccess)}
          aria-describedby="partner-ai-budget-enabled-help"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm sm:max-w-md"
        >
          <option value="">{t('partnerAiBudgets.aiAccessOptions.notSet')}</option>
          <option value="on">{t('partnerAiBudgets.aiAccessOptions.on')}</option>
          <option value="off">{t('partnerAiBudgets.aiAccessOptions.off')}</option>
        </select>
        <InheritanceLine fieldId="aiBudgets.enabled" />
        <p id="partner-ai-budget-enabled-help" className="text-xs text-muted-foreground">
          {t('partnerAiBudgets.aiAccessHelp')}
        </p>
        {aiAccess === 'off' && (
          <p
            data-testid="partner-ai-budget-off-warning"
            className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <span>{t('partnerAiBudgets.offWarning')}</span>
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmingOff}
        onClose={() => setConfirmingOff(false)}
        onConfirm={() => {
          setConfirmingOff(false);
          set({ enabled: false });
        }}
        title={t('partnerAiBudgets.offConfirmTitle')}
        message={t('partnerAiBudgets.offConfirmMessage')}
        confirmLabel={t('partnerAiBudgets.offConfirmAction')}
        variant="warning"
        confirmTestId="partner-ai-budget-off-confirm"
        dialogTestId="partner-ai-budget-off-confirm-dialog"
      />

      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <FieldLabel htmlFor="partner-ai-budget-monthly-budget" fieldId="aiBudgets.monthlyBudgetCents">{t('partnerAiBudgets.monthlyBudget')}</FieldLabel>
          <input
            id="partner-ai-budget-monthly-budget"
            type="number"
            step="0.01"
            min={0}
            value={centsToDollars(data.monthlyBudgetCents)}
            onChange={e => set({ monthlyBudgetCents: dollarsToCents(e.target.value) as number | undefined })}
            placeholder={t('partnerAiBudgets.notSet')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
          <InheritanceLine fieldId="aiBudgets.monthlyBudgetCents" />
        </div>

        <div className="space-y-2">
          <FieldLabel htmlFor="partner-ai-budget-daily-budget" fieldId="aiBudgets.dailyBudgetCents">{t('partnerAiBudgets.dailyBudget')}</FieldLabel>
          <input
            id="partner-ai-budget-daily-budget"
            type="number"
            step="0.01"
            min={0}
            value={centsToDollars(data.dailyBudgetCents)}
            onChange={e => set({ dailyBudgetCents: dollarsToCents(e.target.value) as number | undefined })}
            placeholder={t('partnerAiBudgets.notSet')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
          <InheritanceLine fieldId="aiBudgets.dailyBudgetCents" />
        </div>

        <div className="space-y-2">
          <FieldLabel htmlFor="partner-ai-budget-approval-mode" fieldId="aiBudgets.approvalMode">{t('partnerAiBudgets.approvalMode')}</FieldLabel>
          <select
            id="partner-ai-budget-approval-mode"
            value={data.approvalMode ?? ''}
            onChange={e => set({ approvalMode: (e.target.value || undefined) as InheritableAiBudgetSettings['approvalMode'] })}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{t('partnerAiBudgets.notSet')}</option>
            <option value="per_step">{t('partnerAiBudgets.modes.perStep')}</option>
            <option value="action_plan">{t('partnerAiBudgets.modes.actionPlan')}</option>
            <option value="auto_approve">{t('partnerAiBudgets.modes.autoApprove')}</option>
            <option value="hybrid_plan">{t('partnerAiBudgets.modes.hybridPlan')}</option>
          </select>
          <InheritanceLine fieldId="aiBudgets.approvalMode" />
        </div>

        <div className="space-y-2">
          <FieldLabel htmlFor="partner-ai-budget-max-turns" fieldId="aiBudgets.maxTurnsPerSession">{t('partnerAiBudgets.maxTurns')}</FieldLabel>
          <input
            id="partner-ai-budget-max-turns"
            type="number"
            value={data.maxTurnsPerSession ?? ''}
            onChange={e => set({ maxTurnsPerSession: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={t('partnerAiBudgets.notSet')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            min={1}
            max={100}
          />
          <InheritanceLine fieldId="aiBudgets.maxTurnsPerSession" />
        </div>

        <div className="space-y-2">
          <FieldLabel htmlFor="partner-ai-budget-messages-per-minute" fieldId="aiBudgets.messagesPerMinutePerUser">{t('partnerAiBudgets.messagesPerMinute')}</FieldLabel>
          <input
            id="partner-ai-budget-messages-per-minute"
            type="number"
            value={data.messagesPerMinutePerUser ?? ''}
            onChange={e => set({ messagesPerMinutePerUser: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={t('partnerAiBudgets.notSet')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            min={1}
            max={60}
          />
          <InheritanceLine fieldId="aiBudgets.messagesPerMinutePerUser" />
        </div>

        <div className="space-y-2">
          <FieldLabel htmlFor="partner-ai-budget-messages-per-hour" fieldId="aiBudgets.messagesPerHourPerOrg">{t('partnerAiBudgets.messagesPerHour')}</FieldLabel>
          <input
            id="partner-ai-budget-messages-per-hour"
            type="number"
            value={data.messagesPerHourPerOrg ?? ''}
            onChange={e => set({ messagesPerHourPerOrg: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={t('partnerAiBudgets.notSet')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            min={1}
            max={10000}
          />
          <InheritanceLine fieldId="aiBudgets.messagesPerHourPerOrg" />
        </div>

        <div className="space-y-2">
          <FieldLabel htmlFor="partner-ai-budget-tool-rate-limit-multiplier" fieldId="aiBudgets.toolRateLimitMultiplier">{t('aiUsagePage.toolRateLimitMultiplier')}</FieldLabel>
          <input
            id="partner-ai-budget-tool-rate-limit-multiplier"
            type="number"
            data-testid="partner-ai-budget-tool-rate-limit-multiplier"
            value={data.toolRateLimitMultiplier ?? ''}
            onChange={e => set({ toolRateLimitMultiplier: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={t('partnerAiBudgets.notSet')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            step={1}
            min={TOOL_RATE_LIMIT_MULTIPLIER_MIN}
            max={TOOL_RATE_LIMIT_MULTIPLIER_MAX}
          />
          <InheritanceLine fieldId="aiBudgets.toolRateLimitMultiplier" />
          <p className="text-xs text-muted-foreground">{t('aiUsagePage.toolRateLimitMultiplierHelp')}</p>
        </div>

        <div className="space-y-2 sm:col-span-2">
          <FieldLabel htmlFor="partner-ai-budget-thresholds" fieldId="aiBudgets.alertThresholdPercents">{t('partnerAiBudgets.alertThresholds')}</FieldLabel>
          <AiBudgetThresholdsInput
            id="partner-ai-budget-thresholds"
            value={data.alertThresholdPercents}
            onChange={(v) => set({ alertThresholdPercents: v })}
            text={thresholdsText}
            onTextChange={onThresholdsTextChange}
            placeholder={t('partnerAiBudgets.notSet')}
            testId="partner-ai-budget-thresholds"
          />
          <InheritanceLine fieldId="aiBudgets.alertThresholdPercents" />
          <p className="text-xs text-muted-foreground">{t('partnerAiBudgets.alertThresholdsHelp')}</p>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {t('partnerAiBudgets.description')}
      </p>
    </div>
  );
}

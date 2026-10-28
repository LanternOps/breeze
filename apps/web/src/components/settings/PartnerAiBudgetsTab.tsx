import type { InheritableAiBudgetSettings } from '@breeze/shared';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import AiBudgetThresholdsInput from './AiBudgetThresholdsInput';
import FieldLabel from './partnerSettings/FieldLabel';
import SettingBadge from './partnerSettings/SettingBadge';
import { TOOL_RATE_LIMIT_MULTIPLIER_MAX, TOOL_RATE_LIMIT_MULTIPLIER_MIN } from '@/lib/aiBudget';

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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={data.enabled ?? false}
            onChange={e => set({ enabled: e.target.checked })}
            className="h-4 w-4 rounded border"
          />
          <span className="text-sm font-medium">{t('partnerAiBudgets.enable')}</span>
        </label>
        <SettingBadge fieldId="aiBudgets.enabled" />
      </div>

      {data.enabled && (
        <>
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
              <p className="text-xs text-muted-foreground">{t('partnerAiBudgets.alertThresholdsHelp')}</p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {t('partnerAiBudgets.description')}
          </p>
        </>
      )}
    </div>
  );
}

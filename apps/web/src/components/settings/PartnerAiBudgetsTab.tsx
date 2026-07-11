import type { InheritableAiBudgetSettings } from '@breeze/shared';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

type Props = {
  /** Internal representation uses cents for budgets; this component displays dollars */
  data: InheritableAiBudgetSettings;
  onChange: (data: InheritableAiBudgetSettings) => void;
};

export default function PartnerAiBudgetsTab({ data, onChange }: Props) {
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
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={data.enabled ?? false}
          onChange={e => set({ enabled: e.target.checked })}
          className="h-4 w-4 rounded border"
        />
        <label className="text-sm font-medium">{t('partnerAiBudgets.enable')}</label>
      </div>

      {data.enabled && (
        <>
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('partnerAiBudgets.monthlyBudget')}</label>
              <input
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
              <label className="text-sm font-medium">{t('partnerAiBudgets.dailyBudget')}</label>
              <input
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
              <label className="text-sm font-medium">{t('partnerAiBudgets.approvalMode')}</label>
              <select
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
              <label className="text-sm font-medium">{t('partnerAiBudgets.maxTurns')}</label>
              <input
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
              <label className="text-sm font-medium">{t('partnerAiBudgets.messagesPerMinute')}</label>
              <input
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
              <label className="text-sm font-medium">{t('partnerAiBudgets.messagesPerHour')}</label>
              <input
                type="number"
                value={data.messagesPerHourPerOrg ?? ''}
                onChange={e => set({ messagesPerHourPerOrg: e.target.value ? Number(e.target.value) : undefined })}
                placeholder={t('partnerAiBudgets.notSet')}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                min={1}
                max={10000}
              />
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

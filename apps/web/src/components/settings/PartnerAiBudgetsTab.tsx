import type { InheritableAiBudgetSettings } from '@breeze/shared';

type Props = {
  /** Internal representation uses cents for budgets; this component displays dollars */
  data: InheritableAiBudgetSettings;
  onChange: (data: InheritableAiBudgetSettings) => void;
};

const PLACEHOLDER = 'Not set — orgs configure individually';

export default function PartnerAiBudgetsTab({ data, onChange }: Props) {
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
        <label className="text-sm font-medium">Enable AI budget enforcement</label>
      </div>

      {data.enabled && (
        <>
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Monthly Budget ($)</label>
              <input
                type="number"
                step="0.01"
                min={0}
                value={centsToDollars(data.monthlyBudgetCents)}
                onChange={e => set({ monthlyBudgetCents: dollarsToCents(e.target.value) as number | undefined })}
                placeholder={PLACEHOLDER}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Daily Budget ($)</label>
              <input
                type="number"
                step="0.01"
                min={0}
                value={centsToDollars(data.dailyBudgetCents)}
                onChange={e => set({ dailyBudgetCents: dollarsToCents(e.target.value) as number | undefined })}
                placeholder={PLACEHOLDER}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Approval Mode</label>
              <select
                value={data.approvalMode ?? ''}
                onChange={e => set({ approvalMode: (e.target.value || undefined) as InheritableAiBudgetSettings['approvalMode'] })}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">{PLACEHOLDER}</option>
                <option value="per_step">Per Step</option>
                <option value="action_plan">Action Plan</option>
                <option value="auto_approve">Auto Approve</option>
                <option value="hybrid_plan">Hybrid Plan</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Max Turns per Session</label>
              <input
                type="number"
                value={data.maxTurnsPerSession ?? ''}
                onChange={e => set({ maxTurnsPerSession: e.target.value ? Number(e.target.value) : undefined })}
                placeholder={PLACEHOLDER}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                min={1}
                max={100}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Messages per Minute per User</label>
              <input
                type="number"
                value={data.messagesPerMinutePerUser ?? ''}
                onChange={e => set({ messagesPerMinutePerUser: e.target.value ? Number(e.target.value) : undefined })}
                placeholder={PLACEHOLDER}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                min={1}
                max={60}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Messages per Hour per Org</label>
              <input
                type="number"
                value={data.messagesPerHourPerOrg ?? ''}
                onChange={e => set({ messagesPerHourPerOrg: e.target.value ? Number(e.target.value) : undefined })}
                placeholder={PLACEHOLDER}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                min={1}
                max={10000}
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Budget values are enforced across all child organizations. Dollar amounts are stored in cents internally.
          </p>
        </>
      )}
    </div>
  );
}

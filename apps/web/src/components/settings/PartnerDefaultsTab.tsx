import type { InheritableDefaultSettings } from '@breeze/shared';

type Props = {
  data: InheritableDefaultSettings;
  onChange: (data: InheritableDefaultSettings) => void;
};

const PLACEHOLDER = 'Not set — orgs configure individually';

export default function PartnerDefaultsTab({ data, onChange }: Props) {
  const set = (patch: Partial<InheritableDefaultSettings>) =>
    onChange({ ...data, ...patch });

  const autoEnrollment = data.autoEnrollment ?? { enabled: false, requireApproval: true, sendWelcome: true };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium">Agent Update Policy</label>
          <select
            value={data.agentUpdatePolicy ?? ''}
            onChange={e => set({ agentUpdatePolicy: e.target.value || undefined })}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{PLACEHOLDER}</option>
            <option value="auto">Auto-update</option>
            <option value="manual">Manual</option>
            <option value="staged">Staged rollout</option>
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Maintenance Window</label>
          <input
            type="text"
            value={data.maintenanceWindow ?? ''}
            onChange={e => set({ maintenanceWindow: e.target.value || undefined })}
            placeholder="e.g. Sun 02:00-06:00"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Time window for automatic updates and reboots.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Default Device Group</label>
          <input
            type="text"
            value={data.deviceGroup ?? ''}
            onChange={e => set({ deviceGroup: e.target.value || undefined })}
            placeholder={PLACEHOLDER}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Default Alert Threshold</label>
          <input
            type="text"
            value={data.alertThreshold ?? ''}
            onChange={e => set({ alertThreshold: e.target.value || undefined })}
            placeholder={PLACEHOLDER}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>
      </div>

      {/* Auto-enrollment */}
      <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
        <p className="text-sm font-medium">Auto-Enrollment</p>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoEnrollment.enabled}
              onChange={e =>
                set({ autoEnrollment: { ...autoEnrollment, enabled: e.target.checked } })
              }
              className="h-4 w-4 rounded border"
            />
            <label className="text-sm font-medium">Enable auto-enrollment for new devices</label>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoEnrollment.requireApproval}
              onChange={e =>
                set({ autoEnrollment: { ...autoEnrollment, requireApproval: e.target.checked } })
              }
              className="h-4 w-4 rounded border"
            />
            <label className="text-sm font-medium">Require admin approval</label>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoEnrollment.sendWelcome}
              onChange={e =>
                set({ autoEnrollment: { ...autoEnrollment, sendWelcome: e.target.checked } })
              }
              className="h-4 w-4 rounded border"
            />
            <label className="text-sm font-medium">Send welcome notification</label>
          </div>
        </div>
      </div>
    </div>
  );
}

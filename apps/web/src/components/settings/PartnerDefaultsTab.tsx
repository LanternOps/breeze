import type { InheritableDefaultSettings } from '@breeze/shared';
import { isValidMaintenanceWindow } from '@breeze/shared';

type Props = {
  data: InheritableDefaultSettings;
  onChange: (data: InheritableDefaultSettings) => void;
};

const PLACEHOLDER = 'Not set — orgs configure individually';

export default function PartnerDefaultsTab({ data, onChange }: Props) {
  const set = (patch: Partial<InheritableDefaultSettings>) =>
    onChange({ ...data, ...patch });

  const autoEnrollment = data.autoEnrollment ?? { enabled: false, requireApproval: true, sendWelcome: true };

  const maintenanceWindow = data.maintenanceWindow ?? '';
  const maintenanceWindowInvalid = maintenanceWindow.trim() !== '' && !isValidMaintenanceWindow(maintenanceWindow);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium">Agent Update Policy</label>
          <select
            // Fold the legacy 'staged' value into 'auto' for display — they are
            // behaviourally identical (both maintenance-window gated; no real
            // staged rollout exists, see #1962). The backend still accepts
            // 'staged' for back-compat.
            value={data.agentUpdatePolicy === 'staged' ? 'auto' : (data.agentUpdatePolicy ?? '')}
            onChange={e => set({ agentUpdatePolicy: e.target.value || undefined })}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{PLACEHOLDER}</option>
            <option value="auto">Automatic</option>
            <option value="manual">Manual (block automatic updates)</option>
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Maintenance Window</label>
          <input
            type="text"
            value={maintenanceWindow}
            onChange={e => set({ maintenanceWindow: e.target.value || undefined })}
            placeholder="e.g. Sun 02:00-06:00, 02:00-04:00, or 24/7"
            aria-invalid={maintenanceWindowInvalid}
            className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${
              maintenanceWindowInvalid ? 'border-destructive' : ''
            }`}
          />
          {maintenanceWindowInvalid ? (
            <p className="text-xs text-destructive">
              Use a UTC window like <code>Sun 02:00-04:00</code> or <code>02:00-04:00</code>, or{' '}
              <code>24/7</code> for always-on. Leave empty to let orgs configure it.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Time window (UTC) for automatic updates and reboots. Use <code>24/7</code> for
              always-on, or leave empty so orgs configure it individually.
            </p>
          )}
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

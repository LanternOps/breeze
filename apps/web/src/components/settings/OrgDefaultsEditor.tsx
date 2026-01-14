import { useState } from 'react';
import { Bell, Layers, RefreshCcw, Save, ShieldCheck, Sparkles } from 'lucide-react';

type OrgDefaultsEditorProps = {
  onDirty?: () => void;
  onSave?: () => void;
};

const mockDefaults = {
  organizationName: 'Breeze Labs',
  policyDefaults: {
    deviceCompliance: 'balanced',
    dataProtection: 'strict',
    accessControl: 'standard'
  },
  deviceGroup: 'All Managed Devices',
  alertThreshold: 'high',
  autoEnrollment: {
    enabled: true,
    requireApproval: false,
    sendWelcome: true
  },
  agentUpdatePolicy: 'staged',
  maintenanceWindow: 'Sun 02:00-04:00'
};

const policyOptions = [
  { value: 'strict', label: 'Strict' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'standard', label: 'Standard' },
  { value: 'lenient', label: 'Lenient' }
];

const groupOptions = ['All Managed Devices', 'Critical Infrastructure', 'Remote Staff', 'Contractors'];
const alertThresholds = [
  { value: 'critical', label: 'Critical only' },
  { value: 'high', label: 'High and critical' },
  { value: 'medium', label: 'Medium and above' }
];

export default function OrgDefaultsEditor({ onDirty, onSave }: OrgDefaultsEditorProps) {
  const [policyDefaults, setPolicyDefaults] = useState(mockDefaults.policyDefaults);
  const [deviceGroup, setDeviceGroup] = useState(mockDefaults.deviceGroup);
  const [alertThreshold, setAlertThreshold] = useState(mockDefaults.alertThreshold);
  const [autoEnrollment, setAutoEnrollment] = useState(mockDefaults.autoEnrollment);
  const [agentUpdatePolicy, setAgentUpdatePolicy] = useState(mockDefaults.agentUpdatePolicy);
  const [maintenanceWindow, setMaintenanceWindow] = useState(mockDefaults.maintenanceWindow);

  const markDirty = () => {
    onDirty?.();
  };

  const handleSave = () => {
    onSave?.();
  };

  return (
    <section className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Default settings</h2>
          <p className="text-sm text-muted-foreground">
            Tune the default policies and enrollment behavior for {mockDefaults.organizationName}.
          </p>
        </div>
        <button
          type="button"
          onClick={handleSave}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Save className="h-4 w-4" />
          Save defaults
        </button>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck className="h-4 w-4" />
          Default policies
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { id: 'deviceCompliance', label: 'Device compliance' },
            { id: 'dataProtection', label: 'Data protection' },
            { id: 'accessControl', label: 'Access control' }
          ].map(policy => (
            <label key={policy.id} className="space-y-2 rounded-lg border bg-muted/40 p-4 text-sm">
              <span className="font-medium">{policy.label}</span>
              <select
                value={policyDefaults[policy.id as keyof typeof policyDefaults]}
                onChange={event => {
                  setPolicyDefaults(prev => ({
                    ...prev,
                    [policy.id]: event.target.value
                  }));
                  markDirty();
                }}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                {policyOptions.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Layers className="h-4 w-4" />
            Default device group
          </div>
          <select
            value={deviceGroup}
            onChange={event => {
              setDeviceGroup(event.target.value);
              markDirty();
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            {groupOptions.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Newly enrolled devices are added to this group automatically.
          </p>
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Bell className="h-4 w-4" />
            Default alert severity
          </div>
          <select
            value={alertThreshold}
            onChange={event => {
              setAlertThreshold(event.target.value);
              markDirty();
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            {alertThresholds.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Alerts below this severity are delivered to the summary feed only.
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4" />
            Auto-enrollment
          </div>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>Enable automatic enrollment</span>
            <input
              type="checkbox"
              checked={autoEnrollment.enabled}
              onChange={event => {
                setAutoEnrollment(prev => ({ ...prev, enabled: event.target.checked }));
                markDirty();
              }}
              className="h-4 w-4"
            />
          </label>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>Require admin approval</span>
            <input
              type="checkbox"
              checked={autoEnrollment.requireApproval}
              onChange={event => {
                setAutoEnrollment(prev => ({ ...prev, requireApproval: event.target.checked }));
                markDirty();
              }}
              className="h-4 w-4"
            />
          </label>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>Send welcome message</span>
            <input
              type="checkbox"
              checked={autoEnrollment.sendWelcome}
              onChange={event => {
                setAutoEnrollment(prev => ({ ...prev, sendWelcome: event.target.checked }));
                markDirty();
              }}
              className="h-4 w-4"
            />
          </label>
        </div>

        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <RefreshCcw className="h-4 w-4" />
            Agent update policy
          </div>
          <select
            value={agentUpdatePolicy}
            onChange={event => {
              setAgentUpdatePolicy(event.target.value);
              markDirty();
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="auto">Automatic updates</option>
            <option value="staged">Staged rollout</option>
            <option value="manual">Manual approval</option>
          </select>
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase text-muted-foreground">
              Maintenance window
            </label>
            <input
              type="text"
              value={maintenanceWindow}
              onChange={event => {
                setMaintenanceWindow(event.target.value);
                markDirty();
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              placeholder="Sun 02:00-04:00"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Agents update during the maintenance window when possible.
          </p>
        </div>
      </div>
    </section>
  );
}

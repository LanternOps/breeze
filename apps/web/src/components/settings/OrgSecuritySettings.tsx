import { useState } from 'react';
import { Lock, Save, ShieldCheck, ShieldOff, Timer, Fingerprint } from 'lucide-react';
import { useOrgStore } from '../../stores/orgStore';
import { fetchWithAuth } from '../../stores/auth';

type SecurityData = {
  minLength?: number;
  complexity?: string;
  expirationDays?: number;
  requireMfa?: boolean;
  allowedMethods?: { totp: boolean; sms: boolean };
  sessionTimeout?: number;
  maxSessions?: number;
  ipAllowlist?: string;
};

type MtlsSettings = {
  certLifetimeDays?: number;
  expiredCertPolicy?: 'auto_reissue' | 'quarantine';
};

type OrgSecuritySettingsProps = {
  security?: SecurityData;
  mtls?: MtlsSettings;
  onDirty?: () => void;
  onSave?: (data: SecurityData) => void;
};

const defaultSecurity: SecurityData = {
  minLength: 12,
  complexity: 'standard',
  expirationDays: 90,
  requireMfa: true,
  allowedMethods: { totp: true, sms: false },
  sessionTimeout: 60,
  maxSessions: 3,
  ipAllowlist: ''
};

export default function OrgSecuritySettings({ security, mtls, onDirty, onSave }: OrgSecuritySettingsProps) {
  const initialData = { ...defaultSecurity, ...security };
  const [minLength, setMinLength] = useState(initialData.minLength || 12);
  const [complexity, setComplexity] = useState(initialData.complexity || 'standard');
  const [expirationDays, setExpirationDays] = useState(initialData.expirationDays || 90);
  const [requireMfa, setRequireMfa] = useState(initialData.requireMfa ?? true);
  const [allowedMethods, setAllowedMethods] = useState(initialData.allowedMethods || { totp: true, sms: false });
  const [sessionTimeout, setSessionTimeout] = useState(initialData.sessionTimeout || 60);
  const [maxSessions, setMaxSessions] = useState(initialData.maxSessions || 3);
  const [ipAllowlist, setIpAllowlist] = useState(initialData.ipAllowlist || '');

  // mTLS state
  const [certLifetimeDays, setCertLifetimeDays] = useState(mtls?.certLifetimeDays ?? 90);
  const [expiredCertPolicy, setExpiredCertPolicy] = useState<'auto_reissue' | 'quarantine'>(mtls?.expiredCertPolicy ?? 'auto_reissue');
  const [mtlsSaving, setMtlsSaving] = useState(false);
  const [mtlsError, setMtlsError] = useState<string>();
  const [mtlsSuccess, setMtlsSuccess] = useState(false);

  const { currentOrgId } = useOrgStore();

  const markDirty = () => {
    onDirty?.();
  };

  const handleSave = () => {
    const data: SecurityData = {
      minLength,
      complexity,
      expirationDays,
      requireMfa,
      allowedMethods,
      sessionTimeout,
      maxSessions,
      ipAllowlist
    };
    onSave?.(data);
  };

  const handleMtlsSave = async () => {
    if (!currentOrgId) return;

    setMtlsSaving(true);
    setMtlsError(undefined);
    setMtlsSuccess(false);

    try {
      const response = await fetchWithAuth(`/agents/org/${currentOrgId}/settings/mtls`, {
        method: 'PATCH',
        body: JSON.stringify({
          certLifetimeDays,
          expiredCertPolicy,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to save mTLS settings');
      }

      setMtlsSuccess(true);
      setTimeout(() => setMtlsSuccess(false), 3000);
    } catch (err) {
      setMtlsError(err instanceof Error ? err.message : 'Failed to save mTLS settings');
    } finally {
      setMtlsSaving(false);
    }
  };

  return (
    <section className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Security</h2>
          <p className="text-sm text-muted-foreground">
            Define password, MFA, and session requirements for your organization.
          </p>
        </div>
        <button
          type="button"
          onClick={handleSave}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Save className="h-4 w-4" />
          Save security
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Lock className="h-4 w-4" />
            Password policy
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">Minimum length</label>
              <input
                type="number"
                min={8}
                max={32}
                value={minLength}
                onChange={event => {
                  setMinLength(Number(event.target.value));
                  markDirty();
                }}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Complexity</label>
              <select
                value={complexity}
                onChange={event => {
                  setComplexity(event.target.value);
                  markDirty();
                }}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="standard">Standard</option>
                <option value="strict">Strict</option>
                <option value="passphrase">Passphrase</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Expiration (days)</label>
              <input
                type="number"
                min={30}
                max={365}
                value={expirationDays}
                onChange={event => {
                  setExpirationDays(Number(event.target.value));
                  markDirty();
                }}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Standard complexity requires 1 uppercase, 1 lowercase, 1 number, and 1 symbol.
          </p>
        </div>

        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            {requireMfa ? <ShieldCheck className="h-4 w-4" /> : <ShieldOff className="h-4 w-4" />}
            MFA settings
          </div>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>Require MFA for all users</span>
            <input
              type="checkbox"
              checked={requireMfa}
              onChange={event => {
                setRequireMfa(event.target.checked);
                markDirty();
              }}
              className="h-4 w-4"
            />
          </label>
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase text-muted-foreground">Allowed methods</p>
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>Authenticator app (TOTP)</span>
              <input
                type="checkbox"
                checked={allowedMethods.totp}
                onChange={event => {
                  setAllowedMethods(prev => ({ ...prev, totp: event.target.checked }));
                  markDirty();
                }}
                className="h-4 w-4"
              />
            </label>
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>SMS codes</span>
              <input
                type="checkbox"
                checked={allowedMethods.sms}
                onChange={event => {
                  setAllowedMethods(prev => ({ ...prev, sms: event.target.checked }));
                  markDirty();
                }}
                className="h-4 w-4"
              />
            </label>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Timer className="h-4 w-4" />
            Session settings
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Timeout (minutes)</label>
              <input
                type="number"
                min={15}
                max={240}
                value={sessionTimeout}
                onChange={event => {
                  setSessionTimeout(Number(event.target.value));
                  markDirty();
                }}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Max sessions</label>
              <input
                type="number"
                min={1}
                max={10}
                value={maxSessions}
                onChange={event => {
                  setMaxSessions(Number(event.target.value));
                  markDirty();
                }}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Sessions exceeding the limit are signed out automatically.
          </p>
        </div>

        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4" />
            IP allowlist
          </div>
          <textarea
            value={ipAllowlist}
            onChange={event => {
              setIpAllowlist(event.target.value);
              markDirty();
            }}
            rows={5}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="Enter one IP per line"
          />
          <p className="text-xs text-muted-foreground">
            Leave blank to allow all IPs. Use CIDR notation to allow ranges.
          </p>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t" />

      {/* mTLS Certificate Policy */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">mTLS Certificate Policy</h3>
          <p className="text-sm text-muted-foreground">
            Configure mutual TLS certificate lifecycle for agent connections.
          </p>
        </div>
        <button
          type="button"
          onClick={handleMtlsSave}
          disabled={mtlsSaving}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {mtlsSaving ? 'Saving...' : 'Save mTLS settings'}
        </button>
      </div>

      {mtlsError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {mtlsError}
        </div>
      ) : null}

      {mtlsSuccess ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          mTLS settings saved successfully.
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Fingerprint className="h-4 w-4" />
            Certificate lifetime
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Lifetime (days)</label>
            <input
              type="number"
              min={1}
              max={365}
              value={certLifetimeDays}
              onChange={event => {
                const val = Number(event.target.value);
                setCertLifetimeDays(Math.max(1, Math.min(365, val || 90)));
                markDirty();
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            How long each agent mTLS certificate remains valid before renewal is required.
            Shorter lifetimes improve security but increase renewal frequency. Default is 90 days.
          </p>
        </div>

        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4" />
            Expired certificate policy
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">When a certificate expires</label>
            <select
              value={expiredCertPolicy}
              onChange={event => {
                setExpiredCertPolicy(event.target.value as 'auto_reissue' | 'quarantine');
                markDirty();
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="auto_reissue">Auto Re-issue</option>
              <option value="quarantine">Quarantine</option>
            </select>
          </div>
          <p className="text-xs text-muted-foreground">
            {expiredCertPolicy === 'auto_reissue'
              ? 'The agent automatically receives a new certificate when the current one expires. This ensures uninterrupted connectivity.'
              : 'The device is quarantined when its certificate expires. An administrator must manually approve the device before it can reconnect.'}
          </p>
        </div>
      </div>
    </section>
  );
}

import { useState } from 'react';
import { Lock, Save, ShieldCheck, ShieldOff, Timer } from 'lucide-react';

type OrgSecuritySettingsProps = {
  onDirty?: () => void;
  onSave?: () => void;
};

const mockSecuritySettings = {
  minLength: 12,
  complexity: 'standard',
  expirationDays: 90,
  requireMfa: true,
  allowedMethods: {
    totp: true,
    sms: false
  },
  sessionTimeout: 60,
  maxSessions: 3,
  ipAllowlist: '203.0.113.10\n198.51.100.42'
};

export default function OrgSecuritySettings({ onDirty, onSave }: OrgSecuritySettingsProps) {
  const [minLength, setMinLength] = useState(mockSecuritySettings.minLength);
  const [complexity, setComplexity] = useState(mockSecuritySettings.complexity);
  const [expirationDays, setExpirationDays] = useState(mockSecuritySettings.expirationDays);
  const [requireMfa, setRequireMfa] = useState(mockSecuritySettings.requireMfa);
  const [allowedMethods, setAllowedMethods] = useState(mockSecuritySettings.allowedMethods);
  const [sessionTimeout, setSessionTimeout] = useState(mockSecuritySettings.sessionTimeout);
  const [maxSessions, setMaxSessions] = useState(mockSecuritySettings.maxSessions);
  const [ipAllowlist, setIpAllowlist] = useState(mockSecuritySettings.ipAllowlist);

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
    </section>
  );
}

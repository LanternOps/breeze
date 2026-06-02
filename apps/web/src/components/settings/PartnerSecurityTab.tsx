import type { InheritableSecuritySettings, IpAllowlistStatus } from '@breeze/shared';

type Props = {
  data: InheritableSecuritySettings;
  onChange: (data: InheritableSecuritySettings) => void;
  status?: IpAllowlistStatus | null;
  /** True when the status fetch failed (distinct from "no status yet"). */
  statusUnavailable?: boolean;
};

const PLACEHOLDER = 'Not set — orgs configure individually';

/** Split textarea input into trimmed, non-empty allowlist entries. */
export function parseAllowlistInput(text: string): string[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}

/**
 * Advisory client-side coverage check for the lockout warning. Returns true
 * (no warning) when the current IP is unknown, so we never block on uncertainty.
 * The server enforces the authoritative v4/v6 CIDR logic.
 */
export function currentIpCovered(currentIp: string | null, list: string[]): boolean {
  if (!currentIp) return true;
  if (list.includes(currentIp)) return true;
  // Lightweight IPv4 CIDR check for the common case; non-IPv4 entries fall back
  // to exact match (already handled above).
  return list.some(entry => {
    const [net, bitsRaw] = entry.split('/');
    const bits = Number(bitsRaw);
    if (!net.includes('.') || !currentIp.includes('.') || !Number.isInteger(bits)) {
      return entry === currentIp;
    }
    const toInt = (ip: string) => ip.split('.').reduce((a, p) => (a << 8) + Number(p), 0) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (toInt(net) & mask) === (toInt(currentIp) & mask);
  });
}

export default function PartnerSecurityTab({ data, onChange, status, statusUnavailable }: Props) {
  const set = (patch: Partial<InheritableSecuritySettings>) =>
    onChange({ ...data, ...patch });

  const list = data.ipAllowlist ?? [];
  const currentIp = status?.currentIp ?? null;
  const alreadyListed = currentIp ? list.includes(currentIp) : true;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-2">
        {/* Password Policy */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Minimum Password Length</label>
          <input
            type="number"
            value={data.minLength ?? ''}
            onChange={e => set({ minLength: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={PLACEHOLDER}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            min={6}
            max={128}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Password Complexity</label>
          <select
            value={data.complexity ?? ''}
            onChange={e => set({ complexity: (e.target.value || undefined) as InheritableSecuritySettings['complexity'] })}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{PLACEHOLDER}</option>
            <option value="standard">Standard</option>
            <option value="strict">Strict</option>
            <option value="passphrase">Passphrase</option>
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Password Expiration (days)</label>
          <input
            type="number"
            value={data.expirationDays ?? ''}
            onChange={e => set({ expirationDays: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={PLACEHOLDER}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            min={30}
            max={365}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Session Timeout (minutes)</label>
          <input
            type="number"
            value={data.sessionTimeout ?? ''}
            onChange={e => set({ sessionTimeout: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={PLACEHOLDER}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            min={15}
            max={240}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Max Concurrent Sessions</label>
          <input
            type="number"
            value={data.maxSessions ?? ''}
            onChange={e => set({ maxSessions: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={PLACEHOLDER}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            min={1}
            max={10}
          />
        </div>

        <div className="flex items-center gap-3 self-end pb-2">
          <input
            type="checkbox"
            checked={data.requireMfa ?? false}
            onChange={e => set({ requireMfa: e.target.checked })}
            className="h-4 w-4 rounded border"
          />
          <label className="text-sm font-medium">Require MFA for all users</label>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">IP Allowlist</label>

        {status && status.enforced && !status.active && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            Allowlist configured but <strong>inactive</strong> — the API isn’t seeing real client IPs.
            Configure proxy trust (<code>TRUST_PROXY_HEADERS</code> + <code>TRUSTED_PROXY_CIDRS</code>) for it to take effect.
          </div>
        )}

        {statusUnavailable && (
          <div className="rounded-md border border-muted-foreground/30 bg-muted px-3 py-2 text-xs text-muted-foreground">
            Couldn’t verify allowlist status. The server still enforces any saved allowlist — double-check your own IP is covered before saving.
          </div>
        )}

        <textarea
          value={list.join('\n')}
          onChange={e => {
            const lines = parseAllowlistInput(e.target.value);
            set({ ipAllowlist: lines.length > 0 ? lines : undefined });
          }}
          rows={4}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="Enter one IP or CIDR range per line. Leave blank to let each org decide."
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Leave blank to let each organization configure individually. Use CIDR notation for ranges.
            Requires a configured reverse proxy so the API can see real client IPs.
          </p>
          {currentIp && (
            <button
              type="button"
              disabled={alreadyListed}
              className="text-xs font-medium text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
              onClick={() => {
                if (!list.includes(currentIp)) {
                  set({ ipAllowlist: [...list, currentIp] });
                }
              }}
            >
              {alreadyListed ? `Your IP (${currentIp}) is listed` : `Add my current IP (${currentIp})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

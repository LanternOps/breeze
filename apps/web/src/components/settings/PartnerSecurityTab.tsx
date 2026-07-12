import type { InheritableSecuritySettings, IpAllowlistStatus } from '@breeze/shared';
import { Trans, useTranslation } from 'react-i18next';
import '@/lib/i18n';

type Props = {
  data: InheritableSecuritySettings;
  onChange: (data: InheritableSecuritySettings) => void;
  status?: IpAllowlistStatus | null;
  /** True when the status fetch failed (distinct from "no status yet"). */
  statusUnavailable?: boolean;
};

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
  const { t } = useTranslation('settings');
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
          <label className="text-sm font-medium">{t('partnerSecurity.minimumLength')}</label>
          <input
            type="number"
            value={data.minLength ?? ''}
            onChange={e => set({ minLength: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={t('partnerSecurity.notSet')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            min={6}
            max={128}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('partnerSecurity.complexity')}</label>
          <select
            value={data.complexity ?? ''}
            onChange={e => set({ complexity: (e.target.value || undefined) as InheritableSecuritySettings['complexity'] })}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{t('partnerSecurity.notSet')}</option>
            <option value="standard">{t('partnerSecurity.complexities.standard')}</option>
            <option value="strict">{t('partnerSecurity.complexities.strict')}</option>
            <option value="passphrase">{t('partnerSecurity.complexities.passphrase')}</option>
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('partnerSecurity.expiration')}</label>
          <input
            type="number"
            value={data.expirationDays ?? ''}
            onChange={e => set({ expirationDays: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={t('partnerSecurity.notSet')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            min={30}
            max={365}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('partnerSecurity.sessionTimeout')}</label>
          <input
            type="number"
            value={data.sessionTimeout ?? ''}
            onChange={e => set({ sessionTimeout: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={t('partnerSecurity.notSet')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            min={15}
            max={240}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('partnerSecurity.maxSessions')}</label>
          <input
            type="number"
            value={data.maxSessions ?? ''}
            onChange={e => set({ maxSessions: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={t('partnerSecurity.notSet')}
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
          <label className="text-sm font-medium">{t('partnerSecurity.requireMfa')}</label>
        </div>
      </div>

      <div className="space-y-3 rounded-md border p-4">
        <div>
          <p className="text-sm font-medium">{t('partnerSecurity.allowedMethods', { defaultValue: 'Allowed MFA methods' })}</p>
          <p className="text-xs text-muted-foreground">
            {t('partnerSecurity.allowedMethodsHelp', { defaultValue: 'Users required to enroll MFA must use at least one enabled method.' })}
          </p>
        </div>
        {(['totp', 'sms', 'passkey'] as const).map(method => (
          <label key={method} className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={data.allowedMethods?.[method] === true}
              onChange={e => set({
                allowedMethods: { ...data.allowedMethods, [method]: e.target.checked },
              })}
              className="h-4 w-4 rounded border"
            />
            <span>{t(/* i18n-dynamic */ `partnerSecurity.methods.${method}`, {
              defaultValue: method === 'totp' ? 'Authenticator app' : method === 'sms' ? 'Text message' : 'Passkeys',
            })}</span>
          </label>
        ))}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">{t('partnerSecurity.ipAllowlist')}</label>

        {status && status.enforced && !status.active && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <Trans i18nKey="partnerSecurity.inactiveWarning" t={t} components={{ strong: <strong />, first: <code />, second: <code /> }} />
          </div>
        )}

        {statusUnavailable && (
          <div className="rounded-md border border-muted-foreground/30 bg-muted px-3 py-2 text-xs text-muted-foreground">
            {t('partnerSecurity.statusUnavailable')}
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
          placeholder={t('partnerSecurity.allowlistPlaceholder')}
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {t('partnerSecurity.allowlistHelp')}
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
              {alreadyListed ? t('partnerSecurity.ipListed', { ip: currentIp }) : t('partnerSecurity.addCurrentIp', { ip: currentIp })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

import type { InheritableSecuritySettings, IpAllowlistStatus, SecurityLimitKey } from '@breeze/shared';
import { SECURITY_LIMIT_BOUNDS, SECURITY_LIMIT_KEYS, isValidSecurityLimit } from '@breeze/shared';
import { Trans, useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { SESSION_TIMEOUT_MAX_MINUTES } from '../../lib/sessionTimeout';
import FieldLabel from './partnerSettings/FieldLabel';
import SettingBadge from './partnerSettings/SettingBadge';
import InheritanceLine from './partnerSettings/InheritanceLine';

type Props = {
  data: InheritableSecuritySettings;
  onChange: (data: InheritableSecuritySettings) => void;
  status?: IpAllowlistStatus | null;
  /** True when the status fetch failed (distinct from "no status yet"). */
  statusUnavailable?: boolean;
  /**
   * The server's message for a limit it rejected on the last save, while the
   * field still holds the rejected value. Wins over the local range message.
   */
  serverErrors?: Partial<Record<SecurityLimitKey, string>>;
};

/** Input ids of the scalar limits; also the targets of the status line's "Fix" link. */
export const SECURITY_LIMIT_FIELD_IDS: Record<SecurityLimitKey, string> = {
  minLength: 'partner-security-min-length',
  expirationDays: 'partner-security-expiration',
  sessionTimeout: 'partner-security-session-timeout',
  maxSessions: 'partner-security-max-sessions',
};

/**
 * The scalar limits holding a value the API would reject, in form order. The
 * bounds come from @breeze/shared, the same schemas `PATCH /orgs/partners/me`
 * validates with (#10081).
 */
export function invalidSecurityLimits(data: InheritableSecuritySettings): SecurityLimitKey[] {
  return SECURITY_LIMIT_KEYS.filter(key => !isValidSecurityLimit(key, data[key]));
}

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

/**
 * A dual-stack listener reports an IPv4 client as `::ffff:a.b.c.d`. Show the
 * familiar dotted quad. Display only: the entry the button adds stays the exact
 * address the server reported, because the allowlist matcher never treats the
 * mapped and bare forms as the same address (apps/api/src/services/ipMatch.ts).
 */
export function displayIp(ip: string): string {
  return ip.replace(/^::ffff:(?=\d{1,3}(?:\.\d{1,3}){3}$)/i, '');
}

export default function PartnerSecurityTab({ data, onChange, status, statusUnavailable, serverErrors }: Props) {
  const { t } = useTranslation('settings');
  const set = (patch: Partial<InheritableSecuritySettings>) =>
    onChange({ ...data, ...patch });

  const invalid = new Set(invalidSecurityLimits(data));
  const limitError = (key: SecurityLimitKey): string | null => {
    const server = serverErrors?.[key];
    if (server) return server;
    if (!invalid.has(key)) return null;
    const bounds: { min: number; max?: number } = SECURITY_LIMIT_BOUNDS[key];
    return bounds.max === undefined
      ? t('partnerSecurity.errors.atLeast', { min: bounds.min })
      : t('partnerSecurity.errors.range', { min: bounds.min, max: bounds.max });
  };
  /** aria wiring and border for a limit input. */
  const limitInputProps = (key: SecurityLimitKey) => {
    const hasError = limitError(key) !== null;
    return {
      'aria-invalid': hasError || undefined,
      'aria-describedby': hasError ? `${SECURITY_LIMIT_FIELD_IDS[key]}-error` : undefined,
      className: `h-10 w-full rounded-md border bg-background px-3 text-sm${hasError ? ' border-destructive' : ''}`,
    };
  };
  const limitErrorText = (key: SecurityLimitKey) => {
    const message = limitError(key);
    if (message === null) return null;
    const id = `${SECURITY_LIMIT_FIELD_IDS[key]}-error`;
    return <p id={id} data-testid={id} className="text-xs text-destructive">{message}</p>;
  };

  const list = data.ipAllowlist ?? [];
  const currentIp = status?.currentIp ?? null;
  const alreadyListed = currentIp ? list.includes(currentIp) : true;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-2">
        {/* Password Policy */}
        <div className="space-y-2">
          <label htmlFor={SECURITY_LIMIT_FIELD_IDS.minLength} className="text-sm font-medium">{t('partnerSecurity.minimumLength')}</label>
          <input
            id={SECURITY_LIMIT_FIELD_IDS.minLength}
            type="number"
            value={data.minLength ?? ''}
            onChange={e => set({ minLength: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={t('partnerSecurity.notSet')}
            {...limitInputProps('minLength')}
            min={SECURITY_LIMIT_BOUNDS.minLength.min}
            max={SECURITY_LIMIT_BOUNDS.minLength.max}
          />
          {limitErrorText('minLength')}
        </div>

        <div className="space-y-2">
          <label htmlFor="partner-security-complexity" className="text-sm font-medium">{t('partnerSecurity.complexity')}</label>
          <select
            id="partner-security-complexity"
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
          <label htmlFor={SECURITY_LIMIT_FIELD_IDS.expirationDays} className="text-sm font-medium">{t('partnerSecurity.expiration')}</label>
          <input
            id={SECURITY_LIMIT_FIELD_IDS.expirationDays}
            type="number"
            value={data.expirationDays ?? ''}
            onChange={e => set({ expirationDays: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={t('partnerSecurity.notSet')}
            {...limitInputProps('expirationDays')}
            min={30}
            max={365}
          />
          {limitErrorText('expirationDays')}
        </div>

        <div className="space-y-2">
          <FieldLabel htmlFor={SECURITY_LIMIT_FIELD_IDS.sessionTimeout} fieldId="security.sessionTimeout">{t('partnerSecurity.sessionTimeout')}</FieldLabel>
          <input
            id={SECURITY_LIMIT_FIELD_IDS.sessionTimeout}
            type="number"
            value={data.sessionTimeout ?? ''}
            onChange={e => set({ sessionTimeout: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={t('partnerSecurity.notSet')}
            {...limitInputProps('sessionTimeout')}
            min={15}
            max={SESSION_TIMEOUT_MAX_MINUTES}
          />
          {limitErrorText('sessionTimeout')}
          <InheritanceLine fieldId="security.sessionTimeout" />
        </div>

        <div className="space-y-2">
          <label htmlFor={SECURITY_LIMIT_FIELD_IDS.maxSessions} className="text-sm font-medium">{t('partnerSecurity.maxSessions')}</label>
          <input
            id={SECURITY_LIMIT_FIELD_IDS.maxSessions}
            type="number"
            value={data.maxSessions ?? ''}
            onChange={e => set({ maxSessions: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={t('partnerSecurity.notSet')}
            {...limitInputProps('maxSessions')}
            min={SECURITY_LIMIT_BOUNDS.maxSessions.min}
            max={10}
          />
          {limitErrorText('maxSessions')}
        </div>

        <div className="space-y-1 self-end pb-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={data.requireMfa ?? false}
                onChange={e => set({ requireMfa: e.target.checked })}
                className="h-4 w-4 rounded border"
              />
              <span className="text-sm font-medium">{t('partnerSecurity.requireMfa')}</span>
            </label>
            <SettingBadge fieldId="security.requireMfa" />
          </div>
          <InheritanceLine fieldId="security.requireMfa" />
        </div>
      </div>

      <div className="space-y-2">
        <label htmlFor="partner-security-ip-allowlist" className="text-sm font-medium">{t('partnerSecurity.ipAllowlist')}</label>

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
          id="partner-security-ip-allowlist"
          aria-describedby="partner-security-ip-allowlist-help"
          value={list.join('\n')}
          onChange={e => {
            const lines = parseAllowlistInput(e.target.value);
            // Explicit [] (not undefined): the API keeps the stored list when
            // the key is omitted, so clearing must send the empty array.
            set({ ipAllowlist: lines });
          }}
          rows={4}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder={t('partnerSecurity.allowlistPlaceholder')}
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id="partner-security-ip-allowlist-help" className="text-xs text-muted-foreground">
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
              {alreadyListed
                ? t('partnerSecurity.ipListed', { ip: displayIp(currentIp) })
                : t('partnerSecurity.addCurrentIp', { ip: displayIp(currentIp) })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

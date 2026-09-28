import '@/lib/i18n';
import { useEffect, useState } from 'react';
import { Fingerprint } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  getAuthenticatorPolicyState,
  type EffectiveAuthenticatorPolicy,
} from '../../stores/authenticatorPolicy';
import { useOrgStore } from '../../stores/orgStore';

/** Long, UTC-pinned date: the platform date is a UTC instant, and a local
 * rendering could show the day before for viewers west of UTC. */
export function formatPolicyDate(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'long', timeZone: 'UTC' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * The platform-default approver-assurance notice. Rendered only for a partner
 * that inherits the platform default (no explicit approval-security choice):
 * before the date it announces when approver devices become required; from the
 * date it explains why high/critical approvals ask for a device.
 */
export function ApproverAssuranceDefaultNotice({
  effective,
  settingsHref,
}: {
  effective: EffectiveAuthenticatorPolicy;
  /** Link to the Approval Security setting; omitted on the setting itself. */
  settingsHref?: string | null;
}) {
  const { t, i18n } = useTranslation('approvals');
  if (!effective.defaultNotice || !effective.enforceFrom) return null;
  const date = formatPolicyDate(effective.enforceFrom, i18n.language);
  const active = effective.defaultNotice === 'active';
  return (
    <div
      role="status"
      data-testid="approver-assurance-default-notice"
      data-state={effective.defaultNotice}
      className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
    >
      <Fingerprint className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">
          {active
            ? t('assuranceDefaultNotice.activeTitle')
            : t('assuranceDefaultNotice.upcomingTitle', { date })}
        </p>
        <p className="text-muted-foreground">
          {active
            ? t('assuranceDefaultNotice.activeBody', { date })
            : t('assuranceDefaultNotice.upcomingBody', { date })}
        </p>
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          <a
            className="font-medium underline underline-offset-4"
            href="/settings/profile"
            data-testid="approver-assurance-register-link"
          >
            {t('assuranceDefaultNotice.registerLink')}
          </a>
          {settingsHref && (
            <a
              className="font-medium underline underline-offset-4"
              href={settingsHref}
              data-testid="approver-assurance-settings-link"
            >
              {t('assuranceDefaultNotice.settingsLink')}
            </a>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * Self-loading variant for the approvals inbox. Reads the partner policy; a
 * viewer who cannot read it (403) or a load failure renders nothing — the
 * notice is advisory, and the decide path's own step-up errors still apply.
 */
export function ApproverAssuranceNotice() {
  const { currentOrgId } = useOrgStore();
  const [effective, setEffective] = useState<EffectiveAuthenticatorPolicy | null>(null);

  useEffect(() => {
    let active = true;
    getAuthenticatorPolicyState()
      .then((state) => {
        if (active) setEffective(state?.effective ?? null);
      })
      .catch(() => {
        if (active) setEffective(null);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!effective) return null;
  return (
    <ApproverAssuranceDefaultNotice
      effective={effective}
      settingsHref={currentOrgId ? `/settings/organizations/${currentOrgId}#approval-security` : null}
    />
  );
}

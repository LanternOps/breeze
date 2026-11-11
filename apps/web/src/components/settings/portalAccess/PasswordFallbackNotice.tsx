import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { ActionError, runAction } from '@/lib/runAction';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { showToast } from '../../shared/Toast';
import HashLink from '../../shared/HashLink';
import type { PortalPasswordFallbackCause, PortalPasswordFallbackNotice } from './types';

type Props = {
  orgId: string;
  notice: PortalPasswordFallbackNotice;
  /**
   * Where "Re-run the tenant proof" goes: another tab of this page by its hash
   * (Domains → `portal`, rendered as a HashLink so the tab actually switches
   * under Astro's ClientRouter), or an in-place action (the Sign-in card).
   */
  rerun: { hash: string } | { onClick: () => void };
  /** The server recorded the dismissal; the parent hides the notice. */
  onDismissed: () => void;
  testIdPrefix: string;
};

const CAUSE_KEYS: Record<PortalPasswordFallbackCause, string> = {
  tenant_removed: 'portalAccessPolicy.passwordFallbackNotice.causes.tenant_removed',
  ai_for_office_mapping_removed: 'portalAccessPolicy.passwordFallbackNotice.causes.ai_for_office_mapping_removed',
  ai_for_office_mapping_changed: 'portalAccessPolicy.passwordFallbackNotice.causes.ai_for_office_mapping_changed',
  tenant_displaced: 'portalAccessPolicy.passwordFallbackNotice.causes.tenant_displaced',
};
const UNKNOWN_CAUSE_KEY = 'portalAccessPolicy.passwordFallbackNotice.causes.unknown';

const dismissUrl = (orgId: string) => `/orgs/organizations/${orgId}/portal-entra-tenant/password-fallback/dismiss`;
const toLogin = () => void navigateTo('/login', { replace: true });

/**
 * #11582: the org lost its proven Microsoft tenant while Microsoft sign-in was
 * on, so its portal fell back to password sign-in (W4 D2 keeps that fallback so
 * nobody is locked out). Shown to partner admins on the Sign-in & registration
 * card and on Organization › Domains until the tenant is proven again or an
 * admin dismisses it; the API derives it from the fallback audit row.
 */
export function PasswordFallbackNotice({ orgId, notice, rerun, onDismissed, testIdPrefix }: Props) {
  const { t } = useTranslation('settings');
  const [dismissing, setDismissing] = useState(false);
  const id = `${testIdPrefix}-password-fallback`;

  const dismiss = async () => {
    setDismissing(true);
    try {
      await runAction({
        request: () => fetchWithAuth(dismissUrl(orgId), { method: 'POST' }),
        errorFallback: t('portalAccessPolicy.passwordFallbackNotice.errors.dismiss'),
        successMessage: t('portalAccessPolicy.passwordFallbackNotice.toasts.dismissed'),
        onUnauthorized: toLogin,
      });
      onDismissed();
    } catch (err) {
      if (!(err instanceof ActionError)) {
        console.error('[PasswordFallbackNotice] dismiss failed', err);
        showToast({ type: 'error', message: t('portalAccessPolicy.passwordFallbackNotice.errors.dismiss') });
      }
    } finally {
      setDismissing(false);
    }
  };

  const causeKey = notice.cause ? CAUSE_KEYS[notice.cause] ?? UNKNOWN_CAUSE_KEY : UNKNOWN_CAUSE_KEY;
  const rerunClass = 'font-medium underline hover:no-underline';

  return (
    <div
      role="status"
      data-testid={id}
      className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
    >
      <p className="font-semibold">{t('portalAccessPolicy.passwordFallbackNotice.title')}</p>
      <p data-testid={`${id}-cause`}>
        {t(/* i18n-dynamic */ causeKey, { date: formatDateTime(notice.since) })}
        {notice.tenantId && <> {t('portalAccessPolicy.passwordFallbackNotice.tenant', { tenantId: notice.tenantId })}</>}
      </p>
      <p>{t('portalAccessPolicy.passwordFallbackNotice.body')}</p>
      <div className="flex flex-wrap gap-3 pt-1">
        {'hash' in rerun ? (
          <HashLink hash={rerun.hash} data-testid={`${id}-rerun`} className={rerunClass}>
            {t('portalAccessPolicy.passwordFallbackNotice.rerun')}
          </HashLink>
        ) : (
          <button type="button" data-testid={`${id}-rerun`} onClick={rerun.onClick} className={rerunClass}>
            {t('portalAccessPolicy.passwordFallbackNotice.rerun')}
          </button>
        )}
        <button
          type="button"
          data-testid={`${id}-dismiss`}
          disabled={dismissing}
          onClick={() => void dismiss()}
          className="text-amber-900/80 hover:text-amber-950 disabled:opacity-50 dark:text-amber-100/80 dark:hover:text-amber-50"
        >
          {t('portalAccessPolicy.passwordFallbackNotice.dismiss')}
        </button>
      </div>
    </div>
  );
}

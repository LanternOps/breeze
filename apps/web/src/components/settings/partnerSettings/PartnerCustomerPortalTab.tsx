import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '@/stores/auth';
import { PortalAccessPolicyForm } from '../portalAccess/PortalAccessPolicyForm';
import type { PortalAccessRequestSummary } from '../portalAccess/types';
import { usePortalAccessPolicyDraft } from './units/portalAccessPolicyUnit';

type SummaryState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; summary: PortalAccessRequestSummary };

function isRequestSummary(value: unknown): value is PortalAccessRequestSummary {
  const v = value as Partial<PortalAccessRequestSummary> | null;
  return !!v && typeof v.pendingTotal === 'number' && Array.isArray(v.orgs);
}

/** Pending access requests across the partner's organizations; each row links to that org's portal settings. */
export function PortalAccessRequestsSummary() {
  const { t } = useTranslation('settings');
  const [state, setState] = useState<SummaryState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    (async () => {
      try {
        const res = await fetchWithAuth('/orgs/partners/me/portal-access-requests/summary');
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { data?: unknown };
        if (!isRequestSummary(body.data)) throw new Error('unexpected summary body');
        if (!cancelled) setState({ status: 'ready', summary: body.data });
      } catch (err) {
        console.warn('[PartnerCustomerPortalTab] pending request summary load failed', err);
        if (!cancelled) setState({ status: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, [attempt]);

  return (
    <section className="rounded-lg border bg-card p-6 shadow-xs" data-testid="partner-portal-requests-summary">
      <h3 className="text-base font-semibold">{t('portalAccessRequests.summary.title')}</h3>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">{t('portalAccessRequests.summary.description')}</p>
      {state.status === 'error' && (
        <p role="alert" data-testid="partner-portal-requests-error" className="text-sm text-destructive">
          {t('portalAccessRequests.summary.loadError')}{' '}
          <button type="button" onClick={retry} className="underline hover:text-foreground">
            {t('common:actions.retry')}
          </button>
        </p>
      )}
      {state.status === 'ready' && state.summary.pendingTotal === 0 && (
        <p data-testid="partner-portal-requests-empty" className="text-sm text-muted-foreground">
          {t('portalAccessRequests.summary.empty')}
        </p>
      )}
      {state.status === 'ready' && state.summary.pendingTotal > 0 && (
        <ul className="divide-y rounded-md border">
          {state.summary.orgs.map((org) => (
            <li
              key={org.orgId}
              data-testid={`partner-portal-requests-org-${org.orgId}`}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
            >
              <span className="font-medium">{org.orgName}</span>
              <span className="flex items-center gap-3">
                <span className="text-muted-foreground">{t('portalAccessRequests.summary.orgPending', { count: org.pending })}</span>
                <a href={`/settings/organizations/${org.orgId}#portal`} className="text-primary hover:underline">
                  {t('portalAccessRequests.summary.review')}
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Partner "Customer portal" tab (portal registration W3, #11380): the
 * partner-wide default for how customers sign in and register. Edits are
 * drafts the settings header Save sends (portalAccessPolicyUnit.ts). Orgs
 * override it on their own Sign-in & registration card.
 */
export default function PartnerCustomerPortalTab() {
  const { t } = useTranslation('settings');
  const { slice, setDraft, retry } = usePortalAccessPolicyDraft();
  const value = slice.draft;

  return (
    <div className="space-y-6" data-testid="partner-customer-portal-tab">
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h3 className="text-base font-semibold">{t('portalAccessPolicy.title')}</h3>
        <p className="mt-1 mb-4 text-sm text-muted-foreground">{t('portalAccessPolicy.partnerDescription')}</p>
        {slice.status === 'error' && (
          <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
            <span>{t('portalAccessPolicy.errors.load')}</span>
            <button type="button" onClick={retry} className="rounded-md border px-2 py-1 text-foreground hover:bg-muted">
              {t('common:actions.retry')}
            </button>
          </div>
        )}
        {slice.status !== 'error' && !value && (
          <p className="text-sm text-muted-foreground">{t('portalAccessPolicy.loading')}</p>
        )}
        {value && (
          <PortalAccessPolicyForm
            view={value.view}
            draft={value.draft}
            onChange={(next) => setDraft((prev) => ({ ...prev, draft: next }))}
            onInvalidChange={(hoursInvalid) => setDraft((prev) => (prev.hoursInvalid === hoursInvalid ? prev : { ...prev, hoursInvalid }))}
          />
        )}
      </section>
      <PortalAccessRequestsSummary />
    </div>
  );
}

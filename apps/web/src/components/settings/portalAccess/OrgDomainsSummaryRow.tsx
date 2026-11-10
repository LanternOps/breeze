import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import HashLink from '../../shared/HashLink';
import { stateLabel } from '../orgDomains/labels';
import { customerDomainsUrl, normalizeCustomerDomainList, type CustomerDomainView } from '../orgDomains/types';

type Props = { orgId: string };

/** loading and hidden render nothing; error keeps the row so "no domains" and "could not load" differ. */
type RowState =
  | { status: 'loading' }
  | { status: 'hidden' }
  | { status: 'error' }
  | { status: 'ready'; rows: CustomerDomainView[] };

/**
 * The Sign-in & registration card's Domains row (spec §4): read-only, linking
 * to Organization › Domains. Its route has the domain-governance gate (plan D9),
 * stricter than the card's own ORGS_READ routes, so a caller without it (403)
 * simply does not see the row — the rest of the card renders as before.
 */
export function OrgDomainsSummaryRow({ orgId }: Props) {
  const { t } = useTranslation('settings');
  const [state, setState] = useState<RowState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    (async () => {
      try {
        const res = await fetchWithAuth(customerDomainsUrl(orgId));
        if (cancelled) return;
        // 401 is the card's own load to handle; 403 is "not for this caller".
        if (res.status === 401 || res.status === 403) { setState({ status: 'hidden' }); return; }
        if (!res.ok) throw new Error(`customer domains load failed: ${res.status}`);
        const body = (await res.json()) as { data?: unknown };
        const rows = normalizeCustomerDomainList(body.data, 'OrgDomainsSummaryRow');
        if (!cancelled) setState({ status: 'ready', rows });
      } catch (err) {
        if (cancelled) return;
        console.error('[OrgDomainsSummaryRow] load failed', err);
        setState({ status: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  if (state.status === 'loading' || state.status === 'hidden') return null;

  // Verified first, so the domains sign-in trusts lead the line.
  const ordered = state.status === 'ready'
    ? [...state.rows].sort((a, b) => Number(b.state === 'verified') - Number(a.state === 'verified'))
    : [];

  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t pt-4 text-sm" data-testid="org-sign-in-domains-row">
      <span className="w-40 shrink-0 font-medium">{t('portalAccessPolicy.domains.label')}</span>
      <span className="min-w-0 flex-1 text-muted-foreground">
        {state.status === 'error' ? (
          <span data-testid="org-sign-in-domains-error">{t('portalAccessPolicy.domains.loadFailed')}</span>
        ) : ordered.length === 0 ? (
          t('portalAccessPolicy.domains.none')
        ) : (
          ordered.map((d, i) => (
            <span key={d.id} data-testid={`org-sign-in-domain-${d.id}`}>
              {i > 0 && ' · '}
              <span className="text-foreground">{d.domain}</span> ({stateLabel(t, d)})
            </span>
          ))
        )}
      </span>
      <HashLink hash="domains" className="text-primary hover:underline" data-testid="org-sign-in-domains-link">
        {t('portalAccessPolicy.domains.manage')}
      </HashLink>
    </div>
  );
}

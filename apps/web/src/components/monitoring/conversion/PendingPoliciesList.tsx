import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchPendingCounts, type PendingCounts } from './conversionApi';

/**
 * The policies that still hold unretired legacy rows. Reads the same
 * org-scoped `/conversion/pending` endpoint as the banner, whose list and count
 * come from one query (countPendingConversions), so the two always agree.
 */
export default function PendingPoliciesList({ orgId }: { orgId: string | null }) {
  const { t } = useTranslation(['monitoring']);
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error' } | { status: 'ready'; data: PendingCounts }>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetchPendingCounts(orgId)
      .then((data) => { if (!cancelled) setState({ status: 'ready', data }); })
      .catch(() => { if (!cancelled) setState({ status: 'error' }); });
    return () => { cancelled = true; };
  }, [orgId]);
  if (state.status === 'loading') return <p className="text-sm text-muted-foreground">{t('monitoring:conversion.pendingPolicies.loading')}</p>;
  if (state.status === 'error') return <p className="text-sm text-destructive" role="alert" data-testid="pending-policies-error">{t('monitoring:conversion.pendingPolicies.error')}</p>;
  const pending = state.data.pendingPolicies ?? [];
  if (pending.length === 0) return <p className="text-sm text-muted-foreground" data-testid="pending-policies-empty">{t('monitoring:conversion.pendingPolicies.empty')}</p>;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{t('monitoring:conversion.pendingPolicies.title')}</h2>
      <ul className="divide-y rounded-md border bg-card">
        {pending.map((p) => (
          <li key={p.id} data-testid={`pending-policy-${p.id}`} className="px-4 py-3 text-sm">
            <a href={`/configuration-policies/${p.id}#monitors`} className="font-medium underline-offset-2 hover:underline">{p.name}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

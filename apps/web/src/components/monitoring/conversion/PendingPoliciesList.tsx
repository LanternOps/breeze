import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { ScopeBadge } from '../../shared/ScopeBadge';

const LEGACY_LINK_TYPES = ['alert_rule', 'monitoring', 'automation'] as const;
const SOURCE_LABEL_KEY: Record<(typeof LEGACY_LINK_TYPES)[number], string> = {
  alert_rule: 'monitoring:conversion.sourceTables.config_policy_alert_rules',
  monitoring: 'monitoring:conversion.sourceTables.config_policy_monitoring_watches',
  automation: 'monitoring:conversion.sourceTables.config_policy_automations',
};
type PolicyRow = { id: string; name: string; orgId: string | null; partnerId: string | null; featureLinks: Array<{ id: string; featureType: string }> };

/**
 * Which policies still carry a legacy link. The API's `pending` count is the
 * truth for the banner; this list over-approximates after a conversion (the
 * link row survives, its rows are retired) — the policy's own panel then
 * shows nothing, which is the honest answer.
 */
export default function PendingPoliciesList() {
  const { t } = useTranslation(['monitoring', 'policies']);
  const [rows, setRows] = useState<PolicyRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/configuration-policies?limit=100')
      .then(async (res) => (res.ok ? res.json() : { data: [] }))
      .then((json) => { if (!cancelled) setRows(Array.isArray(json?.data) ? json.data : []); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, []);
  const pending = (rows ?? []).filter((p) => p.featureLinks.some((l) => (LEGACY_LINK_TYPES as readonly string[]).includes(l.featureType)));
  if (rows === null) return <p className="text-sm text-muted-foreground">{t('monitoring:conversion.pendingPolicies.loading')}</p>;
  if (pending.length === 0) return <p className="text-sm text-muted-foreground" data-testid="pending-policies-empty">{t('monitoring:conversion.pendingPolicies.empty')}</p>;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{t('monitoring:conversion.pendingPolicies.title')}</h2>
      <ul className="divide-y rounded-md border bg-card">
        {pending.map((p) => (
          <li key={p.id} data-testid={`pending-policy-${p.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
            <div className="flex items-center gap-2">
              <a href={`/configuration-policies/${p.id}#monitors`} className="font-medium underline-offset-2 hover:underline">{p.name}</a>
              <ScopeBadge orgId={p.orgId} partnerId={p.partnerId} isSystem={false} />
            </div>
            <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
              {p.featureLinks
                .filter((l): l is { id: string; featureType: (typeof LEGACY_LINK_TYPES)[number] } => (LEGACY_LINK_TYPES as readonly string[]).includes(l.featureType))
                .map((l) => <span key={l.id} className="rounded-full border px-2 py-0.5">{t(/* i18n-dynamic */ SOURCE_LABEL_KEY[l.featureType])}</span>)}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

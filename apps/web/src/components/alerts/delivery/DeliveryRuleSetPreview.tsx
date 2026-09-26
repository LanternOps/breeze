import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MONITOR_KINDS, monitorKindSchema, monitorSeveritySchema, type MonitorKind } from '@breeze/shared';
import { useHashState } from '@/lib/useHashState';
import { fetchAllSites } from '@/lib/fetchAllSites';
import DeliveryPreview from './DeliveryPreview';
const initial = 'preview/high/all/all';
function parseHash(hash: string): string | undefined {
  const [prefix, severity, kind, site, extra] = hash.split('/');
  if (prefix !== 'preview' || extra || !monitorSeveritySchema.safeParse(severity).success) return undefined;
  if (kind !== 'all' && !monitorKindSchema.safeParse(kind).success) return undefined;
  if (site !== 'all' && !/^[0-9a-f-]{36}$/i.test(site ?? '')) return undefined;
  return hash;
}
export default function DeliveryRuleSetPreview({ orgId, refreshToken }: { orgId: string | null; refreshToken?: number }) {
  const { t } = useTranslation('monitoring');
  const [hash, setHash] = useHashState<string>(initial, parseHash);
  const [, severityValue, kindValue, siteValue] = hash.split('/');
  const severity = monitorSeveritySchema.parse(severityValue);
  const kind = kindValue === 'all' ? undefined : kindValue as MonitorKind;
  const [sites, setSites] = useState<Array<{ id: string; name: string }>>([]);
  const [sitesError, setSitesError] = useState(false);
  useEffect(() => {
    let active = true; setSites([]); setSitesError(false);
    if (orgId) void fetchAllSites<{ id: string; name: string }>(`/orgs/sites?organizationId=${encodeURIComponent(orgId)}`)
      .then(rows => { if (active) setSites(rows); })
      .catch(() => { if (active) setSitesError(true); });
    return () => { active = false; };
  }, [orgId]);
  const site = sites.some(s => s.id === siteValue) ? siteValue : undefined;
  const change = (severity: string, kind: string, site: string) => {
    const next = `preview/${severity}/${kind}/${site}`;
    setHash(next);
    window.location.hash = next;
  };
  return <section className="space-y-3" data-testid="delivery-rule-set-preview">
    <h2 className="text-lg font-semibold">{t('editor.deliveryPreview.testRules')}</h2>
    <div className="flex flex-wrap gap-3">
      <label className="space-y-1 text-sm">{t('editor.fields.severity')}<select className="block h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring" data-testid="delivery-preview-severity" value={severity}
        onChange={e => change(e.target.value, kindValue!, siteValue!)}>
        {(['critical', 'high', 'medium', 'low', 'info'] as const).map(s => <option key={s} value={s}>{t(/* i18n-dynamic */ `severities.${s}`)}</option>)}
      </select></label>
      <label className="space-y-1 text-sm">{t('editor.deliveryPreview.kind')}<select className="block h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring" value={kindValue} data-testid="delivery-preview-kind"
        onChange={e => change(severity, e.target.value, siteValue!)}>
        <option value="all">{t('editor.deliveryPreview.noKind')}</option>
        {MONITOR_KINDS.map(k => <option key={k} value={k}>{t(/* i18n-dynamic */ `kinds.${k}`)}</option>)}
      </select></label>
      <label className="space-y-1 text-sm">{t('editor.deliveryPreview.site')}<select className="block h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring" value={site ?? 'all'} data-testid="delivery-preview-site"
        onChange={e => change(severity, kindValue!, e.target.value)}>
        <option value="all">{t('editor.deliveryPreview.noSite')}</option>
        {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select></label>
    </div>
    {sitesError && <p role="alert">{t('editor.deliveryPreview.sitesFailed')}</p>}
    <DeliveryPreview orgId={orgId} severity={severity} kind={kind} siteId={site} refreshToken={refreshToken} />
  </section>;
}

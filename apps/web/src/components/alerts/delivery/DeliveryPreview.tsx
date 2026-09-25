import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import type { AlertSeverity, MonitorKind } from '@breeze/shared';

type Answer = {
  source: 'monitor_none' | 'monitor_channels' | 'legacy_override' | 'routing_rule' | 'default_row' | 'none';
  channelIds: string[]; skippedChannelIds: Array<{ id: string; reason: 'disabled' | 'unavailable' }>; escalationPolicyId: string | null; routingRuleName?: string;
  description: { channels: Array<{ id: string; name: string; enabled: boolean }>;
    escalationPolicy: { id: string; name: string } | null; owner: 'partner' | 'organization' | null };
};
export default function DeliveryPreview({ orgId, severity, kind, siteId, monitorId, escalationOverride, refreshToken }: {
  orgId: string | null; severity: AlertSeverity; kind?: MonitorKind; siteId?: string; monitorId?: string;
  escalationOverride?: { id: string; name: string } | null;
  /** Bump this (e.g. after a routing rule/channel/escalation policy is created or edited elsewhere on the
   * page) to force a re-resolve even though severity/kind/site/monitor haven't changed. See #6497 G1-3. */
  refreshToken?: number;
}) {
  const { t, i18n } = useTranslation('monitoring');
  const [attempt, retry] = useState(0);
  const query = new URLSearchParams({ orgId: orgId ?? '', severity });
  if (kind) query.set('kind', kind);
  if (siteId) query.set('siteId', siteId);
  if (monitorId) query.set('monitorId', monitorId);
  const key = query.toString();
  const [state, setState] = useState<{ key: string; answer?: Answer; error?: boolean }>({ key: '' });
  useEffect(() => {
    if (!orgId) return;
    let active = true;
    setState({ key });
    void fetchWithAuth(`/alerts/delivery/resolve?${key}`)
      .then(async response => {
        if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
        if (!response.ok) throw new Error('Delivery preview failed');
        const answer = await response.json() as Answer;
        if (!answer.description || !Array.isArray(answer.channelIds)) throw new Error('Invalid delivery preview');
        if (active) setState({ key, answer });
      })
      .catch(() => { if (active) setState({ key, error: true }); });
    return () => { active = false; };
  }, [orgId, key, attempt, refreshToken]);
  if (!orgId) return <p className="text-sm text-muted-foreground">{t('editor.deliveryPreview.selectOrg')}</p>;
  if (state.key === key && state.error) return <div role="alert" className="text-sm text-destructive">
    {t('editor.deliveryPreview.failed')} <button type="button" data-testid="delivery-preview-retry" onClick={() => retry(n => n + 1)}>{t('common:actions.retry')}</button>
  </div>;
  const answer = state.key === key ? state.answer : undefined;
  if (!answer) return <p role="status" className="text-sm text-muted-foreground">{t('editor.deliveryPreview.loading')}</p>;
  const channelNames = answer.channelIds.map(id => {
    const channel = answer.description.channels.find(c => c.id === id);
    return channel ? (channel.enabled ? channel.name : t('editor.deliveryPreview.disabled', { name: channel.name })) : t('editor.deliveryPreview.unavailable');
  });
  const channels = channelNames.length ? new Intl.ListFormat(i18n.language, { style: 'long', type: 'conjunction' }).format(channelNames) : t('editor.deliveryModes.none');
  const sourceKey = answer.source === 'routing_rule'
    ? (answer.description.owner === 'partner' ? 'partnerRule' : 'orgRule')
    : answer.source === 'default_row'
      ? (answer.description.owner === 'partner' ? 'partnerDefault' : 'orgDefault')
      : answer.source === 'none' ? 'noRow' : 'monitorOverride';
  const escalation = escalationOverride ?? answer.description.escalationPolicy;
  return <div className="space-y-1 rounded-md border bg-muted/20 p-3 text-sm" data-testid="delivery-preview-result" aria-live="polite">
    <p>{t('editor.deliveryPreview.destination', { severity: t(/* i18n-dynamic */ `severities.${severity}`), channels })}</p>
    <p className="text-muted-foreground">{t(/* i18n-dynamic */ `editor.deliveryPreview.${sourceKey}`, { name: answer.routingRuleName ?? '' })}</p>
    {escalation && <p>{t('editor.deliveryPreview.escalation', { name: escalation.name })}</p>}
    <ul data-testid="delivery-preview-skipped">{answer.skippedChannelIds.map(channel => <li key={channel.id}>
      {t('editor.deliveryPreview.skipped', { id: channel.id,
        reason: t(/* i18n-dynamic */ `editor.deliveryPreview.skipReasons.${channel.reason}`) })}
    </li>)}</ul>
    {!siteId && <p className="text-xs text-muted-foreground">{t('editor.deliveryPreview.withoutSite')}</p>}
  </div>;
}

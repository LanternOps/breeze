import DeliveryRuleSetPreview from './delivery/DeliveryRuleSetPreview';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AlertsTabStrip from './AlertsTabStrip';
import type { NotificationChannel } from './NotificationChannelList';
import ChannelsSection from './delivery/ChannelsSection';
import RoutingSection from './delivery/RoutingSection';
import EscalationPoliciesSection from './delivery/EscalationPoliciesSection';
import type { EscalationPolicy, RoutingRule } from './delivery/deliveryActions';
import { useDeliveryResource } from './delivery/useDeliveryResource';
import { useOrgStore } from '../../stores/orgStore';
import { useDefaultOwnerScope } from '@/hooks/useDefaultOwnerScope';
import { navigateTo } from '@/lib/navigation';
import '../../lib/i18n';
export default function DeliveryPage() {
  const { t } = useTranslation('alerts');
  const { currentOrgId } = useOrgStore();
  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
  const suffix = currentOrgId ? `&orgId=${encodeURIComponent(currentOrgId)}` : '';
  const channels = useDeliveryResource<NotificationChannel>(`/alerts/delivery/rails?rail=channels${suffix}`);
  const routing = useDeliveryResource<RoutingRule>(`/alerts/delivery/rails?rail=routing${suffix}`);
  const policies = useDeliveryResource<EscalationPolicy>(`/alerts/delivery/rails?rail=escalation${suffix}`);
  const onUnauthorized = useCallback(() => { void navigateTo('/login', { replace: true }); }, []);
  // Bumped whenever a channel/routing rule/escalation policy is created or edited so the
  // "Test this rule set" preview below re-resolves instead of showing a stale answer (#6497 G1-3).
  const [rulesVersion, setRulesVersion] = useState(0);
  const onChanged = async () => { channels.reload(); routing.reload(); policies.reload(); setRulesVersion(v => v + 1); };
  const choices = [...channels.data.map(({ id, name, type, enabled }) => ({ id, name, type, enabled })), ...channels.inherited];
  const props = { currentOrgId, isPartnerScope, defaultOwnerScope, onChanged, onUnauthorized };
  const state = (resource: { status: string; reload: () => void }, key: string) => resource.status === 'error'
    ? <div role="alert" data-testid={`delivery-${key}-error`}>{t('deliveryPage.loadFailed')}
        <button type="button" data-testid={`delivery-${key}-retry`} onClick={resource.reload}>{t('common:actions.retry')}</button></div>
    : resource.status === 'loading' ? <p role="status">{t('deliveryPage.loading')}</p> : null;
  return <div className="space-y-8">
    <AlertsTabStrip currentPath="/alerts/delivery" />
    <div><h1 className="text-xl font-semibold tracking-tight">{t('deliveryPage.title')}</h1><p className="text-muted-foreground">{t('deliveryPage.subtitle')}</p></div>
    {state(channels, 'channels')}
    {channels.status === 'success' && <>
      <ChannelsSection {...props} channels={channels.data} />
      {channels.inherited.length > 0 && <section data-testid="delivery-inherited-channels" className="space-y-3">
        <h2 className="text-lg font-semibold">{t('deliveryPage.sections.inheritedChannels')}</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{channels.inherited.map(channel => <div key={channel.id}
          data-testid={`delivery-inherited-channel-${channel.id}`} className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{channel.name}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{t('notificationChannelsPage.allOrgs')}</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t(/* i18n-dynamic */ `notificationChannelList.channelType.${channel.type}`, { defaultValue: channel.type })}</p>
          <p className="mt-2 text-xs text-muted-foreground">{t('deliveryPage.routing.partnerRowHint')}</p>
        </div>)}</div>
      </section>}
    </>}
    {state(routing, 'routing')}{state(policies, 'escalation')}
    {channels.status === 'success' && routing.status === 'success' && policies.status === 'success' &&
      <RoutingSection {...props} channels={choices} rules={routing.data} policies={policies.data} />}
    <DeliveryRuleSetPreview orgId={currentOrgId} refreshToken={rulesVersion} />
    {channels.status === 'success' && policies.status === 'success' &&
      <EscalationPoliciesSection {...props} channels={choices} policies={policies.data} />}
  </div>;
}

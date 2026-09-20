import DeliveryRuleSetPreview from './delivery/DeliveryRuleSetPreview';
import { useCallback } from 'react';
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
  const onChanged = async () => { channels.reload(); routing.reload(); policies.reload(); };
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
      <ul data-testid="delivery-inherited-channels">{channels.inherited.map(channel => <li key={channel.id}>
        {channel.name} ({channel.type}) · {t('notificationChannelsPage.allOrgs')} · {t('deliveryPage.routing.partnerRowHint')}
      </li>)}</ul>
    </>}
    {state(routing, 'routing')}{state(policies, 'escalation')}
    {channels.status === 'success' && routing.status === 'success' && policies.status === 'success' &&
      <RoutingSection {...props} channels={choices} rules={routing.data} policies={policies.data} />}
    <DeliveryRuleSetPreview orgId={currentOrgId} />
    {channels.status === 'success' && policies.status === 'success' &&
      <EscalationPoliciesSection {...props} channels={choices} policies={policies.data} />}
  </div>;
}

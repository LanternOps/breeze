import { fetchWithAuth } from '../../../stores/auth';
import { runAction, ActionError } from '../../../lib/runAction';
import { showToast } from '../../shared/Toast';
import { i18n } from '../../../lib/i18n';

// Exported for unit-testing without mounting the full component.
export async function runChannelTest(
  channel: { id: string; name: string },
  deps: { fetchChannels: () => Promise<void>; onUnauthorized: () => void }
): Promise<void> {
  try {
    // T shape only informs isApiFailure/extractApiError; return value is unused.
    await runAction<{ testResult?: { success: boolean; message?: string } }>({
      request: () => fetchWithAuth(`/alerts/channels/${channel.id}/test`, { method: 'POST' }),
      successMessage: i18n.t('alerts:notificationChannelsPage.testNotificationSent', { name: channel.name }),
      errorFallback: i18n.t('alerts:notificationChannelsPage.channelTestFailed'),
      onUnauthorized: deps.onUnauthorized,
    });
  } catch (err) {
    // runAction already surfaced an ActionError via toast. Skip the refetch on
    // 401 — onUnauthorized is redirecting to /login and the page is being
    // replaced; a second authenticated request would be noise.
    if (err instanceof ActionError && err.status === 401) return;
    // A non-ActionError escaped runAction (e.g. onUnauthorized threw, or a bug
    // in this wrapper). runAction never toasted it — surface it so the failure
    // is not silent (the exact class WS-A exists to remove). Mirrors the
    // catch pattern used by the sibling handlers in this file.
    if (!(err instanceof ActionError)) {
      showToast({ message: err instanceof Error ? err.message : i18n.t('alerts:notificationChannelsPage.channelTestFailed'), type: 'error' });
    }
    // ActionError non-401: already toasted by runAction — fall through to refetch.
  }
  await deps.fetchChannels();
}

// Exported for unit-testing without mounting the full component.
export async function runChannelSave(
  opts: { url: string; method: string; payload: unknown; channelName: string; isCreate: boolean },
  deps: { onUnauthorized: () => void }
): Promise<void> {
  const name = opts.channelName;
  await runAction({
    request: () => fetchWithAuth(opts.url, { method: opts.method, body: JSON.stringify(opts.payload) }),
    successMessage: opts.isCreate
      ? (name ? i18n.t('alerts:notificationChannelsPage.channelCreatedWithName', { name }) : i18n.t('alerts:notificationChannelsPage.channelCreated'))
      : (name ? i18n.t('alerts:notificationChannelsPage.channelSavedWithName', { name }) : i18n.t('alerts:notificationChannelsPage.channelSaved')),
    errorFallback: i18n.t('alerts:notificationChannelsPage.failedToSaveChannel'),
    onUnauthorized: deps.onUnauthorized,
  });
}

// Exported for unit-testing without mounting the full component.
export async function runChannelDelete(
  channel: { id: string; name: string },
  deps: { onUnauthorized: () => void }
): Promise<void> {
  await runAction({
    request: () => fetchWithAuth(`/alerts/channels/${channel.id}`, { method: 'DELETE' }),
    successMessage: i18n.t('alerts:notificationChannelsPage.channelDeletedWithName', { name: channel.name }),
    errorFallback: i18n.t('alerts:notificationChannelsPage.failedToDeleteChannel'),
    onUnauthorized: deps.onUnauthorized,
  });
}

// Exported for unit-testing without mounting the full component.
export async function runRoutingRuleSave(
  rule: Omit<EditableRoutingRule, 'id' | 'isDefault' | 'orgId' | 'partnerId' | 'inherited'> & { id?: string; ownerScope?: 'organization' | 'partner' },
  deps: { onUnauthorized: () => void }
): Promise<void> {
  const isEdit = !!rule.id;
  const url = isEdit ? `/alerts/routing-rules/${rule.id}` : '/alerts/routing-rules';
  const method = isEdit ? 'PATCH' : 'POST';
  await runAction({
    request: () => fetchWithAuth(url, {
      method,
      body: JSON.stringify({
        name: rule.name,
        priority: rule.priority,
        conditions: rule.conditions,
        channelIds: rule.channelIds,
        escalationPolicyId: rule.escalationPolicyId ?? null,
        enabled: rule.enabled,
        // Create-only (#2130): updates never move a rule between axes.
        ...(!isEdit && rule.ownerScope ? { ownerScope: rule.ownerScope } : {}),
      }),
    }),
    successMessage: isEdit ? i18n.t('alerts:notificationChannelsPage.routingRuleSaved') : i18n.t('alerts:notificationChannelsPage.routingRuleCreated'),
    errorFallback: i18n.t('alerts:notificationChannelsPage.failedToSaveRoutingRule'),
    onUnauthorized: deps.onUnauthorized,
  });
}

// Exported for unit-testing without mounting the full component.
export async function runRoutingRuleDelete(
  ruleId: string,
  deps: { onUnauthorized: () => void }
): Promise<void> {
  await runAction({
    request: () => fetchWithAuth(`/alerts/routing-rules/${ruleId}`, { method: 'DELETE' }),
    successMessage: i18n.t('alerts:notificationChannelsPage.routingRuleDeleted'),
    errorFallback: i18n.t('alerts:notificationChannelsPage.failedToDeleteRoutingRule'),
    onUnauthorized: deps.onUnauthorized,
  });
}

export type EditableRoutingRule = { id: string; orgId: string | null; partnerId: string | null; name: string; priority: number; conditions: { severities?: string[]; monitorKinds?: string[]; siteIds?: string[] }; channelIds: string[]; escalationPolicyId: string | null; enabled: boolean; isDefault: boolean; inherited?: false };
export type InheritedRoutingRule = Omit<EditableRoutingRule, 'orgId' | 'partnerId' | 'inherited'> & { inherited: true };
export type RoutingRule = EditableRoutingRule | InheritedRoutingRule;
export const isEditableRoutingRule = (row: RoutingRule): row is EditableRoutingRule => row.inherited !== true;
export const isPartnerRail = (row: RoutingRule | EscalationPolicy): boolean => row.inherited === true || row.orgId === null;
export type EditableEscalationPolicy = { inherited?: false; id: string; orgId: string | null; partnerId: string | null; name: string; steps: Array<{ delayMinutes: number; channelIds: string[]; userIds?: string[]; repeat?: { everyMinutes: number; maxTimes: number } }> };
export type InheritedEscalationPolicy = { id: string; name: string; stepCount: number; inherited: true };
export type EscalationPolicy = EditableEscalationPolicy | InheritedEscalationPolicy;
export const isEditableEscalationPolicy = (row: EscalationPolicy): row is EditableEscalationPolicy => row.inherited !== true;

export async function runDefaultRowSave(
  data: { ownerScope?: 'organization' | 'partner'; channelIds: string[]; escalationPolicyId: string | null },
  deps: { onUnauthorized: () => void }
): Promise<void> {
  await runAction({
    request: () => fetchWithAuth('/alerts/routing-rules/default', { method: 'PUT', body: JSON.stringify(data) }),
    successMessage: i18n.t('alerts:deliveryPage.routing.defaultSaved'),
    errorFallback: i18n.t('alerts:deliveryPage.routing.failedToSaveDefault'),
    onUnauthorized: deps.onUnauthorized,
  });
}

/** Mirrors services/delivery/resolveDelivery.ts orderRoutingRows — non-default first, priority ASC, org before partner. */
export function orderRoutingRules<T extends RoutingRule>(rules: T[]): T[] {
  return [...rules].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? 1 : -1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return Number(isPartnerRail(a)) - Number(isPartnerRail(b));
  });
}

export async function runEscalationPolicySave(
  policy: { id?: string; name: string; steps: Array<{ delayMinutes: number; channelIds: string[]; userIds?: string[]; repeat?: { everyMinutes: number; maxTimes: number } }>; ownerScope?: 'organization' | 'partner'; orgId?: string | null },
  deps: { onUnauthorized: () => void }
): Promise<void> {
  const isEdit = !!policy.id;
  const body = isEdit
    ? { name: policy.name, steps: policy.steps }
    : { name: policy.name, steps: policy.steps, ...(policy.ownerScope ? { ownerScope: policy.ownerScope } : {}), ...(policy.ownerScope !== 'partner' && policy.orgId ? { orgId: policy.orgId } : {}) };
  await runAction({
    request: () => fetchWithAuth(isEdit ? `/alerts/policies/${policy.id}` : '/alerts/policies', { method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(body) }),
    successMessage: isEdit ? i18n.t('alerts:deliveryPage.escalation.saved') : i18n.t('alerts:deliveryPage.escalation.created'),
    errorFallback: i18n.t('alerts:deliveryPage.escalation.failedToSave'),
    onUnauthorized: deps.onUnauthorized,
  });
}

export async function runEscalationPolicyDelete(policy: { id: string; name: string }, deps: { onUnauthorized: () => void }): Promise<void> {
  await runAction({
    request: () => fetchWithAuth(`/alerts/policies/${policy.id}`, { method: 'DELETE' }),
    successMessage: i18n.t('alerts:deliveryPage.escalation.deleted'),
    errorFallback: i18n.t('alerts:deliveryPage.escalation.failedToDelete'),
    onUnauthorized: deps.onUnauthorized,
  });
}

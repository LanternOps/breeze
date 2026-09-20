import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { ActionError } from '../../../lib/runAction';
import type { ChannelChoice } from './useDeliveryResource';
import RoutingRuleDrawer, { type RoutingDrawerValues } from './RoutingRuleDrawer';
import {
  orderRoutingRules, runDefaultRowSave, runRoutingRuleDelete, runRoutingRuleSave,
  isEditableRoutingRule, isPartnerRail, type EscalationPolicy, type RoutingRule, type EditableRoutingRule,
} from './deliveryActions';

type DrawerState =
  | { kind: 'closed' }
  | { kind: 'rule'; rule: EditableRoutingRule | null }
  | { kind: 'default'; ownerScope: 'organization' | 'partner'; row: EditableRoutingRule | null; prefillFrom: RoutingRule | null };

export default function RoutingSection({ rules, channels, policies, currentOrgId, isPartnerScope, defaultOwnerScope, onChanged, onUnauthorized }: {
  rules: RoutingRule[];
  channels: ChannelChoice[];
  policies: EscalationPolicy[];
  currentOrgId: string | null;
  isPartnerScope: boolean;
  defaultOwnerScope: 'organization' | 'partner';
  onChanged: () => Promise<void>;
  onUnauthorized: () => void;
}) {
  const { t } = useTranslation('alerts');
  const [drawer, setDrawer] = useState<DrawerState>({ kind: 'closed' });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<EditableRoutingRule | null>(null);
  const [error, setError] = useState<string>();

  const ordered = useMemo(() => orderRoutingRules(rules.filter((r) => !r.isDefault)), [rules]);
  const orgDefault = rules.find((r): r is EditableRoutingRule => isEditableRoutingRule(r) && r.isDefault && r.orgId !== null) ?? null;
  const partnerDefault = rules.find((r) => r.isDefault && isPartnerRail(r)) ?? null;
  // Org view: the org row shadows the partner row. All-orgs view: the partner row.
  const orgView = currentOrgId !== null;
  const effectiveDefault = orgView ? (orgDefault ?? partnerDefault) : partnerDefault;
  const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? id.slice(0, 8);
  const policyName = (id: string | null) => (id ? policies.find((p) => p.id === id)?.name ?? id.slice(0, 8) : null);

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setSaving(true); setError(undefined);
    try { await fn(); await onChanged(); setDrawer({ kind: 'closed' }); setDeleting(null); }
    catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) setError(err instanceof Error ? err.message : fallback);
    } finally { setSaving(false); }
  };

  const saveFromDrawer = (values: RoutingDrawerValues) => {
    if (drawer.kind === 'default') {
      return run(() => runDefaultRowSave({
        ...(drawer.ownerScope === 'partner' ? { ownerScope: 'partner' as const } : {}),
        channelIds: values.channelIds, escalationPolicyId: values.escalationPolicyId,
      }, { onUnauthorized }), t('deliveryPage.routing.failedToSaveDefault'));
    }
    if (drawer.kind === 'rule') {
      const existing = drawer.rule;
      return run(() => runRoutingRuleSave({
        ...(existing ? { id: existing.id } : {}),
        name: values.name.trim(), priority: values.priority,
        conditions: {
          ...(values.severities.length ? { severities: values.severities } : {}),
          ...(values.monitorKinds.length ? { monitorKinds: values.monitorKinds } : {}),
          ...(values.siteIds.length ? { siteIds: values.siteIds } : {}),
        },
        channelIds: values.channelIds, escalationPolicyId: values.escalationPolicyId, enabled: values.enabled,
        ...(!existing && isPartnerScope ? { ownerScope: values.ownerScope } : {}),
      }, { onUnauthorized }), t('notificationChannelsPage.failedToSaveRoutingRule'));
    }
    return Promise.resolve();
  };

  const openDefaultEditor = () => {
    if (orgView) {
      setDrawer({ kind: 'default', ownerScope: 'organization', row: orgDefault, prefillFrom: orgDefault ? null : partnerDefault });
    } else {
      setDrawer({ kind: 'default', ownerScope: 'partner', row: partnerDefault && isEditableRoutingRule(partnerDefault) ? partnerDefault : null, prefillFrom: null });
    }
  };
  const canEditRow = (rule: RoutingRule): rule is EditableRoutingRule => isEditableRoutingRule(rule)
    && (rule.orgId !== null || (isPartnerScope && currentOrgId === null));
  const defaultIsPartnerRowInOrgView = orgView && !orgDefault && !!partnerDefault;

  return (
    <section className="space-y-3" data-testid="delivery-routing">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('deliveryPage.sections.routing')}</h2>
          <p className="text-sm text-muted-foreground">{t('deliveryPage.precedence')}</p>
        </div>
        <button type="button" onClick={() => setDrawer({ kind: 'rule', rule: null })} data-testid="routing-add-rule"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted">
          <Plus className="h-3.5 w-3.5" /> {t('deliveryPage.routing.addRule')}
        </button>
      </div>
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      <ol className="space-y-2">
        {ordered.map((rule) => (
          <li key={rule.id} data-testid={`routing-row-${rule.id}`} className="flex items-center gap-3 rounded-md border bg-muted/20 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{rule.name}</span>
                {isPartnerRail(rule) && (
                  <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary" data-testid="routing-rule-partner-wide-badge" title={t('deliveryPage.routing.partnerRowHint')}>
                    {t('notificationChannelsPage.allOrgs')}
                  </span>
                )}
                {!rule.enabled && <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{t('notificationChannelsPage.disabled')}</span>}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{t('notificationChannelsPage.priority')} {rule.priority}</span>
                <span>{describeMatch(rule, t)}</span>
                <span>{t('deliveryPage.routing.sendTo')}: {rule.channelIds.map(channelName).join(', ')}</span>
                {rule.escalationPolicyId && <span>{t('deliveryPage.routing.escalateVia')}: {policyName(rule.escalationPolicyId)}</span>}
              </div>
            </div>
            {canEditRow(rule) && (
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => setDrawer({ kind: 'rule', rule })} className="rounded-md px-2 py-1 text-xs font-medium hover:bg-muted" data-testid="routing-row-edit">{t('common:actions.edit')}</button>
                <button type="button" onClick={() => setDeleting(rule)} className="rounded-md p-1 text-destructive hover:bg-muted" data-testid="routing-row-delete" aria-label={t('common:actions.delete')}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            )}
          </li>
        ))}
        <li data-testid="routing-row-default" className="flex items-center gap-3 rounded-md border border-dashed bg-card px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{t('deliveryPage.routing.everythingElse')}</span>
              {effectiveDefault && isPartnerRail(effectiveDefault) && (
                <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary" data-testid="routing-rule-partner-wide-badge">{t('notificationChannelsPage.allOrgs')}</span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{t('deliveryPage.routing.matchAll')}</span>
              <span>
                {t('deliveryPage.routing.sendTo')}: {effectiveDefault && effectiveDefault.channelIds.length > 0
                  ? effectiveDefault.channelIds.map(channelName).join(', ')
                  : <span>{t('deliveryPage.routing.inboxOnly')}</span>}
              </span>
              {effectiveDefault?.escalationPolicyId && <span>{t('deliveryPage.routing.escalateVia')}: {policyName(effectiveDefault.escalationPolicyId)}</span>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('deliveryPage.routing.everythingElseHint')}</p>
          </div>
          <div className="flex items-center gap-1">
            {defaultIsPartnerRowInOrgView ? (
              <button type="button" onClick={openDefaultEditor} data-testid="routing-default-customize" className="rounded-md px-2 py-1 text-xs font-medium hover:bg-muted">{t('deliveryPage.routing.customizeForOrg')}</button>
            ) : (orgView || isPartnerScope) && (
              <button type="button" onClick={openDefaultEditor} data-testid="routing-default-edit" className="rounded-md px-2 py-1 text-xs font-medium hover:bg-muted">{t('common:actions.edit')}</button>
            )}

          </div>
        </li>
      </ol>

      {drawer.kind !== 'closed' && (
        <RoutingRuleDrawer
          key={drawer.kind === 'rule' ? (drawer.rule?.id ?? 'new') : `default-${drawer.ownerScope}`}
          open mode={drawer.kind}
          rule={drawer.kind === 'rule' ? drawer.rule : drawer.row}
          initialChannelIds={drawer.kind === 'default' ? drawer.prefillFrom?.channelIds ?? [] : undefined}
          initialEscalationPolicyId={drawer.kind === 'default' ? drawer.prefillFrom?.escalationPolicyId ?? null : undefined}
          ownerScope={drawer.kind === 'default' ? drawer.ownerScope : drawer.rule ? (isPartnerRail(drawer.rule) ? 'partner' : 'organization') : defaultOwnerScope}
          showOwnerScope={isPartnerScope}
          orgId={currentOrgId}
          channels={channels} policies={policies} saving={saving}
          onSave={saveFromDrawer} onCancel={() => setDrawer({ kind: 'closed' })}
        />
      )}
      <ConfirmDialog
        confirmTestId="routing-delete-confirm" dialogTestId="routing-delete-dialog"
        open={deleting !== null} onClose={() => setDeleting(null)} isLoading={saving} variant="destructive"
        title={t('common:actions.delete')}
        message={t('deliveryPage.routing.deleteConfirm', { name: deleting?.name ?? '' })}
        onConfirm={() => {
          if (!deleting) return;
          void run(
            () => runRoutingRuleDelete(deleting.id, { onUnauthorized }),
            t('notificationChannelsPage.failedToDeleteRoutingRule')
          );
        }}
      />
    </section>
  );
}

function describeMatch(rule: RoutingRule, t: (k: string, o?: Record<string, unknown>) => string): string {
  const parts: string[] = [];
  if (rule.conditions.severities?.length) parts.push(`${t('deliveryPage.routing.severities')}: ${rule.conditions.severities.join(', ')}`);
  if (rule.conditions.monitorKinds?.length) parts.push(`${t('deliveryPage.routing.monitorKinds')}: ${rule.conditions.monitorKinds.map((k) => t(/* i18n-dynamic */ `monitoring:kinds.${k}`)).join(', ')}`);
  if (rule.conditions.siteIds?.length) parts.push(`${t('deliveryPage.routing.sites')}: ${rule.conditions.siteIds.length}`);
  return parts.length ? parts.join(' · ') : t('deliveryPage.routing.matchAll');
}

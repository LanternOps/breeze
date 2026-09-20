import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MONITOR_KINDS } from '@breeze/shared';
import { Drawer } from '../../shared/Drawer';
import { fetchWithAuth } from '../../../stores/auth';
import { asList } from '@/lib/asList';
import type { ChannelChoice } from './useDeliveryResource';
import { isPartnerRail, type EscalationPolicy, type EditableRoutingRule } from './deliveryActions';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

export type RoutingDrawerValues = {
  name: string; priority: number; severities: string[]; monitorKinds: string[]; siteIds: string[];
  channelIds: string[]; escalationPolicyId: string | null; enabled: boolean; ownerScope: 'organization' | 'partner';
};

export default function RoutingRuleDrawer({ open, mode, rule, initialChannelIds, initialEscalationPolicyId, ownerScope, showOwnerScope, orgId, channels, policies, saving, onSave, onCancel }: {
  open: boolean;
  /** 'default' edits only channels + escalation of the Everything else row. */
  mode: 'rule' | 'default';
  rule: EditableRoutingRule | null;
  initialChannelIds?: string[];
  initialEscalationPolicyId?: string | null;
  ownerScope: 'organization' | 'partner';
  showOwnerScope: boolean;
  orgId: string | null;
  channels: ChannelChoice[];
  policies: EscalationPolicy[];
  saving: boolean;
  onSave: (values: RoutingDrawerValues) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('alerts');
  const [values, setValues] = useState<RoutingDrawerValues>(() => ({
    name: rule?.name ?? '', priority: rule?.priority ?? 10,
    severities: rule?.conditions.severities ?? [], monitorKinds: rule?.conditions.monitorKinds ?? [], siteIds: rule?.conditions.siteIds ?? [],
    channelIds: rule?.channelIds ?? initialChannelIds ?? [], escalationPolicyId: rule?.escalationPolicyId ?? initialEscalationPolicyId ?? null,
    enabled: rule?.enabled ?? true, ownerScope,
  }));
  const [sites, setSites] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    if (!open || mode !== 'rule' || values.ownerScope !== 'organization' || !orgId) { setSites([]); return; }
    let cancelled = false;
    fetchWithAuth(`/orgs/sites?organizationId=${orgId}&limit=100`)
      .then(async (r) => (r.ok ? asList(await r.json(), 'sites') : []))
      .then((list) => { if (!cancelled) setSites(list as Array<{ id: string; name: string }>); })
      .catch(() => { if (!cancelled) setSites([]); });
    return () => { cancelled = true; };
  }, [open, mode, values.ownerScope, orgId]);

  const toggle = (key: 'severities' | 'monitorKinds' | 'siteIds' | 'channelIds', id: string) =>
    setValues((v) => ({ ...v, [key]: v[key].includes(id) ? v[key].filter((x) => x !== id) : [...v[key], id] }));
  const compatiblePolicies = policies.filter((p) => values.ownerScope === 'partner' ? isPartnerRail(p) : true);
  const canSave = mode === 'default' || (values.name.trim().length > 0 && values.channelIds.length > 0);
  const title = mode === 'default' ? t('deliveryPage.routing.editDefault') : rule ? t('deliveryPage.routing.editRule') : t('deliveryPage.routing.newRule');

  return (
    <Drawer open={open} onClose={onCancel} title={title} width="max-w-lg" dataTestId="routing-rule-drawer" closeDisabled={saving}>
      <div className="space-y-5 p-1">
        {mode === 'rule' && !rule && showOwnerScope && (
          <fieldset className="space-y-2 rounded-md border p-3" data-testid="routing-rule-owner">
            <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">{t('notificationChannelsPage.scope')}</legend>
            {(['partner', 'organization'] as const).map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input type="radio" checked={values.ownerScope === scope} onChange={() => setValues((v) => ({ ...v, ownerScope: scope, siteIds: [] }))} data-testid={`routing-rule-owner-${scope === 'partner' ? 'partner' : 'org'}`} />
                {scope === 'partner' ? t('notificationChannelsPage.allOrganizations') : t('notificationChannelsPage.thisOrganizationOnly')}
              </label>
            ))}
          </fieldset>
        )}
        {mode === 'rule' && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-xs font-medium text-muted-foreground">{t('notificationChannelsPage.name')}
                <input value={values.name} onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))} data-testid="routing-rule-name"
                  className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm" />
              </label>
              <label className="block text-xs font-medium text-muted-foreground">{t('deliveryPage.routing.priority')}
                <input type="number" min={1} max={100} value={values.priority} onChange={(e) => setValues((v) => ({ ...v, priority: Number(e.target.value) || 10 }))} data-testid="routing-rule-priority"
                  className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm" />
              </label>
            </div>
            <ChipGroup label={t('deliveryPage.routing.severities')} hint={t('deliveryPage.routing.leaveEmptyForAll')}>
              {SEVERITIES.map((sev) => (
                <Chip key={sev} active={values.severities.includes(sev)} onClick={() => toggle('severities', sev)} testId={`routing-rule-severity-${sev}`}>
                  {t(/* i18n-dynamic */ `notificationChannelsPage.severity.${sev}`)}
                </Chip>
              ))}
            </ChipGroup>
            <ChipGroup label={t('deliveryPage.routing.monitorKinds')} hint={t('deliveryPage.routing.leaveEmptyForAll')}>
              {MONITOR_KINDS.map((kind) => (
                <Chip key={kind} active={values.monitorKinds.includes(kind)} onClick={() => toggle('monitorKinds', kind)} testId={`routing-rule-kind-${kind}`}>
                  {t(/* i18n-dynamic */ `monitoring:kinds.${kind}`)}
                </Chip>
              ))}
            </ChipGroup>
            {values.ownerScope === 'organization' && sites.length > 0 && (
              <ChipGroup label={t('deliveryPage.routing.sites')} hint={t('deliveryPage.routing.leaveEmptyForAll')}>
                {sites.map((s) => (
                  <Chip key={s.id} active={values.siteIds.includes(s.id)} onClick={() => toggle('siteIds', s.id)} testId={`routing-rule-site-${s.id}`}>{s.name}</Chip>
                ))}
              </ChipGroup>
            )}
          </>
        )}
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t('deliveryPage.routing.sendTo')}</p>
          {mode === 'default' && <p className="mb-2 text-xs text-muted-foreground">{t('deliveryPage.routing.everythingElseHint')}</p>}
          <div className="mt-2 space-y-1">
            {channels.map((ch) => (
              <label key={ch.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-muted">
                <input type="checkbox" aria-label={ch.name} data-testid={`routing-rule-channel-${ch.id}`} checked={values.channelIds.includes(ch.id)} onChange={() => toggle('channelIds', ch.id)} className="h-4 w-4 rounded border-muted" />
                <span className="text-sm">{ch.name}</span><span className="text-xs text-muted-foreground">({ch.type})</span>
              </label>
            ))}
            {channels.length === 0 && <p className="text-xs text-muted-foreground">{t('notificationChannelsPage.noChannelsConfiguredYet')}</p>}
          </div>
        </div>
        <label className="block text-xs font-medium text-muted-foreground">{t('deliveryPage.routing.escalateVia')}
          <select value={values.escalationPolicyId ?? ''} onChange={(e) => setValues((v) => ({ ...v, escalationPolicyId: e.target.value || null }))} data-testid="routing-rule-escalation"
            className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm">
            <option value="">{t('deliveryPage.routing.noEscalation')}</option>
            {compatiblePolicies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {mode === 'rule' && (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" data-testid="routing-rule-enabled" checked={values.enabled} onChange={(e) => setValues((v) => ({ ...v, enabled: e.target.checked }))} className="h-4 w-4 rounded border-muted" />
            {t('notificationChannelsPage.enabled')}
          </label>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} data-testid="routing-rule-drawer-cancel" disabled={saving} className="h-9 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground">{t('common:actions.cancel')}</button>
          <button type="button" onClick={() => onSave(values)} disabled={!canSave || saving} data-testid="routing-rule-drawer-save"
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60">{t('common:actions.save')}</button>
        </div>
      </div>
    </Drawer>
  );
}

function ChipGroup({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mb-2 text-xs text-muted-foreground">{hint}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}
function Chip({ active, onClick, testId, children }: { active: boolean; onClick: () => void; testId: string; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition ${active ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'}`}>{children}</button>
  );
}

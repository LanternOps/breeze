import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { ActionError } from '../../../lib/runAction';
import type { ChannelChoice } from './useDeliveryResource';
import EscalationPolicyDrawer, { type EscalationDrawerValues } from './EscalationPolicyDrawer';
import { runEscalationPolicyDelete, runEscalationPolicySave, isEditableEscalationPolicy, isPartnerRail, type EditableEscalationPolicy, type EscalationPolicy } from './deliveryActions';

export default function EscalationPoliciesSection({ policies, channels, currentOrgId, isPartnerScope, defaultOwnerScope, onChanged, onUnauthorized }: {
  policies: EscalationPolicy[]; channels: ChannelChoice[]; currentOrgId: string | null;
  isPartnerScope: boolean; defaultOwnerScope: 'organization' | 'partner';
  onChanged: () => Promise<void>; onUnauthorized: () => void;
}) {
  const { t } = useTranslation('alerts');
  const [drawer, setDrawer] = useState<{ open: boolean; policy: EditableEscalationPolicy | null }>({ open: false, policy: null });
  const [deleting, setDeleting] = useState<EditableEscalationPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setSaving(true); setError(undefined);
    try { await fn(); await onChanged(); setDrawer({ open: false, policy: null }); setDeleting(null); }
    catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) setError(err instanceof Error ? err.message : fallback);
    } finally { setSaving(false); }
  };
  const save = (values: EscalationDrawerValues) => run(() => runEscalationPolicySave({
    ...(drawer.policy ? { id: drawer.policy.id } : {}),
    name: values.name.trim(), steps: values.steps,
    ...(!drawer.policy ? { ownerScope: isPartnerScope ? values.ownerScope : 'organization', orgId: currentOrgId } : {}),
  }, { onUnauthorized }), t('deliveryPage.escalation.failedToSave'));
  const canEdit = (p: EscalationPolicy): p is EditableEscalationPolicy => isEditableEscalationPolicy(p)
    && (p.orgId !== null || (isPartnerScope && currentOrgId === null));

  return (
    <section className="space-y-3" data-testid="delivery-escalation">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('deliveryPage.sections.escalation')}</h2>
        <button type="button" onClick={() => setDrawer({ open: true, policy: null })} data-testid="escalation-new" className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted">
          <Plus className="h-3.5 w-3.5" /> {t('deliveryPage.escalation.new')}
        </button>
      </div>
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      {policies.length === 0 ? (
        <div className="rounded-md border border-dashed py-8 text-center" data-testid="escalation-empty">
          <p className="text-sm text-muted-foreground">{t('deliveryPage.escalation.empty')}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {policies.map((p) => (
            <li key={p.id} data-testid={`escalation-row-${p.id}`} className="flex items-center gap-3 rounded-md border bg-muted/20 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{p.name}</span>
                  {isPartnerRail(p) && <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary" data-testid="escalation-partner-wide-badge">{t('notificationChannelsPage.allOrgs')}</span>}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('deliveryPage.escalation.stepCount', { count: p.inherited === true ? p.stepCount : p.steps.length })}
                  {p.inherited !== true && p.steps.length ? ` · ${p.steps.map((s) => `${s.delayMinutes}m`).join(' → ')}` : ''}
                </p>
              </div>
              {canEdit(p) && (
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => setDrawer({ open: true, policy: p })} data-testid="escalation-row-edit" className="rounded-md px-2 py-1 text-xs font-medium hover:bg-muted">{t('common:actions.edit')}</button>
                  <button type="button" onClick={() => setDeleting(p)} data-testid="escalation-row-delete" aria-label={t('common:actions.delete')} className="rounded-md p-1 text-destructive hover:bg-muted"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {drawer.open && (
        <EscalationPolicyDrawer key={drawer.policy?.id ?? 'new'} open policy={drawer.policy} channels={channels} orgId={drawer.policy?.orgId ?? currentOrgId} ownerScope={drawer.policy ? (drawer.policy.orgId === null ? 'partner' : 'organization') : defaultOwnerScope} showOwnerScope={isPartnerScope} saving={saving} onSave={save} onCancel={() => setDrawer({ open: false, policy: null })} />
      )}
      <ConfirmDialog
        open={deleting !== null} onClose={() => setDeleting(null)} isLoading={saving} variant="destructive"
        title={t('common:actions.delete')} message={t('deliveryPage.escalation.deleteConfirm', { name: deleting?.name ?? '' })}
        confirmTestId="escalation-delete-confirm"
        onConfirm={() => { if (deleting) void run(() => runEscalationPolicyDelete(deleting, { onUnauthorized }), t('deliveryPage.escalation.failedToDelete')); }}
      />
    </section>
  );
}

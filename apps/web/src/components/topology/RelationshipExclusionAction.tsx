import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RelationshipExclusionSummary, TopologyView } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';

/**
 * M2 D17 reversible per-view exclusion. Both mutations go through runAction so
 * success and failure (including HTTP-200 `{success:false}`) always surface;
 * a 401 is left to the auth redirect. Hiding changes one view only and never
 * touches evidence, monitoring or diagnostics.
 *
 * Route contract (Task 8): POST /topology/sites/:siteId/relationships/:relationshipId/exclusions
 * {view, reason}; DELETE …/exclusions/:exclusionId revokes only that exclusion.
 */
const base = (siteId: string, relationshipId: string) =>
  `/topology/sites/${encodeURIComponent(siteId)}/relationships/${encodeURIComponent(relationshipId)}/exclusions`;

export function hideTopologyRelationship(input: { siteId: string; relationshipId: string; view: TopologyView; reason: string; errorFallback: string; successMessage: string }) {
  return runAction({
    request: () => fetchWithAuth(base(input.siteId, input.relationshipId), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ view: input.view, reason: input.reason }),
    }),
    errorFallback: input.errorFallback, successMessage: input.successMessage,
  });
}

export function restoreTopologyRelationship(input: { siteId: string; relationshipId: string; exclusionId: string; errorFallback: string; successMessage: string }) {
  return runAction({
    request: () => fetchWithAuth(`${base(input.siteId, input.relationshipId)}/${encodeURIComponent(input.exclusionId)}`, { method: 'DELETE' }),
    errorFallback: input.errorFallback, successMessage: input.successMessage,
  });
}

export default function RelationshipExclusionAction({ siteId, relationshipId, view, canEdit, onChanged, exclusion }: {
  siteId: string; relationshipId: string; view: TopologyView; canEdit: boolean; onChanged: () => void;
  /** The active exclusion of THIS view, when the relationship is already hidden from it. */
  exclusion?: RelationshipExclusionSummary;
}) {
  const { t } = useTranslation('topology');
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false);
  if (!canEdit) return null;
  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    try { await action(); setReason(''); onChanged(); }
    catch (cause) { handleActionError(cause, fallback); }
    finally { setBusy(false); }
  };
  if (exclusion) {
    return <div className="space-y-2 text-sm">
      <button data-testid="topology-exclusion-restore" className="rounded border px-3 py-2 disabled:opacity-50" disabled={busy}
        onClick={() => void run(() => restoreTopologyRelationship({ siteId, relationshipId, exclusionId: exclusion.id,
          errorFallback: t('exclusions.restoreFailed'), successMessage: t('exclusions.restored') }), t('exclusions.restoreFailed'))}>{t('exclusions.restore')}</button>
    </div>;
  }
  const trimmed = reason.trim();
  return <div className="space-y-2 text-sm">
    <label className="block">{t('exclusions.reasonLabel')}
      <input data-testid="topology-exclusion-reason" className="mt-1 w-full rounded border bg-background px-3 py-2" value={reason} maxLength={500}
        onChange={(event) => setReason(event.target.value)} /></label>
    <button data-testid="topology-exclusion-hide" className="rounded border px-3 py-2 disabled:opacity-50" disabled={busy || !trimmed}
      onClick={() => void run(() => hideTopologyRelationship({ siteId, relationshipId, view, reason: trimmed,
        errorFallback: t('exclusions.hideFailed'), successMessage: t('exclusions.hidden') }), t('exclusions.hideFailed'))}>{t('exclusions.hide')}</button>
  </div>;
}

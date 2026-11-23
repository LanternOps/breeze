import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AlertTriangle, Info, Lock, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { ActionError } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import type { ConfigPolicyAppliesToSummary } from '../appliesToSummary';
import TargetPicker, { type PickerOwner } from './TargetPicker';
import TargetRow from './TargetRow';
import {
  appliesToDraftReducer,
  draftIsDirty,
  draftToApplyPayload,
  effectiveRow,
  rowIsLive,
  rowKeyForEntry,
  type ApplyPayloadKeys,
  type DraftRow,
} from './appliesToDraft';
import {
  applyAssignments,
  dryRunAssignments,
  fetchAssignments,
  parseApplyFailure,
  type AssignmentDelta,
  type ApplyFailure,
  type ConfigPolicyReach,
} from './appliesToApi';
import { targetNameKey, useTargetNames } from './useTargetNames';

// The one applies-to editor (#12467, plan W02c P3; spec "Applies-to editor").
// It replaces AssignmentsTab, OrganizationScopePanel and
// PartnerGroupAssignmentSection. Changes are staged in a draft and committed
// with one Apply, which first states how many devices it adds and removes
// (a dry run of the same request, debounced). Nothing is written before Apply.

export const DRY_RUN_DEBOUNCE_MS = 400;

type AppliesToPanelProps = {
  policyId: string;
  owner: PickerOwner;
  /** The page's applies-to summary; its unfiltered count tells the panel about rows the caller cannot list. */
  summary: ConfigPolicyAppliesToSummary | null;
  /** The policy's current reach, used to warn when an Apply would leave it matching no device. */
  reach: ConfigPolicyReach | null;
  /** The draft became dirty or clean; the drawer blocks closing while it is dirty. */
  onDirtyChange: (dirty: boolean) => void;
  /** An Apply committed; the page re-reads the summary and reach. */
  onApplied: () => void;
};

type DeltaState =
  | { kind: 'idle' }
  | { kind: 'counting' }
  | { kind: 'ready'; delta: AssignmentDelta }
  | { kind: 'refused'; failure: ApplyFailure }
  | { kind: 'unavailable' };

export default function AppliesToPanel({ policyId, owner, summary, reach, onDirtyChange, onApplied }: AppliesToPanelProps) {
  const { t } = useTranslation('policies');
  const [rows, dispatch] = useReducer(appliesToDraftReducer, [] as DraftRow[]);
  const [storedCount, setStoredCount] = useState(0);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string>();
  const [delta, setDelta] = useState<DeltaState>({ kind: 'idle' });
  const [applying, setApplying] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [rowProblems, setRowProblems] = useState<Record<string, string>>({});
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dryRunReq = useRef(0);

  const dirty = draftIsDirty(rows);
  const names = useTargetNames(rows, owner, summary);
  const { payload, keys } = useMemo(() => draftToApplyPayload(rows), [rows]);
  const payloadSig = JSON.stringify(payload);

  const load = useCallback(async () => {
    setLoadState('loading');
    setLoadError(undefined);
    try {
      const stored = await fetchAssignments(policyId);
      dispatch({ type: 'reset', assignments: stored });
      setStoredCount(stored.length);
      setConflict(null);
      setRowProblems({});
      setConfirmDiscard(false);
      setLoadState('ready');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : undefined);
      setLoadState('error');
    }
  }, [policyId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // The dry run: debounced, and only the newest answer counts. A delta from an
  // earlier draft is cleared the moment the draft changes, so the Apply button
  // never states numbers for a change it is not about to make.
  useEffect(() => {
    const req = ++dryRunReq.current;
    if (!dirty) {
      setDelta({ kind: 'idle' });
      return;
    }
    setDelta({ kind: 'counting' });
    const timer = setTimeout(() => {
      void dryRunAssignments(policyId, payload).then((outcome) => {
        if (req !== dryRunReq.current) return;
        if (outcome.ok) setDelta({ kind: 'ready', delta: outcome.delta });
        else if (outcome.status >= 400 && outcome.status < 500) setDelta({ kind: 'refused', failure: outcome.failure });
        else setDelta({ kind: 'unavailable' });
      });
    }, DRY_RUN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // payloadSig stands for payload: the effect runs when the request would change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadSig, dirty, policyId]);

  const markEntry = (entryKeys: ApplyPayloadKeys, failure: ApplyFailure) => {
    if (!failure.entry) return;
    const key = rowKeyForEntry(entryKeys, failure.entry);
    if (key) setRowProblems({ [key]: failure.message ?? t('configurationPolicies.appliesToPanel.entryRefused') });
  };

  const handleApply = async () => {
    if (!dirty || applying) return;
    setApplying(true);
    setConflict(null);
    setRowProblems({});
    const sentKeys = keys;
    try {
      await applyAssignments(policyId, payload);
      onApplied();
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('configurationPolicies.appliesToPanel.applyFailed') });
        return;
      }
      // Already toasted, except a conflict, which is shown here with Reload.
      const failure = parseApplyFailure(err.body);
      markEntry(sentKeys, failure);
      if (failure.conflict) setConflict(failure.message ?? t('configurationPolicies.appliesToPanel.conflictFallback'));
    } finally {
      setApplying(false);
    }
  };

  const liveRows = rows.filter(rowIsLive);
  const allOrgs = liveRows.some((row) => effectiveRow(row).level === 'partner');
  const isListed = useCallback(
    (level: string, targetId: string) =>
      rows.some((row) => rowIsLive(row) && effectiveRow(row).level === level && effectiveRow(row).targetId === targetId),
    [rows],
  );
  const hiddenCount = summary ? Math.max(0, summary.assignmentCount - storedCount) : 0;

  // After this Apply, how many devices the caller can see would match. Only
  // when both counts are exact: a partial reach is a lower bound and a partial
  // delta an estimate, and neither may produce a "0 matching" claim.
  const deltaReady = delta.kind === 'ready' ? delta.delta : null;
  const projectedTotal = reach && !reach.partial
    ? !dirty
      ? reach.direct
      : deltaReady && !deltaReady.partial
        ? reach.direct + deltaReady.added - deltaReady.removed
        : null
    : null;
  const zeroMatching = projectedTotal === 0 && hiddenCount === 0 && (liveRows.length > 0 || dirty);

  const applyLabel = (() => {
    if (applying) return t('configurationPolicies.appliesToPanel.applying');
    if (!deltaReady) return t('configurationPolicies.appliesToPanel.applyButton');
    return deltaReady.partial
      ? t('configurationPolicies.appliesToPanel.applyWithEstimate', { added: deltaReady.added, removed: deltaReady.removed })
      : t('configurationPolicies.appliesToPanel.applyWithDelta', { added: deltaReady.added, removed: deltaReady.removed });
  })();

  if (loadState === 'loading' && rows.length === 0) {
    return (
      <div data-testid="applies-to-panel" className="flex justify-center py-8">
        <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" role="status" aria-label={t('configurationPolicies.appliesToPanel.loading')} />
      </div>
    );
  }
  if (loadState === 'error') {
    return (
      <div data-testid="applies-to-panel" className="space-y-3">
        <p data-testid="applies-to-load-error" role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {loadError ?? t('configurationPolicies.appliesToPanel.loadFailed')}
        </p>
        <button type="button" data-testid="applies-to-load-retry" onClick={() => void load()} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
          {t('configurationPolicies.appliesToPanel.retry')}
        </button>
      </div>
    );
  }

  return (
    <div data-testid="applies-to-panel" className="flex min-h-full flex-col gap-5">
      {owner.kind === 'org' ? (
        <p data-testid="applies-to-locked-org" className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          {t('configurationPolicies.appliesToPanel.lockedOrganization', { organization: owner.orgName ?? owner.orgId })}
        </p>
      ) : (
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">{t('configurationPolicies.appliesToPanel.scopeLegend')}</legend>
          <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
            <input
              type="radio"
              name={`applies-to-scope-${policyId}`}
              data-testid="applies-to-all-orgs"
              checked={allOrgs}
              disabled={applying}
              onChange={() => dispatch({ type: 'setAllOrganizations', on: true })}
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium">{t('configurationPolicies.appliesToPanel.scopeAllOrganizations')}</span>
              <span className="block text-xs text-muted-foreground">{t('configurationPolicies.appliesToPanel.scopeAllOrganizationsHint')}</span>
            </span>
          </label>
          <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
            <input
              type="radio"
              name={`applies-to-scope-${policyId}`}
              data-testid="applies-to-specific"
              checked={!allOrgs}
              disabled={applying}
              onChange={() => dispatch({ type: 'setAllOrganizations', on: false })}
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium">{t('configurationPolicies.appliesToPanel.scopeSpecificTargets')}</span>
              <span className="block text-xs text-muted-foreground">{t('configurationPolicies.appliesToPanel.scopeSpecificTargetsHint')}</span>
            </span>
          </label>
        </fieldset>
      )}

      <section aria-labelledby="applies-to-targets-heading" className="space-y-2">
        <h3 id="applies-to-targets-heading" className="text-sm font-semibold">
          {t('configurationPolicies.appliesToPanel.targetsHeading')}
        </h3>
        {rows.length === 0 ? (
          <p data-testid="applies-to-empty" className="text-sm text-muted-foreground">{t('configurationPolicies.appliesToPanel.noTargets')}</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => {
              const values = effectiveRow(row);
              return (
                <TargetRow
                  key={row.key}
                  row={row}
                  name={values.level === 'partner' ? null : (names[targetNameKey(values.level, values.targetId)] ?? null)}
                  onEdit={(patch) => dispatch({ type: 'edit', key: row.key, patch })}
                  onRemove={() => dispatch({ type: 'remove', key: row.key })}
                  onRestore={() => dispatch({ type: 'restore', key: row.key })}
                  problem={rowProblems[row.key]}
                  disabled={applying}
                />
              );
            })}
          </ul>
        )}
        {hiddenCount > 0 && (
          <p data-testid="applies-to-hidden-rows" className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t('configurationPolicies.appliesToPanel.hiddenRows', { count: hiddenCount })}
          </p>
        )}
      </section>

      <section aria-labelledby="applies-to-add-heading" className="space-y-2">
        <h3 id="applies-to-add-heading" className="text-sm font-semibold">{t('configurationPolicies.appliesToPanel.addTargetHeading')}</h3>
        <TargetPicker
          owner={owner}
          offerOrganization={!allOrgs}
          isListed={isListed}
          onPick={(target) => dispatch({ type: 'add', target })}
        />
      </section>

      <p data-testid="applies-to-legend" className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {t('configurationPolicies.appliesToPanel.precedenceLegend')}
      </p>

      <div className="sticky bottom-0 mt-auto space-y-2 border-t bg-background pt-3">
        {conflict && (
          <div data-testid="applies-to-conflict" role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <span className="min-w-0 flex-1">{conflict}</span>
            <button
              type="button"
              data-testid="applies-to-reload"
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              {t('configurationPolicies.appliesToPanel.reload')}
            </button>
          </div>
        )}
        {zeroMatching && (
          <p data-testid="applies-to-zero-warning" className="flex items-start gap-2 text-sm font-medium text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {t('configurationPolicies.appliesToPanel.zeroMatching')}
          </p>
        )}
        <div data-testid="applies-to-delta" aria-live="polite" className="text-xs text-muted-foreground">
          {delta.kind === 'counting' && t('configurationPolicies.appliesToPanel.counting')}
          {delta.kind === 'unavailable' && t('configurationPolicies.appliesToPanel.countUnavailable')}
          {deltaReady?.partial && t('configurationPolicies.appliesToPanel.estimateNote')}
          {delta.kind === 'refused' && (
            <span data-testid="applies-to-delta-refused" role="alert" className="text-destructive">
              {delta.failure.message ?? t('configurationPolicies.appliesToPanel.entryRefused')}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty && !confirmDiscard && (
            <button
              type="button"
              data-testid="applies-to-discard"
              onClick={() => setConfirmDiscard(true)}
              disabled={applying}
              className="h-9 rounded-md border px-3 text-sm hover:bg-muted disabled:opacity-50"
            >
              {t('configurationPolicies.appliesToPanel.discard')}
            </button>
          )}
          {dirty && confirmDiscard && (
            <span className="flex flex-wrap items-center gap-2 text-sm">
              {t('configurationPolicies.appliesToPanel.discardConfirmQuestion')}
              <button
                type="button"
                data-testid="applies-to-discard-confirm"
                onClick={() => {
                  dispatch({ type: 'reset', assignments: rows.flatMap((r) => (r.kind === 'existing' ? [r.assignment] : [])) });
                  setConfirmDiscard(false);
                  setConflict(null);
                  setRowProblems({});
                }}
                className="h-9 rounded-md border border-destructive/40 px-3 text-sm text-destructive hover:bg-destructive/10"
              >
                {t('configurationPolicies.appliesToPanel.discardConfirm')}
              </button>
              <button type="button" onClick={() => setConfirmDiscard(false)} className="h-9 rounded-md border px-3 text-sm hover:bg-muted">
                {t('configurationPolicies.appliesToPanel.keepEditing')}
              </button>
            </span>
          )}
          <button
            type="button"
            data-testid="applies-to-apply"
            onClick={() => void handleApply()}
            disabled={!dirty || applying || delta.kind === 'refused'}
            className={cn(
              'h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50',
            )}
          >
            {applyLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

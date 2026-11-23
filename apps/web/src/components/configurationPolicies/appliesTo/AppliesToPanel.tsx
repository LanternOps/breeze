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
  type ApplyPayload,
  type ApplyPayloadKeys,
  type DraftRow,
} from './appliesToDraft';
import { reachPhrase } from '../page/ReachLine';
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
/** Answers that say "try again later", not "this change is not allowed". */
const TRANSIENT_STATUSES = new Set([408, 425, 429]);

type AppliesToPanelProps = {
  /**
   * null = the policy does not exist yet (the create page, W03d C3): nothing
   * is read and no dry run runs; the staged targets are committed by
   * Activate, after the create.
   */
  policyId: string | null;
  owner: PickerOwner;
  /** The page's applies-to summary; its unfiltered count tells the panel about rows the caller cannot list. */
  summary: ConfigPolicyAppliesToSummary | null;
  /** The policy's current reach, used to warn when an Apply would leave it matching no device. */
  reach: ConfigPolicyReach | null;
  /** The draft became dirty or clean; the drawer blocks closing while it is dirty. */
  onDirtyChange: (dirty: boolean) => void;
  /** An Apply committed; the page re-reads the summary and reach. */
  onApplied: () => void;
  /**
   * Activation mode (W03d C3): the policy applies nowhere yet, and the footer
   * asks for the decision instead of offering Apply. Activate needs at least
   * one staged target; Don't apply yet keeps the policy inactive. Each
   * resolves to an error message, '' when there is nothing to show, or null
   * when it succeeded (the page then closes the drawer).
   */
  activation?: {
    onActivate: (payload: ApplyPayload) => Promise<string | null>;
    onDontApply: () => Promise<string | null>;
  };
  /** The org switcher's organization: offered first in the picker, never pre-selected. */
  suggestedOrg?: { id: string; name: string } | null;
};

type DeltaState =
  | { kind: 'idle' }
  | { kind: 'counting' }
  | { kind: 'ready'; delta: AssignmentDelta }
  /** The API refused the draft; `keys` maps its `entry` back to the row. */
  | { kind: 'refused'; failure: ApplyFailure; keys: ApplyPayloadKeys }
  | { kind: 'unavailable' };

export default function AppliesToPanel({
  policyId,
  owner,
  summary,
  reach,
  onDirtyChange,
  onApplied,
  activation,
  suggestedOrg = null,
}: AppliesToPanelProps) {
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
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);
  const dryRunReq = useRef(0);
  const loadReq = useRef(0);

  const dirty = draftIsDirty(rows);
  const names = useTargetNames(rows, owner, summary);
  const { payload, keys } = useMemo(() => draftToApplyPayload(rows), [rows]);
  const payloadSig = JSON.stringify(payload);

  const load = useCallback(async () => {
    const req = ++loadReq.current;
    if (!policyId) {
      // Nothing is stored yet: start from an empty draft.
      dispatch({ type: 'reset', assignments: [] });
      setStoredCount(0);
      setLoadState('ready');
      return;
    }
    setLoadState('loading');
    setLoadError(undefined);
    try {
      const stored = await fetchAssignments(policyId);
      if (req !== loadReq.current) return;
      dispatch({ type: 'reset', assignments: stored });
      setStoredCount(stored.length);
      setConflict(null);
      setRowProblems({});
      setConfirmDiscard(false);
      setLoadState('ready');
    } catch (err) {
      if (req !== loadReq.current) return;
      // Drop the draft: it was built on rows that may no longer be current,
      // and a dirty draft hidden behind the error view would keep the drawer
      // from closing. Retry loads a fresh one.
      dispatch({ type: 'reset', assignments: [] });
      setStoredCount(0);
      setConflict(null);
      setRowProblems({});
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
    setRowProblems({});
    if (!dirty || !policyId) {
      // No policy yet: there is nothing to count against, and no number is claimed.
      setDelta({ kind: 'idle' });
      return;
    }
    setDelta({ kind: 'counting' });
    const timer = setTimeout(() => {
      void dryRunAssignments(policyId, payload).then((outcome) => {
        if (req !== dryRunReq.current) return;
        if (outcome.ok) setDelta({ kind: 'ready', delta: outcome.delta });
        else if (outcome.status >= 400 && outcome.status < 500 && !TRANSIENT_STATUSES.has(outcome.status)) {
          setDelta({ kind: 'refused', failure: outcome.failure, keys });
        }
        else setDelta({ kind: 'unavailable' });
      });
    }, DRY_RUN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // payloadSig stands for payload: the effect runs when the request would change.
  }, [payloadSig, dirty, policyId]);

  const problemFor = (entryKeys: ApplyPayloadKeys, failure: ApplyFailure): Record<string, string> => {
    const key = failure.entry ? rowKeyForEntry(entryKeys, failure.entry) : undefined;
    return key ? { [key]: failure.message ?? t('configurationPolicies.appliesToPanel.entryRefused') } : {};
  };

  const handleApply = async () => {
    if (!dirty || applying || !policyId) return;
    setApplying(true);
    setConflict(null);
    setRowProblems({});
    const sentKeys = keys;
    let applied = false;
    try {
      await applyAssignments(policyId, payload);
      applied = true;
    } catch (err) {
      setApplying(false);
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('configurationPolicies.appliesToPanel.applyFailed') });
        return;
      }
      // Already toasted, except a conflict, which is shown here with Reload.
      const failure = parseApplyFailure(err.body);
      setRowProblems(problemFor(sentKeys, failure));
      if (failure.conflict) setConflict(failure.message ?? t('configurationPolicies.appliesToPanel.conflictFallback'));
      return;
    }
    if (applied) {
      onApplied();
      await load();
      setApplying(false);
    }
  };

  const shownProblems = delta.kind === 'refused' ? { ...rowProblems, ...problemFor(delta.keys, delta.failure) } : rowProblems;
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
  const zeroMatching = summary !== null && projectedTotal === 0 && hiddenCount === 0 && (liveRows.length > 0 || dirty);

  // Activation: the count is the policy's projected direct reach, known only
  // when the policy exists and both counts are exact.
  const activateLabel =
    projectedTotal !== null && dirty && deltaReady
      ? t('configurationPolicies.activation.activateWithReach', {
          reach: reachPhrase({ kind: 'reaches', devices: projectedTotal, partial: false }),
        })
      : t('configurationPolicies.policyStateActions.activateAction');
  const canActivate =
    liveRows.length > 0 && !activating && delta.kind !== 'refused' && delta.kind !== 'counting';
  const runActivation = async (run: () => Promise<string | null>) => {
    setActivating(true);
    setActivationError(null);
    const message = await run();
    setActivating(false);
    if (message) setActivationError(message);
  };

  const applyLabel = (() => {
    if (applying) return t('configurationPolicies.appliesToPanel.applying');
    if (!deltaReady) return t('configurationPolicies.appliesToPanel.applyButton');
    return deltaReady.partial
      ? t('configurationPolicies.appliesToPanel.applyWithEstimate', { count: deltaReady.added, added: deltaReady.added, removed: deltaReady.removed })
      : t('configurationPolicies.appliesToPanel.applyWithDelta', { count: deltaReady.added, added: deltaReady.added, removed: deltaReady.removed });
  })();

  if (loadState === 'loading' && rows.length === 0) {
    return (
      <div data-testid="applies-to-panel" className="flex flex-1 justify-center px-5 py-8">
        <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" role="status" aria-label={t('configurationPolicies.appliesToPanel.loading')} />
      </div>
    );
  }
  if (loadState === 'error') {
    return (
      <div data-testid="applies-to-panel" className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
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
    <div data-testid="applies-to-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
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
              name={`applies-to-scope-${policyId ?? 'new'}`}
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
              name={`applies-to-scope-${policyId ?? 'new'}`}
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
                  problem={shownProblems[row.key]}
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
          disabled={applying || activating}
          suggestedOrg={suggestedOrg}
          onPick={(target) => dispatch({ type: 'add', target })}
        />
      </section>

      <p data-testid="applies-to-legend" className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {t('configurationPolicies.appliesToPanel.precedenceLegend')}
      </p>

      </div>

      <div className="space-y-2 border-t bg-card px-5 py-3">
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
        {activation ? (
          <div className="space-y-2" data-testid="config-policy-activation">
            {activationError && (
              <p data-testid="config-policy-activation-error" role="alert" className="text-sm text-destructive">
                {activationError}
              </p>
            )}
            {liveRows.length === 0 && (
              <p data-testid="config-policy-activation-needs-decision" className="text-xs text-muted-foreground">
                {t('configurationPolicies.activation.needsDecision')}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                data-testid="config-policy-activation-dont-apply"
                title={t('configurationPolicies.activation.dontApplyHint')}
                disabled={activating}
                onClick={() => void runActivation(activation.onDontApply)}
                className="h-9 rounded-md border px-3 text-sm hover:bg-muted disabled:opacity-50"
              >
                {t('configurationPolicies.activation.dontApplyYet')}
              </button>
              <button
                type="button"
                data-testid="config-policy-activation-activate"
                disabled={!canActivate}
                onClick={() => void runActivation(() => activation.onActivate(payload))}
                className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                {activateLabel}
              </button>
            </div>
          </div>
        ) : (
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
            disabled={!dirty || applying || delta.kind === 'refused' || delta.kind === 'counting'}
            className={cn(
              'h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50',
            )}
          >
            {applyLabel}
          </button>
        </div>
        )}
      </div>
    </div>
  );
}

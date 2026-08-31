import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { Organization } from './OrganizationList';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';
import { runAction, handleActionError } from '@/lib/runAction';

/** Poll cadence for `GET /orgs/organizations/merge-runs/:jobId` while a merge
 *  job is queued/running. Exported for the test's fake-timer advances. */
export const MERGE_POLL_INTERVAL_MS = 2000;

export interface OrgMergePreviewTable {
  table: string;
  policy: string;
  loserRows: number;
  wouldDrop: number;
}

export interface OrgMergePreview {
  tables: OrgMergePreviewTable[];
  totalMovableRows: number;
  verdict: 'ok' | 'too-large' | 'blocked';
  warnings: string[];
  /** Non-empty iff `verdict === 'blocked'`. Unlike `too-large`, blocked is
   *  not operator-retryable — the message explains why (durable PAM
   *  lifecycle evidence on the loser side) rather than offering a retry
   *  path, so no separate retry copy is rendered alongside it. */
  blockers: string[];
}

export interface OrgMergeRunResult {
  tables: Record<string, { moved: number; dropped: number }>;
  warnings: string[];
  mergeEventId: string;
}

interface MergeRunStatus {
  state: 'waiting' | 'active' | 'completed' | 'failed';
  result?: OrgMergeRunResult;
  failedReason?: string;
}

export interface MergeOrgModalProps {
  loserOrg: Organization;
  orgs: Organization[];
  /** Dismiss without completing — the pick phase's Cancel button and the
   *  failed phase's Cancel button. No assumptions about the loser's state. */
  onClose: () => void;
  /**
   * Fired exactly once, the moment the merge-runs poll reports a genuine
   * `completed` result. List-state update ONLY (drop the loser from the
   * page's org list) — must NOT close the modal or touch the page's
   * selection. The modal stays open on its own `done` phase so the operator
   * can see the result summary; closing it is a separate, explicit action
   * (see `onDoneClose`).
   */
  onMerged: (loserId: string) => void;
  /**
   * The done phase's explicit Close button. Unlike `onClose`, the caller
   * knows the merge actually completed here, so `loserOrg` now refers to a
   * defunct, merged-away org — the page clears its stale selection in
   * addition to closing.
   */
  onDoneClose: () => void;
}

type Phase = 'pick' | 'progress' | 'done' | 'failed';

/**
 * Eligible merge survivors (Global Constraints, org-lifecycle Wave 3): same
 * partner as the loser (guaranteed here because the launcher button that
 * mounts this modal is itself gated to partner scope, and the org list it is
 * fed is already confined to that partner), excluding the loser itself, the
 * hidden `quick_support` org, and any org not `active`/`trial`. Exported for
 * the test.
 */
export function eligibleSurvivors(orgs: Organization[], loserOrg: Organization): Organization[] {
  return orgs.filter(
    (org) =>
      org.id !== loserOrg.id &&
      org.type !== 'quick_support' &&
      (org.status === 'active' || org.status === 'trial'),
  );
}

function sumMergeResult(tables: Record<string, { moved: number; dropped: number }>): {
  moved: number;
  dropped: number;
} {
  let moved = 0;
  let dropped = 0;
  for (const row of Object.values(tables)) {
    moved += row.moved;
    dropped += row.dropped;
  }
  return { moved, dropped };
}

export default function MergeOrgModal({ loserOrg, orgs, onClose, onMerged, onDoneClose }: MergeOrgModalProps) {
  const { t } = useTranslation('settings');
  const [phase, setPhase] = useState<Phase>('pick');
  const [survivorId, setSurvivorId] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<OrgMergePreview | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<OrgMergeRunResult | null>(null);
  const [failedReason, setFailedReason] = useState<string | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped whenever a poll chain is superseded (unmount, a fresh
  // startPolling from retry, or a terminal state) so an in-flight response
  // that resolves afterward is recognized as stale and dropped rather than
  // updating state or scheduling a further tick. A plain `clearInterval`
  // guard is not enough: it stops FUTURE ticks but does nothing about a
  // fetch that is already in flight when the tick that started it becomes
  // irrelevant.
  const pollTokenRef = useRef(0);
  // Same idea for merge-preview: rapid survivor reselection can make an
  // earlier POST resolve after a later one, and without a guard the stale
  // response would overwrite the fresher preview already on screen.
  const previewRequestIdRef = useRef(0);
  // Set false in the unmount cleanup below. Guards `submitMerge`'s
  // continuation specifically: `pollTokenRef` only protects a poll chain
  // that has already started, but `startPolling()` itself MINTS a fresh
  // token on every call (via `invalidatePolling()` bumping, then reading,
  // the counter) — so if the merge POST resolves after unmount, that fresh
  // token looks perfectly valid and the pollJob guard above would never
  // catch it. `submitMerge` checks this BEFORE ever calling `startPolling`,
  // so a post-unmount POST response never mints a token, never starts a
  // fetch loop, and never has a chance to fire `onMerged` later.
  const mountedRef = useRef(true);

  const survivors = useMemo(() => eligibleSurvivors(orgs, loserOrg), [orgs, loserOrg]);

  const mfaFriendly = useCallback(
    (code: string) => (code === 'MFA_REQUIRED' ? t('organizationsPage.merge.errors.mfaRequired') : undefined),
    [t],
  );

  const stopPolling = useCallback(() => {
    if (pollTimeoutRef.current !== null) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }, []);

  /** Stop any scheduled tick AND invalidate whatever poll chain is currently
   *  in flight (unmount, retry superseding a prior run, or a terminal state
   *  reached). */
  const invalidatePolling = useCallback(() => {
    stopPolling();
    pollTokenRef.current += 1;
  }, [stopPolling]);

  // Cleanup on unmount — the modal can be dismissed (or the parent can
  // navigate away) while a merge job is still queued/running, or while the
  // merge POST itself is still in flight (see mountedRef above).
  useEffect(
    () => () => {
      mountedRef.current = false;
      invalidatePolling();
    },
    [invalidatePolling],
  );

  const fetchPreview = useCallback(
    async (survivor: string) => {
      const requestId = ++previewRequestIdRef.current;
      setPreviewLoading(true);
      setPreview(null);
      try {
        const data = await runAction<OrgMergePreview>({
          request: () =>
            fetchWithAuth(`/orgs/organizations/${loserOrg.id}/merge-preview`, {
              method: 'POST',
              body: JSON.stringify({ survivorId: survivor }),
            }),
          errorFallback: t('organizationsPage.merge.errors.preview'),
          friendly: mfaFriendly,
          onUnauthorized: handleSessionExpired,
        });
        // Dropped if a newer survivor selection has already superseded this
        // request — an out-of-order response must not clobber fresher data.
        if (previewRequestIdRef.current === requestId) setPreview(data);
      } catch (err) {
        if (previewRequestIdRef.current !== requestId) return; // superseded
        // runAction already toasted an ActionError; onUnauthorized handles a
        // 401 redirect. Only a non-ActionError escape needs a fallback toast.
        handleActionError(err, t('organizationsPage.merge.errors.preview'));
      } finally {
        if (previewRequestIdRef.current === requestId) setPreviewLoading(false);
      }
    },
    [loserOrg.id, t, mfaFriendly],
  );

  const handleSurvivorChange = (id: string) => {
    setSurvivorId(id);
    setPreview(null);
    if (id) void fetchPreview(id);
  };

  const pollJob = useCallback(
    async (jobId: string, token: number) => {
      const scheduleNextTick = () => {
        if (pollTokenRef.current !== token) return; // superseded meanwhile
        pollTimeoutRef.current = setTimeout(() => void pollJob(jobId, token), MERGE_POLL_INTERVAL_MS);
      };

      let response: Response;
      try {
        response = await fetchWithAuth(`/orgs/organizations/merge-runs/${jobId}`);
      } catch {
        if (pollTokenRef.current !== token) return; // unmounted/superseded
        scheduleNextTick(); // transient network hiccup — the next tick retries
        return;
      }
      if (pollTokenRef.current !== token) return; // stale — drop silently

      if (response.status === 401) {
        invalidatePolling();
        handleSessionExpired();
        return;
      }
      if (!response.ok) {
        scheduleNextTick(); // transient — the next tick retries
        return;
      }
      const data = (await response.json().catch(() => null)) as MergeRunStatus | null;
      if (pollTokenRef.current !== token) return; // stale — drop silently
      if (!data) {
        scheduleNextTick();
        return;
      }

      if (data.state === 'completed' && data.result) {
        invalidatePolling(); // terminal — no further ticks, no late overwrite
        setResult(data.result);
        setPhase('done');
        onMerged(loserOrg.id);
        return;
      }
      if (data.state === 'completed' && !data.result) {
        // The worker contract is `state: 'completed'` implies `result` is
        // present. A completed run reported with no result payload is not a
        // "keep polling" state — surface it as a failure (with the existing
        // retry affordance) rather than fabricating a zero-row summary and
        // telling the operator the merge is done when we don't actually know
        // what it moved.
        invalidatePolling();
        setFailedReason(t('organizationsPage.merge.errors.missingResult'));
        setPhase('failed');
        return;
      }
      if (data.state === 'failed') {
        invalidatePolling();
        setFailedReason(data.failedReason ?? null);
        setPhase('failed');
        return;
      }

      // 'waiting' | 'active' — keep polling.
      scheduleNextTick();
    },
    [invalidatePolling, loserOrg.id, onMerged, t],
  );

  const startPolling = useCallback(
    (jobId: string) => {
      invalidatePolling(); // drop/ignore anything from a previous run (retry)
      const token = pollTokenRef.current;
      void pollJob(jobId, token);
    },
    [invalidatePolling, pollJob],
  );

  const submitMerge = useCallback(async () => {
    setSubmitting(true);
    setFailedReason(null);
    try {
      const data = await runAction<{ jobId: string }>({
        request: () =>
          fetchWithAuth(`/orgs/organizations/${loserOrg.id}/merge`, {
            method: 'POST',
            body: JSON.stringify({ survivorId, confirmName }),
          }),
        errorFallback: t('organizationsPage.merge.errors.merge'),
        friendly: mfaFriendly,
        onUnauthorized: handleSessionExpired,
      });
      // The modal can be closed/unmounted while this POST is still in
      // flight. Dropped entirely here — no phase change, no `startPolling`
      // (which would otherwise mint a fresh, "valid-looking" poll token and
      // run a whole polling+onMerged cycle against an unmounted modal).
      if (!mountedRef.current) return;
      setPhase('progress');
      startPolling(data.jobId);
    } catch (err) {
      if (!mountedRef.current) return; // ditto — nothing left to update
      // runAction already toasted an ActionError (e.g. the 400 confirmName
      // mismatch, verbatim from the server) — the modal simply stays on the
      // pick phase so the operator can correct it. onUnauthorized handles a
      // 401 redirect. Only a non-ActionError escape needs a fallback toast.
      handleActionError(err, t('organizationsPage.merge.errors.merge'));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [loserOrg.id, survivorId, confirmName, t, mfaFriendly, startPolling]);

  const nameMatches = confirmName === loserOrg.name;
  const canSubmit = Boolean(survivorId) && Boolean(preview) && preview?.verdict === 'ok' && nameMatches && !submitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-lg border bg-card p-6 shadow-xs"
        data-testid="org-merge-modal"
      >
        <h2 className="text-lg font-semibold">{t('organizationsPage.merge.title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('organizationsPage.merge.description', { name: loserOrg.name })}
        </p>

        {phase === 'pick' && (
          <>
            <label htmlFor="org-merge-survivor" className="mt-4 block text-sm font-medium">
              {t('organizationsPage.merge.survivorLabel')}
            </label>
            <select
              id="org-merge-survivor"
              data-testid="org-merge-survivor-select"
              value={survivorId}
              onChange={(e) => handleSurvivorChange(e.target.value)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-2.5 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="">{t('organizationsPage.merge.survivorPlaceholder')}</option>
              {survivors.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
            {survivors.length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('organizationsPage.merge.noEligibleSurvivors')}
              </p>
            )}

            {previewLoading && (
              <p data-testid="org-merge-preview-loading" className="mt-4 text-sm text-muted-foreground">
                {t('organizationsPage.merge.previewLoading')}
              </p>
            )}

            {preview && (
              <div className="mt-4 space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <p data-testid="org-merge-total-rows" className="font-medium">
                  {t('organizationsPage.merge.totalMovableRows', { count: preview.totalMovableRows })}
                </p>

                {/* Warnings (audit-trail destruction, key revocation, ...) render
                    regardless of verdict — a too-large refusal must not hide
                    the reasons a self-hosted operator would need after raising
                    the row limit and retrying, and a partner deciding whether
                    to contact support still needs to see what's at stake. */}
                {preview.warnings.length > 0 && (
                  <div>
                    <p className="font-medium text-destructive">
                      {t('organizationsPage.merge.warningsHeading')}
                    </p>
                    <ul data-testid="org-merge-warnings-list" className="mt-1 list-disc space-y-0.5 pl-4">
                      {preview.warnings.map((warning, index) => (
                        <li key={index} data-testid={`org-merge-warning-${index}`}>
                          {warning}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {preview.verdict === 'blocked' ? (
                  <div
                    role="alert"
                    data-testid="org-merge-blocked"
                    className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
                  >
                    {preview.blockers.map((blocker) => (
                      <p key={blocker}>{blocker}</p>
                    ))}
                  </div>
                ) : preview.verdict === 'too-large' ? (
                  <p data-testid="org-merge-too-large" className="text-destructive">
                    {t('organizationsPage.merge.tooLarge')}
                  </p>
                ) : (
                  <>
                    <div>
                      <p className="font-medium">{t('organizationsPage.merge.tablesHeading')}</p>
                      <ul data-testid="org-merge-tables-list" className="mt-1 list-disc space-y-0.5 pl-4">
                        {preview.tables.map((row) => (
                          <li key={row.table} data-testid={`org-merge-table-row-${row.table}`}>
                            {t('organizationsPage.merge.tableRowSummary', {
                              table: row.table,
                              loserRows: row.loserRows,
                              wouldDrop: row.wouldDrop,
                            })}
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div>
                      <label htmlFor="org-merge-confirm-name" className="block text-sm font-medium">
                        {t('organizationsPage.merge.confirmLabel', { name: loserOrg.name })}
                      </label>
                      <input
                        id="org-merge-confirm-name"
                        data-testid="org-merge-confirm-input"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={confirmName}
                        onChange={(e) => setConfirmName(e.target.value)}
                        placeholder={loserOrg.name}
                        className="mt-1 h-10 w-full rounded-md border bg-background px-2.5 font-mono text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      />
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                data-testid="org-merge-cancel"
                onClick={onClose}
                disabled={submitting}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('organizationsPage.merge.cancel')}
              </button>
              <button
                type="button"
                data-testid="org-merge-submit"
                onClick={() => void submitMerge()}
                disabled={!canSubmit}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? t('organizationsPage.merge.merging') : t('organizationsPage.merge.confirmButton')}
              </button>
            </div>
          </>
        )}

        {phase === 'progress' && (
          <div data-testid="org-merge-progress" className="mt-4">
            <p className="font-medium">{t('organizationsPage.merge.progressTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('organizationsPage.merge.progressDescription')}</p>
          </div>
        )}

        {phase === 'done' && result && (
          <div data-testid="org-merge-done" className="mt-4 space-y-3">
            <p className="font-medium">{t('organizationsPage.merge.doneTitle')}</p>
            <p data-testid="org-merge-result-summary" className="text-sm">
              {t('organizationsPage.merge.resultSummary', sumMergeResult(result.tables))}
            </p>
            {result.warnings.length > 0 && (
              <ul data-testid="org-merge-done-warnings-list" className="list-disc space-y-0.5 pl-4 text-sm">
                {result.warnings.map((warning, index) => (
                  <li key={index} data-testid={`org-merge-done-warning-${index}`}>
                    {warning}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                data-testid="org-merge-close"
                onClick={onDoneClose}
                className="h-10 rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
              >
                {t('organizationsPage.merge.close')}
              </button>
            </div>
          </div>
        )}

        {phase === 'failed' && (
          <div data-testid="org-merge-failed" className="mt-4 space-y-3">
            <p className="font-medium text-destructive">{t('organizationsPage.merge.failedTitle')}</p>
            {failedReason && (
              <p data-testid="org-merge-failed-reason" className="text-sm text-destructive">
                {failedReason}
              </p>
            )}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                data-testid="org-merge-cancel"
                onClick={onClose}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t('organizationsPage.merge.cancel')}
              </button>
              <button
                type="button"
                data-testid="org-merge-retry"
                onClick={() => void submitMerge()}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? t('organizationsPage.merge.retrying') : t('organizationsPage.merge.retry')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

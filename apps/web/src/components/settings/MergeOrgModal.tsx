import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { Organization } from './OrganizationList';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';
import { runAction, handleActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';

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
  verdict: 'ok' | 'too-large';
  warnings: string[];
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
  onClose: () => void;
  onMerged: (loserId: string) => void;
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

export default function MergeOrgModal({ loserOrg, orgs, onClose, onMerged }: MergeOrgModalProps) {
  const { t } = useTranslation('settings');
  const [phase, setPhase] = useState<Phase>('pick');
  const [survivorId, setSurvivorId] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<OrgMergePreview | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<OrgMergeRunResult | null>(null);
  const [failedReason, setFailedReason] = useState<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const survivors = useMemo(() => eligibleSurvivors(orgs, loserOrg), [orgs, loserOrg]);

  const mfaFriendly = useCallback(
    (code: string) => (code === 'MFA_REQUIRED' ? t('organizationsPage.merge.errors.mfaRequired') : undefined),
    [t],
  );

  const clearPoll = useCallback(() => {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  // Cleanup on unmount — the modal can be dismissed (or the parent can
  // navigate away) while a merge job is still queued/running.
  useEffect(() => () => clearPoll(), [clearPoll]);

  const fetchPreview = useCallback(
    async (survivor: string) => {
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
        setPreview(data);
      } catch (err) {
        // runAction already toasted an ActionError; onUnauthorized handles a
        // 401 redirect. Only a non-ActionError escape needs a fallback toast.
        handleActionError(err, t('organizationsPage.merge.errors.preview'));
      } finally {
        setPreviewLoading(false);
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
    async (jobId: string) => {
      let response: Response;
      try {
        response = await fetchWithAuth(`/orgs/organizations/merge-runs/${jobId}`);
      } catch {
        return; // transient network hiccup — the next tick retries
      }
      if (response.status === 401) {
        clearPoll();
        handleSessionExpired();
        return;
      }
      if (!response.ok) return; // transient — the next tick retries
      const data = (await response.json().catch(() => null)) as MergeRunStatus | null;
      if (!data) return;

      if (data.state === 'completed') {
        clearPoll();
        setResult(data.result ?? { tables: {}, warnings: [], mergeEventId: '' });
        setPhase('done');
        onMerged(loserOrg.id);
      } else if (data.state === 'failed') {
        clearPoll();
        setFailedReason(data.failedReason ?? null);
        setPhase('failed');
      }
      // 'waiting' | 'active' — keep polling.
    },
    [clearPoll, loserOrg.id, onMerged],
  );

  const startPolling = useCallback(
    (jobId: string) => {
      clearPoll();
      void pollJob(jobId);
      pollIntervalRef.current = setInterval(() => void pollJob(jobId), MERGE_POLL_INTERVAL_MS);
    },
    [clearPoll, pollJob],
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
      setPhase('progress');
      startPolling(data.jobId);
    } catch (err) {
      // runAction already toasted an ActionError (e.g. the 400 confirmName
      // mismatch, verbatim from the server) — the modal simply stays on the
      // pick phase so the operator can correct it. onUnauthorized handles a
      // 401 redirect. Only a non-ActionError escape needs a fallback toast.
      handleActionError(err, t('organizationsPage.merge.errors.merge'));
    } finally {
      setSubmitting(false);
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

                {preview.verdict === 'too-large' ? (
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
                onClick={onClose}
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

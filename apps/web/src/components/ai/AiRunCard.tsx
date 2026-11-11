import { useEffect, useState } from 'react';
import { CheckCircle, Clock, Download, Loader2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AiAgentRunStatus, AiApprovalScope } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import { CeremonyError, decideIntentApproval, isNoApproverDeviceError } from '@/lib/intentApprovals';
import { ActionError } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import { downloadArtifact } from '@/lib/downloadArtifact';
import type { ChatRunProgressEntry, ChatRunState } from '@/stores/processStreamEvent';

/** Poll cadence, matching the run detail page's DETAIL_POLL_INTERVAL_MS. */
const POLL_INTERVAL_MS = 5_000;

interface PolledArtifact {
  id: string;
  name: string;
  bytes: number;
  contentType: string;
  downloadPath: string;
}

interface PolledRun {
  status: AiAgentRunStatus;
  summary: string | null;
  computeCents: number;
  costCents: number;
  artifacts: PolledArtifact[];
  /** Progress ring from `GET /ai/agents/runs/:id` (routes/aiAgents.ts `progress`). */
  progress?: ChatRunProgressEntry[];
  /** `RunTraceIntentRowInput` rows linked to the run (`intents`). */
  intents?: PolledIntent[];
  /** Run profile; `device_troubleshooting` runs get the Continue button. */
  profile?: string;
  /** Set for a run launched under a Wisp grant. */
  wisp?: { grantorName: string | null } | null;
}

interface PolledIntent {
  id?: string;
  status: string;
  actionName?: string;
  approvalScope?: AiApprovalScope | null;
  decidedVia?: string | null;
  /** The approval card's label copy for this step. */
  actionLabel?: string | null;
  /** The CALLER's own pending approval_requests row; null when they cannot decide it. */
  approvalRequestId?: string | null;
}

interface AiRunCardProps {
  runId: string;
  /** Status from the tool result, shown before the first poll returns. */
  initialStatus: 'queued' | 'running' | 'completed' | 'failed';
  /** Live state from the SSE stream, when a turn happened to be open. */
  run: ChatRunState | undefined;
  /**
   * Device-troubleshooting runs: asks the hosting chat to send a follow-up
   * message. Calls no API itself; the button renders only when provided.
   */
  onContinue?: (runId: string) => void;
}

/**
 * Which run statuses mean "this will never change again", as a TOTAL map over
 * `AiAgentRunStatus`. Deliberately a map and not a hand-written `Set<string>`:
 * a status added upstream is a compile error here, instead of silently reading
 * as non-terminal — which would leave every open tab polling that run every
 * five seconds forever and never show the "open the full run" link.
 */
const TERMINAL_BY_STATUS: Record<AiAgentRunStatus, boolean> = {
  queued: false,
  running: false,
  // Still going: it is waiting on a human, not finished.
  awaiting_approval: false,
  completed: true,
  failed: true,
  cancelled: true,
  expired: true,
  skipped: true,
  // AI model registry W03: model unavailable / refused — final, like skipped.
  blocked: true,
};

/**
 * Statuses after which polling is pointless: terminal ones, plus
 * `awaiting_approval` (the run will not move until a person decides). Kept
 * apart from TERMINAL_BY_STATUS so the status copy and the "open the full run"
 * link still treat an approval-parked run as in flight. Total map for the same
 * reason as above.
 */
const SETTLED_FOR_POLLING: Record<AiAgentRunStatus, boolean> = {
  ...TERMINAL_BY_STATUS,
  awaiting_approval: true,
};

function isSettled(status: string | undefined): boolean {
  return status !== undefined && SETTLED_FOR_POLLING[status as AiAgentRunStatus] === true;
}

function isTerminal(status: string): boolean {
  return TERMINAL_BY_STATUS[status as AiAgentRunStatus] === true;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The chat surface for an `analysis` run (execution-plane spec §5.5).
 *
 * POLLING IS THE SOURCE OF TRUTH, not the `run` prop. The SSE stream only
 * exists for the duration of a turn, so for a run whose turn already closed
 * (the common case: ask, wait, read) no event ever reaches the browser. `run`
 * is a live upgrade for the case where the technician kept typing while the
 * run worked. (Chat-initiated launch is currently disabled — #6086 — so today
 * every run reaching this card was started by a preconfigured agent; this
 * polling contract is unaffected either way and stays ready for when
 * delegated authorization lands.)
 *
 * Artifacts are anchors with `download`, but the click handler
 * (`downloadArtifact`) fetches through the authenticated API and saves a Blob
 * instead of letting the browser navigate to the route directly — the same
 * pattern as `RunArtifactsSection`. The route serves the bytes as
 * `Content-Disposition: attachment` (spec §8). Nothing here renders artifact
 * CONTENT: a name and a size, and the bytes only ever leave as a file. The
 * name is rendered as a React text child, so an artifact called
 * `<img src=x onerror=…>` is escaped, never parsed.
 */
export default function AiRunCard({ runId, initialStatus, run, onContinue }: AiRunCardProps) {
  const { t } = useTranslation('ai');
  const [polled, setPolled] = useState<PolledRun | null>(null);
  // Bumped after a decide so the poll effect restarts and re-reads at once
  // (it also revives a poll that had stopped).
  const [pollNonce, setPollNonce] = useState(0);
  const [decidingIds, setDecidingIds] = useState<ReadonlySet<string>>(new Set());

  // A live settled result beats a poll that predates it.
  const status = run && isSettled(run.status) && !isSettled(polled?.status)
    ? run.status
    : polled?.status ?? run?.status ?? initialStatus;
  const liveSettled = run !== undefined && isSettled(run.status);
  const runIsTerminal = isTerminal(status);
  /**
   * True only when a `run_result` event actually reached this tab — i.e. a turn
   * was open when the run landed. False for the common case (ask, walk away).
   */
  const deliveredLive = run !== undefined && isTerminal(run.status);

  useEffect(() => {
    if (liveSettled) return;
    // Per-effect flags: a shared ref would be reset by the NEXT effect run while
    // this run's in-flight tick was still pending, letting it re-arm a timer.
    let cancelled = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (cancelled || settled) return;
      try {
        const res = await fetchWithAuth(`/ai/agents/runs/${runId}`);
        // A non-OK response falls THROUGH to the reschedule below, deliberately.
        // Returning here would exit before the `setTimeout` and stop polling
        // permanently on a single 500 — or on a 403 after an org-access change —
        // freezing the card on its spinner with no error and no retry, which is
        // strictly worse than the transient-failure behaviour promised below.
        if (res.ok) {
          const body = (await res.json()) as { data?: PolledRun };
          if (cancelled) return;
          if (body.data) {
            setPolled(body.data);
            // Keep polling a settled run only while a pending step is THIS
            // viewer's to decide (it leaves the list once decided). A step
            // only someone else can decide never ends this tab's polling.
            const hasActionable = (body.data.intents ?? []).some(
              (i) => i.status === 'pending_approval' && !!i.approvalRequestId,
            );
            if (isSettled(body.data.status) && !hasActionable) {
              // A finished (or approval-parked) run never changes on its own; keep polling and every open
              // chat with an old run card becomes a background request forever.
              settled = true;
              return;
            }
          }
        }
      } catch {
        // A transient failure is not worth a visible error on a card whose
        // whole job is "this is still working" — the next tick retries.
      }
      if (cancelled || settled) return;
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, liveSettled, pollNonce]);

  const summary = polled?.summary ?? run?.summary ?? null;
  const artifacts: PolledArtifact[] = polled?.artifacts
    ?? (run?.artifacts ?? []).map((a) => ({
      id: a.handle,
      name: a.name,
      bytes: a.bytes,
      contentType: a.contentType,
      downloadPath: `/api/v1/ai/artifacts/${a.handle}`,
    }));
  // Live and polled steps merge by ordinal (live wins), so a stream attached
  // mid-run and the 5 s poll never double a step.
  const byOrdinal = new Map<number, ChatRunProgressEntry>();
  for (const p of polled?.progress ?? []) byOrdinal.set(p.ordinal, p);
  for (const p of run?.progress ?? []) byOrdinal.set(p.ordinal, p);
  const progress = [...byOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);

  const polledPending = polled?.intents?.filter((i) => i.status === 'pending_approval').length;
  const pendingCount = polled?.status === 'awaiting_approval' && polledPending !== undefined
    ? polledPending
    : run?.pendingIntentCount ?? polledPending;

  const pendingIntents = (polled?.intents ?? []).filter(
    (i): i is PolledIntent & { id: string } => i.status === 'pending_approval' && typeof i.id === 'string',
  );

  const decide = async (intent: PolledIntent & { id: string }, decision: 'approve' | 'deny') => {
    const requestId = intent.approvalRequestId;
    if (!requestId || decidingIds.has(intent.id)) return;
    setDecidingIds((cur) => new Set(cur).add(intent.id));
    try {
      const outcome = await decideIntentApproval(requestId, decision, undefined, intent.approvalScope ?? null);
      const copy =
        outcome === 'needs_device' ? 'aiApprovalDialog.noApproverDevice'
          : outcome === 'not_sole_approver' ? 'aiApprovalDialog.notSoleApprover'
            : outcome === 'fresh_factor_required' ? 'aiApprovalDialog.freshFactorRequired'
              : null;
      // `refused` was already shown as an error by decideIntentApproval.
      if (copy) showToast({ type: 'error', message: t(/* i18n-dynamic */ copy) });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        showToast({
          type: 'error',
          message: isNoApproverDeviceError(err)
            ? t('aiApprovalDialog.noApproverDevice')
            : err instanceof CeremonyError
              ? t('aiApprovalDialog.verificationFailed')
              : t('aiApprovalDialog.decideFailed'),
        });
      }
    } finally {
      setDecidingIds((cur) => {
        const next = new Set(cur);
        next.delete(intent.id);
        return next;
      });
      setPollNonce((n) => n + 1);
    }
  };

  const showContinue = onContinue !== undefined
    && polled?.profile === 'device_troubleshooting'
    && isSettled(status);

  const StatusIcon = status === 'completed'
    ? CheckCircle
    : status === 'failed'
      ? XCircle
      : status === 'queued' || isSettled(status)
        ? Clock
        : Loader2;
  // Spin only while the run is genuinely in flight; every settled status is static.
  const spinning = StatusIcon === Loader2;

  return (
    <div
      data-testid="ai-run-card"
      className="my-1 rounded-md border border-gray-200 bg-gray-50/50 p-3 dark:border-gray-700 dark:bg-gray-800/50"
    >
      <div className="flex items-center gap-2 text-xs font-medium">
        <StatusIcon
          className={`h-3.5 w-3.5 ${status === 'failed' ? 'text-red-600' : status === 'completed' ? 'text-green-600' : spinning ? 'animate-spin text-gray-500' : 'text-gray-500'}`}
        />
        <span>{t('aiRunCard.title')}</span>
        <span data-testid="ai-run-card-status" className="text-muted-foreground">
          {t(/* i18n-dynamic */ `aiRunCard.status.${status}`, status)}
        </span>
      </div>

      {progress.length > 0 && (
        <ol data-testid="ai-run-card-progress" className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          {progress.map((p) => (
            <li key={p.ordinal}>{p.label}</li>
          ))}
        </ol>
      )}

      {status === 'awaiting_approval' && pendingCount !== 0 && (
        <div data-testid="ai-run-card-approvals" className="mt-2 text-xs">
          <p>
            {pendingCount !== undefined
              ? t('aiRunCard.approvals.pending', { count: pendingCount })
              : t('aiRunCard.approvals.waiting')}
          </p>
          <a href="/approvals" className="underline">{t('aiRunCard.approvals.review')}</a>
        </div>
      )}

      {pendingIntents.length > 0 && (
        <ul aria-label={t('aiRunCard.stepApprovals.title')} className="mt-2 space-y-1.5 text-xs">
          {pendingIntents.map((intent) => (
            <li
              key={intent.id}
              data-testid="ai-run-card-step-approval"
              className="rounded border border-amber-200 bg-amber-50/50 p-2 dark:border-amber-900 dark:bg-amber-950/20"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{intent.actionLabel ?? intent.actionName}</span>
                {polled?.wisp?.grantorName && (
                  <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] dark:bg-gray-700">
                    {t('aiRunCard.stepApprovals.wispFor', { name: polled.wisp.grantorName })}
                  </span>
                )}
              </div>
              {intent.approvalRequestId ? (
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    type="button"
                    data-testid={`ai-run-card-step-approve-${intent.id}`}
                    disabled={decidingIds.has(intent.id)}
                    onClick={() => void decide(intent, 'approve')}
                    className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50"
                  >
                    {t('aiRunCard.stepApprovals.approve')}
                  </button>
                  <button
                    type="button"
                    data-testid={`ai-run-card-step-deny-${intent.id}`}
                    disabled={decidingIds.has(intent.id)}
                    onClick={() => void decide(intent, 'deny')}
                    className="rounded border border-gray-300 px-2 py-1 disabled:opacity-50 dark:border-gray-600"
                  >
                    {t('aiRunCard.stepApprovals.deny')}
                  </button>
                </div>
              ) : (
                <p className="mt-1 text-muted-foreground">{t('aiRunCard.stepApprovals.waitingForApprover')}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {summary && (
        <p data-testid="ai-run-card-summary" className="mt-2 whitespace-pre-wrap text-xs">
          {summary}
        </p>
      )}

      {artifacts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {artifacts.map((a) => (
            <a
              key={a.id}
              data-testid={`ai-run-card-artifact-${a.id}`}
              href={a.downloadPath}
              download={a.name}
              onClick={downloadArtifact}
              className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:hover:bg-gray-800"
            >
              <Download className="h-3 w-3" />
              <span>{a.name}</span>
              <span className="text-muted-foreground">{formatBytes(a.bytes)}</span>
            </a>
          ))}
        </div>
      )}

      {/*
        The run finished while nothing was streaming — no turn was open, so no
        `run_result` ever reached this tab and the summary above came from the
        poll, not from the conversation. Say so once, plainly: a technician who
        walked away needs to know the result exists and where it lives, rather
        than assuming the conversation simply never answered. `deliveredLive`
        is the SSE state, so this note never appears for a run the technician
        watched land.
      */}
      {runIsTerminal && !deliveredLive && (
        <p data-testid="ai-run-card-offline-notice" className="mt-2 text-xs text-muted-foreground">
          {t('aiRunCard.resultOnRunPage')}
        </p>
      )}

      {showContinue && (
        <button
          type="button"
          data-testid="ai-run-card-continue"
          onClick={() => onContinue?.(runId)}
          className="mt-2 mr-3 rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800"
        >
          {t('aiRunCard.continue')}
        </button>
      )}

      {(runIsTerminal || status === 'awaiting_approval') && (
        <a
          data-testid="ai-run-card-open"
          href={`/ai-agents/runs/${runId}`}
          className="mt-2 inline-block text-xs underline"
        >
          {t('aiRunCard.openRun')}
        </a>
      )}
    </div>
  );
}

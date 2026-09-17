import { useEffect, useRef, useState } from 'react';
import { CheckCircle, Clock, Download, Loader2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AiAgentRunStatus } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import { downloadArtifact } from '@/lib/downloadArtifact';
import type { ChatRunState } from '@/stores/processStreamEvent';

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
}

interface AiRunCardProps {
  runId: string;
  /** Status from the tool result, shown before the first poll returns. */
  initialStatus: 'queued' | 'running' | 'completed' | 'failed';
  /** Live state from the SSE stream, when a turn happened to be open. */
  run: ChatRunState | undefined;
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
};

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
 * exists for the duration of a turn, and `workspace_launch_analysis` returns
 * immediately — so for the common case (ask, wait, read) no event ever reaches
 * the browser. `run` is a live upgrade for the case where the technician kept
 * typing while the run worked.
 *
 * Artifacts are anchors with `download`, pointing at the API route that serves
 * them as `Content-Disposition: attachment` (spec §8). Nothing here renders
 * artifact CONTENT: a name and a size, and the bytes only ever leave as a file.
 * The name is rendered as a React text child, so an artifact called
 * `<img src=x onerror=…>` is escaped, never parsed.
 */
export default function AiRunCard({ runId, initialStatus, run }: AiRunCardProps) {
  const { t } = useTranslation('ai');
  const [polled, setPolled] = useState<PolledRun | null>(null);
  const stopped = useRef(false);

  const status = polled?.status ?? run?.status ?? initialStatus;
  const runIsTerminal = isTerminal(status);
  /**
   * True only when a `run_result` event actually reached this tab — i.e. a turn
   * was open when the run landed. False for the common case (ask, walk away).
   */
  const deliveredLive = run !== undefined && isTerminal(run.status);

  useEffect(() => {
    stopped.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (stopped.current) return;
      try {
        const res = await fetchWithAuth(`/ai/agents/runs/${runId}`);
        // A non-OK response falls THROUGH to the reschedule below, deliberately.
        // Returning here would exit before the `setTimeout` and stop polling
        // permanently on a single 500 — or on a 403 after an org-access change —
        // freezing the card on its spinner with no error and no retry, which is
        // strictly worse than the transient-failure behaviour promised below.
        if (res.ok) {
          const body = (await res.json()) as { data?: PolledRun };
          if (stopped.current) return;
          if (body.data) {
            setPolled(body.data);
            if (isTerminal(body.data.status)) {
              // A finished run never changes again; keep polling and every open
              // chat with an old run card becomes a background request forever.
              stopped.current = true;
              return;
            }
          }
        }
      } catch {
        // A transient failure is not worth a visible error on a card whose
        // whole job is "this is still working" — the next tick retries.
      }
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      stopped.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  const summary = polled?.summary ?? run?.summary ?? null;
  const artifacts: PolledArtifact[] = polled?.artifacts
    ?? (run?.artifacts ?? []).map((a) => ({
      id: a.handle,
      name: a.name,
      bytes: a.bytes,
      contentType: a.contentType,
      downloadPath: `/api/v1/ai/artifacts/${a.handle}`,
    }));
  const progress = run?.progress ?? [];

  const StatusIcon = status === 'completed'
    ? CheckCircle
    : status === 'failed'
      ? XCircle
      : status === 'queued'
        ? Clock
        : Loader2;

  return (
    <div
      data-testid="ai-run-card"
      className="my-1 rounded-md border border-gray-200 bg-gray-50/50 p-3 dark:border-gray-700 dark:bg-gray-800/50"
    >
      <div className="flex items-center gap-2 text-xs font-medium">
        <StatusIcon
          className={`h-3.5 w-3.5 ${status === 'failed' ? 'text-red-600' : status === 'completed' ? 'text-green-600' : 'animate-spin text-gray-500'}`}
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

      {runIsTerminal && (
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

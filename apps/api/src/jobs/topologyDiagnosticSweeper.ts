import { captureException } from '../services/sentry';
import { sweepTopologyDiagnosticRuns } from '../services/topology/diagnosticSweeper';
import { recordTopologyDiagnosticSweep } from '../services/topology/metrics';

export const TOPOLOGY_DIAGNOSTIC_SWEEP_INTERVAL_MS = 5_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<unknown> | null = null;

/** One sweep, publishing how many abandoned runs it expired (orphan backlog). */
export async function runTopologyDiagnosticSweep(): Promise<number> {
  const expired = await sweepTopologyDiagnosticRuns();
  recordTopologyDiagnosticSweep(expired);
  return expired;
}

function tick(): void {
  if (running) return;
  running = runTopologyDiagnosticSweep()
    .catch((error) => captureException(error))
    .finally(() => {
      running = null;
    });
}

/**
 * Expires abandoned diagnostic runs and fences their undelivered commands.
 *
 * Deliberately separate from the dispatch worker and `global` placement: agent
 * disconnect, worker restart, Redis loss and deadline expiry must converge even
 * on a process that owns no sockets.
 */
export function initializeTopologyDiagnosticSweeper(): void {
  if (timer) return;
  timer = setInterval(tick, TOPOLOGY_DIAGNOSTIC_SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export async function shutdownTopologyDiagnosticSweeper(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await running;
}

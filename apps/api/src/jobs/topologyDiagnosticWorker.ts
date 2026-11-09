import { captureException } from '../services/sentry';
import { drainTopologyDiagnosticDispatch } from '../services/topology/diagnosticDispatch';
import { deliverTopologyDiagnosticCommand } from '../services/topology/diagnosticDelivery';

export const TOPOLOGY_DIAGNOSTIC_DISPATCH_INTERVAL_MS = 1_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<unknown> | null = null;

function tick(): void {
  if (running) return;
  running = drainTopologyDiagnosticDispatch({ deliver: deliverTopologyDiagnosticCommand })
    .catch((error) => captureException(error))
    .finally(() => {
      running = null;
    });
}

/**
 * Turns a committed dispatch intent into one agent command.
 *
 * Ticks faster than the other topology workers because a run only has a
 * 30-second queue budget before it expires — a diagnostic that waits is a
 * diagnostic that never runs. `global` placement: delivery reaches the agent
 * through the agentCommandRelay facade (#4142), not the local socket registry.
 */
export function initializeTopologyDiagnosticWorker(): void {
  if (timer) return;
  timer = setInterval(tick, TOPOLOGY_DIAGNOSTIC_DISPATCH_INTERVAL_MS);
  timer.unref?.();
}

export async function shutdownTopologyDiagnosticWorker(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await running;
}

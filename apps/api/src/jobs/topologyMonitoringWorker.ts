import { captureException } from '../services/sentry';
import { dispatchDueTopologyPolicies } from '../services/topology/monitoringScheduler';
import { ensureTopologyTelemetryArmAuthority } from '../services/topology/telemetryArmFence';
import { dispatchDueTopologyTelemetryArms } from '../services/topology/telemetryArms';

/**
 * Recurring topology monitoring (M3 Task 7): claims due policy slots (runs or
 * bounded gaps) and mints standing interface polls from telemetry arms. The
 * durable rows — policy streak state, run + dispatch intent, arm cursor — are
 * the recovery authority, so a crashed tick is simply repeated; delivery is the
 * diagnostic worker's and the agent heartbeat's, never this worker's.
 * `global` placement: it only writes rows.
 */
export const TOPOLOGY_MONITORING_INTERVAL_MS = 15_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<unknown> | null = null;

export async function runTopologyMonitoringTick(): Promise<void> {
  ensureTopologyTelemetryArmAuthority();
  await dispatchDueTopologyPolicies();
  await dispatchDueTopologyTelemetryArms();
}

function tick(): void {
  if (running) return;
  running = runTopologyMonitoringTick()
    .catch((error) => captureException(error))
    .finally(() => {
      running = null;
    });
}

export function initializeTopologyMonitoringWorker(): void {
  if (timer) return;
  timer = setInterval(tick, TOPOLOGY_MONITORING_INTERVAL_MS);
  timer.unref?.();
}

export async function shutdownTopologyMonitoringWorker(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await running;
}

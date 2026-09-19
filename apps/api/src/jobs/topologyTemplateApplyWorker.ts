import { captureException } from '../services/sentry';
import { drainTopologyTemplateApplications } from '../services/topology/templateApplicationExecution';
let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<unknown> | null = null;
function tick() {
  if (running) return;
  running = drainTopologyTemplateApplications()
    .catch((error) => captureException(error))
    .finally(() => {
      running = null;
    });
}
/** Existing DB outbox worker pattern: recover accepted site intents after restart. */
export function initializeTopologyTemplateApplyWorker(): void {
  if (timer) return;
  timer = setInterval(tick, 2_000);
  timer.unref?.();
}
export async function shutdownTopologyTemplateApplyWorker(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await running;
}

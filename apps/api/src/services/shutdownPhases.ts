/**
 * Sequential, bounded-timeout shutdown phase runner.
 *
 * Phases run strictly one after another; within a phase, all tasks start
 * together and are awaited via `Promise.allSettled`, raced against a
 * per-phase timeout. A stuck task in one phase must never prevent later
 * phases (in particular Redis/DB close) from running — so a timeout logs,
 * records the phase as timed out, and moves on. The straggler keeps running
 * detached; its eventual settlement is still captured (never left as an
 * unhandled rejection), it's just recorded after the fact.
 *
 * wave 3.5d-a (#4086).
 */

export interface ShutdownPhase {
  name: string;
  tasks: Array<() => Promise<void> | void>;
  timeoutMs?: number;
}

export interface ShutdownReport {
  failures: Array<{ phase: string; index: number; error: unknown }>;
  timedOutPhases: string[];
}

export async function runShutdownPhases(
  phases: ShutdownPhase[],
  opts: { defaultTimeoutMs?: number; log?: (msg: string) => void } = {},
): Promise<ShutdownReport> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 20_000;
  const report: ShutdownReport = { failures: [], timedOutPhases: [] };

  for (const phase of phases) {
    if (phase.tasks.length === 0) continue;
    log(`[shutdown] phase ${phase.name} (${phase.tasks.length} task(s))`);
    // Start all tasks and attach the settlement handler FIRST, so a straggler
    // that rejects after a phase timeout is already handled (no unhandled
    // rejection from a detached phase).
    const settled = Promise.allSettled(
      phase.tasks.map(async (task) => task()),
    ).then((results) => {
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          report.failures.push({ phase: phase.name, index, error: result.reason });
          log(`[shutdown] phase ${phase.name} task ${index} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
        }
      });
    });
    const timeoutMs = phase.timeoutMs ?? defaultTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      settled.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      report.timedOutPhases.push(phase.name);
      log(`[shutdown] phase ${phase.name} timed out after ${timeoutMs}ms — continuing`);
    }
  }
  return report;
}

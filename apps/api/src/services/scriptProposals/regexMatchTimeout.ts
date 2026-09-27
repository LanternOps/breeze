/**
 * A genuine wall-clock execution bound for a single regex match, for the one
 * caller (verify.ts's `output_matches` claim) that runs a tenant-authored
 * pattern synchronously on a shared worker process. `validateRegexSafety`
 * (packages/shared) rejects the known catastrophic-backtracking shapes at
 * write time, but it is a heuristic, not a proof — this is the backstop for
 * whatever it misses (or for a row written before the heuristic existed).
 *
 * A pure-JS wall-clock check (`Date.now()` polled between operations) cannot
 * interrupt a single synchronous `RegExp.prototype.test()` call mid-flight:
 * once V8 enters the regex engine it runs to completion before JS gets
 * control back. The only way to bound that is to run the match somewhere
 * that can be killed from outside — a worker thread, terminated on timeout.
 * `worker_threads` is a Node builtin, so this module must never be imported
 * from `packages/shared` (browser-bundled) or anywhere else reachable from
 * the web build; it is apps/api-only and Node-only by construction.
 */

// Aliased: jobs/workerReadinessCoverage.test.ts counts every bare
// `new Worker(...)` as a BullMQ consumer site; this one is a thread.
import { Worker as ThreadWorker } from 'node:worker_threads';

export type RegexMatchOutcome =
  | { status: 'matched' }
  | { status: 'not_matched' }
  | { status: 'timeout' }
  | { status: 'error'; message: string };

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const re = new RegExp(workerData.pattern, workerData.flags);
  const result = re.test(workerData.haystack);
  parentPort.postMessage({ ok: true, result });
} catch (err) {
  parentPort.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) });
}
`;

/**
 * Run `new RegExp(pattern, flags).test(haystack)` on a worker thread with a
 * hard kill at `timeoutMs`. Never throws; a timeout, a compile failure, or a
 * worker-level error all resolve to a tagged outcome so the caller can treat
 * every non-match outcome the same non-punitive way it already treats an
 * invalid pattern (`unknown`, not a failure attributed to the device).
 */
export function testRegexWithTimeout(
  pattern: string,
  flags: string,
  haystack: string,
  timeoutMs: number,
): Promise<RegexMatchOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: RegexMatchOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
    };

    let worker: ThreadWorker;
    try {
      worker = new ThreadWorker(WORKER_SOURCE, { eval: true, workerData: { pattern, flags, haystack } });
    } catch (err) {
      resolve({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }

    const timer = setTimeout(() => settle({ status: 'timeout' }), timeoutMs);

    worker.once('message', (msg: { ok: boolean; result?: boolean; message?: string }) => {
      if (!msg.ok) {
        settle({ status: 'error', message: msg.message ?? 'worker_error' });
        return;
      }
      settle(msg.result ? { status: 'matched' } : { status: 'not_matched' });
    });
    worker.once('error', (err: Error) => settle({ status: 'error', message: err.message }));
  });
}

/**
 * #3525 — the cancellation sweep's Prometheus series.
 *
 * A LEAF module: `prom-client` plus `./metricsRegistry`, nothing else. That is
 * load-bearing, not stylistic. The only caller is `jobs/staleCommandReaper.ts`,
 * which runs in the WORKER role (`BREEZE_ROLE=worker`) — a process that never
 * loads `routes/metrics.ts` and whose import closure is asserted never to reach
 * `routes/` (`services/workerEntrypointClosure.contract.test.ts`).
 *
 * So the counter is registered here and incremented directly, rather than
 * through the settable-recorder indirection `backupMetrics.ts` uses. That
 * indirection exists for leaves that must not import `prom-client` at all
 * (`dbConnectTimeoutStats` sits inside `services/sentry.ts`'s graph); this
 * module has no such constraint, and the direct form is what makes the series
 * appear in the role that actually produces it. Binding it from
 * `routes/metrics.ts` instead would have reproduced #4143 exactly: the api
 * process publishing a permanent zero while the worker did the reaping.
 *
 * Registration happens on import (module-scope `new Counter`), so a process
 * that never reaps publishes no series at all rather than publishing a zero it
 * cannot back.
 */
import { Counter } from 'prom-client';

import { metricsRegistry } from './metricsRegistry';

/**
 * Cancels that reached the end of their grace window without the device ever
 * proving what happened to the process.
 *
 * A non-zero rate here is an OPERATIONAL condition, not a code defect: agents
 * go offline, scripts finish a moment before the signal lands, an old agent
 * does not know the command. It is deliberately not paired with a Sentry
 * capture or a device alert (spec OD3-A) — the durable per-row signal is
 * `script_executions.cancel_state`, and this series is what makes a fleet-wide
 * change in that rate visible.
 */
const cancelUnconfirmedTotal = new Counter({
  name: 'breeze_script_cancel_unconfirmed_total',
  help: 'Script cancellations the sweep gave up on without proof the process stopped',
  registers: [metricsRegistry],
});

/** Count one cancellation resolved as `unconfirmed` by the sweep. */
export function recordCancelUnconfirmed(count = 1): void {
  cancelUnconfirmedTotal.inc(count);
}

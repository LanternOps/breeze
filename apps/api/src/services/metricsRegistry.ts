/**
 * The process-wide Prometheus registry (#4143).
 *
 * This module exists ONLY to hold the `Registry` singleton, and it must stay a
 * LEAF — `prom-client` is its one and only import, and nothing may be added
 * here that reaches `routes/`, `db/`, or any service. That constraint is
 * load-bearing, not stylistic:
 *
 *   `worker.ts` (BREEZE_ROLE=worker) statically imports this file so its slim
 *   raw-node:http server can serve `/metrics`, and
 *   `services/workerEntrypointClosure.contract.test.ts` walks worker.ts's
 *   import closure asserting it never reaches `routes/`. The registry used to
 *   be a module-private `const register = new Registry()` inside
 *   `routes/metrics.ts`, which meant the ONLY way to render a scrape was to
 *   load the entire route graph. In split-role mode (#4086) that made the
 *   worker container — the process actually running the 76 relocated BullMQ
 *   workers, the retention sweeps and the heavy jobs — completely unscrapable:
 *   `up` for it did not exist, and every series it could have published simply
 *   was not there. Not stale, not zero: absent, which no alert rule can see.
 *
 * Both roles share this one registry instance rather than each minting their
 * own, so a series' name, help text and label set have exactly one definition
 * regardless of which container publishes it. Which series are actually
 * REGISTERED still differs by role, and that is expected — an api-role process
 * registers the HTTP/business/fleet series from `routes/metrics.ts`, while a
 * worker-role process registers the role-agnostic runtime series from
 * `services/metricsRuntime.ts`. A scrape of either renders whatever that
 * process has registered; neither invents series for work it does not do.
 */
import { Registry } from 'prom-client';

/**
 * The shared registry. `routes/metrics.ts` registers the API's series onto it
 * and renders it for `/api/metrics/scrape`; `worker.ts` renders it for its own
 * `/metrics`.
 */
export const metricsRegistry = new Registry();

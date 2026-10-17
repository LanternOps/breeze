/**
 * Scaling W07 (#8146): the inputs of the spec §3 "agent cost" KPI that no
 * other series provides.
 *
 * LEAF: imports only `prom-client` and `./metricsRegistry`. `worker.ts` reaches
 * this module through `metricsRuntime.ts`, and
 * `workerEntrypointClosure.contract.test.ts` forbids that closure from reaching
 * `routes/`. That is why the socket count is a registered source (set by
 * `routes/agentWs.ts`) instead of an import of `getConnectedAgentCount`.
 *
 * Both series are computed at scrape time from in-memory values; nothing here
 * runs on a request path.
 */
import { Counter, Gauge } from 'prom-client';
import { metricsRegistry } from './metricsRegistry';

export const PROCESS_CPU_METRIC = 'breeze_process_cpu_seconds_total';
export const AGENT_WS_CONNECTIONS_METRIC = 'breeze_agent_ws_connections';

// prom-client's collectDefaultMetrics() is deliberately not called
// (metricsRuntime.ts header), so there is no process_cpu_seconds_total. This is
// the one series we need from that set, under our prefix. It is a Counter
// because rate() needs counter semantics; collect() re-reads the monotonic
// process.cpuUsage() totals on every scrape, so it never drifts.
if (!metricsRegistry.getSingleMetric(PROCESS_CPU_METRIC)) {
  new Counter({
    name: PROCESS_CPU_METRIC,
    help: 'CPU time consumed by this process, from process.cpuUsage(), by mode',
    labelNames: ['mode'] as const,
    registers: [metricsRegistry],
    collect() {
      const { user, system } = process.cpuUsage();
      this.reset();
      this.inc({ mode: 'user' }, user / 1e6);
      this.inc({ mode: 'system' }, system / 1e6);
    },
  });
}

let connectedAgentSource: (() => number) | null = null;

/**
 * `routes/agentWs.ts` registers its owned-socket count here (W07 D7). A process
 * that never registers a source (the worker role) publishes 0.
 */
export function registerConnectedAgentSource(source: () => number): void {
  connectedAgentSource = source;
}

if (!metricsRegistry.getSingleMetric(AGENT_WS_CONNECTIONS_METRIC)) {
  new Gauge({
    name: AGENT_WS_CONNECTIONS_METRIC,
    help: 'Agent WebSockets owned by this process (the presence leases it holds)',
    registers: [metricsRegistry],
    collect() {
      this.set(connectedAgentSource ? connectedAgentSource() : 0);
    },
  });
}

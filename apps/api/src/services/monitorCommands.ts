/**
 * `buildMonitorCommand` — extracted from `routes/monitors.ts` (wave 3.5d-b,
 * #4086) so `jobs/monitorWorker.ts` can import it without pulling in
 * `routes/monitors.ts`'s Hono route registration and, transitively, other
 * route modules. Split out verbatim: only the import location changed, the
 * body is byte-identical to the version that lived in `routes/monitors.ts`.
 * `routes/monitors.ts` re-imports and re-exports `buildMonitorCommand` from
 * here so route behavior/exports are unchanged.
 *
 * This extraction does NOT make `monitorWorker` closure-clean of the agent
 * socket graph: `jobs/monitorWorker.ts` still reaches `routes/agentWs.ts`
 * through `services/agentCommandRelay.ts` (a value import of
 * `isAgentConnected`/`sendCommandToAgent`), so `monitorWorker` remains
 * `socket-owner` per the Task 5 placement classification, not `global`.
 * Clearing that path requires making `agentCommandRelay`'s `routes/agentWs`
 * dependency a lazy import — filed as a follow-up, not done here.
 */

const MONITOR_TYPE_TO_COMMAND: Record<string, string> = {
  icmp_ping: 'network_ping',
  tcp_port: 'network_tcp_check',
  http_check: 'network_http_check',
  dns_check: 'network_dns_check'
};

export function buildMonitorCommand(monitor: {
  id: string;
  monitorType: string;
  target: string;
  config: unknown;
  timeout: number;
}) {
  const commandType = MONITOR_TYPE_TO_COMMAND[monitor.monitorType];
  if (!commandType) {
    throw new Error(`Unknown monitor type: ${monitor.monitorType}`);
  }
  const config = (monitor.config ?? {}) as Record<string, unknown>;

  const payload: Record<string, unknown> = {
    monitorId: monitor.id,
    target: monitor.target,
    timeout: monitor.timeout,
    ...config
  };

  // For HTTP checks, set url from target if not in config
  if (monitor.monitorType === 'http_check' && !payload.url) {
    payload.url = monitor.target;
  }

  // For DNS checks, set hostname from target if not in config
  if (monitor.monitorType === 'dns_check' && !payload.hostname) {
    payload.hostname = monitor.target;
  }

  return {
    id: `mon-${monitor.id}-${Date.now()}`,
    type: commandType,
    payload
  };
}

/**
 * Agent WebSocket credential-lease series (#8838).
 *
 * A DB pool stall once closed hundreds of healthy agent sockets at the same
 * instant because the lease re-check treated "could not ask" as "denied". These
 * series make the two distinguishable in Prometheus: re-check outcomes by
 * result, and credential-driven closes by reason.
 *
 * LEAF: `prom-client` and `metricsRegistry` are the only imports, matching
 * `services/clusterCacheMetrics.ts`.
 */
import { Counter } from 'prom-client';
import { metricsRegistry } from './metricsRegistry';

export type AgentWsCredentialRecheckResult = 'authorized' | 'denied' | 'unknown';
export type AgentWsCredentialCloseReason = 'denied' | 'unverified_grace_expired' | 'revoked';

export const AGENT_WS_CREDENTIAL_RECHECK_METRIC = 'breeze_agent_ws_credential_recheck_total';
export const AGENT_WS_CLOSED_METRIC = 'breeze_agent_ws_closed_total';

function existing<T>(name: string): T | undefined {
  return metricsRegistry.getSingleMetric(name) as T | undefined;
}

const recheckTotal: Counter<'result'> =
  existing<Counter<'result'>>(AGENT_WS_CREDENTIAL_RECHECK_METRIC)
  ?? new Counter({
    name: AGENT_WS_CREDENTIAL_RECHECK_METRIC,
    help: 'Agent WS credential lease DB re-checks by outcome; a re-check that exceeds its bounded wait counts as unknown (#8838)',
    labelNames: ['result'],
    registers: [metricsRegistry],
  });

const closedTotal: Counter<'reason'> =
  existing<Counter<'reason'>>(AGENT_WS_CLOSED_METRIC)
  ?? new Counter({
    name: AGENT_WS_CLOSED_METRIC,
    help: 'Agent WS sockets closed by the credential lease or revocation, by reason (#8838)',
    labelNames: ['reason'],
    registers: [metricsRegistry],
  });

// Pre-seed every series at 0 so rate()/alerts see a zero, not an absent series.
for (const result of ['authorized', 'denied', 'unknown'] as const) recheckTotal.inc({ result }, 0);
for (const reason of ['denied', 'unverified_grace_expired', 'revoked'] as const) closedTotal.inc({ reason }, 0);

export function recordAgentWsCredentialRecheck(result: AgentWsCredentialRecheckResult): void {
  recheckTotal.inc({ result });
}

export function recordAgentWsCredentialClose(reason: AgentWsCredentialCloseReason): void {
  closedTotal.inc({ reason });
}

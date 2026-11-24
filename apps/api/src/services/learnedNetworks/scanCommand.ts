/**
 * Learned networks E8 (#12369, spec §8.2): the only place either discovery scan command type is constructed
 * (`scanCommand.contract.test.ts` fails on any other). The unrestricted command is today's `network_discovery`
 * command, unchanged; the guarded one is the same payload plus `expectedNetwork` (index C2).
 */
import {
  EXPECTED_GATEWAYS_MAX, GUARDED_COMMAND_TYPES, type ExpectedGateway, type ExpectedNetwork,
} from '@breeze/shared';
import type { AgentCommand } from '../../routes/agentWs';
import type { GateDecision } from './gate';

/** The base family. Callers pass it as `commandType`, so they hold no command-type literal. */
export const DISCOVERY_SCAN_FAMILY = 'network_discovery' as const satisfies keyof typeof GUARDED_COMMAND_TYPES;

const byGatewayId = (a: ExpectedGateway, b: ExpectedGateway) =>
  (a.gatewayId < b.gatewayId ? -1 : a.gatewayId > b.gatewayId ? 1 : 0);

/**
 * The fingerprints sent to the agent: deduped by gateway id; those the chosen agent is behind now first, then
 * the rest; each group ascending by gateway id; cut to EXPECTED_GATEWAYS_MAX.
 */
function expectedGateways(allowed: readonly ExpectedGateway[], agentGatewayIds: readonly string[]): ExpectedGateway[] {
  const unique = [...new Map(allowed.map((g) => [g.gatewayId, g])).values()];
  const current = new Set(agentGatewayIds);
  const first = unique.filter((g) => current.has(g.gatewayId)).sort(byGatewayId);
  const rest = unique.filter((g) => !current.has(g.gatewayId)).sort(byGatewayId);
  return [...first, ...rest].slice(0, EXPECTED_GATEWAYS_MAX);
}

export function buildDiscoveryScanCommand(input: {
  commandId: string;
  payload: Record<string, unknown>;                            // today's network_discovery payload
  decision: Extract<GateDecision, { kind: 'unrestricted' | 'guarded' }>;
  agentGatewayIds?: readonly string[];                         // ordering hint for the 64 cut
}): AgentCommand {
  if (input.decision.kind === 'unrestricted') {
    return { id: input.commandId, type: DISCOVERY_SCAN_FAMILY, payload: { ...input.payload } };
  }
  const gateways = expectedGateways(input.decision.allowed, input.agentGatewayIds ?? []);
  if (gateways.length === 0) {
    throw new Error('buildDiscoveryScanCommand: a guarded scan needs at least one allowed fingerprint');
  }
  const expectedNetwork: ExpectedNetwork = { gateways };
  return {
    id: input.commandId,
    type: GUARDED_COMMAND_TYPES.network_discovery,
    payload: { ...input.payload, expectedNetwork },
  };
}

import { withSystemDbAccessContext } from '../../db';
import { isAgentConnected, sendCommandToAgent } from '../../routes/agentWs';
import {
  claimPendingCommandForDelivery,
  releaseClaimedCommandDelivery,
} from '../commandDispatch';
import type { TopologyDiagnosticDelivery } from './diagnosticDispatch';

/**
 * Push a freshly bound diagnostic command over the live agent socket.
 *
 * Kept out of `diagnosticDispatch.ts` on purpose: this is the one topology
 * module that reaches the socket registry under `routes/`, and the dispatch
 * service sits inside `commandDispatch.ts`'s import closure. Only the dispatch
 * WORKER imports this, which is why that worker is `socket-owner` placement.
 *
 * A miss is not an error. The command row stays `pending`, and the agent's next
 * heartbeat claim delivers it through exactly the same revalidation.
 */
export const deliverTopologyDiagnosticCommand: TopologyDiagnosticDelivery = async (input) => {
  if (!input.agentId || !isAgentConnected(input.agentId)) return false;

  const claimed = await withSystemDbAccessContext(
    () => claimPendingCommandForDelivery(input.commandId),
    'topology diagnostic socket delivery claim',
  );
  if (!claimed) return false;

  const delivered = sendCommandToAgent(input.agentId, {
    id: input.commandId,
    type: input.type,
    payload: input.payload,
  });
  if (!delivered) {
    // Put the row back so the heartbeat leg can still pick it up.
    await withSystemDbAccessContext(
      () => releaseClaimedCommandDelivery(input.commandId, claimed.executedAt),
      'topology diagnostic socket delivery release',
    );
    return false;
  }
  return true;
};

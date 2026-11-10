import { withSystemDbAccessContext } from '../../db';
import { agentReachability, dispatchCommandToAgent, dispatchDisposition } from '../agentCommandRelay';
import { captureException } from '../sentry';
import {
  claimPendingCommandForDelivery,
  releaseClaimedCommandDelivery,
} from '../commandDispatch';
import type { TopologyDiagnosticDelivery } from './diagnosticDispatch';

/**
 * Push a freshly bound diagnostic command to the agent's live socket.
 *
 * Kept out of `diagnosticDispatch.ts` on purpose: `commandDispatch.ts`
 * side-effect-imports the dispatch service while this leg value-imports
 * `commandDispatch.ts` (claim/release), so folding them together would be an
 * import cycle, and only the dispatch WORKER needs a delivery leg. It reaches the agent through the role-safe
 * `agentCommandRelay` facade (a local socket first, otherwise the instance that
 * owns the socket), not the socket registry under `routes/`, so the worker is
 * `global` placement (#4142).
 *
 * Disposition: delivered and uncertain both return true. An uncertain frame
 * (indeterminate relay, or a rejected promise, which the facade never does) may
 * already be out, so the claim is KEPT (no release, no retry) and the agent's
 * result or the stale reaper settles the row.
 *
 * A miss is not an error. The command row stays `pending`, and the agent's next
 * heartbeat claim delivers it through exactly the same revalidation.
 */
export const deliverTopologyDiagnosticCommand: TopologyDiagnosticDelivery = async (input) => {
  // Skip only when the agent is provably absent. `unknown` (presence could not
  // be read) proceeds: the dispatch below answers, and a miss releases the claim.
  if (!input.agentId || (await agentReachability(input.agentId)) === 'absent') return false;

  const claimed = await withSystemDbAccessContext(
    () => claimPendingCommandForDelivery(input.commandId),
    'topology diagnostic socket delivery claim',
  );
  // Only a claimed row is pushed. `cancelled` is terminal (claim-time
  // eligibility already settled it); `held` / `not_claimable` leave it to the
  // heartbeat claim.
  if (claimed.status !== 'claimed') return false;

  // #8318 §6.4: to the agent_id read IN the claim, not `input.agentId` read
  // when the command was bound (a reattach or re-enroll may have committed
  // since).
  let disposition: 'delivered' | 'uncertain' | 'not_delivered';
  try {
    disposition = dispatchDisposition(await dispatchCommandToAgent(claimed.agentId, {
      id: input.commandId,
      type: input.type,
      payload: input.payload,
    }));
  } catch (err) {
    // Contract violation (the facade never rejects): the frame may be out, so
    // treat it as uncertain. Keep the claim and report it.
    console.error('[topologyDiagnosticDelivery] relay facade rejected; keeping the delivery claim', {
      commandId: input.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err);
    return true;
  }
  if (disposition === 'not_delivered') {
    // Put the row back so the heartbeat leg can still pick it up.
    await withSystemDbAccessContext(
      () => releaseClaimedCommandDelivery(input.commandId, claimed.executedAt),
      'topology diagnostic socket delivery release',
    );
    return false;
  }
  return true;
};

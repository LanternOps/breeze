/**
 * The agent-visible answers of agent authentication's TERMINAL rejections, in
 * a leaf module (hono + @breeze/shared only) so a route that must answer a
 * stale caller the same way (#8318 §6.4) does not pull agentAuth's whole
 * import graph in with it. agentAuth re-exports both functions.
 */
import { HTTPException } from 'hono/http-exception';
import { ERROR_CODES } from '@breeze/shared';
import type { AgentAuthTerminalRejection } from './agentAuthNegativeCache';

/**
 * #8050 — the single source of each TERMINAL rejection's agent-visible
 * response. Used both when the rejection is first decided and when the
 * negative cache replays it, so a replay is byte-for-byte the original: same
 * status, same message, same structured body. Build a fresh exception per call
 * (a Response body can only be read once).
 */
export function terminalAgentAuthRejection(kind: AgentAuthTerminalRejection): HTTPException {
  switch (kind) {
    case 're_enrollment_required':
      // A device row exists but neither token hash is populated — the
      // pre-hashed-token migration state. A distinct error so the agent can
      // prompt for re-enrollment instead of silently retrying forever.
      return new HTTPException(401, {
        message: 'Re-enrollment required: device predates token-hash migration',
        res: new Response(
          JSON.stringify({ error: 'Re-enrollment required', code: ERROR_CODES.RE_ENROLLMENT_REQUIRED }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      });
    case 'decommissioned':
      return new HTTPException(403, { message: 'Device has been decommissioned' });
    case 'device_not_found':
    case 'token_suspended':
    case 'token_mismatch':
    case 'tenant_denied':
      // Deliberately indistinguishable: a suspended token, a suspended tenant
      // and a stale token all read as the same opaque 401.
      return new HTTPException(401, { message: 'Invalid agent credentials' });
  }
}

/**
 * #8318 §6.4: the answer for a request whose credential stopped matching its
 * device row while the request ran — a reattach confirm or an in-place
 * re-enroll changed the row's `agent_id` after agent auth authenticated it
 * (see services/agentOwnDeviceRow.ts `ownDeviceRowChangedHands`). It is
 * exactly the opaque 401 agent auth gives a token that no longer matches,
 * so the agent takes the same path it takes for that rejection (#2773: keep
 * the credential, retry; the next request re-authenticates against the row).
 * Not remembered in the negative cache: the next request answers for itself.
 */
export function staleAgentCredentialRejection(): HTTPException {
  return terminalAgentAuthRejection('token_mismatch');
}

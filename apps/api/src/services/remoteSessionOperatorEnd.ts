import { and, eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../db';
import { remoteSessions } from '../db/schema';
import { dispatchCommandToAgent } from './agentCommandRelay';
import { revokeViewerSession } from './viewerTokenRevocation';
import { captureException, captureMessage } from './sentry';
import { ACTIVE_REMOTE_SESSION_STATUSES } from './remoteSessionTeardown';
import {
  buildStopDesktopCommand,
  runTerminalWrite,
  terminalIntentSet,
  toTerminalSessionRow,
} from './remoteDesktopTerminalIntent';

type RemoteSessionRow = typeof remoteSessions.$inferSelect;

/**
 * An operator ending a remote session on purpose (`operator_ended`).
 *
 * Shared by the two callers that mean "the technician hung up":
 * - `POST /remote/sessions/:id/end` (web terminal Disconnect, web launcher
 *   cleanup), authorized by the user's session JWT;
 * - `POST /desktop-ws/:id/viewer/end` (the desktop viewer app's hang-up,
 *   #11931), authorized by the session's viewer token.
 *
 * Each caller authorizes the request and checks the row is live first. This
 * does the end itself: the status-guarded terminal write, the viewer token
 * revocation, and the agent stop. It does not write the audit row, because the
 * audit helper and the client address belong to the route.
 */
export interface OperatorEndInput {
  session: Pick<RemoteSessionRow, 'id' | 'type' | 'startedAt' | 'createdAt' | 'bytesTransferred' | 'recordingUrl'>;
  device: { id: string; agentId: string | null };
  bytesTransferred?: number;
  recordingUrl?: string | null;
  /** Prefixes the warnings this logs, so they name the caller. */
  logTag: string;
}

export type OperatorEndResult =
  | {
      ok: true;
      updated: RemoteSessionRow;
      terminalGeneration: bigint;
      durationSeconds: number;
      /**
       * Set when the row ended but the viewer token could not be revoked. The
       * caller writes its audit row first and then throws it, so the failure
       * is a 500 and not a silent success.
       */
      viewerRevocationError?: unknown;
    }
  | { ok: false; reason: 'already_ended'; status: string }
  | { ok: false; reason: 'not_found' };

export async function endRemoteSessionAsOperator(input: OperatorEndInput): Promise<OperatorEndResult> {
  const { session, device, logTag } = input;
  const sessionId = session.id;
  const endedAt = new Date();
  const startedAt = session.startedAt || session.createdAt;
  const durationSeconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);

  // The caller's status read is a TOCTOU snapshot: a concurrent terminal writer
  // (agent `failed` result, stale sweep, teardown, lease revocation, the
  // agent's peer-drop report) can land between that SELECT and this UPDATE.
  // Without a status predicate the End overwrites that terminal row — turning
  // a recorded `failed` with its errorMessage into a clean operator-initiated
  // `disconnected`, and resetting endedAt/durationSeconds. Guard on the live
  // states so the already-terminal case loses the write and is reported, not
  // silently clobbered.
  //
  // Through the terminal-intent contract: the same guarded UPDATE also bumps
  // the generation every start bumps, records it as the terminal one, and
  // moves the phase to 'pending' until the agent's stop result lands. The
  // live-status guard is the contract's own.
  const [updated] = await runTerminalWrite(() => db
    .update(remoteSessions)
    .set(terminalIntentSet({
      status: 'disconnected',
      endedAt,
      endReason: 'operator_ended',
      durationSeconds,
      bytesTransferred: input.bytesTransferred !== undefined ? BigInt(input.bytesTransferred) : session.bytesTransferred,
      recordingUrl: input.recordingUrl ?? session.recordingUrl
    }, 'pending'))
    .where(and(
      eq(remoteSessions.id, sessionId),
      inArray(remoteSessions.status, [...ACTIVE_REMOTE_SESSION_STATUSES])
    ))
    .returning());

  if (!updated) {
    // Lost the race (or the row went away). Re-read so the caller can answer
    // with the same shape its own pre-UPDATE guard uses.
    const [current] = await db
      .select({ status: remoteSessions.status })
      .from(remoteSessions)
      .where(eq(remoteSessions.id, sessionId))
      .limit(1);
    if (!current) return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'already_ended', status: current.status };
  }

  // Revoke the viewer token immediately on End. Without this, a minted viewer
  // token stays valid for its full lifetime (VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS
  // in services/jwt.ts) and could be replayed to reconnect after the operator
  // ended the session.
  let viewerRevocationError: unknown;
  try {
    await revokeViewerSession(sessionId);
  } catch (error) {
    viewerRevocationError = error;
  }

  // Tell the agent to tear down the live stream. Revoking the viewer token
  // only blocks NEW/reconnecting viewers and the legacy WS path; the WebRTC
  // (Flow B) media + input + clipboard flow peer-to-peer to the agent's
  // capture helper with the server out of the loop, so without an explicit
  // stop the operator keeps screen + input + clipboard control after "End".
  // The agent's handleStopDesktop tears down both the direct and the
  // SYSTEM-helper sessions. Finding #2.
  //
  // Durable relay, NOT the socket-local send: the agent's command socket very
  // often lives on a DIFFERENT API instance, where `sendCommandToAgent`
  // silently returns false — leaving the live WebRTC stream running against a
  // session the operator has already ended.
  //
  // NOT awaited. `dispatchCommandToAgent`'s relay branch polls Redis for the
  // delivery ack for up to RELAY_DELIVERY_DEADLINE_MS (5 s), and the REST
  // caller runs inside the auth middleware's ambient request transaction —
  // awaiting it would pin a pooled connection idle-in-transaction across that
  // wait on an operator-triggerable route, the #1105 pool-poison class the
  // `db_operation_inside_held_context` tripwire exists to catch. The row is
  // already terminal and the viewer token already revoked, so delivery is
  // best-effort by design; the outcome is logged and captured, not returned.
  //
  // The contract always writes the terminal generation with the terminal
  // status; a null here would mean the UPDATE above bypassed it.
  const terminalGeneration = toTerminalSessionRow(updated).terminalGeneration;
  if (session.type === 'desktop' && device.agentId) {
    // `dispatchCommandToAgent` RESOLVES with a status — it does not throw on
    // a failed delivery (see DispatchOutcome in services/agentCommandRelay).
    // A bare catch would therefore have been silent for every real
    // non-delivery, so branch on the status explicitly.
    //
    // Outside the caller's DB context: the relay refuses to run inside a held
    // one (#4142), and this send does not wait on the commit (the row update
    // is already final). Nothing here touches the database.
    const stopAgentId = device.agentId;
    void runOutsideDbContext(() => dispatchCommandToAgent(
      stopAgentId,
      buildStopDesktopCommand(sessionId, terminalGeneration),
    )).then((outcome) => {
      if (outcome.status === 'sent') return;
      const detail = outcome.status === 'infrastructure_error' ? ` (${outcome.message})` : '';
      console.warn(
        `[${logTag}] stop_desktop not delivered for session ${sessionId} `
        + `(device ${device.id}, agent ${stopAgentId}): ${outcome.status}${detail}`
      );
      // Two literal call sites, not one with a computed code: the BREEZE-18
      // scanner (sentryEventCodes.test.ts) requires `eventCode` be a plain
      // string literal, and the two branches are separately actionable —
      // one points at the relay, the other at the device.
      if (outcome.status === 'infrastructure_error') {
        captureMessage('remote desktop stop_desktop dispatch faulted after End', {
          eventCode: 'remote_desktop_stop_dispatch_failed',
          level: 'warning',
        });
      } else {
        captureMessage('remote desktop stop_desktop was not delivered after End', {
          eventCode: 'remote_desktop_stop_undelivered',
          level: 'warning',
        });
      }
    }).catch((err) => {
      console.error(`[${logTag}] Failed to dispatch stop_desktop for session ${sessionId}:`, err);
      captureException(err, undefined, { event_code: 'remote_desktop_stop_dispatch_failed' });
    });
  }

  return {
    ok: true,
    updated,
    terminalGeneration,
    durationSeconds,
    ...(viewerRevocationError !== undefined ? { viewerRevocationError } : {}),
  };
}

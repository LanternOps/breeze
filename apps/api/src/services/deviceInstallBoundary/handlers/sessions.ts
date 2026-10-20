/**
 * §5.5 Remote sessions, plus the endpoint messaging surfaces of the old
 * install's helper.
 *
 * - Live `remote_sessions` (desktop, terminal, file transfer) and
 *   `tunnel_sessions` are marked `disconnected` inside the boundary
 *   transaction, with the terminal-intent contract (both generations bumped).
 *   The desktop phase is written `confirmed`: the install that would
 *   acknowledge the stop is gone. The teardown that the row write alone does
 *   not achieve — viewer-token revocation, closing a live terminal or tunnel
 *   socket — runs only once the transaction COMMITS
 *   (`runAfterDbContextCommit`), the same helpers decommission uses.
 * - A live endpoint chat (`endpoint_conversations` opening/open) closes with
 *   `close_reason = 'device_reinstalled'`: it was a conversation with the old
 *   install's helper, and a live row would block every new chat (one live chat
 *   per device).
 * - Undelivered or still-displayed endpoint messages (`endpoint_message_deliveries`
 *   queued/delivered/displayed) become `superseded`, a status the CHECK already
 *   allows: the helper that held or showed them is gone.
 * - `support_sessions` exist only on ephemeral Quick Support devices, which can
 *   never be a reattach target (§6.4), so they are history.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, runAfterDbContextCommit } from '../../../db';
import { remoteSessions, tunnelSessions } from '../../../db/schema';
import {
  ACTIVE_REMOTE_SESSION_STATUSES,
  teardownDisconnectedSessions,
  teardownDisconnectedTunnels,
} from '../../remoteSessionTeardown';
import {
  terminalIntentSet,
  terminalSessionReturning,
  toTerminalSessionRow,
} from '../../remoteDesktopTerminalIntent';
import { DEVICE_REINSTALLED_REASON, rowCount, type BoundaryHandler } from '../types';

export const sessionsHandler: BoundaryHandler = {
  id: 'sessions',
  spec: '§5.5',
  tables: ['remote_sessions', 'tunnel_sessions', 'endpoint_conversations', 'endpoint_message_deliveries'],
  async run(ctx) {
    const d = ctx.deviceId;

    const remote = (
      await db
        .update(remoteSessions)
        .set(terminalIntentSet({ status: 'disconnected', endedAt: ctx.at }, 'confirmed'))
        .where(and(eq(remoteSessions.deviceId, d), inArray(remoteSessions.status, [...ACTIVE_REMOTE_SESSION_STATUSES])))
        .returning(terminalSessionReturning())
    ).map(toTerminalSessionRow);

    const tunnels = await db
      .update(tunnelSessions)
      .set({ status: 'disconnected', endedAt: ctx.at })
      .where(and(eq(tunnelSessions.deviceId, d), inArray(tunnelSessions.status, [...ACTIVE_REMOTE_SESSION_STATUSES])))
      .returning({ id: tunnelSessions.id, type: tunnelSessions.type, deviceId: tunnelSessions.deviceId });

    if (remote.length > 0) {
      runAfterDbContextCommit('installBoundary.remoteSessionTeardown', () => teardownDisconnectedSessions(remote));
    }
    if (tunnels.length > 0) {
      runAfterDbContextCommit('installBoundary.tunnelTeardown', () => teardownDisconnectedTunnels(tunnels));
    }

    const chats = rowCount(await db.execute(sql`
      UPDATE endpoint_conversations
         SET status = 'closed', close_reason = ${DEVICE_REINSTALLED_REASON}, closed_at = now(), updated_at = now()
       WHERE device_id = ${d}::uuid AND status IN ('opening', 'open')
      RETURNING id`));

    const deliveries = rowCount(await db.execute(sql`
      UPDATE endpoint_message_deliveries SET status = 'superseded', updated_at = now()
       WHERE device_id = ${d}::uuid AND status IN ('queued', 'delivered', 'displayed')
      RETURNING id`));

    return {
      'remote_sessions.disconnected': remote.length,
      'tunnel_sessions.disconnected': tunnels.length,
      'endpoint_conversations.closed': chats,
      'endpoint_message_deliveries.superseded': deliveries,
    };
  },
};

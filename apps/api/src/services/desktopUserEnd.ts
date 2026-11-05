import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { auditLogs, remoteSessions } from '../db/schema';
import { markRequestAuditWritten } from './auditRequestTracking';

/**
 * #10190 W06 (OD-5 (c)): the person at the keyboard ended a remote desktop
 * session from the on-screen indicator, after a confirmation, where the
 * device's remote-access policy allows it (`allow_user_end_session`).
 *
 * The agent reports it as its own `desk-userend-<sessionId>` command result,
 * sent just BEFORE it runs the normal stop routine. That stop sends the usual
 * `desk-disconnect-<sessionId>` `peer_disconnected` result, which stays the one
 * terminal writer for the row (remoteDesktopTerminalIntent.ts). This record is
 * bookkeeping about WHY: it sets `remote_sessions.end_reason` and writes the
 * audit event, so the technician sees "Ended by the user" instead of a bare
 * disconnect.
 *
 * A separate result, not a field on `desk-disconnect`: `result` is `.strict()`,
 * so a field an older API does not declare would drop the disconnect itself
 * (the `desk-clipsum-` precedent, desktopClipboardAudit.ts).
 */
export const DESKTOP_ENDED_BY_USER_ACTION = 'remote.session.ended_by_user';

/**
 * How long after a session went `disconnected` the user-end report is still
 * accepted. WS messages are not processed one at a time, so the agent's
 * `desk-disconnect` result can be handled before this one even though the
 * agent sent it second.
 */
export const USER_END_RECENT_WINDOW_MS = 10 * 60 * 1000;

export interface DesktopUserEndDeps {
  /**
   * Atomically sets end_reason = 'ended_by_user' on the session, and writes the
   * audit row in the same transaction, only for a desktop session that ran on
   * `deviceId`, has no end reason yet, and is active or went disconnected less
   * than `recentWindowMs` ago. Returns false when nothing matched (unknown or
   * foreign session, ended long ago, failed/denied, or already recorded).
   */
  markEndedByUser(input: { sessionId: string; deviceId: string; recentWindowMs: number }): Promise<boolean>;
}

export type DesktopUserEndOutcome = 'recorded' | 'not_recorded';

export async function recordDesktopSessionEndedByUser(
  input: { sessionId: string; deviceId: string },
  deps: DesktopUserEndDeps = defaultDeps,
): Promise<DesktopUserEndOutcome> {
  const recorded = await deps.markEndedByUser({
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    recentWindowMs: USER_END_RECENT_WINDOW_MS,
  });
  return recorded ? 'recorded' : 'not_recorded';
}

const defaultDeps: DesktopUserEndDeps = {
  async markEndedByUser({ sessionId, deviceId, recentWindowMs }) {
    return runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.transaction(async (tx) => {
          const cutoff = new Date(Date.now() - recentWindowMs);
          // Bound to the reporting device: an agent cannot label another
          // device's sessions. `end_reason IS NULL` makes a resend a no-op.
          const [row] = await tx
            .update(remoteSessions)
            .set({ endReason: 'ended_by_user' })
            .where(
              and(
                eq(remoteSessions.id, sessionId),
                eq(remoteSessions.deviceId, deviceId),
                eq(remoteSessions.type, 'desktop'),
                isNull(remoteSessions.endReason),
                or(
                  eq(remoteSessions.status, 'active'),
                  and(eq(remoteSessions.status, 'disconnected'), gt(remoteSessions.endedAt, cutoff)),
                ),
              ),
            )
            .returning({
              orgId: remoteSessions.orgId,
              userId: remoteSessions.userId,
              status: remoteSessions.status,
            });
          if (!row) return false;
          // Same shape as logSessionAudit's rows (routes/remote/helpers.ts),
          // written here so the reason and the audit row commit together.
          await tx.insert(auditLogs).values({
            orgId: row.orgId,
            actorType: 'agent',
            actorId: deviceId,
            action: DESKTOP_ENDED_BY_USER_ACTION,
            resourceType: 'remote_session',
            resourceId: sessionId,
            details: {
              sessionId,
              deviceId,
              sessionOwnerId: row.userId,
              endReason: 'ended_by_user',
              statusAtReport: row.status,
              reportedBy: 'authenticated_agent',
            },
            result: 'success',
          });
          markRequestAuditWritten();
          return true;
        }),
      ),
    );
  },
};

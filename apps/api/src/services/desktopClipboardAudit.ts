import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { auditLogs, remoteSessions } from '../db/schema';
import { logSessionAudit } from '../routes/remote/helpers';

/**
 * Clipboard traffic for one remote-desktop session, as the agent counted it:
 * direction × type → transfers and bytes, plus attempts the per-direction
 * policy blocked. Never any content.
 */
export interface DesktopClipboardSummary {
  transfers: Array<{
    direction: 'host_to_viewer' | 'viewer_to_host';
    type: 'text' | 'rtf' | 'image';
    count: number;
    bytes: number;
  }>;
  blocked: number;
}

export const DESKTOP_CLIPBOARD_SUMMARY_ACTION = 'session_clipboard_summary';

export interface DesktopClipboardAuditDeps {
  /** The session, only if it ran on this device. */
  findSession(sessionId: string, deviceId: string): Promise<{ orgId: string; userId: string } | null>;
  hasSummaryAudit(sessionId: string): Promise<boolean>;
  writeAudit(
    action: string,
    actorId: string,
    orgId: string,
    details: Record<string, unknown>,
  ): Promise<void>;
}

export type DesktopClipboardAuditOutcome = 'recorded' | 'empty' | 'unknown_session' | 'duplicate';

/**
 * Writes the one audit row for a session's clipboard activity (#1012). The
 * agent sends it once, at session teardown; the duplicate check covers a
 * resend from the agent's undelivered-result outbox.
 */
export async function recordDesktopClipboardSummary(
  input: { sessionId: string; deviceId: string; clipboard: DesktopClipboardSummary },
  deps: DesktopClipboardAuditDeps = defaultDeps,
): Promise<DesktopClipboardAuditOutcome> {
  const { sessionId, deviceId, clipboard } = input;
  if (clipboard.blocked === 0 && clipboard.transfers.every((t) => t.count === 0)) {
    return 'empty';
  }
  // Bound to the reporting device: an agent cannot write audit rows about
  // another device's sessions.
  const session = await deps.findSession(sessionId, deviceId);
  if (!session) return 'unknown_session';
  if (await deps.hasSummaryAudit(sessionId)) return 'duplicate';

  await deps.writeAudit(DESKTOP_CLIPBOARD_SUMMARY_ACTION, deviceId, session.orgId, {
    sessionId,
    clipboard,
    sessionOwnerId: session.userId,
    deviceId,
    reportedBy: 'authenticated_agent',
  });
  return 'recorded';
}

const defaultDeps: DesktopClipboardAuditDeps = {
  async findSession(sessionId, deviceId) {
    const rows = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db
          .select({ orgId: remoteSessions.orgId, userId: remoteSessions.userId })
          .from(remoteSessions)
          .where(and(eq(remoteSessions.id, sessionId), eq(remoteSessions.deviceId, deviceId)))
          .limit(1),
      ),
    );
    return rows[0] ?? null;
  },
  async hasSummaryAudit(sessionId) {
    const rows = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db
          .select({ id: auditLogs.id })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.resourceType, 'remote_session'),
              eq(auditLogs.resourceId, sessionId),
              eq(auditLogs.action, DESKTOP_CLIPBOARD_SUMMARY_ACTION),
            ),
          )
          .limit(1),
      ),
    );
    return rows.length > 0;
  },
  async writeAudit(action, actorId, orgId, details) {
    await logSessionAudit(action, actorId, orgId, details, undefined, 'agent');
  },
};

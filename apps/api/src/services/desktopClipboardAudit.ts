import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { auditLogs, remoteSessions } from '../db/schema';
import { markRequestAuditWritten } from './auditRequestTracking';

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
  /**
   * The agent Session that counted this. One server session can span several
   * (WebRTC reconnect, Retry, session switch), each reporting once.
   */
  segmentId?: string;
}

export const DESKTOP_CLIPBOARD_SUMMARY_ACTION = 'session_clipboard_summary';

export interface DesktopClipboardAuditDeps {
  /** The session, only if it ran on this device. */
  findSession(sessionId: string, deviceId: string): Promise<{ orgId: string; userId: string } | null>;
  /**
   * Inserts the summary row unless one already exists for this session and
   * segment (`details.segmentId`; the session alone when absent), atomically.
   * Returns false when one existed. Two copies of the same report can be in
   * flight at once (WS messages are not processed one at a time), so the
   * check and the insert must not be separate transactions.
   */
  writeAuditOnce(actorId: string, orgId: string, details: Record<string, unknown> & { sessionId: string; segmentId?: string }): Promise<boolean>;
}

export type DesktopClipboardAuditOutcome = 'recorded' | 'empty' | 'unknown_session' | 'duplicate';

/**
 * Writes the audit row for one segment of a session's clipboard activity
 * (#1012). Each agent Session sends it once, at teardown; the duplicate check
 * covers a resend of that same report.
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

  const written = await deps.writeAuditOnce(deviceId, session.orgId, {
    sessionId,
    clipboard,
    sessionOwnerId: session.userId,
    deviceId,
    reportedBy: 'authenticated_agent',
    ...(clipboard.segmentId ? { segmentId: clipboard.segmentId } : {}),
  });
  return written ? 'recorded' : 'duplicate';
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
  async writeAuditOnce(actorId, orgId, details) {
    // Same shape as logSessionAudit's rows, written in one system-scope
    // transaction serialized per session so a duplicate report finds the row.
    return runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'clipboard-summary:' + details.sessionId}, 0))`);
          const existing = await tx
            .select({ id: auditLogs.id })
            .from(auditLogs)
            .where(
              and(
                eq(auditLogs.resourceType, 'remote_session'),
                eq(auditLogs.resourceId, details.sessionId),
                eq(auditLogs.action, DESKTOP_CLIPBOARD_SUMMARY_ACTION),
                details.segmentId
                  ? sql`${auditLogs.details}->>'segmentId' = ${details.segmentId}`
                  : undefined,
              ),
            )
            .limit(1);
          if (existing.length > 0) return false;
          await tx.insert(auditLogs).values({
            orgId,
            actorType: 'agent',
            actorId,
            action: DESKTOP_CLIPBOARD_SUMMARY_ACTION,
            resourceType: 'remote_session',
            resourceId: details.sessionId,
            details,
            result: 'success',
          });
          // No-op on the agent WS path (no request scope); keeps the generic
          // request-audit fallback from adding a second row on a request path.
          markRequestAuditWritten();
          return true;
        }),
      ),
    );
  },
};

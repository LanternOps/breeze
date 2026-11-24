import { and, eq, isNull } from 'drizzle-orm';
import { db, withDbAccessContext } from '../db';
import { aiSessions } from '../db/schema';

/**
 * Store the SDK session id a chat query reported on its `init` event — but
 * only over the value that query STARTED from (`startedFrom`: the id it
 * resumed, or null for a fresh transcript).
 *
 * #8855: the nightly AI tool output retention job clears
 * `ai_sessions.sdk_session_id` when it scrubs a session's expired tool outputs,
 * so the raw SDK transcript can no longer be resumed. A query that loaded the
 * old id just before that commit would otherwise write it straight back on
 * `init`. Returns whether the pointer was stored.
 */
export async function storeSdkSessionPointer(input: {
  breezeSessionId: string;
  orgId: string;
  sdkSessionId: string;
  startedFrom: string | null;
}): Promise<boolean> {
  const rows = await withDbAccessContext(
    { scope: 'organization', orgId: input.orgId, accessibleOrgIds: [input.orgId] },
    () =>
      db.update(aiSessions)
        .set({ sdkSessionId: input.sdkSessionId })
        .where(and(
          eq(aiSessions.id, input.breezeSessionId),
          input.startedFrom ? eq(aiSessions.sdkSessionId, input.startedFrom) : isNull(aiSessions.sdkSessionId),
        ))
        .returning({ id: aiSessions.id }),
  );
  return rows.length > 0;
}

/**
 * #11818: stop trusting an SDK session for `resume` — the CLI reported
 * (`session_writes_lost`) that it could not save part of that transcript.
 * Clears the pointer only while it still equals `sdkSessionId`, so a newer
 * pointer written by a later query is never wiped. The next turn then starts a
 * fresh SDK session, exactly as after the #8855 retention clear.
 */
export async function clearSdkSessionPointer(input: {
  breezeSessionId: string;
  orgId: string;
  sdkSessionId: string;
}): Promise<boolean> {
  const rows = await withDbAccessContext(
    { scope: 'organization', orgId: input.orgId, accessibleOrgIds: [input.orgId] },
    () =>
      db.update(aiSessions)
        .set({ sdkSessionId: null })
        .where(and(
          eq(aiSessions.id, input.breezeSessionId),
          eq(aiSessions.sdkSessionId, input.sdkSessionId),
        ))
        .returning({ id: aiSessions.id }),
  );
  return rows.length > 0;
}

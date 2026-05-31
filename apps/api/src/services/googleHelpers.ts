/**
 * Shared helpers for the Google Workspace identity AI tool handlers.
 *
 * Mirrors m365Helpers: pure functions (errorString, authorizeGoogleConnection)
 * plus minimal DB-backed loaders. The tool handler owns the DB access context
 * (tool execution runs under the session's org RLS context), so these are plain
 * selects; the explicit org check in authorizeGoogleConnection is defense in
 * depth on top of RLS.
 *
 * Unlike the M365 (Delegant) model, the Google connection is one-per-org and
 * stores the service-account key itself, encrypted. decryptConnectionKey returns
 * the plaintext JSON for in-memory use only — it must never be logged or
 * returned to a client.
 */

import { db } from '../db';
import { eq } from 'drizzle-orm';
import { aiSessions } from '../db/schema/ai';
import { googleWorkspaceConnections } from '../db/schema/google';
import type { GoogleWorkspaceConnectionRow } from '../db/schema/google';
import { decryptForColumn } from './secretCrypto';

export function errorString(code: string, message: string): string {
  return JSON.stringify({ error: code, message });
}

export function authorizeGoogleConnection(
  conn: GoogleWorkspaceConnectionRow | null,
  authOrgId: string,
): { ok: true; conn: GoogleWorkspaceConnectionRow } | { ok: false } {
  if (!conn) return { ok: false };
  if (conn.orgId !== authOrgId) return { ok: false };
  if (conn.status !== 'active') return { ok: false };
  return { ok: true, conn };
}

export async function loadSession(sessionId: string) {
  const [row] = await db
    .select()
    .from(aiSessions)
    .where(eq(aiSessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

/** Resolve the single Google Workspace connection for an org (by org_id). */
export async function loadGoogleConnection(
  orgId: string,
): Promise<GoogleWorkspaceConnectionRow | null> {
  const [row] = await db
    .select()
    .from(googleWorkspaceConnections)
    .where(eq(googleWorkspaceConnections.orgId, orgId))
    .limit(1);
  return row ?? null;
}

/** Decrypt the stored service-account key JSON for in-memory use. */
export function decryptConnectionKey(conn: GoogleWorkspaceConnectionRow): string {
  const decrypted = decryptForColumn(
    'google_workspace_connections',
    'service_account_key',
    conn.serviceAccountKey,
  );
  if (!decrypted) {
    throw new Error('Google Workspace connection key could not be decrypted.');
  }
  return decrypted;
}

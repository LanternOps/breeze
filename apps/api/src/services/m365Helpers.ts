/**
 * Shared helpers for the M365 helpdesk AI tool handlers.
 *
 * Pure functions (authorizeConnection, formatResultForLlm, errorString) plus
 * minimal DB-backed loaders (loadSession, loadConnection). The loaders are
 * intentionally plain selects — the calling tool handler owns access context.
 */

import { db } from '../db';
import { eq } from 'drizzle-orm';
import { aiSessions } from '../db/schema/ai';
import { delegantM365Connections } from '../db/schema/delegant';
import type { DelegantM365ConnectionRow } from '../db/schema/delegant';
import type { DelegantInvokeResult } from './delegantClient';

export function errorString(code: string, message: string): string {
  return JSON.stringify({ error: code, message });
}

export function authorizeConnection(
  conn: DelegantM365ConnectionRow | null,
  authOrgId: string,
): { ok: true; conn: DelegantM365ConnectionRow } | { ok: false } {
  if (!conn) return { ok: false };
  if (conn.orgId !== authOrgId) return { ok: false };
  if (conn.status !== 'active') return { ok: false };
  return { ok: true, conn };
}

export function formatResultForLlm(
  result: DelegantInvokeResult,
  templates: {
    successTemplate: (data: any) => string;
    errorTemplate: (err: { code: string; message: string }) => string;
  },
): string {
  if (result.kind === 'ok') {
    const message = templates.successTemplate(result.data);
    // When Delegant returns a toolCallId, emit a JSON envelope carrying both the
    // human-readable message and the delegantToolCallId so the postToolUse layer
    // can correlate this Breeze audit row to Delegant's audit ledger. The human
    // text remains a substring of the JSON (the LLM can still read it).
    if (typeof result.toolCallId === 'string') {
      return JSON.stringify({ message, delegantToolCallId: result.toolCallId });
    }
    return message;
  }
  return templates.errorTemplate({ code: result.code, message: result.message });
}

export async function loadSession(sessionId: string) {
  const [row] = await db
    .select()
    .from(aiSessions)
    .where(eq(aiSessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

export async function loadConnection(connectionId: string) {
  const [row] = await db
    .select()
    .from(delegantM365Connections)
    .where(eq(delegantM365Connections.id, connectionId))
    .limit(1);
  return row ?? null;
}

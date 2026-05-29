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
  if (result.kind === 'ok') return templates.successTemplate(result.data);
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

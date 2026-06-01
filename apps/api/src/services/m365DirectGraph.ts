/**
 * Direct Microsoft Graph backend for the M365 identity tools.
 *
 * For self-hosted deployments that DON'T use the external Delegant broker, this
 * talks to Graph directly with a client-credentials token built from the per-org
 * `m365_connections` row (tenant id + client id + encrypted client secret).
 *
 * It exposes `invokeDirect(orgId, toolName, params)` which maps the same
 * `DelegantToolName` set the tool handlers already use to Graph calls, and
 * returns the SAME result shape (`{kind:'ok',data}` | `{kind:'error',code,message}`)
 * that `formatResultForLlm` consumes — so the existing handlers work unchanged
 * once `aiToolsM365.ts` routes through here when a direct connection exists.
 *
 * Reuses `acquireClientCredentialsToken` from c2cM365 (fixed-host, SSRF-safe).
 * Reads need only User.Read.All / Group.Read.All / AuditLog.Read.All; the
 * mutations (disable, reset password) additionally require the app to hold
 * User.ReadWrite.All / User-PasswordProfile.ReadWrite.All plus the User
 * Administrator Entra role — surfaced as a clear error if the grant is missing.
 */

import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { m365Connections } from '../db/schema/m365';
import { decryptForColumn } from './secretCrypto';
import { acquireClientCredentialsToken } from './c2cM365';
import type { DelegantToolName } from './delegantClient';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export type DirectInvokeResult =
  | { kind: 'ok'; data: unknown }
  | { kind: 'error'; code: string; message: string };

/** True when a direct M365 connection exists for the org (selects the direct backend). */
export async function hasDirectM365Connection(orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: m365Connections.id })
    .from(m365Connections)
    .where(eq(m365Connections.orgId, orgId))
    .limit(1);
  return !!row;
}

function mapStatusToCode(status: number): string {
  switch (status) {
    case 400: return 'bad_request';
    case 401: return 'auth_failed';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    default: return status >= 500 ? 'graph_unavailable' : 'tool_error';
  }
}

/** Strong temporary password (mixed classes), used by reset_user_password. */
function generateTempPassword(): string {
  const raw = randomBytes(18).toString('base64').replace(/[+/=]/g, '');
  return `Mz9!${raw.slice(0, 18)}`;
}

async function getToken(orgId: string): Promise<{ token: string } | DirectInvokeResult> {
  const [row] = await db
    .select()
    .from(m365Connections)
    .where(eq(m365Connections.orgId, orgId))
    .limit(1);
  if (!row) {
    return { kind: 'error', code: 'no_connection', message: 'No Microsoft 365 connection for this organization.' };
  }
  const secret = decryptForColumn('m365_connections', 'client_secret', row.clientSecret);
  if (!secret) {
    return { kind: 'error', code: 'connection_key_error', message: 'Could not decrypt the stored client secret.' };
  }
  try {
    const t = await acquireClientCredentialsToken({
      tenantId: row.tenantId,
      clientId: row.clientId,
      clientSecret: secret,
    });
    return { token: t.accessToken };
  } catch (err) {
    return { kind: 'error', code: 'auth_failed', message: err instanceof Error ? err.message : 'token acquisition failed' };
  }
}

async function graphFetch(
  token: string,
  method: 'GET' | 'PATCH' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<DirectInvokeResult> {
  let resp: Response;
  try {
    resp = await fetch(`${GRAPH_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return { kind: 'error', code: 'graph_unreachable', message: err instanceof Error ? err.message : 'Graph request failed' };
  }
  if (resp.status === 204) return { kind: 'ok', data: { ok: true } };
  let json: unknown = null;
  try {
    json = await resp.json();
  } catch {
    json = null;
  }
  if (!resp.ok) {
    const message =
      (json as any)?.error?.message ?? `Graph returned HTTP ${resp.status}`;
    return { kind: 'error', code: mapStatusToCode(resp.status), message };
  }
  return { kind: 'ok', data: json };
}

/**
 * Map a Delegant tool name + params to a direct Graph call. `userId` may be a UPN
 * or an object id (Graph /users/{key} accepts either); sign-in filtering needs
 * the object id, which the handler resolves first via get_user.
 */
export async function invokeDirect(
  orgId: string,
  toolName: DelegantToolName,
  params: Record<string, unknown>,
): Promise<DirectInvokeResult> {
  const tok = await getToken(orgId);
  if ('kind' in tok) return tok; // error result
  const token = tok.token;
  const userId = typeof params.userId === 'string' ? params.userId : '';
  const groupId = typeof params.groupId === 'string' ? params.groupId : '';

  switch (toolName) {
    case 'get_user':
      if (!userId) return { kind: 'error', code: 'bad_request', message: 'userId is required.' };
      return graphFetch(token, 'GET', `/users/${encodeURIComponent(userId)}`);

    case 'get_user_signin_activity': {
      if (!userId) return { kind: 'error', code: 'bad_request', message: 'userId is required.' };
      // Escape single quotes per OData (double them) so a quote in the id can't
      // break out of the literal; encodeURIComponent only handles URL transport.
      const odataId = userId.replace(/'/g, "''");
      // Sign-in logs require Entra ID P1/P2 on the tenant; a clear error surfaces if not.
      return graphFetch(
        token,
        'GET',
        `/auditLogs/signIns?$filter=${encodeURIComponent(`userId eq '${odataId}'`)}&$top=10`,
      );
    }

    case 'list_groups':
      return graphFetch(token, 'GET', `/groups?$top=50&$select=id,displayName,mail,description`);

    case 'get_group_members':
      if (!groupId) return { kind: 'error', code: 'bad_request', message: 'groupId is required.' };
      return graphFetch(token, 'GET', `/groups/${encodeURIComponent(groupId)}/members`);

    case 'disable_user':
      if (!userId) return { kind: 'error', code: 'bad_request', message: 'userId is required.' };
      return graphFetch(token, 'PATCH', `/users/${encodeURIComponent(userId)}`, { accountEnabled: false });

    case 'reset_user_password': {
      if (!userId) return { kind: 'error', code: 'bad_request', message: 'userId is required.' };
      const password = generateTempPassword();
      const res = await graphFetch(token, 'PATCH', `/users/${encodeURIComponent(userId)}`, {
        passwordProfile: { forceChangePasswordNextSignIn: true, password },
      });
      // On success, return the temp password so the handler can surface it.
      if (res.kind === 'ok') return { kind: 'ok', data: { ok: true, temporaryPassword: password } };
      return res;
    }

    default:
      return { kind: 'error', code: 'bad_request', message: `Unsupported tool: ${toolName}` };
  }
}

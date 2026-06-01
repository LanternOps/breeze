/**
 * Microsoft 365 helpdesk AI tool handlers.
 *
 * Each exported handler is a clean, unit-testable function with an EXPLICIT
 * sessionId parameter: (input, auth, sessionId) => Promise<string>. They are
 * registered inline inside createBreezeMcpServer (see aiAgentSdkTools.ts),
 * which supplies the session id from the active AI session.
 *
 * Flow per call: resolve session + customer connection (with cross-org guard) ->
 * optionally resolve a UPN to an object id -> invoke the Delegant tool ->
 * format a concise LLM-readable string.
 */

import type { AuthContext } from '../middleware/auth';
import { invokeDelegantTool, type DelegantToolName, type DelegantInvokeResult } from './delegantClient';
import { invokeDirect, hasDirectM365Connection } from './m365DirectGraph';
import type { DelegantM365ConnectionRow } from '../db/schema/delegant';
import {
  loadSession, loadConnection, authorizeConnection, formatResultForLlm, errorString,
} from './m365Helpers';
import {
  DELEGANT_BASE_URL, DELEGANT_SERVICE_TOKEN, DELEGANT_PRINCIPAL_SIGNING_KEY, DELEGANT_PRINCIPAL_KID,
} from '../config/env';

const env = {
  DELEGANT_BASE_URL, DELEGANT_SERVICE_TOKEN, DELEGANT_PRINCIPAL_SIGNING_KEY, DELEGANT_PRINCIPAL_KID,
};

export const m365ToolTiers: Record<string, 1 | 3> = {
  m365_lookup_user: 1,
  m365_recent_signins: 1,
  m365_list_group_memberships: 1,
  m365_disable_user: 3,
  m365_reset_password: 3,
};

// v1 single-customer seeding: every action is attributed to one static acting
// principal + one agent principal sourced from env. This is a deliberate v1
// shortcut (per-technician principal mapping is a known follow-up) — see the
// operator runbook. Named DELEGANT_* (not DELEGANT_TEST_*) because these are
// real production config, not test scaffolding.
function principals(auth: AuthContext) {
  return {
    actingUser: {
      breezeUserId: auth.user.id,
      delegantPrincipalId: process.env.DELEGANT_ACTING_USER_ID ?? '',
    },
    agent: { delegantPrincipalId: process.env.DELEGANT_AGENT_ID ?? '' },
  };
}

// The handler layer is backend-agnostic: a session resolves to EITHER a direct
// Graph backend (self-hosted, the org has its own m365_connections row) or the
// Delegant broker connection (session.delegantM365ConnectionId). `call()`
// dispatches on this; every handler stays identical.
type Backend =
  | { backend: 'direct'; orgId: string }
  | { backend: 'delegant'; conn: DelegantM365ConnectionRow };
type ResolvedContext = { error: string } | Backend;

async function resolveContext(auth: AuthContext, sessionId: string): Promise<ResolvedContext> {
  const session = await loadSession(sessionId);
  if (!session) return { error: errorString('session_not_found', 'AI session not found.') };
  // Prefer the direct Graph backend when this org has its own M365 connection
  // (no Delegant broker required). Falls back to the Delegant session connection.
  if (auth.orgId && (await hasDirectM365Connection(auth.orgId))) {
    return { backend: 'direct', orgId: auth.orgId };
  }
  if (!session.delegantM365ConnectionId) {
    return {
      error: errorString(
        'no_customer_selected',
        'No M365 connection for this organization, and no Delegant customer is selected for this session. Connect Microsoft 365 in settings.',
      ),
    };
  }
  const conn = await loadConnection(session.delegantM365ConnectionId);
  const authz = authorizeConnection(conn, auth.orgId ?? '');
  if (!authz.ok) {
    return { error: errorString('connection_not_found', 'M365 connection not found for this session.') };
  }
  return { backend: 'delegant', conn: authz.conn };
}

async function call(
  ctx: Backend,
  auth: AuthContext,
  sessionId: string,
  toolName: DelegantToolName,
  parameters: Record<string, unknown>,
): Promise<DelegantInvokeResult> {
  if (ctx.backend === 'direct') {
    // DirectInvokeResult is structurally a subset of DelegantInvokeResult; its
    // error `code` is a plain string (formatResultForLlm reads it for display
    // only), so the cast is sound.
    return (await invokeDirect(ctx.orgId, toolName, parameters)) as DelegantInvokeResult;
  }
  const p = principals(auth);
  return invokeDelegantTool(
    { connection: ctx.conn, toolName, parameters, actingUser: p.actingUser, agent: p.agent, sessionId },
    { env },
  );
}

/**
 * Resolve a user identifier to a Graph object id. UPNs (containing '@') are
 * resolved via a get_user call first; bare object ids are returned as-is.
 * Returns null if resolution fails (so the caller can surface a graceful error).
 */
async function resolveUserId(
  identifier: string,
  ctx: Backend,
  auth: AuthContext,
  sessionId: string,
): Promise<string | null> {
  if (!identifier.includes('@')) return identifier;
  const res = await call(ctx, auth, sessionId, 'get_user', { userId: identifier });
  if (res.kind === 'ok') return (res.data as any)?.id ?? identifier;
  return null;
}

const errorTemplate = (e: { code: string; message: string }): string =>
  `Could not complete the M365 operation: ${e.message}`;

const unresolvedUser = (identifier: string): string =>
  errorString('user_not_found', `Could not find an M365 user matching "${identifier}".`);

function requireString(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export async function m365LookupUserHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const identifier = requireString(input, 'userIdentifier');
  if (!identifier) return errorString('missing_user', 'A user identifier (UPN or object id) is required.');

  const result = await call(ctx, auth, sessionId, 'get_user', { userId: identifier });
  return formatResultForLlm(result, {
    successTemplate: (data) => `M365 user profile: ${JSON.stringify(data)}`,
    errorTemplate,
  });
}

export async function m365RecentSigninsHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const identifier = requireString(input, 'userIdentifier');
  if (!identifier) return errorString('missing_user', 'A user identifier (UPN or object id) is required.');

  const userId = await resolveUserId(identifier, ctx, auth, sessionId);
  if (userId === null) return unresolvedUser(identifier);

  const result = await call(ctx, auth, sessionId, 'get_user_signin_activity', { userId });
  return formatResultForLlm(result, {
    successTemplate: (data) => `Recent sign-in activity for ${identifier}: ${JSON.stringify(data)}`,
    errorTemplate,
  });
}

export async function m365ListGroupMembershipsHandler(
  _input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;

  const result = await call(ctx, auth, sessionId, 'list_groups', {});
  return formatResultForLlm(result, {
    successTemplate: (data) => `Groups in the customer tenant: ${JSON.stringify(data)}`,
    errorTemplate,
  });
}

export async function m365DisableUserHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');

  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const identifier = requireString(input, 'userIdentifier');
  if (!identifier) return errorString('missing_user', 'A user identifier (UPN or object id) is required.');

  const userId = await resolveUserId(identifier, ctx, auth, sessionId);
  if (userId === null) return unresolvedUser(identifier);

  const result = await call(ctx, auth, sessionId, 'disable_user', { userId, reason });
  return formatResultForLlm(result, {
    successTemplate: () => `Disabled (blocked sign-in for) M365 user ${identifier}.`,
    errorTemplate,
  });
}

export async function m365ResetPasswordHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');

  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const identifier = requireString(input, 'userIdentifier');
  if (!identifier) return errorString('missing_user', 'A user identifier (UPN or object id) is required.');

  const userId = await resolveUserId(identifier, ctx, auth, sessionId);
  if (userId === null) return unresolvedUser(identifier);

  const result = await call(ctx, auth, sessionId, 'reset_user_password', { userId, reason });
  return formatResultForLlm(result, {
    successTemplate: (data) => {
      const temp = (data as any)?.temporaryPassword;
      return temp
        ? `Reset the password for ${identifier}. Temporary password: ${temp} (the user must change it at next sign-in).`
        : `Reset the password for ${identifier}. ${JSON.stringify(data)}`;
    },
    errorTemplate,
  });
}

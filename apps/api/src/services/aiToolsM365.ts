/**
 * Microsoft 365 AI tool handlers.
 *
 * This file has two distinct halves:
 *
 * 1. Helpdesk tools (m365_lookup_user, m365_recent_signins,
 *    m365_list_group_memberships, m365_disable_user, m365_reset_password) —
 *    each exported handler is a clean, unit-testable function with an
 *    EXPLICIT sessionId parameter: (input, auth, sessionId) => Promise<string>.
 *    They are registered inline inside createBreezeMcpServer (see
 *    aiAgentSdkTools.ts), which supplies the session id from the active AI
 *    session. Flow per call: resolve session + customer connection (with
 *    cross-org guard) -> optionally resolve a UPN to an object id -> invoke
 *    the Delegant tool -> format a concise LLM-readable string.
 *
 * 2. Typed Graph read-query tools (m365_query_users, m365_query_signins,
 *    m365_query_intune_devices, m365_query_groups, m365_query_org,
 *    m365_query_sites) — standard registry `AiTool`s with the ordinary
 *    `(input, auth) => Promise<string>` handler signature, registered into
 *    the shared `aiTools` map via `registerM365Tools`. These map their input
 *    onto a typed `M365ReadAction` and delegate to
 *    `executeM365ReadAction` (the Task 8 control-plane service), which owns
 *    the authz ladder, budget, and audit trail. See "Typed Graph read-query
 *    tools" below.
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
import { m365ReadActionSchema, type M365ReadAction } from '@breeze/shared/m365';
import { executeM365ReadAction, type M365ReadActionServiceResult } from './m365ControlPlane/readActionService';
import type { AiTool } from './aiTools';

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
 * On failure returns the underlying error (code + message) so the caller can
 * distinguish a genuinely-absent user (404 'not_found') from an auth/permission/
 * transport failure that must not masquerade as "user not found".
 */
type ResolveUserResult =
  | { ok: true; userId: string }
  | { ok: false; error: { code: string; message: string } };

async function resolveUserId(
  identifier: string,
  ctx: Backend,
  auth: AuthContext,
  sessionId: string,
): Promise<ResolveUserResult> {
  if (!identifier.includes('@')) return { ok: true, userId: identifier };
  const res = await call(ctx, auth, sessionId, 'get_user', { userId: identifier });
  if (res.kind === 'ok') return { ok: true, userId: (res.data as { id?: string } | null)?.id ?? identifier };
  // Propagate the real failure instead of collapsing every non-ok result to
  // "user not found": only a 404 (code 'not_found') means the user is genuinely
  // absent. auth_failed / forbidden / 5xx are config/permission/transport
  // errors that must surface as themselves, not as a phantom missing user.
  return { ok: false, error: { code: res.code, message: res.message } };
}

const errorTemplate = (e: { code: string; message: string }): string =>
  errorString(e.code, `Could not complete the M365 operation: ${e.message}`);

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

  const resolved = await resolveUserId(identifier, ctx, auth, sessionId);
  if (!resolved.ok) {
    return resolved.error.code === 'not_found'
      ? unresolvedUser(identifier)
      : errorTemplate(resolved.error);
  }
  const userId = resolved.userId;

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

  const resolved = await resolveUserId(identifier, ctx, auth, sessionId);
  if (!resolved.ok) {
    return resolved.error.code === 'not_found'
      ? unresolvedUser(identifier)
      : errorTemplate(resolved.error);
  }
  const userId = resolved.userId;

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

  const resolved = await resolveUserId(identifier, ctx, auth, sessionId);
  if (!resolved.ok) {
    return resolved.error.code === 'not_found'
      ? unresolvedUser(identifier)
      : errorTemplate(resolved.error);
  }
  const userId = resolved.userId;

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

// ============================================
// Typed Graph read-query tools (Task 9)
//
// Standard registry AiTools — (input, auth) => Promise<string>, registered
// into the shared `aiTools` map via registerM365Tools(aiTools) (called from
// aiTools.ts). Each tool maps its loose input onto exactly one typed
// M365ReadAction variant and delegates the entire authz ladder (site scope,
// org resolution, feature flag, connection state, rate budget, audit) to
// executeM365ReadAction — the handlers below do no authorization of their
// own beyond input shaping.
// ============================================

type M365QueryHandler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

/** Wrap handler in try-catch so DB/runtime errors return JSON instead of crashing.
 *  Local convention copied from aiToolsC2C.ts (not exported there either). */
function safeHandler(toolName: string, fn: M365QueryHandler): M365QueryHandler {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error(`[m365:${toolName}] ${err?.constructor?.name ?? 'Error'}:`, message, err);
      return JSON.stringify({ error: 'Operation failed. Check server logs for details.' });
    }
  };
}

/** Clamp a caller-supplied limit into [1, max], falling back to `fallback`
 *  when absent/non-numeric. Same shape as aiToolsC2C.ts's clampLimit. */
function clampLimit(value: unknown, fallback: number, max: number): number {
  return Math.min(Math.max(1, Number(value) || fallback), max);
}

function inputOrgId(input: Record<string, unknown>): string | undefined {
  return typeof input.orgId === 'string' ? input.orgId : undefined;
}

/** Shared result -> wire-format serialization for every m365_query_* tool. */
function serializeM365Result(result: M365ReadActionServiceResult): string {
  if (!result.ok) {
    return JSON.stringify({ error: result.message, code: result.code, retryAfterSeconds: result.retryAfterSeconds });
  }
  if (result.kind === 'collection') {
    return JSON.stringify({
      items: result.items,
      truncated: result.truncated,
      ...(result.truncated ? { note: 'Result capped; narrow the query for more.' } : {}),
    });
  }
  return JSON.stringify({ resource: result.resource });
}

/** Validate + execute one M365ReadAction and serialize the result. Returns
 *  the generic invalid-parameters message when `action` fails the shared
 *  discriminated-union schema (e.g. a required field like groupId/siteId is
 *  missing for the requested mode). */
async function runM365ReadAction(
  action: unknown,
  auth: AuthContext,
  input: Record<string, unknown>,
): Promise<string> {
  const parsed = m365ReadActionSchema.safeParse(action);
  if (!parsed.success) return JSON.stringify({ error: 'Invalid parameters for this Microsoft 365 query.' });
  const result = await executeM365ReadAction(auth, parsed.data as M365ReadAction, inputOrgId(input));
  return serializeM365Result(result);
}

const orgIdProperty = {
  type: 'string' as const,
  description: 'Organization id; required only when the session spans multiple organizations.',
};

/** Register the 6 typed Graph read-query tools into the shared aiTools map. */
export function registerM365Tools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // 1. m365_query_users
  // ============================================
  registerTool({
    tier: 1,
    definition: {
      name: 'm365_query_users',
      description: 'Query Microsoft 365 users (list or get one). Returns at most 50 users per call. Data is read live from the customer\'s Microsoft 365 tenant.',
      input_schema: {
        type: 'object' as const,
        properties: {
          mode: { type: 'string', enum: ['list', 'get'], description: 'list to search/filter users, get to fetch one by id or UPN' },
          search: { type: 'string', description: 'Search term matched against display name / UPN (list mode)' },
          userIdOrUpn: { type: 'string', description: 'User object id or userPrincipalName (required for get mode)' },
          accountEnabled: { type: 'boolean', description: 'Filter to enabled/disabled accounts (list mode)' },
          department: { type: 'string', description: 'Filter by department (list mode)' },
          limit: { type: 'number', description: 'Max results, list mode only (default 25, max 50)' },
          orgId: orgIdProperty,
        },
        required: ['mode'],
      },
    },
    handler: safeHandler('m365_query_users', async (input, auth) => {
      const action = input.mode === 'get'
        ? { type: 'm365.user.get' as const, userIdOrUpn: String(input.userIdOrUpn ?? '') }
        : {
            type: 'm365.user.list' as const,
            ...(typeof input.search === 'string' && input.search ? { search: input.search } : {}),
            ...(typeof input.accountEnabled === 'boolean' ? { accountEnabled: input.accountEnabled } : {}),
            ...(typeof input.department === 'string' && input.department ? { department: input.department } : {}),
            pageSize: clampLimit(input.limit, 25, 50),
          };
      return runM365ReadAction(action, auth, input);
    }),
  });

  // ============================================
  // 2. m365_query_signins
  // ============================================
  registerTool({
    tier: 1,
    definition: {
      name: 'm365_query_signins',
      description: 'Query recent Microsoft 365 sign-in activity, optionally filtered to one user. Returns at most 50 sign-ins per call, covering up to the last 168 hours. Data is read live from the customer\'s Microsoft 365 tenant. Requires the tenant to have Entra ID P1/P2.',
      input_schema: {
        type: 'object' as const,
        properties: {
          userPrincipalName: { type: 'string', description: 'Filter to a specific user by UPN or object id' },
          sinceHours: { type: 'number', description: 'How many hours back to look (default 24, max 168)' },
          limit: { type: 'number', description: 'Max results (default 25, max 50)' },
          orgId: orgIdProperty,
        },
        required: [],
      },
    },
    handler: safeHandler('m365_query_signins', async (input, auth) => {
      const action = {
        type: 'm365.signins.list' as const,
        ...(typeof input.userPrincipalName === 'string' && input.userPrincipalName ? { userPrincipalName: input.userPrincipalName } : {}),
        ...(typeof input.sinceHours === 'number' ? { sinceHours: input.sinceHours } : {}),
        pageSize: clampLimit(input.limit, 25, 50),
      };
      return runM365ReadAction(action, auth, input);
    }),
  });

  // ============================================
  // 3. m365_query_intune_devices
  // ============================================
  registerTool({
    tier: 1,
    definition: {
      name: 'm365_query_intune_devices',
      description: 'Query Intune-managed devices (list or get one). Returns at most 50 devices per call. Data is read live from the customer\'s Microsoft 365 tenant.',
      input_schema: {
        type: 'object' as const,
        properties: {
          mode: { type: 'string', enum: ['list', 'get'], description: 'list to search/filter devices, get to fetch one by id' },
          // Named intuneDeviceId (not deviceId) so this Microsoft Graph/Intune
          // managed-device id — a foreign identifier, unrelated to Breeze's own
          // `devices` table — is never mistaken by the deviceArgs coverage
          // contract (aiTools.deviceArgsCoverage.contract.test.ts) for a
          // Breeze fleet device id that needs the central verifyDeviceAccess gate.
          intuneDeviceId: { type: 'string', description: 'Intune managed device id (required for get mode)' },
          complianceState: { type: 'string', enum: ['compliant', 'noncompliant', 'inGracePeriod', 'unknown'], description: 'Filter by compliance state (list mode)' },
          operatingSystem: { type: 'string', enum: ['Windows', 'macOS', 'iOS', 'Android', 'Linux'], description: 'Filter by OS (list mode)' },
          limit: { type: 'number', description: 'Max results, list mode only (default 25, max 50)' },
          orgId: orgIdProperty,
        },
        required: ['mode'],
      },
    },
    handler: safeHandler('m365_query_intune_devices', async (input, auth) => {
      const action = input.mode === 'get'
        ? { type: 'm365.intune.device.get' as const, deviceId: String(input.intuneDeviceId ?? '') }
        : {
            type: 'm365.intune.device.list' as const,
            ...(typeof input.complianceState === 'string' ? { complianceState: input.complianceState as 'compliant' | 'noncompliant' | 'inGracePeriod' | 'unknown' } : {}),
            ...(typeof input.operatingSystem === 'string' ? { operatingSystem: input.operatingSystem as 'Windows' | 'macOS' | 'iOS' | 'Android' | 'Linux' } : {}),
            pageSize: clampLimit(input.limit, 25, 50),
          };
      return runM365ReadAction(action, auth, input);
    }),
  });

  // ============================================
  // 4. m365_query_groups
  // ============================================
  registerTool({
    tier: 1,
    definition: {
      name: 'm365_query_groups',
      description: 'Query Microsoft 365 groups (list, get one, or list a group\'s members). Returns at most 50 groups or 100 members per call. Data is read live from the customer\'s Microsoft 365 tenant.',
      input_schema: {
        type: 'object' as const,
        properties: {
          mode: { type: 'string', enum: ['list', 'get', 'members'], description: 'list to search groups, get to fetch one by id, members to list a group\'s members' },
          groupId: { type: 'string', description: 'Group object id (required for get and members modes)' },
          search: { type: 'string', description: 'Search term matched against display name (list mode)' },
          limit: { type: 'number', description: 'Max results (default 25, max 50 for list, max 100 for members)' },
          orgId: orgIdProperty,
        },
        required: ['mode'],
      },
    },
    handler: safeHandler('m365_query_groups', async (input, auth) => {
      const action = input.mode === 'get'
        ? { type: 'm365.group.get' as const, groupId: String(input.groupId ?? '') }
        : input.mode === 'members'
        ? { type: 'm365.group.members.list' as const, groupId: String(input.groupId ?? ''), pageSize: clampLimit(input.limit, 25, 100) }
        : {
            type: 'm365.group.list' as const,
            ...(typeof input.search === 'string' && input.search ? { search: input.search } : {}),
            pageSize: clampLimit(input.limit, 25, 50),
          };
      return runM365ReadAction(action, auth, input);
    }),
  });

  // ============================================
  // 5. m365_query_org
  // ============================================
  registerTool({
    tier: 1,
    definition: {
      name: 'm365_query_org',
      description: 'Get the Microsoft 365 tenant\'s organization profile or its license/SKU inventory. Each call returns a single organization record or the full SKU list (no client-settable limit). Data is read live from the customer\'s Microsoft 365 tenant.',
      input_schema: {
        type: 'object' as const,
        properties: {
          include: { type: 'string', enum: ['profile', 'licenses'], description: 'profile for the organization record, licenses for assigned/consumed SKUs' },
          orgId: orgIdProperty,
        },
        required: ['include'],
      },
    },
    handler: safeHandler('m365_query_org', async (input, auth) => {
      const action = input.include === 'licenses'
        ? { type: 'm365.org.skus.list' as const }
        : { type: 'm365.org.get' as const };
      return runM365ReadAction(action, auth, input);
    }),
  });

  // ============================================
  // 6. m365_query_sites
  // ============================================
  registerTool({
    tier: 1,
    definition: {
      name: 'm365_query_sites',
      description: 'Query SharePoint sites (search or get one). List mode returns a single page of results with no client-settable limit. Data is read live from the customer\'s Microsoft 365 tenant.',
      input_schema: {
        type: 'object' as const,
        properties: {
          mode: { type: 'string', enum: ['list', 'get'], description: 'list to search sites by keyword, get to fetch one by site id' },
          search: { type: 'string', description: 'Search term (required for list mode)' },
          siteId: { type: 'string', description: 'Graph composite site id, e.g. "contoso.sharepoint.com,<siteCollectionId>,<siteId>" (required for get mode)' },
          orgId: orgIdProperty,
        },
        required: ['mode'],
      },
    },
    handler: safeHandler('m365_query_sites', async (input, auth) => {
      const action = input.mode === 'get'
        ? { type: 'm365.site.get' as const, siteId: String(input.siteId ?? '') }
        : { type: 'm365.sites.list' as const, search: String(input.search ?? '') };
      return runM365ReadAction(action, auth, input);
    }),
  });
}

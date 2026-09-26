/**
 * Topology M4-D1 (#6000): the ONE authorization gate every topology AI tool
 * call passes before its handler runs, whatever the transport.
 *
 * Topology tools are registered globally (domain `network`), but invocation
 * requires a SERVER-OWNED, site-pinned context. Nothing the model or client
 * sends can create or widen that context:
 *
 *   - chat: the caller names only its active session id (from the in-memory
 *     `ActiveSession`, itself built from the ai_sessions row); the pinned site
 *     is re-read from `ai_sessions.topology_site_id` on EVERY call under the
 *     caller's own RLS context, owner-bound (the row's user must be the
 *     caller) and required to be an active `type = 'topology'` session.
 *   - MCP: there is no session anchor, so the equivalent confinement is the
 *     API key's own site restriction — exactly one allowed site. An
 *     unrestricted (org-wide) or multi-site key is refused.
 *   - everything else (agent runs, script builder, direct callers): refused.
 *     Unbound and multi-site contexts are rejected initially (M4-D1).
 *
 * Then, in order: the tool's `site_id` must equal the pinned site (checked
 * before any site lookup, so a foreign id reveals nothing); the caller's live
 * permissions must pass `requireTopologySiteAccess(..., 'read')` (topology:read
 * + devices:read, org and site ceilings); the site must still belong to the
 * session's org; and topology AI must be available for that org — the
 * `materialization` and `ai` flags plus the server/provider/org AI policy
 * (M4-D4). Every refusal is a fixed, typed message; none echoes input.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import { aiSessions } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { getEffectiveAiBudget } from '../effectiveSettings';
import { resolveLlmConfigForOrg } from '../llm/llmConfigResolver';
import { getUserPermissions } from '../permissions';
import { requireTopologySiteAccess, TopologyError, type TopologyRequestContext } from './access';
import { loadTopologyFlags, type TopologyFlags } from './flags';

/** Every topology tool — the five M4 reads plus the W04 (M3-D12) reads. */
export const TOPOLOGY_AI_TOOL_NAMES = [
  'get_topology',
  'get_link_evidence',
  'get_link_health',
  'get_recent_network_changes',
  'get_diagnostic_run',
  'get_interface_history',
  'get_topology_impact',
  'get_topology_monitoring_status',
] as const;
export type TopologyAiToolName = (typeof TOPOLOGY_AI_TOOL_NAMES)[number];

const TOOL_NAME_SET: ReadonlySet<string> = new Set(TOPOLOGY_AI_TOOL_NAMES);
export function isTopologyAiToolName(name: string): name is TopologyAiToolName {
  return TOOL_NAME_SET.has(name);
}

/**
 * What a transport tells `executeTool` about where the call comes from. It is
 * a POINTER to server state, never the site itself: the gate resolves the site
 * from the session row or the API key's own restriction.
 */
export type TopologyToolBinding =
  | { kind: 'ai_session'; sessionId: string }
  | { kind: 'mcp_site_key' };

export type TopologyAiGateCode =
  | 'topology_session_required'
  | 'topology_site_mismatch'
  | 'topology_site_unavailable'
  | 'topology_ai_disabled';

export type TopologyAiGateResult =
  | { ok: true; ctx: TopologyRequestContext; pinnedSiteId: string; sessionId: string | null }
  | { ok: false; code: TopologyAiGateCode; error: string };

const REFUSALS: Record<TopologyAiGateCode, string> = {
  topology_session_required: 'Topology tools run only inside a site-pinned topology investigation',
  topology_site_mismatch: 'This topology investigation is pinned to a different site',
  topology_site_unavailable: 'Topology site not found or access denied',
  topology_ai_disabled: 'Topology AI is disabled for this organization',
};

const refuse = (code: TopologyAiGateCode): TopologyAiGateResult => ({ ok: false, code, error: REFUSALS[code] });

export type TopologyAiReadiness = {
  /** A usable model provider is configured for the org (server/provider policy). */
  provider: boolean;
  /** The org's (or its partner's) AI policy has AI features enabled. */
  orgPolicy: boolean;
};

/**
 * M4-D4: AI readiness is server/provider/org policy — never an agent
 * capability bit. Fails closed on any read error.
 */
export async function loadTopologyAiReadiness(orgId: string): Promise<TopologyAiReadiness> {
  const [provider, orgPolicy] = await Promise.all([
    resolveLlmConfigForOrg(orgId).then((resolved) => resolved.source !== 'unavailable', () => false),
    withSystemDbAccessContext(() => getEffectiveAiBudget(orgId)).then((budget) => budget.enabled === true, () => false),
  ]);
  return { provider, orgPolicy };
}

/** The topology AI capability: both flags AND the full readiness policy. */
export function topologyAiAvailable(flags: Pick<TopologyFlags, 'materialization' | 'ai'>, readiness: TopologyAiReadiness): boolean {
  return flags.materialization && flags.ai && readiness.provider && readiness.orgPolicy;
}

/**
 * Alias scope for host identities (M4 Task 2): one topology session is one
 * investigation, so its tool results and evidence snapshot share aliases; a
 * call without a session gets a request-local scope.
 */
export function topologyAiAliasScope(sessionId: string | null): string {
  return sessionId ? `session:${sessionId}` : `request:${randomUUID()}`;
}

/** The pinned session row, read under the caller's own RLS context and owner-bound. */
async function loadSessionPin(auth: AuthContext, sessionId: string): Promise<{ orgId: string; siteId: string } | null> {
  const conditions = [eq(aiSessions.id, sessionId), eq(aiSessions.userId, auth.user.id)];
  const orgCondition = auth.orgCondition(aiSessions.orgId);
  if (orgCondition) conditions.push(orgCondition);
  const [row] = await db
    .select({ orgId: aiSessions.orgId, siteId: aiSessions.topologySiteId, type: aiSessions.type, status: aiSessions.status })
    .from(aiSessions)
    .where(and(...conditions))
    .limit(1);
  if (!row || row.type !== 'topology' || row.status !== 'active' || !row.siteId) return null;
  return { orgId: row.orgId, siteId: row.siteId };
}

function mcpPinnedSite(auth: AuthContext): string | null {
  const allowed = auth.allowedSiteIds;
  if (!Array.isArray(allowed)) return null;
  const unique = [...new Set(allowed)];
  return unique.length === 1 ? unique[0]! : null;
}

/**
 * Authorize one topology tool call. `input.site_id` is the tool's own argument;
 * it must match the pinned site exactly.
 */
export async function authorizeTopologyAiToolCall(
  input: Record<string, unknown>,
  auth: AuthContext,
  binding: TopologyToolBinding | undefined,
): Promise<TopologyAiGateResult> {
  if (!binding) return refuse('topology_session_required');

  let pinnedSiteId: string;
  let sessionOrgId: string | null = null;
  let sessionId: string | null = null;
  if (binding.kind === 'ai_session') {
    const pin = await loadSessionPin(auth, binding.sessionId);
    if (!pin) return refuse('topology_session_required');
    pinnedSiteId = pin.siteId;
    sessionOrgId = pin.orgId;
    sessionId = binding.sessionId;
  } else {
    const site = mcpPinnedSite(auth);
    if (!site) return refuse('topology_session_required');
    pinnedSiteId = site;
  }

  // Compared BEFORE any lookup of the requested site: a foreign id is refused
  // identically whether or not it exists.
  if (typeof input.site_id !== 'string' || input.site_id.toLowerCase() !== pinnedSiteId.toLowerCase()) {
    return refuse('topology_site_mismatch');
  }

  const permissions = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId ?? undefined,
    orgId: auth.orgId ?? undefined,
    scope: auth.scope,
  });
  if (!permissions) return refuse('topology_site_unavailable');

  let ctx: TopologyRequestContext;
  try {
    ctx = await requireTopologySiteAccess(auth, permissions, pinnedSiteId, 'read');
  } catch (error) {
    if (error instanceof TopologyError) return refuse('topology_site_unavailable');
    throw error;
  }
  if (sessionOrgId !== null && ctx.scope.orgId !== sessionOrgId) return refuse('topology_site_unavailable');

  const [flags, readiness] = await Promise.all([loadTopologyFlags(ctx), loadTopologyAiReadiness(ctx.scope.orgId)]);
  if (!topologyAiAvailable(flags, readiness)) return refuse('topology_ai_disabled');

  return { ok: true, ctx, pinnedSiteId, sessionId };
}

export class TopologyAiSessionError extends Error {
  constructor(
    public readonly code: Exclude<TopologyAiGateCode, 'topology_session_required' | 'topology_site_mismatch'>,
    public readonly status: 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'TopologyAiSessionError';
  }
}

/**
 * M4-D2: authorize the site a NEW topology session will be pinned to — the
 * same read floor and AI availability every later tool call re-checks. The
 * returned context's org (the SITE's stored org) is the session org.
 */
export async function authorizeTopologySessionSite(auth: AuthContext, siteId: string): Promise<TopologyRequestContext> {
  const permissions = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId ?? undefined,
    orgId: auth.orgId ?? undefined,
    scope: auth.scope,
  });
  if (!permissions) throw new TopologyAiSessionError('topology_site_unavailable', 404, REFUSALS.topology_site_unavailable);
  let ctx: TopologyRequestContext;
  try {
    ctx = await requireTopologySiteAccess(auth, permissions, siteId, 'read');
  } catch (error) {
    if (error instanceof TopologyError) throw new TopologyAiSessionError('topology_site_unavailable', 404, REFUSALS.topology_site_unavailable);
    throw error;
  }
  const [flags, readiness] = await Promise.all([loadTopologyFlags(ctx), loadTopologyAiReadiness(ctx.scope.orgId)]);
  if (!topologyAiAvailable(flags, readiness)) throw new TopologyAiSessionError('topology_ai_disabled', 403, REFUSALS.topology_ai_disabled);
  return ctx;
}

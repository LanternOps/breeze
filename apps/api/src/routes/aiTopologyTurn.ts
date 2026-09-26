/**
 * Topology M4 Task 3 (#6000): the route-side half of an investigation turn on
 * the EXISTING `POST /ai/sessions/:id/messages` endpoint. Runs after the
 * ordinary AI preflight (session, provider policy, rate limits, monetary
 * budget) for a `type = 'topology'` session:
 *
 *   - re-authorizes the session's PINNED site under the caller's live
 *     permissions and AI availability, and requires it to still belong to the
 *     session org (the client page context is never authority);
 *   - reads the selection stored server-side at session creation;
 *   - prepares the investigation (quotas, sanitized evidence, cache) and maps
 *     every refusal to a fixed status/code — never provider or model text.
 */
import type { TopologyAiExplanation } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import { createBreezeMcpServer, type PostToolUseCallback, type PreToolUseCallback } from '../services/aiAgentSdkTools';
import type { ActiveSession } from '../services/streamingSessionManager';
import { TOPOLOGY_INVESTIGATION_TOOL_NAMES } from '../services/topology/aiInvestigation';
import { TopologyError } from '../services/topology/access';
import { TopologyAiEvidenceError, TopologyAiScopeChangedError } from '../services/topology/aiEvidence';
import { prepareTopologyInvestigation, topologySelectionFromSession, type PreparedTopologyInvestigation } from '../services/topology/aiInvestigation';
import { TopologyAiLimitError } from '../services/topology/aiLimits';
import { authorizeTopologySessionSite, TopologyAiSessionError } from '../services/topology/aiToolGate';
import { GraphReadError } from '../services/topology/graphCursor';

export type TopologyTurnSession = { id: string; orgId: string; type: string; topologySiteId: string | null; contextSnapshot: unknown };
export type TopologyTurnRefusal = { ok: false; status: 403 | 404 | 409 | 429 | 503; body: { error: string; code: string } };
export type TopologyTurnPrepared = { ok: true; prepared: PreparedTopologyInvestigation };

const refusal = (status: TopologyTurnRefusal['status'], code: string, error: string): TopologyTurnRefusal => ({ ok: false, status, body: { error, code } });

export async function prepareTopologyTurn(
  auth: AuthContext,
  session: TopologyTurnSession,
  question: string,
  providerRevision: string,
): Promise<TopologyTurnRefusal | TopologyTurnPrepared> {
  if (!session.topologySiteId) return refusal(404, 'topology_session_required', 'Session not found');
  let ctx;
  try {
    ctx = await authorizeTopologySessionSite(auth, session.topologySiteId);
  } catch (error) {
    if (error instanceof TopologyAiSessionError) return refusal(error.status, error.code, error.message);
    throw error;
  }
  if (ctx.scope.orgId !== session.orgId) return refusal(404, 'topology_site_unavailable', 'Topology site not found or access denied');
  const selection = topologySelectionFromSession(session.contextSnapshot, session.topologySiteId);
  if (!selection) return refusal(409, 'investigation_scope_changed', 'The investigation selection is unavailable; start a new investigation');
  try {
    return { ok: true, prepared: await prepareTopologyInvestigation(ctx, selection, question, session.id, { providerRevision }) };
  } catch (error) {
    if (error instanceof TopologyAiLimitError) return refusal(error.status, error.code, error.message);
    if (error instanceof TopologyAiScopeChangedError) return refusal(409, error.code, error.message);
    if (error instanceof TopologyAiEvidenceError) return refusal(409, error.code, error.message);
    if (error instanceof TopologyError) return refusal(404, 'topology_site_unavailable', 'Topology site not found or access denied');
    if (error instanceof GraphReadError) {
      const status = error.status === 400 || error.status === 409 ? 409 : error.status === 403 ? 403 : error.status === 503 ? 503 : 404;
      return refusal(status, error.code, error.message);
    }
    throw error;
  }
}

/** The SSE event sequence for a re-authorized cached answer (no provider call). */
export function cachedTopologyEvents(explanation: TopologyAiExplanation) {
  return [
    { type: 'topology_progress' as const, phase: 'validating' as const },
    { type: 'topology_explanation' as const, explanation },
    { type: 'done' as const },
  ];
}

/**
 * The SDK MCP server for a topology turn: ONLY the topology tool definitions
 * are registered (not merely allow-listed), so the other ~200 definitions
 * never ride along on the model's input and cannot be offered at all. The
 * pre-tool gate still re-checks the allowlist, read budget and live scope.
 */
export function topologyMcpServerFactory(
  getAuth: () => AuthContext,
  onPreToolUse: PreToolUseCallback,
  onPostToolUse: PostToolUseCallback,
  getSession: () => ActiveSession,
) {
  return {
    server: createBreezeMcpServer(getAuth, onPreToolUse, onPostToolUse, getSession, [], { onlyTools: new Set(TOPOLOGY_INVESTIGATION_TOOL_NAMES) }),
    name: 'breeze',
  };
}

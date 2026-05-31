import type { Context, Next } from 'hono';

/**
 * requireAgentRole rejects requests authenticated with a non-agent credential
 * (e.g. the watchdog token). Apply to telemetry/state-ingest routes that only
 * the main agent should write: the watchdog's least privilege is monitoring +
 * heartbeat, not fleet telemetry (inventory, sessions, state, elevation).
 *
 * Runs after agentAuthMiddleware, which sets `agent` on the context (the
 * `agent: AgentAuthContext` ContextVariableMap augmentation lives in
 * middleware/agentAuth.ts). This module is intentionally dependency-free (only
 * hono types) so route modules can import it without pulling the agent-auth /
 * services dependency graph into their unit-test mocks.
 */
export async function requireAgentRole(c: Context, next: Next) {
  const agent = c.get('agent');
  if (!agent || agent.role !== 'agent') {
    return c.json({ error: 'This endpoint requires the agent credential' }, 403);
  }
  return next();
}

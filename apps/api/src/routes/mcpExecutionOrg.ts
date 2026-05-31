import type { AuthContext } from '../middleware/auth';

/**
 * Minimal shape this resolver needs from the MCP principal (X-API-Key or OAuth
 * bearer context). Kept narrow so the resolver has no runtime dependencies and
 * stays unit-testable in isolation. `McpApiKeyContext` in mcpServer.ts is
 * structurally compatible (it carries `orgId`).
 */
export interface McpExecutionPrincipal {
  orgId: string | null;
}

/**
 * Resolve the org id used to ATTRIBUTE an MCP tool execution — the tenant the
 * tool-execution ledger (ai_sessions / ai_tool_executions) and the per-tool
 * audit_logs event are written under.
 *
 * Tenant-isolation contract: a client-supplied `toolInput.orgId` must NEVER be
 * honored without an access check, because the ledger opens an RLS context for
 * the resolved org and the audit row is written under the system (RLS-bypassed)
 * context. Priority:
 *   1. Org-scoped X-API-Key  → pinned to the key's org (input ignored).
 *   2. Org-scoped principal  → pinned to `auth.orgId` (input ignored).
 *   3. Partner-scoped principal → a supplied `orgId` is honored ONLY if it is
 *      within the caller's accessible set (`auth.canAccessOrg`); otherwise it is
 *      discarded and we fall back to the caller's first accessible org.
 *   4. System scope (`auth.accessibleOrgIds === null`) → `auth.canAccessOrg`
 *      returns true for every org, so a supplied `orgId` is honored (a system
 *      caller may act on any tenant); with no input there is no sensible default
 *      and we return null. (The MCP auth path does not mint system scope today;
 *      this keeps the helper correct should it ever be reused.)
 *
 * Follows the same `canAccessOrg`-gating principle as `resolveWritableToolOrgId`
 * (services/aiTools.ts).
 */
export function resolveMcpExecutionOrgId(
  apiKey: McpExecutionPrincipal | undefined,
  auth: AuthContext,
  toolInput: Record<string, unknown>,
): string | null {
  // 1. Org-scoped X-API-Key: pinned to the key's org; client input is ignored.
  if (apiKey?.orgId) return apiKey.orgId;
  // 2. Org-scoped principal: pinned to auth.orgId; client input is ignored.
  if (auth.orgId) return auth.orgId;
  // 3. Partner-scoped principal: honor a client-supplied orgId ONLY if it is
  //    within the caller's accessible set — never trust raw input. Otherwise
  //    discard it and fall back to the caller's first accessible org.
  const inputOrgId = typeof toolInput.orgId === 'string' ? toolInput.orgId : null;
  if (inputOrgId && auth.canAccessOrg(inputOrgId)) return inputOrgId;
  return auth.accessibleOrgIds?.[0] ?? null;
}

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

// ============================================================================
// Authoritative device-org resolution (MCP-OAUTH-05)
// ============================================================================

/**
 * Thrown when a device-targeted MCP tool's execution org cannot be resolved
 * unambiguously and safely: devices span more than one org, an explicit
 * `toolInput.orgId` disagrees with the devices' real org, a targeted device
 * fails the org/site access gate, or an org-pinned caller reaches a device
 * outside its org. The MCP dispatch maps this to a generic JSON-RPC
 * `invalid_params` error — the mixed/ambiguous case must fail closed BEFORE any
 * ledger, audit, or handler mutation.
 */
export class McpExecutionOrgError extends Error {
  constructor(message = 'Ambiguous or unauthorized MCP execution organization') {
    super(message);
    this.name = 'McpExecutionOrgError';
  }
}

type MaybePromise<T> = T | Promise<T>;

/** Resolution of a single device to its authoritative (access-gated) org. */
export type McpDeviceOrgResolution = { orgId: string } | { error: string };

export interface ResolveMcpExecutionContextArgs {
  auth: AuthContext;
  apiKey: McpExecutionPrincipal | null | undefined;
  toolName: string;
  toolInput: Record<string, unknown>;
  /**
   * Seams — default to the live tool registry + `verifyDeviceAccess` gate, but
   * injectable so the resolver stays a pure unit under test (no DB), matching
   * the style of `resolveMcpExecutionOrgId`.
   */
  deviceArgsForTool?: (toolName: string) => MaybePromise<readonly string[] | undefined>;
  resolveDeviceOrg?: (deviceId: string, auth: AuthContext) => MaybePromise<McpDeviceOrgResolution>;
}

// Live seams use dynamic import so merely importing this module (e.g. the unit
// test) does not eagerly pull in the whole aiTools registry / DB layer.
async function liveDeviceArgs(toolName: string): Promise<readonly string[] | undefined> {
  const { aiTools } = await import('../services/aiTools');
  return aiTools.get(toolName)?.deviceArgs;
}

async function liveResolveDeviceOrg(
  deviceId: string,
  auth: AuthContext,
): Promise<McpDeviceOrgResolution> {
  const { verifyDeviceAccess } = await import('../services/aiTools');
  const access = await verifyDeviceAccess(deviceId, auth);
  if ('error' in access) return { error: access.error };
  return { orgId: access.device.orgId };
}

/**
 * Collect every supplied device id a tool declares in `deviceArgs` (direct
 * string form + array form). Returns `null` (fail closed) when a declared arg is
 * PRESENT but malformed — mirrors `enforceDeviceArgs`, so we never trust an
 * upstream validator we cannot see. An empty result means "no devices targeted".
 */
function collectSuppliedDeviceIds(
  deviceArgs: readonly string[] | undefined,
  input: Record<string, unknown>,
): string[] | null {
  if (!deviceArgs || deviceArgs.length === 0) return [];
  const ids: string[] = [];
  for (const argName of deviceArgs) {
    const raw = input[argName];
    if (raw == null) continue; // optional arg not supplied — nothing to gate
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (typeof value !== 'string' || value.length === 0) return null; // malformed
      ids.push(value);
    }
  }
  return ids;
}

/**
 * Resolve the AUTHORITATIVE org an MCP tool executes under — the tenant the
 * tool-execution ledger, the per-tool audit event, and downstream execution are
 * ALL attributed to. Must be called BEFORE ledger creation.
 *
 * For device-targeted tools (`deviceArgs` present + at least one id supplied)
 * the org is resolved from the TARGETED DEVICES via the same org+site access
 * gate downstream execution uses — never from `accessibleOrgIds[0]`. This closes
 * MCP-OAUTH-05, where a partner caller omitting `orgId` had the action execute
 * in device Org B while ledger + audit were written under Org A.
 *
 * Rejects (throws {@link McpExecutionOrgError}) when: the targeted devices span
 * more than one org; an explicit `toolInput.orgId` differs from the devices'
 * org; any device fails the access gate; or an org-pinned api key / bearer
 * targets a device outside its org. Non-device tools keep the existing
 * attribution-only behavior (`resolveMcpExecutionOrgId`), unchanged by design.
 */
export async function resolveMcpExecutionContext(
  args: ResolveMcpExecutionContextArgs,
): Promise<{ orgId: string | null }> {
  const { auth, apiKey, toolName, toolInput } = args;
  const deviceArgsForTool = args.deviceArgsForTool ?? liveDeviceArgs;
  const resolveDeviceOrg = args.resolveDeviceOrg ?? liveResolveDeviceOrg;

  const deviceArgs = await deviceArgsForTool(toolName);
  const deviceIds = collectSuppliedDeviceIds(deviceArgs, toolInput);

  // A declared device arg was present but malformed — fail closed rather than
  // silently attribute to a fallback org.
  if (deviceIds === null) {
    throw new McpExecutionOrgError('Invalid device argument');
  }

  // Non-device tool, or a device tool with no device id supplied: attribution
  // only — behavior is unchanged from the pre-MCP-OAUTH-05 resolver.
  if (deviceIds.length === 0) {
    return { orgId: resolveMcpExecutionOrgId(apiKey ?? undefined, auth, toolInput) };
  }

  // Device-targeted tool: resolve each device's true org through the org+site
  // access gate. Any denial rejects before any mutation.
  const deviceOrgIds = new Set<string>();
  for (const deviceId of deviceIds) {
    const resolution = await resolveDeviceOrg(deviceId, auth);
    if ('error' in resolution) {
      throw new McpExecutionOrgError('Device not found or access denied');
    }
    deviceOrgIds.add(resolution.orgId);
  }

  // Exactly one distinct org — a mixed-org device array is rejected here, BEFORE
  // ledger creation / handler execution.
  if (deviceOrgIds.size !== 1) {
    throw new McpExecutionOrgError('Devices span more than one organization');
  }
  const deviceOrgId = deviceOrgIds.values().next().value as string;

  // An explicit orgId must agree with the devices' real org.
  const inputOrgId = typeof toolInput.orgId === 'string' ? toolInput.orgId : null;
  if (inputOrgId && inputOrgId !== deviceOrgId) {
    throw new McpExecutionOrgError('Supplied orgId does not match the target device organization');
  }

  // Org-scoped api key / bearer stays PINNED: a device outside that org is
  // rejected, never silently re-attributed.
  const pinnedOrgId = apiKey?.orgId ?? auth.orgId ?? null;
  if (pinnedOrgId && pinnedOrgId !== deviceOrgId) {
    throw new McpExecutionOrgError('Target device is outside the pinned organization');
  }

  return { orgId: deviceOrgId };
}

/**
 * AI MCP Tool Registry — Hub File
 *
 * Thin hub: shared types, helper functions, and registration of all domain tool modules.
 * Tool implementations live in per-domain aiTools*.ts files.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { db } from '../db';
import { devices, alerts } from '../db/schema';
import { eq, and, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import { validateToolInput } from './aiToolSchemas';
import {
  extensionContributionRegistry,
  type ExtensionContributionRegistry,
  type RegistryAiTool,
} from '../extensions/contributionRegistry';
import {
  createExtensionStateStore,
  type ExtensionStateStore,
} from '../extensions/stateStore';
// Type-only, deliberately: `toolExecutionContext.ts` names a type from
// `actionIntents/runScriptSnapshot.ts`, and sibling `actionIntents/*` modules
// (intentService, revalidateRelease) already import back into this hub. Keeping
// the edge type-only means it is erased at build time and no import cycle can
// form.
import type { ToolExecutionContext } from './toolExecutionContext';

// Pre-existing domain modules
import { registerAgentLogTools } from './aiToolsAgentLogs';
import { registerVulnerabilityTools } from './aiToolsVulnerability';
import { registerBackupTools } from './aiToolsBackup';
import { registerBackupVmTools } from './aiToolsBackupVm';
import { registerConfigPolicyTools } from './aiToolsConfigPolicy';
import { registerEventLogTools } from './aiToolsEventLogs';
import { registerAnalyticsTools } from './aiToolsAnalytics';
import { registerFleetTools } from './aiToolsFleet';
import { registerPolicyPrereqTools } from './aiToolsPolicyPrereqs';
import { registerIntegrationTools } from './aiToolsIntegrations';
import { registerMonitoringTools } from './aiToolsMonitoring';
import { registerMssqlTools } from './aiToolsMssql';
import { registerHypervTools } from './aiToolsHyperv';
import { registerVaultTools } from './aiToolsVault';
import { registerC2CTools } from './aiToolsC2C';
import { registerSLABackupTools } from './aiToolsSLABackup';
import { registerDRTools } from './aiToolsDR';

// New domain modules
import { registerDeviceTools } from './aiToolsDevice';
import { registerNetworkTools } from './aiToolsNetwork';
import { registerSentinelOneTools } from './aiToolsSentinelOne';
import { registerHuntressTools } from './aiToolsHuntress';
import { registerSecurityTools } from './aiToolsSecurity';
import { registerDnsTools } from './aiToolsDns';
import { registerPeripheralTools } from './aiToolsPeripherals';
import { registerBrowserTools } from './aiToolsBrowser';
import { registerScriptTools } from './aiToolsScripts';
import { registerCisBenchmarkTools } from './aiToolsCisBenchmark';
import { registerComplianceTools } from './aiToolsCompliance';
import { registerPlaybookTools } from './aiToolsPlaybooks';
import { registerAlertTools } from './aiToolsAlerts';
import { registerIncidentTools } from './aiToolsIncident';
import { registerPerformanceTools } from './aiToolsPerformance';
import { registerUserRiskTools } from './aiToolsUserRisk';
import { registerFleetStatusTools } from './aiToolsFleetStatus';
import { registerDeleteTenantTool } from './deleteTenant';
import { registerFilesystemTools } from './aiToolsFilesystem';
import { registerAuditTools } from './aiToolsAudit';
import { registerDocsTools } from './aiToolsDocs';
import { registerRemoteTools } from './aiToolsRemote';
import { registerAgentMgmtTools } from './aiToolsAgentMgmt';
// AI-agent GOVERNANCE (P2-5, #4192) — distinct from aiToolsAgentMgmt above,
// which manages the Go endpoint agent. See that module's header.
import { registerAiAgentGovernanceTools } from './aiToolsAiAgentGovernance';
import { registerUITools } from './aiToolsUI';
import { registerTicketingTools } from './aiToolsTicketing';
import { registerCatalogTools } from './aiToolsCatalog';
import { registerBillingTools } from './aiToolsBilling';
import { registerContractTools } from './aiToolsContracts';
import { registerQuoteTools } from './aiToolsQuotes';
import { registerOrgTools } from './aiToolsOrgs';
import { registerPamTools } from './aiToolsPam';
// M365 helpdesk tools are session-aware (handler signature includes a sessionId)
// so they are NOT registered in the `aiTools` execution registry — they run via
// makeSessionAwareHandler in the SDK server. Their tiers still must be visible to
// getToolTier so checkGuardrails can gate them; import the tier tables for fallback.
import { m365ToolTiers, registerM365Tools } from './aiToolsM365';
import { googleToolTiers } from './aiToolsGoogle';

// ============================================
// Shared Types
// ============================================

export type AiToolTier = 1 | 2 | 3 | 4;

export interface AiTool {
  definition: Anthropic.Tool;
  tier: AiToolTier;
  /**
   * `context` carries material a release path already verified against the
   * approval's pinned effect digest (see `toolExecutionContext.ts`). It is
   * OPTIONAL and trailing, so every handler declared `(input, auth)` — which
   * is nearly all of them — is unaffected; only a handler that has a re-query
   * worth skipping declares it,
   * and it must behave identically when it is absent (direct chat, MCP and
   * script-builder callers never supply one).
   *
   * TRAP — WRAPPERS SILENTLY TRUNCATE IT. A handler produced by a wrapper that
   * returns `async (input, auth) => …` drops the third argument with NO compile
   * error, because a two-parameter function is always assignable here. The
   * `safeHandler` wrappers in `aiToolsBackupVm.ts`, `aiToolsPolicyPrereqs.ts`,
   * `aiToolsC2C.ts` and `aiToolsConfigPolicy.ts` are all shaped that way. If a
   * tool registered through one of those ever needs the context, the WRAPPER
   * must accept and forward a third argument too — widening the inner handler
   * alone will read `undefined` forever. (No current consumer is wrapped:
   * `run_script` is a bare inline arrow in `aiToolsScripts.ts`.)
   */
  handler: (
    input: Record<string, unknown>,
    auth: AuthContext,
    context?: ToolExecutionContext,
  ) => Promise<string>;
  /**
   * Names of the tool's input properties that carry a device id (each a string
   * or string[]). When set, the central dispatch gates every supplied id
   * through the org+site `verifyDeviceAccess` BEFORE the handler runs — so a
   * tool author can no longer forget the per-device tenant check (the root
   * cause of the cross-org incident-tool bug). Tools that resolve the device
   * indirectly (via a VM/snapshot/alert record) or return a device LIST are
   * NOT covered by this and must still narrow results themselves.
   */
  deviceArgs?: readonly string[];
}

// ============================================
// Shared Helpers (exported for domain modules)
// ============================================

export async function verifyDeviceAccess(
  deviceId: string,
  auth: AuthContext,
  requireOnline = false
): Promise<{ device: typeof devices.$inferSelect } | { error: string }> {
  // Helper device lock (finding A, defense-in-depth): a Helper context may only
  // ever resolve its own device. Return before any DB access.
  if (auth.helperDeviceId && deviceId !== auth.helperDeviceId) {
    return { error: 'Device not found or access denied' };
  }
  // Device-exact axis (device-bound agent runs): tighter than canAccessSite
  // below, which admits every sibling device in the same site.
  if (auth.allowedDeviceIds && !auth.allowedDeviceIds.includes(deviceId)) {
    return { error: 'Device not found or access denied' };
  }
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) conditions.push(orgCond);
  const [device] = await db.select().from(devices).where(and(...conditions)).limit(1);
  if (!device) return { error: 'Device not found or access denied' };
  // Site axis: deny devices outside the caller's site allowlist (no-op when unrestricted).
  if (auth.canAccessSite && !auth.canAccessSite(device.siteId)) {
    return { error: 'Device not found or access denied' };
  }
  if (requireOnline && device.status !== 'online') return { error: `Device ${device.hostname} is not online (status: ${device.status})` };
  return { device };
}

/** Decision returned by {@link enforceDeviceArgs}: allow, or deny with a reason.
 *  The caller (`executeTool`) owns serialization to the wire format. */
export type DeviceGateResult = { ok: true } | { ok: false; error: string };

/**
 * Central declarative device-access gate. For each input property a tool names
 * in `deviceArgs`, runs the org+site `verifyDeviceAccess` check on every id it
 * carries (string or string[]). Returns `{ ok: false }` on the first denial,
 * else `{ ok: true }`.
 *
 * Fail-closed: a tool with no `deviceArgs`, or an optional arg the caller did
 * not supply, is allowed (nothing to gate); but a declared arg that IS present
 * must be a non-empty string id (or array of them) — anything else is DENIED
 * rather than skipped, so the gate does not depend on an upstream validator it
 * cannot see. For a truly unrestricted caller `verifyDeviceAccess` returns the
 * row, so the gate degrades to a plain existence check. This is the structural
 * backstop that makes the per-handler check impossible to forget — see
 * `executeTool`.
 */
export async function enforceDeviceArgs(
  tool: Pick<AiTool, 'deviceArgs'>,
  input: Record<string, unknown>,
  auth: AuthContext
): Promise<DeviceGateResult> {
  if (!tool.deviceArgs || tool.deviceArgs.length === 0) return { ok: true };
  const denied: DeviceGateResult = { ok: false, error: 'Device not found or access denied' };
  for (const argName of tool.deviceArgs) {
    const raw = input[argName];
    if (raw == null) continue; // optional arg not supplied — nothing to gate
    const ids = Array.isArray(raw) ? raw : [raw];
    for (const id of ids) {
      // A declared device arg that is present must be a non-empty string.
      // Fail closed on anything else instead of trusting upstream validation.
      if (typeof id !== 'string' || id.length === 0) return denied;
      const access = await verifyDeviceAccess(id, auth);
      if ('error' in access) return { ok: false, error: access.error };
    }
  }
  return { ok: true };
}

export async function findAlertWithAccess(alertId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(alerts.id, alertId)];
  const orgCond = auth.orgCondition(alerts.orgId);
  if (orgCond) conditions.push(orgCond);
  const [alert] = await db.select().from(alerts).where(and(...conditions)).limit(1);
  return alert || null;
}

export function resolveWritableToolOrgId(
  auth: AuthContext,
  inputOrgId?: string
): { orgId?: string; error?: string } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required' };
    if (inputOrgId && inputOrgId !== auth.orgId) {
      return { error: 'Cannot access another organization' };
    }
    return { orgId: auth.orgId };
  }

  if (inputOrgId) {
    if (!auth.canAccessOrg(inputOrgId)) {
      return { error: 'Access denied to this organization' };
    }
    return { orgId: inputOrgId };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return { orgId: auth.accessibleOrgIds[0] };
  }

  return { error: 'orgId is required for this operation' };
}

// ============================================
// Tool Registry
// ============================================

// The map instance and the reserved-name predicate/registration live in
// aiToolNames.ts now (a leaf module with no domain-tool imports) — see that
// file's header for why. Re-exported below for the many domain/consumer
// modules that still import `aiTools/hasCoreAiToolName` from here.
export { aiTools, hasCoreAiToolName } from './aiToolNames';
import { aiTools, hasCoreAiToolName, registerReservedAiToolNamePredicate } from './aiToolNames';

// Register all domain modules
registerAgentLogTools(aiTools);
registerBackupTools(aiTools);
registerBackupVmTools(aiTools);
registerMssqlTools(aiTools);
registerHypervTools(aiTools);
registerVaultTools(aiTools);
registerC2CTools(aiTools);
registerSLABackupTools(aiTools);
registerDRTools(aiTools);
registerConfigPolicyTools(aiTools);
registerEventLogTools(aiTools);
registerAnalyticsTools(aiTools);
registerFleetTools(aiTools);
registerPolicyPrereqTools(aiTools);
registerIntegrationTools(aiTools);
registerMonitoringTools(aiTools);
registerDeviceTools(aiTools);
registerNetworkTools(aiTools);
registerSentinelOneTools(aiTools);
registerHuntressTools(aiTools);
registerSecurityTools(aiTools);
registerDnsTools(aiTools);
registerPeripheralTools(aiTools);
registerBrowserTools(aiTools);
registerScriptTools(aiTools);
registerCisBenchmarkTools(aiTools);
registerComplianceTools(aiTools);
registerPlaybookTools(aiTools);
registerAlertTools(aiTools);
registerTicketingTools(aiTools);
registerCatalogTools(aiTools);
registerBillingTools(aiTools);
registerContractTools(aiTools);
registerQuoteTools(aiTools);
registerOrgTools(aiTools);
registerIncidentTools(aiTools);
registerPerformanceTools(aiTools);
registerUserRiskTools(aiTools);
registerFleetStatusTools(aiTools);
registerDeleteTenantTool(aiTools);
registerFilesystemTools(aiTools);
registerAuditTools(aiTools);
registerDocsTools(aiTools);
registerRemoteTools(aiTools);
registerAgentMgmtTools(aiTools);
registerAiAgentGovernanceTools(aiTools);
registerUITools(aiTools);
registerPamTools(aiTools);
registerVulnerabilityTools(aiTools);
registerM365Tools(aiTools);

// ============================================
// Exports
// ============================================

// M365/Google tools are session-aware and never added to the `aiTools` map
// (see the comment above the `registerM365Tools` import), so their tier
// tables are registered as an additional reserved-name source. This — plus
// the map population above — is what makes hasCoreAiToolName's actual
// behavior identical to the pre-extraction version; see aiToolNames.ts's
// header and aiToolNames.test.ts.
registerReservedAiToolNamePredicate(
  (toolName) => m365ToolTiers[toolName] !== undefined || googleToolTiers[toolName] !== undefined,
);

/** The state-store surface the extension AI-tool gate needs (injectable for tests). */
export type AiToolEnabledStore = Pick<ExtensionStateStore, 'isEnabled'>;

/**
 * The shared, lazily-built store backing the extension AI-tool enable gate.
 *
 * Built once and memoized. `executeTool` resolves it as
 * `opts?.store ?? defaultExtensionEnabledStore()` INSIDE the extension branch,
 * so a core-tool call never constructs one. (It used to be a default parameter,
 * which is evaluated on every call — harmless, since construction is a bare
 * `new` around the shared `db` pool with no I/O and every later call is a memo
 * read, but pointless on the critical path of every AI tool call.) No database
 * work happens until `isEnabled` runs, which only that branch reaches.
 */
let extensionEnabledStore: AiToolEnabledStore | null = null;
function defaultExtensionEnabledStore(): AiToolEnabledStore {
  extensionEnabledStore ??= createExtensionStateStore();
  return extensionEnabledStore;
}

function resolveExtensionTool(
  toolName: string,
  registry: ExtensionContributionRegistry,
): RegistryAiTool | undefined {
  const extensionTool = registry.getAiTool(toolName);
  if (extensionTool && hasCoreAiToolName(toolName)) {
    throw new Error(`AI tool name collision with core registry: ${toolName}`);
  }
  return extensionTool;
}

export function getToolDefinitions(
  registry: ExtensionContributionRegistry = extensionContributionRegistry,
): Anthropic.Tool[] {
  const extensionDefinitions = registry.listAiTools().map((tool) => {
    if (hasCoreAiToolName(tool.definition.name)) {
      throw new Error(`AI tool name collision with core registry: ${tool.definition.name}`);
    }
    return tool.definition as Anthropic.Tool;
  });
  return [
    ...Array.from(aiTools.values(), (tool) => tool.definition),
    ...extensionDefinitions,
  ];
}

export function getToolTier(
  toolName: string,
  registry: ExtensionContributionRegistry = extensionContributionRegistry,
): AiToolTier | undefined {
  const coreTier = aiTools.get(toolName)?.tier
    ?? m365ToolTiers[toolName]
    ?? googleToolTiers[toolName];
  const extensionTool = registry.getAiTool(toolName);
  if (coreTier !== undefined && extensionTool) {
    throw new Error(`AI tool name collision with core registry: ${toolName}`);
  }
  return coreTier ?? extensionTool?.tier;
}

/**
 * All CORE (non-extension) registered tool names — the same three sources
 * `getToolTier` reads: the headless `aiTools` execution registry plus the two
 * session-aware M365/Google tier maps (those tools dispatch outside `aiTools`
 * but still have a real tier). Extension tools are per-tenant/dynamic and
 * deliberately excluded — classification contracts like the tier-3
 * supervised/four_eyes split operate on the fixed core surface.
 */
export function getAllRegisteredToolNames(): string[] {
  return [
    ...aiTools.keys(),
    ...Object.keys(m365ToolTiers),
    ...Object.keys(googleToolTiers),
  ];
}

/**
 * True iff a tool is recognized (getToolTier defined) but NOT executable by the
 * headless `executeTool` path — i.e. it only runs via the inline chat path's
 * makeSessionAwareHandler, which threads a live SSE session id to reach the
 * per-tenant M365/Google OAuth connection. Covers the M365 mutation helpdesk
 * tools (m365_disable_user, m365_reset_password) and ALL Google tools (there is
 * no registerGoogleTools into the core map). The durable release worker uses
 * this to fail such intents with `session_required` instead of `Unknown tool`.
 * Phase 2 (headless dispatch) would make these executable and flip this to false.
 */
export function requiresLiveSession(
  toolName: string,
  registry: ExtensionContributionRegistry = extensionContributionRegistry,
): boolean {
  const executableHeadless = aiTools.has(toolName) || registry.getAiTool(toolName) !== undefined;
  return !executableHeadless && getToolTier(toolName, registry) !== undefined;
}

/**
 * Helper device-scoping (security finding A, Phase 0).
 * Maps each tool the Breeze Helper may run to the input field naming its
 * target device. A tool absent from this map is org-wide and is DENIED under
 * a Helper context. Every tool in helperToolFilter's whitelists must have an
 * entry here (pinned by helperToolFilter.test.ts); mutating tools (tier>=2)
 * are additionally PAM-governed at the preToolUse gate (Phase 1).
 */
export const HELPER_TOOL_SCOPING: Record<string, 'deviceId' | 'deviceIds'> = {
  // Read-only (Phase 0 `basic` set).
  get_device_details: 'deviceId',
  analyze_metrics: 'deviceId',
  analyze_disk_usage: 'deviceId',
  get_cis_device_report: 'deviceId',
  get_security_posture: 'deviceId',
  take_screenshot: 'deviceId',
  analyze_screen: 'deviceId',
  search_logs: 'deviceIds',
  // Device-pinned safe actions (`standard`, Phase 1 governed).
  get_active_users: 'deviceId',
  get_user_experience_metrics: 'deviceId',
  manage_alerts: 'deviceId',
  manage_services: 'deviceId',
  disk_cleanup: 'deviceId',
  file_operations: 'deviceId',
  // Device-pinned destructive tools (`extended`, Phase 1 governed).
  computer_control: 'deviceId',
  execute_command: 'deviceId',
  security_scan: 'deviceId',
  s1_isolate_device: 'deviceId',
  network_discovery: 'deviceId',
  apply_cis_remediation: 'deviceId',
};

/**
 * Force a Helper tool call onto the Helper's own device, or deny it.
 * Pure — the caller (executeTool) applies the result.
 */
export function applyHelperDeviceScope(
  toolName: string,
  input: Record<string, unknown>,
  helperDeviceId: string
): { input: Record<string, unknown> } | { error: string } {
  const field = HELPER_TOOL_SCOPING[toolName];
  if (!field) {
    return { error: `Tool '${toolName}' is not available in the Helper context` };
  }
  const value = field === 'deviceIds' ? [helperDeviceId] : helperDeviceId;
  return { input: { ...input, [field]: value } };
}

/**
 * Everything `executeTool` accepts beyond the three arguments every caller
 * passes. A NAMED BAG, not trailing positionals: the members are unrelated to
 * each other, and getting them in the wrong order used to fail SILENTLY — a
 * context handed to the `registry` slot would break extension tool resolution
 * and skip the enabled-store gate with no error anywhere. Named members make
 * that same mistake a compile error.
 */
export type ExecuteToolOptions = {
  /** Extension contribution snapshot to resolve extension-contributed tools from. */
  registry?: ExtensionContributionRegistry;
  /** Durable enabled-flag store for the extension gate (injectable for tests). */
  store?: AiToolEnabledStore;
  /**
   * Pre-verified release material for THIS invocation. Supplied only by a
   * release path that has already checked the approval's pinned effect digest;
   * every other caller omits it and the handler sees `undefined`.
   */
  context?: ToolExecutionContext;
};

export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  auth: AuthContext,
  opts?: ExecuteToolOptions,
): Promise<string> {
  const registry = opts?.registry ?? extensionContributionRegistry;
  const coreTool = aiTools.get(toolName);
  const extensionTool = resolveExtensionTool(toolName, registry);
  const tool = coreTool ?? extensionTool;
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);

  // Cross-replica ENABLED gate for extension-contributed tools, mirroring the
  // HTTP gateway's per-request check (enabledGate.ts). The registry's
  // in-memory `enabled` flag is
  // REPLICA-LOCAL: an operator disabling an extension through the admin API on
  // replica A never invalidates replica B's snapshot, so B would keep running
  // the extension's handlers indefinitely. Re-reading the durable flag here —
  // uncached, exactly like the gateway — makes the shutoff fleet-wide for the
  // extension-CODE-EXECUTION surface too. A now-disabled tool is reported as
  // unresolvable, the same as a withdrawn one. Core tools never reach this
  // branch, so the core path takes no extra database read.
  if (!coreTool && extensionTool) {
    // Resolved HERE, not up front: a core-tool call must not construct a store.
    const store = opts?.store ?? defaultExtensionEnabledStore();
    const owner = registry.findAiToolOwner(toolName);
    if (!owner || !(await store.isEnabled(owner))) {
      throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // Helper device-scope gate (finding A): force the tool onto the Helper's own
  // device, or deny org-wide tools, before anything else runs.
  let effectiveInput = input;
  if (auth.helperDeviceId) {
    const scoped = applyHelperDeviceScope(toolName, input, auth.helperDeviceId);
    if ('error' in scoped) return JSON.stringify({ error: scoped.error });
    effectiveInput = scoped.input;
  }

  // Core tools retain their Zod table; extension tools carry the Ajv validator
  // compiled into the same immutable contribution snapshot as their handler.
  const validation = extensionTool
    ? extensionTool.validateInput(effectiveInput)
    : validateToolInput(toolName, effectiveInput);
  if (!validation.success) {
    return JSON.stringify({ error: validation.error });
  }

  // Structural device-tenant gate: any id named in `tool.deviceArgs` is
  // org+site-checked before the handler runs, so a tool can't reach a device
  // outside the caller's scope even if its handler forgets to check.
  const gate = await enforceDeviceArgs(tool, effectiveInput, auth);
  if (!gate.ok) return JSON.stringify({ error: gate.error });

  // Only CORE handlers receive the execution context. Extension handlers are
  // third-party code and are called with exactly two arguments — not merely
  // typed without a third one, since a handler written `(input, auth, ...rest)`
  // or reading `arguments` would otherwise capture pre-verified release
  // material the host never intended to hand out.
  if (coreTool) return coreTool.handler(effectiveInput, auth, opts?.context);
  return (tool as RegistryAiTool).handler(effectiveInput, auth);
}

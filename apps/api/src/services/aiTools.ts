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

// Pre-existing domain modules
import { registerAgentLogTools } from './aiToolsAgentLogs';
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
import { registerUITools } from './aiToolsUI';
import { registerTicketingTools } from './aiToolsTicketing';
// M365 helpdesk tools are session-aware (handler signature includes a sessionId)
// so they are NOT registered in the `aiTools` execution registry — they run via
// makeSessionAwareHandler in the SDK server. Their tiers still must be visible to
// getToolTier so checkGuardrails can gate them; import the tier table for fallback.
import { m365ToolTiers } from './aiToolsM365';

// ============================================
// Shared Types
// ============================================

export type AiToolTier = 1 | 2 | 3 | 4;

export interface AiTool {
  definition: Anthropic.Tool;
  tier: AiToolTier;
  handler: (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;
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

export const aiTools: Map<string, AiTool> = new Map();

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
registerUITools(aiTools);

// ============================================
// Exports
// ============================================

export function getToolDefinitions(): Anthropic.Tool[] {
  return Array.from(aiTools.values()).map(t => t.definition);
}

export function getToolTier(toolName: string): AiToolTier | undefined {
  return aiTools.get(toolName)?.tier ?? m365ToolTiers[toolName];
}

/**
 * Helper device-scoping (security finding A, Phase 0).
 * Maps each tool the Breeze Helper may run to the input field naming its
 * target device. A tool absent from this map is org-wide and is DENIED under
 * a Helper context. The Helper's default tool set (helperToolFilter `basic`)
 * is kept in sync with these keys.
 */
export const HELPER_TOOL_SCOPING: Record<string, 'deviceId' | 'deviceIds'> = {
  get_device_details: 'deviceId',
  analyze_metrics: 'deviceId',
  analyze_disk_usage: 'deviceId',
  get_cis_device_report: 'deviceId',
  get_security_posture: 'deviceId',
  take_screenshot: 'deviceId',
  analyze_screen: 'deviceId',
  search_logs: 'deviceIds',
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

export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  auth: AuthContext
): Promise<string> {
  const tool = aiTools.get(toolName);
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);

  // Helper device-scope gate (finding A): force the tool onto the Helper's own
  // device, or deny org-wide tools, before anything else runs.
  let effectiveInput = input;
  if (auth.helperDeviceId) {
    const scoped = applyHelperDeviceScope(toolName, input, auth.helperDeviceId);
    if ('error' in scoped) return JSON.stringify({ error: scoped.error });
    effectiveInput = scoped.input;
  }

  // Validate input against Zod schema before execution
  const validation = validateToolInput(toolName, effectiveInput);
  if (!validation.success) {
    return JSON.stringify({ error: validation.error });
  }

  // Structural device-tenant gate: any id named in `tool.deviceArgs` is
  // org+site-checked before the handler runs, so a tool can't reach a device
  // outside the caller's scope even if its handler forgets to check.
  const gate = await enforceDeviceArgs(tool, effectiveInput, auth);
  if (!gate.ok) return JSON.stringify({ error: gate.error });

  return tool.handler(effectiveInput, auth);
}

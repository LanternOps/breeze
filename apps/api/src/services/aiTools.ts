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
import { registerConfigPolicyTools } from './aiToolsConfigPolicy';
import { registerEventLogTools } from './aiToolsEventLogs';
import { registerAnalyticsTools } from './aiToolsAnalytics';
import { registerFleetTools } from './aiToolsFleet';
import { registerPolicyPrereqTools } from './aiToolsPolicyPrereqs';
import { registerIntegrationTools } from './aiToolsIntegrations';
import { registerMonitoringTools } from './aiToolsMonitoring';

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
import { registerPerformanceTools } from './aiToolsPerformance';
import { registerUserRiskTools } from './aiToolsUserRisk';
import { registerFilesystemTools } from './aiToolsFilesystem';
import { registerAuditTools } from './aiToolsAudit';
import { registerRemoteTools } from './aiToolsRemote';
import { registerAgentMgmtTools } from './aiToolsAgentMgmt';
import { registerUITools } from './aiToolsUI';

// ============================================
// Shared Types
// ============================================

export type AiToolTier = 1 | 2 | 3 | 4;

export interface AiTool {
  definition: Anthropic.Tool;
  tier: AiToolTier;
  handler: (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;
}

// ============================================
// Shared Helpers (exported for domain modules)
// ============================================

export async function verifyDeviceAccess(
  deviceId: string,
  auth: AuthContext,
  requireOnline = false
): Promise<{ device: typeof devices.$inferSelect } | { error: string }> {
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) conditions.push(orgCond);
  const [device] = await db.select().from(devices).where(and(...conditions)).limit(1);
  if (!device) return { error: 'Device not found or access denied' };
  if (requireOnline && device.status !== 'online') return { error: `Device ${device.hostname} is not online (status: ${device.status})` };
  return { device };
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
registerPerformanceTools(aiTools);
registerUserRiskTools(aiTools);
registerFilesystemTools(aiTools);
registerAuditTools(aiTools);
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
  return aiTools.get(toolName)?.tier;
}

export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  auth: AuthContext
): Promise<string> {
  const tool = aiTools.get(toolName);
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);

  // Validate input against Zod schema before execution
  const validation = validateToolInput(toolName, input);
  if (!validation.success) {
    return JSON.stringify({ error: validation.error });
  }

  return tool.handler(input, auth);
}

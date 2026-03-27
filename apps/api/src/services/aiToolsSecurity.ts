/**
 * AI Security Tools
 *
 * Tools for security scanning, posture assessment, sensitive data discovery, and remediation.
 * - security_scan (Tier 3): Run security scans, manage threats, query vulnerabilities
 * - get_security_posture (Tier 1): Fleet-wide or device-level security posture scores
 * - get_sensitive_data_overview (Tier 1): Sensitive-data discovery results
 * - remediate_sensitive_data (Tier 3): Queue or apply sensitive-data remediation
 */

import { db } from '../db';
import {
  devices,
  securityThreats,
  sensitiveDataFindings,
  sensitiveDataScans,
} from '../db/schema';
import { eq, and, desc, sql, inArray, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { verifyDeviceAccess } from './aiTools';
import {
  getLatestSecurityPostureForDevice,
  listLatestSecurityPosture,
} from './securityPosture';
import { publishEvent } from './eventBus';
import { resolveSensitiveDataKeySelection } from './sensitiveDataKeys';

type AiToolTier = 1 | 2 | 3 | 4;

let _commandQueue: typeof import('./commandQueue') | null = null;
async function getCommandQueue() {
  if (!_commandQueue) _commandQueue = await import('./commandQueue');
  return _commandQueue;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function registerSecurityTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // security_scan - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'security_scan',
      description: 'Run security scans on a device, manage detected threats (quarantine, remove, restore), or query vulnerability data.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          action: { type: 'string', enum: ['scan', 'status', 'quarantine', 'remove', 'restore', 'vulnerabilities'], description: 'Security action' },
          threatId: { type: 'string', description: 'Threat ID (for quarantine/remove/restore)' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Filter by severity (for vulnerabilities)' },
          limit: { type: 'number', description: 'Max results for vulnerabilities (default 25, max 100)' }
        },
        required: ['deviceId', 'action']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;

      const access = await verifyDeviceAccess(deviceId, auth);
      if ('error' in access) return JSON.stringify({ error: access.error });

      if (input.action === 'vulnerabilities') {
        const conditions: SQL[] = [eq(securityThreats.deviceId, deviceId)];
        if (input.severity) {
          conditions.push(eq(securityThreats.severity, input.severity as 'critical' | 'high' | 'medium' | 'low'));
        }

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);

        const threats = await db
          .select({
            id: securityThreats.id,
            threatName: securityThreats.threatName,
            threatType: securityThreats.threatType,
            severity: securityThreats.severity,
            status: securityThreats.status,
            filePath: securityThreats.filePath,
            processName: securityThreats.processName,
            detectedAt: securityThreats.detectedAt,
            resolvedAt: securityThreats.resolvedAt,
            details: securityThreats.details
          })
          .from(securityThreats)
          .where(and(...conditions))
          .orderBy(desc(securityThreats.detectedAt))
          .limit(limit);

        const [countResult] = await db
          .select({ count: sql<number>`count(*)` })
          .from(securityThreats)
          .where(and(...conditions));

        const [severitySummary] = await db
          .select({
            critical: sql<number>`count(*) filter (where ${securityThreats.severity} = 'critical')`,
            high: sql<number>`count(*) filter (where ${securityThreats.severity} = 'high')`,
            medium: sql<number>`count(*) filter (where ${securityThreats.severity} = 'medium')`,
            low: sql<number>`count(*) filter (where ${securityThreats.severity} = 'low')`,
            active: sql<number>`count(*) filter (where ${securityThreats.status} = 'detected')`,
            quarantined: sql<number>`count(*) filter (where ${securityThreats.status} = 'quarantined')`,
            removed: sql<number>`count(*) filter (where ${securityThreats.status} = 'removed')`
          })
          .from(securityThreats)
          .where(eq(securityThreats.deviceId, deviceId));

        return JSON.stringify({
          threats,
          total: Number(countResult?.count ?? 0),
          showing: threats.length,
          summary: {
            critical: Number(severitySummary?.critical ?? 0),
            high: Number(severitySummary?.high ?? 0),
            medium: Number(severitySummary?.medium ?? 0),
            low: Number(severitySummary?.low ?? 0),
            active: Number(severitySummary?.active ?? 0),
            quarantined: Number(severitySummary?.quarantined ?? 0),
            removed: Number(severitySummary?.removed ?? 0)
          }
        });
      }

      const { executeCommand } = await getCommandQueue();
      const actionMap: Record<string, string> = {
        scan: 'security_scan',
        status: 'security_collect_status',
        quarantine: 'security_threat_quarantine',
        remove: 'security_threat_remove',
        restore: 'security_threat_restore'
      };

      const secCommandType = actionMap[input.action as string];
      if (!secCommandType) return JSON.stringify({ error: `Unknown action: ${input.action}` });

      const result = await executeCommand(deviceId, secCommandType, {
        threatId: input.threatId
      }, { userId: auth.user.id, timeoutMs: 60000 });

      return JSON.stringify(result);
    }
  });

  // ============================================
  // get_security_posture - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_security_posture',
      description: 'Get fleet-wide or device-level security posture scores with factor breakdowns and prioritized recommendations.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Optional device UUID to fetch posture for a specific device' },
          orgId: { type: 'string', description: 'Optional org UUID (must be accessible)' },
          minScore: { type: 'number', description: 'Filter to scores greater than or equal to this value (0-100)' },
          maxScore: { type: 'number', description: 'Filter to scores less than or equal to this value (0-100)' },
          riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Filter by risk level' },
          includeRecommendations: { type: 'boolean', description: 'Include recommendation payloads (default true)' },
          limit: { type: 'number', description: 'Maximum device results (default 100, max 500)' }
        }
      }
    },
    handler: async (input, auth) => {
      const includeRecommendations = input.includeRecommendations !== false;
      const limit = Math.min(Math.max(1, Number(input.limit) || 100), 500);

      if (typeof input.deviceId === 'string' && input.deviceId) {
        const access = await verifyDeviceAccess(input.deviceId, auth);
        if ('error' in access) return JSON.stringify({ error: access.error });

        const posture = await getLatestSecurityPostureForDevice(input.deviceId);
        if (!posture) {
          return JSON.stringify({
            error: 'No security posture data available for this device yet'
          });
        }

        if (!includeRecommendations) {
          return JSON.stringify({
            device: {
              ...posture,
              recommendations: []
            }
          });
        }
        return JSON.stringify({ device: posture });
      }

      if (typeof input.orgId === 'string' && input.orgId && !auth.canAccessOrg(input.orgId)) {
        return JSON.stringify({ error: 'Access denied to this organization' });
      }

      const orgIds = typeof input.orgId === 'string' && input.orgId
        ? [input.orgId]
        : auth.orgId
          ? [auth.orgId]
          : (auth.accessibleOrgIds && auth.accessibleOrgIds.length > 0 ? auth.accessibleOrgIds : undefined);

      if (!orgIds && auth.scope !== 'system') {
        return JSON.stringify({ error: 'Organization context required' });
      }

      const postures = await listLatestSecurityPosture({
        orgIds,
        minScore: typeof input.minScore === 'number' ? input.minScore : undefined,
        maxScore: typeof input.maxScore === 'number' ? input.maxScore : undefined,
        riskLevel: input.riskLevel as 'low' | 'medium' | 'high' | 'critical' | undefined,
        limit
      });

      const rows = includeRecommendations
        ? postures
        : postures.map((item) => ({ ...item, recommendations: [] }));

      const total = rows.length;
      const summary = {
        totalDevices: total,
        averageScore: total
          ? Math.round(rows.reduce((sum, row) => sum + row.overallScore, 0) / total)
          : 0,
        lowRiskDevices: rows.filter((row) => row.riskLevel === 'low').length,
        mediumRiskDevices: rows.filter((row) => row.riskLevel === 'medium').length,
        highRiskDevices: rows.filter((row) => row.riskLevel === 'high').length,
        criticalRiskDevices: rows.filter((row) => row.riskLevel === 'critical').length
      };

      return JSON.stringify({
        summary,
        worstDevices: rows.slice(0, Math.min(10, rows.length)),
        devices: rows
      });
    }
  });

  // ============================================
  // get_sensitive_data_overview - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_sensitive_data_overview',
      description: 'Query sensitive-data discovery results. Supports dashboard totals, findings list, and recent scans.',
      input_schema: {
        type: 'object' as const,
        properties: {
          view: { type: 'string', enum: ['dashboard', 'findings', 'scans'], description: 'Response shape (default dashboard)' },
          status: { type: 'string', enum: ['open', 'remediated', 'accepted', 'false_positive'], description: 'Findings status filter' },
          risk: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Findings risk filter' },
          dataType: { type: 'string', enum: ['pii', 'pci', 'phi', 'credential', 'financial'], description: 'Sensitive data class filter' },
          deviceId: { type: 'string', description: 'Device UUID filter' },
          scanId: { type: 'string', description: 'Scan UUID filter' },
          limit: { type: 'number', description: 'Max rows returned for list views (default 50, max 200)' },
        }
      }
    },
    handler: async (input, auth) => {
      const view = (typeof input.view === 'string' ? input.view : 'dashboard') as 'dashboard' | 'findings' | 'scans';
      const limit = Math.min(Math.max(1, Number(input.limit) || 50), 200);

      if (view === 'scans') {
        const conditions: SQL[] = [];
        const orgCondition = auth.orgCondition(sensitiveDataScans.orgId);
        if (orgCondition) conditions.push(orgCondition);
        if (typeof input.deviceId === 'string' && input.deviceId) {
          conditions.push(eq(sensitiveDataScans.deviceId, input.deviceId));
        }
        if (typeof input.scanId === 'string' && input.scanId) {
          conditions.push(eq(sensitiveDataScans.id, input.scanId));
        }

        const scans = await db
          .select({
            id: sensitiveDataScans.id,
            orgId: sensitiveDataScans.orgId,
            deviceId: sensitiveDataScans.deviceId,
            deviceName: devices.hostname,
            policyId: sensitiveDataScans.policyId,
            status: sensitiveDataScans.status,
            startedAt: sensitiveDataScans.startedAt,
            completedAt: sensitiveDataScans.completedAt,
            summary: sensitiveDataScans.summary,
            createdAt: sensitiveDataScans.createdAt,
          })
          .from(sensitiveDataScans)
          .innerJoin(devices, eq(devices.id, sensitiveDataScans.deviceId))
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(sensitiveDataScans.createdAt))
          .limit(limit);

        const byStatus: Record<string, number> = {};
        for (const scan of scans) {
          byStatus[scan.status] = (byStatus[scan.status] ?? 0) + 1;
        }

        return JSON.stringify({
          view: 'scans',
          totalReturned: scans.length,
          byStatus,
          scans,
        });
      }

      const findingConditions: SQL[] = [];
      const orgCondition = auth.orgCondition(sensitiveDataFindings.orgId);
      if (orgCondition) findingConditions.push(orgCondition);
      if (typeof input.status === 'string' && input.status) {
        findingConditions.push(eq(sensitiveDataFindings.status, input.status as 'open' | 'remediated' | 'accepted' | 'false_positive'));
      }
      if (typeof input.risk === 'string' && input.risk) {
        findingConditions.push(eq(sensitiveDataFindings.risk, input.risk as 'low' | 'medium' | 'high' | 'critical'));
      }
      if (typeof input.dataType === 'string' && input.dataType) {
        findingConditions.push(eq(sensitiveDataFindings.dataType, input.dataType as 'pii' | 'pci' | 'phi' | 'credential' | 'financial'));
      }
      if (typeof input.deviceId === 'string' && input.deviceId) {
        findingConditions.push(eq(sensitiveDataFindings.deviceId, input.deviceId));
      }
      if (typeof input.scanId === 'string' && input.scanId) {
        findingConditions.push(eq(sensitiveDataFindings.scanId, input.scanId));
      }

      if (view === 'dashboard') {
        const rows = await db
          .select({
            dataType: sensitiveDataFindings.dataType,
            risk: sensitiveDataFindings.risk,
            status: sensitiveDataFindings.status,
            lastSeenAt: sensitiveDataFindings.lastSeenAt,
            remediatedAt: sensitiveDataFindings.remediatedAt,
          })
          .from(sensitiveDataFindings)
          .where(findingConditions.length > 0 ? and(...findingConditions) : undefined);

        const nowMs = Date.now();
        let openTotal = 0;
        let criticalOpen = 0;
        let remediated24h = 0;
        let totalOpenAgeHours = 0;
        const byDataType: Record<string, number> = {};
        const byRisk: Record<string, number> = {};

        for (const row of rows) {
          byDataType[row.dataType] = (byDataType[row.dataType] ?? 0) + 1;
          byRisk[row.risk] = (byRisk[row.risk] ?? 0) + 1;

          if (row.status === 'open') {
            openTotal += 1;
            if (row.risk === 'critical') criticalOpen += 1;
            if (row.lastSeenAt) {
              totalOpenAgeHours += Math.max(0, (nowMs - row.lastSeenAt.getTime()) / (1000 * 60 * 60));
            }
          }
          if (row.status === 'remediated' && row.remediatedAt && (nowMs - row.remediatedAt.getTime()) <= (24 * 60 * 60 * 1000)) {
            remediated24h += 1;
          }
        }

        return JSON.stringify({
          view: 'dashboard',
          totals: {
            findings: rows.length,
            open: openTotal,
            criticalOpen,
            remediated24h,
            averageOpenAgeHours: openTotal > 0 ? Number((totalOpenAgeHours / openTotal).toFixed(2)) : 0,
          },
          byDataType,
          byRisk,
        });
      }

      const findings = await db
        .select({
          id: sensitiveDataFindings.id,
          orgId: sensitiveDataFindings.orgId,
          deviceId: sensitiveDataFindings.deviceId,
          deviceName: devices.hostname,
          scanId: sensitiveDataFindings.scanId,
          filePath: sensitiveDataFindings.filePath,
          dataType: sensitiveDataFindings.dataType,
          patternId: sensitiveDataFindings.patternId,
          matchCount: sensitiveDataFindings.matchCount,
          risk: sensitiveDataFindings.risk,
          confidence: sensitiveDataFindings.confidence,
          status: sensitiveDataFindings.status,
          remediationAction: sensitiveDataFindings.remediationAction,
          firstSeenAt: sensitiveDataFindings.firstSeenAt,
          lastSeenAt: sensitiveDataFindings.lastSeenAt,
          occurrenceCount: sensitiveDataFindings.occurrenceCount,
          remediatedAt: sensitiveDataFindings.remediatedAt,
        })
        .from(sensitiveDataFindings)
        .innerJoin(devices, eq(devices.id, sensitiveDataFindings.deviceId))
        .where(findingConditions.length > 0 ? and(...findingConditions) : undefined)
        .orderBy(desc(sensitiveDataFindings.lastSeenAt))
        .limit(limit);

      return JSON.stringify({
        view: 'findings',
        totalReturned: findings.length,
        findings,
      });
    }
  });

  // ============================================
  // remediate_sensitive_data - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'remediate_sensitive_data',
      description: 'Queue or apply sensitive-data remediation actions for findings. Supports dry-run and manual status actions.',
      input_schema: {
        type: 'object' as const,
        properties: {
          findingIds: { type: 'array', items: { type: 'string' }, description: 'Finding UUIDs to remediate' },
          action: { type: 'string', enum: ['encrypt', 'quarantine', 'secure_delete', 'accept_risk', 'false_positive', 'mark_remediated'], description: 'Remediation action' },
          confirm: { type: 'boolean', description: 'Required for destructive actions (encrypt/quarantine/secure_delete)' },
          dryRun: { type: 'boolean', description: 'Return eligibility without applying remediation' },
          secondApprovalToken: { type: 'string', description: 'Required for secure_delete when second approval is enabled' },
          encryptionKeyRef: { type: 'string', description: 'Optional key reference for encrypt actions' },
          encryptionKeyVersion: { type: 'string', description: 'Optional key version for encrypt actions' },
          quarantineDir: { type: 'string', description: 'Optional target quarantine directory' },
        },
        required: ['findingIds', 'action']
      }
    },
    handler: async (input, auth) => {
      const findingIdsRaw = Array.isArray(input.findingIds) ? input.findingIds : [];
      const findingIds = Array.from(new Set(
        findingIdsRaw
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      ));
      if (findingIds.length === 0) {
        return JSON.stringify({ error: 'No finding IDs provided' });
      }

      const action = input.action as 'encrypt' | 'quarantine' | 'secure_delete' | 'accept_risk' | 'false_positive' | 'mark_remediated';
      const destructive = action === 'encrypt' || action === 'quarantine' || action === 'secure_delete';
      if (destructive && input.confirm !== true) {
        return JSON.stringify({ error: 'Destructive remediation actions require confirm=true' });
      }

      if (
        action === 'secure_delete'
        && envFlag('SENSITIVE_DATA_REQUIRE_SECOND_APPROVAL', false)
      ) {
        const expected = process.env.SENSITIVE_DATA_SECOND_APPROVAL_TOKEN?.trim();
        const provided = typeof input.secondApprovalToken === 'string' ? input.secondApprovalToken.trim() : '';
        if (!expected || provided !== expected) {
          return JSON.stringify({ error: 'secure_delete requires a valid secondApprovalToken' });
        }
      }

      const conditions: SQL[] = [inArray(sensitiveDataFindings.id, findingIds)];
      const orgCondition = auth.orgCondition(sensitiveDataFindings.orgId);
      if (orgCondition) conditions.push(orgCondition);

      const findings = await db
        .select({
          id: sensitiveDataFindings.id,
          orgId: sensitiveDataFindings.orgId,
          deviceId: sensitiveDataFindings.deviceId,
          scanId: sensitiveDataFindings.scanId,
          filePath: sensitiveDataFindings.filePath,
          status: sensitiveDataFindings.status,
        })
        .from(sensitiveDataFindings)
        .where(and(...conditions));

      if (findings.length === 0) {
        return JSON.stringify({ error: 'No findings found or access denied' });
      }

      if (input.dryRun === true) {
        return JSON.stringify({
          dryRun: true,
          action,
          eligible: findings.length,
          findings: findings.map((finding) => ({
            findingId: finding.id,
            deviceId: finding.deviceId,
            filePath: finding.filePath,
            status: finding.status,
          })),
        });
      }

      const now = new Date();
      if (action === 'accept_risk' || action === 'false_positive' || action === 'mark_remediated') {
        const nextStatus = action === 'accept_risk'
          ? 'accepted'
          : action === 'false_positive'
            ? 'false_positive'
            : 'remediated';

        await db
          .update(sensitiveDataFindings)
          .set({
            status: nextStatus,
            remediationAction: action,
            remediationMetadata: {
              source: 'ai_tool',
              updatedBy: auth.user.id,
              updatedAt: now.toISOString(),
            },
            remediatedAt: nextStatus === 'remediated' ? now : null,
          })
          .where(inArray(sensitiveDataFindings.id, findings.map((finding) => finding.id)));

        if (nextStatus === 'remediated') {
          const orgIds = Array.from(new Set(findings.map((finding) => finding.orgId)));
          await Promise.allSettled(orgIds.map((orgId) => publishEvent(
            'compliance.sensitive_data_remediated',
            orgId,
            {
              findingIds: findings.map((finding) => finding.id),
              action,
              remediatedAt: now.toISOString(),
            },
            'ai_tools'
          )));
        }

        return JSON.stringify({
          action,
          updated: findings.length,
          queued: 0,
          failed: 0,
        });
      }

      const { queueCommand, CommandTypes } = await getCommandQueue();
      const commandType = action === 'encrypt'
        ? CommandTypes.ENCRYPT_FILE
        : action === 'quarantine'
          ? CommandTypes.QUARANTINE_FILE
          : CommandTypes.SECURE_DELETE_FILE;

      let keySelection: {
        keyRef: string;
        keyVersion: string;
        provider: string;
        keyFingerprint: string;
      } | null = null;
      if (action === 'encrypt') {
        try {
          keySelection = resolveSensitiveDataKeySelection({
            requestedKeyRef: typeof input.encryptionKeyRef === 'string' ? input.encryptionKeyRef : undefined,
            requestedKeyVersion: typeof input.encryptionKeyVersion === 'string' ? input.encryptionKeyVersion : undefined,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Invalid key selection';
          return JSON.stringify({ error: message });
        }
      }

      const queued: Array<{ findingId: string; commandId: string }> = [];
      const failed: Array<{ findingId: string; error: string }> = [];
      for (const finding of findings) {
        try {
          const command = await queueCommand(
            finding.deviceId,
            commandType,
            {
              findingId: finding.id,
              path: finding.filePath,
              quarantineDir: typeof input.quarantineDir === 'string' ? input.quarantineDir : undefined,
              encryptionKeyRef: keySelection?.keyRef,
              encryptionKeyVersion: keySelection?.keyVersion,
              encryptionProvider: keySelection?.provider,
            },
            auth.user.id
          );
          queued.push({ findingId: finding.id, commandId: command.id });
        } catch (err) {
          failed.push({
            findingId: finding.id,
            error: err instanceof Error ? err.message : 'Failed to queue command',
          });
        }
      }

      const queuedFindingIds = queued.map((entry) => entry.findingId);
      if (queuedFindingIds.length > 0) {
        await db
          .update(sensitiveDataFindings)
          .set({
            remediationAction: action,
            remediationMetadata: {
              source: 'ai_tool',
              updatedBy: auth.user.id,
              queuedAt: now.toISOString(),
              keyRef: keySelection?.keyRef ?? null,
              keyVersion: keySelection?.keyVersion ?? null,
              keyFingerprint: keySelection?.keyFingerprint ?? null,
            },
          })
          .where(inArray(sensitiveDataFindings.id, queuedFindingIds));
      }

      return JSON.stringify({
        action,
        requested: findings.length,
        queued,
        failed,
      });
    }
  });
}

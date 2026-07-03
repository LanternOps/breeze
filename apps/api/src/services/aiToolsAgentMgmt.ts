/**
 * AI Agent Management Tools
 *
 * Tools for managing agent versions and upgrades.
 * - query_agent_versions (Tier 1): List available agent versions and check upgrades
 * - trigger_agent_upgrade (Tier 3): Queue an agent upgrade for devices
 * - trigger_agent_restart (Tier 3): Ask the watchdog to restart a wedged/silent agent
 */

import { db, withSystemDbAccessContext } from '../db';
import { devices, agentVersions } from '../db/schema';
import { eq, ne, and, desc, sql, inArray, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { getOrgAgentUpdateConfig, resolvePinnedUpgradeTarget, normalizeAgentArchitecture } from '../routes/agents/helpers';

type AiToolTier = 1 | 2 | 3 | 4;

async function verifyDeviceAccess(
  deviceId: string,
  auth: AuthContext,
  requireOnline = false
): Promise<{ device: typeof devices.$inferSelect } | { error: string }> {
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

let _commandQueue: typeof import('./commandQueue') | null = null;
async function getCommandQueue() {
  if (!_commandQueue) _commandQueue = await import('./commandQueue');
  return _commandQueue;
}

export function registerAgentMgmtTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // query_agent_versions - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
    definition: {
      name: 'query_agent_versions',
      description: 'List available agent versions and check which devices need upgrades.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['list_versions', 'check_upgrades'],
            description: 'Action to perform',
          },
          platform: {
            type: 'string',
            description: 'Filter by platform (windows, macos, linux) — only for list_versions',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 25, max 50)',
          },
        },
        required: ['action'],
      },
    },
    handler: async (input, auth) => {
      const action = input.action as string;
      const limit = Math.min((input.limit as number) || 25, 50);

      if (action === 'list_versions') {
        const conditions: SQL[] = [];
        if (input.platform) {
          conditions.push(eq(agentVersions.platform, input.platform as string));
        }

        const versions = await db
          .select({
            version: agentVersions.version,
            platform: agentVersions.platform,
            architecture: agentVersions.architecture,
            isLatest: agentVersions.isLatest,
            fileSize: agentVersions.fileSize,
            releaseNotes: agentVersions.releaseNotes,
            createdAt: agentVersions.createdAt,
          })
          .from(agentVersions)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(agentVersions.createdAt))
          .limit(limit);

        return JSON.stringify({ versions, total: versions.length }, (_, v) => typeof v === 'bigint' ? Number(v) : v);
      }

      if (action === 'check_upgrades') {
        // Get the globally promoted latest agent version.
        const [latest] = await db
          .select({ version: agentVersions.version })
          .from(agentVersions)
          .where(eq(agentVersions.isLatest, true))
          .limit(1);

        // Issue #2124: "outdated" must be measured against the fleet's EFFECTIVE
        // target, not the global latest — an org pinned to an older known-good
        // version will never be pushed past its pin, so counting those devices as
        // "behind global latest" contradicts what the fleet will actually do. For
        // an org-scoped caller (the common case) resolve that org's effective pin
        // and compare against it. A partner/system caller can span many orgs with
        // different pins, which no single target can represent — keep the global
        // latest but say so, so the count isn't misread as pin-aware.
        let effectiveTarget: string | null = latest?.version ?? null;
        let pinned = false;
        let note: string | undefined;
        if (auth.orgId) {
          try {
            const cfg = await withSystemDbAccessContext(() => getOrgAgentUpdateConfig(auth.orgId!));
            if (cfg.pins.agent) {
              effectiveTarget = cfg.pins.agent;
              pinned = true;
            }
          } catch {
            note = 'Could not resolve this org’s version pin; counting against global latest.';
          }
        } else {
          note = 'Caller spans multiple orgs; per-org version pins are not reflected in this count.';
        }

        if (!effectiveTarget) {
          return JSON.stringify({ error: 'No latest agent version found' });
        }

        // Find devices whose agent version differs from the effective target.
        const conditions: SQL[] = [ne(devices.agentVersion, effectiveTarget)];
        const orgCond = auth.orgCondition(devices.orgId);
        if (orgCond) conditions.push(orgCond);

        const outdated = await db
          .select({
            currentVersion: devices.agentVersion,
            count: sql<number>`count(*)::int`,
          })
          .from(devices)
          .where(and(...conditions))
          .groupBy(devices.agentVersion)
          .orderBy(desc(sql<number>`count(*)`));

        const totalOutdated = outdated.reduce((sum, row) => sum + row.count, 0);

        return JSON.stringify({
          // `latestVersion` stays the global promoted latest (back-compat); the
          // count is measured against `effectiveTarget` (the pin when set).
          latestVersion: latest?.version ?? null,
          effectiveTarget,
          pinned,
          totalOutdated,
          byVersion: outdated,
          ...(note ? { note } : {}),
        });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    },
  });

  // ============================================
  // trigger_agent_upgrade - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3 as AiToolTier,
    deviceArgs: ['deviceIds'],
    definition: {
      name: 'trigger_agent_upgrade',
      description: 'Queue an agent upgrade for a device or group of devices.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Device UUIDs to upgrade (max 50)',
          },
          targetVersion: {
            type: 'string',
            description: 'Target agent version (defaults to latest if not specified)',
          },
        },
        required: ['deviceIds'],
      },
    },
    handler: async (input, auth) => {
      const deviceIds = (input.deviceIds as string[]).slice(0, 50);
      if (deviceIds.length === 0) {
        return JSON.stringify({ error: 'deviceIds array is required and must not be empty' });
      }

      // Verify access to the first device
      const firstAccess = await verifyDeviceAccess(deviceIds[0]!, auth);
      if ('error' in firstAccess) return JSON.stringify({ error: firstAccess.error });

      // Verify all deviceIds belong to the org
      const orgCond = auth.orgCondition(devices.orgId);
      const accessConditions: SQL[] = [inArray(devices.id, deviceIds)];
      if (orgCond) accessConditions.push(orgCond);

      const accessibleDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(...accessConditions));

      const accessibleIds = new Set(accessibleDevices.map(d => d.id));
      const deniedIds = deviceIds.filter(id => !accessibleIds.has(id));
      if (deniedIds.length > 0) {
        return JSON.stringify({ error: `Access denied for devices: ${deniedIds.join(', ')}` });
      }

      // Resolve the target version PER DEVICE. An explicit targetVersion applies
      // to all devices; otherwise each device resolves to its org's effective
      // AGENT pin (issue #2124) — the SAME pin the heartbeat honors — falling
      // back to the globally promoted latest when the tenant has no pin. This
      // keeps manual and automatic updates on one resolution path.
      const explicitVersion = input.targetVersion as string | undefined;
      const errors: Record<string, string> = {};
      const targetByDevice = new Map<string, string>();

      if (explicitVersion) {
        const [versionRow] = await db
          .select({ version: agentVersions.version })
          .from(agentVersions)
          .where(eq(agentVersions.version, explicitVersion))
          .limit(1);
        if (!versionRow) {
          return JSON.stringify({ error: `Agent version "${explicitVersion}" not found` });
        }
        for (const id of deviceIds) targetByDevice.set(id, explicitVersion);
      } else {
        // Need each device's org (to resolve its effective pin) AND its
        // platform/arch (to fail closed when the pinned/latest version has no
        // build for that device). Resolving through resolvePinnedUpgradeTarget
        // per device — the SAME call the heartbeat uses — is what stops this
        // manual channel from dispatching an update_agent for a binary that
        // doesn't exist and reporting it as `queued` (a silent, on-device 60s
        // timeout the operator never sees).
        const deviceRows = await db
          .select({
            id: devices.id,
            orgId: devices.orgId,
            osType: devices.osType,
            architecture: devices.architecture,
          })
          .from(devices)
          .where(inArray(devices.id, deviceIds));

        const pinByOrg = new Map<string, string | null>();
        const failedOrgs = new Set<string>();

        for (const d of deviceRows) {
          if (failedOrgs.has(d.orgId)) {
            errors[d.id] = 'Failed to resolve version pin for this organization';
            continue;
          }
          if (!pinByOrg.has(d.orgId)) {
            // Effective pin needs the parent partners row (partner-set defaults),
            // which org-scoped RLS can't read — resolve in a system context, the
            // same pattern the heartbeat and aiAgent use. Isolate per org so one
            // org's resolver failure doesn't abort the whole batch.
            try {
              const cfg = await withSystemDbAccessContext(() => getOrgAgentUpdateConfig(d.orgId));
              pinByOrg.set(d.orgId, cfg.pins.agent);
            } catch {
              failedOrgs.add(d.orgId);
              errors[d.id] = 'Failed to resolve version pin for this organization';
              continue;
            }
          }

          const normalizedArch = normalizeAgentArchitecture(d.architecture);
          if (!d.osType || !normalizedArch) {
            errors[d.id] = 'Device platform/architecture unknown — cannot resolve an agent build';
            continue;
          }

          const pin = pinByOrg.get(d.orgId) ?? null;
          // pin set → that exact build for this platform/arch (null if missing);
          // pin null → the globally promoted latest for this platform/arch.
          // Either way, null means "no build" → fail closed, do not dispatch.
          let target: string | null;
          try {
            target = await resolvePinnedUpgradeTarget({
              component: 'agent',
              platform: d.osType,
              architecture: normalizedArch,
              pin,
              agentId: d.id,
            });
          } catch {
            errors[d.id] = 'Failed to resolve an agent build for this device';
            continue;
          }

          if (target) {
            targetByDevice.set(d.id, target);
          } else {
            errors[d.id] = pin
              ? `Pinned agent version "${pin}" has no build for this device (${d.osType}/${normalizedArch})`
              : 'No agent build available for this device platform/architecture';
          }
        }

        if (targetByDevice.size === 0) {
          return JSON.stringify({
            error: 'No latest agent version found',
            ...(Object.keys(errors).length > 0 ? { errors } : {}),
          });
        }
      }

      // Dispatch upgrade commands
      const { executeCommand } = await getCommandQueue();
      let queued = 0;

      for (const deviceId of deviceIds) {
        const targetVersion = targetByDevice.get(deviceId);
        if (!targetVersion) {
          // Already recorded (e.g. no pin + no global latest for this device).
          if (!errors[deviceId]) errors[deviceId] = 'No target version resolved';
          continue;
        }
        try {
          // Agent upgrades are executed by the breeze-watchdog process, not
          // the agent. The watchdog handles type `update_agent` and reads
          // `payload.version` — see agent/cmd/breeze-watchdog/main.go
          // (handleFailoverCommand). It has no WS connection and polls via
          // heartbeat, so we must tag the command with target_role='watchdog'
          // or it will be dispatched to the agent WS and never picked up.
          // executeCommand RETURNS status:'failed' on dispatch failure rather
          // than throwing, so inspect the result instead of assuming success.
          const result = await executeCommand(deviceId, 'update_agent', {
            version: targetVersion,
          }, {
            userId: auth.user.id,
            timeoutMs: 60000,
            targetRole: 'watchdog',
          });
          if (result.status === 'failed') {
            errors[deviceId] = result.error ?? 'Failed to queue upgrade';
          } else {
            queued++;
          }
        } catch (err) {
          errors[deviceId] = err instanceof Error ? err.message : 'Failed to queue upgrade';
        }
      }

      // Report the distinct target(s) queued so a pinned/mixed batch is legible.
      const distinctTargets = [...new Set(targetByDevice.values())];
      return JSON.stringify({
        queued,
        ...(explicitVersion
          ? { targetVersion: explicitVersion }
          : { targetVersions: distinctTargets }),
        ...(Object.keys(errors).length > 0 ? { errors } : {}),
      });
    },
  });

  // ============================================
  // trigger_agent_restart - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3 as AiToolTier,
    deviceArgs: ['deviceIds'],
    definition: {
      name: 'trigger_agent_restart',
      description:
        'Ask the breeze-watchdog to restart the main agent on a device — recovers a wedged or silent agent (the "Agent silent · watchdog OK" state). Targets the watchdog, not the agent, so it works even when the agent itself is unresponsive. The watchdog acts on this when it is supervising/failing over the agent; a healthy agent is left untouched.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Device UUIDs whose agent should be restarted (max 50)',
          },
        },
        required: ['deviceIds'],
      },
    },
    handler: async (input, auth) => {
      const deviceIds = (input.deviceIds as string[]).slice(0, 50);
      if (deviceIds.length === 0) {
        return JSON.stringify({ error: 'deviceIds array is required and must not be empty' });
      }

      // Verify access to the first device (org + site axes).
      const firstAccess = await verifyDeviceAccess(deviceIds[0]!, auth);
      if ('error' in firstAccess) return JSON.stringify({ error: firstAccess.error });

      // Verify all deviceIds belong to the caller's org before dispatching.
      const orgCond = auth.orgCondition(devices.orgId);
      const accessConditions: SQL[] = [inArray(devices.id, deviceIds)];
      if (orgCond) accessConditions.push(orgCond);

      const accessibleDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(...accessConditions));

      const accessibleIds = new Set(accessibleDevices.map(d => d.id));
      const deniedIds = deviceIds.filter(id => !accessibleIds.has(id));
      if (deniedIds.length > 0) {
        return JSON.stringify({ error: `Access denied for devices: ${deniedIds.join(', ')}` });
      }

      // Dispatch restart commands to the WATCHDOG, not the agent. The agent
      // may be wedged with no live WS; the watchdog has no WS and polls via
      // heartbeat, so the command must be tagged target_role='watchdog' or it
      // would be dispatched to the (dead) agent WS and never picked up. The
      // watchdog handles type `restart_agent` — see
      // agent/cmd/breeze-watchdog/main.go (handleFailoverCommand). We do NOT
      // require the device to be online: a silent agent is exactly the case
      // this tool exists to recover.
      const { executeCommand } = await getCommandQueue();
      let queued = 0;
      const errors: Record<string, string> = {};

      for (const deviceId of deviceIds) {
        try {
          // executeCommand signals dispatch failure by RETURNING
          // status:'failed' (device not found, watchdog not reporting, etc.) —
          // it does not throw for those. Counting an awaited call as success
          // would silently report a queued restart that never happened, which
          // is especially likely here since this tool targets silent devices.
          // A 'timeout' means the row was written and the watchdog will claim
          // it on its next failover poll — that counts as queued.
          const result = await executeCommand(deviceId, 'restart_agent', {}, {
            userId: auth.user.id,
            timeoutMs: 60000,
            targetRole: 'watchdog',
          });
          if (result.status === 'failed') {
            errors[deviceId] = result.error ?? 'Failed to queue restart';
          } else {
            queued++;
          }
        } catch (err) {
          errors[deviceId] = err instanceof Error ? err.message : 'Failed to queue restart';
        }
      }

      return JSON.stringify({
        requested: deviceIds.length,
        queued,
        action: 'restart_agent',
        ...(Object.keys(errors).length > 0 ? { errors } : {}),
      });
    },
  });
}

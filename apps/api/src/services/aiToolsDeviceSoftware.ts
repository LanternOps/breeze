/**
 * Device software tools (full-control W12, #6782):
 *
 *  - `get_device_software` (t1): the AI twin of GET /devices/:id/software —
 *    one device's installed software, paged, optional name search.
 *  - `manage_device_software` (supervised): POST /devices/:id/software/update
 *    and /uninstall. `uninstall` is AGENT_HUMAN_ONLY_ACTIONS (irreversible on a
 *    customer machine). The body is validated by the route's own
 *    `softwareActionPayloadSchema` (shared, services/softwareActionPayload.ts).
 *  - `bootstrap_homebrew` (supervised, AGENT_HUMAN_ONLY_TOOLS): POST
 *    /devices/:id/homebrew-bootstrap — the pinned Homebrew installer, macOS only.
 *
 * Device scope is the central `deviceArgs` gate (org + site + exact device +
 * not parked) plus `verifyDeviceAccess` here. Every write's REST twin carries
 * `requireMfa()`, so each checks `mfaGatedToolError` (W12-D5). Commands go
 * through `aiQueueCommand` (AI origin stamp + AI remote-tools policy); the
 * command row is claimed by the agent's heartbeat after this call's
 * transaction commits, so a push can never race an uncommitted row. The
 * requester id is passed positionally and `queueCommand` degrades a
 * non-`users` id to NULL (`resolveCommandCreatedBy`).
 */
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { softwareInventory } from '../db/schema';
import type { AiTool } from './aiTools';
import { verifyDeviceAccess } from './aiTools';
import { aiQueueCommand } from './aiDispatch';
import { CommandTypes } from './commandTypes';
import { RemoteToolsDisabledByPolicyError } from './aiRemoteToolsPolicy';
import { mfaGatedToolError } from './aiToolMfaGate';
import { homebrewBootstrapPayload } from './homebrewBootstrap';
import { escapeLikePattern } from './packageSearch';
import { softwareActionPayloadSchema } from './softwareActionPayload';
import { DEVICE_SOFTWARE_ACTIONS } from './aiToolSchemasSoftware';
import { auditToolWrite, bounded, clampLimit, clampOffset, json, jsonError, notFound, thrown } from './aiToolsSoftwareShared';

type DeviceSoftwareAction = (typeof DEVICE_SOFTWARE_ACTIONS)[number];

export function registerDeviceSoftwareTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('get_device_software', {
    tier: 1,
    domain: 'patching',
    searchHint: 'installed software, programs and apps on one device, with versions and vendors',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'get_device_software',
      description: 'Installed software on one device (name, version, vendor, install date), paged, optional name search.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Device UUID' },
          search: { type: 'string', description: 'Substring of the software name' },
          limit: { type: 'number', description: 'Max rows (default 100, max 200)' },
          offset: { type: 'number', description: 'Rows to skip' },
        },
        required: ['deviceId'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      try {
        const access = await verifyDeviceAccess(String(input.deviceId), auth);
        if ('error' in access) return notFound('Device');
        const device = access.device;
        const limit = clampLimit(input.limit, 100, 200);
        const offset = clampOffset(input.offset);
        const conditions: SQL[] = [eq(softwareInventory.deviceId, device.id)];
        if (typeof input.search === 'string' && input.search.trim() !== '') {
          conditions.push(sql`${softwareInventory.name} ILIKE ${`%${escapeLikePattern(input.search.trim())}%`}`);
        }
        const where = and(...conditions);
        const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(softwareInventory).where(where);
        const rows = await db
          .select({
            name: softwareInventory.name,
            version: softwareInventory.version,
            vendor: softwareInventory.vendor,
            installDate: softwareInventory.installDate,
            isManaged: softwareInventory.isManaged,
            lastSeen: softwareInventory.lastSeen,
          })
          .from(softwareInventory)
          .where(where)
          .orderBy(asc(softwareInventory.name), asc(softwareInventory.id))
          .limit(limit)
          .offset(offset);
        return bounded({
          device: { id: device.id, hostname: device.hostname, os: device.osType },
          software: rows,
          total: Number(count?.n ?? 0),
          showing: rows.length,
          offset,
        });
      } catch (error) {
        return thrown('get_device_software', error);
      }
    },
  });

  aiTools.set('manage_device_software', {
    tier: 3,
    domain: 'patching',
    searchHint: 'update or uninstall an installed application on one device',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'manage_device_software',
      description: 'Actions: update or uninstall one installed application on a device (name as in get_device_software). Version pin and winget packageId: Windows only. Needs approval.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...DEVICE_SOFTWARE_ACTIONS], description: 'The action to perform' },
          deviceId: { type: 'string', description: 'Device UUID' },
          name: { type: 'string', description: 'Installed software name' },
          version: { type: 'string', description: 'update: Windows version pin; uninstall: the version to remove' },
          packageId: { type: 'string', description: 'update: winget package id (Windows)' },
        },
        required: ['action', 'deviceId', 'name'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as DeviceSoftwareAction;
      if (!DEVICE_SOFTWARE_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const mfa = mfaGatedToolError('manage_device_software', action, auth);
      if (mfa) return mfa;
      const parsed = softwareActionPayloadSchema.safeParse({
        name: input.name,
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(action === 'update' && input.packageId !== undefined ? { packageId: input.packageId } : {}),
      });
      if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input', 'VALIDATION_ERROR');
      const data = parsed.data;

      try {
        const access = await verifyDeviceAccess(String(input.deviceId), auth);
        if ('error' in access) return notFound('Device');
        const device = access.device;
        if (device.status === 'decommissioned') {
          return jsonError('Cannot send commands to a decommissioned device', 'VALIDATION_ERROR');
        }
        const isWindows = device.osType === 'windows';
        if (action === 'update' && data.version && !isWindows) {
          return jsonError(
            `Version pinning is only supported on Windows endpoints; this device runs ${device.osType}. Retry without a version to upgrade to the latest.`,
            'VALIDATION_ERROR',
          );
        }
        // Same payload as the route (routes/devices/softwareActions.ts): packageId is forwarded only on Windows updates.
        const payload: Record<string, unknown> = { name: data.name, source: 'ai_tool' };
        if (data.version) payload.version = data.version;
        if (action === 'update' && data.packageId && isWindows) payload.packageId = data.packageId;
        const type = action === 'update' ? CommandTypes.SOFTWARE_UPDATE : CommandTypes.SOFTWARE_UNINSTALL;
        const command = await aiQueueCommand(auth, 'manage_device_software', device.id, type, payload, auth.user.id);
        auditToolWrite(auth, {
          orgId: device.orgId,
          action: `device.software.${action}.queue`,
          resourceType: 'device',
          resourceId: device.id,
          resourceName: device.hostname,
          details: { commandId: command.id, softwareName: data.name, softwareVersion: data.version ?? null },
        });
        return json({ queued: true, commandId: command.id, deviceId: device.id, action, name: data.name, version: data.version ?? null });
      } catch (error) {
        if (error instanceof RemoteToolsDisabledByPolicyError) return jsonError(error.message, 'POLICY_DENIED');
        return thrown('manage_device_software', error);
      }
    },
  });

  aiTools.set('bootstrap_homebrew', {
    tier: 3,
    domain: 'patching',
    searchHint: 'install Homebrew on a Mac so brew packages can be deployed',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'bootstrap_homebrew',
      description: 'Install Homebrew on one Mac (pinned, verified installer; needs a signed-in admin user). Needed before Homebrew deployments. Needs approval.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Device UUID (macOS)' },
        },
        required: ['deviceId'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const mfa = mfaGatedToolError('bootstrap_homebrew', undefined, auth);
      if (mfa) return mfa;
      try {
        const access = await verifyDeviceAccess(String(input.deviceId), auth);
        if ('error' in access) return notFound('Device');
        const device = access.device;
        if (device.status === 'decommissioned') {
          return jsonError('Cannot send commands to a decommissioned device', 'VALIDATION_ERROR');
        }
        if (device.osType !== 'macos') {
          return jsonError(`Homebrew is macOS-only; this device runs ${device.osType}`, 'NOT_SUPPORTED');
        }
        const payload = homebrewBootstrapPayload();
        const command = await aiQueueCommand(auth, 'bootstrap_homebrew', device.id, CommandTypes.HOMEBREW_BOOTSTRAP, payload, auth.user.id);
        auditToolWrite(auth, {
          orgId: device.orgId,
          action: 'device.homebrew_bootstrap',
          resourceType: 'device',
          resourceId: device.id,
          resourceName: device.hostname,
          details: { commandId: command.id, installerUrl: payload.installerUrl, installerSha256: payload.installerSha256 },
        });
        return json({ queued: true, commandId: command.id, deviceId: device.id });
      } catch (error) {
        if (error instanceof RemoteToolsDisabledByPolicyError) return jsonError(error.message, 'POLICY_DENIED');
        return thrown('bootstrap_homebrew', error);
      }
    },
  });
}

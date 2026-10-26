/**
 * `manage_recovery_keys` (full-control W11, #6781): the AI twin of
 * GET /security/encryption/devices/:deviceId/recovery-keys and its `rotate` and
 * `collect` POSTs.
 *
 * `reveal` (plaintext BitLocker / FileVault key) is human-only and is ABSENT
 * from this tool: not an action, not an enum member, no code path reads
 * `encrypted_key` here (aiToolSchemas.securityPolicy.test.ts pins both).
 *
 *  - `list` (t1): key metadata only, as REST. The reveal ledger is reduced to
 *    action + key + time: the tool never returns which staff member revealed a
 *    key (quorum QW8; REST shows names and emails).
 *  - `rotate` (supervised): queues `encryption_rotate_key`. Windows only
 *    (W11-D9): macOS rotation needs a FileVault user's password or the current
 *    recovery key, and credentials never travel through chat. `volumeMount`
 *    defaults only when exactly one volume is escrowed, as REST.
 *  - `collect` (supervised): queues `encryption_collect_keys` (the agent
 *    re-escrows its current keys).
 *
 * Device scope is the central `deviceArgs` gate (org + site + exact device +
 * not parked) plus `verifyDeviceAccess` here. Commands go through
 * `aiQueueCommand`, which stamps the AI origin and applies the AI remote-tools
 * policy; the requesting user id is passed positionally to `queueCommand`,
 * which degrades a non-`users` id to NULL (`resolveCommandCreatedBy`).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { deviceRecoveryKeys, recoveryKeyAccessEvents } from '../db/schema';
import type { AiTool } from './aiTools';
import { verifyDeviceAccess } from './aiTools';
import { aiQueueCommand } from './aiDispatch';
import { CommandTypes } from './commandTypes';
import { RemoteToolsDisabledByPolicyError } from './aiRemoteToolsPolicy';
import { RECOVERY_KEY_ACTIONS } from './aiToolSchemasSecurityPolicy';
import { auditToolWrite, bounded, json, jsonError, notFound, requireFields, str, thrown } from './aiToolsSecurityPolicyShared';

type Action = (typeof RECOVERY_KEY_ACTIONS)[number];
const TOOL = 'manage_recovery_keys';
const VOLUME_MOUNT = /^[A-Za-z]:$/;

export function registerRecoveryKeyTools(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1,
    domain: 'security',
    searchHint: 'BitLocker / FileVault recovery keys: escrow status, rotate a Windows key, re-collect keys from a device',
    deviceArgs: ['deviceId'],
    definition: {
      name: TOOL,
      description:
        'Disk-encryption recovery keys for one device. Actions: list (escrow metadata, never the key), rotate (Windows; volumeMount), collect (re-escrow current keys). Rotate and collect need approval. The key itself is only shown in the Breeze web app.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...RECOVERY_KEY_ACTIONS], description: 'The action to perform' },
          deviceId: { type: 'string', description: 'Device UUID' },
          volumeMount: { type: 'string', description: 'rotate: Windows volume such as C: (optional when exactly one volume is escrowed)' },
        },
        required: ['action', 'deviceId'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!RECOVERY_KEY_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const missing = requireFields(input, ['deviceId'], action);
      if (missing) return missing;

      try {
        const access = await verifyDeviceAccess(String(input.deviceId), auth);
        if ('error' in access) return notFound('Device');
        const device = access.device;

        if (action === 'list') {
          const keys = await db
            .select({
              id: deviceRecoveryKeys.id,
              keyType: deviceRecoveryKeys.keyType,
              volumeMount: deviceRecoveryKeys.volumeMount,
              protectorId: deviceRecoveryKeys.protectorId,
              status: deviceRecoveryKeys.status,
              escrowedAt: deviceRecoveryKeys.escrowedAt,
              supersededAt: deviceRecoveryKeys.supersededAt,
            })
            .from(deviceRecoveryKeys)
            .where(eq(deviceRecoveryKeys.deviceId, device.id))
            .orderBy(desc(deviceRecoveryKeys.escrowedAt))
            .limit(50);
          const keyIds = keys.map((k) => k.id);
          const accessHistory = keyIds.length
            ? await db
              .select({ keyId: recoveryKeyAccessEvents.keyId, action: recoveryKeyAccessEvents.action, createdAt: recoveryKeyAccessEvents.createdAt })
              .from(recoveryKeyAccessEvents)
              .where(inArray(recoveryKeyAccessEvents.keyId, keyIds))
              .orderBy(desc(recoveryKeyAccessEvents.createdAt))
              .limit(25)
            : [];
          return bounded({ device: { id: device.id, hostname: device.hostname, os: device.osType }, keys, accessHistory });
        }

        if (action === 'rotate') {
          const os = (device.osType ?? '').toLowerCase();
          if (os !== 'windows') {
            return jsonError(
              os === 'macos' || os === 'darwin'
                ? 'FileVault key rotation needs a FileVault user\'s password or the current recovery key; do it from the Breeze web app'
                : `Recovery key rotation is not supported on ${device.osType}`,
              'NOT_SUPPORTED',
            );
          }
          let volumeMount = str(input.volumeMount);
          if (volumeMount && !VOLUME_MOUNT.test(volumeMount)) return jsonError('volumeMount must be a drive letter such as C:', 'VALIDATION_ERROR');
          if (!volumeMount) {
            const escrowed = await db
              .select({ volumeMount: deviceRecoveryKeys.volumeMount })
              .from(deviceRecoveryKeys)
              .where(and(eq(deviceRecoveryKeys.deviceId, device.id), eq(deviceRecoveryKeys.status, 'active')));
            const mounts = [...new Set(escrowed.map((r) => r.volumeMount).filter((m): m is string => !!m))];
            if (mounts.length !== 1) {
              return jsonError(
                mounts.length === 0
                  ? 'volumeMount is required: no escrowed volume was found for this device'
                  : `volumeMount is required: this device has several escrowed volumes (${mounts.join(', ')})`,
                'VALIDATION_ERROR',
              );
            }
            volumeMount = mounts[0]!;
          }
          const command = await aiQueueCommand(auth, TOOL, device.id, CommandTypes.ENCRYPTION_ROTATE_KEY, { volumeMount }, auth.user.id);
          auditToolWrite(auth, {
            orgId: device.orgId, action: 'device.recovery_key.rotate', resourceType: 'device', resourceId: device.id,
            resourceName: device.hostname, details: { os, volumeMount },
          });
          return json({ queued: true, commandId: command.id, deviceId: device.id, volumeMount });
        }

        // collect
        const command = await aiQueueCommand(auth, TOOL, device.id, CommandTypes.ENCRYPTION_COLLECT_KEYS, {}, auth.user.id);
        auditToolWrite(auth, {
          orgId: device.orgId, action: 'device.recovery_key.collect', resourceType: 'device', resourceId: device.id, resourceName: device.hostname,
        });
        return json({ queued: true, commandId: command.id, deviceId: device.id });
      } catch (error) {
        if (error instanceof RemoteToolsDisabledByPolicyError) return jsonError(error.message, 'POLICY_DENIED');
        return thrown(TOOL, error);
      }
    },
  });
}

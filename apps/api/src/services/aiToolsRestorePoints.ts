/**
 * AI System Restore ledger tools (#8584, follow-up to #4759 W08 of #4751).
 *
 * - list_device_restore_point_attempts (Tier 1): newest-first page of the
 *   System Restore checkpoints Breeze requested on one device and what the
 *   device reported back.
 *
 * Same ledger and same field allowlist as the console route
 * (`routes/devices/restorePoints.ts`). The ledger records what Breeze asked for
 * and what the device observed — never a promise that a restore point still
 * exists or can be restored — so the output says so.
 */

import { and, desc, eq, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  deviceRestorePointAttempts,
  RESTORE_POINT_ATTEMPT_STATUSES,
  RESTORE_POINT_ATTEMPT_TRIGGERS,
  type RestorePointAttemptStatus,
  type RestorePointAttemptTrigger,
} from '../db/schema/deviceRestorePointAttempts';
import { sanitizeUntrustedText } from './aiInputSanitizer';
import { pageEnvelope, pageParamSchema, readPageArgs } from './aiToolPagination';
import type { AiTool } from './aiTools';
import { verifyDeviceAccess } from './aiTools';

// No module-level constants are read at registration time: this module and
// `./aiTools` import each other, and `aiTools.ts` calls
// `registerRestorePointTools` while this module may still be initialising
// (a top-level `const` read here would throw a TDZ ReferenceError).
function freeText(value: string | null): string | null {
  // Agent-reported free text (redacted at ingest) is still untrusted model input.
  return value === null ? null : sanitizeUntrustedText(value, 500);
}

export function registerRestorePointTools(aiTools: Map<string, AiTool>): void {
  const name = 'list_device_restore_point_attempts';
  const defaultLimit = 20;
  const maxLimit = 50;
  const ledgerNote =
    'Each row records a System Restore checkpoint Breeze requested before a patch, script or software install, and what the device reported. ' +
    "It is not a guarantee that a restore point exists or can be restored (Windows may purge it later). Status 'requested' means the device has not reported yet.";

  aiTools.set(name, {
    tier: 1,
    domain: 'devices',
    deviceArgs: ['deviceId'],
    searchHint: 'Windows System Restore checkpoints requested before patches, scripts and software installs',
    definition: {
      name,
      description:
        'List the Windows System Restore checkpoints Breeze requested on a device before a patch, script or software install, newest first, with the outcome the device reported. Records attempts, not a guarantee a restore point still exists.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          trigger: {
            type: 'string',
            enum: [...RESTORE_POINT_ATTEMPT_TRIGGERS],
            description: 'Only attempts requested before this kind of action',
          },
          status: {
            type: 'string',
            enum: [...RESTORE_POINT_ATTEMPT_STATUSES],
            description: "Only attempts with this outcome ('requested' = no device report yet)",
          },
          ...pageParamSchema(defaultLimit, maxLimit),
        },
        required: ['deviceId'],
      },
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const page = readPageArgs(name, input, { defaultLimit, maxLimit });
      if (!page.ok) return JSON.stringify({ error: page.error, code: page.code });

      // The central deviceArgs gate already ran this; repeated here so the
      // handler is safe on its own (direct registry callers, tests).
      const access = await verifyDeviceAccess(deviceId, auth);
      if ('error' in access) return JSON.stringify({ error: access.error });

      const t = deviceRestorePointAttempts;
      const conditions: SQL[] = [eq(t.deviceId, deviceId)];
      // Defense in depth on top of RLS and the device check.
      const orgCond = auth.orgCondition(t.orgId);
      if (orgCond) conditions.push(orgCond);
      if (typeof input.trigger === 'string') {
        conditions.push(eq(t.trigger, input.trigger as RestorePointAttemptTrigger));
      }
      if (typeof input.status === 'string') {
        conditions.push(eq(t.status, input.status as RestorePointAttemptStatus));
      }

      // One extra row tells pageEnvelope whether another page exists.
      const rows = await db
        .select({
          requestId: t.requestId,
          trigger: t.trigger,
          status: t.status,
          policyRevision: t.policyRevision,
          requestedAt: t.requestedAt,
          attemptedAt: t.attemptedAt,
          receivedAt: t.receivedAt,
          sequenceNumber: t.sequenceNumber,
          description: t.description,
          message: t.message,
          acceptedExistingPoint: t.acceptedExistingPoint,
          existingPointAgeMinutes: t.existingPointAgeMinutes,
          frequencyMinutes: t.frequencyMinutes,
          durationMs: t.durationMs,
          scriptExecutionId: t.scriptExecutionId,
          softwareDeploymentId: t.softwareDeploymentId,
          patchJobId: t.patchJobId,
        })
        .from(t)
        .where(and(...conditions))
        .orderBy(desc(t.requestedAt), desc(t.requestId))
        .limit(page.limit + 1)
        .offset(page.offset);

      // Explicit allowlist, never a spread: orgId/deviceCommandId stay internal
      // and a column added to the ledger later is not exposed by accident.
      const attempts = rows.map((r) => ({
        requestId: r.requestId,
        trigger: r.trigger,
        status: r.status,
        policyRevision: r.policyRevision,
        requestedAt: r.requestedAt,
        attemptedAt: r.attemptedAt,
        receivedAt: r.receivedAt,
        // bigint: JSON.stringify throws on it and Number() rounds past 2^53.
        sequenceNumber: r.sequenceNumber?.toString() ?? null,
        description: freeText(r.description),
        message: freeText(r.message),
        acceptedExistingPoint: r.acceptedExistingPoint,
        existingPointAgeMinutes: r.existingPointAgeMinutes,
        frequencyMinutes: r.frequencyMinutes,
        durationMs: r.durationMs,
        scriptExecutionId: r.scriptExecutionId,
        softwareDeploymentId: r.softwareDeploymentId,
        patchJobId: r.patchJobId,
      }));

      return JSON.stringify({
        deviceId,
        note: ledgerNote,
        ...pageEnvelope({
          key: 'attempts',
          items: attempts,
          limit: page.limit,
          offset: page.offset,
          fingerprint: page.fingerprint,
        }),
      });
    },
  });
}

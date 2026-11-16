import { Hono } from 'hono';
import { and, eq, ne, sql } from 'drizzle-orm';

import { db } from '../../db';
import { deviceHardware, devices } from '../../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { notParkedDeviceCondition } from '../../services/unassignedPool/selectorPredicate';
import { PG_UUID_REGEX } from '../../utils/uuid';
import { buildDeviceScope } from './scope';

/**
 * GET /devices/tpm-coverage[?orgId=] — how much of the fleet is "ready for
 * reinstall" (#8318 T1; spec 2026-10-12 §12.2): devices with a recorded TPM
 * EK baseline, out of the devices the caller sees in the device list
 * (`buildDeviceScope`, on top of RLS), decommissioned and parked rows left
 * out. One statement.
 *
 *   attested     an EK baseline is recorded (wave T2 can prove continuity)
 *   noTpm        the agent reports no usable TPM: only hints will ever apply
 *   notAttested  everything else: an agent that has not attested yet, or
 *                has not reported (older agents, macOS)
 *   ekMismatch   of the attested, those that later proved a DIFFERENT EK:
 *                the baseline is kept and the new key waits for an
 *                operator's review (a replaced motherboard, or a forged key)
 */
export const tpmCoverageRoutes = new Hono();

tpmCoverageRoutes.use('/tpm-coverage', authMiddleware);

export type TpmCoverage = { devices: number; attested: number; noTpm: number; notAttested: number; ekMismatch: number };

tpmCoverageRoutes.get(
  '/tpm-coverage',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const orgId = c.req.query('orgId');
    if (orgId !== undefined && !PG_UUID_REGEX.test(orgId)) return c.json({ error: 'orgId must be a UUID' }, 400);
    const scoped = buildDeviceScope(c.get('auth'), c.get('permissions') as UserPermissions | undefined, orgId);
    if ('forbidden' in scoped) return c.json({ error: 'Access to this organization denied' }, 403);
    const empty: TpmCoverage = { devices: 0, attested: 0, noTpm: 0, notAttested: 0, ekMismatch: 0 };
    if (!('scope' in scoped)) return c.json({ coverage: empty });

    const [row] = await db
      .select({
        devices: sql<number>`count(*)::int`,
        attested: sql<number>`count(*) FILTER (WHERE ${deviceHardware.tpmEkPubSha256} IS NOT NULL)::int`,
        noTpm: sql<number>`count(*) FILTER (WHERE ${deviceHardware.tpmEkPubSha256} IS NULL AND ${deviceHardware.tpmAvailable} = false)::int`,
        ekMismatch: sql<number>`count(*) FILTER (WHERE ${deviceHardware.tpmEkMismatchSha256} IS NOT NULL)::int`,
      })
      .from(devices)
      .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
      .where(and(scoped.scope, ne(devices.status, 'decommissioned'), notParkedDeviceCondition()));
    const total = Number(row?.devices ?? 0);
    const attested = Number(row?.attested ?? 0);
    const noTpm = Number(row?.noTpm ?? 0);
    const ekMismatch = Number(row?.ekMismatch ?? 0);
    return c.json({ coverage: { devices: total, attested, noTpm, notAttested: total - attested - noTpm, ekMismatch } satisfies TpmCoverage });
  },
);

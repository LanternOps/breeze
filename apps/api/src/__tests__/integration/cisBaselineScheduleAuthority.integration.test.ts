/**
 * Stored execution authority for recurring CIS baseline scans, against real
 * Postgres:
 *   - the shape CHECK rejects a partial envelope;
 *   - the live resolver admits only an approver who still holds devices:execute,
 *     and never a legacy (unstamped) row;
 *   - the migration returns undispatched approved remediation actions to
 *     pending approval, and is idempotent.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { cisBaselines, cisRemediationActions, devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { captureSystemSensitiveDataAuthority } from '../../services/sensitiveDataPolicyAuthority';
import {
  captureCisBaselineAuthority,
  resolveCisBaselineScheduleAuthority,
} from '../../services/cisBaselineScheduleAuthority';
import { createOrganization, createPartner, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-12-12-120000-cis-schedule-execution-authority.sql',
);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdBaselines: string[] = [];
const createdDevices: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdDevices.length > 0) {
      await db.delete(cisRemediationActions).where(inArray(cisRemediationActions.deviceId, createdDevices));
      await db.delete(devices).where(inArray(devices.id, createdDevices));
    }
    if (createdBaselines.length > 0) {
      await db.delete(cisBaselines).where(inArray(cisBaselines.id, createdBaselines));
    }
  });
  createdBaselines.length = 0;
  createdDevices.length = 0;
});

const BASE = {
  name: 'Windows L1',
  osType: 'windows' as const,
  benchmarkVersion: '3.0.0',
  level: 'l1' as const,
  customExclusions: [],
  scanSchedule: { enabled: true, intervalHours: 24, nextScanAt: null },
  isActive: true,
};

function orgAuth(env: Awaited<ReturnType<typeof setupTestEnvironment>>): AuthContext {
  return {
    scope: 'organization',
    user: env.user,
    orgId: env.organization.id,
    partnerId: env.partner.id,
    partnerOrgAccess: null,
    accessibleOrgIds: [env.organization.id],
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => id === env.organization.id,
  } as unknown as AuthContext;
}

async function insertBaseline(values: Record<string, unknown>) {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(cisBaselines).values({ ...BASE, ...values } as typeof cisBaselines.$inferInsert).returning());
  createdBaselines.push(row!.id);
  return row!;
}

describe('cis_baselines stored execution authority', () => {
  it('rejects a partial authority envelope (shape CHECK)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await expect(withDbAccessContext(SYSTEM_CTX, () => db.insert(cisBaselines).values({
      ...BASE,
      orgId: org.id,
      executionAuthorityVersion: 1,
      executionAuthorityGeneration: crypto.randomUUID(),
    }).returning())).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('resolves only an approver who still holds devices:execute, never a legacy row', async () => {
    const executor = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'execute' }],
    });
    const writerOnly = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'write' }],
    });

    const approved = await insertBaseline({
      orgId: executor.organization.id,
      ...captureCisBaselineAuthority(orgAuth(executor), { orgId: executor.organization.id, partnerId: null })!,
    });
    const stampedByWriter = await insertBaseline({
      orgId: writerOnly.organization.id,
      ...captureCisBaselineAuthority(orgAuth(writerOnly), { orgId: writerOnly.organization.id, partnerId: null })!,
    });
    const legacy = await insertBaseline({ orgId: executor.organization.id });

    const resolved = await withDbAccessContext(SYSTEM_CTX, async () => ({
      approved: await resolveCisBaselineScheduleAuthority(approved),
      stampedByWriter: await resolveCisBaselineScheduleAuthority(stampedByWriter),
      legacy: await resolveCisBaselineScheduleAuthority(legacy),
    }));

    expect(resolved.approved).toMatchObject({
      userId: executor.user.id,
      generation: approved.executionAuthorityGeneration,
    });
    expect(resolved.stampedByWriter).toBeNull();
    expect(resolved.legacy).toBeNull();
  });

  it('accepts a partner-wide envelope only on a partner-owned row', async () => {
    const partner = await createPartner();
    const row = await insertBaseline({
      orgId: null,
      partnerId: partner.id,
      ...captureSystemSensitiveDataAuthority({ orgId: null, partnerId: partner.id }),
    });
    const resolved = await withDbAccessContext(SYSTEM_CTX, () => resolveCisBaselineScheduleAuthority(row));
    expect(resolved).toMatchObject({ kind: 'partner_unrestricted' });
  });

  it('migration returns undispatched approved remediation actions to pending approval, idempotently', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const suffix = crypto.randomUUID().slice(0, 8);
    const [device] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(devices).values({
      orgId: env.organization.id, siteId: env.site.id, agentId: `cis-auth-${suffix}`,
      hostname: `cis-auth-${suffix}`, osType: 'windows', osVersion: '11',
      architecture: 'x64', agentVersion: '1.0.0', status: 'online',
    }).returning({ id: devices.id }));
    createdDevices.push(device!.id);

    const base = {
      orgId: env.organization.id,
      deviceId: device!.id,
      action: 'apply',
      approvalStatus: 'approved' as const,
      approvedBy: env.user.id,
      approvedAt: new Date(),
      requestedBy: env.user.id,
      details: { source: 'api' },
    };
    const inserted = await withDbAccessContext(SYSTEM_CTX, () => db.insert(cisRemediationActions).values([
      { ...base, checkId: 'undispatched', status: 'queued' as const },
      { ...base, checkId: 'dispatched', status: 'in_progress' as const, commandId: crypto.randomUUID() },
      { ...base, checkId: 'pending', status: 'pending_approval' as const, approvalStatus: 'pending' as const, approvedBy: null, approvedAt: null },
    ]).returning({ id: cisRemediationActions.id }));

    const readStates = () => withDbAccessContext(SYSTEM_CTX, () => db
      .select({
        checkId: cisRemediationActions.checkId,
        status: cisRemediationActions.status,
        approvalStatus: cisRemediationActions.approvalStatus,
        approvedBy: cisRemediationActions.approvedBy,
      })
      .from(cisRemediationActions)
      .where(inArray(cisRemediationActions.id, inserted.map((r) => r.id))));

    const expected = [
      { checkId: 'dispatched', status: 'in_progress', approvalStatus: 'approved', approvedBy: env.user.id },
      { checkId: 'pending', status: 'pending_approval', approvalStatus: 'pending', approvedBy: null },
      { checkId: 'undispatched', status: 'pending_approval', approvalStatus: 'pending', approvedBy: null },
    ];

    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    await getTestDb().execute(sql.raw(migration));
    expect((await readStates()).sort((a, b) => a.checkId.localeCompare(b.checkId))).toEqual(expected);

    await getTestDb().execute(sql.raw(migration));
    expect((await readStates()).sort((a, b) => a.checkId.localeCompare(b.checkId))).toEqual(expected);

    const [undispatched] = await withDbAccessContext(SYSTEM_CTX, () => db
      .select({ details: cisRemediationActions.details })
      .from(cisRemediationActions)
      .where(eq(cisRemediationActions.id, inserted[0]!.id)));
    expect(undispatched?.details).toMatchObject({ source: 'api', returnedForReapprovalAt: expect.any(String) });
  });
});

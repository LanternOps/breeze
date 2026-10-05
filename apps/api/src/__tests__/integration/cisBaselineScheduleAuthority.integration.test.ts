/**
 * Stored execution authority for recurring CIS baseline scans, against real
 * Postgres:
 *   - the shape CHECK rejects a partial envelope;
 *   - the live resolver admits only an approver who still holds devices:execute,
 *     and never a legacy (unstamped) row;
 *   - legacy rows are grandfathered on a creator who holds devices:execute
 *     and downgraded otherwise; a stamped row is never legacy; the migration
 *     never re-grandfathers on replay.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { cisBaselines, cisRemediationActions, devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { captureSystemSensitiveDataAuthority } from '../../services/sensitiveDataPolicyAuthority';
import {
  captureCisBaselineAuthority,
  resolveCisBaselineScheduleAuthority,
  resolveCisScheduleDispatch,
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

  it('grandfathers a legacy row on a creator with devices:execute and downgrades one whose creator lacks it', async () => {
    const executor = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'execute' }],
    });
    const writerOnly = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'write' }],
    });
    const kept = await insertBaseline({
      orgId: executor.organization.id, createdBy: executor.user.id, executionAuthorityLegacy: 'grandfathered',
    });
    const downgraded = await insertBaseline({
      orgId: writerOnly.organization.id, createdBy: writerOnly.user.id, executionAuthorityLegacy: 'grandfathered',
    });

    const decisions = await withDbAccessContext(SYSTEM_CTX, async () => ({
      kept: await resolveCisScheduleDispatch(kept),
      downgraded: await resolveCisScheduleDispatch(downgraded),
    }));
    expect(decisions.kept).toMatchObject({ ok: true, mode: 'legacy', authority: { userId: executor.user.id } });
    expect(decisions.downgraded).toEqual({
      ok: false, reason: 'reapproval_required', revokeLegacy: true, checkStatus: 'approver_invalid',
    });
  });

  it('a stamped row cannot also be on the legacy path (CHECK)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await expect(withDbAccessContext(SYSTEM_CTX, () => db.insert(cisBaselines).values({
      ...BASE,
      orgId: org.id,
      ...captureSystemSensitiveDataAuthority({ orgId: org.id, partnerId: null }),
      executionAuthorityLegacy: 'grandfathered',
    }).returning())).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('migration replay never re-grandfathers a row that left the legacy path', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const left = await insertBaseline({ orgId: org.id, executionAuthorityLegacy: null });
    const revoked = await insertBaseline({ orgId: org.id, executionAuthorityLegacy: 'revoked' });

    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    await getTestDb().execute(sql.raw(migration));
    await getTestDb().execute(sql.raw(migration));

    const rows = await withDbAccessContext(SYSTEM_CTX, () => db
      .select({ id: cisBaselines.id, legacy: cisBaselines.executionAuthorityLegacy })
      .from(cisBaselines)
      .where(inArray(cisBaselines.id, [left.id, revoked.id])));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.legacy]))).toEqual({
      [left.id]: null,
      [revoked.id]: 'revoked',
    });
  });
});

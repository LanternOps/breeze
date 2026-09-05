import '../__tests__/integration/setup';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from './index';
import { auditRetentionPolicies, organizations } from './schema';
import { createOrganization, createPartner } from '../__tests__/integration/db-utils';
import { getAppDb, getTestDb } from '../__tests__/integration/setup';
import { pruneExpiredAuditLogs } from '../jobs/auditRetention';

const migration = readFileSync(new URL('../../migrations/2026-10-09-000201-default-org-audit-retention.sql', import.meta.url), 'utf8');
const policies = (orgId: string) => getTestDb().select().from(auditRetentionPolicies).where(eq(auditRetentionPolicies.orgId, orgId));

function orgValues(partnerId: string, id = randomUUID()) {
  return { id, partnerId, name: 'Retention default', slug: `retention-${id}`, currencyCode: 'USD' };
}

describe('new organization audit retention defaults', () => {
  it('seeds every org in an app-role system transaction, including bulk creates', async () => {
    const partner = await createPartner();
    const created = await withSystemDbAccessContext(() => db.insert(organizations)
      .values([orgValues(partner.id), orgValues(partner.id)]).returning());
    for (const org of created) {
      expect(await policies(org.id)).toEqual([expect.objectContaining({
        orgId: org.id, retentionDays: 365, archiveToS3: false, lastCleanupAt: null,
      })]);
    }
  });

  it('honors the same org access predicate as the organization insert', async () => {
    const partner = await createPartner();
    const values = orgValues(partner.id);
    await withDbAccessContext({ scope: 'partner', orgId: null, userId: null,
      accessibleOrgIds: [values.id], accessiblePartnerIds: [partner.id] }, async () => {
      await db.insert(organizations).values(values);
      expect(await db.select().from(auditRetentionPolicies)).toHaveLength(1);
    });
    const inaccessible = orgValues(partner.id);
    await expect(withDbAccessContext({ scope: 'partner', orgId: null, userId: null,
      accessibleOrgIds: [], accessiblePartnerIds: [partner.id] }, () =>
      db.insert(organizations).values(inaccessible))).rejects.toThrow();
    expect(await policies(inaccessible.id)).toEqual([]);
    await expect(getAppDb().insert(auditRetentionPolicies).values({ orgId: values.id }))
      .rejects.toMatchObject({ cause: { code: '42501', message: expect.stringContaining('row-level security') } });
  });

  it('rolls back the default with its organization when creation fails', async () => {
    const partner = await createPartner();
    const values = orgValues(partner.id);
    await expect(withSystemDbAccessContext(async () => {
      await db.insert(organizations).values(values);
      throw new Error('later onboarding step failed');
    })).rejects.toThrow('later onboarding step failed');
    expect(await policies(values.id)).toEqual([]);
    expect(await getTestDb().select().from(organizations).where(eq(organizations.id, values.id))).toEqual([]);
  });

  it('preserves existing settings and missing policies when the migration is reapplied', async () => {
    const partner = await createPartner();
    const configured = await createOrganization({ partnerId: partner.id });
    const missing = await createOrganization({ partnerId: partner.id });
    await getTestDb().update(auditRetentionPolicies).set({ retentionDays: 730, archiveToS3: true })
      .where(eq(auditRetentionPolicies.orgId, configured.id));
    await getTestDb().delete(auditRetentionPolicies).where(eq(auditRetentionPolicies.orgId, missing.id));
    const before = await policies(configured.id);
    await getTestDb().execute(sql.raw(migration));
    await getTestDb().execute(sql.raw(migration));
    expect(await policies(configured.id)).toEqual(before);
    expect(await policies(missing.id)).toEqual([]);
    const fresh = await createOrganization({ partnerId: partner.id });
    expect(await policies(fresh.id)).toHaveLength(1);
    await getTestDb().insert(organizations).values(orgValues(partner.id, configured.id)).onConflictDoNothing();
    expect(await policies(configured.id)).toEqual(before);
  });

  it('removes its owned default when an otherwise empty organization is deleted', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    expect(await policies(org.id)).toHaveLength(1);
    await withSystemDbAccessContext(() => db.delete(organizations).where(eq(organizations.id, org.id)));
    expect(await policies(org.id)).toEqual([]);
  });

  it('prunes expired logs from a fresh org without saving retention settings', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await getTestDb().execute(sql`
      INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
      VALUES (${org.id}, 'system', gen_random_uuid(), 'expired', 'test', 'success', now() - interval '366 days'),
             (${org.id}, 'system', gen_random_uuid(), 'recent', 'test', 'success', now() - interval '364 days')
    `);
    const stats = await pruneExpiredAuditLogs();
    expect(stats.errors).toBe(0);
    expect(stats.rowsDeleted).toBe(1);
    expect(await getTestDb().execute(sql`SELECT action FROM audit_logs WHERE org_id = ${org.id}`))
      .toEqual([expect.objectContaining({ action: 'recent' })]);
  });
});

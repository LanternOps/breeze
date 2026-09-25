/**
 * monitor_conversions / monitor_conversion_outputs — live RLS, XOR ownership,
 * the partner-wide SELECT branch and the owner-axis composite FKs
 * (#6370 W05c1 ledger, verified by #6371 W05c2 Task 18).
 *
 * Shipped by 2026-10-23-110000-monitor-conversions.sql, identically on both tables:
 *   *_isolation              FOR ALL     system OR breeze_has_org_access(org_id)
 *                                        OR breeze_has_partner_access(partner_id)
 *   *_partner_wide_select    FOR SELECT  org_id IS NULL
 *                                        AND partner_id = breeze_current_partner_id()
 *   *_one_owner_chk          CHECK       exactly one of org_id / partner_id
 *   outputs (conversion_id, org_id|partner_id) → conversions(id, org_id|partner_id)
 *
 * rls-coverage.integration.test.ts proves the policies EXIST. Only driving the
 * real connection as `breeze_app` under FORCE RLS proves they enforce anything.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { monitorConversionOutputs, monitorConversions } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/** Org-scoped session. `currentPartnerId` is what the partner-wide SELECT branch keys on. */
function orgContext(orgId: string, currentPartnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

const createdConversionIds: string[] = [];

afterEach(async () => {
  const ids = [...new Set(createdConversionIds)];
  createdConversionIds.length = 0;
  if (ids.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, () =>
    db.delete(monitorConversions).where(inArray(monitorConversions.id, ids)),
  );
});

async function fixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  return { partnerA: partnerA.id, partnerB: partnerB.id, orgA: orgA.id, orgB: orgB.id };
}

function ledger(over: Partial<typeof monitorConversions.$inferInsert>) {
  return {
    orgId: null,
    partnerId: null,
    sourceTable: 'config_policy_alert_rules' as const,
    sourceId: randomUUID(),
    previewHash: 'test-hash',
    ...over,
  };
}

async function insertLedger(ctx: DbAccessContext, over: Partial<typeof monitorConversions.$inferInsert>) {
  const [row] = await withDbAccessContext(ctx, () =>
    db.insert(monitorConversions).values(ledger(over)).returning(),
  );
  createdConversionIds.push(row!.id);
  return row!;
}

describe('conversion ledger live RLS', () => {
  it('allows own-org writes and denies cross-org and cross-partner forges on both tables', async () => {
    const f = await fixture();
    const ctxA = orgContext(f.orgA, f.partnerA);

    // Positive control: the owner can write and read both tables.
    const row = await insertLedger(ctxA, { orgId: f.orgA });
    const outputs = await withDbAccessContext(ctxA, () =>
      db.insert(monitorConversionOutputs)
        .values({ conversionId: row.id, orgId: f.orgA, role: 'primary' })
        .returning(),
    );
    expect(outputs).toHaveLength(1);
    const own = await withDbAccessContext(ctxA, () =>
      db.select().from(monitorConversions).where(eq(monitorConversions.id, row.id)),
    );
    expect(own).toHaveLength(1);

    for (const ctx of [orgContext(f.orgB, f.partnerB), partnerContext(f.partnerB, [f.orgB])]) {
      await expectSqlState(
        () => withDbAccessContext(ctx, () => db.insert(monitorConversions).values(ledger({ orgId: f.orgA }))),
        '42501',
      );
      await expectSqlState(
        () => withDbAccessContext(ctx, () =>
          db.insert(monitorConversionOutputs).values({ conversionId: row.id, orgId: f.orgA, role: 'primary' }),
        ),
        '42501',
      );
      const visible = await withDbAccessContext(ctx, async () => ({
        ledger: await db.select().from(monitorConversions).where(eq(monitorConversions.id, row.id)),
        outputs: await db.select().from(monitorConversionOutputs)
          .where(eq(monitorConversionOutputs.conversionId, row.id)),
      }));
      expect(visible).toEqual({ ledger: [], outputs: [] });
      const tampered = await withDbAccessContext(ctx, () =>
        db.update(monitorConversions).set({ previewHash: 'forged' })
          .where(eq(monitorConversions.id, row.id)).returning(),
      );
      expect(tampered).toEqual([]);
    }
  });

  it('shows partner-wide ledger rows to the partner org sessions for SELECT only, and to no other partner', async () => {
    const f = await fixture();
    const row = await insertLedger(partnerContext(f.partnerA, [f.orgA]), {
      partnerId: f.partnerA,
      sourceTable: 'automations',
    });
    const [output] = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA]), () =>
      db.insert(monitorConversionOutputs)
        .values({ conversionId: row.id, partnerId: f.partnerA, role: 'response' })
        .returning(),
    );

    await withDbAccessContext(orgContext(f.orgA, f.partnerA), async () => {
      expect(await db.select().from(monitorConversions).where(eq(monitorConversions.id, row.id))).toHaveLength(1);
      expect(
        await db.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.id, output!.id)),
      ).toHaveLength(1);
      // The SELECT branch must not widen UPDATE/DELETE targeting.
      expect(
        await db.update(monitorConversions).set({ previewHash: 'forged' })
          .where(eq(monitorConversions.id, row.id)).returning(),
      ).toEqual([]);
      expect(
        await db.delete(monitorConversionOutputs).where(eq(monitorConversionOutputs.id, output!.id)).returning(),
      ).toEqual([]);
    });

    // Nor may an org session author a partner-wide row.
    await expectSqlState(
      () => withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
        db.insert(monitorConversions).values(ledger({ partnerId: f.partnerA })),
      ),
      '42501',
    );
    await expectSqlState(
      () => withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
        db.insert(monitorConversionOutputs).values({ conversionId: row.id, partnerId: f.partnerA, role: 'primary' }),
      ),
      '42501',
    );
    await expectSqlState(
      () => withDbAccessContext(partnerContext(f.partnerB, [f.orgB]), () =>
        db.insert(monitorConversions).values(ledger({ partnerId: f.partnerA })),
      ),
      '42501',
    );

    for (const ctx of [orgContext(f.orgB, f.partnerB), partnerContext(f.partnerB, [f.orgB])]) {
      const visible = await withDbAccessContext(ctx, async () => ({
        ledger: await db.select().from(monitorConversions).where(eq(monitorConversions.id, row.id)),
        outputs: await db.select().from(monitorConversionOutputs)
          .where(eq(monitorConversionOutputs.id, output!.id)),
      }));
      expect(visible).toEqual({ ledger: [], outputs: [] });
    }
  });

  it('pins an output to its conversion owner through the composite FKs, even in system scope', async () => {
    const f = await fixture();
    const partnerRow = await insertLedger(SYSTEM_CTX, { partnerId: f.partnerA, sourceTable: 'automations' });
    const orgRow = await insertLedger(SYSTEM_CTX, { orgId: f.orgA, sourceTable: 'automations' });
    const insertOutput = (values: typeof monitorConversionOutputs.$inferInsert) =>
      withDbAccessContext(SYSTEM_CTX, () => db.insert(monitorConversionOutputs).values(values));

    // Positive controls: matching owners insert.
    await insertOutput({ conversionId: partnerRow.id, partnerId: f.partnerA, role: 'primary' });
    await insertOutput({ conversionId: orgRow.id, orgId: f.orgA, role: 'primary' });

    await expectSqlState(() => insertOutput({ conversionId: partnerRow.id, partnerId: f.partnerB, role: 'primary' }), '23503');
    await expectSqlState(() => insertOutput({ conversionId: orgRow.id, orgId: f.orgB, role: 'primary' }), '23503');
    await expectSqlState(() => insertOutput({ conversionId: orgRow.id, partnerId: f.partnerA, role: 'primary' }), '23503');
    await expectSqlState(() => insertOutput({ conversionId: partnerRow.id, orgId: f.orgA, role: 'primary' }), '23503');
  });

  it('enforces exactly one owner on both tables and cascades outputs with their conversion', async () => {
    const f = await fixture();
    for (const axes of [{ orgId: null, partnerId: null }, { orgId: f.orgA, partnerId: f.partnerA }]) {
      await expectSqlState(
        () => withDbAccessContext(SYSTEM_CTX, () => db.insert(monitorConversions).values(ledger(axes))),
        '23514',
      );
    }

    const ctxA = orgContext(f.orgA, f.partnerA);
    const row = await insertLedger(ctxA, { orgId: f.orgA });
    for (const axes of [{ orgId: null, partnerId: null }, { orgId: f.orgA, partnerId: f.partnerA }]) {
      await expectSqlState(
        () => withDbAccessContext(SYSTEM_CTX, () =>
          db.insert(monitorConversionOutputs).values({ conversionId: row.id, role: 'primary', ...axes }),
        ),
        '23514',
      );
    }

    await withDbAccessContext(ctxA, async () => {
      await db.insert(monitorConversionOutputs).values({ conversionId: row.id, orgId: f.orgA, role: 'primary' });
      expect(
        await db.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.conversionId, row.id)),
      ).toHaveLength(1);
      await db.delete(monitorConversions).where(eq(monitorConversions.id, row.id));
      expect(
        await db.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.conversionId, row.id)),
      ).toEqual([]);
    });
  });
});

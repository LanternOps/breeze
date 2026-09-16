/**
 * network_monitors / network_monitor_results — live RLS, XOR ownership, the
 * partner-wide SELECT branch, and the scheduler fan-out
 * (#5287 W04, CLAUDE.md "Partner-Wide First" step 6).
 *
 * Reshaped by 2026-10-16-181300-monitor-coverage-kinds.sql:
 *   network_monitors_isolation              FOR ALL     system OR breeze_has_org_access(org_id)
 *                                                       OR breeze_has_partner_access(partner_id)
 *   network_monitors_partner_wide_select    FOR SELECT  org_id IS NULL
 *                                                       AND partner_id = breeze_current_partner_id()
 *   network_monitors_one_owner_chk          CHECK       (org_id IS NULL) <> (partner_id IS NULL)
 *   network_monitor_results_isolation       FOR ALL     system OR breeze_has_org_access(org_id)
 *
 * `rls-coverage.integration.test.ts` proves these policies EXIST by reading
 * pg_catalog. It cannot prove any of them ENFORCES anything — only driving the
 * real postgres.js connection as `breeze_app` under FORCE RLS does, which is
 * what this suite is for.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { networkMonitorResults, networkMonitors } from '../../db/schema';
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
function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<unknown> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
  return raised;
}

const createdPartnerIds: string[] = [];
const createdOrgIds: string[] = [];

afterEach(async () => {
  const partnerIds = [...new Set(createdPartnerIds)];
  const orgIds = [...new Set(createdOrgIds)];
  createdPartnerIds.length = 0;
  createdOrgIds.length = 0;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (orgIds.length > 0) {
      await db.delete(networkMonitorResults).where(inArray(networkMonitorResults.orgId, orgIds));
      await db.delete(networkMonitors).where(inArray(networkMonitors.orgId, orgIds));
    }
    if (partnerIds.length > 0) {
      await db.delete(networkMonitors).where(inArray(networkMonitors.partnerId, partnerIds));
    }
  });
});

async function fixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: partnerA.id });
  const orgA2 = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  createdPartnerIds.push(partnerA.id, partnerB.id);
  createdOrgIds.push(orgA1.id, orgA2.id, orgB.id);
  return { partnerA: partnerA.id, partnerB: partnerB.id, orgA1: orgA1.id, orgA2: orgA2.id, orgB: orgB.id };
}

function monitorValues(over: Partial<typeof networkMonitors.$inferInsert>) {
  return {
    name: `check-${Math.random().toString(36).slice(2, 10)}`,
    monitorType: 'icmp_ping' as const,
    target: '10.0.0.1',
    ...over,
  };
}

const seedPartnerWide = (partnerId: string) =>
  withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(networkMonitors)
      .values(monitorValues({ partnerId, orgId: null }))
      .returning({ id: networkMonitors.id }),
  );

const seedOrgOwned = (orgId: string) =>
  withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(networkMonitors)
      .values(monitorValues({ orgId, partnerId: null }))
      .returning({ id: networkMonitors.id }),
  );

describe('network_monitors RLS — dual-axis (#5291 W04)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });

  describe('XOR ownership', () => {
    it('rejects a row owning BOTH axes (23514)', async () => {
      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db
              .insert(networkMonitors)
              .values(monitorValues({ orgId: f.orgA1, partnerId: f.partnerA }))
              .returning(),
          ),
        '23514',
      );
    });

    it('rejects an OWNERLESS row (23514)', async () => {
      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db
              .insert(networkMonitors)
              .values(monitorValues({ orgId: null, partnerId: null }))
              .returning(),
          ),
        '23514',
      );
    });
  });

  // #5751 W03 (#5754). The app layer is designed never to violate these, so
  // without a live-DB case a typo in either CHECK expression would ship
  // silently — the unit test only proves the text is in the migration file,
  // not that Postgres accepts the good shapes and rejects the bad ones.
  describe('TLS observation CHECKs', () => {
    const OBSERVED = {
      tlsState: 'observed',
      tlsNotAfter: new Date('2027-01-02T03:04:05Z'),
      tlsObservedAt: new Date('2026-09-14T00:00:00Z'),
      tlsObservedHost: 'a.example:443',
      tlsIssuer: 'CN=Example CA',
    };

    const insertMonitor = (over: Partial<typeof networkMonitors.$inferInsert>) =>
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(networkMonitors)
          .values(monitorValues({ orgId: f.orgA1, partnerId: null, ...over }))
          .returning({ id: networkMonitors.id }),
      );

    it('accepts a complete observed row (positive control)', async () => {
      // Without this, a CHECK that rejected EVERY row would still leave the
      // rejection cases below passing — for the wrong reason.
      expect(await insertMonitor(OBSERVED)).toHaveLength(1);
    });

    it('accepts all-NULL — "never observed under the current agent"', async () => {
      expect(await insertMonitor({})).toHaveLength(1);
    });

    it('accepts handshake_failed with no certificate values', async () => {
      expect(await insertMonitor({
        tlsState: 'handshake_failed',
        tlsObservedAt: new Date(),
        tlsObservedHost: 'broken.example',
      })).toHaveLength(1);
    });

    it('rejects an unknown tls_state (23514 — network_monitors_tls_state_chk)', async () => {
      await expectSqlState(() => insertMonitor({ ...OBSERVED, tlsState: 'totally_bogus' }), '23514');
    });

    it.each([
      ['tlsNotAfter', { tlsNotAfter: null }],
      ['tlsObservedAt', { tlsObservedAt: null }],
      ['tlsObservedHost', { tlsObservedHost: null }],
    ] as const)(
      'rejects an observed row missing %s (23514 — network_monitors_tls_observed_shape_chk)',
      async (_field, over) => {
        // All three legs matter: an "observed" row without one of them would
        // let loadExpiringCerts emit a finding that names no endpoint, or
        // order by a NULL expiry.
        await expectSqlState(() => insertMonitor({ ...OBSERVED, ...over }), '23514');
      },
    );
  });

  describe('write policy — forges', () => {
    it('partner A can insert its own partner-wide check (positive control)', async () => {
      // Without this, a policy that denied EVERY partner insert would still
      // leave the cross-partner forge below passing — for the wrong reason.
      const rows = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA1, f.orgA2]), () =>
        db
          .insert(networkMonitors)
          .values(monitorValues({ partnerId: f.partnerA, orgId: null }))
          .returning({ id: networkMonitors.id }),
      );
      expect(rows).toHaveLength(1);
    });

    it('FORGE: partner B cannot insert a partner-wide check for partner A (42501)', async () => {
      await expectSqlState(
        () =>
          withDbAccessContext(partnerContext(f.partnerB, [f.orgB]), () =>
            db
              .insert(networkMonitors)
              .values(monitorValues({ partnerId: f.partnerA, orgId: null }))
              .returning(),
          ),
        '42501',
      );
    });

    it('FORGE: an ORG token cannot insert a partner-wide row for its OWN partner — the SELECT branch grants no write (42501)', async () => {
      await expectSqlState(
        () =>
          withDbAccessContext(orgContext(f.orgA1, f.partnerA), () =>
            db
              .insert(networkMonitors)
              .values(monitorValues({ orgId: null, partnerId: f.partnerA }))
              .returning(),
          ),
        '42501',
      );
    });

    it('FORGE: an ORG token cannot UPDATE the partner-wide row it can READ', async () => {
      const [seeded] = await seedPartnerWide(f.partnerA);
      const updated = await withDbAccessContext(orgContext(f.orgA1, f.partnerA), () =>
        db
          .update(networkMonitors)
          .set({ target: '10.9.9.9' })
          .where(eq(networkMonitors.id, seeded!.id))
          .returning({ id: networkMonitors.id }),
      );
      // UPDATE row targeting never consults a FOR SELECT policy, so the row is
      // simply invisible to the UPDATE and nothing is written.
      expect(updated).toHaveLength(0);
    });
  });

  describe('read policy — the partner-wide SELECT branch', () => {
    it('an org token sees its OWN org rows and its PARTNER-WIDE rows, and not a sibling org\'s', async () => {
      const [mine] = await seedOrgOwned(f.orgA1);
      const [sibling] = await seedOrgOwned(f.orgA2);
      const [partnerWide] = await seedPartnerWide(f.partnerA);

      const visible = await withDbAccessContext(orgContext(f.orgA1, f.partnerA), () =>
        db.select({ id: networkMonitors.id }).from(networkMonitors),
      );
      const ids = visible.map((r) => r.id);

      expect(ids).toContain(mine!.id);
      expect(ids).toContain(partnerWide!.id);
      expect(ids).not.toContain(sibling!.id);
    });

    it('an org token under a DIFFERENT partner cannot see partner A\'s partner-wide row', async () => {
      const [partnerWide] = await seedPartnerWide(f.partnerA);

      const visible = await withDbAccessContext(orgContext(f.orgB, f.partnerB), () =>
        db.select({ id: networkMonitors.id }).from(networkMonitors),
      );
      expect(visible.map((r) => r.id)).not.toContain(partnerWide!.id);
    });

    it('without currentPartnerId the branch grants nothing — it is LOAD-BEARING, not decorative', async () => {
      // This is the failure mode the branch exists to prevent: an agent context
      // missing the GUC sees no partner-wide config AT ALL, with no error.
      const [partnerWide] = await seedPartnerWide(f.partnerA);

      const visible = await withDbAccessContext(orgContext(f.orgA1, null), () =>
        db.select({ id: networkMonitors.id }).from(networkMonitors),
      );
      expect(visible.map((r) => r.id)).not.toContain(partnerWide!.id);
    });
  });

  describe('network_monitor_results — Shape 1 after W04', () => {
    it('a result row is visible to its OWN org and invisible to a sibling org', async () => {
      const [partnerWide] = await seedPartnerWide(f.partnerA);
      await withDbAccessContext(SYSTEM_CTX, () =>
        db.insert(networkMonitorResults).values({
          monitorId: partnerWide!.id,
          orgId: f.orgA1,
          status: 'offline',
        }),
      );

      const mine = await withDbAccessContext(orgContext(f.orgA1, f.partnerA), () =>
        db.select({ id: networkMonitorResults.id }).from(networkMonitorResults),
      );
      const sibling = await withDbAccessContext(orgContext(f.orgA2, f.partnerA), () =>
        db.select({ id: networkMonitorResults.id }).from(networkMonitorResults),
      );

      expect(mine).toHaveLength(1);
      // Same partner-wide PARENT, different org — the old EXISTS-join policy
      // could not tell these apart at all, because the parent has no org.
      expect(sibling).toHaveLength(0);
    });

    it('FORGE: org A cannot write a result stamped with org B (42501)', async () => {
      const [partnerWide] = await seedPartnerWide(f.partnerA);
      await expectSqlState(
        () =>
          withDbAccessContext(orgContext(f.orgA1, f.partnerA), () =>
            db
              .insert(networkMonitorResults)
              .values({ monitorId: partnerWide!.id, orgId: f.orgB, status: 'offline' })
              .returning(),
          ),
        '42501',
      );
    });
  });
});

describe('partner-wide fan-out against real Postgres (#5291 W04)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });

  it('a partner-wide check expands to ONE JOB PER ORG under its partner', async () => {
    const [partnerWide] = await seedPartnerWide(f.partnerA);
    const [orgOwned] = await seedOrgOwned(f.orgB);

    // `selectDueMonitorJobs` is the scheduler's whole read half — real SQL,
    // real rows, real RLS, no Redis. `lastChecked` is NULL on a freshly seeded
    // row, so both checks are due immediately.
    const { selectDueMonitorJobs } = await import('../../jobs/monitorWorker');
    const jobs = await selectDueMonitorJobs();

    const forPartnerWide = jobs.filter((j) => j.monitorId === partnerWide!.id);
    expect(forPartnerWide.map((j) => j.orgId).sort()).toEqual([f.orgA1, f.orgA2].sort());

    const forOrgOwned = jobs.filter((j) => j.monitorId === orgOwned!.id);
    expect(forOrgOwned).toEqual([{ monitorId: orgOwned!.id, orgId: f.orgB }]);
  });
});

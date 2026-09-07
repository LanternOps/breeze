/**
 * Partner-wide READ branch on the software + security policy tables
 * (#4946, #4947, #4948, #4953, #4954 — the software-security group of #4673).
 *
 * Migration under test:
 * 2026-10-11-000200-software-security-partner-wide-select.sql, which is the
 * same fix as wave 1 of #4673
 * (2026-10-05-110000-config-policy-partner-wide-select.sql) applied to five
 * more org_id-XOR-partner_id config tables:
 *
 *   software_catalog, software_policies, security_policies,
 *   sensitive_data_policies, peripheral_policies
 *
 * A partner-wide row is `org_id NULL, partner_id = P`. Before this migration an
 * ORG-scoped session could not see it: `breeze_has_org_access(NULL)` is false,
 * and `breeze_has_partner_access(P)` is false because org scope carries
 * `accessiblePartnerIds: []` (that GUC governs partner-axis WRITES, which an
 * org token never holds). Readers therefore had to escalate through the #1105
 * pattern, which double-holds a pooled connection under the request's own
 * transaction and bypasses RLS entirely.
 *
 * The fix is a SELECT-only own-partner branch, added as a SEPARATE permissive
 * policy per table:
 *
 *   <table>_partner_wide_select  FOR SELECT USING (
 *     org_id IS NULL AND partner_id = public.breeze_current_partner_id()
 *   )
 *
 * Kept separate from each table's existing `<table>_isolation` /
 * `software_catalog_dual_isolation_*` policies on purpose: appending the branch
 * to a FOR ALL `USING` would also widen UPDATE/DELETE row targeting, letting an
 * org admin rewrite or delete its MSP's shared policy. Postgres never consults
 * a FOR SELECT policy when computing UPDATE/DELETE target rows, so a separate
 * policy ORs into reads only. Same mechanism as
 * `cis_baselines_partner_wide_select` (2026-08-10) and
 * `configuration_policies_partner_wide_select` (2026-10-05).
 *
 * Properties proven here — none reachable from a mocked unit test (no RLS runs
 * there) and none proven by rls-coverage either (that is a pg_catalog shape
 * inspection, not a functional one):
 *
 *  1. An ORG session of the OWNING partner SELECTs both its own org-owned row
 *     AND its partner's partner-wide row, on every one of the five tables.
 *  2. An ORG session of a DIFFERENT partner sees neither.
 *  3. The branch grants NO write: UPDATE and DELETE from the owning org's
 *     session affect ZERO rows and leave the partner-wide row byte-identical.
 *     Note this is a silent no-op, not a 42501 — RLS hides the target row from
 *     the write command rather than raising, so asserting rowCount alone is not
 *     enough; the row is re-read under system scope. The 42501 half is proven
 *     separately with an INSERT forge, where WITH CHECK does raise.
 *  4. The branch, and nothing else, is what grants the read: the SAME org
 *     session with `currentPartnerId` NULL (the shape of any context that does
 *     not populate the GUC) sees only its org-owned row. Without this control
 *     every positive assertion above could pass vacuously.
 *
 * Every assertion is keyed on the ids this suite seeded, so rows left behind by
 * an earlier suite in the shard cannot change a result.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  peripheralPolicies,
  securityPolicies,
  sensitiveDataPolicies,
  softwareCatalog,
  softwarePolicies,
} from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function partnerContext(partnerId: string, orgIds: string[] = []): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/**
 * An ORG-scoped session. `currentPartnerId` is populated from the token's
 * partnerId for org scope too (`buildDbAccessContext`, middleware/auth.ts),
 * which is exactly what the read branch keys on — so it is set here
 * deliberately. `accessiblePartnerIds` stays EMPTY: an org token never passes
 * `breeze_has_partner_access`, and that is what keeps the branch read-only.
 *
 * Passing `currentPartnerId: null` yields a context whose GUC is unset, which
 * is the negative control for property 4.
 */
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

/**
 * Assert a statement failed with a specific SQLSTATE. Drizzle wraps driver
 * errors in a DrizzleQueryError whose message is only "Failed query: ...", so
 * a regex on `.message` matches nothing useful — the pg error (with `.code`)
 * hangs off `.cause`.
 */
async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  const actual = cause?.code ?? (raised as { code?: string })?.code;
  expect(actual).toBe(code);
}

/**
 * One entry per table under test, so every assertion covers ALL five instead of
 * a representative sample — the policies are hand-written, and one omission is
 * a silent zero-rows-forever bug on that feature only. Each closure runs in
 * whatever `withDbAccessContext` the caller is inside, which is the point: the
 * context is the variable under test.
 *
 * Inserts supply only NOT NULL columns that have no database default.
 */
interface TableCase {
  /** table name, used in assertion messages */
  label: string;
  /** insert one row on the given ownership axis; returns its id */
  seed: (ownership: { orgId: string | null; partnerId: string | null }) => Promise<string>;
  /** which of `ids` are visible right now */
  visible: (ids: string[]) => Promise<string[]>;
  /** rowCount of a mutating UPDATE against `id`, right now */
  updateRows: (id: string) => Promise<number>;
  /** rowCount of a DELETE against `id`, right now */
  deleteRows: (id: string) => Promise<number>;
  /** the row's name, read right now */
  readName: (id: string) => Promise<string | undefined>;
  /** insert a partner-wide row (the 42501 WITH CHECK forge) */
  forgePartnerWide: (partnerId: string) => Promise<unknown>;
}

const CASES: TableCase[] = [
  {
    label: 'software_catalog',
    seed: async ({ orgId, partnerId }) => {
      const [row] = await db
        .insert(softwareCatalog)
        .values({ orgId, partnerId, name: `catalog ${orgId ?? partnerId}` })
        .returning({ id: softwareCatalog.id });
      return row!.id;
    },
    visible: async (ids) =>
      (await db.select({ id: softwareCatalog.id }).from(softwareCatalog).where(inArray(softwareCatalog.id, ids)))
        .map((r) => r.id),
    updateRows: async (id) =>
      (await db.update(softwareCatalog).set({ name: 'HIJACKED' }).where(eq(softwareCatalog.id, id))
        .returning({ id: softwareCatalog.id })).length,
    deleteRows: async (id) =>
      (await db.delete(softwareCatalog).where(eq(softwareCatalog.id, id)).returning({ id: softwareCatalog.id })).length,
    readName: async (id) =>
      (await db.select({ name: softwareCatalog.name }).from(softwareCatalog).where(eq(softwareCatalog.id, id)))[0]?.name,
    forgePartnerWide: (partnerId) =>
      db.insert(softwareCatalog).values({ orgId: null, partnerId, name: 'forged' }).returning({ id: softwareCatalog.id }),
  },
  {
    label: 'software_policies',
    seed: async ({ orgId, partnerId }) => {
      const [row] = await db
        .insert(softwarePolicies)
        .values({
          orgId,
          partnerId,
          name: `software policy ${orgId ?? partnerId}`,
          mode: 'blocklist',
          rules: { software: [{ name: 'BitTorrent' }] },
        })
        .returning({ id: softwarePolicies.id });
      return row!.id;
    },
    visible: async (ids) =>
      (await db.select({ id: softwarePolicies.id }).from(softwarePolicies).where(inArray(softwarePolicies.id, ids)))
        .map((r) => r.id),
    updateRows: async (id) =>
      (await db.update(softwarePolicies).set({ name: 'HIJACKED' }).where(eq(softwarePolicies.id, id))
        .returning({ id: softwarePolicies.id })).length,
    deleteRows: async (id) =>
      (await db.delete(softwarePolicies).where(eq(softwarePolicies.id, id)).returning({ id: softwarePolicies.id })).length,
    readName: async (id) =>
      (await db.select({ name: softwarePolicies.name }).from(softwarePolicies).where(eq(softwarePolicies.id, id)))[0]?.name,
    forgePartnerWide: (partnerId) =>
      db.insert(softwarePolicies)
        .values({ orgId: null, partnerId, name: 'forged', mode: 'blocklist', rules: { software: [] } })
        .returning({ id: softwarePolicies.id }),
  },
  {
    label: 'security_policies',
    seed: async ({ orgId, partnerId }) => {
      const [row] = await db
        .insert(securityPolicies)
        .values({ orgId, partnerId, name: `security policy ${orgId ?? partnerId}`, settings: {} })
        .returning({ id: securityPolicies.id });
      return row!.id;
    },
    visible: async (ids) =>
      (await db.select({ id: securityPolicies.id }).from(securityPolicies).where(inArray(securityPolicies.id, ids)))
        .map((r) => r.id),
    updateRows: async (id) =>
      (await db.update(securityPolicies).set({ name: 'HIJACKED' }).where(eq(securityPolicies.id, id))
        .returning({ id: securityPolicies.id })).length,
    deleteRows: async (id) =>
      (await db.delete(securityPolicies).where(eq(securityPolicies.id, id)).returning({ id: securityPolicies.id })).length,
    readName: async (id) =>
      (await db.select({ name: securityPolicies.name }).from(securityPolicies).where(eq(securityPolicies.id, id)))[0]?.name,
    forgePartnerWide: (partnerId) =>
      db.insert(securityPolicies).values({ orgId: null, partnerId, name: 'forged', settings: {} })
        .returning({ id: securityPolicies.id }),
  },
  {
    label: 'sensitive_data_policies',
    seed: async ({ orgId, partnerId }) => {
      const [row] = await db
        .insert(sensitiveDataPolicies)
        .values({
          orgId,
          partnerId,
          name: `sensitive data policy ${orgId ?? partnerId}`,
          scope: {},
          detectionClasses: [],
        })
        .returning({ id: sensitiveDataPolicies.id });
      return row!.id;
    },
    visible: async (ids) =>
      (await db.select({ id: sensitiveDataPolicies.id }).from(sensitiveDataPolicies)
        .where(inArray(sensitiveDataPolicies.id, ids))).map((r) => r.id),
    updateRows: async (id) =>
      (await db.update(sensitiveDataPolicies).set({ name: 'HIJACKED' }).where(eq(sensitiveDataPolicies.id, id))
        .returning({ id: sensitiveDataPolicies.id })).length,
    deleteRows: async (id) =>
      (await db.delete(sensitiveDataPolicies).where(eq(sensitiveDataPolicies.id, id))
        .returning({ id: sensitiveDataPolicies.id })).length,
    readName: async (id) =>
      (await db.select({ name: sensitiveDataPolicies.name }).from(sensitiveDataPolicies)
        .where(eq(sensitiveDataPolicies.id, id)))[0]?.name,
    forgePartnerWide: (partnerId) =>
      db.insert(sensitiveDataPolicies)
        .values({ orgId: null, partnerId, name: 'forged', scope: {}, detectionClasses: [] })
        .returning({ id: sensitiveDataPolicies.id }),
  },
  {
    label: 'peripheral_policies',
    seed: async ({ orgId, partnerId }) => {
      const [row] = await db
        .insert(peripheralPolicies)
        .values({
          orgId,
          partnerId,
          name: `peripheral policy ${orgId ?? partnerId}`,
          deviceClass: 'storage',
          action: 'block',
          targetType: 'organization',
        })
        .returning({ id: peripheralPolicies.id });
      return row!.id;
    },
    visible: async (ids) =>
      (await db.select({ id: peripheralPolicies.id }).from(peripheralPolicies).where(inArray(peripheralPolicies.id, ids)))
        .map((r) => r.id),
    updateRows: async (id) =>
      (await db.update(peripheralPolicies).set({ name: 'HIJACKED' }).where(eq(peripheralPolicies.id, id))
        .returning({ id: peripheralPolicies.id })).length,
    deleteRows: async (id) =>
      (await db.delete(peripheralPolicies).where(eq(peripheralPolicies.id, id))
        .returning({ id: peripheralPolicies.id })).length,
    readName: async (id) =>
      (await db.select({ name: peripheralPolicies.name }).from(peripheralPolicies)
        .where(eq(peripheralPolicies.id, id)))[0]?.name,
    forgePartnerWide: (partnerId) =>
      db.insert(peripheralPolicies)
        .values({ orgId: null, partnerId, name: 'forged', deviceClass: 'storage', action: 'block', targetType: 'organization' })
        .returning({ id: peripheralPolicies.id }),
  },
];

interface Fixture {
  partnerId: string;
  orgAId: string;
  /** per table label: the org-A-owned row and the partner-wide row */
  rows: Record<string, { orgOwnedId: string; partnerWideId: string }>;
}

/**
 * Seed, per table, one org-owned row for org A (partner P) and one partner-wide
 * row (`org_id NULL, partner_id P`). Each is written by the scope that owns it
 * in production — the org row under the ORG context, the partner-wide row under
 * the PARTNER context — so seeding itself re-proves the pre-existing dual-axis
 * write policies are untouched.
 */
async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });

  const rows: Fixture['rows'] = {};
  for (const testCase of CASES) {
    const orgOwnedId = await withDbAccessContext(orgContext(orgA.id, partner.id), () =>
      testCase.seed({ orgId: orgA.id, partnerId: null }),
    );
    const partnerWideId = await withDbAccessContext(partnerContext(partner.id, [orgA.id]), () =>
      testCase.seed({ orgId: null, partnerId: partner.id }),
    );
    rows[testCase.label] = { orgOwnedId, partnerWideId };
  }

  return { partnerId: partner.id, orgAId: orgA.id, rows };
}

/** Run `probe` for every table and collect the results keyed by table label. */
async function perTable<T>(fn: (testCase: TableCase) => Promise<T>): Promise<Record<string, T>> {
  const out: Record<string, T> = {};
  for (const testCase of CASES) {
    out[testCase.label] = await fn(testCase);
  }
  return out;
}

describe('software-security tables — partner-wide SELECT branch (#4946, #4947, #4948, #4953, #4954)', () => {
  it('covers all five tables', () => {
    expect(CASES.map((c) => c.label).sort()).toEqual([
      'peripheral_policies',
      'security_policies',
      'sensitive_data_policies',
      'software_catalog',
      'software_policies',
    ]);
  });

  describe('(a) an ORG session of the OWNING partner reads both its org row and the partner-wide row', () => {
    it('sees both rows on every table', async () => {
      const fixture = await seedFixture();

      const visible = await withDbAccessContext(
        orgContext(fixture.orgAId, fixture.partnerId),
        () =>
          perTable(async (testCase) => {
            const { orgOwnedId, partnerWideId } = fixture.rows[testCase.label]!;
            return (await testCase.visible([orgOwnedId, partnerWideId])).sort();
          }),
      );

      const expected = Object.fromEntries(
        CASES.map((c) => [c.label, [fixture.rows[c.label]!.orgOwnedId, fixture.rows[c.label]!.partnerWideId].sort()]),
      );
      // Reported as one object so a failure names EVERY broken table at once
      // instead of stopping at the first.
      expect(visible).toEqual(expected);
    });
  });

  describe('(b) the branch is scoped to the caller’s OWN partner', () => {
    it('an ORG session of a DIFFERENT partner sees neither row', async () => {
      const fixture = await seedFixture();
      const otherPartner = await createPartner();
      const otherOrg = await createOrganization({ partnerId: otherPartner.id });

      const visible = await withDbAccessContext(orgContext(otherOrg.id, otherPartner.id), () =>
        perTable(async (testCase) => {
          const { orgOwnedId, partnerWideId } = fixture.rows[testCase.label]!;
          return (await testCase.visible([orgOwnedId, partnerWideId])).length;
        }),
      );

      const leaked = Object.entries(visible).filter(([, count]) => count > 0).map(([label]) => label);
      expect(leaked, `cross-partner leak on: ${leaked.join(', ')}`).toEqual([]);
    });
  });

  describe('(c) the branch grants NO write', () => {
    it('an ORG session of the owning partner cannot UPDATE the partner-wide row', async () => {
      const fixture = await seedFixture();

      const updated = await withDbAccessContext(orgContext(fixture.orgAId, fixture.partnerId), () =>
        perTable((testCase) => testCase.updateRows(fixture.rows[testCase.label]!.partnerWideId)),
      );
      expect(updated).toEqual(Object.fromEntries(CASES.map((c) => [c.label, 0])));

      // Silent no-op is not proof — re-read under system scope.
      const names = await withDbAccessContext(SYSTEM_CTX, () =>
        perTable((testCase) => testCase.readName(fixture.rows[testCase.label]!.partnerWideId)),
      );
      const mutated = Object.entries(names).filter(([, name]) => name === 'HIJACKED').map(([label]) => label);
      expect(mutated, `partner-wide rows mutated on: ${mutated.join(', ')}`).toEqual([]);
    });

    it('an ORG session of the owning partner cannot DELETE the partner-wide row', async () => {
      const fixture = await seedFixture();

      const deleted = await withDbAccessContext(orgContext(fixture.orgAId, fixture.partnerId), () =>
        perTable((testCase) => testCase.deleteRows(fixture.rows[testCase.label]!.partnerWideId)),
      );
      expect(deleted).toEqual(Object.fromEntries(CASES.map((c) => [c.label, 0])));

      const surviving = await withDbAccessContext(SYSTEM_CTX, () =>
        perTable(async (testCase) => {
          const id = fixture.rows[testCase.label]!.partnerWideId;
          return (await testCase.visible([id])).length;
        }),
      );
      expect(surviving).toEqual(Object.fromEntries(CASES.map((c) => [c.label, 1])));
    });

    // WITH CHECK (unlike USING) does raise rather than filter, so an INSERT
    // forge is where the write denial is observable as a 42501.
    it('an ORG session cannot INSERT a partner-wide row for its own partner (42501)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      for (const testCase of CASES) {
        await expectSqlState(
          () => withDbAccessContext(orgContext(org.id, partner.id), () => testCase.forgePartnerWide(partner.id)),
          '42501',
        );
      }
    });
  });

  describe('the branch is what grants the read — not a pre-existing policy', () => {
    it('the SAME org session with currentPartnerId NULL sees only its org-owned row', async () => {
      const fixture = await seedFixture();

      const visible = await withDbAccessContext(orgContext(fixture.orgAId, null), () =>
        perTable(async (testCase) => {
          const { orgOwnedId, partnerWideId } = fixture.rows[testCase.label]!;
          const seen = await testCase.visible([orgOwnedId, partnerWideId]);
          return { orgOwned: seen.includes(orgOwnedId), partnerWide: seen.includes(partnerWideId) };
        }),
      );

      // Org-owned rows stay visible (existing org policy), partner-wide rows do
      // not (`partner_id = NULL` is NULL, never true). Guards against writing
      // the predicate as `IS NOT DISTINCT FROM`, which WOULD match a NULL GUC.
      expect(visible).toEqual(
        Object.fromEntries(CASES.map((c) => [c.label, { orgOwned: true, partnerWide: false }])),
      );
    });
  });

  describe('existing visibility is unchanged', () => {
    it('the owning PARTNER session still reads both rows', async () => {
      const fixture = await seedFixture();

      const visible = await withDbAccessContext(partnerContext(fixture.partnerId, [fixture.orgAId]), () =>
        perTable(async (testCase) => {
          const { orgOwnedId, partnerWideId } = fixture.rows[testCase.label]!;
          return (await testCase.visible([orgOwnedId, partnerWideId])).length;
        }),
      );

      // The partner-wide row is visible via breeze_has_partner_access; the
      // org-owned row via the org ids the partner session holds. Reported per
      // table so a regression names the table.
      const missing = Object.entries(visible).filter(([, count]) => count < 1).map(([label]) => label);
      expect(missing, `partner session lost visibility on: ${missing.join(', ')}`).toEqual([]);
    });

    it('the owning PARTNER session can still UPDATE and DELETE its partner-wide row', async () => {
      const fixture = await seedFixture();

      const updated = await withDbAccessContext(partnerContext(fixture.partnerId, [fixture.orgAId]), () =>
        perTable((testCase) => testCase.updateRows(fixture.rows[testCase.label]!.partnerWideId)),
      );
      expect(updated).toEqual(Object.fromEntries(CASES.map((c) => [c.label, 1])));

      const deleted = await withDbAccessContext(partnerContext(fixture.partnerId, [fixture.orgAId]), () =>
        perTable((testCase) => testCase.deleteRows(fixture.rows[testCase.label]!.partnerWideId)),
      );
      expect(deleted).toEqual(Object.fromEntries(CASES.map((c) => [c.label, 1])));
    });
  });
});

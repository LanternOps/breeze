/**
 * Partner-wide READ branch on the notification rails + maintenance windows
 * (#4673 wave 4 follow-ups #4955, #4956, #4957, #4958).
 *
 * Migration under test:
 * 2026-10-10-100100-notification-maintenance-partner-wide-select.sql.
 *
 * All four tables are the plain org_id-XOR-partner_id config shape: each row is
 * owned by EITHER an org (`org_id` set, `partner_id` NULL) OR a partner
 * (`org_id` NULL, `partner_id` set — "partner-wide / all orgs", epic #2135),
 * enforced by `<table>_one_owner_chk`, and each carries a SINGLE `FOR ALL`
 * policy (`<table>_isolation`) of the form
 *
 *   system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
 *          OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))
 *
 * An ORG-scoped session therefore could not see its own MSP's partner-wide
 * rows: `breeze_has_org_access(NULL)` is false, and
 * `breeze_has_partner_access(P)` is false because org scope carries
 * `accessiblePartnerIds: []` (that GUC governs partner-axis WRITES). Readers
 * had to escalate through the #1105 pattern
 * (`runOutsideDbContext(() => withSystemDbAccessContext(...))`), which
 * double-holds a pooled connection under the request's own transaction and
 * bypasses RLS entirely.
 *
 * The fix is a SELECT-only own-partner branch added as a SEPARATE permissive
 * policy per table (`<table>_partner_wide_select`), never an edit to the
 * existing FOR ALL one — appending the branch there would also widen
 * UPDATE/DELETE row targeting, letting an org admin rewrite or delete the
 * MSP's shared rail. Postgres never consults a FOR SELECT policy when
 * computing UPDATE/DELETE target rows, so a separate policy ORs into reads
 * only. Same mechanism as `cis_baselines_partner_wide_select` (2026-08-10) and
 * the configuration-policy chain (2026-10-05-110000).
 *
 * rls-coverage.integration.test.ts only inspects pg_catalog shape, so this
 * suite is the functional proof, through the real postgres.js driver
 * (`breeze_app`, FORCE ROW LEVEL SECURITY). Per table it asserts:
 *
 *  1. An org session of the OWNING partner SELECTs both its own org-owned row
 *     and the partner-wide row.
 *  2. An org session under a DIFFERENT partner sees neither.
 *  3. The branch grants NO write: UPDATE and DELETE of the partner-wide row
 *     from that same org session affect ZERO rows and leave the row intact.
 *     This is a silent no-op, not a 42501 — RLS hides the target row from the
 *     write command rather than raising — so assert rowCount AND re-read under
 *     system scope. A test that only asserted "it threw" would be vacuous.
 *     The 42501 half is proven separately via an INSERT forge, where WITH
 *     CHECK does raise.
 *  4. A NULL `currentPartnerId` GUC sees nothing: `partner_id = NULL` is NULL,
 *     never true. Guards against writing the predicate as
 *     `IS NOT DISTINCT FROM`, which WOULD match NULL-partner rows. This is NOT
 *     the agent shape — `middleware/agentAuth.ts` populates `currentPartnerId`
 *     from the device's partner (#4673 W02), so agents DO get the branch and it
 *     is load-bearing for partner-wide rails reaching devices at all.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  escalationPolicies,
  maintenanceWindows,
  notificationChannels,
  notificationRoutingRules,
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
 * Passing `currentPartnerId: null` yields a context no real token has — not
 * the agent shape (`middleware/agentAuth.ts` sets it from the device's
 * partner) — and exists only as the NULL-GUC negative control below.
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

interface Row {
  id: string;
  name: string;
}

/** `{ orgId, partnerId: null }` or `{ orgId: null, partnerId }` — the XOR. */
type Ownership =
  | { orgId: string; partnerId: null }
  | { orgId: null; partnerId: string };

/**
 * One entry per table under test. Each closure runs inside the caller's
 * `withDbAccessContext`, so the same probe set exercises every table under
 * every scope. Insert values are the NOT NULL columns only.
 *
 * Hand-written per table on purpose: the policies are hand-written per table,
 * and one omission is a silent zero-rows-forever bug on that feature alone.
 */
interface TableProbe {
  label: string;
  insert(ownership: Ownership, name: string): Promise<Row>;
  selectById(id: string): Promise<Row[]>;
  selectByIds(ids: string[]): Promise<Row[]>;
  updateName(id: string, name: string): Promise<Row[]>;
  deleteById(id: string): Promise<Row[]>;
  insertPartnerWide(partnerId: string): Promise<Row>;
}

const TABLES: TableProbe[] = [
  {
    label: 'notification_channels',
    insert: async (ownership, name) => {
      const [row] = await db
        .insert(notificationChannels)
        .values({ ...ownership, name, type: 'slack', config: {} })
        .returning({ id: notificationChannels.id, name: notificationChannels.name });
      return row!;
    },
    selectById: (id) =>
      db.select({ id: notificationChannels.id, name: notificationChannels.name })
        .from(notificationChannels).where(eq(notificationChannels.id, id)),
    selectByIds: (ids) =>
      db.select({ id: notificationChannels.id, name: notificationChannels.name })
        .from(notificationChannels).where(inArray(notificationChannels.id, ids)),
    updateName: (id, name) =>
      db.update(notificationChannels).set({ name }).where(eq(notificationChannels.id, id))
        .returning({ id: notificationChannels.id, name: notificationChannels.name }),
    deleteById: (id) =>
      db.delete(notificationChannels).where(eq(notificationChannels.id, id))
        .returning({ id: notificationChannels.id, name: notificationChannels.name }),
    insertPartnerWide: (partnerId) =>
      db.insert(notificationChannels)
        .values({ orgId: null, partnerId, name: 'forged', type: 'slack', config: {} })
        .returning({ id: notificationChannels.id, name: notificationChannels.name })
        .then((rows) => rows[0]!),
  },
  {
    label: 'notification_routing_rules',
    insert: async (ownership, name) => {
      const [row] = await db
        .insert(notificationRoutingRules)
        .values({ ...ownership, name, priority: 1, conditions: {}, channelIds: [] })
        .returning({ id: notificationRoutingRules.id, name: notificationRoutingRules.name });
      return row!;
    },
    selectById: (id) =>
      db.select({ id: notificationRoutingRules.id, name: notificationRoutingRules.name })
        .from(notificationRoutingRules).where(eq(notificationRoutingRules.id, id)),
    selectByIds: (ids) =>
      db.select({ id: notificationRoutingRules.id, name: notificationRoutingRules.name })
        .from(notificationRoutingRules).where(inArray(notificationRoutingRules.id, ids)),
    updateName: (id, name) =>
      db.update(notificationRoutingRules).set({ name }).where(eq(notificationRoutingRules.id, id))
        .returning({ id: notificationRoutingRules.id, name: notificationRoutingRules.name }),
    deleteById: (id) =>
      db.delete(notificationRoutingRules).where(eq(notificationRoutingRules.id, id))
        .returning({ id: notificationRoutingRules.id, name: notificationRoutingRules.name }),
    insertPartnerWide: (partnerId) =>
      db.insert(notificationRoutingRules)
        .values({ orgId: null, partnerId, name: 'forged', priority: 1, conditions: {}, channelIds: [] })
        .returning({ id: notificationRoutingRules.id, name: notificationRoutingRules.name })
        .then((rows) => rows[0]!),
  },
  {
    label: 'escalation_policies',
    insert: async (ownership, name) => {
      const [row] = await db
        .insert(escalationPolicies)
        .values({ ...ownership, name, steps: [] })
        .returning({ id: escalationPolicies.id, name: escalationPolicies.name });
      return row!;
    },
    selectById: (id) =>
      db.select({ id: escalationPolicies.id, name: escalationPolicies.name })
        .from(escalationPolicies).where(eq(escalationPolicies.id, id)),
    selectByIds: (ids) =>
      db.select({ id: escalationPolicies.id, name: escalationPolicies.name })
        .from(escalationPolicies).where(inArray(escalationPolicies.id, ids)),
    updateName: (id, name) =>
      db.update(escalationPolicies).set({ name }).where(eq(escalationPolicies.id, id))
        .returning({ id: escalationPolicies.id, name: escalationPolicies.name }),
    deleteById: (id) =>
      db.delete(escalationPolicies).where(eq(escalationPolicies.id, id))
        .returning({ id: escalationPolicies.id, name: escalationPolicies.name }),
    insertPartnerWide: (partnerId) =>
      db.insert(escalationPolicies)
        .values({ orgId: null, partnerId, name: 'forged', steps: [] })
        .returning({ id: escalationPolicies.id, name: escalationPolicies.name })
        .then((rows) => rows[0]!),
  },
  {
    label: 'maintenance_windows',
    insert: async (ownership, name) => {
      const [row] = await db
        .insert(maintenanceWindows)
        .values({
          ...ownership,
          name,
          startTime: new Date('2026-01-01T02:00:00Z'),
          endTime: new Date('2026-01-01T04:00:00Z'),
          targetType: 'all',
        })
        .returning({ id: maintenanceWindows.id, name: maintenanceWindows.name });
      return row!;
    },
    selectById: (id) =>
      db.select({ id: maintenanceWindows.id, name: maintenanceWindows.name })
        .from(maintenanceWindows).where(eq(maintenanceWindows.id, id)),
    selectByIds: (ids) =>
      db.select({ id: maintenanceWindows.id, name: maintenanceWindows.name })
        .from(maintenanceWindows).where(inArray(maintenanceWindows.id, ids)),
    updateName: (id, name) =>
      db.update(maintenanceWindows).set({ name }).where(eq(maintenanceWindows.id, id))
        .returning({ id: maintenanceWindows.id, name: maintenanceWindows.name }),
    deleteById: (id) =>
      db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, id))
        .returning({ id: maintenanceWindows.id, name: maintenanceWindows.name }),
    insertPartnerWide: (partnerId) =>
      db.insert(maintenanceWindows)
        .values({
          orgId: null,
          partnerId,
          name: 'forged',
          startTime: new Date('2026-01-01T02:00:00Z'),
          endTime: new Date('2026-01-01T04:00:00Z'),
          targetType: 'all',
        })
        .returning({ id: maintenanceWindows.id, name: maintenanceWindows.name })
        .then((rows) => rows[0]!),
  },
];

interface Seeded {
  partnerId: string;
  orgId: string;
  /** org-owned row (org_id = orgId, partner_id NULL) */
  orgRowId: string;
  orgRowName: string;
  /** partner-wide row (org_id NULL, partner_id = partnerId) */
  partnerRowId: string;
  partnerRowName: string;
}

const created: Array<{ probe: TableProbe; ids: string[] }> = [];

afterEach(async () => {
  if (created.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const { probe, ids } of created) {
      for (const id of ids) await probe.deleteById(id);
    }
  });
  created.length = 0;
});

function track(probe: TableProbe, id: string): void {
  const entry = created.find((c) => c.probe === probe);
  if (entry) entry.ids.push(id);
  else created.push({ probe, ids: [id] });
}

/**
 * Seed one org-owned row for org A (under the ORG context — the pre-existing
 * write path) and one partner-wide row for org A's partner P (under the
 * PARTNER context — the only scope that may write `org_id NULL` rows).
 */
async function seed(probe: TableProbe): Promise<Seeded> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });

  const orgRow = await withDbAccessContext(orgContext(org.id, partner.id), () =>
    probe.insert({ orgId: org.id, partnerId: null }, `org-owned ${probe.label}`),
  );
  track(probe, orgRow.id);

  const partnerRow = await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
    probe.insert({ orgId: null, partnerId: partner.id }, `partner-wide ${probe.label}`),
  );
  track(probe, partnerRow.id);

  return {
    partnerId: partner.id,
    orgId: org.id,
    orgRowId: orgRow.id,
    orgRowName: orgRow.name,
    partnerRowId: partnerRow.id,
    partnerRowName: partnerRow.name,
  };
}

describe.each(TABLES)('$label — partner-wide SELECT branch (#4673)', (probe) => {
  it('an ORG session of the OWNING partner SELECTs both its org-owned row and the partner-wide row', async () => {
    const seeded = await seed(probe);

    const visible = await withDbAccessContext(orgContext(seeded.orgId, seeded.partnerId), async () => ({
      orgRow: await probe.selectById(seeded.orgRowId),
      partnerRow: await probe.selectById(seeded.partnerRowId),
      both: await probe.selectByIds([seeded.orgRowId, seeded.partnerRowId]),
    }));

    expect(visible.orgRow.map((r) => r.id)).toEqual([seeded.orgRowId]);
    expect(
      visible.partnerRow.map((r) => r.id),
      `${probe.label}: the partner-wide row is invisible to an org session of its own partner — ` +
        'the FOR SELECT breeze_current_partner_id() branch is missing',
    ).toEqual([seeded.partnerRowId]);
    expect(visible.both).toHaveLength(2);
  });

  it('an ORG session under a DIFFERENT partner sees neither row', async () => {
    const seeded = await seed(probe);
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });

    const visible = await withDbAccessContext(orgContext(otherOrg.id, otherPartner.id), () =>
      probe.selectByIds([seeded.orgRowId, seeded.partnerRowId]),
    );

    expect(visible, `${probe.label}: cross-partner leak`).toEqual([]);
  });

  it('an ORG session of the owning partner cannot UPDATE the partner-wide row (0 rows)', async () => {
    const seeded = await seed(probe);

    const updated = await withDbAccessContext(orgContext(seeded.orgId, seeded.partnerId), () =>
      probe.updateName(seeded.partnerRowId, 'HIJACKED'),
    );
    expect(updated, `${probe.label}: the SELECT branch widened UPDATE row targeting`).toHaveLength(0);

    const [after] = await withDbAccessContext(SYSTEM_CTX, () => probe.selectById(seeded.partnerRowId));
    expect(after?.name).toBe(seeded.partnerRowName);
  });

  it('an ORG session of the owning partner cannot DELETE the partner-wide row (0 rows)', async () => {
    const seeded = await seed(probe);

    const deleted = await withDbAccessContext(orgContext(seeded.orgId, seeded.partnerId), () =>
      probe.deleteById(seeded.partnerRowId),
    );
    expect(deleted, `${probe.label}: the SELECT branch widened DELETE row targeting`).toHaveLength(0);

    const still = await withDbAccessContext(SYSTEM_CTX, () => probe.selectById(seeded.partnerRowId));
    expect(still).toHaveLength(1);
  });

  it('an ORG session cannot INSERT a partner-wide row for its own partner (42501)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    await expectSqlState(
      () => withDbAccessContext(orgContext(org.id, partner.id), () => probe.insertPartnerWide(partner.id)),
      '42501',
    );
  });

  it('a NULL currentPartnerId GUC sees no partner-wide row', async () => {
    const seeded = await seed(probe);

    const visible = await withDbAccessContext(orgContext(seeded.orgId, null), () =>
      probe.selectById(seeded.partnerRowId),
    );

    expect(visible, `${probe.label}: the branch fired on a NULL GUC — predicate must use '=' not IS NOT DISTINCT FROM`).toEqual([]);
  });

  it('the owning PARTNER session still reads and writes both rows', async () => {
    const seeded = await seed(probe);
    const ctx = partnerContext(seeded.partnerId, [seeded.orgId]);

    const visible = await withDbAccessContext(ctx, () =>
      probe.selectByIds([seeded.orgRowId, seeded.partnerRowId]),
    );
    expect(visible).toHaveLength(2);

    const updated = await withDbAccessContext(ctx, () =>
      probe.updateName(seeded.partnerRowId, 'renamed by partner'),
    );
    expect(updated).toHaveLength(1);

    const deleted = await withDbAccessContext(ctx, () => probe.deleteById(seeded.partnerRowId));
    expect(deleted).toHaveLength(1);
  });
});

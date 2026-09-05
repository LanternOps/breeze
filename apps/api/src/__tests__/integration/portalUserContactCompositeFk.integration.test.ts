/**
 * #3258 follow-up — `portal_users.contact_id` is same-org at the DATABASE level.
 *
 * W03 left `portal_users.contact_id` as the last PLAIN single-column FK into
 * `contacts`, so a login in org A pointing at a person in org B was
 * representable even though every writer happened to be org-bounded. That is
 * exactly the state W03's own ticket backfill had to defend against with an
 * `EXISTS ... AND c.org_id = t.org_id` guard, because such a row would have
 * proposed a cross-org `tickets.requester_contact_id` and aborted the whole
 * migration file.
 *
 * Only a real Postgres can prove the claims that matter:
 *
 *  1. A cross-org login/contact pair is REJECTED, on INSERT and on UPDATE, by
 *     `portal_users_contact_org_fk` — not by an app-layer check that a second
 *     writer could forget. The write itself is the test.
 *  2. Exactly ONE FK runs from `portal_users` to `contacts` afterwards, and it
 *     is the composite. (A surviving single-column FK would not re-open the
 *     hole — Postgres evaluates FK constraints conjunctively, so it is
 *     redundant, never permissive — but it would leave two SET NULL actions on
 *     one column and a second lock on `contacts`.)
 *  3. Deleting the contact still unlinks the login instead of failing, for the
 *     ORDINARY app role as well as the superuser. The column-list
 *     `ON DELETE SET NULL (contact_id)` is what makes that true; a bare
 *     composite SET NULL would try to null the NOT NULL `org_id`. The path
 *     that exercises it is the interactive `deleteContact`, NOT org erasure:
 *     `topologicalCascadeOrder()` counts every FK edge regardless of
 *     `confdeltype`, so this constraint makes `portal_users` a CHILD of
 *     `contacts` and it is deleted FIRST.
 *  4. Org MERGE keeps the link. Both tables re-tenant to the survivor in one
 *     transaction under `SET CONSTRAINTS ALL DEFERRED`, which only works
 *     because the constraint is DEFERRABLE — nulling the link there would
 *     silently destroy the customer's portal ownership of their own history.
 *  5. The migration is replayable; its cleanup really nulls a pre-existing
 *     drifted row; that cleanup is RLS-scoped by
 *     `set_config('breeze.scope','system')` and matches nothing without it;
 *     and it reports its count as a WARNING even when the count is zero.
 *
 * Fixtures are written with the admin/superuser handle, deliberately bypassing
 * the app-layer guards: the point is what the DATABASE refuses, which is what
 * makes those guards a nicety rather than the boundary. The two cases that are
 * ABOUT the unprivileged role say so and use `getAppDb()` / `db` instead.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { contacts, devices, organizations, partners, sites } from '../../db/schema';
import { portalUsers } from '../../db/schema/portal';
import { createOrganization, createPartner } from './db-utils';
import { getAppDb, getTestDb } from './setup';
import * as orgMergeModule from '../../services/orgMerge';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-04-100002-portal-users-contact-composite-fk.sql',
);
const migrationSql = () => readFileSync(MIGRATION_FILE, 'utf8');

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const admin = () => getTestDb() as any;

function orgCtx(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
  };
}

const seeded = { partnerIds: [] as string[], orgIds: [] as string[] };

let fx: { partnerId: string; orgId: string };

beforeEach(async () => {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  seeded.partnerIds.push(partner.id);
  seeded.orgIds.push(org.id);
  fx = { partnerId: partner.id, orgId: org.id };
});

afterAll(async () => {
  const db_ = admin();
  if (seeded.partnerIds.length === 0) return;
  const partnerList = sql.join(seeded.partnerIds.map((id) => sql`${id}`), sql`, `);
  const orgList = sql.join(seeded.orgIds.map((id) => sql`${id}`), sql`, `);

  await db_.delete(portalUsers).where(sql`${portalUsers.orgId} IN (${orgList})`);
  await db_.delete(contacts).where(sql`${contacts.orgId} IN (${orgList})`);
  await db_.execute(sql`DELETE FROM audit_logs WHERE org_id IN (${orgList})`);
  await db_.execute(sql`DELETE FROM org_merge_events WHERE partner_id IN (${partnerList})`);
  await db_.delete(devices).where(sql`${devices.orgId} IN (${orgList})`);
  await db_.delete(sites).where(sql`${sites.orgId} IN (${orgList})`);
  await db_.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await db_.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

/**
 * Every FK from `portal_users` to `contacts`, by name.
 *
 * The single source of truth for both "the composite exists" and "nothing
 * redundant survives" — and the restore-check after any test that drops the
 * constraint to forge a row it forbids, so a failed restore reports at its own
 * source instead of as a mystery failure three suites later.
 */
async function contactFkNames(): Promise<string[]> {
  const rows = (await admin().execute(sql`
    SELECT conname
      FROM pg_constraint
     WHERE contype = 'f'
       AND conrelid = 'portal_users'::regclass
       AND confrelid = 'contacts'::regclass
     ORDER BY conname
  `)) as unknown as Array<{ conname: string }>;
  return rows.map((r) => r.conname);
}

async function expectOnlyCompositeFk() {
  expect(await contactFkNames()).toEqual(['portal_users_contact_org_fk']);
}

/** A contact in `orgId`. */
async function seedContact(orgId: string, label = 'Person') {
  const suffix = uniqueSuffix();
  const [row] = await admin()
    .insert(contacts)
    .values({ orgId, email: `pu-fk-${suffix}@example.test`, name: label })
    .returning({ id: contacts.id });
  return row.id as string;
}

/** A portal LOGIN in `orgId`, optionally already linked to `contactId`. */
async function seedLogin(orgId: string, contactId: string | null = null) {
  const suffix = uniqueSuffix();
  const [row] = await admin()
    .insert(portalUsers)
    .values({
      orgId,
      email: `login-${suffix}@example.test`,
      name: 'Login Person',
      passwordHash: null,
      contactId,
    })
    .returning({ id: portalUsers.id });
  return row.id as string;
}

/** A second org under the same partner, registered for teardown. */
async function otherOrg() {
  const org = await createOrganization({ partnerId: fx.partnerId });
  seeded.orgIds.push(org.id);
  return org.id as string;
}

/**
 * Forge the cross-org drift the constraint forbids, run `body`, then put the
 * constraint back.
 *
 * Dropping it is the only way to reach this state — which is precisely the
 * state every database is in the instant BEFORE this migration runs, so the
 * forge is faithful rather than a contrivance. The restore replays the
 * migration itself (guarded and idempotent), and is ASSERTED, because a silent
 * failure here would leave the rest of the shard running against an
 * unconstrained table and blame the next suite.
 */
async function withDriftForged<T>(
  loginId: string,
  foreignContactId: string,
  body: () => Promise<T>,
): Promise<T> {
  await admin().execute(
    sql`ALTER TABLE portal_users DROP CONSTRAINT IF EXISTS portal_users_contact_org_fk`,
  );
  try {
    await admin()
      .update(portalUsers)
      .set({ contactId: foreignContactId })
      .where(eq(portalUsers.id, loginId));
    return await body();
  } finally {
    await admin().execute(sql.raw(migrationSql()));
  }
}

describe('portal_users_contact_org_fk — the composite same-org FK', () => {
  it('refuses an INSERT of a login in org A naming a contact in org B', async () => {
    const foreignContact = await seedContact(await otherOrg(), 'Foreign');

    const forge = admin()
      .insert(portalUsers)
      .values({
        orgId: fx.orgId,
        email: `forge-${uniqueSuffix()}@example.test`,
        name: 'Cross-tenant login',
        passwordHash: null,
        contactId: foreignContact,
      });

    // Drizzle wraps the driver error, so the pg code lives on `cause`. The
    // CONSTRAINT NAME is asserted too: a bare 23503 would also be satisfied by
    // the org_id FK, which is not what this test is about.
    await expect(forge).rejects.toMatchObject({
      cause: { code: '23503', constraint_name: 'portal_users_contact_org_fk' },
    });
  });

  it('refuses an UPDATE that repoints an existing login at a contact in another org', async () => {
    const loginId = await seedLogin(fx.orgId, await seedContact(fx.orgId, 'Home'));
    const foreignContact = await seedContact(await otherOrg(), 'Foreign');

    // The INSERT case alone would leave the drift reachable by any writer that
    // patches contact_id on a row that already exists — the invite route's
    // `contactPatch` is exactly that shape.
    const forge = admin()
      .update(portalUsers)
      .set({ contactId: foreignContact })
      .where(eq(portalUsers.id, loginId));

    await expect(forge).rejects.toMatchObject({
      cause: { code: '23503', constraint_name: 'portal_users_contact_org_fk' },
    });
  });

  it('accepts a same-org link (the constraint is not simply rejecting everything)', async () => {
    const contactId = await seedContact(fx.orgId, 'Home');
    const loginId = await seedLogin(fx.orgId, contactId);

    const [row] = await admin()
      .select({ contactId: portalUsers.contactId })
      .from(portalUsers)
      .where(eq(portalUsers.id, loginId));
    expect(row.contactId).toBe(contactId);
  });

  it('unlinks the login when the contact is deleted, without nulling its org_id', async () => {
    // The column-list `ON DELETE SET NULL (contact_id)` form. A bare composite
    // SET NULL would try to null org_id (NOT NULL) and the DELETE would fail.
    // The path this protects is the INTERACTIVE deleteContact — org erasure
    // deletes portal_users FIRST (it is the FK child), so the referential
    // action never fires there.
    const contactId = await seedContact(fx.orgId, 'Doomed');
    const loginId = await seedLogin(fx.orgId, contactId);

    await admin().delete(contacts).where(eq(contacts.id, contactId));

    const [row] = await admin()
      .select({ contactId: portalUsers.contactId, orgId: portalUsers.orgId })
      .from(portalUsers)
      .where(eq(portalUsers.id, loginId));
    expect(row.contactId).toBeNull();
    expect(row.orgId).toBe(fx.orgId);
  });

  it('unlinks the login when the APP role deletes the contact under org RLS', async () => {
    // The superuser case above proves the clause is well-formed; this proves
    // it works for the role production actually runs as. `portal_users` is
    // ENABLE + FORCE ROW LEVEL SECURITY, and the app role here holds an
    // ORGANIZATION context (not system) — the SET NULL still lands, because
    // referential-action triggers run with row security off. If they did not,
    // deleting a contact through the API would either fail or silently strand
    // the login pointing at a deleted row.
    const contactId = await seedContact(fx.orgId, 'App-deleted');
    const loginId = await seedLogin(fx.orgId, contactId);

    const deleted = await withDbAccessContext(orgCtx(fx.orgId), () =>
      db.delete(contacts).where(eq(contacts.id, contactId)).returning({ id: contacts.id }),
    );
    expect(deleted).toHaveLength(1);

    const [row] = await admin()
      .select({ contactId: portalUsers.contactId, orgId: portalUsers.orgId })
      .from(portalUsers)
      .where(eq(portalUsers.id, loginId));
    expect(row.contactId).toBeNull();
    expect(row.orgId).toBe(fx.orgId);
  });

  it('is DEFERRABLE, and is the ONLY FK from portal_users to contacts', async () => {
    const [row] = await admin().execute(sql`
      SELECT condeferrable, condeferred
        FROM pg_constraint
       WHERE conname = 'portal_users_contact_org_fk'
         AND conrelid = 'portal_users'::regclass
    `);
    // INITIALLY IMMEDIATE: deferred only when org merge asks for it.
    expect(row).toMatchObject({ condeferrable: true, condeferred: false });

    // The superseded single-column FK is REDUNDANT once the composite exists
    // (Postgres evaluates FK constraints conjunctively — a surviving one could
    // never permit a cross-org pair the composite rejects), but leaving it
    // would mean two SET NULL actions on one column and a second lock on
    // `contacts`. The migration drops it by SHAPE, so an alias-named one from
    // a `drizzle-kit push` dev database converges here too.
    await expectOnlyCompositeFk();
  });
});

describe('org merge KEEPS the portal user’s contact link', () => {
  let priorDrain: string | undefined;

  beforeEach(() => {
    priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
  });
  afterEach(() => {
    if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
    else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
  });

  it('re-tenants login AND contact to the survivor with the link intact', async () => {
    // `portal_users` is a plain repoint in the merge registry and `contacts` a
    // custom one, so their org_id UPDATEs land in SEPARATE statements of one
    // transaction. Only `SET CONSTRAINTS ALL DEFERRED` plus a DEFERRABLE
    // constraint lets the pair cross the org boundary together; a
    // NOT DEFERRABLE composite FK here would abort the merge mid-walk.
    const survivorId = await otherOrg();
    const contactId = await seedContact(fx.orgId, 'Merging Person');
    const loginId = await seedLogin(fx.orgId, contactId);

    await orgMergeModule.executeOrgMerge({
      loserOrgId: fx.orgId,
      survivorOrgId: survivorId,
      partnerId: fx.partnerId,
      performedBy: randomUUID(),
      performedByEmail: `merge-actor-${uniqueSuffix()}@example.test`,
    });

    const [loginRow] = await admin()
      .select({ orgId: portalUsers.orgId, contactId: portalUsers.contactId })
      .from(portalUsers)
      .where(eq(portalUsers.id, loginId));
    const [contactRow] = await admin()
      .select({ orgId: contacts.orgId })
      .from(contacts)
      .where(eq(contacts.id, contactId));

    expect(loginRow.orgId).toBe(survivorId);
    expect(contactRow.orgId).toBe(survivorId);
    // The whole point: SAME contact, still linked.
    expect(loginRow.contactId).toBe(contactId);
  });
});

describe('2026-10-04-100002-portal-users-contact-composite-fk.sql', () => {
  it('is idempotent — a second apply is a no-op, not a duplicate-constraint abort', async () => {
    await admin().execute(sql.raw(migrationSql()));
    await admin().execute(sql.raw(migrationSql()));

    await expectOnlyCompositeFk();
    const [{ count: idxCount }] = await admin().execute(
      sql`SELECT count(*)::int AS count FROM pg_indexes WHERE indexname = 'portal_users_contact_idx'`,
    );
    expect(idxCount).toBe(1);
  });

  it('nulls a pre-existing cross-org link instead of aborting the ADD CONSTRAINT', async () => {
    // A drifted row left in place would fail the ADD CONSTRAINT's initial
    // validation and abort the whole file on every affected database.
    const foreignContact = await seedContact(await otherOrg(), 'Drifted');
    const loginId = await seedLogin(fx.orgId, null);

    await withDriftForged(loginId, foreignContact, async () => {
      const [drifted] = await admin()
        .select({ contactId: portalUsers.contactId })
        .from(portalUsers)
        .where(eq(portalUsers.id, loginId));
      // Control: the forge really landed, so the assertions below are about
      // the cleanup rather than about a row that was never drifted.
      expect(drifted.contactId).toBe(foreignContact);
    });

    // withDriftForged's finally IS the migration apply. It must have SUCCEEDED
    // (not raised 23503) and left the constraint in place.
    await expectOnlyCompositeFk();

    const [row] = await admin()
      .select({ contactId: portalUsers.contactId, orgId: portalUsers.orgId })
      .from(portalUsers)
      .where(eq(portalUsers.id, loginId));
    // Unlinked — recoverable by re-inviting — rather than blocking the deploy,
    // and the login itself survives with its org intact.
    expect(row.contactId).toBeNull();
    expect(row.orgId).toBe(fx.orgId);
  });

  it("cleanup matches NOTHING without set_config('breeze.scope','system')", async () => {
    // The migration's `SELECT set_config('breeze.scope', 'system', true)` is
    // invisible in CI, where every test runs as a superuser that RLS does not
    // apply to. `getAppDb()` is the unprivileged `breeze_app` role with NO
    // `breeze.*` GUCs set — the same scope='none' (deny) state a managed
    // Postgres migration role lands in. Without the set_config the cleanup is
    // a silent zero-row no-op that still reports a truthful-looking
    // "cleaned 0"; this is the test that would go red if the line were dropped.
    const foreignContact = await seedContact(await otherOrg(), 'RLS-scoped');
    const loginId = await seedLogin(fx.orgId, null);

    const CLEANUP = sql`
      UPDATE portal_users pu
         SET contact_id = NULL
        FROM contacts c
       WHERE c.id = pu.contact_id
         AND c.org_id <> pu.org_id
      RETURNING pu.id
    `;

    await withDriftForged(loginId, foreignContact, async () => {
      const withoutScope = await getAppDb().transaction((tx) => tx.execute(CLEANUP));
      expect(Array.from(withoutScope as unknown as unknown[])).toHaveLength(0);

      // Read back with admin: the app role cannot see the row it just failed
      // to update, so asserting through it would be vacuous either way.
      const [stillDrifted] = await admin()
        .select({ contactId: portalUsers.contactId })
        .from(portalUsers)
        .where(eq(portalUsers.id, loginId));
      expect(stillDrifted.contactId).toBe(foreignContact);

      const withScope = await getAppDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
        return tx.execute(CLEANUP);
      });
      expect(Array.from(withScope as unknown as unknown[])).toHaveLength(1);

      const [cleaned] = await admin()
        .select({ contactId: portalUsers.contactId, orgId: portalUsers.orgId })
        .from(portalUsers)
        .where(eq(portalUsers.id, loginId));
      expect(cleaned.contactId).toBeNull();
      expect(cleaned.orgId).toBe(fx.orgId);
    });

    await expectOnlyCompositeFk();
  });

  it('RAISEs the cleaned count as a WARNING — 1 when it cleans, 0 when it does not', async () => {
    // The count exists so the forensic trail survives in the Postgres log. An
    // assertion that only checks the ROW EFFECT would still pass if the
    // RAISE were deleted, which is exactly the "suppressed 0" the migration
    // header argues against. Capture the notices the server actually sends.
    const notices: string[] = [];
    const client = postgres(DATABASE_URL, {
      max: 1,
      onnotice: (n) => notices.push(String(n.message ?? '')),
    });
    const foreignContact = await seedContact(await otherOrg(), 'Noticed');
    const loginId = await seedLogin(fx.orgId, null);

    try {
      await withDriftForged(loginId, foreignContact, async () => {
        notices.length = 0;
        await client.unsafe(migrationSql());
      });
      expect(notices.join('\n')).toMatch(/cleaned 1 cross-org portal_users\.contact_id link/);

      // Zero case: nothing left to clean, and the line must STILL be emitted.
      notices.length = 0;
      await client.unsafe(migrationSql());
      expect(notices.join('\n')).toMatch(/cleaned 0 cross-org portal_users\.contact_id link/);
    } finally {
      await client.end();
    }

    await expectOnlyCompositeFk();
  });
});

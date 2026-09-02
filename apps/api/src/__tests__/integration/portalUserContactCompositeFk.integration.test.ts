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
 * Only a real Postgres can prove the four claims that matter:
 *
 *  1. A cross-org login/contact pair is REJECTED, on INSERT and on UPDATE, by
 *     `portal_users_contact_org_fk` — not by an app-layer check that a second
 *     writer could forget. The write itself is the test.
 *  2. Deleting the contact still unlinks the login instead of failing. The
 *     column-list `ON DELETE SET NULL (contact_id)` is what makes that true; a
 *     bare composite SET NULL would try to null the NOT NULL `org_id`. Org
 *     erasure depends on this (tenantCascade deletes `contacts` before
 *     `portal_users`).
 *  3. Org MERGE keeps the link. Both tables re-tenant to the survivor in one
 *     transaction under `SET CONSTRAINTS ALL DEFERRED`, which only works
 *     because the constraint is DEFERRABLE — nulling the link there would
 *     silently destroy the customer's portal ownership of their own history.
 *  4. The migration is replayable and its cleanup really nulls a pre-existing
 *     drifted row (autoMigrate re-applies by filename; a half-applied
 *     constraint would abort boot).
 *
 * Fixtures are written with the admin/superuser handle, deliberately bypassing
 * the app-layer guards: the point is what the DATABASE refuses, which is what
 * makes those guards a nicety rather than the boundary.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { contacts, devices, organizations, partners, sites } from '../../db/schema';
import { portalUsers } from '../../db/schema/portal';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';
import * as orgMergeModule from '../../services/orgMerge';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-04-100002-portal-users-contact-composite-fk.sql',
);

const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const admin = () => getTestDb() as any;

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
  const db = admin();
  if (seeded.partnerIds.length === 0) return;
  const partnerList = sql.join(seeded.partnerIds.map((id) => sql`${id}`), sql`, `);
  const orgList = sql.join(seeded.orgIds.map((id) => sql`${id}`), sql`, `);

  await db.delete(portalUsers).where(sql`${portalUsers.orgId} IN (${orgList})`);
  await db.delete(contacts).where(sql`${contacts.orgId} IN (${orgList})`);
  await db.execute(sql`DELETE FROM audit_logs WHERE org_id IN (${orgList})`);
  await db.execute(sql`DELETE FROM org_merge_events WHERE partner_id IN (${partnerList})`);
  await db.delete(devices).where(sql`${devices.orgId} IN (${orgList})`);
  await db.delete(sites).where(sql`${sites.orgId} IN (${orgList})`);
  await db.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await db.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

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
    // SET NULL would try to null org_id (NOT NULL) and the DELETE would fail —
    // which would also break org erasure, where tenantCascade deletes
    // `contacts` before `portal_users`.
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

  it('is DEFERRABLE, and the superseded single-column FK is gone', async () => {
    const [row] = await admin().execute(sql`
      SELECT condeferrable, condeferred
        FROM pg_constraint
       WHERE conname = 'portal_users_contact_org_fk'
         AND conrelid = 'portal_users'::regclass
    `);
    // INITIALLY IMMEDIATE: deferred only when org merge asks for it.
    expect(row).toMatchObject({ condeferrable: true, condeferred: false });

    const [{ count }] = await admin().execute(sql`
      SELECT count(*)::int AS count
        FROM pg_constraint
       WHERE conname = 'portal_users_contact_fk'
         AND conrelid = 'portal_users'::regclass
    `);
    // Leaving the plain FK in place would keep single-column cross-org links
    // representable through it, defeating the whole migration.
    expect(count).toBe(0);
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
    const text = readFileSync(MIGRATION_FILE, 'utf8');
    await admin().execute(sql.raw(text));
    await admin().execute(sql.raw(text));

    const [{ count: fkCount }] = await admin().execute(sql`
      SELECT count(*)::int AS count FROM pg_constraint
       WHERE conname = 'portal_users_contact_org_fk' AND conrelid = 'portal_users'::regclass
    `);
    expect(fkCount).toBe(1);
    const [{ count: idxCount }] = await admin().execute(
      sql`SELECT count(*)::int AS count FROM pg_indexes WHERE indexname = 'portal_users_contact_idx'`,
    );
    expect(idxCount).toBe(1);
  });

  it('nulls a pre-existing cross-org link instead of aborting the ADD CONSTRAINT', async () => {
    // The drift this simulates is unrepresentable once the constraint exists,
    // so it has to be forged with the constraint off — which is precisely the
    // state every database is in the instant BEFORE this migration runs. A
    // drifted row left in place would fail the ADD CONSTRAINT's initial
    // validation and abort the whole file on every affected database.
    const foreignContact = await seedContact(await otherOrg(), 'Drifted');
    const loginId = await seedLogin(fx.orgId, null);

    await admin().execute(
      sql`ALTER TABLE portal_users DROP CONSTRAINT portal_users_contact_org_fk`,
    );
    try {
      await admin()
        .update(portalUsers)
        .set({ contactId: foreignContact })
        .where(eq(portalUsers.id, loginId));

      // Applying the migration must SUCCEED (not 23503) and clean the row.
      await expect(
        admin().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8'))),
      ).resolves.toBeDefined();
    } finally {
      // The migration re-adds the constraint on its way through; if it threw
      // before that point, restore it so the rest of the shard is not left
      // running against an unconstrained table.
      await admin().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));
    }

    const [row] = await admin()
      .select({ contactId: portalUsers.contactId, orgId: portalUsers.orgId })
      .from(portalUsers)
      .where(eq(portalUsers.id, loginId));
    // Unlinked — recoverable by re-inviting — rather than blocking the deploy,
    // and the login itself survives with its org intact.
    expect(row.contactId).toBeNull();
    expect(row.orgId).toBe(fx.orgId);
  });
});

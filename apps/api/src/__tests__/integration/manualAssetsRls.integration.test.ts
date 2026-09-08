/**
 * Real-PostgreSQL proof for `manual_assets` (#4622) — tenancy shape 1.
 *
 * Every assertion here needs a live database as the unprivileged `breeze_app`
 * role: a contextless or BYPASSRLS connection would let the cross-tenant forge
 * "pass" while proving nothing. Each negative case is paired with a positive
 * control in the SAME context, so a red can never be the fixture being broken
 * rather than the policy working.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

async function causeOf(work: () => Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return (
      (error as { cause?: { code?: string; message?: string } }).cause ??
      (error as { code?: string; message?: string })
    );
  }
}

/** Two orgs under DIFFERENT partners — the hardest isolation case. */
async function seedTwoTenants() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  return { orgA, orgB, siteA, siteB };
}

describe('manual_assets tenant isolation (#4622)', () => {
  runDb('runs as a non-bypass role and forces four-command direct-org RLS', async () => {
    const role = (await withSystemDbAccessContext(() =>
      db.execute(sql`
        SELECT current_user AS who, rolsuper, rolbypassrls
        FROM pg_roles WHERE rolname = current_user
      `),
    )) as unknown as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
    expect(
      role[0],
      'the forge below proves nothing on a superuser or BYPASSRLS connection',
    ).toMatchObject({ rolsuper: false, rolbypassrls: false });

    const [table] = (await getTestDb().execute(sql`
      SELECT c.relrowsecurity AS rls_on,
             c.relforcerowsecurity AS rls_forced,
             ARRAY_AGG(DISTINCT p.cmd ORDER BY p.cmd) AS commands
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname
      WHERE n.nspname = 'public' AND c.relname = 'manual_assets'
      GROUP BY c.relrowsecurity, c.relforcerowsecurity
    `)) as unknown as Array<{ rls_on: boolean; rls_forced: boolean; commands: string[] }>;
    expect(table).toBeDefined();
    expect(table!.rls_on).toBe(true);
    expect(table!.rls_forced).toBe(true);
    expect(table!.commands).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  runDb('refuses a cross-tenant insert (42501) but accepts the same row for the caller org', async () => {
    const { orgA, orgB, siteA, siteB } = await seedTwoTenants();

    // NEGATIVE — org A context forging a row into org B.
    const forged = await causeOf(() =>
      withDbAccessContext(orgContext(orgA.id), () =>
        db.execute(sql`
          INSERT INTO manual_assets (org_id, site_id, name)
          VALUES (${orgB.id}::uuid, ${siteB.id}::uuid, ${'forged-' + randomUUID()})
        `),
      ),
    );
    expect(forged?.code, `expected an RLS refusal, got: ${forged?.message ?? 'no error at all'}`).toBe(
      '42501',
    );

    // POSITIVE CONTROL — the identical statement for the caller's OWN org must
    // succeed and read back. Without this, the red above could just as easily
    // mean the fixture, the column list or the grant is broken.
    const ownName = `own-${randomUUID()}`;
    const readBack = await withDbAccessContext(orgContext(orgA.id), async () => {
      await db.execute(sql`
        INSERT INTO manual_assets (org_id, site_id, name)
        VALUES (${orgA.id}::uuid, ${siteA.id}::uuid, ${ownName})
      `);
      return (await db.execute(sql`
        SELECT id, org_id, source, tags, asset_type FROM manual_assets WHERE name = ${ownName}
      `)) as unknown as Array<{ id: string; org_id: string; source: string; tags: string[]; asset_type: string }>;
    });
    expect(readBack).toHaveLength(1);
    expect(readBack[0]!.org_id).toBe(orgA.id);
    expect(readBack[0]!.source).toBe('manual');
    expect(readBack[0]!.asset_type).toBe('unknown');
    expect(readBack[0]!.tags).toEqual([]);
  });

  runDb('hides another org\'s rows from SELECT, UPDATE and DELETE', async () => {
    const { orgA, orgB, siteB } = await seedTwoTenants();
    const name = `b-only-${randomUUID()}`;
    await withDbAccessContext(orgContext(orgB.id), () =>
      db.execute(sql`
        INSERT INTO manual_assets (org_id, site_id, name)
        VALUES (${orgB.id}::uuid, ${siteB.id}::uuid, ${name})
      `),
    );

    const fromA = (await withDbAccessContext(orgContext(orgA.id), () =>
      db.execute(sql`SELECT id FROM manual_assets WHERE name = ${name}`),
    )) as unknown as Array<{ id: string }>;
    expect(fromA).toHaveLength(0);

    // A silent zero-row UPDATE/DELETE is the correct RLS outcome, not an error —
    // assert the row is untouched rather than expecting a throw.
    await withDbAccessContext(orgContext(orgA.id), async () => {
      await db.execute(sql`UPDATE manual_assets SET name = 'stolen' WHERE name = ${name}`);
      await db.execute(sql`DELETE FROM manual_assets WHERE name = ${name}`);
    });
    const stillThere = (await withDbAccessContext(orgContext(orgB.id), () =>
      db.execute(sql`SELECT name FROM manual_assets WHERE name = ${name}`),
    )) as unknown as Array<{ name: string }>;
    expect(stillThere, 'org A must not be able to update or delete org B inventory').toHaveLength(1);
    expect(stillThere[0]!.name).toBe(name);

    // POSITIVE CONTROL for UPDATE and DELETE. Without it the zero-row outcomes
    // above are equally consistent with a policy that refuses EVERYTHING (a
    // `USING (false)` typo would pass the assertions above and every static
    // policy-text contract, while making the table unusable).
    const ownName = `b-own-${randomUUID()}`;
    const renamed = `${ownName}-renamed`;
    await withDbAccessContext(orgContext(orgB.id), async () => {
      await db.execute(sql`
        INSERT INTO manual_assets (org_id, site_id, name)
        VALUES (${orgB.id}::uuid, ${siteB.id}::uuid, ${ownName})
      `);
      await db.execute(sql`UPDATE manual_assets SET name = ${renamed} WHERE name = ${ownName}`);
    });
    const updated = (await withDbAccessContext(orgContext(orgB.id), () =>
      db.execute(sql`SELECT name FROM manual_assets WHERE name = ${renamed}`),
    )) as unknown as Array<{ name: string }>;
    expect(updated, 'an org must be able to update its OWN manual assets').toHaveLength(1);

    await withDbAccessContext(orgContext(orgB.id), () =>
      db.execute(sql`DELETE FROM manual_assets WHERE name = ${renamed}`),
    );
    const deleted = (await withDbAccessContext(orgContext(orgB.id), () =>
      db.execute(sql`SELECT name FROM manual_assets WHERE name = ${renamed}`),
    )) as unknown as Array<{ name: string }>;
    expect(deleted, 'an org must be able to delete its OWN manual assets').toHaveLength(0);
  });

  runDb('refuses a cross-org link and a cross-org site (composite tenant FKs)', async () => {
    const { orgA, orgB, siteA, siteB } = await seedTwoTenants();

    // site from the WRONG org — manual_assets_site_org_fk.
    const wrongSite = await causeOf(() =>
      withSystemDbAccessContext(() =>
        db.execute(sql`
          INSERT INTO manual_assets (org_id, site_id, name)
          VALUES (${orgA.id}::uuid, ${siteB.id}::uuid, ${'wrong-site-' + randomUUID()})
        `),
      ),
    );
    expect(wrongSite?.code, 'a site belonging to another org must not be attachable').toBe('23503');

    // device from the WRONG org — manual_assets_linked_device_org_fk.
    const [deviceB] = await getTestDb()
      .insert(devices)
      .values({
        orgId: orgB.id,
        siteId: siteB.id,
        agentId: `ma-b-${randomUUID()}`,
        hostname: 'ma-b',
        osType: 'linux',
        osVersion: '1',
        architecture: 'amd64',
        agentVersion: '0.99.0',
        status: 'online',
      })
      .returning({ id: devices.id });
    const wrongDevice = await causeOf(() =>
      withSystemDbAccessContext(() =>
        db.execute(sql`
          INSERT INTO manual_assets (org_id, site_id, name, linked_device_id)
          VALUES (${orgA.id}::uuid, ${siteA.id}::uuid, ${'wrong-dev-' + randomUUID()}, ${deviceB!.id}::uuid)
        `),
      ),
    );
    expect(wrongDevice?.code, 'a device belonging to another org must not be linkable').toBe('23503');

    // POSITIVE CONTROL — the same link inside one org is accepted.
    const [deviceA] = await getTestDb()
      .insert(devices)
      .values({
        orgId: orgA.id,
        siteId: siteA.id,
        agentId: `ma-a-${randomUUID()}`,
        hostname: 'ma-a',
        osType: 'linux',
        osVersion: '1',
        architecture: 'amd64',
        agentVersion: '0.99.0',
        status: 'online',
      })
      .returning({ id: devices.id });
    const okName = `linked-${randomUUID()}`;
    await withSystemDbAccessContext(() =>
      db.execute(sql`
        INSERT INTO manual_assets (org_id, site_id, name, linked_device_id)
        VALUES (${orgA.id}::uuid, ${siteA.id}::uuid, ${okName}, ${deviceA!.id}::uuid)
      `),
    );
    const linked = (await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT linked_device_id FROM manual_assets WHERE name = ${okName}`),
    )) as unknown as Array<{ linked_device_id: string }>;
    expect(linked).toHaveLength(1);
    expect(linked[0]!.linked_device_id).toBe(deviceA!.id);
  });

  runDb('nulls only the link column when a linked parent row is deleted', async () => {
    // The three optional links are `ON DELETE SET NULL (<col>)`, not a bare SET
    // NULL. On a COMPOSITE FK the bare form nulls every referencing column —
    // here that includes org_id, which is NOT NULL — so deleting a linked
    // device would raise 23502 and abort GDPR org erasure part-way through
    // (#4100). This is the behavioural proof of the column-list form;
    // orgCascadeFkOnDelete.integration.test.ts is the static ledger for it.
    const { orgA, siteA } = await seedTwoTenants();
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: orgA.id,
        siteId: siteA.id,
        agentId: `ma-del-${randomUUID()}`,
        hostname: 'ma-del',
        osType: 'linux',
        osVersion: '1',
        architecture: 'amd64',
        agentVersion: '0.99.0',
        status: 'online',
      })
      .returning({ id: devices.id });
    const name = `survives-${randomUUID()}`;
    await withSystemDbAccessContext(() =>
      db.execute(sql`
        INSERT INTO manual_assets (org_id, site_id, name, linked_device_id)
        VALUES (${orgA.id}::uuid, ${siteA.id}::uuid, ${name}, ${device!.id}::uuid)
      `),
    );

    const deleted = await causeOf(() =>
      withSystemDbAccessContext(() =>
        db.execute(sql`DELETE FROM devices WHERE id = ${device!.id}::uuid`),
      ),
    );
    expect(
      deleted,
      `deleting a linked device must not 23502 on manual_assets.org_id, got ${deleted?.code}: ${deleted?.message}`,
    ).toBeUndefined();

    const after = (await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT org_id, linked_device_id FROM manual_assets WHERE name = ${name}`),
    )) as unknown as Array<{ org_id: string; linked_device_id: string | null }>;
    expect(after, 'the inventory row must survive the device it pointed at').toHaveLength(1);
    expect(after[0]!.linked_device_id).toBeNull();
    expect(after[0]!.org_id, 'the tenant key must NOT be collateral damage').toBe(orgA.id);
  });

  runDb('refuses a cross-org contact and a cross-org discovered asset', async () => {
    const { orgA, orgB, siteA, siteB } = await seedTwoTenants();

    // manual_assets_assigned_contact_org_fk
    const [contactB] = (await withSystemDbAccessContext(() =>
      db.execute(sql`
        INSERT INTO contacts (org_id, name)
        VALUES (${orgB.id}::uuid, 'Cross Tenant')
        RETURNING id
      `),
    )) as unknown as Array<{ id: string }>;
    const wrongContact = await causeOf(() =>
      withSystemDbAccessContext(() =>
        db.execute(sql`
          INSERT INTO manual_assets (org_id, site_id, name, assigned_contact_id)
          VALUES (${orgA.id}::uuid, ${siteA.id}::uuid, ${'wrong-contact-' + randomUUID()}, ${contactB!.id}::uuid)
        `),
      ),
    );
    expect(wrongContact?.code, 'a contact belonging to another org must not be assignable').toBe(
      '23503',
    );

    // manual_assets_linked_discovered_asset_org_fk — the FK this wave's new
    // discovered_assets_id_org_id_uniq index exists to make expressible.
    const [assetB] = (await withSystemDbAccessContext(() =>
      db.execute(sql`
        INSERT INTO discovered_assets (org_id, site_id, ip_address)
        VALUES (${orgB.id}::uuid, ${siteB.id}::uuid, '10.9.9.9'::inet)
        RETURNING id
      `),
    )) as unknown as Array<{ id: string }>;
    const wrongAsset = await causeOf(() =>
      withSystemDbAccessContext(() =>
        db.execute(sql`
          INSERT INTO manual_assets (org_id, site_id, name, linked_discovered_asset_id)
          VALUES (${orgA.id}::uuid, ${siteA.id}::uuid, ${'wrong-asset-' + randomUUID()}, ${assetB!.id}::uuid)
        `),
      ),
    );
    expect(
      wrongAsset?.code,
      'a discovered asset belonging to another org must not be linkable',
    ).toBe('23503');

    // POSITIVE CONTROLS — both links inside one org are accepted, so the two
    // reds above cannot be a wrong column order or a missing referenced index.
    const [contactA] = (await withSystemDbAccessContext(() =>
      db.execute(sql`
        INSERT INTO contacts (org_id, name)
        VALUES (${orgA.id}::uuid, 'Same Tenant')
        RETURNING id
      `),
    )) as unknown as Array<{ id: string }>;
    const [assetA] = (await withSystemDbAccessContext(() =>
      db.execute(sql`
        INSERT INTO discovered_assets (org_id, site_id, ip_address)
        VALUES (${orgA.id}::uuid, ${siteA.id}::uuid, '10.1.1.1'::inet)
        RETURNING id
      `),
    )) as unknown as Array<{ id: string }>;
    const okName = `both-links-${randomUUID()}`;
    const ok = await causeOf(() =>
      withSystemDbAccessContext(() =>
        db.execute(sql`
          INSERT INTO manual_assets (org_id, site_id, name, assigned_contact_id, linked_discovered_asset_id)
          VALUES (${orgA.id}::uuid, ${siteA.id}::uuid, ${okName}, ${contactA!.id}::uuid, ${assetA!.id}::uuid)
        `),
      ),
    );
    expect(ok, `same-org links must be accepted, got ${ok?.code}: ${ok?.message}`).toBeUndefined();
  });
});

/**
 * The FK-timing proof behind the hand-written detach in `moveOrg.ts` (#4622).
 *
 * `manual_assets_linked_device_org_fk` is DEFERRABLE INITIALLY IMMEDIATE, so
 * its referential check fires at the end of the `UPDATE devices SET org_id`
 * statement — NOT at commit, and not after the route's later re-stamp loop.
 * `moveOrg.coverage.test.ts` asserts statically that the detach precedes the
 * devices flip; this asserts the reason that ordering is mandatory, against a
 * real server. If the constraint is ever relaxed to INITIALLY DEFERRED, this
 * test goes green-with-no-error and should be revisited alongside the
 * placement rule.
 */
describe('manual_assets link vs. cross-org device move (#4622)', () => {
  runDb('a still-linked manual asset blocks the devices org flip; detaching first lets it through', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: orgA.id,
        siteId: siteA.id,
        agentId: `ma-move-${randomUUID()}`,
        hostname: 'ma-move',
        osType: 'linux',
        osVersion: '1',
        architecture: 'amd64',
        agentVersion: '0.99.0',
        status: 'online',
      })
      .returning({ id: devices.id });
    const assetName = `move-${randomUUID()}`;
    await withSystemDbAccessContext(() =>
      db.execute(sql`
        INSERT INTO manual_assets (org_id, site_id, name, linked_device_id)
        VALUES (${orgA.id}::uuid, ${siteA.id}::uuid, ${assetName}, ${device!.id}::uuid)
      `),
    );

    // NEGATIVE — flip the device without detaching first.
    const blocked = await causeOf(() =>
      withSystemDbAccessContext(() =>
        db.execute(sql`
          UPDATE devices SET org_id = ${orgB.id}::uuid, site_id = ${siteB.id}::uuid
          WHERE id = ${device!.id}::uuid
        `),
      ),
    );
    expect(
      blocked?.code,
      'the IMMEDIATE composite FK must refuse the flip while the link stands — this is why moveOrg.ts detaches BEFORE the devices update',
    ).toBe('23503');

    // POSITIVE CONTROL — the route's order: detach, then flip, in one transaction.
    const moved = await causeOf(() =>
      withSystemDbAccessContext(() =>
        db.transaction(async (tx) => {
          await db.execute(
            sql`UPDATE manual_assets SET linked_device_id = NULL WHERE linked_device_id = ${device!.id}::uuid`,
          );
          await db.execute(sql`
            UPDATE devices SET org_id = ${orgB.id}::uuid, site_id = ${siteB.id}::uuid
            WHERE id = ${device!.id}::uuid
          `);
        }),
      ),
    );
    expect(moved, `detach-then-flip must succeed, got ${moved?.code}: ${moved?.message}`).toBeUndefined();

    // The asset itself survives in the SOURCE org, merely unlinked.
    const after = (await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT org_id, linked_device_id FROM manual_assets WHERE name = ${assetName}`),
    )) as unknown as Array<{ org_id: string; linked_device_id: string | null }>;
    expect(after).toHaveLength(1);
    expect(after[0]!.org_id, 'hand-entered inventory stays with the org that entered it').toBe(orgA.id);
    expect(after[0]!.linked_device_id).toBeNull();
  });
});

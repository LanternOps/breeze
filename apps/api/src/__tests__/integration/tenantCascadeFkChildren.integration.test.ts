/**
 * Org erasure over tables that have no `org_id` of their own and hang off the
 * cascade set only through foreign keys:
 *
 *   device_software     -> devices
 *   script_to_tags      -> scripts, script_tags
 *   mobile_devices      -> users
 *   push_notifications  -> users, mobile_devices
 *   mobile_sessions     -> users, mobile_devices
 *   partner_users       -> users
 *
 * Each FK used to be declared without an `ON DELETE` action, so the first row
 * in any of them made `cascadeDeleteOrg()` abort with 23503 part-way through
 * the walk and left the tenant half-erased. The catalog contract
 * (`orgCascadeFkOnDelete.integration.test.ts`) carried them as accepted debt
 * in `ORG_CASCADE_FK_UNSAFE`; this suite proves the data-level property the
 * catalog contract cannot: with a populated row in every one of those tables,
 * erasure completes, leaves zero rows behind for the erased org, and touches
 * nothing that belongs to the sibling org or to the partner.
 *
 * Shared identities: a user whose home org is the erased org but who ALSO
 * holds a partner membership is the partner's staff identity, not org data.
 * Erasure detaches that user (org_id -> NULL, i.e. partner-level staff) and
 * keeps the membership and the user's own mobile registrations; the org-bound
 * rows (the org membership, anything keyed on the org) still go. A user with
 * no partner membership is deleted, and everything hanging off them with it.
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { cascadeDeleteOrg } from '../../services/tenantCascade';

interface Handles {
  partnerId: string;
  actorUserId: string;
  orgErased: string;
  orgControl: string;
  deviceErased: string;
  deviceControl: string;
  /** Org user of the erased org with no partner membership: deleted. */
  orgOnlyUserId: string;
  /** Home org is the erased org, but holds a partner membership: detached. */
  sharedUserId: string;
  sharedMembershipId: string;
  /** Partner tech whose org selection lists both orgs. */
  selectingMembershipId: string;
  /** Org user of the sibling org: untouched. */
  controlUserId: string;
  scriptErased: string;
  tagErased: string;
  scriptControl: string;
  tagControl: string;
  partnerWideScript: string;
  partnerWideTag: string;
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await getTestDb().execute(query)) as unknown as T[];
}

async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  const [row] = await rows<T>(query);
  if (!row) throw new Error('expected a row');
  return row;
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  const row = await one<{ n: number | string }>(query);
  return Number(row.n);
}

async function seedMobile(userId: string, tag: string): Promise<void> {
  const device = await one<{ id: string }>(sql`
    INSERT INTO mobile_devices (user_id, device_id, platform)
    VALUES (${userId}, ${`mobile-${tag}`}, 'ios')
    RETURNING id
  `);
  await getTestDb().execute(sql`
    INSERT INTO push_notifications (mobile_device_id, user_id, title, platform)
    VALUES (${device.id}, ${userId}, 'Alert', 'ios')
  `);
  await getTestDb().execute(sql`
    INSERT INTO mobile_sessions (user_id, mobile_device_id, refresh_token, expires_at)
    VALUES (${userId}, ${device.id}, ${`rt-${tag}`}, now() + interval '1 day')
  `);
}

async function seed(): Promise<Handles> {
  const testDb = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const partner = await one<{ id: string }>(sql`
    INSERT INTO partners (name, slug, status, created_at, updated_at)
    VALUES ('FK Children Partner', ${`fkc-${suffix}`}, 'active', now(), now())
    RETURNING id
  `);
  const partnerId = partner.id;

  const actor = await one<{ id: string }>(sql`
    INSERT INTO users (partner_id, email, name, status)
    VALUES (${partnerId}, ${`fkc-actor-${suffix}@example.test`}, 'Actor', 'active')
    RETURNING id
  `);

  const orgIds: string[] = [];
  for (const tag of ['erase', 'control']) {
    const org = await one<{ id: string }>(sql`
      INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
      VALUES (${partnerId}, ${`FKC ${tag}`}, ${`fkc-${tag}-${suffix}`}, 'active', 'USD', now(), now())
      RETURNING id
    `);
    orgIds.push(org.id);
  }
  const [orgErased, orgControl] = orgIds as [string, string];

  const deviceIds: string[] = [];
  for (const [orgId, tag] of [[orgErased, 'erase'], [orgControl, 'control']] as const) {
    const site = await one<{ id: string }>(sql`
      INSERT INTO sites (org_id, name, created_at, updated_at)
      VALUES (${orgId}, 'FKC Site', now(), now())
      RETURNING id
    `);
    const device = await one<{ id: string }>(sql`
      INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, created_at, updated_at)
      VALUES (${orgId}, ${site.id}, ${`fkc-${tag}-${suffix}`}, ${`host-${tag}`}, 'linux', '1.0', 'x86_64', '0.0.0-test', now(), now())
      RETURNING id
    `);
    deviceIds.push(device.id);
    await testDb.execute(sql`
      INSERT INTO device_software (device_id, name, version)
      VALUES (${device.id}, 'Example App', '1.0'), (${device.id}, 'Other App', '2.0')
    `);
  }
  const [deviceErased, deviceControl] = deviceIds as [string, string];

  const partnerRole = await one<{ id: string }>(sql`
    INSERT INTO roles (partner_id, scope, name)
    VALUES (${partnerId}, 'partner', ${`FKC Tech ${suffix}`})
    RETURNING id
  `);
  const orgRole = await one<{ id: string }>(sql`
    INSERT INTO roles (partner_id, scope, name)
    VALUES (${partnerId}, 'organization', ${`FKC Org User ${suffix}`})
    RETURNING id
  `);

  const mkUser = async (orgId: string, tag: string) =>
    (await one<{ id: string }>(sql`
      INSERT INTO users (partner_id, org_id, email, name, status)
      VALUES (${partnerId}, ${orgId}, ${`fkc-${tag}-${suffix}@example.test`}, ${`User ${tag}`}, 'active')
      RETURNING id
    `)).id;

  const orgOnlyUserId = await mkUser(orgErased, 'org-only');
  const sharedUserId = await mkUser(orgErased, 'shared');
  const controlUserId = await mkUser(orgControl, 'control');

  for (const [orgId, userId] of [
    [orgErased, orgOnlyUserId],
    [orgErased, sharedUserId],
    [orgControl, controlUserId],
  ] as const) {
    await testDb.execute(sql`
      INSERT INTO organization_users (org_id, user_id, role_id)
      VALUES (${orgId}, ${userId}, ${orgRole.id})
    `);
  }

  const sharedMembership = await one<{ id: string }>(sql`
    INSERT INTO partner_users (partner_id, user_id, role_id, org_access)
    VALUES (${partnerId}, ${sharedUserId}, ${partnerRole.id}, 'all')
    RETURNING id
  `);
  const selectingMembership = await one<{ id: string }>(sql`
    INSERT INTO partner_users (partner_id, user_id, role_id, org_access, org_ids)
    VALUES (${partnerId}, ${actor.id}, ${partnerRole.id}, 'selected', ARRAY[${orgErased}::uuid, ${orgControl}::uuid])
    RETURNING id
  `);

  await seedMobile(orgOnlyUserId, `org-only-${suffix}`);
  await seedMobile(sharedUserId, `shared-${suffix}`);
  await seedMobile(controlUserId, `control-${suffix}`);

  const mkScript = async (orgId: string | null, tag: string) =>
    (await one<{ id: string }>(sql`
      INSERT INTO scripts (org_id, partner_id, name, os_types, language, content)
      VALUES (${orgId}, ${partnerId}, ${`FKC script ${tag} ${suffix}`}, ARRAY['linux'], 'bash', 'echo hi')
      RETURNING id
    `)).id;
  const mkTag = async (orgId: string | null, tag: string) =>
    (await one<{ id: string }>(sql`
      INSERT INTO script_tags (org_id, partner_id, name)
      VALUES (${orgId}, ${partnerId}, ${`fkc-${tag}`})
      RETURNING id
    `)).id;

  const scriptErased = await mkScript(orgErased, 'erase');
  const scriptControl = await mkScript(orgControl, 'control');
  const partnerWideScript = await mkScript(null, 'wide');
  const tagErased = await mkTag(orgErased, 'erase');
  const tagControl = await mkTag(orgControl, 'control');
  const partnerWideTag = await mkTag(null, 'wide');

  // Every combination that crosses the erased org, plus the ones that do not.
  for (const [scriptId, tagId] of [
    [scriptErased, tagErased],
    [scriptErased, partnerWideTag],
    [partnerWideScript, tagErased],
    [partnerWideScript, partnerWideTag],
    [scriptControl, tagControl],
    [scriptControl, partnerWideTag],
  ] as const) {
    await testDb.execute(sql`INSERT INTO script_to_tags (script_id, tag_id) VALUES (${scriptId}, ${tagId})`);
  }

  return {
    partnerId,
    actorUserId: actor.id,
    orgErased,
    orgControl,
    deviceErased,
    deviceControl,
    orgOnlyUserId,
    sharedUserId,
    sharedMembershipId: sharedMembership.id,
    selectingMembershipId: selectingMembership.id,
    controlUserId,
    scriptErased,
    tagErased,
    scriptControl,
    tagControl,
    partnerWideScript,
    partnerWideTag,
  };
}

const mobileCounts = async (userId: string) => ({
  mobile_devices: await count(sql`SELECT count(*) AS n FROM mobile_devices WHERE user_id = ${userId}`),
  push_notifications: await count(sql`SELECT count(*) AS n FROM push_notifications WHERE user_id = ${userId}`),
  mobile_sessions: await count(sql`SELECT count(*) AS n FROM mobile_sessions WHERE user_id = ${userId}`),
});

describe('cascadeDeleteOrg — FK-only child tables', () => {
  let h: Handles;

  beforeEach(async () => {
    h = await seed();
  });

  it('erases device_software for the org\'s devices and keeps the sibling org\'s', async () => {
    expect(await count(sql`SELECT count(*) AS n FROM device_software WHERE device_id = ${h.deviceErased}`)).toBe(2);

    await cascadeDeleteOrg(h.orgErased, h.actorUserId);

    expect(await count(sql`SELECT count(*) AS n FROM devices WHERE id = ${h.deviceErased}`)).toBe(0);
    expect(await count(sql`SELECT count(*) AS n FROM device_software WHERE device_id = ${h.deviceErased}`)).toBe(0);
    expect(await count(sql`SELECT count(*) AS n FROM device_software WHERE device_id = ${h.deviceControl}`)).toBe(2);
  });

  it('erases script_to_tags links on either side of the erased org and keeps every other link', async () => {
    await cascadeDeleteOrg(h.orgErased, h.actorUserId);

    const links = await rows<{ script_id: string; tag_id: string }>(sql`
      SELECT script_id, tag_id FROM script_to_tags
      WHERE script_id IN (${h.scriptErased}, ${h.scriptControl}, ${h.partnerWideScript})
         OR tag_id IN (${h.tagErased}, ${h.tagControl}, ${h.partnerWideTag})
    `);
    const keys = links.map((l) => `${l.script_id}:${l.tag_id}`).sort();
    expect(keys).toEqual(
      [
        `${h.partnerWideScript}:${h.partnerWideTag}`,
        `${h.scriptControl}:${h.tagControl}`,
        `${h.scriptControl}:${h.partnerWideTag}`,
      ].sort(),
    );
    // The partner-wide script and tag themselves are not the org's to erase.
    expect(await count(sql`SELECT count(*) AS n FROM scripts WHERE id = ${h.partnerWideScript}`)).toBe(1);
    expect(await count(sql`SELECT count(*) AS n FROM script_tags WHERE id = ${h.partnerWideTag}`)).toBe(1);
  });

  it('deletes an org-only user with their mobile devices, sessions and notifications', async () => {
    expect(await mobileCounts(h.orgOnlyUserId)).toEqual({ mobile_devices: 1, push_notifications: 1, mobile_sessions: 1 });

    await cascadeDeleteOrg(h.orgErased, h.actorUserId);

    expect(await count(sql`SELECT count(*) AS n FROM users WHERE id = ${h.orgOnlyUserId}`)).toBe(0);
    expect(await mobileCounts(h.orgOnlyUserId)).toEqual({ mobile_devices: 0, push_notifications: 0, mobile_sessions: 0 });
    // Sibling org's user is untouched.
    expect(await count(sql`SELECT count(*) AS n FROM users WHERE id = ${h.controlUserId} AND org_id = ${h.orgControl}`)).toBe(1);
    expect(await mobileCounts(h.controlUserId)).toEqual({ mobile_devices: 1, push_notifications: 1, mobile_sessions: 1 });
  });

  it('detaches a user who also holds a partner membership instead of deleting the partner identity', async () => {
    const before = await one<{ auth_epoch: number }>(sql`SELECT auth_epoch FROM users WHERE id = ${h.sharedUserId}`);

    await cascadeDeleteOrg(h.orgErased, h.actorUserId);

    const user = await one<{ org_id: string | null; partner_id: string; auth_epoch: number }>(sql`
      SELECT org_id, partner_id, auth_epoch FROM users WHERE id = ${h.sharedUserId}
    `);
    expect(user.org_id).toBeNull();
    expect(user.partner_id).toBe(h.partnerId);
    // Tokens minted while the erased org was the home org stop working.
    expect(user.auth_epoch).toBeGreaterThan(before.auth_epoch);
    expect(await count(sql`SELECT count(*) AS n FROM partner_users WHERE id = ${h.sharedMembershipId}`)).toBe(1);
    // The org-bound membership is gone; the user's own registrations stay.
    expect(await count(sql`SELECT count(*) AS n FROM organization_users WHERE user_id = ${h.sharedUserId}`)).toBe(0);
    expect(await mobileCounts(h.sharedUserId)).toEqual({ mobile_devices: 1, push_notifications: 1, mobile_sessions: 1 });
  });

  it('drops the erased org from partner members\' org selections and leaves the rest of the selection', async () => {
    await cascadeDeleteOrg(h.orgErased, h.actorUserId);

    const membership = await one<{ org_ids: string[] }>(sql`
      SELECT org_ids FROM partner_users WHERE id = ${h.selectingMembershipId}
    `);
    expect(membership.org_ids).toEqual([h.orgControl]);
  });
});

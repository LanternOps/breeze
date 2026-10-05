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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { cascadeDeleteOrg, __tenantCascadeTestHooks } from '../../services/tenantCascade';

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

/**
 * What a normal, in-use org actually carries: patched and deployed devices,
 * compliance state, automations, alert notifications and correlations,
 * ticket comments, AI chats, maintenance occurrences, a custom role with
 * permissions, an access review, interactive sessions and SSO links. Every
 * child table here hangs off the cascade set by FK only.
 */
interface RealisticHandles {
  /** Child rows keyed by table, with the column and value(s) to recount. */
  children: Array<{ table: string; column: string; values: string[] }>;
  /** Membership whose only selected org is the erased one. */
  selectedOnlyUserId: string;
  selectedOnlyMembershipId: string;
  /** Home org is the erased org; membership selects the erased AND the sibling org. */
  selectedBothUserId: string;
  /** SSO links of the shared user: partner-level provider (kept), org provider (erased). */
  sharedPartnerSsoIdentityId: string;
  sharedOrgSsoIdentityId: string;
}

async function seedRealistic(h: Handles): Promise<RealisticHandles> {
  const db = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const id = async (q: ReturnType<typeof sql>) => (await one<{ id: string }>(q)).id;

  // Patch job, per-device result, rollback.
  const patchJob = await id(sql`INSERT INTO patch_jobs (org_id, name) VALUES (${h.orgErased}, 'Patch Tuesday') RETURNING id`);
  const patch = await id(sql`
    INSERT INTO patches (source, external_id, title)
    VALUES ('microsoft', ${`KB-${suffix}`}, 'Cumulative update') RETURNING id
  `);
  const patchResult = await id(sql`
    INSERT INTO patch_job_results (job_id, device_id) VALUES (${patchJob}, ${h.deviceErased}) RETURNING id
  `);
  const patchRollback = await id(sql`
    INSERT INTO patch_rollbacks (device_id, patch_id, original_job_id, initiated_by)
    VALUES (${h.deviceErased}, ${patch}, ${patchJob}, ${h.orgOnlyUserId}) RETURNING id
  `);

  // Deployment fan-out.
  const deployment = await id(sql`
    INSERT INTO deployments (org_id, name, type, payload, target_type, target_config, rollout_config)
    VALUES (${h.orgErased}, 'Rollout', 'script', '{}'::jsonb, 'devices', '{}'::jsonb, '{}'::jsonb) RETURNING id
  `);
  const deploymentDevice = await id(sql`
    INSERT INTO deployment_devices (deployment_id, device_id) VALUES (${deployment}, ${h.deviceErased}) RETURNING id
  `);

  // Compliance against a PARTNER-WIDE software policy (survives) and an org automation policy.
  const softwarePolicy = await id(sql`
    INSERT INTO software_policies (partner_id, name, mode, rules)
    VALUES (${h.partnerId}, ${`Wide policy ${suffix}`}, 'audit', '{}'::jsonb) RETURNING id
  `);
  const softwareCompliance = await id(sql`
    INSERT INTO software_compliance_status (device_id, policy_id, last_checked)
    VALUES (${h.deviceErased}, ${softwarePolicy}, now()) RETURNING id
  `);
  const automationPolicy = await id(sql`
    INSERT INTO automation_policies (org_id, name, rules, targets)
    VALUES (${h.orgErased}, 'Baseline', '[]'::jsonb, '{}'::jsonb) RETURNING id
  `);
  const automationCompliance = await id(sql`
    INSERT INTO automation_policy_compliance (device_id, policy_id)
    VALUES (${h.deviceErased}, ${automationPolicy}) RETURNING id
  `);
  const automation = await id(sql`
    INSERT INTO automations (org_id, name, trigger, actions)
    VALUES (${h.orgErased}, 'Nightly', '{}'::jsonb, '[]'::jsonb) RETURNING id
  `);
  const automationRun = await id(sql`
    INSERT INTO automation_runs (automation_id, triggered_by) VALUES (${automation}, 'schedule') RETURNING id
  `);

  // Alerts: a notification through an org channel, and a correlation pair.
  const alertIds: string[] = [];
  for (const title of ['Disk', 'Disk (child)']) {
    alertIds.push(await id(sql`
      INSERT INTO alerts (device_id, org_id, severity, title)
      VALUES (${h.deviceErased}, ${h.orgErased}, 'high', ${title}) RETURNING id
    `));
  }
  const channel = await id(sql`
    INSERT INTO notification_channels (org_id, name, type) VALUES (${h.orgErased}, 'Ops mail', 'email') RETURNING id
  `);
  const alertNotification = await id(sql`
    INSERT INTO alert_notifications (alert_id, channel_id) VALUES (${alertIds[0]}, ${channel}) RETURNING id
  `);
  const alertCorrelation = await id(sql`
    INSERT INTO alert_correlations (parent_alert_id, child_alert_id, correlation_type)
    VALUES (${alertIds[0]}, ${alertIds[1]}, 'device') RETURNING id
  `);

  // Ticket with a comment by an org user.
  const ticket = await id(sql`
    INSERT INTO tickets (org_id, ticket_number, subject, created_at, updated_at)
    VALUES (${h.orgErased}, ${`FKC-${suffix}`}, 'Printer', now(), now()) RETURNING id
  `);
  const ticketComment = await id(sql`
    INSERT INTO ticket_comments (ticket_id, user_id, content) VALUES (${ticket}, ${h.orgOnlyUserId}, 'On it') RETURNING id
  `);

  // AI chat.
  const aiSession = await id(sql`
    INSERT INTO ai_sessions (org_id, model) VALUES (${h.orgErased}, 'test-model') RETURNING id
  `);
  const aiMessage = await id(sql`
    INSERT INTO ai_messages (session_id, role) VALUES (${aiSession}, 'user') RETURNING id
  `);
  const aiToolExecution = await id(sql`
    INSERT INTO ai_tool_executions (session_id, tool_name, tool_input, approved_by)
    VALUES (${aiSession}, 'list_devices', '{}'::jsonb, ${h.orgOnlyUserId}) RETURNING id
  `);

  // Maintenance occurrence of an org window.
  const window = await id(sql`
    INSERT INTO maintenance_windows (org_id, name, start_time, end_time, target_type, created_at, updated_at)
    VALUES (${h.orgErased}, 'Window', now(), now() + interval '1 hour', 'all', now(), now()) RETURNING id
  `);
  const occurrence = await id(sql`
    INSERT INTO maintenance_occurrences (window_id, start_time, end_time)
    VALUES (${window}, now(), now() + interval '1 hour') RETURNING id
  `);

  // Org custom role with a permission, reviewed in a partner-wide access review.
  const orgRole = await id(sql`
    INSERT INTO roles (partner_id, org_id, scope, name)
    VALUES (${h.partnerId}, ${h.orgErased}, 'organization', ${`Custom ${suffix}`}) RETURNING id
  `);
  const permission = await id(sql`
    INSERT INTO permissions (resource, action) VALUES (${`fkc-${suffix}`}, 'read') RETURNING id
  `);
  await db.execute(sql`INSERT INTO role_permissions (role_id, permission_id) VALUES (${orgRole}, ${permission})`);
  const review = await id(sql`
    INSERT INTO access_reviews (partner_id, name) VALUES (${h.partnerId}, 'Quarterly') RETURNING id
  `);
  const reviewItem = await id(sql`
    INSERT INTO access_review_items (review_id, user_id, role_id, reviewed_by)
    VALUES (${review}, ${h.orgOnlyUserId}, ${orgRole}, ${h.orgOnlyUserId}) RETURNING id
  `);

  // Interactive session of the org-only user.
  const session = await id(sql`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${h.orgOnlyUserId}, ${`hash-${suffix}`}, now() + interval '1 day') RETURNING id
  `);

  // SSO: the shared user has a link through a PARTNER-level provider (kept,
  // it is the partner's) and one through the erased org's provider (erased).
  const partnerProvider = await id(sql`
    INSERT INTO sso_providers (partner_id, name, type) VALUES (${h.partnerId}, 'Partner IdP', 'oidc') RETURNING id
  `);
  const orgProvider = await id(sql`
    INSERT INTO sso_providers (org_id, name, type) VALUES (${h.orgErased}, 'Org IdP', 'oidc') RETURNING id
  `);
  const sharedPartnerSsoIdentityId = await id(sql`
    INSERT INTO user_sso_identities (user_id, provider_id, external_id, email)
    VALUES (${h.sharedUserId}, ${partnerProvider}, ${`p-${suffix}`}, 'shared@example.test') RETURNING id
  `);
  const sharedOrgSsoIdentityId = await id(sql`
    INSERT INTO user_sso_identities (user_id, provider_id, external_id, email)
    VALUES (${h.sharedUserId}, ${orgProvider}, ${`o-${suffix}`}, 'shared@example.test') RETURNING id
  `);

  // Memberships that do / do not still grant something once the org is gone.
  const { role_id: partnerRoleId } = await one<{ role_id: string }>(sql`
    SELECT role_id FROM partner_users WHERE id = ${h.sharedMembershipId}
  `);
  const mkMember = async (tag: string, orgIds: string[]) => {
    const userId = await id(sql`
      INSERT INTO users (partner_id, org_id, email, name, status)
      VALUES (${h.partnerId}, ${h.orgErased}, ${`fkc-${tag}-${suffix}@example.test`}, ${tag}, 'active') RETURNING id
    `);
    const membershipId = await id(sql`
      INSERT INTO partner_users (partner_id, user_id, role_id, org_access, org_ids)
      VALUES (${h.partnerId}, ${userId}, ${partnerRoleId}, 'selected',
              ARRAY[${sql.join(orgIds.map((o) => sql`${o}::uuid`), sql`, `)}])
      RETURNING id
    `);
    return { userId, membershipId };
  };
  const selectedOnly = await mkMember('selected-only', [h.orgErased]);
  const selectedBoth = await mkMember('selected-both', [h.orgErased, h.orgControl]);

  return {
    children: [
      { table: 'patch_job_results', column: 'id', values: [patchResult] },
      { table: 'patch_rollbacks', column: 'id', values: [patchRollback] },
      { table: 'deployment_devices', column: 'id', values: [deploymentDevice] },
      { table: 'software_compliance_status', column: 'id', values: [softwareCompliance] },
      { table: 'automation_policy_compliance', column: 'id', values: [automationCompliance] },
      { table: 'automation_runs', column: 'id', values: [automationRun] },
      { table: 'alert_notifications', column: 'id', values: [alertNotification] },
      { table: 'alert_correlations', column: 'id', values: [alertCorrelation] },
      { table: 'ticket_comments', column: 'id', values: [ticketComment] },
      { table: 'ai_messages', column: 'id', values: [aiMessage] },
      { table: 'ai_tool_executions', column: 'id', values: [aiToolExecution] },
      { table: 'maintenance_occurrences', column: 'id', values: [occurrence] },
      { table: 'role_permissions', column: 'role_id', values: [orgRole] },
      { table: 'access_review_items', column: 'id', values: [reviewItem] },
      { table: 'sessions', column: 'id', values: [session] },
    ],
    selectedOnlyUserId: selectedOnly.userId,
    selectedOnlyMembershipId: selectedOnly.membershipId,
    selectedBothUserId: selectedBoth.userId,
    sharedPartnerSsoIdentityId,
    sharedOrgSsoIdentityId,
  };
}

async function childCounts(r: RealisticHandles): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const { table, column, values } of r.children) {
    out[table] = await count(sql`
      SELECT count(*) AS n FROM ${sql.raw(`"${table}"`)}
      WHERE ${sql.raw(`"${column}"`)} IN (${sql.join(values.map((v) => sql`${v}::uuid`), sql`, `)})
    `);
  }
  return out;
}

describe('cascadeDeleteOrg — a realistic, in-use org', () => {
  let h: Handles;
  let r: RealisticHandles;

  beforeEach(async () => {
    h = await seed();
    r = await seedRealistic(h);
  });

  afterEach(() => {
    delete __tenantCascadeTestHooks.afterTableStep;
  });

  it('completes and leaves no FK-only child row behind', async () => {
    const before = await childCounts(r);
    expect(Object.values(before).every((n) => n === 1)).toBe(true);

    await cascadeDeleteOrg(h.orgErased, h.actorUserId);

    expect(await childCounts(r)).toEqual(Object.fromEntries(Object.keys(before).map((t) => [t, 0])));
    expect(await count(sql`SELECT count(*) AS n FROM organizations WHERE id = ${h.orgErased}`)).toBe(0);
  });

  it('keeps the shared user\'s partner-level SSO link and erases the link through the org\'s provider', async () => {
    await cascadeDeleteOrg(h.orgErased, h.actorUserId);

    expect(await count(sql`SELECT count(*) AS n FROM user_sso_identities WHERE id = ${r.sharedPartnerSsoIdentityId}`)).toBe(1);
    expect(await count(sql`SELECT count(*) AS n FROM user_sso_identities WHERE id = ${r.sharedOrgSsoIdentityId}`)).toBe(0);
  });

  it('deletes a member whose only selected org is the erased one, and detaches one that selects another org', async () => {
    const stats = await cascadeDeleteOrg(h.orgErased, h.actorUserId);

    expect(await count(sql`SELECT count(*) AS n FROM users WHERE id = ${r.selectedOnlyUserId}`)).toBe(0);
    expect(await count(sql`SELECT count(*) AS n FROM partner_users WHERE id = ${r.selectedOnlyMembershipId}`)).toBe(0);

    const both = await one<{ org_id: string | null }>(sql`SELECT org_id FROM users WHERE id = ${r.selectedBothUserId}`);
    expect(both.org_id).toBeNull();
    const selection = await one<{ org_ids: string[] }>(sql`
      SELECT org_ids FROM partner_users WHERE user_id = ${r.selectedBothUserId}
    `);
    expect(selection.org_ids).toEqual([h.orgControl]);
    // The 'all' shared user from the base fixture plus selectedBoth.
    expect(stats.usersDetached).toBe(2);
  });

  it('a re-run after an aborted walk completes, and detaches each shared user exactly once', async () => {
    const epochBefore = await one<{ auth_epoch: number }>(sql`SELECT auth_epoch FROM users WHERE id = ${h.sharedUserId}`);
    __tenantCascadeTestHooks.afterTableStep = async (table) => {
      if (table === 'devices') throw new Error('injected mid-walk fault');
    };
    await expect(cascadeDeleteOrg(h.orgErased, h.actorUserId)).rejects.toThrow(/injected mid-walk fault/);
    delete __tenantCascadeTestHooks.afterTableStep;

    // Partial: the detach committed, the org still exists.
    expect(await count(sql`SELECT count(*) AS n FROM organizations WHERE id = ${h.orgErased}`)).toBe(1);
    expect((await one<{ org_id: string | null }>(sql`SELECT org_id FROM users WHERE id = ${h.sharedUserId}`)).org_id).toBeNull();

    const stats = await cascadeDeleteOrg(h.orgErased, h.actorUserId);
    expect(stats.usersDetached).toBe(0);

    expect(await count(sql`SELECT count(*) AS n FROM organizations WHERE id = ${h.orgErased}`)).toBe(0);
    expect(Object.values(await childCounts(r)).every((n) => n === 0)).toBe(true);
    const epochAfter = await one<{ auth_epoch: number }>(sql`SELECT auth_epoch FROM users WHERE id = ${h.sharedUserId}`);
    expect(epochAfter.auth_epoch).toBe(epochBefore.auth_epoch + 1);
    expect(await count(sql`SELECT count(*) AS n FROM partner_users WHERE id = ${h.sharedMembershipId}`)).toBe(1);
  });
});

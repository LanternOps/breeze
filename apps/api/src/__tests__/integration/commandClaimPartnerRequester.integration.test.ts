import './setup';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { deviceCommands, devices } from '../../db/schema';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
} from './db-utils';
import { getTestDb } from './setup';

/**
 * The heartbeat claim runs INSIDE the agent's org-scoped DB access context
 * (routes/agents/heartbeat.ts `dbContext`: scope organization, the device's
 * org only, NO partner-axis access, `currentPartnerId` = the owning MSP).
 * `users` is a dual-axis RLS table, so a partner-level requester (MSP
 * technician: org_id NULL) is invisible from there. The requester-active check
 * in `partitionClaimable` used to read `users.status` directly and so
 * cancelled every heartbeat-delivered command a technician had queued with
 * `requester_inactive`.
 *
 * A mocked unit test cannot decide this — the bug IS the RLS policy — so every
 * case here claims as the unprivileged `breeze_app` role under the exact
 * context shape the heartbeat builds.
 */

const AGENT_CAPS = {
  peripheralPolicyProtocolVersion: 2,
  rollbackProtocolVersion: 1,
  pamLifetimeProtocolVersion: 2,
} as const;

function agentContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: partnerId,
  };
}

async function makeDevice(orgId: string, siteId: string) {
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `claim-requester-${randomUUID()}`,
      hostname: `host-${randomUUID().slice(0, 8)}`,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning();
  if (!device) throw new Error('device fixture insert failed');
  return device;
}

async function queue(deviceId: string, orgId: string, createdBy: string) {
  const [row] = await getTestDb()
    .insert(deviceCommands)
    .values({
      deviceId,
      type: 'refresh_inventory',
      payload: {},
      status: 'pending',
      targetRole: 'agent',
      createdBy,
      submittedOrgId: orgId,
      deliverBy: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning();
  if (!row) throw new Error('command fixture insert failed');
  return row;
}

async function commandRow(id: string) {
  const [row] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, id)).limit(1);
  return row;
}

describe('heartbeat claim — requester resolution under the agent RLS context', () => {
  let partner: Awaited<ReturnType<typeof createPartner>>;
  let org: Awaited<ReturnType<typeof createOrganization>>;
  let device: Awaited<ReturnType<typeof makeDevice>>;

  beforeEach(async () => {
    partner = await createPartner();
    org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    device = await makeDevice(org.id, site.id);
  });

  async function claimAsAgent() {
    return withDbAccessContext(agentContext(org.id, partner.id), () =>
      claimPendingCommandsForDevice(device.id, 10, 'agent', undefined, { ...AGENT_CAPS }),
    );
  }

  async function partnerTech(partnerId: string, status: 'active' | 'disabled' = 'active') {
    const user = await createUser({
      partnerId,
      orgId: null,
      email: `tech-${randomUUID()}@example.com`,
      status,
    });
    const role = await createRole({ scope: 'partner', partnerId });
    await assignUserToPartner(user.id, partnerId, role.id, 'all');
    return user;
  }

  it('delivers a command queued by an ACTIVE partner-level technician of the device\'s MSP', async () => {
    const tech = await partnerTech(partner.id);
    const cmd = await queue(device.id, org.id, tech.id);

    const claimed = await claimAsAgent();

    expect(claimed.map((c) => c.id)).toEqual([cmd.id]);
    const row = await commandRow(cmd.id);
    expect(row?.status).toBe('sent');
  });

  it('delivers a command queued by MSP staff who are also members of the MSP internal org', async () => {
    const internalOrg = await createOrganization({ partnerId: partner.id, type: 'internal' });
    const staff = await createUser({
      partnerId: partner.id,
      orgId: internalOrg.id,
      email: `staff-${randomUUID()}@example.com`,
    });
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    await assignUserToPartner(staff.id, partner.id, role.id, 'all');
    const cmd = await queue(device.id, org.id, staff.id);

    const claimed = await claimAsAgent();

    expect(claimed.map((c) => c.id)).toEqual([cmd.id]);
  });

  it('delivers a command queued by an active user of the device\'s own org (control)', async () => {
    const orgUser = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `orguser-${randomUUID()}@example.com`,
    });
    const role = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
    await assignUserToOrganization(orgUser.id, org.id, role.id);
    const cmd = await queue(device.id, org.id, orgUser.id);

    const claimed = await claimAsAgent();

    expect(claimed.map((c) => c.id)).toEqual([cmd.id]);
  });

  it('cancels a command whose partner-level requester has been DISABLED', async () => {
    const tech = await partnerTech(partner.id, 'disabled');
    const cmd = await queue(device.id, org.id, tech.id);

    const claimed = await claimAsAgent();

    expect(claimed).toEqual([]);
    const row = await commandRow(cmd.id);
    expect(row?.status).toBe('cancelled');
    expect((row?.result as { reason?: string } | null)?.reason).toBe('requester_inactive');
  });

  it('cancels a command whose requester is an active technician of a DIFFERENT partner', async () => {
    const otherPartner = await createPartner();
    const foreignTech = await partnerTech(otherPartner.id);
    const cmd = await queue(device.id, org.id, foreignTech.id);

    const claimed = await claimAsAgent();

    expect(claimed).toEqual([]);
    const row = await commandRow(cmd.id);
    expect(row?.status).toBe('cancelled');
    expect((row?.result as { reason?: string } | null)?.reason).toBe('requester_inactive');
  });

  it('the resolver refuses to answer for an org the CALLER cannot access, and restores the caller scope', async () => {
    const tech = await partnerTech(partner.id);
    const otherOrg = await createOrganization({ partnerId: partner.id });

    const result = await withDbAccessContext(agentContext(otherOrg.id, partner.id), async () => {
      // Caller is scoped to otherOrg; asking about `org` must not answer.
      const probe = (await db.execute(
        sql`SELECT public.breeze_command_requester_is_active(${tech.id}::uuid, ${org.id}::uuid) AS active`,
      )) as unknown as Array<{ active: boolean }>;
      const own = (await db.execute(
        sql`SELECT public.breeze_command_requester_is_active(${tech.id}::uuid, ${otherOrg.id}::uuid) AS active`,
      )) as unknown as Array<{ active: boolean }>;
      const scope = (await db.execute(
        sql`SELECT current_setting('breeze.scope', true) AS scope`,
      )) as unknown as Array<{ scope: string }>;
      return { probe: probe[0]?.active, own: own[0]?.active, scope: scope[0]?.scope };
    });

    expect(result.probe).toBe(false);
    expect(result.own).toBe(true);
    // The in-body elevation must not persist into the caller's transaction.
    expect(result.scope).toBe('organization');
  });

  it('pins the resolver shape in the catalog: SECURITY DEFINER, fixed search_path, in-body elevation, EXECUTE only for breeze_app', async () => {
    // On this stack the migration owner is a superuser, so NO behavioural test
    // above fails if the in-body `breeze.scope` elevation is removed — only
    // this catalog assertion does (same reasoning as customFieldShadowing's
    // 'pins the in-body scope elevation').
    const rows = (await getTestDb().execute(sql`
      SELECT p.prosecdef,
             p.proconfig,
             pg_get_functiondef(p.oid) AS def,
             has_function_privilege('breeze_app', p.oid, 'EXECUTE') AS app_exec,
             EXISTS (
               SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
             ) AS public_exec
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'breeze_command_requester_is_active'
    `)) as unknown as Array<{
      prosecdef: boolean;
      proconfig: string[] | null;
      def: string;
      app_exec: boolean;
      public_exec: boolean;
    }>;

    expect(rows).toHaveLength(1);
    const fn = rows[0]!;
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toEqual(['search_path=pg_catalog, public']);
    expect(fn.def).toContain("set_config('breeze.scope', 'system', true)");
    expect(fn.def).toContain("set_config('breeze.scope', COALESCE(_prev_scope, ''), true)");
    expect(fn.app_exec).toBe(true);
    expect(fn.public_exec).toBe(false);
  });

  it('cancels a command whose requester is an active user of a SIBLING org of the same partner', async () => {
    const siblingOrg = await createOrganization({ partnerId: partner.id });
    const siblingUser = await createUser({
      partnerId: partner.id,
      orgId: siblingOrg.id,
      email: `sibling-${randomUUID()}@example.com`,
    });
    const role = await createRole({ scope: 'organization', orgId: siblingOrg.id, partnerId: partner.id });
    await assignUserToOrganization(siblingUser.id, siblingOrg.id, role.id);
    const cmd = await queue(device.id, org.id, siblingUser.id);

    const claimed = await claimAsAgent();

    expect(claimed).toEqual([]);
    const row = await commandRow(cmd.id);
    expect(row?.status).toBe('cancelled');
    expect((row?.result as { reason?: string } | null)?.reason).toBe('requester_inactive');
  });
});

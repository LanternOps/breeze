import './setup';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Count every attempt to step outside the ambient DB context during a claim.
// `runOutsideDbContext` is the mandatory first step of every system-context
// escalation (`runOutsideDbContext(() => withSystemDbAccessContext(...))`),
// each of which borrows a SECOND pooled connection while the claim
// transaction still holds its own — the #1105 pool-exhaustion shape.
const dbSpy = vi.hoisted(() => ({ outside: 0 }));
vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db')>();
  return {
    ...actual,
    runOutsideDbContext: ((fn: () => unknown) => {
      dbSpy.outside += 1;
      return (actual.runOutsideDbContext as (f: () => unknown) => unknown)(fn);
    }) as typeof actual.runOutsideDbContext,
  };
});

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
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

/**
 * Delivery-time script revalidation (scriptCommandRevalidation.ts) runs on the
 * heartbeat claim transaction, i.e. INSIDE the agent's org-scoped DB context
 * (device org only, no partner-axis access). A partner-level technician
 * (users.org_id NULL, role via partner_users) is invisible to that context on
 * `users` and `partner_users`, so a plain read there resolved no requester and
 * cancelled every script a technician queued for an offline device as
 * `scope_changed`. Mocks cannot decide this — the bug is the RLS policy — so
 * every case claims as `breeze_app` under the context the heartbeat builds.
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

const EXECUTE = { resource: 'scripts', action: 'execute' };
const READ = { resource: 'devices', action: 'read' };

describe('heartbeat claim — script revalidation for a partner-level requester', () => {
  let partner: Awaited<ReturnType<typeof createPartner>>;
  let org: Awaited<ReturnType<typeof createOrganization>>;
  let site: Awaited<ReturnType<typeof createSite>>;
  let deviceId: string;

  beforeEach(async () => {
    dbSpy.outside = 0;
    partner = await createPartner();
    org = await createOrganization({ partnerId: partner.id });
    site = await createSite({ orgId: org.id });
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `script-reval-${randomUUID()}`,
        hostname: `host-${randomUUID().slice(0, 8)}`,
        osType: 'linux',
        osVersion: 'test',
        architecture: 'x64',
        agentVersion: '0.0.0-test',
        status: 'online',
      })
      .returning();
    if (!device) throw new Error('device fixture insert failed');
    deviceId = device.id;
  });

  async function queueScript(createdBy: string) {
    const [row] = await getTestDb()
      .insert(deviceCommands)
      .values({
        deviceId,
        type: 'script',
        payload: { scriptId: randomUUID(), executionId: randomUUID(), language: 'bash', content: 'echo hi' },
        status: 'pending',
        targetRole: 'agent',
        createdBy,
        submittedOrgId: org.id,
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

  async function claimAsAgent() {
    return withDbAccessContext(agentContext(org.id, partner.id), () =>
      claimPendingCommandsForDevice(deviceId, 10, 'agent', undefined, { ...AGENT_CAPS }),
    );
  }

  async function partnerTech(perms: Array<{ resource: string; action: string }>, orgAccess: 'all' | 'selected' | 'none' = 'all') {
    const user = await createUser({
      partnerId: partner.id,
      orgId: null,
      email: `tech-${randomUUID()}@example.com`,
    });
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    if (perms.length > 0) await grantRolePermissions(role!.id, perms);
    await assignUserToPartner(user.id, partner.id, role!.id, orgAccess);
    return user;
  }

  async function orgUser(perms: Array<{ resource: string; action: string }>) {
    const user = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `orguser-${randomUUID()}@example.com`,
    });
    const role = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
    if (perms.length > 0) await grantRolePermissions(role!.id, perms);
    await assignUserToOrganization(user.id, org.id, role!.id);
    return user;
  }

  it('delivers a script queued by a partner-level technician holding scripts:execute', async () => {
    const tech = await partnerTech([READ, EXECUTE]);
    const cmd = await queueScript(tech.id);

    const claimed = await claimAsAgent();

    expect(claimed.map((c) => c.id)).toEqual([cmd.id]);
    expect((await commandRow(cmd.id))?.status).toBe('sent');
  });

  it('opens no second pooled connection while revalidating a partner technician\'s script', async () => {
    const tech = await partnerTech([READ, EXECUTE]);
    await queueScript(tech.id);

    dbSpy.outside = 0;
    await claimAsAgent();

    expect(dbSpy.outside).toBe(0);
  });

  it('cancels (scope_changed) a script whose partner technician no longer holds scripts:execute', async () => {
    const tech = await partnerTech([READ]);
    const cmd = await queueScript(tech.id);

    const claimed = await claimAsAgent();

    expect(claimed).toEqual([]);
    const row = await commandRow(cmd.id);
    expect(row?.status).toBe('cancelled');
    expect((row?.result as { reason?: string } | null)?.reason).toBe('scope_changed');
  });

  it('cancels (scope_changed) a script whose partner technician lost access to the device org', async () => {
    const tech = await partnerTech([READ, EXECUTE], 'none');
    const cmd = await queueScript(tech.id);

    const claimed = await claimAsAgent();

    expect(claimed).toEqual([]);
    expect(((await commandRow(cmd.id))?.result as { reason?: string } | null)?.reason).toBe('scope_changed');
  });

  it('delivers a script queued by an org-level user holding scripts:execute (control)', async () => {
    const user = await orgUser([READ, EXECUTE]);
    const cmd = await queueScript(user.id);

    const claimed = await claimAsAgent();

    expect(claimed.map((c) => c.id)).toEqual([cmd.id]);
  });

  it('cancels (scope_changed) a script whose org-level user no longer holds scripts:execute (control)', async () => {
    const user = await orgUser([READ]);
    const cmd = await queueScript(user.id);

    const claimed = await claimAsAgent();

    expect(claimed).toEqual([]);
    expect(((await commandRow(cmd.id))?.result as { reason?: string } | null)?.reason).toBe('scope_changed');
  });
  it('the resolver answers nothing for an org the CALLER cannot access, and restores the caller scope', async () => {
    const tech = await partnerTech([READ, EXECUTE]);
    const otherOrg = await createOrganization({ partnerId: partner.id });

    const result = await withDbAccessContext(agentContext(otherOrg.id, partner.id), async () => {
      const probe = (await db.execute(
        sql`SELECT public.breeze_command_requester_authority(${tech.id}::uuid, ${org.id}::uuid) AS authority`,
      )) as unknown as Array<{ authority: unknown }>;
      const own = (await db.execute(
        sql`SELECT public.breeze_command_requester_authority(${tech.id}::uuid, ${otherOrg.id}::uuid) AS authority`,
      )) as unknown as Array<{ authority: { scope?: string; orgAccess?: string } | null }>;
      const scope = (await db.execute(
        sql`SELECT current_setting('breeze.scope', true) AS scope`,
      )) as unknown as Array<{ scope: string }>;
      return { probe: probe[0]?.authority, own: own[0]?.authority, scope: scope[0]?.scope };
    });

    expect(result.probe).toBeNull();
    expect(result.own).toMatchObject({ scope: 'partner', orgAccess: 'all' });
    expect(result.scope).toBe('organization');
  });

  it('the resolver describes no user outside the target org\'s partner, and discloses no other customer org', async () => {
    const otherPartner = await createPartner();
    const foreign = await createUser({ partnerId: otherPartner.id, orgId: null, email: `foreign-${randomUUID()}@example.com` });
    const foreignRole = await createRole({ scope: 'partner', partnerId: otherPartner.id });
    await grantRolePermissions(foreignRole!.id, [EXECUTE]);
    await assignUserToPartner(foreign.id, otherPartner.id, foreignRole!.id, 'all');

    const sibling = await createOrganization({ partnerId: partner.id });
    const selected = await partnerTech([READ, EXECUTE], 'selected');
    await getTestDb().execute(
      sql`UPDATE partner_users SET org_ids = ARRAY[${org.id}::uuid, ${sibling.id}::uuid] WHERE user_id = ${selected.id}::uuid`,
    );
    const elsewhere = await partnerTech([READ, EXECUTE], 'selected');
    await getTestDb().execute(
      sql`UPDATE partner_users SET org_ids = ARRAY[${sibling.id}::uuid] WHERE user_id = ${elsewhere.id}::uuid`,
    );

    const read = (userId: string) =>
      withDbAccessContext(agentContext(org.id, partner.id), async () => {
        const rows = (await db.execute(
          sql`SELECT public.breeze_command_requester_authority(${userId}::uuid, ${org.id}::uuid) AS authority`,
        )) as unknown as Array<{ authority: { allowedOrgIds?: unknown } | null }>;
        return rows[0]?.authority ?? null;
      });

    expect(await read(foreign.id)).toBeNull();
    expect((await read(selected.id))?.allowedOrgIds).toEqual([org.id]);
    expect((await read(elsewhere.id))?.allowedOrgIds).toEqual([]);
  });

  it('delivers for a technician whose SELECTED org list covers the device org, cancels when it does not', async () => {
    const sibling = await createOrganization({ partnerId: partner.id });
    const covered = await partnerTech([READ, EXECUTE], 'selected');
    await getTestDb().execute(
      sql`UPDATE partner_users SET org_ids = ARRAY[${org.id}::uuid] WHERE user_id = ${covered.id}::uuid`,
    );
    const uncovered = await partnerTech([READ, EXECUTE], 'selected');
    await getTestDb().execute(
      sql`UPDATE partner_users SET org_ids = ARRAY[${sibling.id}::uuid] WHERE user_id = ${uncovered.id}::uuid`,
    );
    const ok = await queueScript(covered.id);
    const refused = await queueScript(uncovered.id);

    const claimed = await claimAsAgent();

    expect(claimed.map((c) => c.id)).toEqual([ok.id]);
    expect(((await commandRow(refused.id))?.result as { reason?: string } | null)?.reason).toBe('scope_changed');
  });

  it('still delivers a platform admin\'s script to another partner\'s device (unchanged)', async () => {
    const homePartner = await createPartner();
    const admin = await createUser({ partnerId: homePartner.id, orgId: null, email: `admin-${randomUUID()}@example.com` });
    const role = await createRole({ scope: 'partner', partnerId: homePartner.id });
    await grantRolePermissions(role!.id, [READ, EXECUTE]);
    await assignUserToPartner(admin.id, homePartner.id, role!.id, 'all');
    await getTestDb().execute(sql`UPDATE users SET is_platform_admin = true WHERE id = ${admin.id}::uuid`);
    const cmd = await queueScript(admin.id);

    const claimed = await claimAsAgent();

    expect(claimed.map((c) => c.id)).toEqual([cmd.id]);
  });

  it('pins the resolver shape in the catalog: SECURITY DEFINER, fixed search_path, in-body elevation, EXECUTE only for breeze_app', async () => {
    // The stack's migration owner is a superuser, so no behavioural case above
    // fails if the in-body elevation is dropped — only this assertion does.
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
         AND p.proname = 'breeze_command_requester_authority'
    `)) as unknown as Array<{ prosecdef: boolean; proconfig: string[] | null; def: string; app_exec: boolean; public_exec: boolean }>;

    expect(rows).toHaveLength(1);
    const fn = rows[0]!;
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toEqual(['search_path=pg_catalog, public']);
    expect(fn.def).toContain("set_config('breeze.scope', 'system', true)");
    expect(fn.def).toContain("set_config('breeze.scope', COALESCE(_prev_scope, ''), true)");
    expect(fn.app_exec).toBe(true);
    expect(fn.public_exec).toBe(false);
  });
});

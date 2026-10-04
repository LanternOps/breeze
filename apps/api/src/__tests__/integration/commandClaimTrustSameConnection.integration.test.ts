import './setup';

import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { auditLogs, deviceCommands, devices, partners } from '../../db/schema';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * The claim re-checks partner trust for every queued command while it holds
 * its claim transaction's pooled connection. That check must read on the SAME
 * connection: a lookup that borrows a second pooled connection per claim
 * deadlocks the pool once concurrent claims >= pool size (postgres-js has no
 * acquire timeout).
 *
 * The first case asserts the MECHANISM through transaction visibility rather
 * than by sizing a pool: it flips the partner to `restricted` inside an OPEN
 * transaction and claims from inside that same transaction. An uncommitted
 * write is visible only on its own connection, so
 *   - a check read on the claim's connection -> sees `restricted` -> cancelled
 *   - a check that opens a second connection -> sees `trusted`    -> delivered
 * The remaining cases prove the same-connection read works under the agent's
 * org-scoped heartbeat context, as the unprivileged `breeze_app` role.
 */

const AGENT_CAPS = {
  peripheralPolicyProtocolVersion: 2,
  rollbackProtocolVersion: 1,
  pamLifetimeProtocolVersion: 2,
} as const;

const ENV_KEYS = ['IS_HOSTED', 'PARTNER_TRUST_MODE'] as const;

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
      agentId: `claim-trust-${randomUUID()}`,
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

async function queue(deviceId: string, orgId: string, type = 'capture_pprof') {
  const [row] = await getTestDb()
    .insert(deviceCommands)
    .values({
      deviceId,
      type,
      payload: {},
      status: 'pending',
      targetRole: 'agent',
      submittedOrgId: orgId,
      deliverBy: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning();
  if (!row) throw new Error('command fixture insert failed');
  return row;
}

function reasonOf(row: { result: unknown } | undefined) {
  return (row?.result as { reason?: string } | null)?.reason;
}

describe('claim-time partner trust check reads on the claim transaction connection', () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  let partner: Awaited<ReturnType<typeof createPartner>>;
  let org: Awaited<ReturnType<typeof createOrganization>>;
  let device: Awaited<ReturnType<typeof makeDevice>>;

  beforeEach(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.IS_HOSTED = 'true';
    process.env.PARTNER_TRUST_MODE = 'enforce';
    partner = await createPartner();
    org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    device = await makeDevice(org.id, site.id);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('sees an uncommitted trust change made earlier in the same transaction (no second connection)', async () => {
    const cmds = [await queue(device.id, org.id), await queue(device.id, org.id), await queue(device.id, org.id)];

    const outcome = await withSystemDbAccessContext(async () => {
      await db.update(partners).set({ trustState: 'restricted' }).where(eq(partners.id, partner.id));
      const claimed = await claimPendingCommandsForDevice(device.id, 10, 'agent', undefined, { ...AGENT_CAPS });
      const rows = await db
        .select({ id: deviceCommands.id, status: deviceCommands.status, result: deviceCommands.result })
        .from(deviceCommands)
        .where(eq(deviceCommands.deviceId, device.id));
      return { claimed, rows };
    });

    expect(outcome.claimed).toEqual([]);
    expect(outcome.rows).toHaveLength(cmds.length);
    for (const row of outcome.rows) {
      expect(row.status).toBe('cancelled');
      expect(reasonOf(row)).toBe('trust_denied');
    }
  });

  it('under the agent heartbeat context: a restricted partner\'s commands are cancelled as trust_denied and audited after the claim', async () => {
    await getTestDb().update(partners).set({ trustState: 'restricted' }).where(eq(partners.id, partner.id));
    const cmd = await queue(device.id, org.id);

    const claimed = await withDbAccessContext(agentContext(org.id, partner.id), () =>
      claimPendingCommandsForDevice(device.id, 10, 'agent', undefined, { ...AGENT_CAPS }),
    );

    expect(claimed).toEqual([]);
    const [row] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, cmd.id));
    expect(row?.status).toBe('cancelled');
    expect(reasonOf(row)).toBe('trust_denied');

    // The denial audit is written once the claim's context has exited.
    let audits: unknown[] = [];
    for (let i = 0; i < 50 && audits.length === 0; i++) {
      audits = await getTestDb()
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'partner.trust.capability_denied'), eq(auditLogs.resourceId, partner.id)));
      if (audits.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(audits).toHaveLength(1);
  });

  it('under the agent heartbeat context: a trusted partner\'s commands are delivered', async () => {
    const cmd = await queue(device.id, org.id);

    const claimed = await withDbAccessContext(agentContext(org.id, partner.id), () =>
      claimPendingCommandsForDevice(device.id, 10, 'agent', undefined, { ...AGENT_CAPS }),
    );

    expect(claimed.map((c) => c.id)).toEqual([cmd.id]);
  });

  it('the trust resolver answers nothing for an org the CALLER cannot access, and restores the caller scope', async () => {
    const otherOrg = await createOrganization({ partnerId: partner.id });

    const result = await withDbAccessContext(agentContext(otherOrg.id, partner.id), async () => {
      const probe = (await db.execute(
        sql`SELECT partner_id, trust_state FROM public.breeze_org_partner_trust_state(${org.id}::uuid)`,
      )) as unknown as Array<{ partner_id: string | null; trust_state: string | null }>;
      const own = (await db.execute(
        sql`SELECT partner_id, trust_state FROM public.breeze_org_partner_trust_state(${otherOrg.id}::uuid)`,
      )) as unknown as Array<{ partner_id: string | null; trust_state: string | null }>;
      const scope = (await db.execute(
        sql`SELECT current_setting('breeze.scope', true) AS scope`,
      )) as unknown as Array<{ scope: string }>;
      return { probe: probe[0], own: own[0], scope: scope[0]?.scope };
    });

    expect(result.probe).toEqual({ partner_id: null, trust_state: null });
    expect(result.own).toEqual({ partner_id: partner.id, trust_state: 'trusted' });
    expect(result.scope).toBe('organization');
  });

  it('pins the resolver shape in the catalog: SECURITY DEFINER, fixed search_path, in-body elevation, EXECUTE only for breeze_app', async () => {
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
         AND p.proname = 'breeze_org_partner_trust_state'
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
});

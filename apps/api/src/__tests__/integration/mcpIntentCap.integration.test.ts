/**
 * B-W04 (#6158, D-B27, Review Focus 4): the per-origin live cap on MCP-origin
 * action intents holds under concurrency against real Postgres. The cap is
 * serialised by a per-origin advisory lock inside createActionIntent's
 * creation transaction and counted on action_intents_live_origin_idx; the
 * mocked unit suite can prove neither.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { createActionIntent, transitionIntent } from '../../services/actionIntents/intentService';
import { PERMISSIONS } from '../../services/permissions';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';

const TOOL = 'restore_snapshot';

/** The AuthContext buildAuthFromApiKey produces for an org-pinned API key. */
function apiKeyAuth(apiKeyId: string, user: { id: string; email: string }, orgId: string, partnerId: string): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  return {
    principal: { kind: 'api_key', apiKeyId },
    user: { id: user.id, email: user.email, name: 'API Key: ci', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition,
    canAccessOrg,
  };
}

interface Scenario { partnerId: string; orgId: string; requester: { id: string; email: string } }

async function seed(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [PERMISSIONS.APPROVALS_DECIDE]);
  const requester = await createUser({ partnerId: partner.id, orgId: org.id, email: `req-${randomUUID()}@mcpcap.test` });
  await assignUserToOrganization(requester.id, org.id, role.id);
  const approver = await createUser({ partnerId: partner.id, orgId: org.id, email: `apr-${randomUUID()}@mcpcap.test` });
  await assignUserToOrganization(approver.id, org.id, role.id);
  return { partnerId: partner.id, orgId: org.id, requester: { id: requester.id, email: requester.email } };
}

function create(s: Scenario, keyId: string, n: number, cap = 20, input?: Record<string, unknown>) {
  return createActionIntent(apiKeyAuth(keyId, s.requester, s.orgId, s.partnerId), {
    toolName: TOOL,
    input: input ?? { snapshotId: randomUUID(), deviceId: randomUUID(), n },
    source: 'mcp_api',
    orgId: s.orgId,
    idempotencyKey: `mcp:v1:${keyId}:${n}`,
    correlationId: randomUUID(),
    requestingClientLabel: 'MCP · ci',
    maxLiveForOrigin: cap,
  });
}

async function liveCount(keyId: string): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(actionIntents)
      .where(and(
        eq(actionIntents.source, 'mcp_api'),
        eq(actionIntents.originPrincipalId, keyId),
        sql`${actionIntents.status} IN ('pending_approval','approved','executing')`,
      ));
    return row?.n ?? 0;
  });
}

let s: Scenario;
beforeEach(async () => { s = await seed(); });

describe('MCP-origin live cap (B-W04)', () => {
  it('cap holds under concurrency: 21 parallel creations from one credential → 20 rows, 1 too_many_pending_actions', async () => {
    const keyA = randomUUID();
    const results = await Promise.allSettled(Array.from({ length: 21 }, (_, i) => create(s, keyA, i)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(20);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'too_many_pending_actions' });
    expect(await liveCount(keyA)).toBe(20);
  }, 120_000);

  it('a second origin is unaffected by the first one being at the cap', async () => {
    const keyA = randomUUID();
    const keyB = randomUUID();
    for (let i = 0; i < 3; i++) await create(s, keyA, i, 3);
    await expect(create(s, keyA, 99, 3)).rejects.toMatchObject({ code: 'too_many_pending_actions' });
    await expect(create(s, keyB, 0, 3)).resolves.toMatchObject({ status: 'pending_approval' });
  }, 60_000);

  it('a terminal intent frees a slot', async () => {
    const keyA = randomUUID();
    const first = await create(s, keyA, 0, 2);
    await create(s, keyA, 1, 2);
    await expect(create(s, keyA, 2, 2)).rejects.toMatchObject({ code: 'too_many_pending_actions' });
    await transitionIntent(first.id, 'pending_approval', 'cancelled');
    await expect(create(s, keyA, 2, 2)).resolves.toMatchObject({ status: 'pending_approval' });
  }, 60_000);

  it('at the cap, a replay of a live intent returns that intent, not too_many_pending_actions', async () => {
    const keyA = randomUUID();
    const fixed = { snapshotId: randomUUID(), deviceId: randomUUID() };
    const first = await create(s, keyA, 0, 2, fixed);
    await create(s, keyA, 1, 2);
    const replay = await create(s, keyA, 0, 2, fixed);
    expect(replay.id).toBe(first.id);
  }, 60_000);
});

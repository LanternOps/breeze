/**
 * Per-provider-account reservations (#9981) against real Postgres.
 *
 * Real: `admitTask`, the org admission lock, the per-account advisory locks,
 * `ai_operator_account_reservations` with its partial unique index, the
 * release-on-terminal trigger, RLS as `breeze_app`. Faked: the provider
 * lookups by address (there is no tenant to read from in a test stack).
 *
 * The scenario the issue names: two contact rows that resolve to the SAME
 * Microsoft 365 / Google account (here: two contacts sharing one address, so
 * each provider lookup returns the same immutable id).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

const providers = vi.hoisted(() => ({
  m365: vi.fn(),
  googleUser: vi.fn(),
}));
vi.mock('../../services/m365ControlPlane/readActionService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  executeM365ReadActionByOrg: (...a: unknown[]) => providers.m365(...a),
}));
vi.mock('../../services/aiToolsGoogle', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveContextByOrg: async () => ({ conn: { id: null, adminEmail: 'admin@customer.example' }, keyJson: '{}' }),
}));
vi.mock('../../services/googleClient', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getDirectoryClient: () => ({ users: { get: (...a: unknown[]) => providers.googleUser(...a) } }),
}));

import { db } from '../../db';
import {
  aiAgents, aiOperatorAccountReservations, aiOperatorOperations, aiOperatorTasks, contacts, m365Connections,
  orgMergeEvents,
} from '../../db/schema';
import { M365_PERMISSION_PROFILES } from '@breeze/shared/m365';
import { admitTask, type AdmitTaskInput } from '../../services/aiOperator/taskService';
import {
  lockAndCheckAccountReservations, releaseTaskAccountReservations, reserveTaskAccount,
} from '../../services/aiOperator/accountReservations';
import { runReconcilerPass } from '../../services/aiOperator/taskReconciler';
import { replayMigration } from './replayMigration';
import { buildTaskActorAuthContext } from '../../services/actionIntents/actorContext';
import { PERMISSIONS } from '../../services/permissions';
import { asUser, system } from './planApprovalFixtures';
import {
  assignUserToOrganization, createOrganization, createPartner, createRole, createUser, grantRolePermissions,
} from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_TASKS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED', 'true');
  providers.m365.mockImplementation(async (_org: string, action: { userIdOrUpn: string }) => ({
    ok: true, kind: 'resource', resource: { id: `m365-${action.userIdOrUpn}`, userPrincipalName: action.userIdOrUpn, mail: action.userIdOrUpn },
  }));
  providers.googleUser.mockImplementation(async ({ userKey }: { userKey: string }) => ({ data: { id: `g-${userKey}`, primaryEmail: userKey } }));
});
afterEach(() => { vi.unstubAllEnvs(); });

/** `sibling`: a second org under the same partner, reusing its partner-wide agent. */
async function seed(sibling?: { partnerId: string; agentId: string }) {
  const partner = sibling ? { id: sibling.partnerId } : await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [PERMISSIONS.ORGS_READ, PERMISSIONS.ORGS_WRITE]);
  const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `tech-${randomUUID()}@reservations.test` });
  await assignUserToOrganization(user.id, org.id, role.id);
  const [agent] = sibling ? [{ id: sibling.agentId }] : await system(() => db.insert(aiAgents).values({
    orgId: null, partnerId: partner.id, kind: 'helpdesk', name: 'Helpdesk', createdBy: user.id,
    enabled: true, mode: 'shadow', toolAllowlist: [],
  }).returning());
  const profile = M365_PERMISSION_PROFILES['customer-graph-actions'];
  const grantKey = (g: { resourceApplicationId: string; appRoleId: string }) => `${g.resourceApplicationId}/${g.appRoleId}`;
  await system(() => db.insert(m365Connections).values({
    orgId: org.id, tenantId: randomUUID(), clientId: 'test-client-id',
    profile: 'customer-graph-actions', authMode: 'application-certificate', credentialDomain: 'customer-graph-actions',
    vaultRef: 'akv://test-vault.example/m365-customer-graph-actions/00000000000000000000000000000000',
    credentialVersion: '00000000000000000000000000000000', permissionManifestVersion: profile.version, status: 'active',
    observedGrants: [...(profile.applicationPermissionAssignments ?? [])]
      .sort((x, y) => (grantKey(x) < grantKey(y) ? -1 : grantKey(x) > grantKey(y) ? 1 : 0)),
    grantsVerifiedAt: new Date(),
  } as never));
  return { partnerId: partner.id, orgId: org.id, userId: user.id, agentId: agent!.id };
}
type Tenant = Awaited<ReturnType<typeof seed>>;

async function contact(t: Tenant, email: string, name: string | null = null): Promise<string> {
  const [row] = await system(() => db.insert(contacts).values({ orgId: t.orgId, email, name } as never).returning({ id: contacts.id }));
  return row!.id;
}

const input = (t: Tenant, recipeInput: Record<string, unknown>, over: Partial<AdmitTaskInput> = {}): AdmitTaskInput => ({
  orgId: t.orgId, agentId: t.agentId, objective: 'Offboard', originKind: 'manual', requesterUserId: t.userId,
  workflowKey: 'identity_offboarding', workflowVersion: 1, recipeInput, ...over,
});

const tasksOf = (orgId: string) => system(() => db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.orgId, orgId)));
const reservationsOf = (taskId: string) => system(() => db.select().from(aiOperatorAccountReservations)
  .where(eq(aiOperatorAccountReservations.taskId, taskId)));
const taskIdOf = (r: unknown) => (r as { taskId: string }).taskId;

/** Two contact rows for ONE person: each provider lookup resolves the same accounts. */
async function twoContactsOneAccount(t: Tenant): Promise<[string, string]> {
  return [await contact(t, 'dana@customer.example', 'Dana Ruiz'), await contact(t, 'dana@customer.example', 'D. Ruiz')];
}

/** A dispatched operation that has not reported: its effect may still land. */
async function inFlightOperation(t: Tenant, taskId: string): Promise<string> {
  const [op] = await system(() => db.insert(aiOperatorOperations).values({
    orgId: t.orgId, taskId, taskStepKey: 'offboard', operationKey: `op-${randomUUID()}`,
    argumentDigest: 'a'.repeat(64), dispatchState: 'dispatched', resultState: 'pending', dispatchedAt: new Date(),
  }).returning({ id: aiOperatorOperations.id }));
  return op!.id;
}

const settleTask = (taskId: string, state: string, outcome: string | null) =>
  system(() => db.update(aiOperatorTasks).set({ state, outcome } as never).where(eq(aiOperatorTasks.id, taskId)));

describe('one task per provider account (#9981)', () => {
  runDb('two CONCURRENT admissions for different contacts mapped to the same accounts: exactly one wins', async () => {
    const t = await seed();
    const [c1, c2] = await twoContactsOneAccount(t);
    const [a, b] = await Promise.all([
      admitTask(input(t, { contactId: c1 }, { clientIdempotencyKey: 'res-a' })),
      admitTask(input(t, { contactId: c2 }, { clientIdempotencyKey: 'res-b' })),
    ]);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const winner = taskIdOf(results.find((r) => r.ok));
    const loser = results.find((r) => !r.ok)!;
    expect(loser).toMatchObject({ ok: false, refusal: 'account_reserved', existingTaskId: winner });
    expect((loser as { detail: string }).detail).toContain(winner);
    expect(await tasksOf(t.orgId)).toHaveLength(1);
    const held = await reservationsOf(winner);
    expect(held.map((r) => `${r.provider}:${r.externalId}`).sort())
      .toEqual(['google:g-dana@customer.example', 'm365:m365-dana@customer.example']);
    expect(held.every((r) => r.releasedAt === null)).toBe(true);
  });

  runDb('the reservation survives an unknown_effect handoff: the account stays reserved while the effect may land', async () => {
    const t = await seed();
    const [c1, c2] = await twoContactsOneAccount(t);
    const first = taskIdOf(await admitTask(input(t, { contactId: c1 })));
    await inFlightOperation(t, first);
    await settleTask(first, 'handed_off', 'unknown_effect');

    const second = await admitTask(input(t, { contactId: c2 }));
    expect(second).toMatchObject({ ok: false, refusal: 'account_reserved', existingTaskId: first });
    // The SAME contact, once its own task is terminal, is held by the account too.
    expect(await admitTask(input(t, { contactId: c1 }))).toMatchObject({ ok: false, refusal: 'account_reserved' });
    expect((await reservationsOf(first)).every((r) => r.releasedAt === null)).toBe(true);
  });

  runDb('a clean terminal releases the reservation (task_settled) and the account can be offboarded again', async () => {
    const t = await seed();
    const [c1, c2] = await twoContactsOneAccount(t);
    const first = taskIdOf(await admitTask(input(t, { contactId: c1 })));
    await settleTask(first, 'completed', 'verified_resolved');
    const released = await reservationsOf(first);
    expect(released).toHaveLength(2);
    expect(released.every((r) => r.releasedAt !== null && r.releaseReason === 'task_settled')).toBe(true);
    expect((await admitTask(input(t, { contactId: c2 }))).ok).toBe(true);
  });

  runDb('ANY terminal with a dispatched operation still unsettled keeps the accounts, whatever outcome its writer chose', async () => {
    const t = await seed();
    const [c1, c2] = await twoContactsOneAccount(t);
    const first = taskIdOf(await admitTask(input(t, { contactId: c1 })));
    const op = await inFlightOperation(t, first);
    await settleTask(first, 'failed', 'unresolved');
    expect(await admitTask(input(t, { contactId: c2 }))).toMatchObject({ ok: false, refusal: 'account_reserved', existingTaskId: first });
    // Once it settles, the reconciler hands the account back.
    await system(() => db.update(aiOperatorOperations).set({ resultState: 'failed', resultAt: new Date() })
      .where(eq(aiOperatorOperations.id, op)));
    await runReconcilerPass();
    expect((await admitTask(input(t, { contactId: c2 }))).ok).toBe(true);
  });

  runDb('a handoff with nothing in flight (unresolved) releases too', async () => {
    const t = await seed();
    const [c1, c2] = await twoContactsOneAccount(t);
    const first = taskIdOf(await admitTask(input(t, { contactId: c1 })));
    await settleTask(first, 'handed_off', 'unresolved');
    expect((await admitTask(input(t, { contactId: c2 }))).ok).toBe(true);
  });

  runDb('a stopping task (org merge / device detach fence) still holds its accounts', async () => {
    const t = await seed();
    const [c1, c2] = await twoContactsOneAccount(t);
    const first = taskIdOf(await admitTask(input(t, { contactId: c1 })));
    await settleTask(first, 'stopping', null);
    expect(await admitTask(input(t, { contactId: c2 }))).toMatchObject({ ok: false, refusal: 'account_reserved', existingTaskId: first });
  });

  runDb('the database refuses a second ACTIVE reservation of one account in one org (23505)', async () => {
    const t = await seed();
    const [c1] = await twoContactsOneAccount(t);
    const first = taskIdOf(await admitTask(input(t, { contactId: c1 })));
    await settleTask(first, 'completed', 'verified_resolved');
    const c3 = await contact(t, 'sam@customer.example');
    const other = taskIdOf(await admitTask(input(t, { contactId: c3 })));
    const insert = (taskId: string) => system(() => db.insert(aiOperatorAccountReservations).values({
      orgId: t.orgId, taskId, provider: 'm365', externalId: 'm365-shared', principalLabel: 'shared@customer.example',
    }));
    await insert(other);
    await expect(insert(other)).rejects.toSatisfy((err: unknown) => {
      const e = err as { code?: string; cause?: { code?: string } };
      return (e.cause?.code ?? e.code) === '23505';
    });
  });

  runDb('the reservation is per org: the same account ids in another org are not blocked', async () => {
    const t = await seed();
    const other = await seed();
    const [c1] = await twoContactsOneAccount(t);
    expect((await admitTask(input(t, { contactId: c1 }))).ok).toBe(true);
    const [o1] = await twoContactsOneAccount(other);
    expect((await admitTask(input(other, { contactId: o1 }))).ok).toBe(true);
  });

  runDb('RLS: another tenant cannot read this org\'s reservations', async () => {
    const t = await seed();
    const other = await seed();
    const [c1] = await twoContactsOneAccount(t);
    const first = taskIdOf(await admitTask(input(t, { contactId: c1 })));
    const auth = await buildTaskActorAuthContext({ orgId: other.orgId, partnerId: other.partnerId, userId: other.userId });
    const seen = await asUser(auth!, () => db.select({ id: aiOperatorAccountReservations.id })
      .from(aiOperatorAccountReservations).where(eq(aiOperatorAccountReservations.taskId, first)));
    expect(seen).toEqual([]);
    const own = await buildTaskActorAuthContext({ orgId: t.orgId, partnerId: t.partnerId, userId: t.userId });
    const mine = await asUser(own!, () => db.select({ id: aiOperatorAccountReservations.id })
      .from(aiOperatorAccountReservations).where(eq(aiOperatorAccountReservations.taskId, first)));
    expect(mine).toHaveLength(2);
  });

  runDb('org merge: a reservation left in the merged-away org still blocks the survivor', async () => {
    const survivor = await seed();
    const loser = await seed(survivor);
    const [l1] = await twoContactsOneAccount(loser);
    const loserTask = taskIdOf(await admitTask(input(loser, { contactId: l1 })));
    // What the merge fence leaves behind: the task stopping in the loser org.
    await settleTask(loserTask, 'stopping', null);
    await system(() => db.insert(orgMergeEvents).values({
      partnerId: survivor.partnerId, loserOrgId: loser.orgId, loserOrgName: 'Loser', survivorOrgId: survivor.orgId, summary: {},
    }));
    const [s1] = await twoContactsOneAccount(survivor);
    const r = await admitTask(input(survivor, { contactId: s1 }));
    expect(r).toMatchObject({ ok: false, refusal: 'account_reserved', existingTaskId: loserTask });
    expect((r as { detail: string }).detail).toContain('merged');
  });
});

describe('the existing per-contact rule is unchanged', () => {
  runDb('the same contact twice is still duplicate_live_task (checked before the account)', async () => {
    const t = await seed();
    const [c1] = await twoContactsOneAccount(t);
    const first = taskIdOf(await admitTask(input(t, { contactId: c1 })));
    expect(await admitTask(input(t, { contactId: c1 }))).toMatchObject({ ok: false, refusal: 'duplicate_live_task', existingTaskId: first });
    const rows = await system(() => db.select().from(aiOperatorAccountReservations)
      .where(and(eq(aiOperatorAccountReservations.orgId, t.orgId), sql`released_at IS NULL`)));
    expect(rows).toHaveLength(2);
  });
});

describe('releasing a reservation an unknown_effect handoff kept', () => {
  runDb('the reconciler keeps it while the effect is in flight and releases it once the operation settles', async () => {
    const t = await seed();
    const [c1, c2] = await twoContactsOneAccount(t);
    const first = taskIdOf(await admitTask(input(t, { contactId: c1 })));
    const op = await inFlightOperation(t, first);
    await settleTask(first, 'handed_off', 'unknown_effect');

    await runReconcilerPass();
    expect((await reservationsOf(first)).every((r) => r.releasedAt === null)).toBe(true);

    // The late result lands on the operation (set 4, or the agent's own report).
    await system(() => db.update(aiOperatorOperations).set({ resultState: 'succeeded', resultAt: new Date() })
      .where(eq(aiOperatorOperations.id, op)));
    await runReconcilerPass();
    const after = await reservationsOf(first);
    expect(after.every((r) => r.releasedAt !== null && r.releaseReason === 'effects_settled')).toBe(true);
    expect((await admitTask(input(t, { contactId: c2 }))).ok).toBe(true);
  });

  runDb('an operation still `unknown` keeps it: only a person can release it, and only once the task is terminal', async () => {
    const t = await seed();
    const [c1, c2] = await twoContactsOneAccount(t);
    const first = taskIdOf(await admitTask(input(t, { contactId: c1 })));
    const op = await inFlightOperation(t, first);

    // Live: a person cannot release it out from under a running task.
    expect(await system(() => releaseTaskAccountReservations({ orgId: t.orgId, taskId: first, userId: t.userId, note: null })))
      .toMatchObject({ ok: false, reason: 'task_live' });

    await settleTask(first, 'handed_off', 'unknown_effect');
    await system(() => db.update(aiOperatorOperations).set({ resultState: 'unknown' }).where(eq(aiOperatorOperations.id, op)));
    await runReconcilerPass();
    expect(await admitTask(input(t, { contactId: c2 }))).toMatchObject({ ok: false, refusal: 'account_reserved' });

    const released = await system(() => releaseTaskAccountReservations({
      orgId: t.orgId, taskId: first, userId: t.userId, note: 'checked Entra: account disabled',
    }));
    expect(released).toEqual({ ok: true, released: 2 });
    const rows = await reservationsOf(first);
    expect(rows.every((r) => r.releaseReason === 'released_by_user' && r.releasedByUserId === t.userId)).toBe(true);
    expect((await admitTask(input(t, { contactId: c2 }))).ok).toBe(true);
  });

  runDb('a release names the org: another org cannot release this task\'s accounts', async () => {
    const t = await seed();
    const other = await seed();
    const [c1] = await twoContactsOneAccount(t);
    const first = taskIdOf(await admitTask(input(t, { contactId: c1 })));
    await settleTask(first, 'handed_off', 'unknown_effect');
    expect(await system(() => releaseTaskAccountReservations({ orgId: other.orgId, taskId: first, userId: other.userId, note: null })))
      .toMatchObject({ ok: false, reason: 'task_not_found' });
    expect((await reservationsOf(first)).every((r) => r.releasedAt === null)).toBe(true);
  });
});

describe('admission against a non-admission reserver (the onboarding freeze)', () => {
  runDb('an admission that starts while another transaction holds the account lock waits and refuses cleanly', async () => {
    const t = await seed();
    const holderTask = taskIdOf(await admitTask(input(t, { contactId: await contact(t, 'sam@customer.example') })));
    const key = { provider: 'm365' as const, externalId: 'm365-dana@customer.example' };
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    // What commitOnboardingStageTransition does: lock + check, then freeze (reserve), outside the org admission lock.
    const holder = system(async () => {
      expect(await lockAndCheckAccountReservations(db, t.orgId, [key])).toBeNull();
      await reserveTaskAccount(db, { orgId: t.orgId, taskId: holderTask, ...key, principalLabel: 'dana@customer.example' });
      locked();
      await new Promise((r) => setTimeout(r, 400));
    });
    await lockedP;
    const [c1] = await twoContactsOneAccount(t);
    const admitted = await admitTask(input(t, { contactId: c1 }));
    await holder;
    expect(admitted).toMatchObject({ ok: false, refusal: 'account_reserved', existingTaskId: holderTask });
  });
});

describe('lock order', () => {
  runDb('two transactions locking the same accounts in opposite input order never deadlock', async () => {
    const t = await seed();
    const keys = [
      { provider: 'm365' as const, externalId: 'm365-a' },
      { provider: 'google' as const, externalId: 'g-b' },
      { provider: 'm365' as const, externalId: 'm365-c' },
    ];
    const run = (order: typeof keys) => system(async () => {
      await db.execute(sql`SET LOCAL lock_timeout = '5s'`);
      for (let i = 0; i < 5; i++) await lockAndCheckAccountReservations(db, t.orgId, order);
      await new Promise((r) => setTimeout(r, 50));
    });
    await expect(Promise.all([run(keys), run([...keys].reverse()), run([keys[1]!, keys[2]!, keys[0]!])])).resolves.toBeDefined();
  });
});

describe('the migration backfill', () => {
  runDb('reserves live and in-flight unknown_effect tasks, oldest first, and leaves settled ones alone', async () => {
    const t = await seed();
    const dropAll = () => system(() => db.delete(aiOperatorAccountReservations).where(eq(aiOperatorAccountReservations.orgId, t.orgId)));
    // The pre-fix world: two LIVE tasks already share one account (the bug).
    const [c1, c2] = await twoContactsOneAccount(t);
    const older = taskIdOf(await admitTask(input(t, { contactId: c1 })));
    await dropAll();
    const newer = taskIdOf(await admitTask(input(t, { contactId: c2 })));
    await dropAll();
    // A handoff whose effect may still land, a FAILED task with a dispatched
    // operation still unsettled, and one that settled cleanly.
    const inFlight = taskIdOf(await admitTask(input(t, { contactId: await contact(t, 'sam@customer.example') })));
    await inFlightOperation(t, inFlight);
    await settleTask(inFlight, 'handed_off', 'unknown_effect');
    const failedInFlight = taskIdOf(await admitTask(input(t, { contactId: await contact(t, 'kim@customer.example') })));
    await inFlightOperation(t, failedInFlight);
    await settleTask(failedInFlight, 'failed', 'unresolved');
    const settled = taskIdOf(await admitTask(input(t, { contactId: await contact(t, 'lee@customer.example') })));
    await settleTask(settled, 'completed', 'verified_resolved');
    await dropAll();

    await replayMigration('2027-01-15-130000-ai-operator-account-reservations.sql');

    const active = await system(() => db.select().from(aiOperatorAccountReservations)
      .where(and(eq(aiOperatorAccountReservations.orgId, t.orgId), sql`released_at IS NULL`)));
    const holders = (taskId: string) => active.filter((r) => r.taskId === taskId).map((r) => r.provider).sort();
    expect(holders(older)).toEqual(['google', 'm365']);
    expect(holders(newer)).toEqual([]);
    expect(holders(inFlight)).toEqual(['google', 'm365']);
    expect(holders(failedInFlight)).toEqual(['google', 'm365']);
    expect(holders(settled)).toEqual([]);

    // Re-applying changes nothing.
    await replayMigration('2027-01-15-130000-ai-operator-account-reservations.sql');
    const again = await system(() => db.select().from(aiOperatorAccountReservations)
      .where(and(eq(aiOperatorAccountReservations.orgId, t.orgId), sql`released_at IS NULL`)));
    expect(again.map((r) => r.id).sort()).toEqual(active.map((r) => r.id).sort());
  });
});

/**
 * Contact-targeted admission against real Postgres (Recipe Library §8, D-R1-6;
 * W06 R1a Task 14).
 *
 * Real: `admitTask`, the org admission lock, the per-(recipe, contact)
 * advisory lock, the one-live-task refusal, contacts, contact_external_links,
 * target and account rows, RLS as `breeze_app`. Faked: the two provider
 * lookups by address (there is no tenant to read from in a test stack).
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
  aiAgents, aiOperatorTaskTargetAccounts, aiOperatorTaskTargets, aiOperatorTasks, contactExternalLinks, contacts,
  m365Connections,
} from '../../db/schema';
import { M365_PERMISSION_PROFILES } from '@breeze/shared/m365';
import { admitTask, type AdmitTaskInput } from '../../services/aiOperator/taskService';
import { lockContactForRecipe } from '../../services/aiOperator/contactResolution';
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

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [PERMISSIONS.ORGS_READ, PERMISSIONS.ORGS_WRITE]);
  const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `tech-${randomUUID()}@admission.test` });
  await assignUserToOrganization(user.id, org.id, role.id);
  const [agent] = await system(() => db.insert(aiAgents).values({
    orgId: null, partnerId: partner.id, kind: 'helpdesk', name: 'Helpdesk', createdBy: user.id,
    enabled: true, mode: 'shadow', toolAllowlist: [],
  }).returning());
  // A Microsoft 365 connection row: admission only looks a person up in M365
  // when the org uses it (the read itself is stubbed above).
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

describe('one live task per (contact, recipe)', () => {
  runDb('1. two CONCURRENT admissions for the same contact: exactly one wins, the other is duplicate_live_task', async () => {
    const t = await seed();
    const c = await contact(t, 'dana@customer.example');
    const [a, b] = await Promise.all([
      admitTask(input(t, { contactId: c }, { clientIdempotencyKey: 'concurrent-a' })),
      admitTask(input(t, { contactId: c }, { clientIdempotencyKey: 'concurrent-b' })),
    ]);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok)!;
    expect(loser).toMatchObject({ ok: false, refusal: 'duplicate_live_task' });
    const winner = results.find((r) => r.ok) as { taskId: string };
    expect((loser as { existingTaskId?: string }).existingTaskId).toBe(winner.taskId);
    expect(await tasksOf(t.orgId)).toHaveLength(1);
  });

  runDb('2. concurrent admissions for DIFFERENT contacts both succeed — the lock is per contact', async () => {
    const t = await seed();
    const c1 = await contact(t, 'dana@customer.example');
    const c2 = await contact(t, 'sam@customer.example');
    const [a, b] = await Promise.all([admitTask(input(t, { contactId: c1 })), admitTask(input(t, { contactId: c2 }))]);
    expect(a.ok && b.ok).toBe(true);
    expect(await tasksOf(t.orgId)).toHaveLength(2);
  });

  runDb('3. the contact lock is keyed by RECIPE too: a different recipe on the same contact is not blocked', async () => {
    const t = await seed();
    const c = await contact(t, 'dana@customer.example');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = system(async () => { await lockContactForRecipe(t.orgId, 'identity_offboarding', c); await held; });
    await new Promise((r) => setTimeout(r, 100));
    // Another recipe key: acquires immediately.
    await system(async () => {
      await db.execute(sql`SET LOCAL lock_timeout = '500ms'`);
      await lockContactForRecipe(t.orgId, 'identity_onboarding', c);
    });
    // The SAME key: blocks behind the holder.
    await expect(system(async () => {
      await db.execute(sql`SET LOCAL lock_timeout = '300ms'`);
      await lockContactForRecipe(t.orgId, 'identity_offboarding', c);
    })).rejects.toSatisfy((err: unknown) => {
      const e = err as { code?: string; cause?: { code?: string } };
      return (e.cause?.code ?? e.code) === '55P03'; // lock_not_available
    });
    release();
    await holder;
  });

  runDb('a second admission after the first task went terminal is admitted', async () => {
    const t = await seed();
    const c = await contact(t, 'dana@customer.example');
    const first = await admitTask(input(t, { contactId: c }));
    expect(first.ok).toBe(true);
    await system(() => db.update(aiOperatorTasks).set({ state: 'completed' }).where(eq(aiOperatorTasks.id, (first as { taskId: string }).taskId)));
    expect((await admitTask(input(t, { contactId: c }))).ok).toBe(true);
  });
});

describe('idempotency, tenancy and links', () => {
  runDb('4. a replay with the same clientIdempotencyKey returns the same task and writes no second target', async () => {
    const t = await seed();
    const c = await contact(t, 'dana@customer.example');
    const a = await admitTask(input(t, { contactId: c }, { clientIdempotencyKey: 'replay-key-1' }));
    const b = await admitTask(input(t, { contactId: c }, { clientIdempotencyKey: 'replay-key-1' }));
    expect(a).toMatchObject({ ok: true, replayed: false });
    expect(b).toEqual({ ok: true, taskId: (a as { taskId: string }).taskId, replayed: true });
    const targets = await system(() => db.select().from(aiOperatorTaskTargets).where(eq(aiOperatorTaskTargets.orgId, t.orgId)));
    expect(targets.filter((x) => x.targetKind === 'contact')).toHaveLength(1);
  });

  runDb('5. a contactId from ANOTHER tenant is refused with no row written, and RLS hides it from this tenant', async () => {
    const t = await seed();
    const other = await seed();
    const foreign = await contact(other, 'stranger@other.example');
    const r = await admitTask(input(t, { contactId: foreign }));
    expect(r).toMatchObject({ ok: false, refusal: 'contact_not_in_org' });
    expect(await tasksOf(t.orgId)).toHaveLength(0);
    expect(await system(() => db.select().from(aiOperatorTaskTargets).where(eq(aiOperatorTaskTargets.contactId, foreign)))).toHaveLength(0);
    const auth = await buildTaskActorAuthContext({ orgId: t.orgId, partnerId: t.partnerId, userId: t.userId });
    const visible = await asUser(auth!, () => db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, foreign)));
    expect(visible).toEqual([]);
  });

  runDb('6. links are upserted once from the provider lookups and reused (contact_external_links_uniq holds)', async () => {
    const t = await seed();
    const c = await contact(t, 'dana@customer.example');
    const first = await admitTask(input(t, { contactId: c }));
    expect(first.ok).toBe(true);
    const links = () => system(() => db.select().from(contactExternalLinks).where(eq(contactExternalLinks.contactId, c)));
    expect((await links()).map((l) => `${l.system}:${l.externalId}`).sort())
      .toEqual(['google:g-dana@customer.example', 'm365:m365-dana@customer.example']);
    await system(() => db.update(aiOperatorTasks).set({ state: 'completed' }).where(eq(aiOperatorTasks.id, (first as { taskId: string }).taskId)));
    providers.m365.mockClear();
    providers.googleUser.mockClear();
    expect((await admitTask(input(t, { contactId: c }))).ok).toBe(true);
    expect(await links()).toHaveLength(2);
    expect(providers.m365).not.toHaveBeenCalled(); // the links were reused
    const accounts = await system(() => db.select().from(aiOperatorTaskTargetAccounts).where(eq(aiOperatorTaskTargetAccounts.orgId, t.orgId)));
    expect(accounts.map((a) => a.externalId).sort()).toEqual([
      'g-dana@customer.example', 'g-dana@customer.example', 'm365-dana@customer.example', 'm365-dana@customer.example',
    ]);
  });

  runDb('an alias lookup that lands on a DIFFERENT primary account is never frozen or linked', async () => {
    const t = await seed();
    const c = await contact(t, 'sales@customer.example');
    providers.m365.mockResolvedValue({ ok: true, kind: 'resource', resource: { id: 'm365-sam', userPrincipalName: 'sam@customer.example', mail: 'sam@customer.example' } });
    providers.googleUser.mockResolvedValue({ data: { id: 'g-sam', primaryEmail: 'sam@customer.example' } });
    const r = await admitTask(input(t, { contactId: c }));
    expect(r).toMatchObject({ ok: false, refusal: 'no_provider_account' });
    expect(await system(() => db.select().from(contactExternalLinks).where(eq(contactExternalLinks.contactId, c)))).toEqual([]);
    expect(await tasksOf(t.orgId)).toHaveLength(0);
  });
});

describe('resolving the person', () => {
  runDb('an email hint with no contact creates exactly one, after accounts were found', async () => {
    const t = await seed();
    const r = await admitTask(input(t, { personHint: 'new.person@customer.example' }));
    expect(r.ok).toBe(true);
    const rows = await system(() => db.select().from(contacts).where(and(eq(contacts.orgId, t.orgId), eq(contacts.email, 'new.person@customer.example'))));
    expect(rows).toHaveLength(1);
  });

  runDb('a free-text hint never creates a contact; a non-unique or absent name is contact_ambiguous', async () => {
    const t = await seed();
    await contact(t, 'dana1@customer.example', 'Dana Ruiz');
    await contact(t, 'dana2@customer.example', 'Dana Ruiz');
    expect(await admitTask(input(t, { personHint: 'Dana Ruiz' }))).toMatchObject({ ok: false, refusal: 'contact_ambiguous' });
    expect(await admitTask(input(t, { personHint: 'Dana' }))).toMatchObject({ ok: false, refusal: 'contact_ambiguous' });
    const all = await system(() => db.select().from(contacts).where(eq(contacts.orgId, t.orgId)));
    expect(all).toHaveLength(2);
  });

  runDb('the admitted task starts at intake on the identity checkpoint arm, with no device column', async () => {
    const t = await seed();
    const c = await contact(t, 'dana@customer.example', 'Dana Ruiz');
    const r = await admitTask(input(t, { contactId: c }));
    const [task] = await system(() => db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.id, (r as { taskId: string }).taskId)));
    expect(task).toMatchObject({ currentStepKey: 'intake', deviceId: null, targetLabel: 'Dana Ruiz', state: 'queued', workflowKey: 'identity_offboarding' });
    expect(task!.checkpoint).not.toHaveProperty('criterion');
  });
});

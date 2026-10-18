/**
 * Caller verification W05 (#6354 / #6359) — live enforcement contract.
 *
 * Proves against real Postgres + Redis what the unit suites cannot:
 *   - the pinned target columns are immutable (23514) and all-or-none, while
 *     `dispatch_started_at` stays a mutable lifecycle marker;
 *   - `prepareCallerDispatch` commits its marker under the requester+target
 *     subject locks, so a "This is not me" rejection either fences the
 *     dispatch (rejection first) or reports it honestly as already dispatched
 *     (dispatch first) — including real lock races;
 *   - one grant is spent by exactly one intent; a newer grant cannot replace
 *     the consumed one; a re-pointed connection cannot redirect it;
 *   - rejection fan-out cancels undispatched intents through the system path;
 *   - the REAL release worker consumes after its claim, dispatches the pinned
 *     object id once, and terminalises typed refusals without an outbound call;
 *   - link-tier-only: a workstation grant is unreachable end to end while the
 *     workstation tier is dark;
 *   - administrative step-up grants are bound to the live session family and
 *     epochs at dispatch time.
 *
 * Only the external Graph actions executor client is mocked (network edge).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

const outbound = vi.hoisted(() => ({ executeWriteAction: vi.fn() }));
vi.mock('../../services/m365ControlPlane/graphActionsExecutorClient', () => ({
  createGraphActionsExecutorClient: () => ({ executeWriteAction: outbound.executeWriteAction }),
  GraphActionsExecutorClientError: class GraphActionsExecutorClientError extends Error {},
}));
// Creation-time target resolution reaches Microsoft Graph through the read
// executor; only that network lookup is replaced (the gate, the creation
// transaction and the pin columns are real).
const resolver = vi.hoisted(() => ({ resolveM365CallerTarget: vi.fn() }));
vi.mock('../../services/aiToolsM365', async (original) => ({
  ...await original<typeof import('../../services/aiToolsM365')>(),
  resolveM365CallerTarget: resolver.resolveM365CallerTarget,
}));

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { contacts } from '../../db/schema/contacts';
import { contactRoles } from '../../db/schema/contactRoles';
import { refreshTokenFamilies } from '../../db/schema/refreshTokenFamilies';
import { users } from '../../db/schema/users';
import {
  callerVerifications, callerVerificationSubjectBindings, callerVerificationPolicies,
} from '../../db/schema/callerVerification';
import { seedActionsConnection } from '../../services/m365ControlPlane/__testHelpers__/seedActionsConnection';
import { requireCallerVerification } from '../../services/callerVerification/gate';
import { applyDecision, start as startVerification, methodsForContact, createAdministrative } from '../../services/callerVerification/service';
import { withSubjectLocks } from '../../services/callerVerification/locks';
import { prepareCallerDispatch } from '../../services/callerVerification/dispatch';
import { revokeIntentsForSubject } from '../../services/actionIntents/revokeIntentsForSubject';
import { computeArgumentDigest, canonicalizeArguments } from '../../services/actionIntents/canonicalize';
import { withAdministrativeProof } from '../../services/callerVerification/administrativeContext';
import { callerVerificationAdministrativeDigest, mintStepUpGrant } from '../../services/mfaStepUpGrant';
import { closeRedis } from '../../services/redis';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import type { CallerVerificationActor } from '../../services/callerVerification/types';
import {
  createOrganization, createPartner, createRole, createUser, assignUserToOrganization, grantRolePermissions,
} from './db-utils';

const ORGS_WRITE = { resource: 'organizations', action: 'write' } as const;
let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'breeze-caller-enforcement-'));
  const jwk = join(tempDir, 'signing.jwk');
  writeFileSync(jwk, JSON.stringify({
    kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', kid: 'graph-actions-api-1',
    x: Buffer.alloc(32, 1).toString('base64url'), d: Buffer.alloc(32, 2).toString('base64url'),
  }), { mode: 0o600 });
  process.env.M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE = jwk;
});
afterAll(async () => {
  rmSync(tempDir, { recursive: true, force: true });
  await closeRedis();
});

const run = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn, 'caller-enforcement-test');

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [ORGS_WRITE]);
  const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `tech-${randomUUID()}@caller.test` });
  await assignUserToOrganization(user.id, org.id, role.id);
  const tenant = randomUUID();
  const connection = await seedActionsConnection({ orgId: org.id, tenantId: tenant });
  return run(async () => {
    const [manager] = await db.insert(contacts).values({ orgId: org.id, name: 'Requester manager', roles: ['admin'] }).returning();
    const [person] = await db.insert(contacts).values({ orgId: org.id, name: 'Target person' }).returning();
    // Organization-scope `admin` responsibility: the manager may authorize
    // disabling ANOTHER account (D15); a site responsibility could not.
    await db.insert(contactRoles).values({ orgId: org.id, contactId: manager!.id, role: 'admin' });
    const [requester, target] = await db.insert(callerVerificationSubjectBindings).values([
      { orgId: org.id, contactId: manager!.id, entraTenantId: tenant, entraOid: randomUUID(), source: 'technician_attested', upnSnapshot: 'manager@customer.test' },
      { orgId: org.id, contactId: person!.id, entraTenantId: tenant, entraOid: randomUUID(), source: 'technician_attested', upnSnapshot: 'target@customer.test' },
    ]).returning();
    const args = { userIdentifier: 'target@customer.test', reason: 'Approved account offboarding' };
    const digest = computeArgumentDigest(canonicalizeArguments(args));
    const [intent] = await db.insert(actionIntents).values({
      orgId: org.id, partnerId: partner.id, requestedByUserId: user.id, originPrincipalKind: 'user_session', source: 'chat',
      actionName: 'm365_disable_user', arguments: args, argumentDigest: digest,
      targetSummary: 'Disable target', impactSummary: 'Block sign-in', riskTier: 3,
      idempotencyKey: randomUUID(), correlationId: randomUUID(), expiresAt: new Date(Date.now() + 3600_000),
      status: 'executing', targetEntraTenantId: tenant, targetEntraOid: target!.entraOid, targetConnectionRef: connection.id,
    }).returning();
    const [grant] = await db.insert(callerVerifications).values({
      orgId: org.id, contactId: manager!.id, requesterBindingId: requester!.id, targetBindingId: target!.id,
      targetEntraTenantId: tenant, targetEntraOid: target!.entraOid, initiatedByUserId: user.id, technicianLabel: 'Tech',
      actionScope: 'disable_user', method: 'callback_attestation', status: 'verified', tier: 1, tierReason: 'attestation',
      matchValue: '42', decoyValues: ['17', '63'], reverseCode: '7319', attemptNo: 1,
      decidedAt: new Date(), expiresAt: new Date(Date.now() + 1800_000),
    }).returning();
    // Explicit partner policy: callback attestation (tier 1) suffices here.
    await db.insert(callerVerificationPolicies).values({ partnerId: partner.id, requiredTierDisableUser: 1, requiredTierResetPassword: 1 });
    return { partner, org, user, role, tenant, connection, manager: manager!, person: person!, requester: requester!, target: target!, intent: intent!, grant: grant!, args, digest };
  });
}

let f: Awaited<ReturnType<typeof seed>>;
beforeEach(async () => {
  outbound.executeWriteAction.mockReset();
  for (const [name, value] of Object.entries({
    CALLER_VERIFICATION_ENABLED: 'true',
    M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true', M365_GRAPH_ACTIONS_TOOLS_ORG_IDS: '*',
    M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID: 'c3333333-3333-4333-8333-333333333333',
    M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION: '0123456789abcdef0123456789abcdef',
    M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF: 'akv://vault.example/m365-customer-graph-actions/0123456789abcdef0123456789abcdef',
    M365_GRAPH_ACTIONS_EXECUTOR_URL: 'https://executor.example.test',
    M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE: 'm365-graph-actions-executor',
    M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_KID: 'graph-actions-api-1',
  })) vi.stubEnv(name, value);
  f = await seed();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const gateInput = (intentId = f.intent.id, mode: 'check' | 'consume' = 'consume') => ({
  orgId: f.org.id, action: 'disable_user' as const,
  target: { entraTenantId: f.tenant, entraOid: f.target.entraOid! }, backendTenantId: f.tenant,
  technicianUserId: f.user.id, intentId, mode,
});
const dispatchInput = () => ({
  orgId: f.org.id, action: 'disable_user' as const, intentId: f.intent.id,
  connectionId: f.connection.id, backendTenantId: f.tenant, oid: f.target.entraOid!,
});
const readIntent = async (id = f.intent.id) => (await run(() => db.select().from(actionIntents).where(eq(actionIntents.id, id))))[0]!;
const readGrant = async (id = f.grant.id) => (await run(() => db.select().from(callerVerifications).where(eq(callerVerifications.id, id))))[0]!;
async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; return undefined; } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.code ?? err.cause?.code;
  }
}
/** Resolve once some backend is blocked waiting on an advisory (subject) lock. */
async function waitForAdvisoryLockWaiter(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await runOutsideDbContext(() => run(() => db.execute(
      sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)));
    const n = Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
    if (n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no backend ever waited on the subject locks');
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
/** Approve the seeded intent with a bound approval row so the real worker can release it. */
async function approveForRelease(intentId = f.intent.id) {
  await run(async () => {
    await db.update(actionIntents).set({ status: 'approved' }).where(eq(actionIntents.id, intentId));
    await db.insert(approvalRequests).values({
      userId: f.user.id, requestingClientLabel: 'Caller enforcement', actionLabel: 'Disable target',
      actionToolName: 'm365_disable_user', actionArguments: f.args, riskTier: 'high', riskSummary: 'Block sign-in',
      status: 'approved', expiresAt: new Date(Date.now() + 3600_000), intentId, boundArgumentDigest: f.digest,
    });
  });
}

describe('creation check', () => {
  async function requesterAuth(): Promise<AuthContext> {
    // A second technician who may decide approvals (the requester cannot self-approve).
    const approverRole = await createRole({ scope: 'organization', orgId: f.org.id });
    await grantRolePermissions(approverRole.id, [{ resource: 'approvals', action: 'decide' }]);
    const approver = await createUser({ partnerId: f.partner.id, orgId: f.org.id, email: `approver-${randomUUID()}@caller.test` });
    await assignUserToOrganization(approver.id, f.org.id, approverRole.id);
    const { orgCondition, canAccessOrg } = buildOrgAccessClosures([f.org.id]);
    return {
      principal: { kind: 'user_session' },
      user: { id: f.user.id, email: f.user.email, name: 'Tech', isPlatformAdmin: false },
      token: { sub: f.user.id, email: f.user.email, roleId: f.role.id, orgId: f.org.id, partnerId: f.partner.id, scope: 'organization', type: 'access', mfa: true },
      partnerId: f.partner.id, orgId: f.org.id, scope: 'organization', accessibleOrgIds: [f.org.id], orgCondition, canAccessOrg,
    } as AuthContext;
  }
  const createInput = () => ({
    toolName: 'm365_disable_user', source: 'chat' as const,
    input: { userIdentifier: 'renamed-target@customer.test', reason: 'Approved account offboarding request' },
  });
  beforeEach(() => {
    resolver.resolveM365CallerTarget.mockReset();
    resolver.resolveM365CallerTarget.mockImplementation(async () => ({
      backend: 'controlPlane', connectionId: f.connection.id, tenantId: f.tenant, orgId: f.org.id, entraOid: f.target.entraOid,
    }));
  });

  it('refuses without a fresh verification and creates no intent or approval', async () => {
    const auth = await requesterAuth();
    await run(() => db.delete(callerVerifications).where(eq(callerVerifications.id, f.grant.id)));
    await expect(createActionIntent(auth, createInput())).rejects.toMatchObject({
      name: 'CallerVerificationRequiredError', payload: { action: 'disable_user', reason: 'no_fresh_verification' },
    });
    const rows = await run(() => db.select().from(actionIntents).where(eq(actionIntents.orgId, f.org.id)));
    expect(rows.map((r) => r.id)).toEqual([f.intent.id]);
    const approvals = await run(() => db.select().from(approvalRequests).where(eq(approvalRequests.userId, f.user.id)));
    expect(approvals).toEqual([]);
  });

  it('pins the canonical target at insert, never consumes, and a replay does not re-resolve', async () => {
    const auth = await requesterAuth();
    const snapshot = await createActionIntent(auth, createInput());
    expect(snapshot.status).toBe('pending_approval');
    const row = await readIntent(snapshot.id);
    expect(row).toMatchObject({
      targetEntraTenantId: f.tenant, targetEntraOid: f.target.entraOid, targetConnectionRef: f.connection.id, dispatchStartedAt: null,
    });
    expect((await readGrant()).consumedAt).toBeNull();
    const replay = await createActionIntent(auth, createInput());
    expect(replay.id).toBe(snapshot.id);
    expect(resolver.resolveM365CallerTarget).toHaveBeenCalledTimes(1);
  });
});

describe('pinned target columns', () => {
  it('are immutable after insert while dispatch_started_at stays mutable', async () => {
    for (const column of ['target_entra_tenant_id', 'target_entra_oid', 'target_connection_ref']) {
      expect(await sqlState(run(() => db.execute(sql`UPDATE action_intents SET ${sql.identifier(column)} = ${randomUUID()} WHERE id = ${f.intent.id}`))))
        .toBe('23514');
    }
    await run(() => db.update(actionIntents).set({ dispatchStartedAt: new Date() }).where(eq(actionIntents.id, f.intent.id)));
    expect((await readIntent()).dispatchStartedAt).toBeInstanceOf(Date);
  });

  it('are all-or-none', async () => {
    expect(await sqlState(run(() => db.insert(actionIntents).values({
      ...f.intent, id: randomUUID(), idempotencyKey: randomUUID(), targetConnectionRef: null,
    })))).toBe('23514');
  });
});

describe('prepareCallerDispatch', () => {
  it('tier zero dispatches a bindingless target but keeps flag, pin, tenant and marker checks', async () => {
    await run(async () => {
      await db.update(callerVerificationPolicies).set({ requiredTierDisableUser: 0 }).where(eq(callerVerificationPolicies.partnerId, f.partner.id));
      await db.delete(callerVerifications).where(eq(callerVerifications.orgId, f.org.id));
      await db.delete(callerVerificationSubjectBindings).where(eq(callerVerificationSubjectBindings.orgId, f.org.id));
    });
    await expect(run(() => requireCallerVerification(gateInput()))).resolves.toEqual({ verificationId: '', tier: 0 });
    await expect(prepareCallerDispatch({ ...dispatchInput(), oid: randomUUID() })).rejects.toMatchObject({ payload: { reason: 'target_rebound' } });
    await expect(prepareCallerDispatch({ ...dispatchInput(), backendTenantId: randomUUID() })).rejects.toMatchObject({ payload: { reason: 'tenant_mismatch' } });
    vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'false');
    await expect(prepareCallerDispatch(dispatchInput())).rejects.toMatchObject({ payload: { reason: 'feature_disabled' } });
    vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'true');
    expect((await readIntent()).dispatchStartedAt).toBeNull();
    await expect(prepareCallerDispatch(dispatchInput())).resolves.toBeUndefined();
    expect((await readIntent()).dispatchStartedAt).toBeInstanceOf(Date);
    await expect(prepareCallerDispatch(dispatchInput())).rejects.toThrow('Dispatch already started');
  });

  it('refuses without a consumed grant and never writes the marker', async () => {
    await expect(prepareCallerDispatch(dispatchInput())).rejects.toMatchObject({ payload: { reason: 'grant_consumed' } });
    expect((await readIntent()).dispatchStartedAt).toBeNull();
  });

  it('commits the marker before returning (visible to a fresh connection) after a consume', async () => {
    await expect(run(() => requireCallerVerification(gateInput()))).resolves.toHaveProperty('verificationId', f.grant.id);
    await prepareCallerDispatch(dispatchInput());
    const fresh = await runOutsideDbContext(() => readIntent());
    expect(fresh.dispatchStartedAt).toBeInstanceOf(Date);
  });

  it('two intents cannot consume one grant; the same-intent retry can', async () => {
    const [second] = await run(() => db.insert(actionIntents).values({ ...f.intent, id: randomUUID(), idempotencyKey: randomUUID() }).returning());
    const results = await Promise.allSettled([
      run(() => requireCallerVerification(gateInput())),
      run(() => requireCallerVerification(gateInput(second!.id))),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const owner = (await readGrant()).consumedIntentRef!;
    await expect(run(() => requireCallerVerification(gateInput(owner)))).resolves.toHaveProperty('verificationId', f.grant.id);
  });

  it('a newer grant cannot replace the consumed dispatch grant', async () => {
    await run(() => requireCallerVerification(gateInput()));
    await run(() => db.update(callerVerifications).set({ status: 'revoked' }).where(eq(callerVerifications.id, f.grant.id)));
    await run(() => db.insert(callerVerifications).values({ ...f.grant, id: randomUUID(), status: 'verified', consumedAt: null, consumedIntentRef: null }));
    // The revoked consumed grant is the only authority; the newer grant can never substitute.
    await expect(prepareCallerDispatch(dispatchInput())).rejects.toMatchObject({
      name: 'CallerVerificationRequiredError', payload: { reason: expect.stringMatching(/^(target_rebound|grant_consumed)$/) },
    });
    expect((await readIntent()).dispatchStartedAt).toBeNull();
  });

  it('a newer unconsumed grant alongside a valid consumed one does not change which grant dispatch evaluates', async () => {
    await run(() => requireCallerVerification(gateInput()));
    const [newer] = await run(() => db.insert(callerVerifications).values({
      ...f.grant, id: randomUUID(), status: 'verified', consumedAt: null, consumedIntentRef: null,
    }).returning());
    await expect(prepareCallerDispatch(dispatchInput())).resolves.toBeUndefined();
    expect((await readGrant(newer!.id)).consumedAt).toBeNull();
    expect((await readGrant()).consumedIntentRef).toBe(f.intent.id);
  });

  it('manager may disable the target, but substituting another OID fails', async () => {
    await run(() => requireCallerVerification(gateInput()));
    await expect(prepareCallerDispatch({ ...dispatchInput(), oid: f.requester.entraOid! })).rejects.toMatchObject({ payload: { reason: 'target_rebound' } });
    await expect(prepareCallerDispatch(dispatchInput())).resolves.toBeUndefined();
  });

  it('a re-pointed connection tenant cannot redirect an already-consumed intent', async () => {
    await run(() => requireCallerVerification(gateInput()));
    await run(() => db.execute(sql`UPDATE m365_connections SET tenant_id = ${randomUUID()} WHERE id = ${f.connection.id}`));
    await expect(prepareCallerDispatch(dispatchInput())).rejects.toMatchObject({ payload: { reason: 'tenant_mismatch' } });
  });

  it('tolerates upper-case stored tenants on bindings/grant and an upper-case backend tenant (pin is canonical lower-case)', async () => {
    const upper = f.tenant.toUpperCase();
    await run(async () => {
      await db.execute(sql`UPDATE caller_verification_subject_bindings SET entra_tenant_id = ${upper} WHERE org_id = ${f.org.id}`);
      await db.execute(sql`UPDATE caller_verifications SET target_entra_tenant_id = ${upper} WHERE id = ${f.grant.id}`);
      // (m365_connections has a lower-case tenant CHECK; a backend may still report its tenant upper-case.)
    });
    await expect(run(() => requireCallerVerification(gateInput()))).resolves.toHaveProperty('verificationId', f.grant.id);
    await expect(prepareCallerDispatch({ ...dispatchInput(), backendTenantId: upper })).resolves.toBeUndefined();
    expect((await readIntent()).dispatchStartedAt).toBeInstanceOf(Date);
  });

  it('pre-consume refusal leaves the grant unused', async () => {
    await expect(run(() => requireCallerVerification({ ...gateInput(), backendTenantId: randomUUID() }))).rejects.toMatchObject({ payload: { reason: 'tenant_mismatch' } });
    expect((await readGrant()).consumedAt).toBeNull();
  });
});

describe('rejection versus dispatch', () => {
  it('rejection before dispatch fences an executing intent (no marker) and reports it as executing', async () => {
    await run(() => requireCallerVerification(gateInput()));
    await applyDecision({ verificationId: f.grant.id, decision: { kind: 'not_me' } });
    await expect(prepareCallerDispatch(dispatchInput())).rejects.toMatchObject({ payload: { reason: 'contact_fenced' } });
    expect((await readIntent()).dispatchStartedAt).toBeNull();
    const result = await run(() => revokeIntentsForSubject({ orgId: f.org.id, bindingIds: [f.requester.id], verificationId: f.grant.id }));
    expect(result.alreadyExecuting).toContain(f.intent.id);
    expect(result.alreadyDispatched).toEqual([]);
  });

  it('rejection after dispatch reports the irreversible boundary honestly', async () => {
    await run(() => requireCallerVerification(gateInput()));
    await prepareCallerDispatch(dispatchInput());
    await applyDecision({ verificationId: f.grant.id, decision: { kind: 'not_me' } });
    const result = await run(() => revokeIntentsForSubject({ orgId: f.org.id, bindingIds: [f.requester.id], verificationId: f.grant.id }));
    expect(result.alreadyDispatched).toContain(f.intent.id);
    expect(result.alreadyExecuting).toEqual([]);
  });

  it('a dispatch waiting on a rejection that holds the subject locks sees the fence', async () => {
    await run(() => requireCallerVerification(gateInput()));
    const locked = barrier();
    const release = barrier();
    const fence = run(() => withSubjectLocks(db, [f.requester.id, f.target.id], async () => {
      locked.resolve();
      await release.promise;
      await db.update(callerVerifications).set({ status: 'rejected_by_user', decidedAt: new Date() })
        .where(eq(callerVerifications.id, f.grant.id));
    }));
    await locked.promise;
    const observed = prepareCallerDispatch(dispatchInput()).then(() => ({ passed: true }), (error) => ({ error }));
    await waitForAdvisoryLockWaiter();
    release.resolve();
    await fence;
    expect(await observed).toMatchObject({ error: { payload: { reason: 'contact_fenced' } } });
    expect((await readIntent()).dispatchStartedAt).toBeNull();
  });

  it('a committed dispatch marker is visible to a rejection that waited on the locks', async () => {
    await run(() => requireCallerVerification(gateInput()));
    const locked = barrier();
    const release = barrier();
    const marker = run(() => withSubjectLocks(db, [f.requester.id, f.target.id], async () => {
      await db.update(actionIntents).set({ dispatchStartedAt: new Date() }).where(eq(actionIntents.id, f.intent.id));
      locked.resolve();
      await release.promise;
    }));
    await locked.promise;
    const rejection = applyDecision({ verificationId: f.grant.id, decision: { kind: 'not_me' } });
    await waitForAdvisoryLockWaiter();
    release.resolve();
    await marker;
    await rejection;
    const result = await run(() => revokeIntentsForSubject({ orgId: f.org.id, bindingIds: [f.requester.id], verificationId: f.grant.id }));
    expect(result.alreadyDispatched).toContain(f.intent.id);
  });

  it('the requester rejecting their own unconsumed grant cancels the queued intent it would have authorized', async () => {
    await run(() => db.update(actionIntents).set({ status: 'approved' }).where(eq(actionIntents.id, f.intent.id)));
    await applyDecision({ verificationId: f.grant.id, decision: { kind: 'not_me' } });
    const row = await readIntent();
    expect(row.status).toBe('cancelled');
    expect(row.result).toMatchObject({ actor: 'system:caller_verification', verificationId: f.grant.id });
  });

  it('a reset grant does not cancel a disable intent, and another org is untouched', async () => {
    const other = await seed();
    await run(async () => {
      await db.update(actionIntents).set({ status: 'approved' }).where(eq(actionIntents.id, f.intent.id));
      await db.update(actionIntents).set({ status: 'approved' }).where(eq(actionIntents.id, other.intent.id));
      await db.update(callerVerifications).set({ actionScope: 'reset_password' }).where(eq(callerVerifications.id, f.grant.id));
    });
    const result = await run(() => revokeIntentsForSubject({ orgId: f.org.id, bindingIds: [f.requester.id], verificationId: f.grant.id }));
    expect(result.cancelled).toEqual([]);
    expect((await readIntent()).status).toBe('approved');
    expect((await readIntent(other.intent.id)).status).toBe('approved');
  });

  it('rejection fan-out cancels an approved intent for the bound target through the system path', async () => {
    await run(() => db.update(actionIntents).set({ status: 'approved' }).where(eq(actionIntents.id, f.intent.id)));
    const result = await run(() => revokeIntentsForSubject({ orgId: f.org.id, bindingIds: [f.target.id], verificationId: f.grant.id }));
    expect(result.cancelled).toEqual([f.intent.id]);
    const row = await readIntent();
    expect(row.status).toBe('cancelled');
    expect(row.result).toMatchObject({ actor: 'system:caller_verification', verificationId: f.grant.id });
  });
});

describe('real release worker', () => {
  it('consumes after the claim, commits the marker, and dispatches the pinned object id exactly once', async () => {
    await approveForRelease();
    let atDispatch: { intent: unknown; grant: unknown } | undefined;
    outbound.executeWriteAction.mockImplementationOnce(async () => {
      atDispatch = await runOutsideDbContext(async () => ({ intent: await readIntent(), grant: await readGrant() }));
      return { success: true, action: 'm365.user.disable', userId: f.target.entraOid };
    });
    await releaseApprovedIntent(f.intent.id);
    expect(outbound.executeWriteAction).toHaveBeenCalledTimes(1);
    expect(outbound.executeWriteAction).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: f.tenant, idempotencyKey: f.intent.id,
      action: { type: 'm365.user.disable', oid: f.target.entraOid, reason: f.args.reason },
    }));
    expect(atDispatch).toMatchObject({
      intent: { status: 'executing', dispatchStartedAt: expect.any(Date) },
      grant: { consumedAt: expect.any(Date), consumedIntentRef: f.intent.id },
    });
    expect(await readIntent()).toMatchObject({ status: 'completed', dispatchStartedAt: expect.any(Date) });
  });

  it('outbound failure after consumption fails the intent, keeps the marker and the consumption, and never re-sends', async () => {
    await approveForRelease();
    outbound.executeWriteAction.mockRejectedValueOnce(new Error('executor transport failed'));
    await releaseApprovedIntent(f.intent.id);
    expect(outbound.executeWriteAction).toHaveBeenCalledTimes(1);
    expect(await readIntent()).toMatchObject({ status: 'failed', dispatchStartedAt: expect.any(Date) });
    expect(await readGrant()).toMatchObject({ consumedAt: expect.any(Date), consumedIntentRef: f.intent.id });
    await releaseApprovedIntent(f.intent.id);
    expect(outbound.executeWriteAction).toHaveBeenCalledTimes(1);
  });

  it('terminalises a typed refusal with its payload and makes no outbound call', async () => {
    await run(() => db.delete(callerVerifications).where(eq(callerVerifications.id, f.grant.id)));
    await approveForRelease();
    await releaseApprovedIntent(f.intent.id);
    expect(outbound.executeWriteAction).not.toHaveBeenCalled();
    const row = await readIntent();
    expect(row).toMatchObject({ status: 'failed', errorCode: 'caller_verification_required', dispatchStartedAt: null });
    expect(row.result).toMatchObject({
      error: 'Caller verification required',
      requiresCallerVerification: { action: 'disable_user', orgId: f.org.id, reason: 'no_fresh_verification' },
    });
  });

  it('refuses an unpinned (pre-W05) protected intent without resolving its UPN', async () => {
    const [legacy] = await run(() => db.insert(actionIntents).values({
      ...f.intent, id: randomUUID(), idempotencyKey: randomUUID(), status: 'approved',
      targetEntraTenantId: null, targetEntraOid: null, targetConnectionRef: null,
    }).returning());
    await approveForRelease(legacy!.id);
    await releaseApprovedIntent(legacy!.id);
    expect(outbound.executeWriteAction).not.toHaveBeenCalled();
    expect(await readIntent(legacy!.id)).toMatchObject({ status: 'failed', errorCode: 'caller_verification_required' });
    expect((await readIntent(legacy!.id)).result).toMatchObject({ requiresCallerVerification: { reason: 'subject_unmatched' } });
  });

  it('explicit flag-off refuses a pinned intent at release with no marker and no outbound call', async () => {
    vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'false');
    await approveForRelease();
    await releaseApprovedIntent(f.intent.id);
    expect(outbound.executeWriteAction).not.toHaveBeenCalled();
    expect(await readIntent()).toMatchObject({ status: 'failed', errorCode: 'caller_verification_required', dispatchStartedAt: null });
    expect((await readGrant()).consumedAt).toBeNull();
  });
});

describe('link-tier-only: workstation is unreachable end to end', () => {
  const actor = (): CallerVerificationActor => ({
    userId: f.user.id, partnerId: f.partner.id, scope: 'organization', accessibleOrgIds: [f.org.id],
    allowedSiteIds: null, displayName: 'Tech',
  });

  it('is not offered, cannot be started even with a device, and a pre-existing workstation grant never releases', async () => {
    vi.stubEnv('CALLER_VERIFICATION_WORKSTATION_ENABLED', 'false');
    const methods = await run(() => methodsForContact(actor(), f.org.id, f.manager.id, 'disable_user'));
    expect(methods.find((m) => m.method === 'workstation')).toMatchObject({ available: false, unavailableReason: 'method_disabled' });
    await expect(run(() => startVerification(actor(), {
      orgId: f.org.id, contactId: f.manager.id, targetContactId: f.person.id, method: 'workstation',
      actionScope: 'disable_user', deviceId: randomUUID(), username: 'manager',
    }))).rejects.toMatchObject({ code: 'method_disabled' });
    // A bound workstation grant (tier 3) created while the tier was enabled.
    await run(async () => {
      await db.update(callerVerificationSubjectBindings).set({ osPrincipal: 'S-1-5-21-1' }).where(eq(callerVerificationSubjectBindings.id, f.requester.id));
      await db.update(callerVerifications).set({ method: 'workstation', osPrincipalObserved: 'S-1-5-21-1', tier: 3, tierReason: 'bound' })
        .where(eq(callerVerifications.id, f.grant.id));
    });
    await approveForRelease();
    await releaseApprovedIntent(f.intent.id);
    expect(outbound.executeWriteAction).not.toHaveBeenCalled();
    expect(await readIntent()).toMatchObject({ status: 'failed', errorCode: 'caller_verification_required', dispatchStartedAt: null });
    expect((await readGrant()).consumedAt).toBeNull();
  });
});

describe('administrative step-up grants', () => {
  async function adminFixture() {
    const sid = randomUUID();
    const [live] = await run(() => db.select({ authEpoch: users.authEpoch, mfaEpoch: users.mfaEpoch }).from(users).where(eq(users.id, f.user.id)));
    await run(async () => {
      await db.delete(callerVerificationPolicies).where(eq(callerVerificationPolicies.partnerId, f.partner.id));
      await db.update(callerVerifications).set({ status: 'revoked' }).where(eq(callerVerifications.id, f.grant.id));
      await db.insert(refreshTokenFamilies).values({ familyId: sid, userId: f.user.id, absoluteExpiresAt: new Date(Date.now() + 3600_000) });
    });
    const proof = { userId: f.user.id, sid, authEpoch: live!.authEpoch, mfaEpoch: live!.mfaEpoch };
    const reason = 'Confirmed offboarding after approval';
    const bind = {
      ...proof, operation: 'caller_verification_administrative_disable' as const,
      resourceDigest: callerVerificationAdministrativeDigest({ orgId: f.org.id, entraTenantId: f.tenant, entraOid: f.target.entraOid!, reason }),
    };
    const actor: CallerVerificationActor = {
      userId: f.user.id, partnerId: f.partner.id, scope: 'organization', accessibleOrgIds: [f.org.id], allowedSiteIds: null, displayName: 'Tech',
    };
    return { proof, reason, bind, actor };
  }

  it.each(['mfa_epoch', 'auth_epoch', 'revoked_session'] as const)('a default-policy administrative grant authorizes, then fails dispatch after %s', async (change) => {
    const a = await adminFixture();
    const id = await mintStepUpGrant(a.bind);
    expect(id).not.toBeNull();
    const created = await run(() => withAdministrativeProof(a.proof, () => createAdministrative(a.actor, {
      orgId: f.org.id, targetContactId: f.person.id, reason: a.reason, stepUpGrantId: id!,
    })));
    expect(created).toMatchObject({ method: 'administrative_stepup', tier: 3, actionScope: 'disable_user' });
    await expect(run(() => requireCallerVerification(gateInput()))).resolves.toMatchObject({ verificationId: created.id, tier: 3 });
    await run(async () => {
      if (change === 'revoked_session') {
        await db.update(refreshTokenFamilies).set({ revokedAt: new Date() }).where(eq(refreshTokenFamilies.familyId, a.proof.sid));
      } else {
        await db.execute(sql`UPDATE users SET ${sql.identifier(change)} = ${sql.identifier(change)} + 1 WHERE id = ${f.user.id}`);
      }
    });
    await expect(prepareCallerDispatch(dispatchInput())).rejects.toMatchObject({ payload: { reason: 'stepup_invalidated' } });
    expect((await readIntent()).dispatchStartedAt).toBeNull();
  });

  it('an administrative grant cannot be created without an interactive proof context', async () => {
    const a = await adminFixture();
    const id = await mintStepUpGrant(a.bind);
    await expect(run(() => createAdministrative(a.actor, {
      orgId: f.org.id, targetContactId: f.person.id, reason: a.reason, stepUpGrantId: id!,
    }))).rejects.toMatchObject({ code: 'interactive_stepup_required' });
    const rows = await run(() => db.select().from(callerVerifications).where(and(
      eq(callerVerifications.orgId, f.org.id), eq(callerVerifications.method, 'administrative_stepup'))));
    expect(rows).toEqual([]);
  });
});


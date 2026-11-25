/**
 * Entra SCIM provisioning on real Postgres (portal registration W9 #11386,
 * plan Task 7; Review Focus 1–5; invariants 2, 4, 5, 9, 12).
 *
 * The public router runs end to end — token verification, the D8 visibility
 * predicate, one transaction per mutation, the W8 writer — as breeze_app under
 * forced RLS through the real `db` pool with no DB context held. Fixtures are
 * seeded and read back over the superuser connection.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, getTestRedis } from './setup';
import { createOrganization, createPartner, createUser } from './db-utils';
import {
  auditLogs,
  clientAiTenantMappings,
  portalScimTokens,
  portalUserIdentities,
  portalUsers,
} from '../../db/schema';
import { clientAiAuthMiddleware } from '../../middleware/clientAiAuth';
import { CLIENT_AI_REDIS_KEYS } from '../../routes/clientAi/schemas';
import { portalAuthMiddleware } from '../../routes/portal/auth';
import { portalSessions } from '../../routes/portal/helpers';
import { createPortalScimRoutes } from '../../routes/portalScim';
import { __testOnly as policyTestOnly } from '../../services/portalAccessPolicy';
import { disablePortalIdentity, restorePortalIdentity } from '../../services/portalDirectory/identityDisable';
import { mintPortalScimToken, parseScimBearer, revokePortalScimToken } from '../../services/portalScim/tokens';
import { entraIssuer } from '../../services/portalUserIdentities';

const admin = () => getTestDb();
const app = createPortalScimRoutes();
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

beforeEach(async () => {
  policyTestOnly.setCapabilities({ entra: true, google: true, selfRegistration: false });
  // The router's failure / per-org buckets live in Redis; start clean.
  await getTestRedis().flushdb();
});
afterEach(() => {
  policyTestOnly.setCapabilities(null);
});

async function seedOrg() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const tid = randomUUID();
  await admin().insert(clientAiTenantMappings).values({
    orgId: org.id,
    entraTenantId: tid,
    provenAt: new Date(),
    provenVia: 'proof_run' as const,
    provenEvidence: { via: 'proof_run' as const, adminOid: randomUUID(), runId: randomUUID() },
    provenByUserId: null,
  });
  const actor = await createUser({ partnerId: partner.id });
  const minted = await mintPortalScimToken({ orgId: org.id, label: 'Entra', actorUserId: actor.id });
  return { partner, org, tid, actor, token: minted.token, tokenId: minted.view.id };
}

function call(token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/scim+json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const userBody = (oid: string, userName: string, extra: Record<string, unknown> = {}) => ({
  schemas: [USER_SCHEMA], externalId: oid, userName, active: true, displayName: 'Pat Example',
  name: { givenName: 'Pat', familyName: 'Example' }, ...extra,
});
const patchBody = (...ops: unknown[]) => ({ schemas: [PATCH_SCHEMA], Operations: ops });

async function readAccount(id: string) {
  const [row] = await admin().select().from(portalUsers).where(eq(portalUsers.id, id));
  return row;
}
async function readIdentity(id: string) {
  const [row] = await admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.id, id));
  return row;
}
async function countRows(table: typeof portalUsers | typeof portalUserIdentities, orgId: string) {
  return (await admin().select({ id: table.id }).from(table).where(eq(table.orgId, orgId))).length;
}

async function create(token: string, oid = randomUUID(), userName = `pat-${randomUUID().slice(0, 8)}@customer.test`, extra: Record<string, unknown> = {}) {
  const res = await call(token, 'POST', '/Users', userBody(oid, userName, extra));
  return { res, body: await res.json() as Record<string, any>, oid, userName };
}

describe('create, deactivate, reactivate (spec §5.11)', () => {
  it('POST creates an identity-only active + granted account and a scim identity; no contact link', async () => {
    const { org, tid, token } = await seedOrg();
    const { res, body, oid, userName } = await create(token);
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ externalId: oid, userName, active: true, displayName: 'Pat Example' });

    const identity = await readIdentity(body.id);
    expect(identity).toMatchObject({
      orgId: org.id, provider: 'entra', issuer: entraIssuer(tid), subject: oid, linkedVia: 'scim',
      scimUserName: userName, disabledBlockers: [],
    });
    const account = await readAccount(identity!.portalUserId);
    expect(account).toMatchObject({
      authMethod: 'entra', status: 'active', browserAccess: 'granted', disabledBy: null, passwordHash: null,
      email: userName.toLowerCase(), name: 'Pat Example', contactId: null,
    });
    const audits = await admin().select().from(auditLogs).where(and(eq(auditLogs.orgId, org.id), eq(auditLogs.action, 'portal.scim.user.create')));
    expect(audits).toHaveLength(1);
  });

  it('PATCH active false disables the identity and the account as scim; active true restores both', async () => {
    const { token } = await seedOrg();
    const { body } = await create(token);
    const identityId = body.id as string;
    const before = await readAccount((await readIdentity(identityId))!.portalUserId);

    const off = await call(token, 'PATCH', `/Users/${identityId}`, patchBody({ op: 'Replace', path: 'active', value: 'False' }));
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ active: false });
    expect(await readIdentity(identityId)).toMatchObject({ disabledBlockers: ['scim'], disabledReason: 'scim_deactivated' });
    const disabled = await readAccount(before!.id);
    expect(disabled).toMatchObject({ status: 'disabled', disabledBy: 'scim' });
    expect(disabled!.authEpoch).toBeGreaterThan(before!.authEpoch);

    // An inactive resource stays readable (unassignment arrives as active:false).
    expect((await call(token, 'GET', `/Users/${identityId}`)).status).toBe(200);

    const on = await call(token, 'PATCH', `/Users/${identityId}`, patchBody({ op: 'replace', value: { active: true } }));
    expect(on.status).toBe(200);
    expect(await readIdentity(identityId)).toMatchObject({ disabledBlockers: [], disabledAt: null });
    expect(await readAccount(before!.id)).toMatchObject({ status: 'active', disabledBy: null });
  });

  it('POST with active false creates the account disabled by scim, and a later activate enables it', async () => {
    const { token } = await seedOrg();
    const { res, body } = await create(token, randomUUID(), undefined, { active: false });
    expect(res.status).toBe(201);
    expect(body.active).toBe(false);
    const identity = await readIdentity(body.id);
    expect(identity).toMatchObject({ disabledBlockers: ['scim'] });
    expect(await readAccount(identity!.portalUserId)).toMatchObject({ status: 'disabled', disabledBy: 'scim' });
    await call(token, 'PATCH', `/Users/${body.id}`, patchBody({ op: 'replace', path: 'active', value: true }));
    expect(await readAccount(identity!.portalUserId)).toMatchObject({ status: 'active', disabledBy: null });
  });

  it('after a SCIM deactivate the browser and add-in sessions are refused on the next request', async () => { // inv. 9, RF5
    const { org, token } = await seedOrg();
    const { body } = await create(token);
    const account = await readAccount((await readIdentity(body.id))!.portalUserId);
    const browserToken = `portal-${randomUUID()}`;
    portalSessions.set(browserToken, {
      token: browserToken, portalUserId: account!.id, orgId: org.id, authEpoch: account!.authEpoch,
      createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    });
    const addinToken = `client-ai-${randomUUID()}`;
    const redis = getTestRedis();
    await redis.set(
      CLIENT_AI_REDIS_KEYS.session(addinToken),
      JSON.stringify({ portalUserId: account!.id, orgId: org.id, authEpoch: account!.authEpoch, createdAt: new Date().toISOString() }),
    );
    await redis.sadd(CLIENT_AI_REDIS_KEYS.userSessions(account!.id), addinToken);

    await call(token, 'PATCH', `/Users/${body.id}`, patchBody({ op: 'replace', path: 'active', value: false }));

    const browser = new Hono();
    browser.use('*', portalAuthMiddleware);
    browser.get('/protected', () => new Response('downstream'));
    expect((await browser.request('/protected', { headers: { Authorization: `Bearer ${browserToken}` } })).status).toBe(401);
    const addin = new Hono();
    addin.use('*', clientAiAuthMiddleware);
    addin.get('/protected', () => new Response('downstream'));
    expect((await addin.request('/protected', { headers: { Authorization: `Bearer ${addinToken}` } })).status).toBe(401);
  });

  it('DELETE disables and tombstones in one go; GET is 404; a re-POST adopts the identity again', async () => { // D7
    const { token } = await seedOrg();
    const { body, oid, userName } = await create(token);
    const del = await call(token, 'DELETE', `/Users/${body.id}`);
    expect(del.status).toBe(204);
    const tomb = await readIdentity(body.id);
    expect(tomb!.scimDeletedAt).not.toBeNull();
    expect(tomb!.disabledBlockers).toEqual(['scim']);
    expect((await call(token, 'GET', `/Users/${body.id}`)).status).toBe(404);

    const again = await create(token, oid, userName);
    expect(again.res.status).toBe(201);
    expect(again.body.id).toBe(body.id);
    const back = await readIdentity(body.id);
    expect(back).toMatchObject({ scimDeletedAt: null, disabledBlockers: [] });
    expect(await readAccount(back!.portalUserId)).toMatchObject({ status: 'active' });
  });

  it('filters: userName and externalId find the resource; Test Connection\'s GUID finds nothing', async () => {
    const { token } = await seedOrg();
    const { body, oid, userName } = await create(token);
    const byName = await (await call(token, 'GET', `/Users?filter=${encodeURIComponent(`userName eq "${userName.toUpperCase()}"`)}`)).json() as any;
    expect(byName.totalResults).toBe(1);
    expect(byName.Resources[0].id).toBe(body.id);
    const byOid = await (await call(token, 'GET', `/Users?filter=${encodeURIComponent(`externalId eq "${oid}"`)}`)).json() as any;
    expect(byOid.totalResults).toBe(1);
    const probe = await call(token, 'GET', `/Users?filter=${encodeURIComponent(`userName eq "${randomUUID()}"`)}`);
    expect(probe.status).toBe(200);
    expect(await probe.json()).toMatchObject({ totalResults: 0, Resources: [] });
  });
});

describe('isolation (invariants 2 and 4, Review Focus 1)', () => {
  it('a token never reads or writes another org\'s identity, and leaves zero residue', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const { body } = await create(a.token);
    const before = await readIdentity(body.id);

    expect((await call(b.token, 'GET', `/Users/${body.id}`)).status).toBe(404);
    expect((await call(b.token, 'PATCH', `/Users/${body.id}`, patchBody({ op: 'replace', path: 'active', value: false }))).status).toBe(404);
    expect((await call(b.token, 'DELETE', `/Users/${body.id}`)).status).toBe(404);
    const list = await (await call(b.token, 'GET', '/Users')).json() as any;
    expect(list.totalResults).toBe(0);
    expect(await readIdentity(body.id)).toEqual(before);
  });

  it('POST of an externalId already bound in another org is 409 with zero residual rows', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    // The tenant moves from A to B (a W4 proof transfer: one mapping per tenant),
    // after A's SCIM identity for the person exists; B's token is bound to it.
    const { oid } = await create(a.token);
    await admin().delete(clientAiTenantMappings).where(eq(clientAiTenantMappings.orgId, a.org.id));
    await admin().update(clientAiTenantMappings).set({
      entraTenantId: a.tid, provenAt: new Date(), provenVia: 'proof_run',
      provenEvidence: { via: 'proof_run', adminOid: randomUUID(), runId: randomUUID() },
    }).where(eq(clientAiTenantMappings.orgId, b.org.id));
    await admin().update(portalScimTokens).set({ entraTenantId: a.tid }).where(eq(portalScimTokens.orgId, b.org.id));
    const accountsBefore = await countRows(portalUsers, b.org.id);

    const res = await call(b.token, 'POST', '/Users', userBody(oid, `other-${randomUUID().slice(0, 8)}@customer.test`));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ scimType: 'uniqueness' });
    expect(await countRows(portalUsers, b.org.id)).toBe(accountsBefore);
    expect(await countRows(portalUserIdentities, b.org.id)).toBe(0);
    const conflict = await admin().select().from(auditLogs).where(and(eq(auditLogs.orgId, b.org.id), eq(auditLogs.action, 'portal.scim.user.conflict')));
    expect(conflict).toHaveLength(1);
  });

  it('a token of a newly proven tenant cannot see the previous tenant\'s SCIM identities', async () => { // quorum D8
    const { org, actor, token } = await seedOrg();
    const { body } = await create(token);
    await revokePortalScimToken({ orgId: org.id, tokenId: (await admin().select().from(portalScimTokens).where(eq(portalScimTokens.orgId, org.id)))[0]!.id, actorUserId: actor.id });
    // A tenant change clears the proof (W4); the new tenant is then proven.
    const newTid = randomUUID();
    await admin().update(clientAiTenantMappings).set({
      entraTenantId: newTid, provenAt: new Date(), provenVia: 'proof_run',
      provenEvidence: { via: 'proof_run', adminOid: randomUUID(), runId: randomUUID() },
    }).where(eq(clientAiTenantMappings.orgId, org.id));
    const fresh = await mintPortalScimToken({ orgId: org.id, label: 'New tenant', actorUserId: actor.id });
    expect((await call(fresh.token, 'GET', `/Users/${body.id}`)).status).toBe(404);
    expect((await (await call(fresh.token, 'GET', '/Users')).json() as any).totalResults).toBe(0);
  });
});

describe('credential (Review Focus 2)', () => {
  it('revoked, proof removed, or a wrong secret: the same 401; re-proving the same tenant revives an unrevoked token', async () => {
    const { org, tid, actor, token, tokenId } = await seedOrg();
    const wrong = token.slice(0, -4) + (token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const r1 = await call(wrong, 'GET', '/Users');
    expect(r1.status).toBe(401);
    const body401 = await r1.json();

    await admin().update(clientAiTenantMappings).set({ provenAt: null, provenVia: null, provenEvidence: null }).where(eq(clientAiTenantMappings.orgId, org.id));
    const r2 = await call(token, 'GET', '/Users');
    expect(r2.status).toBe(401);
    expect(await r2.json()).toEqual(body401);

    await admin().update(clientAiTenantMappings).set({
      entraTenantId: tid, provenAt: new Date(), provenVia: 'proof_run',
      provenEvidence: { via: 'proof_run', adminOid: randomUUID(), runId: randomUUID() },
    }).where(eq(clientAiTenantMappings.orgId, org.id));
    expect((await call(token, 'GET', '/Users')).status).toBe(200);

    await revokePortalScimToken({ orgId: org.id, tokenId, actorUserId: actor.id });
    const r3 = await call(token, 'GET', '/Users');
    expect(r3.status).toBe(401);
    expect(await r3.json()).toEqual(body401);
  });

  it('stores only the secret\'s hash', async () => {
    const { org, token } = await seedOrg();
    const [row] = await admin().select().from(portalScimTokens).where(eq(portalScimTokens.orgId, org.id));
    // The secret is base64url and can itself contain `_`, so split('_') would
    // truncate it to a fragment that then matches the row by chance (#12091).
    const secret = parseScimBearer(`Bearer ${token}`)!.secret;
    expect(secret).toHaveLength(43);
    expect(JSON.stringify(row)).not.toContain(secret);
  });
});

describe('precedence (invariant 12, Review Focus 3)', () => {
  it('active true never lifts a directory blocker: the identity and the account stay disabled', async () => {
    const { org, token } = await seedOrg();
    const { body } = await create(token);
    await call(token, 'PATCH', `/Users/${body.id}`, patchBody({ op: 'replace', path: 'active', value: false }));
    await disablePortalIdentity({ orgId: org.id, identityId: body.id, blocker: 'entra_directory', reason: 'account_disabled' });

    const res = await call(token, 'PATCH', `/Users/${body.id}`, patchBody({ op: 'replace', path: 'active', value: true }));
    expect(res.status).toBe(200);
    // SCIM's own assertion is now active; the directory's blocker remains.
    expect(await res.json()).toMatchObject({ active: true });
    const identity = await readIdentity(body.id);
    expect(identity).toMatchObject({ disabledBlockers: ['entra_directory'] });
    expect(identity!.disabledAt).not.toBeNull();
    expect(await readAccount(identity!.portalUserId)).toMatchObject({ status: 'disabled', disabledBy: 'scim' });
  });

  it('active true never reactivates an account the MSP disabled', async () => {
    const { token } = await seedOrg();
    const { body } = await create(token);
    const identity = await readIdentity(body.id);
    await admin().update(portalUsers).set({ status: 'disabled', disabledBy: 'msp' }).where(eq(portalUsers.id, identity!.portalUserId));
    await call(token, 'PATCH', `/Users/${body.id}`, patchBody({ op: 'replace', path: 'active', value: false }));
    await call(token, 'PATCH', `/Users/${body.id}`, patchBody({ op: 'replace', path: 'active', value: true }));
    expect(await readIdentity(body.id)).toMatchObject({ disabledBlockers: [] });
    expect(await readAccount(identity!.portalUserId)).toMatchObject({ status: 'disabled', disabledBy: 'msp' });
  });

  it('an MSP Restore clears the scim blocker too', async () => {
    const { org, actor, token } = await seedOrg();
    const { body } = await create(token);
    await call(token, 'PATCH', `/Users/${body.id}`, patchBody({ op: 'replace', path: 'active', value: false }));
    const identity = await readIdentity(body.id);
    const out = await restorePortalIdentity({
      orgId: org.id, portalUserId: identity!.portalUserId, identityId: body.id, reactivateAccount: true, confirmMspDisabled: false, actorUserId: actor.id,
    });
    expect(out.blockersCleared).toEqual(['scim']);
    expect(await readAccount(identity!.portalUserId)).toMatchObject({ status: 'active' });
  });
});

describe('never link by email (invariant 5, Review Focus 4)', () => {
  it('POST at the address of an existing password account is 409; the account is untouched and no identity exists', async () => {
    const { org, token } = await seedOrg();
    const address = `owner-${randomUUID().slice(0, 8)}@customer.test`;
    const [existing] = await admin().insert(portalUsers).values({
      orgId: org.id, email: address, authMethod: 'password', status: 'active', browserAccess: 'granted', passwordHash: 'x',
    }).returning();
    const res = await call(token, 'POST', '/Users', userBody(randomUUID(), address.toUpperCase()));
    expect(res.status).toBe(409);
    expect(await readAccount(existing!.id)).toEqual(existing);
    expect(await countRows(portalUserIdentities, org.id)).toBe(0);
  });

  it('adopting an existing identity of the same person grants an add-in account browser access but keeps its address', async () => {
    const { org, tid, token } = await seedOrg();
    const oid = randomUUID();
    const [addin] = await admin().insert(portalUsers).values({
      orgId: org.id, email: 'addin-user@customer.test', authMethod: 'entra', status: 'active', browserAccess: 'none',
    }).returning();
    const [ident] = await admin().insert(portalUserIdentities).values({
      orgId: org.id, portalUserId: addin!.id, provider: 'entra', issuer: entraIssuer(tid), subject: oid, entraTenantId: tid, linkedVia: 'jit',
    }).returning();
    const res = await call(token, 'POST', '/Users', userBody(oid, 'renamed@customer.test'));
    expect(res.status).toBe(201);
    expect((await res.json() as any).id).toBe(ident!.id);
    expect(await readIdentity(ident!.id)).toMatchObject({ linkedVia: 'jit', scimUserName: 'renamed@customer.test' });
    expect(await readAccount(addin!.id)).toMatchObject({ browserAccess: 'granted', email: 'addin-user@customer.test' });
  });

  it('a userName change moves the login address of a SCIM-created account', async () => {
    const { token } = await seedOrg();
    const { body } = await create(token);
    await call(token, 'PATCH', `/Users/${body.id}`, patchBody({ op: 'replace', path: 'userName', value: 'New.Name@customer.test' }));
    const identity = await readIdentity(body.id);
    expect(identity!.scimUserName).toBe('New.Name@customer.test');
    expect(await readAccount(identity!.portalUserId)).toMatchObject({ email: 'new.name@customer.test' });
  });

  it('a second resource with the same userName is 409', async () => {
    const { token } = await seedOrg();
    const { userName } = await create(token);
    const res = await call(token, 'POST', '/Users', userBody(randomUUID(), userName.toUpperCase()));
    expect(res.status).toBe(409);
  });

  it('PATCH userName to another account\'s address keeps the login address and never touches that account', async () => {
    const { org, token } = await seedOrg();
    const { body } = await create(token);
    const scimAccountBefore = await readAccount((await readIdentity(body.id))!.portalUserId);
    const [victim] = await admin().insert(portalUsers).values({
      orgId: org.id, email: 'victim@customer.test', authMethod: 'password', status: 'active', browserAccess: 'granted', passwordHash: 'x',
    }).returning();
    const res = await call(token, 'PATCH', `/Users/${body.id}`, patchBody({ op: 'replace', path: 'userName', value: 'VICTIM@customer.test' }));
    expect(res.status).toBe(200);
    expect((await readAccount(scimAccountBefore!.id))!.email).toBe(scimAccountBefore!.email);
    expect(await readAccount(victim!.id)).toEqual(victim);
    const [audit] = await admin().select().from(auditLogs)
      .where(and(eq(auditLogs.orgId, org.id), eq(auditLogs.action, 'portal.scim.user.update')));
    expect(audit!.details).toMatchObject({ emailKept: true });
  });

  it('PATCH userName on an adopted account never moves its login address', async () => {
    const { org, tid, token } = await seedOrg();
    const oid = randomUUID();
    const [addin] = await admin().insert(portalUsers).values({
      orgId: org.id, email: 'addin@customer.test', authMethod: 'entra', status: 'active', browserAccess: 'granted',
    }).returning();
    await admin().insert(portalUserIdentities).values({
      orgId: org.id, portalUserId: addin!.id, provider: 'entra', issuer: entraIssuer(tid), subject: oid, entraTenantId: tid, linkedVia: 'jit',
    });
    const adopted = await (await call(token, 'POST', '/Users', userBody(oid, 'first@customer.test'))).json() as any;
    await call(token, 'PATCH', `/Users/${adopted.id}`, patchBody({ op: 'replace', path: 'userName', value: 'second@customer.test' }));
    expect(await readIdentity(adopted.id)).toMatchObject({ scimUserName: 'second@customer.test' });
    expect((await readAccount(addin!.id))!.email).toBe('addin@customer.test');
  });

  it('PATCH userName to another SCIM resource\'s userName is 409, audited, and writes nothing', async () => {
    const { org, token } = await seedOrg();
    const first = await create(token);
    const second = await create(token);
    const before = await readIdentity(second.body.id);
    const res = await call(token, 'PATCH', `/Users/${second.body.id}`, patchBody({ op: 'replace', path: 'userName', value: first.userName }));
    expect(res.status).toBe(409);
    expect(await readIdentity(second.body.id)).toEqual(before);
    const conflicts = await admin().select().from(auditLogs).where(and(eq(auditLogs.orgId, org.id), eq(auditLogs.action, 'portal.scim.user.conflict')));
    expect(conflicts).toHaveLength(1);
  });
});

describe('PUT, PATCH atomicity and DELETE aftermath (review)', () => {
  it('PUT replaces attributes and active; an externalId change is 400 and writes nothing; another org\'s id is 404', async () => {
    const { token } = await seedOrg();
    const other = await seedOrg();
    const { body, oid } = await create(token);
    const res = await call(token, 'PUT', `/Users/${body.id}`, {
      schemas: [USER_SCHEMA], externalId: oid, userName: 'put.name@customer.test', active: false, displayName: 'Put Name',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userName: 'put.name@customer.test', active: false, displayName: 'Put Name' });
    const identity = await readIdentity(body.id);
    // An omitted name part is cleared by a PUT.
    expect(identity).toMatchObject({ scimGivenName: null, scimFamilyName: null, disabledBlockers: ['scim'] });
    expect(await readAccount(identity!.portalUserId)).toMatchObject({ status: 'disabled', disabledBy: 'scim' });

    const snapshot = await readIdentity(body.id);
    const bad = await call(token, 'PUT', `/Users/${body.id}`, { externalId: randomUUID(), userName: 'x@customer.test', active: true });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ scimType: 'mutability' });
    expect(await readIdentity(body.id)).toEqual(snapshot);

    expect((await call(other.token, 'PUT', `/Users/${body.id}`, { externalId: oid, userName: 'y@customer.test' })).status).toBe(404);
    expect(await readIdentity(body.id)).toEqual(snapshot);
  });

  it('a PATCH whose later operation is refused applies none of its operations', async () => {
    const { token } = await seedOrg();
    const { body } = await create(token);
    const before = await readIdentity(body.id);
    const res = await call(token, 'PATCH', `/Users/${body.id}`, patchBody(
      { op: 'replace', path: 'active', value: false },
      { op: 'replace', path: 'externalId', value: randomUUID() },
    ));
    expect(res.status).toBe(400);
    expect(await readIdentity(body.id)).toEqual(before);
    expect(await readAccount(before!.portalUserId)).toMatchObject({ status: 'active' });
  });

  it('a repeated active:false bumps the epoch once', async () => {
    const { token } = await seedOrg();
    const { body } = await create(token);
    const off = patchBody({ op: 'replace', path: 'active', value: false });
    await call(token, 'PATCH', `/Users/${body.id}`, off);
    const accountId = (await readIdentity(body.id))!.portalUserId;
    const epoch = (await readAccount(accountId))!.authEpoch;
    expect((await call(token, 'PATCH', `/Users/${body.id}`, off)).status).toBe(200);
    expect((await readAccount(accountId))!.authEpoch).toBe(epoch);
  });

  it('DELETE of an already deactivated user still tombstones; a second DELETE is 404', async () => {
    const { token } = await seedOrg();
    const { body } = await create(token);
    await call(token, 'PATCH', `/Users/${body.id}`, patchBody({ op: 'replace', path: 'active', value: false }));
    expect((await call(token, 'DELETE', `/Users/${body.id}`)).status).toBe(204);
    expect((await readIdentity(body.id))!.scimDeletedAt).not.toBeNull();
    expect((await call(token, 'DELETE', `/Users/${body.id}`)).status).toBe(404);
  });

  it('a re-POST after DELETE never re-enables an account the MSP disabled', async () => {
    const { token } = await seedOrg();
    const { body, oid, userName } = await create(token);
    const accountId = (await readIdentity(body.id))!.portalUserId;
    await admin().update(portalUsers).set({ status: 'disabled', disabledBy: 'msp' }).where(eq(portalUsers.id, accountId));
    await call(token, 'DELETE', `/Users/${body.id}`);
    expect((await create(token, oid, userName)).res.status).toBe(201);
    expect(await readAccount(accountId)).toMatchObject({ status: 'disabled', disabledBy: 'msp' });
  });
});

describe('tenant change (review)', () => {
  it('an unrevoked token stays 401 after a different tenant is proven, and a fresh token cannot PATCH or DELETE the old tenant\'s identities', async () => {
    const { org, actor, token } = await seedOrg();
    const { body } = await create(token);
    await admin().update(clientAiTenantMappings).set({
      entraTenantId: randomUUID(), provenAt: new Date(), provenVia: 'proof_run',
      provenEvidence: { via: 'proof_run', adminOid: randomUUID(), runId: randomUUID() },
    }).where(eq(clientAiTenantMappings.orgId, org.id));
    expect((await call(token, 'GET', '/Users')).status).toBe(401);

    const fresh = await mintPortalScimToken({ orgId: org.id, label: 'New tenant', actorUserId: actor.id });
    const before = await readIdentity(body.id);
    expect((await call(fresh.token, 'PATCH', `/Users/${body.id}`, patchBody({ op: 'replace', path: 'active', value: false }))).status).toBe(404);
    expect((await call(fresh.token, 'DELETE', `/Users/${body.id}`)).status).toBe(404);
    expect(await readIdentity(body.id)).toEqual(before);
  });
});

describe('races (review)', () => {
  it('concurrent active:true and DELETE never leave a deleted-but-enabled identity', async () => {
    for (let round = 0; round < 6; round += 1) {
      const { token } = await seedOrg();
      const { body } = await create(token);
      await call(token, 'PATCH', `/Users/${body.id}`, patchBody({ op: 'replace', path: 'active', value: false }));
      await Promise.allSettled([
        call(token, 'PATCH', `/Users/${body.id}`, patchBody({ op: 'replace', path: 'active', value: true })),
        call(token, 'DELETE', `/Users/${body.id}`),
      ]);
      const identity = await readIdentity(body.id);
      if (identity!.scimDeletedAt) {
        expect(identity!.disabledBlockers).toContain('scim');
        expect(await readAccount(identity!.portalUserId)).toMatchObject({ status: 'disabled' });
      }
    }
  });

  it('two concurrent POSTs of the same person create one account and one identity, never a 500', async () => {
    for (let round = 0; round < 4; round += 1) {
      const { org, token } = await seedOrg();
      const oid = randomUUID();
      const userName = `race-${randomUUID().slice(0, 8)}@customer.test`;
      const results = await Promise.all([
        call(token, 'POST', '/Users', userBody(oid, userName)),
        call(token, 'POST', '/Users', userBody(oid, userName)),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await countRows(portalUsers, org.id)).toBe(1);
      expect(await countRows(portalUserIdentities, org.id)).toBe(1);
    }
  });
});

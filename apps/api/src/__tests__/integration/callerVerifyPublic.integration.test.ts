/**
 * Caller verification W03 (#6354 / #6357) — live public link tier.
 *
 * Real Postgres (as `breeze_app` through the production `db`) and real Redis.
 * Proves what route mocks cannot:
 *  - start → prepare → post-commit publish → SMS/email deliver → anonymous card
 *    → decision, end to end (only the outbound mail transport is faked);
 *  - exactly ONE status write across concurrent right/wrong choices (counted by
 *    a trigger probe, not inferred from the final status);
 *  - late "This is not me" fences once and opens one incident; the 24h window;
 *  - namespaced miss budgets and the per-IP request limit on real Redis;
 *  - an unrelated org's context cannot decide another org's row;
 *  - a rolled-back prepared row is never published.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { getTestDb, getTestRedis } from './setup';
import { createPartner, createOrganization, createUser } from './db-utils';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { contacts } from '../../db/schema/contacts';
import { incidents } from '../../db/schema/incidentResponse';
import { auditLogs } from '../../db/schema/audit';
import { callerVerifications as v, callerVerificationDestinations as d } from '../../db/schema/callerVerification';
import { callerVerifyPublicRoutes } from '../../routes/callerVerifyPublic';
import { hashLinkToken } from '../../services/callerVerification/linkChallenge';
import { destinationHash } from '../../services/callerVerification/destinations';
import { prepareLink } from '../../services/callerVerification/linkPorts';
import { applyDecision, start } from '../../services/callerVerification/service';
import { callerVerificationPorts } from '../../services/callerVerification/ports';
import { publishCallerVerificationEffects } from '../../jobs/callerVerificationPublisher';
import type { CallerVerificationActor } from '../../services/callerVerification/types';

const mail = vi.hoisted(() => ({ sent: [] as Array<Record<string, unknown>> }));
vi.mock('../../services/email', async (orig) => ({
  ...await orig<typeof import('../../services/email')>(),
  getEmailService: () => ({ sendEmail: async (params: Record<string, unknown>) => { mail.sent.push(params); } }),
}));

const app = new Hono().route('/verify', callerVerifyPublicRoutes);
const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn, 'callerVerifyPublic.integration'));
const post = (token: string, choice: string) => app.request(`/verify/${token}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice }),
});

let partner: string, orgA: string, orgB: string, tech: string, contactA: string;

beforeEach(async () => {
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'true');
  vi.stubEnv('PUBLIC_WEB_URL', 'https://app.example.com');
  mail.sent.length = 0;
  partner = (await createPartner())!.id;
  orgA = (await createOrganization({ partnerId: partner }))!.id;
  orgB = (await createOrganization({ partnerId: partner }))!.id;
  tech = (await createUser({ partnerId: partner, email: `cv3-${randomUUID()}@example.com`, status: 'active' }))!.id;
  await sys(async () => {
    const [c] = await db.insert(contacts).values({ orgId: orgA, name: 'Alex Example', email: 'alex@example.net' }).returning();
    contactA = c!.id;
    await db.insert(d).values({ orgId: orgA, contactId: contactA, kind: 'email', valueHash: destinationHash('alex@example.net'), valueRedacted: 'a***@example.net', source: 'technician' });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A pending, prepared email challenge inserted directly (fixture path). */
async function seed(patch: Partial<typeof v.$inferInsert> = {}) {
  const token = randomBytes(32).toString('base64url');
  const [destination] = await sys(() => db.select().from(d).where(eq(d.contactId, contactA)).limit(1));
  const [row] = await sys(() => db.insert(v).values({
    orgId: orgA, contactId: contactA, initiatedByUserId: tech, technicianLabel: 'Taylor', actionScope: 'any',
    targetLabel: 'Alex Example', method: 'email', status: 'pending', tier: 1, tierReason: 'destination_recent',
    matchValue: '42', decoyValues: ['17', '83'], reverseCode: '7291', challengeTokenHash: hashLinkToken(token),
    destinationId: destination!.id, destinationRedacted: 'a***@example.net', attemptNo: 1,
    expiresAt: new Date(Date.now() + 600_000), deliveryPublishedAt: new Date(), ...patch,
  }).returning());
  await sys(() => prepareLink(row!, token));
  return { token, row: row! };
}
const reload = async (id: string) => (await getTestDb().select().from(v).where(eq(v.id, id)))[0]!;

it('start → prepare → publish → email → anonymous card → decision, end to end', async () => {
  vi.spyOn(callerVerificationPorts, 'available').mockResolvedValue(true);
  const actor: CallerVerificationActor = { userId: tech, partnerId: partner, scope: 'partner', accessibleOrgIds: [orgA], allowedSiteIds: null, displayName: 'Taylor' };
  const ctx = { scope: 'partner' as const, orgId: null, accessibleOrgIds: [orgA], accessiblePartnerIds: [partner], currentPartnerId: partner, userId: tech };
  const started = await withDbAccessContext(ctx, () => start(actor, { orgId: orgA, contactId: contactA, method: 'email', actionScope: 'any' }));
  const stored = await reload(started.id);
  expect(stored.sealedLinkToken).toMatch(/^enc:/);
  expect(new Set(stored.challengeChoices)).toEqual(new Set([stored.matchValue, ...stored.decoyValues]));

  await publishCallerVerificationEffects();
  expect(mail.sent).toHaveLength(1);
  expect(mail.sent[0]).toMatchObject({ to: 'alex@example.net', purpose: 'security.caller_verification_link', partnerId: partner });
  const link = String(mail.sent[0]!.text).match(/https:\/\/app\.example\.com\/verify\/([A-Za-z0-9_-]{43})/);
  expect(link).not.toBeNull();
  const token = link![1]!;
  expect(hashLinkToken(token)).toBe(stored.challengeTokenHash);
  expect(stored.sealedLinkToken).not.toContain(token);
  expect((await reload(started.id)).deliveryPublishedAt).toBeInstanceOf(Date);
  // A second publisher pass never re-sends a published row.
  await publishCallerVerificationEffects();
  expect(mail.sent).toHaveLength(1);
  // The send is audited by id only.
  const audits = await getTestDb().select().from(auditLogs).where(and(eq(auditLogs.resourceId, started.id), eq(auditLogs.action, 'caller_verification.link_sent')));
  expect(audits).toHaveLength(1);
  expect(JSON.stringify(audits[0])).not.toContain(token);

  const card = await app.request(`/verify/${token}`);
  expect(card.status).toBe(200);
  expect(card.headers.get('Cache-Control')).toBe('no-store, private');
  const body = await card.json();
  expect(body).toMatchObject({ status: 'pending', contactFirstName: 'Alex', technicianLabel: 'Taylor', reverseCode: stored.reverseCode });
  expect(body.choices).toEqual(stored.challengeChoices);
  expect(JSON.stringify(body)).not.toContain(started.id);
  expect(JSON.stringify(body)).not.toContain(orgA);

  expect(await (await post(token, stored.matchValue)).json()).toEqual({ status: 'received' });
  expect((await reload(started.id)).status).toBe('verified');
  // Spent: the same link now reads exactly like an unknown one.
  expect(await (await app.request(`/verify/${token}`)).json()).toEqual({ status: 'expired' });
  expect(await (await app.request(`/verify/${'Z'.repeat(43)}`)).json()).toEqual({ status: 'expired' });
});

it('a changed destination is never mailed; the row becomes undeliverable', async () => {
  const { row } = await seed({ deliveryPublishedAt: null });
  await sys(() => db.update(contacts).set({ email: 'attacker@example.org' }).where(eq(contacts.id, contactA)));
  await publishCallerVerificationEffects();
  expect(mail.sent).toHaveLength(0);
  expect(await reload(row.id)).toMatchObject({ status: 'undeliverable', reason: 'email_failed' });
});

it('has exactly one decision UPDATE across concurrent correct and wrong choices', async () => {
  const f = await seed();
  const suffix = randomUUID().replaceAll('-', '');
  const table = `cv_probe_${suffix}`, fn = `cv_count_${suffix}`, trigger = `cv_trigger_${suffix}`;
  const admin = getTestDb();
  await admin.execute(sql.raw(`CREATE TABLE public.${table} (verification_id uuid)`));
  await admin.execute(sql.raw(`GRANT INSERT ON public.${table} TO breeze_app`));
  await admin.execute(sql.raw(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD.status IS DISTINCT FROM NEW.status THEN INSERT INTO public.${table} VALUES (NEW.id); END IF; RETURN NEW; END $$`));
  await admin.execute(sql.raw(`CREATE TRIGGER ${trigger} AFTER UPDATE ON caller_verifications FOR EACH ROW EXECUTE FUNCTION public.${fn}()`));
  try {
    const responses = await Promise.all([post(f.token, '42'), post(f.token, '17'), post(f.token, '83')]);
    for (const response of responses) expect(await response.json()).toEqual({ status: 'received' });
    const rows = await admin.execute(sql.raw(`SELECT count(*)::int AS n FROM public.${table} WHERE verification_id = '${f.row.id}'::uuid`));
    expect((rows as unknown as Array<{ n: number }>)[0]?.n).toBe(1);
    expect(['verified', 'wrong_choice']).toContain((await reload(f.row.id)).status);
  } finally {
    await admin.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON caller_verifications`));
    await admin.execute(sql.raw(`DROP FUNCTION IF EXISTS public.${fn}()`));
    await admin.execute(sql.raw(`DROP TABLE IF EXISTS public.${table}`));
  }
});

it('an expired link still accepts not_me: fences once and opens exactly one p2 incident on replay', async () => {
  const f = await seed();
  await getTestDb().update(v).set({ status: 'expired', expiresAt: new Date(Date.now() - 1000) }).where(eq(v.id, f.row.id));
  expect(await (await post(f.token, 'not_me')).json()).toEqual({ status: 'received' });
  const rejected = await reload(f.row.id);
  expect(rejected.status).toBe('rejected_by_user');
  expect(rejected.decidedAt).toBeInstanceOf(Date);
  expect(await (await post(f.token, 'not_me')).json()).toEqual({ status: 'received' });
  const opened = await getTestDb().select().from(incidents).where(and(eq(incidents.orgId, orgA),
    eq(incidents.sourceType, 'caller_verification'), eq(incidents.sourceRef, f.row.id)));
  expect(opened).toHaveLength(1);
  expect(opened[0]?.severity).toBe('p2');
  // A late number choice never resurrects anything.
  expect(await (await post(f.token, '42')).json()).toEqual({ status: 'received' });
  expect((await reload(f.row.id)).status).toBe('rejected_by_user');
});

it('does not honour not_me beyond the 24-hour public window', async () => {
  const f = await seed({ createdAt: new Date(Date.now() - 86_401_000) });
  await post(f.token, 'not_me');
  expect((await reload(f.row.id)).status).toBe('pending');
  expect(await getTestDb().select().from(incidents).where(eq(incidents.sourceRef, f.row.id))).toEqual([]);
});

it('a not_me after the link was already used revokes the grant and the contact\'s other live grants', async () => {
  const f = await seed();
  expect(await (await post(f.token, '42')).json()).toEqual({ status: 'received' });
  expect((await reload(f.row.id)).status).toBe('verified');
  const other = await seed({ status: 'verified', decidedAt: new Date() });
  expect(await (await post(f.token, 'not_me')).json()).toEqual({ status: 'received' });
  expect((await reload(f.row.id)).status).toBe('rejected_by_user');
  expect((await reload(other.row.id)).status).toBe('revoked');
  const opened = await getTestDb().select().from(incidents).where(eq(incidents.sourceRef, f.row.id));
  expect(opened).toHaveLength(1);
});

it('an expired number choice is refused by the database predicate', async () => {
  const f = await seed();
  await getTestDb().update(v).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(v.id, f.row.id));
  await post(f.token, '42');
  expect((await reload(f.row.id)).status).not.toBe('verified');
});

it('trips the real global miss budget without touching the support namespace', async () => {
  const f = await seed();
  const redis = getTestRedis();
  const now = Date.now();
  await redis.zadd('caller-verification:miss-budget', ...Array.from({ length: 500 }, (_, i) => [now, `guess-${i}`]).flat());
  expect((await app.request(`/verify/${f.token}`)).status).toBe(429);
  expect(await redis.zcard('support-code:miss-budget')).toBe(0);
});

it('records misses only for unknown tokens, in the caller-verification namespace', async () => {
  const f = await seed();
  await app.request(`/verify/${'Q'.repeat(43)}`);
  await app.request(`/verify/${f.token}`);
  const redis = getTestRedis();
  expect(await redis.zcard('caller-verification:miss-budget')).toBe(1);
  expect(await redis.zcard('caller-verification:miss-budget:src:unknown')).toBe(1);
  expect(await redis.zcard('support-code:miss-budget')).toBe(0);
});

it('the thirty-first public request from one source is limited even when every lookup succeeds', async () => {
  const f = await seed();
  for (let i = 0; i < 30; i++) expect((await app.request(`/verify/${f.token}`)).status).toBe(200);
  expect((await app.request(`/verify/${f.token}`)).status).toBe(429);
});

it('an unrelated org context cannot decide another org row; a headless caller gets its own system scope', async () => {
  const f = await seed();
  const decide = () => applyDecision({ verificationId: f.row.id, decision: { kind: 'choice', value: '42' } });
  await expect(withDbAccessContext({ scope: 'organization', orgId: orgB, accessibleOrgIds: [orgB], accessiblePartnerIds: [] }, decide))
    .rejects.toMatchObject({ code: 'not_found' });
  expect((await reload(f.row.id)).status).toBe('pending');
  await expect(runOutsideDbContext(decide)).resolves.toMatchObject({ status: 'verified' });
});

it('the org-scoped app role cannot read another org challenge or its sealed token', async () => {
  const f = await seed();
  const rows = await withDbAccessContext({ scope: 'organization', orgId: orgB, accessibleOrgIds: [orgB], accessiblePartnerIds: [] },
    () => db.select({ id: v.id }).from(v).where(eq(v.challengeTokenHash, hashLinkToken(f.token))));
  expect(rows).toEqual([]);
});

it('publishes a prepared committed link once and never a rolled-back one', async () => {
  const f = await seed({ deliveryPublishedAt: null });
  const rolledBack = randomUUID();
  const ghostToken = randomBytes(32).toString('base64url');
  await expect(sys(async () => {
    const [row] = await db.insert(v).values({ ...f.row, id: rolledBack, challengeTokenHash: hashLinkToken(ghostToken), sealedLinkToken: null, challengeChoices: null, deliveryPublishedAt: null }).returning();
    await prepareLink(row!, ghostToken);
    throw new Error('rollback probe');
  })).rejects.toThrow('rollback probe');
  const deliver = vi.spyOn(callerVerificationPorts, 'deliver').mockResolvedValue();
  await publishCallerVerificationEffects();
  await publishCallerVerificationEffects();
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver).toHaveBeenCalledWith(f.row.id);
  expect(await getTestDb().select().from(v).where(eq(v.id, rolledBack))).toEqual([]);
  const saved = await reload(f.row.id);
  expect(saved.deliveryPublishedAt).toBeInstanceOf(Date);
  expect(saved.sealedLinkToken).not.toContain(f.token);
});

it('rejects a malformed stored choice order at the database', async () => {
  const f = await seed();
  await expect(getTestDb().update(v).set({ challengeChoices: ['42', '17', '99'] }).where(eq(v.id, f.row.id))).rejects.toThrow();
  await expect(getTestDb().update(v).set({ challengeChoices: ['42', '42', '17'] }).where(eq(v.id, f.row.id))).rejects.toThrow();
});

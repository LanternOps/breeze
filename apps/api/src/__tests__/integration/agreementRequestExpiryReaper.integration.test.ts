/**
 * Expiry reaper + remind on a real database (#9075 W3b; spec §3.5).
 *
 *  - the sweep flips ONLY sent/viewed rows at/after expires_at (the instant
 *    boundary), stamps expired_at, and is idempotent;
 *  - remind increments reminder_count in SQL, keeps the SAME accept-token
 *    identity, and refuses every non-open status.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { createOrganization, createPartner, createUser } from './db-utils';
import { insertRecipient, insertRequest, rows, seedPublishedTemplate, sys } from './agreementRequestsFixtures';
import { expireAgreementRequests } from '../../jobs/agreementRequestExpiryReaper';
import { createAgreementRequest, remindAgreementRequest, sendAgreementRequest } from '../../services/agreementRequestLifecycle';
import type { AuthContext } from '../../middleware/auth';

// The bus is Redis-backed and unconsumed; the sweep's contract here is the DB.
vi.mock('../../services/agreementEvents', () => ({
  emitAgreementEvent: vi.fn(),
  emitAgreementEventForOrg: vi.fn(),
}));

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed() {
  return sys(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const tv = await seedPublishedTemplate(partner.id);
    return { partner, org, tv };
  });
}

async function force(id: string, status: string, expiresAtSql: ReturnType<typeof sql>) {
  await sys(() => db.execute(sql`UPDATE agreement_requests SET status = ${status}, expires_at = ${expiresAtSql} WHERE id = ${id}::uuid`));
}

async function statusOf(id: string) {
  return sys(async () => rows(await db.execute(sql`SELECT status, expired_at FROM agreement_requests WHERE id = ${id}::uuid`))[0]!);
}

describe('expireAgreementRequests sweep', () => {
  runDb('flips only sent/viewed requests at/after expires_at; leaves everything else alone; idempotent', async () => {
    const { org, tv } = await seed();
    const mk = () => insertRequest(org.id, tv);
    const sentPast = await mk();     await force(sentPast, 'sent', sql`now() - interval '1 hour'`);        // → expired
    const viewedPast = await mk();   await force(viewedPast, 'viewed', sql`now() - interval '1 second'`);  // → expired
    const sentFuture = await mk();   await force(sentFuture, 'sent', sql`now() + interval '1 day'`);       // stays
    const draftPast = await mk();    await force(draftPast, 'draft', sql`now() - interval '1 hour'`);      // not issued yet
    const signedPast = await mk();   await force(signedPast, 'signed', sql`now() - interval '1 hour'`);    // terminal
    const declinedPast = await mk(); await force(declinedPast, 'declined', sql`now() - interval '1 hour'`);
    const voidedPast = await mk();   await force(voidedPast, 'voided', sql`now() - interval '1 hour'`);

    const count = await withSystemDbAccessContext(() => expireAgreementRequests());
    // Other suites' leftovers may also be due; ours are the two above.
    expect(count).toBeGreaterThanOrEqual(2);

    const byId = Object.fromEntries(await Promise.all(
      [sentPast, viewedPast, sentFuture, draftPast, signedPast, declinedPast, voidedPast].map(async (id) => [id, await statusOf(id)]),
    ));
    expect(byId[sentPast]!.status).toBe('expired');
    expect(byId[sentPast]!.expired_at).not.toBeNull();
    expect(byId[viewedPast]!.status).toBe('expired');
    expect(byId[sentFuture]!.status).toBe('sent');
    expect(byId[draftPast]!.status).toBe('draft');
    expect(byId[signedPast]!.status).toBe('signed');
    expect(byId[declinedPast]!.status).toBe('declined');
    expect(byId[voidedPast]!.status).toBe('voided');

    // Second pass: nothing of ours is left to flip.
    await withSystemDbAccessContext(() => expireAgreementRequests());
    expect((await statusOf(sentFuture)).status).toBe('sent');
    expect((await statusOf(sentPast)).status).toBe('expired');
  });

  runDb('the boundary is the instant: now === expires_at is expired, one ms later is not', async () => {
    const { org, tv } = await seed();
    const edge = await insertRequest(org.id, tv);
    const later = await insertRequest(org.id, tv);
    const now = new Date('2030-01-01T00:00:00.000Z');
    await force(edge, 'sent', sql`${now.toISOString()}::timestamptz`);
    await force(later, 'sent', sql`${new Date(now.getTime() + 1).toISOString()}::timestamptz`);
    await withSystemDbAccessContext(() => expireAgreementRequests(now));
    expect((await statusOf(edge)).status).toBe('expired');
    expect((await statusOf(later)).status).toBe('sent');
  });
});

describe('remindAgreementRequest on a real database', () => {
  function partnerCtx(partnerId: string, orgId: string, userId: string): DbAccessContext {
    return {
      scope: 'partner', orgId: null, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId],
      currentPartnerId: partnerId, userId,
    };
  }
  function staffAuth(partnerId: string, orgId: string, userId: string): AuthContext {
    return {
      user: { id: userId }, partnerId,
      canAccessOrg: (id: string) => id === orgId, orgCondition: () => undefined,
    } as unknown as AuthContext;
  }

  runDb('same link, SQL counter bump, last_reminded_at set; refused once the request leaves sent/viewed', async () => {
    const { partner, org, tv } = await seed();
    const user = await sys(() => createUser({ partnerId: partner.id, orgId: org.id, withMembership: false }));
    const ctx = partnerCtx(partner.id, org.id, user.id);
    const auth = staffAuth(partner.id, org.id, user.id);
    const now = new Date();

    const draft = await withDbAccessContext(ctx, () => createAgreementRequest(auth, {
      orgId: org.id, templateId: tv.templateId, recipients: ['jane@example.com'], variableValues: {},
    }, now));
    const sent = await withDbAccessContext(ctx, () => sendAgreementRequest(auth, draft.id, now));
    const before = await sys(async () => rows(await db.execute(sql`SELECT accept_token_jti, reminder_count FROM agreement_requests WHERE id = ${draft.id}::uuid`))[0]!);
    expect(before.reminder_count).toBe(0);

    const first = await withDbAccessContext(ctx, () => remindAgreementRequest(auth, draft.id, now));
    const second = await withDbAccessContext(ctx, () => remindAgreementRequest(auth, draft.id, now));
    expect(first.link).toBe(sent.link);
    expect(second.link).toBe(sent.link);
    expect(first.reissued).toBe(false);

    const after = await sys(async () => rows(await db.execute(sql`SELECT accept_token_jti, reminder_count, last_reminded_at FROM agreement_requests WHERE id = ${draft.id}::uuid`))[0]!);
    expect(after.accept_token_jti).toBe(before.accept_token_jti); // never a new credential
    expect(after.reminder_count).toBe(2);
    expect(after.last_reminded_at).not.toBeNull();

    await force(draft.id, 'voided', sql`now() + interval '1 day'`);
    await expect(withDbAccessContext(ctx, () => remindAgreementRequest(auth, draft.id, now))).rejects.toMatchObject({ status: 409 });
    const final = await sys(async () => rows(await db.execute(sql`SELECT reminder_count FROM agreement_requests WHERE id = ${draft.id}::uuid`))[0]!);
    expect(final.reminder_count).toBe(2);
  });

  runDb('recipient rows are required (an unrecipiented request cannot be reminded)', async () => {
    const { partner, org, tv } = await seed();
    const user = await sys(() => createUser({ partnerId: partner.id, orgId: org.id, withMembership: false }));
    const ctx = partnerCtx(partner.id, org.id, user.id);
    const auth = staffAuth(partner.id, org.id, user.id);
    const id =await insertRequest(org.id, tv, { status: 'sent' });
    await insertRecipient(org.id, id, 'jane@example.com');
    await sys(() => db.execute(sql`DELETE FROM agreement_request_recipients WHERE request_id = ${id}::uuid`));
    await expect(withDbAccessContext(ctx, () => remindAgreementRequest(auth, id, new Date()))).rejects.toMatchObject({ status: 422, code: 'RECIPIENTS_REQUIRED' });
  });
});

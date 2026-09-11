/**
 * Real-driver cross-tenant forge tests for `stripe_connect_credentials` (SEC-150).
 *
 * The table retains SUPERSEDED Stripe secret keys so an already-rotated
 * credential can still expire the Checkout sessions it minted. That makes its
 * isolation load-bearing in a way an ordinary config table's is not: a leak here
 * is a live payment credential for another MSP's Stripe account.
 *
 * Shape 3 (partner-axis), same policy family as `stripe_financial_events`:
 *   SELECT  — system scope OR breeze_has_partner_access(partner_id)
 *   INSERT/UPDATE/DELETE — system scope AND breeze_has_partner_access(partner_id)
 *
 * Runs under vitest.integration.config.ts, so the code under test connects as
 * the unprivileged `breeze_app` role and RLS is genuinely enforced. The forged
 * inserts are the guard against a vacuous pass on a BYPASSRLS connection.
 *
 * NOT memoized: setup.ts TRUNCATEs partners/organizations before every test, so
 * a cached fixture would hand later cases rows that no longer exist.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { stripeConnectAccounts, stripeConnectCredentials } from '../../db/schema';
import { createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function partnerCtx(partnerId: string): DbAccessContext {
  return {
    scope: 'partner', orgId: null, accessibleOrgIds: null,
    accessiblePartnerIds: [partnerId], userId: null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function seed() {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const [acctA] = await db.insert(stripeConnectAccounts).values({
      partnerId: partnerA.id,
      stripeAccountId: `acct_${partnerA.id.slice(0, 8)}`,
      apiKey: 'enc:test-key', keyLast4: '4242', livemode: false,
    }).returning();
    const [acctB] = await db.insert(stripeConnectAccounts).values({
      partnerId: partnerB.id,
      stripeAccountId: `acct_${partnerB.id.slice(0, 8)}`,
      apiKey: 'enc:test-key', keyLast4: '1111', livemode: false,
    }).returning();
    if (!acctA || !acctB) throw new Error('failed to seed stripe connect accounts');

    const now = new Date();
    const [credA] = await db.insert(stripeConnectCredentials).values({
      partnerId: partnerA.id,
      stripeConnectionId: acctA.id,
      stripeAccountId: acctA.stripeAccountId,
      apiKey: 'enc:superseded-key-A', keyLast4: '9999', livemode: false,
      generation: 1,
      supersededAt: now,
      eraseAfter: new Date(now.getTime() + 120 * DAY_MS),
      eraseHardCapAt: new Date(now.getTime() + 400 * DAY_MS),
    }).returning();
    if (!credA) throw new Error('failed to seed superseded credential');

    return { partnerA, partnerB, acctA, acctB, credA, now };
  });
}

describe('stripe_connect_credentials RLS (breeze_app)', () => {
  runDb('system scope can read the seeded credential (existence probe — not vacuous)', async () => {
    const { credA } = await seed();
    const rows = await withSystemDbAccessContext(() => db.select()
      .from(stripeConnectCredentials).where(eq(stripeConnectCredentials.id, credA.id)));
    expect(rows).toHaveLength(1);
  });

  runDb('the owning partner can read its own superseded credential row', async () => {
    const { partnerA, credA } = await seed();
    const rows = await withDbAccessContext(partnerCtx(partnerA.id), () => db.select()
      .from(stripeConnectCredentials).where(eq(stripeConnectCredentials.id, credA.id)));
    expect(rows).toHaveLength(1);
  });

  runDb('partner B cannot read partner A superseded credential', async () => {
    const { partnerB, credA } = await seed();
    const rows = await withDbAccessContext(partnerCtx(partnerB.id), () => db.select()
      .from(stripeConnectCredentials).where(eq(stripeConnectCredentials.id, credA.id)));
    expect(rows).toHaveLength(0);
  });

  runDb('a forged cross-partner INSERT is rejected with 42501', async () => {
    const { partnerA, partnerB, acctA, now } = await seed();
    await expect(withDbAccessContext(partnerCtx(partnerB.id), () =>
      db.insert(stripeConnectCredentials).values({
        partnerId: partnerA.id, // forged — RLS must reject
        stripeConnectionId: acctA.id,
        stripeAccountId: acctA.stripeAccountId,
        apiKey: 'enc:forged', keyLast4: '0000', livemode: false,
        generation: 2,
        supersededAt: now,
        eraseAfter: new Date(now.getTime() + 120 * DAY_MS),
        eraseHardCapAt: new Date(now.getTime() + 400 * DAY_MS),
      }))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('even the OWNING partner cannot write the table outside a system scope', async () => {
    const { partnerA, acctA, now } = await seed();
    // The archive is written only by the credential transitions, under a system
    // context. A partner-scope write would let an operator plant or overwrite
    // key material with no audit trail.
    await expect(withDbAccessContext(partnerCtx(partnerA.id), () =>
      db.insert(stripeConnectCredentials).values({
        partnerId: partnerA.id,
        stripeConnectionId: acctA.id,
        stripeAccountId: acctA.stripeAccountId,
        apiKey: 'enc:self-planted', keyLast4: '0000', livemode: false,
        generation: 3,
        supersededAt: now,
        eraseAfter: new Date(now.getTime() + 120 * DAY_MS),
        eraseHardCapAt: new Date(now.getTime() + 400 * DAY_MS),
      }))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('a partner-scope UPDATE silently affects zero rows and cannot destroy the key', async () => {
    const { partnerA, credA } = await seed();
    const changed = await withDbAccessContext(partnerCtx(partnerA.id), () =>
      db.update(stripeConnectCredentials).set({ apiKey: null })
        .where(eq(stripeConnectCredentials.id, credA.id)).returning());
    expect(changed).toHaveLength(0);
    const [unchanged] = await withSystemDbAccessContext(() => db.select()
      .from(stripeConnectCredentials).where(eq(stripeConnectCredentials.id, credA.id)));
    expect(unchanged!.apiKey).toBe('enc:superseded-key-A');
  });

  runDb('the composite connection FK rejects cross-partner provenance', async () => {
    const { partnerA, partnerB, acctA, now } = await seed();
    // System scope: RLS is out of the picture, so the ONLY reason this can fail
    // is the (stripe_connection_id, partner_id) composite FK.
    await expect(withSystemDbAccessContext(() =>
      db.insert(stripeConnectCredentials).values({
        partnerId: partnerB.id,
        stripeConnectionId: acctA.id, // partner A's connection
        stripeAccountId: acctA.stripeAccountId,
        apiKey: 'enc:cross', keyLast4: '0000', livemode: false,
        // generation 2: 1 is already taken on this connection, and the unique
        // index would fire FIRST, masking the FK this case exists to prove.
        generation: 2,
        supersededAt: now,
        eraseAfter: new Date(now.getTime() + 120 * DAY_MS),
        eraseHardCapAt: new Date(now.getTime() + 400 * DAY_MS),
      }))).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('generation is unique per connection — two rotations cannot collide', async () => {
    const { partnerA, acctA, now } = await seed();
    await expect(withSystemDbAccessContext(() =>
      db.insert(stripeConnectCredentials).values({
        partnerId: partnerA.id,
        stripeConnectionId: acctA.id,
        stripeAccountId: acctA.stripeAccountId,
        apiKey: 'enc:dupe', keyLast4: '0000', livemode: false,
        generation: 1, // already taken by credA
        supersededAt: now,
        eraseAfter: new Date(now.getTime() + 120 * DAY_MS),
        eraseHardCapAt: new Date(now.getTime() + 400 * DAY_MS),
      }))).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});

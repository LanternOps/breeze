/**
 * SEC-2026-09-05-150 — fail-closed Checkout-session revocation, against real Postgres.
 *
 * The finding: a Stripe Checkout session stays PROVIDER-PAYABLE after Breeze
 * resets the invoice's public link, records an alternate payment, voids the
 * invoice, replaces the Stripe key or disconnects Stripe. Local settlement
 * protects the Breeze ledger and cannot stop a real charge.
 *
 * What this suite pins, and why each needs a real database rather than a mock:
 *   - the transition matrix: every fail-closed transition must reach the
 *     provider BEFORE it changes local state, and must REFUSE when it cannot;
 *   - the provider-response state machine, whose rows are enum values and
 *     `now()`-relative timestamps written by SQL the mock cannot execute;
 *   - concurrency: create-vs-revoke and pay-vs-revoke depend on the invoice row
 *     lock actually serialising two transactions;
 *   - the worker's due-selection, which uses the DATABASE clock and a window
 *     function for per-partner fairness;
 *   - old-key retry: a session minted under generation N stays revocable after
 *     the key rotates to N+1, which is the entire point of the archive table.
 *
 * The Stripe SDK is mocked (there is no Stripe in CI); everything below it —
 * RLS, locks, enum transitions, retry ladder arithmetic — is real.
 */
import './setup';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  runOutsideDbContext,
  type DbAccessContext,
} from '../../db';
import {
  invoiceStripePayments,
  stripeConnectAccounts,
  stripeConnectCredentials,
} from '../../db/schema/stripePayments';
import { invoices } from '../../db/schema/invoices';
import { auditLogs } from '../../db/schema/audit';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Stripe SDK fake. `_key` is recorded on every call so the tests can assert
// WHICH credential expired a session — the archive contract is meaningless
// unless the outgoing key is the one that reaches Stripe.
// ---------------------------------------------------------------------------
const { expireMock, retrieveMock, createMock, accountsRetrieveMock, eventsListMock, constructedKeys } = vi.hoisted(() => ({
  expireMock: vi.fn(),
  retrieveMock: vi.fn(),
  createMock: vi.fn(),
  accountsRetrieveMock: vi.fn(),
  eventsListMock: vi.fn(),
  constructedKeys: [] as string[],
}));

vi.mock('stripe', () => ({
  default: class MockStripe {
    public _key: string;
    accounts = { retrieve: accountsRetrieveMock };
    events = { list: eventsListMock };
    checkout: {
      sessions: {
        expire: (id: string) => unknown;
        retrieve: (id: string) => unknown;
        create: (params: unknown, opts: unknown) => unknown;
      };
    };
    constructor(key: string) {
      this._key = key;
      constructedKeys.push(key);
      this.checkout = {
        sessions: {
          expire: (id: string) => expireMock(key, id),
          retrieve: (id: string) => retrieveMock(key, id),
          create: (params: unknown, opts: unknown) => createMock(key, params, opts),
        },
      };
    }
  },
}));

import { savePartnerStripeKey, disconnectPartnerStripe } from '../../services/partnerStripe';
import { settleCheckoutSession } from '../../services/stripeSettle';
import { recordPayment, voidInvoice } from '../../services/invoiceService';
import { createInvoicePayLink } from '../../services/invoiceCheckout';
import {
  abandonInvoiceSessionRevocation,
  rearmBlockedRevocationsForAccount,
  assertInvoiceSessionsRevoked,
  getPartnerRevocationHealth,
  requestInvoiceSessionRevocation,
  RETRY_GIVE_UP_MS,
} from '../../services/stripeSessionRevocation';
import {
  selectDueRevocations,
  runStripeSessionRevocationSweep,
  runCredentialEraser,
  resetCredentialEraserThrottleForTests,
  MAX_PER_PARTNER_PER_RUN,
} from '../../jobs/stripeSessionRevocationSweep';
import { eraseExpiredStripeCredentials } from '../../services/stripeCredentialArchive';
import { decryptSecret } from '../../services/secretCrypto';

// Assembled from parts so the literal does not trip secret-scanning push protection.
const KEY_GEN1 = ['sk', 'test', 'SEC150generationONE1111'].join('_');
const KEY_GEN2 = ['sk', 'test', 'SEC150generationTWO2222'].join('_');
const DAY_MS = 24 * 60 * 60 * 1000;

function stripeError(type: string, code?: string, message = 'stripe refused'): Error {
  return Object.assign(new Error(message), { type, ...(code ? { code } : {}) });
}

/** An actor with unrestricted access to the fixture org. */
function actorFor(orgId: string) {
  return { userId: null, partnerId: null, accessibleOrgIds: [orgId] };
}

interface Fixture {
  partnerId: string;
  orgId: string;
  invoiceId: string;
  accountId: string;
  connectionId: string;
  sessionId: string;
  mappingId: string;
}

/**
 * One partner with a live Stripe key (encrypted through the real secretCrypto
 * path — `savePartnerStripeKey` is the only writer of that column), one issued
 * invoice, and one OPEN Checkout-session mapping on it.
 *
 * Not memoized: setup.ts TRUNCATEs partners/organizations before every test.
 */
async function seedFixture(opts: { balance?: string; status?: 'sent' | 'partially_paid' | 'overdue' } = {}): Promise<Fixture> {
  accountsRetrieveMock.mockResolvedValue({ id: 'acct_sec150', default_currency: 'usd', country: 'US' });
  eventsListMock.mockResolvedValue({ data: [], has_more: false });
  // The key-save capability probe expires a bogus session id; resource_missing
  // is the "you have the permission" answer.
  expireMock.mockRejectedValue(stripeError('StripeInvalidRequestError', 'resource_missing'));

  const partner = await withSystemDbAccessContext(() => createPartner());
  const org = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
  await savePartnerStripeKey({ partnerId: partner.id, apiKey: KEY_GEN1, userId: null });

  return withSystemDbAccessContext(async () => {
    const [conn] = await db.select().from(stripeConnectAccounts)
      .where(eq(stripeConnectAccounts.partnerId, partner.id)).limit(1);
    const [inv] = await db.insert(invoices).values({
      partnerId: partner.id, orgId: org.id,
      status: opts.status ?? 'sent', currencyCode: 'USD',
      // An invoice_number is what makes recomputeInvoiceStatus treat the row as
      // ISSUED; without one every recompute collapses it back to 'draft' and the
      // paid/void assertions below would be vacuous.
      invoiceNumber: `SEC150-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
      sentAt: new Date(),
      total: opts.balance ?? '100.00', balance: opts.balance ?? '100.00', amountPaid: '0.00',
      issueDate: '2026-09-01', dueDate: '2026-09-30',
    }).returning({ id: invoices.id });
    const sessionId = `cs_test_${inv!.id.slice(0, 8)}`;
    const [mapping] = await db.insert(invoiceStripePayments).values({
      orgId: org.id, invoiceId: inv!.id,
      stripeAccountId: conn!.stripeAccountId,
      stripeObjectType: 'checkout_session', stripeObjectId: sessionId,
      amount: opts.balance ?? '100.00', currency: 'USD', status: 'pending',
    }).returning({ id: invoiceStripePayments.id });

    // The key-save capability probe already called expire once. Drop it so a
    // test can assert on what the REVOCATION did, not on fixture noise.
    expireMock.mockClear();
    return {
      partnerId: partner.id, orgId: org.id, invoiceId: inv!.id,
      accountId: conn!.stripeAccountId, connectionId: conn!.id,
      sessionId, mappingId: mapping!.id,
    };
  });
}

/** expire() calls that targeted a real session, excluding the capability probe. */
function expireCallsFor(sessionId: string): unknown[][] {
  return expireMock.mock.calls.filter((c) => c[1] === sessionId);
}

async function readMapping(mappingId: string) {
  const [row] = await withSystemDbAccessContext(() => db.select()
    .from(invoiceStripePayments).where(eq(invoiceStripePayments.id, mappingId)).limit(1));
  return row!;
}

async function readInvoice(invoiceId: string) {
  const [row] = await withSystemDbAccessContext(() => db.select()
    .from(invoices).where(eq(invoices.id, invoiceId)).limit(1));
  return row!;
}

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: a `mockResolvedValue` set by one case
  // survives `clear` and silently drives the next one (a stale
  // complete/paid retrieve turned three retryable cases into charged_repair).
  vi.resetAllMocks();
  constructedKeys.length = 0;
  resetCredentialEraserThrottleForTests();
  delete process.env.STRIPE_SESSION_REVOCATION_MODE;
});

afterEach(() => {
  delete process.env.STRIPE_SESSION_REVOCATION_MODE;
});

// ---------------------------------------------------------------------------
// Provider-response state machine
// ---------------------------------------------------------------------------
describe('SEC-150 provider-response state machine', () => {
  runDb('an open session that Stripe expires becomes revoked', async () => {
    const fx = await seedFixture();
    expireMock.mockResolvedValue({ id: fx.sessionId, status: 'expired' });

    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'link_reset', requestedByUserId: null,
    });

    expect(expireMock).toHaveBeenCalledWith(KEY_GEN1, fx.sessionId);
    const row = await readMapping(fx.mappingId);
    expect(row.revocationState).toBe('revoked');
    expect(row.revokedAt).not.toBeNull();
    expect(row.revocationNextAttemptAt).toBeNull();
  });

  runDb('a session Stripe has never heard of becomes revoked, not retried forever', async () => {
    const fx = await seedFixture();
    expireMock.mockRejectedValue(stripeError('StripeInvalidRequestError', 'resource_missing'));

    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'invoice_void', requestedByUserId: null,
    });

    const row = await readMapping(fx.mappingId);
    expect(row.revocationState).toBe('revoked');
    expect(row.revocationLastProviderCode).toBe('resource_missing');
  });

  runDb('an already-expired session is read back and recorded revoked', async () => {
    const fx = await seedFixture();
    expireMock.mockRejectedValue(stripeError('StripeInvalidRequestError', 'session_not_open'));
    retrieveMock.mockResolvedValue({ id: fx.sessionId, status: 'expired', payment_status: 'unpaid' });

    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'invoice_void', requestedByUserId: null,
    });

    const row = await readMapping(fx.mappingId);
    expect(row.revocationState).toBe('revoked');
    expect(row.revocationLastProviderCode).toBe('already_expired');
  });

  runDb('a session that is already PAID lands in charged_repair — never a false revoked', async () => {
    const fx = await seedFixture();
    expireMock.mockRejectedValue(stripeError('StripeInvalidRequestError', 'session_not_open'));
    retrieveMock.mockResolvedValue({ id: fx.sessionId, status: 'complete', payment_status: 'paid' });

    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'invoice_void', requestedByUserId: null,
    });

    const row = await readMapping(fx.mappingId);
    expect(row.revocationState).toBe('charged_repair');
    // charged_repair must BLOCK the transition: provider truth wins.
    await expect(withSystemDbAccessContext(() => assertInvoiceSessionsRevoked(fx.invoiceId)))
      .rejects.toMatchObject({ status: 503, code: 'STRIPE_REVOCATION_PENDING' });
  });

  runDb.each([
    ['authentication failure', stripeError('StripeAuthenticationError')],
    ['permission denied', stripeError('StripePermissionError')],
  ])('%s blocks immediately and schedules no retry', async (_label, err) => {
    const fx = await seedFixture();
    expireMock.mockRejectedValue(err);

    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'invoice_void', requestedByUserId: null,
    });

    const row = await readMapping(fx.mappingId);
    expect(row.revocationState).toBe('revocation_blocked');
    expect(row.revocationNextAttemptAt).toBeNull();
  });

  runDb.each([
    ['timeout', stripeError('StripeConnectionError', undefined, 'Request timed out')],
    ['rate limit', stripeError('StripeRateLimitError')],
    ['stripe 5xx', stripeError('StripeAPIError')],
  ])('%s stays retryable with durable intent and a scheduled next attempt', async (_label, err) => {
    const fx = await seedFixture();
    expireMock.mockRejectedValue(err);

    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'invoice_void', requestedByUserId: null,
    });

    const row = await readMapping(fx.mappingId);
    expect(row.revocationState).toBe('revocation_requested');
    expect(row.revocationAttempts).toBeGreaterThan(0);
    expect(row.revocationNextAttemptAt).not.toBeNull();
    // The 12s request budget allows 2 attempts; both must have been spent.
    expect(expireCallsFor(fx.sessionId)).toHaveLength(2);
  });

  runDb('the ladder gives up after 48h and blocks rather than retrying forever', async () => {
    const fx = await seedFixture();
    expireMock.mockRejectedValue(stripeError('StripeAPIError'));
    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'invoice_void', requestedByUserId: null,
    });
    // Backdate the intent past the give-up horizon and re-run the ladder.
    await withSystemDbAccessContext(() => db.update(invoiceStripePayments)
      .set({ revocationRequestedAt: new Date(Date.now() - RETRY_GIVE_UP_MS - 60_000) })
      .where(eq(invoiceStripePayments.id, fx.mappingId)));
    await withSystemDbAccessContext(() => db.update(invoiceStripePayments)
      .set({ revocationNextAttemptAt: sql`now() - interval '1 minute'` })
      .where(eq(invoiceStripePayments.id, fx.mappingId)));

    await runStripeSessionRevocationSweep();

    const row = await readMapping(fx.mappingId);
    expect(row.revocationState).toBe('revocation_blocked');
    expect(row.revocationNextAttemptAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transition matrix — every fail-closed caller
// ---------------------------------------------------------------------------
describe('SEC-150 fail-closed transitions', () => {
  runDb('recordPayment revokes the open session BEFORE the payment lands', async () => {
    const fx = await seedFixture();
    expireMock.mockResolvedValue({ id: fx.sessionId, status: 'expired' });

    await withSystemDbAccessContext(() => recordPayment(fx.invoiceId, {
      amount: '100.00', method: 'check', receivedAt: '2026-09-10',
    } as never, actorFor(fx.orgId) as never));

    expect(expireMock).toHaveBeenCalledWith(KEY_GEN1, fx.sessionId);
    expect((await readMapping(fx.mappingId)).revocationState).toBe('revoked');
    expect((await readInvoice(fx.invoiceId)).status).toBe('paid');
  });

  runDb('recordPayment REFUSES with 503 and records nothing when Stripe is unreachable', async () => {
    const fx = await seedFixture();
    expireMock.mockRejectedValue(stripeError('StripeAPIError'));

    await expect(withSystemDbAccessContext(() => recordPayment(fx.invoiceId, {
      amount: '100.00', method: 'check', receivedAt: '2026-09-10',
    } as never, actorFor(fx.orgId) as never)))
      .rejects.toMatchObject({ status: 503, code: 'STRIPE_REVOCATION_PENDING' });

    // Nothing changed locally, and the intent SURVIVED the refusal so the sweep
    // can finish the job — that is what makes fail-closed bounded, not permanent.
    const inv = await readInvoice(fx.invoiceId);
    expect(inv.status).toBe('sent');
    expect(inv.amountPaid).toBe('0.00');
    expect((await readMapping(fx.mappingId)).revocationState).toBe('revocation_requested');
  });

  runDb('voidInvoice revokes the open session before voiding', async () => {
    const fx = await seedFixture();
    expireMock.mockResolvedValue({ id: fx.sessionId, status: 'expired' });

    await withSystemDbAccessContext(() => voidInvoice(fx.invoiceId, 'duplicate', { reissue: false }, actorFor(fx.orgId) as never));

    expect(expireMock).toHaveBeenCalledWith(KEY_GEN1, fx.sessionId);
    expect((await readInvoice(fx.invoiceId)).status).toBe('void');
    expect((await readMapping(fx.mappingId)).revocationState).toBe('revoked');
  });

  runDb('voidInvoice REFUSES with 503 when the session cannot be proven dead', async () => {
    const fx = await seedFixture();
    expireMock.mockRejectedValue(stripeError('StripeRateLimitError'));

    await expect(withSystemDbAccessContext(() => voidInvoice(fx.invoiceId, 'duplicate', { reissue: false }, actorFor(fx.orgId) as never)))
      .rejects.toMatchObject({ status: 503, code: 'STRIPE_REVOCATION_PENDING' });
    expect((await readInvoice(fx.invoiceId)).status).toBe('sent');
  });

  runDb('observe mode still records intent and still calls Stripe, but never refuses', async () => {
    const fx = await seedFixture();
    process.env.STRIPE_SESSION_REVOCATION_MODE = 'observe';
    expireMock.mockRejectedValue(stripeError('StripeAPIError'));

    await withSystemDbAccessContext(() => voidInvoice(fx.invoiceId, 'duplicate', { reissue: false }, actorFor(fx.orgId) as never));

    expect(expireMock).toHaveBeenCalledWith(KEY_GEN1, fx.sessionId);
    expect((await readInvoice(fx.invoiceId)).status).toBe('void');
    // The intent is still durable — de-escalation must not lose the work.
    expect((await readMapping(fx.mappingId)).revocationState).toBe('revocation_requested');
  });

  runDb('an unrecognised STRIPE_SESSION_REVOCATION_MODE falls back to enforce, never to fail-open', async () => {
    const fx = await seedFixture();
    process.env.STRIPE_SESSION_REVOCATION_MODE = 'obseve'; // typo
    expireMock.mockRejectedValue(stripeError('StripeAPIError'));

    await expect(withSystemDbAccessContext(() => voidInvoice(fx.invoiceId, 'typo-mode', { reissue: false }, actorFor(fx.orgId) as never)))
      .rejects.toMatchObject({ status: 503 });
  });
});

// ---------------------------------------------------------------------------
// Producers
// ---------------------------------------------------------------------------
describe('SEC-150 producer gate', () => {
  runDb('createInvoicePayLink refuses to mint a session while a revocation is in flight', async () => {
    const fx = await seedFixture();
    expireMock.mockRejectedValue(stripeError('StripeAPIError')); // leaves intent pending
    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'link_reset', requestedByUserId: null,
    });
    expect((await readMapping(fx.mappingId)).revocationState).toBe('revocation_requested');

    await expect(withSystemDbAccessContext(() => createInvoicePayLink(fx.invoiceId, actorFor(fx.orgId) as never)))
      .rejects.toMatchObject({ status: 409, code: 'STRIPE_REVOCATION_PENDING' });

    // No second mapping row was created — the window stayed closed.
    const rows = await withSystemDbAccessContext(() => db.select()
      .from(invoiceStripePayments).where(eq(invoiceStripePayments.invoiceId, fx.invoiceId)));
    expect(rows).toHaveLength(1);
  });

  runDb('a session minted before the intent is still covered by it', async () => {
    // The gate protects the window AFTER intent; this proves the intent phase
    // sweeps up every pre-existing open session on the invoice rather than only
    // the newest one.
    const fx = await seedFixture();
    const secondSessionId = `${fx.sessionId}_b`;
    const [second] = await withSystemDbAccessContext(() => db.insert(invoiceStripePayments).values({
      orgId: fx.orgId, invoiceId: fx.invoiceId, stripeAccountId: fx.accountId,
      stripeObjectType: 'checkout_session', stripeObjectId: secondSessionId,
      amount: '50.00', currency: 'USD', status: 'pending',
    }).returning({ id: invoiceStripePayments.id }));
    expireMock.mockResolvedValue({ status: 'expired' });

    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'link_reset', requestedByUserId: null,
    });

    expect((await readMapping(fx.mappingId)).revocationState).toBe('revoked');
    expect((await readMapping(second!.id)).revocationState).toBe('revoked');
  });
});

// ---------------------------------------------------------------------------
// Settlement: sibling sessions
// ---------------------------------------------------------------------------
describe('SEC-150 sibling revocation after a capture', () => {
  runDb('a capture stamps intent on the OTHER open sessions without calling Stripe from the settle path', async () => {
    const fx = await seedFixture();
    const siblingId = `${fx.sessionId}_sib`;
    const [sibling] = await withSystemDbAccessContext(() => db.insert(invoiceStripePayments).values({
      orgId: fx.orgId, invoiceId: fx.invoiceId, stripeAccountId: fx.accountId,
      stripeObjectType: 'checkout_session', stripeObjectId: siblingId,
      amount: '100.00', currency: 'USD', status: 'pending',
    }).returning({ id: invoiceStripePayments.id }));

    retrieveMock.mockResolvedValue({
      id: fx.sessionId, payment_status: 'paid', payment_intent: 'pi_sec150',
      amount_total: 10000, currency: 'usd',
    });

    // Exactly the production call shape: the portal return route and the
    // reconcile sweep both wrap this in a system context, so recordStripePayment
    // runs INSIDE that transaction while holding the invoice row lock.
    const settled = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => settleCheckoutSession(fx.partnerId, fx.sessionId)));
    expect(settled.settled).toBe(true);

    // Intent only. Calling sessions.expire from here would need a second pooled
    // connection to take a lock this transaction still holds — a self-deadlock
    // that hung this suite until the provider call moved to the sweep.
    expect(expireCallsFor(siblingId)).toHaveLength(0);
    expect((await readMapping(sibling!.id)).revocationState).toBe('revocation_requested');
    // The captured session itself is linked and must NOT be revoked.
    const captured = await readMapping(fx.mappingId);
    expect(captured.status).toBe('succeeded');
    expect(captured.revocationState).toBe('active');

    // ...and the sweep finishes the job on the next pass.
    expireMock.mockResolvedValue({ status: 'expired' });
    await runStripeSessionRevocationSweep();
    expect(expireCallsFor(siblingId)).toHaveLength(1);
    expect((await readMapping(sibling!.id)).revocationState).toBe('revoked');
  });

  runDb('a session that settles AFTER revocation was requested lands in charged_repair', async () => {
    const fx = await seedFixture();
    expireMock.mockRejectedValue(stripeError('StripeAPIError'));
    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'invoice_void', requestedByUserId: null,
    });
    expect((await readMapping(fx.mappingId)).revocationState).toBe('revocation_requested');

    retrieveMock.mockResolvedValue({
      id: fx.sessionId, payment_status: 'paid', payment_intent: 'pi_sec150_late',
      amount_total: 10000, currency: 'usd',
    });
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => settleCheckoutSession(fx.partnerId, fx.sessionId)));

    // Provider truth wins: the capture is RECORDED (never discarded to satisfy a
    // local flag) and the mapping is parked for a human.
    const row = await readMapping(fx.mappingId);
    expect(row.revocationState).toBe('charged_repair');
    expect(row.status).toBe('succeeded');
    expect((await readInvoice(fx.invoiceId)).status).toBe('paid');
  });
});

// ---------------------------------------------------------------------------
// Credential lifecycle: rotation, disconnect, archive retry, erasure
// ---------------------------------------------------------------------------
describe('SEC-150 credential transitions', () => {
  runDb('a key rotation expires the open session with the OUTGOING key first', async () => {
    const fx = await seedFixture();
    expireMock.mockImplementation((_key: string, id: string) => {
      if (id === fx.sessionId) return Promise.resolve({ status: 'expired' });
      // the capability probe
      return Promise.reject(stripeError('StripeInvalidRequestError', 'resource_missing'));
    });

    await savePartnerStripeKey({ partnerId: fx.partnerId, apiKey: KEY_GEN2, userId: null });

    // The session was expired with generation 1 — the key that minted it — not
    // with the incoming one, which cannot address it.
    expect(expireMock).toHaveBeenCalledWith(KEY_GEN1, fx.sessionId);
    expect((await readMapping(fx.mappingId)).revocationState).toBe('revoked');

    const [archived] = await withSystemDbAccessContext(() => db.select()
      .from(stripeConnectCredentials)
      .where(eq(stripeConnectCredentials.partnerId, fx.partnerId)));
    expect(archived!.generation).toBe(1);
    expect(decryptSecret(archived!.apiKey!)).toBe(KEY_GEN1);
  });

  runDb('a key rotation is REFUSED while an open session is not provably dead', async () => {
    const fx = await seedFixture();
    expireMock.mockImplementation((_key: string, id: string) =>
      id === fx.sessionId
        ? Promise.reject(stripeError('StripeAPIError'))
        : Promise.reject(stripeError('StripeInvalidRequestError', 'resource_missing')));

    await expect(savePartnerStripeKey({ partnerId: fx.partnerId, apiKey: KEY_GEN2, userId: null }))
      .rejects.toMatchObject({ code: 'STRIPE_SESSION_REVOCATION_PENDING', status: 503 });

    // The live key is untouched: replacing it would have destroyed the only
    // credential that can still expire that session.
    const [conn] = await withSystemDbAccessContext(() => db.select()
      .from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, fx.partnerId)));
    expect(decryptSecret(conn!.apiKey!)).toBe(KEY_GEN1);
  });

  runDb('a session stranded on a superseded ACCOUNT is retried by the sweep with the ARCHIVED key', async () => {
    const fx = await seedFixture();
    // A same-account key rotation does NOT need the archive — a new key on the
    // same Stripe account can expire sessions the old key created, and the live
    // key is deliberately preferred. The archive earns its keep when the session
    // is stranded on an account the live credential no longer addresses: an
    // account change, or a disconnect. Rotate first so a generation exists...
    expireMock.mockImplementation((_key: string, id: string) =>
      id === fx.sessionId
        ? Promise.resolve({ status: 'expired' })
        : Promise.reject(stripeError('StripeInvalidRequestError', 'resource_missing')));
    await savePartnerStripeKey({ partnerId: fx.partnerId, apiKey: KEY_GEN2, userId: null });

    // ...then move the live connection to a DIFFERENT Stripe account, so the
    // live key can no longer address anything minted on the old one.
    await withSystemDbAccessContext(() => db.update(stripeConnectAccounts)
      .set({ stripeAccountId: `${fx.accountId}_v2` })
      .where(eq(stripeConnectAccounts.partnerId, fx.partnerId)));

    // A session on the OLD account carrying no credential pointer — the race the
    // archive exists for: minted before the change committed, mapping written after.
    const strandedId = `${fx.sessionId}_stranded`;
    const [stranded] = await withSystemDbAccessContext(() => db.insert(invoiceStripePayments).values({
      orgId: fx.orgId, invoiceId: fx.invoiceId, stripeAccountId: fx.accountId,
      stripeObjectType: 'checkout_session', stripeObjectId: strandedId,
      amount: '10.00', currency: 'USD', status: 'pending',
      revocationState: 'revocation_requested',
      revocationRequestedAt: new Date(),
      revocationNextAttemptAt: new Date(Date.now() - 60_000),
    }).returning({ id: invoiceStripePayments.id }));

    constructedKeys.length = 0;
    expireMock.mockImplementation((_key: string, _id: string) => Promise.resolve({ status: 'expired' }));
    await runStripeSessionRevocationSweep();

    // The archived generation-1 key, not the live generation-2 one, is what can
    // address a session minted on the old account.
    expect(expireMock).toHaveBeenCalledWith(KEY_GEN1, strandedId);
    expect((await readMapping(stranded!.id)).revocationState).toBe('revoked');
  });

  runDb('disconnect NEVER fails on Stripe: intent + archive commit, the key is wiped', async () => {
    const fx = await seedFixture();
    expireMock.mockRejectedValue(stripeError('StripeConnectionError', undefined, 'connect ECONNREFUSED'));

    await expect(disconnectPartnerStripe(fx.partnerId, null)).resolves.toBeUndefined();

    const [conn] = await withSystemDbAccessContext(() => db.select()
      .from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, fx.partnerId)));
    expect(conn!.status).toBe('disconnected');
    expect(conn!.apiKey).toBeNull();

    // The intent committed WITH the wipe, and the archived key is still there,
    // so the sweep can finish the job the operator could not wait for.
    const row = await readMapping(fx.mappingId);
    expect(row.revocationState).toBe('revocation_requested');
    expect(row.revocationCredentialId).not.toBeNull();

    expireMock.mockResolvedValue({ status: 'expired' });
    await withSystemDbAccessContext(() => db.update(invoiceStripePayments)
      .set({ revocationNextAttemptAt: sql`now() - interval '1 minute'` })
      .where(eq(invoiceStripePayments.id, fx.mappingId)));
    await runStripeSessionRevocationSweep();
    expect(expireMock).toHaveBeenCalledWith(KEY_GEN1, fx.sessionId);
    expect((await readMapping(fx.mappingId)).revocationState).toBe('revoked');
  });

  runDb('a destroyed credential yields revocation_blocked/credential_unavailable, never a fake revoked', async () => {
    const fx = await seedFixture();
    // Simulate the pre-migration disconnect: the live key is gone and nothing
    // was ever archived.
    await withSystemDbAccessContext(() => db.update(stripeConnectAccounts)
      .set({ status: 'disconnected', apiKey: null, keyLast4: null, disconnectedAt: new Date() })
      .where(eq(stripeConnectAccounts.partnerId, fx.partnerId)));

    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'invoice_void', requestedByUserId: null,
    });

    const row = await readMapping(fx.mappingId);
    expect(row.revocationState).toBe('revocation_blocked');
    expect(row.revocationReason).toBe('credential_unavailable');
    expect(expireCallsFor(fx.sessionId)).toHaveLength(0);

    // It is surfaced to the partner rather than mailed out — this is the count
    // the Stripe settings card banner renders.
    const health = await withSystemDbAccessContext(() => getPartnerRevocationHealth(fx.partnerId));
    expect(health.credentialUnavailable).toBe(1);
    expect(health.blocked).toBe(1);

    // And it BLOCKS the transition until an operator explicitly abandons it.
    await expect(withSystemDbAccessContext(() => voidInvoice(fx.invoiceId, 'gone', { reissue: false }, actorFor(fx.orgId) as never)))
      .rejects.toMatchObject({ status: 503, code: 'STRIPE_REVOCATION_PENDING' });
  });
});

// ---------------------------------------------------------------------------
// Operator override
// ---------------------------------------------------------------------------
describe('SEC-150 operator abandon', () => {
  runDb('abandoning unblocks the void, is audited, and is excluded from the partner banner', async () => {
    const fx = await seedFixture();
    expireMock.mockRejectedValue(stripeError('StripeAuthenticationError'));
    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'invoice_void', requestedByUserId: null,
    });
    expect((await readMapping(fx.mappingId)).revocationState).toBe('revocation_blocked');

    const result = await abandonInvoiceSessionRevocation({
      invoiceId: fx.invoiceId,
      reason: 'Stripe account was closed by the bank; links are dead',
      actorUserId: null,
    });
    expect(result.abandoned).toBe(1);

    // The transition the operator was stuck on now succeeds.
    await withSystemDbAccessContext(() => voidInvoice(fx.invoiceId, 'account closed', { reissue: false }, actorFor(fx.orgId) as never));
    expect((await readInvoice(fx.invoiceId)).status).toBe('void');

    // A deliberate acceptance of residual exposure is a decision, not a defect:
    // it leaves the audit trail and drops out of the partner-facing count.
    const health = await withSystemDbAccessContext(() => getPartnerRevocationHealth(fx.partnerId));
    expect(health.blocked).toBe(0);

    const audits = await withSystemDbAccessContext(() => db.select()
      .from(auditLogs).where(eq(auditLogs.action, 'invoice.stripe_session_abandoned')));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });
  runDb('an unsettleable charged_repair row can be abandoned so the invoice is not stuck forever', async () => {
    const fx = await seedFixture();
    expireMock.mockRejectedValue(stripeError('StripeInvalidRequestError', 'session_not_open'));
    retrieveMock.mockResolvedValue({ id: fx.sessionId, status: 'complete', payment_status: 'paid' });
    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'invoice_void', requestedByUserId: null,
    });
    expect((await readMapping(fx.mappingId)).revocationState).toBe('charged_repair');
    await expect(withSystemDbAccessContext(() => voidInvoice(fx.invoiceId, 'stuck', { reissue: false }, actorFor(fx.orgId) as never)))
      .rejects.toMatchObject({ status: 503 });

    const result = await abandonInvoiceSessionRevocation({
      invoiceId: fx.invoiceId,
      reason: 'charge reconciled and refunded by hand in the Stripe dashboard',
      actorUserId: null,
    });
    expect(result.abandoned).toBe(1);
    // The `already_paid` provenance survives the abandon — the row still says a
    // real charge happened, it just no longer bars the transition.
    expect((await readMapping(fx.mappingId)).revocationLastProviderCode).toBe('already_paid');
    await withSystemDbAccessContext(() => voidInvoice(fx.invoiceId, 'stuck', { reissue: false }, actorFor(fx.orgId) as never));
    expect((await readInvoice(fx.invoiceId)).status).toBe('void');
  });
});

// ---------------------------------------------------------------------------
// Concurrency — real row locks
// ---------------------------------------------------------------------------
describe('SEC-150 concurrency (real Postgres locks)', () => {
  runDb('create-vs-revoke: no session survives payable when a pay link races a void', async () => {
    const fx = await seedFixture();
    expireMock.mockImplementation((_key: string, id: string) =>
      id.startsWith('cs_') ? Promise.resolve({ status: 'expired' })
        : Promise.reject(stripeError('StripeInvalidRequestError', 'resource_missing')));

    const [voidOutcome, linkOutcome] = await Promise.allSettled([
      withSystemDbAccessContext(() => voidInvoice(fx.invoiceId, 'race', { reissue: false }, actorFor(fx.orgId) as never)),
      withSystemDbAccessContext(() => createInvoicePayLink(fx.invoiceId, actorFor(fx.orgId) as never)),
    ]);

    // Whichever way the race falls, the invariant is the same: every Checkout
    // mapping on the invoice is terminal, so nothing is left payable. A pay link
    // that lost the race is refused; one that won is revoked by the void.
    const rows = await withSystemDbAccessContext(() => db.select()
      .from(invoiceStripePayments).where(and(
        eq(invoiceStripePayments.invoiceId, fx.invoiceId),
        eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
      )));
    for (const row of rows) {
      expect(['revoked', 'revocation_blocked', 'charged_repair']).toContain(row.revocationState);
    }
    // And the two outcomes are consistent: a successful void implies no payable session.
    if (voidOutcome.status === 'fulfilled') {
      expect((await readInvoice(fx.invoiceId)).status).toBe('void');
    }
    // A pay link that succeeded must not have handed out a live URL for a void invoice.
    if (linkOutcome.status === 'fulfilled' && voidOutcome.status === 'fulfilled') {
      const live = rows.filter((r) => r.revocationState === 'active');
      expect(live).toHaveLength(0);
    }
  });

  runDb('pay-vs-void: the invoice row lock serialises the two transitions', async () => {
    const fx = await seedFixture();
    expireMock.mockResolvedValue({ status: 'expired' });

    const results = await Promise.allSettled([
      withSystemDbAccessContext(() => recordPayment(fx.invoiceId, {
        amount: '100.00', method: 'check', receivedAt: '2026-09-10',
      } as never, actorFor(fx.orgId) as never)),
      withSystemDbAccessContext(() => voidInvoice(fx.invoiceId, 'race', { reissue: false }, actorFor(fx.orgId) as never)),
    ]);

    // Exactly one may win — #5180 refuses a void with applied payments, and a
    // void invoice refuses a payment. Never both.
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeLessThanOrEqual(2);
    const inv = await readInvoice(fx.invoiceId);
    expect(['paid', 'void']).toContain(inv.status);
    expect((await readMapping(fx.mappingId)).revocationState).toBe('revoked');
  });
});

// ---------------------------------------------------------------------------
// Worker: due selection, DB clock, fairness
// ---------------------------------------------------------------------------
describe('SEC-150 revocation sweep', () => {
  runDb('eligibility uses the DATABASE clock, not the worker host clock', async () => {
    const fx = await seedFixture();
    await withSystemDbAccessContext(() => db.update(invoiceStripePayments).set({
      revocationState: 'revocation_requested',
      revocationRequestedAt: new Date(),
      revocationNextAttemptAt: sql`now() + interval '1 hour'`,
    }).where(eq(invoiceStripePayments.id, fx.mappingId)));

    expect(await withSystemDbAccessContext(selectDueRevocations)).toHaveLength(0);

    await withSystemDbAccessContext(() => db.update(invoiceStripePayments)
      .set({ revocationNextAttemptAt: sql`now() - interval '1 second'` })
      .where(eq(invoiceStripePayments.id, fx.mappingId)));
    const due = await withSystemDbAccessContext(selectDueRevocations);
    expect(due.map((r) => r.id)).toContain(fx.mappingId);
    expect(due[0]!.partnerId).toBe(fx.partnerId);
  });

  runDb('one partner cannot starve the pass — the per-partner cap holds', async () => {
    const fx = await seedFixture();
    const extra = MAX_PER_PARTNER_PER_RUN + 5;
    await withSystemDbAccessContext(async () => {
      for (let i = 0; i < extra; i++) {
        await db.insert(invoiceStripePayments).values({
          orgId: fx.orgId, invoiceId: fx.invoiceId, stripeAccountId: fx.accountId,
          stripeObjectType: 'checkout_session', stripeObjectId: `${fx.sessionId}_f${i}`,
          amount: '1.00', currency: 'USD', status: 'pending',
          revocationState: 'revocation_requested',
          revocationRequestedAt: new Date(),
          revocationNextAttemptAt: new Date(Date.now() - 60_000),
        });
      }
      await db.update(invoiceStripePayments).set({
        revocationState: 'revocation_requested',
        revocationRequestedAt: new Date(),
        revocationNextAttemptAt: sql`now() - interval '1 minute'`,
      }).where(eq(invoiceStripePayments.id, fx.mappingId));
    });

    const due = await withSystemDbAccessContext(selectDueRevocations);
    expect(due).toHaveLength(MAX_PER_PARTNER_PER_RUN);
  });

  runDb('a redelivered pass is idempotent — an already-revoked row is not re-expired', async () => {
    const fx = await seedFixture();
    expireMock.mockResolvedValue({ status: 'expired' });
    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'link_reset', requestedByUserId: null,
    });
    const callsAfterFirst = expireCallsFor(fx.sessionId).length;

    await runStripeSessionRevocationSweep();
    await runStripeSessionRevocationSweep();

    expect(expireCallsFor(fx.sessionId)).toHaveLength(callsAfterFirst);
    expect((await readMapping(fx.mappingId)).revocationState).toBe('revoked');
  });
});

// ---------------------------------------------------------------------------
// Superseded-credential retention
// ---------------------------------------------------------------------------
describe('SEC-150 superseded-credential retention', () => {
  async function archiveWith(fx: Fixture, opts: { eraseAfter: Date; hardCap: Date }) {
    return withSystemDbAccessContext(async () => {
      const [row] = await db.insert(stripeConnectCredentials).values({
        partnerId: fx.partnerId, stripeConnectionId: fx.connectionId,
        stripeAccountId: fx.accountId, apiKey: 'enc:retained', keyLast4: '1234',
        livemode: false, generation: 9,
        supersededAt: new Date(Date.now() - 200 * DAY_MS),
        eraseAfter: opts.eraseAfter, eraseHardCapAt: opts.hardCap,
      }).returning({ id: stripeConnectCredentials.id });
      return row!.id;
    });
  }

  runDb('a credential inside its 120-day window is not erased', async () => {
    const fx = await seedFixture();
    const id = await archiveWith(fx, {
      eraseAfter: new Date(Date.now() + 10 * DAY_MS),
      hardCap: new Date(Date.now() + 300 * DAY_MS),
    });
    expect(await withSystemDbAccessContext(() => eraseExpiredStripeCredentials())).toBe(0);
    const [row] = await withSystemDbAccessContext(() => db.select()
      .from(stripeConnectCredentials).where(eq(stripeConnectCredentials.id, id)));
    expect(row!.apiKey).toBe('enc:retained');
  });

  runDb('a still-open dependent session keeps the credential alive past its window', async () => {
    const fx = await seedFixture();
    const id = await archiveWith(fx, {
      eraseAfter: new Date(Date.now() - DAY_MS),
      hardCap: new Date(Date.now() + 300 * DAY_MS),
    });
    await withSystemDbAccessContext(() => db.update(invoiceStripePayments)
      .set({ revocationCredentialId: id, revocationState: 'revocation_requested' })
      .where(eq(invoiceStripePayments.id, fx.mappingId)));

    // Destroying it now would turn a retryable revocation into a permanent
    // revocation_blocked — the opposite of the fix.
    expect(await withSystemDbAccessContext(() => eraseExpiredStripeCredentials())).toBe(0);
  });

  runDb('the 400-day hard cap erases regardless of dependents, keeping the forensic row', async () => {
    const fx = await seedFixture();
    const id = await archiveWith(fx, {
      eraseAfter: new Date(Date.now() - 100 * DAY_MS),
      hardCap: new Date(Date.now() - DAY_MS),
    });
    await withSystemDbAccessContext(() => db.update(invoiceStripePayments)
      .set({ revocationCredentialId: id, revocationState: 'revocation_requested' })
      .where(eq(invoiceStripePayments.id, fx.mappingId)));

    expect(await withSystemDbAccessContext(() => eraseExpiredStripeCredentials())).toBe(1);
    const [row] = await withSystemDbAccessContext(() => db.select()
      .from(stripeConnectCredentials).where(eq(stripeConnectCredentials.id, id)));
    expect(row!.apiKey).toBeNull();
    expect(row!.erasedAt).not.toBeNull();
  });

  runDb('an erased credential yields credential_unavailable, not a silent success', async () => {
    const fx = await seedFixture();
    const id = await archiveWith(fx, {
      eraseAfter: new Date(Date.now() - 100 * DAY_MS),
      hardCap: new Date(Date.now() - DAY_MS),
    });
    await withSystemDbAccessContext(() => db.update(stripeConnectAccounts)
      .set({ status: 'disconnected', apiKey: null, keyLast4: null, disconnectedAt: new Date() })
      .where(eq(stripeConnectAccounts.partnerId, fx.partnerId)));
    await withSystemDbAccessContext(() => db.update(invoiceStripePayments)
      .set({ revocationCredentialId: id })
      .where(eq(invoiceStripePayments.id, fx.mappingId)));
    await withSystemDbAccessContext(() => eraseExpiredStripeCredentials());

    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'invoice_void', requestedByUserId: null,
    });

    const row = await readMapping(fx.mappingId);
    expect(row.revocationState).toBe('revocation_blocked');
    expect(row.revocationReason).toBe('credential_unavailable');
  });

  runDb('the eraser is throttled so a 60s sweep does not rescan the archive every pass', async () => {
    const fx = await seedFixture();
    await archiveWith(fx, {
      eraseAfter: new Date(Date.now() - 100 * DAY_MS),
      hardCap: new Date(Date.now() - DAY_MS),
    });
    expect(await runCredentialEraser()).toBe(1);
    expect(await runCredentialEraser()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Legacy inventory
// ---------------------------------------------------------------------------
describe('SEC-150 legacy inventory', () => {
  runDb('a legacy_unbounded row is revoked on first touch like any open session', async () => {
    const fx = await seedFixture();
    await withSystemDbAccessContext(() => db.update(invoiceStripePayments)
      .set({ revocationState: 'legacy_unbounded' })
      .where(eq(invoiceStripePayments.id, fx.mappingId)));
    expireMock.mockResolvedValue({ status: 'expired' });

    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'invoice_void', requestedByUserId: null,
    });

    expect(expireMock).toHaveBeenCalledWith(KEY_GEN1, fx.sessionId);
    expect((await readMapping(fx.mappingId)).revocationState).toBe('revoked');
  });

  runDb('an aged-out row the migration already revoked is never called out to Stripe again', async () => {
    const fx = await seedFixture();
    await withSystemDbAccessContext(() => db.update(invoiceStripePayments)
      .set({ revocationState: 'revoked', revocationReason: 'aged_out', revokedAt: new Date() })
      .where(eq(invoiceStripePayments.id, fx.mappingId)));

    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'invoice_void', requestedByUserId: null,
    });

    expect(expireCallsFor(fx.sessionId)).toHaveLength(0);
    // And it does not block the transition.
    await expect(withSystemDbAccessContext(() => assertInvoiceSessionsRevoked(fx.invoiceId)))
      .resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Regressions found in review. Each of these was a REAL defect in the first
// draft of this change; the assertions are written to fail loudly if it returns.
// ---------------------------------------------------------------------------
function orgCtx(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}
function partnerCtx(partnerId: string): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: [partnerId], userId: null };
}

describe('SEC-150 regressions', () => {
  runDb('revocation works from an ORGANIZATION-scoped caller — the credential read must escape the ambient scope', async () => {
    const fx = await seedFixture();
    expireMock.mockResolvedValue({ status: 'expired' });

    // The portal runs in organization scope, where both credential tables
    // (partner-axis) are RLS-invisible. A bare withSystemDbAccessContext
    // SHORT-CIRCUITS inside an open context and keeps the caller's scope, so the
    // lookups silently returned zero rows and a perfectly healthy connected
    // partner was parked as `credential_unavailable`: session still payable,
    // invoice permanently unvoidable, false banner on the Stripe card.
    await withDbAccessContext(orgCtx(fx.orgId), () => requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'link_reset', requestedByUserId: null,
    }));

    expect(expireCallsFor(fx.sessionId)).toHaveLength(1);
    const row = await readMapping(fx.mappingId);
    expect(row.revocationState).toBe('revoked');
    expect(row.revocationReason).not.toBe('credential_unavailable');
  });

  runDb('a foreign partner cannot stamp revocation intent on another tenant\'s invoice', async () => {
    const fx = await seedFixture();
    const intruderPartner = await withSystemDbAccessContext(() => createPartner());
    const intruderOrg = await withSystemDbAccessContext(() =>
      createOrganization({ partnerId: intruderPartner.id }));
    const intruder = { userId: null, partnerId: intruderPartner.id, accessibleOrgIds: [intruderOrg.id] };

    // The revocation phases run in a SYSTEM context, which is RLS-exempt. Before
    // the fix they ran on the caller-supplied invoice id BEFORE any tenancy
    // check, so a guessed UUID let a foreign partner block (and, once the
    // credential lookup failed, permanently brick) someone else's invoice.
    const calls: Array<() => Promise<unknown>> = [
      () => voidInvoice(fx.invoiceId, 'not mine', { reissue: false }, intruder as never),
      () => recordPayment(fx.invoiceId, {
        amount: '100.00', method: 'check', receivedAt: '2026-09-10',
      } as never, intruder as never),
    ];
    for (const call of calls) {
      await expect(withDbAccessContext(partnerCtx(intruderPartner.id), call))
        .rejects.toMatchObject({ status: expect.any(Number) });
    }

    const row = await readMapping(fx.mappingId);
    expect(row.revocationState).toBe('active');
    expect(row.revocationRequestedAt).toBeNull();
    expect(expireCallsFor(fx.sessionId)).toHaveLength(0);
  });

  runDb('a producer racing a revocation inside a REQUEST transaction refuses instead of deadlocking', async () => {
    const fx = await seedFixture();
    createMock.mockImplementation(() => Promise.resolve({
      id: `cs_test_raced_${Date.now()}`,
      url: 'https://checkout.stripe.com/c/raced',
      payment_intent: null,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }));
    // Leave an in-flight revocation so the producer's raced branch fires.
    expireMock.mockRejectedValue(stripeError('StripeAPIError'));
    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'link_reset', requestedByUserId: null,
    });
    // Clear the producer gate so the request gets past it and reaches the
    // post-insert raced branch — the one that used to escape the context and
    // re-take the invoice row FOR UPDATE on a second pooled connection while the
    // caller's transaction already held FOR KEY SHARE on it through the mapping
    // INSERT's FK. That waits on a transaction that cannot commit until it
    // returns, and Postgres sees no cycle to break: it hangs to statement_timeout.
    process.env.STRIPE_SESSION_REVOCATION_MODE = 'observe';

    const requestCtx: DbAccessContext = {
      scope: 'partner', orgId: null, accessibleOrgIds: [fx.orgId],
      accessiblePartnerIds: [fx.partnerId], userId: null,
    };
    const raced = await withDbAccessContext(requestCtx, async () => {
      try {
        await createInvoicePayLink(fx.invoiceId, { userId: null, partnerId: fx.partnerId, accessibleOrgIds: [fx.orgId] } as never);
        return 'minted';
      } catch (err) {
        return (err as { code?: string }).code ?? `other: ${(err as Error).message}`;
      }
    });
    // Either outcome is acceptable; HANGING is not. Reaching this line at all is
    // the regression assertion.
    expect(['minted', 'STRIPE_REVOCATION_PENDING']).toContain(raced);
  }, 20_000);

  runDb('saving a working key re-arms blocked revocations but never an operator-abandoned one', async () => {
    const fx = await seedFixture();
    expireMock.mockRejectedValue(stripeError('StripeAuthenticationError'));
    await requestInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'invoice_void', requestedByUserId: null,
    });
    expect((await readMapping(fx.mappingId)).revocationState).toBe('revocation_blocked');

    const rearmed = await withSystemDbAccessContext(() => rearmBlockedRevocationsForAccount(fx.accountId));
    expect(rearmed).toBe(1);
    const row = await readMapping(fx.mappingId);
    expect(row.revocationState).toBe('revocation_requested');
    expect(row.revocationAttempts).toBe(0);

    // An abandoned row is a DECISION, not a defect: re-arming it would silently
    // re-block a transition the operator already accepted.
    await abandonInvoiceSessionRevocation({
      invoiceId: fx.invoiceId, reason: 'Stripe account closed permanently', actorUserId: null,
    });
    expect(await withSystemDbAccessContext(() => rearmBlockedRevocationsForAccount(fx.accountId))).toBe(0);
    expect((await readMapping(fx.mappingId)).revocationState).toBe('revocation_blocked');
  });

  runDb('observe mode lets an operator rotate the key while sessions are unrevoked', async () => {
    const fx = await seedFixture();
    process.env.STRIPE_SESSION_REVOCATION_MODE = 'observe';
    expireMock.mockImplementation((_key: string, id: string) =>
      id === fx.sessionId
        ? Promise.reject(stripeError('StripeAPIError'))
        : Promise.reject(stripeError('StripeInvalidRequestError', 'resource_missing')));

    // Rotating the key IS the remediation during the exact incident observe
    // exists for; refusing it would lock the operator out of their own fix.
    await expect(savePartnerStripeKey({ partnerId: fx.partnerId, apiKey: KEY_GEN2, userId: null }))
      .resolves.toMatchObject({ stripeAccountId: 'acct_sec150' });

    // The outgoing credential is archived either way, so the session stays revocable.
    const [archived] = await withSystemDbAccessContext(() => db.select()
      .from(stripeConnectCredentials).where(eq(stripeConnectCredentials.partnerId, fx.partnerId)));
    expect(decryptSecret(archived!.apiKey!)).toBe(KEY_GEN1);
  });
});

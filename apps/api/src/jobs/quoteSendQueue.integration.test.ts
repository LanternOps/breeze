/**
 * Real-Redis + real-Postgres integration coverage for the quote scheduled-send
 * queue (the 30s "Undo send" window, src/jobs/quoteSendQueue.ts).
 *
 * The mocked unit suite (quoteSendQueue.test.ts) stubs BOTH BullMQ and
 * drizzle, so it cannot prove the two things this design actually hangs on:
 *   1. Real BullMQ accepts the colon-free per-schedule jobId and the delayed
 *      job genuinely lands in / disappears from Redis on schedule, replace,
 *      and undo.
 *   2. The atomic `UPDATE ... WHERE send_job_id = <jobId>` claim against a
 *      real Postgres actually serializes worker-vs-undo-vs-reschedule — a
 *      chainable drizzle mock happily "claims" anything.
 *
 * ONLY the sendQuote pipeline boundary is mocked (it needs full quote/email/
 * PDF fixtures and SMTP). BullMQ runs against the real test Redis and every
 * DB statement runs against the real test Postgres.
 *
 * No BullMQ Worker is started: jobs are enqueued with a long delay so they
 * can never fire on their own, and the worker body (processQuoteSendJob) is
 * invoked directly with the exact payload a fire would deliver.
 *
 * Run (uses the shared integration rig — docker-compose.test.yml):
 *   docker compose -f docker-compose.test.yml up -d
 *   cd apps/api && pnpm vitest run --config vitest.integration.config.ts \
 *     src/jobs/quoteSendQueue.integration.test.ts
 *
 * If the shared :5433 rig's migration ledger is contaminated by another
 * worktree (checksum mismatch on boot), use private ephemeral containers
 * (same pattern as authEmailWorker.integration.test.ts):
 *   docker run -d --name breeze-pg-quotesend -e POSTGRES_USER=breeze_test \
 *     -e POSTGRES_PASSWORD=breeze_test -e POSTGRES_DB=breeze_test -p 55433:5432 \
 *     --tmpfs /var/lib/postgresql/data:rw,size=512m postgres:16-alpine
 *   docker run -d --name breeze-redis-quotesend -p 56381:6379 redis:7-alpine
 *   cd apps/api && \
 *   DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:55433/breeze_test \
 *   DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:55433/breeze_test \
 *   REDIS_URL=redis://localhost:56381 \
 *   pnpm vitest run --config vitest.integration.config.ts \
 *     src/jobs/quoteSendQueue.integration.test.ts
 */
import '../__tests__/integration/setup';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';

// Mock ONLY the send pipeline. Everything else in the module under test —
// the BullMQ Queue, the drizzle `db` proxy, the system DB context — is real.
vi.mock('../services/quoteLifecycle', () => ({
  sendQuote: vi.fn(),
}));

import {
  scheduleQuoteSend,
  cancelQuoteSend,
  processQuoteSendJob,
  type QuoteSendJobData,
} from './quoteSendQueue';
import { sendQuote } from '../services/quoteLifecycle';
import { getBullMQConnection, closeRedis } from '../services/redis';
import { withDbAccessContext, type DbAccessContext } from '../db';
import { quotes } from '../db/schema/quotes';
import type { QuoteActor } from '../services/quoteTypes';
import { createOrganization, createPartner } from '../__tests__/integration/db-utils';
import { getTestDb } from '../__tests__/integration/setup';

/** Long enough that a delayed job can never be promoted mid-test; the worker
 *  body is always invoked directly instead of waiting for BullMQ. */
const DELAY_MS = 60_000;

const sendQuoteMock = vi.mocked(sendQuote);

function okSendResult(overrides: Partial<Awaited<ReturnType<typeof sendQuote>>> = {}) {
  return {
    quote: {} as never,
    emailed: true,
    acceptUrl: 'https://portal.example.test/quote/test-token',
    ...overrides,
  } as Awaited<ReturnType<typeof sendQuote>>;
}

interface Fixture {
  partnerId: string;
  orgId: string;
  quoteId: string;
  actor: QuoteActor;
  /** Partner-admin style request context: quotes are ORG-axis RLS, so the
   *  accessible-org list must carry the org for breeze_app writes to pass. */
  ctx: DbAccessContext;
}

/** Seed partner → org → draft quote through the superuser test client
 *  (seeding bypasses RLS by design; code-under-test goes through `db`). */
async function seedDraftQuote(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const [quote] = await getTestDb()
    .insert(quotes)
    .values({ partnerId: partner.id, orgId: org.id, title: 'Undo-send integration quote' })
    .returning({ id: quotes.id });
  return {
    partnerId: partner.id,
    orgId: org.id,
    quoteId: quote!.id,
    actor: { userId: null, partnerId: partner.id, accessibleOrgIds: null },
    ctx: {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [org.id],
      accessiblePartnerIds: [partner.id],
      userId: null,
    },
  };
}

async function readQuoteRow(quoteId: string) {
  const [row] = await getTestDb()
    .select({
      status: quotes.status,
      sendScheduledAt: quotes.sendScheduledAt,
      sendJobId: quotes.sendJobId,
      sendEmailReason: quotes.sendEmailReason,
    })
    .from(quotes)
    .where(eq(quotes.id, quoteId));
  if (!row) throw new Error(`quote ${quoteId} not found`);
  return row;
}

/** Schedule through the request-style context and return the stamped jobId. */
async function schedule(fx: Fixture): Promise<{ jobId: string; sendScheduledAt: Date }> {
  const { sendScheduledAt } = await withDbAccessContext(fx.ctx, () =>
    scheduleQuoteSend(fx.quoteId, fx.actor, {}, DELAY_MS),
  );
  const row = await readQuoteRow(fx.quoteId);
  expect(row.sendJobId).toBeTruthy();
  return { jobId: row.sendJobId!, sendScheduledAt };
}

function firePayload(fx: Fixture, jobId: string): QuoteSendJobData {
  return { quoteId: fx.quoteId, jobId, actor: fx.actor, emailOpts: {} };
}

// Inspection handle onto the SAME queue the module enqueues into — this is
// the real-Redis visibility the unit suite's Queue mock cannot provide.
let inspectQueue: Queue;

describe('quoteSendQueue — real Redis + real Postgres', () => {
  beforeAll(() => {
    inspectQueue = new Queue('quote-send', { connection: getBullMQConnection() });
  });

  afterAll(async () => {
    await inspectQueue.close();
    // Quit the shared BullMQ/ioredis singletons so vitest can exit; the
    // module under test's Queue rides the same shared connection.
    await closeRedis();
  });

  beforeEach(() => {
    sendQuoteMock.mockReset();
  });

  it('schedule: real BullMQ accepts the colon-free per-schedule jobId as a delayed job', async () => {
    const fx = await seedDraftQuote();
    const { jobId, sendScheduledAt } = await schedule(fx);

    // The id scheme the repo's no-colon BullMQ rule forces.
    expect(jobId).toMatch(new RegExp(`^quote-send-${fx.quoteId}-[0-9a-f-]{36}$`));
    expect(jobId).not.toContain(':');

    // The check mocks can't do: the job genuinely exists in Redis, delayed,
    // carrying its own claim ticket in the payload.
    const job = await inspectQueue.getJob(jobId);
    expect(job).toBeTruthy();
    expect(job!.id).toBe(jobId);
    expect(job!.opts.delay).toBe(DELAY_MS);
    expect(await job!.getState()).toBe('delayed');
    expect(job!.data).toMatchObject({ quoteId: fx.quoteId, jobId });

    // Row stamped for the UI countdown.
    const row = await readQuoteRow(fx.quoteId);
    expect(row.sendScheduledAt?.getTime()).toBe(sendScheduledAt.getTime());
    expect(row.sendEmailReason).toBeNull();
  });

  it('schedule → cancel within the window: undo wins, columns clear, job leaves Redis, a late fire is inert', async () => {
    const fx = await seedDraftQuote();
    const { jobId } = await schedule(fx);

    const undone = await withDbAccessContext(fx.ctx, () => cancelQuoteSend(fx.quoteId));
    expect(undone).toBe(true);

    const row = await readQuoteRow(fx.quoteId);
    expect(row.status).toBe('draft');
    expect(row.sendScheduledAt).toBeNull();
    expect(row.sendJobId).toBeNull();

    // Best-effort Redis removal actually removed the delayed job.
    expect(await inspectQueue.getJob(jobId)).toBeUndefined();

    // Even if removal had failed, the claim makes the orphaned job a no-op:
    // simulate that fire and prove nothing sends and the row is untouched.
    await processQuoteSendJob(firePayload(fx, jobId));
    expect(sendQuoteMock).not.toHaveBeenCalled();
    const after = await readQuoteRow(fx.quoteId);
    expect(after.status).toBe('draft');
    expect(after.sendScheduledAt).toBeNull();
    expect(after.sendJobId).toBeNull();
    expect(after.sendEmailReason).toBeNull();
  });

  it('fire: the claim clears send_job_id and a successful emailed send stamps no reason', async () => {
    const fx = await seedDraftQuote();
    const { jobId } = await schedule(fx);
    sendQuoteMock.mockResolvedValue(okSendResult());

    await processQuoteSendJob(firePayload(fx, jobId));

    expect(sendQuoteMock).toHaveBeenCalledTimes(1);
    expect(sendQuoteMock).toHaveBeenCalledWith(fx.quoteId, fx.actor, {});
    const row = await readQuoteRow(fx.quoteId);
    // The claim took the registration. (The REAL sendQuote would also flip
    // draft→sent and clear send_scheduled_at; that pipeline is mocked here,
    // so only the queue module's own writes are asserted.)
    expect(row.sendJobId).toBeNull();
    expect(row.sendEmailReason).toBeNull();
  });

  it('fire: a send that commits but does not email persists the emailReason', async () => {
    const fx = await seedDraftQuote();
    const { jobId } = await schedule(fx);
    sendQuoteMock.mockResolvedValue(okSendResult({ emailed: false, emailReason: 'no_billing_contact' }));

    await processQuoteSendJob(firePayload(fx, jobId));

    const row = await readQuoteRow(fx.quoteId);
    expect(row.sendJobId).toBeNull();
    expect(row.sendEmailReason).toBe('no_billing_contact');
  });

  it('fire: a sendQuote rejection persists the schedule_failed marker despite the send txn rolling back', async () => {
    const fx = await seedDraftQuote();
    const { jobId } = await schedule(fx);
    sendQuoteMock.mockRejectedValue(new Error('contract variable cleared during the window'));

    await expect(processQuoteSendJob(firePayload(fx, jobId))).rejects.toThrow(
      'contract variable cleared during the window',
    );

    // Regression guard for the transaction-rollback bug this suite found:
    // withSystemDbAccessContext is ONE Postgres transaction, so an
    // in-transaction catch-and-stamp was rolled back by its own rethrow —
    // the failure marker never survived and the banner could never appear.
    // The fix persists the marker in a SECOND system context after the send
    // transaction has rolled back; these assertions fail if the stamp ever
    // moves back inside the rolled-back transaction.
    const row = await readQuoteRow(fx.quoteId);
    expect(row.status).toBe('draft');
    expect(row.sendScheduledAt).toBeNull();
    expect(row.sendJobId).toBeNull();
    expect(row.sendEmailReason).toBe('schedule_failed');
  });

  it('undo-after-claim race: cancel while sendQuote is in flight loses (returns false)', async () => {
    const fx = await seedDraftQuote();
    const { jobId } = await schedule(fx);

    // sendQuote dawdles on a plain timer. NOTE: no interlock with cancel here —
    // the worker's claim UPDATE holds the row lock for the whole in-flight send
    // (one withSystemDbAccessContext transaction), so cancel's conditional
    // UPDATE BLOCKS until that transaction commits; gating sendQuote on
    // cancel's completion would therefore deadlock. This mirrors production:
    // an undo racing a firing send simply waits out the row lock, then loses.
    let notifyEntered!: () => void;
    const entered = new Promise<void>((resolve) => { notifyEntered = resolve; });
    sendQuoteMock.mockImplementation(async () => {
      notifyEntered();
      await new Promise((resolve) => setTimeout(resolve, 400));
      return okSendResult();
    });

    const firing = processQuoteSendJob(firePayload(fx, jobId));
    await entered; // the worker has claimed the row and is inside sendQuote

    // Blocks on the claim transaction's row lock, then re-evaluates against
    // the committed claim (send_job_id now NULL) → 0 rows → false.
    const undone = await withDbAccessContext(fx.ctx, () => cancelQuoteSend(fx.quoteId));
    expect(undone).toBe(false); // claim already taken — genuinely too late

    await firing;
    expect(sendQuoteMock).toHaveBeenCalledTimes(1);
    const row = await readQuoteRow(fx.quoteId);
    expect(row.sendJobId).toBeNull(); // the worker's claim, not the undo's clear
  });

  it('reschedule replaces: the row carries the second jobId and the first job is gone/inert', async () => {
    const fx = await seedDraftQuote();
    const { jobId: firstJobId } = await schedule(fx);
    const { jobId: secondJobId } = await schedule(fx);

    expect(secondJobId).not.toBe(firstJobId);
    const row = await readQuoteRow(fx.quoteId);
    expect(row.sendJobId).toBe(secondJobId);

    // The replaced delayed job was removed from Redis; the new one is live.
    expect(await inspectQueue.getJob(firstJobId)).toBeUndefined();
    expect(await inspectQueue.getJob(secondJobId)).toBeTruthy();

    // Belt-and-braces: even a first job whose removal had failed no-ops —
    // its claim is stale, so it must neither send nor disturb the live schedule.
    await processQuoteSendJob(firePayload(fx, firstJobId));
    expect(sendQuoteMock).not.toHaveBeenCalled();
    const after = await readQuoteRow(fx.quoteId);
    expect(after.status).toBe('draft');
    expect(after.sendJobId).toBe(secondJobId);
    expect(after.sendScheduledAt).not.toBeNull();
  });
});

import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { quotes } from '../../db/schema/quotes';
import { createOrganization, createPartner } from './db-utils';
import { addManualLine, createQuote, reviseQuote } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import type { QuoteActor } from '../../services/quoteTypes';
import { getTestDb } from './setup';

/**
 * #3905 — the lock-release proof, against real Postgres.
 *
 * `sendQuote` used to render the PDF and run the outbound mail round-trip
 * INSIDE the request transaction. On a revision that transaction also holds a
 * `FOR UPDATE` lock on the PARENT quote (taken so the draft→sent claim and the
 * parent's flip to 'superseded' commit together). The parent's public accept
 * link is still live and in a customer's inbox at that moment — that is the
 * entire point of supersede-at-send — so a mail server that accepted the
 * connection and went silent blocked the customer's own `POST /accept` on the
 * original quote for as long as it liked, each blocked request pinning another
 * pooled connection (#1105).
 *
 * A unit test cannot show this: row locks are a Postgres property, and a
 * chainable drizzle mock has none. So this suite drives the real thing and
 * probes the parent row from a SECOND connection with `FOR UPDATE NOWAIT` at
 * the exact moment the email transport is called.
 *
 * The negative control is load-bearing: it proves the probe genuinely observes
 * a held lock, so a passing positive case means "released", not "the probe
 * never worked".
 *
 * Run (shared integration rig — docker-compose.test.yml):
 *   docker compose -f docker-compose.test.yml up -d
 *   cd apps/api && pnpm vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/quoteSendLockRelease.integration.test.ts
 */

const sendEmailMock = vi.fn(async () => {});

vi.mock('../../services/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/email')>();
  return {
    ...actual,
    getEmailService: () => ({
      sendEmail: sendEmailMock,
      fromWithDisplayName: (name: string) => `"${name}" <no-reply@test.example>`,
    }),
  };
});

const runDb = it.runIf(!!process.env.DATABASE_URL);

type ProbeResult = 'acquired' | 'locked';

/**
 * Try to take a row lock on `quoteId` from a connection that is NOT the one
 * under test. `NOWAIT` makes Postgres raise 55P03 (`lock_not_available`)
 * immediately rather than blocking, which is what turns "the customer's accept
 * would have to wait" into an assertable value.
 */
async function probeParentLock(quoteId: string): Promise<ProbeResult> {
  const testDb = getTestDb();
  try {
    await testDb.transaction(async (tx) => {
      await tx.execute(sql`select id from quotes where id = ${quoteId}::uuid for update nowait`);
    });
    return 'acquired';
  } catch (err) {
    const code = (err as { code?: string; cause?: { code?: string } })?.code
      ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === '55P03') return 'locked';
    throw err;
  }
}

interface Fixture {
  orgId: string;
  actor: QuoteActor;
  ctx: DbAccessContext;
}

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    return {
      orgId: org.id,
      actor: { userId: null, partnerId: partner.id, accessibleOrgIds: null },
      // Quotes use ORG-AXIS RLS, so the partner scope must carry the org.
      ctx: {
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: [org.id],
        accessiblePartnerIds: [partner.id],
        userId: null,
      },
    };
  });
}

async function createDraftWithVisibleLine(fx: Fixture) {
  const quote = await withDbAccessContext(fx.ctx, () =>
    createQuote({ orgId: fx.orgId, currencyCode: 'USD' }, fx.actor),
  );
  await withDbAccessContext(fx.ctx, () =>
    addManualLine(quote.id, {
      sourceType: 'manual',
      description: 'Managed services',
      quantity: 1,
      unitPrice: 100,
      taxable: false,
      customerVisible: true,
      recurrence: 'one_time',
      depositEligible: false,
    }, fx.actor),
  );
  return quote;
}

/** A sent parent with a draft revision pointing at it — the shape whose send
 *  takes the parent lock. */
async function seedRevisionOfSentParent(fx: Fixture) {
  const parent = await createDraftWithVisibleLine(fx);
  const sentParent = await withDbAccessContext(fx.ctx, () =>
    sendQuote(parent.id, fx.actor, { to: ['buyer@customer.example'] }),
  );
  await sentParent.deliverEmail();
  const revision = await withDbAccessContext(fx.ctx, () => reviseQuote(parent.id, fx.actor));
  return { parentId: parent.id, revisionId: revision.id };
}

describe('quote send releases the parent row lock before delivering the email (#3905)', () => {
  beforeEach(() => {
    sendEmailMock.mockReset();
    sendEmailMock.mockImplementation(async () => {});
  });

  // Without DATABASE_URL every runDb case below silently skips, and this suite
  // would report green while proving no Postgres invariant at all.
  it('requires DATABASE_URL so the real-Postgres proofs cannot silently skip', () => {
    expect(process.env.DATABASE_URL).toBeTruthy();
  });

  // NEGATIVE CONTROL. Without this, a positive result below could mean the
  // probe simply never detects a lock.
  runDb('control: the probe DOES observe the parent lock while a transaction holds it', async () => {
    const fx = await seedFixture();
    const { parentId } = await seedRevisionOfSentParent(fx);

    const observed = await withDbAccessContext(fx.ctx, async () => {
      await db.select({ id: quotes.id }).from(quotes).where(eq(quotes.id, parentId)).limit(1).for('update');
      return probeParentLock(parentId);
    });

    expect(observed).toBe('locked');
  });

  runDb('the parent is lockable by another connection while the revision email is being delivered', async () => {
    const fx = await seedFixture();
    const { parentId, revisionId } = await seedRevisionOfSentParent(fx);

    // Probe from INSIDE the transport call — the exact instant the old code
    // was still holding the parent lock and a pooled connection.
    // The fixture's own parent send already used the transport once.
    sendEmailMock.mockClear();
    let probedDuringSend: ProbeResult | undefined;
    sendEmailMock.mockImplementation(async () => {
      probedDuringSend = await probeParentLock(parentId);
    });

    const sent = await withDbAccessContext(fx.ctx, () =>
      sendQuote(revisionId, fx.actor, { to: ['buyer@customer.example'] }),
    );
    const delivery = await sent.deliverEmail();

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(delivery.emailed).toBe(true);
    expect(probedDuringSend).toBe('acquired');
  });

  runDb('the supersede still commits atomically with the send, before delivery runs', async () => {
    const fx = await seedFixture();
    const { parentId, revisionId } = await seedRevisionOfSentParent(fx);

    // Read the parent from a separate connection at transport time: it must
    // already be 'superseded', proving the state transition COMMITTED before
    // the email — not that the email was simply skipped.
    let parentStatusDuringSend: string | undefined;
    sendEmailMock.mockImplementation(async () => {
      const rows = await getTestDb().execute(
        sql`select status from quotes where id = ${parentId}::uuid`,
      );
      parentStatusDuringSend = (rows as unknown as Array<{ status: string }>)[0]?.status;
    });

    const sent = await withDbAccessContext(fx.ctx, () =>
      sendQuote(revisionId, fx.actor, { to: ['buyer@customer.example'] }),
    );
    expect(sent.superseded?.parentQuoteId).toBe(parentId);
    await sent.deliverEmail();

    expect(parentStatusDuringSend).toBe('superseded');
  });

  runDb('a delivery failure after commit still records send_email_reason for the banner', async () => {
    const fx = await seedFixture();
    const quote = await createDraftWithVisibleLine(fx);
    sendEmailMock.mockImplementation(async () => { throw new Error('smtp down'); });

    const sent = await withDbAccessContext(fx.ctx, () =>
      sendQuote(quote.id, fx.actor, { to: ['buyer@customer.example'] }),
    );
    const delivery = await sent.deliverEmail();

    expect(delivery.emailed).toBe(false);
    expect(delivery.emailReason).toBe('send_failed');

    // #3502 — the column is what raises the detail page's "no email was
    // delivered" banner, and it must survive the move out of the transaction.
    const row = await withSystemDbAccessContext(async () => {
      const [r] = await db.select().from(quotes).where(eq(quotes.id, quote.id)).limit(1);
      return r;
    });
    expect(row?.status).toBe('sent');
    expect(row?.sendEmailReason).toBe('send_failed');
  });
});

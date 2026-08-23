import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { quoteLines, quotes } from '../../db/schema/quotes';
import { createOrganization, createPartner } from './db-utils';
import {
  addManualLine,
  createQuote,
  deleteDraftQuote,
  reviseQuote,
  updateLine,
} from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import type { QuoteActor } from '../../services/quoteTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  partnerA: { id: string };
  orgA: { id: string };
  actorA: QuoteActor;
  ctxA: DbAccessContext;
}

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const actorA: QuoteActor = {
      userId: null,
      partnerId: partnerA.id,
      accessibleOrgIds: null,
    };
    // Quotes use ORG-AXIS RLS. A partner-only context does not grant quote
    // access, so the partner scope must explicitly carry the organization.
    const ctxA: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [orgA.id],
      accessiblePartnerIds: [partnerA.id],
      userId: null,
    };
    return { partnerA, orgA, actorA, ctxA };
  });
}

async function createDraftWithVisibleLine(fx: Fixture) {
  const quote = await withDbAccessContext(fx.ctxA, () =>
    createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA),
  );
  const line = await withDbAccessContext(fx.ctxA, () =>
    addManualLine(quote.id, {
      sourceType: 'manual',
      description: 'Managed services',
      quantity: 1,
      unitPrice: 100,
      taxable: false,
      customerVisible: true,
      recurrence: 'one_time',
      depositEligible: false,
    }, fx.actorA),
  );
  return { quote, line };
}

async function createSentQuote(fx: Fixture) {
  const seeded = await createDraftWithVisibleLine(fx);
  await withDbAccessContext(fx.ctxA, () => sendQuote(seeded.quote.id, fx.actorA));
  return seeded;
}

async function readQuote(id: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
    return row;
  });
}

async function readChildren(parentId: string) {
  return withSystemDbAccessContext(() =>
    db.select().from(quotes).where(eq(quotes.revisionOfQuoteId, parentId)),
  );
}

describe('quote revisions (breeze_app, real DB)', () => {
  // Without DATABASE_URL, every runDb test below silently skips and this suite
  // could report green while proving none of the Postgres invariants.
  it('requires DATABASE_URL so the real-Postgres proofs cannot silently skip', () => {
    expect(process.env.DATABASE_URL).toBeTruthy();
  });

  runDb('sending a revision retires its parent and preserves parent history', async () => {
    const fx = await seedFixture();
    const { quote: parent } = await createSentQuote(fx);
    const parentBefore = await readQuote(parent.id);
    expect(parentBefore).toMatchObject({
      status: 'sent',
      declinedAt: null,
      viewedAt: null,
      expiryDate: null,
      publicLinkRevokedAt: null,
    });

    const revision = await withDbAccessContext(fx.ctxA, () => reviseQuote(parent.id, fx.actorA));
    const [revisionLine] = await withSystemDbAccessContext(() =>
      db.select().from(quoteLines).where(eq(quoteLines.quoteId, revision.id)).limit(1),
    );
    expect(revisionLine).toBeDefined();
    await withDbAccessContext(fx.ctxA, () =>
      updateLine(revision.id, revisionLine!.id, { unitPrice: 125 }, fx.actorA),
    );
    await withDbAccessContext(fx.ctxA, () => sendQuote(revision.id, fx.actorA));

    const [parentAfter, childAfter, childLineAfter] = await withSystemDbAccessContext(async () => {
      const [storedParent] = await db.select().from(quotes).where(eq(quotes.id, parent.id)).limit(1);
      const [storedChild] = await db.select().from(quotes).where(eq(quotes.id, revision.id)).limit(1);
      const [storedLine] = await db.select().from(quoteLines).where(eq(quoteLines.id, revisionLine!.id)).limit(1);
      return [storedParent, storedChild, storedLine] as const;
    });

    expect(parentAfter).toBeDefined();
    expect(parentAfter!.status).toBe('superseded');
    expect(parentAfter!.publicLinkRevokedAt).not.toBeNull();
    expect(parentAfter!.declinedAt).toEqual(parentBefore!.declinedAt);
    expect(parentAfter!.viewedAt).toEqual(parentBefore!.viewedAt);
    expect(parentAfter!.expiryDate).toEqual(parentBefore!.expiryDate);
    expect(childAfter).toMatchObject({
      status: 'sent',
      revisionNumber: 2,
      revisionOfQuoteId: parent.id,
    });
    expect(childAfter!.quoteNumber).toMatch(/-R2$/);
    expect(childLineAfter!.unitPrice).toBe('125.00');
  });

  runDb('reviseQuote refuses an accepted parent and creates no child', async () => {
    const fx = await seedFixture();
    const { quote: parent } = await createSentQuote(fx);
    await withSystemDbAccessContext(() =>
      db.update(quotes).set({ status: 'accepted' }).where(eq(quotes.id, parent.id)),
    );

    await expect(
      withDbAccessContext(fx.ctxA, () => reviseQuote(parent.id, fx.actorA)),
    ).rejects.toMatchObject({ status: 409, code: 'PARENT_CONVERTED' });

    const [parentAfter, children] = await Promise.all([readQuote(parent.id), readChildren(parent.id)]);
    expect(parentAfter).toMatchObject({ status: 'accepted', publicLinkRevokedAt: null });
    expect(children).toHaveLength(0);
  });

  runDb('sendQuote refuses when the revision parent settles mid-draft', async () => {
    const fx = await seedFixture();
    const { quote: parent } = await createSentQuote(fx);
    const revision = await withDbAccessContext(fx.ctxA, () => reviseQuote(parent.id, fx.actorA));
    await withSystemDbAccessContext(() =>
      db.update(quotes).set({ status: 'accepted' }).where(eq(quotes.id, parent.id)),
    );

    await expect(
      withDbAccessContext(fx.ctxA, () => sendQuote(revision.id, fx.actorA)),
    ).rejects.toMatchObject({ status: 409, code: 'PARENT_CONVERTED' });

    const [parentAfter, childAfter] = await Promise.all([readQuote(parent.id), readQuote(revision.id)]);
    expect(parentAfter).toMatchObject({ status: 'accepted', publicLinkRevokedAt: null });
    expect(childAfter).toMatchObject({
      status: 'draft',
      sentAt: null,
      revisionOfQuoteId: parent.id,
      revisionNumber: 2,
    });
  });

  runDb('concurrent reviseQuote calls create exactly one successor', async () => {
    const fx = await seedFixture();
    const { quote: parent } = await createSentQuote(fx);

    const results = await Promise.allSettled([
      withDbAccessContext(fx.ctxA, () => reviseQuote(parent.id, fx.actorA)),
      withDbAccessContext(fx.ctxA, () => reviseQuote(parent.id, fx.actorA)),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const children = await readChildren(parent.id);
    const parentAfter = await readQuote(parent.id);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      status: 'draft',
      revisionOfQuoteId: parent.id,
      revisionNumber: 2,
    });
    expect(parentAfter).toMatchObject({ status: 'sent', publicLinkRevokedAt: null });
  });

  runDb('deleting a draft revision releases the unique-successor slot', async () => {
    const fx = await seedFixture();
    const { quote: parent } = await createSentQuote(fx);
    const first = await withDbAccessContext(fx.ctxA, () => reviseQuote(parent.id, fx.actorA));
    await withDbAccessContext(fx.ctxA, () => deleteDraftQuote(first.id, fx.actorA));
    expect(await readQuote(first.id)).toBeUndefined();
    expect(await readChildren(parent.id)).toHaveLength(0);

    const second = await withDbAccessContext(fx.ctxA, () => reviseQuote(parent.id, fx.actorA));
    const [children, parentAfter] = await Promise.all([readChildren(parent.id), readQuote(parent.id)]);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      id: second.id,
      status: 'draft',
      revisionOfQuoteId: parent.id,
      revisionNumber: 2,
    });
    expect(second.id).not.toBe(first.id);
    expect(parentAfter).toMatchObject({ status: 'sent', publicLinkRevokedAt: null });
  });

  runDb('database rejects a revision link paired with revision_number 1', async () => {
    const fx = await seedFixture();
    const { quote: parent } = await createSentQuote(fx);
    let error: unknown;
    try {
      await withSystemDbAccessContext(() => db.execute(sql`
        INSERT INTO quotes (
          partner_id, org_id, quote_number, status, currency_code,
          revision_of_quote_id, revision_number
        )
        SELECT
          partner_id, org_id, quote_number || '-BAD', 'draft', currency_code,
          id, 1
        FROM quotes
        WHERE id = ${parent.id}
      `));
    } catch (caught) {
      // Drizzle wraps the postgres.js driver error; the SQLSTATE and named
      // constraint live on the cause (matching sibling real-driver suites).
      error = (caught as { cause?: unknown }).cause ?? caught;
    }

    expect(error).toBeDefined();
    expect((error as { code?: string }).code).toBe('23514');
    const constraint = (error as { constraint_name?: string; constraint?: string }).constraint_name
      ?? (error as { constraint?: string }).constraint;
    if (constraint) expect(constraint).toContain('revision_number');
    expect(await readChildren(parent.id)).toHaveLength(0);
    expect(await readQuote(parent.id)).toMatchObject({
      status: 'sent',
      revisionOfQuoteId: null,
      revisionNumber: 1,
      publicLinkRevokedAt: null,
    });
  });

  runDb('database rejects a revision parent from a different organization', async () => {
    const fx = await seedFixture();
    const source = await withDbAccessContext(fx.ctxA, () =>
      createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA),
    );
    const tenantB = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      return { partner, org };
    });
    const actorB: QuoteActor = {
      userId: null,
      partnerId: tenantB.partner.id,
      accessibleOrgIds: null,
    };
    const ctxB: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [tenantB.org.id],
      accessiblePartnerIds: [tenantB.partner.id],
      userId: null,
    };
    const foreignParent = await withDbAccessContext(ctxB, () =>
      createQuote({ orgId: tenantB.org.id, currencyCode: 'USD' }, actorB),
    );

    let error: unknown;
    try {
      await withSystemDbAccessContext(() => db.execute(sql`
        UPDATE quotes
        SET revision_of_quote_id = ${foreignParent.id}, revision_number = 2
        WHERE id = ${source.id}
      `));
    } catch (caught) {
      error = (caught as { cause?: unknown }).cause ?? caught;
    }

    expect(error).toBeDefined();
    expect((error as { code?: string }).code).toBe('23503');
    expect(await readQuote(source.id)).toMatchObject({
      orgId: fx.orgA.id,
      status: 'draft',
      revisionOfQuoteId: null,
      revisionNumber: 1,
    });
    expect(await readQuote(foreignParent.id)).toMatchObject({
      orgId: tenantB.org.id,
      status: 'draft',
      revisionOfQuoteId: null,
      revisionNumber: 1,
    });
    expect(await readChildren(foreignParent.id)).toHaveLength(0);
  });

  // GDPR org erasure over a REVISION CHAIN. `quotes.revision_of_quote_id` is a
  // SELF-referencing FK, and the cascade deletes each table in ONE statement —
  // so a chain R1 <- R2 <- R3 is the shape that would trip
  // "update or delete on table quotes violates foreign key constraint" if the
  // FK were ever declared without ON DELETE handling. The generic cascade suite
  // seeds flat quotes and cannot catch this; nothing else in the repo builds a
  // lineage and then erases the tenant.
  // Org erasure over a REVISION CHAIN. `quotes.revision_of_quote_id` is a
  // SELF-referencing FK, and the tenant cascade deletes each table in ONE
  // statement — so a chain R1 <- R2 <- R3 is precisely the shape that raises
  // "update or delete on table quotes violates foreign key constraint" if that
  // FK is not self-resolving within a single DELETE. The generic cascade suite
  // seeds flat quotes and cannot catch it, and nothing else in the repo builds
  // a lineage and then deletes the tenant's rows.
  //
  // This asserts the FK property directly rather than driving cascadeDeleteOrg,
  // which additionally needs the breeze_audit_admin role for append-only audit
  // tables — an unrelated contract, and one no integration test currently
  // exercises end to end (see the PR notes).
  runDb('deletes a whole revision chain in one statement without tripping the self-FK', async () => {
    const fx = await seedFixture();

    // R1 sent -> revise -> R2 sent (R1 superseded) -> revise -> R3 sent (R2 superseded)
    const r1 = await createSentQuote(fx);
    const r2 = await withDbAccessContext(fx.ctxA, () => reviseQuote(r1.quote.id, fx.actorA));
    await withDbAccessContext(fx.ctxA, () => sendQuote(r2.id, fx.actorA));
    const r3 = await withDbAccessContext(fx.ctxA, () => reviseQuote(r2.id, fx.actorA));
    await withDbAccessContext(fx.ctxA, () => sendQuote(r3.id, fx.actorA));

    // Precondition: the chain really is three deep and self-linked, or the
    // delete below would prove nothing.
    expect(await readQuote(r1.quote.id)).toMatchObject({ status: 'superseded', revisionOfQuoteId: null });
    expect(await readQuote(r2.id)).toMatchObject({ status: 'superseded', revisionOfQuoteId: r1.quote.id });
    expect(await readQuote(r3.id)).toMatchObject({ status: 'sent', revisionOfQuoteId: r2.id });

    await withSystemDbAccessContext(async () => {
      // Children first, exactly as the cascade order does, then the single
      // org-wide quotes delete that must resolve the self-FK on its own.
      await db.execute(sql`DELETE FROM quote_lines WHERE org_id = ${fx.orgA.id}`);
      await db.execute(sql`DELETE FROM quote_blocks WHERE org_id = ${fx.orgA.id}`);
      await db.execute(sql`DELETE FROM quote_recipients WHERE org_id = ${fx.orgA.id}`);
      await db.execute(sql`DELETE FROM quotes WHERE org_id = ${fx.orgA.id}`);
    });

    const remaining = await withSystemDbAccessContext(() =>
      db.select({ id: quotes.id }).from(quotes).where(eq(quotes.orgId, fx.orgA.id)));
    expect(remaining).toHaveLength(0);
  });
});

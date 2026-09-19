/**
 * Sent-quote continuity across org merges (Task 6, org-lifecycle Wave 2).
 *
 * A quote's public accept token embeds the org it was SENT under. If that org
 * is later merged away (org-lifecycle merge engine, Task 3), the quote row
 * itself gets re-parented onto the survivor — but the token, already in a
 * prospect's inbox, still carries the loser's orgId. Without a fallback, the
 * public routes' `eq(quotes.orgId, claims.orgId)` filter would 404 a
 * perfectly valid, unexpired link the moment the org merges.
 *
 * `resolveMergedOrgIds` (services/orgMerge.ts) walks `org_merge_events`
 * forward from the token's orgId to build the set of orgIds a quote could
 * legitimately live under; the public routes match against that whole set
 * instead of the single claimed orgId. This file drives the real HTTP routes
 * (mirrors quotesPublicRoutes.integration.test.ts) to prove:
 *   1. a token minted for a since-merged org still resolves (GET 200).
 *   2. an unrelated org with NO merge event still fails closed (unchanged
 *      404 — the fallback must not broaden access on its own).
 *   3. a two-hop merge chain (A -> B -> C) still resolves.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import { quotes, orgMergeEvents } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { createQuoteAcceptToken } from '../../services/quoteAcceptToken';
import { quotesPublicRoutes } from '../../routes/quotesPublic';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function app() {
  const a = new Hono();
  a.route('/quotes/public', quotesPublicRoutes); // mirrors index.ts mount
  return a;
}

/** Record a durable "loser merged into survivor" event, exactly as the merge
 * worker would (system scope — the table's RLS forbids anything else from
 * cross-org inserting, and it blocks UPDATE outright, but INSERT is fine). */
async function seedMergeEvent(opts: { partnerId: string; loserOrgId: string; loserOrgName: string; survivorOrgId: string }) {
  await withSystemDbAccessContext(() =>
    db.insert(orgMergeEvents).values({
      partnerId: opts.partnerId,
      loserOrgId: opts.loserOrgId,
      loserOrgName: opts.loserOrgName,
      survivorOrgId: opts.survivorOrgId,
      summary: {},
    }),
  );
}

/** Seed a 'sent' quote directly under `orgId` (system scope, mirrors
 * quotesPublicRoutes.integration.test.ts's seedQuote — no token minted here,
 * callers mint their own so they can pick a DIFFERENT orgId for the token). */
async function seedQuoteUnderOrg(opts: { partnerId: string; orgId: string }) {
  return withSystemDbAccessContext(async () => {
    const [q] = await db.insert(quotes).values({
      partnerId: opts.partnerId, orgId: opts.orgId, currencyCode: 'USD',
      status: 'sent', quoteNumber: 'Q-2026-0001',
    }).returning({ id: quotes.id });
    return q!.id;
  });
}

describe('public quote routes — continuity across org merges', () => {
  runDb('a token minted for a since-merged (loser) org still resolves the quote now living under the survivor', async () => {
    const { partnerId, orgId: orgA } = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      return { partnerId: partner.id, orgId: orgA.id };
    });
    const orgB = await withSystemDbAccessContext(async () => (await createOrganization({ partnerId })).id);

    // The quote already lives under B — as if the merge (A -> B) already ran
    // and re-parented it — but the token was minted+sent back when it was
    // still under A.
    const quoteId = await seedQuoteUnderOrg({ partnerId, orgId: orgB });
    await seedMergeEvent({ partnerId, loserOrgId: orgA, loserOrgName: 'Org A (merged)', survivorOrgId: orgB });
    const { token } = await createQuoteAcceptToken({ quoteId, orgId: orgA, partnerId });

    const res = await app().request(`/quotes/public/${token}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { quote: { id: string } } };
    expect(body.data.quote.id).toBe(quoteId);
  });

  runDb('a token minted for an unrelated org with NO merge event still 404s (fallback does not broaden access)', async () => {
    const { partnerId, orgId: orgB } = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const orgB = await createOrganization({ partnerId: partner.id });
      return { partnerId: partner.id, orgId: orgB.id };
    });
    const orgC = await withSystemDbAccessContext(async () => (await createOrganization({ partnerId })).id);

    const quoteId = await seedQuoteUnderOrg({ partnerId, orgId: orgB });
    // No org_merge_events row links C to B.
    const { token } = await createQuoteAcceptToken({ quoteId, orgId: orgC, partnerId });

    const res = await app().request(`/quotes/public/${token}`);
    expect(res.status).toBe(404);
  });

  runDb('a two-hop merge chain (A -> B -> C) still resolves a token minted for the original org A', async () => {
    const { partnerId, orgId: orgA } = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      return { partnerId: partner.id, orgId: orgA.id };
    });
    const orgB = await withSystemDbAccessContext(async () => (await createOrganization({ partnerId })).id);
    const orgC = await withSystemDbAccessContext(async () => (await createOrganization({ partnerId })).id);

    const quoteId = await seedQuoteUnderOrg({ partnerId, orgId: orgC });
    await seedMergeEvent({ partnerId, loserOrgId: orgA, loserOrgName: 'Org A (merged)', survivorOrgId: orgB });
    await seedMergeEvent({ partnerId, loserOrgId: orgB, loserOrgName: 'Org B (merged)', survivorOrgId: orgC });
    const { token } = await createQuoteAcceptToken({ quoteId, orgId: orgA, partnerId });

    const res = await app().request(`/quotes/public/${token}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { quote: { id: string } } };
    expect(body.data.quote.id).toBe(quoteId);
  });
});

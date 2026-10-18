#!/usr/bin/env tsx
/**
 * Acceptance-hash verification (#8865 W1a, spec §8 rollout gate),
 * operator-invoked.
 *
 * Recomputes the content hash of the newest recorded quote acceptances from
 * the CURRENT quote rows (quoteAcceptanceVerify.verifyQuoteAcceptanceHash) and
 * compares it with the stored quote_acceptances.quote_sha256. Run it after
 * deploying a change to the contract-document freeze path: every stored
 * signature must still re-verify.
 *
 *   pnpm --filter @breeze/api acceptances:verify-hashes --limit 100
 *   docker exec breeze-api node dist/scripts/verify-acceptance-hashes.cjs --limit 100
 *
 * Flags: --limit N (default 50, max 5000), --org-id <uuid>,
 * --partner-id <uuid> (via quotes.partner_id), --since <ISO date> (signed_at >=).
 *
 * Read-only. Output is ids, hash versions and locales only — never signer
 * names, emails or quote content — so it is safe to paste into an issue.
 *
 * Exit codes:
 *   0  every checked acceptance re-verifies (or there was nothing to check).
 *   1  at least one acceptance's recomputed hash differs from the stored one.
 *   2  no mismatch, but at least one acceptance could not be recomputed
 *      (acceptance/quote gone, unsupported hash version, a read failure) — or
 *      the run itself failed (bad flags, database unreachable).
 */
import { and, desc, eq, gte, type SQL } from 'drizzle-orm';
import { closeDb, db, runOutsideDbContext, withSystemDbAccessContext } from '../src/db';
import { quoteAcceptances, quotes } from '../src/db/schema/quotes';
import { acceptanceRenderLocale, verifyQuoteAcceptanceHash } from '../src/services/quoteAcceptanceVerify';
import { parseVerifyArgs, summarize, type VerifyOutcome } from './verify-acceptance-hashes.lib';

const LOG = '[verify-acceptance-hashes]';

type Candidate = { id: string; quoteId: string; hashVersion: number; renderLocale: string | null };

async function selectCandidates(args: ReturnType<typeof parseVerifyArgs>): Promise<Candidate[]> {
  const conds: SQL[] = [];
  if (args.orgId) conds.push(eq(quoteAcceptances.orgId, args.orgId));
  if (args.partnerId) conds.push(eq(quotes.partnerId, args.partnerId));
  if (args.since) conds.push(gte(quoteAcceptances.signedAt, new Date(args.since)));
  return withSystemDbAccessContext(
    () =>
      db
        .select({
          id: quoteAcceptances.id,
          quoteId: quoteAcceptances.quoteId,
          hashVersion: quoteAcceptances.hashVersion,
          renderLocale: quoteAcceptances.renderLocale,
        })
        .from(quoteAcceptances)
        .innerJoin(quotes, eq(quotes.id, quoteAcceptances.quoteId))
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(desc(quoteAcceptances.signedAt), desc(quoteAcceptances.id))
        .limit(args.limit),
    'verifyAcceptanceHashes.select',
  );
}

async function verifyOne(c: Candidate): Promise<VerifyOutcome> {
  try {
    // Same wrapping as the accept route / documentLocaleBackfill test:
    // verifyQuoteAcceptanceHash reads the quote under the caller's context and
    // the pinned template versions through loadContractBlockRenderData's own
    // system context, so it must start outside any open transaction.
    const r = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => verifyQuoteAcceptanceHash(c.id), 'verifyAcceptanceHashes.verify'),
    );
    return { acceptanceId: r.acceptanceId, quoteId: r.quoteId, hashVersion: r.hashVersion, renderLocale: r.renderLocale, matches: r.matches };
  } catch (err) {
    return {
      acceptanceId: c.id,
      quoteId: c.quoteId,
      hashVersion: c.hashVersion,
      renderLocale: acceptanceRenderLocale(c),
      matches: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const args = parseVerifyArgs(process.argv.slice(2));
  const candidates = await selectCandidates(args);
  console.log(`${LOG} checking ${candidates.length} acceptance(s)`);

  const outcomes: VerifyOutcome[] = [];
  for (const c of candidates) {
    const o = await verifyOne(c);
    outcomes.push(o);
    if (o.error !== undefined) {
      console.error(`${LOG} ERROR acceptance=${o.acceptanceId} quote=${o.quoteId} v=${o.hashVersion} locale=${o.renderLocale}: ${o.error}`);
    } else if (!o.matches) {
      console.error(`${LOG} MISMATCH acceptance=${o.acceptanceId} quote=${o.quoteId} v=${o.hashVersion} locale=${o.renderLocale}`);
    }
  }

  const summary = summarize(outcomes);
  console.log(JSON.stringify(summary));
  process.exitCode = summary.exitCode;
}

main()
  .catch((error) => {
    console.error(`${LOG} Failed:`, error instanceof Error ? error.message : error);
    process.exitCode = 2;
  })
  .finally(async () => {
    await closeDb();
  });

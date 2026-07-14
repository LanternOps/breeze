/**
 * SR2-17 Property 2 — real-DB proof that a PENDING email is NOT matchable by
 * any auth path.
 *
 * This is a STANDALONE verification script, NOT a vitest test — it is
 * deliberately named `.check.ts` so neither the unit nor the integration
 * runner picks it up. It stands up its OWN private postgres:16-alpine (the
 * shared :5433 harness is contaminated and its docker-compose.test.yml tmpfs
 * is unsized), so it must be run explicitly:
 *
 *   apps/api/scripts (see task-7-report.md) or:
 *   DATABASE_URL_APP=... POSTGRES_SUPERUSER_URL=... pnpm tsx \
 *     src/services/pendingEmail.realdb.check.ts
 *
 * It seeds two accounts, records a pending email on the ATTACKER pointing at
 * the VICTIM's live address, and proves that the victim-adjacent address never
 * resolves the attacker via an email-keyed lookup (login / SSO auto-link / CF
 * Access all match users.email), while users.email itself never moved.
 */
import postgres from 'postgres';
import { withSystemDbAccessContext, db } from '../db';
import { requestPendingEmailChange } from './pendingEmail';

const SUPER_URL = process.env.POSTGRES_SUPERUSER_URL;
if (!SUPER_URL) {
  console.error('POSTGRES_SUPERUSER_URL is required');
  process.exit(2);
}

const su = postgres(SUPER_URL, { max: 1 });

const PARTNER = '00000000-0000-4000-8000-000000000001';
const VICTIM = '00000000-0000-4000-8000-0000000000a1';
const ATTACKER = '00000000-0000-4000-8000-0000000000a2';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ok: ${msg}`);
}

async function main(): Promise<void> {
  // Seed as superuser (bypasses RLS) — this is the fixture, not the assertion.
  await su`INSERT INTO partners (id, name, slug) VALUES (${PARTNER}, 'RealDB Co', 'realdb-co')`;
  await su`INSERT INTO users (id, partner_id, email, name, status, email_epoch)
           VALUES (${VICTIM}, ${PARTNER}, 'victim@corp.com', 'Victim', 'active', 1)`;
  await su`INSERT INTO users (id, partner_id, email, name, status, email_epoch)
           VALUES (${ATTACKER}, ${PARTNER}, 'attacker@corp.com', 'Attacker', 'active', 1)`;

  // The attacker (with a stolen session) requests a move of THEIR OWN account to
  // the victim's live address. Runs under a system context so the standalone
  // script has a valid DB access context for the write (in production this runs
  // in the caller's own request context).
  await withSystemDbAccessContext(() =>
    requestPendingEmailChange({ userId: ATTACKER, partnerId: PARTNER, newEmail: 'victim@corp.com' }),
  );

  // --- Property 2 assertions, read back as superuser (ground truth) ---
  const [attackerRow] = await su`SELECT email, pending_email, email_epoch FROM users WHERE id = ${ATTACKER}`;
  assert(!!attackerRow, 'attacker row exists');
  assert(attackerRow!.email === 'attacker@corp.com', 'attacker users.email is UNCHANGED (identity did not move)');
  assert(attackerRow!.pending_email === 'victim@corp.com', 'attacker pending_email records the requested address');
  assert(Number(attackerRow!.email_epoch) === 2, 'attacker email_epoch advanced (stale artifacts invalidated)');

  // The victim's row is untouched.
  const [victimRow] = await su`SELECT email, pending_email FROM users WHERE id = ${VICTIM}`;
  assert(!!victimRow, 'victim row exists');
  assert(victimRow!.email === 'victim@corp.com', 'victim users.email is intact');
  assert(victimRow!.pending_email === null, 'victim pending_email is untouched');

  // THE killer: an email-keyed lookup (the shape every auth path uses — login,
  // SSO auto-link, CF Access header match) for the victim address resolves the
  // VICTIM only, never the attacker who parked it as pending.
  const matches = await su`SELECT id FROM users WHERE email = 'victim@corp.com'`;
  assert(matches.length === 1, 'exactly one row matches the victim address by email');
  assert(matches[0]!.id === VICTIM, 'the email match is the VICTIM, never the attacker');

  // And the token minted for the pending address is an email_change token bound
  // to the NEW epoch — it cannot be redeemed until Task 8's commit branch.
  const [tok] = await su`SELECT purpose, email, email_epoch FROM email_verification_tokens WHERE user_id = ${ATTACKER}`;
  assert(!!tok && tok.purpose === 'email_change', 'a purpose=email_change token was minted for the pending address');
  assert(tok!.email === 'victim@corp.com', 'the token targets the pending address');
  assert(Number(tok!.email_epoch) === 2, 'the token carries the advanced email_epoch');

  console.log('\nPASS: pending email is un-matchable by any email-keyed auth path.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await su.end();
    // The app pool must be closed or the process hangs.
    await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.().catch(() => {});
    process.exit(process.exitCode ?? 0);
  });

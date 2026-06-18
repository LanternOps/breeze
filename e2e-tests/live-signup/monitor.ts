import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { parseRegions, type Region } from './regions';
import { makeIdentity, makeRunId } from './identity';
import { printReport, type PhaseResult, type RegionResult } from './report';
import { preflight } from './phases/preflight';
import { registerViaApi, type SignupResult } from './phases/apiSmoke';
import { registerViaUi } from './phases/uiFlow';
import { verifyEmail } from './phases/verifyEmail';
import { simulatePaymentAndAssertActivation } from './phases/simulatePayment';
import { purgePartner, sweepStaleCanaries } from './phases/cleanup';

loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=')[1];
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

async function timed(name: string, fn: () => Promise<void>): Promise<PhaseResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, ok: true, ms: Date.now() - start };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runRegion(region: Region, opts: {
  resendKey: string; syntheticToken: string; skipUi: boolean; skipVerify: boolean;
}): Promise<RegionResult> {
  const runId = makeRunId();
  const phases: PhaseResult[] = [];
  const created: SignupResult[] = [];
  let uiRecipient: string | null = null;

  phases.push(await timed('preflight', () => preflight(region)));
  if (!phases[0].ok) {
    return { region: region.key, phases, ok: false };
  }

  const idA = makeIdentity(runId, 'api');
  phases.push(await timed('apiSmoke', async () => {
    await registerViaApi(region, idA, (r) => created.push(r));
  }));

  let uiResult: SignupResult | null = null;
  if (!opts.skipUi) {
    const idB = makeIdentity(runId, 'ui');
    uiRecipient = idB.email;
    phases.push(await timed('uiFlow', async () => {
      uiResult = await registerViaUi(region, idB, (r) => created.push(r));
    }));

    if (uiResult !== null && !opts.skipVerify) {
      const capturedUiResult: SignupResult = uiResult;
      // verifyEmail MUST run before payment: partnerGuard only reconciles pending→active
      // when BOTH email_verified_at and payment_method_attached_at are set.
      phases.push(await timed('verifyEmail', () => verifyEmail(region, uiRecipient!, opts.resendKey)));
      phases.push(await timed('payment', () => simulatePaymentAndAssertActivation({
        region,
        partnerId: capturedUiResult.partnerId,
        accessToken: capturedUiResult.accessToken,
        syntheticToken: opts.syntheticToken,
      })));
    }
  }

  for (const c of created) {
    phases.push(await timed(`cleanup:${c.partnerId.slice(0, 8)}`, () =>
      purgePartner(region, c.partnerId, opts.syntheticToken)));
  }

  // Janitor sweep catches orphans from any run whose register response was lost
  // (id never captured, so the per-run cleanup above can't see them).
  phases.push(await timed('cleanup:stale-sweep', () =>
    sweepStaleCanaries(region, opts.syntheticToken)));

  return { region: region.key, phases, ok: phases.every((p) => p.ok) };
}

async function main(): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY;
  const syntheticToken = process.env.SYNTHETIC_TEST_TOKEN;
  if (!resendKey || !syntheticToken) {
    console.error('RESEND_API_KEY and SYNTHETIC_TEST_TOKEN must be set (see live-signup/.env.example)');
    process.exit(2);
  }

  const regions = parseRegions(arg('region'));
  const opts = { resendKey, syntheticToken, skipUi: hasFlag('skip-ui'), skipVerify: hasFlag('skip-verify') };

  const results: RegionResult[] = [];
  for (const region of regions) {
    results.push(await runRegion(region, opts));
  }

  printReport(results, hasFlag('json'));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

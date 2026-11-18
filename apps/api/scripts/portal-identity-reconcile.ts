#!/usr/bin/env tsx
/**
 * Portal registration W2 (identities release A): print the drift report
 * between `portal_user_identities` and `portal_users.entra_*`. Read-only —
 * it never repairs anything (repair arrives with the W3 read switch).
 *
 * Run once after each deploy of release A. It is not scheduled.
 *
 * Usage:
 *   pnpm --filter @breeze/api exec tsx scripts/portal-identity-reconcile.ts [--org <uuid>]
 *
 * Exit codes:
 *   0  clean (every count is 0)
 *   1  drift found (the JSON report on stdout names it), or a fatal error
 *   2  usage error
 */
import { closeDb } from '../src/db';
import { reconcilePortalUserIdentities } from '../src/services/portalUserIdentities';
import { ReconcileUsageError, parseReconcileArgs, reconcileExitCode } from './portal-identity-reconcile.lib';

const TAG = '[portal-identity-reconcile]';

async function main(): Promise<void> {
  const { orgId } = parseReconcileArgs(process.argv.slice(2));
  const report = await reconcilePortalUserIdentities({ orgId });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = reconcileExitCode(report);
}

main()
  .catch((err) => {
    if (err instanceof ReconcileUsageError) {
      console.error(`${TAG} ${err.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`${TAG} FAILED`);
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });

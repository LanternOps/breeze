/**
 * Two-replica reconcile harness (Task 8, issue #2619) — child entry point.
 *
 * Launched via `child_process.fork` from
 * `../twoReplicaReconcile.integration.test.ts` as a genuinely SEPARATE OS
 * process. This is the smallest faithful thing that drives the real
 * reconciler: no `index.ts` bootstrap, no HTTP server, no workers, no seeds —
 * just a direct `reconcileExtensions(...)` call, exactly mirroring the boot
 * call at `index.ts:1596-1602`.
 *
 * Why a real child process instead of a second in-process call: the
 * reconciler's DI only covers the bundle/verify/migration path. The `db`
 * pool (`../db`), the tenancy registry (`../tenancyRegistry`), and the
 * extracted-root map (`../faultAttribution`) are hardwired process-global
 * singletons with no constructor seam — two in-process calls would silently
 * share all three, which is precisely NOT what two replicas do. A forked
 * process gives genuinely separate globals, matching what actually differs
 * between real replicas.
 *
 * ENV CONTRACT: `DATABASE_URL`, `DATABASE_URL_APP`, `NODE_ENV`,
 * `JWT_SECRET`, and `BREEZE_EXTENSIONS_ARTIFACTS_DIR` MUST already be set on
 * this process's environment before this module's first import runs — the
 * parent test sets them via `fork(...)`'s `env` option (never via code in
 * this file), because `../db` opens its postgres pool at module-load time
 * (`db/index.ts:31`), before any line of `main()` below could run.
 *
 * OUTPUT CONTRACT: exactly one JSON object is written to stdout, followed by
 * a newline, as the LAST thing this process does before exiting. The parent
 * test scans stdout backwards for the last line that parses as JSON (postgres
 * NOTICE output and the reconciler's own `console.log` lines are not
 * suppressed, so other lines may precede it). Exit codes:
 *   0 — reconcileExtensions resolved (ok:true; inspect `failed` for optional
 *       extensions that were withdrawn).
 *   1 — reconcileExtensions rejected with RequiredExtensionError (a REQUIRED
 *       extension failed a phase) — the faithful analogue of aborted boot
 *       (production: `index.ts`'s `bootstrap().catch(() => process.exit(1))`).
 *   2 — reconcileExtensions rejected with anything else (a genuine harness or
 *       fixture bug, not a modeled failure-policy outcome).
 *   3 — this file's own argv contract was violated before reconcileExtensions
 *       was even called.
 */
import { Hono } from 'hono';
import { reconcileExtensions } from '../reconciler';
import { ExtensionContributionRegistry } from '../contributionRegistry';
import { createExtensionStateStore } from '../stateStore';
import { RequiredExtensionError } from '../errors';

interface ChildResult {
  ok: boolean;
  requiredAbort: boolean;
  activated?: string[];
  failed?: string[];
  skipped?: string[];
  extensionName?: string;
  phase?: string;
  error?: string;
}

/**
 * Write the result as the LAST stdout write, then exit only once the write
 * has actually flushed. `process.exit()` immediately after an async pipe
 * write can truncate it (a well-known Node gotcha for piped — not TTY —
 * stdout, which is exactly what `child_process.fork` gives the parent).
 */
function emit(result: ChildResult, exitCode: number): void {
  process.stdout.write(`${JSON.stringify(result)}\n`, () => {
    process.exit(exitCode);
  });
}

async function main(): Promise<void> {
  const [configPath, storeRoot] = process.argv.slice(2);
  if (!configPath || !storeRoot) {
    throw new Error('reconcileChild requires <configPath> <storeRoot> as argv[2]/argv[3]');
  }

  try {
    const summary = await reconcileExtensions({
      app: new Hono(),
      configPath,
      storeRoot,
      registry: new ExtensionContributionRegistry(),
      stateStore: createExtensionStateStore(),
      // No `ports` override: this must drive the REAL pipeline end to end.
    });
    emit(
      { ok: true, requiredAbort: false, activated: summary.activated, failed: summary.failed, skipped: summary.skipped },
      0,
    );
  } catch (error) {
    if (error instanceof RequiredExtensionError) {
      emit({ ok: false, requiredAbort: true, extensionName: error.extensionName, phase: error.phase }, 1);
      return;
    }
    emit({ ok: false, requiredAbort: false, error: String((error as Error)?.message ?? error) }, 2);
  }
}

main().catch((error) => {
  emit({ ok: false, requiredAbort: false, error: String((error as Error)?.message ?? error) }, 3);
});

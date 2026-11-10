/**
 * Pure helpers for scripts/portal-identity-reconcile.ts (argument parsing and
 * the exit code), split out so they are unit-tested without a database.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ReconcileUsageError extends Error {}

export function parseReconcileArgs(argv: readonly string[]): { orgId: string | undefined } {
  let orgId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--org') {
      const value = argv[i + 1];
      if (!value || !UUID_RE.test(value)) throw new ReconcileUsageError('--org needs an organization uuid');
      orgId = value;
      i++;
      continue;
    }
    throw new ReconcileUsageError(`unknown argument: ${arg}`);
  }
  return { orgId };
}

/** 0 when the report is clean, 1 when any bucket reports drift. */
export function reconcileExitCode(report: { counts: Record<string, number> }): 0 | 1 {
  return Object.values(report.counts).some((n) => n > 0) ? 1 : 0;
}

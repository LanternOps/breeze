export const MAX_BACKFILL_DAYS = 31;

export interface MetricRollupBackfillOptions {
  orgId: string;
  from: Date;
  to: Date;
  expectedSampleSeconds?: number;
  dryRun: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm metric-rollups:backfill -- --org-id <uuid> --from <iso> --to <iso> [--expected-sample-seconds 60] [--dry-run]',
    '',
    `The time range must be positive and no longer than ${MAX_BACKFILL_DAYS} days.`,
  ].join('\n');
}

function readOption(args: string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  const equalsValue = args.find((arg) => arg.startsWith(equalsPrefix));
  if (equalsValue) return equalsValue.slice(equalsPrefix.length);

  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function parseDateOption(value: string | undefined, name: string): Date {
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} is required\n\n${usage()}`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be a valid ISO timestamp`);
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseMetricRollupBackfillArgs(args: string[]): MetricRollupBackfillOptions {
  if (args.includes('--help') || args.includes('-h')) {
    throw new Error(usage());
  }

  const orgId = readOption(args, '--org-id');
  if (!orgId || orgId.startsWith('--')) {
    throw new Error(`--org-id is required\n\n${usage()}`);
  }

  const from = parseDateOption(readOption(args, '--from'), '--from');
  const to = parseDateOption(readOption(args, '--to'), '--to');
  if (from >= to) {
    throw new Error('--from must be before --to');
  }

  const rangeMs = to.getTime() - from.getTime();
  const maxRangeMs = MAX_BACKFILL_DAYS * 24 * 60 * 60 * 1000;
  if (rangeMs > maxRangeMs) {
    throw new Error(`Backfill range must be ${MAX_BACKFILL_DAYS} days or less`);
  }

  return {
    orgId,
    from,
    to,
    expectedSampleSeconds: parsePositiveInteger(readOption(args, '--expected-sample-seconds'), '--expected-sample-seconds'),
    dryRun: args.includes('--dry-run'),
  };
}

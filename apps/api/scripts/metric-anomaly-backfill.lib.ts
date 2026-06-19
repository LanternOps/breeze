export const MAX_ANOMALY_BACKFILL_DAYS = 31;

export interface MetricAnomalyBackfillOptions {
  orgId: string;
  from: Date;
  to: Date;
  dryRun: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm metric-anomalies:backfill -- --org-id <uuid> --from <iso> --to <iso> [--dry-run]',
    '',
    `The time range must be positive and no longer than ${MAX_ANOMALY_BACKFILL_DAYS} days.`,
    'Run metric-rollups:backfill for the same org/time range first if rollups are missing.',
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

export function parseMetricAnomalyBackfillArgs(args: string[]): MetricAnomalyBackfillOptions {
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
  const maxRangeMs = MAX_ANOMALY_BACKFILL_DAYS * 24 * 60 * 60 * 1000;
  if (rangeMs > maxRangeMs) {
    throw new Error(`Backfill range must be ${MAX_ANOMALY_BACKFILL_DAYS} days or less`);
  }

  return {
    orgId,
    from,
    to,
    dryRun: args.includes('--dry-run'),
  };
}

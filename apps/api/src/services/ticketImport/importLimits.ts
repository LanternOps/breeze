import { positiveIntEnv } from '../../config/env';

/**
 * The import worker's knobs (#8313 W4; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §5.8 env table). Read on use through the repo's knob parser: only a plain
 * positive integer counts, anything else falls back to the default, and every
 * value is clamped into its range. config/validate.ts reports an ignored value
 * once at boot. `TICKET_IMPORT_MAX_BYTES_PER_HOUR` (§4.5) lives with the
 * window limits (services/migrationWindowLimits.ts).
 */

const MIB = 1024 * 1024;

export const TICKET_IMPORT_LIMIT_DEFAULTS = {
  workerConcurrency: 3,
  globalConcurrency: 2,
  leaseMs: 60_000,
  sliceMs: 300_000,
  sourceConcurrency: 2,
  sourceTimeoutMs: 30_000,
  maxClockSkewMs: 300_000,
  maxIssuesPerRun: 50_000,
  maxTicketBytes: 256 * MIB,
} as const;

export type TicketImportLimits = {
  /** Slices one API process runs at once (BullMQ worker concurrency). */
  workerConcurrency: number;
  /** Slices holding the lease across every process; always below `workerConcurrency`. */
  globalConcurrency: number;
  /** One lease's lifetime; renewed every third of it. */
  leaseMs: number;
  /** Work one slice does before it persists and enqueues its successor. */
  sliceMs: number;
  /** Requests in flight to one source at once. */
  sourceConcurrency: number;
  /** One source request's timeout. */
  sourceTimeoutMs: number;
  /** How far in the future a source time may be and still be clamped to now. */
  maxClockSkewMs: number;
  /** Issue rows one run writes; counters stay exact beyond it. */
  maxIssuesPerRun: number;
  /** Converted content of one ticket, in UTF-8 bytes; above it the ticket fails `ticket_too_large`. */
  maxTicketBytes: number;
};

export function ticketImportLimits(): TicketImportLimits {
  const d = TICKET_IMPORT_LIMIT_DEFAULTS;
  const workerConcurrency = positiveIntEnv('TICKET_IMPORT_WORKER_CONCURRENCY', d.workerConcurrency, 1, 32);
  // The global cap stays below the worker's concurrency (spec §5.8), so a
  // worker slot is always free to defer a refused slice instead of blocking
  // behind a holder. With one worker slot the cap is 1: the slot that is
  // refused is the one that defers.
  const requestedGlobal = positiveIntEnv('TICKET_IMPORT_GLOBAL_CONCURRENCY', d.globalConcurrency, 1, 32);
  const globalConcurrency = Math.max(1, Math.min(requestedGlobal, workerConcurrency - 1));
  return {
    workerConcurrency,
    globalConcurrency,
    leaseMs: positiveIntEnv('TICKET_IMPORT_LEASE_MS', d.leaseMs, 5_000, 600_000),
    sliceMs: positiveIntEnv('TICKET_IMPORT_SLICE_MS', d.sliceMs, 5_000, 3_600_000),
    sourceConcurrency: positiveIntEnv('TICKET_IMPORT_SOURCE_CONCURRENCY', d.sourceConcurrency, 1, 16),
    sourceTimeoutMs: positiveIntEnv('TICKET_IMPORT_SOURCE_TIMEOUT_MS', d.sourceTimeoutMs, 1_000, 300_000),
    maxClockSkewMs: positiveIntEnv('TICKET_IMPORT_MAX_CLOCK_SKEW_MS', d.maxClockSkewMs, 1, 86_400_000),
    maxIssuesPerRun: positiveIntEnv('TICKET_IMPORT_MAX_ISSUES_PER_RUN', d.maxIssuesPerRun, 1, 1_000_000),
    maxTicketBytes: positiveIntEnv('TICKET_IMPORT_MAX_TICKET_BYTES', d.maxTicketBytes, MIB, 2048 * MIB),
  };
}

/** The env names, for the boot report (config/validate.ts). */
export const TICKET_IMPORT_LIMIT_ENV_VARS = [
  'TICKET_IMPORT_WORKER_CONCURRENCY',
  'TICKET_IMPORT_GLOBAL_CONCURRENCY',
  'TICKET_IMPORT_LEASE_MS',
  'TICKET_IMPORT_SLICE_MS',
  'TICKET_IMPORT_SOURCE_CONCURRENCY',
  'TICKET_IMPORT_SOURCE_TIMEOUT_MS',
  'TICKET_IMPORT_MAX_CLOCK_SKEW_MS',
  'TICKET_IMPORT_MAX_ISSUES_PER_RUN',
  'TICKET_IMPORT_MAX_TICKET_BYTES',
] as const;

import { z } from 'zod';

// #5876 reliability baseline markers — pure policy (no db import; shared by the
// scorer, the baseline service and the routes without import cycles).
export const RELIABILITY_BASELINE_REASONS = ['reimaged', 'remediated', 'hardware_replaced'] as const;
export type ReliabilityBaselineReason = (typeof RELIABILITY_BASELINE_REASONS)[number];
export const RELIABILITY_BASELINE_SOURCES = ['manual', 'bare_metal_recovery'] as const;
export type ReliabilityBaselineSource = (typeof RELIABILITY_BASELINE_SOURCES)[number];

export const BASELINE_MAX_BACKDATE_DAYS = 30;
export const BASELINE_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const BASELINE_PROVISIONAL_REPORTED_DAYS = 14;
export const BASELINE_NOTE_MAX_LENGTH = 2000;
/** Bump whenever the scoring math changes so frozen before-snapshots stay interpretable. */
export const RELIABILITY_SCORER_VERSION = '2026-10-09.1';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ActiveReliabilityBaseline {
  id: string;
  baselineAt: Date;
  reason: ReliabilityBaselineReason;
  source: ReliabilityBaselineSource;
}

/** Persisted on device_reliability.details.baseline by the scorer. */
export interface ReliabilityBaselineDetails {
  id: string;
  baselineAt: string;
  reason: ReliabilityBaselineReason;
  source: ReliabilityBaselineSource;
  reportedDaysSinceBaseline: number;
  provisional: boolean;
}

export type ResolveBaselineAtResult =
  | { ok: true; baselineAt: Date }
  | { ok: false; error: 'baseline_in_future' | 'baseline_too_old' };

/** Server-side marker time: default now, ≤30d back, ≤5min skew forward (clamped to now). */
export function resolveBaselineAt(requested: Date | undefined, now: Date): ResolveBaselineAtResult {
  if (!requested) return { ok: true, baselineAt: now };
  const ms = requested.getTime();
  if (ms > now.getTime() + BASELINE_FUTURE_SKEW_MS) return { ok: false, error: 'baseline_in_future' };
  if (ms < now.getTime() - BASELINE_MAX_BACKDATE_DAYS * DAY_MS) return { ok: false, error: 'baseline_too_old' };
  return { ok: true, baselineAt: new Date(Math.min(ms, now.getTime())) };
}

export function isNoteRequired(reason: ReliabilityBaselineReason, source: ReliabilityBaselineSource): boolean {
  return reason === 'remediated' && source === 'manual';
}

const baselineDetailsSchema = z.object({
  id: z.string().min(1),
  baselineAt: z.string().datetime(),
  reason: z.enum(RELIABILITY_BASELINE_REASONS),
  source: z.enum(RELIABILITY_BASELINE_SOURCES),
  reportedDaysSinceBaseline: z.number().int().min(0),
  provisional: z.boolean(),
});

export function readBaselineDetails(details: unknown): ReliabilityBaselineDetails | null {
  if (!details || typeof details !== 'object') return null;
  const parsed = baselineDetailsSchema.safeParse((details as Record<string, unknown>).baseline);
  return parsed.success ? parsed.data : null;
}

const factorScore = z.object({ score: z.number() });
export const reliabilityBeforeSnapshotSchema = z.object({
  version: z.literal(1),
  scorerVersion: z.string(),
  asOf: z.string().datetime(),
  coverageDays: z.number().int().min(0).max(90),
  reliabilityScore: z.number(),
  weightProfile: z.enum(['workstation', 'infra']),
  factors: z.object({
    uptime: factorScore, crashes: factorScore, hangs: factorScore, serviceFailures: factorScore, hardwareErrors: factorScore,
  }),
  counts30d: z.object({
    crashes: z.number().int(), hangs: z.number().int(), serviceFailures: z.number().int(), hardwareErrors: z.number().int(),
  }),
});
export type ReliabilityBeforeSnapshot = z.infer<typeof reliabilityBeforeSnapshotSchema>;

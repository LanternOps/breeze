/**
 * Limits of ticket migration windows (#8313; spec
 * docs/superpowers/specs/api-platform/2026-10-10-ticket-migration-windows-design.md
 * §3.1–§3.2). Pure: env reads and constants only, so the step-up schema and
 * the window service share one definition.
 *
 * The span cap and the throughput ceiling live here rather than in a CHECK so
 * they can change through env without a migration. The table keeps only the
 * absolute bounds (writes_per_hour BETWEEN 600 AND 100000, ends_at > opened_at).
 */

/** The floor: one import transaction costs at most 102 units (spec §4.6), so every one fits an hour. */
export const MIGRATION_WINDOW_MIN_WRITES_PER_HOUR = 600;
/** The table's CHECK; an env ceiling above it is clamped. */
const MIGRATION_WINDOW_ABSOLUTE_MAX_WRITES_PER_HOUR = 100_000;
/** The most organizations one window may name. */
export const MIGRATION_WINDOW_MAX_ORGS = 500;
/** source_label is varchar(64). */
export const MIGRATION_WINDOW_SOURCE_LABEL_MAX = 64;

const DEFAULT_MAX_DAYS = 14;
const DEFAULT_WRITES_PER_HOUR = 6000;
const DEFAULT_MAX_WRITES_PER_HOUR = 20_000;

function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type MigrationWindowLimits = {
  maxDays: number;
  defaultWritesPerHour: number;
  maxWritesPerHour: number;
};

/**
 * The effective limits. The ceiling is clamped into [600, 100000], and the
 * default into [600, ceiling], so a misconfigured env can never produce a
 * window the table refuses.
 */
export function migrationWindowLimits(): MigrationWindowLimits {
  const maxDays = positiveEnvInt('MIGRATION_WINDOW_MAX_DAYS', DEFAULT_MAX_DAYS);
  const maxWritesPerHour = Math.min(
    MIGRATION_WINDOW_ABSOLUTE_MAX_WRITES_PER_HOUR,
    Math.max(
      MIGRATION_WINDOW_MIN_WRITES_PER_HOUR,
      positiveEnvInt('MIGRATION_WINDOW_MAX_WRITES_PER_HOUR', DEFAULT_MAX_WRITES_PER_HOUR),
    ),
  );
  const defaultWritesPerHour = Math.min(
    maxWritesPerHour,
    Math.max(
      MIGRATION_WINDOW_MIN_WRITES_PER_HOUR,
      positiveEnvInt('MIGRATION_WINDOW_DEFAULT_WRITES_PER_HOUR', DEFAULT_WRITES_PER_HOUR),
    ),
  );
  return { maxDays, defaultWritesPerHour, maxWritesPerHour };
}

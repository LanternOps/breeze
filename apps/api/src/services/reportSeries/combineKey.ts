/**
 * Multi-org report series W04 (Combine) — what "near-identical" means.
 *
 * Two org-owned definitions are combinable when they would produce the same
 * artifact for their own org at the same moments: same `type`, `format`,
 * `schedule` and NORMALIZED config (spec §3.8). This module is the only
 * definition of that normalization; the candidate list and the combine
 * transaction both key rows through it, so the key a dialog showed is the key
 * the server re-derives under lock.
 *
 * Pure. `reportRegistry` value-imports zod schemas only (see its header), so
 * no db module enters this graph.
 */
import { createHash } from 'node:crypto';
import { normalizeScheduleConfig, type ReportType, type ScheduleConfig } from '@breeze/shared';
import { reportTypeDef } from '../reportRegistry';

export type CombineCadence = 'daily' | 'weekly' | 'monthly';
export type CombineFormat = 'csv' | 'pdf' | 'excel';

/** Bump whenever the normalization changes meaning: a dialog opened against the
 *  old key then gets 409 combine_group_changed instead of combining a
 *  different set of rows than it showed. */
export const COMBINE_KEY_VERSION = 1;

/**
 * Config keys that are NOT part of the key:
 *  - `emailRecipients` — delivery; the shared ones become the series internal
 *    CC and the rest must be resolved by the user (spec §3.8).
 *  - `saveTemplate`, `templateName` — the builder's save-as-template toggle;
 *    they change nothing about the artifact.
 *  - `type` — never a config field (`parseStoredReportConfig` drops it); a
 *    legacy row still carrying one must not split a group.
 * The report `name` is a column, never config, so it is never in the key.
 */
export const COMBINE_IGNORED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'emailRecipients',
  'saveTemplate',
  'templateName',
  'type',
]);

/** Arrays whose order IS output order (the builder's column order). Every other
 *  array of primitives is a set (os types, severities, statuses, countries). */
const ORDERED_ARRAY_PATHS: ReadonlySet<string> = new Set(['columns']);

/** Arrays whose object elements carry a client-generated React key `id`
 *  (ReportBuilder's `buildFilterId()`): two identical filters saved separately
 *  never share it. Element ORDER is kept — the and/or chain reads in order. */
const CLIENT_ID_ARRAY_PATHS: ReadonlySet<string> = new Set(['filterConditions']);

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Stable canonical form: object keys sorted (code-unit order); `null` and
 * `undefined` absent; arrays of primitives de-duplicated and sorted by their
 * JSON text unless listed in ORDERED_ARRAY_PATHS; object elements of
 * CLIENT_ID_ARRAY_PATHS lose `id`. `path` is the dotted key path from the
 * config root (`filters.osTypes`), `[]` marking array elements.
 */
export function canonicalize(value: unknown, path = ''): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => {
        if (CLIENT_ID_ARRAY_PATHS.has(path) && item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const { id: _clientKey, ...rest } = item as Record<string, unknown>;
          return canonicalize(rest, `${path}[]`);
        }
        return canonicalize(item, `${path}[]`);
      })
      .filter((item) => item !== undefined);
    if (!ORDERED_ARRAY_PATHS.has(path) && items.every(isPrimitive)) {
      return [...new Set(items.map((item) => JSON.stringify(item)))]
        .sort()
        .map((text) => JSON.parse(text) as unknown);
    }
    return items;
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = canonicalize(source[key], path ? `${path}.${key}` : key);
      if (child !== undefined) out[key] = child;
    }
    return out;
  }
  return value;
}

export interface NormalizedCombineConfig {
  canonical: Record<string, unknown>;
  /** Trimmed, lower-cased, de-duplicated, sorted. */
  emailRecipients: string[];
}

/**
 * Parse `config` with its TYPE's own schema (defaults applied, so an explicit
 * default equals an omitted one), drop the ignored keys, replace `schedule`
 * with its canonical cadence form, canonicalize. `null` when the stored config
 * no longer passes its type's schema — such a row is not combinable.
 */
export function normalizeCombineConfig(
  type: ReportType,
  cadence: CombineCadence,
  config: unknown,
): NormalizedCombineConfig | null {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return null;
  const parsed = reportTypeDef(type).configSchema.safeParse(config);
  if (!parsed.success) return null;
  const withDefaults = parsed.data;

  const keyed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(withDefaults)) {
    if (!COMBINE_IGNORED_CONFIG_KEYS.has(key) && key !== 'schedule') keyed[key] = value;
  }
  const rawSchedule = withDefaults.schedule;
  keyed.schedule = normalizeScheduleConfig(
    cadence,
    rawSchedule !== null && typeof rawSchedule === 'object' ? (rawSchedule as ScheduleConfig) : {},
  );

  const recipients = Array.isArray(withDefaults.emailRecipients)
    ? withDefaults.emailRecipients.filter((r): r is string => typeof r === 'string')
    : [];
  return {
    canonical: canonicalize(keyed) as Record<string, unknown>,
    emailRecipients: [...new Set(recipients.map(normalizeEmail))].filter((r) => r.length > 0).sort(),
  };
}

export function combineGroupKey(parts: {
  type: ReportType;
  format: CombineFormat;
  schedule: CombineCadence;
  canonicalConfig: Record<string, unknown>;
}): string {
  const text = JSON.stringify({
    v: COMBINE_KEY_VERSION,
    type: parts.type,
    format: parts.format,
    schedule: parts.schedule,
    config: parts.canonicalConfig,
  });
  return createHash('sha256').update(text).digest('hex');
}

/** The series definition's `config`: a stored row config (NOT canonical, no
 *  defaults injected — mirrors `parseStoredReportConfig`'s "keys the caller
 *  sent" rule) minus the ignored keys. The internal CC travels in
 *  `report_series.internal_cc`, never in config. */
export function seriesConfigFrom(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !COMBINE_IGNORED_CONFIG_KEYS.has(key)));
}

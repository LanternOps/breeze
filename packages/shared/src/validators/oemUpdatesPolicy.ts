import { z } from 'zod';
import { OEM_CATEGORIES, OEM_LANES, type OemCategory, type OemLane } from '../utils/oemUpdates';

/**
 * Inline settings for the `oem_updates` config-policy feature (Vendor updates,
 * #11065, spec 4.1). Pattern B: the settings live on the feature link and
 * `featurePolicyId` stays NULL.
 *
 * Strict at every depth: an unknown key is a hard error, never a value stored
 * and ignored. An absent vendor or category means off, so a release that ships a
 * lane or opens a category gate turns nothing on by itself.
 */

const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/;

// Every key optional: an absent category is off. `false` is an explicit off.
const categoriesSchema = z.strictObject(
  Object.fromEntries(OEM_CATEGORIES.map((category) => [category, z.boolean().optional()])) as Record<
    OemCategory,
    z.ZodOptional<z.ZodBoolean>
  >,
);

const blockedUpdateIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(NO_CONTROL_CHARS, 'must not contain control characters');

const vendorSchema = z.strictObject({
  enabled: z.boolean(),
  categories: categoriesSchema,
  // The same bounds as the run payload's blockedUpdateIds.
  blockedUpdateIds: z
    .array(blockedUpdateIdSchema)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'blocked update IDs must be unique' })
    .default([]),
});

const vendorsSchema = z.strictObject(
  Object.fromEntries(OEM_LANES.map((lane) => [lane, vendorSchema.optional()])) as Record<
    OemLane,
    z.ZodOptional<typeof vendorSchema>
  >,
);

export const OEM_WEEKS_OF_MONTH = ['first', 'second', 'third', 'fourth', 'last'] as const;
export const OEM_DAYS_OF_WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export const OEM_REBOOT_MODES = ['overnight', 'never'] as const;

export const oemUpdatesScheduleSchema = z.strictObject({
  weekOfMonth: z.enum(OEM_WEEKS_OF_MONTH),
  dayOfWeek: z.enum(OEM_DAYS_OF_WEEK),
  windowStart: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'windowStart must be HH:MM, 00:00 to 23:59'),
  windowHours: z.number().int().min(1).max(8),
});

export const oemUpdatesInlineSettingsSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  schedule: oemUpdatesScheduleSchema,
  catchUpNights: z.number().int().min(0).max(14),
  reboot: z.enum(OEM_REBOOT_MODES),
  vendors: vendorsSchema,
});

export type OemUpdatesInlineSettings = z.infer<typeof oemUpdatesInlineSettingsSchema>;

/**
 * `GET /configuration-policies/oem-updates/gates`: per lane, whether its agent
 * code has shipped and which categories may be stored true today. Device-less:
 * the lab override never opens a gate for a stored policy.
 */
export type OemUpdatesGateSnapshot = {
  lanes: Array<{ lane: OemLane; shipped: boolean; categories: Record<OemCategory, boolean> }>;
};
export type OemUpdatesVendorSettings = z.infer<typeof vendorSchema>;

/**
 * Spec 4.1 defaults: third Wednesday, 01:00, a 4-hour window, 7 catch-up nights,
 * overnight reboot. Off, with no vendor: the tab adds the lanes and open
 * categories it preselects, and switching the policy on is the writer's decision.
 */
export const OEM_UPDATES_POLICY_DEFAULTS: Readonly<OemUpdatesInlineSettings> = Object.freeze({
  version: 1,
  enabled: false,
  schedule: Object.freeze({ weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 }),
  catchUpNights: 7,
  reboot: 'overnight',
  vendors: Object.freeze({}),
}) as Readonly<OemUpdatesInlineSettings>;

// ---------------------------------------------------------------------------
// Arming. These read UNTRUSTED input leniently (a raw request body, or a stored
// blob that may predate the schema), never throw, and treat anything that is not
// literally `true` as off. The write gate runs them BEFORE strict validation, so
// a caller without devices.execute learns nothing about validation.
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function vendorOf(raw: unknown, lane: OemLane): Record<string, unknown> | null {
  return record(record(record(raw)?.vendors)?.[lane]);
}

/** `lane:category` for every category that would run: policy on, vendor on, category true. */
export function armedOemCategories(raw: unknown): Set<`${OemLane}:${OemCategory}`> {
  const armed = new Set<`${OemLane}:${OemCategory}`>();
  if (record(raw)?.enabled !== true) return armed;
  for (const lane of OEM_LANES) {
    const vendor = vendorOf(raw, lane);
    if (vendor?.enabled !== true) continue;
    const categories = record(vendor.categories);
    for (const category of OEM_CATEGORIES) {
      if (categories?.[category] === true) armed.add(`${lane}:${category}`);
    }
  }
  return armed;
}

/** True when the settings would install anything on a device they reach. */
export function hasArmedCategory(raw: unknown): boolean {
  return armedOemCategories(raw).size > 0;
}

function blockedIds(raw: unknown, lane: OemLane): string[] {
  const ids = vendorOf(raw, lane)?.blockedUpdateIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * True when `next` lets a device do something `previous` did not, which needs
 * `devices.execute` + MFA (spec 4.1, plan Decision 6). `previous` is what is in
 * effect for the policy before the write: its own link, else the one it
 * inherits, else null.
 *
 * Arming:
 *  - the policy switched on (`enabled` not true before, true now);
 *  - a lane:category that now runs and did not before (a category newly true,
 *    or a vendor switched on over categories already set);
 *  - overnight reboot switched on while something is armed (reboots devices,
 *    and lets BIOS and firmware run: the dispatch seam drops both without it);
 *  - a blocked update ID removed from a vendor that is armed.
 *
 * Not arming: switching anything off, removing a category or a vendor, adding a
 * blocked ID, and any schedule change (an hour earlier, a longer window, more
 * catch-up nights). Stopping a bad update never needs extra rights.
 */
export function armsBeyond(previous: unknown, next: unknown): boolean {
  const nextRecord = record(next);
  if (nextRecord?.enabled === true && record(previous)?.enabled !== true) return true;

  const before = armedOemCategories(previous);
  const after = armedOemCategories(next);
  for (const pair of after) if (!before.has(pair)) return true;

  if (after.size > 0 && nextRecord?.reboot !== 'never' && record(previous)?.reboot === 'never') return true;

  for (const lane of OEM_LANES) {
    if (![...after].some((pair) => pair.startsWith(`${lane}:`))) continue;
    const kept = new Set(blockedIds(next, lane));
    if (blockedIds(previous, lane).some((id) => !kept.has(id))) return true;
  }
  return false;
}

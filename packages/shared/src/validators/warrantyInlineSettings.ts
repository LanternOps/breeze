import { z } from 'zod';
import { HP_CMSL_EULA_ID } from '../constants/hpCmsl';

// Re-exported so validator consumers (@breeze/shared/validators) can compare
// a recorded consent against the current id without a second import path.
export { HP_CMSL_EULA_ID };

/**
 * `warranty` feature-link inline settings (#5511 W02, contract D1).
 *
 * Pure JSONB on `config_policy_feature_links` — no normalized table, no new
 * tenancy shape, no migration. Two schemas, deliberately:
 *
 *  - `warrantyInlineSettingsSchema` is what a CLIENT may send. `consent` is
 *    not in the shape, and `.strict()` therefore REFUSES it rather than
 *    stripping it (D3): silently dropping a consent object would let a UI
 *    believe an acceptance had been recorded when none was.
 *  - `storedWarrantyInlineSettingsSchema` is what may be PERSISTED. Only the
 *    server produces a value that satisfies it, because only the server writes
 *    `consent` — see addFeatureLink/updateFeatureLink in the API's
 *    configurationPolicy service, which take the accepting user out of band
 *    rather than from the payload.
 *
 * The pre-existing `enabled` field means EXPIRY ALERTING. `hpCmsl.enabled`
 * means DEVICE-SIDE COLLECTION. They are independent; do not overload either.
 */
export const warrantyHpCmslConsentSchema = z
  .object({
    /** The authenticated user who accepted, stamped server-side. */
    acceptedByUserId: z.string().min(1).max(64),
    /** ISO-8601, server clock. Never a client-supplied time. */
    acceptedAt: z.string().datetime(),
    /** Compared against HP_CMSL_EULA_ID; never parsed. */
    eulaId: z.string().min(1).max(64),
  })
  .strict();

export type WarrantyHpCmslConsent = z.infer<typeof warrantyHpCmslConsentSchema>;

/** What a client may send for the hpCmsl block: the flag, and nothing else. */
export const warrantyHpCmslRequestBlockSchema = z
  .object({ enabled: z.boolean() })
  .strict();

/** What may be stored: the flag plus a server-stamped acceptance. */
export const warrantyHpCmslStoredBlockSchema = z
  .object({
    enabled: z.boolean(),
    consent: warrantyHpCmslConsentSchema.optional(),
  })
  .strict();

// The alerting half, unchanged in meaning since #1320. Bounds are wide on
// purpose (1..3650, matching device_lifecycle's retention window) — a WRITE
// that fails to parse discards the whole blob, so a legacy row with an odd
// threshold must still be re-savable after an unrelated edit.
const warrantyAlertFields = {
  enabled: z.boolean().optional(),
  warnDays: z.number().int().min(1).max(3650).optional(),
  criticalDays: z.number().int().min(1).max(3650).optional(),
};

export const warrantyInlineSettingsSchema = z
  .object({
    ...warrantyAlertFields,
    hpCmsl: warrantyHpCmslRequestBlockSchema.optional(),
  })
  .strict();

export type WarrantyInlineSettings = z.infer<typeof warrantyInlineSettingsSchema>;

export const storedWarrantyInlineSettingsSchema = z
  .object({
    ...warrantyAlertFields,
    hpCmsl: warrantyHpCmslStoredBlockSchema.optional(),
  })
  .strict();

export type StoredWarrantyInlineSettings = z.infer<typeof storedWarrantyInlineSettingsSchema>;

function readHpCmslBlock(inlineSettings: unknown): unknown {
  if (!inlineSettings || typeof inlineSettings !== 'object' || Array.isArray(inlineSettings)) {
    return undefined;
  }
  return (inlineSettings as Record<string, unknown>).hpCmsl;
}

/**
 * True when the caller put a `consent` KEY on the hpCmsl block at all —
 * including `consent: null` or `consent: undefined`. Presence is what matters:
 * the point of D3 is that a client learns its consent was refused, so the
 * refusal must not depend on the value being well-formed.
 */
export function clientSuppliedWarrantyHpCmslConsent(inlineSettings: unknown): boolean {
  const block = readHpCmslBlock(inlineSettings);
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
  return 'consent' in (block as Record<string, unknown>);
}

/**
 * "Is this author ASKING for device-side collection?" — the input to the
 * write-time authorization gate (D4), evaluated on a payload that has not been
 * consent-stamped yet. Deliberately does NOT require consent.
 */
export function warrantyHpCmslRequested(inlineSettings: unknown): boolean {
  const parsed = warrantyHpCmslStoredBlockSchema.safeParse(readHpCmslBlock(inlineSettings));
  return parsed.success && parsed.data.enabled === true;
}

/**
 * "Does this STORED link actually deliver collection?" — the input to the
 * agent-config builder and to the inheritance/assignment gates. Requires a
 * consent recorded against the CURRENT HP_CMSL_EULA_ID, so a superseded
 * acceptance turns collection off rather than riding on stale terms (D2).
 *
 * Parses the hpCmsl SUB-BLOCK, not the whole settings object: an unrelated
 * out-of-range alert threshold must not silently disable collection.
 * A block it cannot read at all yields `false` — fail safe.
 */
export function warrantyHpCmslCollectionEffective(inlineSettings: unknown): boolean {
  const parsed = warrantyHpCmslStoredBlockSchema.safeParse(readHpCmslBlock(inlineSettings));
  if (!parsed.success) return false;
  return parsed.data.enabled === true && parsed.data.consent?.eulaId === HP_CMSL_EULA_ID;
}

/**
 * The acceptance recorded on a stored blob, VERBATIM — including one that
 * names a superseded EULA id. Two consumers need exactly that: the API carries
 * a still-current acceptance across an unrelated threshold edit rather than
 * churning `acceptedAt`, and the authoring UI has to be able to say "these
 * terms changed since <user> accepted on <date>" instead of silently showing
 * nothing. Compare `eulaId` at the call site; this reader does not judge.
 */
export function readRecordedWarrantyHpCmslConsent(inlineSettings: unknown): WarrantyHpCmslConsent | null {
  const parsed = warrantyHpCmslStoredBlockSchema.safeParse(readHpCmslBlock(inlineSettings));
  return parsed.success ? (parsed.data.consent ?? null) : null;
}

/**
 * Which `device_warranty.data_source` values were written BY AN AGENT, and
 * which vendor a synthesised agent entitlement belongs to.
 *
 * Its own module rather than more exports on `warrantySync.ts` because four
 * unrelated writers need the same rule and only two of them want a database:
 *   - `warrantySync.ts`                      — the direct sync + the 7-day sweep
 *   - `customFields/import/warrantyTarget.ts` and `valueImport.ts` — CSV import
 *   - `routes/devices/warranty.ts`            — manual refresh
 *   - `routes/agents/schemas.ts`              — the entitlements bound
 * Importing `warrantySync.ts` from a route would drag `../db` into that route's
 * unit-test module graph for a two-line predicate. Nothing here does I/O.
 *
 * THE RULE: a row an agent wrote describes hardware the agent can see. A
 * server-side vendor lookup, or a hand-typed CSV, must never overwrite it — the
 * agent rewrites it on its next report anyway, so the overwrite destroys data
 * and reports success. #5511 W01; `agent_plist` was already exposed to this
 * before HP existed.
 */
import type { WarrantyEntitlement } from './warrantyProviders/types';
import { getProviderForManufacturer, normalizeManufacturer } from './warrantyProviders';

/** macOS: `CollectAppleWarranty` reads the on-device AppleCare plist. */
export const AGENT_PLIST_WARRANTY_SOURCE = 'agent_plist';
/** Windows/HP: HP CMSL writes `root/HP/InstrumentedServices/v1`; the agent reads it. */
export const AGENT_CMSL_WARRANTY_SOURCE = 'agent_cmsl';

/**
 * Ordered, so SQL predicates generated from it are stable across builds.
 * `device_warranty.data_source` is `varchar(50)` with no CHECK and no enum
 * (`db/schema/warranty.ts:50`), so THIS LIST — not the database — is the
 * definition of "agent-owned".
 */
export const AGENT_OWNED_WARRANTY_SOURCE_LIST = [
  AGENT_PLIST_WARRANTY_SOURCE,
  AGENT_CMSL_WARRANTY_SOURCE,
] as const;

export const AGENT_OWNED_WARRANTY_SOURCES: ReadonlySet<string> = new Set(
  AGENT_OWNED_WARRANTY_SOURCE_LIST,
);

export function isAgentOwnedWarrantySource(dataSource: string | null | undefined): boolean {
  return typeof dataSource === 'string' && AGENT_OWNED_WARRANTY_SOURCES.has(dataSource);
}

/** A server-side vendor lookup (`warrantySync.ts` upsertWarranty). Also the column default. */
export const PROVIDER_WARRANTY_SOURCE = 'provider';
/** The custom-field value importer (`customFields/import/warrantyTarget.ts`). */
export const IMPORT_WARRANTY_SOURCE = 'import';

/**
 * #9862 — true when the stored row holds coverage a vendor lookup did NOT
 * produce: an agent report, a CSV import, or any future non-vendor writer.
 *
 * A server sync that has nothing better — no provider for the manufacturer, a
 * vendor miss, a lookup error — must leave such a row's coverage alone. Before
 * this, only agent-owned rows were spared and an imported row was rewritten to
 * `unknown` with NULL dates by a single Refresh click (or the 7-day sweep).
 *
 * Deliberately open-ended (anything that is not 'provider') rather than another
 * list: the failure mode of a new writer missing from a list is silent data
 * loss, while the failure mode of this default is a stale row that still shows
 * where it came from. NULL counts as vendor-shaped — it is the pre-provenance
 * legacy of the 'provider' default.
 *
 * Weaker than agent ownership: a vendor HIT may still replace a non-vendor,
 * non-agent row, but only when that loses no coverage — see
 * `vendorHitShortensCoverage`.
 */
export function isNonVendorWarrantySource(dataSource: string | null | undefined): boolean {
  return typeof dataSource === 'string' && dataSource !== PROVIDER_WARRANTY_SOURCE;
}

/**
 * #9862 — true when replacing a stored non-vendor (imported) row with a vendor
 * HIT would erase or shorten its coverage, so the import must be kept.
 *
 * OEM warranty APIs routinely omit coverage an MSP bought elsewhere — an
 * extended Care Pack through a distributor, a third-party contract — and the
 * MSP imports it by hand. A vendor answer ending before the imported date is
 * then not a correction, it is the vendor not knowing. A vendor end date that
 * is the same or later loses nothing, so the vendor wins there.
 *
 * Dates are `YYYY-MM-DD` (`date` columns, provider output), so string order is
 * date order. Mirrored in SQL by `upsertWarranty`'s `setWhere`, which is the
 * authority; this is the advisory read.
 */
export function vendorHitShortensCoverage(input: {
  storedEndDate: string | null | undefined;
  vendorEndDate: string | null | undefined;
}): boolean {
  const stored = input.storedEndDate ?? null;
  if (stored === null) return false;
  const vendor = input.vendorEndDate ?? null;
  return vendor === null || vendor < stored;
}

/** Contract bound: at most 25 entitlements per agent report. */
export const MAX_AGENT_WARRANTY_ENTITLEMENTS = 25;

type EntitlementProvider = WarrantyEntitlement['provider'];

/** The closed union from `warrantyProviders/types.ts:2`, as a runtime value. */
const ENTITLEMENT_PROVIDERS: readonly EntitlementProvider[] = ['dell', 'hp', 'lenovo', 'apple'];

const SOURCE_ENTITLEMENT_PROVIDER: Readonly<Record<string, EntitlementProvider>> = {
  [AGENT_PLIST_WARRANTY_SOURCE]: 'apple',
  [AGENT_CMSL_WARRANTY_SOURCE]: 'hp',
};

/**
 * The `provider` a synthesised agent entitlement carries.
 *
 * Reporting source FIRST — the collector knows which vendor's data it read, and
 * a garbled SMBIOS manufacturer string must not be able to re-attribute it —
 * then the normalized manufacturer for any future collector not listed here.
 *
 * Returns null when neither resolves, and the caller then synthesises NO
 * entitlement: one stamped with the wrong vendor is worse than a missing one.
 * Everything downstream reads `entitlements[].provider` as ground truth, which
 * is exactly why the hardcoded `provider: 'apple' as const` at
 * `warrantySync.ts:367` was a defect and not a cosmetic default.
 */
export function warrantyEntitlementProviderForSource(
  source: string,
  manufacturer: string,
): EntitlementProvider | null {
  const bySource = SOURCE_ENTITLEMENT_PROVIDER[source];
  if (bySource) return bySource;
  const normalized = normalizeManufacturer(manufacturer ?? '');
  return ENTITLEMENT_PROVIDERS.find((p) => p === normalized) ?? null;
}

/**
 * True when a SERVER-SIDE warranty sync cannot produce anything for this
 * device, so queuing one and answering "refresh queued" would be a lie (D11).
 *
 * Two cases:
 *  - the stored row is already agent-owned — the device, not the server, is its
 *    writer; and
 *  - the device is HP — `warrantyProviders/index.ts:7-12` deliberately does not
 *    register `hpProvider`, so `getProviderForManufacturer` returns null for
 *    every HP device whether or not a row exists yet.
 */
export function isAgentCollectedWarrantyDevice(input: {
  manufacturer: string | null | undefined;
  dataSource: string | null | undefined;
}): boolean {
  if (isAgentOwnedWarrantySource(input.dataSource)) return true;
  return normalizeManufacturer(input.manufacturer ?? '') === 'hp';
}

/**
 * Why a manual warranty refresh would produce nothing, or null when it can.
 *
 *  - `agent_collected` — see `isAgentCollectedWarrantyDevice`.
 *  - `no_vendor_lookup` (#9862) — no registered, configured provider answers
 *    for this manufacturer (or the device reports none) AND the stored row is
 *    non-vendor data the sync now keeps as-is. Queuing would change nothing,
 *    so "refresh queued" would be a lie and the card would poll a `lastSyncAt`
 *    that never advances.
 *
 * A device with no row, or a vendor-shaped row, still queues: the sync records
 * the honest `unknown` result there, which is the existing behaviour.
 */
export type WarrantyRefreshRefusal = 'agent_collected' | 'no_vendor_lookup';

/** One wording for the refresh route and the AI tool. */
export const WARRANTY_REFRESH_REFUSAL_MESSAGES: Readonly<Record<WarrantyRefreshRefusal, string>> = {
  agent_collected:
    "This device's warranty is collected by the Breeze agent, not by a vendor lookup. "
    + 'A server-side refresh cannot produce newer data.',
  no_vendor_lookup:
    'No vendor warranty lookup is available for this manufacturer; the existing warranty data was kept.',
};

export function warrantyRefreshRefusal(input: {
  manufacturer: string | null | undefined;
  dataSource: string | null | undefined;
}): WarrantyRefreshRefusal | null {
  if (isAgentCollectedWarrantyDevice(input)) return 'agent_collected';
  if (
    isNonVendorWarrantySource(input.dataSource)
    && !(input.manufacturer && getProviderForManufacturer(input.manufacturer))
  ) {
    return 'no_vendor_lookup';
  }
  return null;
}

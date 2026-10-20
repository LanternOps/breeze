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
import { normalizeManufacturer } from './warrantyProviders';

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

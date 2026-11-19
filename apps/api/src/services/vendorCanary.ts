/**
 * Vendor canary gating (observe-first amendments, #11065 §1), shared by vendor
 * updates, Wake-on-LAN and HP warranty.
 *
 * Best-guess vendor code ships in two steps, each enabled only for the partners
 * in `BREEZE_VENDOR_CANARY_PARTNER_IDS` (our own tenant; never named in this
 * repo):
 *
 * - `observe`: read-only collection, nothing written or installed;
 * - `act`: the write path, still behind every one of the feature's own locks.
 *
 * Who is an env value; what stage each feature and vendor pair is at is the
 * code table below, which only a reviewed PR carrying observe evidence changes.
 * `vendorStage` answers the table's entry only when the partner is listed, the
 * pair is not disabled, and the table has an entry; otherwise `off`. An unset
 * or empty list is off for everyone. `config/validate.ts` refuses a malformed
 * list or an unknown disabled pair at boot.
 *
 * Widening past the canary is a separate decision per pair through that
 * feature's own switches, and it removes the pair's entry here.
 */
import { createHash } from 'node:crypto';

export const VENDOR_FEATURES = ['oem_updates', 'wake_on_lan', 'hp_warranty'] as const;
export type VendorFeature = (typeof VENDOR_FEATURES)[number];
export type VendorStage = 'off' | 'observe' | 'act';
type VendorStageTable = Readonly<Record<VendorFeature, Readonly<Partial<Record<string, Exclude<VendorStage, 'off'>>>>>>;

/** At most this many canary partners: it is a canary, not a rollout. */
export const VENDOR_CANARY_MAX_PARTNERS = 3;

// Code table; only a PR carrying observe evidence changes an entry.
export const VENDOR_STAGES: VendorStageTable = Object.freeze({
  oem_updates: Object.freeze({ surface: 'observe', hp: 'observe', lenovo: 'observe' }),
  wake_on_lan: Object.freeze({ hp: 'observe', lenovo: 'observe', surface: 'observe' }),
  hp_warranty: Object.freeze({ hp: 'observe' }),
});

function csv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/** The listed partners, lowercased. Empty means every stage is off. */
export function vendorCanaryPartnerIds(): string[] {
  return [...new Set(csv('BREEZE_VENDOR_CANARY_PARTNER_IDS'))];
}

export function isVendorCanaryPartner(partnerId: string | null | undefined): boolean {
  if (!partnerId) return false;
  return csv('BREEZE_VENDOR_CANARY_PARTNER_IDS').includes(partnerId.toLowerCase());
}

/**
 * The kill switch, `BREEZE_VENDOR_CANARY_DISABLED` (`feature:vendor,…`). Needs no
 * release, but the API and worker containers must be recreated with the new env.
 * It stops new dispatch and delivery, and never recalls a run already claimed.
 */
export function vendorPairDisabled(feature: VendorFeature, vendor: string): boolean {
  return csv('BREEZE_VENDOR_CANARY_DISABLED').includes(`${feature}:${vendor.toLowerCase()}`);
}

function tableStage(table: VendorStageTable, feature: VendorFeature, vendor: string): Exclude<VendorStage, 'off'> | null {
  const row = table[feature];
  // Own keys only: `toString` or `__proto__` must not read as a stage.
  if (!row || !Object.prototype.hasOwnProperty.call(row, vendor)) return null;
  const stage = row[vendor];
  return stage === 'observe' || stage === 'act' ? stage : null;
}

export function vendorStage(feature: VendorFeature, vendor: string, partnerId: string | null | undefined): VendorStage {
  if (!isVendorCanaryPartner(partnerId)) return 'off';
  const lane = vendor.toLowerCase();
  if (vendorPairDisabled(feature, lane)) return 'off';
  return tableStage(VENDOR_STAGES, feature, lane) ?? 'off';
}

/** Every pair the table names, as `feature:vendor`. What the kill switch may name. */
export function knownVendorPairs(): string[] {
  return VENDOR_FEATURES.flatMap((feature) => Object.keys(VENDOR_STAGES[feature]).map((vendor) => `${feature}:${vendor}`));
}

/**
 * The partner list, the disabled list and the table, hashed. Folded into each
 * feature's own refresh fingerprint (vendor updates: `oemGatesFingerprint`), so a
 * change to the canary env or a stage refreshes every device's policy side.
 * `table` is for tests.
 */
export function vendorCanaryFingerprint(table: VendorStageTable = VENDOR_STAGES): string {
  const canonical = JSON.stringify({
    partners: [...csv('BREEZE_VENDOR_CANARY_PARTNER_IDS')].sort(),
    disabled: [...csv('BREEZE_VENDOR_CANARY_DISABLED')].sort(),
    stages: VENDOR_FEATURES.map((feature) => [
      feature,
      Object.entries(table[feature]).sort(([a], [b]) => a.localeCompare(b)),
    ]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

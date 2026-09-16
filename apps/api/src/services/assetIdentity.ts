/**
 * Read-time asset identity guards (spec §9, decision D6).
 *
 * W01 ships ONLY the read-time pieces: the mask that stops a raw sysObjectID
 * rendering as a model, and the NIC-vendor derivation. W03 adds
 * `resolveAssetIdentity()` (ingest-side enterprise-number resolution and the
 * vendor model extractors) to this same module — so the read guard protects
 * every row already in the database, including the ones W03 will never re-scan.
 *
 * WHY A MASK AND NOT A BACKFILL: agent/internal/discovery/classify.go:45 writes
 * `model = sysObjectID` whenever nothing better is known, and old agents will
 * keep doing that until they update. A one-off UPDATE would fix today's rows
 * and be re-broken by tomorrow's scan.
 */

import { lookupMacVendor } from './macVendorLookup';

/**
 * A dotted-decimal OID rooted at 1 (iso). Anchored at BOTH ends and requiring
 * at least two components, so real model numbers that merely contain digits and
 * dots ("HL-L2350DW", "ET-2.5G", "UAP-AC-PRO") never match. `2.4.1` does not
 * match either: SNMP object identifiers in this position are always iso-rooted.
 */
export const OID_SHAPED_MODEL = /^\.?1(\.\d+)+$/;

/**
 * Null out a `model` that is really a sysObjectID. The raw value is still
 * available to the UI as `snmpData.sysObjectId`, which is where an operator
 * looking for it expects to find it (the "All scan details" disclosure, §11).
 */
export function maskOidShapedModel(model: string | null): string | null {
  if (!model) return null;
  return OID_SHAPED_MODEL.test(model.trim()) ? null : model;
}

/**
 * The OUI vendor of the asset's MAC, exposed SEPARATELY from `manufacturer`.
 *
 * These are different facts and conflating them is F5: a Xerox C325 has a
 * Lexmark-built engine, so its OUI says LEXMARK while the device is a Xerox.
 * The UI shows this only when it differs from `manufacturer` (§11).
 */
export function nicVendorFromMac(mac: string | null): string | null {
  return lookupMacVendor(mac);
}

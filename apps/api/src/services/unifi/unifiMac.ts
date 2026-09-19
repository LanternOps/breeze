import { sql } from 'drizzle-orm';
import { discoveredAssets } from '../../db/schema';

// Canonical MAC form for cross-source matching: lowercase, colon-separated.
// discovered_assets stores colon-lowercase; UniFi may report uppercase/hyphenated,
// so we normalize both sides before comparing (and store the canonical form).
//
// Shared by unifiTelemetryService.ts and unifiSyncService.ts (#5096, #5102) —
// every UniFi producer that writes/matches discovered_assets.mac_address must
// use the exact same canonicalisation, or a controller reporting a different
// casing than a previous writer will silently fail to match and either fall
// through to the IP fallback or create a duplicate asset.
export function normalizeMac(mac: string): string {
  return mac.trim().toLowerCase().replace(/-/g, ':');
}

// Nullable variant for callers where mac is optional on the wire.
// An empty/whitespace mac must collapse to null, not to '', so it never matches
// a blank macAddress row.
export function canonicalMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const normalized = normalizeMac(mac);
  return normalized.length > 0 ? normalized : null;
}

// Both sides of a MAC comparison must be canonicalised. discovered_assets rows
// are written by several producers (agent discovery, UniFi sync, UniFi telemetry),
// and only the app layer enforces the format — there is no DB CHECK — so a row
// stored uppercase or hyphenated is possible and must still match.
export const canonicalAssetMac = sql`lower(replace(${discoveredAssets.macAddress}, '-', ':'))`;

import { sql, type SQL } from 'drizzle-orm';
import { discoveredAssets } from '../db/schema';

/**
 * Source-precedence contract for automatic `discovered_assets` type classification (#3187).
 *
 * `type_source` ('manual' | 'auto') records whether a HUMAN pinned the type. It
 * deliberately says nothing about WHICH automatic classifier produced the
 * machine guess, so before this module the UniFi controller sync and the agent
 * scan both wrote 'auto' and freely overwrote each other — a UniFi switch got
 * rewritten to `access_point` by the OUI heuristic on the next scan, and back
 * again on the next sync, flapping `detected_asset_type` indefinitely.
 *
 * `detected_type_source` is the second, orthogonal axis: it ranks the automatic
 * classifiers against each other. The two axes compose —
 *
 *   - `type_source = 'manual'`  → a human wins over every classifier, always.
 *   - `detected_type_source`    → among classifiers, the better-informed one wins.
 *
 * Keeping them separate (rather than adding an 'integration' member to
 * `type_source`) means a manual override does NOT erase the provenance of the
 * automatic result underneath it, so "reset to auto" still restores the best
 * machine classification rather than demoting it.
 */

/**
 * Every automatic classifier that may write `discovered_assets.detected_asset_type`.
 * Mirrors the `discovered_asset_detection_source` Postgres enum.
 */
export const DISCOVERED_ASSET_DETECTION_SOURCES = [
  'vendor_oui',
  'agent_scan',
  'unifi_controller',
] as const;

export type DiscoveredAssetDetectionSource =
  typeof DISCOVERED_ASSET_DETECTION_SOURCES[number];

/**
 * Precedence rank — HIGHER wins. A classifier may overwrite a stored detection
 * only when its own rank is >= the stored one.
 *
 * The ranks are spaced by 10 so a future classifier can be slotted between two
 * existing ones without renumbering.
 *
 *   vendor_oui (10)
 *     A guess from the MAC OUI / SNMP vendor string alone. The vendor implies a
 *     product CATEGORY at best, and only for single-purpose manufacturers — it
 *     cannot tell a Ubiquiti switch from a Ubiquiti AP. Weakest by construction.
 *   agent_scan (20)
 *     The agent's own classification from what it observed on the wire (open
 *     ports, SNMP sysDescr, OS fingerprint). Evidence about the actual host.
 *   unifi_controller (30)
 *     The UniFi controller's own device record. It knows the exact model and
 *     product line, so it is authoritative for the gear it manages.
 *
 * `Record<DiscoveredAssetDetectionSource, number>` is deliberate: adding a
 * member to the union without giving it a rank is a COMPILE error, which forces
 * whoever adds the next classifier to decide where it sits. Do not relax this to
 * a partial map or an index signature.
 */
const DETECTION_SOURCE_RANK: Record<DiscoveredAssetDetectionSource, number> = {
  vendor_oui: 10,
  agent_scan: 20,
  unifi_controller: 30,
};

export function detectionSourceRank(source: DiscoveredAssetDetectionSource): number {
  return DETECTION_SOURCE_RANK[source];
}

/**
 * Rank of the detection already stored on the row, as a SQL expression.
 *
 * A NULL `detected_type_source` — a row that predates this column, or one no
 * classifier has ever had an opinion about — ranks 0, below every real source,
 * so the first classifier to run always gets to write. Rows backfilled by the
 * migration from `unifi_devices` are the exception and already carry
 * 'unifi_controller'.
 */
function storedDetectionRankSql(): SQL {
  const whens = DISCOVERED_ASSET_DETECTION_SOURCES.map(
    (source) => sql`when ${source} then ${DETECTION_SOURCE_RANK[source]}`,
  );
  return sql`case ${discoveredAssets.detectedTypeSource} ${sql.join(whens, sql` `)} else 0 end`;
}

/**
 * True when a classifier writing as `source` may replace the stored detection.
 *
 * `>=` rather than `>`: a classifier must always be able to REFRESH its own
 * previous answer (a switch re-provisioned as a gateway, an agent that now sees
 * SNMP where it previously did not). Only a strictly weaker source is blocked.
 */
function outranksStoredDetectionSql(source: DiscoveredAssetDetectionSource): SQL {
  return sql`${storedDetectionRankSql()} <= ${DETECTION_SOURCE_RANK[source]}`;
}

/** The type columns a classifier writes, all guarded in SQL. */
export interface ClassificationWrite {
  assetType: SQL;
  detectedAssetType: SQL;
  detectedTypeSource: SQL;
}

/**
 * Build the guarded write set for a classifier that DID recognise a device.
 *
 * A classifier with no opinion must not call this at all — it should write none
 * of the three columns. `'unknown'` from a classifier means "I can't tell", not
 * "this device is genuinely of unknown type", and stamping it back erases a
 * better answer from someone else (the defect PR #3185 fixed on the UniFi path
 * and this change fixes on the agent-scan path).
 *
 * Every guard is evaluated in SQL against the stored row, never in JS, for the
 * same reason the manual guard is (#3011): on an ON CONFLICT path we never read
 * the colliding row at all, and on an UPDATE path both `type_source` and
 * `detected_type_source` can change between the SELECT and the UPDATE. Inside
 * `UPDATE ... SET` and `ON CONFLICT DO UPDATE SET`, a reference qualified with
 * the target table reads the EXISTING row while `excluded` is the row we
 * proposed — so these CASE expressions compare old against new correctly on both.
 *
 * @param source   which classifier is writing
 * @param proposed the values it wants to store — a bound literal on an UPDATE
 *                 path, or `excluded.<column>` on an insert-conflict path
 */
export function buildClassificationWrite(
  source: DiscoveredAssetDetectionSource,
  proposed: { assetType: SQL; detectedAssetType: SQL },
): ClassificationWrite {
  const outranks = outranksStoredDetectionSql(source);

  return {
    // The user-facing type yields to BOTH axes: a manual pin always wins, and
    // among classifiers only an equal-or-stronger source may overwrite.
    assetType: sql`case when ${discoveredAssets.typeSource} = 'manual' then ${discoveredAssets.assetType} when ${outranks} then ${proposed.assetType} else ${discoveredAssets.assetType} end`,
    // The latent "what did the machines think" columns ignore the manual axis —
    // they are what "reset to auto" restores — but still respect precedence, so
    // a weak guess can't overwrite what a stronger classifier detected.
    detectedAssetType: sql`case when ${outranks} then ${proposed.detectedAssetType} else ${discoveredAssets.detectedAssetType} end`,
    detectedTypeSource: sql`case when ${outranks} then ${sql`${source}`}::discovered_asset_detection_source else ${discoveredAssets.detectedTypeSource} end`,
  };
}

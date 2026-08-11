-- #3187 — rank the AUTOMATIC classifiers of discovered_assets against each other.
--
-- type_source ('manual' | 'auto', added 2026-06-28) records only whether a human
-- pinned the type. Both automatic classifiers — the UniFi controller sync and the
-- agent network scan — write 'auto', so neither could tell it was about to
-- clobber the other. A UniFi switch classified from the controller's device
-- record got rewritten to 'access_point' by the agent's OUI vendor heuristic on
-- the next scan, and back to 'switch' on the next sync, flapping indefinitely.
--
-- detected_type_source is the second, orthogonal axis: it says WHICH classifier
-- produced detected_asset_type. A weaker classifier may no longer overwrite a
-- stronger one. Keeping it separate from type_source means a manual override no
-- longer erases the provenance of the automatic result underneath it, so
-- "reset to auto" still restores the best machine classification.
--
-- The precedence ORDER is NOT this enum's declaration order — it lives in
-- apps/api/src/services/discoveredAssetClassification.ts, where the rank map is
-- exhaustive over the union and a missing entry fails to compile.

DO $$
BEGIN
  CREATE TYPE discovered_asset_detection_source AS ENUM (
    'vendor_oui',       -- MAC OUI / SNMP vendor string guess (weakest)
    'agent_scan',       -- the agent's own on-the-wire classification
    'unifi_controller'  -- the UniFi controller's device record (authoritative)
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Nullable on purpose: NULL means "no classifier has ever had an opinion" and
-- ranks below every real source, so the first classifier to run still wins.
ALTER TABLE discovered_assets
  ADD COLUMN IF NOT EXISTS detected_type_source discovered_asset_detection_source;

-- Backfill the rows we can attribute with certainty: anything the UniFi sync
-- linked to a unifi_devices row AND actually classified came from the
-- controller. Without this, the first agent scan after deploy would be free to
-- overwrite every existing UniFi classification with an OUI guess once (it would
-- converge on the next sync, but that is a visible flap we can avoid).
--
-- Rows left NULL are correct as NULL — we cannot tell which classifier wrote
-- them, so the next classifier of any strength is allowed to claim them.
DO $$
DECLARE
  n bigint;
BEGIN
  UPDATE discovered_assets da
     SET detected_type_source = 'unifi_controller'
   WHERE da.detected_type_source IS NULL
     AND da.detected_asset_type IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM unifi_devices ud WHERE ud.discovered_asset_id = da.id
     );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'backfilled % discovered_assets rows to detected_type_source=unifi_controller', n;
END $$;

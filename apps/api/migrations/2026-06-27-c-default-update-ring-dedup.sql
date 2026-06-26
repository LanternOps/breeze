-- Deduplicate default update rings that collapsed from org-scope to partner-scope.
-- Two orgs under one partner could each have an identical Default ring before
-- 2026-06-27-a; after partner-scope migration they should be one partner ring.

DO $$
DECLARE
  deleted_approvals bigint;
  updated_approvals_ring bigint;
  updated_approvals_policy bigint;
  updated_jobs_ring bigint;
  updated_jobs_policy bigint;
  updated_snapshots bigint;
  updated_feature_links bigint;
  deleted_rings bigint;
BEGIN
  DROP TABLE IF EXISTS pg_temp.patch_policy_default_ring_dedup_map;
  CREATE TEMP TABLE patch_policy_default_ring_dedup_map ON COMMIT DROP AS
  WITH ranked AS (
    SELECT
      id AS loser_id,
      FIRST_VALUE(id) OVER (
        PARTITION BY partner_id
        ORDER BY enabled DESC, updated_at DESC, created_at DESC, id DESC
      ) AS winner_id,
      ROW_NUMBER() OVER (
        PARTITION BY partner_id
        ORDER BY enabled DESC, updated_at DESC, created_at DESC, id DESC
      ) AS rn
    FROM patch_policies
    WHERE kind = 'ring'
      AND lower(name) = 'default'
      AND ring_order = 0
      AND deferral_days = 0
  )
  SELECT loser_id, winner_id
    FROM ranked
   WHERE rn > 1;

  WITH affected_rings AS (
    SELECT loser_id AS id FROM patch_policy_default_ring_dedup_map
    UNION
    SELECT winner_id AS id FROM patch_policy_default_ring_dedup_map
  ),
  ranked_approvals AS (
    SELECT
      pa.id,
      ROW_NUMBER() OVER (
        PARTITION BY
          pa.partner_id,
          pa.patch_id,
          COALESCE(m.winner_id, pa.ring_id, '00000000-0000-0000-0000-000000000000'::uuid)
        ORDER BY CASE pa.status
                   WHEN 'approved' THEN 0
                   WHEN 'deferred' THEN 1
                   WHEN 'rejected' THEN 2
                   ELSE 3
                 END,
                 pa.updated_at DESC,
                 pa.id DESC
      ) AS rn
    FROM patch_approvals pa
    LEFT JOIN patch_policy_default_ring_dedup_map m ON pa.ring_id = m.loser_id
    WHERE pa.ring_id IN (SELECT id FROM affected_rings)
  )
  DELETE FROM patch_approvals
   WHERE id IN (SELECT id FROM ranked_approvals WHERE rn > 1);
  GET DIAGNOSTICS deleted_approvals = ROW_COUNT;

  UPDATE patch_approvals pa
     SET ring_id = m.winner_id
    FROM patch_policy_default_ring_dedup_map m
   WHERE pa.ring_id = m.loser_id;
  GET DIAGNOSTICS updated_approvals_ring = ROW_COUNT;

  UPDATE patch_approvals pa
     SET policy_id = m.winner_id
    FROM patch_policy_default_ring_dedup_map m
   WHERE pa.policy_id = m.loser_id;
  GET DIAGNOSTICS updated_approvals_policy = ROW_COUNT;

  UPDATE patch_jobs pj
     SET ring_id = m.winner_id
    FROM patch_policy_default_ring_dedup_map m
   WHERE pj.ring_id = m.loser_id;
  GET DIAGNOSTICS updated_jobs_ring = ROW_COUNT;

  UPDATE patch_jobs pj
     SET policy_id = m.winner_id
    FROM patch_policy_default_ring_dedup_map m
   WHERE pj.policy_id = m.loser_id;
  GET DIAGNOSTICS updated_jobs_policy = ROW_COUNT;

  UPDATE patch_compliance_snapshots pcs
     SET ring_id = m.winner_id
    FROM patch_policy_default_ring_dedup_map m
   WHERE pcs.ring_id = m.loser_id;
  GET DIAGNOSTICS updated_snapshots = ROW_COUNT;

  UPDATE config_policy_feature_links fl
     SET feature_policy_id = m.winner_id
    FROM patch_policy_default_ring_dedup_map m
   WHERE fl.feature_type = 'patch'
     AND fl.feature_policy_id = m.loser_id;
  GET DIAGNOSTICS updated_feature_links = ROW_COUNT;

  DELETE FROM patch_policies
   WHERE id IN (SELECT loser_id FROM patch_policy_default_ring_dedup_map);
  GET DIAGNOSTICS deleted_rings = ROW_COUNT;

  RAISE WARNING 'default update ring dedup: approvals deleted %, approval ring refs updated %, approval policy refs updated %, job ring refs updated %, job policy refs updated %, snapshot refs updated %, feature links updated %, duplicate rings removed %',
    deleted_approvals,
    updated_approvals_ring,
    updated_approvals_policy,
    updated_jobs_ring,
    updated_jobs_policy,
    updated_snapshots,
    updated_feature_links,
    deleted_rings;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS patch_policies_partner_default_ring_unique
  ON patch_policies (partner_id)
  WHERE kind = 'ring'
    AND lower(name) = 'default'
    AND ring_order = 0
    AND deferral_days = 0;

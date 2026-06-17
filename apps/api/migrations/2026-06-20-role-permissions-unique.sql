-- 2026-06-20-role-permissions-unique.sql
-- Give role_permissions a composite primary key on (role_id, permission_id).
--
-- The table shipped with no PK or unique constraint, so re-running the seed
-- (whose grant loop swallows 23505 expecting a conflict) silently inserted
-- DUPLICATE (role_id, permission_id) rows. This de-dups any existing duplicates
-- and adds the PK so the conflict path is real and grants are unique going
-- forward.
--
-- Idempotent: the de-dup is naturally repeatable; the PK is added only if absent.
-- Runs after 2026-06-19-billing-roles so the new billing-role grants are deduped
-- and constrained too.

-- 1. Collapse duplicate grant rows, keeping one row per (role_id, permission_id).
--    Prefer a row carrying constraints (non-null) when duplicates disagree, then
--    fall back to ctid for a deterministic survivor.
DO $$
DECLARE n integer;
BEGIN
  DELETE FROM role_permissions rp
  USING (
    SELECT ctid,
           row_number() OVER (
             PARTITION BY role_id, permission_id
             ORDER BY (constraints IS NULL), ctid
           ) AS rn
    FROM role_permissions
  ) d
  WHERE rp.ctid = d.ctid AND d.rn > 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'role-permissions-unique: removed % duplicate grant row(s)', n;
  END IF;
END $$;

-- 2. Add the composite primary key if it isn't already present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.role_permissions'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE role_permissions
      ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_id);
  END IF;
END $$;

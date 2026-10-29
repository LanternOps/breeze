-- #7358 (follow-up to #7212 item 2): strip the legacy "[monitor] " prefix from
-- managed network checks compiled before #7359.
--
-- Since #7359, buildCompiledNetworkMonitor names the managed network_monitors
-- row after its monitor definition (no prefix). Rows compiled earlier keep
-- "[monitor] <definition name>" until the definition is next edited;
-- verifyCompiled already tolerates that legacy form, so this is cosmetic
-- cleanup, not a drift repair.
--
-- Scope, deliberately narrow:
--   * only rows owned by a monitor definition (managed_by_monitor_id set), and
--   * only when the row's name is EXACTLY '[monitor] ' || <definition name> —
--     the value the pre-#7359 compiler wrote. The new name is the definition's
--     name, i.e. exactly what the next recompile would write. Hand-named rows,
--     unmanaged checks and any other "[monitor] ..." text are never touched.
--
-- Collisions: there is no uniqueness constraint on network_monitors.name, but
-- two checks with the same name in one list are indistinguishable to an
-- operator. A candidate is SKIPPED (left prefixed, reported by id) when the
-- plain name is already used by another check visible alongside it — same
-- org, or across an org and its partner's partner-wide checks — or by another
-- candidate in that scope. Skipped rows stay valid: verifyCompiled treats them
-- as in sync, and the operator can rename the definition to resolve it.
--
-- Only `name` and `updated_at` change; the topology trigger on this table
-- fires on asset_id/site_id only. Idempotent: a renamed row no longer matches
-- the '[monitor] ' || name predicate, so a re-run renames nothing.

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  r record;
  renamed integer := 0;
  skipped integer := 0;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  -- The cursor's snapshot is taken when the loop opens, so every collision
  -- flag below is computed against the pre-cleanup names regardless of the
  -- order rows are renamed in.
  FOR r IN
    WITH scoped AS (
      SELECT n.id,
             n.name,
             n.org_id,
             n.partner_id,
             n.managed_by_monitor_id,
             COALESCE(n.partner_id, o.partner_id) AS effective_partner_id
        FROM network_monitors n
        LEFT JOIN organizations o ON o.id = n.org_id
    ),
    candidates AS (
      SELECT s.*, d.name AS plain_name
        FROM scoped s
        JOIN monitor_definitions d ON d.id = s.managed_by_monitor_id
       WHERE s.managed_by_monitor_id IS NOT NULL
         AND s.name = '[monitor] ' || d.name
    )
    SELECT c.id,
           c.org_id,
           c.partner_id,
           c.plain_name,
           (
             -- Another check already carries the plain name in this scope.
             EXISTS (
               SELECT 1
                 FROM scoped other
                WHERE other.id <> c.id
                  AND other.name = c.plain_name
                  AND (
                    (c.org_id IS NOT NULL AND other.org_id = c.org_id)
                    OR (
                      (c.partner_id IS NOT NULL OR other.partner_id IS NOT NULL)
                      AND other.effective_partner_id = c.effective_partner_id
                    )
                  )
             )
             -- Or another candidate would be renamed to the same name.
             OR EXISTS (
               SELECT 1
                 FROM candidates sib
                WHERE sib.id <> c.id
                  AND sib.plain_name = c.plain_name
                  AND (
                    (c.org_id IS NOT NULL AND sib.org_id = c.org_id)
                    OR (
                      (c.partner_id IS NOT NULL OR sib.partner_id IS NOT NULL)
                      AND sib.effective_partner_id = c.effective_partner_id
                    )
                  )
             )
           ) AS collides
      FROM candidates c
     ORDER BY c.id
  LOOP
    IF r.collides THEN
      skipped := skipped + 1;
      RAISE WARNING 'network_monitors %: legacy "[monitor] " prefix kept; the plain name collides with another check (org %, partner %)',
        r.id, r.org_id, r.partner_id;
    ELSE
      UPDATE network_monitors
         SET name = r.plain_name,
             updated_at = now()
       WHERE id = r.id;
      renamed := renamed + 1;
    END IF;
  END LOOP;

  IF renamed > 0 OR skipped > 0 THEN
    RAISE WARNING 'network_monitors: stripped legacy "[monitor] " prefix from % managed network check(s); skipped % on name collision',
      renamed, skipped;
  END IF;
END $$;

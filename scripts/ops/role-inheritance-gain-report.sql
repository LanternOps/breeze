-- Role inheritance gain report (#9600 / #11702) — READ ONLY.
--
-- Before #9600 ships, a custom role's "Inherit From" parent granted nothing
-- at runtime. After it ships, each member of such a role gains every
-- permission its validated ancestors carry. This report lists, per region,
-- every role with a parent and exactly what it gains, so the deploy can be
-- judged before it widens live access.
--
-- One row per role whose parent_role_id is set:
--   role_id, scope, partner_id, org_id, is_system, parent_role_id
--   ancestors_honoured   validated ancestors the runtime will follow (0 when
--                        the declared parent is refused: other tenant, other
--                        scope, missing, or a cycle back to the role)
--   member_count         partner_users + organization_users rows on the role
--   active_member_count  the same, counting only users with status 'active'
--   gained_count / gained_permissions
--                        resource:action keys the lineage grants that the
--                        role's OWN rows do not (wildcards shown as stored,
--                        e.g. '*:*')
-- No names, emails or other free text: ids and permission keys only.
--
-- The walk is the one in apps/api/src/services/roleInheritance.ts
-- (walkLineages / isPermittedParentRole), restated in SQL:
--   * each hop's parent must exist, have the child's scope, and be either a
--     global built-in template (is_system, no partner, no org) or owned by the
--     child's partner (scope 'partner') / org (scope 'organization');
--   * a role id already in the lineage ends the walk (cycle-safe);
--   * at most 8 ancestors (MAX_ROLE_INHERITANCE_DEPTH);
--   * the first failed hop ends the walk; nothing past it is inherited.
-- roleInheritanceGainReport.integration.test.ts checks this file against the
-- TypeScript resolver on fixtures that exercise every rule above.
--
-- HOW TO RUN (on the region's host, from the compose directory):
--   docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -v ON_ERROR_STOP=1 -P pager=off < scripts/ops/role-inheritance-gain-report.sql
-- or against any connection string:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -P pager=off -f scripts/ops/role-inheritance-gain-report.sql
--
-- Why it elects system scope: roles, role_permissions, partner_users and
-- organization_users are FORCE ROW LEVEL SECURITY and breeze_current_scope()
-- defaults to 'none' (apps/api/migrations/README.md, "Writing rows requires
-- system scope first"). A connection that does not bypass RLS — breeze_app,
-- or a managed-Postgres admin role that is not a superuser — would otherwise
-- see ZERO roles and print an empty, reassuring report. The scope is set with
-- is_local = true inside a READ ONLY transaction that is rolled back, so the
-- session cannot write and nothing persists. The first result set
-- (visible_roles) shows how many roles the connection can see; if it is 0 on
-- a populated database, the report is not seeing the data.

BEGIN TRANSACTION READ ONLY;
SELECT set_config('breeze.scope', 'system', true) AS breeze_scope;

SELECT count(*) AS visible_roles,
       count(*) FILTER (WHERE parent_role_id IS NOT NULL) AS roles_with_parent
FROM roles;

WITH RECURSIVE lineage AS (
  SELECT r.id AS base_id,
         r.id AS role_id,
         r.scope,
         r.partner_id,
         r.org_id,
         r.parent_role_id,
         0 AS depth,
         ARRAY[r.id] AS path
  FROM roles r
  WHERE r.parent_role_id IS NOT NULL
  UNION ALL
  SELECT l.base_id,
         p.id,
         p.scope,
         p.partner_id,
         p.org_id,
         p.parent_role_id,
         l.depth + 1,
         l.path || p.id
  FROM lineage l
  JOIN roles p ON p.id = l.parent_role_id
  WHERE l.depth < 8
    AND NOT (p.id = ANY (l.path))
    AND p.scope = l.scope
    AND (
      (p.is_system AND p.partner_id IS NULL AND p.org_id IS NULL)
      OR (l.scope = 'partner' AND p.partner_id IS NOT NULL AND p.partner_id = l.partner_id)
      OR (l.scope = 'organization' AND p.org_id IS NOT NULL AND p.org_id = l.org_id)
    )
),
lineage_keys AS (
  SELECT DISTINCT l.base_id, perm.resource || ':' || perm.action AS perm_key
  FROM lineage l
  JOIN role_permissions rp ON rp.role_id = l.role_id
  JOIN permissions perm ON perm.id = rp.permission_id
),
own_keys AS (
  SELECT DISTINCT rp.role_id AS base_id, perm.resource || ':' || perm.action AS perm_key
  FROM role_permissions rp
  JOIN permissions perm ON perm.id = rp.permission_id
  WHERE rp.role_id IN (SELECT id FROM roles WHERE parent_role_id IS NOT NULL)
),
gains AS (
  SELECT lk.base_id, lk.perm_key
  FROM lineage_keys lk
  WHERE NOT EXISTS (
    SELECT 1 FROM own_keys ok WHERE ok.base_id = lk.base_id AND ok.perm_key = lk.perm_key
  )
),
members AS (
  SELECT m.role_id,
         count(*) AS member_count,
         count(*) FILTER (WHERE u.status = 'active') AS active_member_count
  FROM (
    SELECT pu.role_id, pu.user_id FROM partner_users pu
    UNION ALL
    SELECT ou.role_id, ou.user_id FROM organization_users ou
  ) m
  JOIN users u ON u.id = m.user_id
  GROUP BY m.role_id
)
SELECT r.id AS role_id,
       r.scope,
       r.partner_id,
       r.org_id,
       r.is_system,
       r.parent_role_id,
       (SELECT max(l.depth) FROM lineage l WHERE l.base_id = r.id) AS ancestors_honoured,
       COALESCE(m.member_count, 0) AS member_count,
       COALESCE(m.active_member_count, 0) AS active_member_count,
       (SELECT count(*) FROM gains g WHERE g.base_id = r.id) AS gained_count,
       COALESCE(
         (SELECT array_agg(g.perm_key ORDER BY g.perm_key) FROM gains g WHERE g.base_id = r.id),
         ARRAY[]::text[]
       ) AS gained_permissions
FROM roles r
LEFT JOIN members m ON m.role_id = r.id
WHERE r.parent_role_id IS NOT NULL
ORDER BY gained_count DESC, active_member_count DESC, r.scope, r.partner_id, r.org_id, r.id;

ROLLBACK;

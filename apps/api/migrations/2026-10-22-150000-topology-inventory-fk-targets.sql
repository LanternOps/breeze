-- @no-transaction
-- Existing inventory is hot: build supporting keys without blocking ordinary writes.
-- Failed builds must be verified invalid before standalone DROP INDEX CONCURRENTLY.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS devices_id_org_id_site_id_uniq
  ON public.devices (id, org_id, site_id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS discovered_assets_id_org_id_site_id_uniq
  ON public.discovered_assets (id, org_id, site_id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS topology_manual_nodes_id_org_id_site_id_uniq
  ON public.topology_manual_nodes (id, org_id, site_id);

DO $$
DECLARE target record;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('devices', 'devices_id_org_id_site_id_uniq'),
    ('discovered_assets', 'discovered_assets_id_org_id_site_id_uniq'),
    ('topology_manual_nodes', 'topology_manual_nodes_id_org_id_site_id_uniq')
  ) AS targets(table_name, index_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relname = target.index_name
        AND t.oid = to_regclass('public.' || target.table_name)
        AND i.indisunique AND i.indisvalid AND i.indisready
        AND i.indpred IS NULL AND i.indexprs IS NULL
        AND i.indnatts = 3 AND i.indnkeyatts = 3
        AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality)
          FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ordinality)
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        ) = ARRAY['id', 'org_id', 'site_id']::text[]
    ) THEN
      RAISE EXCEPTION 'Topology prerequisite index public.% is missing, invalid or has the wrong definition', target.index_name;
    END IF;
  END LOOP;
END $$;

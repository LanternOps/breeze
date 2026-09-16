-- Detach current inventory associations before legacy/direct writers move or
-- delete inventory. Historical nodes, manual facts and pins stay in their site.
CREATE OR REPLACE FUNCTION breeze_detach_topology_inventory_binding(
  inventory_kind text, inventory_id uuid, old_org_id uuid, old_site_id uuid,
  new_org_id uuid DEFAULT NULL, new_site_id uuid DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE entry record; binding record; detached integer := 0;
BEGIN
  IF inventory_kind NOT IN ('device', 'asset', 'manual') THEN
    RAISE EXCEPTION 'Invalid topology inventory kind' USING ERRCODE = '22023';
  END IF;
  -- An organization merge preserves sites. Its ambient prepare/finalize hooks
  -- fence and rekey the graph; detaching here would destroy accepted bindings.
  IF new_site_id IS NOT NULL AND new_site_id = old_site_id THEN RETURN 0; END IF;
  IF NOT EXISTS (SELECT 1 FROM topology_node_bindings b WHERE b.org_id = old_org_id AND b.site_id = old_site_id
    AND CASE inventory_kind WHEN 'device' THEN b.device_id = inventory_id
      WHEN 'asset' THEN b.discovered_asset_id = inventory_id ELSE b.manual_node_id = inventory_id END)
  THEN RETURN 0; END IF;
  -- Same order as the AFTER capture backstop, including opposite-site moves.
  -- A removed site needs no replacement state; dependent graph rows cascade.
  FOR entry IN SELECT s.org_id, s.id FROM sites s
    WHERE (s.org_id = old_org_id AND s.id = old_site_id)
       OR (s.org_id = new_org_id AND s.id = new_site_id)
    ORDER BY s.id, s.org_id LOOP
    INSERT INTO topology_site_state (org_id, site_id) VALUES (entry.org_id, entry.id) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM topology_site_state WHERE org_id = entry.org_id AND site_id = entry.id FOR UPDATE;
  END LOOP;
  FOR binding IN DELETE FROM topology_node_bindings b WHERE b.org_id = old_org_id AND b.site_id = old_site_id
    AND CASE inventory_kind WHEN 'device' THEN b.device_id = inventory_id
      WHEN 'asset' THEN b.discovered_asset_id = inventory_id ELSE b.manual_node_id = inventory_id END
    RETURNING b.id, b.node_id, b.provenance LOOP
    detached := detached + 1;
    INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, resource_id, result, initiated_by, details)
      VALUES (old_org_id, 'system', '00000000-0000-0000-0000-000000000000', 'topology.binding_detached',
        'topology_node', binding.node_id, 'success', 'automation', jsonb_build_object(
          'bindingId', binding.id, 'nodeId', binding.node_id, 'inventoryKind', inventory_kind, 'inventoryId', inventory_id,
          'oldOrgId', old_org_id, 'oldSiteId', old_site_id, 'newOrgId', new_org_id, 'newSiteId', new_site_id,
          'reason', CASE WHEN new_site_id IS NULL THEN 'inventory_deleted' ELSE 'inventory_moved' END));
  END LOOP;
  IF detached > 0 THEN
    UPDATE topology_site_state SET build_fence = build_fence + 1,
      graph_revision = graph_revision + 1, last_build_status = 'pending', updated_at = now()
      WHERE org_id = old_org_id AND site_id = old_site_id;
    -- The source's AFTER trigger advances dirty_revision and captures exactly
    -- one removal; this function must not allocate a duplicate source event.
  END IF;
  RETURN detached;
END $$;

CREATE OR REPLACE FUNCTION breeze_topology_inventory_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE inventory_kind text;
BEGIN
  inventory_kind := CASE TG_TABLE_NAME WHEN 'devices' THEN 'device'
    WHEN 'discovered_assets' THEN 'asset' WHEN 'topology_manual_nodes' THEN 'manual' END;
  IF TG_OP = 'DELETE' THEN
    PERFORM breeze_detach_topology_inventory_binding(inventory_kind, OLD.id, OLD.org_id, OLD.site_id);
    RETURN OLD;
  END IF;
  IF NEW.site_id IS DISTINCT FROM OLD.site_id THEN
    PERFORM breeze_detach_topology_inventory_binding(inventory_kind, OLD.id, OLD.org_id, OLD.site_id, NEW.org_id, NEW.site_id);
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE source_table text;
BEGIN
  FOREACH source_table IN ARRAY ARRAY['devices', 'discovered_assets', 'topology_manual_nodes'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = format('public.%I', source_table)::regclass
      AND tgname = 'breeze_topology_inventory_lifecycle') THEN
      EXECUTE format('CREATE TRIGGER breeze_topology_inventory_lifecycle BEFORE UPDATE OR DELETE ON %I
        FOR EACH ROW EXECUTE FUNCTION breeze_topology_inventory_lifecycle()', source_table);
    END IF;
  END LOOP;
END $$;

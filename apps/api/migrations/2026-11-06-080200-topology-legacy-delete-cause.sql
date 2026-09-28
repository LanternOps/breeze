-- M2 (#5998) D5: legacy collector-absence cause.
--
-- Legacy collector-absence cleanup (jobs/reconcileTopology.ts age-out deletes,
-- discoveryWorker speculative ethernet/routed cleanup) sets the
-- transaction-local GUC `breeze.topology_delete_cause = 'collector_absence'`
-- around its DELETEs (services/topology/legacyDeleteCause.ts). The capture
-- trigger records it on the relationship tombstone and legacy replay turns such
-- a tombstone into support expiry (lifecycle archived) instead of a deletion.
-- User/inventory deletes carry no cause and still withdraw.
--
-- Replaces two M0 function bodies (2026-10-22-150200 is shipped and never
-- edited); the triggers keep pointing at them. Writes no rows. Idempotent.
--
-- Changes vs M0: the validator accepts an optional `cause` (only
-- 'collector_absence', only on a network_topology relationship.delete); the
-- trigger captures DELETE of measured (lldp/cdp/fdb/unifi) rows — M0 captured
-- only manual rows, so an imported measured legacy relationship could never
-- age out — and stamps the cause.

CREATE OR REPLACE FUNCTION topology_validate_capture_event(event jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  kind text := event->>'type'; data jsonb := event->'data';
  fields text[]; required_fields text[]; field text; value jsonb; limit_chars integer;
  identity jsonb;
BEGIN
  IF jsonb_typeof(event) IS DISTINCT FROM 'object' OR octet_length(event::text) > 65536
    OR event - ARRAY['version','type','sourceTable','sourceId','oldIdentity','newIdentity','idempotencyKey','data','cause'] <> '{}'::jsonb
    OR NOT (event ?& ARRAY['version','type','sourceTable','sourceId','oldIdentity','newIdentity','idempotencyKey','data'])
    OR event->'version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(event->'idempotencyKey') IS DISTINCT FROM 'string'
    OR length(event->>'idempotencyKey') NOT BETWEEN 1 AND 256
    OR (event->>'sourceTable' IN ('topology_manual_nodes','topology_layout','network_topology','devices','discovered_assets','v2_intents')) IS NOT TRUE
  THEN RAISE EXCEPTION 'Invalid topology capture envelope' USING ERRCODE = '22023'; END IF;
  -- M2 D5: only a legacy relationship tombstone may carry a delete cause, and
  -- the only recorded cause is collector absence (never a user/inventory delete).
  IF event ? 'cause' AND (event->>'type' IS DISTINCT FROM 'relationship.delete' OR event->>'sourceTable' IS DISTINCT FROM 'network_topology'
    OR event->'cause' IS DISTINCT FROM '"collector_absence"'::jsonb)
  THEN RAISE EXCEPTION 'Invalid topology capture delete cause' USING ERRCODE = '22023'; END IF;
  PERFORM (event->>'sourceId')::uuid;
  IF event->>'sourceId' IS NULL THEN RAISE EXCEPTION 'Missing capture source UUID'; END IF;
  IF event->'oldIdentity' = 'null'::jsonb AND event->'newIdentity' = 'null'::jsonb THEN RAISE EXCEPTION 'Missing capture scope'; END IF;
  FOREACH field IN ARRAY ARRAY['oldIdentity','newIdentity'] LOOP
    identity := event->field;
    IF identity <> 'null'::jsonb THEN
      IF jsonb_typeof(identity) <> 'object' OR identity - ARRAY['orgId','siteId','sourceId'] <> '{}'::jsonb
        OR NOT (identity ?& ARRAY['orgId','siteId','sourceId']) OR identity->>'sourceId' IS DISTINCT FROM event->>'sourceId'
        OR identity->>'orgId' IS NULL OR identity->>'siteId' IS NULL
      THEN RAISE EXCEPTION 'Invalid capture source identity'; END IF;
      PERFORM (identity->>'orgId')::uuid, (identity->>'siteId')::uuid;
    END IF;
  END LOOP;
  IF (kind LIKE '%.upsert' AND event->'newIdentity' = 'null'::jsonb)
    OR (kind LIKE '%.delete' AND event->'oldIdentity' = 'null'::jsonb)
    OR (event->>'sourceTable' = 'topology_manual_nodes' AND kind NOT IN ('node.upsert','node.delete'))
    OR (event->>'sourceTable' = 'topology_layout' AND kind NOT IN ('layout.upsert','layout.delete'))
    OR (event->>'sourceTable' = 'network_topology' AND kind NOT IN ('relationship.upsert','relationship.delete'))
    OR (event->>'sourceTable' IN ('devices','discovered_assets') AND kind <> 'binding.changed')
  THEN RAISE EXCEPTION 'Topology capture source/type mismatch'; END IF;
  CASE kind
    WHEN 'node.delete', 'relationship.delete' THEN
      IF data IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Invalid capture tombstone'; END IF;
      RETURN;
    WHEN 'node.upsert' THEN
      fields := ARRAY['label','role','notes','createdBy']; required_fields := ARRAY['label','role'];
    WHEN 'relationship.upsert' THEN
      fields := ARRAY['sourceType','sourceId','targetType','targetId','connectionType','interfaceName','vlan','bandwidth','method','createdBy'];
      required_fields := ARRAY['sourceType','sourceId','targetType','targetId','connectionType','method'];
      IF data->>'method' IS DISTINCT FROM 'manual' THEN RAISE EXCEPTION 'Invalid capture relationship method'; END IF;
    WHEN 'layout.upsert' THEN
      fields := ARRAY['nodeType','nodeId','x','y','pinned','updatedBy']; required_fields := ARRAY['nodeType','nodeId','x','y','pinned'];
    WHEN 'layout.delete' THEN
      fields := ARRAY['nodeType','nodeId']; required_fields := fields;
    WHEN 'binding.changed' THEN
      IF data = 'null'::jsonb THEN RETURN; END IF;
      IF data->>'kind' = 'device' THEN
        fields := ARRAY['kind','hostname','displayName','deviceRole','osType','linkGroupId','linkGroupRole'];
        required_fields := ARRAY['kind','hostname','deviceRole','osType'];
      ELSIF data->>'kind' = 'asset' THEN
        fields := ARRAY['kind','hostname','label','ipAddress','macAddress','assetType','source','approvalStatus','linkedDeviceId','linkSource','autoLinkSuppressed','typeSource','detectedAssetType'];
        required_fields := ARRAY['kind','assetType','source','approvalStatus','autoLinkSuppressed','typeSource'];
      ELSE RAISE EXCEPTION 'Invalid inventory capture kind'; END IF;
      IF (event->>'sourceTable' = 'devices' AND data->>'kind' <> 'device')
        OR (event->>'sourceTable' = 'discovered_assets' AND data->>'kind' <> 'asset')
      THEN RAISE EXCEPTION 'Invalid inventory capture source'; END IF;
    ELSE RAISE EXCEPTION 'Invalid topology capture type';
  END CASE;
  IF jsonb_typeof(data) IS DISTINCT FROM 'object' OR data - fields <> '{}'::jsonb OR NOT (data ?& fields)
  THEN RAISE EXCEPTION 'Invalid topology capture data keys'; END IF;
  FOREACH field IN ARRAY fields LOOP
    value := data->field;
    IF value = 'null'::jsonb THEN
      IF field = ANY(required_fields) THEN RAISE EXCEPTION 'Missing topology capture field %', field; END IF;
      CONTINUE;
    END IF;
    IF field IN ('x','y','vlan','bandwidth') THEN
      IF jsonb_typeof(value) <> 'number' THEN RAISE EXCEPTION 'Invalid capture numeric field %', field; END IF;
      IF field IN ('x','y') AND abs((value::text)::numeric) > 1000000 THEN RAISE EXCEPTION 'Capture coordinates out of bounds'; END IF;
      IF field IN ('vlan','bandwidth') AND ((value::text)::numeric <> trunc((value::text)::numeric)
        OR (value::text)::numeric NOT BETWEEN -2147483648 AND 2147483647) THEN RAISE EXCEPTION 'Invalid capture integer'; END IF;
    ELSIF field IN ('pinned','autoLinkSuppressed') THEN
      IF jsonb_typeof(value) <> 'boolean' THEN RAISE EXCEPTION 'Invalid capture boolean'; END IF;
    ELSE
      IF jsonb_typeof(value) <> 'string' THEN RAISE EXCEPTION 'Invalid capture string %', field; END IF;
      IF field IN ('createdBy','updatedBy','nodeId','sourceId','targetId','linkedDeviceId','linkGroupId') THEN PERFORM (data->>field)::uuid; END IF;
      limit_chars := CASE
        WHEN field = 'notes' THEN 8192
        WHEN field IN ('label','hostname','displayName','interfaceName') THEN 255
        WHEN field IN ('role','ipAddress','macAddress') THEN 64
        WHEN field IN ('sourceType','targetType','connectionType') THEN 50
        WHEN field IN ('nodeType','assetType','detectedAssetType') THEN 32
        WHEN field = 'deviceRole' THEN 30
        WHEN field IN ('source','approvalStatus','linkSource','typeSource','osType','linkGroupRole','kind') THEN 16
        ELSE 64 END;
      IF length(data->>field) > limit_chars THEN RAISE EXCEPTION 'Topology capture field % exceeds limit', field; END IF;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION topology_capture_legacy_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb; new_row jsonb; old_data jsonb; new_data jsonb;
  old_identity jsonb; new_identity jsonb; event jsonb; entry record;
  mutation_id uuid := gen_random_uuid(); source_id uuid; prefix text;
  event_kind text; event_data jsonb; delete_cause text;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
  old_data := topology_capture_projection(TG_TABLE_NAME, old_row);
  new_data := topology_capture_projection(TG_TABLE_NAME, new_row);
  -- M2 D5: a measured legacy relationship (imported by the legacy snapshot) is
  -- captured on DELETE too, so its canonical projection can age out; upserts of
  -- measured rows stay uncaptured (the M2 collection pipeline owns them).
  IF TG_TABLE_NAME = 'network_topology' AND TG_OP = 'DELETE' AND old_data IS NULL
    AND old_row->>'method' IN ('lldp','cdp','fdb','unifi') THEN old_data := '{}'::jsonb; END IF;
  IF old_data IS NULL AND new_data IS NULL THEN RETURN NULL; END IF;
  -- A live/new source must resolve to its declared tenant/site. Only deletion
  -- may skip a missing parent during erasure; forged new scopes fail closed.
  IF new_data IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sites WHERE id = (new_row->>'site_id')::uuid AND org_id = (new_row->>'org_id')::uuid)
    AND NOT (TG_OP = 'UPDATE' AND old_row->>'site_id' = new_row->>'site_id' AND old_row->>'org_id' IS DISTINCT FROM new_row->>'org_id')
  THEN RAISE EXCEPTION 'Topology source site scope mismatch' USING ERRCODE = '23503'; END IF;
  -- Organization merges preserve site UUIDs. Their prepare/finalize hook owns
  -- rekeying existing site state and fencing imports, not a fake site move here.
  IF TG_OP = 'UPDATE' AND old_row->>'site_id' = new_row->>'site_id'
    AND old_row->>'org_id' IS DISTINCT FROM new_row->>'org_id' THEN RETURN NULL; END IF;
  IF old_data IS NOT DISTINCT FROM new_data AND old_row->>'site_id' IS NOT DISTINCT FROM new_row->>'site_id'
    AND old_row->>'org_id' IS NOT DISTINCT FROM new_row->>'org_id' THEN RETURN NULL; END IF;
  source_id := COALESCE(new_row->>'id', old_row->>'id')::uuid;
  IF old_data IS NOT NULL THEN old_identity := jsonb_build_object('orgId', old_row->'org_id', 'siteId', old_row->'site_id', 'sourceId', source_id); END IF;
  IF new_data IS NOT NULL THEN new_identity := jsonb_build_object('orgId', new_row->'org_id', 'siteId', new_row->'site_id', 'sourceId', source_id); END IF;
  -- One mutation can touch two sites. Acquire BOTH locks in UUID order before
  -- allocating either revision; opposite-direction single-row moves cannot deadlock.
  -- Missing parents during site/tenant cascades mean there is no surviving graph.
  FOR entry IN SELECT DISTINCT s.org_id, s.id AS site_id FROM sites s
    JOIN (VALUES (old_identity), (new_identity)) identities(identity)
      ON s.id = (identity->>'siteId')::uuid AND s.org_id = (identity->>'orgId')::uuid
    ORDER BY s.id, s.org_id LOOP
    INSERT INTO topology_site_state (org_id, site_id) VALUES (entry.org_id, entry.site_id) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM topology_site_state WHERE org_id = entry.org_id AND site_id = entry.site_id FOR UPDATE;
  END LOOP;
  prefix := CASE TG_TABLE_NAME WHEN 'topology_manual_nodes' THEN 'node' WHEN 'topology_layout' THEN 'layout'
    WHEN 'network_topology' THEN 'relationship' ELSE 'binding' END;
  FOR entry IN SELECT DISTINCT s.org_id, s.id AS site_id FROM sites s
    JOIN (VALUES (old_identity), (new_identity)) identities(identity)
      ON s.id = (identity->>'siteId')::uuid AND s.org_id = (identity->>'orgId')::uuid
    ORDER BY s.id, s.org_id LOOP
    IF new_identity IS NOT NULL AND entry.site_id = (new_identity->>'siteId')::uuid AND entry.org_id = (new_identity->>'orgId')::uuid THEN
      event_kind := CASE WHEN prefix = 'binding' THEN 'binding.changed' ELSE prefix || '.upsert' END;
      event_data := new_data;
    ELSE
      event_kind := CASE WHEN prefix = 'binding' THEN 'binding.changed' ELSE prefix || '.delete' END;
      event_data := CASE WHEN prefix = 'layout' THEN jsonb_build_object('nodeType', old_data->'nodeType', 'nodeId', old_data->'nodeId') ELSE 'null'::jsonb END;
    END IF;
    event := jsonb_build_object('version', 1, 'type', event_kind, 'sourceTable', TG_TABLE_NAME, 'sourceId', source_id,
      'oldIdentity', old_identity, 'newIdentity', new_identity, 'data', event_data,
      'idempotencyKey', 'legacy:' || mutation_id::text || ':' || entry.site_id::text);
    -- Transaction-local cause set by legacy collector-absence cleanup only.
    delete_cause := current_setting('breeze.topology_delete_cause', true);
    IF event_kind = 'relationship.delete' AND TG_OP = 'DELETE' AND delete_cause = 'collector_absence' THEN
      event := event || jsonb_build_object('cause', delete_cause);
    END IF;
    PERFORM topology_enqueue_change(entry.org_id, entry.site_id, event);
  END LOOP;
  RETURN NULL;
END $$;

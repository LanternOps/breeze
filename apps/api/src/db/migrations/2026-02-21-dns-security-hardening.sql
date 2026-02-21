BEGIN;

-- Ensure event IDs are always present so deduplication is guaranteed by schema.
UPDATE dns_security_events
SET provider_event_id = 'legacy-' || id::text
WHERE provider_event_id IS NULL OR btrim(provider_event_id) = '';

ALTER TABLE dns_security_events
  ALTER COLUMN provider_event_id SET NOT NULL;

-- Allow aggregate queries to filter by integration.
ALTER TABLE dns_event_aggregations
  ADD COLUMN IF NOT EXISTS integration_id uuid REFERENCES dns_filter_integrations(id);

CREATE INDEX IF NOT EXISTS dns_event_agg_org_date_integration_idx
  ON dns_event_aggregations (org_id, date DESC, integration_id);

CREATE INDEX IF NOT EXISTS dns_event_agg_integration_id_idx
  ON dns_event_aggregations (integration_id);

COMMIT;

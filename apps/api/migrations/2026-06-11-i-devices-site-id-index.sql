-- Site-axis queries (ticket site scoping, site device lists) filter on
-- devices.site_id; the FK alone creates no index.
CREATE INDEX IF NOT EXISTS devices_site_id_idx ON devices (site_id);

BEGIN;

-- Device approval schema: replace status enum with approvalStatus + isOnline

-- 1. New approval status enum
CREATE TYPE discovered_asset_approval_status AS ENUM ('pending', 'approved', 'dismissed');

-- 2. Add approval columns to discovered_assets
ALTER TABLE discovered_assets
  ADD COLUMN approval_status discovered_asset_approval_status NOT NULL DEFAULT 'pending',
  ADD COLUMN is_online boolean NOT NULL DEFAULT false,
  ADD COLUMN approved_by uuid REFERENCES users(id),
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN dismissed_by uuid REFERENCES users(id),
  ADD COLUMN dismissed_at timestamptz;

-- 3. Migrate existing status values
UPDATE discovered_assets SET approval_status = 'approved' WHERE status IN ('managed', 'identified');
UPDATE discovered_assets SET approval_status = 'dismissed', dismissed_at = ignored_at, dismissed_by = ignored_by WHERE status = 'ignored';
UPDATE discovered_assets SET is_online = true WHERE status NOT IN ('offline');
-- 'new' stays as default 'pending'

-- 4. Drop old ignored_by/ignored_at columns (data migrated above)
ALTER TABLE discovered_assets DROP COLUMN ignored_by;
ALTER TABLE discovered_assets DROP COLUMN ignored_at;

-- 5. Drop old status column
ALTER TABLE discovered_assets DROP COLUMN status;
DROP TYPE IF EXISTS discovered_asset_status;

-- 6. network_known_guests table
CREATE TABLE network_known_guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  mac_address varchar(17) NOT NULL,
  label varchar(255) NOT NULL,
  notes text,
  added_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX network_known_guests_partner_mac_unique ON network_known_guests(partner_id, mac_address);
CREATE INDEX network_known_guests_partner_id_idx ON network_known_guests(partner_id);

-- 7. Add alert_settings to discovery_profiles
ALTER TABLE discovery_profiles ADD COLUMN alert_settings jsonb;

-- 8. Add profile_id to network_change_events (nullable, alongside existing baseline_id)
ALTER TABLE network_change_events ADD COLUMN profile_id uuid REFERENCES discovery_profiles(id) ON DELETE SET NULL;
CREATE INDEX network_change_events_profile_id_idx ON network_change_events(profile_id);

COMMIT;

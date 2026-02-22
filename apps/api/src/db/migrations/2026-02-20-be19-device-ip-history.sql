BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ip_assignment_type') THEN
    CREATE TYPE ip_assignment_type AS ENUM ('dhcp', 'static', 'vpn', 'link-local', 'unknown');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS device_ip_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  interface_name varchar(100) NOT NULL,
  ip_address varchar(45) NOT NULL,
  ip_type varchar(4) NOT NULL DEFAULT 'ipv4',
  assignment_type ip_assignment_type NOT NULL DEFAULT 'unknown',
  mac_address varchar(17),
  subnet_mask varchar(45),
  gateway varchar(45),
  dns_servers text[],
  first_seen timestamp NOT NULL DEFAULT now(),
  last_seen timestamp NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  deactivated_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_ip_history_device_id_idx
  ON device_ip_history (device_id);

CREATE INDEX IF NOT EXISTS device_ip_history_org_id_idx
  ON device_ip_history (org_id);

CREATE INDEX IF NOT EXISTS device_ip_history_ip_address_idx
  ON device_ip_history (ip_address);

CREATE INDEX IF NOT EXISTS device_ip_history_first_seen_idx
  ON device_ip_history (first_seen);

CREATE INDEX IF NOT EXISTS device_ip_history_last_seen_idx
  ON device_ip_history (last_seen);

CREATE INDEX IF NOT EXISTS device_ip_history_is_active_idx
  ON device_ip_history (is_active);

CREATE INDEX IF NOT EXISTS device_ip_history_ip_time_idx
  ON device_ip_history (ip_address, first_seen, last_seen);

WITH active_ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY device_id, interface_name, ip_address, ip_type
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS rn
  FROM device_ip_history
  WHERE is_active = true
)
UPDATE device_ip_history
SET is_active = false, deactivated_at = now(), updated_at = now()
WHERE id IN (
  SELECT id
  FROM active_ranked
  WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS device_ip_history_active_assignment_uniq
  ON device_ip_history (device_id, interface_name, ip_address, ip_type)
  WHERE is_active = true;

COMMIT;

BEGIN;

CREATE TABLE IF NOT EXISTS browser_extensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  browser varchar(20) NOT NULL,
  extension_id varchar(255) NOT NULL,
  name varchar(255) NOT NULL,
  version varchar(80),
  source varchar(30) NOT NULL,
  permissions jsonb NOT NULL,
  risk_level varchar(20) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  first_seen_at timestamp NOT NULL,
  last_seen_at timestamp NOT NULL
);

CREATE INDEX IF NOT EXISTS browser_ext_org_device_idx
  ON browser_extensions (org_id, device_id);
CREATE INDEX IF NOT EXISTS browser_ext_extension_id_idx
  ON browser_extensions (extension_id);
CREATE INDEX IF NOT EXISTS browser_ext_risk_level_idx
  ON browser_extensions (org_id, risk_level);
CREATE UNIQUE INDEX IF NOT EXISTS browser_ext_org_device_browser_ext_uniq
  ON browser_extensions (org_id, device_id, browser, extension_id);

CREATE TABLE IF NOT EXISTS browser_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name varchar(200) NOT NULL,
  allowed_extensions jsonb,
  blocked_extensions jsonb,
  required_extensions jsonb,
  settings jsonb,
  target_type varchar(30) NOT NULL,
  target_ids jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS browser_policy_org_idx
  ON browser_policies (org_id);

CREATE TABLE IF NOT EXISTS browser_policy_violations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  policy_id uuid REFERENCES browser_policies(id),
  violation_type varchar(40) NOT NULL,
  details jsonb NOT NULL,
  detected_at timestamp NOT NULL,
  resolved_at timestamp
);

CREATE INDEX IF NOT EXISTS browser_policy_violations_org_device_idx
  ON browser_policy_violations (org_id, device_id);
CREATE INDEX IF NOT EXISTS browser_policy_violations_policy_idx
  ON browser_policy_violations (policy_id);
CREATE INDEX IF NOT EXISTS browser_policy_violations_unresolved_idx
  ON browser_policy_violations (org_id, resolved_at);

COMMIT;

CREATE TABLE IF NOT EXISTS os_vulnerabilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform VARCHAR(20) NOT NULL,
  os_line VARCHAR(120) NOT NULL,
  fixed_version VARCHAR(120) NOT NULL,
  vulnerability_id UUID NOT NULL REFERENCES vulnerabilities(id)
);

CREATE INDEX IF NOT EXISTS os_vuln_platform_os_line_idx
  ON os_vulnerabilities (platform, os_line);

CREATE INDEX IF NOT EXISTS os_vuln_vulnerability_idx
  ON os_vulnerabilities (vulnerability_id);

ALTER TABLE os_vulnerabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE os_vulnerabilities FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS os_vulnerabilities_system_only ON os_vulnerabilities;
CREATE POLICY os_vulnerabilities_system_only ON os_vulnerabilities
  USING (current_setting('breeze.scope', true) = 'system')
  WITH CHECK (current_setting('breeze.scope', true) = 'system');

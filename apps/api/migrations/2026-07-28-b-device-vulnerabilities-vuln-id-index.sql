-- Index device_vulnerabilities.vulnerability_id.
--
-- GET /vulnerabilities/:cveId/devices now narrows findings by vulnerability_id
-- in SQL (previously it fetched every fleet finding row and filtered by CVE in
-- JS); this index serves that lookup. Idempotent; safe to re-apply.
CREATE INDEX IF NOT EXISTS device_vuln_vulnerability_id_idx
  ON device_vulnerabilities (vulnerability_id);

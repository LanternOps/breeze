-- Security review #2 (H-2, Plan B): org-scoped verified domains for SSO. An org
-- proves DNS ownership before SSO may provision/JIT-link an email in it. RLS
-- shape 1 (direct org_id). Idempotent.
CREATE TABLE IF NOT EXISTS sso_verified_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  domain varchar(253) NOT NULL,
  verification_token varchar(128) NOT NULL,
  verified_at timestamp,
  last_checked_at timestamp,
  created_by uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sso_verified_domains_org_domain_idx
  ON sso_verified_domains (org_id, domain);

ALTER TABLE sso_verified_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_verified_domains FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='sso_verified_domains' AND policyname='sso_verified_domains_org_isolation') THEN
    CREATE POLICY sso_verified_domains_org_isolation ON sso_verified_domains
      USING (public.breeze_has_org_access(org_id))
      WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
END $$;

DO $$
DECLARE n integer;
BEGIN
  -- Built-in token (pgcrypto's gen_random_bytes is NOT installed — only pg_trgm
  -- is; gen_random_uuid is PG core). Two dash-stripped UUIDs = 64 hex chars.
  -- Seeded pending rows only; the app mints real tokens via crypto.randomBytes.
  INSERT INTO sso_verified_domains (org_id, domain, verification_token)
  SELECT DISTINCT p.org_id, lower(trim(d.domain)),
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  FROM sso_providers p
  CROSS JOIN LATERAL unnest(string_to_array(coalesce(p.allowed_domains, ''), ',')) AS d(domain)
  WHERE trim(d.domain) <> ''
  ON CONFLICT (org_id, domain) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'seeded % pending sso_verified_domains from allowed_domains', n; END IF;
END $$;

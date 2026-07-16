-- TD SYNNEX Nightly SFTP Price & Availability file ingest.
--
-- Two partner-axis (RLS shape 3) tables:
--   td_synnex_sftp_integrations  -- per-partner connector config, encrypted creds
--   td_synnex_price_availability -- the ingested P&A rows, one per (partner, sku)
--
-- No host column: the SFTP host is server-controlled via a region map in
-- services/tdSynnexSftpSync.ts, matching the EC Express connector. A partner
-- cannot point this connector at an arbitrary host.
--
-- The SFTP username and the remote filename are DERIVED from the account number
-- ('u' + accountNumber, and accountNumber + '.zip'), so neither is stored twice.

CREATE TABLE IF NOT EXISTS td_synnex_sftp_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  region VARCHAR(8) NOT NULL DEFAULT 'US',
  -- Account number is an identifier, not a credential: it is visible in the SFTP
  -- username and the remote filename, and both are derived from it. Only the
  -- password is encrypted (credentials.password), which keeps it on the existing
  -- SECRET_JSON_KEYS rotation path without adding a new key to that global set.
  account_number VARCHAR(32),
  credentials JSONB NOT NULL DEFAULT '{}'::jsonb,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_test_status VARCHAR(30),
  last_test_at TIMESTAMP,
  last_test_error TEXT,
  last_sync_at TIMESTAMP,
  last_sync_status VARCHAR(20),
  last_sync_error TEXT,
  last_file_name TEXT,
  last_row_count INTEGER,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS td_synnex_sftp_partner_uq
  ON td_synnex_sftp_integrations (partner_id);

ALTER TABLE td_synnex_sftp_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE td_synnex_sftp_integrations FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY td_synnex_sftp_partner_access
    ON td_synnex_sftp_integrations
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ingested price & availability rows. Superset of the EC Express SOAP shape
-- (TdSynnexEcProduct) so the two connectors stay conceptually aligned.
-- Trigram search. The whole point of this table is a SEARCHABLE catalog: the
-- EC Express SOAP lookup can only resolve one EXACT sku/part-no at a time, so
-- keyword/name/manufacturer search does not exist without this index. Plain
-- ILIKE '%term%' cannot use a btree, and at ~500k SKUs per partner a sequential
-- scan per keystroke is unusable — hence pg_trgm GIN.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS td_synnex_price_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  synnex_sku VARCHAR(64) NOT NULL,
  mfg_part_no VARCHAR(128),
  td_part_no VARCHAR(128),
  name TEXT,
  description TEXT,
  manufacturer VARCHAR(64),
  status VARCHAR(32),
  -- Spec field 40: A=Active, B=Special order, C=EOL, T=To be discontinued.
  -- Load-bearing for quoting — do not quote a 'C' without saying so.
  abc_code VARCHAR(8),
  currency VARCHAR(8),
  cost NUMERIC(12,4),
  cost_without_promo NUMERIC(12,4),
  msrp NUMERIC(12,4),
  map_price NUMERIC(12,4),
  total_qty INTEGER,
  warehouses JSONB NOT NULL DEFAULT '[]'::jsonb,
  weight NUMERIC(10,3),
  upc VARCHAR(32),
  unspsc VARCHAR(16),
  eta_date DATE,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  file_date DATE,
  synced_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS td_synnex_pa_partner_sku_uq
  ON td_synnex_price_availability (partner_id, synnex_sku);
CREATE INDEX IF NOT EXISTS td_synnex_pa_partner_mfg_idx
  ON td_synnex_price_availability (partner_id, mfg_part_no);
CREATE INDEX IF NOT EXISTS td_synnex_pa_partner_synced_idx
  ON td_synnex_price_availability (partner_id, synced_at);
CREATE INDEX IF NOT EXISTS td_synnex_pa_partner_upc_idx
  ON td_synnex_price_availability (partner_id, upc);

-- ONE concatenated search column with ONE GIN index, not one index per column.
-- An `a ILIKE x OR b ILIKE x OR c ILIKE x` chain over four separately-indexed
-- columns makes the planner prefer a parallel seq scan (measured: 300ms over
-- 200k rows) rather than a 4-way BitmapOr of GIN scans. Concatenating first
-- turns the query into a single indexable predicate. It also keeps the nightly
-- upsert cheap — four GIN indexes would be four index writes per changed SKU.
ALTER TABLE td_synnex_price_availability
  ADD COLUMN IF NOT EXISTS search_text TEXT
  GENERATED ALWAYS AS (
    COALESCE(name, '') || ' ' ||
    COALESCE(mfg_part_no, '') || ' ' ||
    COALESCE(synnex_sku, '') || ' ' ||
    COALESCE(manufacturer, '') || ' ' ||
    COALESCE(upc, '')
  ) STORED;

CREATE INDEX IF NOT EXISTS td_synnex_pa_search_trgm_idx
  ON td_synnex_price_availability USING GIN (search_text gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Indexed catalog search under RLS.
--
-- WHY THIS FUNCTION EXISTS (do not "simplify" it back into a plain query):
-- Postgres will not evaluate a NON-LEAKPROOF qual beneath an RLS security qual.
-- textlike/texticlike, trigram similarity and full-text @@ are ALL non-leakproof
-- (only `=` is leakproof). So on an RLS-forced table, ILIKE can never become an
-- index condition and the GIN index above is simply ignored — measured 300ms-2.1s
-- of sequential scan over 200k SKUs, versus 6-34ms once the index is usable.
--
-- The fix is a SECURITY DEFINER function owned by a role that is NOT subject to
-- the tenant policy, so no security qual is attached and the planner can use the
-- GIN index. Tenancy is then enforced INSIDE the function, from the same session
-- GUC that RLS itself reads (breeze_accessible_partner_ids()). The caller cannot
-- pass a partner_id — so this is not an app-layer fallback; it is the identical
-- predicate RLS would have applied, relocated to where the planner can use it.
--
-- The owner is a dedicated NOLOGIN role with a USING(true) policy rather than a
-- BYPASSRLS/superuser role, because production runs on DigitalOcean managed
-- Postgres where the admin role is NOT a superuser. A BYPASSRLS-based design
-- would silently return ZERO rows there while passing every local test.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE ROLE breeze_search NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT ON td_synnex_price_availability TO breeze_search;

DO $$ BEGIN
  CREATE POLICY td_synnex_pa_search_fn
    ON td_synnex_price_availability
    FOR SELECT TO breeze_search
    USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.breeze_search_td_synnex_pa(
  p_terms       TEXT[],
  p_in_stock    BOOLEAN DEFAULT FALSE,
  p_limit       INT     DEFAULT 50,
  p_offset      INT     DEFAULT 0
)
RETURNS SETOF public.td_synnex_price_availability
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
-- Pinned search_path: a SECURITY DEFINER function without this can be hijacked
-- by a caller-controlled search_path.
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_sql   TEXT;
  v_term  TEXT;
  v_conds TEXT := '';
BEGIN
  -- Fail closed: no terms => no rows, never "everything".
  IF p_terms IS NULL OR array_length(p_terms, 1) IS NULL THEN
    RETURN;
  END IF;

  FOREACH v_term IN ARRAY p_terms LOOP
    IF v_term IS NULL OR btrim(v_term) = '' THEN
      CONTINUE;
    END IF;
    -- Escape LIKE metacharacters, else a user typing '%' matches the whole
    -- catalog and '_' silently becomes a wildcard. format(%L) then quotes the
    -- literal, so the dynamic SQL below cannot be injected into.
    v_conds := v_conds || format(
      ' AND search_text ILIKE %L',
      '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    );
  END LOOP;

  IF v_conds = '' THEN
    RETURN;
  END IF;

  v_sql :=
    'SELECT * FROM public.td_synnex_price_availability'
    -- The tenancy predicate. Derived from the session GUC, NOT from any argument.
    || ' WHERE partner_id = ANY (public.breeze_accessible_partner_ids())'
    || v_conds;

  IF p_in_stock THEN
    v_sql := v_sql || ' AND total_qty > 0';
  END IF;

  -- In-stock first, then name. A discontinued/backordered SKU should not outrank
  -- one a tech can actually sell today.
  v_sql := v_sql
    || ' ORDER BY (total_qty > 0) DESC, name'
    || ' LIMIT '  || GREATEST(0, LEAST(p_limit, 200))::TEXT
    || ' OFFSET ' || GREATEST(0, p_offset)::TEXT;

  RETURN QUERY EXECUTE v_sql;
END;
$$;

-- Reassigning ownership requires the NEW owner (breeze_search) to hold CREATE on
-- the function's schema. Grant it just for the ALTER, then revoke immediately.
-- Without this a NOSUPERUSER migrator (e.g. DO-managed `doadmin`, and any
-- managed-Postgres self-hoster) fails the OWNER TO with `permission denied for
-- schema public` — a superuser bypasses the check, which is why this passed on
-- the docker-compose superuser (CI + local smoke) but broke on managed prod.
GRANT CREATE ON SCHEMA public TO breeze_search;

ALTER FUNCTION public.breeze_search_td_synnex_pa(TEXT[], BOOLEAN, INT, INT)
  OWNER TO breeze_search;

-- breeze_search only needs to OWN the SECURITY DEFINER function, never to create
-- objects in public; drop the temporary grant so the role stays minimal.
REVOKE CREATE ON SCHEMA public FROM breeze_search;

REVOKE ALL ON FUNCTION public.breeze_search_td_synnex_pa(TEXT[], BOOLEAN, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.breeze_search_td_synnex_pa(TEXT[], BOOLEAN, INT, INT) TO breeze_app;

ALTER TABLE td_synnex_price_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE td_synnex_price_availability FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY td_synnex_price_availability_partner_access
    ON td_synnex_price_availability
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

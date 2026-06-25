-- Per-session TLS verification + explicit scheme for the tunnel http-proxy (#1916).
-- scheme: 'http' | 'https' for proxy sessions (NULL for VNC / pre-existing rows).
-- skip_tls_verify: explicit per-session opt-out of cert verification for known
-- self-signed embedded LAN devices. Default false = verify (secure by default).

ALTER TABLE tunnel_sessions
  ADD COLUMN IF NOT EXISTS scheme varchar(5);

ALTER TABLE tunnel_sessions
  ADD COLUMN IF NOT EXISTS skip_tls_verify boolean NOT NULL DEFAULT false;

-- Constrain scheme to the two valid values (defense-in-depth; the app validates too).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tunnel_sessions_scheme_check'
  ) THEN
    ALTER TABLE tunnel_sessions
      ADD CONSTRAINT tunnel_sessions_scheme_check
      CHECK (scheme IS NULL OR scheme IN ('http', 'https'));
  END IF;
END $$;

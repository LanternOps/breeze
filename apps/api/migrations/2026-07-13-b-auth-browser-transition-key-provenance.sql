-- Retired browser-binding rows are security tombstones, not merely diagnostics.
-- Record signing-key provenance for diagnostics and a future coordinated
-- fleet-authoritative retirement protocol. Process-local keyring state is not
-- sufficient deletion authority; current cleanup retains all tombstones.
ALTER TABLE auth_browser_transitions
  ADD COLUMN IF NOT EXISTS binding_key_id varchar(128);

CREATE INDEX IF NOT EXISTS auth_browser_transitions_retired_cleanup_idx
  ON auth_browser_transitions (state, retired_at, binding_key_id);

-- SSO state is ephemeral authority tied to the transition. Once a transition
-- is safely deletable, dependent sessions/grants must not abort the entire
-- cleanup transaction. Reapplication is a no-op-equivalent constraint refresh.
ALTER TABLE sso_sessions
  DROP CONSTRAINT IF EXISTS sso_sessions_browser_transition_fk;
ALTER TABLE sso_sessions
  ADD CONSTRAINT sso_sessions_browser_transition_fk
  FOREIGN KEY (browser_transition_id)
  REFERENCES auth_browser_transitions (id)
  ON DELETE CASCADE;

ALTER TABLE sso_token_exchange_grants
  DROP CONSTRAINT IF EXISTS sso_token_exchange_grants_transition_fk;
ALTER TABLE sso_token_exchange_grants
  ADD CONSTRAINT sso_token_exchange_grants_transition_fk
  FOREIGN KEY (browser_transition_id)
  REFERENCES auth_browser_transitions (id)
  ON DELETE CASCADE;

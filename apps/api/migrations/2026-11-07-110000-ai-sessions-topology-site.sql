-- Topology M4 (W05 #6000), amendment M4-D2: a topology investigation session is
-- pinned to exactly ONE site, server-owned and immutable. Every topology AI
-- tool call, session list/search/count and replay authorizes against this
-- column; the client page context is never authority.
--
-- * Same-scope composite FK (topology_site_id, org_id) -> sites(id, org_id),
--   DEFERRABLE INITIALLY IMMEDIATE so org merge (SET CONSTRAINTS ALL DEFERRED,
--   separate re-points of ai_sessions and sites) never aborts with 23503.
-- * NO ON DELETE action: deleting a site never clears (or cascades into) the
--   pin — a site with topology investigation history cannot be silently
--   re-scoped. Org erasure deletes ai_sessions before sites (cascade order).
-- * `type = 'topology'` <=> pinned; the pin itself is immutable once written.
-- No rows are written by this migration.
ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS topology_site_id uuid;

ALTER TABLE ai_sessions DROP CONSTRAINT IF EXISTS ai_sessions_topology_site_fk;
ALTER TABLE ai_sessions ADD CONSTRAINT ai_sessions_topology_site_fk
  FOREIGN KEY (topology_site_id, org_id) REFERENCES sites (id, org_id) DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE ai_sessions DROP CONSTRAINT IF EXISTS ai_sessions_topology_site_type_chk;
ALTER TABLE ai_sessions ADD CONSTRAINT ai_sessions_topology_site_type_chk
  CHECK ((type = 'topology') = (topology_site_id IS NOT NULL));

-- Site filters run BEFORE list/search/count pagination and site deletes probe
-- the referencing side of the FK: index the pinned rows only.
CREATE INDEX IF NOT EXISTS ai_sessions_topology_site_idx
  ON ai_sessions (topology_site_id, org_id) WHERE topology_site_id IS NOT NULL;

CREATE OR REPLACE FUNCTION breeze_ai_sessions_topology_site_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.topology_site_id IS DISTINCT FROM OLD.topology_site_id THEN
  RAISE EXCEPTION 'ai_sessions.topology_site_id is immutable' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS breeze_ai_sessions_topology_site_guard ON ai_sessions;
CREATE TRIGGER breeze_ai_sessions_topology_site_guard BEFORE UPDATE OF topology_site_id ON ai_sessions
  FOR EACH ROW EXECUTE FUNCTION breeze_ai_sessions_topology_site_guard();

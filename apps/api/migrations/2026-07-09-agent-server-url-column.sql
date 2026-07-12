-- #2288: which control-plane URL each agent actually heartbeats to.
-- Reported by the agent in its heartbeat payload; powers the device-list
-- "Server" column so operators can watch a fleet migrate to a new URL.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_server_url varchar(512);

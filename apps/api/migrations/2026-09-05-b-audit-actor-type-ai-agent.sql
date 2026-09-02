-- AI agents wave 3 (#3824): audit rows for agent-originated action intents.
--
-- Without this the audit layer resolves an actor-less event to 'system'
-- (auditEvents.ts:68) — bucketing every agent proposal with the expiry reaper.
-- 'agent' is NOT reusable: it means the Go device agent.
--
-- This file contains ONLY the ALTER TYPE. Postgres forbids USING a value added
-- by ALTER TYPE ... ADD VALUE inside the same transaction, and autoMigrate
-- wraps each file in one — so any statement referencing 'ai_agent' must live in
-- a later file, not here.

ALTER TYPE public.actor_type ADD VALUE IF NOT EXISTS 'ai_agent';

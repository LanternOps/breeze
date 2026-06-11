-- Phase 2 SLA engine (spec §8a): index-backed sweep + queue SLA filters.
-- Sweep scans active, unpaused tickets ordered by created_at.
CREATE INDEX IF NOT EXISTS tickets_sla_sweep_idx
  ON tickets (created_at)
  WHERE status IN ('new', 'open') AND sla_paused_at IS NULL;

-- Breached-queue filter + stats count.
CREATE INDEX IF NOT EXISTS tickets_sla_breached_idx
  ON tickets (partner_id, status)
  WHERE sla_breached_at IS NOT NULL;

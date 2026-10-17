-- Add an 'unknown' security provider for a failed collection (#8538).
-- When every applicable AV source errored the agent cannot name a provider;
-- storing 'other' misattributed that to a real-but-unmapped product (#7965,
-- #8043, #8272). 'unknown' is the not-collected value. No row writes: existing
-- 'other' rows are left alone (they cannot be told apart retroactively) and the
-- next collection rewrites them.
-- ADD VALUE IF NOT EXISTS makes the statement a no-op on re-apply.
ALTER TYPE security_provider ADD VALUE IF NOT EXISTS 'unknown';

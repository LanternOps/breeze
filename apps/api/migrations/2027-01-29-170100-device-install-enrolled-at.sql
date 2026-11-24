-- #8318 wave T2 (review): when the CURRENT install of a device row enrolled.
--
-- devices.enrolled_at is the row's first enrollment and never moves; a
-- re-enroll onto the same row (an agent that presented that row's own token,
-- routes/agents/enrollment.ts) installs a new agent on it but keeps every
-- device_hardware column, the TPM key baseline included. TPM reattach evidence
-- (services/deviceReattach/evidence.ts) must count only a key proof made by
-- the install that is there now, so it compares the proof with this column.
--
-- Nullable, no backfill: a metadata-only ALTER on the hot devices table.
-- Existing rows stay NULL and fall back to enrolled_at (their behaviour so
-- far); the default then stamps every new row, and the re-enroll UPDATE sets
-- it explicitly. SET DEFAULT after ADD COLUMN, so existing rows are not given
-- the migration's time. Existing RLS policies on devices cover the column;
-- export policy: included. Writes no rows, so no breeze.scope election.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS install_enrolled_at timestamptz;
ALTER TABLE devices ALTER COLUMN install_enrolled_at SET DEFAULT now();

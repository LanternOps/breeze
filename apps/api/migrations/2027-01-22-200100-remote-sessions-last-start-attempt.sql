-- #11149: when the session's latest start attempt happened.
--
-- A WebRTC reconnect moves a live session back to `connecting` on the same row.
-- started_at must stay on the original start, because the lease hard deadline is
-- measured from it (#11113), and created_at never moves. Keying stale cleanup and
-- the pending/connecting reaper on either one can end a session while its viewer
-- is renegotiating. They key on this column instead.

SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE remote_sessions ADD COLUMN IF NOT EXISTS last_start_attempt_at timestamptz;

-- started_at and created_at are zone-less columns holding UTC. Without the
-- explicit conversion, the backfill would shift by the session's TimeZone.
UPDATE remote_sessions
   SET last_start_attempt_at = COALESCE(started_at, created_at) AT TIME ZONE 'UTC'
 WHERE last_start_attempt_at IS NULL;

ALTER TABLE remote_sessions ALTER COLUMN last_start_attempt_at SET DEFAULT now();
ALTER TABLE remote_sessions ALTER COLUMN last_start_attempt_at SET NOT NULL;

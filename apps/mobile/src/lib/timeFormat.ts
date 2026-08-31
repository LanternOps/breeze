/**
 * Duration formatting for the time-tracking surfaces.
 *
 * Pure module (no React Native imports) so both the timer bar and the
 * timesheet share one implementation and it stays unit-testable.
 */

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Running-timer clock, HH:MM:SS.
 *
 * Hours are NOT wrapped at 24: a timer left running overnight is a real and
 * expensive field mistake, and rolling back to 00:00:0x would hide it at
 * exactly the moment the technician needs to see it.
 */
export function formatElapsed(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(safe % 60)}`;
}

/**
 * Logged duration. `null`/`undefined` renders as an em dash rather than "0m":
 * a still-running entry has `durationMinutes: null`, and showing zero would
 * claim the technician has logged nothing on it.
 */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  const safe = Math.max(0, Math.round(minutes));
  if (safe < 60) return `${safe}m`;
  return `${Math.floor(safe / 60)}h ${pad2(safe % 60)}m`;
}

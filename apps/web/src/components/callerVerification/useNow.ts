import { useEffect, useState } from 'react';

/**
 * Current time, refreshed every `intervalMs`, so time-bound claims (a grant's
 * `usableUntil`) lapse on screen without waiting for a reload or a poll.
 */
export function useNow(intervalMs = 15000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

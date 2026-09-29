import { TIME_SYNC_STALE_AFTER_MS } from '@breeze/shared';
export function isTimeStatusStale(receivedAt: Date, now: Date): boolean {
  return now.getTime() - receivedAt.getTime() > TIME_SYNC_STALE_AFTER_MS;
}

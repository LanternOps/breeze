import { describe, it, expect } from 'vitest';
import { isIntervalScheduleDue } from './discoveryWorker';
import { withHostTimeZone } from '../testUtils/hostTimeZone';

/**
 * Interval-scheduled network discovery must not depend on the API host's zone.
 *
 * `discovery_jobs.scheduled_at` / `.created_at` are offsetless `timestamp`
 * columns. Drizzle decodes them as UTC, so the worker receives the stored
 * instant, which is what these fixtures build. The elapsed interval is then a
 * plain `now - last`. Each case runs on a host west and east of UTC; moving the
 * Date by the host offset would hold a due profile back on one side and run it
 * early on the other.
 */

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-06-10T12:00:00Z');
/** A 60-minute interval profile. */
const THRESHOLD = 60 * 60 * 1000;
const HOSTS = ['America/Denver', 'Asia/Tokyo'] as const;

describe('isIntervalScheduleDue — discovery_jobs timestamps on any API host', () => {
  it.each(HOSTS)('is due when the last run is older than the interval, on a %s host', (zone) => {
    withHostTimeZone(zone, () => {
      // Ran 90 minutes ago.
      expect(isIntervalScheduleDue(new Date(NOW.getTime() - 1.5 * HOUR), NOW, THRESHOLD)).toBe(true);
    });
  });

  it.each(HOSTS)('is not due when the last run is inside the interval, on a %s host', (zone) => {
    withHostTimeZone(zone, () => {
      // Ran 30 minutes ago.
      expect(isIntervalScheduleDue(new Date(NOW.getTime() - 0.5 * HOUR), NOW, THRESHOLD)).toBe(false);
    });
  });

  it('is due exactly at the interval boundary', () => {
    expect(isIntervalScheduleDue(new Date(NOW.getTime() - THRESHOLD), NOW, THRESHOLD)).toBe(true);
  });

  it('a profile that has never run is always due', () => {
    expect(isIntervalScheduleDue(null, NOW, THRESHOLD)).toBe(true);
  });

  it.each(HOSTS)('measures the real elapsed time, on a %s host', (zone) => {
    withHostTimeZone(zone, () => {
      for (const elapsedMinutes of [0, 15, 59, 60, 61, 120, 24 * 60]) {
        const last = new Date(NOW.getTime() - elapsedMinutes * 60_000);
        expect(
          isIntervalScheduleDue(last, NOW, THRESHOLD),
          `${elapsedMinutes} minutes elapsed against a 60-minute interval`,
        ).toBe(elapsedMinutes >= 60);
      }
    });
  });
});

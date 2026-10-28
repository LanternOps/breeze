import { describe, expect, it } from 'vitest';

import {
  DNS_EVENTS_DEFAULT_WINDOW_DAYS,
  decodeDnsEventsCursor,
  encodeDnsEventsCursor,
  resolveDnsEventsWindow,
} from './dnsSecurityEventsPage';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-10-28T12:00:00.000Z');
const ID = '0b5d0f4e-1c2a-4d3b-9e8f-7a6b5c4d3e2f';

describe('dns events cursor', () => {
  it('round-trips a microsecond timestamp and id', () => {
    const cursor = { ts: '2026-10-27T23:59:59.123456', id: ID };
    expect(decodeDnsEventsCursor(encodeDnsEventsCursor(cursor))).toEqual(cursor);
  });

  it('is opaque url-safe text', () => {
    expect(encodeDnsEventsCursor({ ts: '2026-10-27T23:59:59.123456', id: ID })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['not base64 json', '!!!'],
    ['json but not an object', Buffer.from('"x"').toString('base64url')],
    ['missing id', Buffer.from(JSON.stringify({ ts: '2026-10-27T23:59:59.123456' })).toString('base64url')],
    ['id is not a uuid', Buffer.from(JSON.stringify({ ts: '2026-10-27T23:59:59.123456', id: 'x' })).toString('base64url')],
    ['ts carries a timezone', Buffer.from(JSON.stringify({ ts: '2026-10-27T23:59:59.123456Z', id: ID })).toString('base64url')],
    ['ts is sql', Buffer.from(JSON.stringify({ ts: "2026-10-27'); --", id: ID })).toString('base64url')],
  ])('rejects %s', (_label, raw) => {
    expect(decodeDnsEventsCursor(raw)).toBeNull();
  });
});

describe('resolveDnsEventsWindow', () => {
  it(`defaults to the last ${DNS_EVENTS_DEFAULT_WINDOW_DAYS} days when no bound is given`, () => {
    const result = resolveDnsEventsWindow(null, null, NOW);
    expect(result).toEqual({
      ok: true,
      start: new Date(NOW.getTime() - DNS_EVENTS_DEFAULT_WINDOW_DAYS * DAY_MS),
      end: null,
    });
  });

  it('anchors the default start on an explicit end', () => {
    const end = new Date('2026-09-01T00:00:00.000Z');
    const result = resolveDnsEventsWindow(null, end, NOW);
    expect(result).toEqual({
      ok: true,
      start: new Date(end.getTime() - DNS_EVENTS_DEFAULT_WINDOW_DAYS * DAY_MS),
      end,
    });
  });

  it('keeps an explicit start with an open end', () => {
    const start = new Date(NOW.getTime() - 30 * DAY_MS);
    expect(resolveDnsEventsWindow(start, null, NOW)).toEqual({ ok: true, start, end: null });
  });

  it('rejects an open-ended start older than the 90-day ceiling', () => {
    const start = new Date(NOW.getTime() - 91 * DAY_MS);
    expect(resolveDnsEventsWindow(start, null, NOW)).toEqual({
      ok: false,
      error: 'Time range cannot exceed 90 days',
    });
  });

  it('rejects an explicit range wider than 90 days', () => {
    const end = new Date('2026-10-01T00:00:00.000Z');
    const start = new Date(end.getTime() - 91 * DAY_MS);
    expect(resolveDnsEventsWindow(start, end, NOW)).toEqual({
      ok: false,
      error: 'Time range cannot exceed 90 days',
    });
  });

  it('rejects start after end', () => {
    expect(resolveDnsEventsWindow(NOW, new Date(NOW.getTime() - 1), NOW)).toEqual({
      ok: false,
      error: 'start must be before or equal to end',
    });
  });

  it('does not reject an open-ended start slightly in the future (clock skew is an empty page, not an error)', () => {
    const start = new Date(NOW.getTime() + 5_000);
    expect(resolveDnsEventsWindow(start, null, NOW)).toEqual({ ok: true, start, end: null });
  });
});

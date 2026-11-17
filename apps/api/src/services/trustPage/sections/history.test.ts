import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => ({ queue: [] as unknown[][] }));
vi.mock('../../../db', () => {
  const c: any = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) c[m] = vi.fn(() => c);
  c.then = (r: any) => Promise.resolve(rows.queue.shift() ?? []).then(r);
  return { db: c };
});

import { resolveFrozenConfig, trustPublishedConfigSchema } from '@breeze/shared';
import { buildHistory } from './history';
import type { SectionBuildContext } from './types';

const asOf = new Date('2026-10-17T00:00:00Z');
const day = (n: number) => new Date(asOf.getTime() - n * 86_400_000);
const config = (over: Record<string, unknown> = {}) => resolveFrozenConfig(trustPublishedConfigSchema.parse({
  hiddenControlIds: [], showPercentages: false, showDeviceCount: false, showManagedBy: true, searchIndexable: false,
  introHtml: null, websiteUrl: null, securityContactEmail: null, documentIds: [], ...over,
}));
const ctx = (over: Record<string, unknown> = {}): SectionBuildContext => ({ page: { id: 'pg' } as never, asOf, partnerName: 'MSP', config: config(over), documents: [] });
// The columns come back as text (->>, no SQL cast): parsing happens in buildHistory so one bad row cannot throw.
const pt = (d: Date, met: number, shown: number) => ({ generatedAt: d, met: String(met), shown: String(shown) });

// payloadSha256 ignoring history is asserted in payloadBuilder.test.ts ("sha256 ignores history ...").
describe('buildHistory', () => {
  beforeEach(() => { rows.queue = []; });

  it('is empty unless the frozen config opted in, without touching the database', async () => {
    rows.queue = [[pt(day(1), 3, 16)]];
    expect(await buildHistory(ctx({ showHistory: false }))).toEqual([]);
    expect(rows.queue).toHaveLength(1);
  });

  it('keeps the newest pre-window point as a baseline and drops older ones (rows arrive window, then baseline)', async () => {
    rows.queue = [
      [pt(day(30), 5, 16), pt(day(10), 6, 16)],
      [pt(day(95), 2, 15)],
    ];
    const out = await buildHistory(ctx({ showHistory: true }));
    expect(out).toEqual([
      { at: day(95).toISOString(), met: 2, shown: 15 },
      { at: day(30).toISOString(), met: 5, shown: 16 },
      { at: day(10).toISOString(), met: 6, shown: 16 },
    ]);
  });

  it('collapses consecutive equal (met, shown) pairs, keeping the first, and skips unreadable rows', async () => {
    rows.queue = [
      [pt(day(40), 5, 16), pt(day(30), 5, 16), { generatedAt: day(25), met: null, shown: null }, pt(day(20), 6, 16), pt(day(10), 5, 16), pt(day(5), 5, 16)],
      [],
    ];
    const out = await buildHistory(ctx({ showHistory: true }));
    expect(out.map((p) => [p.met, p.shown])).toEqual([[5, 16], [6, 16], [5, 16]]);
    expect(out[0]!.at).toBe(day(40).toISOString());
  });

  it('skips every unreadable row (non-integer, negative, null, unsafe), reports the count once, and keeps good rows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const raw = (d: Date, met: string | null, shown: string | null) => ({ generatedAt: d, met, shown });
      rows.queue = [
        [
          raw(day(50), 'x', '16'),
          raw(day(40), '2.5', '16'),
          raw(day(30), null, '16'),
          raw(day(20), '99999999999999999999', '16'),
          raw(day(15), '-1', '16'),
          raw(day(10), '3', '5'),
        ],
        [raw(day(95), '1e2', '16')],
      ];
      const out = await buildHistory(ctx({ showHistory: true }));
      expect(out).toEqual([{ at: day(10).toISOString(), met: 3, shown: 5 }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[trustPage] history skipped unreadable snapshots', { pageId: 'pg', skipped: 6 });
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when every row is readable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      rows.queue = [[pt(day(10), 3, 5)], []];
      await buildHistory(ctx({ showHistory: true }));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('caps at 200 points, keeping the newest', async () => {
    const many = Array.from({ length: 300 }, (_, i) => pt(new Date(asOf.getTime() - (300 - i) * 60_000), i, 16));
    rows.queue = [many, []];
    const out = await buildHistory(ctx({ showHistory: true }));
    expect(out).toHaveLength(200);
    expect(out[199]!.met).toBe(299);
    expect(out[0]!.met).toBe(100);
  });
});

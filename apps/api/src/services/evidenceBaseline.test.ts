import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rows, failNext } = vi.hoisted(() => ({ rows: [] as unknown[], failNext: { value: false } }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const k of ['select', 'from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
    chain[k] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
    if (failNext.value) { failNext.value = false; return Promise.reject(new Error('db down')).then(res, rej); }
    return Promise.resolve(rows.shift() ?? []).then(res, rej);
  };
  return { db: chain };
});

import { previousOccurrenceBaselineFor } from './evidenceBaseline';

describe('previousOccurrenceBaselineFor', () => {
  beforeEach(() => { rows.length = 0; failNext.value = false; vi.spyOn(console, 'error').mockImplementation(() => {}); });

  it('returns the prior occurrence run summary for the SAME deliverable', async () => {
    rows.push([{ summary: { openCritical: 4 }, generatedAt: '2026-08-31T05:18:00Z', completedAt: new Date('2026-08-31T05:19:00Z') }]);
    const got = await previousOccurrenceBaselineFor({ deliverableId: 'd1', currentPeriodStart: '2026-09-01' });
    expect(got).toEqual({ generatedAt: '2026-08-31T05:18:00Z', summary: { openCritical: 4 } });
  });

  it('falls back to completedAt when the stored result has no generatedAt', async () => {
    rows.push([{ summary: { n: 1 }, generatedAt: null, completedAt: new Date('2026-08-31T05:19:00Z') }]);
    const got = await previousOccurrenceBaselineFor({ deliverableId: 'd1', currentPeriodStart: '2026-09-01' });
    expect(got).toEqual({ generatedAt: '2026-08-31T05:19:00.000Z', summary: { n: 1 } });
  });

  it('returns undefined when there is no prior occurrence run', async () => {
    expect(await previousOccurrenceBaselineFor({ deliverableId: 'd1', currentPeriodStart: '2026-09-01' })).toBeUndefined();
  });

  it('returns undefined when the prior run carries no usable summary', async () => {
    rows.push([{ summary: 'not-an-object', generatedAt: null, completedAt: null }]);
    expect(await previousOccurrenceBaselineFor({ deliverableId: 'd1', currentPeriodStart: '2026-09-01' })).toBeUndefined();
  });

  it('returns undefined rather than throwing when the lookup fails', async () => {
    failNext.value = true;
    expect(await previousOccurrenceBaselineFor({ deliverableId: 'd1', currentPeriodStart: '2026-09-01' })).toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});

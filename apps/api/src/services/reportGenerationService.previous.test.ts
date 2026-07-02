import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));

import { db } from '../db';
import { previousBaselineFor } from './reportGenerationService';

const REPORT_ID = '00000000-0000-0000-0000-000000000001';

/** Thenable that resolves to `rows` and supports any drizzle chain method. */
function selectChain(rows: unknown[]) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'where', 'orderBy', 'limit']) {
    p[m] = () => p;
  }
  return p;
}

describe('previousBaselineFor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the prior completed run\'s generatedAt + summary', async () => {
    const m = vi.mocked(db.select);
    m.mockReturnValueOnce(
      selectChain([
        {
          result: { summary: { postureScore: 74 }, generatedAt: '2026-06-01T09:00:00Z' },
          completedAt: new Date('2026-06-01T09:05:00Z'),
        },
      ]),
    );

    const previous = await previousBaselineFor(REPORT_ID);

    expect(previous).toEqual({ generatedAt: '2026-06-01T09:00:00Z', summary: { postureScore: 74 } });
  });

  it('falls back to completedAt when the stored result has no generatedAt', async () => {
    const m = vi.mocked(db.select);
    m.mockReturnValueOnce(
      selectChain([
        {
          result: { summary: { postureScore: 74 } },
          completedAt: new Date('2026-06-01T09:05:00Z'),
        },
      ]),
    );

    const previous = await previousBaselineFor(REPORT_ID);

    expect(previous).toEqual({ generatedAt: '2026-06-01T09:05:00.000Z', summary: { postureScore: 74 } });
  });

  it('returns undefined when no prior run exists', async () => {
    const m = vi.mocked(db.select);
    m.mockReturnValueOnce(selectChain([]));

    const previous = await previousBaselineFor(REPORT_ID);

    expect(previous).toBeUndefined();
  });

  it('returns undefined when the prior run has no summary', async () => {
    const m = vi.mocked(db.select);
    m.mockReturnValueOnce(
      selectChain([
        { result: { rows: [{ hostname: 'PC-1' }] }, completedAt: new Date('2026-06-01T09:05:00Z') },
      ]),
    );

    const previous = await previousBaselineFor(REPORT_ID);

    expect(previous).toBeUndefined();
  });

  it('returns undefined when the prior run has no result at all', async () => {
    const m = vi.mocked(db.select);
    m.mockReturnValueOnce(selectChain([{ result: null, completedAt: new Date('2026-06-01T09:05:00Z') }]));

    const previous = await previousBaselineFor(REPORT_ID);

    expect(previous).toBeUndefined();
  });
});

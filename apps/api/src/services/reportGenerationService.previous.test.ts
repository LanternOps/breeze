import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));

import { db } from '../db';
import { previousBaselineFor } from './reportGenerationService';

const REPORT_ID = '00000000-0000-0000-0000-000000000001';
const SCOPE_FINGERPRINT = 'a'.repeat(64);
const OTHER_SCOPE_FINGERPRINT = 'b'.repeat(64);
const whereConditions: unknown[] = [];

/** Thenable that resolves to `rows` and supports any drizzle chain method. */
function selectChain(rows: unknown[]) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'orderBy', 'limit']) {
    p[m] = () => p;
  }
  p.where = (condition: unknown) => {
    whereConditions.push(condition);
    return p;
  };
  return p;
}

describe('previousBaselineFor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    whereConditions.length = 0;
  });

  it('returns the prior completed run\'s generatedAt + summary', async () => {
    const m = vi.mocked(db.select);
    m.mockReturnValueOnce(
      selectChain([
        {
          summary: { postureScore: 74 },
          generatedAt: '2026-06-01T09:00:00Z',
          completedAt: new Date('2026-06-01T09:05:00Z'),
        },
      ]),
    );

    const previous = await previousBaselineFor(REPORT_ID, SCOPE_FINGERPRINT);

    expect(previous).toEqual({ generatedAt: '2026-06-01T09:00:00Z', summary: { postureScore: 74 } });
    const rendered = new PgDialect().sqlToQuery(whereConditions[0] as SQL);
    expect(rendered.params).toContain(REPORT_ID);
    expect(rendered.params).toContain('completed');
    expect(rendered.params).toContain(SCOPE_FINGERPRINT);
    expect(rendered.params).not.toContain(OTHER_SCOPE_FINGERPRINT);
  });

  it('falls back to completedAt when the stored result has no generatedAt', async () => {
    const m = vi.mocked(db.select);
    m.mockReturnValueOnce(
      selectChain([
        {
          summary: { postureScore: 74 },
          generatedAt: null,
          completedAt: new Date('2026-06-01T09:05:00Z'),
        },
      ]),
    );

    const previous = await previousBaselineFor(REPORT_ID, SCOPE_FINGERPRINT);

    expect(previous).toEqual({ generatedAt: '2026-06-01T09:05:00.000Z', summary: { postureScore: 74 } });
  });

  it('returns undefined when no prior run exists', async () => {
    const m = vi.mocked(db.select);
    m.mockReturnValueOnce(selectChain([]));

    const previous = await previousBaselineFor(REPORT_ID, SCOPE_FINGERPRINT);

    expect(previous).toBeUndefined();
  });

  it('does not fall back to a completed run from another immutable scope fingerprint', async () => {
    const m = vi.mocked(db.select);
    m.mockReturnValueOnce(selectChain([]));

    const previous = await previousBaselineFor(
      REPORT_ID,
      SCOPE_FINGERPRINT,
    );

    expect(previous).toBeUndefined();
    const rendered = new PgDialect().sqlToQuery(whereConditions[0] as SQL);
    expect(rendered.params).toContain(SCOPE_FINGERPRINT);
    expect(rendered.params).not.toContain(OTHER_SCOPE_FINGERPRINT);
  });

  it('returns undefined when the prior run has no summary', async () => {
    const m = vi.mocked(db.select);
    m.mockReturnValueOnce(
      selectChain([
        { summary: null, generatedAt: null, completedAt: new Date('2026-06-01T09:05:00Z') },
      ]),
    );

    const previous = await previousBaselineFor(REPORT_ID, SCOPE_FINGERPRINT);

    expect(previous).toBeUndefined();
  });

  it('returns undefined when the prior run has no result at all', async () => {
    const m = vi.mocked(db.select);
    m.mockReturnValueOnce(
      selectChain([{ summary: null, generatedAt: null, completedAt: new Date('2026-06-01T09:05:00Z') }]),
    );

    const previous = await previousBaselineFor(REPORT_ID, SCOPE_FINGERPRINT);

    expect(previous).toBeUndefined();
  });

  it('returns undefined (not a throw) when the select fails', async () => {
    const m = vi.mocked(db.select);
    m.mockImplementationOnce(() => {
      throw new Error('connection reset');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const previous = await previousBaselineFor(REPORT_ID, SCOPE_FINGERPRINT);

    expect(previous).toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      '[reports] previous-baseline lookup failed',
      { reportId: REPORT_ID },
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});

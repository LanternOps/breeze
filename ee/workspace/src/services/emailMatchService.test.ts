// Tiered .eml matcher for the Outlook filing panel (W4): given the open
// message's subject/sender/date (and, when Graph hands us one, its
// internetMessageId), answer which crawled .eml file it is. Mocked db exec —
// see filing.integration.test.ts for the real-DB seed pattern this mirrors.
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../hostTypes';
import { createEmailMatchService, normalizeSubject } from './emailMatchService';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

/**
 * Values reachable from a raw drizzle sql template. Raw templates store bound
 * params as bare primitives between StringChunks (crawlRunsService.test.ts /
 * activityService.test.ts convention), so primitives count as bound values here.
 */
function boundValues(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (item && typeof item === 'object' ? boundValues(item) : [item]));
  }
  if (!value || typeof value !== 'object') return [];
  const candidate = value as { value?: unknown; queryChunks?: unknown[] };
  const own = Object.prototype.hasOwnProperty.call(candidate, 'value')
    ? (Array.isArray(candidate.value) ? candidate.value : [candidate.value])
    : [];
  return [
    ...own,
    ...(candidate.queryChunks ?? []).flatMap((item) =>
      (item && typeof item === 'object' ? boundValues(item) : [item])),
  ];
}

/** Approximate SQL text of a drizzle expression (columns as bare names, params as ?). */
function sqlText(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(sqlText).join('');
  if (typeof value !== 'object') return String(value);
  const c = value as Record<string, unknown>;
  if ('encoder' in c) return '?';
  if (Array.isArray(c.queryChunks)) return (c.queryChunks as unknown[]).map(sqlText).join('');
  if (Array.isArray(c.value) && (c.value as unknown[]).every((x) => typeof x === 'string')) {
    return (c.value as string[]).join('');
  }
  if (typeof c.name === 'string') return c.name;
  return '';
}

function makeDb(executeResults: unknown[][] = []) {
  let executeIndex = 0;
  const executed: unknown[] = [];
  const db = {
    execute: vi.fn(async (query: unknown) => {
      executed.push(query);
      return executeResults[executeIndex++] ?? [];
    }),
  };
  return { db: db as unknown as WorkspaceDatabase, executed };
}

describe('normalizeSubject', () => {
  it.each([
    ['RE: PO 4021 issued', 'po 4021 issued'],
    ['Fwd: Re: PO 4021 issued', 'po 4021 issued'],
    ['fw:re:FW: PO 4021 issued', 'po 4021 issued'],
    ['  PO   4021   issued  ', 'po 4021 issued'],
    ['PO 4021 issued', 'po 4021 issued'],
    ['REISSUE: PO 4021', 'reissue: po 4021'], // "re" only strips as a labeled prefix, not any leading "re"
    ['', ''],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeSubject(input)).toBe(expected);
  });
});

describe('createEmailMatchService.match', () => {
  it('tier 1: exact messageId match wins without needing subject/date', async () => {
    const { db, executed } = makeDb([[{ id: 'file-1' }]]);
    const result = await createEmailMatchService(db).match(ORG_ID, {
      subject: 'irrelevant for tier 1',
      internetMessageId: '<ABC123@Mail.Example.com>',
    });
    expect(result).toEqual({ fileIndexId: 'file-1', tier: 1 });
    expect(executed).toHaveLength(1); // tier 1 hit short-circuits — no date-window query follows
    const text = sqlText(executed[0]);
    expect(text).toContain("email_meta ->> 'messageId'");
    expect(text).toContain("fi.ext = 'eml'");
    const values = boundValues(executed[0]);
    expect(values).toContain(ORG_ID);
    // normalized: angle brackets stripped, lowercased
    expect(values).toContain('abc123@mail.example.com');
  });

  it('tier 2: subject + sender + 7-day window hit when the row carries no messageId (PO-4021 shape)', async () => {
    const { db } = makeDb([[
      { id: 'decoy', email_meta: { subject: 'unrelated thread', from: 'x@y.com', date: '2023-08-15T16:00:00.000Z' } },
      {
        id: 'file-2',
        email_meta: {
          subject: 'PO 4021 issued', from: 'Paul Deluca <pdeluca@fairoaksca.gov>',
          date: '2023-08-15T16:00:00.000Z',
        },
      },
    ]]);
    const result = await createEmailMatchService(db).match(ORG_ID, {
      subject: 'RE: PO 4021 issued',
      sender: 'pdeluca@fairoaksca.gov',
      dateISO: '2023-08-16T16:00:00.000Z',
    });
    expect(result).toEqual({ fileIndexId: 'file-2', tier: 2 });
  });

  it('tier 3: forwarded probe (different sender) still hits on subject + date window alone', async () => {
    const { db } = makeDb([[
      {
        id: 'file-3',
        email_meta: {
          subject: 'PO 4021 issued', from: 'Paul Deluca <pdeluca@fairoaksca.gov>',
          date: '2023-08-15T16:00:00.000Z',
        },
      },
    ]]);
    const result = await createEmailMatchService(db).match(ORG_ID, {
      subject: 'FW: PO 4021 issued',
      sender: 'someone-else@example.com',
      dateISO: '2023-08-16T16:00:00.000Z',
    });
    expect(result).toEqual({ fileIndexId: 'file-3', tier: 3 });
  });

  it('ambiguous tier 2 (two sender-matching candidates) falls through tier 3 to null', async () => {
    const { db } = makeDb([[
      {
        id: 'file-a',
        email_meta: {
          subject: 'PO 4021 issued', from: 'Paul Deluca <pdeluca@fairoaksca.gov>',
          date: '2023-08-15T16:00:00.000Z',
        },
      },
      {
        id: 'file-b',
        email_meta: {
          subject: 'PO 4021 issued', from: 'Paul Deluca <pdeluca@fairoaksca.gov>',
          date: '2023-08-16T12:00:00.000Z',
        },
      },
    ]]);
    const result = await createEmailMatchService(db).match(ORG_ID, {
      subject: 'PO 4021 issued',
      sender: 'pdeluca@fairoaksca.gov',
      dateISO: '2023-08-16T16:00:00.000Z',
    });
    expect(result).toBeNull();
  });

  it('visibility: gates on visibleSourcePredicateSql, so groupIds=[] hides a grouped source', async () => {
    const { db, executed } = makeDb([[]]);
    const result = await createEmailMatchService(db).match(ORG_ID, {
      subject: 'PO 4021 issued',
      dateISO: '2023-08-16T16:00:00.000Z',
    }, []);
    expect(result).toBeNull();
    const text = sqlText(executed[0]);
    expect(text).toContain("'[]'::jsonb");
    expect(text).toContain('visibility_group_ids');
  });

  it('org bound: org_id is threaded into the query so cross-org rows never surface', async () => {
    const { db, executed } = makeDb([[]]);
    const result = await createEmailMatchService(db).match(ORG_ID, {
      subject: 'PO 4021 issued',
      dateISO: '2023-08-16T16:00:00.000Z',
    });
    expect(result).toBeNull();
    expect(sqlText(executed[0])).toContain('fi.org_id');
    expect(boundValues(executed[0])).toContain(ORG_ID);
  });

  it('returns null with no query when the probe has neither messageId nor dateISO', async () => {
    const { db, executed } = makeDb([]);
    const result = await createEmailMatchService(db).match(ORG_ID, { subject: 'PO 4021 issued' });
    expect(result).toBeNull();
    expect(executed).toHaveLength(0);
  });
});

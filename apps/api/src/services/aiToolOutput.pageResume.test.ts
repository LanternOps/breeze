import { afterEach, describe, expect, it } from 'vitest';
import { compactToolResultForChat, setToolPaginationHintResolver } from './aiToolOutput';
import { PAGE_RESUME_KEY } from './aiToolPageResume';
import { keysetEnvelope, pageEnvelope, readKeysetArgs, readPageArgs } from './aiToolPagination';

// #10385: when chat compaction dropped rows from a paged array, `nextCursor`,
// `showing` and `hasMore` still described the FULL page, so following the
// cursor skipped every dropped row (and a `hasMore: false` page had no cursor
// at all, while the sentinel told the model to "Call again with the nextCursor
// value"). These tests page a real envelope through the real compactor and
// require that every row is seen exactly once.

const SENTINEL_RE = /more items omitted/;

type Row = { id: string; ts: string; message: string };

// Keyset sort keys are Postgres `timestamp::text`; fixed 6-digit fractions so
// plain string comparison orders them like the DB would.
function makeRows(n: number, messageChars: number): Row[] {
  return Array.from({ length: n }, (_, k) => {
    const id = `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`;
    const ts = `2026-10-${String(1 + Math.floor(k / 100)).padStart(2, '0')} 00:00:${String(k % 60).padStart(2, '0')}.${String(k).padStart(6, '0')}`;
    return { id, ts, message: `row ${k} `.padEnd(messageChars, 'm') };
  });
}

const desc = (a: Row, b: Row) => (a.ts === b.ts ? b.id.localeCompare(a.id) : b.ts.localeCompare(a.ts));

/** In-memory twin of a keyset tool (manage_alerts / query_change_log shape). */
function keysetTool(data: Row[], toolName: string) {
  const sorted = [...data].sort(desc);
  return (input: Record<string, unknown>): string => {
    const page = readKeysetArgs(toolName, input, { defaultLimit: 25, maxLimit: 500 });
    if (!page.ok) return JSON.stringify({ error: page.error, code: page.code });
    const { limit, after, fingerprint } = page;
    const remaining = after
      ? sorted.filter((r) => r.ts < after.t || (r.ts === after.t && r.id < after.i))
      : sorted;
    const items = remaining.slice(0, limit + 1).map((r) => ({ id: r.id, message: r.message, tsText: r.ts }));
    const envelope = keysetEnvelope({
      key: 'alerts', items, limit, fingerprint, after, total: data.length,
      keyOf: (r) => ({ t: r.tsText, i: r.id }),
    });
    const out = (envelope.alerts as Array<Record<string, unknown>>).map(({ tsText: _t, ...rest }) => rest);
    return JSON.stringify({ ...envelope, alerts: out });
  };
}

/** In-memory twin of an offset-paged tool. */
function offsetTool(data: Row[], toolName: string) {
  return (input: Record<string, unknown>): string => {
    const page = readPageArgs(toolName, input, { defaultLimit: 25, maxLimit: 500 });
    if (!page.ok) return JSON.stringify({ error: page.error, code: page.code });
    const { limit, offset, fingerprint } = page;
    const items = data.slice(offset, offset + limit).map((r) => ({ id: r.id, message: r.message }));
    return JSON.stringify(pageEnvelope({ key: 'rows', items, limit, offset, fingerprint, total: data.length }));
  };
}

type Page = Record<string, unknown> & { _chat?: { nextStep?: string } };

/** Page the way the model does: follow nextCursor while hasMore. */
function pageThrough(
  tool: (input: Record<string, unknown>) => string,
  toolName: string,
  key: string,
  baseInput: Record<string, unknown>,
  maxChars?: number,
): { seen: string[]; pages: Page[] } {
  const seen: string[] = [];
  const pages: Page[] = [];
  let input: Record<string, unknown> = { ...baseInput };
  for (let call = 0; call < 200; call += 1) {
    const raw = tool(input);
    const out = JSON.parse(compactToolResultForChat(toolName, raw, maxChars)) as Page;
    pages.push(out);
    expect(out.error).toBeUndefined();
    expect(out).not.toHaveProperty(PAGE_RESUME_KEY);
    const rows = Array.isArray(out[key]) ? (out[key] as unknown[]) : [];
    const real = rows.filter((x) => !(typeof x === 'string' && SENTINEL_RE.test(x))) as Array<{ id: string }>;
    expect(out.showing ?? real.length).toBe(real.length);
    for (const r of real) seen.push(r.id);
    if (out.hasMore !== true) return { seen, pages };
    if (typeof out.nextCursor !== 'string') {
      // Nothing at all fit on a first page: the only way on is a smaller page.
      expect(out.summarized).toBe(true);
      input = { ...baseInput, limit: Math.max(1, Math.floor(Number(input.limit ?? 25) / 2)) };
      continue;
    }
    input = { ...baseInput, ...(input.limit !== undefined ? { limit: input.limit } : {}), cursor: out.nextCursor };
    // A digest (zero rows) asks for a smaller page at the same position.
    if (out.summarized === true) input.limit = Math.max(1, Math.floor(Number(input.limit ?? 25) / 2));
  }
  throw new Error('paging did not terminate');
}

describe('compaction keeps paging lossless (#10385)', () => {
  afterEach(() => setToolPaginationHintResolver(() => 'none'));

  it('keyset: limit 100 over 118 rows that do not fit — every row is visited exactly once', () => {
    setToolPaginationHintResolver(() => 'cursor');
    const data = makeRows(118, 300);
    const { seen, pages } = pageThrough(keysetTool(data, 'manage_alerts'), 'manage_alerts', 'alerts', { action: 'list', limit: 100 });
    expect(seen).toEqual([...data].sort(desc).map((r) => r.id));
    // The first page really was compacted (the case the issue reports).
    expect((pages[0]._chat as Record<string, unknown> | undefined)?.arrayItemsDropped).toBeGreaterThan(0);
    expect(pages[0].hasMore).toBe(true);
    expect(pages[0].total).toBe(118);
  });

  it('keyset: a hasMore:false page that was compacted gets a usable cursor (query_change_log case)', () => {
    setToolPaginationHintResolver(() => 'cursor');
    const data = makeRows(51, 300);
    const tool = keysetTool(data, 'query_change_log');
    const first = JSON.parse(compactToolResultForChat('query_change_log', tool({ limit: 100 }))) as Page;
    const kept = (first.alerts as unknown[]).filter((x) => typeof x !== 'string').length;
    expect(kept).toBeLessThan(51);
    expect(first.showing).toBe(kept);
    expect(first.hasMore).toBe(true);
    expect(typeof first.nextCursor).toBe('string');
    const { seen } = pageThrough(tool, 'query_change_log', 'alerts', { limit: 100 });
    expect(seen).toEqual([...data].sort(desc).map((r) => r.id));
  });

  it('offset: every row is visited exactly once across compacted pages', () => {
    setToolPaginationHintResolver(() => 'cursor');
    const data = makeRows(230, 250);
    const { seen } = pageThrough(offsetTool(data, 'list_things'), 'list_things', 'rows', { limit: 100 });
    expect(seen).toEqual(data.map((r) => r.id));
  });

  it('offset: a later page resumes after the last kept row, not after the full page', () => {
    setToolPaginationHintResolver(() => 'cursor');
    const data = makeRows(300, 250);
    const { seen } = pageThrough(offsetTool(data, 'list_things'), 'list_things', 'rows', { limit: 100, offset: 40 });
    expect(seen).toEqual(data.slice(40).map((r) => r.id));
  });

  it('digest (no row fits at all): the cursor points back at this page instead of past it', () => {
    setToolPaginationHintResolver(() => 'cursor');
    const data = makeRows(40, 2_000);
    const tool = keysetTool(data, 'manage_alerts');
    // Second page: start from a real cursor so the digest must resume mid-list.
    const p1 = JSON.parse(compactToolResultForChat('manage_alerts', tool({ action: 'list', limit: 5 }), 6_000)) as Page;
    expect(p1.summarized).toBeUndefined();
    const digest = JSON.parse(
      compactToolResultForChat('manage_alerts', tool({ action: 'list', limit: 20, cursor: p1.nextCursor }), 1_200),
    ) as Page;
    expect(digest.summarized).toBe(true);
    expect(digest.showing).toBe(0);
    expect(digest.hasMore).toBe(true);
    expect(digest.nextCursor).toBe(p1.nextCursor);
    expect(digest._chat?.nextStep).toMatch(/smaller limit/);
    const { seen } = pageThrough(tool, 'manage_alerts', 'alerts', { action: 'list', limit: 20 }, 1_200);
    expect(seen).toEqual([...data].sort(desc).map((r) => r.id));
  });

  it('a page that fits is returned without the resume descriptor and otherwise unchanged', () => {
    const data = makeRows(3, 20);
    const raw = keysetTool(data, 'manage_alerts')({ action: 'list', limit: 2 });
    const out = JSON.parse(compactToolResultForChat('manage_alerts', raw)) as Page;
    const { [PAGE_RESUME_KEY]: _drop, ...expected } = JSON.parse(raw) as Record<string, unknown>;
    expect(out).toEqual(expected);
  });

  it('ignores a malformed descriptor (strips it, leaves the envelope as the tool wrote it)', () => {
    setToolPaginationHintResolver(() => 'cursor');
    const raw = JSON.stringify({
      rows: makeRows(200, 200),
      showing: 200, hasMore: false, nextCursor: null,
      [PAGE_RESUME_KEY]: { v: 1, key: 'rows', mode: 'keyset', f: 'x', after: null, keys: [['bad']] },
    });
    const out = JSON.parse(compactToolResultForChat('list_things', raw)) as Page;
    expect(out).not.toHaveProperty(PAGE_RESUME_KEY);
    expect(out.showing).toBe(200);
    expect(out.nextCursor).toBeNull();
  });
});

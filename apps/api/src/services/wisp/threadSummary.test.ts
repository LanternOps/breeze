/**
 * #10390 — the session-close summary. The pure helpers are tested directly;
 * `finalizeWispSessionSummary` runs over a mocked Drizzle chain (system context
 * recorded) with the conditional thread writes and the model step mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const h = vi.hoisted(() => ({
  state: { inSystem: false },
  rows: {} as Record<string, unknown[]>,
  selects: [] as Array<{ table: string; where: unknown; system: boolean }>,
  claimThreadSummary: vi.fn(async (_threadId: string, _sessionId: string, _digest: string) => true),
  refineThreadSummary: vi.fn(async (_input: unknown) => {}),
  captureException: vi.fn(),
}));

vi.mock('../../db', () => {
  const select = vi.fn(() => {
    const entry = { table: '', where: undefined as unknown, system: h.state.inSystem };
    h.selects.push(entry);
    const chain: Record<string, unknown> = {};
    chain.from = (t: Parameters<typeof getTableName>[0]) => { entry.table = getTableName(t); return chain; };
    chain.where = (w: unknown) => { entry.where = w; return chain; };
    for (const m of ['orderBy', 'limit']) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(h.rows[entry.table] ?? []).then(res, rej);
    return chain;
  });
  return { db: { select }, runOutsideDbContext: vi.fn((fn: () => unknown) => fn()), withSystemDbAccessContext: vi.fn() };
});
vi.mock('./grantAuthority', () => ({
  inSystemContext: vi.fn(async (fn: () => Promise<unknown>) => {
    h.state.inSystem = true;
    try { return await fn(); } finally { h.state.inSystem = false; }
  }),
}));
vi.mock('./threads', () => ({ claimThreadSummary: h.claimThreadSummary }));
vi.mock('./threadSummaryRefine', () => ({ refineThreadSummary: h.refineThreadSummary }));
vi.mock('../sentry', () => ({ captureException: h.captureException }));

import {
  THREAD_SUMMARY_MAX_CHARS, digestFromMessages, finalizeWispSessionSummary, truncateSummary,
} from './threadSummary';

const THREAD = '00000000-0000-4000-8000-000000000101';
const SESSION = '00000000-0000-4000-8000-000000000201';

const sqlOf = (where: unknown) => {
  const q = new PgDialect().sqlToQuery(where as never);
  return { text: q.sql.toLowerCase(), params: q.params };
};

describe('digestFromMessages', () => {
  const TRAILING_OFFER = "Ask me to check back in about 5–10 minutes and I'll pull the results for both.";

  it('a trailing offer is never the summary: the conclusion above it is what carries over', () => {
    const digest = digestFromMessages([
      { role: 'user', content: 'Why does the .NET patch fail?' },
      { role: 'tool_use', toolName: 'mcp__breeze__get_device_software', content: null },
      { role: 'tool_use', toolName: 'mcp__breeze__get_device_software', content: null },
      { role: 'tool_use', toolName: 'mcp__breeze__search_logs', content: null },
      { role: 'assistant', content: `0x80070643 came from an older update.\n\nI don't see a reason to repair .NET.\n\n${TRAILING_OFFER}` },
    ]);
    expect(digest).toBe([
      'Asked: Why does the .NET patch fail?',
      'Checked: get_device_software ×2, search_logs',
      "Last answer: 0x80070643 came from an older update. I don't see a reason to repair .NET.",
    ].join('\n'));
    expect(digest).not.toContain('check back');
  });

  it.each([
    'Do you want me to run the patch scan on both devices?',
    "I haven't checked the rest. Want me to list the installed updates?",
    'Let me know if you want the full log.',
    'Would you like a summary for the customer?',
    'If you would like, I can schedule it.',
  ])('drops the closing question or offer %j', (closing) => {
    const digest = digestFromMessages([{ role: 'assistant', content: `The disk is healthy.\n\n${closing}` }])!;
    expect(digest.startsWith('Last answer: The disk is healthy.')).toBe(true);
    expect(digest).not.toMatch(/want me|let me know|would you like|if you would like|do you want/i);
  });

  it.each([
    'Check back in 5–10 minutes.',
    "I'll check back shortly.",
    'Feel free to ask for the full log.',
    '- Want me to list them',
    'Also, let me know if you want the log.',
  ])('drops the closing line %j, however it is phrased', (closing) => {
    expect(digestFromMessages([{ role: 'assistant', content: `The disk is healthy.\n\n${closing}` }]))
      .toBe('Last answer: The disk is healthy.');
  });

  it.each([
    'I can also confirm the cert is valid.',
    'If you want the old behaviour, set the flag to 0.',
    'The vendor note asks "is it patched?" and the answer is yes.',
    'The disk is green, and let me know if you want details.',
    'Next step: reboot during the maintenance window.',
  ])('keeps the conclusion %j, which only looks like an offer', (conclusion) => {
    expect(digestFromMessages([{ role: 'assistant', content: conclusion }])).toBe(`Last answer: ${conclusion}`);
  });

  it('keeps the sentence in front of a closing question in the same paragraph', () => {
    expect(digestFromMessages([
      { role: 'assistant', content: "I haven't changed anything. Want me to list the updates?" },
    ])).toBe("Last answer: I haven't changed anything.");
  });

  it('walks back to an earlier reply when the newest one is only an offer', () => {
    expect(digestFromMessages([
      { role: 'assistant', content: 'Backups at all three sites are green.' },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'Anything else I should look at?' },
    ])).toBe('Asked: thanks\nLast answer: Backups at all three sites are green.');
  });

  it('a session that concluded nothing has no digest, so the stored summary survives', () => {
    expect(digestFromMessages([])).toBeNull();
    expect(digestFromMessages([{ role: 'user', content: 'only me' }])).toBeNull();
    expect(digestFromMessages([{ role: 'assistant', content: null }])).toBeNull();
    expect(digestFromMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Want me to look at something?' },
    ])).toBeNull();
  });

  it('tools that ran still count when no reply has a conclusion', () => {
    expect(digestFromMessages([
      { role: 'user', content: 'scan it' },
      { role: 'tool_use', toolName: 'mcp__breeze__manage_patches', content: null },
      { role: 'assistant', content: 'Want me to check the results?' },
    ])).toBe('Asked: scan it\nChecked: manage_patches');
  });

  it('stays within the bound however long the parts are', () => {
    const digest = digestFromMessages([
      { role: 'user', content: 'q '.repeat(4000) },
      ...Array.from({ length: 80 }, (_, i) => ({ role: 'tool_use', toolName: `mcp__breeze__tool_number_${i}`, content: null })),
      { role: 'assistant', content: 'a '.repeat(8000) },
    ])!;
    expect(digest.length).toBeLessThanOrEqual(THREAD_SUMMARY_MAX_CHARS);
    expect(digest).toContain('Last answer: a a');
  });
});

describe('truncateSummary', () => {
  it('the session summary bound is 1500', () => {
    expect(THREAD_SUMMARY_MAX_CHARS).toBe(1500);
  });

  it('truncateSummary keeps ≤ the bound, ends with …, and is deterministic', () => {
    const long = 'word '.repeat(1200);
    const a = truncateSummary(long);
    expect(a.length).toBeLessThanOrEqual(1500);
    expect(a.endsWith('…')).toBe(true);
    expect(truncateSummary(long)).toBe(a);
  });

  it('truncateSummary leaves short text unchanged', () => {
    expect(truncateSummary('  ok  ')).toBe('ok');
  });

  it('cuts at the last whitespace in the final eighth of the bound when there is one', () => {
    const text = `${'a'.repeat(1400)} ${'b'.repeat(1000)}`;
    expect(truncateSummary(text)).toBe(`${'a'.repeat(1400)}…`);
  });

  it('hard-cuts at bound − 1 + … when no whitespace sits in the final eighth', () => {
    const text = `${'a'.repeat(100)} ${'b'.repeat(5000)}`;
    const out = truncateSummary(text);
    expect(out.length).toBe(THREAD_SUMMARY_MAX_CHARS);
    expect(out).toBe(`${text.slice(0, 1499)}…`);
  });

  it('keeps exact-bound text as is and never splits a surrogate pair', () => {
    const exact = 'x'.repeat(1500);
    expect(truncateSummary(exact)).toBe(exact);
    const astral = `${'a'.repeat(1498)}😀${'b'.repeat(100)}`; // 😀 occupies UTF-16 units 1498..1499
    const out = truncateSummary(astral);
    expect(out).toBe(`${'a'.repeat(1498)}…`);
    expect(out.length).toBeLessThanOrEqual(1500);
  });

  it('takes another bound (the picture keeps its 4 000)', () => {
    const out = truncateSummary('word '.repeat(1200), 4000);
    expect(out.length).toBeGreaterThan(3500);
    expect(out.length).toBeLessThanOrEqual(4000);
  });
});

describe('finalizeWispSessionSummary', () => {
  const concluded = [{ role: 'assistant', content: 'Checked the backups.\n\nWant me to re-run them?' }];

  beforeEach(() => {
    h.rows = {};
    h.selects.length = 0;
    h.claimThreadSummary.mockReset();
    h.claimThreadSummary.mockResolvedValue(true);
    h.refineThreadSummary.mockReset();
    h.refineThreadSummary.mockResolvedValue(undefined);
    h.captureException.mockClear();
  });

  it('is a no-op when the session is not attached to a thread', async () => {
    await expect(finalizeWispSessionSummary(SESSION)).resolves.toEqual({ updated: false });
    expect(h.selects.map((s) => s.table)).toEqual(['wisp_thread_sessions']);
    expect(h.claimThreadSummary).not.toHaveBeenCalled();
    expect(h.refineThreadSummary).not.toHaveBeenCalled();
  });

  it("reads only that session's messages in system context and claims the thread with the digest", async () => {
    h.rows.wisp_thread_sessions = [{ threadId: THREAD }];
    h.rows.ai_messages = concluded;
    h.rows.wisp_threads = [{ summary: 'older summary' }];

    await expect(finalizeWispSessionSummary(SESSION)).resolves.toEqual({ updated: true });

    expect(h.claimThreadSummary).toHaveBeenCalledWith(THREAD, SESSION, 'Last answer: Checked the backups.');
    expect(h.selects.every((s) => s.system)).toBe(true);
    const link = sqlOf(h.selects.find((s) => s.table === 'wisp_thread_sessions')!.where);
    expect(link.text).toContain('"session_id"');
    expect(link.params).toContain(SESSION);
    const msgs = sqlOf(h.selects.find((s) => s.table === 'ai_messages')!.where);
    expect(msgs.text).toContain('"ai_messages"."session_id"');
    expect(msgs.params).toContain(SESSION);
  });

  it('the digest lands before the model step starts, and the model gets the summary it replaces', async () => {
    h.rows.wisp_thread_sessions = [{ threadId: THREAD }];
    h.rows.ai_messages = concluded;
    h.rows.wisp_threads = [{ summary: 'older summary' }];

    await finalizeWispSessionSummary(SESSION);

    expect(h.claimThreadSummary.mock.invocationCallOrder[0]!)
      .toBeLessThan(h.refineThreadSummary.mock.invocationCallOrder[0]!);
    expect(h.refineThreadSummary).toHaveBeenCalledWith({
      threadId: THREAD, sessionId: SESSION, previousSummary: 'older summary', messages: concluded,
    });
  });

  it('runs the model step outside the system context, so no connection is held across the provider call', async () => {
    h.rows.wisp_thread_sessions = [{ threadId: THREAD }];
    h.rows.ai_messages = concluded;
    h.rows.wisp_threads = [{ summary: '' }];
    let inSystemDuringRefine: boolean | null = null;
    h.refineThreadSummary.mockImplementation(async () => { inSystemDuringRefine = h.state.inSystem; });
    await finalizeWispSessionSummary(SESSION);
    expect(inSystemDuringRefine).toBe(false);
  });

  it('a lost claim (already finalized, or a newer session holds the summary) writes nothing and spends nothing', async () => {
    h.rows.wisp_thread_sessions = [{ threadId: THREAD }];
    h.rows.ai_messages = concluded;
    h.rows.wisp_threads = [{ summary: 'kept' }];
    h.claimThreadSummary.mockResolvedValue(false);
    await expect(finalizeWispSessionSummary(SESSION)).resolves.toEqual({ updated: false });
    expect(h.refineThreadSummary).not.toHaveBeenCalled();
  });

  it('a failed model step leaves the digest in place and is reported, never thrown', async () => {
    h.rows.wisp_thread_sessions = [{ threadId: THREAD }];
    h.rows.ai_messages = concluded;
    h.rows.wisp_threads = [{ summary: '' }];
    const boom = new Error('provider down');
    h.refineThreadSummary.mockRejectedValue(boom);
    await expect(finalizeWispSessionSummary(SESSION)).resolves.toEqual({ updated: true });
    expect(h.captureException).toHaveBeenCalledWith(boom, undefined, expect.objectContaining({ op: 'wisp.thread_summary.refine' }));
  });

  it('does not touch the thread when the session concluded nothing', async () => {
    h.rows.wisp_thread_sessions = [{ threadId: THREAD }];
    h.rows.ai_messages = [];
    h.rows.wisp_threads = [{ summary: 'kept' }];
    await expect(finalizeWispSessionSummary(SESSION)).resolves.toEqual({ updated: false });
    expect(h.claimThreadSummary).not.toHaveBeenCalled();
    expect(h.refineThreadSummary).not.toHaveBeenCalled();
  });
});

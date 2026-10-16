/**
 * The import writer's planning rules (#8313; spec §4.6), without a database:
 * the final-status path and its Breeze-wins rule on resume, the resume header
 * re-apply (deviation from §4.6 for a cutover's delta pass), comment chunking,
 * and the up-front validation. The transactions themselves run against
 * Postgres in ticketImport.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: {},
  getCurrentDbAccessContext: vi.fn(() => undefined),
  withDbAccessContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
  runOutsideDbContext: vi.fn(),
}));

import {
  chunkComments,
  finalStatusSteps,
  headerChanges,
  IMPORT_COMMENT_CHUNK_BYTES,
  IMPORT_COMMENT_CHUNK_SIZE,
  importTicket,
  statusSteps,
} from './importWriter';
import { parseImportedTicket, type ImportedTicket } from './importedTicket';

const PRINCIPAL = '44444444-4444-4444-8444-444444444444';
const ORG = '22222222-2222-4222-8222-222222222222';
const AGENT = '66666666-6666-4666-8666-666666666666';
const OTHER_AGENT = '77777777-7777-4777-8777-777777777777';
const CATEGORY = '88888888-8888-4888-8888-888888888888';
const T0 = new Date('2021-03-04T09:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function ticket(overrides: Partial<ImportedTicket> = {}): ImportedTicket {
  return {
    sourceId: 'zammad-41023',
    sourceNumber: '#41023',
    orgId: ORG,
    createdAt: T0,
    updatedAt: at(300),
    subject: 'Printer jams',
    description: 'Every second page.',
    priority: 'normal',
    source: 'email',
    requester: { name: 'Maya', email: 'maya@customer.example' },
    finalStatus: 'open',
    comments: [],
    ...overrides,
  };
}

function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: 't-1', orgId: ORG, migrationWindowId: 'w-1', deletedAt: null, status: 'open' as const,
    subject: 'Printer jams', description: 'Every second page.', priority: 'normal' as const, categoryId: null,
    tags: [] as string[], ticketType: 'incident', assignedTo: null as string | null, fieldProvenance: {} as Record<string, string>,
    ...overrides,
  };
}

const ourAssignment = { kind: 'service_principal', principalId: PRINCIPAL };
const ref = { ticketId: 't-1', externalNumber: '#41023', externalUrl: null };

describe('finalStatusSteps — from the current status to the source final status, at most two', () => {
  it('does nothing when the status already matches, and never goes back to new', () => {
    expect(finalStatusSteps('closed', ticket({ finalStatus: 'closed' }))).toEqual([]);
    expect(finalStatusSteps('open', ticket({ finalStatus: 'new' }))).toEqual([]);
  });

  it('resolves then closes when the source knows both times, so both are kept', () => {
    expect(finalStatusSteps('open', ticket({ finalStatus: 'closed', resolvedAt: at(100), closedAt: at(200), resolutionNote: 'Fixed' })))
      .toEqual([{ status: 'resolved', at: at(100), resolutionNote: 'Fixed' }, { status: 'closed', at: at(200) }]);
    // Already resolved: only the close.
    expect(finalStatusSteps('resolved', ticket({ finalStatus: 'closed', resolvedAt: at(100), closedAt: at(200) })))
      .toEqual([{ status: 'closed', at: at(200) }]);
    // No resolved time: closing stamps it (as live does), at the close time or, lacking one, the last update.
    expect(finalStatusSteps('new', ticket({ finalStatus: 'closed' }))).toEqual([{ status: 'closed', at: at(300) }]);
  });

  it('keeps the resolution note of a ticket the source only closed: resolved, then closed, both at the close time', () => {
    expect(finalStatusSteps('open', ticket({ finalStatus: 'closed', closedAt: at(200), resolutionNote: 'Fixed' })))
      .toEqual([{ status: 'resolved', at: at(200), resolutionNote: 'Fixed' }, { status: 'closed', at: at(200) }]);
  });

  it('resolves without a note when the source has none', () => {
    expect(finalStatusSteps('pending', ticket({ finalStatus: 'resolved', resolvedAt: at(50) })))
      .toEqual([{ status: 'resolved', at: at(50) }]);
  });

  it('leaves resolved/closed only through open, as the transition table requires', () => {
    expect(finalStatusSteps('closed', ticket({ finalStatus: 'open' }))).toEqual([{ status: 'open', at: at(300) }]);
    expect(finalStatusSteps('closed', ticket({ finalStatus: 'pending' })))
      .toEqual([{ status: 'open', at: at(300) }, { status: 'pending', at: at(300) }]);
    // Reopened no later than the resolve, so the timeline reads in order.
    expect(finalStatusSteps('closed', ticket({ finalStatus: 'resolved', resolvedAt: at(250) })))
      .toEqual([{ status: 'open', at: at(250) }, { status: 'resolved', at: at(250) }]);
    expect(finalStatusSteps('resolved', ticket({ finalStatus: 'resolved' }))).toEqual([]);
  });

  it('moves between active statuses at the source update time', () => {
    expect(finalStatusSteps('new', ticket({ finalStatus: 'on_hold' }))).toEqual([{ status: 'on_hold', at: at(300) }]);
  });
});

describe('statusSteps — the source status applies only while the import set it last', () => {
  const closedInSource = ticket({ finalStatus: 'closed', resolvedAt: at(100), closedAt: at(200), resolutionNote: 'Fixed' });

  it('applies the source status when the ticket has no status_change row: a first import, or a pass stopped before its status', () => {
    expect(statusSteps('new', null, closedInSource, PRINCIPAL)).toEqual({
      steps: [{ status: 'resolved', at: at(100), resolutionNote: 'Fixed' }, { status: 'closed', at: at(200) }],
      skipped: false,
    });
  });

  it('applies it while this import principal wrote the latest status_change row', () => {
    expect(statusSteps('open', ourAssignment, closedInSource, PRINCIPAL).steps).toHaveLength(2);
    // A reopen-then-resolve pair is applied whole.
    expect(statusSteps('closed', ourAssignment, ticket({ finalStatus: 'resolved', resolvedAt: at(250) }), PRINCIPAL)).toEqual({
      steps: [{ status: 'open', at: at(250) }, { status: 'resolved', at: at(250) }],
      skipped: false,
    });
  });

  it.each([
    ['a technician', { kind: 'user', principalId: null }],
    ["the inbound pipeline's requester reopen (system actor, user origin)", { kind: 'user', principalId: null }],
    ['an AI agent', { kind: 'ai_agent', principalId: 'agent-1' }],
    ['another integration', { kind: 'service_principal', principalId: 'other-principal' }],
  ])('keeps the Breeze status, whole, when %s changed it last', (_label, last) => {
    expect(statusSteps('resolved', last, closedInSource, PRINCIPAL)).toEqual({ steps: [], skipped: true });
    expect(statusSteps('pending', last, ticket({ finalStatus: 'resolved', resolvedAt: at(50) }), PRINCIPAL)).toEqual({ steps: [], skipped: true });
  });

  it('reports nothing skipped when the status already matches the source', () => {
    expect(statusSteps('closed', { kind: 'user', principalId: null }, closedInSource, PRINCIPAL)).toEqual({ steps: [], skipped: false });
    expect(statusSteps('open', { kind: 'user', principalId: null }, ticket({ finalStatus: 'new' }), PRINCIPAL)).toEqual({ steps: [], skipped: false });
  });
});

describe('chunkComments — at most IMPORT_COMMENT_CHUNK_SIZE comments and IMPORT_COMMENT_CHUNK_BYTES of content per transaction', () => {
  const comment = (id: string, content: string) => ({
    sourceId: id, createdAt: at(1), isPublic: false, author: { kind: 'staff' as const, name: 'Tess' }, content,
  });
  const ids = (chunks: Array<Array<{ sourceId: string }>>) => chunks.map((chunk) => chunk.map((c) => c.sourceId));

  it('bounds a chunk by count, in order, and returns nothing for no comments', () => {
    const many = Array.from({ length: 5 }, (_, i) => comment(`c${i}`, 'x'));
    expect(ids(chunkComments(many, 2, 1_000))).toEqual([['c0', 'c1'], ['c2', 'c3'], ['c4']]);
    expect(chunkComments([], 2, 1_000)).toEqual([]);
  });

  it('bounds a chunk by content bytes: a chunk never passes the bound', () => {
    const list = [comment('a', 'x'.repeat(400)), comment('b', 'x'.repeat(400)), comment('c', 'x'.repeat(200)), comment('d', 'x'.repeat(1))];
    expect(ids(chunkComments(list, 100, 1_000))).toEqual([['a', 'b', 'c'], ['d']]);
  });

  it('counts UTF-8 bytes, not characters', () => {
    // 'é' is 2 bytes and '€' 3 in UTF-8: 300 characters, 600 and 900 bytes.
    const list = [comment('a', 'é'.repeat(300)), comment('b', '€'.repeat(300)), comment('c', 'x'.repeat(300))];
    expect(ids(chunkComments(list, 100, 1_000))).toEqual([['a'], ['b'], ['c']]);
  });

  it('puts a comment larger than the bound in a chunk of its own', () => {
    const list = [comment('a', 'x'), comment('big', 'x'.repeat(2_000)), comment('b', 'x')];
    expect(ids(chunkComments(list, 100, 1_000))).toEqual([['a'], ['big'], ['b']]);
  });

  it('keeps 100 ordinary comments in one chunk, and splits comments of the largest allowed size', () => {
    const ordinary = Array.from({ length: 100 }, (_, i) => comment(`m${i}`, 'x'.repeat(4_000)));
    expect(chunkComments(ordinary, IMPORT_COMMENT_CHUNK_SIZE, IMPORT_COMMENT_CHUNK_BYTES)).toHaveLength(1);
    // 200,000 characters of 3-byte text: 600,000 bytes, one a chunk.
    const largest = Array.from({ length: 3 }, (_, i) => comment(`l${i}`, '€'.repeat(200_000)));
    const chunks = chunkComments(largest, IMPORT_COMMENT_CHUNK_SIZE, IMPORT_COMMENT_CHUNK_BYTES);
    expect(ids(chunks)).toEqual([['l0'], ['l1'], ['l2']]);
    // 200,000 ASCII characters: five fit in 1 MiB.
    const ascii = Array.from({ length: 6 }, (_, i) => comment(`s${i}`, 'x'.repeat(200_000)));
    expect(chunkComments(ascii, IMPORT_COMMENT_CHUNK_SIZE, IMPORT_COMMENT_CHUNK_BYTES).map((c) => c.length)).toEqual([5, 1]);
  });
});

describe('headerChanges — a resume converges the header on the source, except what a Breeze user set', () => {
  it('finds nothing to do when the source did not change', () => {
    expect(headerChanges(stored(), ref, ourAssignment, ticket({ tags: [] }), PRINCIPAL))
      .toEqual({ fields: {}, fieldNames: [], assign: null, refreshRef: false });
  });

  it('re-applies changed subject, description, priority, category, tags and type', () => {
    const changes = headerChanges(stored(), ref, ourAssignment, ticket({
      subject: '  Printer jams on floor 3 ', description: 'All pages. ', priority: 'urgent', categoryId: CATEGORY, tags: ['vip'], ticketType: 'problem',
    }), PRINCIPAL);
    expect(changes.fields).toEqual({
      subject: 'Printer jams on floor 3', description: 'All pages.', priority: 'urgent', categoryId: CATEGORY, tags: ['vip'], ticketType: 'problem',
    });
    expect(changes.fieldNames).toEqual(['subject', 'description', 'priority', 'categoryId', 'tags', 'ticketType']);
  });

  it("skips a field whose provenance is 'user'; any other stamp yields to the source", () => {
    const changes = headerChanges(
      stored({ fieldProvenance: { priority: 'user', subject: 'ai_agent', tags: 'service_principal' } }),
      ref, ourAssignment, ticket({ subject: 'New', priority: 'high', tags: ['x'] }), PRINCIPAL,
    );
    expect(changes.fieldNames).toEqual(['subject', 'tags']);
    expect(changes.fields).not.toHaveProperty('priority');
  });

  it('leaves optional fields the module did not send, and clears them on null', () => {
    const s = stored({ categoryId: CATEGORY, tags: ['a'], ticketType: 'problem', assignedTo: AGENT });
    expect(headerChanges(s, ref, ourAssignment, ticket(), PRINCIPAL).fieldNames).toEqual([]);
    const cleared = headerChanges(s, ref, ourAssignment, ticket({ categoryId: null, assigneeUserId: null }), PRINCIPAL);
    expect(cleared.fields).toEqual({ categoryId: null });
    expect(cleared.assign).toEqual({ to: null });
  });

  it('re-applies the assignee only while the import wrote the last assignment, or nobody ever assigned it', () => {
    const t = ticket({ assigneeUserId: OTHER_AGENT });
    expect(headerChanges(stored({ assignedTo: AGENT }), ref, ourAssignment, t, PRINCIPAL).assign).toEqual({ to: OTHER_AGENT });
    expect(headerChanges(stored(), ref, null, t, PRINCIPAL).assign).toEqual({ to: OTHER_AGENT });
    // A technician (or an AI agent, or another integration) reassigned it since.
    expect(headerChanges(stored({ assignedTo: AGENT }), ref, { kind: 'user', principalId: null }, t, PRINCIPAL).assign).toBeNull();
    expect(headerChanges(stored({ assignedTo: AGENT }), ref, { kind: 'ai_agent', principalId: 'agent' }, t, PRINCIPAL).assign).toBeNull();
    expect(headerChanges(stored({ assignedTo: AGENT }), ref, { kind: 'service_principal', principalId: 'other' }, t, PRINCIPAL).assign).toBeNull();
    // Assigned with no feed row at all is not provably ours: left alone.
    expect(headerChanges(stored({ assignedTo: AGENT }), ref, null, t, PRINCIPAL).assign).toBeNull();
  });

  it('refreshes the external ref when the source number or url changed', () => {
    expect(headerChanges(stored(), ref, ourAssignment, ticket({ sourceNumber: '#41024' }), PRINCIPAL).refreshRef).toBe(true);
    expect(headerChanges(stored(), ref, ourAssignment, ticket({ sourceUrl: 'https://helpdesk.example.test/t/1' }), PRINCIPAL).refreshRef).toBe(true);
    expect(headerChanges(stored(), ref, ourAssignment, ticket({ sourceNumber: undefined }), PRINCIPAL).refreshRef).toBe(false);
  });
});

describe('parseImportedTicket — the whole ticket is checked before anything is written', () => {
  const NOW = new Date('2026-10-14T00:00:00.000Z');

  it('accepts a well-formed ticket', () => {
    expect(parseImportedTicket(ticket({ comments: [{ sourceId: 'a1', createdAt: at(5), isPublic: true, author: { kind: 'staff', name: 'Tess' }, content: 'Hi' }] }), NOW))
      .toMatchObject({ sourceId: 'zammad-41023' });
  });

  it.each([
    ['a time in the future', { updatedAt: new Date('2026-10-15T00:00:00.000Z') }, 'updatedAt'],
    ['a resolved time before the creation', { resolvedAt: at(-1) }, 'resolvedAt'],
    ['a comment before the creation', { comments: [{ sourceId: 'a1', createdAt: at(-5), isPublic: true, author: { kind: 'staff' as const, name: 'Tess' }, content: 'x' }] }, 'comments.0.createdAt'],
  ])('refuses %s', (_label, patch, path) => {
    expect(() => parseImportedTicket(ticket(patch as Partial<ImportedTicket>), NOW))
      .toThrow(expect.objectContaining({ code: 'MIGRATION_IMPORT_INVALID', status: 400, details: { path } }));
  });

  it('refuses duplicate comment source ids, an unknown key, an unknown source and a malformed requester', () => {
    const comment = { sourceId: 'dup', createdAt: at(5), isPublic: false, author: { kind: 'staff' as const, name: 'Tess' }, content: 'x' };
    expect(() => parseImportedTicket(ticket({ comments: [comment, comment] }), NOW)).toThrow(expect.objectContaining({ code: 'MIGRATION_IMPORT_INVALID' }));
    for (const bad of [
      { ...ticket(), extra: 1 },
      { ...ticket(), source: 'ai' },
      { ...ticket(), requester: { name: 'x' } },
      // The Partner API's rule for the same column: http(s) only.
      { ...ticket(), sourceUrl: 'javascript:alert(1)' },
    ]) {
      expect(() => parseImportedTicket(bad, NOW)).toThrow(expect.objectContaining({ code: 'MIGRATION_IMPORT_INVALID', status: 400 }));
    }
  });
});

describe('importTicket', () => {
  it('refuses to run inside a DB context (it opens its own transactions and charges Redis between them)', async () => {
    const { getCurrentDbAccessContext } = await import('../../db');
    vi.mocked(getCurrentDbAccessContext).mockReturnValueOnce({ scope: 'system' } as never);
    await expect(importTicket('w-1', ticket(), { partnerId: 'p-1' })).rejects.toThrow(/outside any DB context/);
  });
});

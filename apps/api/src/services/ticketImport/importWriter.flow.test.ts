/**
 * importTicket's transactions without a database (#8313 W0: the #8884 review
 * findings 3, 5, 6 and 7, the reads behind the resume report, and a ticket
 * merged in Breeze): how many transactions a ticket takes, what each is
 * charged, and what the result reports. The window lock, the bucket and the
 * ticketService writes are mocked; every read goes through a scripted fake of
 * `db.select`, answered by what the query reads. The same paths run against
 * Postgres in ticketImport.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Query = { table: string; fields: string[]; lock?: string };

const h = vi.hoisted(() => ({
  /** Scripted answers per query kind, consumed in order; an empty queue answers `fallback`. */
  answers: new Map<string, unknown[][]>(),
  fallback: new Map<string, unknown[]>(),
  log: [] as string[],
  charges: [] as number[],
  locks: 0,
  writes: [] as Array<[string, ...unknown[]]>,
  /** #8313 W1: the object store backend, byte charges, and what each comment write received. */
  backend: 's3' as 's3' | 'db',
  byteCharges: [] as number[],
  commentInputs: [] as Array<{ content: string; imported: { sourceId: string; attachments?: unknown[] } }>,
  /** Names each read the writer makes, from its table and the columns it selects. */
  kindOf(q: { table: string; fields: string[]; lock?: string }): string {
    if (q.table === 'ticket_external_refs') return 'ref';
    if (q.table === 'tickets' && q.fields.includes('fieldProvenance')) return 'storedTicket';
    if (q.table === 'tickets' && q.lock === 'no key update') return 'statusRow';
    if (q.table === 'tickets' && q.lock === 'update') return 'lockedTicket';
    if (q.table === 'ticket_comments' && q.fields.includes('contentHash')) return 'importedComments';
    if (q.table === 'ticket_comments' && q.fields.includes('kind')) return 'feedRow';
    if (q.table === 'ticket_comments' && q.fields.length === 1 && q.fields[0] === 'sourceId') return 'presentByPrincipal';
    return `${q.table}:${q.fields.join(',')}`;
  },
}));

vi.mock('../../db', async () => {
  const { getTableName } = await import('drizzle-orm');
  const select = (fields: Record<string, unknown>) => {
    const q: Query = { table: '', fields: Object.keys(fields).sort() };
    const run = () => {
      const kind = h.kindOf(q);
      h.log.push(kind);
      const queue = h.answers.get(kind);
      return Promise.resolve(queue && queue.length > 0 ? queue.shift()! : (h.fallback.get(kind) ?? []));
    };
    const builder: Record<string, unknown> = {
      from: (table: Parameters<typeof getTableName>[0]) => { q.table = getTableName(table); return builder; },
      where: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      for: (mode: string) => { q.lock = mode; return builder; },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject),
    };
    return builder;
  };
  return {
    db: { select },
    getCurrentDbAccessContext: vi.fn(() => undefined),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(),
    runOutsideDbContext: vi.fn(),
  };
});

vi.mock('./windowLock', () => ({
  readWindowDescriptor: vi.fn(async () => ({
    id: 'w-2', partnerId: 'p-1', principalId: '44444444-4444-4444-8444-444444444444', writesPerHour: 6000,
    orgIds: ['22222222-2222-4222-8222-222222222222'],
  })),
  windowWriteContext: vi.fn(() => ({ scope: 'partner' })),
  lockOpenWindowForWrite: vi.fn(async () => {
    h.locks += 1;
    h.log.push('lock');
    return {
      id: 'w-2', partnerId: 'p-1', principalId: '44444444-4444-4444-8444-444444444444', principalName: 'Zammad import',
      orgIds: new Set(['22222222-2222-4222-8222-222222222222']),
    };
  }),
}));

vi.mock('./throughput', () => ({
  chargeWindowThroughput: vi.fn(async (_window: unknown, cost: number) => { if (cost > 0) h.charges.push(cost); }),
  chargeWindowBytes: vi.fn(async (_window: unknown, bytes: number) => { h.byteCharges.push(bytes); }),
}));

// #8313 W1: the object store and the two attachment statements. The rules
// and the store step are the real ones.
vi.mock('../ticketAttachmentStorage', () => ({
  selectBackend: vi.fn(() => h.backend),
  objectKeyFor: (id: string) => `ticket-attachments/${id}`,
  putBytes: vi.fn(async (id: string) => ({ backend: 's3', storageKey: `ticket-attachments/${id}`, data: null })),
}));
vi.mock('./importAttachments', async (orig) => ({
  ...(await orig<typeof import('./importAttachments')>()),
  reserveImportAttachments: vi.fn(async (input: { files: Array<{ sourceId: string }> }) => {
    h.writes.push(['reserveImportAttachments', input.files.map((f) => f.sourceId)]);
    return input.files.map((f) => ({ id: `id-${f.sourceId}`, sourceId: f.sourceId }));
  }),
  deleteSkippedReservations: vi.fn(async (_ticketId: string, _principalId: string, ids: string[]) => {
    if (ids.length > 0) h.writes.push(['deleteSkippedReservations', ids]);
    return ids.length;
  }),
}));

vi.mock('../ticketExternalRefs', () => ({
  TicketExternalRefConflictError: class TicketExternalRefConflictError extends Error {},
  upsertTicketExternalRef: vi.fn(async (input: unknown) => { h.writes.push(['upsertTicketExternalRef', input]); }),
}));

vi.mock('../ticketService', () => ({
  createTicket: vi.fn(async (input: unknown) => { h.writes.push(['createTicket', input]); return { id: 't-new' }; }),
  assignTicket: vi.fn(async (...args: unknown[]) => { h.writes.push(['assignTicket', ...args]); }),
  updateTicketFields: vi.fn(async (...args: unknown[]) => { h.writes.push(['updateTicketFields', ...args]); }),
  changeTicketStatus: vi.fn(async (id: string, input: { status: string }) => { h.writes.push(['changeTicketStatus', id, input.status]); }),
  addTicketComment: vi.fn(async (id: string, input: { content: string; imported: { sourceId: string } }) => {
    h.writes.push(['addTicketComment', id, input.imported.sourceId]);
    h.commentInputs.push(input);
  }),
}));

import { ImportAttachmentFetchError, importTicket, IMPORT_COMMENT_CHUNK_BYTES, type ImportTicketOptions } from './importWriter';
import type { ImportedTicket } from './importedTicket';

const PRINCIPAL = '44444444-4444-4444-8444-444444444444';
const ORG = '22222222-2222-4222-8222-222222222222';
const TICKET = '99999999-9999-4999-8999-999999999999';
const T0 = new Date('2021-03-04T09:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function answer(kind: string, ...rows: unknown[][]) {
  h.answers.set(kind, rows);
}

function comment(sourceId: string, minutes: number, content = 'x'): ImportedTicket['comments'][number] {
  return { sourceId, createdAt: at(minutes), isPublic: false, author: { kind: 'staff', name: 'Tess' }, content };
}

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

/** The stored ticket of a resume, matching `ticket()`'s header so no field is re-applied. */
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TICKET, orgId: ORG, migrationWindowId: 'w-1', deletedAt: null, status: 'open',
    subject: 'Printer jams', description: 'Every second page.', priority: 'normal', categoryId: null,
    tags: [], ticketType: 'incident', assignedTo: null, fieldProvenance: {},
    requesterContactId: null, submitterEmail: 'maya@customer.example',
    mergedIntoTicketId: null, windowPrincipalId: PRINCIPAL, receivedMerge: false,
    ...overrides,
  };
}

const ours = { kind: 'service_principal', principalId: PRINCIPAL };
const technician = { kind: 'user', principalId: null };
const run = (t: ImportedTicket, extra: Omit<ImportTicketOptions, 'partnerId'> = {}) => importTicket('w-2', t, { partnerId: 'p-1', ...extra });
const statusWrites = () => h.writes.filter((w) => w[0] === 'changeTicketStatus').map((w) => w[2]);

beforeEach(() => {
  h.answers.clear();
  h.fallback.clear();
  h.log.length = 0;
  h.charges.length = 0;
  h.writes.length = 0;
  h.locks = 0;
  h.backend = 's3';
  h.byteCharges.length = 0;
  h.commentInputs.length = 0;
  // Under the lock the ticket is still an import, not deleted.
  h.fallback.set('lockedTicket', [{ migrationWindowId: 'w-1', deletedAt: null, mergedIntoTicketId: null }]);
});

describe('importTicket — the byte bound, counted in transactions (#8884 review, finding 6)', () => {
  // Five comments of 400 bytes each, a first import with no assignee whose
  // final status is `open` (one step from `new`).
  const five = ticket({ comments: [1, 2, 3, 4, 5].map((i) => comment(`a${i}`, i, 'x'.repeat(400))) });

  beforeEach(() => {
    h.fallback.set('statusRow', [{ status: 'new' }]);
  });

  it('splits the comments by content bytes: header, then three chunks of at most 1,000 bytes', async () => {
    const result = await run(five, { chunkBytes: 1_000 });
    expect(result).toMatchObject({ ticketId: 't-new', outcome: 'created', commentsWritten: 5, statusSkipped: false });
    // One lock per transaction: header (create + ref), chunks [a1 a2] [a3 a4] [a5 + the status].
    expect(h.locks).toBe(4);
    expect(h.charges).toEqual([2, 2, 2, 2]);
    expect(h.writes.filter((w) => w[0] === 'addTicketComment').map((w) => w[2])).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(statusWrites()).toEqual(['open']);
  });

  it('keeps the same comments in one chunk at the default bound, and never lets a caller raise it', async () => {
    await run(five);
    expect(h.locks).toBe(2);
    expect(h.charges).toEqual([2, 6]);

    h.charges.length = 0;
    h.locks = 0;
    await run(five, { chunkBytes: IMPORT_COMMENT_CHUNK_BYTES * 4 });
    expect(h.locks).toBe(2);
  });
});

describe('importTicket — a first import whose ticket changes in Breeze mid-import (#8884 review, finding 7)', () => {
  it('reports statusSkipped, with who owns the status, when a Breeze change lands between the header and the last transaction', async () => {
    const closed = ticket({
      finalStatus: 'closed', resolvedAt: at(100), closedAt: at(200), resolutionNote: 'Fixed',
      comments: [comment('a1', 10)],
    });
    // Under the lock of the last transaction: a technician has put the new
    // ticket on hold since the header transaction committed.
    answer('statusRow', [{ status: 'on_hold' }]);
    answer('feedRow', [technician]);

    const result = await run(closed);

    expect(result).toMatchObject({ outcome: 'created', commentsWritten: 1, statusSkipped: true });
    expect(result.statusSkip).toEqual({ statusOwner: technician, sourceStatus: 'closed', currentStatus: 'on_hold' });
    expect(statusWrites()).toEqual([]);
    // Header (create + ref), then the comment plus the two planned status units.
    expect(h.charges).toEqual([2, 3]);
  });
});

describe('importTicket — one reason code for a ticket the window cannot see (#8884 review, finding 5)', () => {
  it('answers org_outside_window when the ref is found but its ticket is invisible, as the locked re-check does', async () => {
    answer('ref', [{ ticketId: TICKET, externalNumber: '#41023', externalUrl: null }]);
    answer('storedTicket', []);
    await expect(run(ticket())).rejects.toMatchObject({
      code: 'MIGRATION_SOURCE_ID_IN_USE', status: 409, details: { sourceId: 'zammad-41023', reason: 'org_outside_window', ticketId: TICKET },
    });
    expect(h.locks).toBe(0);
    expect(h.charges).toEqual([]);
  });

  it('still answers live_ticket for a visible ticket the import did not create', async () => {
    answer('ref', [{ ticketId: TICKET, externalNumber: '#41023', externalUrl: null }]);
    answer('storedTicket', [storedRow({ migrationWindowId: null })]);
    await expect(run(ticket())).rejects.toMatchObject({ details: { reason: 'live_ticket', ticketId: TICKET } });
  });
});

describe('importTicket — a predicted skip is charged when a transaction runs (#8884 review, finding 3)', () => {
  const closedInSource = { finalStatus: 'closed' as const, resolvedAt: at(100), closedAt: at(200), resolutionNote: 'Fixed' };

  beforeEach(() => {
    answer('ref', [{ ticketId: TICKET, externalNumber: '#41023', externalUrl: null }]);
    answer('storedTicket', [storedRow()]);
  });

  it('charges the status steps with the last transaction although the plan predicts a skip, so a racing apply is metered', async () => {
    // The plan: never assigned; a technician changed the status last.
    // Under the lock: another run of this principal has written the status
    // since, so the re-check applies the source's (resolved, then closed).
    answer('feedRow', [], [technician], [ours]);
    answer('statusRow', [{ status: 'open' }]);

    const result = await run(ticket({ ...closedInSource, comments: [comment('a1', 150)] }));

    expect(result).toMatchObject({ outcome: 'resumed', commentsWritten: 1, statusSkipped: false });
    expect(result).not.toHaveProperty('statusSkip');
    expect(statusWrites()).toEqual(['resolved', 'closed']);
    // One comment and both status steps, all charged before the transaction.
    expect(h.charges).toEqual([3]);
  });

  it('opens no transaction and charges nothing for a predicted skip with nothing else to write; the skip is the plan answer', async () => {
    answer('feedRow', [], [technician]);

    const result = await run(ticket(closedInSource));

    expect(result).toMatchObject({ outcome: 'resumed', commentsWritten: 0, statusSkipped: true });
    expect(result.statusSkip).toEqual({ statusOwner: technician, sourceStatus: 'closed', currentStatus: 'open' });
    expect(h.locks).toBe(0);
    expect(h.charges).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it('runs the status-only transaction, charged as planned, when the plan predicts an apply', async () => {
    answer('feedRow', [], [ours], [ours]);
    answer('statusRow', [{ status: 'open' }]);

    const result = await run(ticket(closedInSource));

    expect(result).toMatchObject({ outcome: 'resumed', statusSkipped: false });
    expect(h.locks).toBe(1);
    expect(h.charges).toEqual([2]);
    expect(statusWrites()).toEqual(['resolved', 'closed']);
  });
});

describe('importTicket — the resume report reads nothing extra (spec 2026-10-19 §5.3 item 3)', () => {
  it('plans a first import with the ref read alone, and reports nothing changed', async () => {
    h.fallback.set('statusRow', [{ status: 'new' }]);
    const result = await run(ticket({ comments: [comment('a1', 1)] }), { isSourceArticleId: () => true });
    expect(h.log.slice(0, h.log.indexOf('lock'))).toEqual(['ref']);
    expect(h.log).not.toContain('importedComments');
    expect(result).toMatchObject({ requesterChanged: false, orgChanged: false, commentsChangedInSource: [], commentsMissingInSource: [] });
  });

  it('reports a resume from the read that also answers presence: nothing else is asked when every comment is on the ticket', async () => {
    answer('ref', [{ ticketId: TICKET, externalNumber: '#41023', externalUrl: null }]);
    answer('storedTicket', [storedRow({ submitterEmail: 'old@customer.example' })]);
    const row = { isPublic: true, contentHash: 'stale', edited: false, deleted: false, mergedIn: false };
    answer('importedComments', [{ ...row, sourceId: 'a0' }, { ...row, sourceId: 'a1' }]);
    answer('feedRow', [], [ours]);

    const result = await run(ticket({ comments: [comment('a1', 1)] }), { isSourceArticleId: () => true });

    expect(h.log).toEqual(['ref', 'storedTicket', 'importedComments', 'feedRow', 'feedRow']);
    expect(result).toMatchObject({
      outcome: 'resumed',
      commentsWritten: 0,
      commentsSkipped: 1,
      requesterChanged: true,
      orgChanged: false,
      commentsChangedInSource: [{ sourceId: 'a1', contentChanged: true, visibility: 'made_internal' }],
      commentsMissingInSource: ['a0'],
    });
    // Report-only: no transaction, no charge, no write.
    expect(h.locks).toBe(0);
    expect(h.writes).toEqual([]);
  });

  it('asks the principal-wide presence read only for the comments the ticket does not hold', async () => {
    answer('ref', [{ ticketId: TICKET, externalNumber: '#41023', externalUrl: null }]);
    answer('storedTicket', [storedRow()]);
    answer('importedComments', [{ sourceId: 'a1', isPublic: false, contentHash: 'h', edited: false, deleted: false, mergedIn: false }]);
    // a2 was imported onto another ticket (a merge in the source moved it).
    answer('presentByPrincipal', [{ sourceId: 'a2' }]);
    answer('feedRow', [], [ours]);
    h.fallback.set('statusRow', [{ status: 'open' }]);

    const result = await run(ticket({ comments: [comment('a1', 1), comment('a2', 2), comment('a3', 3)] }));

    expect(h.log.filter((k) => k === 'presentByPrincipal').length).toBe(2); // the plan's, then the chunk's re-check
    expect(result).toMatchObject({ commentsWritten: 1, commentsSkipped: 2 });
    expect(h.writes.filter((w) => w[0] === 'addTicketComment').map((w) => w[2])).toEqual(['a3']);
  });
});

describe('importTicket — a ticket merged in Breeze (#8972) is skipped, final, with its survivor', () => {
  const SURVIVOR = '88888888-8888-4888-8888-888888888888';
  const closedWithNotes = ticket({
    finalStatus: 'closed', resolvedAt: at(100), closedAt: at(200), subject: 'Changed in the source',
    comments: [comment('a1', 10), comment('a2', 20)],
  });

  beforeEach(() => {
    // The plan reads the ref and the ticket; a resumed header transaction reads both again.
    h.fallback.set('ref', [{ ticketId: TICKET, externalNumber: '#41023', externalUrl: null }]);
  });

  it('writes and charges nothing when the ref is on a tombstone this import created', async () => {
    h.fallback.set('storedTicket', [storedRow({ mergedIntoTicketId: SURVIVOR, status: 'closed' })]);

    const result = await run(closedWithNotes);

    expect(result).toEqual({
      ticketId: TICKET,
      outcome: 'skipped',
      skip: { reason: 'merged_in_breeze', mergedIntoTicketId: SURVIVOR },
      commentsWritten: 0, commentsSkipped: 0, fieldsUpdated: 0, statusSkipped: false,
      attachmentsWritten: 0, attachmentsSkipped: [], attachmentBytes: 0,
      requesterChanged: false, orgChanged: false, commentsChangedInSource: [], commentsMissingInSource: [],
    });
    expect(h.log).toEqual(['ref', 'storedTicket']);
    expect(h.locks).toBe(0);
    expect(h.charges).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it.each([
    // The merge moved this import's ref onto a live survivor (the known limit: refused on every pass).
    ['a live ticket', { migrationWindowId: null, windowPrincipalId: null }, 'live_ticket'],
    // Checked before the tombstone: a never-imported live ticket that was later merged stays a conflict.
    ['a live tombstone', { migrationWindowId: null, windowPrincipalId: null, mergedIntoTicketId: SURVIVOR }, 'live_ticket'],
    // The merge moved this import's ref onto another principal's import, which used to be resumed with this source's data.
    ["another principal's import", { windowPrincipalId: '45454545-4545-4545-8545-454545454545' }, 'other_principal_ticket'],
    ["another principal's tombstone", { windowPrincipalId: '45454545-4545-4545-8545-454545454545', mergedIntoTicketId: SURVIVOR }, 'other_principal_ticket'],
  ])('refuses, never resumes, a ref that resolves to %s', async (_label, row, reason) => {
    h.fallback.set('storedTicket', [storedRow(row)]);
    await expect(run(closedWithNotes)).rejects.toMatchObject({
      code: 'MIGRATION_SOURCE_ID_IN_USE', status: 409, details: { reason, ticketId: TICKET },
    });
    expect(h.locks).toBe(0);
    expect(h.charges).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it('stops under the lock when a merge commits between two of its transactions, and writes nothing more', async () => {
    h.fallback.set('storedTicket', [storedRow()]);
    answer('feedRow', [], [ours]);
    // The header transaction (the subject changed) commits; the merge lands
    // before the first comment chunk.
    answer(
      'lockedTicket',
      [{ migrationWindowId: 'w-1', deletedAt: null, mergedIntoTicketId: null }],
      [{ migrationWindowId: 'w-1', deletedAt: null, mergedIntoTicketId: SURVIVOR }],
    );

    const result = await run(closedWithNotes, { chunkSize: 1 });

    expect(result).toMatchObject({
      ticketId: TICKET, outcome: 'skipped', skip: { reason: 'merged_in_breeze', mergedIntoTicketId: SURVIVOR },
      fieldsUpdated: 1, commentsWritten: 0,
    });
    expect(h.writes.map((w) => w[0])).toEqual(['updateTicketFields']);
    // The header's unit, then the chunk's (charged before its transaction
    // opened, spent): the second chunk never runs.
    expect(h.charges).toEqual([1, 1]);
    expect(h.locks).toBe(2);
    // Each transaction locks and re-checks the ticket in one statement; the
    // header transaction then reads the header alone.
    expect(h.log.filter((k) => k === 'lockedTicket')).toHaveLength(2);
    expect(h.log.filter((k) => k === 'storedTicket')).toHaveLength(2);
  });
});

describe('importTicket — attachments: reserve, store, attach (#8313 W1, spec 2026-10-19 §4.3)', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
  const withFiles = ticket({
    comments: [
      { ...comment('a1', 1), attachments: [
        { sourceId: 'f1', filename: 'photo.png', declaredBytes: PNG.length, inline: false },
        { sourceId: 'f2', filename: 'invoice.pdf.exe', declaredBytes: 100, inline: false },
      ] },
      { ...comment('a2', 2), attachments: [{ sourceId: 'f3', filename: 'empty.txt', declaredBytes: 0, inline: false }] },
      comment('a3', 3),
    ],
  });

  beforeEach(() => {
    h.fallback.set('statusRow', [{ status: 'new' }]);
  });

  it('refuses a ticket with files and no object storage (409) before anything is written or charged', async () => {
    h.backend = 'db';
    await expect(run(withFiles, { fetchAttachment: vi.fn() }))
      .rejects.toMatchObject({ code: 'TICKET_IMPORT_OBJECT_STORAGE_REQUIRED', status: 409 });
    expect(h.locks).toBe(0);
    expect(h.charges).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it('refuses files without fetchAttachment (400) before anything is written', async () => {
    await expect(run(withFiles)).rejects.toMatchObject({ code: 'MIGRATION_IMPORT_INVALID', status: 400 });
    expect(h.writes).toEqual([]);
  });

  it('a ticket without files needs neither object storage nor fetchAttachment', async () => {
    h.backend = 'db';
    await expect(run(ticket({ comments: [comment('a1', 1)] }))).resolves.toMatchObject({ outcome: 'created', attachmentsWritten: 0 });
  });

  it('reserves what may be fetched in its own transaction (one unit a file), stores it, then the comment claims it; skips ride in a note', async () => {
    const fetchAttachment = vi.fn(async () => PNG);
    const result = await run(withFiles, { fetchAttachment });

    // Header (create + ref), the reservation of f1 alone, the chunk (3 comments + the status).
    expect(h.charges).toEqual([2, 1, 4]);
    expect(h.locks).toBe(3);
    expect(h.byteCharges).toEqual([PNG.length]);
    expect(fetchAttachment).toHaveBeenCalledWith('f1', 10 * 1024 * 1024);
    expect(h.writes.map((w) => w[0])).toEqual([
      'createTicket', 'upsertTicketExternalRef', 'reserveImportAttachments',
      'addTicketComment', 'addTicketComment', 'addTicketComment', 'changeTicketStatus',
    ]);
    expect(h.writes[2]).toEqual(['reserveImportAttachments', ['f1']]);
    expect(h.commentInputs.map((c) => [c.imported.sourceId, c.content, c.imported.attachments])).toEqual([
      ['a1', 'x\n\n[Attachments not imported: invoice.pdf.exe (blocked file type)]', [expect.objectContaining({ id: 'id-f1', contentType: 'image/png', byteSize: PNG.length })]],
      ['a2', 'x\n\n[Attachments not imported: empty.txt (empty file)]', undefined],
      ['a3', 'x', undefined],
    ]);
    expect(result).toMatchObject({
      outcome: 'created',
      commentsWritten: 3,
      attachmentsWritten: 1,
      attachmentBytes: PNG.length,
      attachmentsSkipped: [{ sourceId: 'f2', reason: 'blocked_type' }, { sourceId: 'f3', reason: 'empty' }],
    });
  });

  it('a file the source no longer has is skipped after its reservation, which the chunk transaction deletes first', async () => {
    const fetchAttachment = vi.fn(async () => { throw new ImportAttachmentFetchError('not_found'); });
    const result = await run(ticket({ comments: [{ ...comment('a1', 1), attachments: [{ sourceId: 'f9', filename: 'lost.pdf', inline: false }] }] }), { fetchAttachment });
    expect(h.writes.map((w) => w[0])).toEqual([
      'createTicket', 'upsertTicketExternalRef', 'reserveImportAttachments', 'deleteSkippedReservations', 'addTicketComment', 'changeTicketStatus',
    ]);
    expect(h.writes[3]).toEqual(['deleteSkippedReservations', ['id-f9']]);
    expect(h.commentInputs[0]!.content).toBe('x\n\n[Attachments not imported: lost.pdf (not found in the source)]');
    expect(result).toMatchObject({ attachmentsWritten: 0, attachmentsSkipped: [{ sourceId: 'f9', reason: 'not_found' }] });
  });

  it('a transient failure fails the ticket after the reservation: no comment, and the reservation stays', async () => {
    const fetchAttachment = vi.fn(async () => { throw new Error('timeout'); });
    await expect(run(ticket({ comments: [{ ...comment('a1', 1), attachments: [{ sourceId: 'f8', filename: 'a.png', inline: false }] }] }), { fetchAttachment }))
      .rejects.toMatchObject({ code: 'TICKET_IMPORT_ATTACHMENT_UNAVAILABLE', status: 503 });
    expect(h.writes.map((w) => w[0])).toEqual(['createTicket', 'upsertTicketExternalRef', 'reserveImportAttachments']);
  });

  it('a reservation that finds the ticket merged in Breeze returns merged_in_breeze and stores nothing', async () => {
    const SURVIVOR = '88888888-8888-4888-8888-888888888888';
    h.fallback.set('ref', [{ ticketId: TICKET, externalNumber: '#41023', externalUrl: null }]);
    h.fallback.set('storedTicket', [storedRow()]);
    answer('lockedTicket', [{ migrationWindowId: 'w-1', deletedAt: null, mergedIntoTicketId: SURVIVOR }]);
    const fetchAttachment = vi.fn(async () => PNG);
    const result = await run(ticket({ comments: [{ ...comment('a1', 1), attachments: [{ sourceId: 'f7', filename: 'a.png', inline: false }] }] }), { fetchAttachment });
    expect(result).toMatchObject({ outcome: 'skipped', skip: { reason: 'merged_in_breeze', mergedIntoTicketId: SURVIVOR }, attachmentsWritten: 0 });
    expect(fetchAttachment).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });
});

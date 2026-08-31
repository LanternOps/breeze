import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  authRef, getScopedTicketOr404Mock, dbSelectMock, dbInsertReturningMock,
  selectColumnArgs, insertedValues, putBytesMock, deleteBytesMock, auditMock, rateLimitAllowed,
  openBytesMock, dbRowMock, deletedRowIds, dbEventOrder,
} = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  getScopedTicketOr404Mock: vi.fn(),
  dbSelectMock: vi.fn(),
  dbInsertReturningMock: vi.fn(),
  selectColumnArgs: [] as unknown[],
  insertedValues: [] as Record<string, unknown>[],
  putBytesMock: vi.fn(),
  deleteBytesMock: vi.fn(),
  openBytesMock: vi.fn(),
  dbRowMock: vi.fn(),
  deletedRowIds: [] as unknown[],
  // Side effects recorded from INSIDE the request, so orderings are observable.
  dbEventOrder: [] as string[],
  auditMock: vi.fn(),
  rateLimitAllowed: { current: true },
}));

vi.mock('../../middleware/auth', async () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    const perms = (authRef.current as any).permissions;
    if (perms) c.set('permissions', perms);
    await next();
  }),
  requireScope: () => async (c: any, next: any) => {
    if (!c.get('auth')) return c.json({ error: 'Not authenticated' }, 401);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  siteAccessCheck: (await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth')).siteAccessCheck,
}));

vi.mock('../../middleware/userRateLimit', () => ({
  userRateLimit: () => async (c: any, next: any) => {
    if (!rateLimitAllowed.current) return c.json({ error: 'Rate limit exceeded' }, 429);
    await next();
  },
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn((cols?: unknown) => {
      selectColumnArgs.push(cols);
      return {
        from: vi.fn(() => ({
          // Single-row attachment lookup joins its parent comment.
          leftJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve(dbRowMock() ?? [])),
            })),
          })),
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(dbSelectMock() ?? [])),
            then: (res: (v: unknown) => unknown, rej: (r?: unknown) => unknown) =>
              Promise.resolve(dbSelectMock() ?? []).then(res, rej),
          })),
        })),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        insertedValues.push(v);
        return { returning: vi.fn(() => dbInsertReturningMock()) };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn((w: unknown) => {
        deletedRowIds.push(w);
        dbEventOrder.push('row');
        return Promise.resolve();
      }),
    })),
  },
}));

vi.mock('./tickets', async () => {
  const actual = await vi.importActual<typeof import('./tickets')>('./tickets');
  return { ...actual, getScopedTicketOr404: getScopedTicketOr404Mock };
});

vi.mock('../../services/ticketAttachmentStorage', async () => {
  const actual = await vi.importActual<typeof import('../../services/ticketAttachmentStorage')>(
    '../../services/ticketAttachmentStorage',
  );
  return { ...actual, putBytes: putBytesMock, deleteBytes: deleteBytesMock, openBytes: openBytesMock };
});

vi.mock('../../services/auditService', () => ({ createAuditLogAsync: auditMock }));

import { ticketAttachmentRoutes } from './attachments';
import { authMiddleware } from '../../middleware/auth';
import { AttachmentStorageError } from '../../services/ticketAttachmentStorage';

const TICKET_ID = '3f2f1d8e-1111-4222-8333-444455556666';
const app = new Hono();
app.use('*', authMiddleware);
app.route('/', ticketAttachmentRoutes);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(16).fill(0)]);
const HEIC = Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heicmif1', 'latin1');

function upload(body: FormData, ticketId = TICKET_ID) {
  return app.request(`/${ticketId}/attachments`, { method: 'POST', body });
}

function oneFile(buf: Buffer, name = 'photo.png', type = 'image/png') {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(buf)], name, { type }));
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectColumnArgs.length = 0;
  insertedValues.length = 0;
  rateLimitAllowed.current = true;
  authRef.current = {
    scope: 'partner',
    user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
    partnerId: 'p-1',
    orgId: null,
    accessibleOrgIds: null,
    orgCondition: () => undefined,
    canAccessOrg: (_id: string) => true,
  };
  getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'org-1', deletedAt: null, deviceId: null });
  dbSelectMock.mockReturnValue([{ count: 0 }]);
  dbRowMock.mockReturnValue([]);
  deletedRowIds.length = 0;
  dbEventOrder.length = 0;
  openBytesMock.mockResolvedValue({ body: Buffer.from('bytes'), contentLength: 5 });
  // clearAllMocks keeps implementations — reset the ones individual tests
  // override with a rejection, or the failure leaks into the next test.
  deleteBytesMock.mockReset();
  deleteBytesMock.mockResolvedValue(undefined);
  putBytesMock.mockResolvedValue({ backend: 'db', storageKey: null, data: PNG });
  dbInsertReturningMock.mockImplementation(() =>
    Promise.resolve([{
      id: 'aaaabbbb-cccc-4ddd-8eee-ffff00001111',
      commentId: null,
      contentType: 'image/png',
      byteSize: PNG.length,
      originalFilename: 'photo.png',
      createdAt: new Date('2026-08-30T00:00:00Z'),
    }]),
  );
});

describe('POST /tickets/:id/attachments (W08 #3902)', () => {
  it('201s with meta only — never storageKey, sha256, storageBackend or data', async () => {
    const res = await upload(oneFile(PNG));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({ commentId: null, contentType: 'image/png', originalFilename: 'photo.png' });
    const keys = Object.keys(body.data);
    expect(keys).not.toContain('storageKey');
    expect(keys).not.toContain('storageBackend');
    expect(keys).not.toContain('sha256');
    expect(keys).not.toContain('data');
  });

  it('403s an organization-scoped caller with no orgId', async () => {
    authRef.current = { ...authRef.current, scope: 'organization', orgId: null };
    const res = await upload(oneFile(PNG));
    expect(res.status).toBe(403);
    expect(putBytesMock).not.toHaveBeenCalled();
  });

  it('404s a ticket outside the caller scope', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(null);
    const res = await upload(oneFile(PNG));
    expect(res.status).toBe(404);
    expect(putBytesMock).not.toHaveBeenCalled();
  });

  it('409 TICKET_DELETED on a soft-deleted ticket', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'org-1', deletedAt: new Date(), deviceId: null });
    const res = await upload(oneFile(PNG));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('TICKET_DELETED');
  });

  it('400s when the request carries no file part', async () => {
    const res = await upload(new FormData());
    expect(res.status).toBe(400);
    expect(putBytesMock).not.toHaveBeenCalled();
  });

  it('400s when the request carries two file parts', async () => {
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array(PNG)], 'a.png', { type: 'image/png' }));
    fd.append('file', new File([new Uint8Array(PNG)], 'b.png', { type: 'image/png' }));
    const res = await upload(fd);
    expect(res.status).toBe(400);
    expect(putBytesMock).not.toHaveBeenCalled();
  });

  it('413 ATTACHMENT_TOO_LARGE above the shared maxBytes limit', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024 + 1)]);
    const res = await upload(oneFile(big));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('ATTACHMENT_TOO_LARGE');
    expect(putBytesMock).not.toHaveBeenCalled();
  });

  it('400s an empty file', async () => {
    const res = await upload(oneFile(Buffer.alloc(0)));
    expect(res.status).toBe(400);
  });

  it('415 UNSUPPORTED_ATTACHMENT_TYPE for HEIC, ignoring a spoofed client Content-Type', async () => {
    const res = await upload(oneFile(HEIC, 'shot.heic', 'image/png'));
    expect(res.status).toBe(415);
    expect((await res.json()).code).toBe('UNSUPPORTED_ATTACHMENT_TYPE');
    expect(putBytesMock).not.toHaveBeenCalled();
  });

  it('429 TOO_MANY_PENDING at the pending cap', async () => {
    dbSelectMock.mockReturnValue([{ count: 20 }]);
    const res = await upload(oneFile(PNG));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('TOO_MANY_PENDING');
    expect(putBytesMock).not.toHaveBeenCalled();
  });

  it('503 STORAGE_UNAVAILABLE and NO row inserted when the object store faults', async () => {
    putBytesMock.mockRejectedValue(new AttachmentStorageError('down'));
    const res = await upload(oneFile(PNG));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('STORAGE_UNAVAILABLE');
    expect(insertedValues).toHaveLength(0);
  });

  it('compensates the object and rethrows the ORIGINAL error when the insert fails', async () => {
    putBytesMock.mockResolvedValue({ backend: 's3', storageKey: 'ticket-attachments/x', data: null });
    dbInsertReturningMock.mockRejectedValue(new Error('insert exploded'));
    const res = await upload(oneFile(PNG));
    expect(res.status).toBe(500);
    expect(deleteBytesMock).toHaveBeenCalledTimes(1);
    expect(deleteBytesMock).toHaveBeenCalledWith(
      expect.objectContaining({ storageBackend: 's3', storageKey: 'ticket-attachments/x' }),
    );
  });

  it('does not let a failing compensating delete mask the original insert error', async () => {
    putBytesMock.mockResolvedValue({ backend: 's3', storageKey: 'ticket-attachments/x', data: null });
    dbInsertReturningMock.mockRejectedValue(new Error('insert exploded'));
    deleteBytesMock.mockRejectedValue(new Error('delete also failed'));
    const res = await upload(oneFile(PNG));
    expect(res.status).toBe(500);
  });

  it('audits the upload without the filename (possible PII)', async () => {
    await upload(oneFile(PNG, 'customer-invoice-jane-doe.png'));
    expect(auditMock).toHaveBeenCalledTimes(1);
    const params = auditMock.mock.calls[0]![0];
    expect(params.action).toBe('ticket.attachment.upload');
    expect(params.details).toEqual(expect.objectContaining({ byteSize: PNG.length, contentType: 'image/png' }));
    expect(params.details).toHaveProperty('attachmentId');
    expect(JSON.stringify(params)).not.toContain('customer-invoice-jane-doe');
  });

  it('stores a sanitised basename — no path separators, quotes, backslashes or newlines', async () => {
    await upload(oneFile(PNG, 'a/b/../../etc/pa"ss\\wd\nx.png'));
    const stored = insertedValues[0]!.originalFilename as string;
    expect(stored).not.toMatch(/[/\\"\n\r\x00]/);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThanOrEqual(255);
  });

  it('falls back to "attachment" when sanitisation empties the filename', async () => {
    await upload(oneFile(PNG, '///'));
    expect(insertedValues[0]!.originalFilename).toBe('attachment');
  });

  it('stamps org_id from the SCOPED ticket, not from anything client-supplied', async () => {
    await upload(oneFile(PNG));
    expect(insertedValues[0]).toMatchObject({ orgId: 'org-1', ticketId: TICKET_ID, commentId: null, uploadedByUserId: 'u-1' });
  });

  it('honours the userRateLimit middleware', async () => {
    rateLimitAllowed.current = false;
    const res = await upload(oneFile(PNG));
    expect(res.status).toBe(429);
    expect(putBytesMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task 10 — byte serving and delete
// ---------------------------------------------------------------------------
const ATT_ID = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111';
const SHA = 'd'.repeat(64);

/** Shape the leftJoin lookup returns: { attachment, comment } */
function joinRow(over: Record<string, unknown> = {}, commentOver: Record<string, unknown> | null = {}) {
  return [{
    attachment: {
      id: ATT_ID,
      ticketId: TICKET_ID,
      commentId: 'c-1',
      uploadedByUserId: 'u-1',
      storageBackend: 'db',
      storageKey: null,
      data: Buffer.from('bytes'),
      contentType: 'image/png',
      byteSize: 5,
      originalFilename: 'photo.png',
      sha256: SHA,
      createdAt: new Date('2026-08-30T00:00:00Z'),
      ...over,
    },
    comment: commentOver === null ? null : { id: 'c-1', isPublic: true, deletedAt: null, userId: 'u-1', ...commentOver },
  }];
}

function content(headers: Record<string, string> = {}, attId = ATT_ID, ticketId = TICKET_ID) {
  return app.request(`/${ticketId}/attachments/${attId}/content`, { method: 'GET', headers });
}

describe('GET /tickets/:id/attachments/:attachmentId/content (W08 #3902)', () => {
  it('404s when no row matches (id + ticket_id)', async () => {
    dbRowMock.mockReturnValue([]);
    const res = await content();
    expect(res.status).toBe(404);
    expect(openBytesMock).not.toHaveBeenCalled();
  });

  it('404s a PENDING row for anyone but its uploader', async () => {
    dbRowMock.mockReturnValue(joinRow({ commentId: null, uploadedByUserId: 'someone-else' }, null));
    const res = await content();
    expect(res.status).toBe(404);
    expect(openBytesMock).not.toHaveBeenCalled();
  });

  it('serves a PENDING row to its own uploader', async () => {
    dbRowMock.mockReturnValue(joinRow({ commentId: null, uploadedByUserId: 'u-1' }, null));
    const res = await content();
    expect(res.status).toBe(200);
  });

  it('404s when the parent comment is soft-deleted and the caller lacks tickets:manage', async () => {
    dbRowMock.mockReturnValue(joinRow({}, { deletedAt: new Date() }));
    const res = await content();
    expect(res.status).toBe(404);
    expect(openBytesMock).not.toHaveBeenCalled();
  });

  it('serves a soft-deleted parent comment to a tickets:manage caller', async () => {
    authRef.current = { ...authRef.current, permissions: { permissions: [{ resource: 'tickets', action: 'manage' }] } } as never;
    dbRowMock.mockReturnValue(joinRow({}, { deletedAt: new Date() }));
    const res = await content();
    expect(res.status).toBe(200);
  });

  it('404s when the ticket itself is out of scope', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(null);
    dbRowMock.mockReturnValue(joinRow());
    const res = await content();
    expect(res.status).toBe(404);
    expect(openBytesMock).not.toHaveBeenCalled();
  });

  it('sends the D7 header set with the STORED content type', async () => {
    dbRowMock.mockReturnValue(joinRow());
    const res = await content();
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBe(`"${SHA}"`);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Type')).toBe('image/png');
    // W08: the RFC 5987 parameter rides alongside the ASCII fallback so a
    // non-latin-1 filename cannot 500 the route (see the non-ASCII case below).
    expect(res.headers.get('Content-Disposition')).toBe(`inline; filename="photo.png"; filename*=UTF-8''photo.png`);
  });

  it('uses Content-Disposition: attachment for a PDF', async () => {
    dbRowMock.mockReturnValue(joinRow({ contentType: 'application/pdf', originalFilename: 'report.pdf' }));
    const res = await content();
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
  });

  it('strips quotes and newlines out of the Content-Disposition filename (header injection)', async () => {
    dbRowMock.mockReturnValue(joinRow({ originalFilename: 'ev"il\r\nX-Injected: 1.png' }));
    const res = await content();
    const cd = res.headers.get('Content-Disposition')!;
    // No CR/LF can survive, so nothing can start a new header line...
    expect(cd).not.toMatch(/[\r\n]/);
    // ...and exactly two quotes remain: the delimiters.
    expect(cd.match(/"/g)).toHaveLength(2);
    expect(res.headers.get('X-Injected')).toBeNull();
  });

  it('keeps a non-ASCII filename out of the raw header and offers it via RFC 5987', async () => {
    // A Node header value must be latin-1; a CJK or emoji filename in the
    // quoted-string form throws ERR_INVALID_CHAR and 500s the byte route, so
    // an ordinary upload named 写真.png would be permanently unreadable.
    dbRowMock.mockReturnValue(joinRow({ originalFilename: '写真.png' }));
    const res = await content();
    expect(res.status).toBe(200);
    const cd = res.headers.get('Content-Disposition')!;
    // Every code unit is latin-1 representable...
    expect([...cd].every((ch) => ch.charCodeAt(0) <= 0xff)).toBe(true);
    // ...the ASCII fallback is still a usable name...
    expect(cd).toMatch(/^inline; filename="[^"]+"/);
    // ...and the real name survives percent-encoded.
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).toContain(encodeURIComponent('写真.png'));
  });

  it('304s on a matching If-None-Match WITHOUT fetching the bytes', async () => {
    dbRowMock.mockReturnValue(joinRow());
    const res = await content({ 'If-None-Match': `"${SHA}"` });
    expect(res.status).toBe(304);
    expect(openBytesMock).not.toHaveBeenCalled();
  });

  it('200s when If-None-Match does not match', async () => {
    dbRowMock.mockReturnValue(joinRow());
    const res = await content({ 'If-None-Match': '"stale"' });
    expect(res.status).toBe(200);
    expect(openBytesMock).toHaveBeenCalledTimes(1);
  });

  it('404s when the stored object has vanished', async () => {
    dbRowMock.mockReturnValue(joinRow({ storageBackend: 's3', storageKey: 'ticket-attachments/x', data: null }));
    openBytesMock.mockResolvedValue({ body: null, contentLength: null });
    const res = await content();
    expect(res.status).toBe(404);
  });
});

describe('DELETE /tickets/:id/attachments/:attachmentId (W08 #3902)', () => {
  function del(attId = ATT_ID) {
    return app.request(`/${TICKET_ID}/attachments/${attId}`, { method: 'DELETE' });
  }

  it('404s when there is no matching row', async () => {
    dbRowMock.mockReturnValue([]);
    expect((await del()).status).toBe(404);
  });

  it('lets the uploader delete their own pending attachment', async () => {
    dbRowMock.mockReturnValue(joinRow({ commentId: null, uploadedByUserId: 'u-1' }, null));
    expect((await del()).status).toBe(204);
    expect(deleteBytesMock).toHaveBeenCalledTimes(1);
  });

  it('403s another user\'s attachment without tickets:manage', async () => {
    dbRowMock.mockReturnValue(joinRow({ uploadedByUserId: 'someone-else' }));
    expect((await del()).status).toBe(403);
    expect(deleteBytesMock).not.toHaveBeenCalled();
    expect(deletedRowIds).toHaveLength(0);
  });

  it('lets a tickets:manage caller delete anyone\'s attachment', async () => {
    authRef.current = { ...authRef.current, permissions: { permissions: [{ resource: 'tickets', action: 'manage' }] } } as never;
    dbRowMock.mockReturnValue(joinRow({ uploadedByUserId: 'someone-else' }));
    expect((await del()).status).toBe(204);
  });

  it('deletes the OBJECT before the row (same reasoning as D9)', async () => {
    // Both markers are pushed from inside the request: 'row' comes from the
    // db.delete stub, not from the test body after await. Pushing it here
    // afterwards made the assertion true for a row-first implementation too.
    deleteBytesMock.mockImplementation(async () => { dbEventOrder.push('object'); });
    dbRowMock.mockReturnValue(joinRow({ storageBackend: 's3', storageKey: 'ticket-attachments/x', data: null }));
    const res = await del();
    expect(res.status).toBe(204);
    expect(dbEventOrder).toEqual(['object', 'row']);
    expect(deletedRowIds).toHaveLength(1);
  });

  it('does NOT delete the row when the object delete fails', async () => {
    deleteBytesMock.mockRejectedValue(new Error('s3 down'));
    dbRowMock.mockReturnValue(joinRow({ storageBackend: 's3', storageKey: 'ticket-attachments/x', data: null }));
    const res = await del();
    expect(res.status).toBe(503);
    expect(deletedRowIds).toHaveLength(0);
  });
});

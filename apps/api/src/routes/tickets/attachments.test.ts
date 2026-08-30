import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  authRef, getScopedTicketOr404Mock, dbSelectMock, dbInsertReturningMock,
  selectColumnArgs, insertedValues, putBytesMock, deleteBytesMock, auditMock, rateLimitAllowed,
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
  auditMock: vi.fn(),
  rateLimitAllowed: { current: true },
}));

vi.mock('../../middleware/auth', async () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
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
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
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
  return { ...actual, putBytes: putBytesMock, deleteBytes: deleteBytesMock };
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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// #6633 — evidence file on an accept-on-behalf acceptance. Drives the REAL
// requireScope/requirePermission middleware and the REAL evidence service; only
// the permission lookup, the quote org-access read, the DB and the blob store
// are stubbed.

const permState = vi.hoisted(() => ({ perms: [] as string[] }));
vi.mock('../../services/permissions', async (importActual) => {
  const actual = await importActual<typeof import('../../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({
      permissions: permState.perms.map((p) => { const [resource, action] = p.split(':'); return { resource, action }; }),
      partnerId: 'p1', orgId: null, roleId: 'r1', scope: 'partner' as const,
    })),
  };
});

// A queue-driven fake of the Drizzle query builder: every chained call returns
// the same thenable, and awaiting it yields the next queued result. `calls`
// records the terminal builder methods so a test can see what was written.
const dbState = vi.hoisted(() => ({
  results: [] as unknown[],
  sets: [] as Array<Record<string, unknown>>,
  forUpdate: 0,
}));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  const self = new Proxy(chain, {
    get(_t, prop) {
      if (prop === 'then') {
        const next = dbState.results.shift();
        return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
          next instanceof Error ? reject(next) : resolve(next ?? []);
      }
      return (...args: unknown[]) => {
        if (prop === 'set') dbState.sets.push(args[0] as Record<string, unknown>);
        if (prop === 'for') dbState.forUpdate += 1;
        return self;
      };
    },
  });
  const db = {
    select: () => self,
    update: () => self,
    transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn(db),
  };
  return { db };
});

const blob = vi.hoisted(() => ({
  putBlob: vi.fn(),
  deleteBlob: vi.fn(async () => undefined),
  getBlobStream: vi.fn(),
}));
vi.mock('../../services/blobStorage', async (importActual) => {
  const actual = await importActual<typeof import('../../services/blobStorage')>();
  return { ...actual, putBlob: blob.putBlob, deleteBlob: blob.deleteBlob, getBlobStream: blob.getBlobStream };
});

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/quoteService', () => ({ getQuote: vi.fn() }));
vi.mock('./quotes', async () => {
  const { QuoteServiceError } = await import('../../services/quoteTypes');
  return {
    quoteActorFrom: () => ({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: null }),
    handleServiceError: (c: { json: (b: unknown, s: number) => Response }, err: unknown) => {
      if (err instanceof QuoteServiceError) return c.json({ error: err.message, code: err.code }, err.status);
      throw err;
    },
  };
});

import { quoteAcceptanceEvidenceRoutes } from './acceptanceEvidence';
import { getQuote } from '../../services/quoteService';
import { QuoteServiceError } from '../../services/quoteTypes';
import { writeRouteAudit } from '../../services/auditEvents';
import { BlobStorageError } from '../../services/blobStorage';

const QUOTE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const ACCEPTANCE_ID = '44444444-4444-4444-8444-444444444444';
const URL = `/${QUOTE_ID}/acceptance/evidence`;

const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\nbody', 'latin1');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(32)]);

function appWith(perms: string[], scope: 'partner' | 'organization' = 'partner') {
  permState.perms = perms;
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope } as never); await next(); });
  a.route('/', quoteAcceptanceEvidenceRoutes);
  return a;
}

function upload(buf: Buffer, name = 'PO-4471.pdf', type = 'application/pdf') {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(buf)], name, { type }));
  return { method: 'POST', body: form };
}

function latest(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCEPTANCE_ID, origin: 'on_behalf',
    evidenceStorageBackend: null, evidenceStorageKey: null,
    evidenceFilename: null, evidenceContentType: null, evidenceSizeBytes: null,
    evidenceSha256: null, evidenceUploadedAt: null,
    ...overrides,
  };
}

const ACCEPT = ['quotes:read', 'quotes:accept'];

beforeEach(() => {
  dbState.results = [];
  dbState.sets = [];
  dbState.forUpdate = 0;
  vi.mocked(getQuote).mockReset();
  vi.mocked(getQuote).mockResolvedValue({ quote: { id: QUOTE_ID, orgId: ORG_ID, status: 'converted' }, blocks: [] } as never);
  blob.putBlob.mockReset();
  blob.putBlob.mockImplementation(async (args: { prefix: string; id: string }) => ({
    backend: 's3', storageKey: `${args.prefix}/${args.id}`, data: null,
  }));
  blob.deleteBlob.mockClear();
  blob.getBlobStream.mockReset();
  vi.mocked(writeRouteAudit).mockClear();
});

describe('POST /:id/acceptance/evidence — RBAC (quotes:accept)', () => {
  it('403s a quotes:read + quotes:write holder without quotes:accept', async () => {
    const res = await appWith(['quotes:read', 'quotes:write', 'quotes:send']).request(URL, upload(PDF));
    expect(res.status).toBe(403);
    expect(blob.putBlob).not.toHaveBeenCalled();
  });

  it('403s an organization-scoped token even with quotes:accept', async () => {
    const res = await appWith(ACCEPT, 'organization').request(URL, upload(PDF));
    expect(res.status).toBe(403);
  });

  it('passes the gate for a quotes:accept holder', async () => {
    dbState.results = [[latest()], [latest()], [{ id: ACCEPTANCE_ID }]];
    const res = await appWith(ACCEPT).request(URL, upload(PDF));
    expect(res.status).toBe(200);
  });
});

describe('POST /:id/acceptance/evidence — refusals', () => {
  it('404s a quote outside the caller\'s orgs, before touching storage', async () => {
    vi.mocked(getQuote).mockRejectedValue(new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND'));
    const res = await appWith(ACCEPT).request(URL, upload(PDF));
    expect(res.status).toBe(404);
    expect(blob.putBlob).not.toHaveBeenCalled();
    expect(dbState.sets).toHaveLength(0);
  });

  it('409s when the latest acceptance is a CUSTOMER acceptance', async () => {
    dbState.results = [[latest({ origin: 'customer' })]];
    const res = await appWith(ACCEPT).request(URL, upload(PDF));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ACCEPTANCE_NOT_ON_BEHALF');
    expect(blob.putBlob).not.toHaveBeenCalled();
    expect(dbState.sets).toHaveLength(0);
  });

  it('409s when the quote has no acceptance at all', async () => {
    dbState.results = [[]];
    const res = await appWith(ACCEPT).request(URL, upload(PDF));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('QUOTE_NOT_ACCEPTED');
    expect(blob.putBlob).not.toHaveBeenCalled();
  });

  it('415s a file that is not a PDF/PNG/JPEG by content, whatever its header says', async () => {
    dbState.results = [[latest()]];
    const res = await appWith(ACCEPT).request(URL, upload(Buffer.from('<html>not a pdf</html>'), 'PO.pdf', 'application/pdf'));
    expect(res.status).toBe(415);
    expect((await res.json()).code).toBe('UNSUPPORTED_EVIDENCE_TYPE');
    expect(blob.putBlob).not.toHaveBeenCalled();
  });

  it('415s a WebP image (only PDF, PNG and JPEG are evidence types)', async () => {
    dbState.results = [[latest()]];
    const res = await appWith(ACCEPT).request(URL, upload(WEBP, 'scan.webp', 'image/webp'));
    expect(res.status).toBe(415);
    expect(blob.putBlob).not.toHaveBeenCalled();
  });

  it('413s a file over 10 MB', async () => {
    dbState.results = [[latest()]];
    const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]);
    const res = await appWith(ACCEPT).request(URL, upload(big));
    expect(res.status).toBe(413);
    expect(blob.putBlob).not.toHaveBeenCalled();
  });

  it('400s an empty file', async () => {
    dbState.results = [[latest()]];
    const res = await appWith(ACCEPT).request(URL, upload(Buffer.alloc(0)));
    expect(res.status).toBe(400);
    expect(blob.putBlob).not.toHaveBeenCalled();
  });

  it('400s a body with no file part', async () => {
    const form = new FormData();
    form.append('note', 'no file');
    const res = await appWith(ACCEPT).request(URL, { method: 'POST', body: form });
    expect(res.status).toBe(400);
  });

  it('503s when the blob store is down, writing no row', async () => {
    dbState.results = [[latest()]];
    blob.putBlob.mockRejectedValue(new BlobStorageError('down'));
    const res = await appWith(ACCEPT).request(URL, upload(PDF));
    expect(res.status).toBe(503);
    expect(dbState.sets).toHaveLength(0);
  });
});

describe('POST /:id/acceptance/evidence — attach', () => {
  it('stores the SNIFFED type (not the header), records metadata and audits', async () => {
    dbState.results = [[latest()], [latest()], [{ id: ACCEPTANCE_ID }]];
    // A real PDF uploaded with a lying image/png header.
    const res = await appWith(ACCEPT).request(URL, upload(PDF, 'PO-4471.pdf', 'image/png'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.acceptanceId).toBe(ACCEPTANCE_ID);
    expect(body.data.evidence).toMatchObject({ filename: 'PO-4471.pdf', contentType: 'application/pdf', sizeBytes: PDF.length });
    expect(typeof body.data.evidence.uploadedAt).toBe('string');

    expect(blob.putBlob).toHaveBeenCalledTimes(1);
    const put = blob.putBlob.mock.calls[0]![0] as { prefix: string; id: string; contentType: string };
    expect(put.prefix).toBe('quote-acceptance-evidence');
    expect(put.contentType).toBe('application/pdf');
    // The object key carries no tenant identifier (blobStorage spec D8).
    expect(put.id).not.toContain(ORG_ID);
    expect(put.id).not.toContain(QUOTE_ID);

    // The row update is locked and records who/what/where.
    expect(dbState.forUpdate).toBe(1);
    expect(dbState.sets).toHaveLength(1);
    expect(dbState.sets[0]).toMatchObject({
      evidenceStorageBackend: 's3',
      evidenceStorageKey: `quote-acceptance-evidence/${put.id}`,
      evidenceData: null,
      evidenceFilename: 'PO-4471.pdf',
      evidenceContentType: 'application/pdf',
      evidenceSizeBytes: PDF.length,
      evidenceUploadedByUserId: 'u1',
    });

    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
    const audit = vi.mocked(writeRouteAudit).mock.calls[0]![1];
    expect(audit).toMatchObject({
      action: 'quote.acceptance_evidence_attached', orgId: ORG_ID, resourceId: QUOTE_ID,
      details: { acceptanceId: ACCEPTANCE_ID, contentType: 'application/pdf', replaced: false },
    });
    expect(blob.deleteBlob).not.toHaveBeenCalled();
  });

  it('accepts a PNG scan', async () => {
    dbState.results = [[latest()], [latest()], [{ id: ACCEPTANCE_ID }]];
    const res = await appWith(ACCEPT).request(URL, upload(PNG, 'scan.png', 'image/png'));
    expect(res.status).toBe(200);
    expect((await res.json()).data.evidence.contentType).toBe('image/png');
  });

  it('replaces a prior file and deletes the OLD object after the row points at the new one', async () => {
    const prior = latest({
      evidenceStorageBackend: 's3', evidenceStorageKey: 'quote-acceptance-evidence/old',
      evidenceFilename: 'old.pdf', evidenceContentType: 'application/pdf', evidenceSizeBytes: 10,
      evidenceSha256: 'aa'.repeat(32), evidenceUploadedAt: new Date(),
    });
    dbState.results = [[prior], [prior], [{ id: ACCEPTANCE_ID }]];
    const res = await appWith(ACCEPT).request(URL, upload(PDF));
    expect(res.status).toBe(200);
    expect(blob.deleteBlob).toHaveBeenCalledWith({ storageBackend: 's3', storageKey: 'quote-acceptance-evidence/old', data: null });
    expect(vi.mocked(writeRouteAudit).mock.calls[0]![1]).toMatchObject({ details: { replaced: true } });
  });

  it('still succeeds when deleting the replaced object fails (logged, not surfaced)', async () => {
    const prior = latest({
      evidenceStorageBackend: 's3', evidenceStorageKey: 'quote-acceptance-evidence/old',
      evidenceFilename: 'old.pdf', evidenceContentType: 'application/pdf', evidenceSizeBytes: 10,
      evidenceSha256: 'aa'.repeat(32), evidenceUploadedAt: new Date(),
    });
    dbState.results = [[prior], [prior], [{ id: ACCEPTANCE_ID }]];
    blob.deleteBlob.mockRejectedValueOnce(new Error('bucket hiccup'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await appWith(ACCEPT).request(URL, upload(PDF));
    expect(res.status).toBe(200);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('deletes the just-put object when the row update fails, and surfaces the failure', async () => {
    dbState.results = [[latest()], [latest()], new Error('db down')];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await appWith(ACCEPT).request(URL, upload(PDF));
    errSpy.mockRestore();
    expect(res.status).toBe(500);
    const put = blob.putBlob.mock.calls[0]![0] as { prefix: string; id: string };
    expect(blob.deleteBlob).toHaveBeenCalledWith({ storageBackend: 's3', storageKey: `quote-acceptance-evidence/${put.id}`, data: null });
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
});

describe('GET /:id/acceptance/evidence', () => {
  const stored = latest({
    evidenceStorageBackend: 'db', evidenceStorageKey: null,
    evidenceFilename: 'PO "4471".pdf', evidenceContentType: 'application/pdf', evidenceSizeBytes: PDF.length,
    evidenceSha256: 'ab'.repeat(32), evidenceUploadedAt: new Date('2026-09-22T10:00:00Z'),
  });

  it('403s without quotes:read', async () => {
    const res = await appWith(['quotes:write']).request(URL);
    expect(res.status).toBe(403);
  });

  it('404s a quote outside the caller\'s orgs', async () => {
    vi.mocked(getQuote).mockRejectedValue(new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND'));
    const res = await appWith(['quotes:read']).request(URL);
    expect(res.status).toBe(404);
    expect(blob.getBlobStream).not.toHaveBeenCalled();
  });

  it('404s when the acceptance carries no evidence', async () => {
    dbState.results = [[latest()]];
    const res = await appWith(['quotes:read']).request(URL);
    expect(res.status).toBe(404);
    expect(blob.getBlobStream).not.toHaveBeenCalled();
  });

  it('streams the file as a download with the STORED type and nosniff', async () => {
    dbState.results = [[stored], [{ evidenceData: PDF }]];
    blob.getBlobStream.mockResolvedValue({ body: PDF, contentLength: PDF.length });
    const res = await appWith(['quotes:read']).request(URL);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('attachment;')).toBe(true);
    expect(disposition).not.toContain('"4471"'); // quotes stripped — no header injection
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it('404s (and logs) when the row names an object the store no longer has', async () => {
    dbState.results = [[{ ...stored, evidenceStorageBackend: 's3', evidenceStorageKey: 'quote-acceptance-evidence/gone' }]];
    blob.getBlobStream.mockResolvedValue({ body: null, contentLength: null });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await appWith(['quotes:read']).request(URL);
    expect(res.status).toBe(404);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

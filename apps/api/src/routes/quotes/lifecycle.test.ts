import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Route-level RBAC test for POST /:id/send. The previously-vacuous
// quoteSendRbac.integration.test.ts only compared permission CONSTANTS; this
// drives the REAL requireScope + requirePermission middleware on the actual
// mounted send route, with a controllable permission set, so it would catch the
// exact regression the old test could not: the route being gated on the wrong
// permission (e.g. quotes:write) or ungated.

// Controllable grant set, read by the mocked getUserPermissions below.
const permState = vi.hoisted(() => ({ perms: ['quotes:read', 'quotes:write'] }));

// Keep the REAL requirePermission/requireScope/hasPermission; only stub the
// DB-backed getUserPermissions so requirePermission resolves a known grant set.
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

// Stub the services the route file imports so mounting it never touches the DB.
vi.mock('../../services/quoteLifecycle', () => ({
  sendQuote: vi.fn(async () => ({ quote: { id: 'q1', status: 'sent' }, emailed: false, acceptUrl: 'http://x/quote/t' })),
}));
vi.mock('../../services/quoteService', () => ({ getQuote: vi.fn() }));
vi.mock('../../services/quoteImageStorage', () => ({
  writeQuoteImage: vi.fn(), readQuoteImage: vi.fn(), sniffImageMime: vi.fn(), MAX_QUOTE_IMAGE_SIZE_BYTES: 5 * 1024 * 1024,
  fetchRemoteImage: vi.fn(),
  RemoteImageError: class RemoteImageError extends Error {
    constructor(public reason: string, msg: string) { super(msg); this.name = 'RemoteImageError'; }
  },
}));
vi.mock('./quotes', () => ({
  quoteActorFrom: () => ({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: null }),
  handleServiceError: (_c: unknown, err: unknown) => { throw err; },
}));
vi.mock('../../services/contractTemplateRender', () => ({ loadContractBlockRenderData: vi.fn() }));

import { quoteLifecycleRoutes } from './lifecycle';
import { getQuote } from '../../services/quoteService';
import { fetchRemoteImage, writeQuoteImage, RemoteImageError } from '../../services/quoteImageStorage';
import { loadContractBlockRenderData } from '../../services/contractTemplateRender';

const QUOTE_ID = '11111111-1111-4111-8111-111111111111';
const BLOCK_ID = '22222222-2222-4222-8222-222222222222';

function appWith(scope: 'partner' | 'system' | 'organization', perms: string[]) {
  permState.perms = perms;
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope } as never); await next(); });
  a.route('/', quoteLifecycleRoutes);
  return a;
}

describe('POST /:id/send RBAC (quotes:send)', () => {
  it('403s a quotes:read + quotes:write user without quotes:send', async () => {
    const res = await appWith('partner', ['quotes:read', 'quotes:write']).request(`/${QUOTE_ID}/send`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('passes the permission gate for a quotes:send holder', async () => {
    const res = await appWith('partner', ['quotes:read', 'quotes:write', 'quotes:send']).request(`/${QUOTE_ID}/send`, { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('403s a wrong scope (organization) even with quotes:send', async () => {
    const res = await appWith('organization', ['quotes:send']).request(`/${QUOTE_ID}/send`, { method: 'POST' });
    expect(res.status).toBe(403);
  });
});

describe('POST /:id/send — composer body', () => {
  const PERMS = ['quotes:read', 'quotes:write', 'quotes:send'];
  const jsonReq = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('forwards to/cc/subject/includePdf/message to the service', async () => {
    const { sendQuote } = await import('../../services/quoteLifecycle');
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/send`, jsonReq({
      to: ['buyer@customer.example'], cc: ['cfo@customer.example'],
      subject: 'Your refresh', includePdf: false, message: 'hi',
    }));
    expect(res.status).toBe(200);
    expect(vi.mocked(sendQuote)).toHaveBeenCalledWith(QUOTE_ID, expect.anything(), {
      to: ['buyer@customer.example'], cc: ['cfo@customer.example'],
      subject: 'Your refresh', includePdf: false, message: 'hi',
    });
  });

  it('400s an invalid recipient email', async () => {
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/send`, jsonReq({ to: ['not-an-email'] }));
    expect(res.status).toBe(400);
  });

  it('400s an empty to array (explicit recipients must be non-empty)', async () => {
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/send`, jsonReq({ to: [] }));
    expect(res.status).toBe(400);
  });

  it('400s an unknown field (strict body)', async () => {
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/send`, jsonReq({ bcc: ['x@y.z'] }));
    expect(res.status).toBe(400);
  });
});

describe('POST /:id/images — from URL (JSON body)', () => {
  const PERMS = ['quotes:read', 'quotes:write'];
  const jsonReq = (url: string) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getQuote).mockResolvedValue({ quote: { orgId: 'org-1' } } as never);
    vi.mocked(writeQuoteImage).mockResolvedValue({ id: 'img-9', byteSize: 1234, sha256: 'x' } as never);
  });

  it('copies the remote image and returns the new imageId', async () => {
    vi.mocked(fetchRemoteImage).mockResolvedValue({ mime: 'image/png', buffer: Buffer.from([1, 2, 3]) });
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, jsonReq('https://cdn.example.com/a.png'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { imageId: 'img-9', mime: 'image/png', byteSize: 1234 } });
    expect(fetchRemoteImage).toHaveBeenCalledWith('https://cdn.example.com/a.png');
    expect(writeQuoteImage).toHaveBeenCalledWith(QUOTE_ID, 'org-1', 'image/png', expect.any(Buffer));
  });

  it('400s a non-http(s) scheme without fetching', async () => {
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, jsonReq('ftp://cdn/a.png'));
    expect(res.status).toBe(400);
    expect(fetchRemoteImage).not.toHaveBeenCalled();
  });

  it('413s an oversized remote image', async () => {
    vi.mocked(fetchRemoteImage).mockRejectedValue(new RemoteImageError('too_large', 'Image is larger than 5 MB'));
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, jsonReq('https://cdn/big.png'));
    expect(res.status).toBe(413);
    expect(writeQuoteImage).not.toHaveBeenCalled();
  });

  it('415s a URL whose bytes are not a supported image', async () => {
    vi.mocked(fetchRemoteImage).mockRejectedValue(new RemoteImageError('not_image', "That URL isn't a PNG, JPEG, or WebP image"));
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, jsonReq('https://cdn/page.png'));
    expect(res.status).toBe(415);
  });

  it('502s an unreachable / blocked URL', async () => {
    vi.mocked(fetchRemoteImage).mockRejectedValue(new RemoteImageError('unreachable', "Couldn't reach that URL"));
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, jsonReq('https://internal/a.png'));
    expect(res.status).toBe(502);
    expect(writeQuoteImage).not.toHaveBeenCalled();
  });

  it('504s when the remote image download times out', async () => {
    vi.mocked(fetchRemoteImage).mockRejectedValue(new RemoteImageError('timeout', 'The image took too long to download'));
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, jsonReq('https://slow/a.png'));
    expect(res.status).toBe(504);
  });

  it('400s malformed JSON without fetching', async () => {
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not valid json',
    });
    expect(res.status).toBe(400);
    expect(fetchRemoteImage).not.toHaveBeenCalled();
  });

  it('rethrows an unexpected (non-RemoteImageError) error to handleServiceError', async () => {
    vi.mocked(fetchRemoteImage).mockRejectedValue(new Error('boom'));
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, jsonReq('https://cdn/a.png'));
    expect(res.status).toBe(500);
    expect(writeQuoteImage).not.toHaveBeenCalled();
  });
});

describe('GET /:id/contract-file/:blockId', () => {
  const PERMS = ['quotes:read', 'quotes:write'];
  const uploadedRenderData = {
    blockId: BLOCK_ID, templateId: 'tmpl-1', templateVersionId: 'ver-1', sourceType: 'uploaded' as const,
    bodyHtml: null, fileData: Buffer.from('%PDF-1.4'), versionSha256: 'sha', declaredVariables: [],
    templateName: 'MSA', versionNumber: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams application/pdf for an uploaded contract block on the caller\'s own quote', async () => {
    vi.mocked(getQuote).mockResolvedValue({
      quote: { id: QUOTE_ID, orgId: 'org-1' },
      blocks: [{ id: BLOCK_ID, blockType: 'contract', content: { templateId: 'tmpl-1', templateVersionId: 'ver-1' } }],
      lines: [],
    } as never);
    vi.mocked(loadContractBlockRenderData).mockResolvedValue([uploadedRenderData]);

    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/contract-file/${BLOCK_ID}`, { method: 'GET' });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.toString()).toBe('%PDF-1.4');
  });

  it('404s a blockId that does not belong to this quote (cross-quote blockId)', async () => {
    vi.mocked(getQuote).mockResolvedValue({
      quote: { id: QUOTE_ID, orgId: 'org-1' },
      blocks: [], // the requested blockId isn't among THIS quote's blocks
      lines: [],
    } as never);

    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/contract-file/${BLOCK_ID}`, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(loadContractBlockRenderData).not.toHaveBeenCalled();
  });

  it('404s when the referenced block is an authored (not uploaded) contract, with no file bytes to stream', async () => {
    vi.mocked(getQuote).mockResolvedValue({
      quote: { id: QUOTE_ID, orgId: 'org-1' },
      blocks: [{ id: BLOCK_ID, blockType: 'contract', content: { templateId: 'tmpl-1', templateVersionId: 'ver-1' } }],
      lines: [],
    } as never);
    vi.mocked(loadContractBlockRenderData).mockResolvedValue([{ ...uploadedRenderData, sourceType: 'authored', fileData: null, bodyHtml: '<p>hi</p>' }]);

    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/contract-file/${BLOCK_ID}`, { method: 'GET' });
    expect(res.status).toBe(404);
  });
});

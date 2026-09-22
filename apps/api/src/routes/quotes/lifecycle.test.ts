import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// #3905 — /send and /resend are registered in SELF_MANAGED_DB_CONTEXT_ROUTES, so
// they open their OWN short transaction via withAuthDbAccessContext and run the
// returned deferred after it commits. The real helper opens a Postgres
// transaction; run the callback inline instead. Everything else in the auth
// module (requireScope, requirePermission, hasPermission) stays REAL — this
// file's whole point is driving the actual RBAC middleware.
const { withAuthDbAccessContextMock } = vi.hoisted(() => ({
  withAuthDbAccessContextMock: vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../middleware/auth', async (importActual) => {
  const actual = await importActual<typeof import('../../middleware/auth')>();
  return { ...actual, withAuthDbAccessContext: withAuthDbAccessContextMock };
});

// Stub the services the route file imports so mounting it never touches the DB.
vi.mock('../../services/quoteLifecycle', () => ({
  sendQuote: vi.fn(async () => ({
    quote: { id: 'q1', status: 'sent' }, acceptUrl: 'http://x/quote/t',
    deliverEmail: vi.fn(async () => ({ quote: { id: 'q1', status: 'sent' }, emailed: false })),
  })),
  resendQuote: vi.fn(async () => ({
    quote: { id: 'q1', orgId: 'org1', status: 'sent' }, acceptUrl: 'http://x/quote/t',
    origin: 'reproduced', reissued: false,
    deliverEmail: vi.fn(async () => ({ quote: { id: 'q1', orgId: 'org1', status: 'sent' }, emailed: true })),
  })),
  getQuoteShareLink: vi.fn(async () => ({ acceptUrl: 'http://x/quote/t', origin: 'reproduced', reissued: false, recipients: ['ap@customer.example'], orgId: 'org1' })),
  getQuoteRecipients: vi.fn(async () => []),
}));
// The two new routes audit-log; the writer is fire-and-forget and DB-backed.
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/quoteService', () => ({ getQuote: vi.fn() }));
vi.mock('../../jobs/quoteSendQueue', () => ({
  scheduleQuoteSend: vi.fn(),
  cancelQuoteSend: vi.fn(),
}));
// QUOTE_IMAGE_WEBP_REJECTED_MESSAGE comes from the REAL module (importActual)
// rather than a hardcoded copy here — a hardcoded duplicate would let the
// mock and the real constant drift apart silently, since every assertion
// below compares the route's response against this same import.
vi.mock('../../services/quoteImageStorage', async (importActual) => {
  const actual = await importActual<typeof import('../../services/quoteImageStorage')>();
  return {
    writeQuoteImage: vi.fn(), readQuoteImage: vi.fn(), sniffImageMime: vi.fn(), MAX_QUOTE_IMAGE_SIZE_BYTES: 5 * 1024 * 1024,
    fetchRemoteImage: vi.fn(),
    QUOTE_IMAGE_WEBP_REJECTED_MESSAGE: actual.QUOTE_IMAGE_WEBP_REJECTED_MESSAGE,
    RemoteImageError: class RemoteImageError extends Error {
      constructor(public reason: string, msg: string) { super(msg); this.name = 'RemoteImageError'; }
    },
  };
});
vi.mock('./quotes', () => ({
  quoteActorFrom: () => ({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: null }),
  handleServiceError: (_c: unknown, err: unknown) => { throw err; },
}));
vi.mock('../../services/contractTemplateRender', () => ({ loadContractBlockRenderData: vi.fn() }));
// accept-on-behalf: the accept pipeline and its post-commit side effects. Every
// one of them opens a real DB context or an SMTP/Redis round trip.
vi.mock('../../services/quoteAcceptService', () => ({
  acceptQuote: vi.fn(async () => ({
    quote: { id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'converted', quoteNumber: 'Q-2026-0001', revisionNumber: 1 },
    acceptanceId: 'acc1', invoiceId: 'inv1', invoiceIssued: true, invoiceNumber: 'INV-2026-0007',
    contractIds: ['c1'], pax8OrderId: null, contractDocumentIds: [], superseded: undefined,
  })),
  emitAcceptInvoiceIssued: vi.fn(),
  resolveAcceptInvoiceUrl: vi.fn(async () => 'https://portal.example/invoice/tok'),
  autoEmailAcceptedInvoice: vi.fn(),
}));
vi.mock('../../services/quoteOutcomeNotify', () => ({ notifyQuoteOutcome: vi.fn() }));
// The accept runs under runOutsideDbContext(withSystemDbAccessContext(...)); the
// real helpers open a Postgres transaction. Run the callback inline. Everything
// else in the db module stays real (nothing else here reads it).
vi.mock('../../db', async (importActual) => {
  const actual = await importActual<typeof import('../../db')>();
  return {
    ...actual,
    runOutsideDbContext: vi.fn(<T,>(fn: () => T) => fn()),
    withSystemDbAccessContext: vi.fn(async <T,>(fn: () => Promise<T>) => fn()),
  };
});

import { quoteLifecycleRoutes } from './lifecycle';
import { getQuote } from '../../services/quoteService';
import { scheduleQuoteSend, cancelQuoteSend } from '../../jobs/quoteSendQueue';
import { fetchRemoteImage, writeQuoteImage, sniffImageMime, RemoteImageError, QUOTE_IMAGE_WEBP_REJECTED_MESSAGE } from '../../services/quoteImageStorage';
import { loadContractBlockRenderData } from '../../services/contractTemplateRender';
import { isSelfManagedDbContextRoute } from '../../middleware/selfManagedDbContextRoutes';

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

/**
 * #3905 — the ordering contract, at the seam where it is actually decided.
 *
 * `sendQuote` writes the draft→sent claim and, on a revision, holds a
 * `FOR UPDATE` lock on the PARENT quote. Those locks are released by the COMMIT
 * of the transaction `withAuthDbAccessContext` opens — so the email must be
 * delivered strictly after that call resolves, never inside it. Held the old
 * way, a stalled mail server blocked the customer's own accept on the original
 * quote and pinned a pooled connection for the whole round-trip.
 *
 * These assert the ORDER, not just that both happened: an implementation that
 * awaited `deliverEmail()` inside the transaction callback would satisfy every
 * other test in this file and reintroduce the exact bug.
 */
describe('POST /:id/send + /:id/resend — delivery happens after commit (#3905)', () => {
  const PERMS = ['quotes:read', 'quotes:write', 'quotes:send'];

  /** Records the real interleaving of transaction commit vs. email delivery. */
  function trace() {
    const events: string[] = [];
    withAuthDbAccessContextMock.mockImplementation(async (_auth: unknown, fn: () => Promise<unknown>) => {
      events.push('tx:begin');
      const value = await fn();
      events.push('tx:commit');
      return value;
    });
    return events;
  }

  it('runs the send transaction to completion BEFORE the deferred email', async () => {
    const { sendQuote } = await import('../../services/quoteLifecycle');
    const events = trace();
    vi.mocked(sendQuote).mockImplementationOnce(async () => {
      events.push('sendQuote');
      return {
        quote: { id: 'q1', orgId: 'org1', status: 'sent' }, acceptUrl: 'http://x/quote/t',
        deliverEmail: async () => {
          events.push('deliverEmail');
          return { quote: { id: 'q1', orgId: 'org1', status: 'sent' }, emailed: true };
        },
      } as never;
    });

    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/send`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(events).toEqual(['tx:begin', 'sendQuote', 'tx:commit', 'deliverEmail']);
  });

  it('runs the re-send transaction to completion BEFORE the deferred email', async () => {
    const { resendQuote } = await import('../../services/quoteLifecycle');
    const events = trace();
    vi.mocked(resendQuote).mockImplementationOnce(async () => {
      events.push('resendQuote');
      return {
        quote: { id: 'q1', orgId: 'org1', status: 'sent' }, acceptUrl: 'http://x/quote/t',
        origin: 'reproduced', reissued: false,
        deliverEmail: async () => {
          events.push('deliverEmail');
          return { quote: { id: 'q1', orgId: 'org1', status: 'sent' }, emailed: true };
        },
      } as never;
    });

    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/resend`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(events).toEqual(['tx:begin', 'resendQuote', 'tx:commit', 'deliverEmail']);
  });

  it('reports the delivery outcome on the response, so the #3502 banner still fires', async () => {
    const { sendQuote } = await import('../../services/quoteLifecycle');
    trace();
    vi.mocked(sendQuote).mockResolvedValueOnce({
      quote: { id: 'q1', orgId: 'org1', status: 'sent', sendEmailReason: null },
      acceptUrl: 'http://x/quote/t',
      deliverEmail: async () => ({
        // The row the deferred persisted the reason onto — NOT the pre-delivery row.
        quote: { id: 'q1', orgId: 'org1', status: 'sent', sendEmailReason: 'send_failed' },
        emailed: false, emailReason: 'send_failed',
      }),
    } as never);

    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/send`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      emailed: false,
      emailReason: 'send_failed',
      acceptUrl: 'http://x/quote/t',
      quote: { id: 'q1', sendEmailReason: 'send_failed' },
    });
  });
});

describe('POST /:id/schedule-send', () => {
  const PERMS = ['quotes:read', 'quotes:write', 'quotes:send'];
  const FIRE_AT = new Date('2026-07-18T12:00:30.000Z');
  const draftQuote = {
    quote: { id: QUOTE_ID, status: 'draft', orgId: 'org-1' },
    lines: [{ customerVisible: true }],
    blocks: [],
  };
  const jsonReq = (body: unknown) => ({
    method: 'POST' as const,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getQuote).mockResolvedValue(draftQuote as never);
    vi.mocked(scheduleQuoteSend).mockResolvedValue({ sendScheduledAt: FIRE_AT });
  });

  it('403s a quotes:read + quotes:write user without quotes:send (same gate as /send)', async () => {
    const res = await appWith('partner', ['quotes:read', 'quotes:write']).request(`/${QUOTE_ID}/schedule-send`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(scheduleQuoteSend).not.toHaveBeenCalled();
  });

  it('409s (INVALID_STATE) when the quote is not a draft', async () => {
    vi.mocked(getQuote).mockResolvedValue({ ...draftQuote, quote: { ...draftQuote.quote, status: 'sent' } } as never);
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/schedule-send`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'INVALID_STATE' });
    expect(scheduleQuoteSend).not.toHaveBeenCalled();
  });

  it('422s (QUOTE_EMPTY) when the draft has no customer-visible lines', async () => {
    vi.mocked(getQuote).mockResolvedValue({ ...draftQuote, lines: [{ customerVisible: false }] } as never);
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/schedule-send`, { method: 'POST' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'QUOTE_EMPTY' });
    expect(scheduleQuoteSend).not.toHaveBeenCalled();
  });

  it('400s a delaySeconds outside 5..300', async () => {
    for (const delaySeconds of [4, 301, 30.5]) {
      const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/schedule-send`, jsonReq({ delaySeconds }));
      expect(res.status).toBe(400);
    }
    expect(scheduleQuoteSend).not.toHaveBeenCalled();
  });

  it('400s malformed JSON without scheduling', async () => {
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/schedule-send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not valid json',
    });
    expect(res.status).toBe(400);
    expect(scheduleQuoteSend).not.toHaveBeenCalled();
  });

  it('200s with the ISO fire time and forwards delaySeconds as milliseconds', async () => {
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/schedule-send`, jsonReq({ delaySeconds: 60, message: 'hi' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { sendScheduledAt: '2026-07-18T12:00:30.000Z' } });
    expect(vi.mocked(scheduleQuoteSend)).toHaveBeenCalledWith(
      QUOTE_ID,
      expect.anything(),
      expect.objectContaining({ message: 'hi' }),
      60_000,
    );
  });

  it('defaults the undo window to 30s when delaySeconds is omitted (empty body)', async () => {
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/schedule-send`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(vi.mocked(scheduleQuoteSend).mock.calls[0]?.[3]).toBe(30_000);
  });
});

describe('DELETE /:id/schedule-send', () => {
  const PERMS = ['quotes:read', 'quotes:write', 'quotes:send'];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getQuote).mockResolvedValue({ quote: { id: QUOTE_ID, status: 'draft', orgId: 'org-1' }, lines: [], blocks: [] } as never);
  });

  it('403s without quotes:send', async () => {
    const res = await appWith('partner', ['quotes:read', 'quotes:write']).request(`/${QUOTE_ID}/schedule-send`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(cancelQuoteSend).not.toHaveBeenCalled();
  });

  it('200s {canceled:true} when the undo wins', async () => {
    vi.mocked(cancelQuoteSend).mockResolvedValue(true);
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/schedule-send`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { canceled: true } });
    expect(cancelQuoteSend).toHaveBeenCalledWith(QUOTE_ID);
  });

  it('passes through {canceled:false} when the window already elapsed', async () => {
    vi.mocked(cancelQuoteSend).mockResolvedValue(false);
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/schedule-send`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { canceled: false } });
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
    vi.mocked(fetchRemoteImage).mockRejectedValue(new RemoteImageError('not_image', "That URL isn't a PNG or JPEG image"));
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, jsonReq('https://cdn/page.png'));
    expect(res.status).toBe(415);
  });

  // #3483: pdfkit (the quote PDF renderer) can't embed WebP — doc.image() threw
  // and the render loop's catch-and-continue silently dropped the image from
  // the exported PDF. fetchRemoteImage now rejects WebP explicitly (as
  // RemoteImageError('not_image', ...)); this proves the route surfaces that
  // as a visible 415 rather than accepting the image only to have it vanish
  // from the PDF later.
  it('415s a remote WebP image with a message telling the author to use PNG/JPEG', async () => {
    vi.mocked(fetchRemoteImage).mockRejectedValue(new RemoteImageError('not_image', QUOTE_IMAGE_WEBP_REJECTED_MESSAGE));
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, jsonReq('https://cdn/photo.webp'));
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: QUOTE_IMAGE_WEBP_REJECTED_MESSAGE });
    expect(writeQuoteImage).not.toHaveBeenCalled();
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

describe('POST /:id/images — multipart file upload', () => {
  const PERMS = ['quotes:read', 'quotes:write'];

  function makeMultipart(bytes: Buffer, mime: string, filename: string): { body: BodyInit; headers: HeadersInit } {
    const formData = new FormData();
    const view = new Uint8Array(bytes.byteLength);
    view.set(bytes);
    formData.append('file', new Blob([view], { type: mime }), filename);
    // Undici sets Content-Type (with boundary) automatically for a FormData body.
    return { body: formData, headers: {} };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getQuote).mockResolvedValue({ quote: { orgId: 'org-1' } } as never);
    vi.mocked(writeQuoteImage).mockResolvedValue({ id: 'img-9', byteSize: 4, sha256: 'x' } as never);
  });

  it('accepts a sniffed PNG and writes it', async () => {
    vi.mocked(sniffImageMime).mockReturnValue('image/png');
    const { body, headers } = makeMultipart(Buffer.from([1, 2, 3, 4]), 'image/png', 'a.png');
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, { method: 'POST', body, headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { imageId: 'img-9', mime: 'image/png', byteSize: 4 } });
    expect(writeQuoteImage).toHaveBeenCalledWith(QUOTE_ID, 'org-1', 'image/png', expect.any(Buffer));
  });

  // #3483: the upload surface previously advertised (and accepted) WebP, but
  // pdfkit can't embed it — the image silently vanished from the exported PDF.
  // The route must now reject it visibly at upload time instead.
  it('415s a WebP file with a message telling the author to use PNG/JPEG, and never persists it', async () => {
    vi.mocked(sniffImageMime).mockReturnValue('image/webp');
    const { body, headers } = makeMultipart(Buffer.from([1, 2, 3, 4]), 'image/webp', 'photo.webp');
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, { method: 'POST', body, headers });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: QUOTE_IMAGE_WEBP_REJECTED_MESSAGE });
    expect(writeQuoteImage).not.toHaveBeenCalled();
  });

  it('415s bytes that sniff to no recognized image format', async () => {
    vi.mocked(sniffImageMime).mockReturnValue(null);
    const { body, headers } = makeMultipart(Buffer.from('not an image'), 'image/png', 'fake.png');
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, { method: 'POST', body, headers });
    expect(res.status).toBe(415);
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


/**
 * Re-send + share link are quotes:send, NOT quotes:read: each hands the
 * customer a live accept credential. A tech with read-only access must not be
 * able to pull the link out of the UI.
 */
describe('POST /:id/resend', () => {
  const PERMS = ['quotes:read', 'quotes:write', 'quotes:send'];

  it('403s a quotes:read + quotes:write user without quotes:send', async () => {
    const res = await appWith('partner', ['quotes:read', 'quotes:write']).request(`/${QUOTE_ID}/resend`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('403s a wrong scope (organization) even with quotes:send', async () => {
    const res = await appWith('organization', ['quotes:send']).request(`/${QUOTE_ID}/resend`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('passes the gate and forwards the composer body', async () => {
    const { resendQuote } = await import('../../services/quoteLifecycle');
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/resend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: ['buyer@customer.example'], message: 'bumping this' }),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(resendQuote)).toHaveBeenCalledWith(QUOTE_ID, expect.anything(), {
      to: ['buyer@customer.example'], cc: undefined, subject: undefined,
      includePdf: undefined, message: 'bumping this',
    });
  });

  it('400s an invalid recipient email', async () => {
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/resend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: ['not-an-email'] }),
    });
    expect(res.status).toBe(400);
  });

  // The server swallows delivery failures, so the request still 200s. The
  // audit record is the only durable trace that nothing actually went out.
  it('audit-logs result:failure when no email was delivered', async () => {
    const { resendQuote } = await import('../../services/quoteLifecycle');
    const { writeRouteAudit } = await import('../../services/auditEvents');
    vi.mocked(resendQuote).mockResolvedValueOnce({
      quote: { id: 'q1', orgId: 'org1', status: 'sent' },
      acceptUrl: 'http://x/quote/t', origin: 'reproduced', reissued: false,
      deliverEmail: vi.fn(async () => ({
        quote: { id: 'q1', orgId: 'org1', status: 'sent', sendEmailReason: 'no_billing_contact' },
        emailed: false, emailReason: 'no_billing_contact',
      })),
    } as never);
    await appWith('partner', PERMS).request(`/${QUOTE_ID}/resend`, { method: 'POST' });
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'quote.resend', result: 'failure',
    }));
  });

  // `origin` is what distinguishes "the customer's old link still works" from
  // "their old link is dead" — a bare reissued boolean cannot, and the audit
  // trail is where that distinction has to survive.
  it('records the link origin so a reissue is forensically distinguishable', async () => {
    const { resendQuote } = await import('../../services/quoteLifecycle');
    const { writeRouteAudit } = await import('../../services/auditEvents');
    vi.mocked(resendQuote).mockResolvedValueOnce({
      quote: { id: 'q1', orgId: 'org1', status: 'sent' },
      acceptUrl: 'http://x/quote/t', origin: 'minted_key_unavailable', reissued: true,
      deliverEmail: vi.fn(async () => ({ quote: { id: 'q1', orgId: 'org1', status: 'sent' }, emailed: true })),
    } as never);
    await appWith('partner', PERMS).request(`/${QUOTE_ID}/resend`, { method: 'POST' });
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ reissued: true, linkOrigin: 'minted_key_unavailable' }),
    }));
  });

  it('audit-logs the re-send with its delivery outcome', async () => {
    const { writeRouteAudit } = await import('../../services/auditEvents');
    await appWith('partner', PERMS).request(`/${QUOTE_ID}/resend`, { method: 'POST' });
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'quote.resend', resourceType: 'quote', resourceId: QUOTE_ID, orgId: 'org1', result: 'success',
    }));
  });
});

describe('GET /:id/share-link', () => {
  it('403s a quotes:read holder — the link is a credential, not a read', async () => {
    const res = await appWith('partner', ['quotes:read', 'quotes:write']).request(`/${QUOTE_ID}/share-link`);
    expect(res.status).toBe(403);
  });

  it('returns the link + recipients for a quotes:send holder, and audits it', async () => {
    const { writeRouteAudit } = await import('../../services/auditEvents');
    const res = await appWith('partner', ['quotes:send']).request(`/${QUOTE_ID}/share-link`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      acceptUrl: 'http://x/quote/t', reissued: false, recipients: ['ap@customer.example'],
    });
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'quote.share_link_viewed', resourceId: QUOTE_ID, orgId: 'org1',
    }));
  });
});

describe('POST /:id/accept-on-behalf', () => {
  const BODY = {
    method: 'purchase_order', reference: 'PO 4471',
    signerName: 'Dana Buyer', signerEmail: 'dana@customer.example',
  };
  const jsonReq = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getQuote).mockResolvedValue({
      quote: { id: QUOTE_ID, orgId: 'org1', partnerId: 'p1', status: 'sent', quoteNumber: 'Q-2026-0001' },
      blocks: [], lines: [],
    } as never);
  });

  // D3: accepting is separately revocable from sending. A role that can send
  // must not silently gain the money-committing action.
  it('403s a quotes:send holder without quotes:accept', async () => {
    const res = await appWith('partner', ['quotes:read', 'quotes:write', 'quotes:send'])
      .request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(res.status).toBe(403);
  });

  it('200s a quotes:accept holder', async () => {
    const res = await appWith('partner', ['quotes:read', 'quotes:accept'])
      .request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(res.status).toBe(200);
  });

  it('403s an organization-scoped token even with quotes:accept', async () => {
    const res = await appWith('organization', ['quotes:accept'])
      .request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(res.status).toBe(403);
  });

  it('400s a missing reference', async () => {
    const { reference: _drop, ...rest } = BODY;
    const res = await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(rest));
    expect(res.status).toBe(400);
  });

  it('400s an unknown method', async () => {
    const res = await appWith('partner', ['quotes:accept'])
      .request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq({ ...BODY, method: 'telepathy' }));
    expect(res.status).toBe(400);
  });

  it('forwards the origin, the body and the acting user to acceptQuote', async () => {
    const { acceptQuote } = await import('../../services/quoteAcceptService');
    await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(vi.mocked(acceptQuote)).toHaveBeenCalledWith(expect.objectContaining({
      quoteId: QUOTE_ID, origin: 'on_behalf',
      method: 'purchase_order', reference: 'PO 4471',
      signerName: 'Dana Buyer', signerEmail: 'dana@customer.example',
      actorUserId: 'u1',
    }));
  });

  it('writes the SSOT audit payload', async () => {
    const { writeRouteAudit } = await import('../../services/auditEvents');
    await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'quote.accepted_on_behalf',
      resourceType: 'quote',
      resourceId: QUOTE_ID,
      details: expect.objectContaining({ method: 'purchase_order', reference: 'PO 4471', wasDraft: false }),
    }));
  });

  // The quote number is NOT the invoice number. The audit row must carry the
  // number the accept actually allocated, or it names the wrong document.
  it('audits the issued invoice number, not the quote number', async () => {
    const { writeRouteAudit } = await import('../../services/auditEvents');
    await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ invoiceNumber: 'INV-2026-0007' }),
    }));
  });

  it('reports wasDraft when the quote was a draft before the accept', async () => {
    vi.mocked(getQuote).mockResolvedValue({
      quote: { id: QUOTE_ID, orgId: 'org1', partnerId: 'p1', status: 'draft' }, blocks: [], lines: [],
    } as never);
    const { writeRouteAudit } = await import('../../services/auditEvents');
    await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ details: expect.objectContaining({ wasDraft: true }) }));
  });

  // Retiring a revision's parent is its own auditable act — the same rule /send
  // follows.
  it('also audits the supersede when the accept retired a parent', async () => {
    const { acceptQuote } = await import('../../services/quoteAcceptService');
    vi.mocked(acceptQuote).mockResolvedValueOnce({
      quote: { id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'converted', quoteNumber: 'Q-2026-0001', revisionNumber: 2 },
      acceptanceId: 'acc1', invoiceId: 'inv1', invoiceIssued: true, invoiceNumber: 'INV-2026-0007',
      contractIds: [], pax8OrderId: null, contractDocumentIds: [],
      superseded: { parentQuoteId: 'parent1', previousStatus: 'sent' },
    } as never);
    const { writeRouteAudit } = await import('../../services/auditEvents');
    await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'quote.superseded', resourceId: 'parent1',
    }));
  });

  // §5: 'msp' emits the bus event and sends NO creator email — the actor
  // already knows, they did it.
  it('notifies the outcome as msp-sourced, carrying the origin', async () => {
    const { notifyQuoteOutcome } = await import('../../services/quoteOutcomeNotify');
    await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(vi.mocked(notifyQuoteOutcome)).toHaveBeenCalledWith(expect.objectContaining({
      quoteId: QUOTE_ID, outcome: 'accepted', source: 'msp',
      origin: 'on_behalf', actorUserId: 'u1',
    }));
  });

  it('answers the portal accept shape', async () => {
    const res = await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    const body = await res.json();
    expect(body.data).toMatchObject({
      invoiceId: 'inv1', invoiceIssued: true, contractIds: ['c1'],
      payUrl: 'https://portal.example/invoice/tok',
    });
    expect(body.data.quote.status).toBe('converted');
  });

  // The UI's success toast says "Invoice <number> issued". Without the ALLOCATED
  // invoice number in the response the web layer reached for quote.quoteNumber
  // and named a document that does not exist.
  it('returns the allocated invoice number, distinct from the quote number', async () => {
    const res = await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    const body = await res.json();
    expect(body.data.invoiceNumber).toBe('INV-2026-0007');
    expect(body.data.invoiceNumber).not.toBe(body.data.quote.quoteNumber);
  });

  // A recurring-only quote leaves the invoice in draft with no number
  // allocated. null must reach the caller as null so it can say so, rather than
  // being papered over with a blank in "Invoice  issued".
  it('returns a null invoice number when the accept allocated none', async () => {
    const { acceptQuote } = await import('../../services/quoteAcceptService');
    vi.mocked(acceptQuote).mockResolvedValueOnce({
      quote: { id: QUOTE_ID, orgId: 'org1', status: 'converted', quoteNumber: 'Q-2026-0001' },
      acceptanceId: 'acc1', invoiceId: 'inv1', invoiceIssued: false, invoiceNumber: null,
      contractIds: ['c1'], superseded: null,
    } as never);
    const res = await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect((await res.json()).data.invoiceNumber).toBeNull();
  });

  // runOutsideDbContext only re-points the ALS db proxy — the middleware's
  // outer transaction would still be held across the accept, pinning a second
  // pooled connection (#1105 class).
  it('opts out of the ambient request transaction', () => {
    expect(isSelfManagedDbContextRoute('POST', `/api/v1/quotes/${QUOTE_ID}/accept-on-behalf`)).toBe(true);
  });

  // #6638: the audit row is this feature's whole point. It must land even if a
  // post-commit side effect (invoice-issued event, pay-URL resolution) throws —
  // both are documented as non-throwing today, but a future regression in
  // either must not silently drop the acceptance's own audit trail.
  it('writes the audit row even when a post-commit side effect throws', async () => {
    const { emitAcceptInvoiceIssued } = await import('../../services/quoteAcceptService');
    vi.mocked(emitAcceptInvoiceIssued).mockRejectedValueOnce(new Error('smtp down'));
    const { writeRouteAudit } = await import('../../services/auditEvents');
    const res = await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(res.status).toBe(500);
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'quote.accepted_on_behalf', resourceId: QUOTE_ID,
    }));
  });

  // Same regression, narrower: the supersede audit is a SEPARATE writeRouteAudit
  // call gated on res.superseded, and a re-ordering that only slips this one
  // back below the side effects would pass the test above.
  it('also writes the supersede audit when a post-commit side effect throws', async () => {
    const { acceptQuote, emitAcceptInvoiceIssued } = await import('../../services/quoteAcceptService');
    vi.mocked(acceptQuote).mockResolvedValueOnce({
      quote: { id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'converted', quoteNumber: 'Q-2026-0001', revisionNumber: 2 },
      acceptanceId: 'acc1', invoiceId: 'inv1', invoiceIssued: true, invoiceNumber: 'INV-2026-0007',
      contractIds: [], pax8OrderId: null, contractDocumentIds: [],
      superseded: { parentQuoteId: 'parent1', previousStatus: 'sent' },
    } as never);
    vi.mocked(emitAcceptInvoiceIssued).mockRejectedValueOnce(new Error('smtp down'));
    const { writeRouteAudit } = await import('../../services/auditEvents');
    const res = await appWith('partner', ['quotes:accept']).request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(res.status).toBe(500);
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'quote.accepted_on_behalf', resourceId: QUOTE_ID,
    }));
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'quote.superseded', resourceId: 'parent1',
    }));
  });
});

// #6638: the route suite mocks `handleServiceError` (./quotes) to rethrow, so
// none of the tests above exercise what a real QuoteServiceError from getQuote
// maps to — a regression here would silently turn every service-typed error
// into an uncaught 500. These tests swap in the REAL handleServiceError via
// vi.doMock + vi.resetModules (last block in the file, so later tests can't be
// affected by the module-registry reset).
describe('POST /:id/accept-on-behalf — error path uses the real handleServiceError (#6638)', () => {
  const QUOTE_ID = '11111111-1111-4111-8111-111111111111';
  const BODY = {
    method: 'purchase_order', reference: 'PO 4471',
    signerName: 'Dana Buyer', signerEmail: 'dana@customer.example',
  };
  const jsonReq = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  afterEach(() => {
    vi.doUnmock('./quotes');
  });

  // Builds the app AND returns the fresh (post-reset) module instances the
  // caller must configure — importing them separately would resolve the PRE-
  // reset instances, which the freshly-reloaded route module no longer shares.
  async function buildAppWithRealErrorHandling(scope: 'partner' | 'organization' | 'system', perms: string[]) {
    vi.resetModules();
    permState.perms = perms;
    vi.doMock('./quotes', async (importActual) => {
      const actual = await importActual<typeof import('./quotes')>();
      return { ...actual, quoteActorFrom: () => ({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: null }) };
    });
    const { quoteLifecycleRoutes: routes } = await import('./lifecycle');
    const { getQuote } = await import('../../services/quoteService');
    const { QuoteServiceError } = await import('../../services/quoteTypes');
    const a = new Hono();
    a.use('*', async (c, next) => { c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope } as never); await next(); });
    a.route('/', routes);
    return { app: a, getQuote, QuoteServiceError };
  }

  it('maps a 404 QuoteServiceError from getQuote to 404, not 500', async () => {
    const { app, getQuote, QuoteServiceError } = await buildAppWithRealErrorHandling('partner', ['quotes:accept']);
    vi.mocked(getQuote).mockRejectedValueOnce(new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND'));
    const res = await app.request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('QUOTE_NOT_FOUND');
  });

  it('maps a 409 QUOTE_NOT_ACCEPTABLE QuoteServiceError from getQuote to 409, not 500', async () => {
    const { app, getQuote, QuoteServiceError } = await buildAppWithRealErrorHandling('partner', ['quotes:accept']);
    vi.mocked(getQuote).mockRejectedValueOnce(new QuoteServiceError('Quote is not in an acceptable state', 409, 'QUOTE_NOT_ACCEPTABLE'));
    const res = await app.request(`/${QUOTE_ID}/accept-on-behalf`, jsonReq(BODY));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('QUOTE_NOT_ACCEPTABLE');
  });
});

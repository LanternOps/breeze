import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const apiPost = vi.hoisted(() => vi.fn());
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), apiPost }));
import { requestAccess, verifyAccess, fetchGrant, downloadGrantDocument } from './trustAccessApi';

beforeEach(() => { apiPost.mockReset(); vi.unstubAllGlobals(); });

describe('trustAccessApi', () => {
  it('requestAccess: 202 and 404 read "sent" (no oracle); 429, 5xx and network failures read "retry"; never throws', async () => {
    const body = { partnerSlug: 'p', orgSlug: null, email: 'a@b.co', name: 'Al', company: 'Co', purpose: 'long enough purpose', ndaAccepted: false };
    apiPost.mockResolvedValue({ data: { data: { accepted: true } }, statusCode: 202 });
    await expect(requestAccess(body)).resolves.toBe('sent');
    expect(apiPost).toHaveBeenCalledWith('/trust/access/requests', body, { redirectOnUnauthorized: false });
    apiPost.mockResolvedValue({ error: 'nf', statusCode: 404 });
    await expect(requestAccess(body)).resolves.toBe('sent');
    apiPost.mockResolvedValue({ error: 'x', statusCode: 429 });
    await expect(requestAccess(body)).resolves.toBe('retry');
    apiPost.mockResolvedValue({ error: 'x', statusCode: 503 });
    await expect(requestAccess(body)).resolves.toBe('retry');
    apiPost.mockRejectedValue(new Error('boom'));
    await expect(requestAccess(body)).resolves.toBe('retry');
  });
  it('verifyAccess returns orgName or null; token only in body', async () => {
    apiPost.mockResolvedValue({ data: { data: { orgName: 'Acme' } }, statusCode: 200 });
    expect(await verifyAccess('tok')).toEqual({ orgName: 'Acme' });
    expect(apiPost.mock.calls[0][0]).toBe('/trust/access/verify');
    expect(apiPost.mock.calls[0][0]).not.toContain('tok');
    expect(apiPost.mock.calls[0][1]).toEqual({ token: 'tok' });
    apiPost.mockResolvedValue({ error: 'nf', statusCode: 404 });
    expect(await verifyAccess('tok')).toBeNull();
    apiPost.mockResolvedValue({ error: 'x', statusCode: 429 });
    expect(await verifyAccess('tok')).toBe('retry');
    apiPost.mockRejectedValue(new Error('net'));
    expect(await verifyAccess('tok')).toBe('retry');
  });
  it('fetchGrant returns the grant or null', async () => {
    const grant = { orgName: 'A', expiresAt: '2026-10-20T00:00:00Z', documents: [] };
    apiPost.mockResolvedValue({ data: { data: grant }, statusCode: 200 });
    expect(await fetchGrant('tok')).toEqual(grant);
    apiPost.mockResolvedValue({ error: 'nf', statusCode: 404 });
    expect(await fetchGrant('tok')).toBeNull();
    apiPost.mockResolvedValue({ error: 'x', statusCode: 500 });
    expect(await fetchGrant('tok')).toBe('retry');
  });
  it('downloadGrantDocument returns blob + filename from Content-Disposition', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('abc', { status: 200, headers: { 'content-disposition': 'attachment; filename="policy.pdf"' } }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await downloadGrantDocument('tok', 'doc1');
    expect(r?.filename).toBe('policy.pdf');
    expect(await r!.blob.text()).toBe('abc');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url).endsWith('/api/v1/trust/access/download')).toBe(true);
    expect(JSON.parse(init.body)).toEqual({ token: 'tok', documentId: 'doc1' });
    expect(init.method).toBe('POST');
  });
  it('downloadGrantDocument: filename null without header, null on non-ok or network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x', { status: 200 })));
    expect((await downloadGrantDocument('t', 'd'))?.filename).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    expect(await downloadGrantDocument('t', 'd')).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    expect(await downloadGrantDocument('t', 'd')).toBeNull();
  });
  it('parses RFC 5987 filename*', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x', { headers: { 'content-disposition': "attachment; filename=\"a.pdf\"; filename*=UTF-8''Sicherheit%20Richtlinie.pdf" } })));
    expect((await downloadGrantDocument('t', 'd'))?.filename).toBe('Sicherheit Richtlinie.pdf');
  });
});

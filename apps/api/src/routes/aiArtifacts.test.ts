/**
 * Execution-plane W01 (spec §8, §12). Proves: attachment + nosniff on every
 * response, a fixed safe content-type map (an HTML artifact is NEVER served as
 * text/html), a bare 404 for another org's handle (not 403), 503 — never a
 * silent 404 — for a storage fault, and 404 for a genuinely missing object.
 *
 * The per-run LIST route is not here: it lives in routes/aiAgents.ts, beside
 * the run detail it shares a prefix with, and is tested in aiAgents.test.ts
 * where its route precedence can actually be observed.
 */
import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  open: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../services/artifacts/artifactService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findArtifactForAuth: mocks.find,
  openArtifactStream: mocks.open,
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('auth', { orgId: ORG, scope: 'organization', accessibleOrgIds: [ORG], orgCondition: () => undefined });
    await next();
  },
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../services/sentry', () => ({ captureException: mocks.captureException }));

const ORG = '00000000-0000-4000-8000-0000000000a1';
const ART = '00000000-0000-4000-8000-0000000000a4';
const RUN = '00000000-0000-4000-8000-0000000000a3';

import { BlobNotFoundError, BlobStorageUnavailableError } from '../services/artifacts/blobStorage';
import { aiArtifactRoutes, artifactDownloadContentType } from './aiArtifacts';

function app() {
  const a = new Hono();
  a.route('/api/v1/ai/artifacts', aiArtifactRoutes);
  return a;
}

function record(over: Record<string, unknown> = {}) {
  return {
    id: ART, orgId: ORG, runId: RUN, sessionId: null, kind: 'input_capture',
    name: 'search_logs.json', contentType: 'application/json', bytes: 7, sha256: 'a'.repeat(64),
    blobKey: 'us/2026/10/k1', headPreview: '{"a":1}', tailPreview: '{"a":1}',
    sourceDeviceId: null, createdByTool: 'search_logs',
    expiresAt: new Date('2026-11-15T00:00:00Z'), createdAt: new Date('2026-10-16T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => { mocks.find.mockReset(); mocks.open.mockReset(); });

describe('artifactDownloadContentType — fixed safe map (spec §8)', () => {
  it('passes the handful of safe types through', () => {
    expect(artifactDownloadContentType('application/json')).toBe('application/json');
    expect(artifactDownloadContentType('text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8');
    expect(artifactDownloadContentType('text/csv')).toBe('text/csv');
  });

  it('NEVER echoes an active type — html, svg and js all become octet-stream', () => {
    for (const t of ['text/html', 'image/svg+xml', 'application/javascript', 'application/xhtml+xml']) {
      expect(artifactDownloadContentType(t)).toBe('application/octet-stream');
    }
  });

  it('falls back to octet-stream for anything unknown or malformed', () => {
    expect(artifactDownloadContentType('application/x-made-up')).toBe('application/octet-stream');
    expect(artifactDownloadContentType('')).toBe('application/octet-stream');
  });
});

describe('GET /api/v1/ai/artifacts/:id', () => {
  it('streams with attachment + nosniff and the mapped content type', async () => {
    mocks.find.mockResolvedValue(record());
    mocks.open.mockResolvedValue(Readable.from([Buffer.from('{"a":1}')]));
    const res = await app().request(`/api/v1/ai/artifacts/${ART}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('attachment;');
    expect(res.headers.get('Content-Disposition')).toContain('search_logs.json');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.text()).toBe('{"a":1}');
  });

  it('serves an HTML artifact as an octet-stream ATTACHMENT, never inline', async () => {
    mocks.find.mockResolvedValue(record({ contentType: 'text/html', name: 'report.html' }));
    mocks.open.mockResolvedValue(Readable.from([Buffer.from('<script>x</script>')]));
    const res = await app().request(`/api/v1/ai/artifacts/${ART}`);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')?.startsWith('attachment;')).toBe(true);
  });

  it("404s — not 403 — for another org's handle, so a handle discloses nothing", async () => {
    mocks.find.mockResolvedValue(null);      // the org predicate excluded it
    const res = await app().request(`/api/v1/ai/artifacts/${ART}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Artifact not found', code: 'ARTIFACT_NOT_FOUND' });
  });

  it('404s for a non-uuid without querying', async () => {
    const res = await app().request('/api/v1/ai/artifacts/not-a-uuid');
    expect(res.status).toBe(404);
    expect(mocks.find).not.toHaveBeenCalled();
  });

  it('503s — never a silent 404 — when the blob store is unavailable', async () => {
    mocks.find.mockResolvedValue(record());
    mocks.open.mockRejectedValue(new BlobStorageUnavailableError('bucket down'));
    const res = await app().request(`/api/v1/ai/artifacts/${ART}`);
    expect(res.status).toBe(503);
    expect((await res.json() as { code: string }).code).toBe('ARTIFACT_STORAGE_UNAVAILABLE');
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('404s when the object is genuinely gone (swept between row read and open)', async () => {
    mocks.find.mockResolvedValue(record());
    mocks.open.mockRejectedValue(new BlobNotFoundError('us/2026/10/k1'));
    expect((await app().request(`/api/v1/ai/artifacts/${ART}`)).status).toBe(404);
  });

  it('sanitises the filename so a stored name cannot inject a header', async () => {
    mocks.find.mockResolvedValue(record({ name: 'a"b\r\nX-Evil: 1' }));
    mocks.open.mockResolvedValue(Readable.from([Buffer.from('x')]));
    const res = await app().request(`/api/v1/ai/artifacts/${ART}`);
    expect(res.headers.get('X-Evil')).toBeNull();
    expect(res.headers.get('Content-Disposition')).not.toContain('\n');
  });
});

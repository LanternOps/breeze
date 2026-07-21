# Quote Image From URL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user paste an image URL in the quote editor's "Add image" panel; the server fetches the bytes and stores them in `quote_images` exactly like an uploaded file (a server-side copy, not a hotlink).

**Architecture:** Reuse the existing `POST /quotes/:id/images` route, branching on request content-type — today's multipart path is unchanged; a new `application/json` `{ url }` path calls a new `fetchRemoteImage(url)` service (SSRF-guarded fetch → size cap → magic-byte sniff) and then the **same** `writeQuoteImage(...)`. Both paths return an identical `{ data: { imageId, mime, byteSize } }`, so the web "add image block" flow is source-agnostic. The web panel gains a "Upload file | From URL" segmented toggle.

**Tech Stack:** Hono + Zod (API), Node `https`/`dns` via existing `safeFetch` SSRF guard, Drizzle/bytea storage, React + Vitest/Testing Library (web).

## Global Constraints

- **SSRF:** all outbound fetching goes through the existing `safeFetch` (`apps/api/src/services/urlSafety.ts`) in **strict mode** (no `allowPrivateNetwork`). No new network-egress code.
- **DB context (#1105):** `safeFetch` calls `assertOutsideHeldDbContext`; the request runs inside a held RLS context, so the fetch MUST be wrapped in `runOutsideDbContext(...)` (mirrors `quoteService.ts:124`).
- **Trust boundary:** the source's `Content-Type` header is ignored; only `sniffImageMime(buffer)` magic-byte sniffing decides the stored mime (PNG / JPEG / WebP).
- **Size cap:** `MAX_QUOTE_IMAGE_SIZE_BYTES` = 5 MB, enforced on the downloaded buffer.
- **No DB migration** — `quote_images` already stores the bytes.
- Every mutation on the web goes through `runAction` (existing pattern in `QuoteEditor.tsx`).

---

### Task 1: Service — `fetchRemoteImage` + `RemoteImageError`

Adds the SSRF-guarded remote-image fetcher to the existing storage module and a typed error the route maps to HTTP codes.

**Files:**
- Modify: `apps/api/src/services/quoteImageStorage.ts`
- Test: `apps/api/src/services/quoteImageStorage.test.ts` (create)

**Interfaces:**
- Consumes: `safeFetch`, `SsrfBlockedError` (from `./urlSafety`); `runOutsideDbContext` (from `../db`); `sniffImageMime`, `MAX_QUOTE_IMAGE_SIZE_BYTES` (already in this module).
- Produces:
  - `class RemoteImageError extends Error` with `readonly reason: RemoteImageFailureReason`.
  - `type RemoteImageFailureReason = 'unreachable' | 'not_image' | 'too_large' | 'timeout'`.
  - `async function fetchRemoteImage(url: string): Promise<{ mime: string; buffer: Buffer }>`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/quoteImageStorage.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module imports `db` (pool) and `safeFetch`. Mock `../db` so importing the
// storage module never opens a real pool, and make runOutsideDbContext a
// pass-through. Keep the real SsrfBlockedError from urlSafety but stub safeFetch.
vi.mock('../db', () => ({
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
  db: {},
}));
vi.mock('./urlSafety', async (importActual) => {
  const actual = await importActual<typeof import('./urlSafety')>();
  return { ...actual, safeFetch: vi.fn() };
});

import { fetchRemoteImage, RemoteImageError } from './quoteImageStorage';
import { safeFetch, SsrfBlockedError } from './urlSafety';

const safeFetchMock = vi.mocked(safeFetch);

// A minimal but valid PNG magic-byte header (>= 12 bytes) so the real
// sniffImageMime recognizes it.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

// Minimal stub of just the Response surface fetchRemoteImage uses (`ok`,
// `headers.get`, `arrayBuffer`). Avoids undici recomputing a real Response's
// content-length from the body, which would defeat the fast-reject test.
function res(body: Buffer, init?: { status?: number; contentLength?: number }): Response {
  const status = init?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-length' && init?.contentLength != null ? String(init.contentLength) : null) },
    arrayBuffer: async () => body,
  } as unknown as Response;
}

describe('fetchRemoteImage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the sniffed mime + bytes for a real PNG', async () => {
    safeFetchMock.mockResolvedValue(res(PNG));
    const out = await fetchRemoteImage('https://cdn.example.com/logo.png');
    expect(out.mime).toBe('image/png');
    expect(out.buffer.equals(PNG)).toBe(true);
    expect(safeFetchMock).toHaveBeenCalledWith('https://cdn.example.com/logo.png', { timeoutMs: 8000 });
  });

  it('maps an SSRF block to reason "unreachable"', async () => {
    safeFetchMock.mockRejectedValue(new SsrfBlockedError('blocked'));
    await expect(fetchRemoteImage('https://internal/x.png')).rejects.toBeInstanceOf(RemoteImageError);
    await expect(fetchRemoteImage('https://internal/x.png')).rejects.toMatchObject({ reason: 'unreachable' });
  });

  it('maps a timeout error to reason "timeout"', async () => {
    safeFetchMock.mockRejectedValue(new Error('request timed out after 8000ms'));
    await expect(fetchRemoteImage('https://slow/x.png')).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('rejects a non-2xx response as "unreachable"', async () => {
    safeFetchMock.mockResolvedValue(res(PNG, { status: 404 }));
    await expect(fetchRemoteImage('https://cdn/x.png')).rejects.toMatchObject({ reason: 'unreachable' });
  });

  it('rejects bytes that are not a supported image even if the URL claims one', async () => {
    safeFetchMock.mockResolvedValue(res(Buffer.from('<!doctype html><html></html>')));
    await expect(fetchRemoteImage('https://cdn/looks-like.png')).rejects.toMatchObject({ reason: 'not_image' });
  });

  it('rejects a buffer over the 5 MB cap', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
    safeFetchMock.mockResolvedValue(res(big));
    await expect(fetchRemoteImage('https://cdn/big.png')).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('fast-rejects on an oversized Content-Length header', async () => {
    safeFetchMock.mockResolvedValue(res(PNG, { contentLength: 6 * 1024 * 1024 }));
    await expect(fetchRemoteImage('https://cdn/liar.png')).rejects.toMatchObject({ reason: 'too_large' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test quoteImageStorage`
Expected: FAIL — `fetchRemoteImage`/`RemoteImageError` are not exported.

- [ ] **Step 3: Write the implementation**

Edit `apps/api/src/services/quoteImageStorage.ts`. Add imports at the top (join the existing import block; `db` is already imported from `../db`):

```ts
import { runOutsideDbContext } from '../db';
import { safeFetch, SsrfBlockedError } from './urlSafety';
```

Append to the file:

```ts
export type RemoteImageFailureReason = 'unreachable' | 'not_image' | 'too_large' | 'timeout';

/** Typed failure from `fetchRemoteImage`; the images route maps `reason` → HTTP. */
export class RemoteImageError extends Error {
  constructor(public readonly reason: RemoteImageFailureReason, message: string) {
    super(message);
    this.name = 'RemoteImageError';
  }
}

const REMOTE_IMAGE_TIMEOUT_MS = 8000;

/**
 * Fetch an image from a user-supplied URL and return its bytes for storage — a
 * server-side copy, never a hotlink. SSRF is fully delegated to `safeFetch`
 * (strict mode: private/loopback/link-local/metadata ranges blocked, IP pinned
 * against rebinding, TLS enforced, no redirect following). The source's
 * Content-Type is untrusted — only magic-byte sniffing decides the mime.
 *
 * `safeFetch` does network I/O and asserts it runs OUTSIDE a held RLS
 * transaction (#1105), so the fetch is wrapped in `runOutsideDbContext`.
 */
export async function fetchRemoteImage(url: string): Promise<{ mime: string; buffer: Buffer }> {
  let res: Response;
  try {
    res = await runOutsideDbContext(() => safeFetch(url, { timeoutMs: REMOTE_IMAGE_TIMEOUT_MS }));
  } catch (err) {
    if (err instanceof SsrfBlockedError) throw new RemoteImageError('unreachable', "Couldn't reach that URL");
    if (err instanceof Error && /timed out/i.test(err.message)) {
      throw new RemoteImageError('timeout', 'The image took too long to download');
    }
    throw new RemoteImageError('unreachable', "Couldn't reach that URL");
  }

  if (!res.ok) throw new RemoteImageError('unreachable', "Couldn't reach that URL");

  // Fast-reject on a truthful Content-Length before buffering the whole body.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_QUOTE_IMAGE_SIZE_BYTES) {
    throw new RemoteImageError('too_large', 'Image is larger than 5 MB');
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  // The header can lie (or be absent) — re-check the real length.
  if (buffer.length > MAX_QUOTE_IMAGE_SIZE_BYTES) {
    throw new RemoteImageError('too_large', 'Image is larger than 5 MB');
  }

  const mime = sniffImageMime(buffer);
  if (!mime) throw new RemoteImageError('not_image', "That URL isn't a PNG, JPEG, or WebP image");

  return { mime, buffer };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api test quoteImageStorage`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteImageStorage.ts apps/api/src/services/quoteImageStorage.test.ts
git commit -m "feat(quotes): fetchRemoteImage — SSRF-guarded remote image copy for quotes"
```

---

### Task 2: API — JSON `{ url }` branch on `POST /:id/images`

Adds the URL branch to the existing images route and its error→HTTP mapping.

**Files:**
- Modify: `apps/api/src/routes/quotes/lifecycle.ts`
- Test: `apps/api/src/routes/quotes/lifecycle.test.ts` (extend)

**Interfaces:**
- Consumes: `fetchRemoteImage`, `RemoteImageError`, `writeQuoteImage` (Task 1 + existing); `getQuote` returning `{ quote: { orgId } }`.
- Produces: `POST /:id/images` accepts `application/json` `{ url }` → `200 { data: { imageId, mime, byteSize } }`; error statuses 400/413/415/502/504.

- [ ] **Step 1: Write the failing tests**

Edit `apps/api/src/routes/quotes/lifecycle.test.ts`. Extend the existing `quoteImageStorage` mock (line ~32) to add `fetchRemoteImage` and a `RemoteImageError` class:

```ts
vi.mock('../../services/quoteImageStorage', () => ({
  writeQuoteImage: vi.fn(), readQuoteImage: vi.fn(), sniffImageMime: vi.fn(), MAX_QUOTE_IMAGE_SIZE_BYTES: 5 * 1024 * 1024,
  fetchRemoteImage: vi.fn(),
  RemoteImageError: class RemoteImageError extends Error {
    constructor(public reason: string, msg: string) { super(msg); this.name = 'RemoteImageError'; }
  },
}));
```

Add these imports below the existing `import { quoteLifecycleRoutes } from './lifecycle';` line:

```ts
import { getQuote } from '../../services/quoteService';
import { fetchRemoteImage, writeQuoteImage, RemoteImageError } from '../../services/quoteImageStorage';
```

Append a new describe block at the end of the file:

```ts
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
  });
});
```

> Note: the existing mock stubs `getQuote` as `vi.fn()`; the new import binds to that same mock so `mockResolvedValue` drives it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @breeze/api test lifecycle`
Expected: FAIL — the JSON branch doesn't exist, so a JSON body currently falls into `parseBody` and returns 400 for all cases (the 200/413/415/502 assertions fail).

- [ ] **Step 3: Write the implementation**

Edit `apps/api/src/routes/quotes/lifecycle.ts`.

Update the storage import to add the two new symbols:

```ts
import { writeQuoteImage, readQuoteImage, sniffImageMime, MAX_QUOTE_IMAGE_SIZE_BYTES, fetchRemoteImage, RemoteImageError, type RemoteImageFailureReason } from '../../services/quoteImageStorage';
```

Add a URL-body schema + status mapper near the other `const … = z.object(...)` declarations:

```ts
// Accepts only http(s) URLs; the fetch layer enforces size/mime.
const imageFromUrlSchema = z.object({
  url: z.string().refine((s) => {
    try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; }
    catch { return false; }
  }, 'url must be an http(s) URL'),
});

function remoteImageStatus(reason: RemoteImageFailureReason): 413 | 415 | 502 | 504 {
  switch (reason) {
    case 'too_large': return 413;
    case 'not_image': return 415;
    case 'timeout': return 504;
    case 'unreachable': return 502;
  }
}
```

In the `POST /:id/images` handler, immediately after `const { quote } = await getQuote(...)` and before `let body: Record<string, unknown>;`, insert the JSON branch:

```ts
      // JSON body → copy the image from a URL (server-side, not a hotlink).
      // Multipart (below) is unchanged.
      if ((c.req.header('content-type') ?? '').includes('application/json')) {
        let json: unknown;
        try { json = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
        const parsed = imageFromUrlSchema.safeParse(json);
        if (!parsed.success) return c.json({ error: 'url must be an http(s) URL' }, 400);
        let fetched: { mime: string; buffer: Buffer };
        try {
          fetched = await fetchRemoteImage(parsed.data.url);
        } catch (err) {
          if (err instanceof RemoteImageError) return c.json({ error: err.message }, remoteImageStatus(err.reason));
          throw err;
        }
        const written = await writeQuoteImage(id, quote.orgId, fetched.mime, fetched.buffer);
        return c.json({ data: { imageId: written.id, mime: fetched.mime, byteSize: written.byteSize } });
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/api test lifecycle`
Expected: PASS — the new describe block plus the unchanged send-RBAC tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/quotes/lifecycle.ts apps/api/src/routes/quotes/lifecycle.test.ts
git commit -m "feat(quotes): accept JSON {url} on POST /quotes/:id/images to copy a remote image"
```

---

### Task 3: Web — "From URL" toggle in the Add-image panel

Adds the client fn, the segmented toggle, and the URL submit path.

**Files:**
- Modify: `apps/web/src/lib/api/quotes.ts`
- Modify: `apps/web/src/components/billing/quotes/QuoteEditor.tsx`
- Test: `apps/web/src/components/billing/quotes/QuoteEditor.imageurl.test.tsx` (create)

**Interfaces:**
- Consumes: `addQuoteImageFromUrl(id, url)` returning a `Response` with `{ data: { imageId } }`; existing `addBlock`, `uploadQuoteImage`, `runAction`, `runScoped`.
- Produces: user can add an image block from a pasted URL.

- [ ] **Step 1: Add the API client function**

Edit `apps/web/src/lib/api/quotes.ts`, directly below `uploadQuoteImage` (around line 200):

```ts
/** Copy an image into a quote from a URL (POST /quotes/:id/images with a JSON
 *  body). The server fetches + stores the bytes — not a hotlink. Responds with
 *  the same `{ data: { imageId, mime, byteSize } }` as the multipart upload.
 *  Gated server-side on quotes:write. */
export function addQuoteImageFromUrl(id: string, url: string): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/images`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ url }),
  });
}
```

- [ ] **Step 2: Write the failing web test**

Create `apps/web/src/components/billing/quotes/QuoteEditor.imageurl.test.tsx`:

```ts
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { addBlock, addQuoteImageFromUrl } from '../../../lib/api/quotes';

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
  ),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

vi.mock('../../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: [] }) } as unknown as Response,
  ),
  createCatalogItem: vi.fn(),
  polishTextRequest: vi.fn(),
}));

vi.mock('../../../lib/api/quotes', () => ({
  addBlock: vi.fn(),
  deleteBlock: vi.fn(),
  updateBlock: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  moveLine: vi.fn(),
  uploadQuoteImage: vi.fn(),
  addQuoteImageFromUrl: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const okRes = (data: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data }) } as unknown as Response);
const errRes = () =>
  ({ ok: false, status: 502, statusText: 'Bad Gateway', json: vi.fn().mockResolvedValue({ error: 'x' }) } as unknown as Response);

const detail: QuoteDetailData = {
  quote: {
    id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
    taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
    termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
    convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
    createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [],
  lines: [],
};

const addBlockMock = vi.mocked(addBlock);
const fromUrlMock = vi.mocked(addQuoteImageFromUrl);

async function openImageUrlPanel() {
  render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('quote-add-block-type-image'));
  fireEvent.click(screen.getByTestId('quote-block-image-source-url'));
}

describe('QuoteEditor — add image from URL', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the URL input and hides the file input when "From URL" is selected', async () => {
    await openImageUrlPanel();
    expect(screen.getByTestId('quote-block-image-url')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-block-image-file')).not.toBeInTheDocument();
  });

  it('submitting a URL copies the image then adds an image block with the returned id', async () => {
    fromUrlMock.mockResolvedValue(okRes({ imageId: 'img-1' }));
    addBlockMock.mockResolvedValue(okRes({}));
    await openImageUrlPanel();

    fireEvent.change(screen.getByTestId('quote-block-image-url'), { target: { value: 'https://cdn.example.com/a.png' } });
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(fromUrlMock).toHaveBeenCalledWith('q-1', 'https://cdn.example.com/a.png'));
    await waitFor(() => expect(addBlockMock).toHaveBeenCalledWith('q-1', {
      blockType: 'image', content: { imageId: 'img-1' },
    }));
  });

  it('a failed fetch shows an error toast and adds no block', async () => {
    fromUrlMock.mockResolvedValue(errRes());
    await openImageUrlPanel();

    fireEvent.change(screen.getByTestId('quote-block-image-url'), { target: { value: 'https://internal/a.png' } });
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(addBlockMock).not.toHaveBeenCalled();
  });

  it('disables submit while the URL is empty', async () => {
    await openImageUrlPanel();
    expect(screen.getByTestId('quote-add-block-submit')).toBeDisabled();
  });
});
```

- [ ] **Step 3: Run the web test to verify it fails**

Run: `pnpm --filter @breeze/web test QuoteEditor.imageurl`
Expected: FAIL — no `quote-block-image-source-url` toggle / `quote-block-image-url` input yet.

- [ ] **Step 4: Implement the toggle + submit path**

Edit `apps/web/src/components/billing/quotes/QuoteEditor.tsx`.

(a) Import the client fn — add `addQuoteImageFromUrl` to the existing `../../../lib/api/quotes` import block (the one containing `uploadQuoteImage, quoteImageUrl`):

```ts
  uploadQuoteImage,
  addQuoteImageFromUrl,
  quoteImageUrl,
```

(b) Add state next to the existing image state (after line 260):

```ts
  const [imageSource, setImageSource] = useState<'file' | 'url'>('file');
  const [imageUrl, setImageUrl] = useState('');
```

(c) Replace the whole `if (addType === 'image') { … return; }` block in `submitBlock` with:

```ts
    if (addType === 'image') {
      // Resolve an imageId from EITHER an uploaded file or a pasted URL (the
      // server copies the bytes in — not a hotlink), then attach an image block.
      const source = imageSource;
      if (source === 'file' && !imageFile) return;
      if (source === 'url' && !imageUrl.trim()) return;
      // File path keeps the immediate client-side 5 MB check; for URLs the server
      // is the size authority (the fetched bytes aren't known here).
      if (source === 'file' && imageFile && imageFile.size > 5 * 1024 * 1024) {
        handleActionError(new Error('image too large'), 'Image must be 5 MB or smaller.');
        return;
      }
      await runScoped('add-block', async () => {
        const uploaded = await runAction<{ imageId: string }>({
          request: () => source === 'file'
            ? uploadQuoteImage(quote.id, imageFile!)
            : addQuoteImageFromUrl(quote.id, imageUrl.trim()),
          errorFallback: source === 'file'
            ? 'Could not upload the image.'
            : 'Could not fetch the image from that URL.',
          onUnauthorized: UNAUTHORIZED,
          parseSuccess: (d) => (d as { data: { imageId: string } }).data,
        });
        await runAction({
          request: () => addBlock(quote.id, {
            blockType: 'image' as const,
            content: imageCaption.trim()
              ? { imageId: uploaded.imageId, caption: imageCaption.trim() }
              : { imageId: uploaded.imageId },
          }),
          errorFallback: 'Image added, but adding the section failed.',
          successMessage: 'Image section added',
          onUnauthorized: UNAUTHORIZED,
        });
        setImageFile(null); setImageCaption(''); setImageUrl('');
        refresh();
      }, 'Could not add the image section.');
      return;
    }
```

(d) Add `imageSource, imageUrl` to the `submitBlock` `useCallback` dependency array (line ~717):

```ts
  }, [addType, headingText, richText, tableLabel, imageFile, imageCaption, imageSource, imageUrl, quote.id, refresh, runScoped]);
```

(e) Replace the `{addType === 'image' && ( … )}` render block (lines ~1224-1243) with:

```tsx
            {addType === 'image' && (
              <div className="mb-3 space-y-2">
                <div className="inline-flex rounded-md border p-0.5 text-xs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={imageSource === 'file'}
                    onClick={() => setImageSource('file')}
                    data-testid="quote-block-image-source-file"
                    className={`rounded px-3 py-1 font-medium ${imageSource === 'file' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                  >
                    Upload file
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={imageSource === 'url'}
                    onClick={() => setImageSource('url')}
                    data-testid="quote-block-image-source-url"
                    className={`rounded px-3 py-1 font-medium ${imageSource === 'url' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                  >
                    From URL
                  </button>
                </div>
                {imageSource === 'file' ? (
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
                    data-testid="quote-block-image-file"
                    className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-medium"
                  />
                ) : (
                  <input
                    type="url"
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    placeholder="https://example.com/photo.png"
                    data-testid="quote-block-image-url"
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                )}
                <input
                  type="text"
                  value={imageCaption}
                  onChange={(e) => setImageCaption(e.target.value)}
                  placeholder="Caption (optional)"
                  data-testid="quote-block-image-caption"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">PNG, JPEG, or WebP, up to 5 MB.</p>
              </div>
            )}
```

(f) Update the submit button's `disabled` and label (lines ~1259-1268):

```tsx
                disabled={
                  isPending('add-block') ||
                  (addType === 'heading' && !headingText.trim()) ||
                  (addType === 'rich_text' && !richText.trim()) ||
                  (addType === 'image' && imageSource === 'file' && !imageFile) ||
                  (addType === 'image' && imageSource === 'url' && !imageUrl.trim())
                }
                data-testid="quote-add-block-submit"
                className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {addType === 'image'
                  ? (imageSource === 'url' ? 'Fetch & add image' : 'Upload & add image')
                  : 'Add section'}
```

- [ ] **Step 5: Run the web test to verify it passes**

Run: `pnpm --filter @breeze/web test QuoteEditor.imageurl`
Expected: PASS (4 tests).

- [ ] **Step 6: Guard against regressions in the existing editor tests**

Run: `pnpm --filter @breeze/web test QuoteEditor`
Expected: PASS — all existing QuoteEditor suites still green (the file-upload path is unchanged).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/api/quotes.ts apps/web/src/components/billing/quotes/QuoteEditor.tsx apps/web/src/components/billing/quotes/QuoteEditor.imageurl.test.tsx
git commit -m "feat(quotes): add image to a quote from a URL via a source toggle in the editor"
```

---

## Final verification

- [ ] `pnpm --filter @breeze/api test quoteImageStorage lifecycle` — API green.
- [ ] `pnpm --filter @breeze/web test QuoteEditor` — web green.
- [ ] `pnpm --filter @breeze/api typecheck && pnpm --filter @breeze/web typecheck` — no type errors (verify the exact script names in each package's `package.json`; use whatever the repo uses for type-checking).
- [ ] Manual smoke (optional, via the `run`/`worktree-stack` skill): open a draft quote → Add section → Image → From URL → paste a public image URL → confirm the block renders from `/api/v1/quotes/:id/images/:imageId` (copied bytes, source URL not referenced).

## Self-review notes (coverage against the spec)

- Spec §1 (extend endpoint, JSON branch, identical response, scheme 400) → Task 2.
- Spec §2 (`fetchRemoteImage`, safeFetch strict, size cap, magic-byte sniff, typed errors, buffering limitation) → Task 1.
- Spec §3 (segmented toggle, client fn, shared runAction flow, skip client size-check for URL) → Task 3.
- Spec §4 (service/API/web tests, no migration) → Tasks 1-3 tests; no migration step present.
- Spec security notes (SSRF delegated, Content-Type ignored, same authz) → enforced in Task 1 (safeFetch, sniff) and Task 2 (same route/perm gate).

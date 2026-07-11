# Add quote image from URL (server-side copy, not hotlink)

**Date:** 2026-07-06
**Status:** Approved design — ready for implementation plan

## Problem

Adding an image to a quote today is a two-step manual dance: the user finds an
image on the web (e.g. a manufacturer's product photo), **downloads** it to their
machine, then **uploads** the file through the "Add image" panel. This is friction
for the common case where the image already lives at a public URL.

## Goal

Let the user paste an image **URL** in the "Add image" panel. The **server fetches
the bytes and stores them** in `quote_images` exactly like an uploaded file, so the
resulting image block is byte-identical to an upload:

- Same `imageId`, same `GET /quotes/:id/images/:imageId` serving path.
- Works after the source URL dies or changes (the bytes are copied in).
- **Not a hotlink** — the customer-facing document never points at the third-party
  URL; there is no request from the customer's browser to the source.

## Non-goals

- No change to how images are stored, served, or rendered (existing `quote_images`
  bytea + authed blob loader).
- No catalog-item image change — this slice is quotes only (the request was
  specifically the quotes add-image button).
- No private/internal image sources — see SSRF section.

## Architecture

Three layers, each reusing existing machinery:

```
QuoteEditor "Add image" panel
  ├─ (toggle) Upload file  → uploadQuoteImage()      → multipart → POST /quotes/:id/images
  └─ (toggle) From URL     → addQuoteImageFromUrl()  → JSON {url} → POST /quotes/:id/images
                                                          │
                                                          ▼
                              lifecycle.ts handler (one route, one perm gate)
                                ├─ multipart branch  → today's path (unchanged)
                                └─ JSON branch       → fetchRemoteImage(url)
                                                          │
                                                          ▼  (mime, buffer)
                                        writeQuoteImage(id, orgId, mime, buffer)   ← SHARED
                                                          │
                                                          ▼
                                              quote_images (bytea row)
```

Both entry paths converge on the **same** `writeQuoteImage` and return the
**same** `{ data: { imageId, mime, byteSize } }` shape, so the "add image block"
step downstream is identical regardless of source.

## 1. API — extend the existing endpoint

Reuse `POST /quotes/:id/images` (in `apps/api/src/routes/quotes/lifecycle.ts`)
rather than adding a route. One handler, one permission gate (`quotes:write`),
one storage call. Branch on request content-type:

- **multipart** (`file` field present) → today's path, unchanged.
- **`application/json`** `{ url, caption? }` → new URL path.

The JSON body is validated with a Zod schema: `url` must parse and use the
`http:`/`https:` scheme (reject `ftp://`, `data:`, etc. with **400**). The handler
calls `fetchRemoteImage(url)`, then the **same** `writeQuoteImage(id, quote.orgId,
mime, buffer)`. Response is byte-identical to the upload path:
`{ data: { imageId, mime, byteSize } }`.

Caption remains a web-side concern (it goes into the image block's `content`,
exactly as today) — the images endpoint stores only the bytes.

Error → HTTP mapping (via the existing `handleServiceError` + typed service
errors):

| Condition | HTTP | Message |
|---|---|---|
| bad/missing scheme | 400 | `url must be an http(s) URL` |
| SSRF-blocked / unreachable | 502 | `Couldn't reach that URL` |
| non-2xx from source | 502 | `Couldn't reach that URL` |
| bytes aren't PNG/JPEG/WebP | 415 | `That URL isn't a PNG, JPEG, or WebP image` |
| over 5 MB | 413 | `Image is larger than 5 MB` |
| timeout | 504 | `The image took too long to download` |

## 2. Service — `fetchRemoteImage(url)` in `quoteImageStorage.ts`

New exported function alongside `writeQuoteImage`:

```
export async function fetchRemoteImage(url: string): Promise<{ mime: string; buffer: Buffer }>
```

Steps:

1. **`safeFetch(url, { timeoutMs: 8000 })`** — the existing SSRF guard
   (`apps/api/src/services/urlSafety.ts`): resolves DNS once, blocks
   private/loopback/link-local/cloud-metadata/CGNAT ranges, pins the validated IP
   against DNS rebinding, keeps TLS verification on, follows **no redirects** (so a
   public URL cannot 302 to an internal one). **Strict mode — no
   `allowPrivateNetwork`.** Image sources are public web; self-hosters who need an
   internal image can still upload the file.
2. Reject non-2xx status.
3. **Size cap** = `MAX_QUOTE_IMAGE_SIZE_BYTES` (5 MB). Fast-reject on
   `Content-Length` when present; always re-check actual `buffer.length` because the
   header can lie.
4. **Magic-byte sniff** via the existing `sniffImageMime(buffer)`. The source's
   `Content-Type` header is **ignored** — only the real bytes decide (PNG / JPEG /
   WebP). A URL ending in `.png` that actually serves HTML is rejected.
5. Return `{ mime, buffer }`, or throw a typed error the route maps to the table
   above.

**Known limitation (accepted):** `safeFetch` buffers the full response body into
memory (no streaming cap); the 8 s timeout bounds the blast radius. This matches
how every other `safeFetch` caller (webhooks, SSO, Pax8, Huntress) already behaves,
so we accept it here rather than introducing a streaming variant in this slice.

## 3. Web — `QuoteEditor.tsx` + `lib/api/quotes.ts`

**Segmented toggle** inside the existing `addType === 'image'` panel:

- New local state: `imageSource: 'file' | 'url'` (default `'file'`) and
  `imageUrl: string`.
- Toggle (`data-testid="quote-block-image-source-file"` /
  `...-source-url`) renders the current file picker when `'file'`, or a URL text
  input (`data-testid="quote-block-image-url"`) when `'url'`. The caption input and
  the "PNG, JPEG, or WebP, up to 5 MB" hint stay shared below both.
- Submit button label: "Upload & add image" (file) / "Fetch & add image" (url).
  Disabled unless the active source has input (file present, or non-empty trimmed
  URL).
- New client fn in `lib/api/quotes.ts`:
  `addQuoteImageFromUrl(id, url)` →
  `fetchWithAuth('/quotes/:id/images', { method:'POST',
  headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url }) })`.
- On URL submit, the **same `runAction`** block that wraps the file upload wraps
  this call (returns `{ imageId }`), then flows into the identical "add image block"
  step. Reset `imageUrl` / `imageFile` / `imageSource` / caption on success.
- The client-side 5 MB pre-check only applies to `File`; it's skipped for URLs —
  the server is the size authority and its error surfaces via the `runAction` toast.

Diff stays contained to the image branch; heading / rich_text / line_items panels
untouched.

## 4. Testing

- **Service (`quoteImageStorage.test.ts`):** with the `__setLookupForTests` hook +
  mocked `safeFetch` responses — happy path returns sniffed mime for real
  PNG/JPEG/WebP byte headers; private-IP URL throws (SSRF blocked); non-2xx throws;
  bytes that aren't a supported image throw *even when the URL/Content-Type claims
  image*; over-5 MB buffer throws; a `.png` URL serving HTML bytes is rejected.
- **API (`quotes.test.ts` / lifecycle):** JSON `{ url }` with stubbed fetch → 200
  `{ data: { imageId } }` and a row lands in `quote_images`; `ftp://` → 400;
  oversized → 413; wrong content → 415; the existing multipart path still passes.
  Auth/permission gating is already covered by the existing suite (same route).
- **Web (`QuoteEditor.*.test.tsx`):** toggle switches inputs; URL submit hits the
  JSON endpoint (mocked) and adds a block with the returned `imageId`; a rejected
  fetch shows the error toast and adds **no** block; submit disabled on empty URL.
- **No DB migration** — `quote_images` already stores the bytes; a URL-sourced
  image is just another row.

## Security notes

- SSRF is the primary risk of any "server fetches a user-supplied URL" feature. It
  is fully delegated to the audited `safeFetch` guard in strict mode; no new
  network-egress code is written.
- The source `Content-Type` is untrusted; only magic-byte sniffing of the actual
  payload determines the stored mime, preventing content-type confusion / stored-XSS
  via a mislabeled payload.
- Same `quotes:write` permission and org-scoped RLS on `quote_images` as the upload
  path — no new authz surface.

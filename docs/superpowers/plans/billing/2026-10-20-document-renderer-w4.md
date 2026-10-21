# Document Renderer W4 — one cover geometry (#9422, feature #9414)

> Parent plan: `2026-10-20-document-renderer.md` §W4. Spec §3.5, OD-5 (a), §8.2.

**Goal:** the proposal cover is the same crop on the web Preview, the portal page, the editor's upload preview and the PDF (reference, unchanged).

**Geometry (single statement):** a cover *with an image* is a page-aspect frame — A4 1 : 1.414, Letter 1 : 1.294, chosen from `branding.pageSize` — the image fills it (`object-fit: cover`, centred crop), and a near-opaque white band from 62 % of the height down carries eyebrow, title and prepared for/by (`quotePdf.ts renderCoverPage`: `bandTop = height × 0.62`, 0.94 fill). A cover *without* an image keeps the flowing text layout (the PDF's plain page has no artwork to crop).

**Constraints:** portal CSP forbids `style=""` → every dimension is a class in `document.css`; `noStyleAttribute` test stays green. W5 files untouched; no API/PDF change; no migration.

## Tasks
1. **Red:** `documentCover.test.tsx` — frame class per `pageSize` (a4/letter), image has the crop class, band element present, no `style` attr, no-image cover has no frame. Watch fail.
2. `document.css`: `.doc-cover-frame`, `.doc-cover-a4`, `.doc-cover-letter`, `.doc-cover-image`, `.doc-cover-band`.
3. `DocumentCover` takes `pageSize`; new exported `DocumentCoverCrop` (frame + image slot + optional band marker) is the one source the editor reuses. `QuoteDocumentView` passes `model.branding.pageSize`. Regenerate quote snapshots (review the diff).
4. **Red → green:** editor test — cover image preview renders inside the crop frame with the quote's `presentation.pageSize` (default a4). `QuoteImagePreview` gains an optional `crop` prop.
5. Playwright matrix in `document-renderer.spec.ts` (spec §8.2): kind {invoice, quote} × surface {Preview, public, logged-in portal} × viewport {1280, 390} × theme {classic, condensed} × web density {compact, dense} × locale {en, pt-BR}, plus cover variants (A4/Letter, with image) — Preview vs portal pixel-compared per variant under the production `style-src-attr 'none'` CSP.
6. Gates: document-ui vitest, web `components/billing/quotes` vitest, tsc (document-ui, web, portal), matrix on wt-stack (document-ui `docker cp` workaround, #9519).

# Contract Documents & Enhanced Proposals — Design

**Date:** 2026-07-16
**Status:** Approved design, pending implementation plan
**Reference artifact:** "Animal Health at Home — IT Strategy Proposal" sample PDF (21 pages: branded cover, narrative sections with images, dual pricing tables, approval form, 7-page MSA with Exhibit A)

## Goal

Make the quote builder able to produce a full client proposal like the reference PDF, and give contracts real legal-document management. Two gaps close in this effort:

1. **Contract documents as first-class entities.** Today the MSA would be pasted into `quotes.termsAndConditions` as a text blob, and `contracts` records hold only structured billing data (`notes`/`terms` free text). This effort adds a versioned, partner-wide contract template library, inline rendering of a pinned template version inside a proposal, and an executed-document snapshot filed against the billing contract on acceptance.
2. **Branded cover page.** Quote-level cover configuration (title, cover image, prepared-for/prepared-by) rendered as the proposal's first page.
3. **Rich-text fidelity.** `rich_text` blocks store HTML but every renderer strips it to plain text today: the PDF renderer (`stripHtml` in `quotePdf.ts`), the portal/public views (deliberate — no sanitizer dependency exists, and raw author HTML on the unauthenticated public page would be an XSS sink), and the web detail view. The editor is a raw-HTML `<textarea>`. The reference proposal's bold lead-ins and bullet/numbered lists — and any MSA template — require real formatting end-to-end: a sanitized constrained HTML subset, a formatted-text pdfkit renderer, safe HTML rendering in portal/web, and a TipTap WYSIWYG editor.

Everything else in the reference proposal (narrative sections, images, multiple pricing tables with section totals, one-time vs recurring, typed-name e-signature, public token link, PDF) already exists in the quote block system.

## Decisions made during brainstorming

| Question | Decision |
|---|---|
| Document format | Authored rich-text templates with merge variables **and** uploaded PDFs, both versioned |
| Signing model | One proposal signature executes pricing + embedded contract (matches reference PDF) |
| Standalone contract signing | Out of scope for v1; schema must not preclude it later |
| Cover page | In scope |
| Relationship to billing contracts | Partner-wide template library; executed snapshot attaches to the billing contract created by quote acceptance |
| Embedding mechanism | New `contract` quote block type (Approach A) — not a header slot, not PDF-append-only |
| Rich text | In scope: sanitized constrained HTML subset + formatted pdfkit rendering + TipTap editor (raised mid-design after fidelity audit; textarea/strip-to-plain-text status quo can't reproduce the reference proposal or render an MSA) |

## Data model

Three new tables, created with policies in a single idempotent migration `apps/api/migrations/2026-07-16-contract-documents.sql`.

### `contract_templates` — library entry (config table → partner-wide first)

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `org_id` / `partner_id` | dual ownership, both nullable, `contract_templates_one_owner_chk` CHECK `((org_id IS NULL) <> (partner_id IS NULL))` |
| `name`, `description` | |
| `status` | `active` / `archived` |
| `created_by`, timestamps | |

- One dual-axis RLS policy (system OR `breeze_has_org_access(org_id)` OR `breeze_has_partner_access(partner_id)`), partner index — copy a `2026-07-01-*-partner-ownership.sql` migration as reference.
- Owner scope is set at create (`ownerScope: 'organization' | 'partner'`) and immutable once any version exists (keeps child denorm from drifting).
- Templates with executed documents can only be archived, never deleted.

### `contract_template_versions` — immutable published versions

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `template_id` | FK → contract_templates |
| `org_id` / `partner_id` | denormalized from parent at insert, same XOR CHECK, own dual-axis RLS policy (FK-child tables get **no** RLS coverage for free — known contract-test blindspot) |
| `version_number` | int, per-template sequence |
| `status` | `draft` / `published`; published versions are immutable — edits create a new draft |
| `source_type` | `authored` / `uploaded` |
| `body_html` | authored contracts (rich text with `{{variable}}` placeholders) |
| `file_data`, `mime`, `byte_size`, `sha256` | uploaded PDFs, bytea-in-Postgres (`invoiceDocuments` pattern); upload endpoint is size-capped and PDF-only, sha256 computed on ingest |
| `declared_variables` | jsonb — variable names + kind (`auto` / `manual`) used for editor UI and send-time validation |
| `published_at`, `created_by` | |

### `contract_documents` — executed paper (transactional record → org-owned)

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `org_id` | **NOT NULL** — justification per playbook: this is a client-specific executed instance, not config |
| `quote_id` | nullable FK → quotes (always set in v1; nullable so standalone contract signing can exist later) |
| `quote_acceptance_id` | nullable FK → quote_acceptances (same rationale; v1 service layer requires both) |
| `contract_id` | nullable FK → contracts (billing contract); linked at acceptance when one is created, linkable later otherwise |
| `template_id`, `template_version_id` | FKs, **RESTRICT** delete |
| `rendered_html` | final substituted content as signed |
| `pdf_data`, `mime`, `byte_size`, `sha256` | final rendered contract PDF, bytea |
| `created_at` | |

Signer identity/IP/user-agent/timestamp stay on `quote_acceptances` — no duplication. `contract_documents` is *what was signed*; `quote_acceptances` is *who/when*.

RLS: shape 1 (direct `org_id`, auto-discovered).

### Quote-side changes

- **New block type `contract`** in the `quoteBlocks.blockType` enum and the shared discriminated union (`packages/shared/src/validators/quotes.ts`):
  `{ templateId, templateVersionId, variableValues: Record<string, string>, label? }`
  Pins a specific published version at attach time.
- **`quotes.cover_page`** jsonb: `{ enabled, title?, coverImageId?, preparedForOverride? }`. Cover is a page frame, not a flowing block. Cover image reuses `quoteImages`. Prepared-for defaults from bill-to snapshot; prepared-by from seller snapshot.

### Registration checklist (mechanical, do in the same PR)

- `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`): all three new tables, alphabetical by `localeCompare`, FK direction verified children-before-parents — `contract_documents` must delete before `contract_template_versions`, `contract_templates`, `contracts`, `quotes`, and `quote_acceptances`.
- `DUAL_AXIS_TENANT_TABLES` (`rls-coverage.integration.test.ts`): `contract_templates`, `contract_template_versions`.
- No `device_id` columns → device-side lists not applicable.
- `PARTNER_LINKABLE_FEATURE_TYPES` / `validateFeaturePolicyExists`: **not applicable** — contract templates are not a configuration-policy feature.

## Data flow

### Attach (quote editor)

1. "Contract" appears in the add-block menu alongside heading/rich_text/image/line_items.
2. Picking a template pins its latest **published** version.
3. Variable panel splits auto vs manual: auto variables resolve from the quote (`{{client.name}}` ← bill-to, `{{seller.name}}` ← seller snapshot, `{{quote.number}}`, `{{monthly_total}}`, `{{one_time_total}}`, `{{effective_date}}`, …); manual ones (governing state, initial term, …) are entered per proposal into `variableValues`.
4. If the template later gets a newer published version, the editor shows a non-automatic "update to vN" nudge.
5. **Send is blocked while any declared variable is unresolved** — a client must never see a raw `{{placeholder}}` in a legal document.

### Render (portal, public link, PDF)

- The block expands server-side: fetch pinned version, substitute variables, render HTML inline at the block's position. Variable values are **HTML-escaped** at substitution (injection guard — a client name must not be able to inject markup into a legal doc).
- Uploaded-PDF versions: embedded as real pages in the proposal PDF; inline viewer in web views via one new authed asset-streaming route.
- **RLS trap handled explicitly:** portal/public reads run in an org-scoped RLS context, which cannot see partner-owned template rows. The template-version fetch runs in the service layer under a system DB context (read-only, by pinned version id) — same pattern as the heartbeat probe-config precedent (#1105).

### Sign (acceptance)

Client experience unchanged: one typed-name acceptance (portal or public token). Under the hood:

1. `quoteSha256` composition extended to fold in rendered contract content (template version sha256 + resolved variable values), so the signature provably covers the legal text.
2. Acceptance renders the final contract HTML + PDF and inserts the `contract_documents` snapshot.
3. Snapshot insert is **atomic with the acceptance** (same transaction). A recorded acceptance without its executed-document snapshot must be impossible.

### File (post-acceptance)

- `quoteToContract` already creates a billing contract from recurring lines; the snapshot links to it via `contract_documents.contract_id`.
- Billing contract detail gets a **Documents** section: executed doc, template + version, signer, date, PDF download.
- Proposal with a contract block but no recurring lines → no billing contract; the snapshot still exists org-scoped and quote-linked, surfaced in the contracts area under "Unattached documents", linkable to a billing contract later.

## Rich-text fidelity pipeline

Applies identically to quote `rich_text` blocks and authored contract template bodies (`body_html`).

- **Allowed subset:** `p`, `br`, `strong`, `em`, `u`, `h3`, `h4`, `ul`, `ol`, `li`, `a[href]` (http/https only, `rel="noopener noreferrer"` forced). Everything else — tags, attributes, inline styles, event handlers, `javascript:` URLs — is stripped.
- **Sanitize on write:** all rich-text inputs (quote block create/update, template version bodies) pass through a server-side sanitizer (`sanitize-html`) before storage; only the clean subset is ever persisted.
- **Sanitize on read (defense in depth + legacy rows):** rich-text HTML is re-sanitized at the API serialization boundary for portal/public/web responses. Rows written before sanitization existed are thereby covered without a data migration.
- **Portal/web rendering:** replace strip-to-plain-text with rendering the sanitized subset as real HTML. Safe because the only HTML that can reach these views has passed the server-side sanitizer.
- **PDF rendering:** new formatted-text renderer parses the sanitized subset into paragraphs/headings/lists with inline bold/italic/underline runs and draws them with pdfkit (replacing `stripHtml` in `quotePdf.ts`); contract document rendering reuses the same module.
- **Editor:** TipTap (`@tiptap/react` + starter-kit) replaces the raw-HTML textareas in the quote editor's rich_text blocks and powers the contract template editor. TipTap's schema is configured to exactly the allowed subset, so the editor cannot produce markup the sanitizer would strip.

## API surface

- **New routes** (`apps/api/src/routes/contracts/templates.ts` or similar, mounted with existing contracts router): template CRUD, version create/publish, archive, PDF-version upload. Create accepts `ownerScope`; update schemas derived via `.partial()` must `.omit({ ownerScope: true })`. Partner-wide create/update/delete gated on `canManagePartnerWidePolicies(auth)`.
- **Quotes**: validator extensions only (`contract` block discriminant, `coverPage` schema); existing block CRUD/reorder/PDF routes carry the new type.
- **Portal/public**: no new endpoints except the uploaded-PDF asset stream; existing detail/PDF/accept routes carry expanded blocks.
- **Accept flow**: `quoteAcceptService` grows the snapshot + linkage step in-transaction.

## Web UI

- **Contracts area** (`apps/web/src/components/contracts/`): new "Templates" tab in `ContractWorkspace` — library list with "All orgs" badges (pattern: `PolicyForm.tsx`), template editor (rich-text body, variable chips, live preview with sample values), version history + publish, archive. Owner-scope selector on create only.
- **Quote editor** (`apps/web/src/components/billing/quotes/QuoteEditor.tsx`): contract block card (template picker, pinned-version indicator + update nudge, auto/manual variable form), cover-page panel (toggle, title, image, prepared-for/by preview).
- **Billing contract detail**: Documents section.
- All mutation handlers wrapped in `runAction`; no-silent-mutations contract respected.

## Error handling

- Send with unresolved variables → 422 with the list of missing variables; editor surfaces inline.
- Template archived after attach → existing pinned blocks keep rendering (version is immutable); attaching archived templates is blocked.
- Template/version delete with executions → RESTRICT (409 surfaced as "archive instead").
- Acceptance transaction failure → whole acceptance rolls back; client sees retryable error, no half-signed state.
- Uploaded PDF failing validation (not PDF / oversized) → rejected at upload, never at render time.

## Testing

- **RLS integration** (`contractTemplatesPartnerRls.integration.test.ts`): cross-partner forge → 42501; XOR violation → 23514; org isolation; portal-context read of partner-owned template succeeds only via the system-context service path.
- **Contract tests**: rls-coverage allowlists (both dual-axis tables), tenant cascade (run `tenantCascade.integration.test.ts` locally — it only fails in the Integration CI job, so a stale-base PR can go green and red main).
- **Unit**: new block + coverPage validator coverage; variable substitution (missing-variable send block, HTML escaping); version immutability; sha composition; sanitizer (XSS vectors: script/style/event handlers/`javascript:` hrefs stripped, allowed subset preserved); formatted-text PDF renderer (bold runs, nested lists, headings).
- **Integration (real Postgres)**: accept flow end-to-end — acceptance row + snapshot row + billing-contract linkage in one transaction; hash includes contract content.
- **E2E (Playwright, data-testid)**: build proposal with cover + narrative + pricing + contract block → send → accept via public link → verify Documents section on the billing contract.

## Out of scope (v1)

- Standalone contract send-for-signature (renewals/re-papering) — schema supports it later (`contract_documents` doesn't require a quote conceptually; v1 code paths do).
- Third-party e-sign integrations (DocuSign etc.).
- Contract clause libraries / composition from fragments.
- Countersignature capture (partner-side signature on the approval form remains implicit, as today).

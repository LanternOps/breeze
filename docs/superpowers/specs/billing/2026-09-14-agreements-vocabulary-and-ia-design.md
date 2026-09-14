---
tracking_issue: LanternOps/breeze#5822
---
# Agreements: vocabulary and information-architecture split — Design

**Status:** approved by Todd 2026-09-14 (critique → "I agree with your recommendations").
**Tracking:** LanternOps/breeze#5822 (W01 #5823 · W02 #5824 · W03 #5825)
**Advisor quorum:** Fable + Codex `gpt-6-astra` xhigh (verdict recorded in §8).

## 1. Problem

Breeze has two objects that both get called "Contract":

| Object | Tables | What it is |
|---|---|---|
| Billing contract | `contracts`, `contract_lines`, `contract_billing_periods`, … | Recurring service agreement that generates invoices on a cadence |
| Legal template | `contract_templates`, `contract_template_versions` | MSA / terms document, authored or uploaded PDF, versioned, attached to a quote as a proposal section |
| Signed instance | `contract_documents` | Frozen render of a template version, created at quote acceptance, optionally linked to a billing contract |

The UI calls all three "Contract": `/contracts` hosts tabs **Contracts / Templates / Documents / Currency mismatches**; the quote editor's add-block type is literally "Contract" (inserts an MSA); the portal shows the client "Download contract" on a proposal. "Terms" also means three unrelated things (contract free-text `terms` → merged into the invoice Notes block; quote "Terms & Conditions" free text; the actual legal terms in template versions). The Templates description says templates attach to *accepted* quotes (wrong: they attach to drafts and freeze at acceptance). The "Documents" tab only lists orphans (`contract_id IS NULL`). The relationship between the objects is stated nowhere in the UI (only in a source comment at `ContractDocumentsSection.tsx:34`).

Critique score: 20/40 (Nielsen heuristics). Detector: 0 visual findings. This is a naming + IA problem.

## 2. Vocabulary (normative)

| Object | Term (UI, docs, locale keys, testids) | Never |
|---|---|---|
| Billing contract | **Contract** (unchanged) | "agreement" |
| Legal template | **Agreement template** | "contract template", "contract" |
| Signed instance | **Signed agreement** | "executed document", "document" |
| Quote free text `termsAndConditions` | **Quote terms** — label "Terms & Conditions (plain text)" with helper | bare "Terms" |
| Contract free text `terms` | **Invoice note** | "Terms" |

Sentence-case UI labels (repo convention). DB tables, enums, Drizzle names, service names, and Zod validator names are **not** renamed (D5). API paths are **not** renamed (D4, see §5).

Every locale key added or renamed needs a real translation in all 8 catalogs (`en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR`); `translationCoverage.test.ts` fails on English copies, `localeParity.test.ts` on missing keys or token mismatch. Canonical translated terms for "agreement template" / "signed agreement" go into `apps/web/src/locales/TERMINOLOGY.md`.

## 3. Copy changes (Wave 1 — copy-only, no IA change)

All in `apps/web/src/locales/*/billing.json` unless noted. English values below are normative.

| Key | New English |
|---|---|
| `contracts.tabs.templates` | Agreement templates |
| `contracts.tabs.documents` | Signed agreements |
| `contracts.templatesTab.title` | Agreement templates |
| `contracts.templatesTab.description` | Your MSA and standard terms. Add one to a quote and the customer signs it with the proposal; the signed copy is filed against the contract that quote creates. |
| `contracts.templatesTab.newTemplate` | New agreement template |
| `contracts.templatesTab.loadError` | Failed to load agreement templates |
| `contracts.templatesTab.empty.title` | No agreement templates yet |
| `contracts.templatesTab.empty.description` | Add your MSA or standard terms once, then drop it into any quote. Customers sign it when they accept. |
| `contracts.templatesTab.createDialog.title` | New agreement template |
| `contracts.templatesTab.createDialog.partnerWide` | Partner-wide template |
| `contracts.templatesTab.createDialog.create` | Create agreement template |
| `contracts.templateEditor.bodyAria` | Agreement template body |
| `contracts.templateEditor.warnings.markupRemoved` | …Agreement bodies support headings, bold, italic, underline, lists and links. |
| `contracts.documentsTab.title` | Signed agreements |
| `contracts.documentsTab.description` | Signed agreements not yet linked to a contract. Link each one so it shows on the contract it governs. |
| `contracts.documentsTab.empty.title` | No unlinked signed agreements |
| `contracts.documentsTab.empty.description` | Signed agreements appear here until they're linked to a contract. |
| `contracts.documentsTab.loadError` | Could not load signed agreements. |
| `contracts.documentsTab.linkSuccess` | Signed agreement linked to contract. |
| `contracts.documentsTab.linkError` | Could not link the signed agreement to that contract. |
| `contracts.contractDetail.documents.title` | Signed agreements |
| `contracts.contractDetail.documents.subtitle` (new) | Accepted with the quote, pinned to the template version the customer saw. |
| `contracts.contractDetail.documents.empty` | No signed agreements yet. |
| `contracts.contractDetail.documents.loadError` | Could not load signed agreements. |
| `contracts.contractDetail.fields.invoiceNote` (new; replaces use of `notes` row for terms) | Invoice note |
| `contracts.contractEditor.content.termsOptional` | Invoice note (optional, added to the Notes block on generated invoices) |
| `quotes.editor.blockTypes.contract` | Agreement / terms |
| `quotes.editor.errors.loadContractTemplates` | Couldn't load agreement templates |
| `quotes.editor.errors.addContractSection` | Couldn't add the agreement section |
| `quotes.editor.success.contractSectionAdded` | Agreement section added |
| `quotes.editor.contract.templateLabel` | Agreement template |
| `quotes.editor.contract.noTemplates` | No agreement templates yet. <link>Create one</link> under Contracts → Agreement templates. (Wave 1 target `/contracts#tab=templates`; Wave 3 retargets to `/agreements/templates`.) Rendered with `<Trans>` so the link is a real anchor. |
| `quotes.editor.contract.noPublishedVersion` | This template has no published version yet. Publish it before adding it to a quote. |
| `quotes.editor.contract.untitledTemplate` | Agreement |
| `quotes.editor.contract.labelPlaceholder` | Optional label (e.g. Master Services Agreement) — unchanged |
| `quotes.editor.terms.title` | Terms & Conditions (plain text) |
| `quotes.editor.terms.helper` (new) | For reusable legal terms, add an Agreement / terms section — the customer signs it with the proposal. |
| `quotes.editor.terms.placeholder` | Payment terms, delivery notes, etc. |
| `contracts.contractEditor.content.notesOptional` | Notes (optional, added to the Notes block on generated invoices) |
| `quotes.document.contract.download` | Download agreement |
| `quotes.document.contract.previewTitle` | {{name}} agreement |

**Contract detail renders the invoice note.** `ContractDetail.tsx` currently never shows `contract.terms`. Add a read-only row "Invoice note" next to "Notes" (key `contracts.contractDetail.fields.invoiceNote`).

**Portal** (`apps/portal/src/components/portal/quoteBlocks.tsx:282,297,303,307`, no i18n in portal): "Contract" → block label if present else "Agreement"; "Download contract" → "Download agreement"; "Contract content unavailable" → "Agreement content unavailable"; "Contract file unavailable" → "Agreement file unavailable". `QuoteDetailView.tsx:334-336`: keep both terms blocks but label the second "Terms & Conditions" and the first "Notes" if `quote.terms` is the notes field (verify in the wave; if both are genuinely terms, leave labels).

**Docs** (`apps/docs/src/content/docs/features/contracts.mdx:153-182`, `quotes.mdx:196,206,252`): rename heading to `## Agreement Templates` and keep an explicit `{#contract-templates}` anchor so existing links keep resolving; replace "executed documents" wording.

Not in Wave 1: any route, testid, nav, permission, or API change. Testids stay as-is so the e2e spec `quote-contract-proposal.spec.ts` is untouched.

## 4. Permission: new resource `agreements` (Wave 2)

- `packages/shared/src/constants/permissions.ts`: add `AGREEMENTS_READ` (`agreements:read`, "View agreement templates and signed agreements") and `AGREEMENTS_WRITE` (`agreements:write`, "Create, edit, publish and archive agreement templates; link signed agreements"). No `manage` action (nothing to manage beyond write).
- `apps/api/src/db/seed.ts` `DEFAULT_PERMISSIONS`: add both rows. Role presets: `Partner Billing` gets read+write; `Partner Billing Viewer` gets read; `Org Admin` unchanged (templates are partner-scope in the UI today via `partnerScopeOnly`).
- `apps/api/src/routes/permissionsCatalog.ts` `RESOURCE_LABELS`: `agreements: 'Agreements'`.
- Migration `apps/api/migrations/<sorted-after-newest-shipped>-agreements-permission.sql`, modelled on `2026-10-15-150200-pam-dedicated-permissions.sql`: `SELECT set_config('breeze.scope','system',true)` first; idempotent inserts of the two permission rows; **back-fill**: every role that holds `contracts:write` gets `agreements:write` + `agreements:read`; every role with only `contracts:read` gets `agreements:read` (system templates, per-partner is_system clones AND custom roles — no-regression rule: nobody who could reach the template library yesterday loses it). Row counts reported via `RAISE WARNING`.
- Integration test copying `pamDedicatedPermissionsMigration.integration.test.ts`: rows exist once, idempotent replay, back-fill reaches a custom role holding `contracts:read`.
- Back-fill copies **effective** authority action-for-action: `contracts:read → agreements:read`, `contracts:write → agreements:write`; never infer write from `contracts:manage`; wildcard grants (`contracts:*`, `*:*`) are covered because `hasPermission` resolves wildcards at runtime (the plan verifies this). Invalidate any permission cache after the migration if one exists.
- API guards: `routes/contracts/templates.ts:35-36` and `documents.ts:22-23` switch `readPerm`/`writePerm` to `AGREEMENTS_*`. No transitional OR (the migration back-fill makes it unnecessary).
- Web: `Sidebar.tsx` item + `orgRecordTabs.ts` `TAB_PERMISSION.billing` add `agreements:read` (ANY-of); `OrgBillingTab.tsx` gains `showAgreements`. Tests: `seed.test.ts`, `permissions.test.ts` (shared), `permissionsCatalog.test.ts`, `Sidebar.rbac.test.tsx`, `orgRecordTabs.test.ts`, `OrgBillingTab.test.tsx`.

## 5. API paths — unchanged (quorum D4)

API paths are **not** renamed. `/contracts/contract-templates` and `/contracts/contract-documents` remain the only mounts; the two web client constants (`apps/web/src/lib/api/contractTemplates.ts:16`, `contractDocuments.ts:12`) hide them from every consumer, so a rename buys no user value and permanent aliases would be permanent maintenance. New endpoints in Wave 3 live under the existing mounts:

- `GET /contracts/contract-documents?linked=all|linked|unlinked[&orgId=][&contractId=]` — omitted `linked` keeps today's `unlinked` behaviour.
- `GET /contracts/contract-templates/:id/usage` → `{ quoteCount, signedCount }`.

## 6. IA split (Wave 3)

Sidebar → Billing:
```
Quotes            /billing/quotes
Invoices          /billing/invoices
Contracts         /contracts                    contracts:read   (billing list only)
Agreements        /agreements/templates         agreements:read  partnerScopeOnly, requiresModule service_management (inherited)
Product Catalog   /settings/catalog
```
`nav.agreements` = "Agreements" in `common.json` × 8 locales (`Sidebar.nav.test.tsx` requires a real pt-BR translation).

Pages (`apps/web/src/pages/agreements/`):
- `templates/index.astro` → `<AgreementsShell tab="templates">` → `<TemplatesTab>` (list). Row click navigates to `/agreements/templates/:id` (replaces `selectedId` component state in `TemplatesTab.tsx:39` — templates become linkable).
- `templates/[id].astro` → `<TemplateEditor templateId>`; "Back" goes to `/agreements/templates`. `id === 'new'` opens the create dialog.
- `signed/index.astro` → `<AgreementsShell tab="signed">` → `<SignedAgreementsTab>`: lists **all** `contract_documents` for the partner with columns Template · Organization · Signer · Signed · Quote · Contract; filter chip "Unlinked only" (default **off** — linking must never make a record disappear; persisted in `#unlinked=1`); "Link to contract" action on unlinked rows. This is the current `DocumentsTab` generalised; the web client passes `linked=all` explicitly. The contract-detail panel and the org-record section reuse the same list component scoped by `contractId` / `orgId`.
- `AgreementsShell` = two-tab header (Agreement templates / Signed agreements) as real links, not hash tabs, plus the one-line relationship sentence from §3 as page description.

`/contracts` (`ContractsTabs.tsx`): remove the Templates and Documents tabs. Currency mismatches stays reachable as a **filter chip / banner** on `ContractsList` ("N contracts bill in a currency that differs from the organisation's" → click opens the existing `CurrencyMismatchesTab` view under `#tab=currency-mismatches`). Net: `/contracts` has no tab bar in the default state. Old deep links `/contracts#tab=templates` and `#tab=documents` redirect client-side to `/agreements/templates` and `/agreements/signed`.

Reciprocal links:
- `ContractWorkspace.tsx` header: pill "Under {{template}} v{{n}}" when the contract has ≥1 signed agreement (from the existing documents query; first by `created_at`). Links to the Signed agreements section on the page.
- `TemplateEditor.tsx` header: "Used on {{quotes}} quotes · {{signed}} signed agreements" from a new `GET /contracts/contract-templates/:id/usage` → `{ quoteCount, signedCount }` (counts quote blocks referencing any version of the template, and `contract_documents` rows). Archive confirm dialog shows the same counts and warns that quotes pinned to it keep working but no new sections can be added.
- Org record (`OrgBillingTab.tsx`): new `<details>` "Agreements" section listing that org's signed agreements (reuse `SignedAgreementsTab` with `lockedOrgId`, unlinked filter off), gated on `agreements:read`.

Testids: new ones use the `agreements-` prefix (`agreements-shell`, `agreements-tab-templates`, `agreements-tab-signed`, `signed-agreements-tab`, `signed-agreements-unlinked-filter`, `agreement-template-editor`, `agreement-template-usage`, `contract-under-agreement-pill`, `org-billing-section-agreements`). Existing `contract-template-*` testids inside the editor may be kept; the e2e spec is updated to navigate via the sidebar to `/agreements/templates` (API URL regexes unchanged).

Docs: new page `apps/docs/src/content/docs/features/agreements.mdx` (moved from `contracts.mdx:153-182`, registered in `astro.config.mjs:109` sidebar); `contracts.mdx` keeps a short "Agreements" cross-link and its `## Permissions` section is rewritten for `agreements:*`; `quotes.mdx` links retarget to `/features/agreements/`.

## 7. Waves

| Wave | Scope | Blast radius | Rigor |
|---|---|---|---|
| W1 copy | §3 locale copy ×8, portal literals, invoice-note row on ContractDetail, docs wording | low | red-first tests on new row + locale suites |
| W2 permission | §4 | **high** (auth, migration) | full: migration integration test, seed/catalog tests, RBAC tests, `breeze_app` cross-tenant check unaffected (no new tables) |
| W3 IA split | §6 | medium | web unit tests per component, e2e spec update, docs |

W2 and W3 both depend on W1 (key names). W3 depends on W2 (permission + paths). Each wave is one PR with `Closes #<wave-issue>`.

## 8. Advisor quorum verdict (Codex gpt-6-astra xhigh, 2026-09-14)

| Decision | Codex | Resolution |
|---|---|---|
| D1 vocabulary | Agree; soften the quote helper ("instead" implied existing terms are wrong), drop "warranty clauses" placeholder, say `notes` also reaches invoices, qualify "signed" with the acceptance record | Applied in §3 |
| D2 IA split | Agree; Signed agreements must default to **all** (linking must not hide records); demote currency mismatches to banner + filter; redirect old hashes | Applied in §6 |
| D3 new permission | Agree; back-fill once, action-for-action, incl. custom roles and wildcards; don't infer write from manage; invalidate caches; no permanent `contracts OR agreements` guard | Applied in §4 |
| D4 API rename | **Disagree** — UI vocabulary doesn't require API churn; aliases are permanent maintenance; both mounts would need to share auth | Accepted; §5 rewritten: paths unchanged |
| D5 no DB rename | Agree | — |

Hard-to-reverse risks Codex flagged (recorded, not in scope):
- A signed agreement links only to the **first** billing contract created from its quote (`contractDocumentService.ts:210`); "unlinked" can legitimately mean a one-time quote. Decide filing vs legal-coverage semantics before renewals/expiry work.
- Uploaded PDFs are copied verbatim; signer evidence lives on the acceptance record. UI must surface the acceptance (signer, date, quote), never imply the PDF carries a signature.
- Quote deletion cascades acceptance evidence while the agreement PDF keeps null references (`quotes.ts:241`, `contractDocuments.ts:69`). Retention policy needed before promising a durable archive — follow-up issue.
- One `agreements:read` couples "pick a template for a quote" with "read signed customer agreements". Today `contracts:read` couples both plus billing, so this is strictly narrower; a future `agreements:use` split is possible without migration pain.

## 9. Out of scope

- Renaming DB tables, enums, Drizzle exports, service files, Zod validators.
- Renaming the `quotes` "Proposal" vs "Quote" inconsistency (separate issue).
- Org-scoped access to agreement templates (kept `partnerScopeOnly`).
- Electronic signature changes; acceptance flow unchanged.

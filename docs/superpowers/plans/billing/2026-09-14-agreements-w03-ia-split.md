---
tracking_issue: LanternOps/breeze#<<PARENT_ISSUE>>
---
# Agreements W03: IA split — `/agreements` area, reciprocal links, org record section, docs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agreement templates and signed agreements their own first-class area at `/agreements`, remove the Templates/Documents tabs from `/contracts`, and wire the three reciprocal links the spec calls for (contract → template pill, template → usage counts, org record → that org's signed agreements) — so the three objects spec §1 shows conflated ("Contract" the recurring biller, "Agreement template" the legal doc, "Signed agreement" the executed instance) finally have distinct homes and visible relationships.

**Architecture:** No new tables, no migration, **no route renames**. The API gains exactly two read surfaces on the existing contracts router: a `?linked=` filter on `GET /contracts/contract-documents` and a `GET /contracts/contract-templates/:id/usage` counter. The web side is a *move*, not a rewrite: `TemplatesTab.tsx` becomes `components/agreements/TemplatesPage.tsx` (row click navigates instead of setting local state, so a template is finally linkable), `DocumentsTab.tsx` becomes `components/agreements/SignedAgreementsPage.tsx` — parameterised by `lockedOrgId`, `lockedContractId` and `defaultUnlinkedOnly` so the org record *and* the contract detail both embed the one list instead of keeping a second table, the same embed idiom `OrgBillingTab.tsx` already uses for `ContractsList`. A thin `AgreementsShell` supplies the two-tab header as real `<a>` links plus the spec §3 relationship sentence. `ContractsTabs.tsx` loses two of its four tabs and, in the default state, its tab bar.

**Tech Stack:** Hono + Zod (route-local validators), Drizzle (`sql` count aggregates over `quote_blocks.content` jsonb), Vitest with mocked services (API routes) and Testing Library (web), Astro pages as thin `client:load` island hosts, react-i18next across 8 locales, Playwright + a page object for e2e, Starlight for docs.

**Spec:** `docs/superpowers/specs/billing/2026-09-14-agreements-vocabulary-and-ia-design.md` (approved by Todd 2026-09-14). **§6 is normative for this wave**; §2 is the vocabulary contract.

## Scope decisions that override a literal reading of spec §6

The advisor quorum revised four points after the spec was approved. Where §6 and this section disagree, **this section wins** — and the reasons are recorded so a reviewer does not "fix" them back.

1. **API paths are NOT renamed.** Spec §5/§6 imagined `/agreement-templates` and `/signed-agreements` mounts. They are not being added. `apps/web/src/lib/api/contractTemplates.ts:16` stays `BASE = '/contracts/contract-templates'` and `contractDocuments.ts:12` stays `BASE = '/contracts/contract-documents'`. Both new endpoints live under those existing mounts (`apps/api/src/routes/contracts/index.ts:16-17`). The e2e regexes at `e2e-tests/tests/quote-contract-proposal.spec.ts:76` (`/\/contracts\/contract-templates$/`) and `:332` (`/\/contracts\/contract-documents\/[^/]+\/pdf$/`) are therefore **unchanged** — Task 10 touches navigation testids only. The vocabulary rename is a UI/docs concern (spec §2 D4/D5 already exempts DB and service names); URLs join it later or never.
2. **The Signed agreements page defaults to `linked=all`.** §6 said the "Unlinked only" chip defaults **on**; it defaults **off**. A page called "Signed agreements" that opens showing only the orphans is the same lie the old Documents tab told (spec §1: *"The 'Documents' tab only lists orphans"*) — the point of the split is that this page is the inventory. The chip is still there, still persists as `#unlinked=1`, still defaults on nothing. The org-record and contract-detail embeds likewise show everything in their scope.
3. **The API default for an omitted `?linked` stays `unlinked`.** That preserves the existing `DocumentsTab` caller's behaviour verbatim while the web moves over. Consequence the implementer must not skip: **the web client now has to send `linked=all` explicitly** — a missing param is not "everything".
4. **`ContractDocumentsSection` is replaced by the shared list.** Contract detail renders `<SignedAgreementsPage lockedContractId={contract.id} />` rather than maintaining its own table. **Checked first, as instructed:** the per-contract endpoint already exists — `documents.ts:26-29` accepts `contractId`, `contractDocumentService.ts:357-358` applies it, and `ContractDocumentsSection.tsx:54` already calls `listContractDocuments({ contractId })`. So this needs **no API change at all**; `lockedContractId` just forwards into the query the shared page already builds. That is the simpler option and the one taken.

**Depends on W01 and W02.** This plan assumes:
- **W01** renamed the §3 copy keys in `apps/web/src/locales/*/billing.json`. In particular `contracts.templatesTab.description` now reads *"Your MSA and standard terms. Add one to a quote and the customer signs it with the proposal; the signed copy is filed against the contract that quote creates."* — Task 4 reuses that exact key for the shell's page description rather than duplicating the sentence.
- **W02** added `AGREEMENTS_READ` / `AGREEMENTS_WRITE` to `packages/shared/src/constants/permissions.ts` and switched the route guards at `apps/api/src/routes/contracts/templates.ts:35-36` and `documents.ts:22-23` to them. **Per decision 1 above, W02's path-alias half is dropped** — if the branch you are on already renamed the web `BASE` constants or added the `/agreement-templates` mount, revert that before starting; if it only did the permission work, you are where this plan expects.

If `get_feature_status` shows either wave still open, **stop** — do not implement around them.

## Global Constraints

- **No schema change, no migration, no new table, no new route mount.** Nothing in §6 needs one; if a step seems to, the step is wrong.
- **Tenancy: the new queries inherit the request's context.** Both new API surfaces are ordinary handlers on `contractTemplateRoutes` / `contractDocumentRoutes`, which run under the request's `withDbAccessContext` transaction — the same ambient context `listContractDocuments` (`apps/api/src/services/contractDocumentService.ts:351`) and `listTemplates` (`contractTemplateService.ts:230`) already rely on. **Do not** wrap either new service function in `withSystemDbAccessContext` / `runOutsideDbContext` (CLAUDE.md: that double-holds a pooled connection under the request's own transaction and bypasses RLS — #1105/#2417). The usage counter re-uses `getTemplateOr404` + this file's existing read assertion so a template the caller cannot see 404s before any counting happens, and every aggregate carries `auth.orgCondition(...)` on its own org column.
- **Both new endpoints are guarded by `AGREEMENTS_READ`** — reuse the module-level `readPerm` constants W02 switched (`templates.ts:35`, `documents.ts:22`). Never inline a second `requirePermission`.
- **Web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`). Reads stay raw `fetchWithAuth` + explicit 401 handling, matching the components being moved.
- **Hash for transient UI state, never query params** (CLAUDE.md). The "Unlinked only" chip persists as `#unlinked=1` via `useHashState` (`apps/web/src/lib/useHashState.ts:47`); the two agreement *tabs* are real routes, not hash state.
- **i18n:** every new key needs a real translation in all 8 catalogs (`en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR`). `localeParity.test.ts` fails on a missing key or an interpolation-token mismatch; `translationCoverage.test.ts` fails on an exact-English duplicate past the per-namespace cap. Verified current caps: `billing.json` — pt-BR 60 (`translationCoverage.test.ts:58`), es-419 46 (`:178`), fr-FR 59 (`:298`), fr-CA 59 (`:433`), de-DE 45 (`:574`), it-IT 37 (`:693`), tr-TR 22 (`:782`); `common.json` — pt-BR 103 (`:67`), es-419 88 (`:190`), fr-FR 106 (`:310`), fr-CA 108 (`:445`), de-DE 107 (`:590`), it-IT 107 (`:703`), tr-TR 49 (`:783`); `pages.json` — pt-BR 11 (`:94`), es-419 12 (`:215`), fr-FR 12 (`:340`), fr-CA 12 (`:475`), de-DE 14 (`:620`), it-IT 10 (`:720`), tr-TR 3 (`:802`). **Do not raise any baseline in this wave** — every string added here is translatable prose, so a raised cap means a lazy translation.
- **Testids:** new ones take the `agreements-` prefix per spec §6. Existing `contract-template-*` / `contract-document-*` testids inside the moved components are **kept** so the moved unit tests stay mostly intact and the e2e diff stays small; only navigation testids change.
- **File-size guideline: keep every new file under 500 lines.** `DocumentsTab.tsx` is 301 lines today; `SignedAgreementsPage.tsx` adds the filter chip, a Contract column, the row subtitle and three locking props (~+90). If it crosses ~450, extract the link dialog (`DocumentsTab.tsx:234-298`) into `components/agreements/LinkSignedAgreementDialog.tsx` **before** adding anything else.
- Run one test file as `cd apps/web && npx vitest run <path>` / `cd apps/api && npx vitest run <path>`. **Never** `pnpm --filter <pkg> test -- --run <path>` (CLAUDE.md:294 — the `--` is forwarded literally and vitest runs the whole suite in watch mode).
- Branch `feature/<parent#>-agreements-vocabulary-ia/wave-<W03 sub-issue#>`; PR body contains `Closes <<W3_ISSUE>>`.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/src/routes/contracts/documents.ts` | `?linked=all\|linked\|unlinked` + `?orgId=` on `GET /` |
| `apps/api/src/services/contractDocumentService.ts` | `listContractDocuments` honours `linked` / `orgId` |
| `apps/api/src/routes/contracts/documents.test.ts` | filter forwarding + back-compat tests |
| `apps/api/src/routes/contracts/templates.ts` | `GET /:id/usage` |
| `apps/api/src/services/contractTemplateService.ts` | `getTemplateUsage` |
| `apps/api/src/routes/contracts/templates.test.ts` | usage route tests |
| `apps/web/src/lib/api/contractDocuments.ts` (+ new `.test.ts`) | `linked` / `orgId` list params (BASE unchanged) |
| `apps/web/src/lib/api/contractTemplates.ts` | `getTemplateUsage(id)` (BASE unchanged) |
| `apps/web/src/components/agreements/AgreementsShell.tsx` (+ `.test.tsx`) | two-tab header + page description |
| `apps/web/src/components/agreements/TemplatesPage.tsx` (+ `.test.tsx`) | moved `TemplatesTab`, row click navigates |
| `apps/web/src/components/agreements/SignedAgreementsPage.tsx` (+ `.test.tsx`) | moved `DocumentsTab`, locking props + chip |
| `apps/web/src/components/agreements/AgreementTemplateEditor.tsx` (+ 2 tests) | moved `TemplateEditor` + back link + usage line |
| `apps/web/src/pages/agreements/templates/index.astro`, `templates/[id].astro`, `signed/index.astro` | thin island hosts |
| `apps/web/src/components/contracts/ContractsTabs.tsx` (+ tests) | two tabs removed, legacy-hash redirect |
| `apps/web/src/components/contracts/ContractsList.tsx` | currency-mismatch banner |
| `apps/web/src/components/contracts/ContractWorkspace.tsx` (+ `.agreement.test.tsx`) | "Under {{template}} v{{n}}" pill |
| `apps/web/src/components/contracts/ContractDetail.tsx` | renders the shared list with `lockedContractId` |
| `apps/web/src/components/contracts/ContractDocumentsSection.tsx` | **deleted** (replaced by the shared list) |
| `apps/web/src/components/layout/Sidebar.tsx` (+ nav/rbac tests) | Agreements nav item + path alias |
| `apps/web/src/components/organizations/record/OrgBillingTab.tsx` (+ test) | Agreements `<details>` section |
| `apps/web/src/locales/*/billing.json`, `common.json`, `pages.json` | new keys ×8 |
| `e2e-tests/pages/AgreementsPage.ts` (new), `e2e-tests/tests/quote-contract-proposal.spec.ts` | sidebar navigation to `/agreements/templates` |
| `apps/docs/src/content/docs/features/agreements.mdx` (new), `contracts.mdx`, `quotes.mdx`, `astro.config.mjs` | docs split |

---

## Spec §6 → task map (self-review)

| Spec §6 bullet | Task | Note |
|---|---|---|
| Sidebar → Billing gains `Agreements  /agreements/templates  agreements:read  partnerScopeOnly` | T7 | |
| `nav.agreements` = "Agreements" in `common.json` ×8, real pt-BR | T7 | |
| `templates/index.astro` → shell → templates list, row click → `/agreements/templates/:id` (replaces `TemplatesTab.tsx:39` `selectedId`) | T5 | |
| `templates/[id].astro` → editor, Back → `/agreements/templates`, `id === 'new'` opens create dialog | T5 | |
| `signed/index.astro` → all `contract_documents`, columns Template · Organization · Signer · Signed · Quote · Contract, "Unlinked only" chip, link action | T5 | chip defaults **off** (decision 2) |
| `GET /signed-agreements?linked=…` | T1 | path stays `/contracts/contract-documents` (decision 1) |
| `AgreementsShell` = two real links + §3 relationship sentence | T4 | |
| `/contracts` drops Templates + Documents tabs; currency mismatches becomes a banner/chip; no tab bar in default state | T6 | |
| `#tab=templates` / `#tab=documents` redirect client-side | T6 | |
| `ContractWorkspace` header pill "Under {{template}} v{{n}}" from the existing documents query | T8 | |
| `TemplateEditor` "Used on {{quotes}} quotes · {{signed}} signed agreements"; archive confirm shows the counts | T2 (API), T3 (client), T5 (UI) | |
| Org record `<details>` "Agreements" reusing the signed list with `lockedOrgId`, gated on `agreements:read` | T9 | filter off (decision 2) |
| Testids `agreements-shell`, `agreements-tab-templates`, `agreements-tab-signed`, `signed-agreements-tab`, `signed-agreements-unlinked-filter`, `agreement-template-editor`, `agreement-template-usage`, `contract-under-agreement-pill`, `org-billing-section-agreements` | T4, T5, T8, T9 | |
| e2e spec navigates via the sidebar to `/agreements/templates` | T10 | API regexes untouched (decision 1) |
| Docs: new `agreements.mdx`, registered in `astro.config.mjs:109`, `contracts.mdx` cross-link + rewritten Permissions, `quotes.mdx` retarget | T11 | |
| *(added)* Contract detail reuses the shared list instead of `ContractDocumentsSection` | T8 | decision 4 |
| *(added)* Row subtitle "Accepted with quote … by … on …" | T5 | decision 4 |

---

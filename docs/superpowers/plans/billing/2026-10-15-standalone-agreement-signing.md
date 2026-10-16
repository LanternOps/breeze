---
spec: docs/superpowers/specs/billing/2026-10-15-standalone-agreement-signing-spec.md
---
# Standalone Agreement Signing — Feature Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is the **feature-level** plan (waves, PR boundaries, contracts). The bite-sized TDD plan for W1 is `2026-10-15-standalone-agreement-signing-w1.md`; W2–W4 get theirs when each wave starts.

**Goal:** Let an MSP send one agreement (BAA, DPA, MSA amendment) to a client for signature — or record one signed elsewhere — without wrapping it in a $0 quote, and make every signed agreement (quote- or request-sourced) carry its own signer evidence so deleting the source never erases who signed it.

**Architecture:** A new per-org `agreement_requests` lifecycle (draft → sent → viewed → signed | declined | voided | expired) whose acceptance files straight into `contract_documents` through one shared writer, `freezeSignedAgreement`, which the quote accept path also delegates to. Signer evidence is snapshotted onto `contract_documents` (back-filled for legacy rows). The signed copy a client downloads is the frozen bytes plus a derived, never-stored signature-certificate page.

**Tech Stack:** Hono/TypeScript API, Drizzle (queries only; hand-written SQL migrations), PostgreSQL RLS (`breeze_app`), pdfkit + pdf-lib, Astro + React (web, portal), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/billing/2026-10-15-standalone-agreement-signing-spec.md` (approved 2026-10-15; OD1 A, OD2 A + B/OD2b follow-ups, OD3 A, OD4 A, OD5 A, OD6 A, OD7 B `agreements:send`, OD8 A, OD9 A, OD10 A). The spec's file:line refs are against `origin/main` @ `ec95c2f236`; at plan time `origin/main` is `509242e9f8`, two commits later (`fix(backup): browse snapshots…`, `fix(agent-ws): keep sockets open…`). Neither touches billing, quotes, contracts, tenancy registries or migrations — **every spec file:line ref still holds.** Re-verify before each wave starts.

## Global Constraints

- **Vocabulary** (spec header): UI says "Agreement template", "Signed agreement", "Contract" (billing), and the new term "Agreement request". UI never says "contract document". The certificate says "electronically accepted by", never "signed by"; no drawn/handwritten-looking signature (spec §3.8).
- **Tenancy** (spec §2, §4.1): `agreement_requests` and `agreement_request_recipients` are Shape 1, `org_id NOT NULL`, four per-command policies on `breeze_has_org_access(org_id)` copied from `apps/api/migrations/2026-07-16-contract-documents.sql:143-157`. Not config tables — the partner-wide-first rule (#2135) does not apply; the `org_id NOT NULL` justification is "per-org transactional record, exactly like `contract_documents` and `quotes`".
- **Migrations** (`apps/api/migrations/README.md`): newest committed migration on `origin/main` at plan time is **`2026-12-28-130000-pam-reconciliation-reset-capability.sql`**. Proposed names (re-run the `git ls-tree … localeCompare` check from the README at implementation time; rename to sort after whatever is newest then):
  - W1b: `2026-12-29-100000-agreement-requests.sql`
  - W2: `2026-12-29-110000-agreements-send-permission.sql`
  - W4 (if OD2-B lands): `2026-12-29-120000-contract-documents-append-only.sql`
  Never a `2026-10-15-*` name (sorts into the middle), never `2026-08-06-*` (closed block). Every file: idempotent (`IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`, `pg_policies` checks), no inner `BEGIN;`/`COMMIT;`, `SELECT set_config('breeze.scope', 'system', true);` as the first statement of any file that writes rows (`migrationRlsScope.test.ts`), RLS enabled + forced + policies in the creating file, every composite FK referencing an `org_id` column `DEFERRABLE INITIALLY IMMEDIATE`, then `pnpm db:migrate && pnpm db:check-drift`.
- **Every composite FK with `ON DELETE SET NULL` names its column list**: `ON DELETE SET NULL (contract_id)` — precedent `apps/api/migrations/2026-10-15-170000-service-deliverables.sql:57-61`; without the list Postgres also nulls `org_id NOT NULL` and the parent delete fails.
- **No FK cycle** between `agreement_requests` and `contract_documents`: there is **no** `signed_agreement_id` back-reference column (spec §4.1); the signed agreement is found via `contract_documents.agreement_request_id` (unique partial index). `CASCADE_ORDER_SET_NULL_EDGE_BREAKS` (`apps/api/src/services/tenantCascade.ts:1375`) gets **no** entry.
- **Registrations for every new `org_id` table** (`docs/agents/tenancy-rls.md`): `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:505-523`, alphabetical by `localeCompare`, `organizations` last), `orgMergeRegistry.ts` (`repoint`, around `:872`), `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts:340` for `contract_documents`, `:727-734` for the quote family precedent). No `device_id`/`ticket_id` columns → no device/ticket lists. No blob keys → no `OBJECT_PRECLEAR_TABLES` entry (`tenantCascade.ts:1390`).
- **Export classification** (`services/tenantExportPolicy.ts:42` `SUSPICIOUS_NAME_PARTS` includes `hash`, `token`; `isOpenContainer` = json/jsonb/bytea): `agreement_requests` → `excludedSensitive`: `accept_token_jti`, `accept_token_issued_at`, `accept_token_expires_at`, `accept_token_kid`, `public_response_jti`; `excludedOpen`: `variable_values`, `client_address_snapshot`, `seller_snapshot`; everything else `included`. `agreement_request_recipients` → all `included`. `contract_documents` column adds → `included`: `source_kind`, `agreement_request_id`, `signer_name`, `signer_email`, `signed_at`, `signer_ip`, `signer_user_agent`, `acceptance_origin`, `acceptance_method`, `acceptance_reference`, `recorded_by_user_id`, `acceptance_render_locale`; `reviewedIncluded`: `content_sha256`, `content_hash_version` (the latter trips the `hash` suspicious-name check if merely `included`); `pdf_data` stays `excludedOpen`.
- **CI traps** (`docs/agents/testing.md`, `docs/agents/tenancy-rls.md`): the org-cascade, org-merge-registry, export-policy, RLS-coverage and every `*.integration.test.ts` suite run only under the **Integration Tests** job (8 shards; which shard is not stable) — never under `pnpm test` / Test API. A **stacked PR** (base ≠ `main`) runs **no CI**: dispatch `gh workflow run CI --ref <branch>` and wait for it before merging. Scoped runs: `cd apps/api && npx vitest run <path>` or `pnpm --filter @breeze/api test --run <path>` — **never** `pnpm --filter <pkg> test -- --run <path>` (runs the whole suite in watch mode). Vitest path filters are substring matches. RLS coverage has its own config: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`. `orgMerge.test.ts` (`no merge policy registered for '<table>'`) reds only in the **full** unit suite, never a touched-file run.
- **Hash compatibility is an input property, not a byte property** (spec §3.7): `verifyQuoteAcceptanceHash` (`apps/api/src/services/quoteAcceptanceVerify.ts:46-91`) re-derives from the resolved variable map, the accepted-date pin and the persisted locale (NULL → `'en'`, `:25`), for both hash versions v1/v2 (`quoteContentHash.ts:50-122`). The quote-context variable map must stay **key- and value-identical** through the extraction.
- **`findUnresolvedVariables` tests key presence** (`contractTemplateRender.ts:379-392`): the request-side auto map **omits** `quote.number`, `quote.title`, `totals.one_time`, `totals.monthly`, `totals.annual`, `totals.total`, `dates.expiry` (never sets them to `''`). The request paths assert the unresolved set is empty and throw `AGREEMENT_VARIABLES_UNRESOLVED` **before** freezing — never reaching the blank-and-capture fallback at `contractDocumentService.ts:246-260`.
- **Web mutations** go through `runAction` (`apps/web/src/lib/runAction.ts`), no additions to `runActionAllowlist.ts`; `no-silent-mutations.test.ts` must pass. New `en` locale keys are added to **all 8** `billing.json` files (`de-DE`, `en`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`). Test ids only (`agreements-*`, `public-agreement-*`).
- **Settings rule 9** does not fire in W1–W3 (no new setting; expiry is a per-request field with a hard-coded 30-day default). W4 introduces the first one and must carry the rule-9 statement.
- **Permissions**: W1 gates `record-signed` on `agreements:write` (stated in the PR body). W2 adds `agreements:send` (OD7 B) via migration back-filled action-for-action from `agreements:write`, and moves send/remind/link/void/record-signed onto it.

## Review Focus

Five inputs the spec implies but no task's tests exercise by default — each gets a pinned test in the task that owns the code (W1 tasks are referenced by number in the W1 plan):

1. **A PNG/JPEG externally-signed copy served by today's `GET /contracts/contract-documents/:id/pdf`** (`routes/contracts/documents.ts:79` hard-codes `.pdf`): a user downloads `contract-document-<id>.pdf` that is really a PNG and cannot open it. → W1c Task 14: filename via `contentDispositionFor(doc.mime, …)` with the extension derived from the stored MIME; test asserts `.png` for `image/png` and `attachment` (never `inline`) disposition.
2. **`signedAt` in the future on `record-signed`**: a tech typos the year; the evidence snapshot then claims a signature that has not happened. → W1c Task 12 validator: `signedAt` must be ≤ `now + 5 minutes` (clock skew), else 400 `SIGNED_AT_IN_FUTURE`.
3. **A template declaring `{{totals.monthly}}` recorded/sent as a request**: with the key omitted the gate must refuse, not blank. → W1b Task 9 (`renderContextFromRequest` omits the keys) + W1c Task 13 (`recordSignedAgreement` throws `AGREEMENT_VARIABLES_UNRESOLVED` 422 naming the variable, and nothing is inserted).
4. **`record-signed` with a `contractId` from another org**: the composite FK raises 23503 inside the transaction; the user must see the same 404 `CONTRACT_NOT_FOUND` that `linkContractDocument` gives (`contractDocumentService.ts:459-464`), never a 500. → W1c Task 13 pre-checks the contract's `org_id` before the insert; the W1b RLS integration test proves the FK is the backstop.
5. **Back-fill on a `contract_documents` row whose `quote_acceptance_id` is already NULL** (quote deleted before this migration): the row must stay `source_kind='quote'` with NULL evidence, no error, and the UI must render it honestly ("accepted via quote; acceptance evidence unavailable"). → W1b Task 6 back-fill integration test seeds exactly this row; W2's certificate renders the "Acceptance record unavailable" text for it (spec §3.8).

---

## Wave list (each independently shippable)

| Wave | PRs | Scope (one line) | Rigor |
|---|---|---|---|
| **W1** | 3 (W1a → W1b → W1c) | Shared freeze path + evidence snapshot + registrations; `record-signed` endpoint + **Record signed agreement** dialog | **high** (migration, tenancy, quote accept path) |
| **W2** | 3 (W2a → W2b → W2c) | `agreements:send` permission; request lifecycle API; public signing page; emails + signed-copy delivery; signature certificate + `?copy=`; Send dialog + status chips | **high** (public token path, permission migration) |
| **W3** | 2 (W3a, W3b) | Portal logged-in list/detail/sign; `/portal/signed-agreements`; remind; expiry reaper; `agreement.*` bus events; docs | medium |
| **W4** (optional) | 2 (W4a, W4b) | OD8 partner setting + auto-reminders (settings rule 9); OD2-B append-only `contract_documents` | high |

Branch naming per `CLAUDE.md`: `feature/8865-standalone-agreement-signing/wave-<subissue#>`; PR body carries `Closes #<sub-issue>` only on the **last** PR of a wave (earlier PRs in the wave reference the sub-issue without a closing keyword).

---

## W1 — Shared freeze path, evidence snapshot, record-signed

**Ships on its own:** an MSP can file an externally-signed BAA (or a Breeze-rendered one recorded as signed verbally/by email) against a contract today; the retention fix lands for every existing quote-sourced signed agreement.

**Why three PRs:** the spec's W1 is a cross-module refactor of the quote accept path (hash-compat risk), a migration with a back-fill plus three registry edits (tenancy risk), and a new endpoint + dialog. A reviewer can reject the refactor without rejecting the migration and vice versa; one PR would be ~60 files.

### W1a — Extraction, zero schema (PR 1 of 3; base `main`)

**Scope**
- Golden characterization vectors for `computeQuoteSha256` + `buildContractHashParts` through the **real** resolver (`quoteAcceptanceHash.golden.test.ts`), recorded on unrefactored `main` **before** any extraction.
- `AgreementRenderContext`, `renderContextFromQuote`, `resolveAutoVariables(ctx, opts)` + `resolveQuoteAutoVariables(quote, opts)` wrapper (`contractTemplateRender.ts:289-326`).
- `freezeSignedAgreement` with the `quote` source only; `createExecutedDocuments` (`contractDocumentService.ts:198-292`) becomes a loop over it; `renderAuthoredContractPdf` takes `ctx`.
- `assertTemplateVersionUsable` extracted from `quoteService.ts:1581-1608` into `contractTemplateService.ts`; `quoteService.assertContractBlockValid` becomes a wrapper that rethrows `QuoteServiceError` 422 `INVALID_CONTRACT_TEMPLATE` (keeps `quoteService.test.ts:292` and `quoteService.clone.test.ts:336` green).
- **Spec adjustment (found against main):** `verifyQuoteAcceptanceHash` has **no production caller** — only `quoteAcceptanceVerify.test.ts` and `documentLocaleBackfill.integration.test.ts:140`. The §8 rollout gate ("confirm it still passes on a sample of production acceptances before W2") is uncallable today. W1a adds `apps/api/scripts/verify-acceptance-hashes.ts` with a tsup named entry (`apps/api/tsup.config.ts` `scripts/upgrade-preflight` pattern) so `node dist/scripts/verify-acceptance-hashes.cjs --limit 50` runs inside the image.

**Depends on:** nothing. **Blast radius:** quote accept path (every acceptance of a quote with a contract block), hash re-verification. **Rigor: high** — top-tier model writes the extraction contract and reviews; the golden test and `pnpm --filter @breeze/api test` are the mechanical gate.

**Acceptance**
- `quoteAcceptanceHash.golden.test.ts` green with the hex constants recorded pre-refactor (v1, v2; `renderLocale` `'en'`, `'fr-FR'`, legacy NULL → `'en'`; manual-over-auto; pdf vs HTML map distinct).
- `contractDocumentService.test.ts`, `contractTemplateRender.test.ts`, `quoteAcceptService.test.ts`, `quoteAcceptanceVerify.test.ts`, `quoteService.test.ts`, `quoteService.clone.test.ts`, `quoteLifecycle.test.ts` green with no expectation changes except the new wrapper names.
- Integration: `quoteAccept.integration.test.ts`, `quoteAcceptOnBehalf.integration.test.ts`, `multiCurrencyWave6QuoteAcceptance.integration.test.ts`, `documentLocaleBackfill.integration.test.ts` green.
- `verify-acceptance-hashes` script: unit test on its `.lib.ts` (sampling + summary), builds into `dist/scripts/`.
- **Post-deploy check (spec §8 rollout):** after W1a is deployed to EU and US, run `docker exec breeze-api node dist/scripts/verify-acceptance-hashes.cjs --limit 100` on each; expected `mismatches: 0`. W1b/W1c may be developed in parallel but **W2 does not start until this check is recorded on #8865.**

### W1b — Migration, schema, registrations, request-aware freeze (PR 2 of 3; base `main` after W1a merges, else stacked on W1a + `gh workflow run CI --ref`)

**Scope**
- Migration `2026-12-29-100000-agreement-requests.sql`: `agreement_requests`, `agreement_request_recipients`, `contract_documents` ALTERs (`source_kind`, `agreement_request_id`, `contract_documents_one_source_chk`, twelve evidence columns), the evidence **back-fill** from `quote_acceptances` under system scope with `GET DIAGNOSTICS` + `RAISE WARNING`.
- Drizzle schema (`apps/api/src/db/schema/contractDocuments.ts` gains both tables above `contractDocuments` — same file to avoid a circular schema import; the file is 84 lines today).
- Registrations: `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY` (both tables + `contract_documents` column adds).
- `computeAgreementSha256` (`services/agreementContentHash.ts`, OD4).
- `freezeSignedAgreement` gains `source.kind='request'`, `evidence: SignedAgreementEvidence`, `externalBytes`; the quote path now passes the acceptance's evidence so new quote-sourced rows are self-describing from day one.
- `listContractDocuments` (`contractDocumentService.ts:354-398`) reads `signerName`/`signedAt` from the snapshot columns and exposes `sourceKind`, `agreementRequestId`, `mime` and the evidence fields; web `ContractDocument` type + `documents.test.ts` LIST_ROW updated.
- Contract/integration tests: `agreementRequestsRls.integration.test.ts` (new), `contractDocumentsSourceCheck.integration.test.ts` (new), `contractDocumentsEvidenceBackfill.integration.test.ts` (new, uses `replayMigration`).

**Depends on:** W1a (freeze signature). **Blast radius:** schema, tenant erasure/merge/export, RLS. **Rigor: high** — top-tier judgment on CHECK/FK direction, export classification and RLS test design; the SQL and Drizzle schema are fully specified in the W1 plan and can be typed by a cheap model, then verified by the contract suites.

**Acceptance** (all under Integration Tests unless noted)
- `tenantCascade.integration.test.ts`: both tables present, alphabetised, FK children before parents, `topologicalCascadeOrder()` succeeds (no cycle).
- `orgCascadeFkOnDelete.integration.test.ts`: no new `ORG_CASCADE_FK_UNSAFE` entry needed (every new FK is `CASCADE`, `SET NULL` on nullable columns, or both ends in the cascade set).
- `orgMergeRegistry.integration.test.ts` + full `orgMerge.test.ts` (Test API, full unit run): policies registered; a merge with a request filed on a contract repoints without 23503.
- `tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip.integration.test.ts`: every new column classified.
- `rls-coverage.integration.test.ts` (`test:rls-coverage` config): auto-discovered, four policies each.
- `migrationRlsScope.test.ts` + `autoMigrate.test.ts` (Test API): the back-fill elects system scope; naming sorts last.
- New suites green; `pnpm db:check-drift` clean.

### W1c — Record signed elsewhere (PR 3 of 3; base `main` after W1b merges, else stacked + manual CI dispatch)

**Scope**
- Shared validator `recordSignedAgreementSchema` (`packages/shared/src/validators/agreementRequests.ts`), reusing `QUOTE_ACCEPT_ON_BEHALF_METHODS` (`packages/shared/src/validators/quotes.ts:450-452`).
- `services/agreementRequestService.ts`: `AgreementRequestServiceError`, `recordSignedAgreement(...)` — creates the request as `signed` with `origin='on_behalf'` in one transaction (template guard → contract org check → unresolved-variable gate → hash → `freezeSignedAgreement`), plus `loadTemplateVersionRenderData` in `contractTemplateRender.ts`.
- Route `routes/contracts/agreementRequests.ts` with only `POST /record-signed` (multipart; `sniffEvidenceMime` + 10 MB limit from `quoteAcceptanceEvidence.ts:36-37,109-114`), mounted at `/contracts/agreement-requests` in `routes/contracts/index.ts` before the `/:id` matchers; gated `agreements:write` (W2 flips to `agreements:send`). Audit `billing.agreement.recorded_on_behalf` via `writeRouteAudit` (`services/auditEvents.ts:225`) with a payload builder `services/agreementRecordedOnBehalfAudit.ts` shaped after `quoteAcceptOnBehalfAudit.ts`.
- `GET /contracts/contract-documents/:id/pdf` names the file by stored MIME (`contentDispositionFor`, `services/attachmentFilename.ts:30`), always `attachment`.
- Web: `lib/api/agreementRequests.ts` (`recordSignedAgreement(form: FormData)`), `components/agreements/RecordSignedAgreementDialog.tsx` opened from the three entry points (Signed agreements page header; `OrgBillingTab` via `SignedAgreementsPage lockedOrgId`; `ContractWorkspace` header beside the "Under …" pill `ContractWorkspace.tsx:159`), locale keys ×8, `SignedAgreementsPage` rows show `mime` honestly and "via quote / recorded by MSP" from `sourceKind`/`acceptanceOrigin`.
- Integration: `agreementRequestRecordSigned.integration.test.ts` (real DB: template-based + external PNG; row shapes; org-isolation).

**Depends on:** W1a + W1b. **Blast radius:** new write surface (auth + tenancy), evidence record. **Rigor: high** for the service and route (top-tier); the dialog and locale keys are cheap-implementable from the API contract.

**Acceptance**
- `agreementRequestService.test.ts`: template guard refuses another partner's template / unpublished version / archived template; contract from another org → 404 `CONTRACT_NOT_FOUND`; blank signer → 400; future `signedAt` → 400; unresolved variables → 422 before any insert; external upload binds bytes (`content_sha256` over `{kind:'external', versionSha, bytesSha256, mime}`); freeze called inside the transaction with `source.kind='request'`.
- `agreementRequests.test.ts` (route): multipart parse errors → 400 `INVALID_MULTIPART`; >10 MB → 413; sniffed non-PDF/PNG/JPEG → 415; success returns `{ request, signedAgreementId }`; audit written with method+reference.
- `documents.test.ts`: `/pdf` filename ends `.png` for `image/png`, `.pdf` for `application/pdf`; disposition `attachment`.
- Web: `RecordSignedAgreementDialog.test.tsx` (required reference, method picker from the shared tuple, file sniff hint, success callback), `SignedAgreementsPage.test.tsx` (button present only with `agreements:write`), `no-silent-mutations.test.ts` green.
- E2E deferred to W2's `agreement-standalone-signing.spec.ts` (needs the W2 public page for the full flow); W1c ships with the integration + component tests above.

---

## W2 — Send for signature, public signing page, certificate

**Ships on its own:** the headline flow — send a BAA from the contract workspace, client opens the emailed link, sees the agreement expanded with no price, types their name, gets the certified copy by email; the signed agreement appears on the contract immediately.

**PR split** (W2a base `main`; W2b/W2c sequential or stacked + manual CI):
- **W2a — permission + lifecycle API** (`high`): migration `2026-12-29-110000-agreements-send-permission.sql` adding `agreements:send` to the catalog and back-filling action-for-action from `agreements:write` (pattern: vocabulary spec §4 migration; `Partner Billing` preset gets it, `Partner Billing Viewer` does not); `PERMISSIONS.AGREEMENTS_SEND` (`packages/shared/src/constants/permissions.ts:100-101`); `routes/contracts/agreementRequests.ts` gains `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id` (draft only; signed → 409 `AGREEMENT_ALREADY_SIGNED`), `GET /:id/preview`, `POST /:id/send`, `GET /:id/link`, `POST /:id/void` (writes `public_link_revoked_at` + Redis jti revoke); `record-signed` moves to `agreements:send`; `services/agreementAcceptToken.ts` (sibling of `quoteAcceptToken.ts`, own claim set `{kind:'agreement_request', requestId, orgId, partnerId, jti}`, `exp = expires_at`, own golden vector, cross-rejection test both ways; `quoteAcceptToken.test.ts` golden vector byte-identical); `isAgreementRequestExpired(expiresAt, now)` used by every path; `services/agreementRequestAcceptService.ts` `acceptAgreementRequest` + `declineAgreementRequest` (customer path: `FOR UPDATE`, durable jti consumption before the status guard, `isPublicLinkDead`, expiry 410 at the instant boundary, provider capture, freeze inside tx, first-committed-response-wins) — its steps "build ctx → variable gate → hash → freeze" are lifted out of W1c's `recordSignedAgreement` into one shared internal `signAndFreezeRequest` helper so there is exactly one request-side writer; seed/catalog/RBAC tests for the permission as the vocabulary wave did.
- **W2b — public page + emails + outcome notify** (`high`): `routes/agreementsPublic.ts` mounted before authed routers (`apps/api/src/index.ts:813-818` pattern) with one shared `resolve()` + `isPublicLinkDead`, enumerated by a `agreementsPublic.resolve.test.ts` like `quotesPublic.superseded.test.ts`; `services/agreementRequestEmail.ts` (`buildAgreementRequestTemplate`, `renderPartnerEmail`), `services/agreementOutcomeNotify.ts` (cloned from `quoteOutcomeNotify.ts:30`), signed-copy email to signer + recipients with the certified copy attached (≤10 MB; `PdfMergeError` → original + portal link, warning logged); portal `pages/agreement/[token].astro` + `PublicAgreementView.tsx`, `ContractBody` exported from `quoteAgreements.tsx:51`, `SignaturePanel` gains `heading`/`intro`/`requireSignerEmail` props (defaults keep today's copy; quote callers unchanged), portal `api.ts` public functions.
- **W2c — certificate + web Send dialog + chips** (`medium`): `services/agreementCertificate.ts` `renderCertifiedAgreementPdf` (deterministic: `CreationDate`/`ModDate` = `signed_at`, no generated-at line; PNG/JPEG → pages via pdf-lib; pdfkit certificate page with `documentThemes.ts:75-79` fonts; `mergeUploadedContractPdfs`/`MAX_MERGED_PAGES` from `pdfMerge.ts`), `?copy=certified|original` on `GET /contracts/contract-documents/:id/pdf` (default certified; `auditSensitiveRead` `format: 'pdf-certified' | 'original'`), legacy-row "Acceptance record unavailable" text; `SendAgreementDialog.tsx` at the three entry points (create draft → live preview → send, all `runAction`), Signed agreements status chip row (`#status=pending|signed|closed` via `useHashState`), pending rows with Remind/Copy link/Void actions (Remind wired in W3; W2 ships Copy link + Void); E2E `agreement-standalone-signing.spec.ts` (send → public link → sign → appears on contract; record-signed with upload; void kills the link).

**Depends on:** W1 deployed and the hash check recorded. **Rigor: high** (public token path, permission migration, email with attachments). Top-tier: token module, `resolve()` enumeration, accept service, permission migration. Cheap-implementable: certificate renderer (fully specified table in spec §3.8), email templates, dialog, chips.

**Acceptance:** spec §8 unit list for `agreementRequestAcceptService.test.ts`, `agreementAcceptToken.test.ts`, `agreementCertificate.test.ts` (deterministic bytes; page count = original + 1; PNG → pages; stored `pdf_data` unchanged; printed hash = `sha256`; one "How" wording case per origin; no "signed by" anywhere; legacy row text; email fallback on `PdfMergeError`); route tests (`?copy=original` byte-for-byte; default certified; audit `format` differs); `agreementsSendPermission` seed/catalog/RBAC tests; web/portal component tests; `no-silent-mutations.test.ts`; E2E green.

## W3 — Portal, remind, reaper, events, docs

**Ships on its own:** portal users sign from their dashboard, download any signed agreement (both kinds), MSPs remind, stale requests expire, integrations see `agreement.*` events.

**PR split:**
- **W3a — portal + signed-agreements read model** (`medium`): `routes/portal/agreements.ts` (`portalAuth`; accept/decline require a recipient-email match as `routes/portal/quotes.ts:249-254`; fail closed without recipient rows), `GET /portal/signed-agreements` + `/:documentId/file` (document-id keyed, both `source_kind`s, MIME-correct filename, `?copy=`), portal `pages/agreements/index.astro` + `[id].astro` + `AgreementDetailView.tsx`, dashboard "awaiting your signature" list, `portal-routes-rls.integration.test.ts` additions, `AgreementDetailView.test.tsx`.
- **W3b — remind, reaper, events, docs** (`medium`): `POST /:id/remind` (same link regenerated from identity, `reminder_count`, `last_reminded_at`, 409 unless `sent`/`viewed`) + Remind row action; `jobs/agreementRequestExpiryReaper.ts` cloned from `quoteExpiryReaper.ts:59` (flip `sent`/`viewed` past `expires_at`, audit `billing.agreement.expired`); `agreement.sent|viewed|signed|declined|voided|expired` on the quote-events bus pattern (`services/quoteEvents.ts`); `apps/docs/src/content/docs/features/agreements.mdx` section "Send an agreement for signature" + "Record a signed agreement".

**Depends on:** W2. **Rigor: medium** — portal RLS tests are the one top-tier item; everything else is cheap-implementable from W2's contracts.

**Acceptance:** portal RLS integration (cross-org portal user cannot read/sign; non-recipient portal user sees but cannot sign); reaper unit test (boundary instant, idempotent re-run); remind route test; bus event emission tests; docs build.

## W4 (optional) — Settings + auto-reminders, append-only documents

**PR split:**
- **W4a — OD8** (`high`, settings rule 9): partner-level setting under Billing → Agreements (default expiry days, reminder cadence), resolver partner default → per-request override; BullMQ repeat job for reminders. PR body states home/level/resolver and the before/after count of places the concept is configured; `settingsPageRegistry.test.ts`.
- **W4b — OD2-B** (`high`): migration `2026-12-29-120000-contract-documents-append-only.sql`: `REVOKE DELETE` from `breeze_app` + immutability trigger allowing only `contract_id` updates (so `linkContractDocument` keeps working); register `contract_documents` in `AUDIT_ADMIN_REQUIRED_TABLES` (`tenantCascade.ts`); `tenantCascadeErasureBreadth.integration.test.ts` negative control. Follow-up issue for OD2b (legal hold after erasure; on-behalf quote evidence file #6633 cascade).

**Depends on:** W3. **Rigor: high.**

---

## Model routing summary (per `docs/agents/model-routing.md`)

| Task class | Examples | Route |
|---|---|---|
| **Top-tier** (contract / tenancy / auth judgment, cross-module reachability) | freeze extraction contract and the golden-vector gate (W1a); CHECK/FK direction, export classification, RLS test design (W1b); record-signed service + route auth (W1c); token sibling, `resolve()` enumeration, accept service, permission migration (W2a/b); portal RLS (W3a); OD2-B trigger (W4b) | Fable/Opus in-session; Sonnet/Opus review; Codex `xhigh` read-only on the migration |
| **Cheap-implementable** (fully specified module + co-located test) | Drizzle schema typed from the SQL; `computeAgreementSha256` + tests; `verify-acceptance-hashes` script; `recordSignedAgreementSchema`; audit payload builder; `RecordSignedAgreementDialog` from the API contract; locale keys; certificate renderer from spec §3.8's table; email templates; reaper clone; docs page | Laguna / Codex `medium` / Haiku with explicit file lists; verified by tsc + the named tests |

The W1 plan marks every task with its route.

## Spec adjustments forced by current main

1. **No production caller for `verifyQuoteAcceptanceHash`** → W1a adds `apps/api/scripts/verify-acceptance-hashes.ts` + tsup entry so the §8 rollout check is runnable (see W1a).
2. **"Golden fixtures (real acceptance rows + their stored `quote_sha256`)"** cannot live in-repo (customer data). W1a's golden test uses **synthesized characterization vectors** recorded from unrefactored `main`; the real-row check is the production script in (1). `documentLocaleBackfill.integration.test.ts:140` already drives the real resolver against a real DB and must stay green.
3. **`contract_documents` timestamps are `timestamp` (no tz)** on main (`2026-07-16-contract-documents.sql:98`), while the spec's evidence `signed_at` is `timestamptz`. The back-fill casts `qa.signed_at AT TIME ZONE 'UTC'` (the API pins the session to UTC); the new tables use `timestamptz` throughout as the spec states.
4. **`assertContractBlockValid` error type**: `quoteService.test.ts:292` / `quoteService.clone.test.ts:336` assert `QuoteServiceError` 422 `INVALID_CONTRACT_TEMPLATE`. The extracted `assertTemplateVersionUsable` throws `ContractTemplateServiceError` (422, new codes `VERSION_NOT_PUBLISHED` / `TEMPLATE_NOT_VISIBLE`, existing `TEMPLATE_ARCHIVED`); `quoteService` keeps a thin wrapper that rethrows the `QuoteServiceError` so no quote test changes.

None of these reopens a §7 decision.

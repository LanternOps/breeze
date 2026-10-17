---
title: Trust Center W2 — depth (implementation plan)
spec: docs/superpowers/specs/trust-center/2026-10-12-trust-center-design.md
tracking_issue: LanternOps/breeze#8768
wave: W02 (#8770)
status: plan-drafted 2026-10-16; awaiting Todd's review (Open Decisions below); execution method to be chosen
previous_wave_plan: docs/superpowers/plans/2026-10-13-trust-center-w1.md (shipped)
---

# Trust Center W2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Read "Sub-waves and ownership" before touching any file: you own only the files your sub-wave lists.**

**Goal:** Give a published trust page the depth buyers and auditors ask for: declared (expiring) controls, an MFA-enforcement control, gated documents with an access-request flow, a framework view, subprocessors, FAQ, a 90-day "controls met" history, a partner-wide template, portal translations, and the W1 carry-forwards.

**Architecture:** One sequential foundation sub-wave (W02a) lands every shared contract at once: the W2 tables and registrations, the payload v2 and frozen-config v2 schemas, the declared catalog, the effective-settings resolver, and file-level seams (stub section modules, stub routers, stub UI sections, locale placeholders) wired into every hub. Eight sub-waves then run in parallel. Each owns a disjoint set of files and fills its own stubs. Publication keeps W1's model: the snapshot payload is the whole public exposure, and everything publisher-authored is frozen into `trust_pages.published_config` at publish.

**Tech Stack:** TypeScript, Hono, Drizzle (queries only, hand-written SQL migrations), PostgreSQL 16 RLS, BullMQ + Redis, Zod 4, Astro 7 + React 19 (portal and web), Tailwind v4, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/trust-center/2026-10-12-trust-center-design.md`: §14 "W2 — Depth", §5.5, §9 W2 tables, §12, §18.2, §18.8, §18.13, and §19 (W1 amendments 17–24). This plan's own amendments are recorded as spec §19 items 25–36, added in the same commit. Executors read both documents.

## Global Constraints

- **W1 contracts still bind.** Public posture is never computed live. Every non-serving public case returns the same generic `{ error: 'Not found', code: 'NOT_FOUND' }` 404 with `Cache-Control: no-store`, never a 410. Public routes do every DB operation inside `runOutsideDbContext(() => withSystemDbAccessContext(...))` and call `rateLimiter()` before any DB context (#1105 tripwire). The payload is closed (`.strict()` at every level) and size-bounded.
- **Ruling 20 extends to W2.** Nothing publisher-authored reaches the public page without a publish (which requires MFA). Declarations, FAQ, subprocessors, framework selection, the history toggle, NDA text, document visibility and the render locale are all frozen into `published_config` at publish. The hourly refresh re-reads evidence, live links, declaration withdrawal and expiry, and nothing else.
- **Legacy frozen configs must keep refreshing.** A W1 `published_config` has none of the W2 fields. When a W2 field is missing, the refresh uses the W1 meaning: `catalogControlIds` → the 15 W1 ids (`W1_TELEMETRY_CONTROL_IDS`), `documents` → `documentIds` as `public`, `frameworkView` → `[]`, `locale` → `'en'`, and every content block → empty. A W1 page gains no new control, language or block until it is republished.
- **Tenancy.** Every new org table is shape 1: `org_id NOT NULL`, RLS enabled, forced and policied with the four `breeze_org_isolation_*` policies in the creating migration. Every composite FK on `org_id` is `DEFERRABLE INITIALLY IMMEDIATE`. Each table is registered in `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical, `organizations` last), `orgMergeRegistry.ts` and `CORE_TENANT_EXPORT_POLICY` in the same PR. Every `json`/`jsonb`/`bytea` column is `excludedOpen` and every token hash is `excludedSensitive`. The partner template is shape 3 (`partner_id NOT NULL`, pre-decided) and is registered only in `PARTNER_TENANT_TABLES`.
- **Migrations.** Files are hand-written, idempotent, with no inner `BEGIN`/`COMMIT`. A file that writes rows starts with `SELECT set_config('breeze.scope', 'system', true);`. Slots: W02a `2026-12-30-100300-trust-center-w2.sql`, W02g `2026-12-30-100500-trust-page-templates.sql`, and `2026-12-30-100700-*` reserved for a W02 fix-forward. Re-check the newest file on `origin/main` before committing (`ls apps/api/migrations | sort | tail -3`). The pre-push hook re-checks against `origin/main`, so rename if main overtakes you. Never edit a shipped migration. Then run `pnpm db:check-drift`.
- **Declared controls:** each declaration expires exactly 365 days after it is declared (`expires_at = declared_at + interval '365 days'`), and the reminder fires 30 days before expiry (§18.2). The public label is "Declared by <partner name> on <date>". A declared control never shares a pill style, a status value or a count with a telemetry control.
- **CIS gate (pre-decided, Todd's gate):** the CIS v8 *framework view* renders only when `BREEZE_TRUST_CIS_FRAMEWORK_VIEW` is truthy, and the flag defaults OFF. The flag is a deployment switch. It does not replace the written CIS confirmation (§18.13): Todd owns that contact and decides when to set it. While the flag is off, the default framework is NIST CSF 2.0. CIS chips and the CIS attribution line on control cards are unchanged (W1). The page never shows verbatim framework text, and never says "compliant with", "certified" or "meets IG1".
- **Tokens:** a raw access token appears only in a URL fragment (`#<token>`) or in a POST body, never in a path or a query string, so proxy and API access logs cannot hold one. Tokens are 48-char `nanoid`s stored as sha256 hex. Verification is an explicit POST from a page, because mail scanners prefetch GET links. Token pages send `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`.
- **Web:** mutations go through `runAction`. Every new web file that mutates is listed in `TARGET_GLOBS` (`apps/web/src/lib/__tests__/no-silent-mutations.test.ts`), and W02a pre-lists all of them. New keys go into **all 8 locale folders** (`apps/web/src/locales/{en,pt-BR,es-419,fr-FR,fr-CA,de-DE,it-IT,tr-TR}/`). The translations must be real: never bump a `translationCoverage.test.ts` baseline, and reword a string instead of leaving it identical to the English. Always run `npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts`; `vitest run src/locales` does not include them. PR bodies with pt-BR carry `pt-BR strings are machine-drafted pending native review`.
- **Portal:** no inline `style=` (CSP `style-src-attr 'none'`, `noInlineStyles.test.ts`) and no literal `href="/..."` (use `withBase`, `basePathCoverage.test.ts`). Portal copy uses the W02a `defineTrustCopy` mechanism (8 locales), never i18next.
- **E2E:** Playwright selects by `data-testid` only.
- **Commits** end with the attribution trailer your session's system prompt specifies. Never commit IPs, hostnames or internal domains. PR bodies use `Part of #8770`, and no sub-wave PR uses a closing keyword for #8770 or #8768. The controller closes the wave with `complete_wave` after all nine sub-waves merge.
- **CI traps:** the org-cascade and export-policy suites fail only under **Integration Tests**. `orgMerge.test.ts` fails only in the FULL API unit suite. AI-tool contract tests key `SAFE_WRITE_SITES` by file:line and cap description lengths. `mailPurposes.callSites.test.ts` rejects a registered purpose with no send site. `envReadComposeCoverage.test.ts` and `envComposeParity.test.ts` police new env vars. Typecheck with the 12 GB heap and check the exit code; `tsc | tail` hides an OOM.

## Plan-time amendments (written into spec §19 as items 25–36 by this commit)

25. **CIS framework-view gate:** `BREEZE_TRUST_CIS_FRAMEWORK_VIEW` (default off) gates CIS v8 in the framework view and in the editor's framework picker. While the flag is off, the default selection is `['nist_csf_2']`; when it is on, the spec's `['cis_v8']`. The CIS licensing confirmation remains Todd's §18.13 gate.
26. **NIST refs normalized to subcategories** (`PR.PS-02`, not `PR.PS`), so that "N of 106" counts like with like. The catalog version bumps to `2026-10-17.1`.
27. **Declared controls are their own payload array** (`declaredControls`), with statuses `current | expired`. `summary.controlsMet` stays telemetry-only. Category `governance` is added for declared-only items.
28. **`published_config` v2** freezes `documents [{id, visibility}]`, `catalogControlIds`, `declarationIds`, `frameworkView`, `showHistory`, `subprocessors`, `faq`, `ndaText` and `locale`, with the legacy defaults in Global Constraints.
29. **Payload `schemaVersion: 2`** adds `locale`, `declaredControls`, `frameworks`, `subprocessors`, `faq`, `history`, `access`, and `documents[].visibility: 'public' | 'gated'`. A v1 normalizer keeps stored v1 snapshots renderable. `payloadSha256` also excludes `history`.
30. **MFA enforcement (`mfa_enforced_m365`)** is read on the trust-page path only (`loadTrustOnlyEvidence`), not inside `loadPostureEvidence`, so the posture PDF's positional query order is untouched. The report may adopt it later.
31. **Portal i18n without a runtime:** typed per-locale copy modules (`defineTrustCopy`). Control, category, crosswalk-label and status translations live in `packages/shared/src/trustCenter/copy/`. The page language is the partner's `settings.language` (`resolvePartnerDocumentLocale`), frozen at publish (settings rule 6). W1 pages stay English until republished.
32. **Access tokens only in fragments and POST bodies** (Global Constraints). Downloads are `POST` and stream an attachment.
33. **Partner template** `trust_page_templates` (shape 3, `partner_id NOT NULL UNIQUE`, pre-decided) carries a `revision`. Publish accepts `expectedTemplateRevision` and answers 409 `TEMPLATE_CHANGED` when the template changed after the editor loaded it.
34. **Revision discipline:** every W2 child write (declarations, FAQ, subprocessors, access settings) locks the page row and bumps `publication_revision` in the same transaction, and requires `expectedRevision` (409 on stale). W1's `PUT /trust-page` and `PUT /documents` accept an optional `expectedRevision` and enforce it when sent.
35. **Gated documents** require a disclosure confirmation, as public ones do. A gated→public change re-stamps the confirmation. Anonymous download requires frozen-public ∩ live-public; gated download requires the grant ∩ frozen-gated ∩ a live link.
36. **Reserved partner slug `access`**, alongside `preview` (portal path `/trust/access/*`).

## Advisor quorum (data model)

**Author's position:** the five W2 org tables and the shape-3 template described in W02a Task 3 and W02g Task 1. A separate token table follows the `billing_link_tokens` pattern, and everything publisher-authored is frozen in `published_config`.

**Codex (gpt-6-astra, xhigh, read-only, 2026-10-16):** agreed on the overall tenancy, registration, merge and freeze design. Codex found two real defects. Both are adopted:
- The declaration immutability trigger would have rejected the `ON DELETE SET NULL` updates. It now allows exactly the non-null→NULL transitions (backup_restore_authorizations precedent) and keeps immutable attribution columns (`declared_by_partner_name`, `evidence_document_sha256`).
- Frozen document ids alone would let a draft gated→public edit enable anonymous downloads before a republish. The plan now freezes `{id, visibility}` and requires frozen ∩ live visibility.

Also adopted:
- `UNIQUE(id, org_id)` on requests before the token FK.
- Exact 365-day expiry.
- Legacy-config semantics.
- Revision locking on child writes, plus a template revision.
- An atomic consume-and-transition for verification tokens.
- Server-side derivation of the accepted NDA text, bound to the snapshot id.
- Audit of every access event.
- Separate verified/declared counts in the framework view.
- Explicit-empty intro (`''`) survives the sanitizer.
- Retention for requester PII and spent tokens.

**Disagreements** (listed under Open Decisions 1–3, each with a recommendation; not silently resolved).

## Open Decisions (for Todd)

1. **History storage.** Codex prefers a separately refreshed, bounded history response or cache, on the ground that history embedded in an immutable snapshot never "ages". The plan keeps history inside the snapshot, excluded from the hash. The renderer appends the current point at `lastEvaluatedAt` and clamps to a 90-day window. The builder includes the newest pre-window point as a baseline. The copy claims change-points only, never uninterrupted verification (the stale banner covers gaps). **Recommend the plan's approach:** it keeps "the payload is the whole public exposure" and adds no live public computation.
2. **Declaration lineage.** Codex prefers a deferrable self-FK `superseded_by_id`. The plan drops the column: lineage is `(trust_page_id, control_id)` ordered by `declared_at`, and a row is replaced by setting `superseded_at`. That removes the cycle and same-control checks and the merge repoint of a self-FK. **Recommend dropping the column.**
3. **Delivery guarantees for emails, reminders and tickets.** Codex prefers an outbox. The plan claims with a conditional `UPDATE … RETURNING`, then sends. That is at-most-once, with a `dedupeKey` on in-app notifications, an explicit **Resend link** action for grants, and a logged, non-retried ticket creation. **Recommend at-most-once plus resend.** Ask for an outbox only if missed reminders are unacceptable.
4. **Expired declarations on the public page:** shown muted as "Declaration expired on <date>" (and not counted), or hidden. **Recommend shown.** Principle 1 says a shown control shows its real status.
5. **A re-declaration goes live only on republish** (frozen ids, Ruling 20). The editor offers "Re-declare and republish". The alternative is that it goes live at the next refresh. **Recommend republish.**
6. **History default:** off, opt-in per page or via the template (matching §18.4 "percentages and device count off"), or on. **Recommend off.**
7. **"Evidenced" in the framework view:** a safeguard counts when a shown telemetry control that references it was *assessed* (met, attention or not met), or a *current* declaration references it. The counts are shown split: "evidence for N of M (V verified · D declared)". The alternative counts only *met*. **Recommend assessed,** because the per-control pills already carry pass/fail.
8. **Requester PII retention:** access requests are purged 365 days after their last state change, and tokens 30 days after expiry. **Recommend 365 days;** a GDPR-minimal alternative is 180.
9. **Existing published W1 pages stay English** until republished (locale frozen at publish, settings rule 6). The alternative localizes them at the next refresh. **Recommend frozen.**

## Review Focus

1. **A page published under W1, refreshed after W02a deploys.** Its legacy `published_config` must still parse and refresh, gain no `mfa_enforced_m365` control, stay English and render no W2 block. Test: W02a Task 4 (`publication.legacyConfig.test.ts`) + `trustPagePublication.integration.test.ts` case.
2. **A draft visibility change on a published page.** Gated→public must not make the document anonymously downloadable before a republish, and public→gated must stop the anonymous download at once. Test: W02a Task 4 (public document route) and W02d Task 3.
3. **A mail scanner GETs the verification link.** It must not verify. A second POST of a consumed token must get the same generic response as an unknown token. A token must never appear in a request path or query. Test: W02d Tasks 2–3 (+ the E2E asserts the URL has no token outside the fragment).
4. **A declaration that expires between two refreshes.** The next refresh flips it to `expired` (hash changes, new snapshot) and the framework view stops counting it. Test: W02b Task 3 and W02e Task 1.
5. **The partner template edited between Preview and Publish:** 409 `TEMPLATE_CHANGED`. Separately, an explicitly empty intro (`''`) must stay "no intro" rather than revert to inheriting the template. Test: W02a Task 4 (intro) and W02g Task 3 (revision).

---

## Sub-waves and ownership

W02a is **sequential and first**. W02b–W02i branch from `origin/main` **after W02a merges** and are mutually file-disjoint: they can run as eight parallel fixer sessions, each opening its own PR against `main`. Nothing is stacked, because stacked PRs get no CI. A file not in your "Owns" column is read-only for you. Where two sub-waves must touch the same file (the locale JSON, `mailPurposes.ts`, `settings.json`, the docs page), the touch is an **anchor insert**: you insert new lines **immediately after a named, pre-existing anchor line that belongs only to you**, never after the last key of an object and never re-indenting. Two such hunks are separated by unchanged lines, so git merges them without conflict.

| Sub-wave | Scope (one line) | Owns (create / modify) | Must not touch | Migration slot | Model | Depends on |
|---|---|---|---|---|---|---|
| **W02a Foundation** | All W2 tables + registrations, shared contracts (catalog, payload v2, frozen config v2, resolver), section/route/UI seams wired into every hub | migration `100300`; `db/schema/trustPages.ts`; `tenantCascade.ts`, `orgMergeRegistry.ts`, `tenantExportPolicyRegistry.ts` (+ tests), `orgMergeRegistry.integration.test.ts`, `trustPagesSchema.integration.test.ts`, `trustPagePublication.integration.test.ts`; `packages/shared/src/trustCenter/*` (except `frameworkCoverage.ts`, `copy/*` bodies), `validators/trustCenter.ts`, `validators/index.ts`, all W2 stub files listed in Task 5–7; `services/trustPage/{payloadBuilder,publication,resolve,revision}.ts`, `sections/{index,types}.ts`; `routes/trustPage.ts` (GET/PUT/publish), `routes/trustPagePublic.ts` (document route); `index.ts` mounts; `routerAuthGate.contract.test.ts`; `mcpCoverage.ts` (new files); `jobs/trustPageSnapshotWorker.ts`; web `TrustCenterTab.tsx`, `lib/api/trustPage.ts`, `TrustControlsSection.tsx`/`TrustContentSection.tsx` (effective values only), `trustControlCopy.ts`, `no-silent-mutations.test.ts`, `organizations.json` ×8 (placeholders); portal `TrustPageView.tsx` (hub wiring), `TrustDocumentsList.tsx` (extraction), `trustCopy.ts`, `middleware.ts`; docs anchors in `trust-center.mdx` | — | `2026-12-30-100300` | **opus** | — |
| **W02b Declared controls** | Declare / re-declare / withdraw, 365-day expiry, 30-day reminders, public rendering | `sections/declarations.ts`, `services/trustPage/declarations.ts`, `services/trustPage/declarationReminders.ts`, `services/trustPage/declarationReminderEmail.ts`, `routes/trustPageDeclarations.ts`, `validators/trustCenterDeclarations.ts`, `mailPurposes.ts`+tests (anchor A1), web `TrustDeclarationsSection.tsx` + `lib/api/trustPageDeclarations.ts`, portal `TrustDeclaredControls.tsx`; locale anchor `orgRecord.trust.declarations`; docs anchor `W02b` | every other sub-wave's files; the catalog (`declaredCatalog.ts` is W02a's) | none | **opus** | W02a |
| **W02c MFA enforcement** | `mfa_enforced_m365` evidence from `m365_ca_policies` | `services/trustPage/trustOnlyEvidence.ts`, `services/m365CaMfaEnforcement.ts` (+tests) | `postureEvidence.ts`, the catalog, everything else | none | sonnet | W02a |
| **W02d Gated documents** | `gated` visibility, request → verify → approve → 7-day download, NDA clickwrap, optional ticket, retention | `sections/access.ts`, `services/trustPage/access/*`, `routes/trustPageAccess.ts`, `routes/trustAccessPublic.ts`, `validators/trustCenterAccess.ts`, `mailPurposes.ts`+tests (anchors A2, A3), web `TrustDocumentsSection.tsx`, `TrustAccessSection.tsx`, `lib/api/trustPageAccess.ts`, portal `TrustDocumentsList.tsx`, `components/trust/access/*`, `pages/trust/access/{verify,download}.astro`, `lib/trustAccessApi.ts`, `disabledPageCoverage.test.ts`; E2E `trust-center-gated.spec.ts`; locale anchors `orgRecord.trust.access`, `orgRecord.trust.documents`; docs anchor `W02d` | `trustPagePublic.ts`, the worker, everything else | none | **opus** | W02a |
| **W02e Framework view** | "N of M safeguards evidenced" view, publisher picker, country suggestion, CIS env flag | `packages/shared/src/trustCenter/frameworkCoverage.ts`, `sections/frameworks.ts`, `config/env.ts` (+ `env.trustCisFrameworkView.test.ts`), `system/connections/internalEnvVars.ts`, `docker-compose.yml`, `docker-compose.test.yml` (if it has `x-api-env`), `.env.example`, `apps/docs/.../deploy/environment.mdx`, web `TrustFrameworksSection.tsx`, portal `TrustFrameworkView.tsx`; E2E `trust-center-frameworks.spec.ts`; locale anchor `orgRecord.trust.frameworks`; docs anchor `W02e` | the crosswalk/catalog (W02a), everything else | none | sonnet | W02a |
| **W02f Content & history** | Subprocessors (prefill + manual), FAQ, 90-day history | `sections/{subprocessors,faq,history}.ts`, `services/trustPage/subprocessorSuggestions.ts`, `routes/trustPageContent.ts`, `validators/trustCenterContent.ts`, web `TrustSubprocessorsSection.tsx`, `TrustFaqSection.tsx`, `TrustHistorySection.tsx`, `lib/api/trustPageContent.ts`, portal `TrustSubprocessors.tsx`, `TrustFaq.tsx`, `TrustHistory.tsx`; locale anchors `orgRecord.trust.{subprocessors,faq,history}`; docs anchor `W02f` | everything else | none | sonnet | W02a |
| **W02g Partner template** | Shape-3 template table, partner settings tab, inheritance UI | migration `100500`; `db/schema/trustPageTemplates.ts` + `db/schema/index.ts` (one line); `rls-coverage.integration.test.ts` (`PARTNER_TENANT_TABLES`); `trustPageTemplatesPartnerRls.integration.test.ts`; `services/trustPage/template.ts`, `routes/trustPageTemplate.ts`, `validators/trustCenterTemplate.ts`, web `PartnerSettingsPage.tsx` + its tab registry, `TrustTemplateSettings.tsx`, `lib/api/trustPageTemplate.ts`, `trustInheritance.ts`, `TrustControlsSection.tsx`, `TrustContentSection.tsx`; `settings.json` ×8 (anchor S1); locale anchor `orgRecord.trust.inheritance`; docs anchor `W02g` | `publication.ts`, `trustPage.ts`, everything else | `2026-12-30-100500` | **opus** | W02a |
| **W02h Portal i18n** | Translate the public page and per-control copy into 8 locales | `packages/shared/src/trustCenter/copy/*`, portal `TrustPageView.tsx`, `trustPageFormat.ts`, `TrustStatusPill.tsx`, `layouts/TrustPageLayout.astro`, `pages/trust/[partnerSlug]/{index,[orgSlug]}.astro`, `pages/trust/preview/[token].astro`, `lib/api.ts` (`TrustCard` type only), `components/trust/copy/pageCopy.ts`; API `routes/trustPagePublic.ts` (card only) + its test; web `trustControlCopy.ts` | other sub-waves' portal sections (they own their copy), everything else | none | sonnet | W02a |
| **W02i Carry-forwards** | Home-flag move rule, serving-set self-heal, read-only AI tool, portal dashboard link, slug-rename warning | `routes/trustPage.ts` (partner-home handler + `GET /publication`), `services/trustPage/servingSet.ts` (+test), `services/aiToolsTrustPage.ts` (+tests), `services/aiTools.ts` (one import + one call), `services/aiAgentSdkTools.ts` (registration), `mcpCoverage.ts` (`trustPage.ts` entry), `routes/portal/trustPageLink.ts`, `routes/portal/index.ts` (one mount), portal `components/portal/TrustPageLink.tsx`, `lib/trustPageLinkApi.ts`, `pages/dashboard/index.astro`, web `OrganizationForm.tsx` (+test), `lib/api/trustPagePublication.ts`; `settings.json` ×8 (anchor S2) | everything else | none | **opus** | W02a |

Each sub-wave also owns every **new** test file its tasks create (for example `trustPageDeclarations.integration.test.ts` is W02b's). A test file that already exists belongs to the owner of the file it tests.

**Anchors** (W02a creates the ones that do not exist yet):
- **Locale (organizations.json, all 8):** W02a adds placeholder objects under `orgRecord.trust`: `declarations`, `frameworks`, `subprocessors`, `faq`, `history`, `access`, `inheritance`. Each holds exactly one translated key, `"title"`, which its stub section renders. Owner sub-waves insert keys immediately **after the `"<object>": {` line**, before `"title"`. W02d also inserts into the existing `orgRecord.trust.documents` object, right after its opening line.
- **`mailPurposes.ts` and `mailPurposes.test.ts`:** A1 (W02b) is immediately after the `'staff.contract_renewal'` entry. A2 (W02d, staff) is immediately after `'staff.access_review_notice'`. A3 (W02d, customer) is immediately after `'report.delivery'`. Apply the same anchors in the test file's pinned object. Only W02d edits the test's "uses the company name" list.
- **`settings.json` (all 8):** S1 (W02g) is immediately after the opening line of the partner-settings tabs object that holds the other tab labels (the implementer finds it with `grep -n '"loginBranding"' en/settings.json` and uses the enclosing object's opening line). S2 (W02i) is immediately after `"organizationForm": {`.
- **Docs (`apps/docs/src/content/docs/security/trust-center.mdx`):** W02a adds MDX comment lines `{/* W02b: declared controls */}`, `{/* W02d: gated documents */}`, `{/* W02e: framework view */}`, `{/* W02f: subprocessors, FAQ, history */}` and `{/* W02g: partner template */}`, each followed by a blank line. Each owner inserts its section right after its comment line.

---

## W02a — Foundation and contracts (sequential, opus)

**Branch:** `feature/8768-trust-center/wave-8770-a` from `origin/main`. **PR:** `Part of #8770`. Its merge unblocks W02b–W02i.

### Task 1: Shared catalog: declared catalog, MFA-enforcement entry, NIST normalization

**Files:**
- Modify: `packages/shared/src/trustCenter/types.ts`, `controlCatalog.ts`, `frameworkCrosswalk.ts`, `index.ts`
- Create: `packages/shared/src/trustCenter/declaredCatalog.ts`, `declaredCatalog.test.ts`, `frameworkCoverage.ts` (stub: `export {};`), `copy/index.ts` (stub, below)
- Modify: `packages/shared/src/trustCenter/controlCatalog.test.ts`
- Modify: `apps/portal/src/components/trust/trustPageFormat.ts` and `apps/web/src/components/trustCenter/TrustControlsSection.tsx`. Add only the `governance` key to their category-label maps to keep the build green; Task 6 moves the web map into `trustControlCopy.ts`.

**Interfaces (Produces):**
- `TRUST_CONTROL_CATEGORY_ORDER` gains `'governance'` (last).
- `TELEMETRY_CONTROL_IDS` gains `'mfa_enforced_m365'`; `export const W1_TELEMETRY_CONTROL_IDS` = the 15 W1 ids, frozen literal.
- `DECLARED_CONTROL_IDS = ['security_awareness_training','incident_response_plan','vendor_risk_management','data_inventory','access_review','backup_recovery_plan','penetration_test','cyber_insurance'] as const`; `type DeclaredControlId`.
- `interface DeclaredControlDefinition { id: DeclaredControlId; category: TrustControlCategory; title: string; description: string; source: 'declared'; frameworkRefs: readonly FrameworkRef[] }`; `DECLARED_CONTROL_CATALOG: readonly DeclaredControlDefinition[]`; `declaredControlById(id)`.
- `TRUST_DECLARATION_TTL_DAYS = 365`, `TRUST_DECLARATION_REMINDER_DAYS = 30`.
- `TRUST_CONTROL_CATALOG_VERSION = '2026-10-17.1'`.
- `copy/index.ts` stub: `export function trustCopyFor(locale: string): null { return null; }` (W02h replaces).

- [ ] **Step 1: Write the failing tests** (`controlCatalog.test.ts` additions and new `declaredCatalog.test.ts`)

```ts
it('has 16 telemetry controls with unique insurer ranks 1..16, mfa_enforced_m365 first', () => {
  expect(TRUST_CONTROL_CATALOG).toHaveLength(16);
  expect(TRUST_CONTROL_CATALOG.map((c) => c.insurerRank).sort((a, b) => a - b)).toEqual([...Array(16)].map((_, i) => i + 1));
  expect(trustControlById('mfa_enforced_m365')).toMatchObject({ insurerRank: 1, metric: 'boolean', unit: 'org', category: 'identity_access' });
});
it('keeps the frozen W1 id list', () => {
  expect(W1_TELEMETRY_CONTROL_IDS).toHaveLength(15);
  expect(W1_TELEMETRY_CONTROL_IDS).not.toContain('mfa_enforced_m365');
  expect(TELEMETRY_CONTROL_IDS.filter((id) => id !== 'mfa_enforced_m365')).toEqual([...W1_TELEMETRY_CONTROL_IDS]);
});
it('every NIST ref is a subcategory', () => {
  const refs = [...TRUST_CONTROL_CATALOG, ...DECLARED_CONTROL_CATALOG].flatMap((c) => c.frameworkRefs).filter((r) => r.framework === 'nist_csf_2');
  for (const r of refs) expect(r.ref).toMatch(/^[A-Z]{2}\.[A-Z]{2}-\d{2}$/);
});
it('every ref of both catalogs resolves in the crosswalk and no crosswalk entry is orphaned', () => { /* both directions */ });
// declaredCatalog.test.ts
it('declares 8 controls, ids disjoint from telemetry, source declared', () => {
  expect(DECLARED_CONTROL_CATALOG.map((c) => c.id)).toEqual([...DECLARED_CONTROL_IDS]);
  expect(DECLARED_CONTROL_IDS.some((id) => (TELEMETRY_CONTROL_IDS as readonly string[]).includes(id))).toBe(false);
  expect(DECLARED_CONTROL_CATALOG.every((c) => c.source === 'declared')).toBe(true);
});
it('TTL constants match spec §18.2', () => { expect(TRUST_DECLARATION_TTL_DAYS).toBe(365); expect(TRUST_DECLARATION_REMINDER_DAYS).toBe(30); });
```

- [ ] **Step 2: Run, expect FAIL** — `cd packages/shared && npx vitest run src/trustCenter` → fails on the length 16 and on the missing exports.

- [ ] **Step 3: Implement.**
  - **New entry.** Insert `mfa_enforced_m365` at insurerRank 1 and shift every existing rank by +1. Title: "MFA enforced (Microsoft 365 Conditional Access)". Description: "An enabled Conditional Access policy requires multi-factor authentication for all users on all cloud apps. Report-only policies do not count." Refs: `cis('6.3'), cis('6.5'), e8('mfa'), ce('user_access_control'), nist('PR.AA-03')`.
  - **NIST normalization** (the test pins the subcategory format; the implementer verifies each id against NIST CSWP 29, CSF 2.0, and records the check in the crosswalk header):

    | Controls | NIST CSF 2.0 ref |
    |---|---|
    | `endpoint_protection`, `definitions_current`, `edr_coverage`, `continuous_monitoring` | `DE.CM-09` |
    | `host_firewall`, `dns_filtering` | `PR.IR-01` |
    | `password_policy` | `PR.AA-01` |
    | `backups_verified` | `PR.DS-11` (replaces `RC.RP`) |

    Crosswalk labels to add: `DE.CM-09` "Computing hardware and software monitored", `PR.IR-01` "Networks protected from unauthorized access", `PR.DS-11` "Backups created, protected and tested". Remove the now-orphaned category-level entries.
  - **Declared refs.** Breeze labels only, IG tiers from CIS v8.1. Verify every safeguard number against the CIS v8.1 PDF and every NIST id against CSWP 29, and record the source and date in the crosswalk header (the W1 Task 1 concern):

    | Declared control | CIS v8 | NIST CSF 2.0 | Essential Eight |
    |---|---|---|---|
    | `security_awareness_training` | 14.1, 14.2 (IG1) | PR.AT-01 | — |
    | `incident_response_plan` | 17.1, 17.2, 17.3 (IG1) | RS.MA-01, ID.IM-04 | — |
    | `vendor_risk_management` | 15.1 (IG1), 15.2 (IG2) | GV.SC-04 | — |
    | `data_inventory` | 3.1, 3.2 (IG1) | ID.AM-07 | — |
    | `access_review` | 5.1, 5.3, 6.1, 6.2 (IG1) | PR.AA-05 | — |
    | `backup_recovery_plan` | 11.1, 11.4 (IG1) | RC.RP-01 | `backups` |
    | `penetration_test` | 18.1, 18.2 (IG2) | ID.RA-01 | — |
    | `cyber_insurance` | none | none | — |

    Categories: `governance` for awareness, IR, vendor, insurance and pen test; `data_protection` for inventory and recovery plan; `identity_access` for access review.
  - **Essential Eight.** Add the three missing strategy labels (`application_control`, `patch_applications`, `macro_settings`) so the crosswalk holds all 8. Mark them `// framework completeness; no Breeze control maps here yet`, and exempt them from the orphan check by an explicit allowlist in the test.

- [ ] **Step 4: Run, expect PASS** — `cd packages/shared && npx vitest run src/trustCenter && npx tsc --noEmit`. Then fix the two `Record<TrustControlCategory, string>` maps the new category breaks: portal `trustPageFormat.ts` CATEGORY_LABELS gets `governance: 'Governance and response'`, and the web `TrustControlsSection.tsx` CATEGORY_LABEL gets the same. `cd apps/portal && npx vitest run src/components/trust` and `cd apps/web && npx vitest run src/components/trustCenter` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(shared): trust center W2 catalog — declared controls, mfa_enforced_m365, NIST subcategory refs (catalog 2026-10-17.1)"`

### Task 2: Shared contracts: payload v2, frozen config v2, editor inputs, effective-settings resolver

**Files:**
- Modify: `packages/shared/src/validators/trustCenter.ts`, `trustCenter.test.ts`, `packages/shared/src/validators/index.ts`
- Create: `packages/shared/src/trustCenter/effectiveSettings.ts`, `effectiveSettings.test.ts`
- Create stubs (each `export {};` plus one header comment naming its owner): `packages/shared/src/validators/trustCenterDeclarations.ts` (W02b), `trustCenterAccess.ts` (W02d), `trustCenterContent.ts` (W02f), `trustCenterTemplate.ts` (W02g). Add their `export * from` lines to `validators/index.ts` now.

**Interfaces (Produces), all exported from `@breeze/shared`:**
- `trustPagePublicPayloadV1Schema` (the W1 schema, renamed, unchanged) and `trustPagePublicPayloadSchema` (v2, `schemaVersion: z.literal(2)`), adding:
  - `locale: z.enum(SUPPORTED_LOCALES)`
  - `documents[].visibility: z.enum(['public','gated'])`
  - `declaredControls: z.array(trustPagePublicDeclaredControlSchema).max(DECLARED_CONTROL_IDS.length)`, where an entry is `{ id: enum(DECLARED_CONTROL_IDS), category, source: literal('declared'), status: enum(['current','expired']), statement: 1..1000, declaredBy: 1..255, declaredAt: iso, expiresAt: iso, evidenceDocumentId: guid|null, frameworkRefs }`
  - `frameworks: z.array(trustFrameworkSchema).max(4)` (unique)
  - `subprocessors: z.array({ name 1..200, purpose 1..300, location ≤120|null, websiteUrl httpsUrl|null }).max(50)`
  - `faq: z.array({ question 1..300, answerHtml ≤ 16_000 }).max(30)`
  - `history: z.array({ at: iso, met: int≥0, shown: int≥0 }).max(200)`
  - `access: z.strictObject({ ndaText: z.string().max(10_000).nullable() }).nullable()`
- `type TrustPagePublicPayload` (v2), `TrustPagePublicPayloadV1`, `TrustPagePublicPayloadAny = V1 | V2`; `normalizeTrustPagePayload(p: TrustPagePublicPayloadAny): TrustPagePublicPayload`. For a v1 payload it sets `locale 'en'`, makes every block empty, sets `access` to null and every document `public`.
- `trustPublishedConfigSchema`: the W1 fields, plus `documents?: {id, visibility}[] (≤20)`, `catalogControlIds?: TelemetryControlId[]`, `declarationIds: guid[] .default([])`, `frameworkView?: TrustFramework[]`, `showHistory: boolean .default(false)`, `subprocessors: frozenSubprocessor[] .default([])` (same shape as the payload entry plus `sortOrder`), `faq: {question, answerHtml}[] .default([])`, `ndaText: string≤10000 | null .default(null)`, `locale: enum .default('en')`.
- `interface TrustPublishedConfigResolved` (every field required) and `resolveFrozenConfig(c: TrustPublishedConfig): TrustPublishedConfigResolved`. Legacy defaults per Global Constraints: missing `catalogControlIds` → `[...W1_TELEMETRY_CONTROL_IDS]`, missing `documents` → `documentIds.map(id => ({ id, visibility: 'public' }))`, missing `frameworkView` → `[]`.
- `trustPageUpdateSchema` changes:
  - `searchIndexable/showPercentages/showDeviceCount/showManagedBy/showHistory: z.boolean().nullable().optional()` (null = inherit)
  - `hiddenControlIds: …nullable().optional()`
  - `frameworkView: z.array(trustFrameworkSchema).max(4).nullable().optional()`
  - `ndaText: z.string().trim().max(10_000).nullable().optional()`
  - `accessRequestCreatesTicket: z.boolean().optional()`
  - `expectedRevision: z.number().int().min(0).optional()`
  - `introHtml` keeps `.nullable().optional()`: null = inherit, `''` = explicitly none.
- `trustPageDocumentsUpdateSchema`: `visibility: z.enum(['public','gated'])`. `disclosureConfirmed` must be true for both visibilities. Adds `expectedRevision?`.
- `trustPagePublishSchema` gains `expectedTemplateRevision: z.number().int().min(0).nullable().optional()`.
- `effectiveSettings.ts`:
  ```ts
  export const TRUST_SETTING_KEYS = ['introHtml','searchIndexable','showPercentages','showDeviceCount','showManagedBy','showHistory','hiddenControlIds','frameworkView'] as const;
  export type TrustSettingKey = (typeof TRUST_SETTING_KEYS)[number];
  export type TrustSettingSource = 'page' | 'template' | 'default';
  export interface TrustSettingValues { introHtml: string | null; searchIndexable: boolean; showPercentages: boolean; showDeviceCount: boolean; showManagedBy: boolean; showHistory: boolean; hiddenControlIds: TelemetryControlId[]; frameworkView: TrustFramework[] }
  export type TrustTemplateSettings = { [K in TrustSettingKey]: TrustSettingValues[K] | null };
  export interface EffectiveTrustSettings { values: TrustSettingValues; sources: Record<TrustSettingKey, TrustSettingSource> }
  export const TRUST_BUILTIN_DEFAULTS: Omit<TrustSettingValues, 'frameworkView'>; // searchIndexable false, showPercentages false, showDeviceCount false, showManagedBy true, showHistory false, hiddenControlIds [], introHtml null
  export function resolveEffectiveTrustSettings(page: TrustTemplateSettings, template: TrustTemplateSettings | null, defaultFrameworkView: TrustFramework[]): EffectiveTrustSettings;
  ```
  `page.introHtml === ''` resolves to `{ value: null, source: 'page' }`.

- [ ] **Step 1: Write failing tests.** In `trustCenter.test.ts`:
  - v2 strictness at every new object level (one unknown key per level → fails), mirroring W1 Ruling 4.
  - The v1 schema still parses a W1 fixture.
  - `normalizeTrustPagePayload(v1)` yields `schemaVersion: 2, locale: 'en', declaredControls: [], frameworks: [], access: null`, with documents all `public`.
  - `trustPublishedConfigSchema.safeParse(W1_FIXTURE_CONFIG).success === true`.
  - `resolveFrozenConfig(W1_FIXTURE_CONFIG).catalogControlIds` equals the W1 ids and does not contain `mfa_enforced_m365`.
  - `resolveFrozenConfig(...).documents` maps W1 `documentIds` to `public`.
  - Documents PUT: gated without confirmation → error at `['documents', i, 'disclosureConfirmed']`.

  In `effectiveSettings.test.ts`, table-driven:
  - page wins (source `'page'`)
  - null page → template value (`'template'`)
  - both null → built-in (`'default'`)
  - `introHtml: ''` → `{ null, 'page' }`
  - template `null` (no template row) → defaults
  - `frameworkView` default comes from the argument.

- [ ] **Step 2: Run, expect FAIL** — `cd packages/shared && npx vitest run src/validators/trustCenter.test.ts src/trustCenter/effectiveSettings.test.ts`.
- [ ] **Step 3: Implement** the schemas and functions above. `normalizeTrustPagePayload` is the only place that knows v1 exists. Every API and portal read path calls it.
- [ ] **Step 4: Run, expect PASS** + `npx tsc --noEmit` (shared).
- [ ] **Step 5: Commit** — `feat(shared): trust page payload v2, frozen config v2 with legacy defaults, effective-settings resolver`

### Task 3: Migration `2026-12-30-100300-trust-center-w2.sql`, Drizzle schema, registrations

**Files:**
- Create: `apps/api/migrations/2026-12-30-100300-trust-center-w2.sql`
- Modify: `apps/api/src/db/schema/trustPages.ts`
- Modify: `apps/api/src/services/tenantCascade.ts`, `orgMergeRegistry.ts`, `tenantExportPolicyRegistry.ts`, `tenantExportPolicyRegistry.trustPages.test.ts`
- Modify: `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts` (`ORG_ID_BENIGN_TRIGGERS`), `trustPagesSchema.integration.test.ts`, `orgMergeCustomExecutors.integration.test.ts` (loser-page children loop)

**Migration content** (header comment states shape 1, the registrations, the scope election reason and each FK's delete behaviour; follow W1's `2026-12-29-130100-trust-pages.sql` idioms):

1. `SELECT set_config('breeze.scope', 'system', true);` (the file deletes rows in step 3).
2. Enums (via `DO $$ … duplicate_object`): `trust_access_request_status ('pending_verification','pending_approval','approved','denied','revoked')`, `trust_access_token_purpose ('verify_email','download')`, `trust_subprocessor_source ('manual','security_product','backup','m365')`. Expiry is computed from timestamps; it is never a status.
3. `trust_page_documents`. The cleanup and the swap run in one `DO $$` block:
   - delete rows with `disclosure_confirmed_at IS NULL`;
   - `GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN RAISE WARNING 'trust_page_documents: removed % unconfirmed links', n; END IF;`;
   - `DROP CONSTRAINT IF EXISTS trust_page_documents_public_confirmed_chk`;
   - add `trust_page_documents_confirmed_chk CHECK (disclosure_confirmed_at IS NOT NULL)`.

   Clean first, so a stray row cannot crash-loop `autoMigrate` (the v0.122.0 lesson).
4. `trust_pages`:
   - `ALTER COLUMN … DROP NOT NULL, DROP DEFAULT` on `search_indexable, show_percentages, show_device_count, show_managed_by, hidden_control_ids`;
   - `ADD COLUMN IF NOT EXISTS framework_view TEXT[]`, `show_history BOOLEAN`, `nda_text TEXT`, `access_request_creates_ticket BOOLEAN NOT NULL DEFAULT FALSE`;
   - `trust_pages_nda_len_chk CHECK (nda_text IS NULL OR length(nda_text) <= 10000)` (drop then re-add).

   Existing rows keep their explicit values.
5. `trust_page_declarations`:

   | column | type / rule |
   |---|---|
   | id | uuid pk default gen_random_uuid() |
   | trust_page_id, org_id | NOT NULL; FK `(trust_page_id, org_id) → trust_pages(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`; `org_id REFERENCES organizations(id)` |
   | control_id | varchar(64) NOT NULL CHECK `control_id ~ '^[a-z][a-z0-9_]{1,63}$'` (catalog membership is app-validated) |
   | statement | text NOT NULL CHECK `length(statement) BETWEEN 1 AND 1000` |
   | evidence_document_id | uuid NULL; FK `(evidence_document_id, org_id) → org_documents(id, org_id) ON DELETE SET NULL (evidence_document_id) DEFERRABLE INITIALLY IMMEDIATE` (PG16; precedent `2026-07-13-a-pax8-ordering.sql`) |
   | evidence_document_sha256 | char(64) NULL (digest at declaration; survives the SET NULL) |
   | declared_by_partner_name | varchar(255) NOT NULL (the public "declared by" label, immutable) |
   | declared_by_user_id | uuid NULL REFERENCES users(id) ON DELETE SET NULL |
   | declared_at | timestamptz NOT NULL DEFAULT now() |
   | expires_at | timestamptz NOT NULL; CHECK `expires_at = declared_at + interval '365 days'` |
   | superseded_at, withdrawn_at, reminder_sent_at | timestamptz NULL |
   | withdrawn_by_user_id | uuid NULL REFERENCES users(id) ON DELETE SET NULL |
   | created_at | timestamptz NOT NULL DEFAULT now() |

   Constraints and indexes:
   - `UNIQUE (id, org_id)`;
   - partial unique `trust_page_declarations_active_uq ON (trust_page_id, control_id) WHERE superseded_at IS NULL AND withdrawn_at IS NULL`;
   - reminder index `(expires_at) WHERE superseded_at IS NULL AND withdrawn_at IS NULL AND reminder_sent_at IS NULL`;
   - `(org_id)`.

   Trigger `trust_page_declarations_immutable_trg` (BEFORE UPDATE), modelled on `2026-12-17-170000-backup-restore-authorizations.sql`:
   - Rejects any change to `id, trust_page_id, control_id, statement, evidence_document_sha256, declared_by_partner_name, declared_at, expires_at, created_at`.
   - Allows `evidence_document_id`, `declared_by_user_id` and `withdrawn_by_user_id` to change only to NULL, except `withdrawn_by_user_id` may be set in the same statement that sets `withdrawn_at`.
   - Allows `superseded_at`, `withdrawn_at` and `reminder_sent_at` only NULL→value.
   - Allows `org_id` (merge repoint).
6. `trust_page_access_requests`:

   | column | type / rule |
   |---|---|
   | id, trust_page_id, org_id | as above; FK to `trust_pages` CASCADE DEFERRABLE |
   | requester_email | varchar(320) NOT NULL CHECK `requester_email = lower(requester_email)` |
   | requester_name, requester_company | varchar(200) NOT NULL |
   | purpose | varchar(2000) NOT NULL |
   | snapshot_id | uuid NULL, no FK (snapshots are pruned); the snapshot the requester saw |
   | nda_text_accepted | text NULL CHECK length ≤ 10000 |
   | nda_text_sha256 | char(64) NULL |
   | nda_accepted_at | timestamptz NULL; CHECK `(nda_text_accepted IS NULL) = (nda_accepted_at IS NULL) AND (nda_text_accepted IS NULL) = (nda_text_sha256 IS NULL)` |
   | status | trust_access_request_status NOT NULL DEFAULT 'pending_verification' |
   | email_verified_at, decided_at, grant_expires_at, revoked_at, last_downloaded_at | timestamptz NULL |
   | decided_by_user_id, revoked_by_user_id | uuid NULL REFERENCES users(id) ON DELETE SET NULL |
   | decision_note | varchar(500) NULL |
   | granted_document_ids | uuid[] NULL CHECK `granted_document_ids IS NULL OR cardinality(granted_document_ids) <= 20` |
   | download_count | integer NOT NULL DEFAULT 0 |
   | created_at, updated_at | timestamptz NOT NULL DEFAULT now() |

   Constraints and indexes:
   - CHECK `status <> 'approved' OR (email_verified_at IS NOT NULL AND decided_at IS NOT NULL AND grant_expires_at IS NOT NULL AND granted_document_ids IS NOT NULL)`;
   - `UNIQUE (id, org_id)`;
   - indexes `(trust_page_id, status, created_at DESC)`, `(org_id)`, `(updated_at)` (retention).
7. `trust_page_access_tokens`:
   - columns `id`, `request_id uuid NOT NULL`, `org_id`, `purpose trust_access_token_purpose NOT NULL`, `token_hash char(64) NOT NULL`, `expires_at timestamptz NOT NULL`, `consumed_at`, `revoked_at`, `created_at`;
   - `UNIQUE (token_hash)`;
   - FK `(request_id, org_id) → trust_page_access_requests(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`;
   - indexes `(request_id)` and `(expires_at)`.
8. `trust_page_faq_items`:
   - columns `id`, `trust_page_id`, `org_id` (FK CASCADE DEFERRABLE), `question varchar(300) NOT NULL`, `answer_html text NOT NULL CHECK length(answer_html) <= 16000`, `sort_order int NOT NULL`, `updated_by_user_id` (SET NULL), `created_at`, `updated_at`;
   - index `(trust_page_id, sort_order)`.
9. `trust_page_subprocessors`:
   - columns `id`, `trust_page_id`, `org_id` (FK CASCADE DEFERRABLE), `name varchar(200) NOT NULL`, `purpose varchar(300) NOT NULL`, `location varchar(120) NULL`, `website_url varchar(2048) NULL CHECK (website_url IS NULL OR website_url ~ '^https://')`, `source trust_subprocessor_source NOT NULL DEFAULT 'manual'`, `source_key varchar(120) NULL`, `sort_order int NOT NULL`, `updated_by_user_id`, timestamps;
   - partial unique `(trust_page_id, source_key) WHERE source_key IS NOT NULL`.
10. RLS for each of the five tables: `ENABLE` + `FORCE` + `DROP POLICY IF EXISTS` / `CREATE POLICY breeze_org_isolation_{select,insert,update,delete}` using `public.breeze_has_org_access(org_id)`, exactly as W1.

**Registrations:**
- `CORE_ORG_CASCADE_DELETE_ORDER`: replace the trust block with `'trust_page_access_requests','trust_page_access_tokens','trust_page_declarations','trust_page_documents','trust_page_faq_items','trust_page_snapshots','trust_page_subprocessors','trust_pages'`. That order is alphabetical by `localeCompare`; the runtime topological sort handles FK direction.
- `orgMergeRegistry.ts`: append the five new names to the existing "Children of trust_pages" repoint list (line ~1243). The custom executor already deletes the loser's page, so the children cascade away.
- `CORE_TENANT_EXPORT_POLICY`: every column of the five tables is `included`, except `trust_page_access_tokens.token_hash` (`excludedSensitive`) and `trust_page_access_requests.nda_text_sha256` and `trust_page_declarations.evidence_document_sha256` (`reviewedIncluded`, matching the `payload_sha256` precedent). Add the four new `trust_pages` columns to `included`.
- `ORG_ID_BENIGN_TRIGGERS`: `'trust_page_declarations.trust_page_declarations_immutable_trg': 'freezes attribution and dates; allows SET NULL on FKs, one-way supersede/withdraw/reminder stamps, and org_id repoint'`.

**Drizzle** (`trustPages.ts`):
- Five new tables plus enums.
- The W1 columns become nullable with no `.default()`.
- `hiddenControlIds` becomes `text().array()` (nullable).
- Export `TrustPageDeclarationRow`, `TrustPageAccessRequestRow`, `TrustPageAccessTokenRow`, `TrustPageFaqItemRow` and `TrustPageSubprocessorRow`.
- Composite FKs stay SQL-only (W1 note).

- [ ] **Step 1: Write the failing tests.**
  - `tenantExportPolicyRegistry.trustPages.test.ts`: the five tables are present, every column is classified, `token_hash` is `excludedSensitive`, `published_config` and `payload` are `excludedOpen`.
  - `trustPagesSchema.integration.test.ts` adds:
    - As `breeze_app` in org A's context, inserting into each new table with org B's `org_id` → `42501`.
    - Updating `declarations.statement` → raises `integrity_constraint_violation`.
    - Updating `withdrawn_at` from NULL → succeeds.
    - Updating `withdrawn_at` back to NULL → raises.
    - Deleting the evidence `org_documents` row → the declaration survives with `evidence_document_id IS NULL` and `evidence_document_sha256` intact.
    - Deleting a user → `declared_by_user_id` is NULL and the row survives.
    - `expires_at` other than +365 days → `23514`.
    - Approved request without a grant → `23514`.
    - Gated document link without confirmation → `23514`.
    - Two active declarations for one control → `23505`.
  - `orgMergeCustomExecutors.integration.test.ts`: seed a loser page with one row in each new table; after merge, the loser has 0 rows in every new table and the survivor's rows are untouched.
- [ ] **Step 2: Run, expect FAIL**:
  ```bash
  pnpm test-stack up   # writes .env.test; export its DATABASE_URL for the commands below
  pnpm --filter @breeze/api test --run src/services/tenantExportPolicyRegistry.trustPages.test.ts
  pnpm --filter @breeze/api test:integration src/__tests__/integration/trustPagesSchema.integration.test.ts
  ```
- [ ] **Step 3: Implement** the migration, the Drizzle schema and the registrations.
- [ ] **Step 4: Verify (all must PASS):**
  ```bash
  pnpm --filter @breeze/api db:migrate && pnpm --filter @breeze/api db:migrate   # second run proves idempotency
  pnpm db:check-drift
  pnpm --filter @breeze/api test --run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/services/orgMerge.test.ts src/services/orgMergeCustomExecutors.trustPages.test.ts src/services/tenantExportPolicyRegistry.trustPages.test.ts
  pnpm --filter @breeze/api test:integration src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenantCascadeFkChildren.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/trustPagesSchema.integration.test.ts
  DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
  ```
- [ ] **Step 5: Commit** — `feat(api): trust center W2 tables (declarations, access requests/tokens, FAQ, subprocessors) with shape-1 RLS; inheritable trust_pages settings; cascade/merge/export registrations`

### Task 4: Section seam, builder v2, publication freeze, routes

**Files:**
- Create: `apps/api/src/services/trustPage/sections/types.ts`, `sections/index.ts`, `sections/index.test.ts`, `services/trustPage/revision.ts`, `revision.test.ts`, `publication.legacyConfig.test.ts`
- Create stubs (one exported function each, owner named in a header comment): `sections/declarations.ts` (W02b), `sections/access.ts` (W02d), `sections/frameworks.ts` (W02e), `sections/subprocessors.ts`, `sections/faq.ts`, `sections/history.ts` (W02f), `services/trustPage/trustOnlyEvidence.ts` (W02c), `services/trustPage/template.ts` (W02g), `services/trustPage/declarationReminders.ts` (W02b), `services/trustPage/access/retention.ts` (W02d)
- Modify: `payloadBuilder.ts` (+test), `publication.ts` (+test), `resolve.ts` (reserved `access`), `trustPagePublicPayload.contract.test.ts`, `routes/trustPage.ts` (+test), `routes/trustPagePublic.ts` (document route + `normalizeTrustPagePayload` on reads) (+test), `servingSet.ts` (cache type `TrustPagePublicPayloadAny` only), `jobs/trustPageSnapshotWorker.ts` (+test), `__tests__/integration/trustPagePublication.integration.test.ts`

**Interfaces (Produces): the seam every parallel sub-wave fills.**
```ts
// sections/types.ts
export interface SectionDraftContext { page: TrustPageRow; asOf: Date }
export interface SectionBuildContext {
  page: TrustPageRow; asOf: Date; partnerName: string;
  config: TrustPublishedConfigResolved;
  documents: TrustPagePublicPayload['documents'];   // exactly as they will appear in the payload
}
// stubs and their final signatures (stub bodies in brackets)
declarations.ts:  freezeDeclarationIds(ctx: SectionDraftContext): Promise<string[]>                       [[]]
                  buildDeclaredControls(ctx: SectionBuildContext): Promise<TrustPagePublicPayload['declaredControls']>  [[]]
subprocessors.ts: freezeSubprocessors(ctx: SectionDraftContext): Promise<TrustPublishedConfig['subprocessors']>  [[]]
                  buildSubprocessors(ctx: SectionBuildContext): TrustPagePublicPayload['subprocessors']    [[]]
faq.ts:           freezeFaq(ctx: SectionDraftContext): Promise<TrustPublishedConfig['faq']>                [[]]
                  buildFaq(ctx: SectionBuildContext): TrustPagePublicPayload['faq']                       [[]]
history.ts:       buildHistory(ctx: SectionBuildContext): Promise<TrustPagePublicPayload['history']>      [[]]
frameworks.ts:    defaultFrameworkView(): TrustFramework[]                                               [['nist_csf_2']]
                  resolveFrameworkView(selection: readonly TrustFramework[]): TrustFramework[]            [selection minus 'cis_v8', canonical order]
                  frameworkOptionsFor(i: { partnerCountry: string | null }): Array<{ framework: TrustFramework; available: boolean; suggested: boolean }>  [all four; available = framework !== 'cis_v8'; suggested false]
access.ts:        buildAccessBlock(ctx: SectionBuildContext): TrustPagePublicPayload['access']            [ctx.documents.some(gated) ? { ndaText: ctx.config.ndaText } : null]
trustOnlyEvidence.ts: loadTrustOnlyEvidence(orgId: string, asOf: Date, policy: PostureEvidencePolicy): Promise<Partial<PostureControlEvidence>>  [{}]
template.ts:      loadPartnerTemplate(partnerId: string): Promise<{ settings: TrustTemplateSettings; revision: number } | null>  [null]
declarationReminders.ts: runDeclarationReminders(now: Date): Promise<{ reminded: number }>               [{ reminded: 0 }]
access/retention.ts:     pruneTrustAccessData(now: Date): Promise<{ tokens: number; requests: number }>  [{ tokens: 0, requests: 0 }]
// sections/index.ts — W02a-owned orchestration
export async function freezeSections(ctx: SectionDraftContext): Promise<Pick<TrustPublishedConfig, 'declarationIds' | 'subprocessors' | 'faq'>>;
export async function buildSections(ctx: SectionBuildContext): Promise<Pick<TrustPagePublicPayload, 'declaredControls' | 'subprocessors' | 'faq' | 'history' | 'frameworks' | 'access'>>;
// revision.ts
export async function withTrustPageRevision<T>(args: { pageId: string; expectedRevision: number | undefined; actorUserId: string },
  fn: (tx: DbTx) => Promise<T>): Promise<{ result: T; publicationRevision: number }>;
// SELECT … FOR UPDATE; when expectedRevision is defined and differs → TrustPageError('This page changed since you loaded it. Reload and try again.', 409, 'REVISION_MISMATCH');
// runs fn(tx), then UPDATE publication_revision = publication_revision + 1, updated_at, updated_by_user_id; returns the new revision.
```

**Behaviour changes:**
- **`buildTrustPagePayload(input)`.** The input takes `config: TrustPublishedConfigResolved`, `sections` and `locale` instead of reading flags off `page`.
  - Controls are filtered by `config.catalogControlIds` minus `config.hiddenControlIds`.
  - Every control-level W1 projection rule is unchanged.
  - `documents[].visibility` comes from the frozen entry, demoted to `gated` when the live link is gated, so the more restrictive value wins.
  - It emits `schemaVersion: 2`.
  - `payloadSha256` also drops `history`.
- **`buildSnapshotForPage(page, { config: 'draft' | TrustPublishedConfig })`:**
  - Overlays `loadTrustOnlyEvidence()` onto `evidence.controls` before evaluating.
  - In draft mode, the effective settings come from `resolveEffectiveTrustSettings(pageSettings(page), (await loadPartnerTemplate(page.partnerId))?.settings ?? null, defaultFrameworkView())`, plus `freezeSections`, `documents` from live links (both visibilities, confirmed), `catalogControlIds` = all current ids, `ndaText` = `page.ndaText`, and `locale` = `resolvePartnerDocumentLocale(partner)`.
  - In frozen mode it uses `resolveFrozenConfig`.
  - It then calls `buildSections`.
  - `config` in the result is the full frozen v2 object, with `documentIds` kept for back-compat.
- **`loadPublicDocumentsForPage`** returns both visibilities, with `visibility` in the row.
- **`publishTrustPage`:**
  - Accepts `expectedTemplateRevision?: number | null`.
  - Before building, if `expectedTemplateRevision !== undefined`, compares it with `(await loadPartnerTemplate(partnerId))?.revision ?? null`; a mismatch → 409 `TEMPLATE_CHANGED` "Your partner's Trust Center template changed since you loaded this page. Reload and publish again."
- **`refreshPublishedPage`** is unchanged apart from passing the parsed v2 config.
- **`GET /orgs/:orgId/trust-page`** adds:
  - `effective: EffectiveTrustSettings`
  - `template: { revision: number } | null`
  - `frameworkOptions: frameworkOptionsFor({ partnerCountry: partners.billingAddressCountry })`

  (the select in `resolveAccessibleOrg` gains `billingAddressCountry`).
- **`PUT /orgs/:orgId/trust-page`:**
  - Writes the new fields.
  - Stores `introHtml` as: `null` → NULL; a string → `sanitizeIntro(s) ?? ''`, so empty or whitespace-only HTML becomes the explicit `''`.
  - Uses `withTrustPageRevision` with the optional `expectedRevision`.
  - Same for `PUT /documents`, which also re-stamps the disclosure provenance when a link's visibility changes (amendment 35; the W1 I7 carry-over applies only when visibility is unchanged).
- **`POST /publish`** passes `expectedTemplateRevision`.
- **`GET /controls`** overlays the trust-only evidence, so the editor sees 16 controls.
- **Public document route:** additionally requires the payload entry's `visibility === 'public'` (frozen), on top of the existing live `visibility = 'public'` SQL. Every place that reads a stored or cached payload (`payloadFor`, card, document route) passes it through `normalizeTrustPagePayload` before use.
- **`TRUST_RESERVED_PARTNER_SLUGS`** gains `'access'`.
- **The worker** calls `runDeclarationReminders(now)` and `pruneTrustAccessData(now)` after the prune, each in its own try/catch. It adds `reminded` and `accessPruned` to `TrustPageSweepSummary`.

- [ ] **Step 1: Write the failing tests.**
  - `publication.legacyConfig.test.ts`, a refresh from `W1_FIXTURE_CONFIG` (no W2 fields):
    - `payload.controls.map(c => c.id)` excludes `mfa_enforced_m365` even when the evidence for it is `met`;
    - `payload.locale === 'en'`;
    - `declaredControls`, `faq`, `subprocessors`, `history` and `frameworks` are all `[]`;
    - `access === null`;
    - `refreshPublishedPage` returns `rebuilt` (it never skips).
  - `payloadBuilder.test.ts`:
    - a gated frozen document stays gated;
    - a frozen-public document whose live link is now gated renders `gated`;
    - `payloadSha256` equal for two payloads differing only in `history`;
    - `schemaVersion === 2`.
  - `sections/index.test.ts` (sections mocked): `buildSections` returns each stub's value under the right key; `freezeSections` merges the three freezes.
  - `revision.test.ts`: stale `expectedRevision` → 409 `REVISION_MISMATCH` with `fn` never called; `undefined` → `fn` runs and the revision bumps by 1.
  - `trustPage.test.ts`:
    - GET returns `effective.sources.showPercentages === 'default'` for a fresh page;
    - PUT `{ introHtml: '<p> </p>' }` stores `''` and GET then reports `effective.values.introHtml === null` with source `'page'`;
    - PUT with a stale `expectedRevision` → 409;
    - publish with `expectedTemplateRevision: 3` while the loader returns `null` → 409 `TEMPLATE_CHANGED`;
    - documents PUT gated→public re-stamps `disclosureConfirmedAt`.
  - `trustPagePublic.test.ts`:
    - a document whose payload entry is `gated` but whose live link is `public` → generic 404;
    - a v1 cached payload is served normalized (`schemaVersion: 2`);
    - partner slug `access` → 404 with zero SQL.
  - `trustPagePublicPayload.contract.test.ts`: the denylist runs over a v2 fixture with every block filled, and adds `requesterEmail`, `token`, `tokenHash` and `ndaAccepted` to the denylist.
  - `trustPagePublication.integration.test.ts`: a page published under a hand-written W1 `published_config` refreshes, and its new snapshot has `schemaVersion: 2` and no `mfa_enforced_m365`.
- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/trustPage src/routes/trustPage.test.ts src/routes/trustPagePublic.test.ts src/jobs/trustPageSnapshotWorker.test.ts`.
- [ ] **Step 3: Implement** per the behaviour list, keeping each stub's body exactly as bracketed above.
- [ ] **Step 4: Run, expect PASS**, then the integration test with the test stack up: `pnpm --filter @breeze/api test:integration src/__tests__/integration/trustPagePublication.integration.test.ts`.
- [ ] **Step 5: Commit** — `feat(api): trust page section seam, payload v2 builder, frozen-config v2 publish/refresh, revision helper, template-revision check`

### Task 5: Stub routers, mounts and route registries

**Files:**
- Create (each an `export const xRoutes = new Hono();` with `authMiddleware` where authenticated, and a header comment naming its owner):
  - `routes/trustPageDeclarations.ts` (`trustPageDeclarationRoutes`, W02b)
  - `routes/trustPageContent.ts` (`trustPageContentRoutes`, W02f)
  - `routes/trustPageAccess.ts` (`trustPageAccessRoutes`, W02d)
  - `routes/trustAccessPublic.ts` (`trustAccessPublicRoutes`, **no auth**, W02d)
  - `routes/trustPageTemplate.ts` (`trustPageTemplateRoutes`, W02g)
- Modify: `apps/api/src/index.ts`. Mount `api.route('/trust/access', trustAccessPublicRoutes)` **before** `api.route('/trust', trustPagePublicRoutes)`. Mount the three org routers with `api.route('/orgs', …)` next to `trustPageRoutes`, and `api.route('/trust-page-template', trustPageTemplateRoutes)`.
- Modify: `apps/api/src/__tests__/routerAuthGate.contract.test.ts` — EXEMPT `trustAccessPublicRoutes: 'Trust Center gated-document requests are unauthenticated by design: anonymous requesters, hashed fragment tokens, generic failures (spec trust-center §12).'`.
- Modify: `apps/api/src/services/mcpCoverage.ts`:
  - `'trustPageDeclarations.ts': { exempt: 'human_only_trust_material', note: 'Declared controls are attestations made by a named MSP user; human-only.' }`
  - `'trustPageAccess.ts': { exempt: 'human_only_approval', note: 'Approving release of gated documents to an outside party; human-only, MFA.' }`
  - `'trustAccessPublic.ts': { exempt: 'portal', note: 'Anonymous gated-document request/verify/download for end customers.' }`
  - `'trustPageContent.ts': { exempt: 'tool_in_later_wave', note: 'Trust page FAQ/subprocessor editing; read access arrives via get_trust_page_status (#8770 W02i).' }`
  - `'trustPageTemplate.ts': { exempt: 'tool_in_later_wave', note: 'Partner Trust Center template; partner-wide admin + MFA.' }`
- Check: `src/extensions/reservedRouteNamespaces.test.ts` already reserves `trust`, and `trust-page-template` sits under no reserved namespace collision. Run it.

- [ ] **Step 1: Failing test** — run `cd apps/api && npx vitest run src/__tests__/routerAuthGate.contract.test.ts src/services/mcp-coverage.test.ts src/extensions/reservedRouteNamespaces.test.ts` after creating the files and mounts but before the registry entries → expect FAIL naming the new files.
- [ ] **Step 2: Add the registry entries**, then run → PASS.
- [ ] **Step 3: Commit** — `chore(api): mount W2 trust routers (stubs) and register auth-gate / MCP coverage`

### Task 6: Web foundation: client types, hub wiring, stub sections, locale placeholders

**Files:**
- Modify: `apps/web/src/lib/api/trustPage.ts`:
  - `TrustPageDraft`: nullable toggles, `frameworkView`, `showHistory`, `ndaText`, `accessRequestCreatesTicket`.
  - `TrustLinkedDocument.visibility: 'public' | 'gated'`.
  - `TrustPageState`: `effective: EffectiveTrustSettings`, `template: { revision } | null`, `frameworkOptions`.
  - `publishTrustPage` body: `expectedTemplateRevision`.
- Modify: `TrustControlsSection.tsx`, `TrustContentSection.tsx`. Read `state.effective.values[key]` for display and write explicit values; no inheritance UI (W02g adds it). Move `CATEGORY_LABEL` and the catalog title/description lookups into `apps/web/src/components/trustCenter/trustControlCopy.ts` as `useTrustControlCopy(): { categoryLabel(c: TrustControlCategory): string; controlTitle(id: TelemetryControlId | DeclaredControlId): string; controlDescription(id): string }`. It returns catalog English; W02h localizes it.
- Create stubs (each renders `<section data-testid="trust-<name>-section"><h3>{t('orgRecord.trust.<name>.title')}</h3></section>` and accepts `TrustSectionProps = { orgId: string; orgFetch: OrgFetch; state: TrustPageState; canWrite: boolean; onReload: () => Promise<void> }`, exported from `trustPage.ts`):
  - `TrustDeclarationsSection.tsx` (W02b)
  - `TrustFrameworksSection.tsx` (W02e)
  - `TrustSubprocessorsSection.tsx`, `TrustFaqSection.tsx`, `TrustHistorySection.tsx` (W02f)
  - `TrustAccessSection.tsx` (W02d)
- Modify: `TrustCenterTab.tsx`. Render order: StatusCard, Controls, **Declarations**, **Frameworks**, Content, **FAQ**, **Subprocessors**, Documents, **Access**, **History**, Badge.
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`. Add the six new section files and `src/components/trustCenter/TrustTemplateSettings.tsx`, `src/components/settings/OrganizationForm.tsx` (if not already present) to `TARGET_GLOBS`. W02a creates `TrustTemplateSettings.tsx` as a stub too (W02g), so `statSync` passes.
- Modify: `apps/web/src/locales/*/organizations.json` (8 files). Add under `orgRecord.trust` the objects `declarations`, `frameworks`, `subprocessors`, `faq`, `history`, `access`, `inheritance`, each `{ "title": "<translated>" }`. English titles: "Declared controls", "Framework view", "Subprocessors", "Frequently asked questions", "Controls met over time", "Document access requests", "Inherited settings". Each object spans three lines (opening, title, closing) so its owner's anchor line is unique.

- [ ] **Step 1: Failing test** — `TrustCenterTab.test.tsx`: the tab renders all six new section test ids in the order above. `TrustControlsSection.test.tsx`: with `page.showPercentages: null` and `effective.values.showPercentages: true`, the toggle reads checked.
- [ ] **Step 2: Run, expect FAIL** — `cd apps/web && npx vitest run src/components/trustCenter src/lib/api/trustPage.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**: `cd apps/web && npx vitest run src/components/trustCenter src/lib/api src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts`.
- [ ] **Step 5: Commit** — `feat(web): Trust Center W2 seams — effective settings, stub sections, locale placeholders`

### Task 7: Portal foundation: copy mechanism, v2 normalization, section stubs, access-page headers, docs anchors

**Files:**
- Create: `apps/portal/src/components/trust/trustCopy.ts` + `trustCopy.test.ts`:
  ```ts
  export function defineTrustCopy<T extends Record<string, string | ((...a: never[]) => string)>>(copy: Record<SupportedLocale, T>): Record<SupportedLocale, T>;
  export function pickTrustCopy<T>(copy: Record<SupportedLocale, T>, locale: string | null | undefined): T;   // unknown → 'en'
  export function copyParityProblems(copy: Record<string, Record<string, unknown>>): string[];             // key-set mismatch, empty string
  export const TrustLocaleContext: React.Context<SupportedLocale>; export function useTrustLocale(): SupportedLocale;
  export function formatTrustDate(iso: string, locale: SupportedLocale): string;   // Intl date, never 'en-US' literal
  ```
- Create stubs (each `export default function X(_: TrustSectionViewProps) { return null; }`, with `TrustSectionViewProps = { payload: TrustPagePublicPayload; lastEvaluatedAt: string | null; preview: boolean; partnerSlug: string | null; orgSlug: string | null }` exported from `trustCopy.ts`):
  - `TrustDeclaredControls.tsx` (W02b)
  - `TrustFrameworkView.tsx` (W02e)
  - `TrustSubprocessors.tsx`, `TrustFaq.tsx`, `TrustHistory.tsx` (W02f)
- Create: `TrustDocumentsList.tsx`, extracted verbatim from `TrustPageView.tsx` (W02d then owns it). It renders `gated` entries as title plus a muted "Available on request" with no link.
- Modify: `TrustPageView.tsx`:
  - Normalize the fetched payload with `normalizeTrustPagePayload`.
  - Wrap the article in `TrustLocaleContext.Provider value={payload.locale}`.
  - Order: header, intro, controls, `<TrustDeclaredControls/>`, `<TrustFrameworkView/>`, method, `<TrustDocumentsList/>`, `<TrustSubprocessors/>`, `<TrustFaq/>`, `<TrustHistory/>`, managed-by, footer.
  - Strings stay English (W02h).
- Modify: `apps/portal/src/lib/api.ts`. The `TrustPageResponse.payload` type becomes `TrustPagePublicPayloadAny`.
- Modify: `apps/portal/src/middleware.ts`. Before the `/trust/` branch, add: `pathname.startsWith('/trust/access/')` → `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow, noarchive`, `Referrer-Policy: no-referrer`.
- Modify: `apps/docs/src/content/docs/security/trust-center.mdx` (the five anchor comments, after "## Framework references").

- [ ] **Step 1: Failing tests:**
  - `trustCopy.test.ts`: an unknown locale gets the `en` value, and `copyParityProblems` flags a missing key.
  - `TrustPageView.test.tsx`: a v1 payload renders (normalized), and the section stubs are rendered in order (assert via a mocked `TrustFaq` that captures props).
  - `middleware.test.ts` (or the existing trust middleware test): `/trust/access/verify` → `no-store` + `no-referrer`.
- [ ] **Step 2: Run, expect FAIL** — `cd apps/portal && npx vitest run src/components/trust src/middleware`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS** + `cd apps/portal && npx astro check` (the 7 pre-existing `*Form.tsx` errors only).
- [ ] **Step 5: Commit** — `feat(portal): trust page v2 normalization, locale copy mechanism, section seams, access-page headers`

### Task 8: W02a verification sweep

- [ ] `pnpm --filter @breeze/api test` (FULL unit; catches `orgMerge.test.ts` and the worker/registry contracts). With the test stack up, run every integration suite from Task 3 plus `trustPagePublication.integration.test.ts`, then `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` and `pnpm db:check-drift`.
- [ ] `cd packages/shared && npx vitest run && npx tsc --noEmit`; `cd apps/portal && npx vitest run && npx astro check`; `cd apps/web && npx vitest run`, plus the web typecheck. API typecheck: `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p apps/api`, then check `$?`.
- [ ] Existing E2E: `cd e2e-tests && npx playwright test tests/trust-center.spec.ts` against `pnpm wt-stack up` → PASS (W1 flow unchanged).
- [ ] `pnpm test-stack down`, `pnpm wt-stack down`; report what is left running.
- [ ] Open the PR (`Part of #8770`). The body names the merge door (two-way except the migration), the blast radius (trust page tables, publish/refresh path, public routes) and the settings rule-9 statement (below). Run one independent review round (opus, tenancy). After merge, notify the controller that W02b–W02i may start.

**Settings rule 9 for W02a** (repeated in W02g's PR):
- *Intro, visibility toggles, hidden controls, framework view, history toggle.* Home: Organization record → Trust Center tab. Level: org override. Resolver: `resolveEffectiveTrustSettings`. Snapshot: `published_config` at publish. Count of places per level, before → after: 1 → 1. The partner default level is added by W02g.
- *NDA text and "create a ticket per request".* Home: the same tab. Level: org only. Resolver: none. Count 0 → 1.
- *`BREEZE_TRUST_CIS_FRAMEWORK_VIEW`.* Home: server environment. Level: deployment. Count 0 → 1 (W02e).

---

## W02b — Declared controls (opus, parallel after W02a)

**Branch:** `feature/8768-trust-center/wave-8770-b`. **Owns / must not touch:** see the table. Tables come from W02a; this sub-wave writes no migration.

### Task 1: Validators and declaration service

**Files:** Modify `packages/shared/src/validators/trustCenterDeclarations.ts` (+ create `.test.ts`). Modify `apps/api/src/services/trustPage/declarations.ts` (create) + `declarations.test.ts`.

**Interfaces (Produces):**
```ts
// shared
export const trustDeclarationCreateSchema = z.strictObject({
  controlId: z.enum(DECLARED_CONTROL_IDS), statement: z.string().trim().min(10).max(1000),
  evidenceDocumentId: z.string().guid().nullable(), expectedRevision: z.number().int().min(0),
});
export const trustDeclarationWithdrawSchema = z.strictObject({ expectedRevision: z.number().int().min(0) });
// api
export async function declareTrustControl(a: { page: TrustPageRow; controlId: DeclaredControlId; statement: string; evidenceDocumentId: string | null;
  actorUserId: string; partnerName: string; expectedRevision: number; now?: Date }): Promise<{ declaration: TrustPageDeclarationRow; superseded: string | null; publicationRevision: number }>;
export async function withdrawTrustDeclaration(a: { page: TrustPageRow; declarationId: string; actorUserId: string; expectedRevision: number }): Promise<{ publicationRevision: number }>;
export async function listTrustDeclarations(page: TrustPageRow): Promise<{ active: TrustPageDeclarationRow[]; history: TrustPageDeclarationRow[] }>;  // history: latest 50 non-active
```
Both write paths run inside `withTrustPageRevision`.
- **Re-declare:** `SELECT … FOR UPDATE` the active row for `(page, control)`. Stamp its `superseded_at` **before** inserting the new row, so the partial unique index holds. `expires_at = declared_at + 365 days` exactly, with both computed from one `now`.
- **Evidence document:** must be an org document of the same org, not deleted and not superseded (422 `EVIDENCE_UNAVAILABLE` otherwise). Copy its `sha256` into `evidence_document_sha256`.

- [ ] **Step 1: Failing tests** (`declarations.test.ts`, db mocked; plus a new real-DB file `src/__tests__/integration/trustPageDeclarations.integration.test.ts`, which re-declares twice and asserts exactly one active row and both `superseded_at` stamps; W02a's `trustPagesSchema.integration.test.ts` stays untouched):
  - A first declaration → `expires_at − declared_at === 365 days`.
  - A re-declaration supersedes the previous row (`superseded_at` set before the insert) and returns `superseded`.
  - Withdrawing an already-withdrawn id → 404.
  - Stale revision → 409.
  - A superseded evidence document → 422.
  - A statement of 9 chars → a validator error.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/trustPage/declarations.test.ts` → FAIL. **Step 3: Implement.** **Step 4:** PASS (+ `cd packages/shared && npx vitest run src/validators/trustCenterDeclarations.test.ts`).
- [ ] **Step 5: Commit** — `feat(api): trust page declarations service (365-day expiry, supersede-then-insert, withdraw)`

### Task 2: Routes

**Files:** `apps/api/src/routes/trustPageDeclarations.ts` (+ `.test.ts`).

Routes (mounted at `/orgs`):
- `GET /:orgId/trust-page/declarations` — `requireScope('partner','system')` + `organizations:read`. Returns `{ catalog: DECLARED_CONTROL_CATALOG, active, history, publishedDeclarationIds: string[] }`.
- `POST /:orgId/trust-page/declarations` — `organizations:write` + `requireMfa()`.
- `POST /:orgId/trust-page/declarations/:declarationId/withdraw` — `organizations:write` + `requireMfa()`.

Reuse W1's `resolveAccessibleOrg` behaviour: copy the 8-line lookup, or import it if W02a exported it from `routes/trustPage.ts`; do not edit that file. Audit `trust_page.declaration.declare|redeclare|withdraw` with `{ controlId, declarationId, publicationRevision }`.

- [ ] Tests first:
  - An inaccessible org → 404.
  - A read-only user gets 403 on POST.
  - No MFA → 403.
  - Success returns the new revision and writes one audit row.
  - Withdraw with a stale revision → 409.
  - Run `cd apps/api && npx vitest run src/routes/trustPageDeclarations.test.ts` FAIL → implement → PASS.
- [ ] Commit — `feat(api): declared-control routes (MFA, audited)`

### Task 3: Section build and freeze

**Files:** `apps/api/src/services/trustPage/sections/declarations.ts` (+ `.test.ts`).

- **`freezeDeclarationIds(ctx)`:** active rows (not superseded, not withdrawn, `expires_at > asOf`), in declared-catalog order.
- **`buildDeclaredControls(ctx)`:**
  - Loads rows `WHERE id IN config.declarationIds AND trust_page_id = page.id`.
  - Drops withdrawn rows; superseded rows stay until a republish (Open Decision 5).
  - `status = expires_at > asOf ? 'current' : 'expired'`.
  - `declaredBy = declared_by_partner_name`.
  - `evidenceDocumentId` only when that id is in `ctx.documents`.
  - Copies `frameworkRefs` from the declared catalog.
  - Order: declared catalog order.

- [ ] Tests first:
  - A frozen id expiring at `asOf − 1ms` → `expired`, and at `asOf + 1ms` → `current` (Review Focus 4).
  - A withdrawn frozen id is omitted.
  - An evidence document not on the page → `null`.
  - A superseded frozen id still renders.
  - An unknown id (deleted by cascade) is skipped without a throw.
  - Run `cd apps/api && npx vitest run src/services/trustPage/sections/declarations.test.ts` FAIL → implement → PASS. Then `trustPagePublicPayload.contract.test.ts` → PASS.
- [ ] Commit — `feat(api): declared controls in the trust page payload (frozen ids, live expiry/withdrawal)`

### Task 4: Reminders (worker hook) and email

**Files:**
- `apps/api/src/services/trustPage/declarationReminders.ts` (+ `.test.ts`), `declarationReminderEmail.ts` (+ `.test.ts`)
- `apps/api/src/services/emailDomains/mailPurposes.ts` (anchor A1: `'staff.trust_declaration_reminder': { lane: 'platform' },`) and `mailPurposes.test.ts` (same anchor in the pinned object)

`runDeclarationReminders(now)` runs in a system context:
- It selects active declarations with `expires_at <= now + 30 days`, `expires_at > now` and `reminder_sent_at IS NULL`, limit 200, using the reminder index.
- It claims each row with `UPDATE … SET reminder_sent_at = now WHERE id = $1 AND reminder_sent_at IS NULL RETURNING id`, which is at-most-once (Open Decision 3).
- It resolves recipients with `resolveUsersWithPermissionForOrg(orgId, PERMISSIONS.ORGS_WRITE)` and creates `createNotification({ userId, orgId, type: 'system', title: 'A declared control expires soon', message: '<control title> on <org name>’s trust page expires on <date>. Re-declare it and republish.', link: '/organizations/<orgId>#trust', priority: 'normal', dedupeKey: 'trust-declaration-reminder:<id>' })` for each one.
- It emails each recipient through `getEmailService()?.sendEmail({ purpose: 'staff.trust_declaration_reminder', to, subject, html, text })`, with the template built in `declarationReminderEmail.ts` from `renderLayout`/`renderButton`.
- It returns `{ reminded }`.

- [ ] Tests first:
  - A row 29 days out is reminded once, and a second run reminds 0.
  - A row 31 days out → 0.
  - Expired and withdrawn rows → 0.
  - An email failure does not throw and the notification is still created.
  - `mailPurposes.callSites.test.ts` passes (the send site is the literal `'staff.trust_declaration_reminder'`).
  - Run `cd apps/api && npx vitest run src/services/trustPage/declarationReminders.test.ts src/services/trustPage/declarationReminderEmail.test.ts src/services/emailDomains` FAIL → implement → PASS.
- [ ] Commit — `feat(api): 30-day re-declare reminders (in-app + email) from the hourly trust sweep`

### Task 5: Web section

**Files:** `apps/web/src/components/trustCenter/TrustDeclarationsSection.tsx` (+ `.test.tsx`), `apps/web/src/lib/api/trustPageDeclarations.ts` (+ `.test.ts`), the 8 `organizations.json` (anchor: after `"declarations": {`).

Behaviour:
- A list of the 8 declared catalog controls (titles via `useTrustControlCopy`), each showing one of:
  - Not declared, with a **Declare** button.
  - Current: statement, "Declared by <partner> on <date> · expires <date>", and a "**Expires in N days**" warning badge when ≤ 30 days.
  - Expired.
- An "On the public page" marker when the id is in `publishedDeclarationIds`, and "Changes appear after you publish again" when the draft differs.
- The **Declare / Re-declare** dialog: statement textarea (10–1000), an optional evidence document picker (the org library), and a required checkbox "I confirm this statement is accurate and I am authorized to make it on behalf of <partner>".
- **Withdraw** with a confirm.

Every mutation goes through `runAction` with the 401/`ActionError` catch pattern and sends `expectedRevision: state.page.publicationRevision`; it calls `onReload` afterwards. A 409 shows the "reload" toast. Every control has a `data-testid` (`trust-declare-<id>`, `trust-declaration-<id>-status`).

- [ ] Tests first:
  - The confirm checkbox gates the submit.
  - The expiry badge appears at 30 days and not at 31.
  - Read-only users (`canWrite=false`) see no buttons.
  - A 409 calls `onReload`.
  - Run `cd apps/web && npx vitest run src/components/trustCenter/TrustDeclarationsSection.test.tsx src/lib/api/trustPageDeclarations.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts` FAIL → implement → PASS.
- [ ] Commit — `feat(web): declared controls section (declare, re-declare, withdraw, expiry badges)`

### Task 6: Portal rendering + docs

**Files:** `apps/portal/src/components/trust/TrustDeclaredControls.tsx` (+ `.test.tsx`, + `declaredCopy.ts` via `defineTrustCopy`, 8 locales), docs (anchor `W02b`).

Renders nothing when `declaredControls` is empty. Otherwise it renders a heading "Declared by the provider" and one row per control with:
- the title (W02h's shared copy when present, else the catalog English via a local fallback);
- the statement as **plain text** (never HTML);
- the label "Declared by {declaredBy} on {date}";
- a **distinct** "Declared" marker (outlined, never the telemetry pill);
- for expired rows, a muted "Declaration expired on {date}";
- framework chips.

`data-testid="trust-declared-<id>"`.

- [ ] Tests first:
  - An expired control gets the muted copy and no "current" marker.
  - The statement `<b>x</b>` renders literally.
  - Copy parity: `copyParityProblems(declaredCopy)` is `[]`.
  - Run `cd apps/portal && npx vitest run src/components/trust` FAIL → implement → PASS.
- [ ] Commit — `feat(portal): declared controls on the public trust page`
- [ ] **Sweep:** `pnpm --filter @breeze/api test` (full) + `cd apps/web && npx vitest run` + `cd apps/portal && npx vitest run`, plus typechecks. Then the PR (`Part of #8770`) and one review round (opus).

---

## W02c — MFA enforcement control (sonnet, parallel after W02a)

**Branch:** `feature/8768-trust-center/wave-8770-c`. Owns only the two files below plus tests and the catalog copy review.

### Task 1: Pure CA-policy evaluator

**Files:** Create `apps/api/src/services/m365CaMfaEnforcement.ts`, `m365CaMfaEnforcement.test.ts`.

**Interfaces:**
```ts
export const CA_MAX_EXCLUDED_USERS = 5;   // emergency-access (break-glass) accounts
export const CA_MAX_EXCLUDED_GROUPS = 1;
export function caPolicyEnforcesMfaForAllUsers(p: { state: string | null; isStale: boolean; conditions: unknown; grantControls: unknown }): boolean;
```

The function is true iff all of the following hold:
- `state === 'enabled'` (not `enabledForReportingButNotEnforced`) and not `isStale`.
- `conditions.users.includeUsers` contains `'All'`.
- `excludeUsers.length <= 5`, `excludeGroups.length <= 1` and `excludeRoles` is empty.
- `conditions.applications.includeApplications` contains `'All'`.
- `conditions.clientAppTypes` is absent, empty or contains `'all'`.
- MFA is required, meaning one of:
  - `grantControls.authenticationStrength` is non-null;
  - `grantControls.builtInControls` includes `'mfa'` and either `operator === 'AND'` or `mfa` is the only built-in control (an `OR` with `compliantDevice` is **not** enforcement).

Unknown JSON shapes → false. The function never throws. The implementer confirms field names against `services/m365Sync/domains/caPolicies.ts` and the Graph `conditionalAccessPolicy` resource.

- [ ] **Step 1: Failing table-driven tests** — one per rule above, plus each negative: a report-only state, stale, an included group only, 6 excluded users, an `OR` with `compliantDevice`, the `authenticationStrength` path, and malformed JSON (`'x'`, `null`, arrays).
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/m365CaMfaEnforcement.test.ts` FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit — `feat(api): Conditional Access MFA-enforcement evaluator`

### Task 2: Evidence reader in `loadTrustOnlyEvidence`

**Files:** `apps/api/src/services/trustPage/trustOnlyEvidence.ts` (+ `.test.ts`).

`loadTrustOnlyEvidence(orgId, asOf, policy)` returns `{ mfa_enforced_m365: ControlEvidence }`. It runs in the caller's DB context.
- It reads `m365_sync_state` for `domain = 'ca_policies'`. When there is no row, or `lastCompleteSnapshotAt` is null or older than `policy.maxSecurityStatusAgeDays`, the result is `{ eligible: 0, assessed: 0, passing: 0, aggregatePct: null, newestEvidenceAt: null }`, which evaluates to `not_assessed / no_data`.
- It reads the org's `m365_ca_policies` rows, non-stale only.
- Zero rows → `{ eligible: 1, assessed: 0, passing: 0, … }`. With the boolean metric this reads `not_assessed`, because no CA policies were synced (security defaults or per-user MFA are not read).
- Otherwise `eligible: 1, assessed: 1, passing: any(caPolicyEnforcesMfaForAllUsers) ? 1 : 0`, with `newestEvidenceAt = lastCompleteSnapshotAt`.

The implementer checks how `evaluateTrustControls` treats `boolean` with `assessed 0` and asserts the resulting reason in the test.

- [ ] Tests first:
  - A stale sync → not assessed.
  - Zero policies → not assessed.
  - One qualifying policy among three → met.
  - Only report-only policies → not met.
  - Run through `evaluateTrustControls` to assert the final status, not just the counts.
  - Run `cd apps/api && npx vitest run src/services/trustPage/trustOnlyEvidence.test.ts` FAIL → PASS.
- [ ] Integration: create `src/__tests__/integration/trustOnlyEvidence.integration.test.ts` (seed `m365_sync_state` + two policies, assert met) → `pnpm --filter @breeze/api test:integration src/__tests__/integration/trustOnlyEvidence.integration.test.ts`.
- [ ] Commit — `feat(api): mfa_enforced_m365 evidence on the trust page path (CA policies, sync freshness)`
- [ ] Sweep: `pnpm --filter @breeze/api test` (full) + typecheck; PR; one review round (sonnet).

---

## W02d — Gated documents and access requests (opus, parallel after W02a)

**Branch:** `feature/8768-trust-center/wave-8770-d`.

Flow: anonymous visitor → **Request access** (name, email, company, purpose, NDA checkbox when the page has NDA text) → verification email (magic link, fragment token) → visitor clicks **Confirm** (POST) → MSP users notified (in-app + email; optional ticket) → MSP approves (MFA) → requester emailed a 7-day link (fragment token) → download page lists the granted documents → each download is a POST that streams the file.

### Task 1: Validators and token service

**Files:** `packages/shared/src/validators/trustCenterAccess.ts` (+ test); `apps/api/src/services/trustPage/access/tokens.ts` (+ test).

**Interfaces:**
```ts
// shared
export const trustAccessRequestCreateSchema = z.strictObject({
  partnerSlug: trustSlugSchema, orgSlug: trustSlugSchema.nullable(),
  email: z.string().trim().toLowerCase().email().max(320), name: z.string().trim().min(2).max(200),
  company: z.string().trim().min(2).max(200), purpose: z.string().trim().min(10).max(2000), ndaAccepted: z.boolean(),
});
export const trustAccessTokenBodySchema = z.strictObject({ token: z.string().min(40).max(64) });
export const trustAccessDownloadSchema = trustAccessTokenBodySchema.extend({ documentId: z.string().guid() });
export const trustAccessDecisionSchema = z.strictObject({ note: z.string().trim().max(500).nullable().optional() });
export const TRUST_ACCESS_VERIFY_TTL_HOURS = 24; export const TRUST_ACCESS_GRANT_TTL_DAYS = 7;
// api
export function hashAccessToken(raw: string): string;                         // sha256 hex
export async function mintAccessToken(tx: DbTx, a: { requestId: string; orgId: string; purpose: 'verify_email' | 'download'; ttlMs: number }): Promise<string>;  // returns raw; revokes prior unrevoked tokens of the same purpose for the request
export async function findLiveToken(raw: string, purpose: 'verify_email' | 'download', now: Date): Promise<TrustPageAccessTokenRow | null>;  // system ctx; null when unknown/expired/revoked/consumed(verify)
```

- [ ] Tests first:
  - The raw token is 48 chars and its hash is 64 hex.
  - Minting a second verify token revokes the first.
  - `findLiveToken` returns null for each of expired, revoked, consumed and wrong purpose.
  - Run `cd apps/api && npx vitest run src/services/trustPage/access/tokens.test.ts` FAIL → PASS.
- [ ] Commit — `feat(api): trust access tokens (hashed, purpose-bound, single live token per purpose)`

### Task 2: Request lifecycle service

**Files:** `apps/api/src/services/trustPage/access/requests.ts` (+ test), `access/emails.ts` (+ test), `mailPurposes.ts`/`mailPurposes.test.ts` (anchors A2: `'staff.trust_access_request': { lane: 'platform' },`; A3: `'trust.access_verification'`, `'trust.access_granted'`, `'trust.access_denied'`, each `{ lane: 'partner', stream: 'support', fallbackFrom: 'partner_display_name' }`; and add the three to the test's "company name" list).

**Interfaces:**
```ts
export async function createAccessRequest(input: TrustAccessRequestCreate, resolved: ResolvedTrustPage, payload: TrustPagePublicPayload, now: Date): Promise<void>;
// system ctx. No-op (still 202 at the route) when the payload has no gated document, or ndaText present and !ndaAccepted.
// nda_text_accepted = payload.access.ndaText (server-side, never from the client), sha256 of it, snapshot_id = payload.snapshotId.
// Inserts status pending_verification, mints verify token, emails `${portal}/trust/access/verify#<raw>`.
export async function verifyAccessRequest(raw: string, now: Date): Promise<{ orgName: string } | null>;
// ONE transaction: SELECT token FOR UPDATE … consumed_at IS NULL; request FOR UPDATE status = 'pending_verification';
// set consumed_at, email_verified_at, status pending_approval; after commit: notify MSP (in-app type 'approval',
// dedupeKey 'trust-access:<id>', link '/organizations/<orgId>#trust'; email purpose 'staff.trust_access_request');
// when trust_pages.access_request_creates_ticket: createTicket(...) after commit, failure logged, ticket id in the audit details.
export async function approveAccessRequest(a: { requestId: string; orgId: string; actorUserId: string; note: string | null; now: Date }): Promise<void>;
// request FOR UPDATE status = pending_approval; granted_document_ids = gated docs of the CURRENT snapshot payload ∩ live gated links (≥1 else 422 NO_GATED_DOCUMENTS);
// grant_expires_at = now + 7 d; mint download token (7 d); email `${portal}/trust/access/download#<raw>`.
export async function denyAccessRequest(...), revokeAccessGrant(...), resendAccessGrant(...);   // revoke: status revoked + revoke tokens; resend: mint new download token (old revoked), same grant_expires_at
export async function readGrant(raw: string, now: Date): Promise<GrantView | null>;
export async function openGrantedDocument(raw: string, documentId: string, now: Date): Promise<OpenedDocument | null>;
```

`openGrantedDocument` returns non-null only when every one of these holds (codex's checklist):
- The token's purpose is `download`, and it is unrevoked and unexpired.
- The request is `approved`, `email_verified_at` is set and `grant_expires_at > now`.
- `documentId ∈ granted_document_ids`.
- The page is still published, passes the live predicate (`livePublicationPredicate`) and the partner is trusted.
- The current payload lists the document as `gated` (frozen).
- A live link exists with disclosure confirmed, and the document is not deleted and not superseded.

On success it increments `download_count`, stamps `last_downloaded_at` and writes audit `trust_page.access.download` (`actorEmail` = requester).

- [ ] Tests first (db and email mocked, plus one real-DB case in a new `src/__tests__/integration/trustAccessRequests.integration.test.ts`):
  - The NDA text stored equals the payload's, even when the client sent other text.
  - Verifying the same token twice → the second is `null`, and the notification is created once.
  - Approve racing revoke ends in exactly one terminal state (integration, two concurrent calls).
  - Each failing condition of `openGrantedDocument` returns `null` individually (one test per condition).
  - Expiry at `grant_expires_at` exactly → `null`.
- [ ] `cd apps/api && npx vitest run src/services/trustPage/access src/services/emailDomains` FAIL → implement → PASS; then `pnpm --filter @breeze/api test:integration src/__tests__/integration/trustAccessRequests.integration.test.ts`.
- [ ] Commit — `feat(api): gated-document access requests — verify, approve (frozen grant), deny, revoke, resend`

### Task 3: Public routes `/api/v1/trust/access/*`

**Files:** `apps/api/src/routes/trustAccessPublic.ts` (+ `.test.ts`).

| Method | Path | Limits (before any DB context) | Response |
|---|---|---|---|
| POST | `/requests` | 5/h per IP, 3/day per `sha256(email)`, 30/day per page key | always `202 { data: { accepted: true } }` when the body is valid and the page admits; the generic 404 when the page does not serve |
| POST | `/verify` | 10/min per IP | `200 { data: { orgName } }`, or the generic 404 |
| POST | `/grant` | 30/min per IP | `200 { data: GrantView }` (org name, expiry, documents: id/title/category/contentType/byteSize), or 404 |
| POST | `/download` | 20/min per IP | streams the attachment (W1 `documentRoute` headers: `attachment`, `no-store`, `nosniff`, `noindex`), or 404 |

Every response sets `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Validation failures return the generic 404, never a 400 body, so a malformed token is indistinguishable from an unknown one. Page admission reuses `parseTrustSlugs` + `resolvePublishedTrustPage` under `sys()`. Never log the raw token or the request body.

- [ ] Tests first:
  - A GET to any `/trust/access/*` path → generic 404 (no verify side effect: assert `verifyAccessRequest` never called).
  - A consumed token and an unknown token produce byte-identical bodies.
  - The 6th request/hour from one IP → 429.
  - The download response has `Content-Disposition: attachment`.
  - No handler reads `c.req.query()` or a path param for a token (static check in the test: `expect(source).not.toMatch(/req\.(query|param)\(['"]token/)`).
  - Run `cd apps/api && npx vitest run src/routes/trustAccessPublic.test.ts` FAIL → PASS.
- [ ] Commit — `feat(api): public gated-document endpoints (POST-only, fragment tokens, generic failures)`

### Task 4: MSP routes and access settings

**Files:** `apps/api/src/routes/trustPageAccess.ts` (+ test).

- `GET /orgs/:orgId/trust-page/access-requests?status=` — `organizations:read`. Returns requests newest first, limit 100. Each carries its expiry, computed from timestamps.
- `POST …/:requestId/approve` and `…/resend` — `organizations:write` + `requireMfa()`.
- `…/deny` and `…/revoke` — `organizations:write`.

Every action is audited (`trust_page.access.approve|deny|revoke|resend`). The NDA text and the ticket toggle are written through W02a's `PUT /trust-page` (fields already in the schema), so this file adds no settings route.

- [ ] Tests first:
  - Approve without MFA → 403.
  - Approve a `pending_verification` request → 409 `INVALID_STATE`.
  - Approve when the page has no gated documents → 422.
  - Another org's request id → 404.
  - Run `cd apps/api && npx vitest run src/routes/trustPageAccess.test.ts` FAIL → PASS.
- [ ] Commit — `feat(api): MSP access-request routes (approve with MFA, deny, revoke, resend)`

### Task 5: Payload access block and retention

**Files:** `sections/access.ts` (+ test), `access/retention.ts` (+ test).

- **`buildAccessBlock`** keeps the W02a stub semantics and normalizes `ndaText` (trim; empty → null).
- **`pruneTrustAccessData(now)`** runs in a system context:
  - Delete tokens with `expires_at < now − 30 days`.
  - Delete requests whose `updated_at < now − 365 days` (Open Decision 8) and that are **not** an approved grant with `grant_expires_at > now`.
  - Return the counts. The worker hook already calls it.
- [ ] Tests first:
  - A 366-day-old denied request is deleted, and its tokens cascade.
  - A live approved grant is kept regardless of age.
  - Run `cd apps/api && npx vitest run src/services/trustPage/sections/access.test.ts src/services/trustPage/access/retention.test.ts` FAIL → PASS.
- [ ] Commit — `feat(api): access block in the payload; access-request retention`

### Task 6: Web: gated visibility, NDA text, requests inbox

**Files:** `TrustDocumentsSection.tsx` (+ test), `TrustAccessSection.tsx` (+ test), `apps/web/src/lib/api/trustPageAccess.ts` (+ test), locale anchors `orgRecord.trust.documents` and `orgRecord.trust.access` (8 files).

**Documents section:**
- A per-link visibility select (Public / Available on request).
- The disclosure confirmation copy switches to "approved for release to approved requesters" for gated.
- Switching visibility re-requires the confirmation checkbox.
- It sends `expectedRevision`.

**Access section:**
- NDA clickwrap textarea (≤ 10,000 chars) and the "Create a ticket for each request" switch, saved with the page Save (rule 7).
- The requests table: status, requester, company, purpose, requested, expires.
- Actions: Approve (MFA step-up handled by `runAction`'s existing 403 MFA path), Deny with note, Revoke, Resend.
- A banner when the page has gated documents but is unpublished: "Requests open once the page is published".

`data-testid`s: `trust-doc-visibility-<id>`, `trust-access-row-<id>`, `trust-access-approve-<id>`, …

- [ ] Tests first:
  - Switching to gated without confirming disables Save.
  - Approve calls the API through `runAction` and reloads.
  - Read-only users see the table without actions.
  - Run `cd apps/web && npx vitest run src/components/trustCenter src/lib/api/trustPageAccess.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts` FAIL → PASS.
- [ ] Commit — `feat(web): gated documents, NDA clickwrap text, access-request inbox`

### Task 7: Portal: request form, verify and download pages

**Files:**
- `apps/portal/src/components/trust/TrustDocumentsList.tsx`
- `components/trust/access/RequestAccessForm.tsx`, `AccessVerifyView.tsx`, `AccessGrantView.tsx`, `accessCopy.ts` (8 locales)
- `apps/portal/src/lib/trustAccessApi.ts` (uses the exported `apiPost`)
- `pages/trust/access/verify.astro`, `pages/trust/access/download.astro` (TrustPageLayout, `noindex`, no SSR data)
- `apps/portal/src/lib/disabledPageCoverage.test.ts` (public allowlist: both pages)
- tests for each component

**Behaviour:**
- **Gated rows:** a **Request access** button (`data-testid="trust-request-access"`) opens the form inline. Fields carry `data-testid`s. The NDA box (the payload's `access.ndaText` rendered as preformatted plain text + a required checkbox) appears when `ndaText` is set. On submit it shows the generic "Check your email to confirm the request." whatever the response.
- **Verify page:** reads `location.hash` and **clears it with `history.replaceState`**. It shows **Confirm request** (`trust-access-confirm`); the POST happens on click only. Success: "Request confirmed. <org> will review it." Failure: the generic "This link is invalid or has expired."
- **Download page:** reads and clears the hash, then POSTs `/grant` and lists the documents. Each **Download** POSTs `/download` and saves the blob with the server's filename. It shows the expiry date.

- [ ] Tests first:
  - Verify does not POST on mount, only on click.
  - The hash is cleared before any request.
  - The NDA checkbox is required only when `ndaText` is set.
  - `disabledPageCoverage` passes.
  - Run `cd apps/portal && npx vitest run src/components/trust src/lib` FAIL → PASS; `npx astro check`.
- [ ] Commit — `feat(portal): request access, confirm and download pages for gated trust documents`

### Task 8: E2E and docs

**Files:** `e2e-tests/tests/trust-center-gated.spec.ts`, `e2e-tests/pages/TrustAccessPage.ts`, docs (anchor `W02d`).

The spec reuses the W1 spec's flow to publish the seeded org with one document linked as **gated** (upload one through the org library UI, or seed it with `psql` as `ai-script-proposals.spec.ts` does).
- An anonymous context opens the public page and requests access.
- The test then `psql`-replaces the verify token's `token_hash` with `sha256(KNOWN_RAW)` for that request, opens `/portal/trust/access/verify#KNOWN_RAW`, and clicks Confirm. It asserts `pending_approval` via `psql`.
- The admin approves in the editor.
- The test replaces the download token hash the same way, opens `/portal/trust/access/download#KNOWN_RAW2`, clicks Download and asserts the `download` event.
- After **Revoke**, the same link shows the invalid-link copy.

It asserts `page.url()` never carries the token outside the fragment.

- [ ] Run against `pnpm wt-stack up`: `cd e2e-tests && npx playwright test tests/trust-center-gated.spec.ts tests/trust-center.spec.ts` → PASS. Tear down, then the sweep (full API unit, web, portal, typechecks), the PR and one review round (opus).
- [ ] Commit — `test(e2e): gated trust document request → verify → approve → download → revoke`

---

## W02e — Framework view (sonnet, parallel after W02a)

**Branch:** `feature/8768-trust-center/wave-8770-e`.

### Task 1: Pure coverage summary

**Files:** `packages/shared/src/trustCenter/frameworkCoverage.ts` (replace the stub) + `.test.ts`.

```ts
export interface FrameworkSafeguardRow { ref: string; label: string; ig: 1 | 2 | 3 | null;
  controls: Array<{ id: string; source: 'telemetry' | 'declared'; status: string; counts: boolean }> }
export interface FrameworkCoverage { framework: TrustFramework; total: number; evidenced: number; verified: number; declaredOnly: number; safeguards: FrameworkSafeguardRow[] }
export function summarizeFrameworkCoverage(payload: TrustPagePublicPayload, framework: TrustFramework): FrameworkCoverage;
```

Rules (Open Decision 7):
- A telemetry control counts when `status !== 'not_assessed'`; a declared control counts when `status === 'current'`.
- `evidenced` = distinct refs with ≥1 counting control. `verified` = refs with ≥1 counting telemetry control. `declaredOnly = evidenced − verified`.
- `total = FRAMEWORK_META[framework].safeguardTotal`.
- `safeguards` lists every ref referenced by any shown control or declaration (counting or not), sorted naturally (`'5.4' < '10.1'`, `PR.AA-01 < PR.AA-03`).

- [ ] Tests first:
  - A fixture with `mfa_registered_m365` met (CIS 6.3, 6.5) and an expired `incident_response_plan` (17.1–17.3) → CIS `evidenced 2, verified 2, declaredOnly 0`, with 17.x listed but not counting.
  - A not-assessed control does not count.
  - Natural sort.
  - Totals 153 / 106 / 8 / 5.
  - Run `cd packages/shared && npx vitest run src/trustCenter/frameworkCoverage.test.ts` FAIL → PASS.
- [ ] Commit — `feat(shared): framework coverage summary (evidenced/verified/declared, natural ref order)`

### Task 2: CIS flag, frameworks section, options and suggestion

**Files:**
- `apps/api/src/config/env.ts`: `export function trustCisFrameworkViewEnabled(): boolean`, read at call time; `'true'|'1'|'on'|'yes'` enable it and anything else (incl. unset) means **false**.
- `env.trustCisFrameworkView.test.ts`
- `system/connections/internalEnvVars.ts`: entry with reason "Trust Center CIS v8 framework view rollout gate; set only after CIS licensing confirmation (spec §18.13)."
- `docker-compose.yml` `x-api-env` (+ the second compose file the coverage test checks): `BREEZE_TRUST_CIS_FRAMEWORK_VIEW: ${BREEZE_TRUST_CIS_FRAMEWORK_VIEW:-false}`
- `.env.example` (commented, default false, one-line reason)
- `apps/docs/.../deploy/environment.mdx` (one row)
- `apps/api/src/services/trustPage/sections/frameworks.ts` (+ test)

Behaviour:
- `defaultFrameworkView()` → `trustCisFrameworkViewEnabled() ? ['cis_v8'] : ['nist_csf_2']`.
- `resolveFrameworkView(sel)` → `sel` deduped, in `TRUST_FRAMEWORKS` order, with `cis_v8` dropped while the flag is off.
- `frameworkOptionsFor({ partnerCountry })`: `available` (CIS = the flag; others true) and `suggested` (`AU` → essential_eight, `GB`/`UK` → cyber_essentials, case-insensitive).

- [ ] Tests first:
  - Flag unset → default `['nist_csf_2']` and CIS unavailable.
  - Flag `true` → `['cis_v8']`.
  - `resolveFrameworkView(['cis_v8','nist_csf_2'])` with the flag off → `['nist_csf_2']`.
  - `AU` suggests E8.
  - `envReadComposeCoverage.test.ts` and `envComposeParity.test.ts` pass.
  - Run `cd apps/api && npx vitest run src/config/env.trustCisFrameworkView.test.ts src/config/envReadComposeCoverage.test.ts src/config/envComposeParity.test.ts src/services/trustPage/sections/frameworks.test.ts` FAIL → PASS.
- [ ] Commit — `feat(api): CIS framework-view env gate (default off), framework resolution and country suggestion`

### Task 3: Portal framework view

**Files:** `apps/portal/src/components/trust/TrustFrameworkView.tsx` (+ test, `frameworkCopy.ts`).

Renders nothing when `payload.frameworks` is empty. Otherwise:
- One tab per framework (state in `location.hash`, `#framework-<id>`, per repo convention).
- The summary line "Evidence shown for {evidenced} of {total} safeguards ({verified} verified by Breeze telemetry · {declaredOnly} declared by the provider). This is not a statement of compliance."
- Safeguard rows: ref, Breeze label (W02h copy when present), IG tag for CIS, and the mapped controls with their pill or declared marker.
- The framework's attribution line.

`data-testid`: `trust-framework-view`, `trust-framework-tab-<id>`, `trust-framework-summary`.

- [ ] Tests first:
  - The summary numbers come from `summarizeFrameworkCoverage`.
  - "compliant" never appears (regex on the rendered text).
  - The tab hash is restored on mount.
  - Run `cd apps/portal && npx vitest run src/components/trust` FAIL → PASS.
- [ ] Commit — `feat(portal): framework view with evidenced/verified/declared counts`

### Task 4: Web framework picker

**Files:** `TrustFrameworksSection.tsx` (+ test), locale anchor `orgRecord.trust.frameworks` (8 files).

- One checkbox per framework from `state.frameworkOptions`.
- An unavailable CIS option is disabled with the hint "Available once CIS licensing is confirmed".
- A suggestion chip when `suggested`.
- **Use default** (sends `frameworkView: null`) and the inherited value with its source from `state.effective.sources.frameworkView`.
- Save through `updateTrustPage` (`runAction`, `expectedRevision`).

- [ ] Tests first: the CIS checkbox is disabled when unavailable; Save sends the selection; "Use default" sends null. Run `cd apps/web && npx vitest run src/components/trustCenter/TrustFrameworksSection.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts` FAIL → PASS.
- [ ] Commit — `feat(web): framework view picker (CIS gated, country suggestion, inherit)`

### Task 5: E2E and docs

**Files:** `e2e-tests/tests/trust-center-frameworks.spec.ts`, docs (anchor `W02e`, incl. "CIS v8 view requires `BREEZE_TRUST_CIS_FRAMEWORK_VIEW`; enabling it is an operator decision after CIS licensing confirmation").

The spec:
- Selects NIST CSF 2.0 + Essential Eight and asserts the CIS checkbox is disabled (the stack runs with the flag unset).
- Publishes, opens the public page anonymously and asserts `trust-framework-view` with two tabs.
- Asserts the summary contains "of 106" on the NIST tab and "of 8" on Essential Eight.

Run `cd e2e-tests && npx playwright test tests/trust-center-frameworks.spec.ts` (wt-stack), tear down, then the sweep, the PR and one review round (sonnet).
- [ ] Commit — `test(e2e): framework view selection and public rendering`

---

## W02f — Subprocessors, FAQ, history (sonnet, parallel after W02a)

**Branch:** `feature/8768-trust-center/wave-8770-f`.

### Task 1: Validators, routes and subprocessor suggestions

**Files:**
- `packages/shared/src/validators/trustCenterContent.ts` (+ test):
  - `trustSubprocessorsPutSchema = { expectedRevision, subprocessors: ≤50 × { name, purpose, location|null, websiteUrl https|null, source, sourceKey|null } }`
  - `trustFaqPutSchema = { expectedRevision, items: ≤30 × { question 5..300, answerHtml ≤2000 raw } }`
- `apps/api/src/routes/trustPageContent.ts` (+ test): `GET/PUT /orgs/:orgId/trust-page/subprocessors`, `GET /…/subprocessors/suggestions`, `GET/PUT /…/faq`. The PUTs are replace-all inside `withTrustPageRevision`; FAQ answers go through `sanitizeFlowRichTextHtml` and a stored length ≤ 16,000 (else 422 `ANSWER_TOO_LONG`); the routes are audited.
- `apps/api/src/services/trustPage/subprocessorSuggestions.ts` (+ test): `suggestSubprocessors(orgId, asOf): Promise<Suggestion[]>`. It draws on `loadPostureEvidence(...).report.productEvidence` (EDR/AV/MDR/DNS → purpose "Endpoint security" / "DNS filtering", backup → "Backup") and an active `m365_connections` row (→ "Microsoft 365 — identity and productivity"). It dedupes by `sourceKey = '<source>:<lowercased name>'` and excludes keys already on the page.

- [ ] Tests first:
  - Replace-all with a stale revision → 409.
  - 51 subprocessors → validator error.
  - An `http://` website → error.
  - The FAQ answer `<script>` is stripped in the stored value.
  - Suggestions never return a key already saved.
  - Run `cd apps/api && npx vitest run src/routes/trustPageContent.test.ts src/services/trustPage/subprocessorSuggestions.test.ts` + `cd packages/shared && npx vitest run src/validators/trustCenterContent.test.ts` FAIL → PASS.
- [ ] Commit — `feat(api): trust page subprocessors (prefill suggestions) and FAQ routes`

### Task 2: Sections: freeze and build for subprocessors and FAQ; history

**Files:** `sections/subprocessors.ts`, `sections/faq.ts`, `sections/history.ts` (+ tests).

- **Freeze:** read the rows in `sort_order` and copy the content.
- **Build:** map `config` → payload. Websites are re-validated as https (else null). FAQ answers are re-sanitized (the builder never trusts stored HTML; W1 Ruling 10 pattern), and an answer over the cap is dropped with a warn rather than throwing.
- **`buildHistory(ctx)`:**
  - `[]` unless `config.showHistory`.
  - Otherwise `SELECT generated_at, (payload->'summary'->>'controlsMet')::int, (payload->'summary'->>'controlsShown')::int FROM trust_page_snapshots WHERE trust_page_id = $1 ORDER BY generated_at`.
  - Keep the points with `generated_at >= asOf − 90 d`, plus the newest one before the window as a baseline.
  - Collapse consecutive equal `(met, shown)` pairs, keeping the first.
  - Cap at 200, keeping the newest.
  - The snapshot being built is not in the table yet, so it is excluded by construction.
- [ ] Tests first:
  - The history baseline is kept and older points are dropped.
  - Consecutive duplicates collapse.
  - `showHistory: false` → `[]`.
  - A hostile FAQ answer in the frozen config is re-sanitized.
  - Payload hash equal with differing history (W02a rule, re-asserted).
  - Run `cd apps/api && npx vitest run src/services/trustPage/sections` FAIL → PASS; the contract test → PASS.
- [ ] Commit — `feat(api): subprocessors, FAQ and 90-day history in the trust page payload`

### Task 3: Web sections

**Files:** `TrustSubprocessorsSection.tsx`, `TrustFaqSection.tsx`, `TrustHistorySection.tsx` (+ tests), `apps/web/src/lib/api/trustPageContent.ts` (+ test), locale anchors `orgRecord.trust.{subprocessors,faq,history}`.

- **Subprocessors:** an editable list with an **Add from detected tools** menu (suggestions), manual add, reorder and remove; one Save (rule 7).
- **FAQ:** question + `RichTextEditor` (flow subset, the existing component) per item, reorder, Save.
- **History:** the "Show controls met over time" switch (autosave with a toast, rule 7; `PUT /trust-page { showHistory }`) and the inherited value/source.

- [ ] Tests first: Save sends `expectedRevision`; a suggestion click appends a row with its `sourceKey`; the history switch shows the source badge. Run `cd apps/web && npx vitest run src/components/trustCenter src/lib/api/trustPageContent.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts` FAIL → PASS.
- [ ] Commit — `feat(web): subprocessors, FAQ and history sections`

### Task 4: Portal rendering + docs

**Files:** `TrustSubprocessors.tsx`, `TrustFaq.tsx`, `TrustHistory.tsx` (+ tests, `contentCopy.ts` 8 locales), docs (anchor `W02f`).

- **Subprocessors:** a table (name, purpose, location, website).
- **FAQ:** `<details>` per item, answer via `dangerouslySetInnerHTML` (sanitized server-side twice; same contract as `introHtml`).
- **History:** an inline SVG step chart built only from SVG attributes (no `style=`). Its points are `payload.history` plus `{ at: lastEvaluatedAt, met: summary.controlsMet, shown: summary.controlsShown }`, clamped to the last 90 days. The caption reads "Controls met over the last 90 days. Each change is recorded when Breeze re-evaluates the page." (Open Decision 1 copy). `data-testid="trust-history"`.

- [ ] Tests first: history renders the appended current point; the empty `history` with `showHistory` off renders nothing; FAQ answers render sanitized HTML; no `style` attribute anywhere (`container.querySelectorAll('[style]').length === 0`). Run `cd apps/portal && npx vitest run src/components/trust` FAIL → PASS; `npx astro check`.
- [ ] Commit — `feat(portal): subprocessors, FAQ and controls-met history on the public trust page`
- [ ] Sweep, PR, one review round (sonnet).

---

## W02g — Partner-wide template (opus, parallel after W02a)

**Branch:** `feature/8768-trust-center/wave-8770-g`.

### Task 1: Migration `2026-12-30-100500-trust-page-templates.sql` + Drizzle

The header comment copies the `work_types` reasoning: shape 3, no `org_id`, registration only in `PARTNER_TENANT_TABLES`, partner erasure by the `partner_id` sweep. `partner_id NOT NULL` is the product owner's decision (spec §18.8, this plan's amendment 33): a template is the partner's own default, never an org-owned policy, and there is no org-XOR-partner shape to choose.
- `trust_page_templates`:
  - `id uuid pk`, `partner_id uuid NOT NULL UNIQUE REFERENCES partners(id)` (no ON DELETE)
  - `intro_html text NULL CHECK (intro_html IS NULL OR length(intro_html) <= 40000)`
  - `search_indexable`, `show_percentages`, `show_device_count`, `show_managed_by`, `show_history` boolean NULL
  - `hidden_control_ids text[] NULL`, `framework_view text[] NULL`
  - `revision integer NOT NULL DEFAULT 0`
  - `updated_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL`
  - `created_at`, `updated_at`
- RLS: `ENABLE` + `FORCE`, then one policy `trust_page_templates_partner_access FOR ALL TO breeze_app USING (breeze_current_scope() = 'system' OR breeze_has_partner_access(partner_id)) WITH CHECK (same)` (pg_policies existence check). `GRANT SELECT, INSERT, UPDATE, DELETE ON trust_page_templates TO breeze_app`. DDL only, so no scope election.
- Drizzle: `apps/api/src/db/schema/trustPageTemplates.ts` + one `export * from './trustPageTemplates';` line in `db/schema/index.ts`.
- `rls-coverage.integration.test.ts`: `PARTNER_TENANT_TABLES` gains `['trust_page_templates', 'partner_id']` with a comment like `work_types`'s. It must **not** go into `DUAL_AXIS_TENANT_TABLES` or `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`.
- Create: `src/__tests__/integration/trustPageTemplatesPartnerRls.integration.test.ts`:
  - A cross-partner forged insert as `breeze_app` → `42501`.
  - Partner A cannot read partner B's row.
  - The partner erasure path removes the row (`cascadeDeletePartner` on a seeded partner).
- [ ] Order: write the RLS test and the coverage entry → run `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` and the new integration test → FAIL → migration + Drizzle → `pnpm --filter @breeze/api db:migrate` twice, `pnpm db:check-drift`, both suites PASS.
- [ ] Commit — `feat(api): trust_page_templates (shape 3, partner-wide default, revision)`

### Task 2: Template service and routes

**Files:** `services/trustPage/template.ts` (replace the stub) + test, `validators/trustCenterTemplate.ts` (+ test), `routes/trustPageTemplate.ts` (+ test).

- **`loadPartnerTemplate(partnerId)`** reads under the caller's context; partner scope passes `breeze_has_partner_access`, and the system scope passes. It returns `{ settings, revision }` or null.
- **`GET /api/v1/trust-page-template`** is partner scope (system scope must pass `?partnerId=`). It returns `{ template: settings | null, revision, defaults: TRUST_BUILTIN_DEFAULTS + defaultFrameworkView() }`.
- **`PUT /api/v1/trust-page-template`:**
  - Requires `canManagePartnerWidePolicies(auth)` (403 `PARTNER_WIDE_REQUIRED`) + `requireMfa()`.
  - Body: `trustTemplateUpdateSchema` (each field nullable-optional, `introHtml` ≤ 5,000 raw → `sanitizeIntro`, `expectedRevision`).
  - Upserts with `revision + 1` and checks `expectedRevision` (409).
  - Audited as `trust_page_template.update`.
- [ ] Tests first:
  - A non-partner-wide user → 403.
  - A stale revision → 409.
  - A first PUT creates the row with revision 1.
  - An org-scoped token → 403 (scope).
  - Run `cd apps/api && npx vitest run src/routes/trustPageTemplate.test.ts src/services/trustPage/template.test.ts` FAIL → PASS.
- [ ] Commit — `feat(api): partner Trust Center template routes (partner-wide admin + MFA, revisioned)`

### Task 3: Publish template-revision check (end to end) and inheritance

**Files:** test-only additions in `apps/api/src/__tests__/integration/trustPageTemplateInheritance.integration.test.ts` (new).

1. Template `showManagedBy: false`, page null → the draft build has `managedBy: null`, and GET reports `effective.sources.showManagedBy === 'template'`.
2. The page explicitly `true` → the page wins.
3. Publish with `expectedTemplateRevision` = the GET value → 200. Change the template, then publish with the old value → 409 `TEMPLATE_CHANGED` (Review Focus 5).
4. After publish, changing the template does **not** change the next refresh (frozen).
- [ ] `pnpm --filter @breeze/api test:integration src/__tests__/integration/trustPageTemplateInheritance.integration.test.ts` → FAIL before Task 2 wiring is complete, PASS after. Commit — `test(api): template inheritance, frozen at publish, revision conflict`

### Task 4: Web: partner settings tab and editor inheritance controls

**Files:**
- `apps/web/src/components/settings/PartnerSettingsPage.tsx` (new `trustCenter` tab), plus whatever tab registry `settingsPageRegistry.test.ts` checks (grep it first)
- `apps/web/src/components/trustCenter/TrustTemplateSettings.tsx` (replace the stub) + test
- `apps/web/src/lib/api/trustPageTemplate.ts` (+ test)
- `apps/web/src/components/trustCenter/trustInheritance.ts` (`InheritanceBadge`, `resetToInherited(key)`) + test
- `TrustControlsSection.tsx`, `TrustContentSection.tsx`
- `settings.json` ×8 (anchor S1), `organizations.json` ×8 (anchor `orgRecord.trust.inheritance`)

**Behaviour:**
- **Template form** (page Save, rule 7): each field shows the Breeze default when blank (rule 4: "Blank = inherit; shows the inherited value and its source"), plus a framework picker identical to W02e's options (read from GET).
- **Editor:** each toggle and the intro show an `InheritanceBadge` ("Partner template" / "Breeze default" / "Set for this organization") and a **Reset to inherited** action that sends `null`. The intro offers "Use the partner template intro", "No intro" (sends `''`) and "Custom". The publish dialog sends `expectedTemplateRevision: state.template?.revision ?? null`.

- [ ] Tests first:
  - The badge reflects `effective.sources`.
  - Reset sends `null`.
  - "No intro" sends `''`.
  - Publish sends the template revision.
  - `settingsPageRegistry.test.ts` passes.
  - Run `cd apps/web && npx vitest run src/components/trustCenter src/components/settings src/lib/api/trustPageTemplate.test.ts src/lib/__tests__/settingsPageRegistry.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts` FAIL → PASS.
- [ ] Commit — `feat(web): partner Trust Center template tab; inheritance badges and reset in the editor`
- [ ] Docs (anchor `W02g`), sweep (full API unit + RLS coverage + the new integration suites), PR with the settings rule-9 statement:
  - *Intro and default visibility (+ frameworks, history).* Home: Settings → Partner → Trust Center (partner default) and Organization record → Trust Center (org override). Level: partner default → org override → frozen at publish. Resolver: `resolveEffectiveTrustSettings`. Places configured, before → after: 1 → 2, one per level (rule 1 holds per level).

  One review round (opus).

---

## W02h — Portal i18n (sonnet, parallel after W02a)

**Branch:** `feature/8768-trust-center/wave-8770-h`. **Approach (amendment 31):** typed copy modules, no runtime. TypeScript enforces key parity (`Record<SupportedLocale, T>` where `T` is inferred from `en`), and a test enforces non-English values.

### Task 1: Shared control copy (8 locales)

**Files:** `packages/shared/src/trustCenter/copy/{index.ts,en.ts,pt-BR.ts,es-419.ts,fr-FR.ts,fr-CA.ts,de-DE.ts,it-IT.ts,tr-TR.ts}` + `copy/copy.test.ts`.

```ts
export interface TrustCatalogCopy {
  controls: Record<TelemetryControlId | DeclaredControlId, { title: string; description: string }>;
  categories: Record<TrustControlCategory, string>;
  crosswalk: { [F in TrustFramework]: Record<string, string> };     // ref → Breeze label
  statuses: Record<TrustControlStatus | 'current' | 'expired', string>;
}
export function trustCopyFor(locale: string | null | undefined): TrustCatalogCopy;   // replaces the W02a stub; unknown → en
```
`en.ts` is generated from the catalogs and the crosswalk (`title`, `description`, `label`), so English stays single-sourced.

- [ ] Tests first:
  - Every locale has every control id, category, crosswalk ref and status.
  - No non-`en` value is empty.
  - For each non-`en` locale, ≥ 90% of strings differ from English (allowlist: product and framework proper nouns such as "Microsoft 365", "EDR", "CIS", "NIST").
  - The `en` copy equals the catalog strings.
  - Run `cd packages/shared && npx vitest run src/trustCenter/copy` FAIL → PASS + `npx tsc --noEmit`.
- [ ] Commit — `feat(shared): trust center control, category, crosswalk and status copy in 8 locales`

### Task 2: Portal page chrome and card

**Files:**
- portal `TrustPageView.tsx`, `trustPageFormat.ts` (category/reason/coverage-note/relative-time per locale), `TrustStatusPill.tsx`, `components/trust/copy/pageCopy.ts` (8 locales, every W1 string)
- `layouts/TrustPageLayout.astro` (`lang` prop on `<html>`, localized robots-independent strings)
- `pages/trust/[partnerSlug]/index.astro`, `[orgSlug].astro`, `preview/[token].astro` (title/description from card numbers + `pageCopy`)
- `lib/api.ts` (`TrustCard` gains `locale`, `controlsShown`, `catalogTotal`, `controlsMet`)
- API `routes/trustPagePublic.ts` card response (adds those four fields from the normalized payload; keeps `title`/`summaryLine` English for compatibility) + `trustPagePublic.test.ts`

Dates and numbers use `Intl` with the payload locale (`formatTrustDate`); the `'en-US'` literals are removed.

- [ ] Tests first:
  - A `de-DE` payload renders the German header summary, status pill and method block.
  - `<html lang="de-DE">`.
  - The card JSON has `locale`.
  - An unknown locale falls back to `en`.
  - No `'en-US'` literal remains in `components/trust` (static grep test).
  - `copyParityProblems(pageCopy)` is `[]`.
  - Run `cd apps/portal && npx vitest run src/components/trust src/layouts` + `cd apps/api && npx vitest run src/routes/trustPagePublic.test.ts` FAIL → PASS; `npx astro check`.
- [ ] Commit — `feat(portal): public trust page renders in the published locale (8 locales)`

### Task 3: Web editor control copy

**Files:** `apps/web/src/components/trustCenter/trustControlCopy.ts` (+ test). `useTrustControlCopy()` reads `i18n.resolvedLanguage` and returns `trustCopyFor(lang)` lookups.
- [ ] Tests first: `de-DE` returns the German title for `disk_encryption`. Run `cd apps/web && npx vitest run src/components/trustCenter` FAIL → PASS.
- [ ] Commit — `feat(web): Trust Center editor shows control copy in the user's language`
- [ ] Sweep, PR (with `pt-BR strings are machine-drafted pending native review`), one review round (sonnet).

---

## W02i — W1 carry-forwards (opus, parallel after W02a)

**Branch:** `feature/8768-trust-center/wave-8770-i`. These are the five W1 follow-ups from rulings 15, 26–28 and amendments 23–24.

### Task 1: Home-flag move rule (Ruling 28 residual)

**Files:** `apps/api/src/routes/trustPage.ts` (partner-home handler only) + `trustPage.test.ts`.

Inside the existing transaction, when `isPartnerHome` is true and a different page `prev` holds the flag: if `prev` is published and has no `publication_authorized_by`, roll back with 422 `PARTNER_HOME_UNPUBLISH_FIRST` and the message "The current partner home page is live without a recorded customer authorization. Unpublish it before moving the partner home." Otherwise clear `prev`'s flag **and bump its `publication_revision`** (an in-flight publish on it 409s).
- [ ] Tests first:
  - Moving the flag from a published unattested page → 422 and both flags unchanged.
  - From an attested or unpublished page → 200, and the previous page's revision +1.
  - Run `cd apps/api && npx vitest run src/routes/trustPage.test.ts` FAIL → PASS.
- [ ] Commit — `fix(api): moving the partner-home flag requires the previous home page unpublished or attested`

### Task 2: Serving-set self-heal sooner than hourly

**Files:** `apps/api/src/services/trustPage/servingSet.ts` + `servingSet.test.ts`.

Add `scheduleServingSetRebuild(reason: string): void`. `isServing` calls it whenever it returns `null` because the marker or the sentinel is missing; the Redis-down case does **not** call it.
- It is single-flight in process.
- It takes the cluster-wide lock `SET trust:serving:rebuild-lock 1 NX EX 60`; it calls `rebuildServingSetFromDb()` only if the lock was acquired.
- It runs fire-and-forget after the current request, outside any DB context (`runOutsideDbContext`).
- Errors are logged and never surface to the request.

The card route stays DB-free per request: at most one rebuild query per minute cluster-wide.
- [ ] Tests first:
  - Two `null`s in one tick → one rebuild.
  - Lock not acquired → no rebuild.
  - Redis error → no rebuild and `isServing` still returns `null`.
  - A rebuild failure is swallowed.
  - Run `cd apps/api && npx vitest run src/services/trustPage/servingSet.test.ts src/routes/trustPagePublic.test.ts` FAIL → PASS.
- [ ] Commit — `fix(api): trust serving set self-heals within a minute of eviction (locked, single-flight)`

### Task 3: Read-only AI tool `get_trust_page_status` (Ruling 15)

**Files:**
- `apps/api/src/services/aiToolsTrustPage.ts` (+ `aiToolsTrustPage.test.ts`)
- `services/aiTools.ts` (import + `registerTrustPageTools(...)` call, appended after the last register call)
- `services/aiAgentSdkTools.ts` (registration block appended **after the last existing block**, so no line keyed by `aiTools.userOwnedRelease.contract.test.ts` shifts)
- `mcpCoverage.ts`: `'trustPage.ts': { tools: ['get_trust_page_status'], note: 'Read-only status; publish/edit stay human-attested (customer authorization + MFA).' }`

Before editing, grep `"'query_audit_log'"` across `apps/api/src` and mirror every registry it appears in (tier, golden prompts, SDK list).

**Tool:**
- Tier 1, read-only. Input `{ orgId: string (guid) }`; no `z.undefined()` anywhere.
- Access check `auth.canAccessOrg(orgId)`, else a tool error.
- Reads in the caller's DB context and never creates a page.
- Output: `{ exists, published, publishedAt, publicPath, lastEvaluatedAt, stale, controls: { shown, met, catalogTotal } | null, declarations: { current, expiringWithin30Days }, accessRequests: { pendingApproval } }`. The control counts come from the current snapshot's `summary`; nothing device-level.
- Description ≤ 300 chars, param ≤ 160.

- [ ] Tests first:
  - An inaccessible org → error.
  - A never-created page → `exists: false` with no insert (assert no `insert` on the db mock).
  - A published page returns its counts.
  - Then the contract suites: `cd apps/api && npx vitest run src/services/aiToolsTrustPage.test.ts src/services/aiTools.descriptionBudget.contract.test.ts src/services/aiTools.userOwnedRelease.contract.test.ts src/services/aiTools.domainMetadata.contract.test.ts src/services/aiTools.outputBudget.contract.test.ts src/services/aiToolsActorParity.contract.test.ts src/services/mcp-coverage.test.ts` FAIL → PASS.
- [ ] Commit — `feat(api): get_trust_page_status read-only AI tool`

### Task 4: Portal dashboard "Public trust page" link (amendment 24)

**Files:**
- `apps/api/src/routes/portal/trustPageLink.ts` (+ test): `GET /trust-page` → `{ data: { publicPath: string | null } }`, computed for `auth.user.orgId`. The path is non-null only when the page is published, the slugs are valid and `trustPublishDecision(trustState).allowed`. It uses the portal's request context, with no system escalation unless the existing portal helpers require it (follow `routes/portal/documents.ts`).
- `routes/portal/index.ts` (one mount under the dashboard feature gate)
- portal `lib/trustPageLinkApi.ts`, `components/portal/TrustPageLink.tsx` (+ test; `data-testid="portal-dashboard-trust-link"`, `withBase`, English like the rest of the portal dashboard)
- `pages/dashboard/index.astro` (render it)

- [ ] Tests first:
  - An unpublished page → null and nothing rendered.
  - A published page → a link to `/portal/trust/<p>/<o>`.
  - A restricted partner → null.
  - Run `cd apps/api && npx vitest run src/routes/portal/trustPageLink.test.ts` + `cd apps/portal && npx vitest run src/components/portal/TrustPageLink.test.tsx` FAIL → PASS.
- [ ] Commit — `feat(portal): dashboard links to the org's public trust page when published`

### Task 5: Editor slug-rename warning (amendment 23)

**Files:**
- `routes/trustPage.ts`: `GET /:orgId/trust-page/publication` → `{ data: { published: boolean; publicPath: string | null } }`. `organizations:read`; reads without `ensureTrustPage`, so it never creates rows.
- `apps/web/src/lib/api/trustPagePublication.ts`
- `apps/web/src/components/settings/OrganizationForm.tsx` (+ test)
- `settings.json` ×8 (anchor S2: `organizationForm.trustSlugWarning`, "This organization has a published trust page. Changing the slug changes its public URL, and the old link will stop working.")

In edit mode, when the slug field differs from its initial value and the page is published, show the warning (`data-testid="org-slug-trust-warning"`). Partner slugs have no web editor (API-only `PATCH /orgs/partners/:id`), so the docs page (W02i appends one sentence under "Who can publish") states that renaming a partner slug changes every trust page URL.
- [ ] Tests first: the warning appears only after a slug edit on a published org; the endpoint performs no insert. Run `cd apps/api && npx vitest run src/routes/trustPage.test.ts` + `cd apps/web && npx vitest run src/components/settings/OrganizationForm.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts` FAIL → PASS.
- [ ] Commit — `feat(web): warn before renaming the slug of an org with a published trust page`
- [ ] Sweep (full API unit, web, portal, typechecks), PR, one review round (opus).

---

## Controller notes (execution)

- **Order:** W02a → (merge) → dispatch W02b–W02i in parallel, each in its own worktree, from fresh `origin/main`. Before dispatching, confirm W02a's merge commit is on `origin/main`, and check that no in-flight PR has added a migration that sorts after `2026-12-30-100300`.
- **Merging:** a parallel PR that goes red only because a sibling merged first is rebased, not re-planned. The anchor inserts are designed to merge cleanly; a conflict there means someone inserted at the wrong place.
- **Wave completion:** when all nine PRs are on `main`, run the three trust E2E specs on a fresh wt-stack, then `complete_wave` for #8770. No PR body contains a closing keyword.
- **Rigor:** one independent review round per PR. W02a, W02b, W02d, W02g and W02i are reviewed by opus; the rest by sonnet.

## Self-review notes (plan author, 2026-10-16)

- **Spec coverage** (§14 W2 + carry-forwards):

  | Item | Sub-wave |
  |---|---|
  | Declared controls with expiry/reminders | W02b |
  | MFA enforcement | W02c |
  | Gated documents + NDA + ticket | W02d |
  | Framework view + CIS gate + country suggestion | W02e |
  | Subprocessors + FAQ + 90-day history | W02f |
  | Partner template | W02g |
  | Portal i18n + per-control translations | W02h |
  | Dashboard link, rename warning, AI status tool, self-heal, home-flag rule | W02i |
  | Catalog version, NIST normalization, payload contract, frozen config, legacy semantics | W02a |

  W3 items (embed, JWS, questionnaire export, per-benchmark mapping, portal self-edit) are not in this plan.
- **Shared-file audit.** These files are touched by more than one sub-wave:

  | File | Mechanism |
  |---|---|
  | `organizations.json` ×8 | anchors |
  | `settings.json` ×8 | anchors S1/S2 |
  | `mailPurposes.ts` + test | anchors A1–A3 |
  | `trust-center.mdx` | comment anchors |
  | `TrustDocumentsList.tsx` | W02a extracts, then W02d alone owns it |
  | `routes/trustPage.ts` | W02a, then W02i alone |
  | `routes/trustPagePublic.ts` | W02a, then W02h alone |
  | `TrustControlsSection.tsx` / `TrustContentSection.tsx` | W02a, then W02g alone |
  | `mcpCoverage.ts` | W02a (new entries), then W02i (one existing entry) |

  Everything else is single-owner.
- **Known verification gaps:** CIS v8.1 safeguard numbers, NIST CSF 2.0 subcategory ids and Essential Eight strategy keys were chosen from the author's knowledge, not checked against the publications in this session. W02a Task 1 requires that check and records it in the crosswalk header. Graph CA-policy field names are to be confirmed in W02c Task 1.

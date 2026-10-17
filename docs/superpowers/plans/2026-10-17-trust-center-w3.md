---
title: Trust Center W3 — distribution (implementation plan)
spec: docs/superpowers/specs/trust-center/2026-10-12-trust-center-design.md
tracking_issue: LanternOps/breeze#8768
wave: W03 (#8771)
status: draft, awaiting Todd's review (plan-drafted). Not approved.
depends_on: W02 (#8770) for W03a, W03c and W03e (see "Dependencies on W02"); #3282 for the deferred custom-domain item only
---

# Trust Center W3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a published trust page travel: embeddable in an iframe on origins the MSP allowlists, signed as a machine-readable attestation that insurer and auditor tooling can verify, exportable as questionnaire answers, editable in part by the customer's own admin in the portal, and expanded so `hardening_baseline` names the CIS safeguards each hardening check evidences.

**Architecture:** Five file-disjoint sub-waves, each its own PR against `main`. W03a adds a separate `/portal/trust/embed/*` route whose CSP carries the page's live `frame-ancestors` allowlist, read from the existing SSR card endpoint. W03b adds a per-deployment ES256 signing keyset (system-only table, encrypted private keys, auto-provisioned), a `/api/v1/trust/attestation/*` router that serves the published payload as a compact JWT, and a JWKS. W03c adds a pure shared serializer that turns a published payload into CSV/JSON questionnaire answers, plus a download menu in the editor. W03d adds a portal flag and a portal-admin gate (`contact_roles.role = 'admin'`, org-scoped) for draft edits, preview and withdrawal from the portal. W03e adds a code-defined mapping from the agent's CIS Benchmark checks to CIS Controls v8 safeguards, evaluates per-safeguard evidence, and renders it under `hardening_baseline` behind W02's CIS gate.

**Tech Stack:** TypeScript, Hono, Drizzle (queries only, hand-written SQL migrations), PostgreSQL RLS, Redis, `jose` 6 (API only), Zod 4, Astro 7 + React 19 (portal, web), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/trust-center/2026-10-12-trust-center-design.md`. W03 scope is §14 "W3 — Distribution", with §5.5 (per-benchmark mapping), §8 (URLs, headers, badge), §13 (security) and §18.9 (portal admins edit in W3). The W1 plan (`docs/superpowers/plans/2026-10-13-trust-center-w1.md`) and its §19 amendments (Rulings 1–28) are binding where this plan does not say otherwise. Executors read the spec §7, §8, §13, §19 before starting any sub-wave.

## Scope

**In W03 (five sub-waves, below):** iframe embed with per-page `frame-ancestors` allowlist; signed machine-readable payload (JWS) with key management, rotation and a verification endpoint; questionnaire answer export (CSV + JSON); portal self-edit for customer org admins; per-benchmark-check safeguard mapping for `hardening_baseline`.

**Deferred, not planned for implementation:** custom domain via #3282. #3282 is OPEN at `track:spec` (Option A, Cloudflare SSL-for-SaaS, decided 2026-08-16; no spec yet). Nothing in W03 depends on it. "Interface note for #3282" below states what the trust page needs from that capability; the item is implemented as a follow-up once #3282 ships.

**Out of W03 (recorded as follow-ups, "Follow-ups after W03"):** export from the public portal page and from the portal editor, draft (unpublished) export, an MSP-side "customer edited the draft" indicator, the badge section showing the attestation URL, linking the new docs pages from `trust-center.mdx`, SIG/CAIQ questionnaire formats (proprietary or licensed formats).

## Global Constraints

- Every W1 constraint carries over: generic 404 `{ error: 'Not found', code: 'NOT_FOUND' }` with `Cache-Control: no-store` for every non-serving case, never 410; slug regex `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$` checked before any Redis or SQL; public DB work inside `runOutsideDbContext(() => withSystemDbAccessContext(...))`; `rateLimiter()` never inside a held DB context (#1105).
- Public posture is never computed live. Every new public surface (embed card, attestation, export) is derived from the current immutable snapshot payload or the card; none re-runs `loadPostureEvidence`.
- Payload exposure rules are unchanged: no device ids/hostnames, IPs, users/UPNs, CVEs, open ports, pending patches, `top_issues`, posture score. **No CIS Benchmark check titles or check ids reach the payload** (the agent's titles are verbatim CIS recommendation text). Enforced by `trustPagePublicPayload.contract.test.ts`.
- Copy never says "compliant with", "certified", "meets IG1". Framework labels are Breeze's own paraphrases. No verbatim CIS text (Controls or Benchmarks), ever (spec §5.5, §18.13).
- CIS v8 rendering stays behind W02's CIS gate (an env flag, OFF by default until Todd holds written CIS confirmation or a SecureSuite vendor membership; spec §18.13). W03e reads that gate; it does not add a second flag. The W02 plan fixes the flag's name and helper.
- Migrations: hand-written, idempotent, no inner `BEGIN`/`COMMIT`, DDL-only (no `set_config('breeze.scope', ...)` needed unless a file writes rows). Newest committed migration on `main` is `2026-12-29-140000-audit-chain-verify-org-index.sql`; W02 uses `2026-12-30-1003xx`–`1009xx`; W03 uses `2026-12-30-110300` (W03a), `110500` (W03b), `110700` (W03d). Re-check with `ls apps/api/migrations | sort | tail -3` and the pre-push `check-migration-naming.sh --against-ref origin/main` before pushing.
- New tenant-scoped column or table: RLS in the creating migration; composite FKs on `org_id` are `DEFERRABLE INITIALLY IMMEDIATE`; registered in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY` (columns: `json`/`jsonb`/`bytea` → `excludedOpen`). W03 adds two columns to registered tables and one system-only table; no new org tables.
- Web mutations go through `runAction`; a new web file that mutates is added to `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (a literal list).
- **All-locales rule.** A new `apps/web` locale key exists in all **8** locale files of its namespace: `apps/web/src/locales/{en,pt-BR,es-419,fr-FR,fr-CA,de-DE,it-IT,tr-TR}/<ns>.json`, really translated (`translationCoverage.test.ts` caps English-identical values per namespace; a new namespace needs a baseline entry in all 7 translated locales of that test). Run `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts`. PR bodies carry `pt-BR strings are machine-drafted pending native review` and `es-419, fr-FR, fr-CA, de-DE, and it-IT strings are machine-drafted pending native review`. The portal has no i18n runtime (spec §19.4): portal copy is English.
- Portal: no inline `style=` (`noInlineStyles.test.ts`), no literal `href="/..."` (`withBase`, `basePathCoverage.test.ts`). Production CSP is a response header built per request (Astro `security.csp` + `lib/csp.ts`); dev deletes CSP unless `CSP_STRICT_DEV=1`, so CSP behaviour is tested through the pure helpers, not `astro dev`.
- Never commit IPs, hostnames or internal domains (tests use `example.com`/`example.org`). Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Scoped test runs: `cd apps/api && npx vitest run <file>` (never `pnpm --filter <pkg> test -- --run <path>`; vitest filters are substring matches — check the file count). Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit; echo "exit=$?"` (a piped tsc masks OOM as green).
- Contract suites (need `pnpm test-stack up`, then `pnpm test-stack down` and say so): `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts` · `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` · `pnpm --filter @breeze/api db:migrate && pnpm --filter @breeze/api db:migrate && pnpm --filter @breeze/api db:check-drift` (migrate twice proves idempotency). The cascade/export suites fail only under **Integration Tests**, never **Test API**.

## Review Focus

1. **An allowlisted origin is removed while a customer site has the embed open.** Expected: the next embed load carries `frame-ancestors 'none'` (card and embed HTML are `no-store`); no stale allowlist survives in Redis, the card or an HTTP cache. A frame already rendered in a visitor's browser stays until reload (documented). Test: W03a Task 3 (`card reflects an allowlist edit on the next request`, `card is no-store`) and Task 4 (`empty allowlist → 'none' + DENY + no-store`).
2. **A JWS verified long after it was fetched, across a key rotation.** Expected: the old `kid` stays in the JWKS as verify-only, so the signature still verifies; the expired `exp` tells the verifier it is not a current statement. Test: W03b Task 2 (`verify-only key stays in JWKS after activate`) and Task 3 (`attestation from a rotated-out kid verifies against the JWKS`).
3. **A customer admin's portal edit races the MSP's publish.** Expected: the portal PUT bumps `publication_revision`, so the MSP's publish 409s (`REVISION_MISMATCH`) instead of publishing a draft the MSP never saw. Test: W03d Task 3 (`portal edit bumps the revision; publish with the old revision 409s`).
4. **A questionnaire cell that starts with `=` (org name, intro-derived fields, framework label).** Expected: neutralized with a leading `'` by the shared CSV helpers. Test: W03c Task 1 (`neutralizes formula prefixes in every column`).
5. **A device whose latest CIS scan reports `not_applicable` or `error` for every mapped check.** Expected: not assessed for that safeguard (not passing, not failing), and the coverage floor applies per safeguard. Test: W03e Task 3 (`not_applicable and error findings do not assess a safeguard`).

---

## Sub-wave map

Five sub-waves. Each is one PR against `main`, branched from `main` (stacked PRs get no CI). Branch names after `start_wave`: `feature/8768-trust-center/wave-8771-<letter>`, e.g. `feature/8768-trust-center/wave-8771-a`. Every PR body says `Part of #8771`; only the last of the five to merge says `Closes #8771`, and only if the custom-domain item has been split to its own issue first (otherwise `Part of #8771` throughout and the wave closes when #3282's follow-up lands).

| Sub-wave | Scope | Owned files (create / modify) | Must not touch | Migration slot | Model tier | Depends on |
|---|---|---|---|---|---|---|
| **W03a Embed** | Per-page `frame-ancestors` allowlist; `/portal/trust/embed/*`; no-store card | **API create:** `migrations/2026-12-30-110300-trust-pages-embed-origins.sql`, `src/services/trustPage/embedOrigins.test.ts`. **API modify:** `src/db/schema/trustPages.ts`, `src/services/tenantExportPolicyRegistry.ts` (the `"trust_pages"` entry only), `src/services/tenantExportPolicyRegistry.trustPages.test.ts`, `src/routes/trustPage.ts`, `src/routes/trustPage.test.ts`, `src/routes/trustPagePublic.ts`, `src/routes/trustPagePublic.test.ts`, `src/services/trustPage/resolve.ts`, `src/services/trustPage/resolve.test.ts`, `src/__tests__/integration/trustPagesSchema.integration.test.ts`. **Shared create:** `packages/shared/src/validators/trustCenterEmbed.ts` (+ `.test.ts`). **Shared modify:** `packages/shared/src/validators/index.ts`. **Portal create:** `src/pages/trust/embed/[partnerSlug]/index.astro`, `src/pages/trust/embed/[partnerSlug]/[orgSlug].astro`, `src/layouts/TrustEmbedLayout.astro`, `src/components/trust/TrustEmbedCard.astro`, `src/lib/trustEmbed.ts` (+ `.test.ts`). **Portal modify:** `src/middleware.ts`, `src/middleware.test.ts`, `src/lib/csp.ts`, `src/lib/csp.test.ts`, `src/env.d.ts`, `src/lib/disabledPageCoverage.test.ts`. **Web create:** `src/components/trustCenter/TrustEmbedSection.tsx` (+ `.test.tsx`). **Web modify:** `src/components/trustCenter/TrustCenterTab.tsx`, `src/lib/api/trustPage.ts`, `src/lib/__tests__/no-silent-mutations.test.ts`, `src/locales/<8>/organizations.json`. **Docs:** create `apps/docs/src/content/docs/security/trust-center-embed.mdx`; modify `apps/docs/src/content/docs/deploy/tls.mdx`. **E2E:** create `e2e-tests/tests/trust-center-embed.spec.ts` | `apps/api/src/index.ts`, `mcpCoverage.ts`, `partnerGuard.ts`, `globalRateLimit.ts`, `portal/lib/api.ts`, `TrustPageView.tsx`, `TrustPageLayout.astro`, `pages/trust/[partnerSlug]/*`, `TrustStatusCard.tsx`, `TrustBadgeSnippet.tsx`, `validators/trustCenter.ts`, `payloadBuilder.ts`, `publication.ts` | `110300` | opus (CSP) | W02 sub-waves that change `trust_pages` columns, `trustPagePublic.ts`, `routes/trustPage.ts`, `TrustCenterTab.tsx` or `orgRecord.trust.*` locale keys (spec §12 gated documents + access requests, §18.8 partner template) — rebase after they merge |
| **W03b Signed attestation** | ES256 keyset, signing, `/api/v1/trust/attestation/*` (JWT + JWKS), rotation CLI, page link; cross-origin CORP exception at the `secureHeaders` boundary (fixes the W1 badge) | **API create:** `migrations/2026-12-30-110500-trust-signing-keys.sql`, `src/db/schema/trustSigningKeys.ts`, `src/services/trustPage/attestationKeys.ts` (+ `.test.ts`), `src/services/trustPage/attestation.ts` (+ `.test.ts`), `src/routes/trustPageAttestation.ts` (+ `.test.ts`), `src/middleware/trustCrossOrigin.ts` (+ `.test.ts`), `src/__tests__/integration/trustSigningKeys.integration.test.ts`, `scripts/trust-signing-key.ts`. **API modify:** `src/db/schema/index.ts`, `src/index.ts`, `src/middleware/globalRateLimit.ts` (+ test), `src/middleware/partnerGuard.ts` (+ test), `src/__tests__/routerAuthGate.contract.test.ts`, `src/services/mcpCoverage.ts` (one line after `'trustPagePublic.ts'`), `src/services/encryptedColumnRegistry.ts`, `src/__tests__/integration/rls-coverage.integration.test.ts`, `package.json` (script). **Portal create:** `src/lib/trustAttestation.ts` (+ `.test.ts`). **Portal modify:** `src/layouts/TrustPageLayout.astro`, `src/layouts/TrustPageLayout.test.ts`, `src/pages/trust/[partnerSlug]/index.astro`, `src/pages/trust/[partnerSlug]/[orgSlug].astro`. **Docs:** create `apps/docs/src/content/docs/security/trust-center-attestation.mdx`; modify `.env.example` only if Task 1 adds an env var (it does not by default) | `trustPagePublic.ts`, `resolve.ts`, `routes/trustPage.ts`, `tenantExportPolicyRegistry.ts`, `portal/middleware.ts`, `portal/lib/api.ts`, `TrustPageView.tsx`, any `apps/web` file | `110500` | opus (signing) | none (schema-agnostic: signs whatever payload the snapshot holds) |
| **W03c Questionnaire export** | Pure CSV/JSON serializer over the published payload; editor download menu | **Shared create:** `packages/shared/src/trustCenter/questionnaireExport.ts` (+ `.test.ts`). **Shared modify:** `packages/shared/src/trustCenter/index.ts`. **Web create:** `src/components/trustCenter/TrustExportMenu.tsx` (+ `.test.tsx`), `src/lib/trustExport.ts` (+ `.test.ts`), `src/locales/<8>/trustCenter.json`. **Web modify:** `src/components/trustCenter/TrustStatusCard.tsx`, `src/components/trustCenter/TrustStatusCard.test.tsx`, `src/lib/i18n/translationCoverage.test.ts`. **Docs:** create `apps/docs/src/content/docs/security/trust-center-questionnaire.mdx` | every `apps/api` file, `organizations.json`, `TrustCenterTab.tsx`, `lib/api/trustPage.ts`, `no-silent-mutations.test.ts`, `frameworkCrosswalk.ts`, `validators/trustCenter.ts` | none | sonnet | W02 declared-controls payload (spec §18.2, §14 W2 item 1: `source: 'declared'` in the payload) so declared rows export; nothing else |
| **W03d Portal self-edit** | Portal flag `enableTrustPageEditing`; org-admin gate; draft subset edit, preview, withdraw | **API create:** `migrations/2026-12-30-110700-portal-branding-trust-page-editing.sql`, `src/services/portal/trustPageEditor.ts` (+ `.test.ts`), `src/services/trustPage/draftPatch.ts` (+ `.test.ts`), `src/routes/portal/trustPage.ts` (+ `.test.ts`), `src/__tests__/integration/portalTrustPageEditing.integration.test.ts`. **API modify:** `src/db/schema/portal.ts`, `src/services/tenantExportPolicyRegistry.ts` (the `"portal_branding"` entry only), `src/services/tenantExportPolicyRegistry.portalBranding.test.ts`, `src/services/portal/portalFlags.ts` (+ test), `src/routes/orgPortalSettings.ts` (+ test), `src/routes/portal/featureFlags.ts` (+ test), `src/routes/portal/index.ts`, `src/services/mcpCoverage.ts` (one line after `'portal/tickets.ts'`). **Shared modify:** `packages/shared/src/validators/portal.ts` (+ test), `packages/shared/src/types/portalVisibility.ts`. **Portal create:** `src/pages/security/trust-page.astro`, `src/components/trust/TrustPageEditor.tsx` (+ `.test.tsx`), `src/lib/trustEditorApi.ts` (+ `.test.ts`). **Portal modify:** `src/lib/api.ts`, `src/lib/navItems.ts` (+ test). **Web modify:** `src/components/settings/OrgPortalSettingsEditor.tsx` (+ test), `src/locales/<8>/settings.json`. **Docs:** create `apps/docs/src/content/docs/security/trust-center-portal-editing.mdx`. **E2E:** create `e2e-tests/tests/trust-center-portal-edit.spec.ts` | `routes/trustPage.ts`, `trustPagePublic.ts`, `resolve.ts`, `publication.ts`, `schema/trustPages.ts`, `portal/middleware.ts`, `disabledPageCoverage.test.ts`, `protectedPaths.ts`, `organizations.json`, `TrustCenterTab.tsx` | `110700` | opus (permission gating) | none |
| **W03e Benchmark safeguards** | `(os, agent checkId) → CIS v8 safeguards`; per-safeguard evidence under `hardening_baseline`, behind W02's CIS gate | **Shared create:** `packages/shared/src/trustCenter/benchmarkSafeguards.ts` (+ `.test.ts`). **Shared modify:** `packages/shared/src/trustCenter/frameworkCrosswalk.ts`, `packages/shared/src/trustCenter/types.ts`, `packages/shared/src/trustCenter/evaluate.ts` (+ test), `packages/shared/src/validators/trustCenter.ts` (+ test), `packages/shared/src/trustCenter/controlCatalog.test.ts`. **API create:** `src/services/cisBenchmarkSafeguards.contract.test.ts`. **API modify:** `src/services/postureEvidence.ts` (+ test), `src/services/trustPage/payloadBuilder.ts` (+ test), `src/services/trustPage/trustPagePublicPayload.contract.test.ts`. **Portal create:** `src/components/trust/HardeningSafeguards.tsx` (+ `.test.tsx`). **Portal modify:** `src/components/trust/TrustPageView.tsx` (+ test). **Docs:** modify `apps/docs/src/content/docs/security/trust-center.mdx` | `trustPagePublic.ts`, `resolve.ts`, `publication.ts`, `trustCenter/index.ts`, every `apps/web` file, `portal/middleware.ts`, `portal/lib/api.ts` | none | sonnet (opus for the Task 1 mapping review) | W02 framework view + CIS gate (spec §5.5 "W2", §18.13) and W02's payload-schema change (declared controls); both edit `validators/trustCenter.ts`, `payloadBuilder.ts` and `TrustPageView.tsx` |

**Deferred: custom domain (#3282)** — no sub-wave, no files, no migration slot. See "Interface note for #3282".

### Shared-registry exceptions (the only two files touched by more than one sub-wave)

Both are declarative registries. Each touch is one insertion inside a different, named entry, more than 100 lines apart, so git merges the second PR without a conflict. Nothing else overlaps; if an implementer finds they need any other file outside their "owned" list, they stop and report (NEEDS_CONTEXT), they do not edit it.

| File | W03a | W03b | W03d |
|---|---|---|---|
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | `"trust_pages"` entry (line ~998): add `embed_allowed_origins` to `included` | — | `"portal_branding"` entry (line ~699): add `enable_trust_page_editing` to `included` |
| `apps/api/src/services/mcpCoverage.ts` | — | new line after `'trustPagePublic.ts'` (~723) | new line after `'portal/tickets.ts'` (~601) |

These two cannot be avoided without making one sub-wave depend on another: W03b and W03d each need a new route file (the coverage map requires an entry per file), and W03a and W03d each add a column to an org-cascade table (the export policy classifies every column).

### Dependencies on W02 (#8770)

W02 is being planned concurrently; dependencies are named by spec section, not by W02 file names. Before starting a sub-wave, the controller checks `get_feature_status` for #8768 and the W02 PR list.

- **W03a** shares `trust_pages`, `routes/trustPage.ts`, `trustPagePublic.ts`, `TrustCenterTab.tsx` and `orgRecord.trust.*` locale keys with W02's gated documents and access requests (§12) and partner-wide template (§18.8). Start after those W02 sub-waves merge.
- **W03b** has no W02 dependency. It may start now.
- **W03c** consumes declared controls (§18.2) so declared rows export with their "declared by … on …, expires …" basis. Start after W02's declared-controls payload change merges. (If Todd wants W03c first, it ships telemetry-only and a follow-up adds the declared branch; Open Decision 6.)
- **W03d** has no W02 dependency. It may start now. Its editable subset is fixed (contact email, website, hidden controls, exposure toggles) and does not include W02's new draft fields.
- **W03e** extends W02's framework view (the "N of M safeguards evidenced" count must include expanded safeguards) and reads W02's CIS gate. Start after W02's framework-view sub-wave merges.

Merge order inside W03 does not matter. Each PR rebases on `main` before it enters the merge queue.

### Settings rule 9

- **W03a — embed allowlist.** Home: Organization record → Trust Center tab → "Embed on your website". Level: org (per page). Resolver: none (one value, read live by the card query). Count of places the concept is configured: 0 → 1.
- **W03d — `enableTrustPageEditing`.** Home: Organization settings → Customer Portal (`OrgPortalSettingsEditor`), next to the other portal feature flags, outside "Enable all" (like the sensitive flags). Level: org. Resolver: the existing portal-flag read (`portal_branding` row; missing row = false). Count: 0 → 1. Who may edit is not a new setting: it is the existing contact responsibility `admin` (org-scoped), configured in the existing contacts UI.
- W03b, W03c, W03e add no setting. The signing key is platform infrastructure, managed by the CLI, not a setting.

---

## Advisor quorum (CSP carve-out and signing design)

Position formed first (below), then an independent `codex exec -s read-only -m gpt-6-astra -c model_reasoning_effort="xhigh"` review of the same design. Result and how each disagreement was resolved: see "Quorum result". Disagreements that were not resolved on the merits are Open Decisions.

**Embed (my position).** A separate, JS-free embed route keeps the carve-out narrow: the full page (documents, method, downloads) stays `frame-ancestors 'none'` + `X-Frame-Options: DENY`; only a compact card that links out (`target=_blank rel="noopener noreferrer"`) is frameable, so there is nothing to clickjack. The allowlist is exact `https://host[:port]` origins (≤ 10, no wildcards, no paths, no CSP keywords), stored on `trust_pages`, written by an MFA-gated route, and read **live** (not frozen at publish): it is an access-control setting, and removing an origin must take effect on the next request, which a freeze would delay until a republish. The middleware **replaces** the `frame-ancestors` directive (Astro's `insertDirective` merges and would yield `'none' https://x`) and deletes `X-Frame-Options` only on a 200 with a non-empty allowlist. Also found while reading: Hono `secureHeaders` sends `Cross-Origin-Resource-Policy: same-origin` on every API response (`apps/api/src/index.ts:500-513`; Hono 4.13.5 default), so the W1 badge `<img>` is very likely blocked on customer sites (inferred from code, not reproduced in a browser). The fix is `Cross-Origin-Resource-Policy: cross-origin` on `badge.svg` only (where it is applied changed in the quorum: see A5).

**Signing (my position).** One signer per deployment (the Breeze installation attests to what its telemetry shows); no per-partner keys, because no partner holds or controls the key. A new system-only table modeled on `manifest_signing_keys` (forced RLS, system-only policy), private keys encrypted with `secretCrypto` v3 AAD and registered in `encryptedColumnRegistry`, auto-provisioned on first use so self-hosters configure nothing. Never reuse the OAuth keyset (off by default, and it signs access tokens — cross-protocol confusion), the manifest key (agents trust it for updates), the audit-anchor seed, or the HS256 JWT keyring (symmetric, cannot be published). ES256 over EdDSA for interop with insurer/auditor tooling (.NET and older Java stacks verify ES256 natively; EdDSA needs add-ons). Compact JWT with explicit `typ`, signed on demand and cached per (snapshot, evaluation time, kid), so the immutable snapshot table gets no column and rotation needs no re-signing. Retired public keys stay in the JWKS so archived attestations keep verifying; a compromised key is revoked (removed) at once.

### Quorum result

Codex (gpt-6-astra, xhigh, read-only, 2026-10-16) agreed with both architectures and disagreed on five specifics. Each was resolved on the merits and folded into the tasks below; the two that are product calls are also Open Decisions.

| # | Codex finding | Resolution |
|---|---|---|
| A3/A4 | A 300 s card cache and a 60 s embed-HTML cache contradict "removal takes effect at once". | **Adopted.** The card response becomes `no-store` (its only consumer is portal SSR, so nothing is lost) and embed HTML is `no-store`. Frames already loaded in a visitor's browser cannot be recalled; the docs say so. |
| A4 | In dev the portal deletes CSP (`lib/csp.ts:75`); deleting `X-Frame-Options` there would leave the embed with no framing control at all. | **Adopted.** XFO is deleted only when an enforced CSP with the allowlist was actually emitted. Nested frames: every ancestor must be allowlisted (documented). |
| A5 | Hono `secureHeaders` sets its headers **after** `await next()` (verified: `hono@4.13.5/dist/middleware/secure-headers/secure-headers.js:85-86`), so a CORP header set in the badge handler is overwritten. | **Adopted, and moved.** The CORP exception is applied where `secureHeaders` is registered (`apps/api/src/index.ts:500-513`) for the badge path and the attestation prefix. `index.ts` is W03b's file, so the W1 badge fix moves from W03a to W03b (Task 3). |
| A6 | `frame-ancestors` supersedes XFO, but not a second restrictive CSP a proxy injects. | **Adopted** in the W03a proxy docs. |
| B1 | Auto-provisioning on "no active key" means a revoke silently mints a replacement (and a context bug that reads zero rows would mint keys repeatedly). `encryptSecret` drops AAD unless `APP_ENCRYPTION_KEY_ID` is set (`secretCrypto.ts:403-418`). | **Adopted:** auto-provision only when the table is empty; `revoke` requires `--replace` to mint a successor, otherwise attestation answers 503 until an operator acts. **AAD:** follow the repo standard (AAD applies when `APP_ENCRYPTION_KEY_ID` is set, as for every registry column); the docs tell self-hosters to set it. Not verified: whether hosted regions set it. |
| B3 | `jti` should be unique per issued token, not the snapshot id; cache identity must include `iss`/`sub` (a slug rename changes `sub` without a new snapshot); `stale` changes with time alone. | **Adopted:** `jti` = random UUID; cache key includes `sub`; the cache TTL is bounded by `exp`. |
| B4 | Errors must be `no-store`; success caching must not outlive `exp`; 5-minute caching delays unpublish. | **Adopted:** `public, max-age=min(60, exp − now)`; every non-200 is `no-store`. |
| B5 | A cached JWKS keeps a revoked key for its max-age; "immediately" is false. Never serve an empty first JWKS. | **Adopted:** JWKS `max-age=600`; revocation propagates within 10 minutes for caching verifiers (documented); `activate` waits ≥ 600 s after `prepare`; the JWKS route provisions before serving. |
| B6 | Recipes must check `iss`, `sub`, `alg`, `typ` and freshness, not only the signature; a self-hosted operator controls both evidence and signer. | **Adopted** in the W03b docs. |
| C | Keep on-demand signing; refresh stamps new evaluation times on unchanged snapshots, which snapshot-time signing would miss. | **Agreed** (no change). |
| D | `exp = iat + 7 days` permits replay of a stale posture. Recommend `exp = min(iat + 1 h, lastEvaluatedAt + 24 h)`, and issue no currently-valid token once the page is stale. | **Adopted as the default; Open Decision 3** because validity length is a product call for insurer tooling. A stale page's attestation route answers 503 `ATTESTATION_STALE`. |
| B2 | ES256 for external interop; JOSE `EdDSA` is deprecated by RFC 9864 in favour of `Ed25519`. | **Agreed** (ES256). |

---

## Open Decisions

Defaults are what the plan implements; each can be flipped before the sub-wave starts.

1. **Portal edit gate — no portal roles exist.** Verified on `main`: `portal_users` has no role column, no portal-role enum or check exists anywhere, and #4562 (CLOSED 2026-09-03) shipped only its Wave-1 visibility scope; its "W3 portal roles (admin / billing / read-only)" exists only as text in the issue body, with no sub-issue in any state. **Recommend** the smallest gate consistent with the portal model: a per-org portal flag `enableTrustPageEditing` (default off, MSP-controlled, like every portal feature flag) **and** an org-scoped `contact_roles.role = 'admin'` on the portal user's contact (the canonical responsibility table; ticket approvals already read org-scoped contact roles the same way, `services/ticketApproval/requests.ts:216-245`). Caveat: `admin` today means "customer admin contact"; granting edit rights on it widens that meaning, which the flag's help text states. Alternatives: a new `portal_users.is_org_admin` boolean (duplicates the contact-role model, needs a validator and UI) or waiting for a real portal-roles feature (blocks W03d indefinitely).
2. **What a customer admin may do.** **Recommend** draft edits to contact email, website, hidden controls and the two exposure toggles; preview; and unpublish (a customer withdrawing consent should not need its MSP). Excluded: publish (the portal has no MFA or step-up; publish needs MFA, the trusted-partner capability and the customer attestation), intro rich text (the portal has no rich-text editor; a plain-text replacement would flatten the MSP's formatting), documents, embed allowlist. Alternative: also let customers publish after a current-password step-up (Entra-only portal users have no password, so this would need a new step-up mechanism).
3. **Attestation validity.** **Recommend** `exp = min(iat + 1 h, lastEvaluatedAt + 24 h)` and no token at all for a stale page (codex D). Archival verification checks the signature and the dates without claiming current validity (the docs show how). Alternative: `iat + 7 days` (easier for tools that fetch once a week; weaker replay story).
4. **Embed allowlist is live, not frozen at publish.** Deviates from Ruling 20 ("publication config frozen at publish"). **Recommend** live: it is an access-control setting; removal must apply at the next load, and the PUT itself requires MFA, so the property Ruling 20 protects (nothing public changes without MFA) holds. Alternative: freeze into `published_config` (changes require a republish; removal waits for one).
5. **Exact origins only, no wildcards.** **Recommend** exact `https://host[:port]`, at most 10 per page. Alternative: allow `https://*.example.com` (CSP supports it; harder to reason about subdomain takeover on the customer side).
6. **Questionnaire format and source.** **Recommend** CSV + JSON from the published payload only, generated in the browser by a shared serializer (no new API route; the export can never exceed the public page). Alternatives: an authenticated API export route (adds an audit trail, can export drafts, but needs a route file and a `runAction` path); SIG Lite or CAIQ mappings (proprietary or licensed question sets; out of scope). If W02's declared controls are not merged when W03c should start, ship telemetry-only and add the declared branch later.
7. **Per-benchmark mapping data and licensing.** The safeguard identifiers come from CIS Benchmark PDFs (CIS licensing, not only the CIS Controls licence §5.5 discusses). **Recommend** treating it under the same §18.13 gate: data ships, rendering stays behind W02's CIS flag until Todd has CIS's written confirmation, and the confirmation request names Benchmark-to-Controls mappings explicitly. Todd owns the CIS contact; the plan takes no outward action.
8. **Reserved partner slug `embed`.** **Recommend** reserving it, like `preview` (Ruling 16). Before merge, someone with prod access runs `SELECT id FROM partners WHERE slug = 'embed'` on each region (not verifiable from the repo). Alternative: put the embed under `/portal/trust/<p>/<o>/embed` (no partner reservation, but an org slug `embed` would then be shadowed on partner-home pages).

---

## Interface note for #3282 (custom domains) — deferred

The trust page's custom-domain item (`trust.customer.com`) waits for #3282. What the trust page needs from that capability, so its spec can cover it:

1. **Host → tenant resolution**, verified-only and revocable: `resolveVerifiedHost(host) → { partnerId, orgId | null, surface: 'portal' } | null`, served from a cache that a release/revocation invalidates immediately (a released domain must stop serving the page at once).
2. **Canonical public origin per tenant**: `publicOriginFor({ partnerId, orgId }) → string` (verified custom host, else the platform origin). Trust consumers: canonical/OG URLs, the badge and embed snippets, the JWS `sub` claim, the questionnaire export's `page_url`.
3. **Path mapping**: on a verified trust host, `/` serves the org page and `/embed` the embed card, with the slugs resolved from the host, not the path. The portal pages take the host-resolved slugs; the API routes stay slug-addressed.
4. **Ingress/TLS** owned entirely by #3282 (Cloudflare SSL-for-SaaS, Option A). The trust page adds no ingress.
5. **Cross-origin API**: if the custom host serves only the portal, the client-side payload fetch becomes cross-origin. #3282 must either proxy `/api/v1/trust/public/*` on the custom host or the payload route must answer CORS for verified custom origins (`connect-src` widened to match).
6. **Cookie isolation**: no portal session cookie is ever set on a custom trust host (trust pages ignore cookies today; keep it that way).
7. **Attestation**: `iss` stays the deployment origin (keys are per deployment); `sub` becomes the custom URL once verified.
8. **Canonicalization**: once verified, the platform URL serves `rel=canonical` to the custom URL; the platform URL keeps working.

Follow-up to file when #3282 has a spec: "Trust Center: serve published pages on verified custom hosts (#3282 interface note in the W3 plan)".

---

## W03a — Embed (opus)

**Files:** see the sub-wave map. **Interfaces produced:** `normalizeEmbedOrigin(input: string): string | null`, `trustEmbedOriginsUpdateSchema` (shared); `trust_pages.embed_allowed_origins text[]`; `ResolvedTrustPage.embedAllowedOrigins: string[]`; card field `frameAncestors: string[]`; `withFrameAncestors(csp: string, sources: readonly string[]): string` (portal `lib/csp.ts`); `Astro.locals.trustEmbedOrigins?: string[]`.

### Task 1: Origin validator and the column

**Files:** create `packages/shared/src/validators/trustCenterEmbed.ts` (+ test), modify `packages/shared/src/validators/index.ts`; create `apps/api/migrations/2026-12-30-110300-trust-pages-embed-origins.sql`; modify `apps/api/src/db/schema/trustPages.ts`, `tenantExportPolicyRegistry.ts` (`"trust_pages"` entry), `tenantExportPolicyRegistry.trustPages.test.ts`, `src/__tests__/integration/trustPagesSchema.integration.test.ts`.

- [ ] **Step 1: Write the failing validator tests** (`trustCenterEmbed.test.ts`)

```ts
import { normalizeEmbedOrigin, trustEmbedOriginsUpdateSchema, TRUST_EMBED_ORIGINS_MAX } from './trustCenterEmbed';
it.each([
  ['https://Example.COM', 'https://example.com'],
  ['https://example.com/', 'https://example.com'],
  ['https://example.com:8443', 'https://example.com:8443'],
  ['https://sub.example.org/path?q=1', null],   // paths/queries are rejected, not stripped silently
  ['http://example.com', null], ['https://*.example.com', null], ["'self'", null], ['*', null],
  ['https://example.com; script-src *', null], ['https://user:pw@example.com', null],
  ['https://192.0.2.10', null], ['https://[2001:db8::1]', null], ['https://localhost', null],
  ['https://bücher.example', 'https://xn--bcher-kva.example'],
])('normalizeEmbedOrigin(%s) → %s', (input, out) => expect(normalizeEmbedOrigin(input)).toBe(out));
it('caps the list and rejects duplicates after normalization', () => {
  expect(TRUST_EMBED_ORIGINS_MAX).toBe(10);
  expect(trustEmbedOriginsUpdateSchema.safeParse({ origins: ['https://a.example', 'https://A.example/'] }).success).toBe(false);
  expect(trustEmbedOriginsUpdateSchema.safeParse({ origins: Array.from({ length: 11 }, (_, i) => `https://s${i}.example`) }).success).toBe(false);
  expect(trustEmbedOriginsUpdateSchema.parse({ origins: ['https://Example.com/'] })).toEqual({ origins: ['https://example.com'] });
});
```

- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/validators/trustCenterEmbed.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `normalizeEmbedOrigin` with `new URL(input.trim())`: require `protocol === 'https:'`, no username/password, `pathname === '/'` and empty `search`/`hash` (a bare trailing `/` is allowed), hostname not an IP literal and not `localhost`, hostname matches `^[a-z0-9.-]+$` after URL's punycode conversion and contains a dot; return `url.origin`. `trustEmbedOriginsUpdateSchema = z.strictObject({ origins: z.array(z.string().max(300)).max(TRUST_EMBED_ORIGINS_MAX) })` with a transform that normalizes, an issue per unnormalizable entry (path `['origins', i]`), and a duplicate check after normalization. Export from `validators/index.ts`.
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Write the failing schema/integration assertions.** In `trustPagesSchema.integration.test.ts`: `embed_allowed_origins` exists, `text[]`, `NOT NULL`, default `'{}'`; inserting 11 elements fails with the CHECK `trust_pages_embed_origins_max_chk`. In `tenantExportPolicyRegistry.trustPages.test.ts`: `embed_allowed_origins` is classified `included`.
- [ ] **Step 6: Write the migration** (DDL only, idempotent):

```sql
-- Trust Center W3a (#8771): per-page iframe embed allowlist (spec §14 W3). Exact https origins, validated in the
-- app (packages/shared/src/validators/trustCenterEmbed.ts); the CHECK only bounds the size. Read live by the
-- card query; not part of published_config (live access-control setting, see the W3 plan quorum).
ALTER TABLE trust_pages ADD COLUMN IF NOT EXISTS embed_allowed_origins text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE trust_pages DROP CONSTRAINT IF EXISTS trust_pages_embed_origins_max_chk;
ALTER TABLE trust_pages ADD CONSTRAINT trust_pages_embed_origins_max_chk CHECK (cardinality(embed_allowed_origins) <= 10);
```

  Drizzle: `embedAllowedOrigins: text('embed_allowed_origins').array().notNull().default(sql\`'{}'::text[]\`)`. Export policy: add `embed_allowed_origins` to the `included` list of the `"trust_pages"` entry (text array, not json/jsonb/bytea).
- [ ] **Step 7: Verify** — `cd packages/shared && npx vitest run src/validators/trustCenterEmbed.test.ts`; `cd apps/api && npx vitest run src/services/tenantExportPolicyRegistry.trustPages.test.ts`; with the test stack up: migrate twice + drift, the four contract suites, `trustPagesSchema.integration.test.ts`. Expected: all PASS; drift clean.
- [ ] **Step 8: Commit** — `git commit -m "feat(trust-center): embed origin validator and trust_pages.embed_allowed_origins (W3a)"` (+ trailer).

### Task 2: Editor route — `PUT /orgs/:orgId/trust-page/embed`

**Files:** modify `apps/api/src/routes/trustPage.ts`, `apps/api/src/routes/trustPage.test.ts`.

**Interfaces:** request `{ origins: string[] }` (shared schema); response `{ data: { embedAllowedOrigins: string[] } }`. GET `/:orgId/trust-page` already returns the whole `page` row, so `page.embedAllowedOrigins` reaches the editor without a change; GET additionally returns `embedPath: string` (base-relative `/portal/trust/embed/<p>[/<o>]`).

- [ ] **Step 1: Failing route tests** in `trustPage.test.ts`: `PUT /embed without MFA → 403` (mirrors the publish MFA test); `org-scoped sign-in → 403` (`requireScope('partner','system')`); `orgs:read only → 403`; `inaccessible org → 404 NOT_FOUND`; `normalizes and stores origins` (body `['https://Example.com/']` → db update called with `['https://example.com']`, response echoes it); `invalid origin → 400 with path origins.0`; `audits trust_page.embed.update with { added, removed }`; `does not bump publication_revision` (live setting, not a draft change: no 409 on a concurrent publish); `GET returns embedPath` (`/portal/trust/embed/nw/acme`, partner home `/portal/trust/embed/nw`).
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/trustPage.test.ts` → the new cases FAIL.
- [ ] **Step 3: Implement** `trustPageRoutes.put('/:orgId/trust-page/embed', scopes, orgWrite, requireMfa(), zValidator('param', orgParam), zValidator('json', trustEmbedOriginsUpdateSchema), …)`: `resolveAccessibleOrg` → `ensureTrustPage` → `db.update(trustPages).set({ embedAllowedOrigins, updatedAt, updatedByUserId })` → audit `trust_page.embed.update` with `{ added, removed, count }`. Extend `publicPaths()` with `embedPath`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(trust-center): MFA-gated embed allowlist route (W3a)`.

### Task 3: Card carries `frameAncestors`; `embed` reserved

**Files:** modify `apps/api/src/services/trustPage/resolve.ts` (+ test), `apps/api/src/routes/trustPagePublic.ts` (+ test).

- [ ] **Step 1: Failing tests.** `resolve.test.ts`: `parseTrustSlugs('embed') → null` and `parseTrustSlugs('embed','acme') → null`; the rendered resolve SQL selects `embed_allowed_origins` (PgDialect rendering, as the W1 shape test does). `trustPagePublic.test.ts`: `card includes frameAncestors from the resolved page` (`['https://example.com']`); `card reflects an allowlist edit on the next request` (two calls, resolver mock returns different arrays); `card frameAncestors is [] when the column is empty`; `card is no-store` (`Cache-Control: no-store`; its only consumer is portal SSR, and a cached copy of a live policy is wrong — quorum A3); `card still answers 503 + Retry-After when the serving set is unknown` (W1 behaviour kept); `payload route Cache-Control unchanged`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/trustPage/resolve.test.ts src/routes/trustPagePublic.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Add `'embed'` to `TRUST_RESERVED_PARTNER_SLUGS` (comment: the portal's `/trust/embed/*` route shadows a partner slug `embed`; `validatePublishSlugs` already rejects reserved slugs). Add `embedAllowedOrigins: trustPages.embedAllowedOrigins` to the resolve select and `ResolvedTrustPage`. In `card()`, add `frameAncestors: r.embedAllowedOrigins` (never from the payload — it is live) and pass `'no-store'` to `publicHeaders` instead of `PUBLIC_CACHE`. Do not touch the badge route (its CORP fix is W03b's, at the `secureHeaders` boundary in `index.ts`). PR body: ask the deployer to run `SELECT id FROM partners WHERE slug = 'embed'` on each region before merge (Open Decision 8).
- [ ] **Step 4: Run** → PASS. Also `cd apps/api && npx vitest run src/routes/trustPagePublic src/services/trustPage` (substring: check the file count covers the W1 suites).
- [ ] **Step 5: Commit** — `feat(trust-center): live frameAncestors on the no-store card; reserve 'embed' (W3a)`.

### Task 4: Portal embed route, CSP carve-out, middleware

**Files:** create `apps/portal/src/lib/trustEmbed.ts` (+ test), `src/layouts/TrustEmbedLayout.astro`, `src/components/trust/TrustEmbedCard.astro`, `src/pages/trust/embed/[partnerSlug]/index.astro`, `src/pages/trust/embed/[partnerSlug]/[orgSlug].astro`; modify `src/lib/csp.ts` (+ test), `src/middleware.ts` (+ test), `src/env.d.ts`, `src/lib/disabledPageCoverage.test.ts`.

**Interfaces:** `getTrustEmbedCard(partnerSlug, orgSlug | null, config) → TrustEmbedCard | null` (uses the exported `apiGet` from `lib/api.ts` against `/trust/card/...`; type = W1 `TrustCard` fields + `frameAncestors: string[]`, declared in `trustEmbed.ts`, not in `api.ts`); `withFrameAncestors(csp, sources)`; `embedFramingHeaders(origins: readonly string[]): { frameAncestors: string; deleteXfo: boolean }`.

- [ ] **Step 1: Failing pure tests.** `csp.test.ts`:

```ts
it('replaces frame-ancestors, never merges', () => {
  const csp = "default-src 'self'; frame-ancestors 'none'; object-src 'none'";
  expect(withFrameAncestors(csp, ['https://example.com', 'https://www.example.com']))
    .toBe("default-src 'self'; frame-ancestors https://example.com https://www.example.com; object-src 'none'");
});
it("adds the directive when absent and falls back to 'none' for an empty list", () => {
  expect(withFrameAncestors("default-src 'self'", ['https://example.com'])).toBe("default-src 'self'; frame-ancestors https://example.com");
  expect(withFrameAncestors("frame-ancestors https://x.example", [])).toBe("frame-ancestors 'none'");
});
it('refuses a source that is not a normalized https origin', () => {
  expect(() => withFrameAncestors("frame-ancestors 'none'", ["https://example.com; script-src *"])).toThrow();
});
```

  `middleware.test.ts` (extend the W1 `/trust/` describe): `embed 200 with origins → CSP frame-ancestors lists them, no X-Frame-Options, Cache-Control no-store, X-Robots-Tag noindex`; `embed 200 with origins but CSP deleted (dev without CSP_STRICT_DEV) → X-Frame-Options DENY kept` (XFO is removed only when an enforced CSP carrying the allowlist was emitted — quorum A4); `embed 200 with no origins → frame-ancestors 'none' + XFO DENY + no-store`; `embed 404 → 'none' + DENY + no-store`; `full page /trust/nw/acme still DENY` (the W1 assertion at `middleware.test.ts:174` stays green); `preview still DENY`.
- [ ] **Step 2: Run** `cd apps/portal && npx vitest run src/lib/csp.test.ts src/middleware.test.ts src/lib/trustEmbed.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `withFrameAncestors` re-validates every source with the shared `normalizeEmbedOrigin` (defence in depth: a value that is not its own normalization throws), then rewrites the directive by splitting on `;`. Middleware: a `/trust/embed/` branch **before** the existing `/trust/` branch — always `Cache-Control: no-store` and `X-Robots-Tag: noindex`; when `response.status === 200 && (context.locals.trustEmbedOrigins?.length ?? 0) > 0 && decision.action === 'set'`: set CSP to `withFrameAncestors(decision.value, origins)` and `headers.delete('X-Frame-Options')`; in every other case CSP/XFO stay exactly as resolved (`'none'` + `DENY`). Pages: SSR `getTrustEmbedCard` (3 s timeout, as W1); `null` or empty `frameAncestors` → 404 response; else set `Astro.locals.trustEmbedOrigins = card.frameAncestors` and render `TrustEmbedLayout` (robots `noindex`, `<link rel="canonical">` to the full page via `publicOriginFor`, no `ClientRouter`, no islands) with `TrustEmbedCard` (logo `<img>`, org name, "Security posture · verified by Breeze", `summaryLine`, last verified date, a muted "Verification paused" line when `stale`, and a "View the full trust page" link `target="_blank" rel="noopener noreferrer"`). Accent colour, if used, goes through the nonced `<style>` exactly as `TrustPageLayout.astro:42` does. Add both pages to `UNAUTHENTICATED_PAGES` in `disabledPageCoverage.test.ts` with the comment "embed card is public by design; framing is limited to the page's allowlist". Add `trustEmbedOrigins?: string[]` to `App.Locals` in `env.d.ts`.
- [ ] **Step 4: Run** the three tests + `cd apps/portal && npx vitest run && npx astro check` → PASS (astro check: compare the error count against `main`; W1 recorded 7 pre-existing errors in `components/portal/*Form.tsx`).
- [ ] **Step 5: Commit** — `feat(portal): framable trust embed card with per-page frame-ancestors (W3a)`.

### Task 5: Web "Embed on your website" section

**Files:** create `apps/web/src/components/trustCenter/TrustEmbedSection.tsx` (+ test); modify `TrustCenterTab.tsx`, `src/lib/api/trustPage.ts`, `src/lib/__tests__/no-silent-mutations.test.ts` (add the new file to `TARGET_GLOBS`), `src/locales/<8>/organizations.json` (`orgRecord.trust.embed.*`).

- [ ] **Step 1: Failing component tests** (`TrustEmbedSection.test.tsx`): lists current origins from `page.embedAllowedOrigins`; add → client-side normalization preview (`https://Example.com/` shows `https://example.com`), invalid input shows the inline error and Save stays disabled; Save calls `updateTrustEmbedOrigins` through `runAction`; a 403 MFA response follows the same step-up path the publish dialog uses; `canWrite=false` → inputs `disabled` and handlers early-return; the iframe snippet is `<iframe src="<abs embed URL>" title="<escaped title>" width="100%" height="160" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>` and the copy button writes it; when the list is empty the snippet is replaced by "Add at least one website to enable embedding"; unpublished page shows the W1 "publish first" note.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/trustCenter/TrustEmbedSection.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the section (reuse `escapeHtmlAttr` from `TrustBadgeSnippet.tsx` by import, do not copy it); `updateTrustEmbedOrigins(orgFetch, orgId, origins)` in `lib/api/trustPage.ts`; mount after `TrustDocumentsSection` in `TrustCenterTab.tsx`. Locale keys in all 8 `organizations.json` files under `orgRecord.trust.embed` (title, description, originLabel, add, remove, save, saved, invalidOrigin, duplicateOrigin, maxReached, snippetLabel, copy, copied, copyFailed, emptyNote, unpublishedNote, mfaRequired, liveNote "Changes apply within a minute; no republish needed"). Real translations; no value identical to English (avoid bare "iframe"/"URL" values), so no baseline bump is needed in `translationCoverage.test.ts` (that file is W03c's).
- [ ] **Step 4: Run** the component test, `no-silent-mutations.test.ts`, the three i18n tests, then `cd apps/web && npx vitest run src/components/trustCenter` → PASS.
- [ ] **Step 5: Commit** — `feat(web): Trust Center embed allowlist editor and iframe snippet (W3a)`.

### Task 6: Docs, E2E, verification

**Files:** create `apps/docs/src/content/docs/security/trust-center-embed.mdx` (sidebar order 8); modify `apps/docs/src/content/docs/deploy/tls.mdx`; create `e2e-tests/tests/trust-center-embed.spec.ts`.

- [ ] **Step 1: Docs.** What the embed shows and never shows; exact-origin rules; changes apply on the next load of the embed (frames already open in a visitor's browser stay until reload); nested frames need every ancestor allowlisted; the full page is never framable; the badge alternative. `tls.mdx`: the nginx example's server-level `add_header X-Frame-Options "DENY" always;` gets a note — modern browsers obey CSP `frame-ancestors` over XFO, but a proxy that adds XFO **or its own Content-Security-Policy** to `/portal/trust/embed/` responses breaks embedding (a second restrictive CSP is enforced alongside the app's); exclude `location /portal/trust/embed/` from both.
- [ ] **Step 2: E2E** (worktree stack; `pnpm wt-stack up`). Publish the seeded org (reuse the W1 spec's login/MFA helpers from `e2e-tests/tests/trust-center.spec.ts`), set the allowlist to the stack's own web origin through the editor, then assert with `page.request.get(embedUrl)`: status 200, CSP header contains `frame-ancestors <origin>`, no `x-frame-options`; clear the list → the next request is 404. Full page request still has `x-frame-options: DENY`. `data-testid` selectors only.
- [ ] **Step 3: Verify** — API: `cd apps/api && npx vitest run src/routes/trustPage src/routes/trustPagePublic src/services/trustPage src/services/tenantExportPolicyRegistry`; full API unit suite `pnpm --filter @breeze/api test --run` (the merge-registry trap reds only in the full suite); typecheck with exit code; contract suites + rls-coverage + migrate×2 + drift (Global Constraints). Shared: `cd packages/shared && npx vitest run && npx tsc --noEmit`. Portal: `npx vitest run && npx astro check`. Web: full `npx vitest run`. E2E: `cd e2e-tests && npx playwright test tests/trust-center-embed.spec.ts tests/trust-center.spec.ts`. Tear down (`pnpm wt-stack down`, `pnpm test-stack down`) and report what is left running.
- [ ] **Step 4: Commit** — `docs(trust-center): embed guide and proxy note; e2e for the embed carve-out (W3a)`.

---

## W03b — Signed attestation (opus)

**Files:** see the sub-wave map. **Interfaces produced:** table `trust_signing_keys`; `ensureActiveTrustSigningKey(): Promise<ActiveTrustKey>`, `loadTrustJwks(): Promise<{ keys: JWK[] }>`, `prepareTrustSigningKey()`, `activateTrustSigningKey(kid)`, `revokeTrustSigningKey(kid)`; `signTrustAttestation(input: { resolved: ResolvedTrustPage; payload: TrustPagePublicPayload; canonicalUrl: string }): Promise<string>`; routes `GET /api/v1/trust/attestation/jwks.json`, `GET /api/v1/trust/attestation/:partnerSlug`, `GET /api/v1/trust/attestation/:partnerSlug/:orgSlug`; `isTrustCrossOriginPath(path: string): boolean` (API middleware); portal `trustAttestationPath(p, o | null)`.

**Attestation contract (fixed here; verifiers depend on it):**
- JOSE header: `{ alg: 'ES256', kid, typ: 'trust-attestation+jwt' }`.
- Claims: `iss` = origin of `DASHBOARD_URL || PUBLIC_APP_URL` (same precedence as `jobs/ticketNotifyWorker.ts:125`; deployment configuration only, never request headers); `sub` = canonical public page URL (`<iss>/portal/trust/<p>[/<o>]`); `aud` absent; `iat` = signing time; `exp` = `min(iat + 3600, lastEvaluatedAt + 86400)` (Open Decision 3); `jti` = random UUID per issued token; `trust` = `{ v: 1, payload: <the exact public payload object>, lastEvaluatedAt: string }`. The snapshot id travels inside `payload`.
- A page whose `lastEvaluatedAt` is null or older than 24 h (stale) gets **no** token: 503 `{ code: 'ATTESTATION_STALE' }` + `Retry-After: 3600` + `no-store`.
- Media types: attestation `application/jwt`; JWKS `application/jwk-set+json`.
- Caching: attestation `public, max-age=min(60, exp − now)`; JWKS `public, max-age=600`; every non-200 `no-store`. Server-side token cache key `trust:attest:<kid>:<sha256(sub)>:<snapshotId>:<lastEvaluatedAt epoch>`, TTL `min(300, exp − now − 60)` s (skip caching when that is ≤ 0).
- In production, if neither `DASHBOARD_URL` nor `PUBLIC_APP_URL` is set, the attestation route answers 503 rather than sign with a localhost issuer.

### Task 1: Keyset table and key service

**Files:** create migration `2026-12-30-110500-trust-signing-keys.sql`, `src/db/schema/trustSigningKeys.ts`, `src/services/trustPage/attestationKeys.ts` (+ test), `src/__tests__/integration/trustSigningKeys.integration.test.ts`; modify `src/db/schema/index.ts`, `src/services/encryptedColumnRegistry.ts`, `src/__tests__/integration/rls-coverage.integration.test.ts`.

- [ ] **Step 1: Failing unit tests** (`attestationKeys.test.ts`, db and crypto mocked as `manifestSigning` tests do): `ensureActiveTrustSigningKey generates an ES256 P-256 key when the table is empty, stores the public JWK without d, encrypts the private JWK with AAD trust_signing_keys.private_key_enc`; `rows exist but none is active → throws TrustAttestationUnavailable and does NOT generate` (bootstrap only when no key ever existed — quorum B1); `a concurrent first insert (23505 on the partial unique index) re-reads the winner instead of failing`; `loadTrustJwks returns pending + active + verify_only keys, never revoked, never private fields (no d/p/q/dp/dq/qi)`; `activate(kid) moves the current active to verify_only and nulls its private_key_enc in one transaction`; `activate refuses a kid that is not pending`; `activate refuses when the pending key is younger than the JWKS max-age (600 s) unless --force`; `revoke(kid) marks it revoked and nulls the private key; with --replace it also creates and activates a successor in the same transaction; without --replace no active key remains`; `the keyset cache (TTL 60 s per instance) is invalidated locally on prepare/activate/revoke`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/trustPage/attestationKeys.test.ts` → FAIL.
- [ ] **Step 3: Migration** (DDL only; mirror `2026-05-09-manifest-signing-keys.sql`): enum `trust_signing_key_status` (`pending`, `active`, `verify_only`, `revoked`) via `DO $$ … EXCEPTION WHEN duplicate_object`; table `trust_signing_keys (id uuid pk default gen_random_uuid(), kid text NOT NULL UNIQUE, alg text NOT NULL DEFAULT 'ES256' CHECK (alg = 'ES256'), public_jwk jsonb NOT NULL, private_key_enc text NULL, status trust_signing_key_status NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), activated_at timestamptz, retired_at timestamptz, revoked_at timestamptz, CHECK (status IN ('verify_only','revoked') OR private_key_enc IS NOT NULL))`; `CREATE UNIQUE INDEX IF NOT EXISTS trust_signing_keys_one_active_uq ON trust_signing_keys(status) WHERE status = 'active'`; `ENABLE` + `FORCE ROW LEVEL SECURITY`; one policy `trust_signing_keys_system_only USING (current_setting('breeze.scope', true) = 'system') WITH CHECK (same)` created inside a `pg_policies` existence check. No `org_id`/`partner_id`, so no cascade, merge or export registration.
- [ ] **Step 4: Implement** the service. Keys: `jose` `generateKeyPair('ES256', { extractable: true })` + `exportJWK`; `kid` = `trust-` + base64url(SHA-256 of the canonical public JWK `{crv,kty,x,y}`) first 16 chars (RFC 7638 thumbprint via `calculateJwkThumbprint`). Encrypt with `encryptSecret(JSON.stringify(privateJwk), { aad: 'trust_signing_keys.private_key_enc' })`; decrypt with `decryptForColumn('trust_signing_keys', 'private_key_enc', …)`. All DB access inside `runOutsideDbContext(() => withSystemDbAccessContext(…))`. Cache the keyset with the same `HotPathTtlCache` pattern as `manifestSigning.ts:244` (TTL 60 s). Register `{ table: 'trust_signing_keys', column: 'private_key_enc', kind: 'text', description: 'Trust attestation ES256 private JWK (W3b)' }` in `encryptedColumnRegistry.ts`. Schema file + barrel line in `schema/index.ts`.
- [ ] **Step 5: rls-coverage registration.** Add `'trust_signing_keys'` to `EXEMPT_TABLES` and to `INTENTIONAL_UNSCOPED` with the comment "Per-deployment trust-attestation signing keys (Trust Center W3b, #8771). No tenant column. Forced RLS, single system-only policy. No org_id, so no cascade/merge/export registration." Integration test `trustSigningKeys.integration.test.ts`: as `breeze_app` under an org-scoped context, `SELECT` returns 0 rows and `INSERT` fails with 42501; under system scope both succeed; two concurrent `ensureActiveTrustSigningKey` calls leave exactly one `active` row.
- [ ] **Step 6: Run** the unit test, then with the test stack up: migrate×2, drift, `trustSigningKeys.integration.test.ts`, `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` → PASS.
- [ ] **Step 7: Commit** — `feat(trust-center): per-deployment ES256 attestation keyset, system-only (W3b)`.

### Task 2: Signing and the rotation CLI

**Files:** create `src/services/trustPage/attestation.ts` (+ test), `apps/api/scripts/trust-signing-key.ts`; modify `apps/api/package.json` (`"trust:signing-key": "tsx scripts/trust-signing-key.ts"`).

- [ ] **Step 1: Failing tests** (`attestation.test.ts`, real `jose`, key from `generateKeyPair` in the test, fake timers): `signs a compact JWT whose header is { alg: 'ES256', kid, typ: 'trust-attestation+jwt' }`; `claims carry iss, sub, iat, jti (uuid), trust.v = 1, trust.payload deep-equals the input payload`; `exp = iat + 3600 when lastEvaluatedAt is fresh`; `exp = lastEvaluatedAt + 86400 when that is sooner`; `stale or null lastEvaluatedAt → throws TrustAttestationStale`; `two tokens issued without the cache have different jti`; `verifies with jwtVerify(token, createLocalJWKSet(jwks), { algorithms: ['ES256'], typ: 'trust-attestation+jwt', issuer, subject })`; `verify-only key stays in JWKS after activate` (sign with key A, activate key B, the A-signed token still verifies against the new JWKS); `revoked key's token no longer verifies`; `cache hit returns the same string without signing`; `cache key changes with sub (slug rename), lastEvaluatedAt and kid`; `cache TTL never outlives exp − 60 s`; `production without DASHBOARD_URL/PUBLIC_APP_URL throws TrustAttestationUnavailable`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/trustPage/attestation.test.ts` → FAIL.
- [ ] **Step 3: Implement** `signTrustAttestation` with `jose` `SignJWT` (`setProtectedHeader({ alg: 'ES256', kid, typ: 'trust-attestation+jwt' })`, `.setJti(randomUUID())`), cached under the contract's key and TTL (Redis errors are logged and skipped, never fatal; Redis calls after the DB context closes). CLI `scripts/trust-signing-key.ts` subcommands `list`, `prepare`, `activate <kid> [--force]`, `revoke <kid> [--replace]` — each prints the resulting keyset (kid, status, dates; never private material) and writes an `audit_logs` system entry `trust_signing_key.<action>`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(trust-center): sign published payloads as trust attestations; rotation CLI (W3b)`.

### Task 3: Attestation router, JWKS, and the cross-origin header exception (includes the W1 badge fix)

**Files:** create `src/routes/trustPageAttestation.ts` (+ test), `src/middleware/trustCrossOrigin.ts` (+ test); modify `src/index.ts`, `src/middleware/globalRateLimit.ts` (+ test), `src/middleware/partnerGuard.ts` (+ test), `src/__tests__/routerAuthGate.contract.test.ts`, `src/services/mcpCoverage.ts`.

**Why the header exception lives here.** Hono `secureHeaders` writes its headers after `await next()` (`hono@4.13.5/dist/middleware/secure-headers/secure-headers.js:85-86`), so any `Cross-Origin-Resource-Policy` a handler sets is overwritten with `same-origin`. That breaks the W1 badge on customer websites today (inferred from code; confirm in a browser during Step 4) and would break attestation/JWKS fetches. The exception must be applied where `secureHeaders` is registered (`index.ts:500-513`), which is this sub-wave's file.

- [ ] **Step 1: Failing tests.** `trustCrossOrigin.test.ts`: `isTrustCrossOriginPath` is true for `/api/v1/trust/attestation/...` and for `/api/v1/trust/public/<p>/<o>/badge.svg`, false for `/api/v1/trust/public/<p>/<o>` (payload), `/api/v1/trust/card/...`, and `/api/v1/trust/public/<p>/<o>/documents/<id>`. An app-level test (build the real middleware chain from `index.ts`'s exported app or a minimal Hono app with the same two registrations): `badge.svg response carries Cross-Origin-Resource-Policy: cross-origin`; `attestation response carries cross-origin`; `payload response keeps same-origin`. `trustPageAttestation.test.ts` (mocks as `trustPagePublic.test.ts`): `GET /jwks.json → 200 application/jwk-set+json, public, max-age=600, Access-Control-Allow-Origin *, no Access-Control-Allow-Credentials, never empty` (it provisions first); `GET /:p/:o for a serving page → 200 application/jwt, verifies against /jwks.json, Cache-Control max-age ≤ 60 and ≤ exp − now, X-Robots-Tag noindex`; `GET /:p (partner home)`; `unknown / unpublished / untrusted / invalid slug / reserved slug → the generic 404 with no-store` (identical bodies and headers across causes); `serving-set miss → 404 without a SQL call`; `Redis down → falls through to the live resolve` (rate-limited path, like the payload route); `no current snapshot → 404`; `stale page → 503 ATTESTATION_STALE, Retry-After 3600, no-store`; `attestation from a rotated-out kid verifies against the JWKS`; `issuer unavailable or no active key → 503 no-store`. `globalRateLimit.test.ts`: `/api/v1/trust/attestation/` maps to bucket `trustattest` limit 60. `partnerGuard.test.ts`: the prefix is exempt. `routerAuthGate.contract.test.ts`: `trustPageAttestationRoutes` in `EXEMPT` ("public, unauthenticated attestation of an already-public payload; generic 404").
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/middleware/trustCrossOrigin.test.ts src/routes/trustPageAttestation.test.ts src/middleware/globalRateLimit.test.ts src/middleware/partnerGuard.test.ts src/__tests__/routerAuthGate.contract.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `index.ts`: register two `secureHeaders` instances behind one dispatcher — the existing options for every path, and the same options plus `crossOriginResourcePolicy: 'cross-origin'` when `isTrustCrossOriginPath(c.req.path)` — keeping the `exceptTunnelHttp` wrapper. Router: declare `GET /jwks.json` first (`.` fails the slug regex, so no partner slug can collide); admission duplicates W1's `admit()` semantics with the exported building blocks only (`parseTrustSlugs`, `isServing`, `trustServingMember`, `resolvePublishedTrustPage`, `readCachedSnapshotPayload`, `cacheSnapshotPayload`) — do not import from or edit `trustPagePublic.ts`; non-serving → generic 404 + `no-store`; catch-all `.all('/*')` → generic 404 registered last. Headers: set `Access-Control-Allow-Origin: *` and delete `Access-Control-Allow-Credentials` in the handler (the global `cors()` runs with `credentials: true`; `*` with credentials is rejected by browsers). Mount `api.route('/trust/attestation', trustPageAttestationRoutes)` **before** `api.route('/trust', trustPagePublicRoutes)` in `index.ts` with a comment tying it to the W1 block at `index.ts:773-779`. Bucket `{ prefix: '/api/v1/trust/attestation/', name: 'trustattest', limit: 60 }`; partnerGuard exempt prefix next to the W1 line 35; mcpCoverage line `'trustPageAttestation.ts': { exempt: 'portal', note: 'Unauthenticated signed copy of the public trust payload plus its JWKS; read by insurer/auditor tooling, not a tool surface.' }` inserted directly after `'trustPagePublic.ts'`.
- [ ] **Step 4: Run** the four tests, then `cd apps/api && npx vitest run src/__tests__/mcp-coverage.test.ts src/extensions/reservedRouteNamespaces.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(trust-center): public attestation and JWKS routes (W3b)`.

### Task 4: Discoverability, docs, verification

**Files:** create `apps/portal/src/lib/trustAttestation.ts` (+ test); modify `src/layouts/TrustPageLayout.astro` (+ test), `src/pages/trust/[partnerSlug]/index.astro`, `src/pages/trust/[partnerSlug]/[orgSlug].astro`; create `apps/docs/src/content/docs/security/trust-center-attestation.mdx` (sidebar order 9).

- [ ] **Step 1: Failing tests.** `trustAttestation.test.ts`: `trustAttestationPath('nw','acme') === publicApiPath('/trust/attestation/nw/acme')`, partner home without the org segment, slugs URL-encoded. `TrustPageLayout.test.ts`: renders `<link rel="alternate" type="application/jwt" href="…">` when `alternateJwtHref` is set and nothing when it is not.
- [ ] **Step 2: Run** `cd apps/portal && npx vitest run src/lib/trustAttestation.test.ts src/layouts/TrustPageLayout.test.ts` → FAIL.
- [ ] **Step 3: Implement** the optional `alternateJwtHref` prop; both slug pages pass it when the card loaded and render, below the island, a plain footer line "Machine-readable, signed copy: <a href>…</a> · Verification keys: <a href>jwks.json</a>" (no inline styles, `withBase` not needed: these are API paths built by `publicApiPath`). Docs: what the attestation proves (this Breeze installation computed this payload at this time) and does not (no certification; on a self-hosted install the operator controls both the evidence and the signer, so it is an installation attestation, not independent assurance); the contract (header, claims, media types, stale → 503); verification recipes that check **signature, `alg` = ES256, `typ`, `iss`, `sub` and `exp`** — Node (`jose` `createRemoteJWKSet` + `jwtVerify` with `algorithms`, `typ`, `issuer`, `subject`), Python (`PyJWT` + `PyJWKClient`, `algorithms=['ES256']`, `issuer=`, then a `sub` check), .NET (`Microsoft.IdentityModel.JsonWebTokens` + `JsonWebKeySet`, `ValidIssuer`, `ValidTypes`); archival verification of an expired token (verify the signature and dates; it is a historical statement, not a current one); self-hosting ("nothing to configure; keys are created on first use and encrypted with `APP_ENCRYPTION_KEY` — set `APP_ENCRYPTION_KEY_ID` so the ciphertext is bound to its column; set `DASHBOARD_URL` so the issuer is right"); the rotation runbook (`pnpm --filter @breeze/api trust:signing-key prepare` → wait ≥ 10 min (JWKS max-age) → `activate <kid>`; compromise: `revoke <kid> --replace`, and verifiers that cache the JWKS stop trusting the key within 10 minutes).
- [ ] **Step 4: Verify** — full API unit suite, typecheck with exit code, the integration + rls-coverage + migrate×2 + drift set; portal `npx vitest run && npx astro check`. Manual checks on the worktree stack, output pasted in the PR body: `curl -s <stack>/api/v1/trust/attestation/<p>/<o> | cut -d. -f1 | base64 -d` shows the header; the Node recipe from the docs verifies the token against `/jwks.json`; `curl -sI` on `badge.svg` shows `cross-origin-resource-policy: cross-origin`; a static HTML file served from a different origin renders the badge `<img>` in a browser (Playwright `page.setContent` on `about:blank` with the absolute badge URL, assert `naturalWidth > 0`).
- [ ] **Step 5: Commit** — `feat(portal): link the signed attestation from the trust page; attestation docs (W3b)`.

---

## W03c — Questionnaire export (sonnet)

**Format decision:** CSV (questionnaires are spreadsheets; every insurer portal accepts a paste from CSV) and JSON (the same rows plus page metadata, for tooling that does not want the JWS). Both are derived from the **published** payload only, so the export can never say more than the public page. The JWS (W03b) is the verifiable machine format; the export is the convenience format. Open Decision 6 records the alternatives.

**Interfaces produced:** `TRUST_QUESTIONNAIRE_FORMAT_VERSION = 1`; `TRUST_QUESTIONNAIRE_QUESTIONS: Readonly<Record<TelemetryControlId, string>>`; `buildTrustQuestionnaireRows(input: { payload: TrustPagePublicPayload; lastEvaluatedAt: string | null; stale: boolean; pageUrl: string }): TrustQuestionnaireRow[]`; `trustQuestionnaireCsv(input): string`; `trustQuestionnaireJson(input): TrustQuestionnaireDocument`.

`TrustQuestionnaireRow` = `{ controlId, category, question, answer: 'Yes' | 'Partially' | 'No' | 'Not assessed', status, reason, basis, devicesAssessed: number | null, devicesEligible: number | null, percent: number | null, evidenceAsOf: string | null, frameworkRefs: string /* "cis_v8 10.1; nist_csf_2 PR.PS" */, verificationPaused: boolean }`. CSV header (exact, in order): `control_id,category,question,answer,status,reason,basis,devices_assessed,devices_eligible,percent,evidence_as_of,framework_refs,verification_paused,page_url,snapshot_id,generated_at,published_at`. JSON document: `{ format: 'breeze-trust-questionnaire', version: 1, pageUrl, org: { name }, snapshotId, generatedAt, publishedAt, lastEvaluatedAt, stale, summary, methodology, disclaimer, rows }`. Disclaimer (exact): `Evidence summary computed by Breeze RMM from device telemetry. Not a certification or attestation of compliance.`

### Task 1: Shared serializer

**Files:** create `packages/shared/src/trustCenter/questionnaireExport.ts` (+ test); modify `packages/shared/src/trustCenter/index.ts`.

- [ ] **Step 1: Failing tests** (`questionnaireExport.test.ts`, fixtures built with `trustPagePublicPayloadSchema.parse`): `one row per shown control, in payload order`; `answer mapping met→Yes, attention→Partially, not_met→No, not_assessed→Not assessed with reason`; `basis for telemetry rows is "Continuously verified by Breeze RMM telemetry"`; `percent/devices columns are empty when the payload nulls them (show_percentages off)`; `verification_paused is true for every row when stale`; `framework_refs joins framework ids and refs`; `every shown control has a question` (iterate `TELEMETRY_CONTROL_IDS`); `CSV header matches exactly`; `neutralizes formula prefixes in every column` (org name `=HYPERLINK(...)` in a fixture, a ref beginning `+`) via the shared `csvRow`; `JSON document validates its own shape and carries the exact disclaimer`; `questions never contain "compliant", "certified" or "meets"`. **Declared branch** (after W02's declared payload lands): `a declared control row has basis "Declared by <MSP> on <date>, expires <date>"` using W02's declared fields — the exact field names come from W02's payload schema; if W02 has not merged when this task runs, stop and report NEEDS_CONTEXT (Dependencies on W02).
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/trustCenter/questionnaireExport.test.ts` → FAIL.
- [ ] **Step 3: Implement** with the shared `csvRow`/`toCsv` from `utils/csvExport.ts` (no hand-rolled escaping). Questions are Breeze's own plain-English wording, one per control, e.g. `endpoint_protection`: "Is anti-malware with real-time protection active on managed devices?"; `mfa_registered_m365`: "Are Microsoft 365 users registered for multi-factor authentication?"; `backups_verified`: "Are backups verified as restorable?". Export from the `trustCenter` barrel.
- [ ] **Step 4: Run** → PASS; `cd packages/shared && npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(shared): trust questionnaire CSV/JSON serializer over the published payload (W3c)`.

### Task 2: Editor download menu

**Files:** create `apps/web/src/lib/trustExport.ts` (+ test), `apps/web/src/components/trustCenter/TrustExportMenu.tsx` (+ test), `apps/web/src/locales/<8>/trustCenter.json`; modify `TrustStatusCard.tsx` (+ test), `src/lib/i18n/translationCoverage.test.ts`.

- [ ] **Step 1: Failing tests.** `trustExport.test.ts`: `fetchPublishedTrustPayload builds /api/v1/trust/public/<p>/<o> (partner home: /<p>) and returns { payload, lastEvaluatedAt, stale }`; `404 → null`; `downloadTrustQuestionnaire('csv') creates a text/csv;charset=utf-8 Blob named trust-questionnaire-<orgSlug>-<YYYY-MM-DD>.csv` (JSON: `application/json`, `.json`). `TrustExportMenu.test.tsx`: `disabled with the unpublished note when publishedAt is null`; `CSV and JSON buttons call the download with the right format`; `a failed fetch shows an error toast` (GET only: no `runAction`, so no `TARGET_GLOBS` entry). `TrustStatusCard.test.tsx`: the menu renders for published pages.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/lib/trustExport.test.ts src/components/trustCenter/TrustExportMenu.test.tsx src/components/trustCenter/TrustStatusCard.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** Fetch with the same API base the web client uses (find it in `src/lib/api`; the public route needs no auth), slugs from the GET state (`slugs.partnerSlug`, `slugs.orgSlug`, `page.isPartnerHome`), page URL from `trustPublicUrl(publicPath)`. New namespace `trustCenter.json` in all 8 locales: `export.title`, `export.csv`, `export.json`, `export.unpublishedNote`, `export.failed`, `export.publishedOnlyNote` ("Exports what your public page shows"). Add `'trustCenter.json': 0` to each of the 7 translated locales' maps in `namespaceDuplicateBaselines` (`translationCoverage.test.ts` asserts the key set equals the namespace set).
- [ ] **Step 4: Run** the tests + the three i18n tests + `cd apps/web && npx vitest run` → PASS.
- [ ] **Step 5: Docs** — create `apps/docs/src/content/docs/security/trust-center-questionnaire.mdx` (sidebar order 10): columns, answer mapping, "published page only", spreadsheet-injection neutralization, pointer to the signed attestation for verifiable copies.
- [ ] **Step 6: Commit** — `feat(web): download trust questionnaire answers (CSV/JSON) from the editor (W3c)`.

---

## W03d — Portal self-edit (opus)

**Gate (Open Decision 1):** a portal user may edit when (a) the org's `portal_branding.enable_trust_page_editing` is true, (b) the portal user's `contact_id` has a `contact_roles` row with `role = 'admin'`, `site_id IS NULL`, `device_group_id IS NULL`, same `org_id`, and (c) the page exists, is not the partner-home page, and the portal user's account is active. Checked fresh on every request, never cached in the session (precedent: `decideApprovalRequest` re-checks `portal_users`). A null `contact_id` (Entra/add-in logins without a contact) is not an admin.

**What a customer admin can do (Open Decision 2):** edit the draft subset `securityContactEmail`, `websiteUrl`, `hiddenControlIds`, `showPercentages`, `showDeviceCount`; mint a preview token; unpublish (withdraw consent). **Not:** publish (no MFA in the portal; publish needs MFA, the partner trust capability and the attestation), intro HTML, documents, partner-home, embed allowlist. Edits reach the public page only through the MSP's next publish (Ruling 20).

**Interfaces produced:** portal flag `enableTrustPageEditing`; `isPortalTrustPageEditor(portalUser): Promise<boolean>`; `requirePortalTrustPageEditor` middleware (403 `PORTAL_TRUST_EDITING_DISABLED` when the flag is off, 403 `PORTAL_TRUST_EDITOR_REQUIRED` when not an admin); `applyTrustPageDraftPatch(pageId, patch: TrustPagePortalDraftPatch, actor: { kind: 'portal_user'; id: string }): Promise<TrustPageRow>`; routes under `/api/v1/portal/trust-page`: `GET /`, `PUT /`, `POST /preview-token`, `POST /unpublish`; feature-flags response field `canEditTrustPage: boolean`.

### Task 1: The flag

**Files:** create migration `2026-12-30-110700-portal-branding-trust-page-editing.sql`; modify `src/db/schema/portal.ts`, `tenantExportPolicyRegistry.ts` (`"portal_branding"` entry), `tenantExportPolicyRegistry.portalBranding.test.ts`, `src/services/portal/portalFlags.ts` (+ test), `src/routes/orgPortalSettings.ts` (+ test), `packages/shared/src/validators/portal.ts` (+ test), `packages/shared/src/types/portalVisibility.ts`, `apps/web/src/components/settings/OrgPortalSettingsEditor.tsx` (+ test), `apps/web/src/locales/<8>/settings.json`.

- [ ] **Step 1: Failing tests** — follow every assertion the `enableEdrVisibility` flag added (the file list in the sub-wave map is that flag's footprint): shared schema accepts `enableTrustPageEditing: boolean`; the flag is **not** in the "Enable all" set (`PORTAL_VISIBILITY_FLAG_KEYS` stays unchanged; a separate `PORTAL_PERMISSION_FLAG_KEYS = ['enableTrustPageEditing']`); `PATCH /orgs/:orgId/portal-settings` persists it (MFA already required there); the export-policy test classifies `enable_trust_page_editing` as `included`; the web editor shows the toggle with its help text and saves it.
- [ ] **Step 2: Run** the touched tests → FAIL.
- [ ] **Step 3: Implement.** Migration (DDL only, mirrors `2026-12-25-180000-portal-branding-enable-edr-visibility.sql`): `ALTER TABLE portal_branding ADD COLUMN IF NOT EXISTS enable_trust_page_editing boolean NOT NULL DEFAULT false;` + `COMMENT ON COLUMN` ("Let the customer's org-admin contacts edit parts of the trust page draft from the portal. Off by default."). Web locale keys in all 8 `settings.json` (label, help text that names the admin-contact requirement and that publishing stays with the MSP).
- [ ] **Step 4: Run** → PASS; contract suites + migrate×2 + drift.
- [ ] **Step 5: Commit** — `feat(portal): enableTrustPageEditing portal flag (W3d)`.

### Task 2: Gate and draft-patch service

**Files:** create `src/services/portal/trustPageEditor.ts` (+ test), `src/services/trustPage/draftPatch.ts` (+ test).

- [ ] **Step 1: Failing tests.** `trustPageEditor.test.ts`: `flag off → false`; `contactId null → false`; `admin role scoped to a site → false`; `admin role scoped to a device group → false`; `admin role for another org → false`; `org-scoped admin + flag on → true`; `portal user status disabled → false`; `the lookup runs every call (no memo)`. `draftPatch.test.ts`: `applies only the five portal fields` (strict schema `trustPagePortalDraftPatchSchema` defined in this file; `introHtml` / `isPartnerHome` / `embedAllowedOrigins` rejected); `bumps publication_revision`; `does not overwrite updated_by_user_id` (that column references `users`, portal users are not users; attribution lives in the audit entry); `hiddenControlIds validated against TELEMETRY_CONTROL_IDS`; `websiteUrl https only, contact email max 320`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/portal/trustPageEditor.test.ts src/services/trustPage/draftPatch.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `isPortalTrustPageEditor` = one query joining `portal_branding` (flag) and `contact_roles` (role, scope) under the request's org context. `applyTrustPageDraftPatch` mirrors the field handling of the staff `PUT /:orgId/trust-page` (`routes/trustPage.ts:73-95`) for the five fields and bumps the revision with `sql\`${trustPages.publicationRevision} + 1\``. Do not edit `routes/trustPage.ts` (W03a owns it); switching the staff route to this helper is a follow-up.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(trust-center): portal trust-page editor gate and draft-patch service (W3d)`.

### Task 3: Portal routes

**Files:** create `src/routes/portal/trustPage.ts` (+ test), `src/__tests__/integration/portalTrustPageEditing.integration.test.ts`; modify `src/routes/portal/index.ts`, `src/routes/portal/featureFlags.ts` (+ test), `src/services/mcpCoverage.ts`.

- [ ] **Step 1: Failing tests** (`trustPage.test.ts` alongside the portal route tests, using their auth helpers): `GET without a session → 401`; `flag off → 403 PORTAL_TRUST_EDITING_DISABLED`; `non-admin → 403 PORTAL_TRUST_EDITOR_REQUIRED`; `no trust page → 200 { page: null }` (the portal never creates the row); `partner-home page → 403 PORTAL_TRUST_EDITOR_REQUIRED`; `GET returns the five fields, publishedAt, publicationRevision, publicPath — and never publishedConfig, authorization or user ids`; `PUT applies the patch and writes portal audit portal.trust_page.update with the portal user as actor`; `PUT without the CSRF header (cookie auth) → 403` (`validatePortalCookieCsrfRequest`); `POST /preview-token returns a W1 preview token for this page only`; `POST /unpublish requires { confirm: true }, clears published_at, bumps the revision, removes the serving member after commit, audits portal.trust_page.unpublish`; `feature-flags response carries canEditTrustPage`. Integration (`portalTrustPageEditing.integration.test.ts`, real Postgres): `portal edit bumps the revision; publish with the old revision 409s`; a portal user of org B cannot read or write org A's page (RLS + route) — expect 404/0 rows, never 200.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/portal/trustPage.test.ts src/routes/portal/featureFlags.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Mount in `routes/portal/index.ts`: `portalRoutes.use('/trust-page/*', requirePortalTrustPageEditor)` (and on `/trust-page`) after `portalAuthMiddleware`, then `portalRoutes.route('/trust-page', portalTrustPageRoutes)`. Unpublish calls the W1 `unpublishTrustPage` (exported from `publication.ts`, no edit) with `actorUserId: null` if its signature allows, otherwise performs the same transaction locally — **check the signature first**; if it requires a `users.id`, implement the local transaction and note the follow-up to accept a portal actor. Serving-set removal after commit via `scheduleServingRefreshForPartner` (W1 Ruling 28 pattern). `canEditTrustPage` computed in `featureFlags.ts` with `isPortalTrustPageEditor`. mcpCoverage: `'portal/trustPage.ts': { exempt: 'portal', note: 'Customer org-admin edits of their own trust page draft (Trust Center W3d); human-only, publishing stays with the MSP.' }` directly after `'portal/tickets.ts'`.
- [ ] **Step 4: Run** the unit tests, `src/__tests__/mcp-coverage.test.ts`, and the integration test with the test stack up → PASS.
- [ ] **Step 5: Commit** — `feat(portal-api): customer admin trust-page draft edit, preview and withdraw (W3d)`.

### Task 4: Portal editor page

**Files:** create `apps/portal/src/pages/security/trust-page.astro`, `src/components/trust/TrustPageEditor.tsx` (+ test), `src/lib/trustEditorApi.ts` (+ test); modify `src/lib/api.ts` (feature-flags type `canEditTrustPage`), `src/lib/navItems.ts` (+ test).

- [ ] **Step 1: Failing tests.** `trustEditorApi.test.ts`: GET/PUT/POST paths under `/portal/trust-page`, CSRF header sent on mutations (reuse `apiPut`/`apiPost`). `TrustPageEditor.test.tsx`: renders the five fields; Save sends only changed fields with the loaded revision; a 409 reloads and shows "Your provider changed this page; review and save again"; Preview opens `/trust/preview/<token>` via `withBase`; Unpublish requires typing the org name before `confirm: true` is sent; the copy states "Your provider publishes your changes" and never offers Publish. `navItems.test.ts`: the "Trust page" item appears under Security only when `canEditTrustPage`.
- [ ] **Step 2: Run** `cd apps/portal && npx vitest run src/lib/trustEditorApi.test.ts src/components/trust/TrustPageEditor.test.tsx src/lib/navItems.test.ts` → FAIL.
- [ ] **Step 3: Implement.** The page frontmatter branches on the two 403 codes (redirect to `/security` with no misleading error, as `disabledPageCoverage.test.ts` demands of gated pages); `/security` is already in `PORTAL_PROTECTED_PREFIXES`, so neither `protectedPaths.ts` nor `disabledPageCoverage.test.ts` changes. English copy. No inline styles.
- [ ] **Step 4: Run** + `cd apps/portal && npx vitest run && npx astro check` → PASS.
- [ ] **Step 5: Commit** — `feat(portal): trust page editor for customer admins (W3d)`.

### Task 5: Docs, E2E, verification

- [ ] **Step 1: Docs** — create `apps/docs/src/content/docs/security/trust-center-portal-editing.mdx` (sidebar order 11): enabling the flag, who qualifies (org-scoped admin contact with a portal login), what they can and cannot change, that the MSP publishes, withdrawal.
- [ ] **Step 2: E2E** `e2e-tests/tests/trust-center-portal-edit.spec.ts`: MSP enables the flag and gives the seeded portal user's contact the `admin` role (reuse existing contact-role helpers or the API), portal user edits the contact email, MSP editor reload shows the new draft value, MSP publish succeeds with the fresh revision; portal user unpublishes; public URL 404s.
- [ ] **Step 3: Verify** — full API unit suite (the portal `index.ts` mount is a full-suite trap), typecheck with exit code, contract suites + rls-coverage + migrate×2 + drift, portal + web full vitest, astro check, the E2E. Tear down stacks and report.
- [ ] **Step 4: Commit** — `docs(trust-center): portal editing guide; e2e for customer edits (W3d)`.

---

## W03e — Benchmark safeguards (sonnet; mapping review on opus)

**Model.** The agent runs a fixed set of CIS Benchmark checks per OS (`agent/internal/cis/checks_{windows,linux,darwin,darwin_sharing}.go`: 10 Windows, 10 Linux, 23 macOS ids today). Each check implements one or more Benchmark recommendations, and CIS publishes, per recommendation, the CIS Controls v8 safeguards it maps to. W03e records that mapping as data keyed by **(device OS, agent check id)** — not by `cis_baselines.benchmark_version`, which is free text (`routes/cisHardening.ts:64`) and does not select the check set. Licensing is the §18.13 question: identifiers and Breeze's own labels only, and the whole expansion renders only when W02's CIS gate is on.

**Interfaces produced:** `CIS_BENCHMARK_CHECK_SAFEGUARDS: Readonly<Record<'windows' | 'macos' | 'linux', Readonly<Record<string, readonly string[]>>>>` and `CIS_BENCHMARK_MAPPING_SOURCES` (re-exported through `frameworkCrosswalk.ts`, not the barrel); `ControlEvidence.safeguards?: Record<string /* cis_v8 ref */, { eligible: number; assessed: number; passing: number; newestEvidenceAt: string | null }>`; `TrustControlAssessment.safeguards?: TrustSafeguardAssessment[]` with `TrustSafeguardAssessment = { framework: 'cis_v8'; ref: string; status; reason; percent: number | null; assessed: number; eligible: number }`; payload control field `safeguards` (optional, only on `hardening_baseline`).

### Task 1: The mapping table (opus reviews; a human verifies)

**Files:** create `packages/shared/src/trustCenter/benchmarkSafeguards.ts` (+ test), `apps/api/src/services/cisBenchmarkSafeguards.contract.test.ts`; modify `packages/shared/src/trustCenter/frameworkCrosswalk.ts`.

- [ ] **Step 1: Failing tests.** `benchmarkSafeguards.test.ts`: `every mapped ref resolves in FRAMEWORK_CROSSWALK.cis_v8`; `refs are unique per check`; `CIS_BENCHMARK_MAPPING_SOURCES names, per OS, the benchmark title and version and the date the mapping was verified`; `no label contains a verbatim recommendation title` (no `Ensure '` prefix, no quoted setting values). `cisBenchmarkSafeguards.contract.test.ts` (API, reads the Go sources): `every agent check id in checks_<os>.go has an entry in CIS_BENCHMARK_CHECK_SAFEGUARDS[os]` (an empty array is an allowed, explicit "not mapped"); `no entry names a check the agent does not run`. Regex for ids: `/\bID:\s*"([0-9][0-9.]*)"/g` over `checks_windows.go`, `checks_linux.go`, `checks_darwin.go` + `checks_darwin_sharing.go`.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/trustCenter/benchmarkSafeguards.test.ts`; `cd apps/api && npx vitest run src/services/cisBenchmarkSafeguards.contract.test.ts` → FAIL.
- [ ] **Step 3: Populate the table from the official mappings.** For each agent check, read the recommendation(s) it implements in the CIS Benchmark PDF named in `CIS_BENCHMARK_MAPPING_SOURCES` (Windows 11 Enterprise, Ubuntu 22.04 LTS, macOS 14; the versions the agent's titles follow) and copy only the CIS Controls v8 safeguard identifiers listed there. A check whose source cannot be checked ships as `[]`. The candidates below come from reading the check titles; **every one must be confirmed against the PDF before merge and is not authoritative**:

| OS | Agent check ids | Candidate safeguards (verify) |
|---|---|---|
| windows | 1.1.1, 1.1.2, 1.1.3, 1.1.4 (password policy) | 5.2 |
| windows | 2.3.1 (guest account) | 4.7 |
| windows | 9.1.1 (firewall, all profiles) | 4.4, 4.5 |
| windows | 17.1.1 (audit credential validation) | 8.2, 8.5 |
| windows | 2.3.7, 18.4.1, 18.9.4 | verify; likely 4.1 / 5.4 |
| linux | 1.1.1.1 (filesystem module), 3.3.1 (IP forwarding) | 4.8 |
| linux | 1.5.3 (ASLR) | 10.5 |
| linux | 3.4.1 (firewall) | 4.4, 4.5 |
| linux | 5.2.1 (sshd_config permissions) | 3.3 |
| linux | 5.2.5 (SSH root login) | 5.4 |
| linux | 1.4.1, 1.5.4, 5.2.13, 5.4.1 | verify |
| macos | 2.2.1 (FileVault) | 3.6 |
| macos | 5.1.1, 5.1.3 (application firewall, stealth) | 4.5 |
| macos | 6.1.3 (password on wake) | 4.3 |
| macos | 1.2, 1.3, 1.5 (automatic updates) | 7.3, 7.4 |
| macos | 2.1.1.1, 2.3.3.1–2.3.3.9, 2.4.1 (sharing and remote services off) | 4.8 |
| macos | 5.2.1 (SSH root login) | 5.4 |
| macos | 2.5.1, 5.1.2, 6.1.2, 6.3.1 | verify |

  Add every new ref to `FRAMEWORK_CROSSWALK.cis_v8` with a Breeze label and IG tier (e.g. `'4.3': { label: 'Automatic session locking', ig: 1 }`, `'4.4': { label: 'Firewall on servers', ig: 1 }`, `'4.7': { label: 'Default accounts managed', ig: 1 }`, `'4.8': { label: 'Unnecessary services disabled', ig: 2 }`, `'7.4': { label: 'Automated application patching', ig: 1 }`, `'8.5': { label: 'Detailed audit logging', ig: 2 }`, `'10.5': { label: 'Anti-exploitation features enabled', ig: 2 }`, `'3.3': { label: 'Data access control lists', ig: 1 }`) — IG tiers are verified against the CIS Controls v8.1 document in the same pass, and the crosswalk header's source line gains "benchmark-check mapping verified <date> by <name>".
- [ ] **Step 4: Opus review of the table** (one dispatch): compares each entry to the PDF excerpts the implementer quotes in the PR body (identifiers only), and rejects any entry without a quoted source. Todd owns the CIS contact and the §18.13 licensing confirmation; the review does not settle licensing.
- [ ] **Step 5: Run** both tests → PASS. Also `cd packages/shared && npx vitest run src/trustCenter` (the W1 crosswalk/catalog tests must stay green).
- [ ] **Step 6: Commit** — `feat(shared): CIS Benchmark check → CIS Controls v8 safeguard mapping for the agent's checks (W3e)`.

### Task 2: Per-safeguard evidence in the loader

**Files:** modify `apps/api/src/services/postureEvidence.ts` (+ test), `packages/shared/src/trustCenter/types.ts`.

- [ ] **Step 1: Failing loader tests** (`postureEvidence.test.ts`, positional mocks as W1): with `policy.includeCisSafeguards = true`, a Windows device whose latest fresh scan has `9.1.1 pass` and `2.3.1 fail` → `controls.hardening_baseline.safeguards['4.5'] = { eligible: 1, assessed: 1, passing: 1 }` and `['4.7'] = { eligible: 1, assessed: 1, passing: 0 }`; a device with two checks on one safeguard passes it only when both pass; `not_applicable and error findings do not assess a safeguard`; a stale latest scan contributes nothing (same 30-day rule as W1 Ruling 21); a macOS device does not become eligible for a Windows-only safeguard; eligible = hardening-eligible devices whose OS has at least one check mapped to the safeguard; `includeCisSafeguards = false` issues no findings query (call count unchanged from W1); the report path (`securityComplianceReport.ts`) is unaffected (its policy leaves the flag false).
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/postureEvidence.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Add `includeCisSafeguards: boolean` to `PostureEvidencePolicy` (false in `postureEvidencePolicyFromReportConfig`; `TRUST_PAGE_EVIDENCE_POLICY` sets it from W02's CIS gate at call time, not at module load). One extra query, only when the flag is on: the latest result per device with its findings (`SELECT DISTINCT ON (device_id) device_id, checked_at, findings … ORDER BY device_id, checked_at DESC`, scoped by `org_id` and the device list) — never the full scan history, which the W1 query reads without findings. Parse findings with `cisFindingSchema.safeParse` per element; skip malformed ones.
- [ ] **Step 4: Run** → PASS; the report suites (`npx vitest run src/services/securityComplianceReport`) stay green.
- [ ] **Step 5: Commit** — `feat(trust-center): per-safeguard hardening evidence from the latest CIS scan (W3e)`.

### Task 3: Evaluate, payload, contract

**Files:** modify `packages/shared/src/trustCenter/evaluate.ts` (+ test), `packages/shared/src/validators/trustCenter.ts` (+ test), `packages/shared/src/trustCenter/controlCatalog.test.ts`, `apps/api/src/services/trustPage/payloadBuilder.ts` (+ test), `apps/api/src/services/trustPage/trustPagePublicPayload.contract.test.ts`.

- [ ] **Step 1: Failing tests.** `evaluate.test.ts`: `safeguards are evaluated as coverage_pct with the page thresholds and the coverage floor` (12/12 → met; 9 of 12 assessed → not_assessed insufficient_telemetry); `sorted by ref numerically` ("4.5" before "10.5"); `absent when evidence has no safeguards`. `trustCenter.test.ts` (validators): `safeguards is optional and strict` (an old W1 snapshot fixture without the key still parses — snapshots are immutable and `schemaVersion` stays 1); `only hardening_baseline may carry safeguards`; `at most 40 entries`; `each ref resolves in the crosswalk`. `payloadBuilder.test.ts`: `gate off → no safeguards key`; `gate on → safeguards present, percent/assessed/eligible null unless show_percentages`; `footer.frameworkAttributions includes cis_v8 when only a safeguard references it`. Contract test: denylist additionally asserts no `checkId`, `title`, `findings`, `Ensure ` substring anywhere in the payload, against a fixture whose findings carry agent titles.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/trustCenter src/validators/trustCenter.test.ts`; `cd apps/api && npx vitest run src/services/trustPage` → FAIL.
- [ ] **Step 3: Implement** in the evaluator (reuse its coverage rule; no second threshold path), the strict optional schema field with a `superRefine` for the control-id and crosswalk rules, and the builder mapping. W02's framework view counts "N of M safeguards evidenced": extend W02's counting helper so a safeguard evidenced only via `safeguards` counts once — the helper's name and file come from the W02 code on `main` at the time; if it is not there, stop and report NEEDS_CONTEXT.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(trust-center): evaluate and publish hardening safeguards behind the CIS gate (W3e)`.

### Task 4: Portal rendering, docs, verification

**Files:** create `apps/portal/src/components/trust/HardeningSafeguards.tsx` (+ test); modify `TrustPageView.tsx` (+ test); modify `apps/docs/src/content/docs/security/trust-center.mdx`.

- [ ] **Step 1: Failing tests.** `HardeningSafeguards.test.tsx`: a collapsed "Safeguards evidenced by hardening checks (N)" disclosure under the hardening control; each row "CIS v8 4.8 · <Breeze label> · <pill>" with the coverage note only when the numbers are present; no rows and no disclosure when `safeguards` is absent; labels come from `FRAMEWORK_CROSSWALK`, never from the payload. `TrustPageView.test.tsx`: the component mounts only for `hardening_baseline`.
- [ ] **Step 2: Run** `cd apps/portal && npx vitest run src/components/trust` → FAIL.
- [ ] **Step 3: Implement**; docs: a "Hardening safeguards" subsection in `trust-center.mdx` (what is mapped, partial by construction, gate, identifiers only).
- [ ] **Step 4: Verify** — shared full vitest + tsc; API full unit suite + typecheck; portal full vitest + astro check. No migration, so no contract suites are required, but `trustPagePublicPayload.contract.test.ts` must run.
- [ ] **Step 5: Commit** — `feat(portal): show hardening safeguards under the hardening control (W3e)`.

---

## Follow-ups after W03 (file on #8771 when the relevant sub-waves merge)

1. Export button on the portal editor (needs W03c + W03d) and optionally on the public page (needs W03c + W03e's ownership of `TrustPageView.tsx` to end).
2. Draft (unpublished) export through a preview token (needs a `runAction` POST in the web menu).
3. MSP-side "customer edited the draft on <date>" indicator (needs W03a's `routes/trustPage.ts` GET + W03c's `TrustStatusCard.tsx`).
4. Staff `PUT /trust-page` switches to `applyTrustPageDraftPatch` (W03a + W03d).
5. Badge section shows the attestation URL (W03b + W03a's ownership of the editor).
6. `trust-center.mdx` links the four new pages.
7. Custom domain once #3282 ships (interface note above).

## Self-review notes (plan author, 2026-10-16)

- **Spec coverage.** §14 W3 items: embed → W03a; portal self-edit (§18.9) → W03d; signed payload → W03b; questionnaire export → W03c; per-benchmark mapping (§5.5 "W3 candidate") → W03e; custom domain → deferred with the #3282 interface note. §8 headers/badge → W03a Task 4 and W03b Task 3; §13 enumeration/generic 404 → W03a Task 3, W03b Task 3, W03d Task 3; licensing (§5.5, §18.13) → Global Constraints, W03e, Open Decision 7.
- **Verified on `main` (d721f0963d) while writing:** no portal roles or portal MFA; `contact_roles` admin role and the approval code's org-scoped read; portal flags are `portal_branding` columns; `secureHeaders` CORP default and its post-`next()` write; `encryptSecret` AAD needs `APP_ENCRYPTION_KEY_ID`; the agent's CIS check ids; `cis_baselines.benchmark_version` is free text; `mcpCoverage.ts` requires an entry per route file; `translationCoverage.test.ts` requires a baseline per namespace; the newest migration is `2026-12-29-140000-…` (not `130100` as the brief said; the W03 slots still sort after it).
- **Not verified:** whether a partner with slug `embed` exists in production; whether hosted regions set `APP_ENCRYPTION_KEY_ID`; the badge being blocked cross-site (code-read only; W03b Task 4 confirms in a browser); every candidate safeguard in the W03e table (to be checked against the CIS Benchmark PDFs); W02's file names, flag name and helpers (W02 is planned concurrently — every W02 touchpoint is named by spec section and guarded by a NEEDS_CONTEXT stop).
- **Type consistency.** `ResolvedTrustPage.embedAllowedOrigins` (W03a Task 3) is read only by W03a's card; W03b's router reuses `resolvePublishedTrustPage` without that field mattering. `TrustPagePublicPayload` stays `schemaVersion: 1`; W03e's `safeguards` is optional so W1 snapshots stay valid; W03b signs whatever the snapshot holds; W03c serializes through the shared type, so it compiles against W03e's optional field either way.
- **Proportion.** Signatures, test names and assertions, not bodies; code blocks only where the exact text is the contract (migration SQL, CSP rewrite cases, validator cases).

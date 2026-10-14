---
title: Trust Center — public security-posture pages for organizations
tracking_issue: LanternOps/breeze#8768 (waves: W01 #8769, W02 #8770, W03 #8771)
status: approved 2026-10-13 (all §18 defaults); plan-time amendments recorded in §19. Plan: docs/superpowers/plans/2026-10-13-trust-center-w1.md
depends_on: LanternOps/breeze#3282 (platform custom domains) — W3 only
related: #4562 (portal visibility), #5784 (evidence reports), specs/reports/2026-06-29-security-compliance-posture-report.md, specs/reports/2026-07-14-posture-backup-evidence-design.md (parked), #3281, #3229, #3967
reviewed_by: advisor + codex gpt-6-astra xhigh (read-only), 2026-10-12 — both concur on the architecture; their refinements are folded in and marked "(review)".
---

# Trust Center: design

## 1. Problem and goal

An MSP's customer is asked, repeatedly, to prove it is secure: by its own clients during vendor due diligence, by a cyber-insurance underwriter at renewal, and by auditors. Today the MSP answers by hand: a letter, a screenshot of the RMM, a questionnaire filled in from memory. The answer is stale the day it is sent and nobody can verify it.

Vanta, Drata and SafeBase sell a "trust center" for this: a public page with controls, documents and a request-access flow. Their controls are mostly self-attested. Breeze holds what they do not: live, per-device telemetry about the controls that matter to an SMB (endpoint protection, encryption, patching, MFA, backups). A Breeze trust page can say "continuously verified", with a timestamp and a stated method, and mean it.

**Goal.** Any organization in Breeze can publish one public page, maintained by its MSP, that shows the security controls Breeze verifies, the documents the org chooses to share, and who manages it. The MSP publishes the same page for itself by designating one org as its own infrastructure. The page is hosted by Breeze, linkable from the org's website, with a badge the org can embed.

**Non-goal.** Breeze certifies nothing. The page is an evidence summary, never a SOC 2 / ISO / CIS attestation, and the copy says so (same rule as the posture report).

## 2. Audience, and what "proof" means

Three readers, in the order the page serves them:

1. **Cyber-insurance underwriters.** They ask the same ~15 questions every year (MFA, EDR, backups, patching, encryption, privileged access). Control ordering follows this list.
2. **The org's clients and prospects** doing vendor due diligence: a status per control and a policy PDF.
3. **Auditors**: the same plus dated documents, method, and a contact.

Two kinds of claim, never visually confused:

- **Continuously verified** — computed from Breeze telemetry with a stated method, evidence-age window and coverage floor. W1 ships only these.
- **Declared** — stated by the MSP or org about something Breeze does not observe (security-awareness training, incident-response plan, cyber insurance held, penetration test). Labeled "declared by <MSP> on <date>", expires, must be re-declared. This reopens the question the backup-evidence spec parked (should Breeze render evidence about tools it does not manage?). Proposed answer: yes, labeled and expiring — a product decision (§18.2), W2.

## 3. Principles

1. **Honesty over flattery.** No data → "Not assessed", never 0% and never a pass (posture-report rule). A control is "Met" only when enough of the fleet was actually assessed (§5.4). A shown control shows its real status. The page always states how many catalog controls are shown and that the publisher selected them (review).
2. **Public is more exposed than the portal.** The portal already hides patch and vulnerability detail as weakness maps (`PORTAL_SENSITIVE_FLAG_KEYS`). Public shows a status per control; percentages and device counts are opt-in; device names, users, IPs, CVEs, open ports, pending patches, `top_issues` and the 0–100 posture score never appear.
3. **One computation.** Control evidence comes from the same loader the Security & Compliance Posture PDF uses, evaluated with that report's default thresholds and org-wide scope. A default posture PDF and the trust page agree by construction; a PDF run with custom thresholds or a site subset is a different question and says so in its own header.
4. **Public posture is never computed live.** The public surface serves an immutable, closed-field snapshot. What *is* resolved live per request: slug → org → page, publication pointer, and tenant liveness (review). The snapshot payload is contract-tested like the portal read models.
5. **No new mechanisms.** Existing slugs, document library, branding resolvers, partner trust state, public-route pattern (system context + liveness predicate + isolated rate bucket), rich-text sanitizer. No domain columns (#3282), no new top-level path (#3229), no entitlement framework.

## 4. Page anatomy

Top to bottom; every block optional except header, controls and footer:

1. **Header** — org name and logo (org branding, partner fills gaps via `resolveDocumentBrand`), summary line "Showing 11 of 15 Breeze-verifiable controls · 9 met · last verified 2 hours ago", security contact email, link to the org's website.
2. **Intro** — short rich text written by the publisher, sanitized server-side.
3. **Controls** — grouped by category (Endpoint protection · Patching & hardening · Identity & access · Data protection · Monitoring). Each row: title, plain-English description, status pill (Met / Needs attention / Not met / Not assessed), "Continuously verified" marker, and, when enabled, the percentage with its coverage note ("46 of 50 devices assessed").
4. **Method** — a collapsed block, always present: catalog version, evidence age window, definitions window, coverage floor, thresholds, "verified by Breeze RMM telemetry; not a certification". Generated from the payload's `methodology`, not hand-written.
5. **Documents** — public documents from the org document library: title, category, size, date, download. Gated documents (W2) show "Request access".
6. **Managed by** — the MSP's name, logo and website (toggle, default on). The URL carries the partner slug regardless.
7. **Footer** — "Powered by Breeze" (§18.3) and the non-certification sentence.

Not shown: the posture score, an overall grade, anything device-level.

## 5. Control catalog and evaluation

### 5.1 Catalog

Code-defined, `packages/shared/src/trustCenter/controlCatalog.ts`, versioned by `catalogVersion`. No table: the list is small, must be identical across API, web and portal, and changes are code changes with review. Each entry:

```ts
{
  id: 'endpoint_protection',
  category: 'endpoint_protection' | 'patching_hardening' | 'identity_access' | 'data_protection' | 'monitoring',
  titleKey, descriptionKey,                    // i18n keys, all 8 locales (SUPPORTED_LOCALES)
  source: 'telemetry',                         // W2 adds 'declared'
  metric: 'coverage_pct' | 'exposure_pct' | 'boolean' | 'pass_rate',
  thresholds?: { met: 95, attention: 80 },     // coverage/pass_rate: ≥met → met, ≥attention → attention, else not_met
                                               // exposure (lower is better): ≤(100−met) → met, ≤(100−attention) → attention
  insurerRank: number,
  frameworkRefs: Array<{ framework: 'cis_v8' | 'essential_eight' | 'cyber_essentials' | 'nist_csf_2'; ref: string }>,  // §5.5
}
```

### 5.2 W1 controls (all telemetry)

| id | Category | Evidence | Metric |
|---|---|---|---|
| `endpoint_protection` | Endpoint protection | real-time protection active (`anyAvCoveragePct`) | coverage |
| `edr_coverage` | Endpoint protection | EDR-class product present (`edrCoveragePct`) | coverage |
| `definitions_current` | Endpoint protection | definitions ≤ 7 days (`avDefinitionsCurrentPct`) | coverage |
| `host_firewall` | Endpoint protection | `firewallPct` | coverage |
| `os_patch_currency` | Patching & hardening | `patchCurrentPct` | coverage |
| `hardening_baseline` | Patching & hardening | `cisAvgPassRate`, only when `cisAssessedCount > 0` | pass rate |
| `password_policy` | Identity & access | `passwordComplexityPct` (min length 8 + lockout) | coverage |
| `least_privilege` | Identity & access | `localAdminExposurePct` (> 2 local admins flagged) | exposure |
| `identity_provider` | Identity & access | `identityProviderConnected` | boolean |
| `mfa_registered_m365` | Identity & access | `m365_posture_rollups.users_mfa_registered / users_total`; `met` also requires `admins_without_mfa = 0`. Titled "MFA registered (Microsoft 365)"; registration is not enforcement (review) — enforcement via `m365_ca_policies` is a separate W2 control | coverage |
| `privileged_access` | Identity & access | `privilegedAccess.activePamRules > 0 OR mfaStepUpEnforced` | boolean |
| `disk_encryption` | Data protection | `encryptionPct` | coverage |
| `backups_verified` | Data protection | devices with a Breeze `backup_jobs` row (eligible) that have a `backup_verifications` row with `status = 'passed'` and type `integrity` or `test_restore` completed inside the evidence window (passing); `not_assessed / no_data` when no device has a Breeze backup job. Third-party-provider "last success" is not a verification and does not count (§19.8). Titled "Backups verified restorable", never "backups configured" (review) | coverage |
| `dns_filtering` | Monitoring | `dnsFilteringActive` | boolean |
| `continuous_monitoring` | Monitoring | devices with agent check-in ≤ 24 h / managed devices | coverage |

Boolean controls have met / not met / not assessed. Thresholds and windows (7-day definitions, 30-day evidence age, min password length 8, max 2 local admins) are the defaults of `securityCompliancePostureConfigSchema` (`services/reportConfigSchemas.ts`) — the trust page is the posture report's default configuration, by reference, not by copy.

### 5.3 Shared loader (in-scope refactor)

`apps/api/src/services/securityComplianceReport.ts` (620 lines) computes `summary.controls` inline inside `generateSecurityCompliancePostureReport(orgId, rawConfig, authority)`. Extract two functions:

```ts
// apps/api/src/services/postureEvidence.ts — runs under the caller's DB context
export async function loadPostureEvidence(
  scope: OrgAxisLiveSiteScopeV1,                        // from services/siteScope.ts
  policy: PostureEvidencePolicy,                        // the report's threshold/window defaults
  asOf: Date,
): Promise<PostureEvidence>                             // per control: eligible, assessed, passing, newestEvidenceAt

// packages/shared/src/trustCenter/evaluate.ts — pure
export function evaluateTrustControls(
  catalog: TrustControlCatalog, evidence: PostureEvidence, policy: TrustEvaluationPolicy, asOf: Date,
): TrustControlAssessment[]
```

The report keeps `assertReportExecutionPreflight` and its `OrgReportExecutionAuthority`; those are report-execution concerns. The snapshot worker runs under `systemReportAuthorityFor(orgId)` (org-wide, unrestricted, the #5784 managed-evidence authority) inside `withSystemDbAccessContext` for one org at a time — it never forges a user or portal-user authority (review). Restricted-site scoping does not apply to a trust page: it is always org-wide.

`PostureEvidence` carries counts, not percentages, so the evaluator owns the denominator rule below. The report switches to the same loader in the same PR so the two cannot drift. §19.6–7: eligible devices exclude `status = 'decommissioned'` (as the posture worker does), and the report's EDR / endpoint-protection percentages become `passing / assessed` with new `edrUnknownCount` / `anyAvUnknownCount`, where a device is assessed when Breeze holds any evidence about it (a `security_status` row, an EDR agent row, or a check-in inside the evidence window). Both callers read the same counts, so principle 3 holds exactly.

Three controls have **no loader in the report today** and are net-new evidence readers added alongside the extraction (size the W1 plan accordingly): `mfa_registered_m365` (reads `m365_posture_rollups`), `backups_verified` (joins `backup_verifications` to backup-protected devices and the org's RPO), and `continuous_monitoring` (device last-check-in). The report may surface them later; W1 does not require it.

### 5.4 Denominators, coverage floor and freshness (review)

The report today divides by *assessed* devices, so one assessed device among 100 can read 100%. Public rules:

- `eligible` = managed devices in the org that the control applies to (platform-appropriate; a control that cannot apply to a device excludes it).
- `assessed` = eligible devices with evidence newer than `evidenceMaxAgeDays` (30).
- `passing` = assessed devices meeting the control.
- **Coverage floor.** If `assessed / eligible < coverageFloorPct` (80%), status is `not_assessed` with reason `insufficient_telemetry`, whatever `passing / assessed` says.
- Percent shown (when opted in) is `passing / assessed`, with the coverage note "46 of 50 devices assessed".
- Each control carries `evidenceAsOf` = newest evidence timestamp among assessed devices. Snapshot time is not evidence time.
- **Page-level staleness.** If `trust_pages.last_evaluated_at` is older than 24 h (worker failure), the public page shows "Verification paused since <time>" and every pill is rendered muted. The payload is still served; the condition is visible, not hidden.

### 5.5 Framework crosswalk

**Relationship to the existing CIS feature.** Breeze's CIS feature (`cis_baselines`, `cis_baseline_results`, `cis_check_catalog`; `apps/web/src/pages/cis-hardening/`) implements CIS *Benchmarks*: per-OS configuration checks (Windows 11, macOS 14, Ubuntu 22.04; L1/L2). That is one evidence source and feeds exactly one trust control, `hardening_baseline`. CIS *Controls* v8 is the 18-control / 153-safeguard framework that insurers and questionnaires reference. They share an acronym and nothing else; no framework identifiers exist anywhere in the codebase today.

**What the crosswalk is.** A static, code-defined table `packages/shared/src/trustCenter/frameworkCrosswalk.ts` keyed by `(framework, ref)` → `{ ig?: 1 | 2 | 3; labelKey }`, plus `frameworkRefs` on every catalog entry (§5.1). Labels are Breeze's own short paraphrases, never the framework's verbatim text. Indicative mapping for the W1 controls (safeguard numbers verified against the current CIS v8.1, ACSC, NCSC and NIST publications at plan time, with the source document and version recorded in the crosswalk file header):

| Control | CIS Controls v8 | Essential Eight | Cyber Essentials | NIST CSF 2.0 |
|---|---|---|---|---|
| `endpoint_protection`, `definitions_current` | 10.1, 10.2 (IG1) | — | Malware protection | PR.PS |
| `edr_coverage` | 10.7, 13.2 (IG2) | — | Malware protection | DE.CM |
| `host_firewall` | 4.5 (IG1) | — | Firewalls | PR.IR |
| `os_patch_currency` | 7.3 (IG1) | Patch operating systems | Security update management | PR.PS-02 |
| `hardening_baseline` | 4.1, 4.2 (IG1) | User application hardening (partial) | Secure configuration | PR.PS-01 |
| `password_policy` | 5.2 (IG1) | — | Secure configuration | PR.AA |
| `least_privilege`, `privileged_access` | 5.4 (IG1), 6.8 | Restrict administrative privileges | User access control | PR.AA-05 |
| `identity_provider` | 5.6, 6.7 (IG2) | — | User access control | PR.AA-01 |
| `mfa_registered_m365` | 6.3, 6.5 (IG1) | Multi-factor authentication | User access control | PR.AA-03 |
| `disk_encryption` | 3.6 (IG1) | — | — | PR.DS-01 |
| `backups_verified` | 11.2, 11.3 (IG1), 11.5 (IG2) | Regular backups | — | RC.RP |
| `dns_filtering` | 9.2 (IG1) | — | — | PR.PS |
| `continuous_monitoring` | 1.1, 8.2 (IG1) | — | — | DE.CM |

**Coverage is partial by construction and is shown as such.** IG1 has 56 safeguards; telemetry evidences roughly 18. The framework view (W2) renders "N of M safeguards evidenced on this page", with M the framework's full count from the crosswalk table, never "compliant with" or "meets IG1". The gaps (awareness training, incident response plan, vendor management, and so on) are not telemetry and can only ever be declared controls (§18.2) with expiry. The framework view is therefore the main reason declared controls exist; the two ship together in W2.

**Wave split.** W1: `frameworkRefs` on the catalog, the crosswalk table, refs in the payload (§6), and small chips on each control card ("CIS v8 10.1 · IG1"). This is data plus a chip; no evaluation logic changes. W2: framework view grouped by framework with evidenced/total counts; publisher picks which frameworks to display (default CIS v8 only; the editor suggests Essential Eight for AU partners and Cyber Essentials for UK partners by partner country); declared controls carry `frameworkRefs` the same way. W3 candidate: per-benchmark-check mapping using the official CIS Benchmark-to-Controls mappings, so `hardening_baseline` can expand into the specific safeguards each check satisfies.

**Licensing (verify before W2 GA).** NIST CSF 2.0 is a US Government work (public domain). ACSC's Essential Eight is CC BY 4.0. NCSC's Cyber Essentials requirements are under the Open Government Licence; "Cyber Essentials" is a trademark, referenced by name only. CIS Controls v8 is CC BY-NC-ND 4.0 with "commercial use subject to the prior approval of CIS". Referencing safeguard identifiers with our own labels, CIS attribution and a link to cisecurity.org/controls is the industry norm (Vanta, Drata, Secureframe do exactly this), but the spec does not treat that as settled: the page carries the attribution line from W1, and W2's framework view does not ship to GA until CIS has confirmed in writing or Breeze holds a CIS SecureSuite vendor membership (§18.13). No verbatim CIS safeguard text, ever.

## 6. Exposure rules and the public payload contract

The snapshot payload is the whole public exposure. Closed schema `trustPagePublicPayloadSchema` (`packages/shared/src/validators/trustCenter.ts`), `.strict()`, `schemaVersion: 1`:

```ts
{
  schemaVersion: 1,
  snapshotId: string, generatedAt: string, publishedAt: string,
  org: { name: string; logoUrl: string | null; websiteUrl: string | null; securityContactEmail: string | null },
  managedBy: { name: string; logoUrl: string | null; websiteUrl: string | null } | null,
  introHtml: string | null,
  summary: { catalogTotal: number; controlsShown: number; controlsMet: number; deviceCount: number | null },
  methodology: {
    catalogVersion: string; evidenceMaxAgeDays: number; definitionsMaxAgeDays: number;
    coverageFloorPct: number; thresholds: { met: number; attention: number };
  },
  controls: Array<{
    id: string; category: string; source: 'telemetry';
    status: 'met' | 'attention' | 'not_met' | 'not_assessed';
    reason: 'insufficient_telemetry' | 'no_data' | 'not_applicable' | null;   // only with not_assessed
    percent: number | null; assessed: number | null; eligible: number | null;   // null unless show_percentages (§19.13: numbers, not a coverageNote string)
    unit: 'devices' | 'users' | 'org';
    evidenceAsOf: string | null;
    frameworkRefs: Array<{ framework: 'cis_v8' | 'essential_eight' | 'cyber_essentials' | 'nist_csf_2'; ref: string }>;  // ids only; labels resolve from the shared crosswalk (§5.5)
  }>,
  documents: Array<{ id: string; title: string; category: string; contentType: string; byteSize: number; updatedAt: string; visibility: 'public' }>,
  footer: { poweredByBreeze: boolean; frameworkAttributions: Array<'cis_v8' | 'essential_eight' | 'cyber_essentials' | 'nist_csf_2'> },  // every framework any shown control references (§5.5 licensing)
}
```

Served alongside, outside the immutable payload: `lastEvaluatedAt` and `stale: boolean`.

Contract test `trustPagePublicPayload.contract.test.ts`: builder output validates `.strict()`; a denylist (`deviceId`, `hostname`, `ipAddress`, `cve`, `topIssues`, `openPorts`, `score`, `userPrincipalName`, any email other than the contact) is asserted absent at any depth, against fixtures that would leak if the builder did.

Builder-enforced rules:

- Hidden controls are omitted from `controls`; `summary.catalogTotal` always states the full catalog size so curation is visible.
- `percent`, `assessed`, `eligible`, `deviceCount` are `null` unless opted in.
- Intro: ≤ 5,000 chars of sanitized HTML from the existing TipTap `RichTextEditor`, sanitized on PUT and again at build time by `sanitizeFlowRichTextHtml` (`RICH_TEXT_FLOW_TAGS`: no tables, no media, `http(s)` links only). §19.3 replaced the Markdown path: the web has no Markdown editor and the portal no Markdown renderer.
- `documents` ≤ 20, each a live `org_documents` row (`deleted_at IS NULL`, not superseded) linked with `visibility = 'public'` and `disclosure_confirmed_at` set.

## 7. Publishing model: snapshots and a live pointer

- `trust_pages` holds the **draft configuration** and the **publication state**: `published_at`, `publication_revision` (monotonic). `trust_page_snapshots` rows are immutable full payloads; exactly one per page carries `is_current = true` (partial unique index). There is deliberately **no back-pointer from page to snapshot**: a `current_snapshot_id` FK would make the two tables a cycle, and the org-erasure cascade (children before parents) would fire its `ON DELETE` on a published page mid-erasure and abort the whole delete — the latent GDPR bug `docs/agents/tenancy-rls.md` warns about (review).
- **Publish**: build a snapshot, then in one transaction: insert it with `is_current = true`, clear `is_current` on the previous one, set `published_at`, increment `publication_revision` — only if the revision still matches what the editor loaded (optimistic concurrency, 409 otherwise). Add the page's `partnerSlug/orgSlug` to the Redis serving-set (below). Live when the toast says so.
- **Unpublish**: one transaction clears `published_at`, bumps the revision, and removes the key from the serving-set. Correctness does not depend on the cache: the public resolve reads `published_at` live.
- **Refresh**: repeat job `trust-page-snapshot` (hourly, after `security-posture-scan`) walks published pages; for each, rebuilds under `withSystemDbAccessContext` for that org, inserts a new `is_current` snapshot only when `payload_sha256` differs (same revision check, so a publish that raced wins), and always updates `last_evaluated_at`. It also rebuilds the serving-set from the table so the set self-heals. Prune `WHERE NOT is_current AND generated_at < now() − 90 days`.
- **Serving-set**: a Redis set `trust:serving` of `partnerSlug/orgSlug` (and `partnerSlug` for partner-home) keys currently publishable, maintained by publish/unpublish/refresh and by partner trust-state and org/partner status changes (those handlers call `trustServingSet.refreshForPartner(partnerId)`). It is an admission filter, not an authority: a hit still goes through the live resolve; a miss answers 404 without touching Postgres (review: an unthrottled miss path must not reach the database).
- **Serve** (per public request): check the serving-set; on a hit, one indexed query resolves `partners.slug` → `organizations (partner_id, lower(slug))` → `trust_pages` with `buildPublicLinkLiveOrgPredicate`, `trust_state = 'trusted'` and `published_at IS NOT NULL` folded in; then the current snapshot's payload from Redis (`trust:snapshot:<id>`, TTL 1 h; immutable, so a hit is always correct) or the table. Unknown, unpublished, soft-deleted, non-live org or partner, or non-`trusted` partner all return the same generic 404 (review: one indistinguishable response; the 410 that `routes/quotesPublic.ts` uses would reveal state).
- **Preview**: the editor mints a 15-minute HS256 JWT (jose, `jwt.ts` sign-key helpers, as `quoteAcceptToken.ts`) bound to the page id; the portal renders `/portal/trust/preview/<token>` from a freshly built draft payload; never cached, always `noindex`.

## 8. URLs, hosting and serving

**Canonical URL.** `https://<breeze-host>/portal/trust/<partner-slug>/<org-slug>`. `partners.slug` is globally unique; `organizations.slug` is per-partner unique, lifetime, case-insensitive (#3967, `ORG_SLUG_UNIQUE_INDEX`). No new slug table, no squatting, no vanity slugs (vanity is `trust.customer.com`, #3282).

**Slug hygiene (review).** Imported orgs get `slugify(name)` (`services/orgImport/slug.ts`), but `POST /orgs` accepts any non-empty slug (`routes/orgs.ts`), and non-Latin names collapse to `org`/`org-2`. Publish validates both slugs against `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`; failure returns a clear "fix the organization slug" error, with a link to the org settings. The public route rejects slugs over 64 chars before any query. Renaming a slug changes the URL; the old URL 404s. The editor warns before a rename when a page is published.

**Partner's own page.** `/portal/trust/<partner-slug>` resolves to the org flagged `is_partner_home` (one per partner). Setting or moving it requires partner scope (`auth.scope === 'partner'`) and the org-management permission.

**Why the portal app, under its base path.** `apps/portal` is the customer-facing deployment boundary, Astro SSR, already renders unauthenticated token pages (`layouts/PublicDocumentLayout.astro`), already resolves branding by host (the #3282 hook), and `/portal/*` already reaches it through Caddy and every self-hoster's proxy. A new `/trust/*` path is an ingress change every custom proxy misses. `apps/web` has no public layout and is the MSP's workspace. Files: `pages/trust/[partnerSlug]/index.astro`, `pages/trust/[partnerSlug]/[orgSlug].astro`, `pages/trust/preview/[token].astro`, `layouts/TrustPageLayout.astro` (the public-document shell with parameterized title, description, OG tags, robots and locale — `PublicDocumentLayout` hardcodes English and `noindex`, so extract the shell rather than fork it). `/trust` stays out of `PORTAL_PROTECTED_PREFIXES`; `disabledPageCoverage.test.ts` gets an explicit public allowlist entry.

**Branding (review).** `loadPortalBrandingWithStatus` prefers the viewer's session cookie, then the host. A trust page's branding must come from the *published subject* only: the page reads `org`/`managedBy` from the payload and ignores cookies and host.

**SSR vs client rendering (review — release blocker otherwise).** Portal SSR calls to the API carry no client IP (`buildServerForwardHeaders` forwards cookie and host only), so every SSR fetch would share one `unknown` slot of the public rate bucket; `pages/invoice/[token].astro` documents exactly this and renders client-side for that reason. Trust pages split the work:

- SSR fetches only `GET /api/v1/trust/public/:partnerSlug/:orgSlug/card`: org name, logo, summary line, publication state. It is registered with `registerGlobalRateLimitSkipPrefix` (first use of that helper) and must therefore be DB-free on a miss: slug-length check, then the serving-set membership check (§7), and only a hit proceeds to the resolve query and the cached card. Its worst case per request is two Redis reads plus one indexed query for a currently-published page. It renders `<title>`, description, Open Graph tags and the header, so link previews and crawlers see real content.
- The browser fetches the full payload from `GET /api/v1/trust/public/:partnerSlug/:orgSlug`, keyed by the visitor's own IP in an isolated bucket (120/min/IP). Controls, documents and method render client-side, as the invoice page does.

**Response headers.** The portal middleware applies `no-store`/`noindex` by path prefix for token pages; add a `/trust/` branch: `Cache-Control: public, max-age=300, stale-while-revalidate=600` for pages and `no-store` for `/trust/preview/`; `X-Robots-Tag: noindex` unless the card says `searchIndexable`; `<link rel="canonical">`. `X-Frame-Options: DENY` and `frame-ancestors 'none'` stay (no embedding in W1).

**Badge.** `GET /api/v1/trust/public/:partnerSlug/:orgSlug/badge.svg`: a static SVG "Security posture · verified by Breeze · updated <date>", no counts (a count over publisher-selected controls is a vanity metric — review), `Cache-Control: public, max-age=3600`, 404 when unpublished. The editor shows the snippet `<a href="<page>"><img src="<badge>" alt="Security posture verified by Breeze"></a>`. The badge is only meaningful through its link to the hosted page, and the page says so in Method.

**Ingress.** Zero changes. Self-hosting notes say "nothing to do".

## 9. Data model and tenancy

All new tables are shape 1 (`org_id NOT NULL`, policy `breeze_has_org_access(org_id)`), RLS enabled, forced and policied in the creating migration, registered in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts` and `CORE_TENANT_EXPORT_POLICY` in the same PR. No `device_id`/`ticket_id` columns, so no device/ticket lists.

**Why `org_id NOT NULL`, not org-XOR-partner.** A trust page is one org's public identity, not a policy applied across orgs (CLAUDE.md requires this justification). The partner-wide thing that could exist later is a *template* for intro and default visibility, W2-or-never (§18.8). `partner_id` is denormalized for the partner-home uniqueness and partner-level listing, enforced by a composite FK `(org_id, partner_id) → organizations(id, partner_id)` `DEFERRABLE INITIALLY IMMEDIATE`. That mirrors the *structural* constraint of the `users` migration (`2026-04-11-users-rls.sql`), not its dual-axis RLS: the policy stays org-only (review).

### `trust_pages` (one per org)
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| org_id | uuid not null unique | |
| partner_id | uuid not null | composite FK with org_id, deferrable |
| is_partner_home | boolean not null default false | partial unique index `(partner_id) WHERE is_partner_home` |
| published_at | timestamptz null | |
| publication_revision | integer not null default 0 | optimistic concurrency |
| search_indexable | boolean default false | |
| show_percentages | boolean default false | |
| show_device_count | boolean default false | |
| show_managed_by | boolean default true | |
| security_contact_email | varchar(320) null | |
| website_url | text null | https only |
| intro_markdown | text null | ≤ 5,000 chars |
| hidden_control_ids | text[] default '{}' | catalog ids |
| publication_authorized_by | varchar(200) null | who at the customer authorized publication (free text); required by the publish route when `is_partner_home = false` |
| publication_authorized_at | timestamptz null | set with the above; cleared when the org changes ownership (merge survivor keeps its own) |
| publication_authorized_by_user_id | uuid null | the Breeze user who recorded the attestation; set null on user delete |
| last_evaluated_at | timestamptz null | |
| created_by_user_id / updated_by_user_id | uuid null | set null on user delete |
| created_at / updated_at | timestamptz | |

Export policy: every column `included` (no jsonb).

### `trust_page_snapshots` (immutable)
| column | notes |
|---|---|
| id, trust_page_id, org_id | composite FK `(trust_page_id, org_id) → trust_pages(id, org_id)`, deferrable, ON DELETE CASCADE |
| payload jsonb | `excludedOpen` |
| payload_sha256 char(64) | dedupe |
| catalog_version text, publication_revision int | |
| is_current boolean not null default false | partial unique index `(trust_page_id) WHERE is_current` |
| generated_at timestamptz | index `(trust_page_id, generated_at desc)` |

Only `is_current` may be updated (trigger rejects any other column change); DELETE allowed (retention, cascade). No FK from `trust_pages` back to this table (§7).

### `trust_page_documents`
| column | notes |
|---|---|
| trust_page_id, document_id, org_id | composite FKs `(trust_page_id, org_id)` and `(document_id, org_id) → org_documents(id, org_id)` (the existing `org_documents_id_org_uq` supports it), deferrable; PK `(trust_page_id, document_id)` |
| visibility | enum `public` (W1), `gated` (W2) |
| disclosure_confirmed_at, disclosure_confirmed_by_user_id | the publisher confirmed this document is approved for public release (review) |
| sort_order int | |

`org_documents` is content-addressed and immutable per row (supersession creates a new row), so a link pins a version. `org_documents.portal_visible` is untouched: portal visibility (signed-in customers) and public disclosure are different decisions.

### W2 tables (named now, designed in the W2 plan)
`trust_page_declarations` (control id, statement, declared_by, declared_at, expires_at, evidence document id) and `trust_page_access_requests` (requester email, company, purpose, verification token hash, status, decided_by, expires_at).

### Merge (review)
`orgMergeRegistry` policy for `trust_pages` is a custom executor (`orgMergeCustomExecutors.ts`): **the loser's page is always retired**, even when the survivor has none — a page is an org's public identity and must not be repointed onto a different org (`buildKeepSurvivor` would). Snapshots and document links cascade with it. If the survivor has a published page, its `last_evaluated_at` is cleared so the next refresh rebuilds it: its fleet just changed.

### Trust and entitlement
- **Who may publish.** Publishing is a reputational surface for Breeze ("Managed by X · Powered by Breeze"); a scam operator on a trial must not get it. Publish is a new `GatedCapability` `'trust_page_publish'` in `services/partnerTrust.ts`: allowed only when `partners.trust_state = 'trusted'` (existing enum probation/trusted/restricted; the admin Trust Queue already moves partners between states). The public resolve predicate also requires `trusted`, so restricting a partner hides every page it publishes immediately and re-trusting restores them, no unpublish needed. This is the operator abuse switch (review: keep it separate from commercial eligibility).
- **Commercial eligibility.** None in W1: every edition and plan can publish; publication is opt-in so no toggle is needed (review).
- **Footer removal.** `footer.poweredByBreeze = NOT partners.trust_page_unbranded`, a platform-operator-granted boolean like `ai_for_office_enabled` (not in partner-writable settings JSONB, not inferred from the `plan` enum — review). How it is granted (plan tier, add-on) is a billing decision (§18.3).

## 10. API surface

Authenticated (`/api/v1/orgs/:orgId/trust-page`, existing org-management permission):

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | draft + publication state + `publicationRevision` + public URL + slug validity |
| PUT | `/` | update draft (Zod `trustPageUpdateSchema`), returns new revision |
| PUT | `/documents` | replace document list (id, visibility, order, disclosure confirmation) |
| POST | `/publish` | body `{ expectedRevision, authorization?: { authorizedBy } }`; trust-gate, slug validation, **publication authorization attestation** (a customer page cannot publish without `publication_authorized_by`; the partner-home page needs none, the MSP is publishing its own data), build, one transaction flips `is_current` + `published_at` + revision; serving-set add |
| POST | `/unpublish` | one transaction clears `published_at` + bumps revision; serving-set remove |
| POST | `/partner-home` | set/clear (partner scope required) |
| POST | `/preview-token` | 15-minute preview JWT |
| GET | `/controls` | catalog with current evaluated status, exactly as the public would see it |

Public (no auth; system context; resolve query includes the liveness predicate and `trust_state = 'trusted'`; generic 404 for every non-serving case):

| Method | Path | Bucket | Purpose |
|---|---|---|---|
| GET | `/api/v1/trust/card/:partnerSlug/:orgSlug` | skip-prefix `/api/v1/trust/card/`; serving-set gate, DB-free on miss; 503 when Redis is unavailable (§19.1–2) | SSR header + OG metadata |
| GET | `/api/v1/trust/card/:partnerSlug` | skip-prefix | partner-home card |
| GET | `/api/v1/trust/public/:partnerSlug/:orgSlug` | isolated 120/min/IP | payload + `lastEvaluatedAt` + `stale` |
| GET | `/api/v1/trust/public/:partnerSlug` | isolated | partner-home payload |
| GET | `/api/v1/trust/public/:partnerSlug/:orgSlug/badge.svg` | isolated | badge |
| GET | `/api/v1/trust/public/:partnerSlug/:orgSlug/documents/:documentId` | `rateLimiter` 20/min/IP | streams a public, linked, disclosure-confirmed, live document through the API (`getBlobStream`; no presigned URLs, per `routes/orgDocuments.ts`); `Content-Disposition: attachment`; the link check is live, so unlinking revokes downloads at once |
| GET | `/api/v1/trust/public/preview/:token` | isolated | draft payload for a valid preview token |

## 11. Editor (apps/web) and portal

Organization detail → **Trust Center** tab (hash state, repo convention). Components under `apps/web/src/components/trust/`:

- **Status card**: Unpublished / Published <date> · public URL (copy) · Preview · Publish/Unpublish · partner-home toggle (partner scope) · slug warning when invalid · trust-state notice when the partner cannot publish.
- **Publication authorization**: on first publish of a customer page the Publish dialog requires a checkbox ("The customer has authorized publication of this page") and an "Authorized by" field (name and role at the customer). Stored on `trust_pages`, written to `audit_logs`, shown on the status card afterwards with a "Change" action. Same pattern as document disclosure confirmation (§12): Breeze is publishing the customer's security data on the MSP's say-so, and the record of who said so is cheap and durable.
- **Controls**: the catalog with live pills exactly as the public sees them, show/hide per control, and the percentages / device-count / managed-by / indexable toggles. The pill component is shared with the portal page (`packages/shared` React component), so the editor is the preview.
- **Content**: intro rich text (the existing `RichTextEditor`, flow subset), security contact, website URL.
- **Documents**: pick from the org library (`policy`, `report`, `evidence` first), mark public with an explicit "approved for public release" confirmation, reorder. "Upload" links to the library.
- **Badge**: snippet with copy button.

Mutations go through `runAction`. Publish, unpublish, document disclosure changes and partner-home changes write `audit_logs` entries with actor, `publicationRevision` and `snapshotId` (precedent: `routes/orgDocuments.ts` document auditing).

Signed-in portal customers see a "Public trust page" link on the portal dashboard when published (one line; no portal editing in W1).

## 12. Documents

W1: public documents only, from `org_documents`. The public list exposes `ORG_DOCUMENT_META_COLUMNS` minus `uploadedByUserId`, `sha256` and `supersedesDocumentId`. A superseded document cannot be linked; linking the newer one is the publisher's action, not automatic, and the editor flags a linked document that has since been superseded.

W2: `gated` visibility → "Request access" → email verification (magic link, like portal password reset) → approval by an MSP user (notification, optional ticket) → 7-day download link (hashed token row, `billing_link_tokens` pattern) → optional NDA clickwrap text per page.

## 13. Security

- **Enumeration.** Slugs are public identifiers; the page is public by design. Every non-serving case is the same 404; a miss on the serving-set never reaches Postgres; slugs are length-bounded before any lookup; the payload is size-bounded (§6).
- **Suspended or untrusted tenants.** The liveness predicate (`buildPublicLinkLiveOrgPredicate`: org `active`/`trial`, partner `active`, neither soft-deleted) plus `trust_state = 'trusted'` is evaluated live on every request, before any cache read.
- **Content injection.** Publisher-controlled text is the intro, contact and URLs. Intro is sanitized at build time with the existing rich-text subset; URLs must be `http(s)`; the portal renders `introHtml` with `set:html` under the portal CSP. No publisher CSS or scripts (`portal_branding.custom_css` stays portal-only).
- **Preview tokens** are bound to one page id, 15 minutes, never serve a published payload.
- **No posture leakage.** Enforced by the payload contract test, not UI discipline.
- **Rate limits** as in §10. The global limiter falls back to in-memory when Redis is down (existing behavior); the card endpoint's cost is a Redis read or one indexed query.
- **Audit** as in §11.

## 14. Waves

**W1 — Publishable page.** Migration + schema + registrations; catalog + `loadPostureEvidence` extraction (report switched to it) + `evaluateTrustControls`; snapshot builder + `trust-page-snapshot` job + pointer semantics; `trust_page_publish` capability; authenticated routes; public card/payload/badge/document routes; portal pages and layout shell; web editor tab; audit; i18n in all 8 locales; self-hosting note. Deliberately in W1 because the page is not credible without them: method block, coverage floor, staleness display, MFA control, public documents with disclosure confirmation. Also W1, because it is data plus a chip: `frameworkRefs` on the catalog, the crosswalk table, framework chips on each control and the attribution line (§5.5).

**W2 — Depth.** Declared controls with expiry and re-declare reminders (§18.2); MFA *enforcement* from `m365_ca_policies`; gated documents + access requests; framework view (§5.5): controls grouped by framework with "N of M safeguards evidenced", publisher-selected frameworks (default CIS v8), declared controls carrying `frameworkRefs` to fill the non-telemetry gaps; GA gated on the CIS licensing confirmation (§18.13); subprocessors (prefilled from `securityProducts`, backup vendor, M365; manual add); FAQ blocks; 90-day "controls met" history from snapshots; partner-wide template for intro and default visibility.

**W3 — Distribution.** iframe embed with a per-page `frame-ancestors` allowlist (route-level CSP carve-out); portal self-edit for org admins (needs portal roles, #4562 W3); signed machine-readable payload (JWS) for insurer/auditor tooling; questionnaire answer export; per-benchmark-check safeguard mapping for `hardening_baseline` (§5.5); custom domain via #3282.

## 15. Testing

- **Unit**: `evaluateTrustControls` fixtures for every metric type, N/A, zero devices, coverage floor (79% vs 80% assessed), exposure inversion, MFA admin rule, evidence-age cutoff. Snapshot builder: hidden controls omitted and `catalogTotal` kept, opt-in nulls, sanitization (script, `javascript:` link, table stripped, oversized intro), document filtering (deleted, superseded, unlinked, unconfirmed).
- **Catalog**: every telemetry control has at least one `cis_v8` ref; every `frameworkRefs` entry resolves in the crosswalk table; every crosswalk `labelKey` exists in all 8 locales; the crosswalk file header names the source publication and version for each framework.
- **Contract**: payload `.strict()` + denylist (§6); `footer.frameworkAttributions` equals the set of frameworks referenced by shown controls. Slug resolution: soft-deleted org, wrong partner, case-insensitive, invalid slug rejected pre-query, probation partner → 404.
- **Tenancy**: shape-1 auto-discovery in `rls-coverage.integration.test.ts`; `tenantCascade`, `orgMergeRegistry` (custom executor retires loser; survivor marked for rebuild), `tenant-export-policy` suites (Integration Tests job); forged cross-tenant insert as `breeze_app` fails.
- **Routes**: unpublished/unknown/archived/untrusted → identical 404; a card request for an unknown slug pair performs zero SQL (query-count assertion); publish with stale `expectedRevision` → 409; publish then GET serves the new `snapshotId`; unpublish then GET 404s in the same second (live `published_at`, not cache); refresh does not flip `is_current` when a publish raced; exactly one `is_current` per page under concurrent publish + refresh; trust-state change to `restricted` empties the partner's serving-set entries; document download refuses unlinked/unconfirmed/superseded; preview token expiry and page mismatch; 429 on the payload bucket; card endpoint exempt from the per-IP bucket.
- **Erasure**: `tenantCascade.integration.test.ts` children-before-parents passes with no FK cycle; deleting an org with a published page succeeds.
- **Web**: `no-silent-mutations`; registry tests if the tab touches nav registries; locale parity for new keys across 8 locales.
- **E2E (Playwright)**: publish from the editor → public portal page SSR shows title/OG, client render shows controls, method and a document → unpublish → 404.

## 16. Open questions resolved by review

- *Snapshot vs live*: snapshot for posture, live for authorization and pointer (§7).
- *Portal vs web*: portal (§8).
- *Hiding controls equals a passing-only page*: allowed, but curation is always disclosed (`catalogTotal`, "publisher-selected"), no overall grade, badge carries no counts (§4, §6, §8).
- *Documents in W1*: kept, with disclosure confirmation, pinned versions and live revocation (§9, §12).
- *Entitlement*: none; publish gated on partner trust state; footer removal is an operator-granted boolean (§9).

## 17. Non-goals

Certification language or any "compliant with" / "meets IG1" wording (§5.5); verbatim framework text; the posture score or any overall grade; device, vulnerability or patch detail; custom domains (#3282), new top-level paths, per-feature domain fields; a partner-level *aggregate* page across customer orgs (leaks customer aggregates; §18.8); portal-side editing in W1; an entitlement framework; visitor language negotiation in W1.

## 18. Decisions (all defaults approved by Todd, 2026-10-13)

Approved as written below, plus the publication authorization attestation (§9, §10, §11) raised under decision 9. Plan-time amendments that change text in this document are listed in §19 and were made after approval; they are implementation facts, not new product decisions, except where marked.

1. **Audience ranking.** Default: insurer questions first, then due diligence, then audit.
2. **Declared controls (W2).** Default: allowed, labeled "declared by <MSP>", expire after 365 days, reminder at 30 days. Reopens the parked backup-evidence question. A "no" removes W2's first item and keeps subprocessors telemetry-only.
3. **Footer removal.** Default: `trust_page_unbranded` is operator-granted; whether it maps to a plan tier or an add-on is a billing call. The feature itself is free on every plan.
4. **Default exposure.** Default: status pills only; percentages and device count off.
5. **Thresholds and floors.** Default: coverage ≥ 95% met, ≥ 80% attention; coverage floor 80% assessed; evidence age 30 days (report default); MFA `met` requires zero admins without MFA.
6. **URL shape.** `/portal/trust/<partner-slug>/<org-slug>` and `/portal/trust/<partner-slug>` until #3282. Alternative: `/trust/*` with an ingress change for every self-hoster.
7. **Locale.** Default: the page renders in the org's portal locale (fallback `en`), stored control ids and statuses, translated presentation; no visitor negotiation in W1. The plan must verify `apps/portal` has an i18n mechanism for public pages before committing to 8-locale rendering there; if it does not, W1 renders control copy in `en` and adds portal i18n as its own task.
8. **Partner-wide template / aggregate page.** Default: template W2, aggregate page never.
9. **Who edits in W1.** Default: MSP users with org-management permission; partner-home needs partner scope. Portal admins W3.
10. **"Managed by" default.** Default: on. The partner slug is in the URL regardless.
11. **Publish gate = partner `trusted`.** Default: yes. Probation partners see "publishing opens once your account is trusted".
12. **Badge without counts.** Default: yes ("verified by Breeze · updated <date>"). Alternative: show "N controls met" and accept that it is over a curated set.
13. **Framework crosswalk and CIS licensing (§5.5).** Default: W1 ships chips with identifiers, Breeze's own labels and a CIS attribution line; W2's framework view defaults to CIS v8 only, with Essential Eight and Cyber Essentials suggested by partner country; W2 GA waits for written CIS confirmation or a SecureSuite vendor membership. Alternative: drop CIS v8 and lead with NIST CSF 2.0 (public domain), which insurers reference less often. Todd owns the CIS contact; it is an outward-facing action and is not taken by the plan.

## 19. Plan-time amendments (2026-10-13)

Found while writing `docs/superpowers/plans/2026-10-13-trust-center-w1.md` against the code. Each changes text above; the plan carries the detail.

1. **Card path** is `/api/v1/trust/card/:partnerSlug[/:orgSlug]`: `registerGlobalRateLimitSkipPrefix` matches prefixes only. Payload, badge, documents and preview stay under `/api/v1/trust/public/` (§8, §10).
2. **Redis unavailable:** the unlimited card endpoint answers 503 + `Retry-After: 30` rather than touching Postgres; the rate-limited payload/badge/document endpoints skip the serving-set and resolve live (§7, §13).
3. **Intro is sanitized HTML** from the existing TipTap editor, not Markdown (§4, §6, §13).
4. **Portal renders English in W1.** `apps/portal` has no i18n runtime at all (confirmed), so the §18.7 fallback applies: the catalog carries English `title`/`description` used by the public page and the editor; portal i18n and per-control translations are a W2 item (§14).
5. **No shared React pill** (`packages/shared` has no React): shared exports `trustStatusPillRole`; each app renders its own pill (§11).
6. **Eligible devices exclude decommissioned devices.** The report inherits this (§5.3, §5.4).
7. **Report denominators for EDR / endpoint protection** become `passing / assessed` with unknown counts, so page and PDF agree exactly (§5.3, §5.4, principle 3).
8. **`backups_verified` is strict:** Breeze-verified restore points only (§5.2).
9. **Merge:** `trust_pages` custom executor deletes the loser's page (children cascade) and clears the survivor's `last_evaluated_at`; children are registered as plain repoint (§9).
10. **Publish requires MFA** (`requireMfa()`), and partner-home set/clear requires `canManagePartnerWidePolicies` (§10).
11. **Self-hosted:** when `partnerTrustMode() === 'off'` neither publish nor the public resolve checks `trust_state` (§9 Trust and entitlement).
12. **Editor tab visibility** is `organizations:read`; every mutation requires `organizations:write` (§11, §18.9).
13. **Payload `coverageNote` replaced by `assessed` / `eligible` / `unit` numbers** so W2 can localize (§6).
14. **`trust_page_unbranded` is API-only in W1** (`PATCH /orgs/partners/:id`, system scope + MFA), exactly like `aiForOfficeEnabled`, which also has no admin UI (§9, §18.3).
15. **Hourly slot** `'11 * * * *'` (the ≡2 mod 5 lane is full; the schedule contract test decides) (§7).
16. **W1 editing is partner/system scope only**: the org record page refuses org-scoped sign-ins and the routes use `requireScope('partner', 'system')` (§11).

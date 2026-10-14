---
title: Trust Center W1 — publishable page (implementation plan)
spec: docs/superpowers/specs/trust-center/2026-10-12-trust-center-design.md
tracking_issue: (added by register_feature)
status: ready for Todd's review; execution method to be chosen
---

# Trust Center W1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any Breeze organization can publish one public, Breeze-hosted security-posture page (`/portal/trust/<partner-slug>/<org-slug>`) showing telemetry-verified controls, public documents, framework chips and a badge, maintained from a "Trust Center" tab on the org record.

**Architecture:** A code-defined control catalog and a pure evaluator live in `packages/shared`; the API extracts the posture report's evidence loading into `services/postureEvidence.ts` (the report switches to it in the same PR), builds immutable snapshot payloads validated by a strict Zod schema, stores them in three new shape-1 tables, and serves them through unauthenticated routes gated by a Redis serving-set plus a live liveness/trust predicate. The portal renders the page (SSR card for title/OG, React island for the body); the web app gets an editor tab.

**Tech Stack:** TypeScript, Hono, Drizzle (queries only, hand-written SQL migrations), PostgreSQL RLS, BullMQ + Redis, Zod 4, Astro 7 + React 19 (portal and web), Tailwind v4, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/trust-center/2026-10-12-trust-center-design.md` (all §18 decisions approved 2026-10-13; §19 "Plan-time amendments" records what this plan changed and why). Executors read both.

## Global Constraints

- Every new table is tenancy **shape 1**: `org_id NOT NULL`, RLS enabled + forced + four `breeze_org_isolation_*` policies **in the creating migration**; registered in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY` in the same PR (`docs/agents/tenancy-rls.md`).
- Every composite FK that references an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE`. The `(org_id, partner_id) → organizations(id, partner_id)` FK is declared deferrable too (repo precedent).
- Migrations are hand-written, idempotent, no inner `BEGIN`/`COMMIT`, named to sort after `2026-12-18-100000-partner-api-idempotency-keys.sql` (re-check with the README command before committing). DDL-only files need no `set_config('breeze.scope', ...)`.
- Public routes run every DB operation inside `runOutsideDbContext(() => withSystemDbAccessContext(...))`; `rateLimiter()` is never called inside a held DB context (#1105 tripwire).
- Public posture is never computed live. Every non-serving case on a public route returns the **same** generic 404 body `{ error: 'Not found', code: 'NOT_FOUND' }`. Never 410.
- Payload never contains: device ids/hostnames, IPs, usernames/UPNs, CVE ids, open ports, pending patches, `top_issues`, the 0–100 posture score, factor weights. Enforced by `trustPagePublicPayload.contract.test.ts`.
- Copy never says "compliant with", "certified", "meets IG1". Framework labels are Breeze's own paraphrases; CIS attribution line is always rendered when any shown control references `cis_v8`.
- Slugs in public URLs must match `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$` (max 63 chars) and are checked before any Redis or SQL call.
- Thresholds (by reference to `securityCompliancePostureConfigSchema` defaults): met ≥ 95, attention ≥ 80, coverage floor 80% assessed, evidence age 30 days (`maxSecurityStatusAgeDays`), definitions 7 days, min password length 8, max local admins 2. MFA `met` also requires `admins_without_mfa = 0`.
- Web mutations go through `runAction`; new tab files are added to `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`.
- New web i18n keys exist in all 8 locales (`en, pt-BR, es-419, fr-FR, fr-CA, de-DE, it-IT, tr-TR`) and are really translated (translationCoverage cap). Portal has no i18n: public page copy is English in W1 (spec §19.4).
- No portal inline `style=` attributes (CSP `style-src-attr 'none'`, `noInlineStyles.test.ts`); no literal `href="/..."` (use `withBase`, `basePathCoverage.test.ts`).
- Never commit IPs, hostnames or internal domains. Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Stacked PRs run no CI: `gh workflow run CI --ref <branch>`. Integration/contract suites need `pnpm test-stack up` (tear down after).

## Plan-time deviations from the spec (all written into spec §19 by the spec commit that accompanies this plan)

1. **Card endpoint path** is `/api/v1/trust/card/:partnerSlug[/:orgSlug]` (own prefix) because `registerGlobalRateLimitSkipPrefix` matches path prefixes only. Payload, badge, documents, preview stay under `/api/v1/trust/public/`.
2. **Redis unavailable:** the card endpoint (unlimited) returns 503 + `Retry-After: 30` rather than touching Postgres; payload/badge/document endpoints (rate-limited, in-memory fallback) skip the serving-set and go straight to the live resolve query.
3. **Intro is sanitized HTML** (`intro_html`, TipTap `RichTextEditor`, server-side `sanitizeFlowRichTextHtml`, ≤ 5,000 chars) instead of Markdown. Sanitized on PUT and again in the builder.
4. **Portal renders English in W1.** The catalog carries English `title`/`description`; the editor shows the same strings. Portal i18n and per-control translations move to W2 (§18.7 fallback clause invoked).
5. **No shared React pill.** `packages/shared` has no React; it exports `trustStatusPillRole()`; each app renders its own pill.
6. **Eligible devices exclude `status = 'decommissioned'`** (matches the posture worker). The report inherits this via the shared loader.
7. **EDR / endpoint-protection denominators.** The loader reports `{eligible, assessed, passing}` where `assessed` = eligible devices with any evidence (a `security_status` row, an EDR agent row, or `last_seen_at` within 30 days). The report switches to `passing/assessed` for `edrCoveragePct`/`anyAvCoveragePct` and gains `edrUnknownCount`/`anyAvUnknownCount`; `unprotectedCount` keeps its fleet-wide meaning. Page and PDF agree by construction (principle 3 holds).
8. **`backups_verified` is strict:** only `backup_verifications` rows with `status = 'passed'` (type `integrity` or `test_restore`) completed within the evidence window count. Eligible = devices with a Breeze `backup_jobs` row. Third-party-provider-only orgs read `not_assessed / no_data`. No provider "covered" shortcut.
9. **Merge:** `trust_pages` custom executor deletes the loser's page (children `ON DELETE CASCADE`) and clears the survivor's `last_evaluated_at`; children are registered as plain `repoint` (zero rows remain after the cascade); `CUSTOM_WOULD_DROP_COUNTS` entry added.
10. **Publish requires MFA** (`requireMfa()`), matching `routes/orgPortalSettings.ts`. Partner-home set/clear requires `canManagePartnerWidePolicies(auth)`.
11. **Self-hosted:** when `partnerTrustMode() === 'off'`, neither publish nor the public resolve checks `trust_state` (otherwise a self-hosted non-`trusted` partner could publish into a 404).
12. **Tab visibility** uses `organizations:read` (status visible to read-only MSP users); every mutation requires `organizations:write`. Two assertions in `orgRecordTabs.test.ts` change.
13. **Payload `coverageNote` string is replaced by numbers** `assessed`/`eligible`/`unit` so W2 can localize.
14. **`trust_page_unbranded`** is API-only in W1 (`PATCH /orgs/partners/:id`, system scope + MFA), mirroring `aiForOfficeEnabled`; no admin UI exists for that precedent either.
15. **Hourly slot** `'11 * * * *'` (free in `scheduleRegistry.ts`; the contract test confirms).
16. **W1 editing is partner/system scope only** (`OrganizationRecordPage` refuses org-scoped sign-ins; routes use `requireScope('partner', 'system')`).

## Review Focus

1. **Uppercase in the partner slug of a URL** (`partners.slug` is case-sensitive unique; org slug is case-insensitive): must 404 before any lookup — the regex rejects uppercase. Test in Task 8.
2. **Org with zero eligible devices**: every device control `not_assessed / no_data`, `summary.deviceCount` null, page still publishable. Test in Task 7.
3. **Publish racing the hourly refresh on the same page**: exactly one `is_current` row survives; the publish wins (revision check). Test in Task 9 and Task 12.
4. **A linked document superseded after disclosure confirmation**: public list omits it and the download 404s; the editor flags it. Test in Task 7 and Task 11.
5. **Partner moved to `restricted` between the card fetch and the payload fetch**: the payload route 404s on its own live check regardless of the serving-set. Test in Task 11.

## PR boundaries

- **PR A1 — foundations** (Tasks 1–6): shared catalog/evaluator/validators, migrations + registrations, loader extraction + report switch. Runs the tenancy contract suites and the report suites.
- **PR A2 — publication and public API** (Tasks 7–12), stacked on A1.
- **PR B — UI** (Tasks 13–17), stacked on A2.
- Task 18 (verification sweep) runs before each PR is marked ready.

Branch naming after `register_feature`: `feature/<parent#>-trust-center/wave-<w1-subissue#>`; PR bodies carry `Closes #<w1-subissue>` only on the last PR of the wave (PR B), and `Part of #<w1-subissue>` on A1/A2.

## File Structure

**packages/shared**
- `src/trustCenter/types.ts` — ids, categories, metric/unit/status unions, `TrustControlDefinition`, `ControlEvidence`, `PostureControlEvidence`, `TrustControlAssessment`, `TrustEvaluationPolicy`.
- `src/trustCenter/frameworkCrosswalk.ts` — `TRUST_FRAMEWORKS`, `FRAMEWORK_CROSSWALK` (`(framework, ref) → { ig?, label }`), `FRAMEWORK_META` (name, attribution text, url, safeguard totals).
- `src/trustCenter/controlCatalog.ts` — `TRUST_CONTROL_CATALOG_VERSION`, `TRUST_CONTROL_CATALOG` (15 entries), lookup helpers.
- `src/trustCenter/evaluate.ts` — `evaluateTrustControls`, `trustStatusPillRole`, `DEFAULT_TRUST_EVALUATION_POLICY`.
- `src/trustCenter/index.ts` — barrel; exported from `src/index.ts`.
- `src/validators/trustCenter.ts` — `TRUST_SLUG_RE`, `trustSlugSchema`, `trustPagePublicPayloadSchema` (strict), `trustPageUpdateSchema`, `trustPageDocumentsUpdateSchema`, `trustPagePublishSchema`, `trustPagePartnerHomeSchema`; re-exported from `src/validators/index.ts`.

**apps/api**
- `migrations/2026-12-18-110000-partners-trust-page-unbranded.sql` — partner column.
- `migrations/2026-12-18-110100-trust-pages.sql` — three tables, enum, RLS, immutability trigger, indexes.
- `src/db/schema/trustPages.ts` — Drizzle tables; barrel line in `src/db/schema/index.ts`; `trustPageUnbranded` column in `src/db/schema/orgs.ts`.
- `src/services/tenantCascade.ts`, `src/services/orgMergeRegistry.ts`, `src/services/orgMergeCustomExecutors.ts`, `src/services/tenantExportPolicyRegistry.ts` — registrations.
- `src/services/postureEvidence.ts` — `loadPostureEvidence(scope, policy, asOf)` (extracted from the report) + `postureEvidencePolicyFromReportConfig`.
- `src/services/postureEvidenceNetNew.ts` — the three net-new readers (M365 MFA, backups verified, continuous monitoring).
- `src/services/securityComplianceReport.ts` — switched to the loader.
- `src/services/trustPage/payloadBuilder.ts` — `buildTrustPagePayload`, `payloadSha256`, `sanitizeIntro`.
- `src/services/trustPage/servingSet.ts` — Redis serving-set + snapshot cache.
- `src/services/trustPage/resolve.ts` — slug validation + live resolve query.
- `src/services/trustPage/publication.ts` — `buildSnapshotForPage`, `publishTrustPage`, `unpublishTrustPage`, `refreshTrustPage`, `TrustPageError`.
- `src/services/trustPage/previewToken.ts` — HS256 preview JWT (jose, shared keyring).
- `src/services/partnerTrust.ts` — `'trust_page_publish'` capability + serving-set hook in `setTrustState`.
- `src/routes/trustPage.ts` — authenticated `/orgs/:orgId/trust-page/*`.
- `src/routes/trustPagePublic.ts` — `/trust/card/*` and `/trust/public/*`.
- `src/middleware/globalRateLimit.ts` — `trustpublic` isolated bucket; `src/middleware/partnerGuard.ts` — exempt prefixes.
- `src/jobs/trustPageSnapshotWorker.ts` — hourly refresh; `src/jobs/scheduleRegistry.ts`, `src/services/workerRegistry.ts`, `src/jobs/workerReadinessManifest.ts` registrations.
- `src/routes/orgs.ts` — `trustPageUnbranded` in `updatePartnerSchema` and the partner select.

**apps/portal**
- `src/lib/api.ts` — `portalApi.getTrustCard`, `getTrustPage`, `getTrustPreview`, types.
- `src/layouts/TrustPageLayout.astro` — public shell with title/description/OG/canonical/robots props.
- `src/pages/trust/[partnerSlug]/index.astro`, `src/pages/trust/[partnerSlug]/[orgSlug].astro`, `src/pages/trust/preview/[token].astro`.
- `src/components/trust/TrustPageView.tsx` (+ `TrustStatusPill.tsx`, `trustPageFormat.ts`).
- `src/middleware.ts` — `/trust/` header branch; `src/lib/disabledPageCoverage.test.ts` allowlist.

**apps/web**
- `src/lib/api/trustPage.ts` — typed client over `OrgFetch`.
- `src/components/organizations/record/orgRecordTabs.ts`, `OrganizationRecordPage.tsx` — `trust` tab.
- `src/components/trustCenter/TrustCenterTab.tsx`, `TrustStatusCard.tsx`, `TrustPublishDialog.tsx`, `TrustControlsSection.tsx`, `TrustContentSection.tsx`, `TrustDocumentsSection.tsx`, `TrustBadgeSnippet.tsx`, `trustCenterPill.ts`.
- `src/locales/<8>/organizations.json` — `orgRecord.tabs.trust`, `orgRecord.trust.*`.

**apps/docs**
- `src/content/docs/security/trust-center.mdx` — feature + self-hosting note ("nothing to do").

---

### Task 1: Shared types, framework crosswalk and control catalog

**Files:**
- Create: `packages/shared/src/trustCenter/types.ts`
- Create: `packages/shared/src/trustCenter/frameworkCrosswalk.ts`
- Create: `packages/shared/src/trustCenter/controlCatalog.ts`
- Create: `packages/shared/src/trustCenter/index.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from './trustCenter';`)
- Test: `packages/shared/src/trustCenter/controlCatalog.test.ts`

**Interfaces:**
- Produces: `TELEMETRY_CONTROL_IDS`, `TelemetryControlId`, `TrustControlCategory`, `TrustControlStatus`, `TrustNotAssessedReason`, `TrustControlDefinition`, `ControlEvidence`, `PostureControlEvidence`, `TrustControlAssessment`, `TrustEvaluationPolicy`, `TrustFramework`, `FrameworkRef`, `TRUST_FRAMEWORKS`, `FRAMEWORK_CROSSWALK`, `FRAMEWORK_META`, `TRUST_CONTROL_CATALOG`, `TRUST_CONTROL_CATALOG_VERSION`, `trustControlById()`, `TRUST_CONTROL_CATEGORY_ORDER`.
- Consumed by Tasks 2, 3, 5–7, 10, 14, 15.

- [ ] **Step 1: Write the failing catalog contract test**

```ts
// packages/shared/src/trustCenter/controlCatalog.test.ts
import { describe, expect, it } from 'vitest';
import {
  TRUST_CONTROL_CATALOG, TRUST_CONTROL_CATALOG_VERSION, TELEMETRY_CONTROL_IDS, trustControlById,
} from './controlCatalog';
import { FRAMEWORK_CROSSWALK, FRAMEWORK_META, TRUST_FRAMEWORKS } from './frameworkCrosswalk';

describe('trust control catalog', () => {
  it('has exactly the 15 W1 telemetry controls, each once', () => {
    expect(TRUST_CONTROL_CATALOG.map((c) => c.id).sort()).toEqual([...TELEMETRY_CONTROL_IDS].sort());
    expect(new Set(TRUST_CONTROL_CATALOG.map((c) => c.id)).size).toBe(15);
  });

  it('every control has unique insurerRank and non-empty English copy', () => {
    const ranks = TRUST_CONTROL_CATALOG.map((c) => c.insurerRank);
    expect(new Set(ranks).size).toBe(ranks.length);
    for (const c of TRUST_CONTROL_CATALOG) {
      expect(c.title.length).toBeGreaterThan(3);
      expect(c.description.length).toBeGreaterThan(10);
      expect(c.source).toBe('telemetry');
    }
  });

  it('every control references at least one CIS v8 safeguard and every ref resolves in the crosswalk', () => {
    for (const c of TRUST_CONTROL_CATALOG) {
      expect(c.frameworkRefs.some((r) => r.framework === 'cis_v8'), c.id).toBe(true);
      for (const r of c.frameworkRefs) {
        expect(TRUST_FRAMEWORKS).toContain(r.framework);
        expect(FRAMEWORK_CROSSWALK[r.framework][r.ref], `${c.id} → ${r.framework} ${r.ref}`).toBeDefined();
      }
    }
  });

  it('crosswalk labels are Breeze paraphrases, never framework-verbatim markers, and every framework has meta', () => {
    for (const fw of TRUST_FRAMEWORKS) {
      expect(FRAMEWORK_META[fw].name.length).toBeGreaterThan(2);
      expect(FRAMEWORK_META[fw].sourceUrl.startsWith('https://')).toBe(true);
      expect(FRAMEWORK_META[fw].safeguardTotal).toBeGreaterThan(0);
      for (const [ref, entry] of Object.entries(FRAMEWORK_CROSSWALK[fw])) {
        expect(ref.length).toBeGreaterThan(0);
        expect(entry.label.length).toBeLessThanOrEqual(60);
        expect(entry.label).not.toMatch(/compliant|certified/i);
      }
    }
  });

  it('copy never implies certification', () => {
    for (const c of TRUST_CONTROL_CATALOG) {
      expect(`${c.title} ${c.description}`).not.toMatch(/compliant with|certified|meets IG/i);
    }
  });

  it('exposes a semver-ish catalog version and a lookup', () => {
    expect(TRUST_CONTROL_CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(trustControlById('disk_encryption')?.category).toBe('data_protection');
    expect(trustControlById('nope' as never)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && npx vitest run src/trustCenter/controlCatalog.test.ts`
Expected: FAIL — cannot resolve `./controlCatalog`.

- [ ] **Step 3: Write `types.ts`**

```ts
// packages/shared/src/trustCenter/types.ts
export const TRUST_FRAMEWORKS = ['cis_v8', 'essential_eight', 'cyber_essentials', 'nist_csf_2'] as const;
export type TrustFramework = (typeof TRUST_FRAMEWORKS)[number];
export interface FrameworkRef { framework: TrustFramework; ref: string }

export const TRUST_CONTROL_CATEGORY_ORDER = [
  'endpoint_protection', 'patching_hardening', 'identity_access', 'data_protection', 'monitoring',
] as const;
export type TrustControlCategory = (typeof TRUST_CONTROL_CATEGORY_ORDER)[number];

export const TELEMETRY_CONTROL_IDS = [
  'endpoint_protection', 'edr_coverage', 'definitions_current', 'host_firewall',
  'os_patch_currency', 'hardening_baseline',
  'password_policy', 'least_privilege', 'identity_provider', 'mfa_registered_m365', 'privileged_access',
  'disk_encryption', 'backups_verified',
  'dns_filtering', 'continuous_monitoring',
] as const;
export type TelemetryControlId = (typeof TELEMETRY_CONTROL_IDS)[number];

/** coverage_pct: passing/assessed, higher is better. exposure_pct: (assessed-passing)/assessed, lower is better.
 *  boolean: one org-level fact. pass_rate: `aggregatePct` (mean per-device pass rate), higher is better. */
export type TrustControlMetric = 'coverage_pct' | 'exposure_pct' | 'boolean' | 'pass_rate';
export type TrustControlUnit = 'devices' | 'users' | 'org';
export type TrustControlStatus = 'met' | 'attention' | 'not_met' | 'not_assessed';
export type TrustNotAssessedReason = 'insufficient_telemetry' | 'no_data' | 'not_applicable';

export interface TrustControlDefinition {
  id: TelemetryControlId;
  category: TrustControlCategory;
  /** English copy — the W1 source of truth for the public page and the editor (spec §19.4). */
  title: string;
  description: string;
  source: 'telemetry';
  metric: TrustControlMetric;
  unit: TrustControlUnit;
  /** 1 = asked first on insurer questionnaires. Unique. */
  insurerRank: number;
  frameworkRefs: readonly FrameworkRef[];
  /** When set, `met` additionally requires `evidence.gate === true`. */
  gate?: { label: string };
}

/** Counts, never percentages: the evaluator owns the denominator rule (spec §5.4). */
export interface ControlEvidence {
  eligible: number;
  assessed: number;
  /** Units meeting the control among `assessed` (for exposure metrics: units WITHIN the limit). */
  passing: number;
  /** pass_rate metrics only: mean per-device pass rate 0–100. */
  aggregatePct: number | null;
  /** ISO timestamp of the newest evidence among assessed units; null when none. */
  newestEvidenceAt: string | null;
  /** Secondary gate (MFA: admins_without_mfa === 0). Undefined when the control has no gate. */
  gate?: boolean | null;
}
export type PostureControlEvidence = Record<TelemetryControlId, ControlEvidence>;

export interface TrustEvaluationPolicy {
  coverageFloorPct: number;       // 80
  thresholds: { met: number; attention: number }; // 95 / 80
  evidenceMaxAgeDays: number;     // 30
}

export interface TrustControlAssessment {
  id: TelemetryControlId;
  category: TrustControlCategory;
  source: 'telemetry';
  unit: TrustControlUnit;
  status: TrustControlStatus;
  reason: TrustNotAssessedReason | null;
  /** coverage/pass_rate: passing %. exposure: exposure %. boolean: null. Null when not_assessed. */
  percent: number | null;
  assessed: number;
  eligible: number;
  evidenceAsOf: string | null;
  frameworkRefs: readonly FrameworkRef[];
}
```

- [ ] **Step 4: Write `frameworkCrosswalk.ts`** (labels are Breeze paraphrases; the header records the source documents; verify each number against the current publication while implementing and correct any that differ)

```ts
// packages/shared/src/trustCenter/frameworkCrosswalk.ts
// Sources (verify at implementation time, record the version you checked):
//   cis_v8          — CIS Critical Security Controls v8.1 (cisecurity.org/controls). Licensed CC BY-NC-ND 4.0;
//                     identifiers + Breeze's own labels only, attribution rendered (spec §5.5, §18.13).
//   essential_eight — ACSC Essential Eight (cyber.gov.au), CC BY 4.0.
//   cyber_essentials— NCSC Cyber Essentials requirements v3.2, Open Government Licence; name is a trademark.
//   nist_csf_2      — NIST CSF 2.0 (nist.gov), public domain.
import type { TrustFramework } from './types';
export { TRUST_FRAMEWORKS } from './types';

export interface CrosswalkEntry { label: string; ig?: 1 | 2 | 3 }

export const FRAMEWORK_META: Record<TrustFramework, {
  name: string; shortName: string; sourceUrl: string; safeguardTotal: number; attribution: string;
}> = {
  cis_v8: {
    name: 'CIS Critical Security Controls v8', shortName: 'CIS v8',
    sourceUrl: 'https://www.cisecurity.org/controls', safeguardTotal: 153,
    attribution: 'CIS Controls® are a registered trademark of the Center for Internet Security, Inc. Safeguard identifiers are referenced with Breeze\'s own descriptions; see cisecurity.org/controls for the current text.',
  },
  essential_eight: {
    name: 'ACSC Essential Eight', shortName: 'Essential Eight',
    sourceUrl: 'https://www.cyber.gov.au/resources-business-and-government/essential-cyber-security/essential-eight',
    safeguardTotal: 8, attribution: 'Essential Eight © Commonwealth of Australia (ACSC), CC BY 4.0.',
  },
  cyber_essentials: {
    name: 'NCSC Cyber Essentials', shortName: 'Cyber Essentials',
    sourceUrl: 'https://www.ncsc.gov.uk/cyberessentials/overview', safeguardTotal: 5,
    attribution: 'Cyber Essentials is a UK Government scheme operated by the NCSC. Referenced by control name only.',
  },
  nist_csf_2: {
    name: 'NIST Cybersecurity Framework 2.0', shortName: 'NIST CSF 2.0',
    sourceUrl: 'https://www.nist.gov/cyberframework', safeguardTotal: 106,
    attribution: 'NIST CSF 2.0 is a work of the U.S. Government (public domain).',
  },
};

export const FRAMEWORK_CROSSWALK: Record<TrustFramework, Record<string, CrosswalkEntry>> = {
  cis_v8: {
    '1.1': { label: 'Maintain a detailed asset inventory', ig: 1 },
    '3.6': { label: 'Encrypt data on end-user devices', ig: 1 },
    '4.1': { label: 'Maintain a secure configuration process', ig: 1 },
    '4.2': { label: 'Secure configuration for network infrastructure', ig: 1 },
    '4.5': { label: 'Host-based firewall on end-user devices', ig: 1 },
    '5.2': { label: 'Unique, strong passwords', ig: 1 },
    '5.4': { label: 'Restrict admin rights to dedicated accounts', ig: 1 },
    '5.6': { label: 'Centralized account management', ig: 2 },
    '6.3': { label: 'MFA for externally exposed applications', ig: 1 },
    '6.5': { label: 'MFA for administrative access', ig: 1 },
    '6.7': { label: 'Centralized access control', ig: 2 },
    '6.8': { label: 'Role-based access control', ig: 3 },
    '7.3': { label: 'Automated operating-system patching', ig: 1 },
    '8.2': { label: 'Collect audit logs', ig: 1 },
    '9.2': { label: 'DNS filtering', ig: 1 },
    '10.1': { label: 'Anti-malware deployed and maintained', ig: 1 },
    '10.2': { label: 'Automatic anti-malware signature updates', ig: 1 },
    '10.7': { label: 'Behavior-based anti-malware', ig: 2 },
    '11.2': { label: 'Automated backups', ig: 1 },
    '11.3': { label: 'Protect recovery data', ig: 1 },
    '11.5': { label: 'Test data recovery', ig: 2 },
    '13.2': { label: 'Host-based intrusion detection', ig: 2 },
  },
  essential_eight: {
    patch_os: { label: 'Patch operating systems' },
    user_app_hardening: { label: 'User application hardening' },
    restrict_admin: { label: 'Restrict administrative privileges' },
    mfa: { label: 'Multi-factor authentication' },
    backups: { label: 'Regular backups' },
  },
  cyber_essentials: {
    firewalls: { label: 'Firewalls' },
    secure_configuration: { label: 'Secure configuration' },
    security_update_management: { label: 'Security update management' },
    user_access_control: { label: 'User access control' },
    malware_protection: { label: 'Malware protection' },
  },
  nist_csf_2: {
    'PR.PS': { label: 'Platform security' },
    'PR.PS-01': { label: 'Configuration management practices' },
    'PR.PS-02': { label: 'Software maintained and patched' },
    'PR.IR': { label: 'Technology infrastructure resilience' },
    'PR.AA': { label: 'Identity management and access control' },
    'PR.AA-01': { label: 'Identities and credentials managed' },
    'PR.AA-03': { label: 'Users and services authenticated' },
    'PR.AA-05': { label: 'Least-privilege access' },
    'PR.DS-01': { label: 'Data-at-rest protected' },
    'RC.RP': { label: 'Incident recovery plan execution' },
    'DE.CM': { label: 'Continuous monitoring' },
  },
};
```

- [ ] **Step 5: Write `controlCatalog.ts`**

```ts
// packages/shared/src/trustCenter/controlCatalog.ts
import { TELEMETRY_CONTROL_IDS, type TelemetryControlId, type TrustControlDefinition } from './types';
export { TELEMETRY_CONTROL_IDS };

/** Bump the suffix whenever an entry's semantics change; the date is the catalog's publication date. */
export const TRUST_CONTROL_CATALOG_VERSION = '2026-10-13.1';

const cis = (ref: string) => ({ framework: 'cis_v8', ref }) as const;
const e8 = (ref: string) => ({ framework: 'essential_eight', ref }) as const;
const ce = (ref: string) => ({ framework: 'cyber_essentials', ref }) as const;
const nist = (ref: string) => ({ framework: 'nist_csf_2', ref }) as const;

export const TRUST_CONTROL_CATALOG: readonly TrustControlDefinition[] = [
  { id: 'mfa_registered_m365', category: 'identity_access', source: 'telemetry', metric: 'coverage_pct', unit: 'users', insurerRank: 1,
    title: 'MFA registered (Microsoft 365)',
    description: 'Share of Microsoft 365 users with a registered multi-factor authentication method. Registration is not enforcement; every admin account must also be registered.',
    frameworkRefs: [cis('6.3'), cis('6.5'), e8('mfa'), ce('user_access_control'), nist('PR.AA-03')],
    gate: { label: 'All admin accounts have MFA registered' } },
  { id: 'edr_coverage', category: 'endpoint_protection', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 2,
    title: 'Endpoint detection and response (EDR)',
    description: 'Share of assessed devices running a Breeze-managed EDR agent.',
    frameworkRefs: [cis('10.7'), cis('13.2'), ce('malware_protection'), nist('DE.CM')] },
  { id: 'backups_verified', category: 'data_protection', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 3,
    title: 'Backups verified restorable',
    description: 'Share of Breeze-backed-up devices with a passed integrity check or test restore inside the evidence window. Configured-but-unverified backups do not count.',
    frameworkRefs: [cis('11.2'), cis('11.3'), cis('11.5'), e8('backups'), nist('RC.RP')] },
  { id: 'os_patch_currency', category: 'patching_hardening', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 4,
    title: 'Operating-system patches current',
    description: 'Share of patch-scanned devices with no outstanding critical patch.',
    frameworkRefs: [cis('7.3'), e8('patch_os'), ce('security_update_management'), nist('PR.PS-02')] },
  { id: 'disk_encryption', category: 'data_protection', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 5,
    title: 'Disk encryption',
    description: 'Share of assessed devices reporting full-disk encryption (BitLocker, FileVault or LUKS).',
    frameworkRefs: [cis('3.6'), nist('PR.DS-01')] },
  { id: 'endpoint_protection', category: 'endpoint_protection', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 6,
    title: 'Endpoint protection active',
    description: 'Share of assessed devices with real-time anti-malware protection on, from any supported product.',
    frameworkRefs: [cis('10.1'), ce('malware_protection'), nist('PR.PS')] },
  { id: 'least_privilege', category: 'identity_access', source: 'telemetry', metric: 'exposure_pct', unit: 'devices', insurerRank: 7,
    title: 'Local administrator accounts limited',
    description: 'Share of assessed devices with more local administrator accounts than the policy allows (lower is better).',
    frameworkRefs: [cis('5.4'), e8('restrict_admin'), ce('user_access_control'), nist('PR.AA-05')] },
  { id: 'privileged_access', category: 'identity_access', source: 'telemetry', metric: 'boolean', unit: 'org', insurerRank: 8,
    title: 'Privileged access controlled',
    description: 'Elevation requests are governed by active privileged-access rules or require step-up MFA.',
    frameworkRefs: [cis('5.4'), cis('6.8'), e8('restrict_admin'), ce('user_access_control'), nist('PR.AA-05')] },
  { id: 'host_firewall', category: 'endpoint_protection', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 9,
    title: 'Host firewall enabled',
    description: 'Share of assessed devices with the operating-system firewall on.',
    frameworkRefs: [cis('4.5'), ce('firewalls'), nist('PR.IR')] },
  { id: 'definitions_current', category: 'endpoint_protection', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 10,
    title: 'Anti-malware definitions current',
    description: 'Share of devices with native anti-malware whose definitions are no older than the definitions window.',
    frameworkRefs: [cis('10.2'), ce('malware_protection'), nist('PR.PS')] },
  { id: 'password_policy', category: 'identity_access', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 11,
    title: 'Local password policy enforced',
    description: 'Share of assessed devices enforcing the minimum password length and account lockout.',
    frameworkRefs: [cis('5.2'), ce('secure_configuration'), nist('PR.AA')] },
  { id: 'identity_provider', category: 'identity_access', source: 'telemetry', metric: 'boolean', unit: 'org', insurerRank: 12,
    title: 'Central identity provider connected',
    description: 'Microsoft 365 or Google Workspace is connected to Breeze for identity visibility.',
    frameworkRefs: [cis('5.6'), cis('6.7'), ce('user_access_control'), nist('PR.AA-01')] },
  { id: 'hardening_baseline', category: 'patching_hardening', source: 'telemetry', metric: 'pass_rate', unit: 'devices', insurerRank: 13,
    title: 'Configuration hardening baseline',
    description: 'Mean pass rate of the latest CIS Benchmark configuration scan across assessed devices.',
    frameworkRefs: [cis('4.1'), cis('4.2'), e8('user_app_hardening'), ce('secure_configuration'), nist('PR.PS-01')] },
  { id: 'dns_filtering', category: 'monitoring', source: 'telemetry', metric: 'boolean', unit: 'org', insurerRank: 14,
    title: 'DNS filtering active',
    description: 'A DNS-filtering integration is connected and syncing without errors.',
    frameworkRefs: [cis('9.2'), nist('PR.PS')] },
  { id: 'continuous_monitoring', category: 'monitoring', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 15,
    title: 'Continuous monitoring',
    description: 'Share of managed devices that checked in with Breeze within the last 24 hours.',
    frameworkRefs: [cis('1.1'), cis('8.2'), nist('DE.CM')] },
];

const BY_ID = new Map(TRUST_CONTROL_CATALOG.map((c) => [c.id, c]));
export function trustControlById(id: TelemetryControlId): TrustControlDefinition | undefined {
  return BY_ID.get(id);
}
```

- [ ] **Step 6: Write the barrel and export it**

```ts
// packages/shared/src/trustCenter/index.ts
export * from './types';
export * from './frameworkCrosswalk';
export * from './controlCatalog';
export * from './evaluate';   // added in Task 2 — create evaluate.ts as an empty module now: `export {};`
```
Append `export * from './trustCenter';` to `packages/shared/src/index.ts`.

- [ ] **Step 7: Run the test and the barrel guard**

Run: `cd packages/shared && npx vitest run src/trustCenter/controlCatalog.test.ts src/browserSafeBarrel.test.ts && npx tsc --noEmit`
Expected: PASS (no Node builtins imported).

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/trustCenter packages/shared/src/index.ts
git commit -m "feat(shared): trust center control catalog, framework crosswalk and types (W1)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Pure evaluator and pill-role helper

**Files:**
- Create: `packages/shared/src/trustCenter/evaluate.ts` (replace the empty module)
- Test: `packages/shared/src/trustCenter/evaluate.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `DEFAULT_TRUST_EVALUATION_POLICY`, `evaluateTrustControls(catalog, evidence, policy, asOf): TrustControlAssessment[]`, `trustStatusPillRole(status): 'success'|'warning'|'danger'|'neutral'`, `emptyControlEvidence()`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/trustCenter/evaluate.test.ts
import { describe, expect, it } from 'vitest';
import { TRUST_CONTROL_CATALOG } from './controlCatalog';
import { DEFAULT_TRUST_EVALUATION_POLICY, emptyControlEvidence, evaluateTrustControls, trustStatusPillRole } from './evaluate';
import type { ControlEvidence, PostureControlEvidence, TelemetryControlId } from './types';

const AS_OF = new Date('2026-10-13T12:00:00.000Z');
const fresh = '2026-10-13T11:00:00.000Z';

function evidence(over: Partial<Record<TelemetryControlId, Partial<ControlEvidence>>> = {}): PostureControlEvidence {
  const base = emptyControlEvidence();
  for (const [id, patch] of Object.entries(over)) {
    base[id as TelemetryControlId] = { ...base[id as TelemetryControlId], ...patch };
  }
  return base;
}
const byId = (list: ReturnType<typeof evaluateTrustControls>, id: TelemetryControlId) => list.find((a) => a.id === id)!;

describe('evaluateTrustControls', () => {
  it('returns one assessment per catalog entry, in insurer order', () => {
    const out = evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence(), DEFAULT_TRUST_EVALUATION_POLICY, AS_OF);
    expect(out).toHaveLength(TRUST_CONTROL_CATALOG.length);
    expect(out[0].id).toBe('mfa_registered_m365');
  });

  it('no data → not_assessed/no_data with null percent', () => {
    const a = byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence(), DEFAULT_TRUST_EVALUATION_POLICY, AS_OF), 'disk_encryption');
    expect(a).toMatchObject({ status: 'not_assessed', reason: 'no_data', percent: null, evidenceAsOf: null });
  });

  it('coverage: 79% assessed → insufficient_telemetry; 80% → evaluated', () => {
    const p = DEFAULT_TRUST_EVALUATION_POLICY;
    const low = byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ disk_encryption: { eligible: 100, assessed: 79, passing: 79, newestEvidenceAt: fresh } }), p, AS_OF), 'disk_encryption');
    expect(low).toMatchObject({ status: 'not_assessed', reason: 'insufficient_telemetry', percent: null, assessed: 79, eligible: 100 });
    const ok = byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ disk_encryption: { eligible: 100, assessed: 80, passing: 76, newestEvidenceAt: fresh } }), p, AS_OF), 'disk_encryption');
    expect(ok).toMatchObject({ status: 'met', percent: 95 });
  });

  it('thresholds: 95 met, 94 attention, 79 not_met', () => {
    const p = DEFAULT_TRUST_EVALUATION_POLICY;
    const run = (passing: number) => byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ host_firewall: { eligible: 100, assessed: 100, passing, newestEvidenceAt: fresh } }), p, AS_OF), 'host_firewall');
    expect(run(95).status).toBe('met');
    expect(run(94).status).toBe('attention');
    expect(run(80).status).toBe('attention');
    expect(run(79).status).toBe('not_met');
  });

  it('exposure inverts: 4% flagged → met, 10% → attention, 30% → not_met; percent is the exposure', () => {
    const p = DEFAULT_TRUST_EVALUATION_POLICY;
    const run = (passing: number) => byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ least_privilege: { eligible: 100, assessed: 100, passing, newestEvidenceAt: fresh } }), p, AS_OF), 'least_privilege');
    expect(run(96)).toMatchObject({ status: 'met', percent: 4 });
    expect(run(90)).toMatchObject({ status: 'attention', percent: 10 });
    expect(run(70)).toMatchObject({ status: 'not_met', percent: 30 });
  });

  it('boolean: assessed 0 → no_data; passing 1 → met; passing 0 → not_met; percent null', () => {
    const p = DEFAULT_TRUST_EVALUATION_POLICY;
    const run = (e: Partial<ControlEvidence>) => byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ dns_filtering: e }), p, AS_OF), 'dns_filtering');
    expect(run({ eligible: 1, assessed: 0, passing: 0 })).toMatchObject({ status: 'not_assessed', reason: 'no_data' });
    expect(run({ eligible: 1, assessed: 1, passing: 1, newestEvidenceAt: fresh })).toMatchObject({ status: 'met', percent: null });
    expect(run({ eligible: 1, assessed: 1, passing: 0, newestEvidenceAt: fresh })).toMatchObject({ status: 'not_met', percent: null });
  });

  it('pass_rate uses aggregatePct and still applies the coverage floor', () => {
    const p = DEFAULT_TRUST_EVALUATION_POLICY;
    const ok = byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ hardening_baseline: { eligible: 10, assessed: 9, passing: 0, aggregatePct: 88, newestEvidenceAt: fresh } }), p, AS_OF), 'hardening_baseline');
    expect(ok).toMatchObject({ status: 'attention', percent: 88 });
    const thin = byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ hardening_baseline: { eligible: 10, assessed: 2, passing: 0, aggregatePct: 100, newestEvidenceAt: fresh } }), p, AS_OF), 'hardening_baseline');
    expect(thin).toMatchObject({ status: 'not_assessed', reason: 'insufficient_telemetry' });
  });

  it('MFA gate: 100% registered but an admin without MFA → attention, not met', () => {
    const p = DEFAULT_TRUST_EVALUATION_POLICY;
    const run = (gate: boolean) => byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ mfa_registered_m365: { eligible: 50, assessed: 50, passing: 50, gate, newestEvidenceAt: fresh } }), p, AS_OF), 'mfa_registered_m365');
    expect(run(true).status).toBe('met');
    expect(run(false).status).toBe('attention');
  });

  it('evidence older than the window → insufficient_telemetry even with full coverage', () => {
    const stale = '2026-09-01T00:00:00.000Z';
    const a = byId(evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence({ host_firewall: { eligible: 10, assessed: 10, passing: 10, newestEvidenceAt: stale } }), DEFAULT_TRUST_EVALUATION_POLICY, AS_OF), 'host_firewall');
    expect(a).toMatchObject({ status: 'not_assessed', reason: 'insufficient_telemetry', evidenceAsOf: stale });
  });

  it('never emits a percent for a not_assessed control', () => {
    const out = evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence(), DEFAULT_TRUST_EVALUATION_POLICY, AS_OF);
    expect(out.every((a) => a.status !== 'not_assessed' || a.percent === null)).toBe(true);
  });
});

describe('trustStatusPillRole', () => {
  it('maps every status', () => {
    expect(trustStatusPillRole('met')).toBe('success');
    expect(trustStatusPillRole('attention')).toBe('warning');
    expect(trustStatusPillRole('not_met')).toBe('danger');
    expect(trustStatusPillRole('not_assessed')).toBe('neutral');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/shared && npx vitest run src/trustCenter/evaluate.test.ts`
Expected: FAIL — `evaluateTrustControls` is not exported.

- [ ] **Step 3: Implement `evaluate.ts`**

```ts
// packages/shared/src/trustCenter/evaluate.ts
import {
  TELEMETRY_CONTROL_IDS, type ControlEvidence, type PostureControlEvidence, type TelemetryControlId,
  type TrustControlAssessment, type TrustControlDefinition, type TrustControlStatus, type TrustEvaluationPolicy,
} from './types';

/** By reference to securityCompliancePostureConfigSchema defaults (spec §5.2, §18.5). */
export const DEFAULT_TRUST_EVALUATION_POLICY: TrustEvaluationPolicy = {
  coverageFloorPct: 80,
  thresholds: { met: 95, attention: 80 },
  evidenceMaxAgeDays: 30,
};

export function emptyControlEvidence(): PostureControlEvidence {
  const out = {} as PostureControlEvidence;
  for (const id of TELEMETRY_CONTROL_IDS) {
    out[id] = { eligible: 0, assessed: 0, passing: 0, aggregatePct: null, newestEvidenceAt: null };
  }
  return out;
}

const pct = (num: number, denom: number): number => Math.round((num / denom) * 100);

function notAssessed(def: TrustControlDefinition, e: ControlEvidence, reason: TrustControlAssessment['reason']): TrustControlAssessment {
  return {
    id: def.id, category: def.category, source: 'telemetry', unit: def.unit,
    status: 'not_assessed', reason, percent: null,
    assessed: e.assessed, eligible: e.eligible, evidenceAsOf: e.newestEvidenceAt, frameworkRefs: def.frameworkRefs,
  };
}

function statusForHigherIsBetter(value: number, t: TrustEvaluationPolicy['thresholds']): TrustControlStatus {
  if (value >= t.met) return 'met';
  if (value >= t.attention) return 'attention';
  return 'not_met';
}

function evaluateOne(def: TrustControlDefinition, e: ControlEvidence, policy: TrustEvaluationPolicy, asOf: Date): TrustControlAssessment {
  if (e.eligible <= 0 || e.assessed <= 0) return notAssessed(def, e, 'no_data');

  if (e.newestEvidenceAt) {
    const ageMs = asOf.getTime() - new Date(e.newestEvidenceAt).getTime();
    if (ageMs > policy.evidenceMaxAgeDays * 86_400_000) return notAssessed(def, e, 'insufficient_telemetry');
  }
  if (def.metric !== 'boolean' && pct(e.assessed, e.eligible) < policy.coverageFloorPct) {
    return notAssessed(def, e, 'insufficient_telemetry');
  }

  let percent: number | null;
  let status: TrustControlStatus;
  switch (def.metric) {
    case 'boolean':
      percent = null;
      status = e.passing > 0 ? 'met' : 'not_met';
      break;
    case 'coverage_pct':
      percent = pct(e.passing, e.assessed);
      status = statusForHigherIsBetter(percent, policy.thresholds);
      break;
    case 'exposure_pct': {
      percent = pct(e.assessed - e.passing, e.assessed);
      const good = 100 - percent;
      status = statusForHigherIsBetter(good, policy.thresholds);
      break;
    }
    case 'pass_rate':
      if (e.aggregatePct === null) return notAssessed(def, e, 'no_data');
      percent = Math.round(e.aggregatePct);
      status = statusForHigherIsBetter(percent, policy.thresholds);
      break;
  }
  if (def.gate && status === 'met' && e.gate !== true) status = 'attention';

  return {
    id: def.id, category: def.category, source: 'telemetry', unit: def.unit,
    status, reason: null, percent,
    assessed: e.assessed, eligible: e.eligible, evidenceAsOf: e.newestEvidenceAt, frameworkRefs: def.frameworkRefs,
  };
}

/** Pure. Output order = insurerRank ascending. */
export function evaluateTrustControls(
  catalog: readonly TrustControlDefinition[],
  evidence: PostureControlEvidence,
  policy: TrustEvaluationPolicy,
  asOf: Date,
): TrustControlAssessment[] {
  return [...catalog]
    .sort((a, b) => a.insurerRank - b.insurerRank)
    .map((def) => evaluateOne(def, evidence[def.id] ?? { eligible: 0, assessed: 0, passing: 0, aggregatePct: null, newestEvidenceAt: null }, policy, asOf));
}

export type TrustPillRole = 'success' | 'warning' | 'danger' | 'neutral';
export function trustStatusPillRole(status: TrustControlStatus): TrustPillRole {
  switch (status) {
    case 'met': return 'success';
    case 'attention': return 'warning';
    case 'not_met': return 'danger';
    case 'not_assessed': return 'neutral';
  }
}
export function trustStatusLabel(status: TrustControlStatus): string {
  switch (status) {
    case 'met': return 'Met';
    case 'attention': return 'Needs attention';
    case 'not_met': return 'Not met';
    case 'not_assessed': return 'Not assessed';
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/shared && npx vitest run src/trustCenter && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/trustCenter
git commit -m "feat(shared): pure trust-control evaluator with coverage floor, exposure inversion and MFA gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Shared Zod validators (public payload contract and editor inputs)

**Files:**
- Create: `packages/shared/src/validators/trustCenter.ts`
- Modify: `packages/shared/src/validators/index.ts` (append `export * from './trustCenter';`)
- Test: `packages/shared/src/validators/trustCenter.test.ts`

**Interfaces:**
- Produces: `TRUST_SLUG_RE`, `trustSlugSchema`, `trustPagePublicPayloadSchema` + `TrustPagePublicPayload`, `trustPageUpdateSchema` + `TrustPageUpdateInput`, `trustPageDocumentsUpdateSchema`, `trustPagePublishSchema`, `trustPagePartnerHomeSchema`, `TRUST_INTRO_MAX_CHARS = 5000`, `TRUST_DOCUMENTS_MAX = 20`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/validators/trustCenter.test.ts
import { describe, expect, it } from 'vitest';
import {
  TRUST_SLUG_RE, trustPageDocumentsUpdateSchema, trustPagePublicPayloadSchema, trustPagePublishSchema, trustPageUpdateSchema,
} from './trustCenter';

const control = {
  id: 'disk_encryption', category: 'data_protection', source: 'telemetry', unit: 'devices',
  status: 'met', reason: null, percent: null, assessed: null, eligible: null, evidenceAsOf: '2026-10-13T11:00:00.000Z',
  frameworkRefs: [{ framework: 'cis_v8', ref: '3.6' }],
};
const payload = {
  schemaVersion: 1, snapshotId: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6b',
  generatedAt: '2026-10-13T12:00:00.000Z', publishedAt: '2026-10-01T09:00:00.000Z',
  org: { name: 'Acme Dental', logoUrl: null, primaryColor: '#1d4ed8', websiteUrl: 'https://acme.example', securityContactEmail: 'security@acme.example' },
  managedBy: { name: 'Northwind IT', logoUrl: 'https://cdn.example/logo.png', websiteUrl: null },
  introHtml: '<p>Hello</p>',
  summary: { catalogTotal: 15, controlsShown: 1, controlsMet: 1, deviceCount: null },
  methodology: { catalogVersion: '2026-10-13.1', evidenceMaxAgeDays: 30, definitionsMaxAgeDays: 7, coverageFloorPct: 80, thresholds: { met: 95, attention: 80 }, eligibilityNote: 'Managed, non-decommissioned devices.' },
  controls: [control],
  documents: [],
  footer: { poweredByBreeze: true, frameworkAttributions: ['cis_v8'] },
};

describe('trust slug', () => {
  it.each(['acme', 'acme-dental', 'a1', 'x'.repeat(63)])('accepts %s', (s) => expect(TRUST_SLUG_RE.test(s)).toBe(true));
  it.each(['Acme', '-acme', 'acme-', 'ac me', 'x'.repeat(64), '', 'acme_dental', 'ünïcode'])('rejects %j', (s) => expect(TRUST_SLUG_RE.test(s)).toBe(false));
});

describe('trustPagePublicPayloadSchema', () => {
  it('accepts a complete payload', () => {
    expect(trustPagePublicPayloadSchema.parse(payload)).toEqual(payload);
  });
  it('is strict at every level', () => {
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, extra: 1 }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, org: { ...payload.org, hostname: 'x' } }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, controls: [{ ...control, deviceIds: [] }] }).success).toBe(false);
  });
  it('rejects a non-https website and a percent on a not_assessed control', () => {
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, org: { ...payload.org, websiteUrl: 'http://acme.example' } }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, controls: [{ ...control, status: 'not_assessed', reason: 'no_data', percent: 50 }] }).success).toBe(false);
  });
  it('bounds documents at 20 and intro at 5000 chars', () => {
    const doc = { id: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6c', title: 'Policy', category: 'policy', contentType: 'application/pdf', byteSize: 10, updatedAt: '2026-10-01T00:00:00.000Z', visibility: 'public' };
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, documents: Array.from({ length: 21 }, () => doc) }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, introHtml: 'x'.repeat(20_001) }).success).toBe(false);
  });
});

describe('editor inputs', () => {
  it('update schema trims, bounds and defaults', () => {
    const r = trustPageUpdateSchema.parse({ securityContactEmail: ' security@acme.example ', websiteUrl: 'https://acme.example', hiddenControlIds: ['dns_filtering'] });
    expect(r.securityContactEmail).toBe('security@acme.example');
    expect(trustPageUpdateSchema.safeParse({ websiteUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(trustPageUpdateSchema.safeParse({ hiddenControlIds: ['not_a_control'] }).success).toBe(false);
    expect(trustPageUpdateSchema.safeParse({ introHtml: 'x'.repeat(5001) }).success).toBe(false);
  });
  it('documents update requires confirmation for public documents', () => {
    const id = '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6c';
    expect(trustPageDocumentsUpdateSchema.safeParse({ documents: [{ documentId: id, visibility: 'public', disclosureConfirmed: false }] }).success).toBe(false);
    expect(trustPageDocumentsUpdateSchema.safeParse({ documents: [{ documentId: id, visibility: 'public', disclosureConfirmed: true }] }).success).toBe(true);
  });
  it('publish schema needs expectedRevision; authorization is optional at schema level', () => {
    expect(trustPagePublishSchema.safeParse({}).success).toBe(false);
    expect(trustPagePublishSchema.parse({ expectedRevision: 3 })).toEqual({ expectedRevision: 3 });
    expect(trustPagePublishSchema.safeParse({ expectedRevision: 3, authorization: { authorizedBy: '' } }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/shared && npx vitest run src/validators/trustCenter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `validators/trustCenter.ts`** (Zod 4: `z.strictObject`)

```ts
// packages/shared/src/validators/trustCenter.ts
import { z } from 'zod';
import { TELEMETRY_CONTROL_IDS, TRUST_CONTROL_CATEGORY_ORDER, TRUST_FRAMEWORKS } from '../trustCenter/types';

export const TRUST_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const trustSlugSchema = z.string().min(1).max(63).regex(TRUST_SLUG_RE);

export const TRUST_INTRO_MAX_CHARS = 5000;
export const TRUST_DOCUMENTS_MAX = 20;

const httpsUrl = z.string().trim().max(2048).refine((v) => /^https:\/\/[^\s/$.?#].[^\s]*$/i.test(v), 'https URL required');
const isoDate = z.string().datetime({ offset: true });
const hexColor = z.string().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i);
/** https or an inline image data URL, bounded so a logo cannot bloat the payload. */
const logoUrl = z.string().max(150_000).refine((v) => v.startsWith('https://') || v.startsWith('data:image/'), 'https or data:image URL');

export const trustControlStatusSchema = z.enum(['met', 'attention', 'not_met', 'not_assessed']);
export const trustNotAssessedReasonSchema = z.enum(['insufficient_telemetry', 'no_data', 'not_applicable']);
export const trustFrameworkSchema = z.enum(TRUST_FRAMEWORKS);
export const telemetryControlIdSchema = z.enum(TELEMETRY_CONTROL_IDS);

const frameworkRefSchema = z.strictObject({ framework: trustFrameworkSchema, ref: z.string().min(1).max(32) });

export const trustPagePublicControlSchema = z.strictObject({
  id: telemetryControlIdSchema,
  category: z.enum(TRUST_CONTROL_CATEGORY_ORDER),
  source: z.literal('telemetry'),
  unit: z.enum(['devices', 'users', 'org']),
  status: trustControlStatusSchema,
  reason: trustNotAssessedReasonSchema.nullable(),
  percent: z.number().int().min(0).max(100).nullable(),
  assessed: z.number().int().min(0).nullable(),
  eligible: z.number().int().min(0).nullable(),
  evidenceAsOf: isoDate.nullable(),
  frameworkRefs: z.array(frameworkRefSchema).max(12),
}).superRefine((c, ctx) => {
  if (c.status === 'not_assessed' && (c.percent !== null || c.reason === null)) {
    ctx.addIssue({ code: 'custom', message: 'not_assessed carries a reason and no percent' });
  }
  if (c.status !== 'not_assessed' && c.reason !== null) {
    ctx.addIssue({ code: 'custom', message: 'reason only with not_assessed' });
  }
});

export const trustPagePublicDocumentSchema = z.strictObject({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  category: z.enum(['baseline', 'runbook', 'policy', 'evidence', 'report', 'export', 'other']),
  contentType: z.string().min(1).max(255),
  byteSize: z.number().int().positive(),
  updatedAt: isoDate,
  visibility: z.literal('public'),
});

export const trustPagePublicPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotId: z.string().uuid(),
  generatedAt: isoDate,
  publishedAt: isoDate,
  org: z.strictObject({
    name: z.string().min(1).max(255),
    logoUrl: logoUrl.nullable(),
    primaryColor: hexColor.nullable(),
    websiteUrl: httpsUrl.nullable(),
    securityContactEmail: z.string().email().max(320).nullable(),
  }),
  managedBy: z.strictObject({
    name: z.string().min(1).max(255),
    logoUrl: logoUrl.nullable(),
    websiteUrl: httpsUrl.nullable(),
  }).nullable(),
  introHtml: z.string().max(TRUST_INTRO_MAX_CHARS * 4).nullable(), // sanitized HTML may expand entities
  summary: z.strictObject({
    catalogTotal: z.number().int().positive(),
    controlsShown: z.number().int().min(0),
    controlsMet: z.number().int().min(0),
    deviceCount: z.number().int().min(0).nullable(),
  }),
  methodology: z.strictObject({
    catalogVersion: z.string().min(1),
    evidenceMaxAgeDays: z.number().int().positive(),
    definitionsMaxAgeDays: z.number().int().positive(),
    coverageFloorPct: z.number().int().min(0).max(100),
    thresholds: z.strictObject({ met: z.number().int(), attention: z.number().int() }),
    eligibilityNote: z.string().min(1).max(500),
  }),
  controls: z.array(trustPagePublicControlSchema).max(TELEMETRY_CONTROL_IDS.length),
  documents: z.array(trustPagePublicDocumentSchema).max(TRUST_DOCUMENTS_MAX),
  footer: z.strictObject({
    poweredByBreeze: z.boolean(),
    frameworkAttributions: z.array(trustFrameworkSchema).max(TRUST_FRAMEWORKS.length),
  }),
});
export type TrustPagePublicPayload = z.infer<typeof trustPagePublicPayloadSchema>;
export type TrustPagePublicControl = z.infer<typeof trustPagePublicControlSchema>;

export const trustPageUpdateSchema = z.strictObject({
  introHtml: z.string().max(TRUST_INTRO_MAX_CHARS).nullable().optional(),
  securityContactEmail: z.string().trim().email().max(320).nullable().optional(),
  websiteUrl: httpsUrl.nullable().optional(),
  hiddenControlIds: z.array(telemetryControlIdSchema).max(TELEMETRY_CONTROL_IDS.length).optional(),
  showPercentages: z.boolean().optional(),
  showDeviceCount: z.boolean().optional(),
  showManagedBy: z.boolean().optional(),
  searchIndexable: z.boolean().optional(),
});
export type TrustPageUpdateInput = z.infer<typeof trustPageUpdateSchema>;

export const trustPageDocumentsUpdateSchema = z.strictObject({
  documents: z.array(z.strictObject({
    documentId: z.string().uuid(),
    visibility: z.literal('public'),
    disclosureConfirmed: z.boolean(),
  })).max(TRUST_DOCUMENTS_MAX),
}).superRefine((v, ctx) => {
  v.documents.forEach((d, i) => {
    if (d.visibility === 'public' && !d.disclosureConfirmed) {
      ctx.addIssue({ code: 'custom', path: ['documents', i, 'disclosureConfirmed'], message: 'public documents need disclosure confirmation' });
    }
  });
  if (new Set(v.documents.map((d) => d.documentId)).size !== v.documents.length) {
    ctx.addIssue({ code: 'custom', path: ['documents'], message: 'duplicate document' });
  }
});

export const trustPagePublishSchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  authorization: z.strictObject({ authorizedBy: z.string().trim().min(2).max(200) }).optional(),
});
export const trustPagePartnerHomeSchema = z.strictObject({ isPartnerHome: z.boolean() });
```

- [ ] **Step 4: Export and run**

Append `export * from './trustCenter';` to `packages/shared/src/validators/index.ts`.
Run: `cd packages/shared && npx vitest run src/validators/trustCenter.test.ts src/browserSafeBarrel.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/trustCenter.ts packages/shared/src/validators/trustCenter.test.ts packages/shared/src/validators/index.ts
git commit -m "feat(shared): trust page public payload contract (strict) and editor input schemas

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Migrations, Drizzle schema and tenancy registrations

**Files:**
- Create: `apps/api/migrations/2026-12-18-110000-partners-trust-page-unbranded.sql`
- Create: `apps/api/migrations/2026-12-18-110100-trust-pages.sql`
- Create: `apps/api/src/db/schema/trustPages.ts`
- Modify: `apps/api/src/db/schema/index.ts` (add `export * from './trustPages';`)
- Modify: `apps/api/src/db/schema/orgs.ts` (partner column after `aiForOfficeEnabled`)
- Modify: `apps/api/src/services/tenantCascade.ts` (three entries)
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (`SPECIAL` + `REPOINT_TABLES`)
- Modify: `apps/api/src/services/orgMergeCustomExecutors.ts` (`mergeTrustPages`, `CUSTOM_EXECUTORS`, `CUSTOM_WOULD_DROP_COUNTS`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (three entries)
- Test: `apps/api/src/services/orgMergeCustomExecutors.trustPages.test.ts`, `apps/api/src/services/tenantExportPolicyRegistry.trustPages.test.ts`

**Interfaces:**
- Produces Drizzle tables `trustPages`, `trustPageSnapshots`, `trustPageDocuments`, enum `trustPageDocumentVisibilityEnum`, type `TrustPageRow`, `TrustPageSnapshotRow`; `partners.trustPageUnbranded`.
- Consumed by Tasks 7–12.

- [ ] **Step 1: Confirm the newest migration name**

Run (from `apps/api`):
```bash
git ls-tree --name-only HEAD migrations/ | sed 's#.*/##' | grep -E '^[0-9]{4}-.*\.sql$' | node -e 'const n=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean);console.log(n.sort((a,b)=>a.localeCompare(b)).pop())'
```
Expected: `2026-12-18-100000-partner-api-idempotency-keys.sql`. If `main` moved, rename both new files so they still sort last.

- [ ] **Step 2: Write the partner-column migration**

```sql
-- apps/api/migrations/2026-12-18-110000-partners-trust-page-unbranded.sql
-- Trust Center (spec docs/superpowers/specs/trust-center/2026-10-12-trust-center-design.md §9, §18.3):
-- operator-granted footer removal for public trust pages. A dedicated column, not
-- settings JSONB, because settings is partner-writable and the partner must not
-- self-enable (same reasoning as ai_for_office_enabled). partners already has
-- partner-axis RLS; a non-key column inherits the row policies. DDL only.
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS trust_page_unbranded boolean NOT NULL DEFAULT false;
```

- [ ] **Step 3: Write the tables migration**

```sql
-- apps/api/migrations/2026-12-18-110100-trust-pages.sql
-- Trust Center W1 (spec docs/superpowers/specs/trust-center/2026-10-12-trust-center-design.md §7, §9).
-- Shape 1 (direct org_id) for all three tables. org_id NOT NULL is justified in
-- spec §9: a trust page is one org's public identity, not an inheritable policy.
-- partner_id is denormalized for the partner-home uniqueness and proven by the
-- composite FK to organizations(id, partner_id), DEFERRABLE INITIALLY IMMEDIATE
-- (org merge runs SET CONSTRAINTS ALL DEFERRED). RLS stays org-only.
-- There is deliberately NO FK from trust_pages back to trust_page_snapshots: a
-- current_snapshot_id pointer would make the pair a cycle and abort org erasure.
-- Registered in CORE_ORG_CASCADE_DELETE_ORDER, orgMergeRegistry (trust_pages:
-- custom executor; children: repoint) and CORE_TENANT_EXPORT_POLICY.
-- DDL only: no rows written, so no breeze.scope election.

DO $$ BEGIN
  CREATE TYPE trust_page_document_visibility AS ENUM ('public', 'gated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS trust_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL UNIQUE REFERENCES organizations(id),
  partner_id UUID NOT NULL REFERENCES partners(id),
  is_partner_home BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  publication_revision INTEGER NOT NULL DEFAULT 0,
  search_indexable BOOLEAN NOT NULL DEFAULT FALSE,
  show_percentages BOOLEAN NOT NULL DEFAULT FALSE,
  show_device_count BOOLEAN NOT NULL DEFAULT FALSE,
  show_managed_by BOOLEAN NOT NULL DEFAULT TRUE,
  security_contact_email VARCHAR(320),
  website_url TEXT,
  intro_html TEXT,
  hidden_control_ids TEXT[] NOT NULL DEFAULT '{}',
  publication_authorized_by VARCHAR(200),
  publication_authorized_at TIMESTAMPTZ,
  publication_authorized_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  last_evaluated_at TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE trust_pages ADD CONSTRAINT trust_pages_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id)
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE trust_pages ADD CONSTRAINT trust_pages_intro_len_chk
    CHECK (intro_html IS NULL OR length(intro_html) <= 20000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Target for the children's composite FKs.
CREATE UNIQUE INDEX IF NOT EXISTS trust_pages_id_org_uq ON trust_pages (id, org_id);
-- One partner-home page per partner.
CREATE UNIQUE INDEX IF NOT EXISTS trust_pages_partner_home_uq
  ON trust_pages (partner_id) WHERE is_partner_home;
-- The hourly refresh walks published pages.
CREATE INDEX IF NOT EXISTS trust_pages_published_idx
  ON trust_pages (published_at) WHERE published_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS trust_page_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trust_page_id UUID NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id),
  payload JSONB NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  catalog_version TEXT NOT NULL,
  publication_revision INTEGER NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE trust_page_snapshots ADD CONSTRAINT trust_page_snapshots_page_org_fk
    FOREIGN KEY (trust_page_id, org_id) REFERENCES trust_pages(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS trust_page_snapshots_current_uq
  ON trust_page_snapshots (trust_page_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS trust_page_snapshots_page_generated_idx
  ON trust_page_snapshots (trust_page_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS trust_page_snapshots_prune_idx
  ON trust_page_snapshots (generated_at) WHERE NOT is_current;

-- Snapshots are immutable except for is_current (spec §9) and org_id (the org
-- merge's buildRepoint may re-stamp children; the payload itself never changes).
CREATE OR REPLACE FUNCTION trust_page_snapshots_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.trust_page_id IS DISTINCT FROM OLD.trust_page_id
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.catalog_version IS DISTINCT FROM OLD.catalog_version
     OR NEW.publication_revision IS DISTINCT FROM OLD.publication_revision
     OR NEW.generated_at IS DISTINCT FROM OLD.generated_at THEN
    RAISE EXCEPTION 'trust_page_snapshots rows are immutable (only is_current and org_id may change)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trust_page_snapshots_immutable_trg ON trust_page_snapshots;
CREATE TRIGGER trust_page_snapshots_immutable_trg
  BEFORE UPDATE ON trust_page_snapshots
  FOR EACH ROW EXECUTE FUNCTION trust_page_snapshots_immutable();

CREATE TABLE IF NOT EXISTS trust_page_documents (
  trust_page_id UUID NOT NULL,
  document_id UUID NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id),
  visibility trust_page_document_visibility NOT NULL DEFAULT 'public',
  disclosure_confirmed_at TIMESTAMPTZ,
  disclosure_confirmed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (trust_page_id, document_id)
);

DO $$ BEGIN
  ALTER TABLE trust_page_documents ADD CONSTRAINT trust_page_documents_page_org_fk
    FOREIGN KEY (trust_page_id, org_id) REFERENCES trust_pages(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE trust_page_documents ADD CONSTRAINT trust_page_documents_document_org_fk
    FOREIGN KEY (document_id, org_id) REFERENCES org_documents(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A public document must carry its disclosure confirmation (spec §12).
DO $$ BEGIN
  ALTER TABLE trust_page_documents ADD CONSTRAINT trust_page_documents_public_confirmed_chk
    CHECK (visibility <> 'public' OR disclosure_confirmed_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS trust_page_documents_org_idx ON trust_page_documents (org_id);

-- RLS: shape 1 (direct org_id) on all three tables.
ALTER TABLE trust_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_pages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON trust_pages;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON trust_pages;
DROP POLICY IF EXISTS breeze_org_isolation_update ON trust_pages;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON trust_pages;
CREATE POLICY breeze_org_isolation_select ON trust_pages FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON trust_pages FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON trust_pages FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON trust_pages FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE trust_page_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_page_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON trust_page_snapshots;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON trust_page_snapshots;
DROP POLICY IF EXISTS breeze_org_isolation_update ON trust_page_snapshots;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON trust_page_snapshots;
CREATE POLICY breeze_org_isolation_select ON trust_page_snapshots FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON trust_page_snapshots FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON trust_page_snapshots FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON trust_page_snapshots FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE trust_page_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_page_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON trust_page_documents;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON trust_page_documents;
DROP POLICY IF EXISTS breeze_org_isolation_update ON trust_page_documents;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON trust_page_documents;
CREATE POLICY breeze_org_isolation_select ON trust_page_documents FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON trust_page_documents FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON trust_page_documents FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON trust_page_documents FOR DELETE USING (public.breeze_has_org_access(org_id));
```

- [ ] **Step 4: Write the Drizzle schema**

```ts
// apps/api/src/db/schema/trustPages.ts
import { sql } from 'drizzle-orm';
import { pgTable, pgEnum, uuid, varchar, text, integer, char, boolean, timestamp, jsonb, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { users } from './users';
import { orgDocuments } from './orgDocuments';
import type { TrustPagePublicPayload } from '@breeze/shared';

export const trustPageDocumentVisibilityEnum = pgEnum('trust_page_document_visibility', ['public', 'gated']);

/**
 * Trust Center (spec trust-center/2026-10-12 §9). Shape 1 (direct org_id).
 * The composite deferrable FKs (org_id, partner_id) → organizations and the
 * children's (x, org_id) → parent(id, org_id) are declared in SQL only; Drizzle
 * cannot express DEFERRABLE, so the migration is the authority (orgDocuments precedent).
 * No back-pointer to the current snapshot: see migration header.
 */
export const trustPages = pgTable('trust_pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().unique().references(() => organizations.id),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  isPartnerHome: boolean('is_partner_home').notNull().default(false),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  publicationRevision: integer('publication_revision').notNull().default(0),
  searchIndexable: boolean('search_indexable').notNull().default(false),
  showPercentages: boolean('show_percentages').notNull().default(false),
  showDeviceCount: boolean('show_device_count').notNull().default(false),
  showManagedBy: boolean('show_managed_by').notNull().default(true),
  securityContactEmail: varchar('security_contact_email', { length: 320 }),
  websiteUrl: text('website_url'),
  introHtml: text('intro_html'),
  hiddenControlIds: text('hidden_control_ids').array().notNull().default(sql`'{}'::text[]`),
  publicationAuthorizedBy: varchar('publication_authorized_by', { length: 200 }),
  publicationAuthorizedAt: timestamp('publication_authorized_at', { withTimezone: true }),
  publicationAuthorizedByUserId: uuid('publication_authorized_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('trust_pages_id_org_uq').on(t.id, t.orgId),
  uniqueIndex('trust_pages_partner_home_uq').on(t.partnerId).where(sql`${t.isPartnerHome}`),
  index('trust_pages_published_idx').on(t.publishedAt).where(sql`${t.publishedAt} IS NOT NULL`),
]);
export type TrustPageRow = typeof trustPages.$inferSelect;

export const trustPageSnapshots = pgTable('trust_page_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  trustPageId: uuid('trust_page_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  payload: jsonb('payload').$type<TrustPagePublicPayload>().notNull(),
  payloadSha256: char('payload_sha256', { length: 64 }).notNull(),
  catalogVersion: text('catalog_version').notNull(),
  publicationRevision: integer('publication_revision').notNull(),
  isCurrent: boolean('is_current').notNull().default(false),
  generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('trust_page_snapshots_current_uq').on(t.trustPageId).where(sql`${t.isCurrent}`),
  index('trust_page_snapshots_page_generated_idx').on(t.trustPageId, t.generatedAt),
]);
export type TrustPageSnapshotRow = typeof trustPageSnapshots.$inferSelect;

export const trustPageDocuments = pgTable('trust_page_documents', {
  trustPageId: uuid('trust_page_id').notNull(),
  documentId: uuid('document_id').notNull().references(() => orgDocuments.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  visibility: trustPageDocumentVisibilityEnum('visibility').notNull().default('public'),
  disclosureConfirmedAt: timestamp('disclosure_confirmed_at', { withTimezone: true }),
  disclosureConfirmedByUserId: uuid('disclosure_confirmed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.trustPageId, t.documentId] }),
  index('trust_page_documents_org_idx').on(t.orgId),
]);
export type TrustPageDocumentRow = typeof trustPageDocuments.$inferSelect;
```
Add `export * from './trustPages';` to `apps/api/src/db/schema/index.ts`. In `orgs.ts`, directly after `aiForOfficeEnabled`:
```ts
  // Trust Center footer removal — operator-granted (spec trust-center §9, §18.3).
  // Dedicated column for the same reason as aiForOfficeEnabled: settings JSONB is
  // partner-writable and the partner must not self-enable.
  trustPageUnbranded: boolean('trust_page_unbranded').notNull().default(false),
```

- [ ] **Step 5: Register cascade order** — in `apps/api/src/services/tenantCascade.ts`, between `'topology_view_exclusions',` and `'tunnel_allowlists',`:
```ts
  // trust_page_* : documents/snapshots -> trust_pages (children first);
  // localeCompare puts '_' before 's', so alphabetical order IS FK order here.
  'trust_page_documents',
  'trust_page_snapshots',
  'trust_pages',
```

- [ ] **Step 6: Write the failing merge-executor test**

```ts
// apps/api/src/services/orgMergeCustomExecutors.trustPages.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const executed = vi.hoisted(() => ({ statements: [] as string[], counts: [] as number[] }));
vi.mock('../db', () => ({
  db: {
    execute: vi.fn(async (statement: { queryChunks?: unknown[] }) => {
      executed.statements.push(JSON.stringify(statement.queryChunks ?? statement));
      return { rowCount: executed.counts.shift() ?? 0 };
    }),
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

import { CUSTOM_EXECUTORS, CUSTOM_WOULD_DROP_COUNTS } from './orgMergeCustomExecutors';

const LOSER = '11111111-1111-4111-8111-111111111111';
const SURVIVOR = '22222222-2222-4222-8222-222222222222';

describe('trust_pages merge executor', () => {
  beforeEach(() => { executed.statements.length = 0; executed.counts.length = 0; });

  it('always deletes the loser page and clears the survivor evaluation marker', async () => {
    executed.counts.push(1, 1); // DELETE loser page → 1; UPDATE survivor → 1
    const out = await CUSTOM_EXECUTORS.trust_pages(LOSER, SURVIVOR);
    expect(out.dropped).toBe(1);
    expect(out.moved).toBe(0);
    expect(executed.statements[0]).toMatch(/DELETE FROM trust_pages/);
    expect(executed.statements[1]).toMatch(/UPDATE trust_pages/);
    expect(out.notes.join(' ')).toMatch(/retired/);
  });

  it('is a no-op note when the loser had no page', async () => {
    executed.counts.push(0, 0);
    const out = await CUSTOM_EXECUTORS.trust_pages(LOSER, SURVIVOR);
    expect(out).toMatchObject({ dropped: 0, moved: 0 });
  });

  it('reports the would-drop count for the merge preview', async () => {
    expect(typeof CUSTOM_WOULD_DROP_COUNTS.trust_pages).toBe('function');
  });
});
```
Run: `cd apps/api && npx vitest run src/services/orgMergeCustomExecutors.trustPages.test.ts` → FAIL (`trust_pages` executor undefined).

- [ ] **Step 7: Implement the executor and registry entries**

In `apps/api/src/services/orgMergeCustomExecutors.ts`, next to `mergeBackupConfigs`:
```ts
// ---------------------------------------------------------------------------
// trust_pages — UNIQUE(org_id) and a page is an org's PUBLIC identity (spec
// trust-center §9 "Merge"). The loser's page is ALWAYS retired, even when the
// survivor has none: repointing would publish org A's history under org B's
// name. Children (snapshots, document links) are ON DELETE CASCADE. The
// survivor's last_evaluated_at is cleared so the next hourly refresh rebuilds
// its snapshot: its fleet just changed.
// ---------------------------------------------------------------------------
const mergeTrustPages: CustomMergeExecutor = async (loser, survivor) => {
  const dropped = await run(sql`DELETE FROM trust_pages WHERE org_id = ${uuid(loser)}`);
  await run(sql`UPDATE trust_pages SET last_evaluated_at = NULL, updated_at = now() WHERE org_id = ${uuid(survivor)}`);
  return {
    moved: 0,
    dropped,
    notes: dropped > 0
      ? [`trust_pages: retired the merged-away org's public trust page (${dropped}); its snapshots and document links were removed with it. The surviving page will be rebuilt on the next hourly refresh.`]
      : [],
  };
};
```
Add `trust_pages: mergeTrustPages,` to `CUSTOM_EXECUTORS` and, in `CUSTOM_WOULD_DROP_COUNTS`, following the file's existing entry shape:
```ts
  trust_pages: async (loser) => run(sql`SELECT count(*)::int AS n FROM trust_pages WHERE org_id = ${uuid(loser)}`),
```
(If the map's value type is `(loser, survivor) => Promise<number>` returning a count rather than a row count, mirror the neighbouring entry's exact shape; read two neighbours first.)

In `apps/api/src/services/orgMergeRegistry.ts`:
- `SPECIAL`: `trust_pages: { kind: 'custom', note: 'public identity — loser page always retired (children cascade); never repointed' },`
- `REPOINT_TABLES` (alphabetical): `"trust_page_documents",` and `"trust_page_snapshots",` with the comment `// Children of trust_pages: ON DELETE CASCADE removes them with the loser's page in the custom executor; a plain repoint here only ever sees zero rows and keeps the registry total.`

- [ ] **Step 8: Export policy entries** — in `apps/api/src/services/tenantExportPolicyRegistry.ts` (alphabetical position):
```ts
  "trust_page_documents": tablePolicy("org_id", {
    included: ["trust_page_id", "document_id", "org_id", "visibility", "disclosure_confirmed_at", "disclosure_confirmed_by_user_id", "sort_order", "created_at"],
    reviewedIncluded: [], excludedSensitive: [], excludedOpen: [],
  }),
  "trust_page_snapshots": tablePolicy("org_id", {
    included: ["id", "trust_page_id", "org_id", "catalog_version", "publication_revision", "is_current", "generated_at"],
    reviewedIncluded: ["payload_sha256"], excludedSensitive: [],
    excludedOpen: ["payload"],
  }),
  "trust_pages": tablePolicy("org_id", {
    included: ["id", "org_id", "partner_id", "is_partner_home", "published_at", "publication_revision", "search_indexable", "show_percentages", "show_device_count", "show_managed_by", "security_contact_email", "website_url", "intro_html", "hidden_control_ids", "publication_authorized_by", "publication_authorized_at", "publication_authorized_by_user_id", "last_evaluated_at", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at"],
    reviewedIncluded: [], excludedSensitive: [], excludedOpen: [],
  }),
```
Write `apps/api/src/services/tenantExportPolicyRegistry.trustPages.test.ts` modelled on `tenantExportPolicyRegistry.portalBranding.test.ts`: assert the three tables are present, `payload` is `excludedOpen`, and no column is unclassified.

- [ ] **Step 9: Apply and verify locally**

```bash
pnpm test-stack up
export DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test   # from docs/agents/testing.md / check-drift header
pnpm --filter @breeze/api db:migrate && pnpm --filter @breeze/api db:check-drift
pnpm --filter @breeze/api test --run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/services/orgMerge.test.ts src/services/orgMergeCustomExecutors.trustPages.test.ts src/services/tenantExportPolicyRegistry.trustPages.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenantCascadeFkChildren.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
```
Expected: all PASS (shape 1 is auto-discovered; no allowlist entry). Leave the stack up for Task 5 or `pnpm test-stack down` and say so.

- [ ] **Step 10: Commit**

```bash
git add apps/api/migrations/2026-12-18-1100* apps/api/src/db/schema apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/orgMergeCustomExecutors.ts apps/api/src/services/orgMergeCustomExecutors.trustPages.test.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.trustPages.test.ts
git commit -m "feat(api): trust_pages, trust_page_snapshots, trust_page_documents (shape-1 RLS) + partners.trust_page_unbranded; cascade/merge/export registrations

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Extract `loadPostureEvidence` from the posture report and switch the report to it

**Files:**
- Create: `apps/api/src/services/postureEvidence.ts`
- Modify: `apps/api/src/services/securityComplianceReport.ts` (device/evidence/loop sections replaced by the loader; summary derived from evidence)
- Modify: `apps/api/src/services/securityComplianceReport.test.ts` (expectations for the two changed denominators and the new unknown counts)
- Modify: `apps/api/src/__tests__/parkedFanoutModules.ts` (classify the new module)
- Test: `apps/api/src/services/postureEvidence.test.ts`

**Interfaces:**
- Produces:
```ts
export interface PostureEvidencePolicy {
  sites: string[]; windowDays: number; minPasswordLength: number; maxLocalAdmins: number;
  maxAvDefinitionsAgeDays: number; maxSecurityStatusAgeDays: number; includeCis: boolean; monitoringWindowHours: number;
}
export function postureEvidencePolicyFromReportConfig(cfg: z.infer<typeof securityCompliancePostureConfigSchema>): PostureEvidencePolicy;
export const TRUST_PAGE_EVIDENCE_POLICY: PostureEvidencePolicy;   // report defaults, sites [], includeCis true, monitoringWindowHours 24
export interface PostureEvidence {
  asOf: string;
  org: { id: string; name: string; partnerId: string | null } | null;
  scopeKind: 'unrestricted' | 'restricted';
  deviceCount: number;
  devices: DeviceEvidenceRow[];            // per-device facts the report table renders
  controls: PostureControlEvidence;        // the 15 counts (net-new three are zero until Task 6)
  report: {
    reporting: number; unprotected: number; cisIncluded: boolean; cisAssessedCount: number;
    edrUnknown: number; anyAvUnknown: number;
    orgWide: OrgWideEvidence | null;       // null when scope is restricted
    backupProviders: { evidence: SecurityProductEvidence[]; coveredDeviceCount: number };
    vulnByDevice: Map<string, { critical: number; high: number }>;
  };
}
export async function loadPostureEvidence(scope: OrgAxisLiveSiteScopeV1, policy: PostureEvidencePolicy, asOf: Date): Promise<PostureEvidence>;
```
- Consumed by: the report (this task), Task 6 (appends readers), Task 9 (snapshot build).

**Query order is preserved exactly** (positional `db.select` mocks in `securityComplianceReport.test.ts` depend on it): 1 organizations · 2 devices · 3 security_status · 4 s1_agents · 5 huntress_agents · 6 device_patches pending+severity · 7 dns · 8 backup_configs · 9 c2c · 10 m365_connections · 11 google · 12 pam_org_config · 13 pam_rules · 14 elevation_requests · (loadPartnerPolicy, mocked separately) · 16 posture snapshot · 17 cis (if includeCis) · 18 device_patches scanned-set. Task 6 appends 19–20 after these.

- [ ] **Step 1: Write the failing loader test** (positional mocks, same fixture shape as the report test)

```ts
// apps/api/src/services/postureEvidence.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./securityComplianceReportVulnerabilities', () => ({ loadOpenVulnerabilityCounts: vi.fn(async () => new Map()) }));
vi.mock('./securityComplianceReportBackupProviders', () => ({ loadBackupProviderEvidence: vi.fn(async () => ({ evidence: [], coveredDeviceCount: 0 })) }));
vi.mock('./authenticatorPolicy', async (orig) => ({ ...(await orig<typeof import('./authenticatorPolicy')>()), loadPartnerPolicy: vi.fn(async () => null) }));
import { db } from '../db';
import { loadPostureEvidence, TRUST_PAGE_EVIDENCE_POLICY } from './postureEvidence';

function selectChain(rows: unknown) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'limit']) p[m] = () => p;
  return p;
}
const ORG = '00000000-0000-0000-0000-000000000001';
const AS_OF = new Date('2026-10-13T12:00:00.000Z');
const recent = new Date('2026-10-13T10:00:00.000Z');

function mockQueries(over: Partial<Record<number, unknown[]>> = {}) {
  const seq: unknown[][] = [
    /* 1 */ [{ id: ORG, name: 'Acme', partnerId: 'p1' }],
    /* 2 */ [
      { id: 'd1', hostname: 'pc-1', osType: 'windows', siteName: 'HQ', lastSeenAt: recent },
      { id: 'd2', hostname: 'pc-2', osType: 'macos', siteName: 'HQ', lastSeenAt: recent },
      { id: 'd3', hostname: 'pc-3', osType: 'windows', siteName: 'Remote', lastSeenAt: null },
    ],
    /* 3 */ [
      { deviceId: 'd1', provider: 'windows_defender', realTimeProtection: true, definitionsDate: recent, encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: { minLength: 12, lockoutThreshold: 5 }, localAdminSummary: { adminCount: 1 }, updatedAt: recent },
      { deviceId: 'd2', provider: 'other', realTimeProtection: false, definitionsDate: null, encryptionStatus: 'unencrypted', firewallEnabled: false, passwordPolicySummary: { minLength: 4 }, localAdminSummary: { adminCount: 5 }, updatedAt: recent },
    ],
    /* 4 */ [], /* 5 */ [{ deviceId: 'd1' }], /* 6 */ [{ deviceId: 'd2', severity: 'critical' }],
    /* 7 */ [{ isActive: true, provider: 'umbrella', lastSyncStatus: 'success' }],
    /* 8 */ [{ isActive: true, provider: 's3', encryption: true }], /* 9 */ [], /* 10 */ [{ status: 'active' }], /* 11 */ [],
    /* 12 */ [{ uacInterceptionEnabled: true }], /* 13 */ [{ id: 'r1' }], /* 14 */ [],
    /* 16 */ [{ overallScore: 82 }],
    /* 17 */ [{ deviceId: 'd1', passedChecks: 9, totalChecks: 10 }],
    /* 18 */ [{ deviceId: 'd1' }, { deviceId: 'd2' }],
  ];
  for (const [i, rows] of Object.entries(over)) if (rows) seq[Number(i) - 1] = rows;
  const m = vi.mocked(db.select); m.mockReset();
  for (const rows of seq) m.mockReturnValueOnce(selectChain(rows));
  m.mockReturnValue(selectChain([]));
}

describe('loadPostureEvidence', () => {
  beforeEach(() => mockQueries());

  it('counts eligible/assessed/passing per control from the same facts the report uses', async () => {
    const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
    expect(ev.deviceCount).toBe(3);
    // d3 has no status row, no agent, no check-in → not assessed for EDR/AV
    expect(ev.controls.edr_coverage).toMatchObject({ eligible: 3, assessed: 2, passing: 1 });
    expect(ev.controls.endpoint_protection).toMatchObject({ eligible: 3, assessed: 2, passing: 1 });
    expect(ev.report.edrUnknown).toBe(1);
    expect(ev.controls.disk_encryption).toMatchObject({ eligible: 3, assessed: 2, passing: 1 });
    expect(ev.controls.host_firewall).toMatchObject({ eligible: 3, assessed: 2, passing: 1 });
    expect(ev.controls.password_policy).toMatchObject({ eligible: 3, assessed: 2, passing: 1 });
    expect(ev.controls.least_privilege).toMatchObject({ eligible: 3, assessed: 2, passing: 1 }); // d2 flagged (5 > 2)
    expect(ev.controls.os_patch_currency).toMatchObject({ eligible: 3, assessed: 2, passing: 1 }); // d2 has a pending critical
    expect(ev.controls.definitions_current).toMatchObject({ eligible: 3, assessed: 1, passing: 1 });
    expect(ev.controls.hardening_baseline).toMatchObject({ eligible: 3, assessed: 1, aggregatePct: 90 });
    expect(ev.controls.identity_provider).toMatchObject({ eligible: 1, assessed: 1, passing: 1 });
    expect(ev.controls.dns_filtering).toMatchObject({ eligible: 1, assessed: 1, passing: 1 });
    expect(ev.controls.privileged_access).toMatchObject({ eligible: 1, assessed: 1, passing: 1 });
    expect(ev.controls.disk_encryption.newestEvidenceAt).toBe(recent.toISOString());
  });

  it('a stale security_status row is not assessed for encryption/firewall but still counts as EDR evidence', async () => {
    const old = new Date('2026-08-01T00:00:00.000Z');
    mockQueries({ 3: [{ deviceId: 'd1', provider: 'windows_defender', realTimeProtection: true, definitionsDate: null, encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null, updatedAt: old }] });
    const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
    expect(ev.controls.disk_encryption.assessed).toBe(0);
    expect(ev.controls.endpoint_protection.assessed).toBeGreaterThanOrEqual(1);
  });

  it('restricted scope omits org-wide evidence and filters devices by site', async () => {
    const ev = await loadPostureEvidence({ version: 1, kind: 'restricted', orgId: ORG, siteIds: ['site-a'] }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
    expect(ev.report.orgWide).toBeNull();
    expect(ev.controls.identity_provider).toMatchObject({ eligible: 0, assessed: 0 });
  });

  it('zero devices → every device control zero, org-wide still loaded', async () => {
    mockQueries({ 2: [] });
    const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
    expect(ev.deviceCount).toBe(0);
    expect(ev.controls.disk_encryption).toMatchObject({ eligible: 0, assessed: 0, passing: 0 });
  });
});
```
Run: `cd apps/api && npx vitest run src/services/postureEvidence.test.ts` → FAIL (module missing).

- [ ] **Step 2: Create `postureEvidence.ts`** — move the report's query and per-device code here verbatim (the excerpts below are the report's current code, re-homed; keep the comments). Only additions are marked `// NEW`.

```ts
// apps/api/src/services/postureEvidence.ts
// Shared evidence loader for the Security & Compliance Posture report AND the
// Trust Center snapshot (spec trust-center §5.3). One computation: both callers
// read the same counts; the evaluators own the denominators. Query ORDER is a
// contract (positional mocks in securityComplianceReport.test.ts).
import { and, desc, eq, gte, inArray, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../db';
import { isEnforcing, loadPartnerPolicy } from './authenticatorPolicy';
import {
  backupConfigs, c2cConnections, devicePatches, devices, dnsFilterIntegrations, elevationRequests,
  googleWorkspaceConnections, huntressAgents, cisBaselineResults, m365Connections, organizations,
  OUTSTANDING_DEVICE_PATCH_STATUSES, pamOrgConfig, pamRules, patches, s1Agents,
  securityPostureOrgSnapshots, securityStatus, sites,
} from '../db/schema';
import { EFFECTIVE_PATCH_SEVERITY_SQL } from './patchSeverityOverlay';
import type { securityCompliancePostureConfigSchema } from './reportConfigSchemas';
import type { OrgAxisLiveSiteScopeV1 } from './siteScope';
import { loadOpenVulnerabilityCounts } from './securityComplianceReportVulnerabilities';
import { loadBackupProviderEvidence } from './securityComplianceReportBackupProviders';
import type { SecurityProductEvidence } from './securityComplianceReportProducts';
import { classifyDeviceProtection } from './portal/protection';
import { notParkedDeviceCondition } from './unassignedPool/selectorPredicate';
import { emptyControlEvidence, type ControlEvidence, type PostureControlEvidence } from '@breeze/shared';

export interface PostureEvidencePolicy {
  sites: string[];
  windowDays: number;
  minPasswordLength: number;
  maxLocalAdmins: number;
  maxAvDefinitionsAgeDays: number;
  maxSecurityStatusAgeDays: number;
  includeCis: boolean;
  monitoringWindowHours: number;
}

export function postureEvidencePolicyFromReportConfig(cfg: z.infer<typeof securityCompliancePostureConfigSchema>): PostureEvidencePolicy {
  return {
    sites: cfg.sites, windowDays: cfg.windowDays, minPasswordLength: cfg.minPasswordLength, maxLocalAdmins: cfg.maxLocalAdmins,
    maxAvDefinitionsAgeDays: cfg.maxAvDefinitionsAgeDays, maxSecurityStatusAgeDays: cfg.maxSecurityStatusAgeDays,
    includeCis: cfg.includeCis, monitoringWindowHours: 24,
  };
}

/** The trust page is the report's DEFAULT configuration, by reference (spec §5.2). */
export const TRUST_PAGE_EVIDENCE_POLICY: PostureEvidencePolicy = {
  sites: [], windowDays: 30, minPasswordLength: 8, maxLocalAdmins: 2,
  maxAvDefinitionsAgeDays: 7, maxSecurityStatusAgeDays: 30, includeCis: true, monitoringWindowHours: 24,
};

export interface DeviceEvidenceRow {
  id: string; hostname: string; osType: string; siteName: string | null; lastSeenAt: Date | null;
  hasStatusRow: boolean; protection: ReturnType<typeof classifyDeviceProtection>; managed: string[];
  realTimeProtection: boolean | null; avDefinitionsAgeDays: number | null;
  encryption: string; firewall: boolean | null; localAdmins: number | null;
  patchAssessed: boolean; pendingPatches: number; criticalPatches: number;
  cisPassRate: number | null;
}

export interface OrgWideEvidence {
  dns: { isActive: boolean; provider: string; lastSyncStatus: string | null } | undefined;
  backup: { isActive: boolean; provider: string; encryption: boolean } | undefined;
  c2c: { status: string; provider: string } | undefined;
  m365: { status: string } | undefined;
  google: { status: string } | undefined;
  pamCfg: { uacInterceptionEnabled: boolean | null } | undefined;
  pamRuleRows: Array<{ id: string }>;
  elevationRows: Array<{ approvedAt: Date | null; deniedByUserId: string | null }>;
  mfaStepUpEnforced: boolean;
  postureRow: { overallScore: number } | undefined;
}

export interface PostureEvidence {
  asOf: string;
  org: { id: string; name: string; partnerId: string | null } | null;
  scopeKind: 'unrestricted' | 'restricted';
  deviceCount: number;
  devices: DeviceEvidenceRow[];
  controls: PostureControlEvidence;
  report: {
    reporting: number; unprotected: number; cisIncluded: boolean; cisAssessedCount: number;
    edrUnknown: number; anyAvUnknown: number;
    orgWide: OrgWideEvidence | null;
    backupProviders: { evidence: SecurityProductEvidence[]; coveredDeviceCount: number };
    vulnByDevice: Map<string, { critical: number; high: number }>;
  };
}

const daysAgo = (asOf: Date, d: Date | null | undefined): number | null =>
  d ? Math.floor((asOf.getTime() - new Date(d).getTime()) / 86400000) : null;
const isString = (v: unknown): v is string => typeof v === 'string';
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const newer = (a: string | null, d: Date | null | undefined): string | null => {
  const b = iso(d);
  if (!b) return a;
  return !a || b > a ? b : a;
};

export function passwordComplexityResult(summary: unknown, minLength: number): boolean | null {
  if (!summary || typeof summary !== 'object') return null;
  const s = summary as Record<string, unknown>;
  const hasLen = typeof s.minLength === 'number';
  const hasLockout = typeof s.lockoutThreshold === 'number' || typeof s.lockoutEnabled === 'boolean';
  if (!hasLen && !hasLockout) return null;
  const len = typeof s.minLength === 'number' ? s.minLength : 0;
  const lockout = typeof s.lockoutThreshold === 'number' ? s.lockoutThreshold > 0 : Boolean(s.lockoutEnabled);
  return len >= minLength && lockout;
}
export function localAdminCount(summary: unknown): number | null {
  if (!summary || typeof summary !== 'object') return null;
  const s = summary as Record<string, unknown>;
  return typeof s.adminCount === 'number' ? s.adminCount : null;
}

function bump(c: ControlEvidence, assessed: boolean, passing: boolean, evidenceAt?: Date | null): void {
  c.eligible += 1;
  if (!assessed) return;
  c.assessed += 1;
  if (passing) c.passing += 1;
  c.newestEvidenceAt = newer(c.newestEvidenceAt, evidenceAt);
}
function orgFact(c: ControlEvidence, known: boolean, value: boolean, evidenceAt: Date | null): void {
  c.eligible = 1;
  if (!known) return;
  c.assessed = 1; c.passing = value ? 1 : 0; c.newestEvidenceAt = iso(evidenceAt);
}

export async function loadPostureEvidence(
  scope: OrgAxisLiveSiteScopeV1,
  policy: PostureEvidencePolicy,
  asOf: Date,
): Promise<PostureEvidence> {
  const orgId = scope.orgId;
  const controls = emptyControlEvidence();
  const empty = (orgWide: OrgWideEvidence | null, org: PostureEvidence['org']): PostureEvidence => ({
    asOf: asOf.toISOString(), org, scopeKind: scope.kind, deviceCount: 0, devices: [], controls,
    report: { reporting: 0, unprotected: 0, cisIncluded: policy.includeCis, cisAssessedCount: 0, edrUnknown: 0, anyAvUnknown: 0,
      orgWide, backupProviders: { evidence: [], coveredDeviceCount: 0 }, vulnByDevice: new Map() },
  });

  if (scope.kind === 'restricted' && scope.siteIds.length === 0) return empty(null, null);

  // 1 organizations
  const [orgRow] = await db
    .select({ id: organizations.id, name: organizations.name, partnerId: organizations.partnerId })
    .from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const org = orgRow ? { id: orgRow.id, name: orgRow.name, partnerId: orgRow.partnerId } : null;

  // 2 devices. Ephemeral Quick Support devices stay inside accessibleOrgIds for
  // RLS by design — exclude them from the compliance population explicitly.
  // Decommissioned devices are excluded (NEW, spec §19.6; matches securityPostureWorker).
  const deviceConditions = [
    eq(devices.orgId, orgId), eq(devices.isEphemeral, false), notParkedDeviceCondition(),
    ne(devices.status, 'decommissioned'),
  ];
  if (policy.sites.length > 0) deviceConditions.push(inArray(devices.siteId, policy.sites));
  if (scope.kind === 'restricted') deviceConditions.push(inArray(devices.siteId, scope.siteIds));
  const deviceRows = await db
    .select({ id: devices.id, hostname: devices.hostname, osType: devices.osType, siteName: sites.name, lastSeenAt: devices.lastSeenAt })
    .from(devices).leftJoin(sites, eq(devices.siteId, sites.id)).where(and(...deviceConditions));
  const deviceIds = deviceRows.map((d) => d.id);

  const includeOrgWide = scope.kind === 'unrestricted';
  // Org-wide evidence is independent of the device population; load it even for
  // zero devices so the trust page can show identity/DNS/privileged-access.
  const loadOrgWide = async (): Promise<OrgWideEvidence> => {
    const [dns] = await db.select({ isActive: dnsFilterIntegrations.isActive, provider: dnsFilterIntegrations.provider, lastSyncStatus: dnsFilterIntegrations.lastSyncStatus })
      .from(dnsFilterIntegrations).where(and(eq(dnsFilterIntegrations.orgId, orgId), eq(dnsFilterIntegrations.isActive, true))).limit(1);
    const [backup] = await db.select({ isActive: backupConfigs.isActive, provider: backupConfigs.provider, encryption: backupConfigs.encryption })
      .from(backupConfigs).where(and(eq(backupConfigs.orgId, orgId), eq(backupConfigs.isActive, true))).limit(1);
    const [c2c] = await db.select({ status: c2cConnections.status, provider: c2cConnections.provider })
      .from(c2cConnections).where(and(eq(c2cConnections.orgId, orgId), eq(c2cConnections.status, 'active'))).limit(1);
    const [m365] = await db.select({ status: m365Connections.status })
      .from(m365Connections).where(and(eq(m365Connections.orgId, orgId), eq(m365Connections.status, 'active'))).limit(1);
    const [google] = await db.select({ status: googleWorkspaceConnections.status })
      .from(googleWorkspaceConnections).where(and(eq(googleWorkspaceConnections.orgId, orgId), eq(googleWorkspaceConnections.status, 'active'))).limit(1);
    const [pamCfg] = await db.select({ uacInterceptionEnabled: pamOrgConfig.uacInterceptionEnabled })
      .from(pamOrgConfig).where(eq(pamOrgConfig.orgId, orgId)).limit(1);
    const pamRuleRows = await db.select({ id: pamRules.id }).from(pamRules).where(and(eq(pamRules.orgId, orgId), eq(pamRules.enabled, true)));
    const windowStart = new Date(asOf.getTime() - policy.windowDays * 86400000);
    const elevationRows = await db.select({ approvedAt: elevationRequests.approvedAt, deniedByUserId: elevationRequests.deniedByUserId })
      .from(elevationRequests).where(and(eq(elevationRequests.orgId, orgId), gte(elevationRequests.requestedAt, windowStart)));
    const authPol = org?.partnerId ? await loadPartnerPolicy(org.partnerId) : null;
    const mfaStepUpEnforced = isEnforcing(authPol, asOf, 'high') && isEnforcing(authPol, asOf, 'critical');
    const [postureRow] = await db.select({ overallScore: securityPostureOrgSnapshots.overallScore })
      .from(securityPostureOrgSnapshots).where(eq(securityPostureOrgSnapshots.orgId, orgId)).orderBy(desc(securityPostureOrgSnapshots.capturedAt)).limit(1);
    return { dns, backup, c2c, m365, google, pamCfg, pamRuleRows, elevationRows, mfaStepUpEnforced, postureRow };
  };

  if (deviceIds.length === 0) {
    const orgWide = includeOrgWide ? await loadOrgWide() : null;
    const out = empty(orgWide, org);
    if (orgWide) applyOrgWide(out.controls, orgWide, asOf);
    return out;
  }

  // 3 security_status
  const ssRows = await db.select({
      deviceId: securityStatus.deviceId, provider: securityStatus.provider, realTimeProtection: securityStatus.realTimeProtection,
      definitionsDate: securityStatus.definitionsDate, encryptionStatus: securityStatus.encryptionStatus, firewallEnabled: securityStatus.firewallEnabled,
      passwordPolicySummary: securityStatus.passwordPolicySummary, localAdminSummary: securityStatus.localAdminSummary, updatedAt: securityStatus.updatedAt,
    }).from(securityStatus).where(and(eq(securityStatus.orgId, orgId), inArray(securityStatus.deviceId, deviceIds)));
  const ssByDevice = new Map(ssRows.map((r) => [r.deviceId, r]));
  // 4 s1_agents, 5 huntress_agents
  const s1Rows = await db.select({ deviceId: s1Agents.deviceId }).from(s1Agents).where(and(eq(s1Agents.orgId, orgId), inArray(s1Agents.deviceId, deviceIds)));
  const huntressRows = await db.select({ deviceId: huntressAgents.deviceId }).from(huntressAgents).where(and(eq(huntressAgents.orgId, orgId), inArray(huntressAgents.deviceId, deviceIds)));
  const s1Devices = new Set(s1Rows.map((r) => r.deviceId).filter(isString));
  const huntressDevices = new Set(huntressRows.map((r) => r.deviceId).filter(isString));
  // 6 device_patches pending + effective severity
  const patchRows = await db.select({ deviceId: devicePatches.deviceId, severity: EFFECTIVE_PATCH_SEVERITY_SQL })
    .from(devicePatches).innerJoin(patches, eq(devicePatches.patchId, patches.id))
    .where(and(eq(devicePatches.orgId, orgId), inArray(devicePatches.deviceId, deviceIds), inArray(devicePatches.status, OUTSTANDING_DEVICE_PATCH_STATUSES)));
  const pendingByDevice = new Map<string, { total: number; critical: number }>();
  for (const p of patchRows) {
    const e = pendingByDevice.get(p.deviceId) ?? { total: 0, critical: 0 };
    e.total += 1; if (p.severity === 'critical') e.critical += 1; pendingByDevice.set(p.deviceId, e);
  }
  const vulnByDevice = await loadOpenVulnerabilityCounts(deviceIds);
  const backupProviders = await loadBackupProviderEvidence(orgId, deviceIds, { now: asOf });

  // 7–16 org-wide
  const orgWide = includeOrgWide ? await loadOrgWide() : null;

  // 17 cis (latest result per device)
  const cisByDevice = new Map<string, { pct: number; checkedAt: Date }>();
  if (policy.includeCis) {
    const cisRows = await db.select({ deviceId: cisBaselineResults.deviceId, passedChecks: cisBaselineResults.passedChecks, totalChecks: cisBaselineResults.totalChecks, checkedAt: cisBaselineResults.checkedAt })
      .from(cisBaselineResults).where(and(eq(cisBaselineResults.orgId, orgId), inArray(cisBaselineResults.deviceId, deviceIds))).orderBy(desc(cisBaselineResults.checkedAt));
    for (const r of cisRows) {
      if (cisByDevice.has(r.deviceId)) continue; // desc order → first seen is the latest scan
      cisByDevice.set(r.deviceId, { pct: r.totalChecks > 0 ? Math.round((r.passedChecks / r.totalChecks) * 100) : 0, checkedAt: r.checkedAt });
    }
  }
  // 18 device_patches scanned-set (any status)
  const patchRowDevices = await db.select({ deviceId: devicePatches.deviceId }).from(devicePatches)
    .where(and(eq(devicePatches.orgId, orgId), inArray(devicePatches.deviceId, deviceIds)));
  const patchScannedDevices = new Set(patchRowDevices.map((r) => r.deviceId));

  let reporting = 0, unprotected = 0, edrUnknown = 0, anyAvUnknown = 0;
  const monitoringCutoff = asOf.getTime() - policy.monitoringWindowHours * 3600_000;
  const evidenceCutoff = asOf.getTime() - policy.maxSecurityStatusAgeDays * 86400000;

  const rows: DeviceEvidenceRow[] = deviceRows.map((d) => {
    const ss = ssByDevice.get(d.id);
    const managed: string[] = [];
    if (huntressDevices.has(d.id)) managed.push('Huntress');
    if (s1Devices.has(d.id)) managed.push('SentinelOne');
    const isManaged = managed.length > 0;
    const rtp = ss?.realTimeProtection ?? null;
    const hasNativeAv = Boolean(ss && ss.provider && ss.provider !== 'other' && rtp === true);
    const protection = classifyDeviceProtection({
      securityStatus: ss ? { provider: ss.provider, realTimeProtection: ss.realTimeProtection } : null,
      hasS1Agent: s1Devices.has(d.id), hasHuntressAgent: huntressDevices.has(d.id),
    });
    if (ss) reporting += 1;
    if (protection !== 'protected') unprotected += 1;

    // NEW (spec §19.7): a device is ASSESSED for EDR/AV when Breeze has any
    // evidence about it — a status row, an agent row, or a recent check-in.
    const seenRecently = d.lastSeenAt ? d.lastSeenAt.getTime() >= evidenceCutoff : false;
    const epAssessed = Boolean(ss) || isManaged || seenRecently;
    const epEvidenceAt = ss?.updatedAt ?? d.lastSeenAt ?? null;
    if (!epAssessed) { edrUnknown += 1; anyAvUnknown += 1; }
    bump(controls.edr_coverage, epAssessed, isManaged, epEvidenceAt);
    bump(controls.endpoint_protection, epAssessed, protection === 'protected', epEvidenceAt);

    const ssAgeDays = ss ? daysAgo(asOf, ss.updatedAt) : null;
    const ssFresh = Boolean(ss) && (ssAgeDays == null || ssAgeDays <= policy.maxSecurityStatusAgeDays);
    const enc = ss?.encryptionStatus ?? 'unknown';
    bump(controls.disk_encryption, ssFresh && enc !== 'unknown', enc === 'encrypted', ss?.updatedAt);
    bump(controls.host_firewall, Boolean(ss && ssFresh && ss.firewallEnabled != null), ss?.firewallEnabled === true, ss?.updatedAt);
    const pw = ss ? passwordComplexityResult(ss.passwordPolicySummary, policy.minPasswordLength) : null;
    bump(controls.password_policy, pw !== null, pw === true, ss?.updatedAt);
    const admins = ss ? localAdminCount(ss.localAdminSummary) : null;
    bump(controls.least_privilege, admins != null, admins != null && admins <= policy.maxLocalAdmins, ss?.updatedAt);

    const pend = pendingByDevice.get(d.id) ?? { total: 0, critical: 0 };
    const patchAssessed = patchScannedDevices.has(d.id);
    bump(controls.os_patch_currency, patchAssessed, pend.critical === 0, d.lastSeenAt);

    const avAge = ss ? daysAgo(asOf, ss.definitionsDate) : null;
    bump(controls.definitions_current, hasNativeAv && avAge != null, avAge != null && avAge <= policy.maxAvDefinitionsAgeDays, ss?.definitionsDate);

    const cis = cisByDevice.get(d.id);
    bump(controls.hardening_baseline, Boolean(cis), Boolean(cis && cis.pct >= 95), cis?.checkedAt);

    // NEW: continuous monitoring — every eligible device is assessed; passing = checked in within the window.
    bump(controls.continuous_monitoring, true, d.lastSeenAt ? d.lastSeenAt.getTime() >= monitoringCutoff : false, d.lastSeenAt);

    return {
      id: d.id, hostname: d.hostname, osType: d.osType, siteName: d.siteName ?? null, lastSeenAt: d.lastSeenAt ?? null,
      hasStatusRow: Boolean(ss), protection, managed, realTimeProtection: rtp, avDefinitionsAgeDays: avAge,
      encryption: enc, firewall: ss?.firewallEnabled ?? null, localAdmins: admins,
      patchAssessed, pendingPatches: pend.total, criticalPatches: pend.critical, cisPassRate: cis?.pct ?? null,
    };
  });

  const cisValues = [...cisByDevice.values()].map((v) => v.pct);
  controls.hardening_baseline.aggregatePct = policy.includeCis && cisValues.length > 0
    ? Math.round(cisValues.reduce((a, b) => a + b, 0) / cisValues.length) : null;

  if (orgWide) applyOrgWide(controls, orgWide, asOf);

  return {
    asOf: asOf.toISOString(), org, scopeKind: scope.kind, deviceCount: deviceRows.length, devices: rows, controls,
    report: { reporting, unprotected, cisIncluded: policy.includeCis, cisAssessedCount: cisByDevice.size, edrUnknown, anyAvUnknown, orgWide, backupProviders, vulnByDevice },
  };
}

function applyOrgWide(controls: PostureControlEvidence, w: OrgWideEvidence, asOf: Date): void {
  orgFact(controls.identity_provider, true, Boolean(w.m365 || w.google), asOf);
  const dnsSync = w.dns?.lastSyncStatus ?? null;
  orgFact(controls.dns_filtering, true, Boolean(w.dns) && dnsSync !== 'error', asOf);
  orgFact(controls.privileged_access, true, w.pamRuleRows.length > 0 || w.mfaStepUpEnforced, asOf);
}
```
Note on `hardening_baseline.passing`: the pass/attention status comes from `aggregatePct` (metric `pass_rate`); `passing` is informational only.

- [ ] **Step 3: Switch the report to the loader.** In `securityComplianceReport.ts`, after the preflight and the empty-restricted-scope early return, replace everything from the `organizations` select through the end of the per-device loop with:

```ts
  const evidence = await loadPostureEvidence(authority.scope, postureEvidencePolicyFromReportConfig(cfg), new Date(generatedAt));
  const orgRow = evidence.org ?? { id: orgId, name: 'Unknown', partnerId: null };
  if (evidence.deviceCount === 0) {
    return { rows: [], rowCount: 0, generatedAt,
      summary: emptySummary(orgRow, generatedAt, cfg.includeCis, cfg.backupRequired, authority.scope.kind === 'unrestricted') };
  }
  const c = evidence.controls;
  const w = evidence.report.orgWide;
  const includeOrgWideEvidence = w !== null;
  const elevationsApproved = w?.elevationRows.filter((e) => e.approvedAt != null).length ?? 0;
  const elevationsDenied = w?.elevationRows.filter((e) => e.deniedByUserId != null).length ?? 0;
  const dnsSyncStatus = w?.dns?.lastSyncStatus ?? null;
  const dnsActive = Boolean(w?.dns) && dnsSyncStatus !== 'error';
  const securityProducts = buildSecurityProductInventory(/* unchanged arguments, now sourced from evidence.devices / evidence.report.backupProviders */);

  const rows = evidence.devices.map((d) => {
    const vuln = evidence.report.vulnByDevice.get(d.id) ?? { critical: 0, high: 0 };
    return {
      hostname: d.hostname, site: d.siteName ?? '—', os: d.osType, protection: d.protection,
      protectionManaged: d.managed.length > 0 ? d.managed.join(', ') : null, realTimeProtection: d.realTimeProtection,
      avDefinitionsAgeDays: d.avDefinitionsAgeDays, encryption: d.encryption, firewall: d.firewall, localAdmins: d.localAdmins,
      patchAssessed: d.patchAssessed, pendingPatches: d.pendingPatches, criticalPatches: d.criticalPatches,
      openVulnCritical: vuln.critical, openVulnHigh: vuln.high, cisPassRate: d.cisPassRate, posture: null,
    };
  });
```
and build the summary from counts (same keys as today, plus the two new unknown counts):
```ts
      controls: {
        edrCoveragePct: pctOrNull(c.edr_coverage.passing, c.edr_coverage.assessed),
        edrUnknownCount: evidence.report.edrUnknown,
        anyAvCoveragePct: pctOrNull(c.endpoint_protection.passing, c.endpoint_protection.assessed),
        anyAvUnknownCount: evidence.report.anyAvUnknown,
        unprotectedCount: evidence.report.unprotected,
        encryptionPct: pctOrNull(c.disk_encryption.passing, c.disk_encryption.assessed),
        encryptionUnknownCount: evidence.deviceCount - c.disk_encryption.assessed,
        firewallPct: pctOrNull(c.host_firewall.passing, c.host_firewall.assessed),
        firewallUnknownCount: evidence.deviceCount - c.host_firewall.assessed,
        patchCurrentPct: pctOrNull(c.os_patch_currency.passing, c.os_patch_currency.assessed),
        patchUnknownCount: evidence.deviceCount - c.os_patch_currency.assessed,
        passwordComplexityPct: pctOrNull(c.password_policy.passing, c.password_policy.assessed),
        passwordUnknownCount: evidence.report.reporting - c.password_policy.assessed,
        localAdminExposurePct: pctOrNull(c.least_privilege.assessed - c.least_privilege.passing, c.least_privilege.assessed),
        localAdminUnknownCount: evidence.report.reporting - c.least_privilege.assessed,
        avDefinitionsCurrentPct: pctOrNull(c.definitions_current.passing, c.definitions_current.assessed),
        cisAvgPassRate: c.hardening_baseline.aggregatePct,
        cisIncluded: cfg.includeCis,
        cisAssessedCount: evidence.report.cisAssessedCount,
        backupRequired: cfg.backupRequired,
        ...(includeOrgWideEvidence ? {
          identityProviderConnected: Boolean(w.m365 || w.google),
          backupConfigured: Boolean(w.backup || w.c2c || evidence.report.backupProviders.coveredDeviceCount > 0),
          backupEncrypted: w.backup ? Boolean(w.backup.encryption) : null,
          dnsFilteringActive: dnsActive,
          dnsFilteringSyncStatus: dnsSyncStatus,
        } : {}),
      },
```
Keep `privilegedAccess`, `securityProducts`, `postureScore` exactly as today, sourced from `w`. Delete the now-unused local helpers (`passwordComplexityResult`, `localAdminCount`, `daysAgo`) and imports; import `loadPostureEvidence, postureEvidencePolicyFromReportConfig` instead. Add `edrUnknownCount: number` and `anyAvUnknownCount: number` to `PostureSummary['controls']` in `packages/shared` (find the type with `grep -rn "edrCoveragePct" packages/shared/src`) and to `emptySummary` (both 0). The PDF renderer that prints `encryptionUnknownCount` gets the same "N unknown" footnote for EDR/AV (grep `encryptionUnknownCount` in `apps/api/src/services` and mirror).

- [ ] **Step 4: Classify the new module for the parked-device sweep** — in `apps/api/src/__tests__/parkedFanoutModules.ts` add `'services/postureEvidence.ts': { guards: 1, reason: 'posture evidence device population (report + trust page)' },` and change the `securityComplianceReport.ts` entry's guard count to match what the test now measures (the report no longer selects devices; if the test reports 0 guards for it, remove its entry).

- [ ] **Step 5: Run and reconcile the report suite**

Run: `cd apps/api && npx vitest run src/services/postureEvidence.test.ts src/services/securityComplianceReport.test.ts src/__tests__/parkedFanout.contract.test.ts src/services/reportRegistry.test.ts src/routes/reports.test.ts`

Expected failures are only assertions on `edrCoveragePct` / `anyAvCoveragePct` (new denominator: assessed instead of deviceCount) and assertions that enumerate the `controls` keys (two new keys). Rule for each: recompute with `passing / assessed` where assessed = devices with a status row, an agent row, or `lastSeenAt` within 30 days (fixtures have no `lastSeenAt`, so assessed = devices with a status row or agent row), and add `edrUnknownCount`/`anyAvUnknownCount` expectations. Any other failure is a regression in the extraction: fix the loader, not the test.

Then: `pnpm --filter @breeze/api test:integration src/__tests__/integration/securityComplianceReport.integration.test.ts src/__tests__/integration/patchSeverityOverlayReaders.integration.test.ts` (test stack up) → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/postureEvidence.ts apps/api/src/services/postureEvidence.test.ts apps/api/src/services/securityComplianceReport.ts apps/api/src/services/securityComplianceReport.test.ts apps/api/src/__tests__/parkedFanoutModules.ts packages/shared/src
git commit -m "refactor(api): extract loadPostureEvidence from the posture report; report reads the shared counts (EDR/AV assessed denominators, unknown counts, decommissioned excluded)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Net-new evidence readers (M365 MFA, backups verified)

**Files:**
- Create: `apps/api/src/services/postureEvidenceNetNew.ts`
- Modify: `apps/api/src/services/postureEvidence.ts` (call the two readers after query 18; `continuous_monitoring` already landed in Task 5)
- Test: `apps/api/src/services/postureEvidenceNetNew.test.ts`

**Interfaces:**
- Produces: `loadM365MfaEvidence(orgId, asOf, maxAgeDays): Promise<ControlEvidence>`, `loadBackupsVerifiedEvidence(orgId, deviceIds, asOf, maxAgeDays): Promise<ControlEvidence>`.
- Query order: 19 `m365_posture_rollups` (unrestricted scope only), 20 `backup_jobs` device set, 21 `backup_verifications`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/postureEvidenceNetNew.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../db', () => ({ db: { select: vi.fn() } }));
import { db } from '../db';
import { loadBackupsVerifiedEvidence, loadM365MfaEvidence } from './postureEvidenceNetNew';

function selectChain(rows: unknown) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'limit']) p[m] = () => p;
  return p;
}
const AS_OF = new Date('2026-10-13T12:00:00.000Z');
const ORG = '00000000-0000-0000-0000-000000000001';

describe('loadM365MfaEvidence', () => {
  beforeEach(() => vi.mocked(db.select).mockReset());
  it('reads the latest rollup: eligible=users_total, assessed=total-unknown, passing=registered, gate=admins_without_mfa===0', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([{ usersTotal: 50, usersMfaRegistered: 45, usersMfaUnknown: 2, adminsWithoutMfa: 0, computedAt: new Date('2026-10-13T06:00:00.000Z') }]));
    expect(await loadM365MfaEvidence(ORG, AS_OF, 30)).toEqual({ eligible: 50, assessed: 48, passing: 45, aggregatePct: null, newestEvidenceAt: '2026-10-13T06:00:00.000Z', gate: true });
  });
  it('admins without MFA → gate false; stale rollup → not assessed', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([{ usersTotal: 50, usersMfaRegistered: 50, usersMfaUnknown: 0, adminsWithoutMfa: 1, computedAt: new Date('2026-10-13T06:00:00.000Z') }]));
    expect((await loadM365MfaEvidence(ORG, AS_OF, 30)).gate).toBe(false);
    vi.mocked(db.select).mockReturnValueOnce(selectChain([{ usersTotal: 50, usersMfaRegistered: 50, usersMfaUnknown: 0, adminsWithoutMfa: 0, computedAt: new Date('2026-08-01T00:00:00.000Z') }]));
    expect(await loadM365MfaEvidence(ORG, AS_OF, 30)).toMatchObject({ eligible: 50, assessed: 0, passing: 0 });
  });
  it('no rollup → all zero', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([]));
    expect(await loadM365MfaEvidence(ORG, AS_OF, 30)).toMatchObject({ eligible: 0, assessed: 0, passing: 0, gate: null });
  });
});

describe('loadBackupsVerifiedEvidence', () => {
  beforeEach(() => vi.mocked(db.select).mockReset());
  it('eligible = devices with a Breeze backup job; passing = passed verification inside the window', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ deviceId: 'd1' }, { deviceId: 'd2' }, { deviceId: 'd3' }]))          // backup_jobs device set
      .mockReturnValueOnce(selectChain([                                                                         // backup_verifications
        { deviceId: 'd1', status: 'passed', verificationType: 'test_restore', completedAt: new Date('2026-10-10T00:00:00.000Z') },
        { deviceId: 'd2', status: 'failed', verificationType: 'integrity', completedAt: new Date('2026-10-11T00:00:00.000Z') },
        { deviceId: 'd3', status: 'passed', verificationType: 'integrity', completedAt: new Date('2026-08-01T00:00:00.000Z') }, // outside window
      ]));
    expect(await loadBackupsVerifiedEvidence(ORG, ['d1', 'd2', 'd3', 'd4'], AS_OF, 30))
      .toEqual({ eligible: 3, assessed: 2, passing: 1, aggregatePct: null, newestEvidenceAt: '2026-10-11T00:00:00.000Z' });
  });
  it('provider-only org (no Breeze jobs) → eligible 0 → not assessed upstream', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([])).mockReturnValueOnce(selectChain([]));
    expect(await loadBackupsVerifiedEvidence(ORG, ['d1'], AS_OF, 30)).toMatchObject({ eligible: 0, assessed: 0, passing: 0 });
  });
  it('empty device list issues no query', async () => {
    expect(await loadBackupsVerifiedEvidence(ORG, [], AS_OF, 30)).toMatchObject({ eligible: 0 });
    expect(db.select).not.toHaveBeenCalled();
  });
});
```
Run: `cd apps/api && npx vitest run src/services/postureEvidenceNetNew.test.ts` → FAIL.

- [ ] **Step 2: Implement**

```ts
// apps/api/src/services/postureEvidenceNetNew.ts
// Evidence readers the posture report never had (spec trust-center §5.3).
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../db';
import { backupJobs, backupVerifications, m365PostureRollups } from '../db/schema';
import type { ControlEvidence } from '@breeze/shared';

const zero = (): ControlEvidence => ({ eligible: 0, assessed: 0, passing: 0, aggregatePct: null, newestEvidenceAt: null });

/** Latest m365_posture_rollups row for the org. Registration, not enforcement (spec §5.2). */
export async function loadM365MfaEvidence(orgId: string, asOf: Date, maxAgeDays: number): Promise<ControlEvidence> {
  const [row] = await db.select({
      usersTotal: m365PostureRollups.usersTotal, usersMfaRegistered: m365PostureRollups.usersMfaRegistered,
      usersMfaUnknown: m365PostureRollups.usersMfaUnknown, adminsWithoutMfa: m365PostureRollups.adminsWithoutMfa,
      computedAt: m365PostureRollups.computedAt,
    }).from(m365PostureRollups).where(eq(m365PostureRollups.orgId, orgId))
    .orderBy(desc(m365PostureRollups.rollupDate), desc(m365PostureRollups.computedAt)).limit(1);
  if (!row || row.usersTotal == null) return { ...zero(), gate: null };
  const ageMs = asOf.getTime() - new Date(row.computedAt).getTime();
  const fresh = ageMs <= maxAgeDays * 86400000;
  const eligible = row.usersTotal;
  if (!fresh) return { ...zero(), eligible, gate: null };
  const assessed = Math.max(0, eligible - (row.usersMfaUnknown ?? 0));
  return {
    eligible, assessed, passing: Math.min(assessed, row.usersMfaRegistered ?? 0), aggregatePct: null,
    newestEvidenceAt: new Date(row.computedAt).toISOString(),
    gate: row.adminsWithoutMfa == null ? null : row.adminsWithoutMfa === 0,
  };
}

/** Breeze-managed backups only: a passed integrity check or test restore inside the window.
 *  Third-party provider "last success" is NOT a verification (spec §19.8). */
export async function loadBackupsVerifiedEvidence(orgId: string, deviceIds: string[], asOf: Date, maxAgeDays: number): Promise<ControlEvidence> {
  if (deviceIds.length === 0) return zero();
  const jobDevices = await db.selectDistinct({ deviceId: backupJobs.deviceId }).from(backupJobs)
    .where(and(eq(backupJobs.orgId, orgId), inArray(backupJobs.deviceId, deviceIds)));
  const eligibleIds = new Set(jobDevices.map((r) => r.deviceId).filter((v): v is string => typeof v === 'string'));
  if (eligibleIds.size === 0) return zero();
  const windowStart = new Date(asOf.getTime() - maxAgeDays * 86400000);
  const rows = await db.select({
      deviceId: backupVerifications.deviceId, status: backupVerifications.status,
      verificationType: backupVerifications.verificationType, completedAt: backupVerifications.completedAt,
    }).from(backupVerifications)
    .where(and(eq(backupVerifications.orgId, orgId), inArray(backupVerifications.deviceId, [...eligibleIds]), gte(backupVerifications.startedAt, windowStart)));
  const byDevice = new Map<string, { passed: boolean; newest: Date }>();
  for (const r of rows) {
    if (!r.completedAt || r.completedAt < windowStart) continue;
    if (r.verificationType !== 'integrity' && r.verificationType !== 'test_restore') continue;
    const cur = byDevice.get(r.deviceId);
    const passed = (cur?.passed ?? false) || r.status === 'passed';
    const newest = cur && cur.newest > r.completedAt ? cur.newest : r.completedAt;
    byDevice.set(r.deviceId, { passed, newest });
  }
  let newest: string | null = null;
  let passing = 0;
  for (const v of byDevice.values()) {
    if (v.passed) passing += 1;
    const n = v.newest.toISOString();
    if (!newest || n > newest) newest = n;
  }
  return { eligible: eligibleIds.size, assessed: byDevice.size, passing, aggregatePct: null, newestEvidenceAt: newest };
}
```
If `db.selectDistinct` is unavailable in this Drizzle version, use `db.select(...).groupBy(backupJobs.deviceId)` (the test chain supports `groupBy`).

- [ ] **Step 3: Wire into the loader** — in `postureEvidence.ts`, after query 18 and before the per-device loop:
```ts
  // 19 (unrestricted only) + 20/21 — net-new readers (Task 6).
  if (includeOrgWide) controls.mfa_registered_m365 = await loadM365MfaEvidence(orgId, asOf, policy.maxSecurityStatusAgeDays);
  controls.backups_verified = await loadBackupsVerifiedEvidence(orgId, deviceIds, asOf, policy.maxSecurityStatusAgeDays);
```
and in the zero-device branch call `loadM365MfaEvidence` too when `includeOrgWide`. Extend `postureEvidence.test.ts` with one case: with queries 19–21 returning `[]`, both controls are zero; with a rollup row, `mfa_registered_m365` is populated.

- [ ] **Step 4: Run**

`cd apps/api && npx vitest run src/services/postureEvidenceNetNew.test.ts src/services/postureEvidence.test.ts src/services/securityComplianceReport.test.ts` → PASS (the report test's trailing `mockReturnValue(selectChain([]))` covers queries 19–21).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/postureEvidenceNetNew.ts apps/api/src/services/postureEvidenceNetNew.test.ts apps/api/src/services/postureEvidence.ts apps/api/src/services/postureEvidence.test.ts
git commit -m "feat(api): M365 MFA registration and verified-backup evidence readers for the trust page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**PR A1 ends here.** Open the PR (`Part of #<w1-subissue>`), run `gh workflow run CI --ref <branch>` if stacked, and request review before starting Task 7 on a stacked branch.

---

### Task 7: Snapshot payload builder and the exposure contract test

**Files:**
- Create: `apps/api/src/services/trustPage/payloadBuilder.ts`
- Modify: `apps/api/src/services/richTextSanitize.ts` (add `sanitizeFlowRichTextHtml`: same options as `sanitizeRichTextHtml` with `allowedTags: RICH_TEXT_FLOW_TAGS`, no table tags)
- Test: `apps/api/src/services/trustPage/payloadBuilder.test.ts`, `apps/api/src/services/trustPage/trustPagePublicPayload.contract.test.ts`

**Interfaces:**
- Consumes: `TrustPageRow` (Task 4), `TrustControlAssessment[]` (Task 2), `trustPagePublicPayloadSchema` (Task 3), `resolveDocumentBrand` (`services/partnerDocumentBrand.ts`), `OrgDocumentView`.
- Produces:
```ts
export interface BuildPayloadInput {
  snapshotId: string; generatedAt: Date; publishedAt: Date;
  page: TrustPageRow;
  org: { name: string };
  partner: { name: string; settings: unknown; billingWebsite: string | null; trustPageUnbranded: boolean };
  orgBrand: { logoUrl: string | null; primaryColor: string | null } | null;   // portal_branding row or null
  assessments: TrustControlAssessment[];
  deviceCount: number;
  documents: OrgDocumentView[];          // already filtered: linked, public, confirmed, live, not superseded
  policy: { evidenceMaxAgeDays: number; definitionsMaxAgeDays: number; coverageFloorPct: number; thresholds: { met: number; attention: number } };
}
export function buildTrustPagePayload(input: BuildPayloadInput): TrustPagePublicPayload;   // throws ZodError if the contract is violated
export function payloadSha256(payload: TrustPagePublicPayload): string;                   // sha256 of stable JSON (sorted keys)
export function sanitizeIntro(html: string | null): string | null;                       // sanitizeFlowRichTextHtml, trimmed, null when empty
export const TRUST_ELIGIBILITY_NOTE: string;
```

- [ ] **Step 1: Write the failing builder tests**

```ts
// apps/api/src/services/trustPage/payloadBuilder.test.ts
import { describe, expect, it } from 'vitest';
import { TRUST_CONTROL_CATALOG, DEFAULT_TRUST_EVALUATION_POLICY, evaluateTrustControls, emptyControlEvidence } from '@breeze/shared';
import { buildTrustPagePayload, payloadSha256, sanitizeIntro, type BuildPayloadInput } from './payloadBuilder';

const AS_OF = new Date('2026-10-13T12:00:00.000Z');
function page(over: Partial<BuildPayloadInput['page']> = {}): BuildPayloadInput['page'] {
  return {
    id: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6b', orgId: 'o1', partnerId: 'p1', isPartnerHome: false,
    publishedAt: new Date('2026-10-01T09:00:00.000Z'), publicationRevision: 2, searchIndexable: false,
    showPercentages: false, showDeviceCount: false, showManagedBy: true,
    securityContactEmail: 'security@acme.example', websiteUrl: 'https://acme.example',
    introHtml: '<p>Hi</p>', hiddenControlIds: [],
    publicationAuthorizedBy: 'Jane Doe, COO', publicationAuthorizedAt: AS_OF, publicationAuthorizedByUserId: null,
    lastEvaluatedAt: AS_OF, createdByUserId: null, updatedByUserId: null, createdAt: AS_OF, updatedAt: AS_OF,
    ...over,
  } as BuildPayloadInput['page'];
}
function input(over: Partial<BuildPayloadInput> = {}): BuildPayloadInput {
  const ev = emptyControlEvidence();
  ev.disk_encryption = { eligible: 50, assessed: 46, passing: 45, aggregatePct: null, newestEvidenceAt: '2026-10-13T11:00:00.000Z' };
  return {
    snapshotId: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6c', generatedAt: AS_OF, publishedAt: new Date('2026-10-01T09:00:00.000Z'),
    page: page(), org: { name: 'Acme Dental' },
    partner: { name: 'Northwind IT', settings: { branding: { logoUrl: 'https://cdn.example/nw.png', primaryColor: '#123456' } }, billingWebsite: 'https://northwind.example', trustPageUnbranded: false },
    orgBrand: null,
    assessments: evaluateTrustControls(TRUST_CONTROL_CATALOG, ev, DEFAULT_TRUST_EVALUATION_POLICY, AS_OF),
    deviceCount: 50,
    documents: [],
    policy: { evidenceMaxAgeDays: 30, definitionsMaxAgeDays: 7, coverageFloorPct: 80, thresholds: { met: 95, attention: 80 } },
    ...over,
  };
}

describe('buildTrustPagePayload', () => {
  it('produces a schema-valid payload with status-only controls by default', () => {
    const p = buildTrustPagePayload(input());
    expect(p.schemaVersion).toBe(1);
    const enc = p.controls.find((c) => c.id === 'disk_encryption')!;
    expect(enc).toMatchObject({ status: 'met', percent: null, assessed: null, eligible: null });
    expect(p.summary).toEqual({ catalogTotal: 15, controlsShown: 15, controlsMet: 1, deviceCount: null });
    expect(p.footer).toEqual({ poweredByBreeze: true, frameworkAttributions: ['cis_v8', 'essential_eight', 'cyber_essentials', 'nist_csf_2'] });
  });
  it('opt-ins expose percent/assessed/eligible and device count', () => {
    const p = buildTrustPagePayload(input({ page: page({ showPercentages: true, showDeviceCount: true }) }));
    expect(p.controls.find((c) => c.id === 'disk_encryption')).toMatchObject({ percent: 98, assessed: 46, eligible: 50 });
    expect(p.summary.deviceCount).toBe(50);
  });
  it('hidden controls are omitted but catalogTotal stays 15; attributions follow shown controls only', () => {
    const hidden = TRUST_CONTROL_CATALOG.filter((c) => c.id !== 'disk_encryption').map((c) => c.id);
    const p = buildTrustPagePayload(input({ page: page({ hiddenControlIds: hidden }) }));
    expect(p.controls.map((c) => c.id)).toEqual(['disk_encryption']);
    expect(p.summary).toMatchObject({ catalogTotal: 15, controlsShown: 1 });
    expect(p.footer.frameworkAttributions).toEqual(['cis_v8', 'nist_csf_2']);
  });
  it('branding: org logo wins, partner fills gaps; managedBy honours the toggle; unbranded removes the footer flag', () => {
    const p = buildTrustPagePayload(input({ orgBrand: { logoUrl: 'https://cdn.example/acme.png', primaryColor: null } }));
    expect(p.org).toMatchObject({ logoUrl: 'https://cdn.example/acme.png', primaryColor: '#123456' });
    expect(p.managedBy).toEqual({ name: 'Northwind IT', logoUrl: 'https://cdn.example/nw.png', websiteUrl: 'https://northwind.example' });
    const q = buildTrustPagePayload(input({ page: page({ showManagedBy: false }), partner: { ...input().partner, trustPageUnbranded: true } }));
    expect(q.managedBy).toBeNull();
    expect(q.footer.poweredByBreeze).toBe(false);
  });
  it('drops an http: logo and an http: website rather than failing', () => {
    const p = buildTrustPagePayload(input({ orgBrand: { logoUrl: 'http://cdn.example/x.png', primaryColor: 'red' }, page: page({ websiteUrl: 'http://acme.example' }) }));
    expect(p.org.logoUrl).toBeNull();
    expect(p.org.primaryColor).toBe('#123456');
    expect(p.org.websiteUrl).toBeNull();
  });
  it('zero devices: every device control not_assessed, org controls still evaluated, deviceCount null even when opted in', () => {
    const p = buildTrustPagePayload(input({ deviceCount: 0, page: page({ showDeviceCount: true }), assessments: evaluateTrustControls(TRUST_CONTROL_CATALOG, emptyControlEvidence(), DEFAULT_TRUST_EVALUATION_POLICY, AS_OF) }));
    expect(p.controls.every((c) => c.status === 'not_assessed')).toBe(true);
    expect(p.summary.deviceCount).toBeNull();
  });
  it('documents are projected to the public subset in sort order', () => {
    const doc = { id: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6d', orgId: 'o1', title: 'Security policy', description: 'x', category: 'policy', contentType: 'application/pdf', byteSize: 1234, sha256: 'a'.repeat(64), originalFilename: 'policy.pdf', uploadedByUserId: 'u1', portalVisible: true, supersedesDocumentId: null, supersededByDocumentId: null, createdAt: '2026-09-01T00:00:00.000Z' } as const;
    const p = buildTrustPagePayload(input({ documents: [doc] }));
    expect(p.documents).toEqual([{ id: doc.id, title: 'Security policy', category: 'policy', contentType: 'application/pdf', byteSize: 1234, updatedAt: '2026-09-01T00:00:00.000Z', visibility: 'public' }]);
    expect(JSON.stringify(p)).not.toContain('a'.repeat(64));
    expect(JSON.stringify(p)).not.toContain('policy.pdf');
  });
  it('sha256 is stable across key order and changes with content', () => {
    const a = buildTrustPagePayload(input());
    const b = JSON.parse(JSON.stringify(a));
    expect(payloadSha256(a)).toBe(payloadSha256(b));
    expect(payloadSha256({ ...a, introHtml: '<p>Changed</p>' })).not.toBe(payloadSha256(a));
  });
});

describe('sanitizeIntro', () => {
  it('strips scripts, javascript: links, tables and inline styles; keeps the flow subset', () => {
    const out = sanitizeIntro('<p style="color:red">Hi <a href="javascript:alert(1)">x</a> <a href="https://ok.example">ok</a></p><script>1</script><table><tr><td>t</td></tr></table><h3>H</h3>');
    expect(out).not.toMatch(/script|javascript:|style=|<table|<td/);
    expect(out).toContain('<h3>H</h3>');
    expect(out).toContain('href="https://ok.example"');
  });
  it('returns null for empty/whitespace input', () => {
    expect(sanitizeIntro('   ')).toBeNull();
    expect(sanitizeIntro(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Write the failing exposure contract test** — fixtures that would leak if the builder copied input blindly:

```ts
// apps/api/src/services/trustPage/trustPagePublicPayload.contract.test.ts
import { describe, expect, it } from 'vitest';
import { trustPagePublicPayloadSchema, TRUST_CONTROL_CATALOG, DEFAULT_TRUST_EVALUATION_POLICY, evaluateTrustControls, emptyControlEvidence } from '@breeze/shared';
import { buildTrustPagePayload } from './payloadBuilder';

const DENY = ['deviceId', 'hostname', 'ipAddress', 'cve', 'topIssues', 'top_issues', 'openPorts', 'score', 'overallScore', 'userPrincipalName', 'sha256', 'originalFilename', 'storageKey', 'uploadedByUserId', 'weights'];

function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
}

describe('trust page public payload contract', () => {
  it('builder output validates strictly and contains no denylisted key at any depth, even from a poisoned input', () => {
    const poisoned = {
      snapshotId: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6c', generatedAt: new Date(), publishedAt: new Date(),
      page: { id: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6b', orgId: 'o', partnerId: 'p', isPartnerHome: false, publishedAt: new Date(), publicationRevision: 1,
        searchIndexable: false, showPercentages: true, showDeviceCount: true, showManagedBy: true, securityContactEmail: null, websiteUrl: null, introHtml: null,
        hiddenControlIds: [], publicationAuthorizedBy: null, publicationAuthorizedAt: null, publicationAuthorizedByUserId: null, lastEvaluatedAt: null,
        createdByUserId: null, updatedByUserId: null, createdAt: new Date(), updatedAt: new Date(),
        hostname: 'LEAK', ipAddress: '10.0.0.1' } as never,
      org: { name: 'Acme', hostname: 'LEAK' } as never,
      partner: { name: 'MSP', settings: { branding: {}, apiToken: 'LEAK' }, billingWebsite: null, trustPageUnbranded: false },
      orgBrand: null,
      assessments: evaluateTrustControls(TRUST_CONTROL_CATALOG, emptyControlEvidence(), DEFAULT_TRUST_EVALUATION_POLICY, new Date()).map((a) => ({ ...a, deviceId: 'LEAK', topIssues: ['LEAK'] })) as never,
      deviceCount: 3,
      documents: [{ id: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6d', orgId: 'o', title: 'Doc', description: null, category: 'policy', contentType: 'application/pdf', byteSize: 1, sha256: 'LEAK'.repeat(16), originalFilename: 'LEAK.pdf', uploadedByUserId: 'LEAK', portalVisible: false, supersedesDocumentId: null, supersededByDocumentId: null, createdAt: new Date().toISOString() }] as never,
      policy: { evidenceMaxAgeDays: 30, definitionsMaxAgeDays: 7, coverageFloorPct: 80, thresholds: { met: 95, attention: 80 } },
    };
    const payload = buildTrustPagePayload(poisoned);
    expect(trustPagePublicPayloadSchema.safeParse(payload).success).toBe(true);
    const keys = keysDeep(payload);
    for (const k of DENY) expect(keys.has(k), k).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('LEAK');
  });
});
```
Run: `cd apps/api && npx vitest run src/services/trustPage` → FAIL (module missing).

- [ ] **Step 3: Implement**

In `richTextSanitize.ts`, next to `sanitizeRichTextHtml`, add (mirroring its internals and the `RICH_TEXT_FLOW_TAGS` constant already exported):
```ts
/** Flow subset WITHOUT tables — the trust page intro (spec trust-center §6, §19.3). */
export function sanitizeFlowRichTextHtml(html: string): string {
  return sanitizeWith(html, { allowedTags: [...RICH_TEXT_FLOW_TAGS] });   // use the file's existing option-building helper; if none exists, copy sanitizeRichTextHtml's sanitize-html options and swap allowedTags
}
```

```ts
// apps/api/src/services/trustPage/payloadBuilder.ts
import { createHash } from 'node:crypto';
import {
  FRAMEWORK_META, TRUST_CONTROL_CATALOG, TRUST_CONTROL_CATALOG_VERSION, TRUST_FRAMEWORKS,
  trustPagePublicPayloadSchema, type TrustControlAssessment, type TrustFramework, type TrustPagePublicPayload,
} from '@breeze/shared';
import type { TrustPageRow } from '../../db/schema/trustPages';
import { resolveDocumentBrand } from '../partnerDocumentBrand';
import { sanitizeFlowRichTextHtml } from '../richTextSanitize';
import type { OrgDocumentView } from '../orgDocumentService';

export const TRUST_ELIGIBILITY_NOTE =
  'Eligible devices are Breeze-managed, non-ephemeral, non-decommissioned devices in this organization. A device counts as assessed only when Breeze holds evidence for the control inside the evidence window.';

export interface BuildPayloadInput {
  snapshotId: string; generatedAt: Date; publishedAt: Date;
  page: TrustPageRow;
  org: { name: string };
  partner: { name: string; settings: unknown; billingWebsite: string | null; trustPageUnbranded: boolean };
  orgBrand: { logoUrl: string | null; primaryColor: string | null } | null;
  assessments: TrustControlAssessment[];
  deviceCount: number;
  documents: OrgDocumentView[];
  policy: { evidenceMaxAgeDays: number; definitionsMaxAgeDays: number; coverageFloorPct: number; thresholds: { met: number; attention: number } };
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const https = (v: string | null | undefined): string | null => (v && /^https:\/\/[^\s/$.?#].[^\s]*$/i.test(v.trim()) ? v.trim() : null);
const logo = (v: string | null | undefined): string | null =>
  v && v.length <= 150_000 && (v.startsWith('https://') || v.startsWith('data:image/')) ? v : null;
const hex = (v: string | null | undefined): string | null => (v && HEX.test(v.trim()) ? v.trim().toLowerCase() : null);

export function sanitizeIntro(html: string | null | undefined): string | null {
  if (!html) return null;
  const out = sanitizeFlowRichTextHtml(html).trim();
  return out.length === 0 || out === '<p></p>' ? null : out;
}

export function buildTrustPagePayload(input: BuildPayloadInput): TrustPagePublicPayload {
  const { page } = input;
  const hidden = new Set(page.hiddenControlIds);
  const shown = input.assessments.filter((a) => !hidden.has(a.id));
  const brand = resolveDocumentBrand(input.orgBrand ?? undefined, input.partner.settings);
  const partnerBrand = resolveDocumentBrand(undefined, input.partner.settings);
  const attributions = TRUST_FRAMEWORKS.filter((fw: TrustFramework) => shown.some((a) => a.frameworkRefs.some((r) => r.framework === fw)));
  const deviceCount = page.showDeviceCount && input.deviceCount > 0 ? input.deviceCount : null;

  const payload: TrustPagePublicPayload = {
    schemaVersion: 1,
    snapshotId: input.snapshotId,
    generatedAt: input.generatedAt.toISOString(),
    publishedAt: input.publishedAt.toISOString(),
    org: {
      name: input.org.name,
      logoUrl: logo(brand.logoUrl),
      primaryColor: hex(brand.primaryColor),
      websiteUrl: https(page.websiteUrl),
      securityContactEmail: page.securityContactEmail?.trim() || null,
    },
    managedBy: page.showManagedBy
      ? { name: input.partner.name, logoUrl: logo(partnerBrand.logoUrl), websiteUrl: https(input.partner.billingWebsite) }
      : null,
    introHtml: sanitizeIntro(page.introHtml),
    summary: {
      catalogTotal: TRUST_CONTROL_CATALOG.length,
      controlsShown: shown.length,
      controlsMet: shown.filter((a) => a.status === 'met').length,
      deviceCount,
    },
    methodology: {
      catalogVersion: TRUST_CONTROL_CATALOG_VERSION,
      evidenceMaxAgeDays: input.policy.evidenceMaxAgeDays,
      definitionsMaxAgeDays: input.policy.definitionsMaxAgeDays,
      coverageFloorPct: input.policy.coverageFloorPct,
      thresholds: { ...input.policy.thresholds },
      eligibilityNote: TRUST_ELIGIBILITY_NOTE,
    },
    controls: shown.map((a) => ({
      id: a.id, category: a.category, source: 'telemetry', unit: a.unit,
      status: a.status, reason: a.reason,
      percent: page.showPercentages && a.status !== 'not_assessed' ? a.percent : null,
      assessed: page.showPercentages && a.status !== 'not_assessed' ? a.assessed : null,
      eligible: page.showPercentages && a.status !== 'not_assessed' ? a.eligible : null,
      evidenceAsOf: a.evidenceAsOf,
      frameworkRefs: a.frameworkRefs.map((r) => ({ framework: r.framework, ref: r.ref })),
    })),
    documents: input.documents.slice(0, 20).map((d) => ({
      id: d.id, title: d.title, category: d.category, contentType: d.contentType, byteSize: d.byteSize,
      updatedAt: d.createdAt, visibility: 'public' as const,
    })),
    footer: { poweredByBreeze: !input.partner.trustPageUnbranded, frameworkAttributions: attributions },
  };
  // The schema is the exposure boundary: anything the projection above missed fails here, loudly.
  return trustPagePublicPayloadSchema.parse(payload);
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  return v;
}
export function payloadSha256(payload: TrustPagePublicPayload): string {
  // snapshotId/generatedAt change every build; exclude them so identical evidence dedupes (spec §7 "Refresh").
  const { snapshotId: _s, generatedAt: _g, ...rest } = payload;
  return createHash('sha256').update(JSON.stringify(stable(rest))).digest('hex');
}
export { FRAMEWORK_META };
```

- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/services/trustPage src/services/richTextSanitize.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/trustPage apps/api/src/services/richTextSanitize.ts
git commit -m "feat(api): trust page snapshot payload builder with strict exposure contract and flow-only intro sanitizer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Serving-set, snapshot cache and live resolve

**Files:**
- Create: `apps/api/src/services/trustPage/servingSet.ts`
- Create: `apps/api/src/services/trustPage/resolve.ts`
- Test: `apps/api/src/services/trustPage/servingSet.test.ts`, `apps/api/src/services/trustPage/resolve.test.ts`

**Interfaces:**
```ts
// servingSet.ts
export const TRUST_SERVING_SET_KEY = 'trust:serving';
export const trustServingMember: (partnerSlug: string, orgSlug?: string) => string;   // 'p/o' or 'p'
export async function isServing(member: string): Promise<boolean | null>;               // null when Redis is unavailable
export async function addServing(members: string[]): Promise<void>;
export async function removeServing(members: string[]): Promise<void>;
export async function replaceServingSet(members: string[]): Promise<void>;              // MULTI: DEL + SADD (atomic swap via rename)
export async function refreshServingForPartner(partnerId: string): Promise<void>;       // recompute this partner's members from the DB (system context), SREM stale, SADD live
export async function cacheSnapshotPayload(snapshotId: string, payload: TrustPagePublicPayload): Promise<void>;  // SETEX 3600
export async function readCachedSnapshotPayload(snapshotId: string): Promise<TrustPagePublicPayload | null>;
// resolve.ts
export function parseTrustSlugs(partnerSlug: string, orgSlug?: string): { partnerSlug: string; orgSlug: string | null } | null;  // regex-validated, null → 404
export interface ResolvedTrustPage { pageId: string; orgId: string; partnerId: string; publishedAt: Date; searchIndexable: boolean; lastEvaluatedAt: Date | null; snapshotId: string | null; payload: TrustPagePublicPayload | null }
export async function resolvePublishedTrustPage(partnerSlug: string, orgSlug: string | null): Promise<ResolvedTrustPage | null>;  // ONE query; runs in the caller's (system) db context
export function livePublicationPredicate(): SQL;     // published_at IS NOT NULL AND liveness AND (trust mode off OR trust_state='trusted')
```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/trustPage/servingSet.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
const redisMock = vi.hoisted(() => ({ client: null as null | Record<string, ReturnType<typeof vi.fn>> }));
vi.mock('../redis', () => ({ getRedis: () => redisMock.client }));
const dbRows = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ innerJoin: () => ({ innerJoin: () => ({ where: async () => dbRows.rows }) }) }) }) },
  runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
import { addServing, isServing, refreshServingForPartner, removeServing, trustServingMember, cacheSnapshotPayload, readCachedSnapshotPayload, TRUST_SERVING_SET_KEY } from './servingSet';

function fakeRedis() {
  const set = new Set<string>(); const kv = new Map<string, string>();
  return {
    sismember: vi.fn(async (_k: string, m: string) => (set.has(m) ? 1 : 0)),
    sadd: vi.fn(async (_k: string, ...m: string[]) => { m.forEach((x) => set.add(x)); return m.length; }),
    srem: vi.fn(async (_k: string, ...m: string[]) => { m.forEach((x) => set.delete(x)); return m.length; }),
    smembers: vi.fn(async () => [...set]),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => { kv.set(k, v); return 'OK'; }),
    get: vi.fn(async (k: string) => kv.get(k) ?? null),
    _set: set,
  };
}

describe('serving set', () => {
  beforeEach(() => { redisMock.client = fakeRedis(); dbRows.rows = []; });
  it('builds members and round-trips add/is/remove', async () => {
    expect(trustServingMember('nw', 'acme')).toBe('nw/acme');
    expect(trustServingMember('nw')).toBe('nw');
    await addServing(['nw/acme']);
    expect(await isServing('nw/acme')).toBe(true);
    expect(await isServing('nw/other')).toBe(false);
    await removeServing(['nw/acme']);
    expect(await isServing('nw/acme')).toBe(false);
    expect(redisMock.client!.sadd).toHaveBeenCalledWith(TRUST_SERVING_SET_KEY, 'nw/acme');
  });
  it('returns null (not false) when Redis is unavailable', async () => {
    redisMock.client = null;
    expect(await isServing('nw/acme')).toBeNull();
    await expect(addServing(['x'])).resolves.toBeUndefined();
  });
  it('refreshServingForPartner removes stale members for that partner and adds live ones', async () => {
    await addServing(['nw/old', 'nw', 'other/keep']);
    dbRows.rows = [{ partnerSlug: 'nw', orgSlug: 'acme', isPartnerHome: true }];
    await refreshServingForPartner('p1');
    expect([...redisMock.client!._set].sort()).toEqual(['nw', 'nw/acme', 'other/keep']);
  });
  it('caches a payload for an hour and reads it back', async () => {
    await cacheSnapshotPayload('s1', { schemaVersion: 1 } as never);
    expect(redisMock.client!.setex).toHaveBeenCalledWith('trust:snapshot:s1', 3600, expect.any(String));
    expect(await readCachedSnapshotPayload('s1')).toEqual({ schemaVersion: 1 });
    expect(await readCachedSnapshotPayload('nope')).toBeNull();
  });
});
```

```ts
// apps/api/src/services/trustPage/resolve.test.ts
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../config/partnerTrustMode', () => ({ partnerTrustMode: vi.fn(() => 'enforce') }));
import { parseTrustSlugs, livePublicationPredicate } from './resolve';
import { partnerTrustMode } from '../../config/partnerTrustMode';

describe('parseTrustSlugs', () => {
  it('accepts lowercase slugs and rejects everything else before any I/O', () => {
    expect(parseTrustSlugs('nw', 'acme')).toEqual({ partnerSlug: 'nw', orgSlug: 'acme' });
    expect(parseTrustSlugs('nw')).toEqual({ partnerSlug: 'nw', orgSlug: null });
    expect(parseTrustSlugs('NW', 'acme')).toBeNull();          // Review Focus 1
    expect(parseTrustSlugs('nw', 'Acme')).toBeNull();
    expect(parseTrustSlugs('x'.repeat(64), 'acme')).toBeNull();
    expect(parseTrustSlugs('nw', '')).toBeNull();
    expect(parseTrustSlugs('../etc', 'acme')).toBeNull();
  });
});

describe('livePublicationPredicate', () => {
  it('requires trusted when the trust mode is on, and not when it is off', () => {
    vi.mocked(partnerTrustMode).mockReturnValue('enforce');
    expect(JSON.stringify(livePublicationPredicate().queryChunks)).toMatch(/trusted/);
    vi.mocked(partnerTrustMode).mockReturnValue('off');
    expect(JSON.stringify(livePublicationPredicate().queryChunks)).not.toMatch(/trusted/);
  });
});
```
Run: `cd apps/api && npx vitest run src/services/trustPage/servingSet.test.ts src/services/trustPage/resolve.test.ts` → FAIL.

- [ ] **Step 2: Implement `servingSet.ts`**

```ts
// apps/api/src/services/trustPage/servingSet.ts
// Admission filter, not an authority (spec trust-center §7): a hit still goes
// through the live resolve; a miss answers 404 without touching Postgres.
import { and, eq, isNotNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, partners, trustPages } from '../../db/schema';
import { getRedis } from '../redis';
import type { TrustPagePublicPayload } from '@breeze/shared';

export const TRUST_SERVING_SET_KEY = 'trust:serving';
const SNAPSHOT_TTL_SECONDS = 3600;
const snapshotKey = (id: string) => `trust:snapshot:${id}`;

export const trustServingMember = (partnerSlug: string, orgSlug?: string): string =>
  orgSlug ? `${partnerSlug}/${orgSlug.toLowerCase()}` : partnerSlug;

export async function isServing(member: string): Promise<boolean | null> {
  const redis = getRedis();
  if (!redis) return null;
  try { return (await redis.sismember(TRUST_SERVING_SET_KEY, member)) === 1; }
  catch (err) { console.warn('[trustPage] serving-set read failed', err); return null; }
}
export async function addServing(members: string[]): Promise<void> {
  const redis = getRedis();
  if (!redis || members.length === 0) return;
  try { await redis.sadd(TRUST_SERVING_SET_KEY, ...members); } catch (err) { console.warn('[trustPage] serving-set add failed', err); }
}
export async function removeServing(members: string[]): Promise<void> {
  const redis = getRedis();
  if (!redis || members.length === 0) return;
  try { await redis.srem(TRUST_SERVING_SET_KEY, ...members); } catch (err) { console.warn('[trustPage] serving-set remove failed', err); }
}

/** Members a partner SHOULD have right now, computed from the tables (system context). */
async function liveMembersForPartner(partnerId: string): Promise<{ members: string[]; partnerSlug: string | null }> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({ partnerSlug: partners.slug, orgSlug: organizations.slug, isPartnerHome: trustPages.isPartnerHome })
      .from(trustPages)
      .innerJoin(organizations, eq(organizations.id, trustPages.orgId))
      .innerJoin(partners, eq(partners.id, trustPages.partnerId))
      .where(and(eq(trustPages.partnerId, partnerId), isNotNull(trustPages.publishedAt), livePublicationPredicateImport())),
  ));
  const members = new Set<string>();
  let partnerSlug: string | null = null;
  for (const r of rows as Array<{ partnerSlug: string; orgSlug: string; isPartnerHome: boolean }>) {
    partnerSlug = r.partnerSlug;
    members.add(trustServingMember(r.partnerSlug, r.orgSlug));
    if (r.isPartnerHome) members.add(trustServingMember(r.partnerSlug));
  }
  return { members: [...members], partnerSlug };
}
// Late import to avoid a cycle (resolve.ts imports nothing from here).
function livePublicationPredicateImport() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('./resolve') as typeof import('./resolve')).livePublicationPredicate();
}

/** Called by publish/unpublish, trust-state changes and the hourly refresh. */
export async function refreshServingForPartner(partnerId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const { members, partnerSlug } = await liveMembersForPartner(partnerId);
  try {
    const existing = await redis.smembers(TRUST_SERVING_SET_KEY);
    // We only know the partner's slug when it has a live page; otherwise fall back to the DB slug lookup.
    const slug = partnerSlug ?? (await runOutsideDbContext(() => withSystemDbAccessContext(async () =>
      (await db.select({ slug: partners.slug }).from(partners).where(eq(partners.id, partnerId)).limit(1))[0]?.slug ?? null)));
    if (slug) {
      const stale = existing.filter((m) => (m === slug || m.startsWith(`${slug}/`)) && !members.includes(m));
      if (stale.length) await redis.srem(TRUST_SERVING_SET_KEY, ...stale);
    }
    if (members.length) await redis.sadd(TRUST_SERVING_SET_KEY, ...members);
  } catch (err) { console.warn('[trustPage] serving-set refresh failed', err); }
}

/** Full rebuild (hourly worker): swap atomically so readers never see an empty set. */
export async function replaceServingSet(members: string[]): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const tmp = `${TRUST_SERVING_SET_KEY}:rebuild:${Date.now()}`;
  try {
    const multi = redis.multi();
    if (members.length) multi.sadd(tmp, ...members); else multi.sadd(tmp, '__empty__');
    multi.rename(tmp, TRUST_SERVING_SET_KEY);
    if (!members.length) multi.srem(TRUST_SERVING_SET_KEY, '__empty__');
    await multi.exec();
  } catch (err) { console.warn('[trustPage] serving-set rebuild failed', err); }
}

export async function cacheSnapshotPayload(snapshotId: string, payload: TrustPagePublicPayload): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try { await redis.setex(snapshotKey(snapshotId), SNAPSHOT_TTL_SECONDS, JSON.stringify(payload)); } catch { /* cache only */ }
}
export async function readCachedSnapshotPayload(snapshotId: string): Promise<TrustPagePublicPayload | null> {
  const redis = getRedis();
  if (!redis) return null;
  try { const raw = await redis.get(snapshotKey(snapshotId)); return raw ? (JSON.parse(raw) as TrustPagePublicPayload) : null; } catch { return null; }
}
```
If the repo's lint forbids `require`, move `livePublicationPredicate` into a tiny leaf module `trustPage/predicate.ts` imported by both files instead.

- [ ] **Step 3: Implement `resolve.ts`**

```ts
// apps/api/src/services/trustPage/resolve.ts
import { and, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { organizations, partners, trustPages, trustPageSnapshots } from '../../db/schema';
import { buildPublicLinkLiveOrgPredicate } from '../publicLinkOrgGate';
import { partnerTrustMode } from '../../config/partnerTrustMode';
import { TRUST_SLUG_RE, type TrustPagePublicPayload } from '@breeze/shared';

export function parseTrustSlugs(partnerSlug: string, orgSlug?: string): { partnerSlug: string; orgSlug: string | null } | null {
  if (typeof partnerSlug !== 'string' || !TRUST_SLUG_RE.test(partnerSlug)) return null;
  if (orgSlug === undefined) return { partnerSlug, orgSlug: null };
  if (typeof orgSlug !== 'string' || !TRUST_SLUG_RE.test(orgSlug)) return null;
  return { partnerSlug, orgSlug };
}

/** published + live org/partner + (hosted) trusted partner. Spec §7 "Serve", §19.11. */
export function livePublicationPredicate(): SQL {
  const parts: SQL[] = [isNotNull(trustPages.publishedAt), buildPublicLinkLiveOrgPredicate(trustPages.orgId)];
  if (partnerTrustMode() !== 'off') parts.push(eq(partners.trustState, 'trusted'));
  return and(...parts)!;
}

export interface ResolvedTrustPage {
  pageId: string; orgId: string; partnerId: string; publishedAt: Date; searchIndexable: boolean;
  lastEvaluatedAt: Date | null; snapshotId: string | null; payload: TrustPagePublicPayload | null;
}

/** ONE indexed query. Caller holds the system db context. Unknown/unpublished/non-live/untrusted → null. */
export async function resolvePublishedTrustPage(partnerSlug: string, orgSlug: string | null): Promise<ResolvedTrustPage | null> {
  const target = orgSlug === null
    ? eq(trustPages.isPartnerHome, true)
    : sql`lower(${organizations.slug}) = ${orgSlug}`;
  const [row] = await db.select({
      pageId: trustPages.id, orgId: trustPages.orgId, partnerId: trustPages.partnerId, publishedAt: trustPages.publishedAt,
      searchIndexable: trustPages.searchIndexable, lastEvaluatedAt: trustPages.lastEvaluatedAt,
      snapshotId: trustPageSnapshots.id, payload: trustPageSnapshots.payload,
    })
    .from(trustPages)
    .innerJoin(organizations, eq(organizations.id, trustPages.orgId))
    .innerJoin(partners, eq(partners.id, trustPages.partnerId))
    .leftJoin(trustPageSnapshots, and(eq(trustPageSnapshots.trustPageId, trustPages.id), eq(trustPageSnapshots.isCurrent, true)))
    .where(and(eq(partners.slug, partnerSlug), target, livePublicationPredicate()))
    .limit(1);
  if (!row || !row.publishedAt) return null;
  return { ...row, publishedAt: row.publishedAt, payload: row.payload ?? null };
}
```

- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/services/trustPage` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/trustPage
git commit -m "feat(api): trust page Redis serving-set, snapshot cache and single-query live resolve (trust mode aware)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Publication service, preview tokens, trust capability and the trust-state hook

**Files:**
- Create: `apps/api/src/services/trustPage/publication.ts`
- Create: `apps/api/src/services/trustPage/previewToken.ts`
- Modify: `apps/api/src/services/partnerTrust.ts` (`GatedCapability` + `setTrustState` hook)
- Test: `apps/api/src/services/trustPage/publication.test.ts`, `apps/api/src/services/trustPage/previewToken.test.ts`, `apps/api/src/__tests__/integration/trustPagePublication.integration.test.ts`

**Interfaces:**
```ts
// publication.ts
export class TrustPageError extends Error { constructor(message: string, public status: 400|403|404|409|422, public code: string) }
export interface SnapshotBuild { snapshotId: string; payload: TrustPagePublicPayload; sha256: string; deviceCount: number; generatedAt: Date }
export async function ensureTrustPage(orgId: string, actorUserId: string | null): Promise<TrustPageRow>;   // get-or-create draft (partner_id from organizations)
export async function buildSnapshotForPage(page: TrustPageRow, opts?: { publishedAt?: Date }): Promise<SnapshotBuild>;  // loader → evaluate → documents → builder; caller's db context
export async function publishTrustPage(args: { orgId: string; expectedRevision: number; actorUserId: string; authorization?: { authorizedBy: string } | null; partnerTrustState: PartnerTrustState; partnerSlug: string; orgSlug: string }): Promise<{ page: TrustPageRow; snapshotId: string }>;
export async function unpublishTrustPage(args: { orgId: string; actorUserId: string; partnerSlug: string; orgSlug: string; isPartnerHome: boolean }): Promise<TrustPageRow>;
export async function refreshPublishedPage(pageId: string): Promise<{ rebuilt: boolean; snapshotId: string | null }>;   // worker; system context
export async function loadPublicDocumentsForPage(page: TrustPageRow): Promise<OrgDocumentView[]>;   // linked, public, confirmed, live, not superseded, sort order
export function validatePublishSlugs(partnerSlug: string, orgSlug: string): void;   // throws TrustPageError 422 SLUG_INVALID
// previewToken.ts
export async function createTrustPreviewToken(input: { pageId: string; orgId: string }): Promise<string>;           // 15 min, aud 'breeze-trust-preview'
export async function verifyTrustPreviewToken(token: string): Promise<{ pageId: string; orgId: string } | null>;
```

- [ ] **Step 1: Capability and hook (tiny, do first)**

In `apps/api/src/services/partnerTrust.ts`:
```ts
export type GatedCapability = 'remote_control' | 'device_execute' | 'installer_distribute' | 'agent_enroll' | 'custom_sending_domain' | 'trust_page_publish';
```
(`decide()`'s `default` branch already denies probation and restricted.) In `setTrustState`, after the Redis publish and before the audit write:
```ts
  // Trust Center (spec §9 "Trust and entitlement"): restricting a partner hides every page it
  // publishes within the second via the live predicate; the serving-set is an admission filter
  // and is refreshed here so misses stay DB-free.
  try {
    const { refreshServingForPartner } = await import('./trustPage/servingSet');
    await refreshServingForPartner(partnerId);
  } catch (error) {
    console.warn('[partnerTrust] trust page serving-set refresh failed:', error);
  }
```
Add a test to `partnerTrust.test.ts` (or a new `partnerTrust.trustPage.test.ts`): `evaluateCapabilityContinuationForState('trust_page_publish', ctx, { trustState: 'probation', probationEnrollments: 0 })` → `allow: false, reason: 'probation_default_deny'`; `'restricted'` → deny; `'trusted'` → allow; and `setTrustState` calls `refreshServingForPartner` with the partner id (mock the module).

- [ ] **Step 2: Preview token (test first)**

```ts
// apps/api/src/services/trustPage/previewToken.test.ts
import { describe, expect, it, vi } from 'vitest';
vi.mock('../jwt', async (orig) => {
  const key = new TextEncoder().encode('test-secret-test-secret-test-secret-32');
  return { ...(await orig<typeof import('../jwt')>()), getSignKey: () => ({ key }), getVerifyKey: () => key, buildHeader: () => ({ alg: 'HS256' as const }) };
});
import { createTrustPreviewToken, verifyTrustPreviewToken } from './previewToken';

describe('trust preview token', () => {
  it('round-trips pageId/orgId and is bound to purpose + audience', async () => {
    const t = await createTrustPreviewToken({ pageId: 'page-1', orgId: 'org-1' });
    expect(await verifyTrustPreviewToken(t)).toEqual({ pageId: 'page-1', orgId: 'org-1' });
  });
  it('rejects garbage and expired tokens', async () => {
    expect(await verifyTrustPreviewToken('nope')).toBeNull();
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    const t = await createTrustPreviewToken({ pageId: 'p', orgId: 'o' });
    vi.setSystemTime(new Date('2026-10-13T12:16:00Z'));
    expect(await verifyTrustPreviewToken(t)).toBeNull();
    vi.useRealTimers();
  });
});
```
```ts
// apps/api/src/services/trustPage/previewToken.ts
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { buildHeader, getSignKey, getVerifyKey } from '../jwt';

const ISSUER = 'breeze';
const AUDIENCE = 'breeze-trust-preview';
const PURPOSE = 'trust-preview';
export const TRUST_PREVIEW_TTL_SECONDS = 15 * 60;

export async function createTrustPreviewToken(input: { pageId: string; orgId: string }): Promise<string> {
  const signKey = getSignKey();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ pageId: input.pageId, orgId: input.orgId, purpose: PURPOSE })
    .setProtectedHeader(buildHeader(signKey.kid)).setJti(randomUUID()).setIssuedAt(now)
    .setExpirationTime(now + TRUST_PREVIEW_TTL_SECONDS).setIssuer(ISSUER).setAudience(AUDIENCE).sign(signKey.key);
}
export async function verifyTrustPreviewToken(token: string): Promise<{ pageId: string; orgId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getVerifyKey, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
    if (payload.purpose !== PURPOSE || typeof payload.pageId !== 'string' || typeof payload.orgId !== 'string') return null;
    return { pageId: payload.pageId, orgId: payload.orgId };
  } catch { return null; }
}
```

- [ ] **Step 3: Publication service tests (unit, mocked db) — the transaction semantics are covered by the integration test in Step 5**

```ts
// apps/api/src/services/trustPage/publication.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
vi.mock('../postureEvidence', () => ({ loadPostureEvidence: vi.fn(), TRUST_PAGE_EVIDENCE_POLICY: { sites: [], windowDays: 30, minPasswordLength: 8, maxLocalAdmins: 2, maxAvDefinitionsAgeDays: 7, maxSecurityStatusAgeDays: 30, includeCis: true, monitoringWindowHours: 24 } }));
vi.mock('./servingSet', () => ({ addServing: vi.fn(), removeServing: vi.fn(), cacheSnapshotPayload: vi.fn(), trustServingMember: (p: string, o?: string) => (o ? `${p}/${o}` : p) }));
vi.mock('../../config/partnerTrustMode', () => ({ partnerTrustMode: () => 'enforce' }));
const dbm = vi.hoisted(() => ({ select: vi.fn(), transaction: vi.fn(), insert: vi.fn(), update: vi.fn() }));
vi.mock('../../db', () => ({ db: dbm, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() }));
import { emptyControlEvidence } from '@breeze/shared';
import { loadPostureEvidence } from '../postureEvidence';
import { publishTrustPage, validatePublishSlugs, TrustPageError } from './publication';

describe('validatePublishSlugs', () => {
  it('throws 422 SLUG_INVALID with the offending slug named', () => {
    expect(() => validatePublishSlugs('Northwind', 'acme')).toThrowError(TrustPageError);
    try { validatePublishSlugs('nw', 'Acme Dental'); } catch (e) { expect(e).toMatchObject({ status: 422, code: 'SLUG_INVALID' }); expect((e as Error).message).toMatch(/organization slug/); }
    expect(() => validatePublishSlugs('nw', 'acme-dental')).not.toThrow();
  });
});

describe('publishTrustPage guards', () => {
  beforeEach(() => { vi.mocked(loadPostureEvidence).mockResolvedValue({ asOf: new Date().toISOString(), org: { id: 'o', name: 'Acme', partnerId: 'p' }, scopeKind: 'unrestricted', deviceCount: 0, devices: [], controls: emptyControlEvidence(), report: { reporting: 0, unprotected: 0, cisIncluded: true, cisAssessedCount: 0, edrUnknown: 0, anyAvUnknown: 0, orgWide: null, backupProviders: { evidence: [], coveredDeviceCount: 0 }, vulnByDevice: new Map() } }); });
  it('refuses probation/restricted partners with 403 TRUST_PROBATION / TRUST_RESTRICTED', async () => {
    await expect(publishTrustPage({ orgId: 'o', expectedRevision: 0, actorUserId: 'u', partnerTrustState: 'probation', partnerSlug: 'nw', orgSlug: 'acme' })).rejects.toMatchObject({ status: 403, code: 'TRUST_PROBATION' });
    await expect(publishTrustPage({ orgId: 'o', expectedRevision: 0, actorUserId: 'u', partnerTrustState: 'restricted', partnerSlug: 'nw', orgSlug: 'acme' })).rejects.toMatchObject({ status: 403, code: 'TRUST_RESTRICTED' });
  });
  it('a customer page without authorization (stored or supplied) fails 422 AUTHORIZATION_REQUIRED before touching the transaction', async () => {
    dbm.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ id: 'pg', orgId: 'o', partnerId: 'p', isPartnerHome: false, publicationRevision: 0, publicationAuthorizedBy: null, hiddenControlIds: [] }] }) }) });
    await expect(publishTrustPage({ orgId: 'o', expectedRevision: 0, actorUserId: 'u', partnerTrustState: 'trusted', partnerSlug: 'nw', orgSlug: 'acme' })).rejects.toMatchObject({ status: 422, code: 'AUTHORIZATION_REQUIRED' });
    expect(dbm.transaction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Implement `publication.ts`**

```ts
// apps/api/src/services/trustPage/publication.ts
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { orgDocuments, organizations, partners, portalBranding, trustPageDocuments, trustPages, trustPageSnapshots, ORG_DOCUMENT_META_COLUMNS } from '../../db/schema';
import type { PartnerTrustState } from '../../db/schema/orgs';
import type { TrustPageRow } from '../../db/schema/trustPages';
import { partnerTrustMode } from '../../config/partnerTrustMode';
import { loadPostureEvidence, TRUST_PAGE_EVIDENCE_POLICY } from '../postureEvidence';
import type { OrgDocumentView } from '../orgDocumentService';
import { buildTrustPagePayload, payloadSha256 } from './payloadBuilder';
import { addServing, cacheSnapshotPayload, removeServing, trustServingMember } from './servingSet';
import {
  DEFAULT_TRUST_EVALUATION_POLICY, TRUST_CONTROL_CATALOG, TRUST_CONTROL_CATALOG_VERSION, TRUST_SLUG_RE,
  evaluateTrustControls, type TrustPagePublicPayload,
} from '@breeze/shared';

export class TrustPageError extends Error {
  constructor(message: string, public readonly status: 400 | 403 | 404 | 409 | 422, public readonly code: string) { super(message); }
}

export function validatePublishSlugs(partnerSlug: string, orgSlug: string): void {
  if (!TRUST_SLUG_RE.test(partnerSlug)) throw new TrustPageError(`The partner slug "${partnerSlug}" is not URL-safe (lowercase letters, digits and hyphens, max 63). Fix it in partner settings before publishing.`, 422, 'SLUG_INVALID');
  if (!TRUST_SLUG_RE.test(orgSlug)) throw new TrustPageError(`The organization slug "${orgSlug}" is not URL-safe (lowercase letters, digits and hyphens, max 63). Fix it in the organization settings before publishing.`, 422, 'SLUG_INVALID');
}

export async function ensureTrustPage(orgId: string, actorUserId: string | null): Promise<TrustPageRow> {
  const [existing] = await db.select().from(trustPages).where(eq(trustPages.orgId, orgId)).limit(1);
  if (existing) return existing;
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt))).limit(1);
  if (!org) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
  const [created] = await db.insert(trustPages).values({ orgId, partnerId: org.partnerId, createdByUserId: actorUserId, updatedByUserId: actorUserId })
    .onConflictDoNothing({ target: trustPages.orgId }).returning();
  if (created) return created;
  const [raced] = await db.select().from(trustPages).where(eq(trustPages.orgId, orgId)).limit(1);
  return raced!;
}

/** Linked + public + disclosure-confirmed + live + not superseded, in sort order (spec §12). */
export async function loadPublicDocumentsForPage(page: TrustPageRow): Promise<OrgDocumentView[]> {
  const successor = alias(orgDocuments, 'successor');
  const rows = await db.select({ ...ORG_DOCUMENT_META_COLUMNS, supersededByDocumentId: successor.id, sortOrder: trustPageDocuments.sortOrder })
    .from(trustPageDocuments)
    .innerJoin(orgDocuments, and(eq(orgDocuments.id, trustPageDocuments.documentId), eq(orgDocuments.orgId, trustPageDocuments.orgId)))
    .leftJoin(successor, and(eq(successor.supersedesDocumentId, orgDocuments.id), eq(successor.orgId, orgDocuments.orgId)))
    .where(and(eq(trustPageDocuments.trustPageId, page.id), eq(trustPageDocuments.visibility, 'public'),
      sql`${trustPageDocuments.disclosureConfirmedAt} IS NOT NULL`, isNull(orgDocuments.deletedAt), isNull(successor.id)))
    .orderBy(asc(trustPageDocuments.sortOrder), asc(orgDocuments.createdAt));
  return rows.map(({ supersededByDocumentId: _s, sortOrder: _o, createdAt, ...r }) => ({ ...r, supersededByDocumentId: null, createdAt: createdAt.toISOString() }));
}

export interface SnapshotBuild { snapshotId: string; payload: TrustPagePublicPayload; sha256: string; deviceCount: number; generatedAt: Date }

/** loader → evaluator → documents → builder. Runs in the CALLER's db context (route: user RLS; worker: system). */
export async function buildSnapshotForPage(page: TrustPageRow, opts: { publishedAt?: Date } = {}): Promise<SnapshotBuild> {
  const generatedAt = new Date();
  const [ctx] = await db.select({
      orgName: organizations.name, partnerName: partners.name, partnerSettings: partners.settings,
      billingWebsite: partners.billingWebsite, trustPageUnbranded: partners.trustPageUnbranded,
    }).from(organizations).innerJoin(partners, eq(partners.id, organizations.partnerId)).where(eq(organizations.id, page.orgId)).limit(1);
  if (!ctx) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
  const [brand] = await db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor }).from(portalBranding).where(eq(portalBranding.orgId, page.orgId)).limit(1);
  const evidence = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: page.orgId }, TRUST_PAGE_EVIDENCE_POLICY, generatedAt);
  const assessments = evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence.controls, DEFAULT_TRUST_EVALUATION_POLICY, generatedAt);
  const documents = await loadPublicDocumentsForPage(page);
  const snapshotId = randomUUID();
  const payload = buildTrustPagePayload({
    snapshotId, generatedAt, publishedAt: opts.publishedAt ?? page.publishedAt ?? generatedAt,
    page, org: { name: ctx.orgName },
    partner: { name: ctx.partnerName, settings: ctx.partnerSettings, billingWebsite: ctx.billingWebsite, trustPageUnbranded: ctx.trustPageUnbranded },
    orgBrand: brand ?? null, assessments, deviceCount: evidence.deviceCount, documents,
    policy: { evidenceMaxAgeDays: TRUST_PAGE_EVIDENCE_POLICY.maxSecurityStatusAgeDays, definitionsMaxAgeDays: TRUST_PAGE_EVIDENCE_POLICY.maxAvDefinitionsAgeDays,
      coverageFloorPct: DEFAULT_TRUST_EVALUATION_POLICY.coverageFloorPct, thresholds: DEFAULT_TRUST_EVALUATION_POLICY.thresholds },
  });
  return { snapshotId, payload, sha256: payloadSha256(payload), deviceCount: evidence.deviceCount, generatedAt };
}

function trustDenial(state: PartnerTrustState): TrustPageError | null {
  if (partnerTrustMode() === 'off' || state === 'trusted') return null;
  return state === 'restricted'
    ? new TrustPageError('Publishing is unavailable for this account.', 403, 'TRUST_RESTRICTED')
    : new TrustPageError('Publishing opens once your account is trusted.', 403, 'TRUST_PROBATION');
}

/** One transaction: insert current snapshot, demote the previous, stamp published_at, bump revision — only if the
 *  revision still matches (409 otherwise). Serving-set and cache writes happen AFTER commit. */
export async function publishTrustPage(args: {
  orgId: string; expectedRevision: number; actorUserId: string; authorization?: { authorizedBy: string } | null;
  partnerTrustState: PartnerTrustState; partnerSlug: string; orgSlug: string;
}): Promise<{ page: TrustPageRow; snapshotId: string }> {
  const denied = trustDenial(args.partnerTrustState);
  if (denied) throw denied;
  validatePublishSlugs(args.partnerSlug, args.orgSlug);
  const [page] = await db.select().from(trustPages).where(eq(trustPages.orgId, args.orgId)).limit(1);
  if (!page) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
  const authorizedBy = args.authorization?.authorizedBy?.trim() || page.publicationAuthorizedBy;
  if (!page.isPartnerHome && !authorizedBy) {
    throw new TrustPageError('Record who at the customer authorized publication before publishing.', 422, 'AUTHORIZATION_REQUIRED');
  }
  const publishedAt = page.publishedAt ?? new Date();
  const built = await buildSnapshotForPage({ ...page, publishedAt }, { publishedAt });

  const result = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ rev: trustPages.publicationRevision }).from(trustPages).where(eq(trustPages.id, page.id)).for('update');
    if (!locked || locked.rev !== args.expectedRevision) return null;
    await tx.update(trustPageSnapshots).set({ isCurrent: false }).where(and(eq(trustPageSnapshots.trustPageId, page.id), eq(trustPageSnapshots.isCurrent, true)));
    await tx.insert(trustPageSnapshots).values({
      id: built.snapshotId, trustPageId: page.id, orgId: page.orgId, payload: built.payload, payloadSha256: built.sha256,
      catalogVersion: TRUST_CONTROL_CATALOG_VERSION, publicationRevision: args.expectedRevision + 1, isCurrent: true, generatedAt: built.generatedAt,
    });
    const [updated] = await tx.update(trustPages).set({
      publishedAt, publicationRevision: args.expectedRevision + 1, lastEvaluatedAt: built.generatedAt,
      updatedAt: new Date(), updatedByUserId: args.actorUserId,
      ...(args.authorization?.authorizedBy ? { publicationAuthorizedBy: args.authorization.authorizedBy.trim(), publicationAuthorizedAt: new Date(), publicationAuthorizedByUserId: args.actorUserId } : {}),
    }).where(eq(trustPages.id, page.id)).returning();
    return updated;
  });
  if (!result) throw new TrustPageError('This page changed since you loaded it. Reload and publish again.', 409, 'REVISION_MISMATCH');

  await cacheSnapshotPayload(built.snapshotId, built.payload);
  const members = [trustServingMember(args.partnerSlug, args.orgSlug)];
  if (result.isPartnerHome) members.push(trustServingMember(args.partnerSlug));
  await addServing(members);
  return { page: result, snapshotId: built.snapshotId };
}

export async function unpublishTrustPage(args: { orgId: string; actorUserId: string; partnerSlug: string; orgSlug: string; isPartnerHome: boolean }): Promise<TrustPageRow> {
  const [updated] = await db.update(trustPages).set({
    publishedAt: null, publicationRevision: sql`${trustPages.publicationRevision} + 1`, updatedAt: new Date(), updatedByUserId: args.actorUserId,
  }).where(eq(trustPages.orgId, args.orgId)).returning();
  if (!updated) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
  await removeServing([trustServingMember(args.partnerSlug, args.orgSlug), ...(args.isPartnerHome ? [trustServingMember(args.partnerSlug)] : [])]);
  return updated;
}

/** Worker path (system context). Inserts a new current snapshot only when the content hash changed and the
 *  revision is unchanged (a racing publish wins); always stamps last_evaluated_at. */
export async function refreshPublishedPage(pageId: string): Promise<{ rebuilt: boolean; snapshotId: string | null }> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [page] = await db.select().from(trustPages).where(and(eq(trustPages.id, pageId), sql`${trustPages.publishedAt} IS NOT NULL`)).limit(1);
    if (!page) return { rebuilt: false, snapshotId: null };
    const [current] = await db.select({ id: trustPageSnapshots.id, sha: trustPageSnapshots.payloadSha256 }).from(trustPageSnapshots)
      .where(and(eq(trustPageSnapshots.trustPageId, page.id), eq(trustPageSnapshots.isCurrent, true))).limit(1);
    const built = await buildSnapshotForPage(page);
    const rev = page.publicationRevision;
    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx.select({ rev: trustPages.publicationRevision, publishedAt: trustPages.publishedAt }).from(trustPages).where(eq(trustPages.id, page.id)).for('update');
      if (!locked || locked.rev !== rev || !locked.publishedAt) return { rebuilt: false, snapshotId: current?.id ?? null };
      if (current && current.sha === built.sha256) {
        await tx.update(trustPages).set({ lastEvaluatedAt: built.generatedAt }).where(eq(trustPages.id, page.id));
        return { rebuilt: false, snapshotId: current.id };
      }
      await tx.update(trustPageSnapshots).set({ isCurrent: false }).where(and(eq(trustPageSnapshots.trustPageId, page.id), eq(trustPageSnapshots.isCurrent, true)));
      await tx.insert(trustPageSnapshots).values({
        id: built.snapshotId, trustPageId: page.id, orgId: page.orgId, payload: built.payload, payloadSha256: built.sha256,
        catalogVersion: TRUST_CONTROL_CATALOG_VERSION, publicationRevision: rev, isCurrent: true, generatedAt: built.generatedAt,
      });
      await tx.update(trustPages).set({ lastEvaluatedAt: built.generatedAt }).where(eq(trustPages.id, page.id));
      return { rebuilt: true, snapshotId: built.snapshotId };
    });
    if (outcome.rebuilt) await cacheSnapshotPayload(built.snapshotId, built.payload);
    return outcome;
  }));
}
```
`portalBranding` is exported from `db/schema/portal.ts`; `ORG_DOCUMENT_META_COLUMNS` from `db/schema/orgDocuments.ts` (both reachable through the schema barrel). If `.for('update')` is not available on the select builder in this Drizzle version, use `tx.execute(sql\`SELECT publication_revision FROM trust_pages WHERE id = ${page.id} FOR UPDATE\`)`.

- [ ] **Step 5: Integration test (real Postgres, Review Focus 3)**

```ts
// apps/api/src/__tests__/integration/trustPagePublication.integration.test.ts
// Follows the setup idiom of securityComplianceReport.integration.test.ts (seed partner/org via helpers there).
import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { trustPages, trustPageSnapshots } from '../../db/schema';
import { ensureTrustPage, publishTrustPage, refreshPublishedPage, unpublishTrustPage } from '../../services/trustPage/publication';
// import { seedPartnerAndOrg } from './helpers/...' — reuse the seeding helper the posture report integration test uses.

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

describe('trust page publication', () => {
  let orgId: string; let partnerSlug: string; let orgSlug: string; let userId: string;
  beforeAll(async () => { ({ orgId, partnerSlug, orgSlug, userId } = await seedTrustedPartnerWithOrg({ partnerSlug: 'nw-int', orgSlug: 'acme-int' })); });

  it('publishes with an attestation, serves one current snapshot, 409s on a stale revision', async () => {
    await sys(() => ensureTrustPage(orgId, userId));
    const first = await sys(() => publishTrustPage({ orgId, expectedRevision: 0, actorUserId: userId, authorization: { authorizedBy: 'Jane Doe, COO' }, partnerTrustState: 'trusted', partnerSlug, orgSlug }));
    expect(first.page.publicationRevision).toBe(1);
    await expect(sys(() => publishTrustPage({ orgId, expectedRevision: 0, actorUserId: userId, partnerTrustState: 'trusted', partnerSlug, orgSlug }))).rejects.toMatchObject({ status: 409 });
    const current = await sys(() => db.select().from(trustPageSnapshots).where(and(eq(trustPageSnapshots.trustPageId, first.page.id), eq(trustPageSnapshots.isCurrent, true))));
    expect(current).toHaveLength(1);
  });

  it('refresh with unchanged evidence does not insert; a concurrent publish keeps exactly one is_current', async () => {
    const [page] = await sys(() => db.select().from(trustPages).where(eq(trustPages.orgId, orgId)));
    const before = await sys(() => db.select().from(trustPageSnapshots).where(eq(trustPageSnapshots.trustPageId, page.id)));
    const r = await refreshPublishedPage(page.id);
    expect(r.rebuilt).toBe(false);
    const [reloaded] = await sys(() => db.select().from(trustPages).where(eq(trustPages.id, page.id)));
    expect(reloaded.lastEvaluatedAt).not.toBeNull();
    await Promise.all([
      refreshPublishedPage(page.id),
      sys(() => publishTrustPage({ orgId, expectedRevision: page.publicationRevision, actorUserId: userId, partnerTrustState: 'trusted', partnerSlug, orgSlug })),
    ]);
    const current = await sys(() => db.select().from(trustPageSnapshots).where(and(eq(trustPageSnapshots.trustPageId, page.id), eq(trustPageSnapshots.isCurrent, true))));
    expect(current).toHaveLength(1);
    expect((await sys(() => db.select().from(trustPageSnapshots).where(eq(trustPageSnapshots.trustPageId, page.id)))).length).toBeGreaterThanOrEqual(before.length);
  });

  it('snapshots are immutable except is_current', async () => {
    const [snap] = await sys(() => db.select().from(trustPageSnapshots).where(eq(trustPageSnapshots.orgId, orgId)).limit(1));
    await expect(sys(() => db.update(trustPageSnapshots).set({ catalogVersion: 'tampered' }).where(eq(trustPageSnapshots.id, snap.id)))).rejects.toThrow(/immutable/);
  });

  it('unpublish clears published_at and bumps the revision; erasing the org succeeds with a published page', async () => {
    const [page] = await sys(() => db.select().from(trustPages).where(eq(trustPages.orgId, orgId)));
    const u = await sys(() => unpublishTrustPage({ orgId, actorUserId: userId, partnerSlug, orgSlug, isPartnerHome: false }));
    expect(u.publishedAt).toBeNull();
    expect(u.publicationRevision).toBe(page.publicationRevision + 1);
    // Erasure: reuse the cascade helper the tenantCascadeExecution integration test calls, then assert zero trust_* rows for orgId.
  });
});
```
Write `seedTrustedPartnerWithOrg` in the integration helpers directory if no equivalent exists (partner `trust_state='trusted'`, org `status='active'`, one user).

- [ ] **Step 6: Run**

`cd apps/api && npx vitest run src/services/trustPage src/services/partnerTrust` → PASS; `pnpm --filter @breeze/api test:integration src/__tests__/integration/trustPagePublication.integration.test.ts` (test stack up) → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/trustPage apps/api/src/services/partnerTrust.ts apps/api/src/services/partnerTrust*.test.ts apps/api/src/__tests__/integration/trustPagePublication.integration.test.ts apps/api/src/__tests__/integration/helpers
git commit -m "feat(api): trust page publication (revision-checked publish/unpublish/refresh), preview tokens, trust_page_publish capability, serving-set hook on trust-state change

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Authenticated routes `/orgs/:orgId/trust-page/*` and the operator flag

**Files:**
- Create: `apps/api/src/routes/trustPage.ts`
- Modify: `apps/api/src/index.ts` (import + `api.route('/orgs', trustPageRoutes); // /orgs/:orgId/trust-page/*`)
- Modify: `apps/api/src/routes/orgs.ts` (`trustPageUnbranded: z.boolean().optional()` in `updatePartnerSchema` next to `aiForOfficeEnabled`; include `trustPageUnbranded: partners.trustPageUnbranded` in the partner select; **not** in the `/partners/me` schema)
- Test: `apps/api/src/routes/trustPage.test.ts`

**Interfaces (all JSON `{ data }` envelopes; errors `{ error, code }`):**

| Method | Path | Guards | Body / result |
|---|---|---|---|
| GET | `/:orgId/trust-page` | scopes, orgRead | `{ page, publicUrl, badgeUrl, slugs: { partnerSlug, orgSlug, valid, problems[] }, canPublish: { allowed, reason } }` (creates the draft row on first GET) |
| PUT | `/:orgId/trust-page` | scopes, orgWrite, `trustPageUpdateSchema` | returns `{ page }` with the new revision; intro sanitized here too |
| PUT | `/:orgId/trust-page/documents` | scopes, orgWrite, `trustPageDocumentsUpdateSchema` | replaces links; 422 `DOCUMENT_UNAVAILABLE` for a deleted/superseded/foreign document |
| POST | `/:orgId/trust-page/publish` | scopes, orgWrite, `requireMfa()`, `requireCapability('trust_page_publish')`, `trustPagePublishSchema` | `{ page, snapshotId }`; 409 `REVISION_MISMATCH`; 422 `SLUG_INVALID` / `AUTHORIZATION_REQUIRED` |
| POST | `/:orgId/trust-page/unpublish` | scopes, orgWrite, `requireMfa()` | `{ page }` |
| POST | `/:orgId/trust-page/partner-home` | scopes, orgWrite, partner-wide admin, `trustPagePartnerHomeSchema` | moves the flag (clears any other page's flag in the same transaction) |
| POST | `/:orgId/trust-page/preview-token` | scopes, orgRead | `{ token, expiresInSeconds: 900, previewPath: '/trust/preview/<token>' }` |
| GET | `/:orgId/trust-page/controls` | scopes, orgRead | `{ assessments: TrustControlAssessment[], catalog: TrustControlDefinition[], evaluatedAt, deviceCount }` — the editor's live preview |

`scopes = requireScope('partner', 'system')`; `orgRead = requirePermission(PERMISSIONS.ORGS_READ…)`; `orgWrite = requirePermission(PERMISSIONS.ORGS_WRITE…)`. Every handler resolves the org through `resolveAccessibleOrg(c, orgId)` → 404 when `auth.scope === 'partner' && !auth.canAccessOrg(orgId)` or the org is soft-deleted (precedent `routes/orgPortalSettings.ts`). Audit (`createAuditLogAsync`) actions: `trust_page.update`, `trust_page.documents.update` (details: added/removed ids, confirmed count), `trust_page.publish` (details: `publicationRevision`, `snapshotId`, `authorizedBy` present?), `trust_page.unpublish`, `trust_page.partner_home` (details: from/to page ids); `resourceType: 'trust_page'`, `resourceId: page.id`.

- [ ] **Step 1: Write the failing route tests** (mock pattern from `orgDocuments.test.ts`)

```ts
// apps/api/src/routes/trustPage.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: c.req.header('x-scope') ?? 'partner', partnerOrgAccess: c.req.header('x-org-access') ?? 'all', accessibleOrgIds: ['org1'], canAccessOrg: (id: string) => id === 'org1' });
    return next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (c: any, next: any) => (c.req.header('x-mfa') === '1' ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)),
  requirePermission: (resource: string, action: string) => async (c: any, next: any) =>
    (c.req.header('x-allow') ?? '').split(',').includes(`${resource}:${action}`) ? next() : c.json({ error: 'Forbidden' }, 403),
}));
vi.mock('../services/partnerTrust', () => ({ requireCapability: () => async (c: any, next: any) => (c.req.header('x-trust') === 'deny' ? c.json({ error: 'TRUST_PROBATION' }, 403) : next()) }));
const svc = vi.hoisted(() => ({
  ensureTrustPage: vi.fn(), publishTrustPage: vi.fn(), unpublishTrustPage: vi.fn(), buildSnapshotForPage: vi.fn(),
  loadPublicDocumentsForPage: vi.fn(async () => []), validatePublishSlugs: vi.fn(),
}));
vi.mock('../services/trustPage/publication', async (orig) => ({ ...(await orig<typeof import('../services/trustPage/publication')>()), ...svc }));
vi.mock('../services/trustPage/previewToken', () => ({ createTrustPreviewToken: vi.fn(async () => 'tok'), TRUST_PREVIEW_TTL_SECONDS: 900 }));
const auditMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../services/auditService', () => ({ createAuditLogAsync: auditMock }));
const dbm = vi.hoisted(() => ({ rows: [] as unknown[][] }));
vi.mock('../db', () => {
  const chain = () => { const c: any = {}; for (const m of ['select', 'from', 'where', 'innerJoin', 'leftJoin', 'limit', 'orderBy', 'update', 'set', 'insert', 'values', 'returning', 'delete', 'onConflictDoNothing']) c[m] = vi.fn(() => c); c.then = (r: any) => Promise.resolve(dbm.rows.shift() ?? []).then(r); return c; };
  return { db: Object.assign(chain(), { transaction: async (fn: any) => fn(chain()) }), runOutsideDbContext: (fn: any) => fn(), withSystemDbAccessContext: (fn: any) => fn() };
});
import { authMiddleware } from '../middleware/auth';
import { trustPageRoutes } from './trustPage';

const PAGE = { id: 'pg1', orgId: 'org1', partnerId: 'p1', isPartnerHome: false, publishedAt: null, publicationRevision: 0, hiddenControlIds: [], showPercentages: false, showDeviceCount: false, showManagedBy: true, searchIndexable: false, introHtml: null, securityContactEmail: null, websiteUrl: null, publicationAuthorizedBy: null };
const app = new Hono(); app.use('*', authMiddleware); app.route('/orgs', trustPageRoutes);
const H = (extra: Record<string, string> = {}) => ({ authorization: 'Bearer t', 'x-allow': 'organizations:read,organizations:write', 'content-type': 'application/json', ...extra });

describe('trust page routes', () => {
  beforeEach(() => { dbm.rows = []; vi.clearAllMocks(); svc.ensureTrustPage.mockResolvedValue(PAGE); });

  it('GET creates the draft and reports slug validity and publish eligibility', async () => {
    dbm.rows.push([{ orgSlug: 'Acme Dental', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    const res = await app.request('/orgs/org1/trust-page', { headers: H() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.slugs).toMatchObject({ valid: false });
    expect(body.data.publicUrl).toMatch(/\/portal\/trust\/nw\//);
  });
  it('404s an org outside the caller\'s access', async () => {
    const res = await app.request('/orgs/org2/trust-page', { headers: H() });
    expect(res.status).toBe(404);
  });
  it('PUT validates and audits', async () => {
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }], [{ ...PAGE, publicationRevision: 1 }]);
    const res = await app.request('/orgs/org1/trust-page', { method: 'PUT', headers: H(), body: JSON.stringify({ introHtml: '<p>x</p><script>1</script>', hiddenControlIds: ['dns_filtering'] }) });
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'trust_page.update', orgId: 'org1' }));
    const bad = await app.request('/orgs/org1/trust-page', { method: 'PUT', headers: H(), body: JSON.stringify({ hiddenControlIds: ['nope'] }) });
    expect(bad.status).toBe(400);
  });
  it('publish requires MFA, write, capability and a matching revision; maps service errors', async () => {
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    expect((await app.request('/orgs/org1/trust-page/publish', { method: 'POST', headers: H(), body: JSON.stringify({ expectedRevision: 0 }) })).status).toBe(403); // no MFA
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    expect((await app.request('/orgs/org1/trust-page/publish', { method: 'POST', headers: H({ 'x-mfa': '1', 'x-trust': 'deny' }), body: JSON.stringify({ expectedRevision: 0 }) })).status).toBe(403);
    const { TrustPageError } = await import('../services/trustPage/publication');
    svc.publishTrustPage.mockRejectedValueOnce(new TrustPageError('stale', 409, 'REVISION_MISMATCH'));
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    const stale = await app.request('/orgs/org1/trust-page/publish', { method: 'POST', headers: H({ 'x-mfa': '1' }), body: JSON.stringify({ expectedRevision: 0 }) });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('REVISION_MISMATCH');
    svc.publishTrustPage.mockResolvedValueOnce({ page: { ...PAGE, publishedAt: new Date(), publicationRevision: 1 }, snapshotId: 's1' });
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    const ok = await app.request('/orgs/org1/trust-page/publish', { method: 'POST', headers: H({ 'x-mfa': '1' }), body: JSON.stringify({ expectedRevision: 0, authorization: { authorizedBy: 'Jane Doe, COO' } }) });
    expect(ok.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'trust_page.publish', details: expect.objectContaining({ snapshotId: 's1', publicationRevision: 1 }) }));
  });
  it('partner-home needs partner-wide admin', async () => {
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    const res = await app.request('/orgs/org1/trust-page/partner-home', { method: 'POST', headers: H({ 'x-org-access': 'selected' }), body: JSON.stringify({ isPartnerHome: true }) });
    expect(res.status).toBe(403);
  });
  it('preview-token returns a token and path', async () => {
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    const res = await app.request('/orgs/org1/trust-page/preview-token', { method: 'POST', headers: H() });
    expect(await res.json()).toEqual({ data: { token: 'tok', expiresInSeconds: 900, previewPath: '/trust/preview/tok' } });
  });
});
```

- [ ] **Step 2: Implement `routes/trustPage.ts`**

```ts
// apps/api/src/routes/trustPage.ts
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { orgDocuments, organizations, partners, trustPageDocuments, trustPages } from '../db/schema';
import { PERMISSIONS } from '../services/permissions';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { requireCapability, evaluateCapabilityContinuationForState } from '../services/partnerTrust';
import { createAuditLogAsync } from '../services/auditService';
import { captureException } from '../services/sentry';
import {
  buildSnapshotForPage, ensureTrustPage, publishTrustPage, unpublishTrustPage, TrustPageError, validatePublishSlugs,
} from '../services/trustPage/publication';
import { sanitizeIntro } from '../services/trustPage/payloadBuilder';
import { createTrustPreviewToken, TRUST_PREVIEW_TTL_SECONDS } from '../services/trustPage/previewToken';
import { loadPostureEvidence, TRUST_PAGE_EVIDENCE_POLICY } from '../services/postureEvidence';
import {
  DEFAULT_TRUST_EVALUATION_POLICY, TRUST_CONTROL_CATALOG, TRUST_SLUG_RE, evaluateTrustControls,
  trustPageDocumentsUpdateSchema, trustPagePartnerHomeSchema, trustPagePublishSchema, trustPageUpdateSchema,
} from '@breeze/shared';

export const trustPageRoutes = new Hono();
trustPageRoutes.use('*', authMiddleware);
const scopes = requireScope('partner', 'system');
const orgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const orgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
const orgParam = z.object({ orgId: z.string().guid() });

interface OrgCtx { orgId: string; orgSlug: string; partnerSlug: string; partnerId: string; trustState: 'probation' | 'trusted' | 'restricted'; probationEnrollments: number }
async function resolveAccessibleOrg(c: Context, orgId: string): Promise<OrgCtx | null> {
  const auth = c.get('auth') as AuthContext;
  if (auth.scope === 'partner' && !auth.canAccessOrg(orgId)) return null;
  const [row] = await db.select({ orgSlug: organizations.slug, partnerSlug: partners.slug, partnerId: partners.id, trustState: partners.trustState, probationEnrollments: partners.probationEnrollments, deletedAt: organizations.deletedAt })
    .from(organizations).innerJoin(partners, eq(partners.id, organizations.partnerId)).where(eq(organizations.id, orgId)).limit(1);
  if (!row || row.deletedAt) return null;
  return { orgId, orgSlug: row.orgSlug, partnerSlug: row.partnerSlug, partnerId: row.partnerId, trustState: row.trustState, probationEnrollments: row.probationEnrollments ?? 0 };
}
const notFound = (c: Context) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
function handleError(c: Context, err: unknown): Response {
  if (err instanceof TrustPageError) return c.json({ error: err.message, code: err.code }, err.status);
  captureException(err); throw err;
}
function publicPaths(ctx: OrgCtx, isPartnerHome: boolean) {
  const base = `/portal/trust/${ctx.partnerSlug}`;
  return {
    publicPath: isPartnerHome ? base : `${base}/${ctx.orgSlug}`,
    badgePath: `/api/v1/trust/public/${ctx.partnerSlug}/${ctx.orgSlug}/badge.svg`,
  };
}
function slugReport(ctx: OrgCtx) {
  const problems: string[] = [];
  if (!TRUST_SLUG_RE.test(ctx.partnerSlug)) problems.push('partner_slug');
  if (!TRUST_SLUG_RE.test(ctx.orgSlug)) problems.push('org_slug');
  return { partnerSlug: ctx.partnerSlug, orgSlug: ctx.orgSlug, valid: problems.length === 0, problems };
}
const audit = (c: Context, orgId: string, action: string, resourceId: string, details: Record<string, unknown>) => {
  const auth = c.get('auth') as AuthContext;
  return createAuditLogAsync({ orgId, actorId: auth.user.id, actorEmail: auth.user.email, action, resourceType: 'trust_page', resourceId, details, result: 'success' });
};

trustPageRoutes.get('/:orgId/trust-page', scopes, orgRead, zValidator('param', orgParam), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  try {
    const auth = c.get('auth') as AuthContext;
    const page = await ensureTrustPage(orgId, auth.user.id);
    const gate = evaluateCapabilityContinuationForState('trust_page_publish', { partnerId: ctx.partnerId }, { trustState: ctx.trustState, probationEnrollments: ctx.probationEnrollments });
    return c.json({ data: { page, ...publicPaths(ctx, page.isPartnerHome), slugs: slugReport(ctx), canPublish: gate.allow ? { allowed: true, reason: null } : { allowed: false, reason: gate.reason } } });
  } catch (err) { return handleError(c, err); }
});

trustPageRoutes.put('/:orgId/trust-page', scopes, orgWrite, zValidator('param', orgParam), zValidator('json', trustPageUpdateSchema), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  const body = c.req.valid('json');
  try {
    const page = await ensureTrustPage(orgId, auth.user.id);
    const patch: Partial<typeof trustPages.$inferInsert> = { updatedAt: new Date(), updatedByUserId: auth.user.id, publicationRevision: sql`${trustPages.publicationRevision} + 1` as never };
    if (body.introHtml !== undefined) patch.introHtml = sanitizeIntro(body.introHtml);
    if (body.securityContactEmail !== undefined) patch.securityContactEmail = body.securityContactEmail;
    if (body.websiteUrl !== undefined) patch.websiteUrl = body.websiteUrl;
    if (body.hiddenControlIds !== undefined) patch.hiddenControlIds = body.hiddenControlIds;
    for (const k of ['showPercentages', 'showDeviceCount', 'showManagedBy', 'searchIndexable'] as const) if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
    const [updated] = await db.update(trustPages).set(patch).where(eq(trustPages.id, page.id)).returning();
    await audit(c, orgId, 'trust_page.update', page.id, { fields: Object.keys(body), publicationRevision: updated.publicationRevision });
    return c.json({ data: { page: updated } });
  } catch (err) { return handleError(c, err); }
});

trustPageRoutes.put('/:orgId/trust-page/documents', scopes, orgWrite, zValidator('param', orgParam), zValidator('json', trustPageDocumentsUpdateSchema), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  const { documents } = c.req.valid('json');
  try {
    const page = await ensureTrustPage(orgId, auth.user.id);
    const ids = documents.map((d) => d.documentId);
    if (ids.length > 0) {
      const successor = alias(orgDocuments, 'successor');
      const live = await db.select({ id: orgDocuments.id }).from(orgDocuments)
        .leftJoin(successor, and(eq(successor.supersedesDocumentId, orgDocuments.id), eq(successor.orgId, orgDocuments.orgId)))
        .where(and(eq(orgDocuments.orgId, orgId), inArray(orgDocuments.id, ids), isNull(orgDocuments.deletedAt), isNull(successor.id)));
      const liveIds = new Set(live.map((r) => r.id));
      const missing = ids.filter((id) => !liveIds.has(id));
      if (missing.length) return c.json({ error: 'One or more documents are deleted, superseded or not in this organization.', code: 'DOCUMENT_UNAVAILABLE', details: { documentIds: missing } }, 422);
    }
    const [before] = await db.select({ ids: sql<string[]>`coalesce(array_agg(${trustPageDocuments.documentId}), '{}')` }).from(trustPageDocuments).where(eq(trustPageDocuments.trustPageId, page.id));
    await db.transaction(async (tx) => {
      await tx.delete(trustPageDocuments).where(eq(trustPageDocuments.trustPageId, page.id));
      if (documents.length) {
        await tx.insert(trustPageDocuments).values(documents.map((d, i) => ({
          trustPageId: page.id, documentId: d.documentId, orgId, visibility: d.visibility, sortOrder: i,
          disclosureConfirmedAt: d.disclosureConfirmed ? new Date() : null, disclosureConfirmedByUserId: d.disclosureConfirmed ? auth.user.id : null,
        })));
      }
      await tx.update(trustPages).set({ publicationRevision: sql`${trustPages.publicationRevision} + 1`, updatedAt: new Date(), updatedByUserId: auth.user.id }).where(eq(trustPages.id, page.id));
    });
    const after = new Set(ids); const prev = new Set(before?.ids ?? []);
    await audit(c, orgId, 'trust_page.documents.update', page.id, { added: ids.filter((i) => !prev.has(i)), removed: [...prev].filter((i) => !after.has(i)), confirmed: documents.filter((d) => d.disclosureConfirmed).length });
    return c.json({ data: { documents } });
  } catch (err) { return handleError(c, err); }
});

trustPageRoutes.post('/:orgId/trust-page/publish', scopes, orgWrite, requireMfa(), requireCapability('trust_page_publish'), zValidator('param', orgParam), zValidator('json', trustPagePublishSchema), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  const body = c.req.valid('json');
  try {
    const { page, snapshotId } = await publishTrustPage({ orgId, expectedRevision: body.expectedRevision, actorUserId: auth.user.id, authorization: body.authorization ?? null, partnerTrustState: ctx.trustState, partnerSlug: ctx.partnerSlug, orgSlug: ctx.orgSlug });
    await audit(c, orgId, 'trust_page.publish', page.id, { publicationRevision: page.publicationRevision, snapshotId, authorizationRecorded: Boolean(body.authorization) });
    return c.json({ data: { page, snapshotId, ...publicPaths(ctx, page.isPartnerHome) } });
  } catch (err) { return handleError(c, err); }
});

trustPageRoutes.post('/:orgId/trust-page/unpublish', scopes, orgWrite, requireMfa(), zValidator('param', orgParam), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  try {
    const current = await ensureTrustPage(orgId, auth.user.id);
    const page = await unpublishTrustPage({ orgId, actorUserId: auth.user.id, partnerSlug: ctx.partnerSlug, orgSlug: ctx.orgSlug, isPartnerHome: current.isPartnerHome });
    await audit(c, orgId, 'trust_page.unpublish', page.id, { publicationRevision: page.publicationRevision });
    return c.json({ data: { page } });
  } catch (err) { return handleError(c, err); }
});

trustPageRoutes.post('/:orgId/trust-page/partner-home', scopes, orgWrite, zValidator('param', orgParam), zValidator('json', trustPagePartnerHomeSchema), async (c) => {
  const { orgId } = c.req.valid('param');
  const auth = c.get('auth') as AuthContext;
  if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: 'PARTNER_WIDE_REQUIRED' }, 403);
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  const { isPartnerHome } = c.req.valid('json');
  try {
    const page = await ensureTrustPage(orgId, auth.user.id);
    const previous = await db.transaction(async (tx) => {
      const [prev] = await tx.select({ id: trustPages.id, orgId: trustPages.orgId }).from(trustPages).where(and(eq(trustPages.partnerId, ctx.partnerId), eq(trustPages.isPartnerHome, true))).limit(1);
      if (isPartnerHome) await tx.update(trustPages).set({ isPartnerHome: false, updatedAt: new Date() }).where(and(eq(trustPages.partnerId, ctx.partnerId), eq(trustPages.isPartnerHome, true)));
      await tx.update(trustPages).set({ isPartnerHome, publicationRevision: sql`${trustPages.publicationRevision} + 1`, updatedAt: new Date(), updatedByUserId: auth.user.id }).where(eq(trustPages.id, page.id));
      return prev ?? null;
    });
    const { refreshServingForPartner } = await import('../services/trustPage/servingSet');
    await refreshServingForPartner(ctx.partnerId);
    await audit(c, orgId, 'trust_page.partner_home', page.id, { isPartnerHome, previousPageId: previous?.id ?? null });
    const [updated] = await db.select().from(trustPages).where(eq(trustPages.id, page.id)).limit(1);
    return c.json({ data: { page: updated } });
  } catch (err) { return handleError(c, err); }
});

trustPageRoutes.post('/:orgId/trust-page/preview-token', scopes, orgRead, zValidator('param', orgParam), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  try {
    const page = await ensureTrustPage(orgId, auth.user.id);
    const token = await createTrustPreviewToken({ pageId: page.id, orgId });
    return c.json({ data: { token, expiresInSeconds: TRUST_PREVIEW_TTL_SECONDS, previewPath: `/trust/preview/${token}` } });
  } catch (err) { return handleError(c, err); }
});

trustPageRoutes.get('/:orgId/trust-page/controls', scopes, orgRead, zValidator('param', orgParam), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  try {
    const asOf = new Date();
    const evidence = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId }, TRUST_PAGE_EVIDENCE_POLICY, asOf);
    const assessments = evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence.controls, DEFAULT_TRUST_EVALUATION_POLICY, asOf);
    return c.json({ data: { assessments, catalog: TRUST_CONTROL_CATALOG, evaluatedAt: asOf.toISOString(), deviceCount: evidence.deviceCount } });
  } catch (err) { return handleError(c, err); }
});
```
Mount in `index.ts` next to `orgDocumentRoutes`: `api.route('/orgs', trustPageRoutes); // /orgs/:orgId/trust-page/* (Trust Center W1)`.

- [ ] **Step 3: Operator flag** — `routes/orgs.ts`: add `trustPageUnbranded: z.boolean().optional(),` under `aiForOfficeEnabled` in `updatePartnerSchema` with the same comment; add `trustPageUnbranded: partners.trustPageUnbranded,` to the partner select that returns `aiForOfficeEnabled`; confirm the `/partners/me` schema does **not** include it; extend the existing orgs route test that covers `aiForOfficeEnabled` with one case for `trustPageUnbranded` (system scope accepted, `/partners/me` rejects with 400 unrecognized key).

- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/routes/trustPage.test.ts src/routes/orgs.test.ts src/lib/validation.imports.test.ts` → PASS. Typecheck: `cd apps/api && npx tsc --noEmit -p tsconfig.json` (12 GB heap per repo trap: `NODE_OPTIONS=--max-old-space-size=12288`; check the exit code, never pipe to `tail`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/trustPage.ts apps/api/src/routes/trustPage.test.ts apps/api/src/index.ts apps/api/src/routes/orgs.ts apps/api/src/routes/orgs*.test.ts
git commit -m "feat(api): authenticated trust page routes (draft, documents, publish with attestation, unpublish, partner-home, preview token, live controls) + trust_page_unbranded operator flag

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Public routes — card (DB-free miss), payload, badge, documents, preview

**Files:**
- Create: `apps/api/src/routes/trustPagePublic.ts`
- Modify: `apps/api/src/middleware/globalRateLimit.ts` (`ISOLATED_BUCKETS` entry; `registerGlobalRateLimitSkipPrefix('/api/v1/trust/card/')` is called from `index.ts` right before mounting)
- Modify: `apps/api/src/middleware/partnerGuard.ts` (`isPartnerGuardExemptPath`: `if (path.startsWith('/api/v1/trust/card/') || path.startsWith('/api/v1/trust/public/')) return true;` with the autopay comment's reasoning)
- Modify: `apps/api/src/index.ts` (import, skip-prefix registration, `api.route('/trust', trustPagePublicRoutes);` mounted before any authenticated `/trust*` router — there is none today)
- Test: `apps/api/src/routes/trustPagePublic.test.ts`, extend `apps/api/src/middleware/globalRateLimit.test.ts` (card prefix exempt; `trustpublic` bucket limit 120)

**Interfaces (all unauthenticated):**

| Method | Path | Limiter | Response |
|---|---|---|---|
| GET | `/trust/card/:partnerSlug` and `/trust/card/:partnerSlug/:orgSlug` | **none** (skip-prefix) → must be DB-free on a miss | `{ data: { title, orgName, logoUrl, primaryColor, summaryLine, publishedAt, lastEvaluatedAt, stale, searchIndexable, managedByName } }`; 404 generic; **503 + Retry-After: 30 when Redis is unavailable** |
| GET | `/trust/public/:partnerSlug` and `/trust/public/:partnerSlug/:orgSlug` | isolated bucket `trustpublic` 120/min/IP | `{ data: { payload, lastEvaluatedAt, stale } }`; 404 generic; when Redis is unavailable, skip the serving-set and resolve live |
| GET | `/trust/public/:partnerSlug/:orgSlug/badge.svg` | isolated bucket | `image/svg+xml`, `Cache-Control: public, max-age=3600`; 404 generic |
| GET | `/trust/public/:partnerSlug/:orgSlug/documents/:documentId` | isolated bucket + in-route `rateLimiter` `trust-doc:<ip>` 20/60s (called before the db context) | streams via `getBlobStream`; `Content-Disposition: attachment`; live link check; 404 generic |
| GET | `/trust/public/preview/:token` | isolated bucket | `{ data: { payload, lastEvaluatedAt: null, stale: false, preview: true } }` built fresh from the draft; `Cache-Control: no-store`; 404 generic on invalid/expired |

`stale = lastEvaluatedAt === null || now − lastEvaluatedAt > 24h`. Headers on every `/trust/public/*` response: `Cache-Control: public, max-age=300, stale-while-revalidate=600` (payload, badge), `no-store` (preview, documents), `X-Robots-Tag: noindex` unless `searchIndexable`. Partner-home paths (no orgSlug) use the org resolved by `is_partner_home`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/routes/trustPagePublic.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
const serving = vi.hoisted(() => ({ isServing: vi.fn(), readCachedSnapshotPayload: vi.fn(async () => null), cacheSnapshotPayload: vi.fn() }));
vi.mock('../services/trustPage/servingSet', () => ({ ...serving, trustServingMember: (p: string, o?: string) => (o ? `${p}/${o}` : p) }));
const resolve = vi.hoisted(() => ({ resolvePublishedTrustPage: vi.fn() }));
vi.mock('../services/trustPage/resolve', async (orig) => ({ ...(await orig<typeof import('../services/trustPage/resolve')>()), ...resolve }));
const redis = vi.hoisted(() => ({ client: {} as unknown }));
vi.mock('../services/redis', () => ({ getRedis: () => redis.client }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: vi.fn(async () => ({ allowed: true, remaining: 1, resetAt: new Date() })) }));
vi.mock('../services/clientIp', () => ({ getTrustedClientIp: () => '203.0.113.9', rateLimitIpKey: (ip: string) => ip }));
const dbSelect = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({ db: { select: dbSelect }, runOutsideDbContext: (fn: any) => fn(), withSystemDbAccessContext: (fn: any) => fn() }));
vi.mock('../services/trustPage/previewToken', () => ({ verifyTrustPreviewToken: vi.fn(async (t: string) => (t === 'good' ? { pageId: 'pg', orgId: 'o' } : null)) }));
vi.mock('../services/trustPage/publication', () => ({ buildSnapshotForPage: vi.fn(async () => ({ payload: { schemaVersion: 1, controls: [] }, snapshotId: 's', sha256: 'x', deviceCount: 0, generatedAt: new Date() })) }));
import { trustPagePublicRoutes } from './trustPagePublic';

const PAYLOAD = { schemaVersion: 1, snapshotId: 's1', org: { name: 'Acme', logoUrl: null, primaryColor: null }, managedBy: { name: 'NW' }, summary: { catalogTotal: 15, controlsShown: 15, controlsMet: 9 }, controls: [], documents: [{ id: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6d', title: 'Doc' }], footer: { poweredByBreeze: true, frameworkAttributions: [] } };
const RESOLVED = { pageId: 'pg', orgId: 'o', partnerId: 'p', publishedAt: new Date('2026-10-01T00:00:00Z'), searchIndexable: false, lastEvaluatedAt: new Date(), snapshotId: 's1', payload: PAYLOAD };
const app = new Hono(); app.route('/trust', trustPagePublicRoutes);
const GENERIC = { error: 'Not found', code: 'NOT_FOUND' };

describe('card', () => {
  beforeEach(() => { vi.clearAllMocks(); redis.client = {}; serving.isServing.mockResolvedValue(true); resolve.resolvePublishedTrustPage.mockResolvedValue(RESOLVED); });
  it('serving-set miss → generic 404 with ZERO SQL', async () => {
    serving.isServing.mockResolvedValue(false);
    const res = await app.request('/trust/card/nw/acme');
    expect(res.status).toBe(404); expect(await res.json()).toEqual(GENERIC);
    expect(resolve.resolvePublishedTrustPage).not.toHaveBeenCalled(); expect(dbSelect).not.toHaveBeenCalled();
  });
  it('invalid slug → 404 before Redis', async () => {
    const res = await app.request('/trust/card/NW/acme');
    expect(res.status).toBe(404); expect(serving.isServing).not.toHaveBeenCalled();
  });
  it('Redis unavailable → 503 with Retry-After, no SQL', async () => {
    redis.client = null; serving.isServing.mockResolvedValue(null);
    const res = await app.request('/trust/card/nw/acme');
    expect(res.status).toBe(503); expect(res.headers.get('Retry-After')).toBe('30'); expect(resolve.resolvePublishedTrustPage).not.toHaveBeenCalled();
  });
  it('hit → header card with summary line and stale flag', async () => {
    const res = await app.request('/trust/card/nw/acme');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ orgName: 'Acme', managedByName: 'NW', stale: false, summaryLine: expect.stringMatching(/9 met/) });
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });
  it('partner-home card resolves without an org slug', async () => {
    const res = await app.request('/trust/card/nw');
    expect(res.status).toBe(200);
    expect(resolve.resolvePublishedTrustPage).toHaveBeenCalledWith('nw', null);
  });
});

describe('payload', () => {
  beforeEach(() => { vi.clearAllMocks(); redis.client = {}; serving.isServing.mockResolvedValue(true); resolve.resolvePublishedTrustPage.mockResolvedValue(RESOLVED); });
  it('unknown / unpublished / untrusted all yield the SAME generic 404', async () => {
    resolve.resolvePublishedTrustPage.mockResolvedValue(null);
    const a = await app.request('/trust/public/nw/acme'); expect(a.status).toBe(404); expect(await a.json()).toEqual(GENERIC);
    serving.isServing.mockResolvedValue(false);
    const b = await app.request('/trust/public/nw/acme'); expect(b.status).toBe(404); expect(await b.json()).toEqual(GENERIC);
  });
  it('Redis unavailable → still serves via the live resolve (rate-limited path)', async () => {
    redis.client = null; serving.isServing.mockResolvedValue(null);
    const res = await app.request('/trust/public/nw/acme');
    expect(res.status).toBe(200); expect(resolve.resolvePublishedTrustPage).toHaveBeenCalled();
  });
  it('serves payload + stale, uses the snapshot cache when present, applies public cache headers', async () => {
    serving.readCachedSnapshotPayload.mockResolvedValueOnce(PAYLOAD as never);
    const res = await app.request('/trust/public/nw/acme');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ payload: { snapshotId: 's1' }, stale: false });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, stale-while-revalidate=600');
  });
  it('stale when last_evaluated_at is older than 24h', async () => {
    resolve.resolvePublishedTrustPage.mockResolvedValue({ ...RESOLVED, lastEvaluatedAt: new Date(Date.now() - 25 * 3600_000) });
    expect((await (await app.request('/trust/public/nw/acme')).json()).data.stale).toBe(true);
  });
  it('a partner restricted between card and payload fetch (Review Focus 5) → 404 from the live resolve', async () => {
    resolve.resolvePublishedTrustPage.mockResolvedValue(null); // predicate now fails
    expect((await app.request('/trust/public/nw/acme')).status).toBe(404);
  });
});

describe('badge, documents, preview', () => {
  beforeEach(() => { vi.clearAllMocks(); redis.client = {}; serving.isServing.mockResolvedValue(true); resolve.resolvePublishedTrustPage.mockResolvedValue(RESOLVED); });
  it('badge is an SVG without counts', async () => {
    const res = await app.request('/trust/public/nw/acme/badge.svg');
    expect(res.headers.get('Content-Type')).toMatch(/image\/svg\+xml/);
    const svg = await res.text();
    expect(svg).toMatch(/verified by Breeze/); expect(svg).not.toMatch(/9|15/);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });
  it('document download refuses an unlinked id and streams a linked one', async () => {
    const miss = await app.request('/trust/public/nw/acme/documents/00000000-0000-4000-8000-000000000000');
    expect(miss.status).toBe(404);
    // Linked: the route checks payload.documents AND re-checks the live link in SQL (dbSelect returns the live row).
    dbSelect.mockReturnValue({ from: () => ({ innerJoin: () => ({ leftJoin: () => ({ where: () => ({ limit: async () => [{ storageBackend: 'db', storageKey: null, data: Buffer.from('pdf'), contentType: 'application/pdf', originalFilename: 'p.pdf', byteSize: 3 }] }) }) }) }) });
    const hit = await app.request('/trust/public/nw/acme/documents/0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6d');
    expect(hit.status).toBe(200);
    expect(hit.headers.get('Content-Disposition')).toMatch(/^attachment/);
    expect(hit.headers.get('Cache-Control')).toBe('no-store');
  });
  it('preview: invalid token → 404; valid → fresh draft payload, no-store', async () => {
    expect((await app.request('/trust/public/preview/bad')).status).toBe(404);
    dbSelect.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ id: 'pg', orgId: 'o', publishedAt: null }] }) }) });
    const res = await app.request('/trust/public/preview/good');
    expect(res.status).toBe(200); expect(res.headers.get('Cache-Control')).toBe('no-store'); expect((await res.json()).data.preview).toBe(true);
  });
});
```

- [ ] **Step 2: Implement `routes/trustPagePublic.ts`**

```ts
// apps/api/src/routes/trustPagePublic.ts
// SECURITY: NO auth middleware. Every DB op runs inside runOutsideDbContext(() => withSystemDbAccessContext(...)).
// Every non-serving case is the same generic 404 (spec trust-center §7, §13): never 410, never "unpublished".
// /trust/card/* is exempt from the global limiter (portal SSR shares one IP) and therefore MUST be DB-free on a
// miss: slug regex → serving-set → only then one indexed query. /trust/public/* sits in the 'trustpublic' bucket.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Readable } from 'node:stream';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { zValidator } from '../lib/validation';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { orgDocuments, trustPageDocuments, trustPages } from '../db/schema';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { getTrustedClientIp, rateLimitIpKey } from '../services/clientIp';
import { getBlobStream, BlobStorageError } from '../services/blobStorage';
import { contentDispositionFor } from '../services/attachmentFilename';
import { isServing, readCachedSnapshotPayload, cacheSnapshotPayload, trustServingMember } from '../services/trustPage/servingSet';
import { parseTrustSlugs, resolvePublishedTrustPage, type ResolvedTrustPage } from '../services/trustPage/resolve';
import { verifyTrustPreviewToken } from '../services/trustPage/previewToken';
import { buildSnapshotForPage } from '../services/trustPage/publication';
import type { TrustPagePublicPayload } from '@breeze/shared';

export const trustPagePublicRoutes = new Hono();
const STALE_AFTER_MS = 24 * 3600_000;
const GENERIC_404 = { error: 'Not found', code: 'NOT_FOUND' } as const;
const slugParams = z.object({ partnerSlug: z.string().max(64), orgSlug: z.string().max(64).optional() });
const docParams = z.object({ partnerSlug: z.string().max(64), orgSlug: z.string().max(64), documentId: z.string().guid() });

const notFound = (c: Context) => c.json(GENERIC_404, 404);
const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const isStale = (lastEvaluatedAt: Date | null) => !lastEvaluatedAt || Date.now() - lastEvaluatedAt.getTime() > STALE_AFTER_MS;
function publicHeaders(c: Context, r: { searchIndexable: boolean }, cache: string) {
  c.header('Cache-Control', cache);
  c.header('X-Robots-Tag', r.searchIndexable ? 'all' : 'noindex');
  c.header('X-Content-Type-Options', 'nosniff');
}

/** Admission + resolve. `requireServingSet` = true for the unlimited card path (503 when Redis is down). */
async function admit(c: Context, partnerSlug: string, orgSlug: string | undefined, requireServingSet: boolean): Promise<ResolvedTrustPage | Response> {
  const slugs = parseTrustSlugs(partnerSlug, orgSlug);
  if (!slugs) return notFound(c);
  const serving = await isServing(trustServingMember(slugs.partnerSlug, slugs.orgSlug ?? undefined));
  if (serving === false) return notFound(c);
  if (serving === null && requireServingSet) {
    c.header('Retry-After', '30');
    return c.json({ error: 'Temporarily unavailable', code: 'SERVICE_UNAVAILABLE' }, 503);
  }
  const resolved = await sys(() => resolvePublishedTrustPage(slugs.partnerSlug, slugs.orgSlug));
  return resolved ?? notFound(c);
}
async function payloadFor(r: ResolvedTrustPage): Promise<TrustPagePublicPayload | null> {
  if (!r.snapshotId) return null;
  const cached = await readCachedSnapshotPayload(r.snapshotId);
  if (cached) return cached;
  if (r.payload) { await cacheSnapshotPayload(r.snapshotId, r.payload); return r.payload; }
  return null;
}

// ---- card (SSR header + OG). Mounted under /trust/card; exempt from the global limiter.
async function card(c: Context, partnerSlug: string, orgSlug?: string) {
  const r = await admit(c, partnerSlug, orgSlug, true);
  if (r instanceof Response) return r;
  const payload = await payloadFor(r);
  if (!payload) return notFound(c);
  publicHeaders(c, r, 'public, max-age=300, stale-while-revalidate=600');
  const s = payload.summary;
  return c.json({ data: {
    title: `${payload.org.name} · Security posture`,
    orgName: payload.org.name, logoUrl: payload.org.logoUrl, primaryColor: payload.org.primaryColor,
    managedByName: payload.managedBy?.name ?? null,
    summaryLine: `Showing ${s.controlsShown} of ${s.catalogTotal} Breeze-verifiable controls · ${s.controlsMet} met`,
    publishedAt: r.publishedAt.toISOString(), lastEvaluatedAt: r.lastEvaluatedAt?.toISOString() ?? null,
    stale: isStale(r.lastEvaluatedAt), searchIndexable: r.searchIndexable,
  } });
}
trustPagePublicRoutes.get('/card/:partnerSlug', zValidator('param', slugParams), (c) => card(c, c.req.valid('param').partnerSlug));
trustPagePublicRoutes.get('/card/:partnerSlug/:orgSlug', zValidator('param', slugParams), (c) => { const p = c.req.valid('param'); return card(c, p.partnerSlug, p.orgSlug); });

// ---- preview (declared before the slug routes so 'preview' is never read as a partner slug)
trustPagePublicRoutes.get('/public/preview/:token', zValidator('param', z.object({ token: z.string().min(10).max(4096) })), async (c) => {
  c.header('Cache-Control', 'no-store'); c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  const claims = await verifyTrustPreviewToken(c.req.valid('param').token);
  if (!claims) return notFound(c);
  const built = await sys(async () => {
    const [page] = await db.select().from(trustPages).where(and(eq(trustPages.id, claims.pageId), eq(trustPages.orgId, claims.orgId))).limit(1);
    if (!page) return null;
    return buildSnapshotForPage(page, { publishedAt: page.publishedAt ?? new Date() });
  });
  if (!built) return notFound(c);
  return c.json({ data: { payload: built.payload, lastEvaluatedAt: null, stale: false, preview: true } });
});

// ---- payload
async function payloadRoute(c: Context, partnerSlug: string, orgSlug?: string) {
  const r = await admit(c, partnerSlug, orgSlug, false);
  if (r instanceof Response) return r;
  const payload = await payloadFor(r);
  if (!payload) return notFound(c);
  publicHeaders(c, r, 'public, max-age=300, stale-while-revalidate=600');
  return c.json({ data: { payload, lastEvaluatedAt: r.lastEvaluatedAt?.toISOString() ?? null, stale: isStale(r.lastEvaluatedAt) } });
}
trustPagePublicRoutes.get('/public/:partnerSlug', zValidator('param', slugParams), (c) => payloadRoute(c, c.req.valid('param').partnerSlug));
trustPagePublicRoutes.get('/public/:partnerSlug/:orgSlug', zValidator('param', slugParams), (c) => { const p = c.req.valid('param'); return payloadRoute(c, p.partnerSlug, p.orgSlug); });

// ---- badge: no counts (spec §8, §18.12)
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
export function renderBadgeSvg(updated: string): string {
  const label = 'Security posture'; const value = `verified by Breeze · updated ${updated}`;
  const lw = 7 * label.length + 20; const vw = 7 * value.length + 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="24" role="img" aria-label="${esc(label)}: ${esc(value)}"><rect width="${lw}" height="24" fill="#334155"/><rect x="${lw}" width="${vw}" height="24" fill="#0f766e"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="10" y="16">${esc(label)}</text><text x="${lw + 10}" y="16">${esc(value)}</text></g></svg>`;
}
trustPagePublicRoutes.get('/public/:partnerSlug/:orgSlug/badge.svg', zValidator('param', slugParams), async (c) => {
  const p = c.req.valid('param');
  const r = await admit(c, p.partnerSlug, p.orgSlug, false);
  if (r instanceof Response) return r;
  const updated = (r.lastEvaluatedAt ?? r.publishedAt).toISOString().slice(0, 10);
  publicHeaders(c, r, 'public, max-age=3600');
  return c.body(renderBadgeSvg(updated), 200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
});

// ---- documents: live link check; stream through the API (no presigned URLs, per routes/orgDocuments.ts)
trustPagePublicRoutes.get('/public/:partnerSlug/:orgSlug/documents/:documentId', zValidator('param', docParams), async (c) => {
  const p = c.req.valid('param');
  // Rate limit BEFORE any db context (#1105 tripwire). Fails closed when Redis is down — downloads are not critical.
  const limit = await rateLimiter(getRedis(), `trust-doc:${rateLimitIpKey(getTrustedClientIp(c, 'unknown'))}`, 20, 60);
  if (!limit.allowed) return c.json({ error: 'Too many requests', code: 'RATE_LIMITED' }, 429);
  const r = await admit(c, p.partnerSlug, p.orgSlug, false);
  if (r instanceof Response) return r;
  const payload = await payloadFor(r);
  if (!payload || !payload.documents.some((d) => d.id === p.documentId)) return notFound(c);
  const successor = alias(orgDocuments, 'successor');
  const row = await sys(async () => (await db.select({
      storageBackend: orgDocuments.storageBackend, storageKey: orgDocuments.storageKey, data: orgDocuments.data,
      contentType: orgDocuments.contentType, originalFilename: orgDocuments.originalFilename, byteSize: orgDocuments.byteSize,
    }).from(trustPageDocuments)
    .innerJoin(orgDocuments, and(eq(orgDocuments.id, trustPageDocuments.documentId), eq(orgDocuments.orgId, trustPageDocuments.orgId)))
    .leftJoin(successor, and(eq(successor.supersedesDocumentId, orgDocuments.id), eq(successor.orgId, orgDocuments.orgId)))
    .where(and(eq(trustPageDocuments.trustPageId, r.pageId), eq(trustPageDocuments.documentId, p.documentId), eq(trustPageDocuments.visibility, 'public'),
      sql`${trustPageDocuments.disclosureConfirmedAt} IS NOT NULL`, isNull(orgDocuments.deletedAt), isNull(successor.id)))
    .limit(1))[0] ?? null);
  if (!row) return notFound(c);   // unlinked since the snapshot, deleted or superseded (Review Focus 4)
  let opened: Awaited<ReturnType<typeof getBlobStream>>;
  try { opened = await getBlobStream({ storageBackend: row.storageBackend, storageKey: row.storageKey, data: row.data }); }
  catch (err) { if (err instanceof BlobStorageError) return c.json({ error: 'Temporarily unavailable', code: 'SERVICE_UNAVAILABLE' }, 503); throw err; }
  if (!opened.body) return notFound(c);
  const headers: Record<string, string> = {
    'Content-Type': row.contentType, 'Content-Disposition': contentDispositionFor(row.contentType, row.originalFilename).replace(/^inline/, 'attachment'),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex',
  };
  const length = opened.contentLength ?? row.byteSize; if (typeof length === 'number') headers['Content-Length'] = String(length);
  if (Buffer.isBuffer(opened.body)) return c.body(new Uint8Array(opened.body), 200, headers);
  return c.body(Readable.toWeb(opened.body) as ReadableStream, 200, headers);
});
```
If `contentDispositionFor` already returns `attachment; ...`, drop the `.replace`. Note on Hono route order: register `/public/preview/:token` before `/public/:partnerSlug/:orgSlug` (as above) so `preview` is never treated as a partner slug.

- [ ] **Step 3: Wire the limiter, guard and mount**

`globalRateLimit.ts`, in `ISOLATED_BUCKETS`:
```ts
  // Public trust pages (spec trust-center §8, §10): unauthenticated by design. Isolated so a scanner
  // enumerating slugs cannot burn the shared budget; 120/min is generous for one human reading a page
  // (payload + badge + a few documents). The SSR card path lives under /trust/card/ and is skip-listed
  // instead, because portal SSR shares one IP — see routes/trustPagePublic.ts for why it is DB-free.
  { prefix: '/api/v1/trust/public/', name: 'trustpublic', limit: 120 },
```
`index.ts` (before the mount): `registerGlobalRateLimitSkipPrefix('/api/v1/trust/card/');` then `api.route('/trust', trustPagePublicRoutes);`. `partnerGuard.ts`: add the two prefixes to `isPartnerGuardExemptPath` ("public GETs must never trigger staff account activation").
Extend `globalRateLimit.test.ts`: a request to `/api/v1/trust/card/nw/acme` after registering the prefix is not counted; `/api/v1/trust/public/nw/acme` uses key `global:trustpublic:<ip>` with limit 120.

- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/routes/trustPagePublic.test.ts src/middleware/globalRateLimit.test.ts src/middleware/partnerGuard.test.ts src/lib/validation.imports.test.ts` → PASS. Typecheck as in Task 10.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/trustPagePublic.ts apps/api/src/routes/trustPagePublic.test.ts apps/api/src/middleware/globalRateLimit.ts apps/api/src/middleware/globalRateLimit.test.ts apps/api/src/middleware/partnerGuard.ts apps/api/src/index.ts
git commit -m "feat(api): public trust page routes — DB-free card, rate-isolated payload/badge/documents, preview; generic 404 everywhere

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Hourly snapshot worker

**Files:**
- Create: `apps/api/src/jobs/trustPageSnapshotWorker.ts`
- Modify: `apps/api/src/jobs/scheduleRegistry.ts` (`'trust-page-snapshot': '11 * * * *'` with a comment: runs 4 minutes after `security-posture-scan` at :07)
- Modify: `apps/api/src/services/workerRegistry.ts` (entry `trustPageSnapshotWorker`, `placement: 'global'`)
- Modify: `apps/api/src/jobs/workerReadinessManifest.ts` (`consumers('trustPageSnapshotWorker')`)
- Test: `apps/api/src/jobs/trustPageSnapshotWorker.test.ts`; run `apps/api/src/jobs/scheduleRegistry.contract.test.ts` and `apps/api/src/__tests__/workerEntrypointClosure.contract.test.ts`

**Interfaces:**
```ts
export async function runTrustPageSnapshotSweepOnce(now?: Date): Promise<{ pages: number; rebuilt: number; failed: number; pruned: number; durationMs: number }>;
export async function initializeTrustPageSnapshotWorker(): Promise<void>;
export async function shutdownTrustPageSnapshotWorker(): Promise<void>;
```
Sweep: (1) select published page ids joined through the live predicate (system context, short-lived); (2) for each, `refreshPublishedPage(pageId)` in its own try/catch (one failure never stops the sweep; `captureException`); (3) `replaceServingSet(members)` computed from the same rows (self-heal); (4) prune `DELETE FROM trust_page_snapshots WHERE NOT is_current AND generated_at < now() - interval '90 days'` (system context, report row count).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/jobs/trustPageSnapshotWorker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
const pub = vi.hoisted(() => ({ refreshPublishedPage: vi.fn() }));
vi.mock('../services/trustPage/publication', () => pub);
const sset = vi.hoisted(() => ({ replaceServingSet: vi.fn(), trustServingMember: (p: string, o?: string) => (o ? `${p}/${o}` : p) }));
vi.mock('../services/trustPage/servingSet', () => sset);
vi.mock('../services/trustPage/resolve', () => ({ livePublicationPredicate: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
const dbm = vi.hoisted(() => ({ rows: [] as unknown[], executeResult: { rowCount: 0 } }));
vi.mock('../db', () => ({
  db: { select: () => ({ from: () => ({ innerJoin: () => ({ innerJoin: () => ({ where: async () => dbm.rows }) }) }) }), execute: async () => dbm.executeResult },
  runOutsideDbContext: (fn: any) => fn(), withSystemDbAccessContext: (fn: any) => fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
import { runTrustPageSnapshotSweepOnce } from './trustPageSnapshotWorker';

describe('trust page snapshot sweep', () => {
  beforeEach(() => { vi.clearAllMocks(); dbm.rows = [{ pageId: 'a', partnerSlug: 'nw', orgSlug: 'acme', isPartnerHome: true }, { pageId: 'b', partnerSlug: 'nw', orgSlug: 'beta', isPartnerHome: false }]; dbm.executeResult = { rowCount: 3 }; });
  it('refreshes every live page, rebuilds the serving set from the same rows, prunes old snapshots', async () => {
    pub.refreshPublishedPage.mockResolvedValueOnce({ rebuilt: true, snapshotId: 's' }).mockResolvedValueOnce({ rebuilt: false, snapshotId: 's2' });
    const out = await runTrustPageSnapshotSweepOnce(new Date('2026-10-13T12:11:00Z'));
    expect(out).toMatchObject({ pages: 2, rebuilt: 1, failed: 0, pruned: 3 });
    expect(sset.replaceServingSet).toHaveBeenCalledWith(expect.arrayContaining(['nw/acme', 'nw', 'nw/beta']));
  });
  it('one page failing does not stop the sweep', async () => {
    pub.refreshPublishedPage.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ rebuilt: false, snapshotId: null });
    const out = await runTrustPageSnapshotSweepOnce();
    expect(out).toMatchObject({ pages: 2, failed: 1 });
    expect(sset.replaceServingSet).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement** (template: `jobs/parkedDeviceExpiry.ts`)

```ts
// apps/api/src/jobs/trustPageSnapshotWorker.ts
import { Queue, Worker } from 'bullmq';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations, partners, trustPages } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { refreshPublishedPage } from '../services/trustPage/publication';
import { replaceServingSet, trustServingMember } from '../services/trustPage/servingSet';
import { livePublicationPredicate } from '../services/trustPage/resolve';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

const LOG_PREFIX = '[TrustPageSnapshot]';
const QUEUE_NAME = 'trust-page-snapshot';
const PRUNE_AFTER_DAYS = 90;
let queue: Queue | null = null;
let worker: Worker | null = null;

export interface TrustPageSweepSummary { pages: number; rebuilt: number; failed: number; pruned: number; durationMs: number }

export async function runTrustPageSnapshotSweepOnce(now: Date = new Date()): Promise<TrustPageSweepSummary> {
  const startedAt = Date.now();
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({ pageId: trustPages.id, partnerSlug: partners.slug, orgSlug: organizations.slug, isPartnerHome: trustPages.isPartnerHome })
      .from(trustPages).innerJoin(organizations, eq(organizations.id, trustPages.orgId)).innerJoin(partners, eq(partners.id, trustPages.partnerId))
      .where(and(isNotNull(trustPages.publishedAt), livePublicationPredicate())),
  )) as Array<{ pageId: string; partnerSlug: string; orgSlug: string; isPartnerHome: boolean }>;
  const summary: TrustPageSweepSummary = { pages: rows.length, rebuilt: 0, failed: 0, pruned: 0, durationMs: 0 };
  for (const r of rows) {
    try { if ((await refreshPublishedPage(r.pageId)).rebuilt) summary.rebuilt += 1; }
    catch (err) { summary.failed += 1; console.error(`${LOG_PREFIX} refresh failed for page ${r.pageId}:`, err); captureException(err); }
  }
  const members = new Set<string>();
  for (const r of rows) { members.add(trustServingMember(r.partnerSlug, r.orgSlug)); if (r.isPartnerHome) members.add(trustServingMember(r.partnerSlug)); }
  await replaceServingSet([...members]);   // self-heal (spec §7)
  try {
    const res = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.execute(sql`DELETE FROM trust_page_snapshots WHERE NOT is_current AND generated_at < ${now.toISOString()}::timestamptz - make_interval(days => ${PRUNE_AFTER_DAYS})`)));
    summary.pruned = Number((res as { rowCount?: number }).rowCount ?? 0);
  } catch (err) { console.error(`${LOG_PREFIX} prune failed:`, err); captureException(err); }
  summary.durationMs = Date.now() - startedAt;
  if (summary.pages > 0 || summary.pruned > 0) console.log(`${LOG_PREFIX} refreshed ${summary.pages} pages (rebuilt=${summary.rebuilt}, failed=${summary.failed}), pruned ${summary.pruned} snapshots in ${summary.durationMs}ms`);
  return summary;
}

export function getTrustPageSnapshotQueue(): Queue {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return queue;
}
export async function initializeTrustPageSnapshotWorker(): Promise<void> {
  worker = new Worker(QUEUE_NAME, () => runTrustPageSnapshotSweepOnce(), { connection: getBullMQConnection(), concurrency: 1, lockDuration: 600_000 });
  attachWorkerObservability(worker, 'trustPageSnapshotWorker');
  worker.on('error', (error) => { console.error(`${LOG_PREFIX} Worker error:`, error); captureException(error); });
  const q = getTrustPageSnapshotQueue();
  for (const job of await q.getRepeatableJobs()) await q.removeRepeatableByKey(job.key);
  await q.add('sweep', {}, { repeat: { pattern: jobSchedule('trust-page-snapshot') }, removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } });
  console.log(`${LOG_PREFIX} worker initialized`);
}
export async function shutdownTrustPageSnapshotWorker(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}
```
Registry entries: `workerRegistry.ts` → `{ name: 'trustPageSnapshotWorker', placement: 'global', load: async () => { const m = await import('../jobs/trustPageSnapshotWorker'); return { init: m.initializeTrustPageSnapshotWorker, shutdown: m.shutdownTrustPageSnapshotWorker }; } }`; `workerReadinessManifest.ts` → `consumers('trustPageSnapshotWorker')` next to `securityPostureWorker`.

- [ ] **Step 3: Run** `cd apps/api && npx vitest run src/jobs/trustPageSnapshotWorker.test.ts src/jobs/scheduleRegistry.contract.test.ts src/__tests__/workerEntrypointClosure.contract.test.ts src/services/workerRegistry.test.ts src/worker.boot.test.ts` → PASS. If the schedule contract test reports a collision for `:11`, pick the lowest free minute it names that is not ≡ 0 (mod 5) and update the registry comment.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/jobs/trustPageSnapshotWorker.ts apps/api/src/jobs/trustPageSnapshotWorker.test.ts apps/api/src/jobs/scheduleRegistry.ts apps/api/src/services/workerRegistry.ts apps/api/src/jobs/workerReadinessManifest.ts
git commit -m "feat(api): hourly trust-page snapshot refresh (hash-deduped, revision-checked), serving-set self-heal, 90-day prune

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**PR A2 ends here.** Before opening it: Task 18's API sweep, then `gh workflow run CI --ref <branch>`.

---

### Task 13: Portal API client, public layout, pages and middleware headers

**Files:**
- Modify: `apps/portal/src/lib/api.ts` (types + three `portalApi` methods)
- Create: `apps/portal/src/layouts/TrustPageLayout.astro`
- Create: `apps/portal/src/pages/trust/[partnerSlug]/index.astro`, `apps/portal/src/pages/trust/[partnerSlug]/[orgSlug].astro`, `apps/portal/src/pages/trust/preview/[token].astro`
- Modify: `apps/portal/src/middleware.ts` (`/trust/` header branch)
- Modify: `apps/portal/src/lib/disabledPageCoverage.test.ts` (`UNAUTHENTICATED_PAGES` + reasons)
- Test: `apps/portal/src/middleware.test.ts` (new cases), `apps/portal/src/lib/api.trust.test.ts`, `apps/portal/src/layouts/TrustPageLayout.test.ts`

**Interfaces:**
```ts
// api.ts additions
export interface TrustCard { title: string; orgName: string; logoUrl: string | null; primaryColor: string | null; managedByName: string | null; summaryLine: string; publishedAt: string; lastEvaluatedAt: string | null; stale: boolean; searchIndexable: boolean }
export interface TrustPageResponse { payload: TrustPagePublicPayload; lastEvaluatedAt: string | null; stale: boolean; preview?: boolean }
portalApi.getTrustCard(partnerSlug: string, orgSlug: string | null, config?: ApiRequestConfig): Promise<ApiResponse<{ data: TrustCard }>>   // GET /trust/card/<p>[/<o>]
portalApi.getTrustPage(partnerSlug: string, orgSlug: string | null, config?): Promise<ApiResponse<{ data: TrustPageResponse }>>            // GET /trust/public/<p>[/<o>]
portalApi.getTrustPreview(token: string, config?): Promise<ApiResponse<{ data: TrustPageResponse }>>                                      // GET /trust/public/preview/<token>
export function trustBadgePath(partnerSlug: string, orgSlug: string): PublicApiPath;   // publicApiPath(`/trust/public/${p}/${o}/badge.svg`)
export function trustDocumentPath(partnerSlug: string, orgSlug: string, documentId: string): PublicApiPath;
```
`TrustPagePublicPayload` comes from `@breeze/shared` (the portal already aliases it in `vitest.config.ts`). All three calls pass `{ redirectOnUnauthorized: false }` (public).

- [ ] **Step 1: API client test + implementation**

```ts
// apps/portal/src/lib/api.trust.test.ts
import { describe, expect, it, vi, afterEach } from 'vitest';
import { portalApi, trustBadgePath, trustDocumentPath } from './api';

describe('trust api paths', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('builds encoded public paths', () => {
    expect(trustBadgePath('nw', 'acme')).toBe('/api/v1/trust/public/nw/acme/badge.svg');
    expect(trustDocumentPath('nw', 'acme', 'd1')).toBe('/api/v1/trust/public/nw/acme/documents/d1');
  });
  it('card and page hit the right endpoints without an auth redirect', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await portalApi.getTrustCard('nw', 'acme');
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/v1\/trust\/card\/nw\/acme$/);
    await portalApi.getTrustPage('nw', null);
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/v1\/trust\/public\/nw$/);
    await portalApi.getTrustPreview('tok');
    expect(fetchMock.mock.calls[2][0]).toMatch(/\/api\/v1\/trust\/public\/preview\/tok$/);
  });
});
```
Implementation in `api.ts` (next to `getPublicInvoice`), using `apiGet` and `publicApiPath`:
```ts
  getTrustCard: async (partnerSlug: string, orgSlug: string | null, config: ApiRequestConfig = {}) =>
    apiGet<{ data: TrustCard }>(`/trust/card/${encodeURIComponent(partnerSlug)}${orgSlug ? `/${encodeURIComponent(orgSlug)}` : ''}`, { redirectOnUnauthorized: false, ...config }),
  getTrustPage: async (partnerSlug: string, orgSlug: string | null, config: ApiRequestConfig = {}) =>
    apiGet<{ data: TrustPageResponse }>(`/trust/public/${encodeURIComponent(partnerSlug)}${orgSlug ? `/${encodeURIComponent(orgSlug)}` : ''}`, { redirectOnUnauthorized: false, ...config }),
  getTrustPreview: async (token: string, config: ApiRequestConfig = {}) =>
    apiGet<{ data: TrustPageResponse }>(`/trust/public/preview/${encodeURIComponent(token)}`, { redirectOnUnauthorized: false, ...config }),
```
```ts
export const trustBadgePath = (p: string, o: string) => publicApiPath(`/trust/public/${encodeURIComponent(p)}/${encodeURIComponent(o)}/badge.svg`);
export const trustDocumentPath = (p: string, o: string, id: string) => publicApiPath(`/trust/public/${encodeURIComponent(p)}/${encodeURIComponent(o)}/documents/${encodeURIComponent(id)}`);
```

- [ ] **Step 2: Layout test, then layout**

```ts
// apps/portal/src/layouts/TrustPageLayout.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const src = readFileSync(fileURLToPath(new URL('./TrustPageLayout.astro', import.meta.url)), 'utf8');
describe('TrustPageLayout', () => {
  it('parameterizes robots, canonical and Open Graph; never hardcodes noindex', () => {
    expect(src).toMatch(/name="robots" content=\{robots\}/);
    expect(src).toMatch(/rel="canonical"/);
    expect(src).toMatch(/property="og:title"/);
    expect(src).toMatch(/property="og:description"/);
    expect(src).not.toMatch(/content="noindex"/);
  });
  it('emits the accent only through the nonced style element and uses withBase for local hrefs', () => {
    expect(src).toMatch(/<style nonce=\{cspNonce\} set:html=\{accentCss\}>/);
    expect(src).not.toMatch(/style="/);
    expect(src).toMatch(/withBase\('\/favicon\.svg'\)/);
  });
});
```
```astro
---
// apps/portal/src/layouts/TrustPageLayout.astro
// Public shell for trust pages (spec trust-center §8). Unlike PublicDocumentLayout
// the metadata is parameterized: title/description/OG for link previews, robots
// from the page's search_indexable flag, canonical for the hosted URL. English
// only in W1 (spec §19.4). Branding comes exclusively from the published subject.
import '../styles/globals.css';
import { ClientRouter } from 'astro:transitions';
import { withBase } from '../lib/basePath';
import { buildDocAccentCss } from '../lib/docAccent';

interface Props {
  title: string;
  description: string;
  canonicalPath: string;          // base-relative, e.g. /trust/nw/acme
  indexable: boolean;
  accent?: string | null;
  imageUrl?: string | null;       // https logo for og:image, optional
}
const { title, description, canonicalPath, indexable, accent, imageUrl } = Astro.props;
const accentCss = buildDocAccentCss(accent);
const cspNonce = Astro.locals.cspNonce;
const robots = indexable ? 'index,follow' : 'noindex,nofollow';
const canonical = new URL(withBase(canonicalPath), Astro.url.origin).toString();
---
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content={robots} />
    <meta name="description" content={description} />
    <link rel="canonical" href={canonical} />
    <meta property="og:type" content="website" />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:url" content={canonical} />
    {imageUrl && imageUrl.startsWith('https://') && <meta property="og:image" content={imageUrl} />}
    <meta name="twitter:card" content="summary" />
    <link rel="icon" type="image/svg+xml" href={withBase('/favicon.svg')} />
    <title>{title}</title>
    {accentCss && <style nonce={cspNonce} set:html={accentCss}></style>}
    <ClientRouter />
  </head>
  <body class="min-h-dvh bg-background antialiased">
    <main class="mx-auto w-full max-w-5xl px-4 py-10 sm:py-14">
      <slot />
    </main>
  </body>
</html>
```

- [ ] **Step 3: Pages** (SSR fetches ONLY the card; the body is a client island — invoice-page precedent)

```astro
---
// apps/portal/src/pages/trust/[partnerSlug]/[orgSlug].astro
// PUBLIC. SSR fetches only the small card (DB-free on a miss; exempt from the IP limiter because
// the portal container's requests share one IP) for <title>/OG/header. The body loads client-side
// from the visitor's own IP (spec trust-center §8 "SSR vs client rendering").
import TrustPageLayout from '../../../layouts/TrustPageLayout.astro';
import TrustPageView from '../../../components/trust/TrustPageView';
import { portalApi } from '../../../lib/api';
import { buildServerApiConfig } from '../../../lib/server';

const { partnerSlug, orgSlug } = Astro.params;
const res = await portalApi.getTrustCard(partnerSlug!, orgSlug!, { ...buildServerApiConfig(Astro.request), timeoutMs: 3000 });
const card = res.data?.data ?? null;
if (!card && res.statusCode === 404) return new Response('Not Found', { status: 404 });
// 503 (Redis blip) or network error: render the generic shell; the island still loads the page.
const title = card?.title ?? 'Security posture';
const description = card ? `${card.summaryLine}. Continuously verified by Breeze RMM telemetry; not a certification.` : 'Security posture page.';
---
<TrustPageLayout title={title} description={description} canonicalPath={`/trust/${partnerSlug}/${orgSlug}`} indexable={card?.searchIndexable ?? false} accent={card?.primaryColor} imageUrl={card?.logoUrl}>
  <TrustPageView partnerSlug={partnerSlug!} orgSlug={orgSlug!} card={card} client:load />
</TrustPageLayout>
```
`trust/[partnerSlug]/index.astro` is identical with `orgSlug = null`, canonical `/trust/${partnerSlug}`, and `<TrustPageView partnerSlug={partnerSlug!} orgSlug={null} card={card} client:load />`.

```astro
---
// apps/portal/src/pages/trust/preview/[token].astro
// Draft preview for the editor (15-minute token). No SSR fetch at all: the token is the capability
// and the payload is rebuilt live; the island fetches it. Always noindex, no-store (middleware).
import TrustPageLayout from '../../../layouts/TrustPageLayout.astro';
import TrustPageView from '../../../components/trust/TrustPageView';
const { token } = Astro.params;
---
<TrustPageLayout title="Trust page preview" description="Unpublished preview." canonicalPath={`/trust/preview/${token}`} indexable={false}>
  <TrustPageView previewToken={token!} partnerSlug={null} orgSlug={null} card={null} client:load />
</TrustPageLayout>
```

- [ ] **Step 4: Middleware header branch** — in `apps/portal/src/middleware.ts`, after the token-page block:
```ts
  // Public trust pages (spec trust-center §8): shareable and cacheable, unlike token pages. The
  // layout owns the robots meta from the page's search_indexable flag; the header mirrors the
  // conservative default so a crawler that ignores meta still gets noindex unless the page opted in
  // (the API sets X-Robots-Tag on the data itself). Previews are drafts: never cached, never indexed.
  if (pathname.startsWith('/trust/preview/')) {
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    headers.set('Referrer-Policy', 'no-referrer');
  } else if (pathname.startsWith('/trust/')) {
    headers.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
  }
```
Add to `middleware.test.ts`:
```ts
it('/trust/<p>/<o> is anonymous and cacheable; previews are no-store/noindex', async () => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  try {
    const page = await run(contextFor('/trust/nw/acme', { signedIn: false }));
    expect(page.status).toBe(200);
    expect(page.headers.get('Cache-Control')).toBe('public, max-age=300, stale-while-revalidate=600');
    expect(page.headers.get('X-Frame-Options')).toBe('DENY');
    expect(fetchMock).not.toHaveBeenCalled();   // middleware itself fetches nothing for public pages
    const preview = await run(contextFor('/trust/preview/abc', { signedIn: false }));
    expect(preview.headers.get('Cache-Control')).toBe('no-store');
    expect(preview.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, noarchive');
  } finally { vi.unstubAllGlobals(); }
});
```

- [ ] **Step 5: Allowlist** — in `disabledPageCoverage.test.ts` add to `UNAUTHENTICATED_PAGES`: `'trust/[partnerSlug]/index.astro'`, `'trust/[partnerSlug]/[orgSlug].astro'`, `'trust/preview/[token].astro'`, with the reason comment: "trust pages are public by design (spec trust-center §8); the preview token is the capability."

- [ ] **Step 6: Run** `cd apps/portal && npx vitest run src/lib/api.trust.test.ts src/layouts/TrustPageLayout.test.ts src/middleware.test.ts src/lib/disabledPageCoverage.test.ts src/lib/basePathCoverage.test.ts src/lib/noInlineStyles.test.ts src/lib/sessionClearCoverage.test.ts` → PASS (Task 14 provides `TrustPageView`; until then create it as a stub that renders `<div data-testid="trust-page-loading" />` so the pages type-check).

- [ ] **Step 7: Commit**

```bash
git add apps/portal/src/lib/api.ts apps/portal/src/lib/api.trust.test.ts apps/portal/src/layouts/TrustPageLayout.astro apps/portal/src/layouts/TrustPageLayout.test.ts apps/portal/src/pages/trust apps/portal/src/middleware.ts apps/portal/src/middleware.test.ts apps/portal/src/lib/disabledPageCoverage.test.ts apps/portal/src/components/trust
git commit -m "feat(portal): public trust pages — SSR card shell with OG/canonical/robots, client-rendered body, preview route

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Portal island `TrustPageView`

**Files:**
- Create: `apps/portal/src/components/trust/TrustPageView.tsx`, `apps/portal/src/components/trust/TrustStatusPill.tsx`, `apps/portal/src/components/trust/trustPageFormat.ts`
- Test: `apps/portal/src/components/trust/TrustPageView.test.tsx` (`// @vitest-environment jsdom`), `apps/portal/src/components/trust/trustPageFormat.test.ts`

**Interfaces:**
```ts
interface TrustPageViewProps { partnerSlug: string | null; orgSlug: string | null; card: TrustCard | null; previewToken?: string; initial?: TrustPageResponse | null /* test seam */ }
export default function TrustPageView(props: TrustPageViewProps): JSX.Element;
// trustPageFormat.ts (pure, unit-tested)
export function groupControlsByCategory(controls: TrustPagePublicControl[]): Array<{ category: TrustControlCategory; label: string; controls: TrustPagePublicControl[] }>;  // TRUST_CONTROL_CATEGORY_ORDER, English labels
export function controlCopy(id: TelemetryControlId): { title: string; description: string };   // from TRUST_CONTROL_CATALOG
export function coverageNote(c: TrustPagePublicControl): string | null;   // "46 of 50 devices assessed" / "48 of 50 users assessed"; null when numbers hidden
export function frameworkChip(ref: FrameworkRef): string;                 // "CIS v8 10.1 · IG1" / "Essential Eight: Multi-factor authentication"
export function relativeTime(iso: string | null, now?: Date): string;     // "2 hours ago" / "never"
export function statusLabel(status: TrustControlStatus): string;          // trustStatusLabel from shared
export const NOT_ASSESSED_REASON_COPY: Record<TrustNotAssessedReason, string>;  // insufficient_telemetry: "Fewer than 80% of eligible devices reported inside the evidence window" …
```

- [ ] **Step 1: Pure helpers test + implementation**

```ts
// apps/portal/src/components/trust/trustPageFormat.test.ts
import { describe, expect, it } from 'vitest';
import { coverageNote, frameworkChip, groupControlsByCategory, relativeTime } from './trustPageFormat';
const ctl = (over: Record<string, unknown>) => ({ id: 'disk_encryption', category: 'data_protection', source: 'telemetry', unit: 'devices', status: 'met', reason: null, percent: null, assessed: null, eligible: null, evidenceAsOf: null, frameworkRefs: [], ...over }) as never;
describe('trustPageFormat', () => {
  it('groups in canonical category order and drops empty categories', () => {
    const g = groupControlsByCategory([ctl({ category: 'monitoring', id: 'dns_filtering' }), ctl({})]);
    expect(g.map((x) => x.category)).toEqual(['data_protection', 'monitoring']);
    expect(g[0].label).toBe('Data protection');
  });
  it('coverage note uses the unit and hides when numbers are not exposed', () => {
    expect(coverageNote(ctl({ assessed: 46, eligible: 50 }))).toBe('46 of 50 devices assessed');
    expect(coverageNote(ctl({ unit: 'users', assessed: 48, eligible: 50 }))).toBe('48 of 50 users assessed');
    expect(coverageNote(ctl({}))).toBeNull();
  });
  it('framework chips', () => {
    expect(frameworkChip({ framework: 'cis_v8', ref: '10.1' })).toBe('CIS v8 10.1 · IG1');
    expect(frameworkChip({ framework: 'essential_eight', ref: 'mfa' })).toBe('Essential Eight: Multi-factor authentication');
  });
  it('relative time', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    expect(relativeTime('2026-10-13T10:00:00Z', now)).toBe('2 hours ago');
    expect(relativeTime(null, now)).toBe('never');
  });
});
```
Implement `trustPageFormat.ts` against `TRUST_CONTROL_CATALOG`, `FRAMEWORK_CROSSWALK`, `FRAMEWORK_META`, `TRUST_CONTROL_CATEGORY_ORDER`, `trustStatusLabel` from `@breeze/shared`; category labels: `endpoint_protection → 'Endpoint protection'`, `patching_hardening → 'Patching & hardening'`, `identity_access → 'Identity & access'`, `data_protection → 'Data protection'`, `monitoring → 'Monitoring'`.

- [ ] **Step 2: Island test**

```tsx
// @vitest-environment jsdom
// apps/portal/src/components/trust/TrustPageView.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import TrustPageView from './TrustPageView';

const payload = {
  schemaVersion: 1, snapshotId: 's1', generatedAt: '2026-10-13T12:00:00.000Z', publishedAt: '2026-10-01T09:00:00.000Z',
  org: { name: 'Acme Dental', logoUrl: null, primaryColor: '#123456', websiteUrl: 'https://acme.example', securityContactEmail: 'security@acme.example' },
  managedBy: { name: 'Northwind IT', logoUrl: null, websiteUrl: 'https://northwind.example' },
  introHtml: '<p>We take <strong>security</strong> seriously.</p>',
  summary: { catalogTotal: 15, controlsShown: 3, controlsMet: 1, deviceCount: 50 },
  methodology: { catalogVersion: '2026-10-13.1', evidenceMaxAgeDays: 30, definitionsMaxAgeDays: 7, coverageFloorPct: 80, thresholds: { met: 95, attention: 80 }, eligibilityNote: 'Eligible devices are…' },
  controls: [
    { id: 'disk_encryption', category: 'data_protection', source: 'telemetry', unit: 'devices', status: 'met', reason: null, percent: 98, assessed: 46, eligible: 50, evidenceAsOf: '2026-10-13T11:00:00.000Z', frameworkRefs: [{ framework: 'cis_v8', ref: '3.6' }] },
    { id: 'host_firewall', category: 'endpoint_protection', source: 'telemetry', unit: 'devices', status: 'not_assessed', reason: 'insufficient_telemetry', percent: null, assessed: null, eligible: null, evidenceAsOf: null, frameworkRefs: [{ framework: 'cis_v8', ref: '4.5' }] },
    { id: 'mfa_registered_m365', category: 'identity_access', source: 'telemetry', unit: 'users', status: 'attention', reason: null, percent: 90, assessed: 48, eligible: 50, evidenceAsOf: '2026-10-13T06:00:00.000Z', frameworkRefs: [{ framework: 'essential_eight', ref: 'mfa' }] },
  ],
  documents: [{ id: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6d', title: 'Security policy', category: 'policy', contentType: 'application/pdf', byteSize: 123456, updatedAt: '2026-09-01T00:00:00.000Z', visibility: 'public' }],
  footer: { poweredByBreeze: true, frameworkAttributions: ['cis_v8', 'essential_eight'] },
} as const;
const initial = { payload, lastEvaluatedAt: '2026-10-13T11:30:00.000Z', stale: false };

describe('TrustPageView', () => {
  it('renders header, summary, grouped controls with pills, coverage notes, chips, method, documents, managed-by and footer', () => {
    render(<TrustPageView partnerSlug="nw" orgSlug="acme" card={null} initial={initial as never} />);
    expect(screen.getByRole('heading', { level: 1, name: /Acme Dental/ })).toBeInTheDocument();
    expect(screen.getByText(/Showing 3 of 15 Breeze-verifiable controls/)).toBeInTheDocument();
    expect(screen.getByText(/publisher-selected/i)).toBeInTheDocument();
    const enc = screen.getByTestId('trust-control-disk_encryption');
    expect(within(enc).getByText('Met')).toBeInTheDocument();
    expect(within(enc).getByText('46 of 50 devices assessed')).toBeInTheDocument();
    expect(within(enc).getByText('CIS v8 3.6 · IG1')).toBeInTheDocument();
    const fw = screen.getByTestId('trust-control-host_firewall');
    expect(within(fw).getByText('Not assessed')).toBeInTheDocument();
    expect(within(fw).getByText(/Fewer than 80%/)).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText(/not a certification/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Security policy/ })).toHaveAttribute('href', '/api/v1/trust/public/nw/acme/documents/0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6d');
    expect(screen.getByText(/Managed by/)).toBeInTheDocument();
    expect(screen.getByText(/Powered by Breeze/)).toBeInTheDocument();
    expect(screen.getByText(/CIS Controls® are a registered trademark/)).toBeInTheDocument();
    expect(screen.getByText(/security@acme.example/)).toBeInTheDocument();
  });
  it('renders the sanitized intro HTML and never a raw script', () => {
    render(<TrustPageView partnerSlug="nw" orgSlug="acme" card={null} initial={{ ...initial, payload: { ...payload, introHtml: '<p>Hi</p>' } } as never} />);
    expect(screen.getByText('Hi')).toBeInTheDocument();
  });
  it('stale → "Verification paused" banner and muted pills', () => {
    render(<TrustPageView partnerSlug="nw" orgSlug="acme" card={null} initial={{ ...initial, stale: true, lastEvaluatedAt: '2026-10-11T00:00:00.000Z' } as never} />);
    expect(screen.getByText(/Verification paused since/)).toBeInTheDocument();
    expect(screen.getByTestId('trust-controls')).toHaveAttribute('data-stale', 'true');
  });
  it('hides the footer badge when unbranded, hides documents section when empty', () => {
    render(<TrustPageView partnerSlug="nw" orgSlug="acme" card={null} initial={{ ...initial, payload: { ...payload, documents: [], footer: { poweredByBreeze: false, frameworkAttributions: [] } } } as never} />);
    expect(screen.queryByText(/Powered by Breeze/)).toBeNull();
    expect(screen.queryByTestId('trust-documents')).toBeNull();
  });
  it('fetches client-side when no initial data, shows the generic error on 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }), { status: 404 })));
    render(<TrustPageView partnerSlug="nw" orgSlug="nope" card={null} />);
    expect(await screen.findByTestId('trust-page-error')).toHaveTextContent(/isn’t available|not available/i);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 3: Implement the island** (Tailwind classes only, no `style=`; `withBase` for any local href; `publicApiPath`-based document/badge hrefs)

```tsx
// apps/portal/src/components/trust/TrustPageView.tsx
import { useEffect, useState } from 'react';
import { portalApi, trustDocumentPath, type TrustCard, type TrustPageResponse } from '@/lib/api';
import { FRAMEWORK_META, type TrustPagePublicControl } from '@breeze/shared';
import { TrustStatusPill } from './TrustStatusPill';
import { coverageNote, controlCopy, frameworkChip, groupControlsByCategory, NOT_ASSESSED_REASON_COPY, relativeTime } from './trustPageFormat';

interface Props { partnerSlug: string | null; orgSlug: string | null; card: TrustCard | null; previewToken?: string; initial?: TrustPageResponse | null }

export default function TrustPageView({ partnerSlug, orgSlug, card, previewToken, initial = null }: Props) {
  const [data, setData] = useState<TrustPageResponse | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(initial == null);

  useEffect(() => {
    if (data || error) return;
    let cancelled = false;
    const req = previewToken ? portalApi.getTrustPreview(previewToken) : portalApi.getTrustPage(partnerSlug!, orgSlug);
    void req.then((res) => {
      if (cancelled) return;
      if (res.data?.data) setData(res.data.data); else setError('');
      setLoading(false);
    }).catch(() => { if (!cancelled) { setError(''); setLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerSlug, orgSlug, previewToken]);

  if (loading) return <div data-testid="trust-page-loading" className="mx-auto max-w-lg p-8 text-center text-sm text-muted-foreground">Loading security posture…</div>;
  if (error != null || !data) {
    return <div data-testid="trust-page-error" className="mx-auto max-w-lg p-8 text-center"><p className="text-sm text-muted-foreground">This page isn’t available. The organization may not have published a trust page, or the link may have changed.</p></div>;
  }
  const { payload, stale, lastEvaluatedAt } = data;
  const groups = groupControlsByCategory(payload.controls);
  const docHref = (id: string) => (partnerSlug && orgSlug ? trustDocumentPath(partnerSlug, orgSlug, id) : undefined);

  return (
    <article className="space-y-8" data-testid="trust-page">
      {data.preview && <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">Preview of the unpublished draft. Expires in 15 minutes.</div>}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          {payload.org.logoUrl && <img src={payload.org.logoUrl} alt="" className="h-12 w-auto max-w-[200px] object-contain" />}
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{payload.org.name} <span className="text-muted-foreground">· Security posture</span></h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Showing {payload.summary.controlsShown} of {payload.summary.catalogTotal} Breeze-verifiable controls (publisher-selected) · {payload.summary.controlsMet} met · last verified {relativeTime(lastEvaluatedAt)}
              {payload.summary.deviceCount != null && <> · {payload.summary.deviceCount} devices</>}
            </p>
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          {payload.org.securityContactEmail && <p><a className="doc-accent-text hover:underline" href={`mailto:${payload.org.securityContactEmail}`}>{payload.org.securityContactEmail}</a></p>}
          {payload.org.websiteUrl && <p><a className="hover:underline" href={payload.org.websiteUrl} rel="noopener noreferrer">{payload.org.websiteUrl.replace(/^https:\/\//, '')}</a></p>}
        </div>
      </header>

      {stale && <div role="status" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">Verification paused since {lastEvaluatedAt ? new Date(lastEvaluatedAt).toLocaleString('en-US') : 'an unknown time'}. Statuses below are the last known values.</div>}

      {payload.introHtml && <section className="quote-rich-text prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: payload.introHtml }} />}

      <section data-testid="trust-controls" data-stale={stale ? 'true' : 'false'} className={stale ? 'space-y-6 opacity-60' : 'space-y-6'}>
        {groups.map((g) => (
          <div key={g.category}>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</h2>
            <ul className="divide-y rounded-lg border bg-card">
              {g.controls.map((c) => <ControlRow key={c.id} control={c} />)}
            </ul>
          </div>
        ))}
      </section>

      <details className="rounded-lg border bg-card p-4 text-sm">
        <summary className="cursor-pointer font-medium">How this page is verified</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>Control catalog version {payload.methodology.catalogVersion}; evaluated from Breeze RMM telemetry. This is an evidence summary, <strong>not a certification</strong>.</li>
          <li>{payload.methodology.eligibilityNote}</li>
          <li>Evidence older than {payload.methodology.evidenceMaxAgeDays} days is not counted; anti-malware definitions older than {payload.methodology.definitionsMaxAgeDays} days count as stale.</li>
          <li>A control is evaluated only when at least {payload.methodology.coverageFloorPct}% of eligible units were assessed; otherwise it reads “Not assessed”.</li>
          <li>Met at ≥ {payload.methodology.thresholds.met}%, needs attention at ≥ {payload.methodology.thresholds.attention}%, otherwise not met.</li>
          <li>Framework references are indicative mappings to safeguard identifiers, never a statement of compliance.</li>
        </ul>
      </details>

      {payload.documents.length > 0 && (
        <section data-testid="trust-documents">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Documents</h2>
          <ul className="divide-y rounded-lg border bg-card">
            {payload.documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <div><a className="font-medium hover:underline" href={docHref(d.id)}>{d.title}</a><p className="text-xs text-muted-foreground">{d.category} · {(d.byteSize / 1024).toFixed(0)} KB · {new Date(d.updatedAt).toLocaleDateString('en-US')}</p></div>
                <a className="text-xs doc-accent-text hover:underline" href={docHref(d.id)}>Download</a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {payload.managedBy && (
        <section className="flex items-center gap-3 rounded-lg border bg-card p-4 text-sm">
          {payload.managedBy.logoUrl && <img src={payload.managedBy.logoUrl} alt="" className="h-8 w-auto max-w-[140px] object-contain" />}
          <p>Managed by <strong>{payload.managedBy.name}</strong>{payload.managedBy.websiteUrl && <> · <a className="hover:underline" href={payload.managedBy.websiteUrl} rel="noopener noreferrer">{payload.managedBy.websiteUrl.replace(/^https:\/\//, '')}</a></>}</p>
        </section>
      )}

      <footer className="space-y-2 text-xs text-muted-foreground">
        {payload.footer.poweredByBreeze && <p>Powered by Breeze RMM · continuously verified telemetry. Not a SOC 2, ISO or CIS attestation.</p>}
        {payload.footer.frameworkAttributions.map((fw) => <p key={fw}>{FRAMEWORK_META[fw].attribution}</p>)}
      </footer>
    </article>
  );
}

function ControlRow({ control }: { control: TrustPagePublicControl }) {
  const copy = controlCopy(control.id);
  const note = coverageNote(control);
  return (
    <li data-testid={`trust-control-${control.id}`} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{copy.title} <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Continuously verified</span></p>
        <p className="text-sm text-muted-foreground">{copy.description}</p>
        {control.status === 'not_assessed' && control.reason && <p className="mt-1 text-xs text-muted-foreground">{NOT_ASSESSED_REASON_COPY[control.reason]}</p>}
        <p className="mt-1 flex flex-wrap gap-1">{control.frameworkRefs.map((r) => <span key={`${r.framework}:${r.ref}`} className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{frameworkChip(r)}</span>)}</p>
      </div>
      <div className="text-right">
        <TrustStatusPill status={control.status} />
        {control.percent != null && <p className="mt-1 text-sm font-medium">{control.percent}%</p>}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
    </li>
  );
}
```
`TrustStatusPill.tsx`: a `<span>` with `inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium` plus the role classes `success: 'border-success/30 bg-success/10 text-success'`, `warning: 'border-warning/40 bg-warning/15 text-warning'`, `danger: 'border-destructive/40 bg-destructive/10 text-destructive'`, `neutral: 'border-border bg-muted text-muted-foreground'` chosen by `trustStatusPillRole(status)`, text `trustStatusLabel(status)`.

- [ ] **Step 4: Run** `cd apps/portal && npx vitest run src/components/trust src/lib/noInlineStyles.test.ts src/lib/basePathCoverage.test.ts && npx astro check` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/portal/src/components/trust
git commit -m "feat(portal): TrustPageView island — grouped controls, pills, coverage notes, framework chips, method block, documents, managed-by, attributions, stale banner

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: Web — typed client, `trust` tab registration, status card and publish/unpublish

**Files:**
- Create: `apps/web/src/lib/api/trustPage.ts`
- Modify: `apps/web/src/components/organizations/record/orgRecordTabs.ts` (`'trust'` after `'documents'`; `TAB_PERMISSION.trust = []` — org read; mutations check `can('organizations','write')` in the component)
- Modify: `apps/web/src/components/organizations/record/OrganizationRecordPage.tsx` (`TAB_ICONS.trust = <ShieldCheck className="h-4 w-4" />`; render `{effectiveTab === 'trust' && <TrustCenterTab orgId={orgId} orgFetch={orgFetch} />}`)
- Modify: `apps/web/src/components/organizations/record/orgRecordTabs.test.ts` (order assertion at L116 gains `'trust'` between `documents` and `activity`; the org-read-only set assertions at L34/L58 gain `'trust'`)
- Modify: `apps/web/src/components/organizations/record/OrganizationRecordPage.test.tsx` (mock `TrustCenterTab`, assert the tab renders for `#trust`)
- Create: `apps/web/src/components/trustCenter/TrustCenterTab.tsx`, `TrustStatusCard.tsx`, `TrustPublishDialog.tsx`, `TrustBadgeSnippet.tsx`, `trustCenterPill.ts`
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS` += `apps/web/src/components/trustCenter/**/*.tsx`)
- Test: `apps/web/src/lib/api/trustPage.test.ts`, `apps/web/src/components/trustCenter/TrustCenterTab.test.tsx`, `TrustPublishDialog.test.tsx`

**Interfaces:**
```ts
// lib/api/trustPage.ts — reads unwrap, mutations return Response (orgDocuments.ts idiom)
export interface TrustPageDraft { id: string; orgId: string; isPartnerHome: boolean; publishedAt: string | null; publicationRevision: number; searchIndexable: boolean; showPercentages: boolean; showDeviceCount: boolean; showManagedBy: boolean; securityContactEmail: string | null; websiteUrl: string | null; introHtml: string | null; hiddenControlIds: TelemetryControlId[]; publicationAuthorizedBy: string | null; publicationAuthorizedAt: string | null; lastEvaluatedAt: string | null }
export interface TrustPageState { page: TrustPageDraft; publicPath: string; badgePath: string; slugs: { partnerSlug: string; orgSlug: string; valid: boolean; problems: string[] }; canPublish: { allowed: boolean; reason: string | null } }
export interface TrustControlsState { assessments: TrustControlAssessment[]; catalog: TrustControlDefinition[]; evaluatedAt: string; deviceCount: number }
export function getTrustPage(f: Fetcher, orgId: string): Promise<TrustPageState>;                       // GET /orgs/:orgId/trust-page
export function getTrustControls(f: Fetcher, orgId: string): Promise<TrustControlsState>;               // GET /orgs/:orgId/trust-page/controls
export function updateTrustPage(f: Fetcher, orgId: string, body: TrustPageUpdateInput): Promise<Response>;                // PUT
export function updateTrustDocuments(f: Fetcher, orgId: string, documents: Array<{ documentId: string; visibility: 'public'; disclosureConfirmed: boolean }>): Promise<Response>; // PUT /documents
export function publishTrustPage(f: Fetcher, orgId: string, body: { expectedRevision: number; authorization?: { authorizedBy: string } }): Promise<Response>;
export function unpublishTrustPage(f: Fetcher, orgId: string): Promise<Response>;
export function setPartnerHome(f: Fetcher, orgId: string, isPartnerHome: boolean): Promise<Response>;
export function createPreviewToken(f: Fetcher, orgId: string): Promise<Response>;                       // POST → { data: { token, previewPath } }
export function trustPublicUrl(publicPath: string): string;                                             // `${window.location.origin}${publicPath}`
```
Components: `TrustCenterTab({ orgId, orgFetch })` loads state + controls (`useLatest`), owns `canWrite = can('organizations','write')`, renders `TrustStatusCard`, then (Task 16) `TrustControlsSection`, `TrustContentSection`, `TrustDocumentsSection`, `TrustBadgeSnippet`. `TrustStatusCard` shows Unpublished/Published date, public URL (copy), Preview (POST token → `window.open(withPortalBase(previewPath))`), Publish/Unpublish buttons (disabled unless `canWrite && slugs.valid && canPublish.allowed`; tooltips explain), partner-home switch (only when `useJwtClaims()` scope is `partner`/`system` and the API accepted — hide on 403), slug warning with a link to org settings, trust-state notice, and the recorded attestation ("Authorized by Jane Doe, COO on …" with Change). `TrustPublishDialog` (built on `Dialog`): first publish of a customer page requires the checkbox "The customer has authorized publication of this page" and the "Authorized by (name, role)" field; later publishes show the recorded attestation and a "Change" link. Submits `publishTrustPage` through `runAction`; `friendly` maps `REVISION_MISMATCH` → "This page changed since you loaded it — reload and try again", `SLUG_INVALID` → the API message, `AUTHORIZATION_REQUIRED` → "Record who authorized publication", `MFA_REQUIRED` → the MFA copy used by `AiKillSwitch`, `TRUST_PROBATION`/`TRUST_RESTRICTED` → "Publishing opens once your account is trusted".

- [ ] **Step 1: Typed client test + implementation** (`apps/web/src/lib/api/trustPage.test.ts` mirrors `orgDocuments.test.ts`: asserts paths/methods/bodies for all 8 functions and that `getTrustPage` unwraps `{ data }`). Implement with `unwrapData` from `./serviceDeliverables`.

- [ ] **Step 2: Tab registration (test first)** — update `orgRecordTabs.test.ts` as listed, run it red, then edit `orgRecordTabs.ts`, `OrganizationRecordPage.tsx`, `OrganizationRecordPage.test.tsx`. Run: `cd apps/web && npx vitest run src/components/organizations/record/orgRecordTabs.test.ts src/components/organizations/record/OrganizationRecordPage.test.tsx` → PASS.

- [ ] **Step 3: Status card + publish dialog tests**

```tsx
// @vitest-environment jsdom
// apps/web/src/components/trustCenter/TrustCenterTab.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/i18n';
const api = vi.hoisted(() => ({ getTrustPage: vi.fn(), getTrustControls: vi.fn(), publishTrustPage: vi.fn(), unpublishTrustPage: vi.fn(), updateTrustPage: vi.fn(), updateTrustDocuments: vi.fn(), setPartnerHome: vi.fn(), createPreviewToken: vi.fn(), trustPublicUrl: (p: string) => `https://breeze.test${p}` }));
vi.mock('@/lib/api/trustPage', () => api);
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ permissions: [], can: () => true }) }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => ({ status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p1' } }) }));
vi.mock('@/lib/api/orgDocuments', () => ({ listOrgDocuments: vi.fn(async () => []) }));
import TrustCenterTab from './TrustCenterTab';

const state = (over: Record<string, unknown> = {}) => ({
  page: { id: 'pg', orgId: 'o1', isPartnerHome: false, publishedAt: null, publicationRevision: 3, searchIndexable: false, showPercentages: false, showDeviceCount: false, showManagedBy: true, securityContactEmail: null, websiteUrl: null, introHtml: null, hiddenControlIds: [], publicationAuthorizedBy: null, publicationAuthorizedAt: null, lastEvaluatedAt: null, ...over },
  publicPath: '/portal/trust/nw/acme', badgePath: '/api/v1/trust/public/nw/acme/badge.svg',
  slugs: { partnerSlug: 'nw', orgSlug: 'acme', valid: true, problems: [] }, canPublish: { allowed: true, reason: null },
});
const controls = { assessments: [], catalog: [], evaluatedAt: new Date().toISOString(), deviceCount: 0 };
const orgFetch = vi.fn() as never;

describe('TrustCenterTab', () => {
  beforeEach(() => { vi.clearAllMocks(); api.getTrustControls.mockResolvedValue(controls); });
  it('shows Unpublished state and the public URL; first publish of a customer page demands the attestation', async () => {
    api.getTrustPage.mockResolvedValue(state());
    api.publishTrustPage.mockResolvedValue(new Response(JSON.stringify({ data: { page: { ...state().page, publishedAt: new Date().toISOString(), publicationRevision: 4 }, snapshotId: 's' } }), { status: 200 }));
    render(<TrustCenterTab orgId="o1" orgFetch={orgFetch} />);
    expect(await screen.findByText(/Unpublished/)).toBeInTheDocument();
    expect(screen.getByText('https://breeze.test/portal/trust/nw/acme')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('trust-publish'));
    const confirm = screen.getByTestId('trust-publish-confirm');
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByTestId('trust-publish-authorized-checkbox'));
    fireEvent.change(screen.getByTestId('trust-publish-authorized-by'), { target: { value: 'Jane Doe, COO' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(api.publishTrustPage).toHaveBeenCalledWith(orgFetch, 'o1', { expectedRevision: 3, authorization: { authorizedBy: 'Jane Doe, COO' } }));
    expect(await screen.findByText(/Published/)).toBeInTheDocument();
  });
  it('disables Publish with an explanation when a slug is invalid or the partner is on probation', async () => {
    api.getTrustPage.mockResolvedValue({ ...state(), slugs: { partnerSlug: 'nw', orgSlug: 'Acme Dental', valid: false, problems: ['org_slug'] } });
    render(<TrustCenterTab orgId="o1" orgFetch={orgFetch} />);
    expect(await screen.findByTestId('trust-publish')).toBeDisabled();
    expect(screen.getByText(/organization slug/i)).toBeInTheDocument();
  });
  it('partner-home page skips the attestation; unpublish asks for confirmation', async () => {
    api.getTrustPage.mockResolvedValue(state({ isPartnerHome: true, publishedAt: '2026-10-01T00:00:00Z' }));
    api.unpublishTrustPage.mockResolvedValue(new Response(JSON.stringify({ data: { page: state().page } }), { status: 200 }));
    render(<TrustCenterTab orgId="o1" orgFetch={orgFetch} />);
    fireEvent.click(await screen.findByTestId('trust-unpublish'));
    fireEvent.click(screen.getByTestId('trust-unpublish-confirm'));
    await waitFor(() => expect(api.unpublishTrustPage).toHaveBeenCalledWith(orgFetch, 'o1'));
  });
});
```

- [ ] **Step 4: Implement** `TrustCenterTab.tsx` (data loading with `useLatest`, `tr` key-prefix helper over `orgRecord.trust.*`, `handleActionError`), `TrustStatusCard.tsx`, `TrustPublishDialog.tsx` (on `Dialog`, `data-testid`s as in the test), `TrustBadgeSnippet.tsx` (read-only `<textarea>` with the `<a href><img src alt></a>` snippet and a copy button). Mutations:
```tsx
await runAction({
  request: () => publishTrustPage(orgFetch, orgId, body),
  parseSuccess: (d) => (d as { data: { page: TrustPageDraft; snapshotId: string } }).data,
  successMessage: tr('publish.success'),
  errorFallback: tr('publish.failed'),
  friendly: (code) => ({ REVISION_MISMATCH: tr('errors.revisionMismatch'), AUTHORIZATION_REQUIRED: tr('errors.authorizationRequired'), MFA_REQUIRED: tr('errors.mfaRequired'), TRUST_PROBATION: tr('errors.trustProbation'), TRUST_RESTRICTED: tr('errors.trustRestricted') } as Record<string, string>)[code],
});
```
Every string goes through `t`; `data-testid`s on every interactive element.

- [ ] **Step 5: Run** `cd apps/web && npx vitest run src/components/trustCenter src/lib/api/trustPage.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/components/organizations/record` → PASS (i18n keys land in Task 17; until then add the `en` keys you use so `keyUsage.test.ts` stays green, and the other 7 locales in Task 17).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/api/trustPage.ts apps/web/src/lib/api/trustPage.test.ts apps/web/src/components/organizations/record apps/web/src/components/trustCenter apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/locales/en/organizations.json
git commit -m "feat(web): Trust Center tab — status card, publish with attestation, unpublish, preview, badge snippet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: Web — controls, content and documents sections

**Files:**
- Create: `apps/web/src/components/trustCenter/TrustControlsSection.tsx`, `TrustContentSection.tsx`, `TrustDocumentsSection.tsx`
- Modify: `apps/web/src/components/trustCenter/TrustCenterTab.tsx` (compose)
- Test: `apps/web/src/components/trustCenter/TrustControlsSection.test.tsx`, `TrustDocumentsSection.test.tsx`

**Behaviour:**
- **Controls**: list the catalog in insurer order grouped by category; each row shows the English title (from the catalog), the live pill (`StatusPill` with `trustStatusPillRole`), percent + "n of m assessed" always visible to the MSP, framework chips, and a Show/Hide switch (role=switch pattern). Toggles for Show percentages / Show device count / Show "Managed by" / Allow search engines. Each change calls `updateTrustPage` via `runAction` (optimistic, revert on error with `handleActionError`), then refreshes state so `publicationRevision` is current. Banner when the page is published: "Changes apply to the public page when you publish again."
- **Content**: `RichTextEditor` for the intro (`value` = `introHtml ?? ''`, 5,000-char soft counter), security contact email, website URL (https only, inline validation); Save button → `updateTrustPage`.
- **Documents**: left list = org library (`listOrgDocuments(orgFetch, orgId, { category: undefined, includeSuperseded: false })`, filtered to `policy, report, evidence` first then others), right list = linked documents in order with ↑/↓ and remove; adding a document opens a confirmation ("I confirm this document is approved for public release") that sets `disclosureConfirmed: true`; a linked document whose library row is now `supersededByDocumentId !== null` or missing shows a "Superseded — relink the newer version" warning. Save → `updateTrustDocuments`; `DOCUMENT_UNAVAILABLE` → friendly message naming the document(s). "Upload a document" links to `#documents`.

- [ ] **Step 1: Tests** — `TrustControlsSection.test.tsx`: renders a pill per assessment, hiding a control calls `updateTrustPage` with the updated `hiddenControlIds`, toggling percentages calls with `{ showPercentages: true }`, and the published banner appears when `publishedAt` is set. `TrustDocumentsSection.test.tsx`: adding a document requires the confirmation checkbox; superseded link shows the warning; Save calls `updateTrustDocuments` with order + `disclosureConfirmed: true`.
- [ ] **Step 2: Implement** the three sections and compose them in `TrustCenterTab` (Content and Documents are visible to read-only users but their inputs are disabled when `!canWrite`).
- [ ] **Step 3: Run** `cd apps/web && npx vitest run src/components/trustCenter src/lib/__tests__/no-silent-mutations.test.ts` → PASS; `npx astro check` or the web typecheck script → PASS.
- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/trustCenter apps/web/src/locales/en/organizations.json
git commit -m "feat(web): Trust Center controls, content and documents sections with disclosure confirmation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 17: i18n (8 locales), docs page, Rule 9 statement

**Files:**
- Modify: `apps/web/src/locales/{en,pt-BR,es-419,fr-FR,fr-CA,de-DE,it-IT,tr-TR}/organizations.json` — `orgRecord.tabs.trust` and the `orgRecord.trust.*` block (status, publish dialog, errors, controls, content, documents, badge, partner-home, slug warnings, trust notice)
- Create: `apps/docs/src/content/docs/security/trust-center.mdx`
- Modify: `apps/docs` sidebar/index as the docs app requires (follow `security/overview.mdx`'s registration)
- PR template checkbox (Rule 9) text goes in the PR body, not a file

- [ ] **Step 1: Keys** — write `en` first (every key the components use; `keyUsage.test.ts` fails on unresolved literal keys), then the seven translations. Real translations, not English copies: `translationCoverage.test.ts` caps English-identical values per namespace. PR body carries the two required lines: `pt-BR strings are machine-drafted pending native review` and `es-419, fr-FR, fr-CA, de-DE, and it-IT strings are machine-drafted pending native review`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts` → PASS.
- [ ] **Step 3: Docs page** — `trust-center.mdx`: what the page shows, what it never shows (device detail, score), how controls are evaluated (link the method block semantics), who can publish (trusted partners; MFA), the customer-authorization attestation, framework references are indicative and the CIS attribution, the badge, and a **Self-hosting** section: "Nothing to configure. Trust pages are served under `/portal/trust/...`, which your existing reverse-proxy rule for `/portal` already covers. Set `PARTNER_TRUST_MODE` only on hosted installs; self-hosted installs skip the trust gate."
- [ ] **Step 4: Settings Rule 9 statement** (for the PR body): *Setting home:* Organization record → Trust Center tab. *Level:* org only (one page per org; partner-home is a per-partner pointer). *Resolver:* none inherited; `trust_page_unbranded` is an operator-only partner flag set via `PATCH /orgs/partners/:id`. *Count of places configured before/after:* 0 → 1 (plus the operator flag: 0 → 1).
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/locales apps/docs/src/content/docs/security/trust-center.mdx apps/docs
git commit -m "feat(trust-center): editor i18n in all 8 locales and documentation (incl. self-hosting note)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 18: Verification sweep and E2E

**Files:**
- Create: `e2e-tests/tests/trust-center.spec.ts`
- No other code changes expected; fix what the sweep finds.

- [ ] **Step 1: API** — `pnpm --filter @breeze/api test` (full unit), then with the test stack up: `pnpm --filter @breeze/api test:integration` for the trust, cascade, merge, export, report integration suites listed in Tasks 4, 5 and 9, `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`, `pnpm --filter @breeze/api db:check-drift`. Typecheck with the 12 GB heap and check the exit code.
- [ ] **Step 2: Shared / portal / web** — `cd packages/shared && npx vitest run && npx tsc --noEmit`; `cd apps/portal && npx vitest run && npx astro check`; `cd apps/web && npx vitest run` (full; `orgMerge.test.ts`-style "full suite only" traps exist on the web side too) and the web typecheck.
- [ ] **Step 3: E2E** (worktree stack; seed has no posture data, so assert structure, not green pills):

```ts
// e2e-tests/tests/trust-center.spec.ts
import { test, expect } from '@playwright/test';
import { waitForHydration } from '../pages/hydration';
// Sign in as the seeded partner admin (reuse the login helper the portal-visibility spec uses), open the seeded org record.
test('publish → public page renders → unpublish → 404', async ({ page, browser }) => {
  await loginAsSeededPartnerAdmin(page);
  await page.goto(`/organizations/${SEEDED_ORG_ID}#trust`);
  await page.getByTestId('trust-publish').click();
  await page.getByTestId('trust-publish-authorized-checkbox').check();
  await page.getByTestId('trust-publish-authorized-by').fill('E2E Approver, CTO');
  await page.getByTestId('trust-publish-confirm').click();
  await expect(page.getByText(/Published/)).toBeVisible();
  const publicUrl = await page.getByTestId('trust-public-url').textContent();

  const anon = await browser.newContext();
  const pub = await anon.newPage();
  await pub.goto(publicUrl!);
  await expect(pub).toHaveTitle(/Security posture/);
  await expect(pub.locator('meta[property="og:title"]')).toHaveCount(1);
  await waitForHydration(pub, 'trust-page');
  await expect(pub.getByText(/Breeze-verifiable controls/)).toBeVisible();
  await expect(pub.getByText('Not assessed').first()).toBeVisible();      // seed has no telemetry
  await expect(pub.getByText(/not a certification/i)).toBeVisible();
  await anon.close();

  await page.getByTestId('trust-unpublish').click();
  await page.getByTestId('trust-unpublish-confirm').click();
  const anon2 = await browser.newContext();
  const gone = await anon2.newPage();
  const res = await gone.goto(publicUrl!);
  expect(res?.status()).toBe(404);
  await anon2.close();
});
```
Run: `cd e2e-tests && npx playwright test tests/trust-center.spec.ts` against the worktree stack (`pnpm wt-stack up`; tear down after and say so).
- [ ] **Step 4: Review gates** — one independent review round per PR (`requesting-code-review`), none more unless a fix touches tenancy/auth again (Todd's rigor rule). Verify every subagent claim: commit exists on the right branch, tests actually ran (paste the summary line).
- [ ] **Step 5: Stacks** — `pnpm test-stack down`, `pnpm wt-stack down`; report what is left running (nothing).

---

## Self-review notes (plan author, 2026-10-13)

- **Spec coverage:** §4 anatomy → Task 14; §5.1–5.5 → Tasks 1, 2, 5, 6; §6 → Tasks 3, 7; §7 → Tasks 8, 9, 12; §8 → Tasks 11, 13, 14; §9 → Task 4 (+ merge executor), §9 trust/entitlement → Tasks 9, 10; §10 → Tasks 10, 11; §11 → Tasks 15, 16; §12 → Tasks 7, 10, 11, 16; §13 → Tasks 3, 7, 8, 11; §14 W1 list → all; §15 testing → every task; §18.9 attestation → Tasks 4, 9, 10, 15. Not in W1 by spec: declared controls, gated documents, framework view, portal i18n, embed, signed payload.
- **Type consistency:** `ControlEvidence{eligible, assessed, passing, aggregatePct, newestEvidenceAt, gate?}` used identically in Tasks 1, 2, 5, 6, 7; `TrustControlAssessment` fields match Tasks 2, 3, 7, 10, 15; `TrustPagePublicPayload` from Task 3 is what Tasks 7, 11, 13, 14 consume; `TrustPageError(status, code)` from Task 9 is mapped in Task 10; serving-set function names match between Tasks 8, 9, 11, 12.
- **Review Focus → tests:** 1 (Task 8 `parseTrustSlugs`), 2 (Task 7 zero devices), 3 (Task 9 integration race), 4 (Task 11 document route + Task 7 filtering), 5 (Task 11 payload after restriction).
- **Known open edges handed to the executor explicitly:** Drizzle `.for('update')` / `selectDistinct` availability (fallbacks given); `CUSTOM_WOULD_DROP_COUNTS` exact value shape (read two neighbours); `scheduleRegistry` minute collision (contract test decides); `contentDispositionFor` prefix; PDF renderer footnote for the two new unknown counts (grep `encryptionUnknownCount`).

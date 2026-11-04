---
title: Safeguard ledger — per-customer framework assessment (NIST CSF 2.0, ISO/IEC 27001:2022 Annex A, loadable CIS Controls)
tracking_issue: LanternOps/breeze#11020
status: draft 2026-11-04 (spec-drafted; awaiting approval)
area: reports — see "Why this folder" below
related: specs/trust-center/2026-10-12-trust-center-design.md (catalog, crosswalk, declarations, evidence loader), specs/reports/2026-06-29-security-compliance-posture-report.md, #5784 (managed evidence), #5573 (service deliverables), epic #2135 (partner-wide first)
reviewed_by: advisor quorum — codex gpt-6-astra xhigh (read-only), 2026-11-04; adopted changes and open disagreements in §7 "Quorum record"
---

# Safeguard ledger: design

**Why this folder.** The issue is labelled security and reporting. The code it builds on points at `reports`: the evidence it reuses is the posture-report loader (`apps/api/src/services/postureEvidence.ts`, specced under `specs/reports/`), and the customer deliverable is a new report type run by the reports subsystem (`reportGenerationService.ts`, `reportScheduleWorker.ts`). `security-auth` covers authentication, identity, and security reviews of Breeze itself, which this feature is not. (`specs/trust-center/` would also fit; it was not one of the two options.)

**Naming.** "Compliance" already means three different things in the codebase: the `compliance` config-policy feature type (`config_policy_compliance_rules`), `software_compliance_status`, and `patch_compliance_snapshots`. It is also the name of the old `compliance` report type and an `aiToolsCompliance.ts` file. This feature is called the **safeguard ledger**. Its tables use the `safeguard_` / `framework_` prefixes and its AI tool file is `aiToolsSafeguardLedger.ts`. The UI label is "Compliance frameworks".

## 1. Problem

An MSP that sells compliance needs one ledger per customer. Each line in it is a framework safeguard (a NIST CSF subcategory, an ISO 27001 Annex A control or a CIS safeguard), and each line records:

- who is responsible: the MSP, the customer, both, or a third party;
- whether the safeguard applies, with a reason when it does not (an ISO Statement of Applicability needs one);
- its current status, measured by Breeze where Breeze has a signal and attested by a named person where it does not;
- evidence;
- a plan of action for each gap, with an owner and a due date.

Competitors show this as one compliance screen with a percentage per framework. A design-partner MSP asked for it on a 2026-11-04 feedback call.

Breeze already has most of the inputs. They are scattered across features and none of them is organised per framework safeguard:

| Have | Where | Gap for this feature |
|---|---|---|
| 16 measured controls with honest denominators (eligible / assessed / passing, coverage floor, evidence age) | `packages/shared/src/trustCenter/controlCatalog.ts`, `evaluate.ts`; loader `apps/api/src/services/postureEvidence.ts` (`loadPostureEvidence`), `postureEvidenceNetNew.ts`, `services/trustPage/trustOnlyEvidence.ts` | Controls are Breeze's own. They are not safeguards and are not per framework. |
| Framework crosswalk (CIS v8, Essential Eight, Cyber Essentials, NIST CSF 2.0) | `packages/shared/src/trustCenter/frameworkCrosswalk.ts`, `frameworkCoverage.ts`, `benchmarkSafeguards.ts` | It covers only the safeguards a trust control references. It is hard-coded TypeScript. It has no ISO 27001. CIS is behind `BREEZE_TRUST_CIS_FRAMEWORK_VIEW`. |
| Declared (attested) controls with a 365-day expiry | `trust_page_declarations` (`apps/api/src/db/schema/trustPages.ts`), `declaredCatalog.ts`, `services/trustPage/declarations.ts` | There are 8 fixed items. They are scoped to a public trust page and have no responsibility, applicability or plan of action. |
| Recurring MSP evidence (documents, report runs, signed agreements per period) | `service_deliverables`, `service_deliverable_occurrences`, `service_deliverable_evidence` (`schema/serviceDeliverables.ts`), `jobs/deliverableWorker.ts`, `services/deliverableAutoEvidence.ts` | Not tied to any safeguard. |
| Org document library, tickets, org contacts with roles | `org_documents`, `tickets`, `contacts` (`services/contacts/types.ts` `CONTACT_ROLES`) | Nothing links them to safeguards. |
| CIS *Benchmark* hardening scans | `cis_baselines`, `cis_baseline_results`, `cis_check_catalog` (`schema/cisHardening.ts`) | This is device configuration benchmarking, not the CIS *Controls* framework. It feeds one signal. |
| A "Policy set: ISO 27001" option | `apps/web/src/components/reports/ReportBuilder.tsx:451` (legacy `compliance` report builder) | It is a cosmetic option with no catalog behind it. W5 removes or redirects it so it stops implying ISO support that does not exist. |

## 2. Users and scope

- **Partner scope (MSP staff).** Partner staff enable frameworks for all customers or for chosen ones, set the default responsibility and applicability matrix, work each customer's ledger, attest safeguards, attach evidence, run plans of action, and generate the customer report. They also get a cross-customer overview with the percentage per framework per customer and overdue actions.
- **Org scope (an org-scoped Breeze user, such as a co-managed customer IT admin).** Same ledger operations for their own org, with the same permission gates. They cannot change partner defaults.
- **Site-restricted authority.** Refused, not filtered. Measured statuses are org-wide aggregates, so showing them to a site-restricted technician would widen their view. This is the same rule as the identity-access report (`services/identityAccessReport.ts`, rule 1) and the trust page (§5.3 of its spec).
- **Customer portal users.** W6 gives them a read-only view behind a sensitive portal flag, and later lets them attest the rows their own organisation is responsible for (§4.7).
- **Not in scope:** auditors logging in, and any external sharing beyond the existing report delivery and the Trust Center.

The ledger never says "compliant", "certified" or "meets". This follows the trust-center rule (§5.5 there) and the posture report non-goal. The report and UI show counts and percentages of applicable safeguards with their evidence basis, plus the sentence "Evidence summary; not a certification or attestation of compliance."

## 3. Licensing constraint (binding on the design)

**The CIS Controls catalog content is licensed, and that licence is being evaluated separately.** The vendor's terms may also restrict *assessment against* the Controls in the self-hosted open-source distribution. So:

1. **The framework catalog is pluggable and loadable** (§4.1). No framework is special-cased in code. Ledger rows key on `(framework_id, safeguard_ref)` strings that a loaded pack defines.
2. **Shipped default:** NIST CSF 2.0 (a US Government work in the public domain, full text allowed) and the ISO/IEC 27001:2022 Annex A *structure*: the 93 control identifiers in their four themes, with Breeze-written short paraphrases and no ISO text, because ISO text is copyrighted (Open Decision 3). **No CIS Controls pack is bundled**, not even identifiers only, and no CIS safeguard text appears in the repository.
3. **A CIS pack, if licensed, is loaded at runtime** from an operator-supplied pack directory (§4.1, source b) on deployments that hold the licence. A test asserts that no bundled pack has a `frameworkId` beginning `cis` or a `publisher`, `sourceUrl` or `attribution` naming CIS. An id check cannot catch CIS text filed under another id (review), so the release checklist adds a packaging review of bundled packs, test fixtures and generated assets (§8).
4. The existing trust-center CIS identifiers and chips (`frameworkCrosswalk.ts`, `BREEZE_TRUST_CIS_FRAMEWORK_VIEW`) are **unchanged**. That surface already went through the identifier-referencing review, and this spec does not widen it.
5. If a pack disappears (licence lapsed, pack removed), its enrollments show "Framework pack unavailable" and its ledger rows are **kept read-only, never deleted**. A re-loaded pack resumes them.

## 4. Proposed design

### 4.1 Framework packs (pluggable catalog)

A **pack** is a versioned JSON document validated by one Zod schema, `frameworkPackSchema`, in `packages/shared/src/safeguards/packSchema.ts`:

```ts
{
  schemaVersion: 1,
  frameworkId: 'nist_csf_2' | 'iso_27001_2022' | string,   // open string: packs are pluggable
  frameworkVersion: string,                               // '2.0', '2022'
  packVersion: string,                                    // '2026-11-04.1' — bump on any semantic change
  name: string, shortName: string, publisher: string, sourceUrl: string,
  license: {
    summary: string,                                      // e.g. 'US Government work, public domain'
    textPolicy: 'verbatim' | 'paraphrase' | 'identifiers_only',
    // Per-surface permission (review): a pack's own claim is not a licence, so each surface is opted into
    // explicitly and the renderer for that surface checks it. Text not permitted on a surface renders as
    // the bare ref.
    surfaces: Array<'console' | 'report_pdf' | 'report_export' | 'portal'>,
    attribution: string,                                  // printed in every report footer that cites the pack
  },
  tiers?: Array<{ id: string; label: string }>,           // e.g. CIS IG1–3; NIST has none
  groups: Array<{ ref: string; label: string; parentRef?: string }>,   // NIST function/category, ISO theme
  safeguards: Array<{
    ref: string; groupRef: string; title: string; description?: string;
    tier?: string;                                        // lowest tier the safeguard belongs to
    // coverage defaults to 'partial'; 'full' requires a reviewed scopeJustification (review)
    signals?: Array<{ signalId: SafeguardSignalId; coverage?: 'full' | 'partial'; scopeJustification?: string; note?: string }>,
    mappings?: Array<{ frameworkId: string; ref: string; relationship: 'equivalent' | 'subset' | 'superset' | 'intersects' }>,
  }>,
  renamedRefs?: Record<string, string>,                   // packVersion upgrade map (old ref → new ref)
}
```

The relationship vocabulary follows NIST OLIR. Breeze authors the mappings and labels them "indicative".

**Pack sources** (`apps/api/src/services/safeguards/packRegistry.ts`):

- **(a) Bundled**: `packages/shared/src/safeguards/packs/nist-csf-2.json` (106 subcategories) and `iso-27001-2022-annex-a.json` (93 controls, `textPolicy: 'paraphrase'`). They are shared with web and portal so the UI renders without a round trip.
- **(b) Operator directory**: `BREEZE_SAFEGUARD_PACK_DIR`, read once at boot by the API **and** the workers. Each file is validated, checksummed and logged. An invalid pack fails closed: it is skipped with an error log and never half-loaded. This is how a licensed CIS pack, or any pack that cannot sit in a public AGPL repository, reaches a deployment. The loader does not enforce any licence term on its own. A restriction such as "hosted only" is enforced by not distributing the pack to deployments that may not use it.
- **Authoritative registry (review).** Packs are keyed by `(frameworkId, packVersion, sha256)`. If two packs claim the same `(frameworkId, packVersion)` with different content, both are rejected. Older versions stay loadable while any enrollment pins them. API and workers must report the same manifest set: each logs it at boot, and `/safeguards/frameworks` exposes the checksum. Web and portal get pack content from the versioned `GET /safeguards/frameworks/:frameworkId/:packVersion`, not by importing JSON, so an operator pack renders exactly like a bundled one. The bundled JSON in `packages/shared` is just one source the registry loads.
- **(c) Later: partner-imported custom packs** for MSP-specific frameworks such as cyber-insurance questionnaires, regional regulations or a sector checklist. These would be stored in a partner-axis table. Open Decision 2 covers it; it is out of W1–W6.
- **OSCAL import**: `pnpm safeguards:import-oscal <catalog.json>` converts an OSCAL catalog into a pack skeleton (groups and controls). Signals and mappings are added by hand. Publisher feeds exist in OSCAL, and licensed vendor feeds are commonly offered in OSCAL. The importer is the bridge that keeps licensed text out of the repository.

**Pinning and upgrades.** An enrollment pins `pack_version`. An upgrade is an explicit per-enrollment action. In one transaction it applies `renamedRefs` to ledger entries, responsibility rows (partner and org) and evidence links, re-pins the enrollment, and records an audit event. Inherited org enrollments follow their partner row. Past attestations keep the `pack_sha256` they were made under (§4.5) and are never rewritten. Rows whose ref no longer exists are flagged `orphaned`, never deleted.

**Consistency with the trust crosswalk.** The trust crosswalk stays the trust page's source. A contract test (§7) asserts agreement: every trust telemetry control that carries a `nist_csf_2` ref R in `controlCatalog.ts` has R list that control's signal in the NIST pack. Collapsing the two into one source is Open Decision 9.

### 4.2 Signals (what Breeze can measure)

`SafeguardSignalId` is a closed, code-defined union in `packages/shared/src/safeguards/signals.ts`. It is a **superset of `TelemetryControlId`**: every trust-center telemetry control is a signal with the same id. Each signal returns `ControlEvidence` (counts, not percentages) and is evaluated with `DEFAULT_TRUST_EVALUATION_POLICY` (`packages/shared/src/trustCenter/evaluate.ts`): coverage floor 80%, met ≥ 95, attention ≥ 80, evidence ≤ 30 days.

**The evaluator is not generic today (review).** `TrustControlDefinition`, `PostureControlEvidence` and `evaluateTrustControls` are closed over `TelemetryControlId` (`trustCenter/types.ts:40`). W1 therefore extracts a generic `evaluateSignal(metric, evidence, policy, asOf)` and keeps `evaluateTrustControls` as a thin adapter over it. The trust evaluate tests must pass unchanged.

**Parity is conditional.** The ledger and the trust page agree only when evidence, evaluation time and policy are the same. The trust build passes an EDR-visibility callback to the loader (`services/trustPage/publication.ts:118`), and the worker must pass the same one. Evaluation times differ (daily ledger snapshot versus page refresh), so the UI never states that the two views match. A shared-fixture test pins identical outputs for identical inputs.

**New windows** (vulnerability SLA age, inventory freshness, clock tolerance, dormant-account window) live in one versioned, code-defined `SAFEGUARD_SIGNAL_POLICY` (`signals.ts`). It reuses the trust and posture defaults where they exist and is stamped into each snapshot. None of them becomes a setting in v1.

Indicative mapping. Refs are confirmed against the publications at plan time. The CIS column is identifiers only and renders only when a CIS pack is loaded.

| Signal | Source (existing unless marked new) | NIST CSF 2.0 | ISO 27001:2022 Annex A | CIS v8 (loaded pack only) |
|---|---|---|---|---|
| `continuous_monitoring` | `loadPostureEvidence` (device check-in ≤ 24 h) | DE.CM-09 | A.8.16 | 1.1, 8.2 |
| `asset_inventory_coverage` **(new)** | `discovered_assets.linked_device_id` vs managed `devices` (`schema/discovery.ts`) | ID.AM-01 | A.5.9 | 1.1, 1.2 |
| `software_inventory_current` **(new)** | device software inventory freshness (`routes/softwareInventory.ts` source tables) | ID.AM-02 | A.5.9 | 2.1 |
| `unauthorized_software_controlled` **(new)** | `software_policies` + `software_compliance_status` (`schema/softwarePolicies.ts`) | PR.PS-05 | A.8.19 | 2.3, 2.5 |
| `os_patch_currency` | `loadPostureEvidence` (`device_patches`) | PR.PS-02 | A.8.8 | 7.3 |
| `vulnerability_remediation_sla` **(new)** | open critical/high `device_vulnerabilities` older than the SLA window. **New age-aware query**: `loadOpenVulnerabilityCounts` (`securityComplianceReportVulnerabilities.ts:125`) counts open findings and takes no age input | ID.RA-01 | A.8.8 | 7.1, 7.2 |
| `hardening_baseline` | `cis_baseline_results` via `loadPostureEvidence` (CIS *Benchmarks*) | PR.PS-01 | A.8.9 | 4.1 |
| `host_firewall` | `loadPostureEvidence` (`security_status`) | PR.IR-01 | A.8.20 | 4.4, 4.5 |
| `endpoint_protection`, `definitions_current` | `loadPostureEvidence` | DE.CM-09 | A.8.7 | 10.1, 10.2 |
| `edr_coverage` | `loadPostureEvidence` + `securityComplianceReportEdr.ts` | DE.CM-09 | A.8.7, A.8.16 | 10.7, 13.2 |
| `disk_encryption` | `loadPostureEvidence` | PR.DS-01 | A.8.24, A.8.1 | 3.6 |
| `recovery_key_escrowed` **(new)** | `device_recovery_keys` (`schema/recoveryKeys.ts`) for encrypted devices | PR.DS-01 (partial) | A.8.24 (partial) | 3.6 (partial) |
| `backups_verified` | `postureEvidenceNetNew.ts` `loadBackupsVerifiedEvidence` | PR.DS-11 | A.8.13 | 11.2, 11.3 |
| `mfa_enforced_m365` | `services/trustPage/trustOnlyEvidence.ts` (`m365_ca_policies`) | PR.AA-03 | A.8.5 | 6.3, 6.4, 6.5 |
| `mfa_registered_m365` | `loadM365MfaEvidence` (`m365_posture_rollups`) | PR.AA-03 (partial) | A.8.5 (partial) | 6.3 (partial) |
| `stale_accounts_m365` **(new)** | `m365_users` last *successful* sign-in (what the sync stores, `apps/m365-graph-read-executor/src/microsoft/syncActions.ts:349`) vs the dormant window (`schema/m365Sync.ts`; honesty rules of `identityAccessReport.ts`: NULL = unknown) | PR.AA-01 | A.5.18 | 5.3 |
| `identity_provider` | `loadPostureEvidence` | PR.AA-01 | A.5.16 | 5.6, 6.7 |
| `password_policy` | `loadPostureEvidence` | PR.AA-01 | A.5.17 | 5.2 |
| `least_privilege`, `privileged_access` | `loadPostureEvidence` (local admins, PAM rules, step-up) | PR.AA-05 | A.8.2 | 5.4, 6.8 |
| `dns_filtering` | `loadPostureEvidence` (`dns_filter_integrations`) | PR.IR-01 (partial) | A.8.23 | 9.2 |
| `removable_media_controlled` **(new)** | active `peripheral_policies` coverage (`schema/peripheralControl.ts`) | PR.PS-01 (partial) | A.7.10 | 10.3 |
| `clock_sync` **(new)** | `device_time_status` (`schema/timeSync.ts`) | — | A.8.17 | 8.4 |
| `event_logs_collected` **(new)** | devices with `device_event_logs` inside the window (`schema/eventLogs.ts`) | PR.PS-04 | A.8.15 | 8.2 |

**User risk, stated plainly.** `user_risk_scores` (`schema/userRisk.ts`, `services/userRiskScoring.ts`) scores **Breeze console accounts** (`organization_users` → `users`), not the customer's workforce. Using it as evidence for workforce identity safeguards would overclaim. It feeds no signal in W1–W6. Workforce identity comes from the M365 signals above. A future `console_access_reviewed` signal from `access_reviews` could evidence access control over Breeze itself (Open Decision 11).

**Fleet findings** (`fleet_findings`: metric anomalies, log correlations, reliability) are operational hygiene, not safeguard evidence, and map to nothing. Their remediation stays in the feature that owns it.

Safeguards with no signal (governance, HR, physical, supplier, incident process) are attestation-only. The ledger shows them as such. There is no grey "unknown" that looks like a failure.

### 4.3 Status model (pure, shared)

The status model lives in `packages/shared/src/safeguards/effectiveStatus.ts` and runs the same way on API, web, portal and report.

- **Applicability:** `applicable` | `not_applicable` (justification required, ≤ 1,000 chars). Inherited from the matrix (§4.4).
- **Measured** (rows with signals only): the trust statuses `met | attention | not_met | not_assessed (+reason)`, one per signal, combined by the worst status. `not_assessed` beats `met` when any signal is unmeasured, so the row is never optimistic.
- **Measured freshness (review).** A snapshot is valid for reads only within `SNAPSHOT_MAX_AGE` (48 h), and only when its `pack_sha256`, signal-policy version and scope match the current enrollment. Anything else reads as `not_assessed / stale_measurement`, never as the last green value. This is the same idea as the trust page's "Verification paused".
- **Attested:** `implemented | partially_implemented | planned | not_implemented`, plus `attested_by`, `attested_at` and `expires_at` (365 days, the same as `TRUST_DECLARATION_TTL_DAYS`). An expired attestation reads as `not_attested`.
- **Effective status** (`implemented | partial | gap | not_assessed | not_applicable`):
  - **Mappings default to `partial`** (review). Breeze's coverage rule can return `met` for 76 passing / 80 assessed / 100 eligible, and `backups_verified` sees only devices with Breeze backup jobs. A signal therefore rarely proves a whole framework control. `full` needs a reviewed `scopeJustification` in the pack, and the pack test fails a `full` mapping that lacks one.
  - A `partial` signal **vetoes, never vouches**. The attestation decides, but a measured `not_met` or `attention` caps the effective status at `partial`.
  - A `full` signal **vouches and vetoes**. `met` gives implemented, `attention` gives partial, `not_met` gives gap. `not_assessed` falls back to the attestation, flagged "measurement unavailable".
  - **Mixed signals:** the worst veto applies first, so any `not_met` (full or partial) caps the row at `partial`, or at `gap` when the signal is full. Only then may a `full` + `met` vouch. Example: full `met` plus partial `not_met` gives `partial`.
  - A disagreement between measurement and attestation shows a "conflict" badge. Neither side silently wins.
  - With no signal, the attestation decides. No attestation gives `not_assessed`.
  - The truth table is a test fixture shared by API, web, portal and report.
- **Framework summary** (the competitor-style percentage): denominator = applicable safeguards in the enrolled tier. The UI shows a stacked bar: implemented-measured, implemented-attested, partial, gap, not assessed. The headline is "*n* of *m* applicable safeguards implemented (*x* measured, *y* attested)". The percentage is never shown without the split and the not-assessed count (Open Decision 6).

### 4.4 Partner defaults and org overrides

The settings follow `docs/agents/settings.md`.

- **Which frameworks apply** (`framework_enrollments`, org XOR partner). A partner row enables a framework (and optional tier) for every org of the partner. An org row overrides it: opt out, opt in, or a different tier. Resolver: `resolveFrameworkEnrollments(orgId)` in `services/safeguards/enrollments.ts`, the only resolver, used by API, worker and report.
- **Responsibility and applicability matrix** (`safeguard_responsibility`, org XOR partner). Partner rows set the default per `(framework, ref)`: responsibility `msp | customer | shared | third_party` and applicability with justification. Org rows override responsibility on its own, and **applicability together with its justification** (review): an org can never inherit a partner's exclusion reason for an applicability it set itself, and vice versa. A CHECK enforces that `not_applicable` carries a justification. Blank means inherit, and the UI shows the inherited value and its source. Resolver: `resolveSafeguardResponsibility(orgId, frameworkId)`.
- **Evidence thresholds and windows** are not configurable. They are the trust defaults plus `SAFEGUARD_SIGNAL_POLICY` (§4.2), by reference, so no new setting is added.

Settings rule 9 statement for the plan PRs:

| Concept | Home (partner) | Home (org) | Resolver | Places configured before → after |
|---|---|---|---|---|
| Frameworks applying to an org | Settings → Compliance frameworks | Org → Compliance tab → Frameworks | `resolveFrameworkEnrollments` | 0 → 1 (two levels) |
| Safeguard responsibility / applicability | Settings → Compliance frameworks → Responsibility matrix | Org → Compliance tab → row drawer | `resolveSafeguardResponsibility` | 0 → 1 (two levels) |
| Frameworks *shown on the public trust page* | unchanged (trust page editor / `trust_page_templates`) | unchanged | unchanged | 1 → 1. This is a separate concept (public display choice). Open Decision 8 covers defaulting it from enrollments. |

### 4.5 Ledger, evidence, plan of action

- **Ledger entry** (`safeguard_ledger_entries`). Created lazily on the first write to `(org, framework, ref)`. It holds notes, the review date and `revision` (optimistic concurrency: a stale write returns 409). The effective view is computed at read time as pack safeguards × enrollment × matrix × entry × current attestation × latest valid snapshot. The API never materialises 200 empty rows per org.
- **Attestations** (`safeguard_attestations`, review). An append-only history modelled on `trust_page_declarations` (`services/trustPage/declarations.ts`). Each revision records the statement, status, actor (user or later portal user), `attested_at`, `expires_at`, the `pack_sha256` it was made under, and the evidence-link ids it cited. A trigger makes every column immutable except `superseded_at`. A partial unique index allows one current row per entry. "Current attestation" is the row with `superseded_at IS NULL`. The entry holds no back-pointer to it, which avoids an erasure-order cycle (trust spec §7).
- **Evidence** (`safeguard_evidence_links`), many per entry. Kinds:
  - `document`: `org_documents`, pinned version.
  - `report_run`: e.g. a posture report run. `report_runs` is unique on `(id, report_id)`, not `(id, org_id)` (`schema/reports.ts:310`). The link therefore carries `(report_id, report_run_id)` with the same FK chain `service_deliverable_evidence` uses (`report_id` → `reports(id, org_id)`, `(report_run_id, report_id)` → `report_runs`).
  - `deliverable_occurrence` (review): a delivered `service_deliverable_occurrences` row, together with the concrete `service_deliverable_evidence` ids it carried. A deliverable *definition* is not a dated artifact. Linking a definition to a safeguard (`safeguard_deliverable_bindings`, W5) makes the deliverable worker add a citation per delivered occurrence. A citation is **revoked** (`revoked_at`, `revoked_reason`) when the occurrence is reopened or its evidence removed (`serviceDeliverableService.ts:803`, `:927`), so the ledger never cites a delivery that no longer stands.
  - `ticket`.
  - `trust_declaration`: an existing `trust_page_declarations` row. It is stored as a **citation snapshot** (statement hash, declarer, declared and expiry dates) plus a live pointer that is `ON DELETE SET NULL`. A loser org's trust page is retired with its declarations in an org merge (`orgMergeCustomExecutors.ts:1009`), and that must neither block the merge nor delete the ledger's record of what was cited.
  - `external_url`: https only, a label, and no fetch.
  - `assessment_snapshot`: implicit. Measured rows cite the snapshot automatically.
- **Plan of action** (`safeguard_action_items` plus `safeguard_action_item_targets` for many-to-many safeguards). Fields: title, description, responsibility, owner (`owner_user_id` for MSP staff, or `owner_contact_id` → `contacts(id, org_id)` for a customer person, or `owner_label` free text), due date, status `open | in_progress | done | risk_accepted | cancelled`, and an optional `ticket_id`. "Create ticket" uses the existing ticket create path. Risk acceptance requires `accepted_by_label`, `accepted_at` and `acceptance_expires_at`, and is shown as "risk accepted until <date>". Measured gaps offer "Suggest action": a prefilled item with a deep link to the Breeze remediation surface (patches, CIS remediation, encryption, PAM). It never auto-remediates.
- **Assessment snapshots** (`safeguard_assessment_snapshots`). Immutable, one per org per framework per run. They hold per-safeguard measured status and counts plus the framework summary. They are retained for 400 days for the trend chart and are the measured-status source for reads, subject to the freshness rule in §4.3. Each one stamps `evaluated_at`, the newest source timestamp, `pack_sha256` and the signal-policy version.

### 4.6 Worker

The worker is `apps/api/src/jobs/safeguardAssessmentWorker.ts` (BullMQ), modelled on `jobs/trustPageSnapshotWorker.ts`:

- It runs daily, plus a rate-limited "Refresh now" (one per org per 10 min). Per org, it runs `withSystemDbAccessContext` under `systemReportAuthorityFor(orgId)` (`services/siteScope.ts`) with org-wide scope.
- It calls `loadPostureEvidence` once with the trust evidence policy (`TRUST_PAGE_EVIDENCE_POLICY`), overlays `trustOnlyEvidence`, runs the new loaders, evaluates, and writes one snapshot per enrolled framework.
- **Partner-wide fan-out** (tenancy playbook step 5): the org set is orgs with an org-level enrollment **or** whose partner has a partner-level enrollment not opted out. An integration test proves a partner-only enrollment produces snapshots for every org.
- It does not change the posture report's positional query order. New loaders sit outside `loadPostureEvidence`, the same as `trustOnlyEvidence.ts`.

### 4.7 API, UI, report, portal, AI

- **API** in `apps/api/src/routes/safeguards/` (split by resource): `frameworks.ts` (`GET /safeguards/frameworks`, loaded packs), `enrollments.ts`, `responsibility.ts`, `ledger.ts` (`GET /orgs/:orgId/safeguards/:frameworkId` effective view, `PUT …/:ref` attestation), `evidence.ts`, `actionItems.ts`, `overview.ts` (partner cross-org summary). Partner-wide writes are gated on `canManagePartnerWidePolicies` (`services/partnerWideAccess.ts`). Create routes take `ownerScope`, and update schemas `.omit({ ownerScope: true })`. Mutations write the audit log. `requireMfa()` only checks that the session meets the caller's *effective* MFA policy (`middleware/auth.ts:1075`), so it admits password-only sessions where the policy allows them. Attestation instead requires an **operation-bound step-up**: the plan reuses an existing step-up mechanism (`routes/billingStepUp.ts`, the approval step-up grant) and does not invent one.
- **Org-wide refusal everywhere (review).** Site-restricted authority is refused in every reader: routes, the partner overview (an org is omitted, not partially shown), report generation (including scheduled and system-authority runs that a restricted user requested), downloads and the AI tool. A shared `assertOrgWideSafeguardAuthority` sits in `services/safeguards/authority.ts`, modelled on `identityAccessReport.ts:275`.
- **Web.** An org detail "Compliance" tab (hash state per CLAUDE.md) with one framework selector, the summary bar, a ledger table (filters for responsibility, effective status, measured or attested, conflict, overdue) and a row drawer (responsibility and applicability with inherit control, attestation, evidence, actions). It also gets a partner `/compliance` overview (customers × frameworks matrix, overdue actions) and a Settings → Compliance frameworks page registered in `settingsCatalog.ts`. Mutations use `runAction`. Copy is in all supported locales.
- **Report.** New report type `safeguard_ledger` (`report_type` enum ADD VALUE). Generator at `services/safeguardLedgerReport.ts`. Formats: PDF (per-framework summary, safeguard table, plan of action, method, attributions), CSV and Excel (an ISO "Statement of Applicability" layout: control, applicable, justification, implemented, evidence). The run **freezes** the effective ledger into the run (settings rule 6). It is schedulable and deliverable through the existing report scheduler and recipients. It is also a `MANAGED_EVIDENCE_REGISTRY` candidate (Open Decision 10). The `report_type` label goes in **its own migration**, committed before any statement uses it. This is the documented transaction boundary of `2026-10-17-110700-report-type-identity-access-review.sql`. W5 also removes or redirects the cosmetic "ISO 27001" option in `ReportBuilder.tsx`.
- **Portal.** Portal exposure rules ship in **W5, before** the report becomes a managed-evidence type (review). Managed report runs become portal-visible on delivery through the generic report endpoints (`services/portal/reportsSelfService.ts:364`). The ledger report must therefore check the flag below and per-evidence visibility (`org_documents.portal_visible`, deliverable `portal_visible`, as `services/portal/serviceReadModel.ts:152`/`:258` do) before any portal UI exists. `portal_branding.enable_safeguard_ledger` is a **sensitive** flag: the ledger is a map of the customer's weaknesses. It joins `PORTAL_SENSITIVE_FLAG_KEYS` (`packages/shared/src/validators/portal.ts`), stays out of "Enable all", and shows a read-only view. A later wave adds a permission flag `enable_safeguard_attestation` (pattern: `enableTrustPageEditing`) so the org's admin contacts can attest and attach documents for **customer-responsible** rows only, recorded as a `safeguard_attestations` revision with `attested_by_portal_user_id` set.
- **AI.** `aiToolsSafeguardLedger.ts` adds `get_safeguard_ledger` (read tier: summary, gaps, overdue actions). Writes are deferred. The tool must be classified in `WISP_TOOL_SUBJECTS` / `NON_FOCAL` and fit the tool-index byte budget, and the permissions-catalog parity contract applies.

## 5. Tenancy and data-model impact

All tables are created with RLS enabled, forced and policied in the creating migration, named after the newest committed migration (currently `2027-01-20-*`; check at plan time). Every composite FK to an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE`.

| Table | Shape | Notes |
|---|---|---|
| `framework_enrollments` | **XOR dual-axis** (`org_id` XOR `partner_id`, `framework_enrollments_one_owner_chk`), one dual-axis policy plus the separate **SELECT-only partner read branch** (`2026-10-05-110000-config-policy-partner-wide-select.sql` template) | cols: framework_id text, tier text null, pack_version text, pack_sha256 char(64), enabled bool, created/updated by + at. Unique `(partner_id, framework_id) WHERE org_id IS NULL`, `(org_id, framework_id)`. `DUAL_AXIS_TENANT_TABLES` + `XOR_OWNERSHIP_DUAL_AXIS_TABLES`; `framework_enrollmentsPartnerRls.integration.test.ts`. |
| `safeguard_responsibility` | **XOR dual-axis**, same policy set | cols: framework_id, safeguard_ref, responsibility enum null, applicability enum null, justification text null; CHECK `applicability <> 'not_applicable' OR justification IS NOT NULL`. Unique per owner `(owner, framework_id, safeguard_ref)`. |
| `safeguard_ledger_entries` | Shape 1, `org_id NOT NULL` | **Justification:** an assessment is a fact about one customer's environment. The partner-level counterpart is `safeguard_responsibility`, so there is still exactly one home per level. Unique `(org_id, framework_id, safeguard_ref)`; `(id, org_id)` unique for children; `revision`, `orphaned_at`. |
| `safeguard_attestations` | Shape 1 | Append-only revisions (§4.5). Composite `(entry_id, org_id)` → entries ON DELETE CASCADE. Immutability trigger except `superseded_at`, partial unique current row, `cited_evidence_ids uuid[]`, `pack_sha256`, `merged_from_org_id`. |
| `safeguard_evidence_links` | Shape 1 | Composite `(entry_id, org_id)` → entries ON DELETE CASCADE. Composite FKs to `org_documents(id, org_id)`, `reports(id, org_id)` + `(report_run_id, report_id)` → `report_runs` (§4.5), `service_deliverable_occurrences(id, org_id)` (`sd_occ_id_org_uq`). The `trust_page_declarations` pointer is `ON DELETE SET NULL` with a citation snapshot. `revoked_at`/`revoked_reason`; `ticket_id` see below. |
| `safeguard_deliverable_bindings` (W5) | Shape 1 | `(entry_id, org_id)`, `(deliverable_id, org_id)` → `service_deliverables(id, org_id)`, PK `(entry_id, deliverable_id)`. |
| `safeguard_action_items` | Shape 1 | `owner_contact_id` composite → `contacts(id, org_id)` (confirm the unique index at plan time; add one if absent); `ticket_id` see below. |
| `safeguard_action_item_targets` | Shape 1 | `(action_item_id, org_id)` and `(entry_id, org_id)` composites, PK `(action_item_id, entry_id)`. |
| `safeguard_assessment_snapshots` | Shape 1 | `payload jsonb` → export `excludedOpen`; immutable except DELETE (retention, cascade); index `(org_id, framework_id, generated_at desc)`. |

**Registration (grep, don't judge).**

- Every `org_id` table above goes into `CORE_ORG_CASCADE_DELETE_ORDER`. The list is **alphabetical**, with `organizations` last. The runtime DELETE order comes from the FK graph (`services/tenantCascade.ts:243`), and `tenantCascade.integration.test.ts` asserts children-before-parents, so check FK direction and do not hand-order the list.
- Every `org_id` table also goes into `orgMergeRegistry.ts` and `CORE_TENANT_EXPORT_POLICY`. Every jsonb is `excludedOpen`; `justification`, notes and URLs are `included`.
- There are no `device_id` columns, so no device cascade lists.
- **Export gap (review).** Because snapshot payloads are `excludedOpen`, an ordinary tenant export omits measured assessment content. The supported path for a customer's assessment data is the `safeguard_ledger` CSV/Excel report (W5). The export-policy entry says so in its comment.

**Ticket links (review: enforce in the database, detach in both movers).** `safeguard_action_items.ticket_id` and `safeguard_evidence_links.ticket_id` are links, not ticket children. The ledger row's `org_id` never moves with a ticket.

- A link-time check alone does not survive a concurrent move. So the columns carry a **composite `(ticket_id, org_id)` → `tickets(id, org_id)` FK, `DEFERRABLE INITIALLY IMMEDIATE`, `ON DELETE SET NULL (ticket_id)`**. A move that forgets to detach fails loudly with 23503 instead of leaving a cross-tenant pointer.
- Both movers **detach** them (set `ticket_id` NULL) before the `tickets` UPDATE, at the lock-order position `services/ticketOrgMoveLockOrder.ts` prescribes:
  - the ticket axis, `moveTicketOrg` in `services/ticketService.ts`, next to the `ai_agent_runs` / `ai_operator_task_targets` / `device_vulnerabilities` detaches;
  - the device axis (`routes/devices/moveOrg.ts`), which re-stamps device-linked tickets.
- The tables are **not** re-stamped, so they do not go in `TICKET_ORG_DENORMALIZED_TABLES`. They are registered as documented exemptions in the schema-derived completeness guard `TICKET_ORG_DENORMALIZED_TABLES completeness` (`routes/devices/moveOrg.coverage.test.ts:824`, Test API). That guard fails on any `ticket_id` + `org_id` table that is neither listed nor exempt.
- Rejected precedent: `service_deliverable_occurrences`, whose `sd_occ_ticket_org_fk` *pins* the ticket and turns the move into a 409 (`ticketService.ts:4005`). A remediation ticket filed under the wrong org should be movable, and the ledger only loses the link.

**Org merge** (custom executors in `orgMergeCustomExecutors.ts`):

- Org-level enrollments and responsibility rows: the survivor's row wins, the loser's colliding rows are dropped, and the rest are repointed.
- Ledger entries colliding on `(framework, ref)`: the survivor's entry and its current attestation stay. The loser's attestations are **kept as history**: they are repointed to the survivor entry with `merged_from_org_id` set and `superseded_at` stamped, so they never count toward current status. Evidence links, citations and action-item targets are repointed. Notes are appended with a "(merged <org8>)" prefix. **Nothing is deleted.**
- The trust-declaration pointers SET NULL when the loser's trust page is retired, and the citation snapshot remains.
- Snapshots: the loser's are deleted, and the survivor re-evaluates on its next run because its fleet changed (trust-page precedent).

**Portal column.** Adding `enable_safeguard_ledger` (and later `enable_safeguard_attestation`) to `portal_branding` is an ADD COLUMN on an org-cascade table, so both need export-policy classification (`included`, like `enable_trust_page_editing`).

**Packs** are not tables in W1–W6, so they have no RLS surface. A future partner-imported pack table would be shape 3 (`PARTNER_TENANT_TABLES`, `partner_id NOT NULL`). That is Open Decision 2.

**Settings home:** §4.4.

## 6. Out of scope

- Certification, audit workflow, auditor accounts, or any "compliant" verdict.
- Bundling CIS Controls content. Enabling a CIS pack anywhere waits on the separate licensing decision.
- Auto-remediation from the ledger. It deep-links to existing remediation features.
- Partner-imported custom packs and OSCAL export (Open Decision 2).
- Device-level or site-level ledgers. The ledger is org-wide by construction.
- Changing the trust page payload, catalog version or crosswalk. Publishing ledger attestations to a trust page is Open Decision 8.
- New evidence thresholds or settings for them.
- HIPAA, SOC 2, Essential Eight and Cyber Essentials as ledger packs. They can come later as packs with no code change; Essential Eight and Cyber Essentials remain trust-page crosswalk frameworks.

## 7. Open Decisions

1. **How a licensed CIS pack reaches a deployment.** (a) Operator pack directory, loaded at boot with checksum logging; hosted mounts the licensed file, and the open-source distribution ships none. (b) A platform-admin upload stored in the database. (c) A signed download from a Breeze-operated pack service, gated by licence. **Recommend (a)**: no new table or service, licensed text never touches the repository, and a self-hoster who holds their own licence can load the same pack. The loader enforces no licence term (review). If the vendor's terms bar *assessment* in the self-hosted build, the control is distribution: the pack goes only to deployments allowed to use it, and the pack's `surfaces` list limits where its text renders. Whether a self-hoster may load a pack they licensed themselves is for the licensing decision, not this spec.
2. **Custom partner packs.** (a) Not in this feature. (b) A partner-axis `safeguard_custom_packs` table with JSON import in a later wave. **Recommend (a) now, (b) as a follow-up issue.** The design-partner request was for standard frameworks. Custom packs bring partner-authored content, licensing liability and validation work.
3. **ISO 27001 text policy.** (a) Identifiers plus Breeze-written paraphrases (`textPolicy: 'paraphrase'`). (b) Identifiers only, with the MSP typing the titles. (c) License ISO text. **Recommend (a)**, with a plan-time review of the paraphrases so none reproduces ISO wording, and the pack header recording who reviewed it.
4. **Cross-framework mapping source.** (a) Breeze-authored, indicative, with NIST CSF 2.0 as the pivot (ISO → NIST mappings in the ISO pack; CIS → NIST in a loaded CIS pack), shown as "related". (b) Import NIST OLIR informative references after checking each one's licence. (c) No cross-mapping in v1; shared signals only. **Recommend (a)**, with (b) evaluated at plan time as a source for checking our mappings.
5. **Do attestations propagate across frameworks?** (a) Never automatically. The drawer offers "Apply to related safeguards" as an explicit bulk action that writes separate attestations. (b) A shared Breeze-control layer where one answer feeds every mapped safeguard. **Recommend (a).** Mappings are rarely `equivalent`, an ISO Statement of Applicability needs a per-control answer, and silent propagation would overclaim.
6. **Headline percentage.** (a) Implemented (measured + attested) ÷ applicable, always shown with the measured/attested split and the not-assessed count. (b) Measured only. (c) Both as separate numbers. **Recommend (a)**: it matches the competitor screen MSPs expect, and the split keeps it honest.
7. **Responsibility defaults: one matrix or named profiles.** (a) One partner default matrix plus org overrides. (b) Named profiles ("Fully managed", "Co-managed") assigned per org or contract. **Recommend (a) for v1.** The table shape allows (b) later by adding a profile axis.
8. **Relationship to the Trust Center.** (a) Separate in v1, with read-only evidence links to existing declarations. (b) Add a "Publish to trust page" action that creates a `trust_page_declaration` from an attestation, and default the trust page framework picker from enrollments. **Recommend (a) now, (b) as a follow-up.** The trust page has its own exposure contract (`trustPagePublicPayloadSchema`), and coupling them doubles the review surface.
9. **One crosswalk source.** (a) Keep `frameworkCrosswalk.ts` for the trust page and packs for the ledger, with a consistency contract test. (b) Derive the trust crosswalk from packs. **Recommend (a).** (b) touches a pinned public payload and the CIS gate.
10. **Managed evidence.** Should `safeguard_ledger` join `MANAGED_EVIDENCE_REGISTRY` (`services/managedEvidenceRegistry.ts`) so a service deliverable can auto-attach a quarterly ledger report? **Recommend yes in W5, after the portal exposure checks (§4.7).** It is more than one entry (review): the registry entry, the `MANAGED_EVIDENCE_REPORT_TYPES` parity in `packages/shared/src/validators/deliverableTemplates.ts` (`managedEvidenceRegistry.test.ts:38`), the portal-definition parity, and the execution classification in `services/reportRegistry.ts:60`.
11. **Permissions.** (a) Reuse `PERMISSIONS.ORGS_READ` / `ORGS_WRITE` (`organizations:read|write`, `packages/shared/src/constants/permissions.ts`), as the trust page does (`routes/trustPage.ts:31`). (b) Dedicated `safeguards:read`, `safeguards:write` and `safeguards:attest` in the same catalog. **Recommend (b).** Attesting is signing a statement on the customer's behalf, and helpdesk roles with `orgs:write` should not get it by default.
12. **Breeze console access as evidence.** Add a `console_access_reviewed` signal from `access_reviews` / `user_risk_scores` scoped to "access to the RMM"? **Recommend no for v1.** It evidences the MSP's tooling, not the customer's environment, and is easy to misread.

13. **When a signal may vouch (`coverage: 'full'`).** (a) Never in v1: every mapping is `partial`, so measurement only vetoes and an attestation is always required. (b) Allowed with a reviewed `scopeJustification` per mapping. **Recommend (b)** for a short list (e.g. `disk_encryption` → ISO A.8.24 is still only partial, but `continuous_monitoring` → a device-monitoring subcategory may be full), each reviewed at plan time. The quorum leaned toward partial-by-default, and the spec adopts that default either way.

**Quorum record (codex gpt-6-astra xhigh, 2026-11-04).** It agreed with the XOR ownership for defaults, the org ownership of assessment facts, the NIST + ISO default and external CIS loading. **Adopted from the review:**

- the authoritative pack registry keyed by checksum, with a versioned content API (§4.1);
- per-surface licence permissions instead of a `redistributable` flag;
- partial-by-default mappings and the mixed-signal rule (§4.3);
- read-time snapshot expiry (§4.3);
- one versioned signal policy for the new windows (§4.2);
- applicability resolved together with its justification (§4.4);
- append-only attestation history, kept through merges (§4.5, §5);
- occurrence-level deliverable citations with revocation (§4.5);
- trust-declaration citation snapshots so a merge cannot block or delete them;
- the `report_runs` FK chain;
- the composite ticket FK with detach in both movers, plus the completeness-guard exemption (§5);
- operation-bound step-up instead of `requireMfa()`;
- org-wide refusal in every reader;
- portal exposure checks before managed evidence (§8);
- the `report_type` label in its own migration;
- the generic evaluator extraction and conditional parity (§4.2);
- corrected sources for the vulnerability SLA and M365 sign-in signals.

**Not fully resolved:**

- the reviewer would require a reviewed justification for *every* `full` mapping and implied few would pass (Open Decision 13);
- it noted that `docs/agents/tenancy-rls.md` still says ticket-move coverage is runtime-only, which `moveOrg.coverage.test.ts:824` has superseded. That doc fix is out of scope here and is flagged for the plan.

## 8. Test and rollout notes

**Waves (sketch):**

- **W1 — Packs and status model (shared, no DB).** Pack schema; bundled NIST CSF 2.0 and ISO 27001:2022 packs; `SafeguardSignalId` and `SAFEGUARD_SIGNAL_POLICY`; the generic `evaluateSignal` extracted beneath `evaluateTrustControls` (trust tests unchanged); `effectiveStatus.ts`. Tests:
  - every pack validates;
  - every signal id resolves;
  - every `TelemetryControlId` is a signal;
  - NIST pack ↔ trust crosswalk consistency;
  - **no bundled pack has a `frameworkId` starting `cis` or a CIS publisher, source or attribution, and the ISO pack is `textPolicy: 'paraphrase'`**;
  - every `full` mapping has a `scopeJustification`;
  - the effective-status truth table, with full and partial coverage, veto, expiry and not-assessed precedence.
- **W2 — Data model and API.** Eight tables with RLS and all registrations (`safeguard_deliverable_bindings` waits for W5); the pack registry with `BREEZE_SAFEGUARD_PACK_DIR` and the versioned content API; routes; `assertOrgWideSafeguardAuthority`; attestation step-up; ticket detach in both movers. Contract and integration suites: `rls-coverage`, `tenantCascade`, `orgMergeRegistry`, export policy, the partner-RLS suites for both XOR tables, the merge-keeps-attestation-history test, the `moveTicketOrg` and device-move detach tests, and the completeness-guard exemptions.
- **W3 — Worker and signals.** The assessment worker with partner fan-out; wiring the existing signals; the 9 new loaders, each with an unmeasured-is-not-zero test.
- **W4 — Web.** Org Compliance tab, partner overview, settings page (with `settingsPageRegistry` / settings catalog registration), all locales.
- **W5 — Report and plan of action.** The `report_type` label migration on its own, then the `safeguard_ledger` report (PDF, CSV and Excel Statement of Applicability) with snapshot on run and the scheduler. **Portal exposure checks** (flag and per-evidence visibility) ship before the managed-evidence registration and its parity lists. Also: ticket creation from action items, deliverable bindings and occurrence citations with revocation, and the `ReportBuilder` ISO option cleanup.
- **W6 — Portal.** Sensitive read-only flag, then customer attestation for customer-responsible rows.
- **W7 — AI read tool.**

**CI traps:**

- `pnpm test` does **not** run the RLS, cascade, merge or export-policy suites. They fail only under **Integration Tests**, so run them locally against a real database before the PR.
- Stacked wave PRs (base ≠ main) get **no CI**. Dispatch with `gh workflow run CI --ref <branch>`.
- Adding the `report_type` enum value (its own migration) and the `portal_branding` columns touches long-registered tables: check export-policy classification and `pnpm db:check-drift`.
- The ticket-link exemptions are enforced by `moveOrg.coverage.test.ts` in **Test API**. The merge and cascade suites run only under **Integration Tests**.
- New `apps/api/src/services/` files must be classified for the parked fan-out and area-gating contracts.
- Any i18n key goes into every supported locale.
- The AI tool needs Wisp subject classification and fits the tool-index budget.

**Rollout:** behind `BREEZE_SAFEGUARD_LEDGER_ENABLED` (default off) until the complete workflow (ledger, evidence, actions, report, W5) has landed, then on.

**Release packaging review:** before any release that ships packs, a human checks bundled packs, fixtures and generated assets for framework text the pack's `textPolicy` does not allow. The result is recorded in the pack file header. No backfill: rows are created lazily, and snapshots start at the first worker run after enrollment.

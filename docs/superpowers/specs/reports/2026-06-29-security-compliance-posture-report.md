# Security & Compliance Posture Report — Spec

**Status:** Draft for review
**Author:** (drafted with Claude)
**Date:** 2026-06-29
**Related:** composes with `docs/superpowers/plans/reports/2026-06-29-downloadable-report-runs.md` (snapshot/download plumbing)

## 1. Problem & Goal

MSPs are repeatedly handed **cyber-insurance applications and vendor-security questionnaires** ("do you deploy EDR? is disk encryption enforced? what's your patch cadence? do you have MFA / backup / DNS filtering?"). Today an MSP has to hand-assemble these answers from a half-dozen Breeze screens.

**Goal:** a single, downloadable **Security & Compliance Posture Report** — scoped to one organization (optionally filtered by site) — that joins Breeze's existing security data into the per-control answers and **percent-implemented** rollups those questionnaires ask for, and renders as CSV / Excel / PDF.

**Non-goals (this spec):**
- No new agent telemetry. TPM, Secure Boot, and SMBv1 are explicitly out of scope — they are not collected today (see §7) and would each need separate agent work.
- No new scheduling/delivery. The report is generated on demand and downloaded; it inherits the run/snapshot/download mechanics from the downloadable-report-runs plan. Scheduled delivery remains out of scope project-wide.
- Not a framework-certified attestation (not SOC 2 / CIS-certified output). It is an **evidence summary** the MSP uses to answer questionnaires, clearly labelled point-in-time.

## 2. Where the data already lives

Everything below already exists in the schema. The report is a read + join + rollup layer; **no new collection.**

| Questionnaire control | Source table(s) | Key columns |
|---|---|---|
| Endpoint protection (AV) — *observed* | `security_status` | `provider`, `provider_version`, `real_time_protection`, `definitions_date`, `last_scan`, `threat_count` |
| Endpoint protection (EDR/MDR) — *managed* | `s1_agents`, `huntress_agents` (resolve org via `s1_org_mappings`, `huntress_org_mappings`) | `deviceId`, `infected`/`threatCount` (S1), incident counts (Huntress); integration liveness via `s1_integrations.isActive` / `huntress_integrations.isActive` + `lastSyncStatus` |
| Disk encryption | `security_status` | `encryption_status`, `encryption_details` (jsonb, per-volume) |
| Host firewall | `security_status` | `firewall_enabled` |
| Password complexity / policy | `security_status` | `password_policy_summary` (jsonb: minLength, maxAgeDays, lockoutThreshold, historyCount) |
| Local-admin exposure | `security_status` | `local_admin_summary` (jsonb: adminCount, localAccountCount, accounts[]) |
| Privileged access (PAM) — config | `pam_org_config` (org-scoped) | `uacInterceptionEnabled` |
| Privileged access (PAM) — rules | `pam_rules` (org/site-scoped) | `enabled`, `priority`, verdict |
| Privileged access (PAM) — activity | `elevation_requests` (org-scoped) | `approvedAt`/`deniedByUserId`/`expiresAt`/`revokedAt`, `approvedByUserId` — gated & time-boxed evidence |
| MFA step-up enforcement | `authenticator_policies` (partner-scoped) | `requireEnrollment`, `enforceFrom`, `floorOverrides` |
| macOS Gatekeeper | `security_status` | `gatekeeper_enabled` |
| Patch compliance | `device_patches` | `status='pending'`, severity; `devices.pending_reboot` |
| Vulnerabilities | BE-16 vuln subsystem | open CVEs by CVSS severity, affected devices |
| Hardening benchmark (policy %) — *bonus, when scanned* | `cis_baseline_results.findings` (jsonb pass/fail) | per-check pass/fail. **Not relied upon** — see §5 |
| Config policies enforced | configuration-policy subsystem | assignment resolution / effective config |
| Pre-computed posture scores | `security_posture_org_snapshots`, `security_posture_snapshots` | `avHealthScore`, `encryptionScore`, `firewallScore`, `patchComplianceScore`, `osCurrencyScore`, `adminExposureScore`, `openPortsScore`, `passwordPolicyScore`, risk-level device counts |
| DNS filtering | `dns_filter_integrations` | `provider`, `isActive`, `lastSyncStatus` |
| Backup (endpoint) | `backup_configs` | `provider`, `isActive`, `encryption` |
| Backup (SaaS M365/GWS) | `c2c_connections`, `c2c_backup_configs` | `provider`, `status` |
| Identity / MFA exposure | `m365_connections`, `google_workspace_connections` | `status`, `lastVerifiedAt` |

**Scope wrinkle:** S1/Huntress/UniFi integrations are **partner-scoped** and fan out to orgs via `*_org_mappings`. DNS/backup/c2c/m365/google are **org-scoped**. The generator must resolve partner-scoped EDR through the mapping tables to attribute it to the report's org.

## 3. Report shape

The report produces **both** a tabular per-device body (so CSV/Excel download works — avoids the summary-only 409 path noted in the downloadable-report-runs plan) **and** a summary object (for the PDF cover page + rollups).

```ts
type SecurityComplianceResult = {
  // Per-device detail — the CSV/Excel body
  rows: Array<{
    hostname: string;
    site: string | null;
    os: string;
    // endpoint protection (merged, see §4)
    protection: string;            // e.g. "Huntress + Defender (RTP on)"
    protectionManaged: boolean;    // S1/Huntress agent present
    realTimeProtection: boolean | null;
    avDefinitionsAgeDays: number | null;
    // controls
    encryption: string;            // "encrypted" | "partial" | "unencrypted" | "unknown"
    firewall: boolean | null;
    localAdmins: number | null;
    pendingPatches: number;
    criticalPatches: number;
    openVulnCritical: number;
    openVulnHigh: number;
    cisPassRate: number | null;    // % of CIS checks passing, null if never scanned
    posture: number | null;        // latest per-device overallScore if present
  }>;
  rowCount: number;
  summary: {
    org: { id: string; name: string };
    generatedAt: string;
    deviceCount: number;
    // percent-implemented rollups (the questionnaire answers)
    controls: {
      edrCoveragePct: number;        // % devices with managed EDR (S1/Huntress)
      anyAvCoveragePct: number;      // % with any AV + RTP on
      unprotectedCount: number;      // devices with NEITHER managed EDR NOR native AV+RTP
      encryptionPct: number;
      firewallPct: number;
      patchCurrentPct: number;       // % with zero pending critical patches
      passwordComplexityPct: number; // % meeting a configurable min policy (length/lockout/history)
      localAdminExposurePct: number; // % of devices with >N local admins (configurable threshold)
      cisAvgPassRate: number | null; // bonus — null until CIS scans run in the fleet
      identityProviderConnected: boolean; // m365/google tenant connected — NOT proof of MFA enforcement (see privilegedAccess.mfaStepUpEnforced)
      backupConfigured: boolean;     // active backup_configs OR c2c
      backupEncrypted: boolean | null;
      dnsFilteringActive: boolean;
    };
    // privileged access management (PAM-adjacent)
    privilegedAccess: {
      uacInterceptionEnabled: boolean;   // pam_org_config
      activePamRules: number;            // count of enabled pam_rules in scope
      elevationsInWindow: number;        // elevation_requests in the report window
      elevationsApproved: number;
      elevationsDenied: number;
      mfaStepUpEnforced: boolean;        // authenticator_policies.requireEnrollment (+ enforceFrom passed)
    };
    // integration inventory (the "products in use" section)
    securityProducts: Array<{
      product: string;               // "SentinelOne" | "Huntress" | "Cisco Umbrella" | ...
      category: 'edr' | 'mdr' | 'dns_filtering' | 'backup' | 'identity';
      active: boolean;
      lastSyncStatus: string | null;
      deviceCoverage: number | null; // devices reporting to it, where applicable
    }>;
    postureScore: number | null;     // latest org overallScore if a snapshot exists
  };
};
```

## 4. Endpoint-protection merge (the AV/EDR section)

Per Todd: the AV/EDR answer must **include what the security integrations report**, not just the agent's native detection. Three sources, merged per `deviceId`:

1. **Managed EDR/MDR (authoritative):** a row in `s1_agents` or `huntress_agents` for the device (resolved to this org via the `*_org_mappings`), gated on the parent integration being live (`isActive` + recent `lastSyncStatus='success'`). Proves the EDR is deployed *and reporting* — the strongest evidence for a questionnaire.
2. **Native AV (observed):** `security_status.provider` + `real_time_protection`. Note the provider enum already includes `sentinelone`/`crowdstrike`, so native detection can corroborate.
3. **Merge rule:** `protection` string = the union of all detected products, labelled. `protectionManaged = true` if (1) holds. A device counts toward `edrCoveragePct` only via (1); toward `anyAvCoveragePct` via (1) or (2)-with-RTP-on.

**Unprotected devices are a first-class section, not just a percentage.** Any device with *neither* a managed EDR agent *nor* native AV+RTP is listed explicitly (hostname, site, last seen) — this is the remediation list and the most scrutinised part of an insurance review.

> Data caveat to surface in the report footnotes: native AV detail is lossy at ingest — the agent collects a multi-AV array but `upsertSecurityStatusForDevice` collapses it to one `provider` + `real_time_protection`. The report should not claim an exhaustive per-product AV list from native detection; the managed-EDR integration tables are the reliable multi-product signal.

## 5. Scoring / percent-implemented methodology

Two options for the rollup numbers:

- **(A) Compute directly from source tables** at report time (authoritative, point-in-time, independent of whether the posture job has run).
- **(B) Read the latest `security_posture_org_snapshots` row** (cheap, already computed, but stale if the posture engine hasn't run recently and may not respect a site filter).

**Decision: (A) for the questionnaire control percentages**, so the report is self-contained and reflects the exact moment of generation and any site filter. **(B) is surfaced as a supplementary `postureScore`** (and could feed a trend sparkline in a later iteration) only when a recent snapshot exists. This avoids coupling the report's correctness to the posture scheduler.

**CIS is wired but optional, and never a dependency.** CIS baseline scans are not yet routinely run in the target fleets, so **every primary control percentage derives from `security_status`, `device_patches`, the integration tables, and the PAM/elevation tables** — all of which populate without any CIS scan. The CIS section is now implemented: when `config.includeCis` is true (default), the generator reads each in-scope device's latest `cis_baseline_results` row and computes `cisPassRate = passedChecks / totalChecks` (using the result's aggregate columns directly — no findings-jsonb parsing), with `cisAvgPassRate` the mean over devices that have a scan. When no scans exist it is `null` and the PDF renders "Not yet assessed — enable CIS baseline scans," never 0% (which would read as a failing control rather than an unmeasured one). When `config.includeCis` is false, the CIS query is skipped entirely and the hardening line is omitted from the PDF (`controls.cisIncluded` distinguishes "off" from "no data"). When CIS coverage later grows, the section lights up with no report changes.

**No-data is never scored as the favorable answer (insurance-grade honesty).** Each control has its own *assessed* denominator, not a shared one: a device that reports `security_status` but lacks data for a specific control (corrupt/absent `local_admin_summary`, no password-policy fields, `firewall_enabled` null, `encryption_status` 'unknown') is counted as **unknown** for that control — excluded from both numerator and denominator — and the unknown count is surfaced (`localAdminUnknownCount`, `passwordUnknownCount`, `patchUnknownCount`). Percentages are `number | null`; when nothing was assessed the value is `null` and the PDF renders **"N/A — not assessed"**, never `0%` (which would read as a measured failure). Specific honesty rules baked in:
- **Patch currency** counts a device only if it has a `device_patches` row (any status) — never-scanned devices are unknown, not "current".
- **AV definitions currency** consumes `maxAvDefinitionsAgeDays` over native-AV devices that report a definitions date.
- **Identity**: `identityProviderConnected` proves only that an M365/Google tenant is connected; it does **not** assert MFA. Real MFA enforcement is `privilegedAccess.mfaStepUpEnforced` (`authenticator_policies`).
- **Integration health**: an integration failing to sync (`lastSyncStatus='error'`) is reported degraded, not active; sync status is rendered on the scorecard.
- **CIS** reports its coverage (`cisAssessedCount`/`deviceCount`) alongside the average, so a thin sample can't read as a fleet number.

`passwordComplexityPct` and `localAdminExposurePct` read `password_policy_summary` / `local_admin_summary` against thresholds in `config` (sensible defaults: min length ≥ 8, lockout enabled; local-admin threshold > 2). Privileged-access counts come from `pam_org_config` (one row/org), enabled `pam_rules`, and `elevation_requests` filtered to the report's date window.

## 6. Implementation surface (high level — a separate plan will task this out)

1. **Enum migration** — add `security_compliance_posture` to `report_type`:
   ```sql
   ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'security_compliance_posture';
   ```
   ⚠️ Verify behaviour under `autoMigrate`'s per-file transaction wrapper. `ALTER TYPE … ADD VALUE` is allowed inside a transaction on PG12+ but the new label is unusable until commit — fine here because no later statement in the same migration uses it. Keep this migration **value-add only** (no table using the value in the same file). The `reportTypeEnum` Drizzle array in `schema/reports.ts` must be extended in the same PR for drift.
2. **Generator** — `generateSecurityCompliancePostureReport(orgId, config, perms)` added to `reportGenerationService.ts` (the shared service the downloadable-report-runs plan extracts) and wired into its `generateReport` dispatcher + `ReportType` union. Must honour `perms` / `siteScopeRequestAllowed` exactly like the other generators (site-scope security is mandatory).
3. **Builder/registry surfacing** — add the type to `ReportBuilder.tsx` options and a curated `ReportTemplates.tsx` entry ("Security & Compliance Posture"). Config options: `sites[]` filter, `sections[]` toggles (which controls to include), optional `frameworkLabel` (free-text, e.g. "Cyber Insurance Renewal 2026").
4. **PDF template** — see §8. The generic table PDF is insufficient; this needs a branded summary layout. Rendered client-side from the stored snapshot (consistent with the downloadable-report-runs PDF path).
5. **Tests** — generator unit tests (Drizzle-mock per `breeze-testing`): merge logic, unprotected-device detection, percent math, site-scope rejection, partner-scoped EDR resolution, empty-data ("no devices reporting") behaviour.

Because the downloadable-report-runs plan stores `report_runs.result` as a jsonb snapshot and serves CSV/Excel server-side + PDF client-side, **this report needs no new run/download plumbing** — it just emits the `SecurityComplianceResult` shape and gets persistence + download for free. The only nuance: that plan's CSV path renders `result.rows`, which this report populates (so CSV/Excel work), while the rich rollups travel in `result.summary` for the PDF.

## 7. Known data gaps (surface as report footnotes, not silent omissions)

| Signal | Status | Implication |
|---|---|---|
| TPM, Secure Boot | Not collected (no agent collector, no column) | Omit; if a questionnaire requires them, scope agent work separately |
| SMBv1 enabled | Not collected | Omit |
| UAC interception (org policy) | `pam_org_config.uacInterceptionEnabled` — always available | Reported in the privileged-access section (distinct from per-device UAC, which is CIS-only) |
| Per-device UAC, screen-lock | CIS-only (jsonb findings), only if a CIS baseline scan was run | Bonus section; "not yet assessed" until CIS scans run |
| Multi-AV per device | Collapsed at ingest | Use managed-EDR tables for multi-product truth; native = single provider |
| Generic Slack/Teams/monitoring integrations | In-memory only, not persisted | Not a reliable "in use" source; exclude from security-products inventory |

Per project convention, any bounded coverage (e.g. "12 of 240 devices never CIS-scanned") is **stated in the report**, never silently dropped — silent truncation reads as "100% covered" when it isn't.

## 8. PDF template (cover + sections)

1. **Cover** — org name, framework label, generated-at, overall posture score (if available), and a control-coverage scorecard (EDR %, encryption %, firewall %, patch-current %, MFA y/n, backup y/n, DNS filtering y/n) as a grid of labelled gauges.
2. **Security products in use** — table of detected EDR/MDR/DNS/backup/identity integrations with active status + device coverage.
3. **Per-control breakdown** — one block per control (EDR, encryption, firewall, patch, password complexity, local-admin exposure) with the percentage, the numerator/denominator, and the exception count.
4. **Privileged access (PAM)** — UAC interception on/off, count of active PAM rules, elevation activity in window (approved/denied), and MFA step-up enforcement status. This is the section that answers the "PAM-adjacent" questionnaire items.
5. **Unprotected devices** — explicit table (hostname, site, last seen). Empty = a green "all devices protected" callout.
6. **Patch & vulnerability summary** — pending/critical patches, open CVEs by CVSS severity.
7. **Hardening (CIS)** — bonus; renders pass-rate when scans exist, otherwise a "Not yet assessed" callout.
8. **Footnotes** — data-gap disclosures from §7 and the point-in-time / not-a-certification disclaimer.

## 9. Decisions & remaining questions

**Resolved (Todd, 2026-06-29):**
- **Questionnaire fields** — confirmed the forms also ask about **password complexity, local admin, and PAM-adjacent** controls. All three are now first-class summary controls (§3) sourced from `password_policy_summary`, `local_admin_summary`, and the PAM/elevation/authenticator tables (§2). Backup `legalHold` and immutable-backup specifics remain derivable extensions if a specific form needs them.
- **CIS dependency** — CIS scans are **not yet** routine ("hopefully soon"). The report therefore takes **zero CIS dependency**: all primary control percentages derive from `security_status` / `device_patches` / integrations / PAM tables, and the hardening section degrades to "Not yet assessed" until scans run, then lights up automatically (§5).

**Still open:**
1. **One org per report, or partner-wide roll-up?** This spec is per-org (the natural unit for a client's insurance form). A partner-level "all my clients" variant is a straightforward extension but changes the rollup denominators and the PDF. *(Assume per-org unless told otherwise.)*
2. **Threshold defaults** — confirm the password-complexity floor (default: min length ≥ 8, lockout enabled) and local-admin exposure threshold (default: > 2 admins flags a device). These are `config`-driven, so defaults are fine to start.
3. **"Not a certification" disclaimer wording** — do you want specific legal language on the PDF footer, or is a generic "point-in-time evidence summary, not a formal attestation" line sufficient?

# Security & Compliance Posture Report Corrections - Design

**Status:** Approved design, pending implementation plan  
**Date:** 2026-07-14  
**Reference artifact:** `/Users/toddhebebrand/Downloads/security_compliance_posture-report-2026-07-14.pdf`

## Problem

The Security & Compliance Posture report currently publishes misleading or incomplete evidence in three areas:

1. Open vulnerability counts can appear as zero even when affected devices have findings.
2. Backup is treated as a mandatory failed control even for workstation-oriented reports where backup is intentionally not required.
3. The security-product inventory omits endpoint-reported products and silently clips later products when the PDF cover runs out of space.

The supplied PDF demonstrates the product problem directly: device rows show Huntress, Defender, and SentinelOne, while the cover lists only Huntress. It also shows every high and critical vulnerability count as zero.

This work corrects the evidence and presentation paths without changing the numeric posture-score model. The separately reported template-gallery duplication and mislabeled Technician Activity template are explicitly deferred to follow-up work.

## Goals

- Count open high and critical vulnerabilities accurately for ad-hoc and scheduled reports.
- Preserve tenant isolation while reading the system-only CVE catalog.
- Make backup a report-level requirement choice.
- Keep optional backup evidence visible and neutral rather than hiding it.
- Include all detected security products with deduplicated device coverage.
- Never silently truncate security-product evidence in the PDF.
- Preserve existing saved reports and historical report snapshots.

## Non-goals

- Changing the security posture score or its weights.
- Adding new endpoint telemetry or per-device backup coverage.
- Classifying devices as servers versus workstations.
- Canonicalizing or migrating the entire vulnerability catalog as part of this report fix.
- Fixing template duplication or the Technician Activity template mapping.

## Selected approach

Use targeted end-to-end corrections at the existing report boundaries:

- Mirror the established two-phase vulnerability read used by the fleet vulnerability feature.
- Add an explicit `backupRequired` report option and carry it into the persisted summary.
- Build a canonical product inventory from managed integrations and endpoint observations.
- Continue product inventory onto a dedicated PDF page when the cover cannot contain every item.

This is preferred over either loosening the report's database context or undertaking a broad reporting-engine refactor. It fixes the root causes while keeping the change isolated to posture-report configuration, generation, shared types, UI options, and PDF rendering.

## Architecture and data flow

### Vulnerability counts

The current report directly joins `device_vulnerabilities`, which is tenant-readable, to `vulnerabilities`, which is a forced-RLS system-only catalog. Under an organization or partner request context, PostgreSQL removes the catalog side of the join and the report receives no rows. Real catalog severity values also arrive in inconsistent casing such as `HIGH`, `High`, `CRITICAL`, and `Critical`, while the report compares only exact lowercase values.

The corrected flow is:

1. Under the ambient tenant request context, read open `device_vulnerabilities` rows for the report's already-scoped device IDs.
2. Collect the distinct referenced vulnerability IDs.
3. Escape the request database context with `runOutsideDbContext` and read only those catalog IDs inside `withSystemDbAccessContext`.
4. Merge the tenant findings and catalog records in memory.
5. Normalize severity with lowercase comparison and produce per-device high and critical counts.

The tenant-scoped read remains the authorization boundary. The system read contains only global reference data for IDs that survived that boundary. The report must not run its entire generation path under system context as a shortcut.

If tenant findings exist but their referenced catalog evidence cannot be loaded completely, generation fails with a clear error. It must not publish zeros for an incomplete lookup. The catalog foreign key should make missing referenced rows abnormal, so fail-closed behavior is appropriate for an insurance-oriented report.

### Backup requirement

Add `backupRequired: boolean` to the posture-report configuration and `backupRequired?: boolean` to `PostureControls` for persisted-summary compatibility.

Behavior is:

- New reports created from the posture template explicitly default `backupRequired` to `false`.
- A report-creation option labeled `Require backup coverage` lets the user opt in.
- Existing reports and historical summaries that omit `backupRequired` retain the current required behavior.
- When backup is required, the existing pass/fail control and missing-backup recommendation remain.
- When backup is optional and no solution is detected, the PDF renders a neutral `Backup - Not required` result and emits no recommendation.
- When backup is optional and configured, the PDF renders a neutral `Backup - Optional; configured` result.
- Detected endpoint or SaaS backup products remain in the product inventory regardless of requirement policy.

Backup remains excluded from the numeric posture score. This change affects only the compliance judgment and recommendation.

### Security-product inventory

Build one deterministic inventory from:

- Huntress-managed device IDs.
- SentinelOne-managed device IDs.
- Each in-scope `security_status.provider` other than `other`.
- Existing DNS filtering, endpoint backup, SaaS backup, and identity integrations.

For device-based products, aggregation uses normalized product identity and a set of device IDs. If SentinelOne is detected through both `s1_agents` and `security_status`, the inventory contains one SentinelOne row whose coverage is the union of those IDs.

Add `antivirus` to `PostureProductCategory`. Endpoint observations are categorized consistently:

- Defender, Bitdefender, Sophos, Malwarebytes, ESET, and Kaspersky are antivirus.
- SentinelOne, CrowdStrike, and Elastic Defend are EDR.
- A managed-product source takes precedence over an endpoint-only classification when the same normalized product is present in both sources.

Endpoint providers are inventory evidence even when real-time protection is off. The product remains listed, but its activity state reflects whether it is protected or corroborated by a managed integration. Device coverage is the unique count of detected installations, not the count of only RTP-enabled devices.

### PDF rendering

The product inventory is compliance evidence and must be complete.

The cover renders as many product rows as safely fit without overlapping the glossary or footer. If every product does not fit:

1. The cover displays an explicit continuation note.
2. A dedicated `Security products in use` continuation page renders the complete remaining inventory.
3. Per-device detail follows afterward.

The renderer never exits a product loop silently. Product ordering is deterministic for stable snapshots and tests, but ordering does not determine which evidence survives.

## Component boundaries

### API report service

Introduce a focused vulnerability-loading boundary that owns the tenant-to-system context transition and returns per-device counts. Keep the main generator responsible for report orchestration, not RLS mechanics.

Introduce a pure product-inventory aggregator that accepts scoped device observations and integration sets, then returns `PostureProduct[]`. Its normalization, deduplication, category, activity, and coverage rules are independently testable.

### Report schemas and shared types

- Add `backupRequired` to both posture configuration schema definitions used by create, update, and ad-hoc generation.
- Default parsed legacy configuration to required at the API boundary.
- Add the optional persisted-summary field and the `antivirus` category to shared posture types.

No database migration is required because report configuration and result summaries are JSON.

### Web report creation and editing

The posture template currently bypasses the generic report builder to avoid downgrading its report type. Preserve that behavior, but add a lightweight posture-options step before direct creation. It must post the true `security_compliance_posture` type and an explicit `backupRequired` value.

Editing a posture report must preserve posture-specific and unknown future configuration fields. It must not route the report through a form path that reconstructs only generic configuration or downgrades its type. Saving should merge the edited posture options with the existing configuration.

All new user-facing strings must exist in the five supported report locale files.

### Shared PDF renderer

The PDF layer owns presentation only. It reads `backupRequired` from the persisted summary, treats absence as required for backward compatibility, renders the new antivirus label, and handles product continuation without changing evidence semantics.

## Error handling and compatibility

- Vulnerability catalog lookup failure is a report-generation error, not a zero count.
- Tenant and site scoping continue to happen before the catalog read.
- Unknown or unclassified severity values are ignored for high/critical totals but do not invalidate otherwise complete catalog evidence.
- Historical summaries without `backupRequired` remain required.
- Historical product categories continue to render.
- Old report configurations can be regenerated without schema rejection.
- Product output order is stable.
- No unrelated report template behavior changes in this implementation.

## Testing strategy

Implementation follows test-driven development, with each production behavior preceded by a failing regression test.

### API and data isolation

- Unit test mixed-case high and critical catalog severities.
- Test that open findings count while patched, mitigated, and accepted findings do not.
- Test incomplete catalog lookup fails generation instead of returning zeros.
- Add an RLS integration test proving an organization-context report sees its own findings through the two-phase lookup and cannot see another organization's findings.
- Add a parity fixture comparing posture-report per-device counts to the canonical fleet vulnerability aggregation.

### Product aggregation

- Native Defender appears with correct unique-device coverage.
- Endpoint-only SentinelOne appears without an `s1_agents` row.
- SentinelOne present through both sources is emitted once with union coverage.
- RTP-off products remain visible with degraded activity semantics.
- Site and device scope limit product coverage correctly.

### Backup configuration and UI

- Schema accepts both boolean values, rejects non-booleans, and applies legacy-required behavior when omitted.
- Template creation posts `backupRequired: false` by default and preserves the posture report type.
- Opting in posts `backupRequired: true`.
- Posture editing loads and saves the choice while preserving unrelated config fields.
- Optional/no-backup summary remains factually `backupConfigured: false` while rendering neutrally and omitting the recommendation.
- Required/no-backup and legacy summaries retain the failed control and recommendation.

### PDF

- A fixture matching the supplied artifact renders Huntress, SentinelOne, and Defender.
- A many-product fixture produces a continuation page and contains every product name.
- No product row overlaps the glossary or footer.
- Existing posture and generic report PDF tests remain green.
- Render the final reference-like PDF to PNG and inspect page transitions, alignment, clipping, and legibility.

## Acceptance criteria

- Ad-hoc tenant-generated reports count open high and critical vulnerabilities correctly.
- Scheduled reports produce the same vulnerability counts for the same snapshot.
- Mixed-case source severities count identically.
- Cross-tenant findings never enter the report.
- A new posture report can treat backup as optional without a red status or recommendation.
- Optional backup remains visible as neutral evidence, and detected backup products remain listed.
- The security-product inventory includes endpoint-reported Defender and SentinelOne where detected.
- Duplicate detections do not inflate product device coverage.
- Every product in the generated summary appears in the PDF, either on the cover or the continuation page.
- Numeric posture score and methodology remain unchanged.

## Deferred follow-up

Track separately:

- Creating a report from a template appears to duplicate a report-like item in the template list.
- The Technician Activity template is mislabeled and currently generates device inventory.


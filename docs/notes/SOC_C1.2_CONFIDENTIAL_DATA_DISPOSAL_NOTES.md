# SOC 2 C1.2 Confidential Data Disposal Notes (Breeze)

Last updated: 2026-02-28

## Control Metadata

- Control ID: `C1.2`
- Severity: `MEDIUM`
- Control statement (summary): The entity disposes of confidential information to meet confidentiality commitments and reduce unauthorized access risk.

## Objective of This Note

Define how Breeze handles retention, archival, and deletion/disposal for confidential data, and what evidence is needed for SOC review.

## Disposal Model (Policy-Level)

Breeze should apply disposal by data class:

1. Restricted data

- shortest practical retention
- strict access and deletion controls
- auditable deletion/archive trail

2. Confidential operational data

- retention based on operational and contractual needs
- automated pruning where possible
- immutable audit evidence of policy execution

3. Internal/public data

- standard lifecycle controls

## Current Controls in Codebase

1. Retention workers (implemented)

- Event log retention worker with per-org retention resolution:
  - `apps/api/src/jobs/eventLogRetention.ts`
- Agent diagnostic log retention worker:
  - `apps/api/src/jobs/agentLogRetention.ts`
- Device change log retention worker:
  - `apps/api/src/jobs/changeLogRetention.ts`
- Additional retention workers present for SNMP, IP history, reliability, user-risk and playbook execution data.

2. Time-series retention (implemented where TimescaleDB is enabled)

- `time_series_metrics` retention/compression policy migration:
  - `apps/api/src/db/migrations/timescaledb-setup.sql`

3. Backup retention controls (implemented in backup policy model)

- Backup policy objects include retention schedule fields (`keepDaily/keepWeekly/keepMonthly`):
  - `apps/api/src/routes/backup/policies.ts`
  - `apps/api/src/routes/backup/types.ts`

4. Confidential file remediation paths (implemented command surface)

- Sensitive data remediation command types include `secure_delete_file` and `quarantine_file`:
  - `apps/api/src/services/commandQueue.ts`

5. Audit retention data model (partially implemented)

- `audit_retention_policies` table exists with `retention_days`, `archive_to_s3`, `last_cleanup_at`:
  - `apps/api/src/db/schema/audit.ts`
- This supports C1.2 design intent; verify/complete operational cleanup + archival workflow evidence.

## DigitalOcean-Oriented Disposal Planning

For production on DigitalOcean:

- use DO Spaces lifecycle/versioning policies to enforce object retention/expiry for confidential artifacts
- apply managed DB backup retention policies aligned with confidentiality requirements
- ensure disposal/retention policy changes are change-managed and auditable

## Evidence Checklist (Audit-Friendly)

- documented retention schedule by data domain/class
- retention worker configuration and execution evidence (logs/job history)
- sample proof of aged-record pruning for each major confidential dataset
- backup retention policy configuration evidence
- object storage lifecycle/expiry policy evidence (for DO Spaces or equivalent)
- deletion/disposal audit entries for privileged destructive actions
- exception approvals when legal/contractual hold overrides disposal schedule

## Implementation Plan (Recommended)

1. Centralize retention matrix

- Build a single matrix: dataset -> classification -> retention -> archive -> disposal method -> owner.

2. Validate automation coverage

- Map each confidential dataset to an automated retention job or documented manual process.

3. Close audit-retention gaps

- Confirm `audit_retention_policies` is actively enforced by scheduled cleanup/archival workflow.
- If not fully enforced, implement and test before audit period.

4. Add legal-hold handling

- Document controlled exceptions and override process for records under legal/contractual hold.

5. Quarterly control review

- Review disposal outcomes, failures, and exceptions.

## Known Gaps / Pre-Audit Tasks

- Need explicit, centralized retention/disposal register for all confidential datasets.
- Need clear evidence that audit-log retention policy settings are operationally enforced (not only modeled in schema).
- Need formal legal-hold procedure tied to disposal suppression and approval tracking.

## Primary References

- `docs/SECURITY_PRACTICES.md`
- `docs/BACKUP_RESTORE.md`
- `apps/api/src/jobs/eventLogRetention.ts`
- `apps/api/src/jobs/agentLogRetention.ts`
- `apps/api/src/jobs/changeLogRetention.ts`
- `apps/api/src/db/migrations/timescaledb-setup.sql`
- `apps/api/src/db/schema/audit.ts`
- `apps/api/src/routes/backup/policies.ts`
- `apps/api/src/services/commandQueue.ts`

## Example C1.2 Narrative (Draft)

Breeze applies confidentiality-focused data lifecycle controls by defining retention and disposal requirements for confidential datasets and enforcing those requirements through automated retention jobs, storage lifecycle settings, and audited destructive operations. Where archival is required before deletion, policy-driven controls and evidence are retained to demonstrate compliance with confidentiality commitments and contractual obligations.

# SOC 2 C1.1 Confidential Data Identification Notes (Breeze)

Last updated: 2026-02-28

## Control Metadata

- Control ID: `C1.1`
- Severity: `MEDIUM`
- Control statement (summary): The entity identifies confidential information and protects it according to confidentiality commitments and system objectives.

## Objective of This Note

Document how Breeze identifies confidential data classes, where that data exists, and which controls are applied to protect confidentiality.

## Confidential Data Categories (Draft)

Use the following categories for Breeze:

1. Restricted

- authentication secrets
- integration API tokens and webhook secrets
- MFA secrets and recovery artifacts
- encryption keys and keying material

2. Confidential

- tenant operational data (device inventory, telemetry, alerting context)
- audit logs containing security-relevant actor/action metadata
- customer-generated scripts, reports, and attachments

3. Internal

- non-public operational metrics and internal runbooks

4. Public

- documentation intentionally published for product usage/marketing

## Current Identification and Protection Mechanisms

1. Tenant-aware data boundary

- PostgreSQL row-level security (RLS) is enabled and forced for tenant tables with `org_id`.
- Access is controlled by request/job scope context (`system`, `partner`, `organization`) and org access functions.
- Scope defaults are fail-closed when context is missing.

2. Confidential secret handling

- Sensitive secrets are encrypted at rest using AES-256-GCM (`enc:v1:*` format) via `secretCrypto`.
- Production requires dedicated encryption key material (`APP_ENCRYPTION_KEY` or equivalent).
- Auth/session tokens and API keys are stored as one-way hashes where applicable.

3. Access controls

- RBAC permissions and scoped middleware restrict access to tenant data.
- MFA gates are applied for sensitive operations (for supported routes/workflows).

4. In-transit protections

- TLS-protected transport for UI/API traffic and secure WebSocket channels.

5. Logging and exposure reduction

- Security documentation states sensitive secrets/tokens should not be logged.
- Metrics and labels include redaction controls for tenant identifiers in production paths.

## Data Inventory Baseline (Initial)

Start with these systems/tables and expand:

- tenant-scoped relational data (`org_id` tables under RLS)
- encrypted secret columns (integration/provider credentials, SSO client secrets, MFA secrets)
- hashed token stores (API keys, enrollment key artifacts, agent token hashes)
- object storage artifacts (scripts/reports/attachments)
- audit/event logs

## Evidence Checklist (Audit-Friendly)

- data classification register (table/dataset -> classification -> owner)
- RLS migration/config evidence and tenant isolation tests
- encryption-at-rest implementation evidence (`secretCrypto`, key policy, secret rotation records)
- proof of token hashing for applicable credential types
- access control evidence (RBAC policy, route permission mapping, MFA requirements)
- logging/redaction review evidence (sample logs, logging policy)
- periodic review record showing updates to data inventory/classification

## Implementation Plan (Recommended)

1. Formalize data inventory

- Create a maintained register of confidential datasets by table, storage location, and owner.

2. Attach handling rules by class

- Define required controls per class (encryption, access approval, retention, export constraints).

3. Validate controls-to-data mapping

- For each restricted/confidential dataset, map implemented controls and evidence location.

4. Establish review cadence

- Review and attest inventory/classification quarterly and at major architecture changes.

## Known Gaps / Pre-Audit Tasks

- Formal classification register is not yet centralized in a single control-owned artifact.
- Need explicit dataset owner assignment per major confidential data domain.
- Need recurring attestation workflow confirming classification remains accurate.
- Ensure log review procedure explicitly validates non-disclosure of restricted fields.

## Primary References

- `docs/SECURITY_PRACTICES.md`
- `docs/SECURITY.md`
- `docs/SECRET_ROTATION.md`
- `apps/api/src/services/secretCrypto.ts`
- `apps/api/src/db/migrations/2026-02-09-tenant-rls.sql`
- `apps/api/src/db/migrations/2026-02-10-tenant-rls-deny-default.sql`
- `apps/api/src/__tests__/multi-tenant-isolation.test.ts`

## Example C1.1 Narrative (Draft)

Breeze identifies confidential information through a documented data classification approach covering restricted secrets, tenant operational data, and sensitive audit artifacts. Confidential datasets are protected with tenant-aware access boundaries (RLS and scoped RBAC), encryption and hashing controls for secrets and credentials, and secure transport protections. The organization maintains evidence of classification, control mapping, and periodic review to ensure confidentiality commitments are met.

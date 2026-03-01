# SOC Remaining Controls Walkthrough (Breeze)

Last updated: 2026-02-28

## Purpose

Step through the remaining SOC controls in one place with:

- plain-English meaning
- Breeze implementation starting point
- immediate next step for evidence readiness

## Assumptions

- Uses SOC 2 Trust Services Criteria control ID format (CC/A/C/PI/P) commonly used in SOC 2 programs.
- `A1.1-A1.3` and `C1.1-C1.2` are already documented separately.
- Final in-scope control set must be confirmed with your auditor and report scope (especially Privacy criteria).

## Already Covered

- Availability:
  - `docs/notes/SOC_A1.1_CAPACITY_NOTES.md`
  - `docs/notes/SOC_A1.2_RECOVERY_OBJECTIVES_NOTES.md`
  - `docs/notes/SOC_A1.3_RECOVERY_TESTING_NOTES.md`
- Confidentiality:
  - `docs/notes/SOC_C1.1_CONFIDENTIAL_DATA_IDENTIFICATION_NOTES.md`
  - `docs/notes/SOC_C1.2_CONFIDENTIAL_DATA_DISPOSAL_NOTES.md`

## Security (Common Criteria)

### CC1 — Control Environment

| Control | What it means | Breeze starting point | Next step |
|---|---|---|---|
| CC1.1 | Leadership sets ethical tone and integrity expectations | Existing security/compliance docs and coding standards | Publish formal code of conduct + policy acknowledgment evidence |
| CC1.2 | Oversight body governs internal control | Security docs and release practices exist | Add recurring governance review minutes and approvals |
| CC1.3 | Structure, reporting lines, and authority are defined | Multi-tenant architecture + scoped roles documented | Create formal RACI for security/compliance controls |
| CC1.4 | Organization attracts/develops competent personnel | Engineering/security practices documented | Add role-based training matrix and completion records |
| CC1.5 | Personnel are accountable for control responsibilities | Audit logs + role permissions exist | Assign named control owners with periodic attestation |

### CC2 — Information and Communication

| Control | What it means | Breeze starting point | Next step |
|---|---|---|---|
| CC2.1 | Relevant quality information supports controls | Audit logs, monitoring, and telemetry available | Define KPI/KRI set used in control decisions |
| CC2.2 | Internal communication of control matters is effective | Existing runbooks/docs | Add formal incident/compliance comms cadence artifacts |
| CC2.3 | External communication supports trust commitments | Security disclosure and customer docs exist | Formalize customer/security notice workflow + evidence |

### CC3 — Risk Assessment

| Control | What it means | Breeze starting point | Next step |
|---|---|---|---|
| CC3.1 | Objectives are clear enough to assess risk | Security and availability objectives documented | Maintain objective-to-risk register mapping |
| CC3.2 | Risks are identified/analyzed and responded to | Threat model and security documentation exist | Implement periodic risk review log with treatment decisions |
| CC3.3 | Fraud risk is considered | Audit logs and approval gates exist | Add explicit fraud scenarios and control mapping |
| CC3.4 | Significant change risk is assessed | PR workflow + CI gates | Require risk impact section in change templates |

### CC4 — Monitoring Activities

| Control | What it means | Breeze starting point | Next step |
|---|---|---|---|
| CC4.1 | Ongoing/separate evaluations monitor controls | Monitoring stack and tests present | Establish periodic control effectiveness review calendar |
| CC4.2 | Control deficiencies are communicated and remediated | Issue tracking and runbooks exist | Add formal deficiency register with SLA + closure evidence |

### CC5 — Control Activities

| Control | What it means | Breeze starting point | Next step |
|---|---|---|---|
| CC5.1 | Control activities mitigate identified risks | RBAC, RLS, encryption, and guardrails implemented | Build risk-to-control matrix with owners |
| CC5.2 | Technology controls support objectives | CI, runtime security controls, and infra hardening present | Capture baseline configuration standards + drift checks |
| CC5.3 | Policies/procedures are deployed through operations | Existing docs and runbooks | Add formal policy lifecycle (owner/version/review date) |

### CC6 — Logical and Physical Access Controls

| Control | What it means | Breeze starting point | Next step |
|---|---|---|---|
| CC6.1 | Logical access is restricted to authorized users | JWT/MFA/RBAC in place | Add periodic access review evidence by scope |
| CC6.2 | Prior to issuing access, users are authenticated | Enrollment/auth patterns documented | Formalize identity proofing and joiner workflow evidence |
| CC6.3 | Access provisioning/modification/removal is managed | Role/permission model exists | Document JML process and deprovisioning SLAs |
| CC6.4 | Physical access to assets is restricted | DO-hosted infra and cloud controls | Capture cloud provider physical security reliance memo |
| CC6.5 | Vulnerabilities are identified and addressed | Security scanning stack documented | Maintain vuln SLA tracking + exception approvals |
| CC6.6 | Data is transmitted/processed/stored securely | TLS + encryption + scoped access | Publish crypto/key management standard with rotation evidence |
| CC6.7 | System components are protected from unauthorized software | Signed releases and constrained runtime patterns exist | Add allowlist/hardening verification evidence per environment |
| CC6.8 | Endpoint/mobile/remote access risk is controlled | Agent auth, mTLS option, session controls | Add remote access policy + periodic review artifacts |

### CC7 — System Operations

| Control | What it means | Breeze starting point | Next step |
|---|---|---|---|
| CC7.1 | Systems are monitored for operational anomalies | Prometheus/Grafana/alerts and health checks | Define formal runbook ownership and on-call evidence |
| CC7.2 | Security events are monitored and analyzed | Audit/event telemetry and alerting exist | Add detection-use-case catalog with tuning records |
| CC7.3 | Incidents are responded to and resolved | DR/security runbooks available | Add incident severity matrix + after-action template evidence |
| CC7.4 | Recovery from incidents supports objectives | A1.x recovery docs and testing templates exist | Run recurring exercises and log measured outcomes |
| CC7.5 | Root cause and corrective actions are tracked | Existing issue tracking patterns | Formal CAPA register with due dates and verification |

### CC8 — Change Management

| Control | What it means | Breeze starting point | Next step |
|---|---|---|---|
| CC8.1 | Changes are authorized, tested, approved, and deployed safely | PR + CI/CD patterns established | Enforce change tickets, approver evidence, and rollback proof |

### CC9 — Risk Mitigation

| Control | What it means | Breeze starting point | Next step |
|---|---|---|---|
| CC9.1 | Risks from business/vendor/partner dependencies are identified | Third-party integrations documented | Build vendor risk inventory and review schedule |
| CC9.2 | Commitments with third parties are managed to reduce risk | Integration security controls exist | Add contractual/security requirement tracking and reassessments |

## Processing Integrity (if in scope)

| Control | What it means | Breeze starting point | Next step |
|---|---|---|---|
| PI1.1 | Inputs are complete, valid, accurate, and authorized | Input validation and auth middleware are present | Define critical processing input control tests |
| PI1.2 | Processing is complete, valid, accurate, timely | Jobs/queues and monitoring exist | Add end-to-end reconciliation checks for key workflows |
| PI1.3 | Outputs are complete, accurate, and restricted to authorized recipients | RBAC and scoped APIs in place | Add output integrity checks and export approval logging |
| PI1.4 | Processing errors are detected and corrected | Alerting/logging and retries exist | Formalize error correction playbook + evidence |
| PI1.5 | Processing changes are controlled to preserve integrity | Change management controls exist | Add integrity regression tests to release gates |

## Privacy (if in scope)

| Control | What it means | Breeze starting point | Next step |
|---|---|---|---|
| P1.1 | Privacy policies are defined and communicated | Security/privacy posture docs exist | Publish customer-facing privacy control statement and review cadence |
| P2.1 | Choice and consent are captured/managed | Some user/security controls exist | Define explicit consent records where applicable |
| P3.1 | Personal information collection aligns to notice/consent | Data handling controls exist | Create data-collection inventory by endpoint/feature |
| P3.2 | Collection changes are reviewed for privacy impact | Change process exists | Add privacy impact check to feature/change template |
| P4.1 | Use/retention/access of personal data aligns to commitments | Retention workers and access controls exist | Map personal data uses to legal basis and policy |
| P4.2 | Personal data use is limited to authorized purposes | RBAC/RLS controls exist | Add purpose limitation review evidence |
| P4.3 | Sharing/disclosure is controlled and documented | Integration controls and scopes exist | Maintain third-party disclosure register |
| P5.1 | Data quality is maintained for personal information | Validation and integrity controls exist | Define correction workflows and evidence |
| P5.2 | Personal data is updated/corrected when needed | Existing admin capabilities | Add data correction request workflow tracking |
| P6.1 | Personal data access is restricted to authorized users | RBAC + MFA + RLS in place | Add periodic privacy access recertification |
| P6.2 | Personal data is protected in transit/at rest | TLS + encryption controls implemented | Add encryption coverage attestations per data store |
| P6.3 | Personal data access/changes are logged | Audit logs available | Define privacy-specific audit queries and periodic reviews |
| P6.4 | Transmission/disclosure controls protect personal data | Scoped APIs and integrations | Add DLP/redaction validation for exports/sharing paths |
| P6.5 | Personal data retention/disposal follows policy | C1.2 retention/disposal controls | Add privacy-specific retention matrix and deletion evidence |
| P6.6 | Third-party processors protect personal data | Integration security controls exist | Track processor agreements and annual reassessments |
| P6.7 | Privacy incidents are detected and responded to | Incident handling foundation exists | Add privacy breach triage/notification runbook |
| P7.1 | Data subject access/correction/deletion requests are handled | Core access controls exist | Implement DSAR workflow with SLA evidence |
| P8.1 | Privacy commitments are monitored and updated | Governance docs exist | Establish privacy program review with leadership sign-off |

## Suggested Execution Order

1. Complete all Security Common Criteria (`CC1.x` to `CC9.x`) evidence foundations.
2. Finalize Availability and Confidentiality evidence operation (already drafted).
3. If included in scope, implement Processing Integrity control evidence.
4. If included in scope, define Privacy program boundaries and DSAR/privacy workflows.

## Evidence Packaging Tip

Use one evidence index per domain:

- `SOC_SECURITY_EVIDENCE_INDEX.md`
- `SOC_AVAILABILITY_EVIDENCE_INDEX.md` (already created)
- `SOC_CONFIDENTIALITY_EVIDENCE_INDEX.md`
- `SOC_PROCESSING_INTEGRITY_EVIDENCE_INDEX.md` (if in scope)
- `SOC_PRIVACY_EVIDENCE_INDEX.md` (if in scope)

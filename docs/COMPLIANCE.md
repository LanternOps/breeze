# Compliance Coverage

This document summarizes Breeze compliance controls and API surfaces used for audit workflows.

## SOC Program Walkthrough

- Remaining controls walkthrough (Security, PI, Privacy assumptions):
  - `docs/notes/SOC_REMAINING_CONTROLS_WALKTHROUGH.md`

## SOC 2 Availability (A1.1-A1.3)

- Evidence index and monthly tracker:
  - `docs/notes/SOC_AVAILABILITY_EVIDENCE_INDEX.md`
- Processing capacity notes for Breeze application infrastructure:
  - `docs/notes/SOC_A1.1_CAPACITY_NOTES.md`
- Recovery objectives notes (DigitalOcean-focused planning):
  - `docs/notes/SOC_A1.2_RECOVERY_OBJECTIVES_NOTES.md`
- Recovery testing notes (DigitalOcean-focused planning):
  - `docs/notes/SOC_A1.3_RECOVERY_TESTING_NOTES.md`

## SOC 2 Confidentiality (C1.1-C1.2)

- Confidential data identification notes:
  - `docs/notes/SOC_C1.1_CONFIDENTIAL_DATA_IDENTIFICATION_NOTES.md`
- Confidential data disposal notes:
  - `docs/notes/SOC_C1.2_CONFIDENTIAL_DATA_DISPOSAL_NOTES.md`

## CIS Configuration Hardening

Breeze supports CIS benchmark posture tracking and controlled remediation through `/api/v1/cis/*`.

### Coverage

- Baseline profile management per org and OS (`windows`, `macos`, `linux`)
- Scheduled and on-demand CIS scans
- Device-level score history with per-check findings and evidence
- Check-level remediation queue with audited execution status
- Event emission for deviation, score changes, and remediation application

### Endpoints

- `GET /api/v1/cis/baselines` — list CIS baselines
- `POST /api/v1/cis/baselines` — create/update CIS baseline profile
- `POST /api/v1/cis/scan` — trigger baseline scan
- `GET /api/v1/cis/compliance` — compliance summary + latest score set
- `GET /api/v1/cis/devices/:deviceId/report` — device-level CIS findings
- `POST /api/v1/cis/remediate` — create remediation requests (pending approval)
- `POST /api/v1/cis/remediate/approve` — approve or reject pending remediation requests

### Security Controls

- Baseline mutation requires `orgs.write`
- Scan trigger requires `devices.write`
- Reporting requires `devices.read`
- All CIS tables are protected by org-scoped row-level security policies
- Remediation actions are asynchronously tracked with defined status transitions (`pending_approval` -> `queued` -> `in_progress` -> `completed`/`failed`, or `cancelled` on rejection)
- Remediation execution via the REST API requires explicit approval (`pending_approval` -> `queued`). AI tool-initiated remediations (tier 3, guardrail-gated) are auto-approved and bypass the `pending_approval` step.

### Event Types

- `compliance.cis_deviation`
- `compliance.cis_score_changed`
- `compliance.cis_remediation_applied`

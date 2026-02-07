# Security Implementation Tracker

Last updated: 2026-02-07
Scope: Security observability and enablement across Windows, macOS, Linux, with agent integration and Windows Security Center AV support.

## Status Legend
- `TODO`: not started
- `IN_PROGRESS`: actively being implemented
- `BLOCKED`: waiting on dependency/decision
- `DONE`: implemented and validated

## Priority Order
1. Security observability (real status + persistence + UI truth)
2. Security actions (scan/quarantine/remove/restore via command pipeline)
3. Platform depth and parity hardening

## Workstream A: Agent Unification and Security Port

| ID | Task | Priority | Status | Notes |
|---|---|---:|---|---|
| A1 | Confirm `/agent` as authoritative runtime agent | P0 | TODO | Use `/apps/agent` as donor only |
| A2 | Port `status.go` capabilities from `/apps/agent/internal/security` into `/agent/internal/security` | P0 | TODO | AV/firewall/encryption posture |
| A3 | Port threat scanning/quarantine/remove (`scanner.go`, `threats.go`) into `/agent/internal/security` | P1 | TODO | Signature-based baseline scanner |
| A4 | Wire security collectors into `/agent/internal/heartbeat` periodic loop | P0 | TODO | Send real security telemetry |
| A5 | Add agent tests for security collection and parser logic | P1 | TODO | Unit tests + platform-specific guards |

## Workstream B: Windows AV via Security Center (WSC)

| ID | Task | Priority | Status | Notes |
|---|---|---:|---|---|
| B1 | Add Windows WSC collector (`root/SecurityCenter2 AntiVirusProduct`) | P0 | TODO | Multi-provider AV visibility |
| B2 | Parse WSC product state to realtime/definitions/overall health fields | P0 | TODO | Deterministic state mapping |
| B3 | Add fallback to Defender telemetry when WSC unavailable (esp. Server) | P0 | TODO | Avoid false unknowns |
| B4 | Expose `avProducts[]`, `primaryAvProvider`, `windowsSecurityCenterAvailable` in agent payload | P0 | TODO | First-class model |
| B5 | Validate with Defender-only and third-party AV scenarios | P0 | TODO | Acceptance coverage |

## Workstream C: API Persistence and Command Wiring

| ID | Task | Priority | Status | Notes |
|---|---|---:|---|---|
| C1 | Replace seeded security route data with DB-backed queries | P0 | TODO | `/apps/api/src/routes/security.ts` |
| C2 | Add security ingestion endpoints under agent routes | P0 | TODO | status/threats/scan results |
| C3 | Add security command types to command queue | P0 | TODO | scan/quarantine/remove/restore |
| C4 | Dispatch security actions from security routes to command queue | P0 | TODO | End-to-end execution |
| C5 | Enforce org-safe query boundaries and remove shared mutable state | P0 | TODO | Multi-tenant safety |

## Workstream D: UI Enablement (Real Data)

| ID | Task | Priority | Status | Notes |
|---|---|---:|---|---|
| D1 | Keep Antivirus/Firewall/Encryption/Vulnerabilities pages fully API-backed | P0 | TODO | Validate all filters and pagination |
| D2 | Convert `SecurityScanManager` from static demo to live API + actions | P0 | TODO | Start/track scans |
| D3 | Convert `DeviceSecurityStatus` from static demo to per-device API data | P1 | TODO | Include AV provider details |
| D4 | Convert `ThreatList` and `ThreatDetail` to live data flows | P1 | TODO | Action buttons fully wired |
| D5 | Normalize security policy editor API paths and persistence behavior | P1 | TODO | Remove mixed `/api/security` usage |

## Workstream E: Validation and Release Readiness

| ID | Task | Priority | Status | Notes |
|---|---|---:|---|---|
| E1 | API tests for security routes with real DB behavior | P0 | TODO | Replace seed-only assumptions |
| E2 | Agent integration tests for command lifecycle (dispatch->execute->result) | P0 | TODO | Security action commands included |
| E3 | UI smoke tests for security pages/actions | P1 | TODO | Prevent demo regressions |
| E4 | Rollout checklist and migration notes | P1 | TODO | Production readiness |

## Milestones

| Milestone | Includes | Target Outcome |
|---|---|---|
| M1: Observability Baseline | A1-A4, B1-B4, C1-C2, D1 | Real, persisted fleet security status across OSes |
| M2: Action Pipeline | C3-C4, D2-D4, E2 | Scan/quarantine/remove/restore work end-to-end |
| M3: Hardening | A5, B5, C5, D5, E1/E3/E4 | Stable multi-tenant production-ready behavior |

## Acceptance Criteria (Must Pass)

1. Windows endpoint with third-party AV reports provider and health from WSC.
2. Windows endpoint without WSC data falls back to Defender-based status cleanly.
3. macOS and Linux endpoints report firewall + encryption from real collectors.
4. Security dashboard and detail pages read only persisted API data (no seeded state).
5. Security actions queue commands and reflect real completion/failure results.

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
| A1 | Confirm `/agent` as authoritative runtime agent | P0 | DONE | `/agent` now contains runtime security implementation |
| A2 | Port `status.go` capabilities from `/apps/agent/internal/security` into `/agent/internal/security` | P0 | DONE | AV/firewall/encryption posture with API-aligned payload |
| A3 | Port threat scanning/quarantine/remove (`scanner.go`, `threats.go`) into `/agent/internal/security` | P1 | DONE | Scanner and quarantine/remove operations now in runtime agent |
| A4 | Wire security collectors into `/agent/internal/heartbeat` periodic loop | P0 | DONE | Periodic security inventory submission + command handlers wired |
| A5 | Add agent tests for security collection and parser logic | P1 | TODO | Unit tests still needed for WSC parser and scan/result edge cases |

## Workstream B: Windows AV via Security Center (WSC)

| ID | Task | Priority | Status | Notes |
|---|---|---:|---|---|
| B1 | Add Windows WSC collector (`root/SecurityCenter2 AntiVirusProduct`) | P0 | DONE | WSC collector added in `/agent/internal/security/windows_security_center_windows.go` |
| B2 | Parse WSC product state to realtime/definitions/overall health fields | P0 | DONE | Product state parsing maps real-time and definition freshness |
| B3 | Add fallback to Defender telemetry when WSC unavailable (esp. Server) | P0 | DONE | Defender status fallback retained and merged into payload |
| B4 | Expose `avProducts[]`, `primaryAvProvider`, `windowsSecurityCenterAvailable` in agent payload | P0 | DONE | Agent payload includes AV products + WSC availability |
| B5 | Validate with Defender-only and third-party AV scenarios | P0 | TODO | Needs live Windows validation across endpoint variants |

## Workstream C: API Persistence and Command Wiring

| ID | Task | Priority | Status | Notes |
|---|---|---:|---|---|
| C1 | Replace seeded security route data with DB-backed queries | P0 | DONE | `/apps/api/src/routes/security.ts` rewritten to DB-backed behavior |
| C2 | Add security ingestion endpoints under agent routes | P0 | DONE | `PUT /api/v1/agents/:id/security/status` + command result post-processing |
| C3 | Add security command types to command queue | P0 | DONE | Security command constants + auditing added |
| C4 | Dispatch security actions from security routes to command queue | P0 | DONE | Scan/threat actions queue agent commands |
| C5 | Enforce org-safe query boundaries and remove shared mutable state | P0 | DONE | Recommendation actions now persisted via `audit_logs` (no in-process mutable state) |

## Workstream D: UI Enablement (Real Data)

| ID | Task | Priority | Status | Notes |
|---|---|---:|---|---|
| D1 | Keep Antivirus/Firewall/Encryption/Vulnerabilities pages fully API-backed | P0 | DONE | Core pages consume DB-backed security endpoints |
| D2 | Convert `SecurityScanManager` from static demo to live API + actions | P0 | DONE | Component now loads devices/scans and queues scans |
| D3 | Convert `DeviceSecurityStatus` from static demo to per-device API data | P1 | DONE | Component now fetches live provider/protection posture |
| D4 | Convert `ThreatList` and `ThreatDetail` to live data flows | P1 | DONE | Components now fetch and execute threat actions |
| D5 | Normalize security policy editor API paths and persistence behavior | P1 | DONE | Security policy editor now uses normalized `/security/*` API paths |

## Workstream E: Validation and Release Readiness

| ID | Task | Priority | Status | Notes |
|---|---|---:|---|---|
| E1 | API tests for security routes with real DB behavior | P0 | DONE | Route tests updated for DB-backed flows and passing |
| E2 | Agent integration tests for command lifecycle (dispatch->execute->result) | P0 | DONE | Heartbeat security command lifecycle tests added and passing |
| E3 | UI smoke tests for security pages/actions | P1 | DONE | React smoke tests added for security scan/threat/device action flows |
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

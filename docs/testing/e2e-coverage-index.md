# E2E Coverage Index

Living pointer for the `e2e-coverage` skill. Each sweep reads the most recent row to find its baseline and what's already covered, then adds a row when done. Most-recent first.

| Baseline | Last swept commit | Date | Plan / Results | Coverage |
|---|---|---|---|---|
| `v0.68.2` | `cba95590` (branch `feat/google-identity-device-tasks`) | 2026-06-01 | [results](./FEATURE_TEST_LOG.md) (entry "Since-Release E2E Sweep") | Partial — credential-free items only. PASS: identity route auth, devices columns/filters, Google/M365 connection UIs, org-axis RBAC, patch-pin, notif-link. FAIL→FIXED: Fix-with-AI org binding (branch `fix/ai-session-device-org-binding`). NEEDS-CREDS: Google/M365 tenant flows, live-agent items, SSRF egress. DEFERRED: intra-org site-axis (seed). |
| `v0.66.1` | `2719f10d` (main) | 2026-05-26 | [plan](./v0.66.1-to-HEAD-test-plan.md) · [results](./v0.66.1-to-HEAD-test-results.md) | Full P0/P1 sweep. 1 bug found+fixed (`/devices` list dropped `watchdogStatus`/`mainAgentSilentSince`). |

## Carry-forward (open across sweeps)

Recheck these at the start of the next sweep — clear them when creds/agents/data become available:

- **NEEDS-CREDS** — Google Workspace + M365 real-tenant flows (connect, offboard/wipe, drift dashboard, helpdesk tools, OData escaping on live data); live Win/macOS agent items (macOS `.pkg` sig verify, quarantine re-enroll, remote-desktop self-heal/revocation); SSRF live egress trigger.
- **DEFERRED — seed** — intra-org site-axis RBAC (needs a 2nd site with devices in one org).

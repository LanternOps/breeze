# EDR Operations Surfacing — Phase Plan

> **Status:** Phase plan / design doc for review. This is a *scoping* document, not a
> bite-sized TDD implementation plan. Each pillar below gets its own
> `docs/superpowers/plans/` implementation plan (written with `superpowers:writing-plans`)
> once scope is locked. Open decisions at the bottom must be resolved before Pillar 1 starts.

**Goal:** Surface the SentinelOne and Huntress data we already sync — and the actions the API
already supports — in the places technicians actually work (device detail, fleet lists, the
dashboard), then connect that EDR signal to the existing Incident Response module so a threat can
be escalated, contained, and tracked end-to-end.

**Author:** Todd Hebebrand · **Date:** 2026-06-25 · **Branch:** `huntress-sentinelone-ui-plan`

---

## Background — the stranded-investment problem

Both EDR integrations have mature backends and **almost no operational UI**. Verified during research:

| Capability | Backend | UI surface today |
|---|---|---|
| Huntress config + org mapping + webhook | `routes/huntress.ts`, `HuntressIntegration.tsx` | ✅ Integrations → Security → Huntress |
| Huntress incidents (`/huntress/incidents`, paginated, site-scoped) | ✅ | ❌ **5-row preview in the config panel only** |
| S1 config + site mapping + coverage | `routes/sentinelOne.ts`, `SecurityIntegration.tsx` | ✅ Integrations → Security → SentinelOne |
| S1 threats (`GET /s1/threats`) | ✅ | ❌ **nowhere** |
| S1 isolate / un-isolate (`POST /s1/isolate`) | ✅ (MFA + `devices:execute`) | ❌ **no button anywhere** |
| S1 threat-action kill/quarantine/rollback (`POST /s1/threat-action`) | ✅ | ❌ **nowhere** |
| Automation triggers (`s1.*`, `huntress.*`) | ✅ | ✅ AutomationForm |
| AI tools (query + Tier-3 actions) | ✅ | ✅ via AI agent |

**Critical confirmation:** `DeviceSecurityTab.tsx` and the fleet `ThreatList.tsx` both fetch the
**generic** `/security/threats` endpoint — that is the agent's *own* AV detections
(`security_threats` table). Neither view unions S1 threats or Huntress incidents. A human in the
console literally cannot see a Huntress incident or isolate an S1 device today.

### The Incident Response module (`incidents` page)

`BE-32: Incident response automation (#305)`, March 2026 — **predates both EDR integrations**
(Huntress migration `0049`, S1 `0052`). It is a general-purpose IR / war-room module:

- `incidents` — severity `p1–p4`, lifecycle `detected → analyzing → contained → recovering → closed`,
  `relatedAlerts[]`, `affectedDevices[]`, `timeline[]`, assignee.
- `incident_evidence` — forensic evidence with SHA-256 hash / chain-of-custody.
- `incident_actions` — containment actions with `reversible`, `approvalRef`, actor `user|brain|system`.

It is **wired but starved**: populated today only by manual create (`POST /incidents`), the AI brain
(`aiToolsIncident.ts`: `create_incident`, `execute_containment`), and audit-chain tamper detection.
Nothing routinely feeds it — which is why it looks unused. Its `affectedDevices[]` / `relatedAlerts[]`
/ reversible-containment-with-approval schema is *exactly* the right escalation target for EDR signal.
**Pillar 4 connects them.**

---

## Huntress API capability (researched 2026-06-25 — corrects an earlier assumption)

Our `huntressClient.ts` is **read-only today** — it only `GET`s `/agents`, `/incident_reports`,
`/organizations`. But the Huntress public API is **no longer read-only**. Per the Huntress changelog
"APIs for Escalations and Incident Report responses now available":

- `POST /v1/incident_reports/{id}/resolution` — resolve a single incident report (all remediations
  must be approved first). ("Create Incident Resolution.")
- Bulk **Approve** / **Deny** Remediations for an incident report; List Remediations.
- **Escalations API** — list, get details, resolve common escalations.

Auth is unchanged from what we already do (API key pair → Basic auth, base `api.huntress.io/v1/`).

**Implication:** Pillar 4's Huntress write-back is *feasible*, but it is **net-new client code** —
`huntressClient.ts` currently has no write methods, and we don't yet sync remediations or escalations.
So a true two-way Huntress flow is a scoped add-on, not free. S1 is already fully two-way.

Sources:
- https://feedback.huntress.com/changelog/apis-for-escalations-and-incident-report-responses-now-available
- https://support.huntress.io/hc/en-us/articles/4780697192851-Huntress-REST-API-Overview
- https://www.huntress.com/blog/huntress-api-is-now-in-public-beta

---

## The phase, as four pillars

Sequence **1 → 2 → 3**, each independently shippable. **4** is a follow-on that depends on 1–2.

### Pillar 1 — Device-detail EDR panel  *(highest value, reuses existing endpoints)*

On the device Security tab, add an **Endpoint Protection** section distinct from the native-AV
"Recent Threats" card:

- S1 threats for the device via `GET /s1/threats?deviceId=<id>`; Huntress incidents via
  `GET /huntress/incidents?deviceId=<id>`.
- S1 inline actions: **Isolate / Un-isolate** (`POST /s1/isolate`) and **kill / quarantine / rollback**
  (`POST /s1/threat-action`), each behind a confirm modal (API already enforces MFA + `devices:execute`).
- Huntress incidents render read-only (severity / status / category / recommendation) in this phase.

**Files:** `apps/web/src/components/devices/DeviceSecurityTab.tsx` (add EDR section, or extract a new
`DeviceEdrPanel.tsx` it renders); new `apps/web/src/lib/edr.ts` shared types/fetchers; wrap all
mutations in `runAction` per the web-mutation convention. No API changes.

### Pillar 2 — Fleet EDR pages

New **Security → EDR** area with two tabs:

- **SentinelOne Threats** — `GET /s1/threats` with filters (severity / status / org / device / search /
  date); row → device; inline isolate + threat-action.
- **Huntress Incidents** — `GET /huntress/incidents` with the same filter shape; row → device; read-only.

**Files:** `apps/web/src/pages/security/edr.astro`; `apps/web/src/components/security/EdrPage.tsx`
(tab shell), `S1ThreatList.tsx`, `HuntressIncidentList.tsx`; reuse `ResponsiveTable` + severity-badge
patterns from `ThreatList.tsx`; add a sidebar entry next to the existing Security links. No API changes.

### Pillar 3 — Dashboard surfacing

Add to `SecurityDashboard.tsx` (and/or the main dashboard): **open Huntress incidents**, **active S1
threats**, **isolated-devices count**, and **EDR coverage gaps** (mapped vs. unmapped agents; devices
with no EDR agent). The numbers already exist in `GET /huntress/status` and `GET /s1/status` — this is
aggregation + presentation, no new query work.

**Files:** `apps/web/src/components/security/SecurityDashboard.tsx`, reuse `SecurityStatCard.tsx`;
possibly one thin `GET /security/edr-summary` aggregator if we don't want the dashboard fanning out to
both status endpoints client-side (decision D4).

### Pillar 4 — EDR → Incident escalation  *(the reframe; depends on 1–2)*

Turn the starved Incident Response module into the top of the EDR funnel.

- **Promote to Incident** action on an S1 threat or Huntress incident (device panel + fleet list):
  `POST /incidents` with `relatedAlerts` / `affectedDevices` prefilled and an opening `timeline` entry.
- **Containment logged as incident actions:** when an S1 isolate/quarantine/rollback is performed from
  *inside* an incident, also write an `incident_actions` row (`reversible`, `approvalRef`). The IR
  `containIncidentSchema` / `execute_containment` shape already matches the S1 action API — they just
  aren't connected.
- **Huntress write-back (scoped add-on, decision D3):** if we resolve a promoted Huntress incident in
  Breeze, optionally call `POST /v1/incident_reports/{id}/resolution` (+ approve remediations) via
  **new** write methods in `huntressClient.ts`. Requires syncing remediation state first.
- **Optional auto-file:** on a `p1`/critical `s1.threat_detected` or `huntress.incident_created`,
  auto-create an incident from the existing event triggers so the page gets organic inflow.

**Files:** `apps/api/src/routes/incidents.ts` / `incidentActions.ts` (escalation + action-logging
endpoints if not already sufficient); `apps/api/src/services/huntressClient.ts` (new write methods,
D3 only); `apps/api/src/services/eventBus.ts` consumers for auto-file; web: "Promote to Incident"
controls in the Pillar 1/2 components + `IncidentDetailPage.tsx` to show EDR-sourced evidence/actions.

---

## Cross-cutting requirements (apply to every pillar)

- **Web mutations** wrap requests in `runAction` (`apps/web/src/lib/runAction.ts`); add any new mutation
  handlers to the `no-silent-mutations` allowlist if they qualify.
- **Site-scope:** `/s1/threats` and `/huntress/incidents` already enforce site-scope narrowing —
  preserve it; don't widen via a new aggregator that bypasses it.
- **Destructive S1 actions** keep MFA + `devices:execute`; UI adds a confirm modal, never one-click.
- **No new tenant-scoped tables** are required for Pillars 1–3. Pillar 4 reuses existing `incidents*`
  tables; any new Huntress remediation table (D3) follows the RLS workflow in `CLAUDE.md`.
- **Tests:** API route tests + web component tests per the `breeze-testing` skill; Pillar 4 IR changes
  need RLS coverage if any schema is added.

---

## Open decisions (resolve before Pillar 1)

- **D1 — IA:** provider-specific tabs (recommended, ships faster, matches the bespoke-per-integration
  pattern) **vs.** one unified cross-provider threat stream (S1 + Huntress + native AV). Unify later.
- **D2 — S1 device-level isolate in this phase?** Recommended **yes**, confirm-modal + existing MFA gate.
- **D3 — Huntress write-back scope:** (a) read-only in this phase, drive containment via Breeze/agent
  only; **vs.** (b) build the new `huntressClient` write methods + remediation sync for true two-way.
  Recommend **(a) for Pillars 1–3, defer (b) into Pillar 4** as an explicit sub-scope.
- **D4 — Dashboard data path:** client fans out to both `status` endpoints **vs.** one new
  `GET /security/edr-summary` aggregator. Recommend the aggregator if Pillar 3 widgets multiply.
- **D5 — Auto-file incidents** on critical EDR events in this phase, or hold until promote-to-incident
  is proven manually? Recommend **manual promote first**, auto-file as a fast follow.

---

## Out of scope (named, not silently dropped)

- New EDR providers (Defender, CrowdStrike, Bitdefender) — framework is extensible but not this phase.
- Huntress agent install/deploy orchestration from Breeze.
- Rewriting the native-AV `ThreatList` / `DeviceSecurityTab` to be cross-provider (that's the D1
  "unify" path, deferred).

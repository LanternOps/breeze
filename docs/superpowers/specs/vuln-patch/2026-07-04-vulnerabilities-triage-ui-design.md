# Vulnerabilities Fleet Page — Triage UI Enhancement (Design)

**Date:** 2026-07-04
**Status:** Approved design, pending implementation plan
**Route:** `/vulnerabilities` (top-level fleet page — NOT `/security/vulnerabilities`, which is the EDR threats list)

## Problem

The fleet `/vulnerabilities` page (`apps/web/src/components/vulnerabilities/VulnerabilityTable.tsx`, 148 lines) is a read-only 6-column per-CVE table with a single severity filter. The backend (BE-16 phases 1–3) is far richer: triage statuses (open/patched/mitigated/accepted), accept-risk with reason+expiry, mitigate, reopen, bulk remediate wired to approved patches, EPSS/KEV/risk scoring, per-finding patch availability — all surfaced only on the per-device tab (`DeviceVulnerabilitiesTab.tsx`). Technicians cannot triage from the fleet view, and the per-CVE grain means one Chrome update shows as ~30 identical Critical rows.

## Decisions (user-approved)

- **Workflow:** fix-first remediation queue (not risk-review dashboard).
- **Primary grain:** software/product — one row ≈ one remediation action. Per-CVE view retained as a second tab.
- **Scope:** full-stack — new aggregation/bulk endpoints, one migration (ticket linkage).
- **Actions:** remediate, accept-risk, mitigate, reopen (all existing server-side) **plus** create-ticket (net-new linkage to native ticketing).
- **Detail view:** right-side slide-over drawer, hash-selected. Extracted from the existing catalog drawer chrome, not invented new.

## UX Design

### Page structure

1. **Header + stat cards** (reuse `SecurityStatCard` pattern from the security page). Four clickable cards that apply the matching filter:
   - **Critical open** — open findings with severity critical.
   - **KEV exposure** — known-exploited CVEs present, with affected-device count.
   - **Patch ready** — open findings with an approved patch pending ("fixable right now").
   - **Accepted, expiring soon** — acceptances with `acceptedUntil` within 14 days.
2. **Tabs** (hash-based, app convention): `#software` (default work queue) and `#cves` (report view). Drawer sub-selection: `#software/<groupKey>`, `#cves/<cveId>`.
3. **Filter bar** shared across tabs: text search (software name or CVE id), severity select, status select (default **Open**), KEV-only toggle, patch-available toggle.

### By-software table (default tab)

One row per remediation unit, sorted by max risk score desc:

| Software (name, vendor, affected version range) | Worst severity (+KEV flag) | Risk (max) | CVEs | Devices | Patch ("Ready · 12/14 devices" / "—") |

OS-level CVEs (from `os_vulnerabilities`; findings without a software product) roll into per-platform pseudo-groups ("Windows OS updates", "macOS updates") so nothing falls out of the queue.

### By-CVE table

Today's table plus: EPSS column, patch-available column, status column (when the status filter ≠ open), row click opens the CVE drawer. The existing fleet endpoint `GET /vulnerabilities` already supports `status`/`severity`/`cve`; it gains `kevOnly` and `patchAvailable` params so the shared filter bar works identically on both tabs.

Mobile: both tabs keep the `ResponsiveTable`/`DataCard` pattern.

### Drawer

**Shared primitive** `apps/web/src/components/shared/Drawer.tsx`, extracted verbatim from the chrome of `settings/CatalogItemEditorDrawer.tsx:441-458` (portal, `dialog-backdrop` backdrop + `justify-end`, `drawer-panel` with `slide-in-from-right` animation from `globals.css`, header with close button) and its a11y block (`:177-207`: focus-first, scroll-lock, Escape, Tab focus-trap, focus restore). Props: `open`, `onClose`, `title` (node), `width` (default `max-w-md`; vuln page uses `max-w-xl`), `data-testid`, children. Optional low-risk cleanup task: refactor `CatalogItemEditorDrawer` to consume it (markup identical).

**Software-group drawer** (`#software/<groupKey>`):
- Header: name + vendor, worst-severity badge, KEV flag, max risk.
- CVE section: compact list (CVE id, severity, CVSS, EPSS, KEV), each linking to `#cves/<id>`.
- Devices section: affected devices with per-device finding status, patch availability, checkboxes (all selected by default).
- Action bar (permission-gated, all `runAction`):
  - **Remediate** (`devices:execute` + MFA) — existing bulk endpoint; surfaces per-item skip reasons.
  - **Accept risk** (`vulnerabilities:accept_risk`) — reason + future expiry modal (same as device tab), new bulk endpoint.
  - **Mitigate** (`devices:write`) — note modal, new bulk endpoint.
  - **Create ticket** — pre-filled ticket modal; on create, findings link to the ticket; drawer shows a ticket chip thereafter.

**CVE drawer** (`#cves/<cveId>`): description, published/modified, reference links, CVSS vector, EPSS, KEV; affected-device list with same selection + action bar scoped to the CVE. **Reopen** shown on accepted/mitigated findings (`vulnerabilities:accept_risk`).

Actions refresh table + stat cards; partial success → summary toast ("12 scheduled, 2 skipped — no approved patch").

## Backend Design

All new routes live in `apps/api/src/routes/vulnerabilities.ts` under the existing middleware stack (`authMiddleware`, `requireScope`, `requirePermission(devices:read)`, site-axis filtering; org isolation via RLS). Aggregation logic goes in a new unit-testable service `apps/api/src/services/vulnerabilityFleetAggregation.ts`.

### Read endpoints

1. `GET /vulnerabilities/software` — groups `device_vulnerabilities` by remediation unit. **Group key (opaque, URL-safe):** `sw:<normalized name>|<normalized vendor>` (URL-encoded; derived from the finding's `software_inventory` row, normalized the same way the correlation pipeline normalizes to `software_products`) for software findings, or `os:<platform>` (`os:windows`, `os:macos`, …) for OS findings (`softwareInventoryId` null). The key must be stable across requests so `#software/<groupKey>` deep links work. Query params: `status` (default open), `severity`, `search` (software name or CVE), `kevOnly`, `patchAvailable`. Returns per group: `groupKey, kind ('software'|'os'), name, vendor, deviceCount, cveCount, worstSeverity, maxRiskScore, kevCveCount, maxEpss, patchReadyFindingCount, ticketIds`. Sorted maxRiskScore desc. No pagination — group cardinality is fleet-bounded; hard cap (500) + `hasMore` flag.
2. `GET /vulnerabilities/software/:groupKey` — drawer payload: group's CVEs (id, severity, cvssScore, epssScore, knownExploited, riskScore) + per-device findings (deviceVulnerabilityId, deviceId, deviceName, orgId/orgName, status, patchAvailable, detectedAt, ticketId).
3. `GET /vulnerabilities/stats` — the four stat-card numbers in one call.
4. `GET /vulnerabilities/:cveId/devices` — CVE drawer payload: fleet-wide affected devices + findings for one CVE (same finding shape as above) + the CVE catalog record (description, references, vector, dates).

### Mutation endpoints

- `POST /vulnerabilities/bulk/accept-risk` `{ deviceVulnerabilityIds (1–200), reason (1–2000), acceptedUntil (future ISO) }` — `vulnerabilities:accept_risk`; per-item audit (`vulnerability.accept_risk`).
- `POST /vulnerabilities/bulk/mitigate` `{ deviceVulnerabilityIds (1–200), note (1–2000) }` — `devices:write`; per-item audit.
- Bulk remediate: existing `POST /vulnerabilities/remediate` unchanged. Reopen: existing per-finding `POST /:id/reopen` unchanged.
- `POST /vulnerabilities/tickets` `{ deviceVulnerabilityIds (1–200), title, description, priority }` — gated on ticketing write permission; creates ticket(s) via the existing ticketing service. Ticket org = findings' org; a cross-org selection creates one ticket per org. Stamps `ticket_id` on the findings; audited.

Bulk endpoints are per-item fault-tolerant: `{ success, succeeded, skipped: [{id, reason}] }` — never fail the whole batch on one bad id (matches remediate's contract).

### Schema / migration

`apps/api/migrations/2026-07-04-device-vulnerabilities-ticket-link.sql` (idempotent, no inner BEGIN/COMMIT):
- `ALTER TABLE device_vulnerabilities ADD COLUMN IF NOT EXISTS ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL;`
- Partial index on `ticket_id WHERE ticket_id IS NOT NULL`.
- Existing tenant table with RLS already forced — no policy changes, no allowlist changes. Drizzle schema updated in `apps/api/src/db/schema/vulnerabilityManagement.ts`; `pnpm db:check-drift` must pass.

## Permissions & Error Handling

- Web buttons gated via `usePermissions().can(...)`; hidden when unpermitted (device-tab convention). Remediate surfaces the MFA-required 403 cleanly.
- All mutations wrapped in `runAction`; new components added to the `no-silent-mutations` targeted set (bump the count constant in the same PR).
- Drawer fetch failure → inline retry; filtered-empty state → clear-filters link.

## Testing

- **API route tests** (Vitest + Drizzle mocks): auth/RBAC per endpoint, validation bounds, 200-id caps, per-item skip paths, cross-org ticket split, `ticket_id` stamping.
- **Aggregation unit tests** (`vulnerabilityFleetAggregation`): grouping key resolution, OS pseudo-groups, worst-severity/max-risk/patch-ready math, filter application.
- **Web component tests**: software table render, drawer open/close via hash, action flows with mocked fetch, permission-hiding, stat-card filter application.
- **E2E** (Playwright, `data-testid` only): open queue → open drawer → accept risk happy path.
- No RLS coverage changes (no new tables).

## Out of Scope

- Dual-control co-sign for critical/KEV waivers (explicitly deferred in the RBAC spec).
- PSA (external) ticket sync — native ticketing only.
- Network-device vulnerabilities (BE-16 phase 5).
- Changes to `/security/vulnerabilities` (EDR threats page).

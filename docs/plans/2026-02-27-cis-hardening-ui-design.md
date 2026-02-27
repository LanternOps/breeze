# CIS Hardening UI Design

**Date**: 2026-02-27
**Branch**: codex/be-26-configuration-hardening-baselines-cis-benchmarks
**Status**: Approved

## Context

The CIS hardening backend is complete (schema, routes, jobs, AI tools) but has no frontend UI. This design adds a single-page dashboard for MSP admins to monitor CIS benchmark compliance across their fleet.

## Target User

MSP admin managing CIS compliance across many customer organizations and devices. Primary need: see what's failing and needs attention right now.

## Design Decisions

- **Single tabbed page** at `/cis-hardening` (not hub+detail or embedded in Security)
- **Remediation is AI-only** — the UI shows remediation status read-only; approve/reject lives in the AI chat sidebar
- **Failing devices first** — default sort by score ascending so worst devices surface immediately
- **Follows existing patterns** — matches SecurityDashboard stat cards + ConfigPolicyList table patterns

## Navigation

Add "CIS Benchmarks" to Sidebar under the Monitoring section (alongside Security, AI Risk Engine).
- Icon: `ShieldCheck` from Lucide
- Route: `/cis-hardening`

## Page Layout

```
┌────────────────────────────────────────────────────────┐
│  CIS Hardening                            [Refresh]    │
├────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ Avg Score│  │ Failing  │  │ Baselines│  │ Pending│ │
│  │   78%    │  │  12 devs │  │  5 active│  │ 3 remed│ │
│  └──────────┘  └──────────┘  └──────────┘  └────────┘ │
│                                                        │
│  [Compliance] [Baselines] [Remediations]               │
│                                                        │
│  (tab content below)                                   │
└────────────────────────────────────────────────────────┘
```

### Summary Cards

| Card | Value | Color Logic | API Source |
|------|-------|-------------|------------|
| Average Score | Percentage with score bar | >=80 green, 60-79 amber, <60 red | `GET /cis/compliance` → `summary.averageScore` |
| Failing Devices | Count | Red if >0, green if 0 | `summary.failingDevices` |
| Active Baselines | Count | Neutral | `GET /cis/baselines?active=true` → `pagination.total` |
| Pending Remediations | Count | Amber if >0 | Count of actions with `status` in `pending_approval`, `queued`, `in_progress` |

### Tab 1: Compliance (default)

Primary view — "what needs fixing."

**Filters**: Org dropdown, OS type dropdown, score range, hostname search.

**Table columns**:
- Device (hostname)
- Org
- Baseline (name)
- OS
- Score (number + colored progress bar)
- Failed Checks (count)
- Last Scanned (relative time)

**Default sort**: Score ascending (worst first).

**Row expansion**: Click to expand inline showing failed checks list with severity badge, check ID, title, and evidence summary. Uses `GET /cis/devices/:deviceId/report`.

### Tab 2: Baselines

CRUD list of baseline profiles.

**Table columns**:
- Name
- OS Type
- Level (L1/L2/Custom badge)
- Benchmark Version
- Schedule (enabled/disabled pill)
- Devices Scanned (count from latest compliance data)
- Actions (Edit, Toggle Active, Trigger Scan)

**Create**: "New Baseline" button opens modal/form with: name, OS type, benchmark version, level, scan schedule (enabled, interval hours), custom exclusions.

**Edit**: Same form, pre-filled.

### Tab 3: Remediations

Read-only status view of remediation actions.

**Table columns**:
- Check ID
- Device (hostname)
- Baseline
- Action (apply/rollback)
- Status (badge)
- Approval Status (badge)
- Requested (timestamp)
- Completed (timestamp or dash)

**Status badge colors**:
- `pending_approval`: amber
- `queued`: blue
- `in_progress`: sky
- `completed`: green
- `failed`: red
- `cancelled`: gray

No approve/reject buttons — remediation initiated via AI chat only.

## File Structure

```
apps/web/src/pages/cis-hardening/
  index.astro                    # Astro page wrapper

apps/web/src/components/cisHardening/
  CisHardeningPage.tsx           # Main page component with tabs
  CisSummaryCards.tsx            # Top stat cards row
  CisComplianceTab.tsx           # Compliance table + filters + row expansion
  CisComplianceRow.tsx           # Expandable row with failed checks detail
  CisBaselinesTab.tsx            # Baselines CRUD list
  CisBaselineForm.tsx            # Create/edit baseline modal
  CisRemediationsTab.tsx         # Read-only remediation status table
```

## API Endpoints Used

| Endpoint | Tab | Purpose |
|----------|-----|---------|
| `GET /api/v1/cis/compliance` | Summary + Compliance | Fleet compliance with scores, summary stats |
| `GET /api/v1/cis/baselines` | Summary + Baselines | List baselines with counts |
| `GET /api/v1/cis/devices/:deviceId/report` | Compliance (expand) | Device-level findings detail |
| `POST /api/v1/cis/baselines` | Baselines | Create/update baseline |
| `POST /api/v1/cis/scan` | Baselines | Trigger scan for a baseline |
| `GET /api/v1/cis/remediate` (needs new endpoint or filter on actions) | Remediations | List remediation actions |

## Notes

- The remediations tab may need a new list endpoint (`GET /api/v1/cis/remediations`) since the current API only has POST endpoints for remediation. This should return paginated remediation actions filtered by org scope.
- Score color thresholds align with `CIS_COMPLIANCE_THRESHOLD = 80` from the backend.
- Loading states use skeleton grids matching existing SecurityDashboard pattern.
- Error states show alert banner with retry button.

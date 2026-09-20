---
tracking_issue: (set by feature-lifecycle after registration)
spec: docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md
diagrams: docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-diagrams.html
---

# Alerting Consolidation — Plan Index

One domain (Alerts) with three facets (Monitors · Inbox · Delivery); every legacy alert-authoring
surface converted into monitors and removed; one delivery precedence with a visible default; one
sweep. Five waves, six plan files. Each plan is self-contained; read the spec first, then the plan.

| Wave | Plan | PRs | Depends on | Ships |
|---|---|---|---|---|
| W05a — stop the bleeding | `2026-09-19-alerting-consolidation-w05a-stop-the-bleeding.md` | 2 | — | false copy deleted; duplicate-condition warning; Create monitor + Recommended strip on the policy Monitors tab; creation frozen on policy Alerts / Service & Process / Alert Templates; dead routing filter fields rejected; orphaned editors, `hub.*` keys and `/monitoring/*` stubs deleted; 09-08 spec marked superseded |
| W05b — delivery | `2026-09-19-alerting-consolidation-w05b-delivery.md` | 3 | — | `resolveDelivery`; routing `escalation_policy_id` / `is_default` / `monitorKinds`; default-row migration; Delivery page (Channels · Routing · Escalation policies); `/alerts/channels` → 301; Notify card shows resolved inheritance; all-channels fallback deleted |
| W05c1 — conversion (API) | `2026-09-19-alerting-consolidation-w05c1-conversion-api.md` | 3 | W05a, W05b, **#6342, #6343, #6344 merged** | `composite` kind; restart params; `consecutiveFailures` 100; `inheritance` link setting; retirement columns; `monitor_conversions` + outputs; converter + preview + equivalence check + open-alert carry-over; routes; payload `monitorId`/`kind`; onboarding writes attachments |
| W05c2 — conversion (web, tools, docs) | `2026-09-19-alerting-consolidation-w05c2-conversion-web-and-tools.md` | 3 | W05c1 | Needs-conversion panel + Convert everything; library banner; Alert workflows filter; device Monitoring tab; Alert Templates pages deleted; Fleet Designer + AI tools on monitors; docs + release notes |
| W05d — retirement | `2026-09-19-alerting-consolidation-w05d-retirement.md` | 2 | W05c shipped **in a prior release** | system sweep of leftovers; settings re-key; policy Alerts / S&P tabs, `/alerts/rules`, legacy write routers (410), `evaluateDeviceAlertsFromPolicy`, migrate script deleted; `RETIRED_CONFIG_FEATURE_TYPES`; startup count check |
| W05e — network checks | `2026-09-19-alerting-consolidation-w05e-network-checks.md` | 3 | W05d, **#6352, #6353 merged** | `network_monitors` converted to `network_check` monitors; Network page loses check authoring; nav → Network; AI network tools refuse creation |

## Program-wide constraints (every plan restates the ones that bind it)

- Migration names must sort after the newest committed file on `origin/main`
  (`2026-10-21-100200-billing-profiles-permissions.sql` at planning time). Assigned:
  W05b `2026-10-23-100000-…`, W05c1 `2026-10-23-110000-…` / `2026-10-23-120000-…`,
  W05d `2026-10-24-100000-…`, W05e `2026-10-24-110000-…`. Re-check before pushing.
- No source row is ever deleted by this program: `retired_at` + `converted_to_monitor_id`.
- Nothing stops firing silently: every unconvertible row is listed with a reason.
- One resolver for delivery (`services/delivery/resolveDelivery.ts`), used by dispatch and preview.
- Cross-wave names are fixed in each plan's **Interfaces** block; do not rename between waves.
- Prerequisite defects #6342 (offline monitors never fire), #6343 (restart discriminator lost),
  #6344 (resolver ignores role/OS filters) are fixed as independent issue PRs before W05c1.

## Execution

Per wave: `get_feature_status` → branch `feature/<parent#>-alerting-consolidation/wave-<sub#>` →
`start_wave` → execute the plan with subagent-driven development → PR body `Closes #<sub#>` →
`/pr-review-toolkit:review-pr` → merge queue. W05a and W05b may run in parallel on separate branches.

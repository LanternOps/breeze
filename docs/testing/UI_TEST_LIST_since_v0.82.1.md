# UI Test List — changes since last stable (v0.82.1 → main)

**Generated:** 2026-06-25
**Baseline:** v0.82.1 (2026-06-21, last stable before the 0.83.x line)
**Head:** `61983fbd9` (main, 147 commits / ~80 PRs in window)
**Scope:** the entire 0.83.x release line (0.83.0 → 0.83.3) **plus unreleased commits on main** (the freshest, never-shipped-in-a-release changes — highest priority).

Legend per item: each is a concrete click-path to verify in the browser. Mark
PASS / PARTIAL / FAIL / BLOCKED in `FEATURE_TEST_LOG.md`. A backend 2xx with no
visible UI feedback = FAIL.

---

## P0 — Unreleased on main (post-v0.83.3, never released-tested)

1. **#1926 Billing bulk actions + draft delete** — Quotes/Invoices/Contracts list: multi-select rows → bulk action bar appears → perform a bulk action; open a *draft* quote/invoice detail → Delete present and works with confirm + list updates.
2. **#1924 Pax8 → contract-line picker** — Contract detail: link a Pax8 subscription to a contract line; change/pause/unlink; verify state + feedback each step.
3. **#1922 TD SYNNEX EC Express inline lookup in quote editor** — Quote editor: inline distributor lookup, search by SKU, insert price/availability into a line.
4. **#1913 Network Proxy + discovery asset-modal rework** — Network: HTTP reverse proxy config UI; Discovery asset modal new layout renders fields.
5. **#1911 Remote Tools — all services + Close/Back** — Remote Tools: services list shows *all* services (not truncated); Close and Back both work reliably (no dead end).
6. **#1909 Viewer interactive update prompt** — (viewer app) update prompt is interactive, not silent auto-close. *(Likely BLOCKED — desktop viewer, not web.)*
7. **#1907/#1921 Reliability — capped counts, age-aware windows, offender drill-down** — Reliability card: alarming counts capped/sane; young-device labeling; click into offender drill-down list.
8. **#1897 Patch ring selection no longer collapses list to 50** — Patches: select an update ring → patch list keeps full pagination (not silently capped at 50).
9. **#1914 PAM UAC interception opt-in default** — PAM settings: UAC interception defaults to opt-in for new orgs; active orgs grandfathered (toggle visible + state correct).

## P0 — Billing / Quotes / Contracts / Accounting (0.83.x)

10. **#1862 Quote/invoice presentation refresh + typed-name e-signature** — Open a quote PDF/preview; accept with typed-name signature; presentation styling intact.
11. **#1759 Accepted quote → auto-draft contract** — Accept a quote with recurring lines → a draft contract is auto-created; navigate to it.
12. **#1765 Contracts auto-renew + renewal notices** — Contract detail: auto-renew toggle/settings; renewal notice config renders.
13. **#1743 Quote detail Customer label** — Quote detail shows resolved org name (not an id) for Customer.
14. **#1763 Quote PDF preview (blob: CSP)** — Quote PDF preview iframe renders (no CSP frame-src block in console).
15. **#1849 QuickBooks Online — connect flow** — Integrations → QuickBooks: connect button; if unconfigured shows honest "not configured", not a crash.
16. **#1848 TD SYNNEX EC Express connector** — Integrations → Distributors: enter EC Express credentials form; price/availability lookup by SKU.

## P0 — Vulnerability Management (#1861, BE-16)

17. **Vuln list & detection** — Security/Vulnerabilities nav: list renders; risk scores shown; filter/sort.
18. **Remediation workflow** — open a vuln → remediation actions; risk-accept (RBAC-gated) with visible feedback.
19. **RBAC** — non-privileged role sees appropriate gating, not a blank 403 page.

## P1 — Network / Topology / Discovery

20. **#1728/#1842 Network topology redesign** — Network Monitor/Topology: Cytoscape view renders; backbone + host attachment; manual mapping add/move a node.
21. **#1801 Empty Network Changes tab explains Alerting prereq** — Discovery → Network Changes (no data): explanatory empty state, not a blank panel.
22. **#1799 SNMP data in asset detail modal** — Discovery asset list → open asset → SNMP fields render in modal.
23. **#1748 Network Discovery in All-Orgs mode** — switch to All Orgs → Network Discovery page guarded (no crash).
24. **#1742 Discovered-asset "Link to Device" clarity** — discovered asset → "Link to Device" action labeled clearly, works.

## P1 — Devices

25. **#1762 Unified chip-centric filter bar + saved views** — Devices: add filter chips, save a view, re-apply, delete.
26. **#1886 Reboot-pending dot layout** — device with reboot pending + Down status: dot does not wrap under the "Down" pill.
27. **#1850 Pending-reboot orange dot + "Updating" label** — device status column: orange dot for pending reboot; label reads "Updating" (not "Upd").
28. **#1718 Display names in Device column** — Device column shows friendly display names.
29. **#1745 Process drilldown empty states + drillable charts** — device → Performance/process drilldown: distinct empty states; area charts are drillable.
30. **#1744 Activity pane last-N feed** — device → Activity pane shows index-backed last-N feed.
31. **#1755 / #1804 / #1810 Device Reliability column + card** — sortable Reliability column; reliability card with Ask-AI CTA + Mark-outcome menu.
32. **#1760 Responsive data tables (mobile)** — resize to mobile width: device/other tables collapse to ResponsiveTable layout (desktop+mobile both render, no dupes).

## P1 — Patches

33. **#1764 Partner-scoped update rings & approvals** — Patches → Update Rings: create a partner-scoped (org-independent) ring; approvals flow.
34. **#1775 Linux OS patch logic** — Linux device patch list renders correct OS patches.

## P1 — PAM / Remote / Helper

35. **#1771 Signer-group (trusted-publisher) catalog** — PAM: create/reuse a signer group.
36. **#1761 PAM rule matching cluster** — PAM rule editor: command-line match, negation, default-unmatched verdict.
37. **#1752 UAC elevation → mobile approval** — (cross-surface) elevation request appears on mobile approval surface. *(Likely PARTIAL/BLOCKED — needs mobile + live elevation.)*
38. **#1694 Remote session consent & notification** — start remote session → end-user consent prompt config.
39. **#1863/#1864 Breeze Assist tab** — device → Breeze Assist: tray toggles shown when deploy off; badge honest.

## P1 — Tickets / Scripts / Config Policy

40. **#1883 Ticket requester selectable/editable + device link** — ticket detail: change requester; click device link navigates.
41. **#1749 Script scope changer on edit screen** — Scripts → edit a script → change scope control present + saves.
42. **#1794 Monaco theme preserved across nav** — open script editor (dark theme) → navigate away & back → editor not white.
43. **#1875 Config-policy monitoring + compliance in portal** — Config Policies: monitoring + compliance status surfaced.
44. **#1860/#1859 Config-policy automations & offline rules** — config-policy automations visible in portal; offline alert rules repaired.

## P2 — Integrations / Software / Web misc

45. **#1754 Huntress inbound webhook URL + secret in GUI** — Integrations → Huntress: webhook URL + secret displayed/copyable.
46. **#1791 Partner-wide SentinelOne** — Integrations → SentinelOne: partner-wide config.
47. **#1852 Software inventory "All Orgs"** — Software Library in All-Orgs mode: aggregated list loads.
48. **#1741 AI chat panel pinned to bottom** — AI Workspace: on submit + streaming, panel stays pinned to bottom.
49. **#1740 Sidebar nav scroll position preserved** — scroll sidebar, navigate, scroll position retained.
50. **#1803 Warranty refresh feedback + auto-update card** — device → warranty: refresh shows feedback; auto-update card renders.
51. **#1844 Forced-MFA enrollment login** — (if MFA-required fixture) enrollment page restores token, fails closed to clean re-login. *(Likely BLOCKED — fixture.)*

---

## Out of scope for UI (note, don't chase)
Backend/agent/observability-only: #1896/#1919/#1894/#1880/#1840/#1806 (conn-hold), #1823/#1824/#1825 (Sentry), #1887/#1888/#1889/#1890/#1891/#1892/#1893 (API authz/security gates — verify only via behavior if they surface in UI), #1902/#1881/#1884/#1832/#1833 (installer/agent), #1818 (rust dep), #1830 (CSS safelist — verify prod build only).

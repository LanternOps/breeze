# UI Testing Checklist — changes since v0.69.0

Pre-release manual/Playwright testing checklist. Covers user-facing UI changes
landed on `main` since **v0.69.0** (2026-06-01). Dependency bumps, docs, and
backend-only changes are excluded. PR refs included for drill-down.

## 🎫 Native Ticketing (brand-new feature — test heavily)
- [ ] **Technician ticketing UI** loads and lists tickets (#1223)
- [ ] Create / view / edit a ticket; **PATCH changes appear in the audit trail** (#1227)
- [ ] **Queue filters** narrow the ticket list correctly (#1227)
- [ ] **Bulk actions** on multiple selected tickets work (#1227)
- [ ] **Org-scope toggle** filters tickets to the selected org (#1245)
- [ ] **Workbench assignment** — assign ticket to a technician (#1245)
- [ ] **Category settings** page edits persist (#1245)
- [ ] **Bulk feedback** / skippedReasons surface to the user (#1245, #1243)
- [ ] **Own-org read** — non-assigned users can read their org's tickets (#1261)
- [ ] **Site gates** — site-scoped users only see/act on in-scope tickets (#1261)
- [ ] **Hard-delete detaches** linked records cleanly (no orphan errors) (#1261)
- [ ] **Queue UX polish** — verify the queue interactions from #1261 follow-ups
- [ ] **SLA engine (Phase 2)** — set SLA targets; verify pause, breach monitor, and notifications fire (#1250)
- [ ] **SLA queue + UI columns** show target/remaining time (#1250)
- [ ] **Portal settings tab** for tickets renders and saves (#1251)
- [ ] **Alert → ticket** — create a ticket from an alert via the UI (#1251)
- [ ] **Category reorder** — drag/reorder ticket categories persists (#1251)

## 🔐 PAM Admin UI (brand-new feature)
- [ ] **Overview / Requests / Rules / Audit tabs** all render (#1229)
- [ ] Approve / deny a privileged-action request (#1229)
- [ ] **Approver/denier display names** show (not raw IDs) (#1236)
- [ ] **Audit tab live-refreshes** after a decision (#1236)
- [ ] **Mobile app** — `uac_intercept` PAM elevations render on the approval surface (#1252)

## 🖥️ Devices page
- [ ] **Chip-bar device filter UI** — add/remove filter chips (#1013)
- [ ] **Advanced filters** apply, are uncapped, and **grid view respects them** (#1195)
- [ ] **Page-size picker includes 500** (#1063)
- [ ] **Network Discovery** — SNMP discovery selects the right target (#1262)
- [ ] **Network Discovery** — run feedback/progress surfaces to the user (#1263)
- [ ] **Pill-shaped "agent silent" badge** renders correctly (#1119)
- [ ] **Portal device row menu** opens/works (#1119)
- [ ] **Software tab — "Update" button is gated** on real available updates (disabled/hidden when none) (#1256)

## ⚙️ Settings & preferences
- [ ] **Table/page density toggle** (Comfortable / Compact / Dense) changes layout and persists (#1060)
- [ ] **Organization name editing** on settings page works again (#1094 — was broken)
- [ ] **Avatar upload** — upload / display / delete profile avatar (#1059)
- [ ] **Partner-level admin IP allowlist** config UI (#1092)
- [ ] **Event-log / vendor-neutral log forwarding** settings (#1239)
- [ ] **Proxy/tunnel allowlist** — partner users can manage it (org resolves from `?orgId=`) (#1259)
- [ ] **New-site default timezone** prefills from the partner's timezone (#1255)
- [ ] **Add custom field** works for partner-scoped fields (no RLS 500) (#1257)

## 🌐 Global org-scope
- [ ] **Global org-scope toggle is honored** on previously-ignoring pages (#1064)
- [ ] **Audit-logs / activity list respects selected org** (#1062)
- [ ] **Audit-logs `excludeActions` filter** hides routine telemetry noise (#1095)

## 🔑 Auth / SSO (regression-test login flows)
- [ ] **Hard refresh does not log you out** (rotation leeway) (#1113)
- [ ] **Cloudflare Access JWT trust + SSO redirect login** (#1058)
- [ ] **CLI onboarding token** enrolls a batch; expiry displayed honestly (#1114)
- [ ] **Remote-access launcher** scheme guard — allowed schemes launch, others blocked (#1162)

## 🎨 Visual / CSP (smoke-check rendering)
- [ ] **Plus Jakarta Sans brand font loads** (self-hosted, survives CSP) (#1234)
- [ ] **Monaco script editor loads and is styled** — including **after View-Transition navigation** (#1233, #1143)
- [ ] **Top bar** — responsive layout / critique fixes across breakpoints (#1120)
- [ ] **Modal headers are opaque** (no bleed-through of content behind the header) (#1255)

---

## 🆕 Added 2026-06-12 — PRs #1264–#1276 (merged after the first pass)

### 🎫 Ticketing (Phase 3)
- [ ] **Time tracking + parts backend** (#1276) — **backend-only**, no UI shipped yet (timer widget, `/timesheet`, Time & Billing rail, parts UI deferred to a follow-up frontend PR). Nothing to click; covered by API unit/integration tests. **Watch:** ticket API calls don't regress.

### 🔐 PAM (agent + AI backend — mostly not web-testable)
- [ ] **PAM Brain AI tools** — `request_elevation` / `revoke_elevation` / `get_elevation_history` callable from the AI agent without error (#1246)
- [ ] **Dormant `~breeze_elev` admin lifecycle** — JIT admin account created/removed by agent (#1248) — *agent-side, watch audit*
- [ ] **PAM approval dialog in user-helper** — Tauri Helper renders the elevation approve/deny prompt (#1249) — *desktop Helper, not web Playwright*

### 🔧 Patches
- [ ] **Approved vs Pending-Approval split** (#1266) — Patch Compliance shows separate **Approved** (green) / **Pending Approval** (orange) columns + header summary; bulk-install banner reads "Install approved patches on N devices" and toast notes "…N skipped pending approval"; device Patches tab shows "(N pending approval)" + 409 "approve them first" error
- [ ] **Third-party patch source management** (#1269) — policy **Patch tab → Patch Sources**: toggle "Third-party applications" on, Save, reload persists; last remaining source cannot be removed ("At least one patch source must be selected")
- [ ] **Policy auto-approve + per-app rules** (#1275) — `auto-approve-toggle` reveals severity checkboxes + Deferral days; zero severities → "Select at least one severity…"; a selected ring disables the toggle (`auto-approve-ring-notice`); **Application Rules** add/search/manual-package, "Pinned" action requires a version ("Pinned applications need a version."); rules persist after Save+reopen

### 🖥️ Devices
- [ ] **User Idle stat on device detail** (#1272) — Overview stat strip shows "User Idle" beside "Logged-in User"; renders a value (not a crash), tooltip shows per-session breakdown + "As of HH:MM"; graceful `—` with no sessions
- [ ] **Pending Reboot indicator** (#1273) — list shows amber "Reboot pending" status badge for flagged devices; optional hidden "Pending Reboot" column toggles on; device detail header shows the "Reboot pending" badge; advanced filter `system.rebootRequired` reads the new `pending_reboot` column

### 🔌 Integrations / Automation
- [ ] **Huntress integration fix** (#1264) — separate "API Key" (`hk_…`) / "API Secret" (`hs_…`) fields each with show/hide; filling only one shows inline error + Save disabled; **All-orgs scope** renders the per-org info panel (no failed-request error); status-fetch failure shows amber banner (not silent zeroes)
- [ ] **EDR events in automation builder** (#1270) — trigger=Event → Event Type dropdown lists the 6 new options (Huntress Incident Created/Updated/Agent Offline, SentinelOne Threat Detected/Device Isolated/Threat Action Completed); selection persists on save+reopen

### 🔑 Auth / MFA
- [ ] **Passkey MFA** (#1265) — `/settings/profile` Passkeys section: empty state + add form (name + current-password), "Add passkey" disabled until password entered; add → shows "Last used: Never"; Rename/Delete work (delete needs current password); login MFA step shows "Use your passkey" (`mfa-passkey-submit`) and completes. *Needs a Playwright virtual authenticator for the WebAuthn ceremony.*

### 🛠️ Install
- [ ] **Clear errors for partial-connectivity installs** (#1271) — Add Device modal: macOS/Linux tabs fetch `install.sh` to a `mktemp` path + `sudo bash … --server --token` (not the old `installer -pkg` one-liner); Windows starts with `$ErrorActionPreference='Stop'` + MZ-magic / `$LASTEXITCODE` checks; real token substitutes in; Copy button works per tab

### 🐛 Fixes — resolves prior must-fix items from the first pass
- [ ] **Avatar storage moved to DB bytea** (#1268) — **resolves the #1059 avatar-upload 500.** Avatars now stored in `users.avatar_data` (bytea) via `services/avatarStorage.ts` — no `/data/avatars` filesystem write. Re-test upload/preview/persist/remove; non-image / >5MB rejected. *Needs API image rebuilt from this branch.*
- [ ] **Login #418 hydration fixed** (#1268) — `/login` loads with **no React #418** in console (SSR/CSR seed agreement); form appears within ~4s even if `/api/v1/config` hangs
- [ ] **Deletion-requests badge 403 fixed** (#1268) — non-platform-admins no longer see the "Deletion requests" nav item and the badge fetch no longer fires (no 403 on `/admin/account-deletion-requests/pending-count`); platform admins still get item + badge

---

## 🆕 Added 2026-06-12 — PR #1290 (security: tenant-isolation & authz hardening)

From the multi-tenant + authz security review. Mostly backend, but several gates
have observable effects — **verify the happy path still works AND the denial
fires (a real 403, not a silent no-op or empty result).**

### 🔐 Authorization gates
- [ ] **Deployments now require MFA** (#1290) — create / edit / delete a deployment works with MFA satisfied; **without MFA → 403**. Lifecycle actions (start/pause/cancel) were already MFA-gated — confirm no regression.
- [ ] **Security-module RBAC** (#1290) — a **read-only role** user gets **403** (not a silent no-op) on: trigger AV scan, create/edit security policy, threat **quarantine / remove / restore**. A user **with** the device execute/write permission still succeeds.
- [ ] **Policy-management RBAC** (#1290) — read-only role gets **403** on **activate / deactivate / evaluate / remediate**; a permitted role still works.
- [ ] **Playbook site-scope** (#1290) — a **site-restricted** technician runs a playbook on an **in-site** device but gets **403** for an in-org **out-of-site** device (both `POST execute` and `PATCH execution` state).
- [ ] **Patch-job site-scope** (#1290) — site-restricted user creating a patch job from a config policy: in-site devices enqueue; out-of-site device ids are **rejected (403, listed in `siteDeniedDeviceIds`, no job created)**.
- [ ] **Threat-action site-scope** (#1290) — site-restricted user blocked (**403**) from quarantine/remove/restore on an out-of-site device.
- [ ] **Time-entry cross-org block** (#1290) — a partner user with `orgAccess=selected` **cannot** log time / start a timer against a ticket in a **non-granted** org (denied); a **granted**-org ticket works. Confirm no ticket comment is silently written to the foreign org's feed.

### Watch-during-testing (non-UI security/data fixes that could surface as errors)
These have no obvious UI but could error on save/assignment actions — watch the
console during the Ticketing/PAM passes:
- Audit-chain commit-time sealing (#1247)
- Site-scope enforcement on AI tools / PATCH devices / automations (#1199, #1200, #1204)
- Provisioning creds via short-lived one-time-fetch URL (#1244)
- **RLS backstop on 7 FK-child tables** (#1290) — newly forced RLS on **webhook delivery history**, **network-monitor alert rules / results**, **role permissions** (role edit/clone), **plugin logs**, **report run history**, **maintenance-window occurrences**. A regression shows as **empty lists or 500/RLS errors** for in-tenant users — confirm these views still populate, and that role/permission edits and **ticket-comment posting** don't error (the `ticket_comments` insert policy was also tightened to require parent-ticket org access).

---

## 🆕 Added 2026-06-13 — PRs #1285, #1286, #1288, #1291, #1294, #1295 (merged after #1290)

### 🎫 Ticketing — Phase 3 frontend NOW SHIPPED (corrects line 75)
- [ ] **Time tracking + parts UI** (#1285) — the #1276 backend is now wired to the UI; line 75's "backend-only, nothing to click" no longer applies:
  - **Header timer widget** (`TimerWidget`) appears when a timer is running (live elapsed + ticket link), stop popover takes description + billable, hidden when idle.
  - **Ticket detail rail** — `TicketTimeBilling` (billing summary, start-timer, quick-add manual entry) + `TicketPartsCard` (parts add/edit/delete with cost + margin, internal-only). Both live-refresh on timer/billing events.
  - **Feed** renders `time_entry` comment lines on timer create/stop/delete.
  - **`/timesheet`** — Monday-UTC week view, `#week=&tech=` hash state, admin tech-selector (graceful 403 fallback), inline edit, approval checkboxes + bulk approve/unapprove with `skippedReasons` warning toasts, weekly totals.
  - **Settings → Ticketing → Export** — `BillablesExportCard` CSV export (date range + org picker, authed blob download).
  - *Known deferred:* no Playwright e2e yet; parts form omits partNumber/vendor/notes; parts delete has **no confirm dialog** (note as UX risk).

### 🎫 Ticketing — configuration frontend (#1291)
- [ ] **`/settings/ticketing` tabbed page** — Statuses | Priorities | Categories | Export with `#tab=` hash state; Ticketing card moved next to Partner settings on `/settings`.
- [ ] **Statuses tab** — add/edit custom status with color, activate/deactivate, ▲/▼ reorder persists; built-in rows can't be deactivated/recored; friendly errors for `STATUS_NAME_TAKEN` / `SYSTEM_STATUS_IMMUTABLE` / `SYSTEM_STATUS_REQUIRED`.
- [ ] **Priorities tab** — per-priority label + response/resolution SLA minutes (placeholders show SLA-engine defaults); single wholesale save.
- [ ] **Org settings → Ticketing tab** — per-priority SLA overrides, default hourly rate, tri-state default billable; **MFA-required save path** (confirm the MFA gate fires).
- [ ] **Custom statuses across ticket UI** — workbench select shows `<optgroup>` per core state; queue/workbench chips show `statusName` + color dot; legacy tickets (null `statusName`) fall back to core-state label. **Verify graceful fallback if `/ticket-config` fetch fails** (select keeps posting `{status}`).

### 🔐 PAM config-policy (#1286)
- [ ] **"Privileged Access" feature tab** in config policies — `uacInterceptionEnabled` toggle + link-out to `/pam`; default ON at every layer (toggle *off* to opt out). *Agent-side capture pause is not web-testable; watch the policy tab saves.*

### 🖥️ Devices — power actions (#1294)
- [ ] **Power dropdown** — Reboot / Reboot to Safe Mode / Shutdown / Wake grouped under one **Power** menu on `DeviceActions`; Refresh moved to overflow; standalone "Fix with AI" button removed from `DeviceDetails`.
- [ ] **Reboot-pending badge in list/grid** (fixes #1273) — the list mapper now keeps `pendingReboot`, so the amber badge renders in list **and** grid (previously detail-only). Confirm on a flagged device.

### 🎨 Web polish + error pages (#1288, #1295)
- [ ] **Custom 404 page** (#1288) — unknown route renders a branded, theme-aware 404 with correct `<title>` + "Go to dashboard" / "Sign in" links; renders even with hydration broken (no client JS); no CSP/asset console errors.
- [ ] **Custom 500 page** (#1288) — server error renders branded 500 with a Sentry **Reference ID**. *Hard to trigger in normal flow — note as BLOCKED unless a 500 occurs naturally.*
- [ ] **App-wide interface density** (#1295) — density toggle now lives in the **top-bar theme/display menu** (moved out of the Devices toolbar); changing it re-skins tables app-wide via `<html data-density>` and persists. (Supersedes the per-table #1060 control.)
- [ ] **HelpPanel lazy-loads docs** (#1295) — docs iframe doesn't load until Help is opened; **no CSP report-only spam on every navigation** anymore (check console stays clean while navigating before opening Help).
- [ ] **Huntress org-scope empty state** (#1295) — at org scope with no connection, shows a clear "Huntress isn't connected yet" empty state (not just a mapping warning).
- [ ] **TicketsPage filter selects** (#1295) — filter/bulk selects no longer clip descenders (text not cut off inside the `h-8` boxes).

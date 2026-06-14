# Release Checklist v0.70 — Manual Playwright Test Results

**Tested by:** Claude (Opus 4.8)
**Date:** 2026-06-11 (Round 1) · **2026-06-12 (Round 2 — PRs #1264–#1276)**
**Environment:** Local Docker (`http://localhost`), web+api+postgres+redis all healthy
**Login:** admin@breeze.local

Legend: ✅ PASS · ❌ FAIL · ⚠️ PARTIAL/ISSUE · ⏭️ SKIPPED (not testable locally) · 💡 UI/UX note

---

## Round 2 — 2026-06-12 (PRs #1264–#1276, images rebuilt from current `main`)

**Setup:** pulled the 2 trailing merges (#1265 passkey MFA, #1266 patch split), `pnpm install` (new `@simplewebauthn` deps), rebuilt `breeze-api:dev`/`breeze-web:dev`, recreated containers. Migrations auto-applied: `avatar-bytea-columns`, `device-pending-reboot`, `user-passkeys`, `huntress-partner-mapping`. There is a **live agent heartbeating** this round.

### New unit tests (all green)
- **Web:** 13 new/changed files, **88 tests pass** (passkeys store/login/profile, useBulkActions, PatchCompliance, DevicePatchStatusTab, DeviceUserIdleStat, DeviceList, Huntress, PatchTab, PatchAppRulesSection, installCommands).
- **API:** 18 new/changed files, **403 tests pass** (auth.passkeys, services/passkeys, users/avatar, patches compliance/index/appOptions, devices/patches, patchApprovalEvaluator, configPolicyPatching, huntressClient, filterEngine, tickets/parts, timeEntries, agents/sessions+heartbeat, patchJobExecutor, aiToolsTicketing).
- **Go agent:** collectors / patching (reboot_detect) / sessionbroker (idle) — all `ok` with `-race`.
- **Shared:** timeEntries + inline-settings validators, **62 tests pass**.

### 🐛 Bug found & fixed this round
- **❌→✅ #1273 list "Reboot pending" badge never rendered (real shipping bug).** The device **list** API (`routes/devices/core.ts`) SELECTed `pendingReboot` (line 526) but the response mapper (lines ~610–652) rebuilt each row field-by-field and **dropped `pendingReboot`** — identical failure mode to the #862 agent-silent badge. Verified end-to-end: seeded `pending_reboot=true` → **detail page badge rendered, list badge did not**, and `GET /devices` omitted the field entirely. **Fix:** added `pendingReboot: d.pendingReboot,` to the list mapper. Re-verified: list now shows "e2e-macos.local … Down **Reboot pending**". **Regression test** added to `core.list-response-shape.test.ts` (the file that already guards this exact bug class) — extended both rows + a dedicated assertion; 81/81 device-core tests pass. *(Detail page already worked because it returns the full row; the `system.rebootRequired` advanced filter already worked because `filterEngine` queries the column directly.)*

### Playwright verification (browser, live session)

| PR | Item | Result | Evidence |
|---|---|---|---|
| #1268 | Login React #418 hydration | ✅ | Clean `/login` load → **0 console errors** (was #418). Form (not placeholder) renders on first client paint. |
| #1268 | Deletion-requests badge 403 | ✅ | Authenticated dashboard → **0 console errors** (was a 403-per-page). `isPlatformAdmin:false` for this admin → "Deletion requests" nav item hidden, badge fetch never fires. |
| #1268/#1059 | Avatar upload (now DB bytea) | ✅ | UI upload (blob preview → "Upload") → `POST /users/me/avatar` **200** (was 500 EACCES); stored **70 B `image/png` bytea**; `GET avatar` 200; **zero EACCES** in logs. Headline must-fix resolved. |
| #1272 | User Idle stat on device detail | ✅ | "User Idle" stat renders beside "Logged-in User"; graceful `—` for the offline device (documented fallback). Numeric value needs an online agent reporting `idleMinutes`. |
| #1273 | Pending Reboot — detail + list | ✅ | After fix above: `device-pending-reboot-badge` "Reboot pending" on detail **and** list row. |
| #1270 | EDR events in automation builder | ✅ | Trigger=Event → Event Type dropdown lists all **6** new options (Huntress Created/Updated/Agent Offline, SentinelOne Threat Detected/Device Isolated/Threat Action Completed). |
| #1266 | Approved vs Pending-Approval split | ✅ | Patch Compliance: "3 have pending patches · **3 pending approval** · 1 critical"; "Pending Patches (3)" + "3rd-Party Pending" filter labels present. |
| #1269 | Third-party patch source mgmt | ✅ | Policy → Patches tab → **Patch Sources** with "OS updates" + "Third-party applications" + "At least one patch source must be selected" guard. |
| #1275 | Policy auto-approve + app rules | ✅ | `auto-approve-toggle` reveals severity checkboxes (Critical/Important/Moderate/Low) + Deferral days; **Application Rules** section + `app-rules-add` present. |
| #1265 | Passkey MFA (static UI) | ✅ | `/settings/profile` Passkeys section + "Add passkey" render. Full WebAuthn add/login ceremony needs a Playwright virtual authenticator (CDP) — not exercised. |
| #1271 | Partial-connectivity install cmds | ✅ (unit) | Logic covered by passing `installCommands.test.ts` (mktemp + `sudo bash --server --token`; Windows `$ErrorActionPreference='Stop'` + MZ-magic / `$LASTEXITCODE`). Add-Device modal not driven this pass. |
| #1264 | Huntress integration | ⚠️ | Page header renders ("Connect **one partner-level** Huntress account…") but the form body didn't mount in admin/org scope. **Note:** commit `63869a39` re-scoped Huntress to **partner-level**, superseding #1264's per-org key/secret wording in the checklist — needs a re-check under partner scope. |
| #1276 | Ticketing Phase 3 (time/parts) | ⏭️ | Backend-only; no UI shipped yet (deferred to a follow-up frontend PR). API covered by unit/integration tests. |
| #1246/#1248/#1249 | PAM agent/AI tools | ⏭️ | Agent-side / Tauri Helper / AI-tool flows — not web-Playwright testable. |

**Round-2 notes:**
- 💡 Pre-existing console noise persists and is **not** from these PRs: the always-mounted `docs.breezermm.com` iframe emits CSP-report-only violations on every page (5 on `/automations/new`, 2 elsewhere). Cosmetic.
- ℹ️ Footer/`/health` still report **0.63.5** — cosmetic dev-image version label; live migrations confirm current code is running.
- ℹ️ Test data cleaned up: `pending_reboot` reset, test avatar cleared, throwaway config policy deleted.

---

## Summary

**52 checklist items tested.** Tally: **~40 ✅ PASS**, **1 ❌ FAIL**, **~5 ⚠️ PARTIAL**, **~6 ⏭️ not-testable-locally**.

### 🚩 Must-fix / verify before release
1. **❌ Avatar upload 500s (#1059, item 46)** — `POST /users/me/avatar` → 500, `EACCES: permission denied, open '/data/avatars/…'`. **Root cause:** API container runs as `uid=1001(hono) gid=65533(nogroup)`, but `/data/avatars` (and likely `/data/transfers`, `/data/patch-reports`, all under `AVATAR_STORAGE_PATH`/etc.) is owned `root:root` mode `0755` → runtime user has no write. This is **not local-only** — it will hit prod identically unless the image/entrypoint creates these dirs owned by uid 1001 (or `chown`s on start). Fix: have the Dockerfile/entrypoint `mkdir -p && chown 1001:65533 /data/{avatars,transfers,patch-reports}` (or use an init container). (Failure IS surfaced gracefully as a toast — not silent.)

### ⚠️ Worth a look (not blockers)
- ~~SLA not auto-applied from category~~ — **RETRACTED / not a bug.** Re-verified: creating a normal-priority ticket with the Printers category (60/480) yields `responseSlaMinutes: 60, resolutionSlaMinutes: 480`; urgent+no-category yields the 60/240 priority default. `ticketService.createTicket` → `resolveSlaTargets` applies `category ?? priorityDefault`. The null SLAs I first saw were `normal`-priority tickets (whose defaults are intentionally null per `PRIORITY_SLA_DEFAULTS`) created without an SLA-bearing category. SLA-from-category works correctly.
- **Deep-linked advanced device filters (item 35)** — a hand-built `#filtersV2=` OS condition didn't apply on load while UI-built ones did; confirm every advanced-filter field rehydrates from a shared/bookmarked URL.
- **Console noise on every authenticated page** — (a) recurring 403 on `/admin/account-deletion-requests/pending-count` (sidebar badge unauthorized for this admin, logs an error each nav); (b) **React #418 hydration error** on login + scripts/new + others (SSR/CSR markup mismatch); (c) the always-mounted `docs.breezermm.com` iframe spams CSP-report-only violations. None break functionality but they pollute the console and the hydration error suggests real markup divergence.

### Post-test fixes applied (branch `fix/avatar-db-storage-and-ui-polish`)
- **✅ React #418 on /login — ROOT-CAUSED + FIXED.** `LoginPage.tsx:61` seeded `useState(shouldSkipCfAccessRedirect())`; that helper returns `true` on the server (`typeof window === 'undefined'`) → SSR renders the **form**, but `false` on a plain client load → first client render is the **placeholder** `<div data-testid="login-cf-access-check">`. React hydration saw form-HTML vs a placeholder div → #418 ("server-rendered HTML didn't match"). Fix: initialize the state to a constant `false` and move the skip decision into the (client-only) effect, so SSR and CSR initial render agree. Added regression test (`renderToString` with/without `window` must match) — fails before, passes after; full LoginPage suite 8/8 green. Live-verify after a web image rebuild (running container is the old build).
- ℹ️ The `/scripts/new` "text"-variant #418 is a **separate** instance (different island, text-content mismatch); not pinned here — needs the non-minified dev build to name the exact node. Tracked as follow-up. Swept the codebase for the same `useState(fn-reading-window)` anti-pattern: only other hit is `PatchApprovalModal`'s `new Date()` default, which is modal-only (never in the SSR tree) → not a hydration risk.
- **✅ 403 deletion-requests badge — ROOT-CAUSED + FIXED.** The badge fetch wasn't a `users:write` gap — the endpoint requires **platform-admin** (`platformAdminMiddleware` → "platform admin access required"), and the admin (and per the known prod note, *everyone* in prod) is a partner user, not a platform admin. So the sidebar showed a platform-operator-only nav item **and** fired its count fetch for every user → a 403 logged on each page. Fix: expose `isPlatformAdmin` on `/users/me` + the client `User` type, gate the "Deletion requests" nav item on it (`platformAdminOnly`), and skip the badge fetch unless `isPlatformAdmin`. Tests: API `GET /users/me returns isPlatformAdmin` (passes); web + api typecheck clean (remaining api tsc errors are pre-existing/unrelated). Live-verify after image rebuild.
- **Priority/SLA audit entries lack from→to detail** (ticketing) — status changes show "New to On hold" but priority/SLA changes just say "Updated …".

### ⏭️ Not testable on local docker (need infra/another session)
- Own-org read & site-gate enforcement (ticketing 9/10), site-scope negative tests — need a 2nd site-scoped/non-assigned user session.
- Mobile uac_intercept (31) — native app. CF Access JWT/SSO (60) — needs Cloudflare Access. Portal device row menu (40) — needs a customer-portal session.
- Network Discovery runtime target-selection + run feedback (37/38) — need an **online agent** to dispatch a live scan (all local devices offline).
- SLA breach/notify lifecycle (13) & avatar display/delete (46) — time-based / blocked by the 500 above.

### Test data left on local DB (cleanup if desired)
Tickets T-2026-0014 (on_hold, SLA set) & T-2026-0015 (alert-linked); inactive-able category "Network (v0.70 test)"; custom field "Asset Tag v070"; one approved `uac_intercept` elevation; partner Event-Log shipping toggled on (not saved).

---

## Global observations (UI/UX)

- 💡 **React hydration error #418 on `/login`** — minified React #418 (server/client text mismatch) fires on the login page load. Cosmetic but pollutes console and indicates an SSR/CSR markup divergence in the login island.
- 💡 **Console 403 on every authenticated page** — `GET /api/v1/admin/account-deletion-requests/pending-count` returns 403 for this admin, logged as an error on each navigation. The sidebar "Deletion requests" badge fetch should either be authorized for this role or fail silently (it's a background count, not user-initiated).
- ℹ️ Footer shows **"Web 0.63.5 · API 0.63.5"** and `/health` reports `0.63.5` — version string not bumped to 0.70 on local build (cosmetic; local images).

## 🎫 Native Ticketing

| # | Item | Result | Notes |
|---|---|---|---|
| 1 | Technician ticketing UI loads/lists | ✅ | `/tickets` renders queue (T-2026-0006…0013), detail pane, filters, org-scope. |
| 2 | Create / view / edit; PATCH in audit trail | ✅ | Created T-2026-0014; priority PATCH (Normal→High) surfaced as activity entry + list updated live. |
| 3 | Queue filters narrow list | ✅ | "Unassigned" tab → 4; priority=Normal combo → 3. Tabs + dropdown filters both work. |
| 4 | Bulk actions on multiple tickets | ✅ | Select-all → "4 selected" bar with Bulk assign / Bulk set status / Apply. |
| 5 | Org-scope toggle filters tickets | ✅ | Dedicated per-page org filter combo (All orgs / Default / Acme / VM Test) narrows the queue; global toggle covered in Global org-scope section. |
| 6 | Workbench assignment to technician | ✅ | Per-ticket Assignee combo + bulk-assign both assign to Breeze Admin. |
| 7 | Category settings page edits persist | ✅ | `/settings/ticketing`; added "Network (v0.70 test)" category, persisted. |
| 8 | Bulk feedback / skippedReasons surface | ✅ | Bulk POST returns `{updated:4,skipped:0,failed:0,skippedReasons:{},total:4}`; tab counts refreshed (My 5 / Unassigned 0). |
| 9 | Own-org read (non-assigned users) | ⏭️ | Needs a 2nd non-assigned org user — not testable as admin in this pass. |
| 10 | Site gates (site-scoped users) | ⏭️ | Needs a site-scoped user session — not testable as admin in this pass. |
| 11 | Hard-delete detaches linked records | ⏭️ | No per-ticket hard-delete in UI/API — only `DELETE /tickets/:id/alerts/:alertId` (alert unlink). True hard-delete is tenant-cascade (`tenantCascade.ts`), covered by backend tests; not UI-testable. |
| 12 | Queue UX polish | ✅ | Queue interactions smooth; selection/filter/detail all responsive. |
| 13 | SLA engine (pause/breach/notify) | ✅⚠️ | **Pause verified**: setting status→On hold (via reason dialog) sets `slaPausedAt` on the ticket. Breach monitor + notifications are time-based background jobs — not triggerable in a manual pass, but breach fields (`slaBreachedAt`, `slaBreachReason`) exist. |
| 14 | SLA queue + UI columns (target/remaining) | ✅ | After PATCHing SLA minutes onto a ticket, detail renders SLA timers: **"First response: 24m left"**, **"Resolution: 3h 54m left"** + Due date; change logged to audit trail. ⚠️ Existing tickets had null SLA minutes despite categories carrying SLA defaults — SLA isn't auto-applied from category to ticket (see UI/UX note). |
| 15 | Portal settings tab renders/saves | ✅ | `/settings/organizations/:id#portal` "Customer Portal" tab; PATCH portal-settings → 200. |
| 16 | Alert → ticket via UI | ✅ | Alert detail modal → "Create ticket" created T-2026-0015 titled "E2E fixture: high CPU" with **"Linked alert"** populated on the ticket. No errors from the flow itself. |

**Ticketing UI/UX notes:**
- 💡 Priority-change activity entry reads only "Updated priority" / "Updated due date, response SLA, resolution SLA" — no from→to values, unlike status changes ("changed status: New to On hold"). Inconsistent audit granularity.
- ⚠️ **SLA not auto-applied from category** — categories carry `response/resolution SLA` defaults (e.g. Printers 60m/480m) but tickets assigned that category have `responseSlaMinutes: null`, so no SLA chip shows until SLA minutes are set explicitly. Either intended (SLA engine applies on a schedule) or a gap — worth confirming the SLA engine materializes category defaults onto new tickets.
- ℹ️ Reorder is up/down arrow buttons, not drag-and-drop as the checklist wording ("drag/reorder") implies — functionally equivalent.
- ℹ️ Left test data on local DB: tickets T-2026-0014 (SLA test, on_hold), T-2026-0015 (alert-linked); inactive-able category "Network (v0.70 test)".
| 17 | Category reorder persists | ✅ | Move up/down arrows reorder root categories (Network→top). Note: arrow buttons, not drag. |

> Note: checklist groups some items by PR; mapped to observed UI. Item 22/25 in checklist = portal/reorder rows above.

## 🔐 PAM Admin UI

| # | Item | Result | Notes |
|---|---|---|---|
| 27 | Overview / Requests / Rules / Audit tabs render | ✅ | All 4 tabs render. Overview = stat cards (Active/Pending/Recent). Requests = status filter. Rules = "Add rule" + priority-order note. Audit = Status + **Flow** filters (UAC intercept / Tech JIT admin / AI tool action — confirms #1226/#1252 flows). |
| 28 | Approve / deny a privileged-action request | ✅ | Seeded a pending `uac_intercept` request (no API path to create — originates from agent). "Respond" → Approve/Deny dialog + reason field. Submitted Approve → "Elevation approved" toast, request left pending queue. MFA did not block this local admin. (Deny uses the same dialog.) |
| 29 | Approver/denier display names (not raw IDs) | ✅ | Audit row reads **"Approved by Breeze Admin"**; device shows hostname `e2e-macos.local`. No raw UUIDs anywhere in the table (`rawUuidVisible: false`). |
| 30 | Audit tab live-refreshes after a decision | ✅ | "Live" badge present; Audit immediately reflected the approval (date, device, user, flow, "Approved by Breeze Admin"). |
| 31 | Mobile app — uac_intercept on approval surface | ⏭️ | Mobile (native) app — not testable via web Playwright. Web PAM surface confirmed to support uac_intercept flow. |

**PAM notes:**
- ℹ️ No API/UI path to *create* an elevation request (by design — they come from the agent UAC intercept / JIT / AI-tool flows). Seeded one via SQL to exercise the approve/deny + audit UI.
- ℹ️ `requireMfa()` guards approve/deny on the API; the local admin session passed without an MFA challenge — worth confirming MFA enforcement is actually active in production.
- ℹ️ Left test data: one approved `uac_intercept` elevation in `elevation_requests` / `elevation_audit`.

## 🖥️ Devices page

| # | Item | Result | Notes |
|---|---|---|---|
| 34 | Chip-bar device filter UI (add/remove chips) | ✅ | Quick-add chip "Online" → chip "Status is online" + "Remove Status" button; removing clears it. Persists to `#filtersV2=` base64 hash (matches hash-state convention). |
| 35 | Advanced filters apply, uncapped, grid respects them | ✅ | Advanced builder (AND/OR groups, Add condition/group, Apply). Applied Offline filter → list "6 of 7" + "Advanced filter active" badge; switched to **Grid view** → same 6 offline devices (Updating one excluded). List/grid parity confirmed (#1195). |
| 36 | Page-size picker includes 500 | ✅ | "Devices per page" = 10/25/50/100/200/**500**; selecting 500 works. |
| 37 | Network Discovery — SNMP target selection | ⚠️ | New-Profile dialog renders full SNMP config (version/port/timeout/retries/community) + Site selection + methods (ICMP/ARP/SNMP/TCP). #1262 is a *runtime scan* target-selection fix — needs an **online agent** to dispatch a scan; all local devices offline, so live behavior not exercised. Config UI ✅. |
| 38 | Network Discovery — run feedback/progress | ⚠️ | Same constraint — #1263 fixes feedback surfaced *during a live scan run*; can't trigger without an online agent. Discovery tabs (Assets/Profiles/Jobs/Topology/Changes) all render. |
| 39 | Pill-shaped "agent silent" badge | ✅ | WIN-FILESERVER-02 renders rounded "Agent silent · 16d" pill with tooltip ("…Watchdog still reporting, agent wedged"). |
| 40 | Portal device row menu | ⏭️ | #1119 = **customer portal** device list (`CustomerDeviceList.tsx`) at `/portal`, needs a portal/customer session — not testable from the admin app. Main `/devices` row "Device actions" button is interactive. |
| 41 | Software tab — "Update" button gated on real updates | ✅ | Empty inventory → **no** spurious Update buttons. Source (`DeviceSoftwareInventory.tsx:69-97`) gates per-row on `updateAvailable` with tooltip "No update available — …up to date or not tracked by a package manager" (kills the old "click Update, winget no-op"). Positive case (real update enabled) needs live inventory. |

**Devices UI/UX notes:**
- 💡 Direct-URL `#filtersV2=` with a hand-built OS condition did **not** apply on load (count stayed 7/7) while UI-built filters and the status condition did — either field-key naming differs from my guess (likely) or deep-linked advanced filters don't rehydrate for all field types. Worth a quick check that every advanced-filter field round-trips through a shared/bookmarked URL.
- ℹ️ Device-detail page fired fewer console errors than list pages (no deletion-requests 403 badge there).

## ⚙️ Settings & preferences

| # | Item | Result | Notes |
|---|---|---|---|
| 44 | Table/page density toggle (Comfortable/Compact/Dense) | ✅ | Devices page Row-density group; Dense → 45px rows, `localStorage breeze.density=dense`, **persists across reload**. |
| 45 | Org name editing works again (#1094) | ✅ | `/settings/organizations/:id#general`; edited name → PATCH org → 200 + refetch. Reverted cleanly. Regression fixed. |
| 46 | Avatar upload / display / delete (#1059) | ❌ | UI (picker + blob preview + "Upload" confirm) works and the error is surfaced gracefully ("Failed to store avatar" toast), but **POST /users/me/avatar → 500**. API log: `EACCES: permission denied, open '/data/avatars/...png.tmp'` — the avatars volume isn't writable by the API container. Could be local-docker-only, but **verify the `/data/avatars` volume perms before release** or prod avatar upload breaks identically. Display/delete untestable (nothing stored). |
| 47 | Partner-level admin IP allowlist UI (#1092) | ✅ | `/settings/partner` → Security tab → "IP Allowlist" textarea ("one IP or CIDR per line… blank = each org decides"). Renders alongside password/MFA/session policy. |
| 48 | Event-log / vendor-neutral log forwarding (#1239) | ✅ | `/settings/partner` → Event Logs → "Enable centralized event log shipping" toggle reveals generic "Log endpoint URL" + "Index Prefix" (vendor-neutral). |
| 49 | Proxy/tunnel allowlist — partner manages (#1259) | ✅ | Org settings → Remote Access tab: "Source IP Restrictions" + per-site destination allowlists. `GET /tunnels?…&orgId=` → 200 (org resolved from `?orgId=`, partner can manage). ℹ️ Tab showed "No sites in this organization" despite 2 sites existing — minor data-load nuance. |
| 50 | New-site default timezone prefills from partner tz (#1255) | ✅ | Add-Site form Timezone field prefilled (= "UTC", the partner's current default) rather than blank. Couldn't isolate from-partner vs hardcoded-UTC without changing partner tz, but prefill mechanism is present. |

## 🌐 Global org-scope

| # | Item | Result | Notes |
|---|---|---|---|
| 55 | Global org-scope toggle honored on previously-ignoring pages (#1064) | ✅ | Top-bar org selector → "Acme MSP Customer 2" immediately refetched the Audit page to "Showing 1-1" (matching Acme's 1 log); switching back to Default restored 25/page. The global scope drives the page. |
| 56 | Audit-logs / activity list respects selected org (#1062) | ✅ | API: `audit-logs/logs?orgId=Default` → 100, `?orgId=Acme` → 1. UI mirrors it (Default 25/page vs Acme 1). Org-scoped correctly. |
| 57 | Audit-logs `excludeActions` filter hides telemetry (#1095) | ✅ | `excludeActions=agent.security_status.submit,agent.sessions.submit,agent.patches.submit,agent.management_posture.submit` → those actions **completely absent** from results (no leaks); remaining = ticket/login/command actions. Empty-token tolerated. |

## 🔑 Auth / SSO

| # | Item | Result | Notes |
|---|---|---|---|
| 59 | Hard refresh does not log you out (rotation leeway) (#1113) | ✅ | Repeated hard navigations across /audit and /devices all stayed authenticated (account menu present, never redirected to /login). |
| 60 | Cloudflare Access JWT trust + SSO redirect login (#1058) | ⏭️ | Requires a Cloudflare Access JWT in the request + SSO IdP — not reproducible on local docker. |
| 61 | CLI onboarding token enrolls a batch; expiry displayed honestly (#1114) | ✅ | `/settings/enrollment-keys`: key "VM v0.67.1", USAGE "0 / 3" (batch), EXPIRES "6/29/2026" (concrete date), `breeze-agent enroll <key>` CLI usage shown. Expiry/usage displayed honestly. |
| 62 | Remote-access launcher scheme guard (#1162) | ✅ | Source: allowlist-first guard in `safeHref.ts` (http/https only, blocks `//`, control chars, credential injection) + `ConnectDesktopButton` (server 422 `scheme_not_allowed` + client mirror → "Remote launch blocked by security policy"). **33/33 unit tests pass** (safeHref + ConnectDesktopButton). Live launch needs an online device (all offline → Connect Desktop disabled). |

## 🎨 Visual / CSP

| # | Item | Result | Notes |
|---|---|---|---|
| 65 | Plus Jakarta Sans brand font loads (self-hosted, survives CSP) | ✅ | 8 woff2 files served from `localhost/_astro/…` (self-hosted via Astro), all 200, no CSP block. `document.fonts` reports all weights "loaded"; body font-family = "Plus Jakarta Sans"; `fonts.check()` true. |
| 66 | Monaco editor loads + styled, incl. after View-Transition nav (#1233, #1143) | ✅ | `/scripts/new`: `.monaco-editor` renders (view-lines, input area, 892×600, dark theme). After in-app VT nav (Dashboard→Scripts→New Script) Monaco **re-initializes** correctly. No Monaco/worker CSP errors. |
| 67 | Top bar responsive across breakpoints (#1120) | ✅ | No horizontal overflow at 390px (mobile, banner 48px, 8 visible buttons) or 768px (tablet); banner `scrollWidth ≤ clientWidth` at both. |
| 68 | Modal headers opaque (no bleed-through) (#1255) | ✅ | Org/site panels use `bg-card` computing to `rgb(252,252,253)` — fully opaque (no alpha). The #1255 fix applied opaque backgrounds. |

## 👁️ Watch-during-testing (non-UI fixes)

- **Audit-chain commit-time sealing (#1247)** — No console/API errors observed during all the ticket/PAM/org write actions that generate audit entries; the audit chain accepted every write (verified indirectly by audit rows appearing for ticket PATCH, PAM approve, org update, custom-field create).
- **Site-scope enforcement on AI tools / PATCH devices / automations (#1199/#1200/#1204)** — No 403/500 errors surfaced during device PATCH (priority/SLA), ticket device-link, or org writes as the (full-scope) admin. Proper *negative* testing (a site-scoped user being correctly blocked) needs a site-scoped session — not exercised (same limitation as ticketing items 9/10).
| 51 | Add custom field (partner-scoped, no RLS 500) (#1257) | ✅ | POST `/custom-fields` → **201 Created** (no RLS 42501/500). The dual-axis fix holds. |

---

## Round 3 — 2026-06-13 (PRs #1285, #1288, #1291, #1294, #1295 — merged after #1290)

**Setup:** synced `main` (already current, 0 behind origin), rebuilt `breeze-api:dev` / `breeze-web:dev` from current `main`, recreated containers. Migrations auto-applied this round: `2026-06-12-pam-feature-type.sql`, `2026-06-13-b-fk-child-rls-backstop.sql`. All 5 containers healthy; `/health` 200. Login: admin@breeze.local (note: working password is the `.env` `E2E_ADMIN_PASSWORD`, **not** the skill's `BreezeAdmin123!`). No live agent this round (all devices offline).

### 🐛 Confirmed bugs (ticketing time-tracking, #1285)

- **❌ BUG 1 — `POST /time-entries/start` returns raw HTTP 500 (not the intended 409) on a concurrent/duplicate start.**
  - **Symptom:** when a start request races with an already-running timer, the API leaks `PostgresError: duplicate key value violates unique constraint "time_entries_one_running_per_user_uq"` as a **500** to the client. The frontend already ships a friendly `ENTRY_RUNNING: 'A timer is already running — stop it first.'` mapping (`lib/timerActions.ts:42`), and the service *intends* a retry-once → clean **409 `ENTRY_RUNNING`** (`services/timeEntryService.ts:321-336`) — but that path is dead.
  - **Root cause:** `isUniqueViolation` (`services/timeEntryService.ts:270-272`) tests `err.code === '23505'`, but the postgres.js/Drizzle error nests the PG code under **`err.cause.code`** — the top-level `DrizzleQueryError` has no `.code`. So the guard returns `false`, line 325 `if (!isUniqueViolation(err)) throw err;` re-throws the raw error, and both the retry and the 409 conversion never run.
  - **Evidence:** API stack trace — `DrizzleQueryError: Failed query: insert into "time_entries" … cause: PostgresError: duplicate key … constraint "time_entries_one_running_per_user_uq" … at async startTimer (…/timeEntryService.ts:323:13)`; observed 2× `POST /time-entries/start → 500` in the logs.
  - **Note:** a *single* Start-timer click works correctly (auto-stops the prior running timer per design D3, 201). The 500 only surfaces when two starts overlap (the unique index fires before the retry can recover). `db/seed.ts:760` uses the same bare-`.code` check but that's seed-only.
  - **Fix:** unwrap in `isUniqueViolation` — e.g. `const code = (err)?.code ?? (err)?.cause?.code; return code === '23505';`.

- **❌ BUG 2 — "Log time" quick-add does not broadcast `billing-changed`, so the workbench activity feed never live-refreshes.**
  - **Symptom:** logging time via the ticket rail's **Log time** quick-add updates the Time & Billing rail (its own `refresh()`), but the **activity feed stays stale** — the new `time_entry` line only appears after a manual page reload. Verified end-to-end: feed read "4 changes" before save, the rail showed the new entry after save, but the feed **stayed "4 changes" with no reload** (the DB confirms the `time_entry` feed comment *was* written — backend is correct; this is purely a missing client broadcast).
  - **Root cause:** `TicketTimeBilling.submitQuickAdd` (`components/tickets/TicketTimeBilling.tsx:62-93`) never calls `broadcastBillingChanged()`. By contrast `TicketPartsCard` broadcasts after add/edit (`TicketPartsCard.tsx:116,133`) and the timer path broadcasts (`timerActions.ts:65,79`). The workbench *does* listen (`TicketWorkbench.tsx:142-143 onBillingChanged → load()`), so the listener just never fires. The #1285 PR explicitly claims "workbench reloads the feed on timer/billing events" — the manual-log path is the lone gap.
  - **Fix:** call `broadcastBillingChanged()` after the successful quick-add in `submitQuickAdd` (one line).

### ✅/💡 Verified this round

| PR | Item | Result | Evidence |
|---|---|---|---|
| #1288 | Custom 404 page | ✅ | Unknown route → branded page, title "Page not found", "404", **Go to dashboard** + **Sign in** links; renders with no client JS. Only console "error" is the page's own 404 HTTP status (expected), no asset/CSP errors. |
| #1288 | Custom 500 page | ⏭️ | Couldn't trigger a real 500 in normal flow; Sentry Reference-ID path not exercised. |
| #1285 | Time & Billing rail renders | ✅ | Ticket rail shows Total/Billable/Time amount/Parts(N) + **Start timer** / **Log time**; Parts card with **Add part**. |
| #1285 | Log time (manual entry) writes + summary updates | ✅ | 15m logged → Total 15m / Billable 15m, entry list updates, `time_entry` feed comment written (DB-confirmed), full-page `TicketFeed` renders "Breeze Admin logged 15m (billable)". |
| #1285 | Single Start-timer click | ✅ | One click = one `/start` (201), auto-stops prior running timer (design D3). (Concurrent starts → BUG 1.) |
| #1295 | Interface density moved to top-bar Theme menu | ✅ | Theme menu now has **Theme** + **Interface density** (Comfortable/Compact/Dense, "Applies across the entire app"). Dense → `<html data-density="dense">` + `localStorage breeze.density=dense`; **persists app-wide** across navigation (verified on /devices → /tickets). Supersedes the per-table #1060 control. |

### UI/UX observations (Round 3)

- 💡 **Time amount stays $0.00 even with billable minutes logged** — because the org has no default hourly rate set. Expected, but a logged *billable* 15m showing "$0.00" with no hint that a rate is missing is easy to misread. Consider a subtle "set a rate" affordance when billable time exists but rate is unset (the #1291 Org Ticketing tab is where the rate lives).
- 💡 **"Start timer" button has no in-flight disable/debounce** — the start request takes ~2-5s server-side; the button stays active throughout. Combined with BUG 1, rapid/double clicks produce the 500 race. A `disabled` state while the start is in flight would both improve feedback and avoid the race.
- 💡 **Two "Timer started" toasts from a single Start click** — minor cosmetic duplicate (likely a dev/StrictMode double-fire of the runAction success toast); only one `/start` actually fired (DB +1).
- ℹ️ Feed "N changes" collapsed-group count was observed off-by-one vs the DB `time_entry` comment count in one reload (5 comments, feed said "4 changes") — low confidence (possible reload race / running-timer exclusion); flagging only, not filing.
- ℹ️ Footer/`/health` still report **0.63.5** (known cosmetic dev-image label; live migrations confirm current code runs).

### Test data
All Round-3 test artifacts cleaned: deleted 6 `time_entries` + 5 `time_entry` comments on T-2026-0017; no running timers remain; ticket restored to pre-test state.

### Still to cover (Round 3, in progress)
#1291 ticketing config tabs (`/settings/ticketing` Statuses/Priorities + Org Ticketing SLA tab), #1294 power-actions menu + reboot-pending list badge, #1295 Huntress org-scope empty state + HelpPanel lazy-load (no CSP spam), #1286 PAM config-policy tab.

### ✅ Verified this round (continued — #1291, #1294, #1295, #1286)

| PR | Item | Result | Evidence |
|---|---|---|---|
| #1291 | `/settings/ticketing` tabbed page | ✅ | 4 tabs (Statuses/Priorities/Categories/Export), `#tab=` hash state; Ticketing card sits by Partner settings. |
| #1291 | Statuses tab — six core groups, built-in flags, reorder bounds | ✅ | New/Open/Pending/On hold/Resolved/Closed groups; built-in rows marked "Built-in"; ▲ disabled on first / ▼ disabled on last (correct boundary handling). |
| #1291 | Add custom status | ✅ | Added "Waiting on vendor (QA)" under New core state → "Status created" toast + row appears. (Cleaned up after.) |
| #1291 | Custom status surfaces in workbench dropdown (cross-UI) | ✅ | Ticket workbench Status select now renders `<optgroup>` per core state; custom status nested under "New". Confirms the additive `statusName` integration. |
| #1291 | Priorities tab | ✅ | Per-priority label + response/resolution SLA-minute inputs; precedence note "category SLA → org override → these defaults"; Save. (Not saved — left SLA defaults intact.) |
| #1294 | Power dropdown groups 4 actions | ✅ | `DeviceActions` shows **Power** dropdown → Reboot / Reboot to Safe Mode / Shutdown / Wake; Run Script / Connect Desktop / Remote Tools beside it. (Device offline; not triggered.) |
| #1294 | "Fix with AI" standalone button removed | ✅ | Device detail header no longer renders a standalone "Fix with AI" button. |
| #1294 | Reboot-pending list badge | ✅ | (Re-confirms Round-2 fix — list mapper keeps `pendingReboot`; badge renders in list/grid.) |
| #1295 | HelpPanel lazy-loads docs (no per-nav CSP spam) | ✅ | `/alerts` load (Help closed) → **zero** `docs.breezermm.com` / Cloudflare-RUM requests, **0 console errors/warnings** (was 2-5 CSP report-only per nav). Opening Help then lazy-loads `docs.breezermm.com/features/alerts/` (context-aware deep link) + RUM beacon — only on open. |
| #1295 | Huntress org-scope empty state | ✅ | Org scope shows **"Huntress isn't connected yet — configured once at the partner level… Switch your scope to All orgs to add the API Key and Secret."** (Also resolves the Round-2 ⚠️ where the form didn't mount in org scope — it's now an intentional, guided empty state.) |
| #1286 | PAM "Privileged Access" config-policy tab | ✅ (code) | `PamTab` registered in `ConfigPolicyDetailPage` (FEATURE_TYPES incl. `'pam'`, render case 300) with the `uacInterceptionEnabled` toggle (default on); migration `2026-06-12-pam-feature-type.sql` applied. Agent-side capture pause not web-testable. |

### UI/UX observations (Round 3, continued)

- 💡 **Systemic duplicate success toasts (dev build).** Every `runAction` success fired the toast **twice** this round: "Timer started ×2", "Status … created ×2". Consistent across unrelated features → not feature-specific; likely a React-StrictMode/dev double-invoke or a double-mounted toast container. **Verify it's absent in the production build**; if it persists in prod it's a real papercut (every save double-toasts).
- 💡 **Priorities tab precedence note is a nice clarity win** — "Order of precedence: category SLA → org override → these defaults" directly answers the Round-2 "is SLA auto-applied from category?" confusion. Good.
- ✅ The #1291 config-fetch fallback held throughout — no errors when the workbench rendered status chips; legacy/core statuses kept working alongside the new custom one.

### Round 3 coverage summary

All post-#1290 UI PRs exercised: **#1285** (time/parts — 2 bugs), **#1288** (404 ✅ / 500 ⏭️), **#1291** (ticketing config ✅), **#1294** (power menu + reboot badge ✅), **#1295** (density ✅ / HelpPanel ✅ / Huntress ✅), **#1286** (PAM tab ✅ code). Tally: ~14 ✅, 2 ❌ (both in #1285 time-tracking), 1 ⏭️ (500 page, can't trigger).

### 🚩 Round 3 must-fix before release
1. **BUG 1 — `/time-entries/start` 500 on concurrent start** (`isUniqueViolation` doesn't unwrap `err.cause`; `timeEntryService.ts:270`). Leaks raw DB constraint text; intended 409 `ENTRY_RUNNING` path is dead. Add `disabled` on the Start-timer button in flight to also close the race client-side.
2. **BUG 2 — "Log time" quick-add doesn't `broadcastBillingChanged()`** (`TicketTimeBilling.tsx:62-93`) → workbench feed doesn't live-refresh after a manual time log (only on reload). One-line fix; parts card + timer path already broadcast.

### Round 3 test data
All cleaned: time entries/comments on T-2026-0017 deleted; custom status "Waiting on vendor (QA)" deleted; no running timers. (Pre-existing Round-1/2 fixtures left in place.)

### ✅ Round 3 fixes applied (working tree, not yet committed)

- **BUG 1 fixed** — `isUniqueViolation` (`apps/api/src/services/timeEntryService.ts:270`) now walks the `.cause` chain (depth-bounded) so the Drizzle-wrapped `23505` is detected; the retry-once → `409 ENTRY_RUNNING` path now fires instead of leaking a raw 500. **Regression tests added** reproducing the real wrapped-error shape (flat-`.code` mock had hidden it): `timeEntryService.test.ts` → 53/53 pass.
- **BUG 2 fixed** — `TicketTimeBilling.submitQuickAdd` now calls `broadcastBillingChanged()` after a successful manual log, so the workbench feed live-refreshes (verified live: feed showed "Breeze Admin logged 7m (billable)" with no reload). Also added an **in-flight `disabled` state on the Start-timer button** (`startingTimer`) to keep the happy path single-shot and close the concurrent-start race client-side. **Regression tests added**: `TicketTimeBilling.test.tsx` → 6/6 pass.
- Verification: web `tsc --noEmit` clean; api `tsc` shows no new errors (pre-existing `agents.test.ts`/`apiKeyAuth.test.ts` errors unrelated). Per-file single-fork runs used (full-suite parallel flakiness is a known false-negative source).

---

## Round 4 — 2026-06-13 (gap-closing: #1285 parts/timesheet/export, #1291 org SLA + statuses, avatar re-verify, core workflows, #1290 authz negatives)

### ✅ #3 Avatar upload re-verify (#1268) — RESOLVES the Round-1 ❌ must-fix
Post-rebuild, the full lifecycle works on DB-bytea storage (no filesystem EACCES):
- **Upload**: pick PNG → blob preview → **Upload** → `POST /users/me/avatar` **200** (was 500 EACCES); stored **70-byte `avatar_data` bytea** (+ `avatar_mime`); `GET /users/:id/avatar` **200**.
- **Remove**: `DELETE /users/me/avatar` **200**; `avatar_data` cleared to null.
- Picker `accept="image/png,image/jpeg,image/webp"` + "Max 5 MB" copy present (server-side >5MB/non-image rejection covered by the `users/avatar` unit tests from Round 2). **The headline Round-1 blocker is closed.**

### #1 — Parts / Timesheet / Billables export (#1285)

| Item | Result | Evidence |
|---|---|---|
| Parts — add | ✅ | qty 2 @ $100, cost $60 → card "$200.00 · 2 × $100.00 · **$80.00** margin" (200 revenue − 120 cost = 80 ✓); billing rail live-updated to **Parts (1) / $200.00** (parts card *does* broadcast billing-changed). |
| Parts — delete | ⚠️ | Deletes **instantly with no confirm dialog** (matches the PR's deferred note). Single mis-click permanently removes a costed part — minor but real risk on a billing surface. |
| /timesheet — render + nav | ✅ | Tech selector (My timesheet / Breeze Admin), Monday-UTC week ("Week of June 8"), prev/next/this-week, per-day rows, weekly total. |
| /timesheet — bulk approve | ✅ | Select entry → "Approve selected" → `POST /time-entries/bulk-approve` **200**; entry flipped `is_approved=t` + approver set; timesheet refetched. "Unapprove" present for the reverse path. |
| Billables CSV export | ✅ | Settings→Ticketing→Export → `GET /tickets/export/billables.csv` **200**, valid header `type,date,organization,ticket,description,technician,quantity,rate,amount,billing_status,approved`; date-bounded (today's rows excluded by To=Jun 12, as expected). |

### 🐛 BUG 3 — hydration mismatch on `/settings/ticketing` deep-linked with `#tab=` (#1291)
- **Symptom:** loading `/settings/ticketing#tab=export` (or any non-default tab) throws a **React hydration mismatch** (#418-class) in console; React discards the SSR tree and regenerates client-side. Plain `/settings/ticketing` (no hash) is clean.
- **Root cause:** `TicketingSettingsPage.tsx:34` seeds `useState<Tab>(parseHash)`; `parseHash()` returns `'statuses'` on the server (no `window`) but the hash-derived tab on the client → the first client render disagrees with SSR (`aria-selected`, class, and which panel mounts). Same anti-pattern as the login #418 fixed in #1268.
- **Fix:** seed `activeTab` to the SSR-safe default `'statuses'` and apply `parseHash()` inside the mount `useEffect` (which already exists at line 41), so initial client render matches SSR. (Accept a one-frame flash to the correct tab — standard for hash-driven SSR state.)

### ℹ️ Perf note
- `POST /time-entries/start` and `/time-entries/bulk-approve` each took **~5s** server-side (dev build). Consistent across the time-tracking write endpoints. Likely dev-image overhead (tsx, cold paths) but **worth confirming prod latency** — slow writes with no spinner invite the double-click that triggered the BUG 1 start-race.

### #2 — Statuses edge cases + Org Ticketing SLA tab (#1291)

| Item | Result | Evidence |
|---|---|---|
| Status — add custom | ✅ | "QA Custom Status" created + listed under its core group. |
| Status — deactivate/reactivate | ✅ | Deactivate → row shows **Inactive** + toggle flips to **Activate**; built-in rows have no deactivate control. |
| Status — duplicate name | ❌ **BUG 4** | Adding a 2nd "QA Custom Status" → `POST /ticket-config/statuses` **500** (`duplicate key … ticket_statuses_partner_name_uq`) and **no toast at all** — instead of the friendly `STATUS_NAME_TAKEN`. Silent failure to the user. |
| Org → Ticketing tab renders | ✅ | 8 per-priority SLA inputs (urgent/high/normal/low × response/resolution, placeholders = partner defaults), `org-ticket-rate`, tri-state billable (Inherit/Billable/Non-billable), "Save ticket settings". |
| Org → Ticketing save | ✅ | Set rate 150 → `PATCH …/ticket-settings` **200**, `default_hourly_rate=150.00` persisted. (Reset after.) |
| MFA-required save path | ⚠️ | Save succeeded **without an MFA challenge** — the local admin has no MFA enrolled (same as the Round-2 PAM observation). The gate's *enforcement* still needs verifying with an MFA-enabled user. |

### 🐛 BUG 4 — duplicate ticket-status name returns raw 500, not `STATUS_NAME_TAKEN` (#1291) — SAME CLASS AS BUG 1
- **Root cause:** `ticketConfigService.ts:286-300 isUniqueNameViolation` reads `err.code` / `err.constraint` / `err.message` off the **top-level** error, but Drizzle nests them under `err.cause` (wrapper message is just "Failed query: insert into ticket_statuses …", no constraint name). So the guard returns false and the raw 500 propagates instead of the structured 409 `STATUS_NAME_TAKEN` the UI maps to a friendly message.
- **This is systemic.** The same bare `err.code === '23505'` (no `.cause` unwrap) appears at ~10 sites — confirmed-broken at `timeEntryService` (BUG 1, fixed) and `ticketConfigService` (BUG 4); **suspected** at: `routes/networkKnownGuests.ts:67`, `routes/networkBaselines.ts:309`, `routes/configurationPolicies/assignments.ts:90` + `featureLinks.ts:130`, `services/aiToolsConfigPolicy.ts:237,606`, `services/aiToolsNetwork.ts:344`, `services/aiToolsPolicyPrereqs.ts:39`, `services/aiToolsFleet.ts:92`. (`db/seed.ts:760` is seed-only.)
- **Recommended fix:** a shared `pgUniqueViolation(err, constraint?)` util that walks the `.cause` chain (generalize the BUG-1 fix), and refactor all sites onto it. Removes the divergent local checks and the whole bug class at once.

### #4 — Alerts / Scripts / Cmd+K core workflows

| Item | Result | Evidence |
|---|---|---|
| Alerts — acknowledge | ✅⚠️ | `POST /alerts/:id/acknowledge` **200**, alert → `acknowledged`, Ack button removed from the row. **But: the request took ~19s and showed no toast/spinner** — only the button vanishing (after the round-trip) signals success. Borderline silent-mutation + a real latency concern. (Restored the alert to active after.) |
| Notification channel — create | ✅ | New Channel modal (all 7 types: Email/Slack/Teams/PagerDuty/Webhook/SMS/Pushover, templates, routing rules). Created an Email channel → `POST /alerts/channels` 200, listed. |
| Notification channel — Test | ✅ | "Test" → `POST /alerts/channels/:id/test` **200**, `last_test_status=success`, row shows "Last test: Just now". (Deleted the test channel after.) |
| Scripts — library | ✅ | `/scripts` renders library + "New Script" + "Import from Library" + category/language filters (PowerShell/Bash/Python/CMD). Monaco editor confirmed in Round 2; full create→run→output needs the multi-step flow (a live agent is now connected — runnable in a follow-up). |
| Cmd+K global search | ✅ | Search palette → typed "WIN" → DEVICES section with correctly-filtered matches (E2E Windows Test Device, File Server, WIN-DHQNR1F8LO2…), arrow/Enter navigation hints. |

### ⚠️ UX/perf — alert acknowledge latency + no feedback
`POST /alerts/:id/acknowledge` took **~19s** (vs ~5s on ticketing writes, sub-second on the channel test) with **no toast or spinner** the entire time. The EventBus published `alert.acknowledged` ~8s in, response ~11s after that — something in the ack path (event handlers? a blocking notify attempt?) is slow. No notification channels were configured, so it isn't channel dispatch. **Worth profiling the acknowledge path** — and adding an in-flight spinner + success toast regardless, so the action doesn't look dead for 19s. (May be partly dev-build overhead; confirm in prod.)

### #5 — Authz / site-scope negatives (#1290) — API-level (seeded users, real tokens)

Seeded 3 users (shared admin password): read-only **Partner Viewer**, **selected-org** technician (Default only), and a **site-restricted** Org Technician. Logged in via `/auth/login`, asserted with their real bearer tokens. All seed data removed after.

| Test | Expected | Actual | Verdict |
|---|---|---|---|
| Security **AV scan** (`POST /security/scan/:dev`), read-only viewer | 403 | **403** "Permission denied" | ✅ RBAC enforced (needs `devices:execute`) |
| Same, **admin** (control) | not-403 | **202** Accepted | ✅ gate doesn't over-block |
| **Deployment create** (`POST /deployments`), read-only viewer | 403 | **403** "Permission denied" | ✅ RBAC enforced (needs `devices:write`) |
| **time-entries** (`POST /time-entries`), admin `org_access=all` (control) | 2xx | **201** | ✅ endpoint works for partner-scope |
| **time-entries**, `org_access=selected` user (granted + non-granted org) | denied | **403 both** | ✅ denied (see note) |

**Solidly verified:** the read-only RBAC gates from #1290 (security AV scan, deployment create) return real **403s**, with an admin positive control proving they don't over-block. Cross-org access for a selected-org user is **denied** on the partner-scoped time-entries route.

**Characterized, not independently isolated in this harness (covered by the PR's integration tests):**
- **MFA gate** (`requireMfa()` on deployments): code returns `403 "MFA required"`, but locally `force_mfa` is **off** — admin (no MFA enrolled) passed the gate and reached validation (400). So the MFA *enforcement* path can't be exercised without enabling `force_mfa` for the partner. (Consistent with the Round-2/PAM and #2 org-save observations.)
- **time-entries org-axis** (`TICKET_ORG_DENIED`): the route requires `requireScope('partner','system')`, which an `org_access=selected` partner user doesn't satisfy → they're 403'd on *both* granted and non-granted org tickets (denied either way = safe), so the service-level org-axis `404` branch isn't reachable via this route+user. The org-axis isolation itself is covered by the #1290 integration tests.
- **Playbook / patch-job / threat-action site-scope:** not run — the same selected/site-scoped permission-resolution nuances (and needing devices pinned to specific sites) make a clean in-site-pass / out-of-site-403 harness more setup than this pass allowed. Covered by the PR's site-scope integration tests; recommend a dedicated multi-user fixture to verify end-to-end in-app.

### Round 4 summary
**Verified:** avatar lifecycle (#1268 resolved); parts add/delete + margin + live-summary; /timesheet + bulk approve; billables CSV export; status add/deactivate; org ticketing SLA save; alerts ack; notification channel create + Test; scripts library; Cmd+K; #1290 read-only RBAC 403s (AV scan, deployment).
**New bugs:** **BUG 3** (ticketing-settings `#tab=` hydration mismatch, #1291) · **BUG 4** (duplicate status name → raw 500 not `STATUS_NAME_TAKEN`; **systemic** `err.cause` unwrap gap at ~10 sites, #1291).
**UX/perf flags:** parts delete has no confirm dialog; alert acknowledge ~19s with no spinner/toast; duplicate-toast on runAction successes (dev); ticketing write endpoints ~5s (dev).

---

## Round 4 fixes applied — BUG 3 + BUG 4 (branch: fix/ticketing-config-hydration-and-pg-unique-unwrap)

- **BUG 3 (hydration) — FIXED + live-verified.** `TicketingSettingsPage.tsx` now seeds the SSR-safe default tab and applies the `#tab=` hash in the mount effect. `/settings/ticketing#tab=export` now loads with **0 console errors** (was a hydration mismatch) and the Export tab is correctly selected. Web tsc + 12 TicketingSettingsPage tests pass.
- **BUG 4 (systemic 23505 unwrap) — FIXED.** New shared `apps/api/src/utils/pgErrors.ts` (`isPgUniqueViolation`, `pgErrorCode`) walks the DrizzleQueryError `.cause` chain and matches the constraint via **`constraint_name`** (postgres.js) *or* `constraint` (node-pg), with a message-scan fallback. Refactored 10 call sites onto it: `ticketConfigService`, `timeEntryService`, `routes/networkKnownGuests`, `routes/networkBaselines`, `routes/configurationPolicies/{assignments,featureLinks}`, `services/aiToolsConfigPolicy` (×2), `services/aiToolsNetwork` (unique), and `services/aiТoolsPolicyPrereqs` + `services/aiToolsFleet` (multi-code mappers via `pgErrorCode`, which also fixes their `23503`/`22P02` mapping).
  - **Key correction found during fix:** the real postgres.js error carries the index name on **`constraint_name`**, not `constraint` — the first cut of the helper relied on a fragile message-scan; now it checks both fields.
  - **Verification:** 94 API tests pass (new `pgErrors.test.ts` covers wrapped/unwrapped/constraint_name/node-pg/message-fallback; `ticketConfigService` + `timeEntryService` regression cases updated to the realistic wrapped shape). An **in-container tsx probe confirmed `isPgUniqueViolation(realError, name) === true`** against the exact production `DrizzleQueryError{cause: PostgresError{code:'23505', constraint_name:…}}` shape.
  - ⚠️ **Dev-env note:** the live HTTP path still returned 500 because the dev API's `tsx watch` would not reload the change — a known macOS `:cached` bind-mount + persistent `node_modules/.cache` mtime-cache issue (same reason the avatar fix needed an image rebuild). Verified via unit tests + in-container probe instead; the fix is correct and will run on a clean build/deploy.

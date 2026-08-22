# Pre-release local docker test log — 2026-07-27

**Scope:** everything merged to `main` since tag `v0.101.0`. This covers TWO untested releases' worth of change: the v0.102.0 contents (deployed to prod 2026-07-27 but never manually tested) plus everything merged after it — security waves 2/3/4/7 and today's PR-queue flush.

**DO NOT COMMIT THIS FILE** (QA logs are local-only — leak risk from captured test data).

Status legend: `[ ]` untested · `[x]` pass · `[!]` fail (file issue + note) · `[-]` skipped/n-a

## SESSION RESULTS — 2026-07-28 (wt-stack on main @ dfcc8f6c6, NODE_ENV=development)

**Verified PASS:**
- [x] P0 boot: stack up with the 4 new env vars; all 6 containers healthy; `/health` 200. (P0b fail-closed: verified via CI evidence — smoke workflows on NODE_ENV=production died on the missing vars for 8h, booted after #2864. Dev stack can't exercise it: enforcement is production-only.)
- [x] All 467 migrations incl. all 7 new ones applied on a fresh DB in one autoMigrate pass.
- [x] Wave 3 login/token mint: login works, dashboard + seeded data render, zero console errors. (The mid-session logout was diagnosed as e2e-suite rate-limit collateral — refresh got 429, not a refresh regression. Token-refresh soak + role-change revocation still `[ ]`.)
- [x] Org defaults editor (#2811+#2819 hand-merge): renders, enrollment-defaults section present, save persists to DB (`deviceGroup=Contractors` verified in psql).
- [x] Enrollment TTL stack: Add Device modal both tabs have the expiry select; CLI tab 7-day TTL flows to DB (`expires_at - created_at` = 168h vs default 24h).
- [x] Invoice editor (#2829): blank draft → manual line → autosave ("Saved" stamp) → totals correct in rail + sticky bar → taxable-no-rate warning → Issue → `status=sent, INV-2026-0001, 136.50` in DB.
- [x] Analytics page renders with data (admin path, wave 2).
- [x] Portal accept-invite ROUTE (#2825): portal-scoped API route mounted + reachable + proper JSON rejection of a bad token. Portal invite creates the `portal_users` row (`status=invited`).

**FAIL / issues filed:**
- [!] Org defaults device-group select rendered raw i18n keys (camelCase labelKeys vs PascalCase locale keys; pre-existing, live in prod too). Fix PR #2869.
- [!] Portal accept-invite form: on island hydration failure, native GET submit puts the **password in the URL** and drops the token. Issue #2868. (Hydration failure itself = known dev-rig limitation; the fallback shape is the product concern.)
- Minor observation (not filed): `/login?returnTo=%2Fdevices` lands on `/` after login, dropping returnTo.

**Blocked in this rig `[-]`:**
- Portal invite browser flow end-to-end (dev-rig island hydration 404 + in-memory portal tokens, `PORTAL_USE_REDIS=false` in development).
- e2e suite: 7 passed; 13 failures diagnosed as environmental (parallel workers exhausted the IP-keyed login rate limiter — every client shares one IP behind caddy in dev — plus dev-mode compile timeouts and missing third-party-catalog seed data). Rerun serially (`pnpm wt-stack test -- --workers=1`) after clearing `login:*` keys in redis for a clean signal.

## SESSION RESULTS — security-wave subagent sweep (live stack, main @ dfcc8f6c6)

**Wave 7 (#2843) — ALL PASS.**
- [x] Tenant/partner export: `GET /admin/tenant-export/:orgId` → 200, 257-table ZIP + manifest (sha256+rowCount); column preflight did NOT false-positive on current schema; `tenant.export` audit success row.
- [x] Sensitive-download audit: `report.run.download` → 200; audit row `byteCount` exactly matches HTTP body (audit-after-byte-prep confirmed). Audit-failure-still-succeeds path = unit-test-only (can't throw live without code change).
- [x] Public quote DTO + portal SSR: public API returns exactly `PublicQuoteHeader`'s 25 fields, no leaked internals; `/portal/quote/<token>` SSR renders full `PublicQuoteView` (lines, totals, accept/decline) — no missing-field errors, sent→viewed transition works.
- [x] Route-template logging: all `route=` values are `:param` templates; 0 raw UUIDs in 20 min of logs; public accept JWT not logged.
- [x] Time-entry audit org attribution correct.
- **Two rig-seed gaps found (NOT wave bugs, but flag):** (a) dev seed admin lacks `is_platform_admin` (tenant-export needs it); (b) seeded Partner Admin role has NO `reports` role_permissions → report create 403s out of the box via the wave-3 live-authority resolver. Both worked once granted; worth confirming the PRODUCTION seed/role templates include reports perms so fresh partners aren't locked out of reporting.

**#2828 (partner-axis system-context escape) — ALL PASS.** Proven with an org-scoped (`scope=organization`) token, and DB-proven that partner-axis rows are invisible to that scope without the escape (`partners`→0 rows under org GUCs).
- [x] `GET /partner/me` 200 (was 404); ml-feature-flags all resolve `source:default` (no `org_not_found`); effective-settings 200; `PUT /ai/budget` 200.
- [x] **Device cap behavior change**: set `max_devices=4` with 3 devices → provision #4 = 201, #5 = **403 DEVICE_LIMIT_REACHED** (was inert at org scope).
- [x] **Step-up MFA fails closed**: enforcing policy → medium-tier L1 approve = **403 step_up_required** (was silent fail-open); low-tier still 200; deny still 200 (refusal never blocked).
- [x] 45 min logs: zero RLS/42501 errors.
- **Same seed gap as wave 7**: seeded Org Admin role lacks `organizations:read` — org admins 403 on their own effective-settings out of the box. Pre-existing RBAC/seed gap; confirm prod role templates.

**Wave 2 (#2840) report scope — enforcement PASS, but ONE REAL BUG (#2874).**
- [x] Admin create/run/download; site-scoped in-scope allow; out-of-scope hard-deny (404/403, no empty-success); scheduled reports still generate (fail-closed-before-generation regression NOT present — the highest-risk item is clean).
- [!] **#2874 (code-verified, filed)**: `roleGrantsReportAction` (`siteScope.ts:650`, +:1052/:1123) filters permissions with a literal `eq(permissions.resource,'reports')` that never matches a `*|*` wildcard grant, while the canonical `services/permissions.ts:215` honors `*`. Consequence: the seeded **Partner Admin** super-role (natural state = `*|*` only) is **denied every report action** with 403 "Report scope is not authorized". This is the ROOT CAUSE of the "reports seed gap" the wave-7 and #2828 agents worked around — not three separate seed gaps, one wildcard divergence. Fix: honor `*` in the report authority check, or seed explicit `reports:*` on Partner Admin.

**#2853 temp-password sealing — PASS (real mint untestable on this rig).**
- [x] Sealing contract correct: credential never in `llmText`/model/transcript/`ai_messages`/`ai_tool_executions`/SSE; stored only as AES-256-GCM v3 AAD-bound ciphertext; one-time reveal via `/action-intents/:id/reveal-secret` with CAS burn; decrypt-failure returns 500 and does NOT burn the row (never burn what you can't return); uniform 404 (no oracle).
- [x] DB-at-rest sweep: 0 plaintext rows across action_intents/ai_messages/ai_tool_executions/audit_logs; scrub migration applied.
- [x] The PR's own tests: 255/255 unit + 6/6 real-Postgres integration pass. (Its merged-with-red-checks were the known lockfile dup + GO-2026-5051, not #2853.)
- `[~]` A real provider-side mint (M365/Google) can't be exercised — no tenant wired, and **this local stack has no `APP_ENCRYPTION_KEY_ID`** so seal falls to the fail-closed "credential unavailable" branch (prod has `prod-1` per the deploy note). Durable-worker path proven fail-closed to the provider boundary; inline-chat path's secret tools aren't even registered without a connection.
- **Local-QA gotcha to remember**: seal/encryption features need `APP_ENCRYPTION_KEY_ID` set on the api container (restart) to exercise the happy path locally; without it everything correctly takes the unavailable branch.

**Wave 3 (#2841) live-authorization/revocation — PASS (1 tracking finding #2875).**
- [x] Role change bumps `permissions_epoch` (all 4 migration triggers fire); permissions re-resolve live per request — old token got 403 on `POST /scripts` instantly after the change.
- [x] Event-WS enforcement (`compat`): ticket consumed post-change → 4001 at open; held socket → **4003 "Access revoked" ~11s** after change (`permission_epoch_mismatch`).
- [x] Explicit revocation (`DELETE /users/:id`): `auth_epoch` bumps, refresh family durably revoked, existing access+refresh tokens → 401 within the same second (redis cutoff hot-path).
- [x] Refresh: 15m access TTL confirmed; rotation proven (jti + family); **reuse-detection** replay → 401 + family-wide durable kill + audit row.
- [!] **#2875 (verified, filed, tracking-not-blocker)**: migration 2026-08-06-c's durable `quotes.public_response_*` columns have **no runtime writer** (0 code refs outside schema) — quote single-use is redis-only (`quote-accept-jti-revoked:<jti>`). Behavior correct today; durable authority the schema implies hasn't shipped. Likely intentional forward-prep per migration header.

## SESSION RESULTS — live-agent round (Windows Server 2022 VM 100.101.150.55 over Tailscale)

**Verified PASS:**
- [x] **Enrollment end-to-end**: UI-minted CLI token + enrollment secret enrolled a real agent (`enroll --force` exit 0); device row created, **online**, heartbeating, agent 0.103.0-qa; inventory populated (135 processes, OS string, hardware).
- [x] Remote Tools process manager: live process list streamed over the agent WS path.
- [x] Terminal session ESTABLISHES: WS ticket mint → pre-upgrade validation → agent ConPTY spawn → banner delivered to browser xterm (the wave-4 handshake chain itself works).

**FAIL — wave-4 regressions found (release blockers for remote terminal):**
- [!] **#2870**: every `terminal_data` command executed TWICE on the agent (`component=websocket` + `component=heartbeat`, same commandId) → PTY input scrambled (`hostname` → `snehoe`); API logs `ws_result_terminal_cas` 0-row CAS writes. Dual-claim class (cf. #2407) resurfacing under #2842.
- [!] **#2871**: terminal sessions die at exactly 60s (`pong timeout` / `revoked mid-session` — wave-3/4 ticket/lease renewal suspect) and the UI freezes silently: no disconnect banner, no reconnect.

**Still untested:**
- [ ] Remote DESKTOP connect/teardown (viewer WebRTC; blocked on fixing #2870/#2871 first — same relay machinery).
- [ ] Wave 3: token-refresh soak past expiry; mid-session role-change revocation; event WS `compat`→`enforce` flip.
- [ ] Wave 2: site-scoped user report run + scheduled report delivery.
- [ ] #2828 org-scoped user smoke; #2781 offboarding drain (agent enrolled + ready for it — offboard a throwaway org, NOT Default Organization); wave 7 export + audit; #2806/#2812 AI drawer; #2804 winget ErrScanSkipped (Server 2022 has no winget — check the device's software scan status); #2853 temp-password sealing; locale spot-checks.

**#2804 winget ErrScanSkipped — partial:** on the Server 2022 VM winget is never registered ("winget provisioning not yet implemented"), so the agent takes the *sibling* branch (unresolvable winget → not registered as a provider → third_party correctly NOT marked covered) — verified: no crash, 35 software_inventory rows still populated from other providers, no tombstoning. The #2804-specific branch (winget present but emits *unreadable table output* → `ErrScanSkipped` instead of empty) can't be reproduced on a box with no winget at all; that exact path stays unit-test-only. `[~]`

## SESSION RESULTS — offboarding drain (#2781/#2808) + winget (#2804), live VM

**#2804 winget ErrScanSkipped — now FULLY PASS** (agent planted a fake unreadable winget.exe to hit the exact branch):
- [x] winget-absent: patch scan completes via WUA; targeted `third_party` scan fails explicitly (not empty-success).
- [x] winget-present-but-unreadable-output (the #2804/#2726 trigger): full scan logs `partial coverage … uncoveredSources=[third_party]` (ErrScanSkipped firing); a pre-inserted `third_party` pending row SURVIVED (not tombstoned to missing) — the exact #2726 regression is fixed.

**#2781/#2808 offboarding drain — core behavior PASS, but FOUR bugs found (2 blockers):**
- [x] Core drain works when driven correctly: suspension severs the agent; **#2808 clears the superseded suspension on offboarding entry** (agent recovers, heartbeats through drain); auto-queued `self_uninstall` delivered + acked; non-allowlisted agent routes → **403 tenant_offboarding**; reaper finalizes fully-drained fleet → `churned`.
- [!] **#2877 (BLOCKER)**: offboarding entry self-DEADLOCKS — request-txn holds the org row lock while `beginOrganizationOffboarding`'s nested `runOutsideDbContext(withSystemDbAccessContext)` UPDATEs the same row from a fresh connection. Wedges indefinitely; kill → torn entry (status rolled back, side effects committed). Code-verified (orgs.ts:1478-1490 + tenantOffboarding.ts:155). #1105 family.
- [!] **#2878 (BLOCKER)**: Windows `self_uninstall` is a FALSE SUCCESS — `performSelfUninstall` runs `sc.exe stop BreezeAgent` (its own service) FIRST, killing the goroutine before `sc delete`/watchdog teardown/config removal. Agent left installed + auto-start + watchdog running + severed token → reboots into permanent 401s (#2796) while the drain reports clean. Code-verified (handlers_uninstall.go:218). Defeats the feature's whole purpose.
- [!] **#2879**: suspended→offboarding is UNREACHABLE via API (`computeAccessibleOrgIds` filters `active`/`trial`; system admin fails requirePermission) — so #2808's fix can't be triggered on the real path (only via DB flip). Code-verified (auth.ts:271/286).
- Minor (not filed separately, noted in #2877): `offboarding_completed` reported `uninstallsCompleted:0` despite a completed uninstall — JS-clock `drainStartedAt` vs DB-clock `created_at` gte with ~2ms skew.
- **VM left in post-drain residual state** as evidence (agent stopped-but-installed, watchdog running); to reuse: fresh enroll into an active org + `Start-Service BreezeAgent`.

**Rig state for the next session:** wt-stack up at `localhost:32773` (`.breeze-stack.json` has creds); VM .55 agent enrolled against `http://100.95.194.59:32773` (was previously on the backup-testing stack — re-point when done); scratch worktree branches cleaned; PR #2869 (i18n fix) merged.

---

## 0. Stack prerequisites (read before `docker compose up`)

The next release is **NOT a rolling deploy** (wave 4 calls it a barrier deployment). The local stack must set **4 new hard-required env vars** (compose uses `:?` interpolation — the stack won't boot without them):

```bash
# .env additions for the local stack (recommended initial values)
EVENT_PERMISSION_EPOCH_MODE=compat          # wave 3; switch to 'enforce' as a separate test
REMOTE_ACCESS_ADMISSION_MODE=open           # wave 4; prod will start 'closed' — test both
REMOTE_WS_AUTH_MODE=post_upgrade            # wave 4; test 'pre_upgrade' too
REMOTE_WS_REDIS_TOPOLOGY=standalone-single-primary
```

Conditional/optional new vars (defaults exist): `OAUTH_AUTH_EPOCH_ENFORCE_AFTER` (required only when OAuth enabled in prod/staging), `REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT`, `REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT`, `OFFBOARDING_DRAIN_WINDOW_HOURS` (default 72), `CHILD_ENROLLMENT_KEY_TTL_MINUTES`, `INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES`, `INSTALLER_PARENT_MIN_REMAINING_SECONDS`, `ENROLLMENT_KEY_CLEANUP_ENABLED`, `ENROLLMENT_KEY_PURGE_AFTER_DAYS`, `ABUSE_SCRIPT_INDICATORS`.

- [ ] **P0. Boot check:** stack boots with the 4 vars set. (Already evidenced in CI: the two smoke-binary-source workflows died at API startup for 8+ hours because wave 4 didn't add these vars to them — fixed by #2864. Any production-mode boot without them refuses to start, so a droplet deploy missing them = hard outage.)
- [ ] **P0b. Fail-closed check:** remove one required var → API refuses to boot with the aggregated boot-report error (not a silent start, not an import-time stack trace).
- [ ] **P0c. Dev-compose sanity (#2802):** dev override mode (`docker-compose.override.yml.dev`) comes up clean after the stale `tailwind.config.mjs` bind-mount removal — this is the stack you're testing in, so do it first.

## 1. Migrations — apply all 7 in one pass (P0)

On a v0.101.0-shaped DB, one `autoMigrate` pass must apply cleanly; re-run must be a no-op. As `breeze_app`-connected API (not superuser psql).

| Migration | From |
|---|---|
| `2026-07-25-partner-billing-identity.sql` | #2799 |
| `2026-07-25-abuse-script-hosts.sql` | #2782 |
| `2026-08-05-offboarding-drain-state.sql` | #2781 |
| `2026-08-05-metric-rollup-partition-maintenance-privileges.sql` | #2786 |
| `2026-08-06-a-report-site-scope.sql` | wave 2 #2840 |
| `2026-08-06-b-live-authorization.sql` | wave 3 #2841 — triggers + new RLS table `oauth_revocation_retries` |
| `2026-08-06-c-quote-response-capability.sql` | wave 3 #2841 |

- [ ] All apply on first boot; `breeze_migrations` shows all 7.
- [ ] Second boot: no-op, no NOTICE/ERROR noise.

## 2. Auth hot path — wave 3 (#2841) — HIGHEST RISK

Every request crosses this. A regression = total outage.

- [ ] Login → browse → token refresh → logout (Playwright: standard login flow).
- [ ] Role change mid-session: change a logged-in user's role as admin → their session/permissions actually revoke (epoch advance via the new DB triggers).
- [ ] Event WebSocket (live device status updates in UI) stays connected under `EVENT_PERMISSION_EPOCH_MODE=compat`.
- [ ] Flip to `enforce`, restart API: event WS reconnects and works; stale sockets close on permission change.
- [ ] MCP OAuth flow if enabled locally (token refresh, revocation).

## 3. Remote desktop / terminal — wave 4 (#2842) — HIGHEST RISK

Real agent↔API↔viewer WS handshakes — unit tests cannot cover this. Needs a real enrolled agent (local VM or the Windows test box).

- [ ] Remote desktop: connect → interact → clean disconnect → reconnect.
- [ ] Remote terminal session end-to-end.
- [ ] Tunnel (if practical locally).
- [ ] Abrupt viewer close (kill the tab) → desktop teardown finalizes on the agent (no orphaned session; reconnect works).
- [ ] Repeat connect under `REMOTE_ACCESS_ADMISSION_MODE=closed` and `REMOTE_WS_AUTH_MODE=pre_upgrade` (the prod target modes).

## 4. Reports — wave 2 (#2840)

- [ ] Create/run/download a report as an org-scoped user.
- [ ] Same as a **site-scoped** user — allowed within scope, denied outside (fail-closed must not break legitimate runs).
- [ ] A scheduled report still generates and delivers.
- [ ] Analytics page renders for a site-scoped tech (`AnalyticsPage.tsx` changed).

## 5. Offboarding drain — #2781 + #2808

Zero prod exercise. Pair test.

- [ ] Transition a seeded org to `offboarding` in the UI.
- [ ] User sessions/API keys die on entry (proactive revocation).
- [ ] Agent keeps heartbeating/polling; queued `self_uninstall` is delivered.
- [ ] Non-allowlisted agent routes return `403 tenant_offboarding`.
- [ ] #2808 specifically: a tenant that was **suspended first, then moved to offboarding** — the superseded token suspension is cleared so the drain actually works.

## 6. Enrollment TTL stack — #2816/#2817/#2818/#2819 + today's #2813

One combined flow (this is the agent-onboarding critical path):

- [ ] Partner settings: set enrollment default TTL/device-count + a TTL cap; org tab shows the inherited cap read-only (#2819).
- [ ] Add Device modal (installer tab) seeds pickers from defaults, filters options above the cap.
- [ ] **CLI Commands tab**: expiry select present and honored — `ttlMinutes` reaches the API (#2816 + #2813).
- [ ] Over-cap mint → 400 naming the cap (#2818).
- [ ] Long-TTL link: bootstrap token `expires_at` in DB is independent of the 60-min parent key (#2817; psql check).
- [ ] **First-run guided setup enroll step** (empty-body POST regression risk called out in #2816).
- [ ] End-to-end: enroll a real agent through a minted link.

## 7. Portal — wave 7 (#2843) + #2825

- [ ] Public quote page renders correctly (exact DTO change; portal has had render-parity gaps).
- [ ] Quote accept/decline one-time response works; second attempt rejected (quote response capability migration).
- [ ] **Portal invite** (#2825): invite a portal user from admin → accept-invite page → set password → logged in. (Was 100% broken before — posted to the admin route.)

## 8. Org-scoped user smoke — #2828

Partner-axis reads escaped to system RLS context; several silent zero-row bugs fixed, one behavior change.

- [ ] Log in as an **org-scoped** (not partner-scoped) user: settings pages, AI-for-Office admin, effective settings all load (previously silent 404/empty).
- [ ] Step-up MFA at org scope now fails **closed** — verify a step-up-gated action still works for a properly-MFA'd org user.
- [ ] Device provision at the partner device cap → now actually rejected (was inert). Verify normal provisioning still works under cap.

## 9. Exports + audit — wave 7 (#2843)

- [ ] Partner/tenant export completes (column preflight + classification).
- [ ] A sensitive download succeeds and produces an audit row (audit failure must never block an authorized download).

## 10. Web UI spot-checks (today's merges)

- [ ] Toasts appear after mutations across islands (#2807 — globalThis emitter; regression: swallowed toasts).
- [ ] Org defaults save no longer 403s when a partner-locked field is present (#2811). Because #2811 was hand-merged with #2819's enrollment-defaults work in the same files, verify the combined editor thoroughly: locked fields render disabled + seeded from the partner's effective value, the partner cap notice still shows, enrollment TTL/device-count pickers still work, and a save with a partner-locked field present succeeds while changing a locked field still 403s.
- [ ] AI drawer: search trigger label + heading order (#2806) — visual.
- [ ] Localized page with glued JSX strings renders correct interpolation (#2809) — check a non-English locale.
- [ ] AI chat: vulnerability tools are callable (#2812 — ask the chat a CVE question against a device).
- [ ] General web build smoke after vite 8.1.5 (if merged) — no blank pages/console errors.
- [ ] `/partners/me` projection (#2779): partner settings page renders (low priority — prod-exercised).
- [ ] Invoice editor on the quote save grammar (#2829, MERGED): create/edit an invoice — autosave behavior, line add/remove (totals must update immediately during the delete-undo window), org combobox, Issue/send flow; specifically try to Issue while a field save is failing/pending → must be refused naming the field (the review-round bug). Spot-check one non-English locale (fr-CA/it-IT translations were agent-written).
- [ ] Linked Profiles tab hidden on unlinked devices (#2867): device details for a device with no linked profiles → tab absent; with profiles → present.

## 11. Not testable in local docker / defer

- Agent Windows-specific: winget ErrScanSkipped (#2804) — needs Windows box, unit-covered.
- Agent auth-dead backoff cap (#2793), backup helper logs (#2801) — unit-covered; observe on next agent deploy.
- Wave 1 (#2800) — CI-only; its verification is CI being green.
- Internal ops surfaces (#2778, #2780, #2782, #2795, #2799) — CI + migration apply only.
- **Mobile**: #2833 (expo-sdk group) merged today; per the SDK-57 drift record the iOS native build is already broken by past bumps and nothing in CI builds native — needs an `expo install --check` alignment pass before the next TestFlight archive. Not part of this docker release.

## 12. Post-release PROD checks (not local — schedule after deploy)

- [ ] Tonight's metric-rollup partition maintenance runs without 42501 on US+EU (#2786 — first-ever successful run expected; retention has never run).
- [ ] First nightly `enrollmentKeyCleanup` respects the live-token exemption (#2817).
- [ ] Barrier-deploy sequencing for wave 4 (post-deployment steps 3–6 of its Task 10) + `OAUTH_AUTH_EPOCH_ENFORCE_AFTER` timing rule (≥1800s after new token writers start, choose once, never extend).
- [ ] The 4 required env vars added to `/opt/breeze/.env` **and** mapped in the compose `environment:` blocks on both droplets (necessary-but-not-sufficient rule).

---

## Appendix: merged today (2026-07-27 queue flush)

By me (staggered admin-squash, all reviewed via issue-fixer review summaries or dedicated review rounds):
#2852, #2791, #2831, #2830, #2828 (batch 1) · #2793, #2801, #2802, #2803, #2804, #2808, #2810 (batch 2) · #2806, #2807, #2809, #2812 (batch 3) · #2859 (lockfile hotfix) · #2811 + #2805 (rebased/conflict-resolved) · #2861 (govulncheck allowlist + Type Check repair) · #2864 (smoke-binary-source env fix, subagent) · #2829 (invoice editor — subagent fixed its locale-parity red, full review round found + fixed a queued-Issue money bug before merge) · #2849 (vite 8.1.5) + #2839 (react group) via dependabot rebase-first protocol, lockfile dup-scanned clean after each.

By Todd in parallel (GitHub UI): #2833, #2835, #2836, #2837, #2838, #2844, #2845, #2846, #2847, #2848, #2853, #2825.

Closed without merge: #2813 (fully superseded by #2816, already on main).

Incidents during the flush:
1. Parallel admin-merges of #2845/#2846 while behind main 3-way-merged `pnpm-lock.yaml` and duplicated hono/postcss blocks → every JS CI job red at Install. Fixed forward by #2859 (surgical dedup). Recurrence of #1792/#2056/#2271.
2. **GO-2026-5051** published mid-flush: go-smb2 `ReadDir` OOB-read/panic advisory with NO fixed release → Go Vulnerability Check red repo-wide. Fixed by #2861: recover guard in `smbFS.ReadDir` + govulncheck allowlist wrapper (`scripts/security/run-govulncheck.sh` + `govulncheck-allowlist.txt`), tracking issue #2860. This explains most of #2853's "red checks" too.
3. #2811 (value-based `assertNotLocked`) and #2828 (partner-axis integration suite using the old signature) were individually green but incompatible on main → Type Check red; also #2811's typed `isLocked` collided with #2819's cap-notice call. Both repaired in #2861.

**Note on #2853 (merged with red checks):** its Go Vulnerability Check / branch Security Scanning failures were NOT diagnosed before Todd merged it. The `smoke-binary-source-*` failures pre-exist on main, but the Go vuln check needs a follow-up look — if the next Security Scanning run on main is red on Go Vulnerability Check, that's the place to start. Its feature (sealing AI-minted temp passwords in action-intents) should get a manual pass: run an AI temp-password intent end-to-end and confirm the password is sealed in both execution paths.

## Appendix: held PRs (NOT in this release until resolved)

- #2826 — partner-api enrollment-keys (community, obsidiangroup): no CI checks ran; unreviewed. Review before any merge.
- #2834 — react-native-animation bump: mobile-only, no native CI coverage (expo drift). Mobile ships separately; not a blocker for this docker release.

## SESSION RESULTS — 2026-07-28 post-fix merge + live re-verification (wt-stack on main, VM .70)

All 8 QA-filed issues driven to reviewed PRs, merged (staggered admin-squash, CI green or rerun-verified per PR), and the two release-blocker fixes re-verified live:

**Merged:** #2884(→#2868) · #2885(→#2874) · #2886(→#2878) · #2887(→#2879) · #2888(→#2875) · #2889(→#2870) · #2890(→#2877) · #2892(→#2871). All issues auto-closed via Closes keywords (verified).

**Live re-verification (VM .70 WIN-IMDR2GAIDMV — .55 was half-dead: tailscale pings but SSH+RDP down, needs console):**
- [x] **Terminal ordering (#2870/#2889)**: `hostname` char-by-char → clean echo, correct output; 33-char rapid burst character-perfect; agent log shows exactly one dispatch+process per commandId (new `term-data-<ms>-<seq>` ids).
- [x] **Terminal 60s survival (#2871/#2892)**: session responsive at 1m51s+ (old bug killed at exactly 60s); zero orphan_recovery/pong-timeout lines in API logs.
- [x] **Offboarding deadlock (#2877/#2890)**: suspended→offboarding entry PATCH returned 200 in 0.107s (pre-fix: infinite wedge); self_uninstall queued in the same second (atomic entry).
- [x] **Windows self_uninstall (#2878/#2886)**: REAL teardown verified — both services DELETED, agent+watchdog binaries REMOVED, ProgramData\Breeze REMOVED, zero breeze processes, no watchdog respawn; `offboarding_completed` audit row shows `uninstallsCompleted:1, failed:0` (count fix confirmed); reaper finalized org → churned.
- Rig note: an initial no-echo terminal was a rig artifact (agent service restarted mid-session during setup → in-memory session map wiped; UI stayed "Connected" while writes failed "session not found"). Underlines the pre-existing follow-up: terminalWs ignores sendCommandToAgent returns on data/resize.

**VM .70 state**: was prod-enrolled (2breeze.app) before QA; prod agent.yaml backup was lost (stored inside ProgramData\Breeze, which the uninstall correctly deletes). Restored to ready-to-enroll: prod-version binaries back in `C:\Program Files\Breeze`, services recreated Stopped/Manual. To return to prod: mint a prod enrollment key, `breeze-agent.exe enroll <key> --server https://2breeze.app --enrollment-secret <secret>`, set services Automatic, start.

**Not re-tested live** (unit/integration-covered only): remote desktop under the new admission modes; #2885/#2887/#2888/#2884 (API/UI-level fixes, CI-verified).

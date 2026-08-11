# v0.105.0 Release QA — Change List & Manual Test Checklist

**Range:** `v0.104.0..origin/main` (fetched 2026-08-11) · **103 commits**

## Summary

| Bucket | Count |
|---|---|
| UI-affecting | 37 |
| API / backend behaviour | 11 |
| Agent (Go) | 14 |
| Migrations / schema | 4 (primary) — 12 migration files total across all buckets |
| Release / build / CI infra | 11 |
| Dependency bumps | 17 (collapsed) |
| Docs / plans only | 9 |

**Headline items, in priority order for the sweep:**

1. **`e18108457` (#3299) — blocking Redis consumers get their own connections.** This is the single most operationally important change in the range: it fixes a bug where a 5s blocking `BRPOP` on the shared Redis connection stalled *every* job enqueue fleet-wide (the production latency incident from 08-10/08-11). No dedicated UI page to test — verify via general app responsiveness / webhook delivery timing, not a specific screen.
2. **CIS baselines go partner-wide** (`9455019e5` + fix `65b4a6380`) — flagship feature of this range, and it shipped *broken* for any partner with 2+ orgs (400 on every create) until the follow-up fix. Test both the ownership feature and the fix.
3. **Remote-access provider choice** (`31e762a0f`/#3391, `fce4f0504`/#3406) — technician-level provider preference, but ships **with no web UI control yet**; only the validation-hardening half (`fce4f0504`) is browser-testable today.
4. **BYO agent-signing, phases 1–3** (`df4eb2b24`, `ede3380d1`, `bbde37ea9`, `67605e8bc`, `e39fba453`, `8577d7aa4`) + the parallel **edition-aware release pipeline** (`4c11cdc50`, `5076d4088`, `8b4aa2499`, `25673fe09`, `8b85a77a0`, `669a3551a`) — almost entirely release-infra/self-host-only, NOT browser-testable, but carries the release's most important self-hoster-facing env-var and boot-behavior changes (see §2).
5. **Business-email signup gate** (`b7edcac78`) — hosted-only abuse mitigation with a real web UI change (rejection link).
6. **Organization Contacts** (`23851193d`, `f11c225c4`, `a54a4ad37`) — new first-class data model, **no web UI yet** (data-layer only this cycle).
7. **Two destructive migrations**: drop `patch_policies.sources` and drop `organizations.accounting_provider`/`accounting_external_id`. Both are contract, not accident — see §2.

---

## 1. Categorized change list

### UI-affecting (37) — grouped by feature

**Remote access & quick support**
- `31e762a0f` feat(remote): per-technician remote-access provider preference (#3389/#3391) — API-only; **no UI control exists yet** to set the preference.
- `fce4f0504` fix(orgs): reject duplicate remote-access provider ids / dangling default at save time (#3406) — Partner Settings → Remote Access tab validation. Pairs with `31e762a0f` (that PR made the duplicate-id bug easier to hit).
- `c0ef527e7` feat(remote): consolidate proxy access to one entry point, fix the 5-minute session cliff (#3199/#3294) — Network device detail page proxy popover, Org Settings Remote Access tab.
- `459c8aa45` fix(desktop): stop viewer answer-poll from exhausting the global IP rate limit (#3041/#3377) — Viewer session polling + web auth-refresh 429 handling.
- `9344a2b4e` feat(quick-support): digit codes, session re-open, IPv6 /64 rate limiting, tenant-wide domain descope (#3292) — Quick Support technician page + `/quick` landing page.
- `226299b15` fix(agent): resolve macOS Finder aliases in the file browser (#3344/#3384) — Remote Desktop File Browser (agent + `apps/web/.../FileManager.tsx`).

**Webhooks & integrations (self-hosted networking)**
- `2aa281e67` feat(webhooks): honour the self-hosted private-network gate, drop the local IP policy (#3320) — Settings → Webhooks, self-hosted only.
- `c6106154d` fix(webhooks): confine the self-hosted cleartext allowance to private addresses (#3366) — same page, review follow-up to `2aa281e67`.

**Partner-wide CIS baselines (flagship — org XOR partner ownership)**
- `9455019e5` feat(api,web): partner-wide CIS baselines — dual-ownership (#3400) — Security → CIS Hardening: adds `ownerScope` selector + "All orgs" badge (pattern from `PolicyForm.tsx`).
- `65b4a6380` fix(web): org scoping for CIS Hardening and audit baselines (#3372) — fixes the create flow, which 400'd for every multi-org partner; also fixes stale-org-on-load races and a false "No baselines configured" flash. Same bug pattern hit the separate Audit Baselines feature too, fixed in the same commit.

**PSA connectors & org-import**
- `33c088e2d` feat(psa): PSA company import via the org-import seam (#3246/#3311) — Settings → Integrations → PSA, new import preview + pagination fix + SSRF hardening on cursor URLs.
- `2cb6f7a6b` feat(psa): dual ownership (org XOR partner) for `psa_connections` (#2135/#3308) — same page, ownerScope selector.
- `f400fc315` fix(psa): real connection test, honest 501 sync, working form round-trip, single-source provider list (#3291) — same page; fixes a credential-exposure bug (`GET /psa/connections/:id` leaked decrypted secrets to `orgs:read`-only callers) and a PATCH-wipes-status bug.
- `1ee46b103` refactor(accounting): migrate the QuickBooks importer onto the shared org-import seam (#3298) — Settings → Integrations → Accounting → QuickBooks; changes duplicate-org error messaging (no `.tsx` touched, but response shape/behavior the UI renders changed).
- `1d1880817` feat(orgs): bulk org/site import + `organization_external_links` (#3242/#3273) — Settings → Organizations → new "Bulk import" modal.
- `d0fb9cc54` fix(orgs): org-import hardening — sites:write gate, skip-mode persistence, atomic group create (#3287) — same Bulk Import flow; a site failure now fails the whole org+sites group instead of stranding a siteless org.

**Organization contacts, partner API, fleet reporting, scripts**
- `870c69f61` feat(partner-api): unattended tenancy provisioning via partner service principals (#3243/#3274) — Settings → Partner API → Service Principals gains `organizations:write`/`sites:write`/`enrollment-keys:write` scope checkboxes (unchecked by default).
- `bf505f83a` feat(devices): fleet migration posture report (#3244/#3264) — new page, Devices → Reporting → Fleet Posture.
- `739e8d84b` feat(scripts): script bundle import/export (#3245/#3276) — Scripts page, export/import `.json` bundles.
- `b7edcac78` feat(abuse): require a business email for hosted partner signup (#3289) — partner registration page; rejection now renders a clickable action link instead of a bare string.

**Devices / networking / discovery**
- `b0f938357` fix(discovery): rank automatic asset classifiers so a UniFi switch stops flapping to `access_point` (#3187/#3383) — Devices → Discovery / Network Devices list.
- `b311456de` fix(api): exclude virtual machines from warranty sync (#3201/#3399) — Device warranty tab; VMs previously parked in "unknown" forever.
- `489d4cdab` fix(api): match process-sample path id against the agent id (#3387/#3396) — Device Details → Processes tab.
- `954a288d5` fix(groups): clear `group_membership_log` before deleting a device group (#3313/#3314) — Devices → Groups delete action (was a 500).
- `0c8c6fb74` fix(api): discriminate installer capacity per token, not per key (#3034/#3392) — Settings → Enrollment Keys.

**AI, quotes/billing, config policy, logs, i18n, dashboard**
- `f2d7fda83` fix(api): dispatch policy remediation instead of simulating completion (#3413/#3414) — Config Policies / automation-run history; runs previously self-reported "completed" after a `setTimeout` with no device contact at all.
- `3716e414d` fix(ai): resolve `remediate_vulnerability`'s org from the device, not `accessibleOrgIds[0]` (#3322/#3379) — AI chat, Vulnerabilities remediation tool, partner-scope sessions.
- `ff147bdb4` fix(ai): count tool executions in the usage rollup and refresh spend live (#3297) — AI chat sidebar cost indicator.
- `c16d1e5a4` fix(api): stop binding raw JS Dates into hand-written SQL templates (#3369/#3382) — Alerts filter engine (date-based filters), OAuth revocation retry.
- `945de59f0` fix(api): make `search_logs` keyset pagination usable (#3329/#3368) — Logs → Log Search, page 2+ (was HTTP 500).
- `2295d859a` fix(web): walk every page of `/scripts` so the full library is reachable (#3301/#3305) — Scripts page, Script Picker modal, category tree, remediation script picker (all silently capped at 50).
- `2dbe7505f` fix(web): use shared `TimezoneSelect` in config-policy Automation/Maintenance tabs (#3361/#3376) — Config Policy feature tabs; previously a short hardcoded timezone list.
- `48b819a14` fix(quotes): stop the quote line unit price clipping its last digit (#3318/#3370) — Quotes editor, line-item unit price input.
- `81ce58025` fix(billing): carry the quote line name onto the converted invoice (#3319/#3365) — Quote→Invoice conversion + Portal invoice detail view.
- `1ee678186` fix(i18n): correct contextual translations (#3296) — es-419/pt-BR/de-DE/fr-FR/fr-CA/it-IT locale strings across many pages.
- `449e9a3d2` feat(web): surface agent `migrationRequired` signal (#3324) — persistent self-hosted migration banner on the dashboard.
- `8310c6d71` feat(web): what's-new splash on login with reopen link (#3317) — login flow + sidebar footer.
- `46a84cee3` test(web): InvoiceWorkspace test timing fix (#3219/#3284) — **test-only, no behavior change**, nothing to manually verify.

### API / backend behaviour (11)
- `f52c2815b` feat(abuse): provider-default hostname detector, hosted-only abuse detection (#3411)
- `091870388` fix(api): resolve partner-owned config policies for agent config delivery (#2930/#3390) — 4 agent-facing resolvers (event_log, monitoring, pam, patch_source) never saw partner-wide policies.
- `56c8c0268` fix(snmp): make the live device row the sole org authority for poll dispatch (#3226/#3378) — closes a durable cross-org SNMP-credential-dispatch bug.
- `5f8204ae2` fix(dns): authenticate Umbrella with OAuth2 client credentials, not Basic (#3271/#3275)
- `0dac5b4a3` fix(api,secrets): seal plaintext into registered columns without requiring `APP_ENCRYPTION_KEY_ID` (#3394)
- `f11c225c4` feat(contacts): route all ten legacy jsonb writers through the compat service (#3258/#3328)
- `23851193d` feat(contacts): first-class organization contacts — tables, contracts, compat service (#3258/#3316) — no web UI yet.
- `e18108457` fix(api): give blocking Redis consumers their own connections (#3299) — **headline item, see above.**
- `ce22803a9` test(ai): pin the aiTools registry against TOOL_TIERS (#3300/#3306) — contract test only, no runtime effect.
- `b01681907` fix(api): enforce same-partner ownership on partner-wide script writes (#3262 follow-up) (#3272) — 403→404 on cross-partner mismatch.

### Agent / Go (14)
- `f2017277e` fix(agent): reject malformed reboot delays instead of coercing to 0 (#3373/#3393)
- `4c143b5c4` fix(agent): route every content-touching file op through containment (#3397/#3398)
- `35ef4a411` fix(agent): deny the Keychains directory node, not just its contents (#3385/#3395)
- `8d2e19eb8` fix(agent): normalize reboot/shutdown delay to minutes on Windows (#3252/#3371)
- `8e079316d` fix(agent): bound total shutdown time so systemd stops cleanly (#3323/#3367)
- `cba656fb4` fix(agent): filter `BroadcastNotification` on the notify scope (#3255/#3364)
- `48e526307` fix(backup): hold VSS session COM references for the whole run, signal BackupComplete (#3269/#3285)
- `9cc3cd1d1` feat(agents): raise command-result cap to 5 MB, matching stdout/stderr (#3283)
- `f4d0bc905` test(backup): make `vss.Provider` injectable (#3270/#3280) — test-only.
- `7cff512a4` fix(backup): bound command result against the server's 1 MiB cap, not the IPC frame (#3001/#3267)
- `5d1a0f47f` fix(backup): short-retry ACL denials, abort on lost VSS snapshot (#3259/#3260/#3266)
- `25673fe09` feat(installer): parameterize MSI edition identity (#3350) — part of the edition-aware pipeline, see Release/build.
- `8b85a77a0` feat(agent): enforce edition match on release manifest assets (#3349) — same initiative.
- `4c11cdc50` feat(agent): compile-time control-plane build-mode host policy, inert by default (#3321) — same initiative.

### Migrations / schema (primary bucket — 4 commits; full migration file list in §2)
- `48c1e366c` chore(api): drop deprecated `patch_policies.sources` column (#3151/#3154) — **destructive**.
- `b6b09b6a7` chore(rls): codify partner-axis RLS for the breeze-billing tables (#3290) — records a fix already applied by hand in both prod DBs (the `billing_*` tables live outside this repo's Drizzle schema and had no RLS at all).
- `a54a4ad37` fix(contacts): bound backfill projections so an overlong jsonb value cannot abort the migration (#3326) — edits the `2026-08-19-contacts.sql` migration file in place (justified: `autoMigrate` has no per-statement retry, so only a same-file fix works before the flawed version ships).
- `b0f7407bd` chore(orgs): drop the legacy `accounting_provider`/`accounting_external_id` columns (#3309) — **destructive**.

### Release / build / CI infra (11)
- `9736edec1` fix(deps): dedup pnpm-lock.yaml — duplicated mapping keys broke every JS CI job (#3407)
- `bbde37ea9` fix(api): abort sync on re-signing failure, enforce non-official trust root — BYO signing phase 2 follow-up (#3352)
- `190a1b222` fix(config): make the env↔compose parity guard see commented-out vars (#3239/#3388) — see §2, this wires through ~30 previously-inert env vars.
- `ef8d9c28d` fix(ci): retire the `update-community-readme` schedule (#3173/#3375)
- `669a3551a` feat(release): optional draft-first gate via `RELEASE_DRAFT_FIRST` (#3362)
- `e39fba453` feat(selfhost-signing): build BYO MSIs under the self-host edition identity (#3360)
- `5076d4088` feat(release): edition-aware build pipeline + self-host artifact publication (#3351)
- `8b4aa2499` feat(api): edition-aware release sources, `BINARY_EDITION` mode, `agent_versions` edition (#3353) — ships migration `2026-08-10-agent-versions-edition.sql`.
- `67605e8bc` feat(selfhost-signing): BYO-signing template repo contents + "Sign Your Own Agent Packages" guide, phase 3 (#3331)
- `ede3380d1` feat(api): unified release source + deployment re-signing trust chain — BYO signing phase 2 (#3330)
- `df4eb2b24` feat(release): publish unsigned signing-input artifacts + manifest `sourceCommit` — BYO signing phase 1 (#3327)

### Dependency bumps (17, collapsed)
Dependabot/renovate-style version bumps across TypeScript tooling, mobile (Expo SDK, react-native-animation), Astro, Sentry, testing-library, Hono, PostCSS/Tailwind, e2e-tests (werift, tsx, @types/pg), and 5 Docker `node` base-image bumps (m365-graph-actions-executor, m365-communications-executor, docker, apps/api, apps/web). No behavior review needed beyond CI passing.

### Docs / plans only (9)
`ad37a9d1b`, `3a43238f8`, `fc24eb7aa`, `8577d7aa4`, `00a209a01`, `089543198`, `2830f07a6`, `cd697bb7b`, `510a8ae50` — design specs, plan handoffs, migration/deployment guides, and the v0.102→v0.104 release-notes sweep. `089543198` and `510a8ae50` touch `apps/api/src/openapi.ts` / `docsIndex.json` respectively but only as documentation metadata, no runtime code.

---

## 2. Self-hoster / operator callouts

### New or changed environment variables

| Variable | Status | Default | Notes |
|---|---|---|---|
| `ABUSE_SIGNALS_ENABLED` | new, optional | follows `IS_HOSTED` | Boolean; malformed value **refuses boot**, unrecognized value falls back to default with a warning. Self-hosters: no action needed, off by default. |
| `ABUSE_HOSTNAME_INDICATORS` | new, optional | `{"prefixes": []}` | JSON; empty by design. Only matters for hosted deployments. |
| `SIGNUP_REQUIRE_BUSINESS_EMAIL` | new, optional | ON when `IS_HOSTED=true` | Kill switch; hosted-only signup gate. Self-hosted registering their own partner is exempt by construction. |
| `SIGNUP_BUSINESS_EMAIL_CONTACT_URL` | new, optional | — | Where a rejected signup is sent. |
| `SIGNUP_EXTRA_CONSUMER_EMAIL_DOMAINS` | new, optional | — | Additive to the built-in consumer-domain blocklist. |
| `SIGNUP_ALLOWED_EMAIL_DOMAINS` | new, optional | — | Allowlist override, wins over the above two. |
| `BINARY_EDITION` | new, optional | `self-host` | `hosted` **requires** `BINARY_SOURCE=local` + `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` in production or boot refuses. Not relevant to self-hosted deployments — leave at default. |
| `BINARY_GITHUB_REPOSITORY` | new, optional | `lanternops/breeze` | BYO-signing repo override (`owner/repo` shape). **Overriding this to a non-default value and leaving `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` as only the official key now correctly refuses to boot in production** (previously booted, then silently froze on every sync). |
| `GITHUB_REPO` | legacy alias | — | Still accepted; same effect and same trust-root requirement as `BINARY_GITHUB_REPOSITORY`. |
| `BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` | new alias | — | Same purpose as `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`; either name is accepted. |
| `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` | existing, **behavior change** | — | Already required in production since v0.65+. New rule: when `BINARY_GITHUB_REPOSITORY`/`GITHUB_REPO` points at a non-official repo, this **must include the overriding repo's own key**, not just (or instead of) the official Breeze key, or boot is rejected. |
| `RELEASE_DRAFT_FIRST` | new, GitHub Actions repo variable — **not** an app `.env` var | unset = today's behavior | Only affects the release workflow itself; irrelevant to a running deployment's `.env`. |
| ~30 previously-documented-but-inert vars | now actually wired into compose | unchanged | `190a1b222` fixed the env↔compose parity guard and mapped ~26 root + 5 droplet vars into the `environment:` blocks that were documented in `.env.example` but never reached the container: `COOKIE_SAME_SITE`, `COOKIE_FORCE_SECURE`, `AUTH_COOKIE_SAME_SITE`, `AUTH_COOKIE_FORCE_SECURE`, `PORTAL_COOKIE_SAME_SITE`, `PORTAL_COOKIE_FORCE_SECURE`, `CORS_INCLUDE_DEFAULT_ORIGINS`, `REFRESH_ROTATION_GRACE_SECONDS`, `PORTAL_STATE_BACKEND`, `MCP_REQUIRE_EXECUTE_ADMIN`, `MCP_EXECUTE_TOOL_ALLOWLIST`, `MCP_SSE_RATE_LIMIT_PER_MINUTE`, `MCP_MESSAGE_RATE_LIMIT_PER_MINUTE`, `MCP_MAX_SSE_SESSIONS_PER_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `BREEZE_BILLING_URL`, `BREEZE_BILLING_API_KEY`, `BILLING_SERVICE_URL`, `BILLING_SERVICE_API_KEY`, `AUTO_MIGRATE`, `AGENT_AUTO_PROMOTE`, `ENABLE_API_DOCS_UI`, `PUBLIC_ACTIVATION_BASE_URL` (root) + `MFA_FORCE_FOR_PARTNER_ADMIN`, `LOGIN_ACCOUNT_LOCKOUT_MAX`, `LOGIN_ACCOUNT_LOCKOUT_WINDOW_SECONDS`, `AGENT_AUTO_PROMOTE`, `BREEZE_ALLOW_UNAUTH_REDIS` (droplet). **Self-hosters who set any of these before and saw no effect should retest after upgrading.** A real bug was fixed alongside this: generic `COOKIE_SAME_SITE`/`COOKIE_FORCE_SECURE` were being silently shadowed by an always-injected empty-string prefixed variable — session-cookie `SameSite`/`Secure` behavior behind a reverse proxy may change. |
| `MSI_SIGNING_URL`, `MSI_SIGNING_CF_ACCESS_ID`, `MSI_SIGNING_CF_ACCESS_SECRET`, `MSI_SIGNING_API_KEY` | **removed** | — | The old per-download Windows-installer signing tunnel is retired by BYO-signing phase 2. Anyone still setting these gets silently ignored. |

### New migrations (12 files)

| File | Commit | Destructive? |
|---|---|---|
| `2026-08-08-organization-external-links.sql` | `1d1880817` | No — additive |
| `2026-08-08-proxy-session-lifetime.sql` | `c0ef527e7` | No — additive |
| `2026-08-09-device-agent-edition-migration-required.sql` | `449e9a3d2` | No — additive |
| `2026-08-10-agent-versions-edition.sql` | `8b4aa2499` | No — drops+replaces a constraint only, no data loss |
| `2026-08-10-billing-tables-partner-rls.sql` | `b6b09b6a7` | No — RLS/policy only, idempotent no-op on prod (already applied by hand) |
| `2026-08-10-cis-baselines-partner-ownership.sql` | `9455019e5` | No — additive + policy swap |
| `2026-08-14-drop-patch-policies-sources.sql` | `48c1e366c` | **Yes — drops `patch_policies.sources` column** |
| `2026-08-17-psa-connections-partner-ownership.sql` | `2cb6f7a6b` | No — additive + policy swap |
| `2026-08-18-drop-organizations-accounting-columns.sql` | `b0f7407bd` | **Yes — drops `accounting_provider` + `accounting_external_id` columns** |
| `2026-08-19-contacts.sql` | `23851193d` (bug-fixed in place by `a54a4ad37`) | No — additive + backfill; fixed version bounds an overlong-jsonb backfill failure |
| `2026-08-20-discovered-asset-detection-source.sql` | `b0f938357` | No — additive |
| `2026-08-20-installer-bootstrap-token-usage-kind.sql` | `0c8c6fb74` | No — additive |

Neither destructive migration is long-running (both are simple `ALTER TABLE ... DROP COLUMN` on non-hot-path tables); both are gated on the reading/writing code having already been removed in the same or an earlier release.

### Breaking changes to API routes / response shapes
- `agent_versions` gains an `edition` column and its uniqueness constraint changes shape (now includes `edition`); `/agent-versions` list responses can include both `self-host` and `hosted` rows on a server running `BINARY_EDITION=hosted` (not relevant to self-host).
- `GET /psa/connections/:id` no longer returns decrypted `baseUrl`/`username`/`clientId` to a caller with only `orgs:read` (now requires `orgs:write`) — a deliberate security tightening that will 403 any client relying on the old leak.
- `POST /psa/connections/:id/sync` now returns an honest `501 Not Implemented` instead of a fake "queued" response.
- `PATCH /orgs/partners/me` (`remoteAccessProviders`) now 400s on duplicate provider ids or a dangling `defaultProviderId` — previously silently accepted.
- Webhook URL validation is stricter for self-hosted cleartext (`http:`) targets — now requires the resolved IP to be private, closing an accidental any-hostname allowance.

---

## 3. Manual test checklist

Legend: **[NOT BROWSER-TESTABLE]** = flagged reason follows; otherwise assume a normal web-UI Playwright/browser pass.

### Devices
- [ ] Devices → Discovery/Network Devices: sync a UniFi switch via both the UniFi controller integration and an agent discovery scan → confirm the listed asset type stays `switch` and does not flap to `access_point` across repeated runs (`b0f938357`).
- [ ] Device Details → warranty tab: confirm a VM (VMware/Hyper-V guest) is excluded from the warranty-sync job and no longer shows a permanent "unknown" warranty status (`b311456de`).
- [ ] Device Details → Processes tab: open the process list on a live device, confirm it loads without a 403 (`489d4cdab`).
- [ ] Devices → Groups: delete a **dynamic** group that has previously matched devices → expect success, not a 500 (`954a288d5`).
- [ ] Devices → Reporting → Fleet Posture (new page): select an org with a mix of scanned/never-scanned devices → confirm never-scanned devices show an explicit amber caveat (not silently counted as clean), and any device still running a legacy remote-access agent after RMM uninstall appears in a red "orphaned remote access" callout (`bf505f83a`).
- [ ] Dashboard: with at least one device on a hosted-edition agent, confirm the persistent, non-dismissible "self-hosted migration required" banner appears and the fleet count is accurate (`449e9a3d2`). **[Edge case, likely not reproducible on a normal self-host fleet — skip unless a hosted-edition agent is available.]**

### Organizations / Settings
- [ ] Settings → Organizations → Bulk import: upload a CSV with a mix of new/matching org+site names → confirm a preview table with match/create status per row, then commit → confirm no duplicates on re-upload of the same file (`1d1880817`).
- [ ] Same flow: commit a row with an invalid/duplicate site name → confirm the **whole org+sites group** fails as one unit with one error (no orphan org left behind) — this is a behavior change from per-row to per-group failure (`d0fb9cc54`).
- [ ] Settings → Integrations → PSA: open a configured connection (e.g. ConnectWise/Autotask) → click "Import companies" → confirm a preview table with a truncation notice if the PSA has >1000 companies (`33c088e2d`).
- [ ] Same page, as a partner managing 2+ orgs: create a new PSA connection → confirm an ownership selector (single-org vs. all-orgs); confirm an org-scoped user can still see a partner-wide connection on the read side but not the ownership selector (`2cb6f7a6b`).
- [ ] Same page: edit a **paused** PSA connection, change only its name, save → confirm it stays paused (was silently reactivated) (`f400fc315`).
- [ ] Same page: as an `orgs:read`-only user, attempt to view a PSA connection's stored credentials → confirm they are no longer returned (403/redacted) (`f400fc315`).
- [ ] Settings → Integrations → Accounting → QuickBooks: import a customer whose name matches an existing **unlinked** org → confirm a clear failure message pointing at Bulk Import, not a silently-created duplicate org (`1ee46b103`).
- [ ] Settings → Partner Settings → Remote Access tab: add two providers, force a duplicate id (or edit via API) → Save → confirm a 400 validation error; set the default-provider selector to a provider not in the list → Save → confirm rejection (`fce4f0504`).
- [ ] Settings → Webhooks (self-hosted only, `IS_HOSTED=false`): add a webhook with `http://<public-hostname>` → confirm rejection; add `http://<private-LAN-IP>` → confirm it's accepted and deliverable (`c6106154d`, `2aa281e67`).
- [ ] Settings → Enrollment Keys: build an installer from a **short-link child** key row → confirm its consumed/max device-slot counter now displays and decrements correctly (previously hidden) (`0c8c6fb74`).
- [ ] Settings → Partner API → Service Principals: create/edit a principal → confirm `organizations:write`/`sites:write`/`enrollment-keys:write` scopes are selectable but unchecked by default (`870c69f61`). **[Full round-trip via the partner API itself is NOT BROWSER-TESTABLE — needs a scripted API-key client.]**
- [ ] Login page: after this release, confirm the "What's new" splash appears once, "Got it" dismisses permanently, "Show me later" snoozes to next login, and the sidebar footer "What's new" link reopens it anytime (`8310c6d71`).
- [ ] Register a new hosted partner with a disposable/consumer email (e.g. a Gmail address) → confirm rejection with a clickable action link (not a bare string) pointing at the configured contact URL; register with a business domain → confirm success (`b7edcac78`). **[Hosted-only — skip if testing a self-hosted stack.]**
- [ ] Log in behind a reverse proxy after upgrading, if `AUTH_COOKIE_SAME_SITE`/`PORTAL_COOKIE_SAME_SITE`/`COOKIE_FORCE_SECURE` are set explicitly → inspect `Set-Cookie` headers to confirm the flags now actually take effect (`190a1b222`).

### Config Policies
- [ ] Config Policies → any policy with a drift-remediation automation → trigger remediation → confirm the automation-run history reflects the **actual** dispatch outcome (pending/dispatched), not an instant fake "completed" (`f2d7fda83`).
- [ ] Config Policy → Automation tab and Maintenance tab: open the timezone selector → confirm the full searchable IANA timezone list (e.g. `Asia/Dubai`, `America/Sao_Paulo`) is available, not the old short hardcoded list (`2dbe7505f`).
- [ ] As a partner: assign a partner-wide config policy (event log, monitoring, PAM, or patch-source feature) to devices across 2+ orgs → confirm the policy actually reaches agents in all those orgs, not just one (`091870388`). **[Full agent-side confirmation is NOT BROWSER-TESTABLE without a live enrolled agent; the assignment/save UI side is testable in-browser.]**

### Patching
- [ ] Patch Policies: confirm the UI no longer references the removed `sources` field anywhere it was previously shown (settings form, patch policy detail) — sanity check after `48c1e366c`'s column drop.

### Scripts
- [ ] Scripts page: with a library of 51+ scripts, confirm the full library is browsable (not capped at the first 50) — check the main list, the Script Picker modal (on a device), the category tree, and the Remediation Script Picker inside a config policy (`2295d859a`).
- [ ] Scripts page: select several scripts → Export → download the `.json` bundle → re-import with mode "new-version" → confirm a per-script conflict preview; hand-edit the bundle to add an `isSystem`/`orgId` field and re-import → confirm it's silently stripped, not honored (`739e8d84b`).
- [ ] As a partner, attempt a partner-wide script write from an account belonging to a different partner → confirm a 404 (not 403) (`b01681907`).

### Security / CIS Hardening
- [ ] Security → CIS Hardening, as a partner managing 2+ orgs: click "New Baseline" → confirm the create form saves successfully (previously 400'd for every multi-org partner) (`65b4a6380`).
- [ ] Same page: toggle ownership to "All orgs" on create → save → confirm the "All orgs" badge appears on the baseline list (`9455019e5`).
- [ ] Same page: switch the org selector in the header while the baseline list is still loading → confirm the final render matches the org you land on (no stale/false-empty flash) (`65b4a6380`).
- [ ] Edit a baseline belonging to Org A while the header is scoped to Org B → confirm the edit targets Org A, not a 404 (`65b4a6380`).
- [ ] Repeat the same org-scoping check on the separate **Audit Baselines** feature (same underlying bug, same fix) (`65b4a6380`).

### AI Assistant
- [ ] AI chat sidebar cost indicator: run a tool-using AI chat session → confirm the tool-execution count and live spend both increment (previously the tool-execution counter stayed pinned at 0) (`ff147bdb4`).
- [ ] In a **partner-scope** AI chat session (no home org), ask the assistant to remediate a vulnerability on a device belonging to an org that does not sort first among your accessible orgs → confirm it is not incorrectly skipped, and an audit-log entry is written either way (`3716e414d`).

### Quotes / Invoices / Billing
- [ ] Quotes editor: create/edit a quote line, type a multi-digit unit price → confirm the input doesn't visually clip the last digit (`48b819a14`).
- [ ] Accept a quote with a line that has both a name and description → convert to invoice → confirm the invoice line shows the quote line's name as the title (previously lost) — check both the web billing view and the **Portal** invoice detail view (`81ce58025`).

### Logs / Audit
- [ ] Logs → Log Search: run a search that returns more than one page of results → click through to page 2+ → confirm it loads (was a 500 despite claiming `hasMore: true`) (`945de59f0`).
- [ ] Alerts page: apply a date-range filter → confirm it returns results without error (regression check on the SQL date-binding fix) (`c16d1e5a4`).

### Remote Access / Quick Support / Viewer
- [ ] Remote → Quick Support: generate a new support code → confirm it's a 9-digit code shown 3-3-3; if any old letter-style code is still open, confirm it still redeems (`9344a2b4e`).
- [ ] Same page: click a past session in history → confirm a live detail panel reopens (connect/poll/end), and the URL hash updates and restores on reload; edit the hash to a bogus session id → confirm the panel closes cleanly (`9344a2b4e`).
- [ ] Visit `/quick`, enter an invalid code repeatedly → confirm a distinct "too many attempts" message appears once rate-limited, separate from "invalid code" (`9344a2b4e`).
- [ ] Devices → Networking: open a discovered network device with a web-facing port (443/8080/etc.) → use the new proxy popover to connect through a bridge agent → confirm one click opens the proxied session (no separate "enable" step) (`c0ef527e7`).
- [ ] Leave a proxy session open and idle past 5 minutes (but under 12h) → confirm the session stays active (previously died at the 5-minute mark) (`c0ef527e7`).
- [ ] Remote Desktop: browse a macOS device's file system to a folder containing a Finder alias (not a symlink) → confirm it's identified correctly, not misreported as a plain file (`226299b15`). **[Needs a real macOS agent — the agent-side alias resolution itself is NOT BROWSER-TESTABLE without one; the web FileManager display change is testable once such a device is available.]**
- [ ] Start a remote-desktop connection to an offline device and let the connection attempt time out → confirm you are NOT simultaneously logged out of the main dashboard tab (`459c8aa45`).

### Fleet / Backups **[mostly NOT BROWSER-TESTABLE]**
- [ ] **[NOT BROWSER-TESTABLE — needs a real Windows Server host running a live VSS backup]**: confirm a backup job survives the full run without losing its VSS shadow-copy COM references, and correctly signals `BackupComplete` (`48e526307`).
- [ ] **[NOT BROWSER-TESTABLE — needs a real Windows Server + simulated ACL denial / VSS snapshot loss]**: confirm a transient ACL denial retries briefly instead of failing the whole job, and a genuinely lost VSS snapshot aborts cleanly rather than silently completing with partial data (`5d1a0f47f`).
- [ ] If a backup or script run produces very large console output (multi-MB), check the Script Run output panel / Backup job detail page displays it up to the new 5 MB cap without truncating early (`9cc3cd1d1`, `7cff512a4`). Partially browser-testable — trigger a script that prints several MB of text and inspect the console panel.
- [ ] **[NOT BROWSER-TESTABLE — Linux systemd host required]**: confirm agent shutdown completes cleanly within its time budget on a systemd-managed Linux install (`8e079316d`).
- [ ] **[NOT BROWSER-TESTABLE — real Windows host]**: trigger a reboot/shutdown with a delay from Remote Actions → confirm the delay is honored in minutes on Windows, not misinterpreted as seconds (`8d2e19eb8`); also confirm a malformed delay value is rejected rather than silently treated as "immediately" (`f2017277e`).

### Portal
- [ ] Portal → Invoice detail view: open an invoice converted from a quote with named lines → confirm line names render correctly (`81ce58025`).

### Localization
- [ ] Spot-check es-419, pt-BR, de-DE, fr-FR, fr-CA, it-IT locales on the Devices, Discovery, Auth, Backup, and Integrations pages for corrected terminology (network "switch" vs. UI toggle, OAuth grants, Entra tenants) (`1ee678186`).

### Not applicable this cycle
No changes landed in Software Deployment, Mobile app, or Extension/Office-add-in surfaces this range (beyond the untouched mobile dependency bumps).

---

## 4. Highest-risk areas for the sweep

1. **CIS Hardening / Audit Baselines org-scoping (`9455019e5` + `65b4a6380`)** — highest density of related, overlapping changes: a brand-new dual-ownership feature shipped in a state that was completely broken for its primary target audience (multi-org partners) until a same-day-ish follow-up fix touched four components across two features (CIS + the separate Audit Baselines) for the identical bug class (missing `orgId` in write bodies, stale org on mount, race on org-switch). This is the single place most likely to still have an edge case the fix didn't cover — test the ownerScope + org-switch-race combination hardest here.
2. **Tenancy / RLS surface**: `b6b09b6a7` (billing tables had **zero RLS in production** until this migration — codifies a hand-applied fix), `2cb6f7a6b` and `9455019e5` (both introduce the org-XOR-partner dual-ownership RLS shape fresh), and `091870388` (agent config delivery was silently RLS-blind to partner-wide policies for 3 of 4 resolvers). All four are exactly the class of bug this repo's cascade/RLS contract tests exist to catch — worth confirming the relevant integration suites (`rls-coverage.integration.test.ts`, a `psaConnectionsPartnerRls`/`cisBaselinesPartnerRls`-style suite) actually ran green in CI for this range, not just that the manual sweep looks fine.
3. **Two independent PR pairs touching the same files, same range**: (a) `2aa281e67` then `c6106154d` both modify `webhookSender.ts`'s private-network gate in the same PR-review cycle — test the *combination*, not each in isolation (self-hosted + `https:` + private IP; self-hosted + `http:` + public hostname; self-hosted + `http:` + private IP). (b) `f11c225c4`/`23851193d` (contacts writers) and the org-import work (`1ee46b103`, `33c088e2d`, `1d1880817`) both write through org create/site create/PATCH paths concurrently — an org created via Bulk Import or PSA import should be checked for correct contact-compat backfill behavior too, since both feature sets touch the same org-creation code paths in the same release.

Also worth a general regression pass: **Redis/queue responsiveness** (`e18108457`) has no dedicated screen, but a general "does anything feel like it stalls for multiple seconds under load" check across webhook delivery, AI chat streaming, and bulk operations is the closest thing to a manual test for the release's most impactful fix.

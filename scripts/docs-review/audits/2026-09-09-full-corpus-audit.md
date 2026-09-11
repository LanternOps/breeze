# Docs full-corpus audit — 2026-09-09

Whole-corpus verification of `apps/docs/src/content/docs/` (170 pages) against `origin/main` at `b633bc58b6` (v0.111.1 + 6 fixes). Distinct from the diff-mode sweeps recorded in `last-reviewed.json`: every page was read and its verifiable claims (UI paths, env vars, defaults, endpoints, CLI flags, behaviour) were checked against current source by 14 section auditors. Findings are grouped by section; each cites the source file:line that proves it. Severity: WRONG (would mislead an admin), STALE (removed/renamed/shipped-since), MISSING (shipped feature with no coverage), NAV (link/sidebar/path), MINOR.

Mechanical checks run separately: 0 broken internal links; 3 stale `mapping.json` patterns (`publicShortLinks.ts` → moved into `enrollmentKeys.ts`, `aiToolsPlaybook.ts` → `aiToolsPlaybooks.ts`, `apps/web/.../reportPdf.ts` gone); 79 of 170 pages have **no** `mapping.json` entry at all (so diff-mode sweeps can never flag them); 4 feature pages absent from the sidebar (`extensions`, `incident-response`, `ticketing`, `watchdog`).

## Product defects surfaced (not doc fixes — file issues)

- Org-scoped Org Admin gets 403 on audit-retention settings the UI shows them (`routes/orgAuditRetentionSettings.ts:37,53` requires partner/system scope).
- Partner-wide event-log forwarding destination is never delivered to child orgs (`services/logForwarding.ts:40-60`); partner config only locks the org UI.
- `GET /tags` ignores manual-asset tags (`routes/tags.ts` never reads `manual_assets.tags`).
- `agent.source.ip.changed` is written but excluded from the security-events report set (`routes/auditLogs.ts:100-108`).
- `POST /integrations/monitoring/test` always returns success (`routes/integrations.ts:178-180`).
- User Risk endpoints are not site-scoped, unlike Alerts/Software/EDR (`routes/userRisk.ts`).
- Selective backup restore over-matches by path prefix (`agent/internal/backup/restore.go:329-343`) — known from the 09-09 backup-assurance campaign.
- PSA ticket sync endpoint is a 501 stub and C2C backup sync/restore are hard-coded failures — both documented as working.


# getting-started + contributing + monitoring + scripts (14 findings)
WRONG:
1 architecture.mdx:123-124 — run_script via /devices/:id/commands rejected 400 (routes/devices/commands.ts:470-472); use POST /scripts/:id/execute
2 architecture.mdx:110-113 — terminal WS path is /remote/sessions/:id/ws?ticket= (index.ts:847, terminalWs.ts:1133)
3 architecture.mdx:111 — agent WS is /api/v1/agent-ws/:id/ws (index.ts:975)
4 architecture.mdx:29, introduction.mdx:51, prerequisites.mdx:69 — Node 20 → Node ≥22.22.2 (pin 22.23.2), setup_22.x
5 prerequisites.mdx:73 — pnpm@9 → pnpm@10 (packageManager pnpm@10.34.5, engine-strict)
6 monitoring/health.mdx:186-196 — start_period API 40s, Web 30s, PG 15s, Redis 5s (docker-compose.yml:570,636,688,719)
STALE: 7 stack.mdx:41,358 .env.prod → .env (repo-wide convention check); 10 stack.mdx removed recording rule breeze:http_requests:rate5m_by_org; 11 stack.mdx:74 Grafana rescans every 30s; 12 contributing:42-48 roadmap "in the works" — shipped (breezermm.com/roadmap)
MISSING: 8 alerts.mdx 8 undocumented rules (anomaly group FailedLoginSpike/EnrollmentSpike/CommandDispatchSpike + CapacityMetricsMissing, FleetGaugesStale, BackupDispatchFailuresDetected, RestoreTimeoutsDetected, ScheduledVerificationSkipsDetected) monitoring/rules/breeze-rules.yml; 9 stack.mdx breeze-worker scrape job (worker-split profile); 10 6 new recording rules + 4 dashboard panel groups; 13 quickstart breeze-worker row
Accurate: stopping-a-running-script (fully), index, core monitoring tables.

# deploy/ — 13 pages (22 findings)
WRONG:
1 production.mdx:181 — first boot needs BREEZE_BOOTSTRAP_ADMIN_EMAIL/_PASSWORD or API crash-loops (db/seed.ts:59-66; autoMigrate.ts:747-751)
2 tls.mdx:16 — Caddyfile is mounted docker/Caddyfile.prod, not inline (docker-compose.yml:496)
3 tls.mdx:18-38 — snippet omits oauth/billing/portal/SSE/mTLS routing → point at file
4 tls.mdx:56-59 — WS paths /api/v1/agent-ws/:id/ws and /api/v1/remote/sessions/... (index.ts:975,847); contradicts cloudflare-tunnel.mdx
5 antivirus-exceptions.mdx:18,35,39,52 — Windows agent binaries UNSIGNED since v0.105 (services/releaseAssetTrust.ts; releaseArtifactManifest.ts:27-29); contradicts code-signing.mdx
6 antivirus-exceptions.mdx paths — Helper: C:\Program Files\Breeze Helper\breeze-helper.exe; /Applications/Breeze Helper.app/Contents/MacOS/breeze-helper (agent/internal/helper/manager.go:220-231)
7 cloudflare-access-trust.mdx — logout is 3-step ticket flow incl POST /cf-access-logout/prepare (routes/auth/cfAccessRedirectLogin.ts)
8 binaries.mdx compose snippet — BREEZE_BINARIES_IMAGE_REF digest-pinned mandatory (docker-compose.yml:468)
9 production.mdx Pinning — clearing BREEZE_VERSION breaks pull, no latest fallback
10 upgrades.mdx:455,461,484,718 — curl uses Bearer api-key; routes need JWT + MFA → $TOKEN
20 environment.mdx:412 — rate limits ARE env-tunable: LOGIN_ACCOUNT_LOCKOUT_MAX/_WINDOW_SECONDS, AUTH_REFRESH_RATE_LIMIT/_WINDOW_SECONDS (services/rate-limit.ts:147-204)
MISSING: 11 cloudflare-tunnel Option B portal/billing/oauth-consent rules; 12 binaries.mdx download endpoints watchdog/user-helper/msi/pkg/uninstall.sh (routes/agents/download.ts); 13 AV process list watchdog/user-helper/desktop-helper/backup exes; 21 env vars AGENT_BACKUP_SERVER_URL, DELEGANT_* (verify self-host relevance), APPLE_APP_ATTEST_APP_ID/_ENVIRONMENT, *_RETENTION_DAYS ×7, CLIENT_AI_ENTRA_CLIENT_ID, AUTH_BROWSER_TRANSITIONS_ENFORCED/AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED
MINOR: 14 worker-split socket-owner exceptions (backupVerificationJobs, automationWorker, eventLogRetention); 15 turn-server TURN_REALM only bundled coturn; 16 HELPER_BINARY_DIR fallback ./agent/bin; 17 S3 offload only agent+viewer (services/binarySync.ts:1271); 18 maintenance window single day only; 19 54 migrations not 53; 22 BREEZE_DOMAIN/ACME_EMAIL "required for TLS"
Accurate: code-signing, worker-split, rollout-modes, environment + upgrades otherwise, cloudflare-tunnel Option A.

# agents/ — 9 pages (31 findings)
WRONG:
1 enrollment-keys.mdx:312-319,421,484-486 — pepper fallback claim; ENROLLMENT_KEY_PEPPER itself mandatory (config/validate.ts:169-196; services/enrollmentKeySecurity.ts:26-51)
2 helper.mdx:175-199 — Tool Permission Levels table fabricated; rebuild from services/helperToolFilter.ts BASIC/STANDARD/EXTENDED_TOOLS
3 enrollment-keys.mdx:342,476-478 — decommissioned re-enroll "403"; actually allowed, fresh row 201 (routes/agents/enrollment.ts:595-632); contradicts enrollment.mdx:99-101
4 installation.mdx:229,264,278 — config dir 0750/0640 → 0755/0644 (agent/internal/config/permissions_unix.go:12,20)
5 helper.mdx:421,447,523,Aside:16 — helper uses agent brz_ token → separate helper token (middleware/helperAuth.ts)
6 helper.mdx:205,463 — default level standard → basic (routes/helper/index.ts:44)
7 helper.mdx:437,498-511 — STALE /helper/chat/sessions/:id/approve/:executionId removed (helperApprove.removed.test.ts)
8 advanced-install.mdx:41-48,69-82 — macOS zip no longer bundles pkg; install.sh downloads+verifies (services/installerBuilder.ts:236-268)
9 enrollment.mdx:13-27 — enroll body fields: enrollmentKey required, osType/architecture, no siteId; response authToken (routes/agents/schemas.ts:35-42; enrollment.ts:1185)
10 advanced-install.mdx:228-234 — after service install unenrolled host left STOPPED (agentapp/service_install.go:37-44)
11 commands.mdx:848-859 — backup_verify ignores verificationType; test restore = backup_test_restore (cmd/breeze-backup/exec_backup.go:321-334)
12 installation.mdx:161-171, enrollment-keys.mdx:53-55 — STALE MSI filename brackets → "Breeze Agent (token@host).msi" (installerBuilder.ts:441-446)
13 helper.mdx:257,262 — computer control extended-only
17 enrollment-keys.mdx:455-462 — STALE single 401 message → reasons not_found/expired/exhausted/race_lost (enrollment.ts:139-142)
20 enrollment-keys.mdx:49 — macOS "PKG" → .zip app bundle
23 helper.mdx — GET /helper/config enabled hardcoded true (index.ts:519)
MISSING: 14 commands.mdx covers ~50 of 136 commands (types.go) — caveat or add; 15 helper endpoints tool-results/device-info/flag; 16 building.mdx other binaries (desktop-helper, backup, watchdog, user-helper); 18 4 audit actions; 19 enrollment response extra fields; 21 60-min timeout tier (services/commandTimeouts.ts:100-107); 22 backup_restore row; 30 Linux one-liner bootstrap-token flow (web/lib/installCommands.ts); 31 Windows user-helper auto via Scheduled Task
MINOR: 24 permissionLevel in session-create body not accepted; 25 dedup pending only; 26 no PATCH; 27 uninstall OS diff; 28 file_write 4MB; 29 heartbeat configurable 5-3600s
Accurate: macos-permissions, self-host-migration, building (except #16), most of commands + enrollment-keys mechanics.

# security/ — 7 pages (16 findings)
WRONG:
1-3 hardening.mdx:42-45 — read_only/resource limits absent; no-new-privileges + cap_drop only on api+worker (deploy/docker-compose.prod.yml:381-382)
4 mtls.mdx:207-216 — endpoint /agents/org/:orgId/settings/mtls; body {certLifetimeDays, expiredCertPolicy} (routes/agents/index.ts:63; validators/index.ts:338-341)
5 secrets.mdx:53-55 — JWT_SECRET_PREVIOUS doesn't exist; real = JWT_SIGNING_KEYRING + JWT_ACTIVE_KID (services/jwt.ts:26-42, .env.example:94-96)
6 overview.mdx:246-256 — prod CSP has no unsafe-inline; connect-src via CSP_CONNECT_HOSTS (middleware/security.ts:188)
7 overview.mdx:381 — 6 placeholder values + 11 patterns, not 24 (config/validate.ts:25-45)
8 error-tracking.mdx:29 — replaysOnErrorSampleRate 0.5 (apps/web/sentry.client.config.ts:19)
11 hardening.mdx:54 — SESSION_MAX_AGE doesn't exist; fixed 7 days (services/session.ts:7)
12 secrets.mdx:183-199 — rotating SESSION_SECRET does NOT invalidate sessions (random tokens); affects OAuth state + legacy encryption fallback
MISSING: 9 Cargo Audit = 6th scanner (.github/workflows/security.yml)
MINOR: 10 "npm audit" is osv-scanner; 13 audit result `dispatched`; 14 API key rotate = POST /api-keys/:id/rotate (apiKeys.ts:619); 15 SMS limit per login attempt; 16 Sentry tag is route_template
Accurate: pam.mdx fully, overview auth/RLS/rate-limit/headers/audit, backup.mdx.
Unverified: RTO/RPO aspirational; bulk API-key revoke.

# reference/ part 1 (api, api-keys, pam-api, schema, audit-logs, regional-settings, troubleshooting)
|1| troubleshooting.mdx:19-24 | WRONG | deploy requires 8 vars | scripts/prod/deploy.sh:120-154 requires 24 unconditionally + monitoring-only subset | replace list |
|2| audit-logs.mdx:27-49,92-100 | WRONG | hash chain on audit_logs.checksum/prevChecksum | vestigial (db/schema/audit.ts:37-40); real chain = audit_log_chain side table sealed by trigger (migration 2026-06-11-h), daily verify job jobs/auditChainVerify.ts P1, Ed25519 anchors | rewrite Tamper Evidence |
|3| audit-logs.mdx:205 | WRONG | max 500 log entries | max 200, 256KB gz (routes/agents/logs.ts:41) | fix |
|4| audit-logs.mdx:79-91 | WRONG | agent.source.ip.changed in security events report | not in securityActions set (routes/auditLogs.ts:100-108) | remove from list (or code fix) |
|5| audit-logs.mdx:153 | WRONG | Org Admin can set audit retention | route requireScope partner/system (routes/orgAuditRetentionSettings.ts:37,53) → org-scoped 403 | doc: partner-level action; flag product bug |
|6| regional-settings.mdx:21 | STALE | fixed 15 IANA zones | searchable ~418 zones (components/shared/TimezoneSelect.tsx) | any IANA zone |
|7| regional-settings.mdx:24 | MISSING | 7 languages | + tr-TR (PartnerRegionalTab.tsx:114) | add |
|8| troubleshooting.mdx:311-327 | STALE | MSI "Generate Link" bug fix ships after v0.67.0 | fixed (services/releaseSource.ts:80) | remove section |
|9| audit-logs.mdx:275-286 | MISSING | eventlogs response lacks filtered, level filter, 429, 5000 cap | routes/agents/eventlogs.ts:96,232; schemas.ts:910 | add |
|10| audit-logs.mdx:232 | MISSING | diag-log query needs only scope | + devices:read (routes/devices/diagnosticLogs.ts:18) | add |
api.mdx: audit endpoint table prefix /audit → /audit-logs; ENABLE_API_DOCS doesn't exist (ENABLE_API_DOCS_UI does); /devices pagination numbers wrong+self-contradictory; response envelopes don't match; "consistent error format" overclaim; Backup/AI Agents/EDR/M365 route groups unlisted.
api-keys.mdx: wildcard "*" scope claimed supported (rejected 400); enrollment TTL 60 min (30 days); pepper requirement overstated (only ENROLLMENT_KEY_PEPPER required).
pam-api.mdx: uacInterceptionEnabled default stated true (code false); missing assertion-challenge step-up endpoint, proof/reauth fields, matchSignerThumbprint; revoke/respond samples omit enforcementStatus.
schema.mdx: lastSeenIp typed inet (varchar(45)); core tables omit alerts/scripts/automations/tickets/api_keys.
Accurate: RELEASE_ARTIFACT key section, event-loop troubleshooting, MSI section, regional PATCH path, core audit endpoints, partner API tables, pam endpoints.

# reference/ part 2 (users-and-roles, organizations-and-sites, partner-management, sso, access-reviews, filters-and-search, account-deletion) — 20 findings
WRONG:
1 partner-management.mdx:75-101,378-399 + users-and-roles.mdx:143-144 — register-partner is now two-step email-verified; generic message, no tokens (routes/auth/register.ts:60-72,95-251; verifyEmail.ts); /auth/register legacy no-op
2 partner-management.mdx:210 — IP allowlist untrusted IP fails CLOSED (deny untrusted_ip, services/ipAllowlist.ts:37), not open
3 users-and-roles.mdx actions table + custom-role example + Built-in Permissions — action vocab wrong (view→read etc.; packages/shared/src/constants/permissions.ts, routes/permissionsCatalog.ts); ~25 missing constants; example payload invalid
4 users-and-roles.mdx:89-97,487 — PATCH /users/:id system-scope only (routes/users.ts:1473-1475)
5 users-and-roles.mdx:105 — PATCH /users/me fields name/email/preferences, not avatarUrl (users.ts:436-455); avatar via /users/me/avatar
6 sso.mdx:167-204 — SAML "can be activated" + ACS URL; no SAML route exists; users-and-roles.mdx:288 says correctly not implemented
7 partner-management.mdx:251 — plan enum missing starter/community (own page lists 6)
8 organizations-and-sites.mdx:166 — org status enum lists 4 of 8
9 organizations-and-sites.mdx:474 — body key orderedIds (routes/orgs.ts:1639-1648) + full partner access
10 account-deletion.mdx:29 — duplicate request is idempotent 200, not rejected
15 filters-and-search.mdx:207 — "30+ operators" → 24
MISSING: 11 partner+org `offboarding` status/drain flow (db/schema/orgs.ts:8, routes/orgs.ts:1271-1283); 12 platform admins bypass IP allowlist (ipAllowlist.ts:36); 13 requireMfa on all partner/org/site CUD routes; 14 filter fields deviceRole,lastUser,isHeadless,uptimeSeconds,watchdogStatus,quarantinedAt,lastSeenIp + capability checks patches.pending/alerts.critical/system.rebootRequired (services/filterEngine.ts:72-130); 16 search matches lastUser
NAV: 17 account-deletion nav entry platformAdminOnly (Sidebar.tsx:370)
MINOR: 18 software.installed operators; 19 8-per-category search cap; 20 public /account/delete page
Accurate: access-reviews (fully), account-deletion core.

# backup/ — 17 pages (17 findings)
WRONG:
1 cloud-to-cloud.mdx:86-102 + api-reference.mdx:166-178 — C2C sync/restore hard-coded to fail c2c_sync_not_implemented (services/c2cQueuedAuthorization.ts:282-316)
2 encryption.mdx whole — client-managed backup encryption not wired; only S3 SSE via services/backupEncryption.ts:84-138; agent has no crypto; EncryptionKeyList has early-access banner
3 storage.mdx:36-46, overview.mdx:36-44, monitoring.mdx:42 — providers only s3|local (routes/backup/schemas.ts:74; BackupDestinationSection.tsx:19); Azure/GCS unreachable
4 storage.mdx:54-60 — retention presets 5/10/20 versions (BackupTab.tsx:159-182); no scheduled key rotation (manual only)
7 api-reference.mdx:118-119 — /bmr/tokens (plural) (bmr.ts:365,446,536,564)
8 api-reference.mdx:100 — /hyperv/checkpoints/:deviceId/:vmId; vm-state same params (hyperv.ts:483,564)
13 restoring.mdx:61-70 — selective restore over-matches by prefix (agent/internal/backup/restore.go:329-343) — known 09-09 defect; caution note
NAV: 5 "Operations > Backup > X" ×10 across 8 pages → "Backup > Device Backup > [tab]" (Sidebar.tsx:283-293; BackupDashboard.tsx:35-48)
STALE: 6 overview.mdx:64-75 — 7 tabs → 10 (Profiles, Snapshots, Recovery Bootstrap)
MISSING: 9 boot-media endpoints (bmr.ts:910-1080); 10 jobs/run-all + preview (jobs.ts:333,389); 11 DELETE keys, DELETE vault, vault status, PATCH/DELETE sla configs, sla dashboard; 12 c2c items + DELETE connections; 15 troubleshooting has none of the 5 campaign defects
MINOR: 17 cron minutes 03:38 Sun / 02:18 daily (jobs/scheduleRegistry.ts:86,91)
Unverified: 14 long-path; 16 profile job order.
Accurate: policies, profiles, sql-server, sla, disaster-recovery, monitoring, hyperv, bare-metal-recovery.

# migration/ — 11 pages
| # | Page:line | Sev | Doc | Code | Edit |
|1| toolkit.mdx:124 | WRONG | PSA company-import supports "and Jira" | ORG_IMPORT_CAPABLE_PSA_PROVIDERS excludes jira (packages/shared/src/validators/psa.ts:49-55) | drop "and Jira" |
|2| toolkit.mdx:261, overview.mdx:123, mass-deployment.mdx:28 | STALE | enrollment key default TTL "60 minutes… too short" | 30 days via ENROLLMENT_KEY_DEFAULT_TTL_MINUTES (services/enrollmentKeyTtlDefault.ts:18-34) | say 30 days, tunable |
|3| toolkit.mdx:359 | WRONG | GET /devices limit capped at 100 | HARD_MAX 1000, default 500 (routes/devices/cursor.ts:29,39) | fix |
|4| toolkit.mdx:118 | MISSING | commit-only fields lack forceCreate | services/orgImport/types.ts:121-123 | add forceCreate |
|5| overview.mdx:148 + vendor pages | MISSING | warranty target is one target | 3 sub-targets + "Override manufacturer-provided warranty data" checkbox (routes/devices/customFieldImport.ts:70-80) | one sentence |
Accurate: everything else. Links all resolve.

# features/ Remote Management — 10 pages (7 findings)
WRONG: 1 deployments.mdx:103 — "Fleet" sidebar + Script/Patch/Software/Policy type picker don't exist; only software DeploymentWizard under Software catalog (components/software/DeploymentWizard.tsx:25); others API-only. 2 scripts.mdx:673 — API max timeout 3600 not 86400 (routes/scripts.ts:274,307)
MISSING: 3 remote-access.mdx session recordingUrl / View Recording (db/schema/remote.ts:24; SessionHistoryPage.tsx:238-252); 4 automations.mdx `cancelled` status + Cancel run (routes/automations.ts:811-936; AutomationRunHistory.tsx:100-131); 5 automations.mdx maintenance-window suppression (automationWorker.ts:882-902)
STALE: 6 maintenance-windows.mdx:294 reboot grace from effective patch policy, 15 min only fallback (maintenanceRebootWorker.ts:18-22)
MINOR: 7 script-ai.mdx:123 — 11 tools, add get_script_execution (services/scriptBuilderTools.ts:40-51,366)
Accurate: ai-agents, ai-impact, playbooks, system-tools, remote-access, scripts, maintenance-windows otherwise.

# features/ Patching + Billing + Fleet — 20 pages (16 findings)
WRONG:
1 software-inventory.mdx:399-401 — "in-memory layer" caution false; both endpoints read software_inventory (routes/software.ts:2449-2530)
2 software-inventory.mdx:17 — "App Library"/"App Policies" sidebar entries don't exist; one "Software" item, /software-inventory & /software-policies are tab aliases (Sidebar.tsx:253-255)
7 configuration-policies.mdx:354 — featureType list 10 of 19 (packages/shared/src/validators/index.ts:634)
15 patch-management.mdx:75 — per-user winget IS detected best-effort (winget_user.go), just not installable
13 tags.mdx — GET /tags ignores manual-asset tags (routes/tags.ts vs db/schema/manualAssets.ts:44)
MISSING: 3 fleet Inventory tab approve/deny/clear (routes/softwareInventory.ts; SoftwareInventory.tsx); 4 devices.mdx removal/uninstall/restore/bulk permanent-delete/purge-after-N-days (routes/devices/core.ts, bulkLifecycle.ts, DeviceLifecycleTab.tsx); 5 agent-version pin colouring (DeviceList.tsx); 6 config-policies 9 missing feature types (db/schema/configurationPolicies.ts:32-51): event_log, software_policy, sensitive_data, peripheral_control, warranty, helper, remote_access, onedrive_helper, device_lifecycle; 12 billing pages need Service Management module note (Sidebar.tsx:305-324); 14 warranty subject can be manual asset (db/schema/warranty.ts:29-38)
NAV: 8 update-rings.mdx:96 "Patches → Rings tab" (Sidebar.tsx:203; PatchesPage.tsx:30); 9 configuration-policies.mdx:119 + 10 warranty-tracking.mdx:24 → "Fleet Management → Config Policies" (Sidebar.tsx:250); 11 product-catalog.mdx:12,19 → "Billing → Product Catalog" (Sidebar.tsx:311)
MINOR: 16 decline response status 'declined' vs stored 'rejected' (routes/patches/approvals.ts:190,266)
Accurate: software-policies, policy-management, invoices, quotes, contracts, online-payments, device-groups, linked-profiles, custom-fields, onedrive-helper, notifications, reports.

# features/ Security & Compliance — 14 pages (13 findings)
WRONG:
1 user-risk.mdx:178-187 — Weights JSON uses 6 fictional keys; real 8 keys mfaRisk/authFailureRisk/sessionAnomalyRisk/threatExposureRisk/softwareViolationRisk/deviceSecurityRisk/staleAccessRisk/recentImpactRisk (services/userRiskScoring.ts:44-52); unknown keys dropped
2 user-risk.mdx:96,219-225,233-240 — "Settings > User Risk > Policy", Thresholds tab, Assign Training button don't exist (components/security/UserRiskPage.tsx) — API-only
12 security.mdx:~495 — triggerSecurityPostureRecompute(orgId) "from the API" — no route (jobs/securityPostureWorker.ts:283)
MISSING (API-only pages that ignore full consoles):
3 sensitive-data.mdx — console at Security → Sensitive Data (components/sensitiveData/*: Dashboard/Scans/Policies/Findings tabs)
4 peripheral-control.mdx — /peripherals (components/peripherals/*; DevicePeripheralsTab)
5 cis-hardening.mdx — /cis-hardening "CIS Benchmarks" (components/cisHardening/* Baselines/Compliance/Remediations)
6 audit-baselines.mdx — /audit-baselines "Compliance Baselines" (components/auditBaselines/*)
7 user-sessions.mdx:171-173 — 4 GET endpoints /devices/:id/sessions/{active,live,history,experience} (routes/devices/sessions.ts:42,128,168,229)
8 edr-integrations.mdx:21,54,105,194 — site-level scoping for S1/Huntress (routes/sentinelOne.ts:112-165; huntress.ts:924-944)
9 user-risk.mdx — user risk NOT site-scoped (routes/userRisk.ts) — state explicitly or file follow-up
11 user-risk.mdx:344-350 — GET /user-risk/evaluation
NAV: 10 approval-security.mdx:14 — path is Settings → Organizations → (org) → Security & Access → Approval Security (OrgSettingsPage.tsx:79-82); 13 pam.mdx:14 sidebar label "PAM" (Sidebar.tsx:274)
Accurate: dns-security, vulnerability-management, management-posture, approval-security (defaults), edr (vendors/flags).

# features/ Monitoring & Alerting A — 10 pages (9 findings)
WRONG:
1 alerts.mdx:116-152 — "Alerts > Rules > Create Rule" 301-redirects to /configuration-policies (pages/alerts/rules/*.astro); rules only via Config Policy Alert Rules tab (#2946)
2 alerts.mdx:228-244 — Escalation Policies "Alerts > Policies" page + rule field don't exist; API-only (routes/alerts/policies.ts)
3 alerts.mdx:130,248-256 — offline 24h cap only for config-policy rules (routes/configurationPolicies/featureLinks.ts); schema allows 10080
4 alert-templates.mdx:32-41 — built-ins: 5th is Device Offline not Network Latency High; conditions shape type/metric/operator/value, diskPercent gt 90; +4 network templates (migrations 0060, 0018) = 9
5 bandwidth-monitoring.mdx:191-216 — bandwidthInBps metric doesn't exist; bandwidth_high write-blocked, value in Mbps (services/alertConditions/handlers/bandwidthHigh.ts)
6 snmp.mdx:34-38 — auth md5|sha|sha256, priv des|aes|aes256 only (routes/monitoring.ts:388-393; EnableMonitoringForm.tsx:168-193)
MISSING: 7 network-monitors, alert-templates, snmp, network-baselines, network-intelligence — no UI paths (/monitoring, /settings/alert-templates, /snmp, NetworkBaselinesPanel, KnownGuestsSettings, DeviceIpHistoryTab)
STALE: 8 network-baselines vs network-intelligence duplicate API reference — consolidate
MINOR: 9 alerts.mdx:164-166 partner-wide scope set on the Config Policy, not the rule
Accurate: service-monitoring, performance-metrics, network-connections.

# features/ Monitoring & Alerting B — 9 pages (22 findings)
WRONG:
1 discovery.mdx:31-39,298,306,309,367-380,475,507 — status model is approvalStatus pending/approved/dismissed + isOnline; routes PATCH approve/dismiss, POST bulk-approve/bulk-dismiss; no /ignore (db/schema/discovery.ts:53,156; routes/discovery.ts:371,1296,1330,1637)
2 log-shipping.mdx:101,304-305 — default level warn (agent/internal/config/config.go:339)
3 log-shipping.mdx:219-296 — /logs/search etc. are EVENT-log search (services/logSearch.ts:19-33) → move to event-log-forwarding
4 agent-diagnostics.mdx:150-245 — `service` subcommand cross-platform (service_cmd_linux.go, _darwin.go)
5 change-tracking.mdx:8,61 — 8 change types (db/schema/changes.ts:14-22); batch cap CHANGE_INGEST_MAX_ITEMS 50,000 (routes/agents/schemas.ts:948-982)
6 filesystem-analysis.mdx:494-498 — cleanup-preview needs devices.execute (routes/devices/filesystem.ts:266-269)
8 reliability.mdx:110-116,208 — system_crash macOS only (reliability_unix.go:79); Linux app-crash sentence bogus
9 reliability.mdx:176 — service failure IDs 7000,7023,7024,7031,7034 (collectors/reliability.go:212-219)
10 ip-history.mdx:44,217 — macAddress varchar(64) (db/schema/devices.ts:349)
11 ip-history.mdx:81,263 — Windows DHCP via Get-NetIPInterface, 2s (heartbeat/ip_tracking.go:249-253)
12 event-log-forwarding.mdx:70-84 — partner-wide destination NOT delivered (services/logForwarding.ts:40-60) — likely PRODUCT GAP, confirm w/ eng
STALE: 7 reliability.mdx:144-166 flat -30/-15/-5 → saturating curve (services/reliabilityScoring.ts:578,592); 17 log-shipping component names; 22 reliability version notes v0.85-0.89
MISSING: 13 discovery Changes tab + alertOnNew/Disappeared/Changed (DiscoveryPage.tsx:25; routes/discovery.ts:291-297); 14 change-tracking UI tab + query_change_log AI tool; 15 ip-history UI tab; 16 MFA step-up notes (discovery/boot-performance/filesystem); 18 phone/iot/camera via OUI; 19 schedule timezone + 60-min default
MINOR: 20 agent log cleanup fixed daily slot; 21 macOS boot time sysctl kern.boottime
Accurate: boot-performance mechanics, ip-history heuristics, discovery scan mechanics, reliability math core, filesystem scan config, log-shipping batching, event-log-forwarding UI.

# features/ AI & Intelligence + Platform + orphans — 25 pages (28 findings + NAV)
WRONG:
1 branding.mdx:42-99,224-236,306-325 — logo upload API /branding/upload + GET/PUT branding don't exist; real GET/PATCH /organizations/:id/portal-settings excludes visual branding (routes/orgPortalSettings.ts:16-20,119-138); BrandingEditor.tsx never rendered; OrgBrandingEditor logo = local blob preview only
2 branding.mdx:320-325 — GET /portal/branding is authenticated; only /portal/branding/:domain is public (routes/portal/index.ts:29; branding.ts:54,86)
3 psa-integrations.mdx:96-166, integrations.mdx:502-521,663-664 — PSA ticket sync = 501 stub (routes/psa.ts:936-945); no Syncing status; UI has no Sync button
4 monitoring-integrations.mdx:20,42,98 — Test connection always {success:true} (routes/integrations.ts:178-180)
5 ai.mdx:117-144, mcp-server.mdx:406-423 — 8 tools listed with limits are unlimited; trigger_backup/execute_playbook = 5/10min (services/aiGuardrails.ts:1184-1282)
6 ai.mdx:203, mcp-server.mdx:244,414 — manage_policies doesn't exist → manage_configuration_policy / configuration_policy_compliance
7 ai-computer-control.mdx — page documents generic tools; real computer_control/take_screenshot/analyze_screen (services/aiToolsRemote.ts:68,125,190) + ai-operator absent → rescope
8 ai-computer-control.mdx:124,138,202,305 — timeouts execute_command/run_script/security_scan 120s, file_operations 60s (services/toolTimeouts.ts:15-21)
9 identity-integrations.mdx:99 — tenant domain form rejected (services/c2cM365.ts:31-33; routes/m365.ts:100-104)
STALE: 10 identity-console.mdx — two M365 profiles customer-graph-read/actions (packages/shared/src/m365/profiles.ts); 11 setup-wizard.mdx:9,20-24 — 4 steps Account/Organization/Regional/Install Agent (SetupWizard.tsx:22-26); 12 mobile.mdx:16-17 Expo 57 not 50
NAV: 13 ai.mdx:23,75,455 "Security → AI Risk" (Sidebar.tsx:262-278); 14 ai.mdx:180 "AI → Fleet Orchestration"; 22 integrations.mdx type table link to dedicated pages; 23 identity-console AI Risk path
MISSING: 15 portal.mdx account-disabled behaviour (apps/portal/src/lib/accountStatus.ts); 16 psa company import (PsaCompanyImport.tsx); 17 mobile attestation L1-L4 + findings rollup; 18 mobile detail fields; 19 plugins.mdx API-only no UI; 20 monitoring-integrations in-memory + MFA; 21 ML_OUTPUTS_DISABLED alias (config/env.ts:654-656)
MINOR: 24 admin-fallback reveal (routes/actionIntents.ts:60-88); 25 webhooks retryPolicy DB-only; 26 APP_ENCRYPTION_KEY always required; 27 integrations MFA note; 28 unifi duplication in integrations.mdx
ORPHANS (all keep + add to sidebar): extensions → Platform after plugins; incident-response → Security & Compliance after edr-integrations; ticketing → NEW "Service Desk" subgroup; watchdog → Agent group (move file to agents/ or explicit slug)
Accurate: bring-your-own-llm-key, fleet-hygiene, ai-for-office, distributor, accounting, unifi, extensions; webhooks + mcp-server mostly.

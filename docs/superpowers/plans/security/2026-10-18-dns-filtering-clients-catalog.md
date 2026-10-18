---
status: draft-for-review
issue: LanternOps/breeze#6958
related: [6960, 8734, 3408]
unblocks: "docs/superpowers/plans/security/2026-10-13-security-agents-policy.md Wave 5 (prerequisite P)"
spec: docs/superpowers/specs/security/2026-10-12-security-agents-policy-spec.md
verified_at: origin/main 23648a6246 (2026-10-18)
---

# DNS Filtering Clients (Control D, NextDNS) via Software Deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MSP can deploy Control D (`ctrld`) and the NextDNS CLI from the software catalog with the customer's provisioning code or profile ID substituted per org, and a stopped client shows up as a software-policy violation on the periodic compliance cycle.

**Architecture:** Five file-disjoint PRs close the four gaps in #6958:
- **(A) Shared validators.** Add a `service_running` detection clause, a `zip` file type, per-version install-spec rules, and the timeout budget.
- **(B) Agent.** Evaluate `service_running`, install `zip` packages, and run pre/post-install scripts through the existing script executor. Values travel as `BREEZE_PARAM_*` environment references and are never spliced into script text. B also fixes macOS/Linux service-absence reporting.
- **(C) API dispatch.** Send scripts with the same `{{...}}` grammar behind agent-version gates at enqueue and at claim, and add the data-model columns.
- **(D) Built-in catalog rows.** Code-pinned rows, one per vendor and OS, seeded per partner on demand.
- **(E) Periodic bridge.** API only. It reuses the existing monitoring service-watch path, which the agent already reports on Windows, macOS and Linux, so the compliance worker can raise `not_running` / `service_unverified` violations. It also fixes forward the missing RLS on `software_compliance_status`.

**Tech Stack:** Go agent (`agent/internal/remote/tools`, `executor`, `monitoring`, `svcquery`), Hono/TypeScript API, Drizzle (queries only) plus hand-written SQL migrations, BullMQ, Zod in `packages/shared`, Astro + React islands, Vitest, Go `testing`.

**Spec:** `docs/superpowers/specs/security/2026-10-12-security-agents-policy-spec.md` §2.4–§2.6, §3, Decisions 2/4/9. Read it alongside `docs/superpowers/plans/security/2026-10-13-security-agents-policy.md` (header `prerequisite: [6958]`, row **P**, Wave 5 Tasks 5.1–5.3). Issue #6958 is the requirements source. Out of scope: #3408 (Control D API sync), Linux `.rpm`, the security-agents W1–W5 code (`securityAgentVendors.ts` is not touched here).

---

## Premise check (all four gaps confirmed open at `23648a6246`)

| # | Claim | Evidence | Status |
|---|---|---|---|
| a | `BUILTIN_PACKAGES` holds only `huntress`/`sentinelone`; `ensureBuiltinPackage` (partner-scoped) is called only on integration connect | `apps/api/src/services/builtinDeploymentPackages.ts:5,28,66`; callers `routes/huntress.ts:457`, `routes/sentinelOne.ts:437` | open |
| b | No `service_running` clause | `packages/shared/src/validators/softwareDetection.ts`: `registry`, `file_exists`, `msi_product_code`, `file_version` | open |
| c | Pre/post scripts stored, never run | `db/schema/software.ts:76-77`; written by `routes/software.ts:1184,1408`, `routes/softwareUploads.ts:744`; read by neither `services/softwareDeployment.ts` nor `agent/internal/remote/tools/software_install.go` | open |
| d | DNS vendors not enableable, no presence | `services/securityAgents/securityAgentVendors.ts:90-115` (`enableable:false`, `presence:{}`) | open (flipped by #6960 W5, not here) |

No gap is already closed. Gap 2 (macOS/Linux args) is closed by scripts, as the issue allows. `.pkg`, `.dmg` (whether it holds a pkg or an app) and `.deb` stay argument-less (`software_install.go:681-726`). New writes that set `silentInstallArgs` on those types, or on `zip`, are rejected (`args_unsupported_for_file_type`) instead of being silently dropped.

## Decisions (settled; quorum outcome in the last section)

**D1 — Catalog mechanism: code-pinned built-in rows, one per (vendor, OS), keyed by a new `software_catalog.builtin_package_key`, seeded per partner on demand.**
- `software_versions` allows one `is_latest` per catalog (`software_versions_one_latest_per_catalog_idx`), and policy install remediation picks only that row (`softwarePolicyInstallRemediation.ts:164-169`). Manual deploys can name another version id (`routes/software.ts:2038`), but desired state cannot. Each OS therefore gets its own catalog row. Keys: `controld_windows`, `controld_macos`, `nextdns_windows`.
- `integration_provider` is **not** widened (spec Decision 4; `software_catalog_integration_provider_chk`). It keeps meaning "credentials come from integration X", which gates `resolveEdrInstaller` (`softwareDeployment.ts:704-734`). `builtin_package_key` means "Breeze-defined package". Huntress/S1 rows keep it NULL (backfill deferred).
- **Seeding is on demand, per partner; there is no migration backfill.**
  - `POST /software/builtin-packages/:key` provisions the row and `GET /software/builtin-packages` lists keys with their provisioned state.
  - The POST requires `devices.write`, `devices.execute` (the rows carry scripts), MFA and `canManagePartnerWidePolicies`.
  - A boot task `refreshPinnedBuiltinPackages()` (`runStartupTaskWithRetry`, `apps/api/src/index.ts:2017` precedent) moves provisioned rows to the code-pinned version. Pins change only with a code deploy.
  - Per catalog row the refresh runs in one transaction under `SELECT … FOR UPDATE`. It **only moves forward** (`compareSoftwareVersions(pinned, currentLatest) > 0`), so a booting older API replica cannot revert a newer pin.
- **Built-in rows are immutable outside system scope**, the same as integration rows. The guards that today test `integrationProvider !== null` also test `builtinPackageKey !== null`:
  - catalog PATCH `routes/software.ts:1016`
  - catalog DELETE `:1055`
  - install-method create `routes/softwareInstallMethods.ts:113`
  - version create/upload
  S1's partner-upload path is unaffected, because S1 rows have a NULL key.
- **`catalog:controld|nextdns` resolution:**
  - `BUILTIN_TENANT_VAR_PACKAGES[key].vendorKey` maps a key to its vendor.
  - `builtinPackageKeysForVendor(vendor)` maps a vendor to `{ windows?: key, macos?: key }`.
  - `software_catalog.builtin_package_key` maps a rule's `catalogId` back to its key and vendor.
  - Consuming these in `services/securityAgents/managedPolicyGenerator.ts` / `services/securityAgents/managedRuleApplicability.ts` is #6960 W5 (see D5).
- **No RLS change on the catalog.** The rows are partner-owned; partner scope reads them via `breeze_has_partner_access`, and the workers run in system context. Org-scope reads keep today's partner-wide-package behavior: catalog via `software_catalog_partner_wide_select`, versions denied. That denial is a pre-existing gap, deferred and pinned by a test.

**D2 — Installer sources: GitHub release assets pinned in code, sha256 from the vendor's `checksums.txt`.**
- Floating URLs are never used for built-ins.
- NextDNS `stable.msi` is rejected (unpinnable).
- Control D's `api.controld.com/dl/rmm` is rejected (an unpinned remote script run as SYSTEM).

| Key | Artifact (verified 2026-10-18) | sha256 (matches `checksums.txt` and a local `shasum -a 256`) | Install | Enrollment |
|---|---|---|---|---|
| `controld_windows` | `https://github.com/Control-D-Inc/ctrld/releases/download/v1.5.8/ctrld_1.5.8_windows_amd64.zip` (exe at `dist/ctrld_1.5.8_windows_amd64/ctrld.exe`) | `7a72bab5ad384f9028c48f166f7872b5fc64f7210e65bbb59ce4d257d36df310` | `zip` (extract only) | post-install: copy to `C:\ControlD\ctrld.exe`, `ctrld.exe start --cd-org <code>` |
| `controld_macos` | `https://github.com/Control-D-Inc/ctrld/releases/download/v1.5.8/ctrld_1.5.8_darwin_universal.pkg` (Developer ID Installer signed, notarized) | `dfc94e649e8a38fa04a314ff2d23fba59903cea217a315deafb9bece6979ec3c` | `pkg` | pre-install: write the managed-prefs `ProvisionToken` the pkg's own postinstall consumes |
| `nextdns_windows` | `https://github.com/nextdns/nextdns/releases/download/v1.47.3/nextdns_1.47.3_windows_amd64.zip` (`nextdns.exe` at the archive root) | `b9ea2c3b2286d62aff63c48356c06ee75bf9fb775b7d9800b3c0d9febaedcbfc` | `zip` | post-install: `nextdns.exe install -profile <id> -report-client-info -auto-activate` (self-copies to `C:\Program Files\nextdns\`) |

| Vendor fact | Status |
|---|---|
| ctrld service name `ctrld` | VERIFIED: `cmd/cli/prog.go@v1.5.8` `ctrldServiceName = "ctrld"` |
| `ctrld start --cd-org <code>` enrolls via a provisioning code | VERIFIED: docs.controld.com/docs/provisioning; pkg postinstall runs `start --cd-org=` |
| On a fresh install (no `/Library/LaunchDaemons/ctrld.plist`), the ctrld pkg postinstall exits 1 unless `/Library/Managed Preferences/com.controld.ctrld` holds a `ProvisionToken`. It polls 12×10 s, reads with `defaults read <path>`, and requires 6–64 characters with no whitespace. When the plist exists it takes an upgrade path that keeps the endpoint identity | VERIFIED: expanded `Scripts/postinstall` of the v1.5.8 pkg |
| The pkg installs `/usr/local/bin/ctrld` and `/usr/local/controld/uninstall.sh` | VERIFIED: `pkgutil --payload-files` |
| A root-written (not MDM-delivered) plist at that path is honored by the postinstall and left alone by macOS on an unmanaged Mac | **NOT VERIFIED** (lab gate L2) |
| `ctrld start` registers the service against the path it ran from (so it must run from `C:\ControlD`, not the staging dir) | **NOT VERIFIED** (L1); the script copies first either way |
| NextDNS CLI service name `nextdns`; `install` copies the exe to `C:\Program Files\nextdns\nextdns.exe` and registers the service | VERIFIED: `service.go@v1.47.3` (`Name: "nextdns"`), `host/service/windows/service.go@v1.47.3` (`InstallDir = C:\Program Files\<name>`) |
| NextDNS flags `-profile`, `-report-client-info`, `-auto-activate` | VERIFIED: `config/config.go@v1.47.3` |
| `nextdns install …` run from a SYSTEM service on Windows 11 enrolls and starts the service | **NOT VERIFIED** (L3) |
| `amd64` builds run on Windows 11 ARM64 under emulation as a DNS service | **NOT VERIFIED**: documented limitation, not a gate |

NextDNS macOS is **deferred**. The CLI ships per-arch tarballs only, and deployment has no architecture selection.

**D3 — Pre/post-install scripts run through the agent's script executor, with values as parameters.**

*Payload*
- `preInstallScript` / `postInstallScript: { language, content, parameters, timeoutSeconds }`.
- `language` follows the device OS: `powershell` on Windows, `bash` on macOS/Linux. Because of that binding, a version with scripts declares exactly one `supportedOs`.
- `timeoutSeconds = SOFTWARE_INSTALL_SCRIPT_TIMEOUT_MS / 1000` = 600.

*Substitution*
- Authored text uses the `installerVariables.ts` grammar (`{{org.*}}`, `{{site.*}}`, `{{device.hostname}}`, `{{device.customField.<k>}}`, `{{var.<k>}}`) plus agent-filled `{{install.dir}}` / `{{install.file}}`.
- The API rewrites each token to an executor placeholder (`{{var.x}}` → `{{var_x}}`) and puts the resolved value in `parameters`.
- `executor.RenderParameterReferences` (`agent/internal/executor/paramrefs.go:89`) turns the placeholders into `BREEZE_PARAM_*` env references. No value reaches the script file, so no charset filter is needed.
- An unresolved token fails the device with the existing `Could not resolve installer variable(s): …` message.
- The secret-variable rejection (`softwareDeployment.ts:836-848, :927`) covers scripts too, with the same text.

*Agent order*
1. Detection pre-gate. A detected install is skipped and no script runs.
2. Platform check.
3. A `zip` without a post-install script is refused.
4. Download, then sha256.
5. Restore checkpoint.
6. Pre-install script.
7. `executeInstaller`, or archive extraction for `zip`.
8. Post-install script.
9. Post-install detection, polling up to 60 s while a `service_running` clause is unmet.
10. Staging-dir cleanup, last, so scripts can copy files out first.

*Failure codes*
- `pre_install_script_failed`: the installer is not run.
- If the installer fails, the post-install script is not run.
- `post_install_script_failed`: no rollback; the restore point stays.
- `install_script_timeout`: the process tree is killed.
- `archive_requires_post_install_script`: refused before download.
- `install_script_runner_unavailable`: a payload carries a script but the build has no runner. It never silently skips the script.

The executor's content validation applies unchanged. Captured output has every `var_*` parameter value replaced with `[redacted]`.

*Dormant rows stay dormant*
- New column `software_versions.install_scripts_enabled boolean NOT NULL DEFAULT false`. Existing rows that already hold scripts keep exactly today's behavior (scripts not sent).
- Only a create path whose writer holds `devices.execute` sets it to true, as does `ensurePinnedBuiltinPackage`.
- The UI shows an inactive stored script as "not active; re-create the version to activate".

*Authorization*
- A non-null script on any create path (JSON `POST /catalog/:id/versions`, multipart `/versions/upload`, the chunked-upload completion in `routes/softwareUploads.ts`) requires `devices.execute` on top of `devices.write` + MFA.
- PATCH stays script-immutable.
- PATCH re-validates the single-OS invariant when `supportedOs` changes on a version with scripts.
- `softwarePolicyExecutableRulesAuthorization.ts` (PAM `rules.executable[]`) and `automationReferenceAuthorization.ts` need no change. Automation `deploy_software` reaches the same dispatch and gates.

*Agent gates*
- `MIN_AGENT_VERSION_INSTALL_SCRIPTS` covers any script-enabled version or `fileType:'zip'`.
- **At enqueue:** an older agent's device result is `failed` with `agent_update_required (minimum agent <v>)` and no command is created. An older agent ignores unknown payload keys and would run a pkg without its pre-script.
- **At claim:** the same check repeats in the command-claim path, modeled on `failClaimedSecretCommandsForUnsupportedAgent` (`services/scriptSecretDelivery.ts`), because agent version is non-sticky across a downgrade.

*Persistence*
- `device_commands.payload` is plaintext JSONB (`services/sensitiveCommandPayload.ts:15`).
- Provisioning codes are non-secret by design and are stored like `silentInstallArgs` are today.
- Command audit (`services/commandAudit.ts:61`) gains a `software_install` branch that reduces script `content` to `contentMetadata` and sanitizes `parameters`.
- `fingerprintSoftwareVersionDependency` (`services/softwareDependencyIdentity.ts:51`) includes `preInstallScript`, `postInstallScript` and `installScriptsEnabled` only when the scripts are enabled. Existing fingerprints stay byte-identical (#7038 pattern).

*Timeout budget*
- Download 15 + installer 30 + two scripts 2×10 + settle 1 = 66 min, which exceeds `SOFTWARE_INSTALL_SERVER_TIMEOUT_MS` = 55 min (`packages/shared/src/constants/softwareInstallTimeouts.ts`).
- Raise it to **75 min** and add `SOFTWARE_INSTALL_SCRIPT_TIMEOUT_MS = 10 min`. Both are pinned by the Go timeouts test.

**D4 — `service_running`: one clause, two evaluators.**

*Schema*
- `{ type: 'service_running', serviceName }`: 1–256 characters, no control characters, no leading `-`.
- It means the Windows SCM service name (svcquery falls back to display name), the macOS launchd label, or the Linux systemd unit, depending on the executing OS.

*Install time (agent, B1)*
- Evaluated in the pre-gate and in post-install verification. A stopped service re-dispatched for install therefore reinstalls and re-enrolls.
- Windows/macOS use `svcquery.GetStatus`; Linux uses a tools-local `systemctl is-active --quiet -- <unit>` helper. `svcquery_other.go` is untouched, so `mgmtdetect` booleans do not change.

*Older agents*
- They treat an unknown clause as "rule set unsupported" (`software_detection.go:131`; an earlier false clause short-circuits first). So the API strips `service_running` for agents below `MIN_AGENT_VERSION_SERVICE_RUNNING_RULE`.
- If no clauses remain, the payload carries no `detectionRules`.

*Periodic bridge (API, E)*
- The compliance worker (system context) derives, per (policy, device), the `service_running` names from each **allowlist-mode** rule's catalog `is_latest` version that applies to the device's OS. Audit/blocklist modes are untouched (`softwarePolicyService.ts:422` allowlist branch vs `:481` blocklist, audit at `:233`).
- It stores them in `software_compliance_status.service_watches` (`[{ name }]`).
- `resolveDeviceMonitoringSettings` (`routes/agents/helpers.ts:2728`) unions them as service watches:
  - **Read** in the agent's own context, joined to `software_policies` where `is_active`. Rows must have `last_checked` within 30 min, and an inactive or disabled policy's watches vanish within one cache TTL (120 s).
  - **Auto-restart** is re-derived at read time from the live policy row (`evaluateSoftwarePolicyArming(policy, 'install').armed`, `softwarePolicyService.ts:229`), never from stored state. When armed: `max_restart_attempts: 3`, `restart_cooldown_seconds: 300` (0 attempts means no restart, `agent/internal/monitoring/monitor.go:277`).
  - **Deduplication and cap:** deduped case-insensitively (`watchKey`, `services/monitoringActiveWatches.ts`), where a monitor watch of the same name wins, and capped at 50 derived watches per device.
  - **Interval:** a device with only derived watches checks every 300 s.
- **The agent needs no release for the periodic path.** Absence reporting is the one correctness fix B makes.
- **Presence evidence.** A fresh service status substitutes for an inventory match only when the rule has no `vendor`, `minVersion` or `maxVersion`; otherwise the inventory match stays required (AND semantics preserved).
- **Freshness.** Only results no older than 60 min count. A `not_found` counts as absence only from an agent at or above `MIN_AGENT_VERSION_SERVICE_RUNNING_RULE`. Older macOS agents report every query error as `not_found` (`agent/internal/monitoring/service_darwin.go:12`), and Linux conflates exec failures (`service_linux.go:31`). An older agent's `not_found` reads as `error`.

| Inventory match | Fresh service status | Result |
|---|---|---|
| no | none, `error` | `service_unverified` (severity `low`; no install. A telemetry gap must not reinstall) |
| no | `not_found` | `missing` (existing; drives install remediation, bounded by W2 attempt accounting) |
| no | `stopped` | `not_running` (severity `high`; the service exists, so the client is installed) |
| any | `running` | compliant for this rule |
| yes | `stopped` | `not_running` |
| yes | `not_found` | `not_running` (`observedStatus:'not_found'`) |
| yes | none, `error` | `service_unverified` |

*Remediation and alerting*
- `not_running` / `service_unverified` never enqueue install or uninstall remediation. Remediation is the armed watch's agent-side auto-restart.
- **Cost of first install:** with no telemetry on the first pass the result is `service_unverified`. A fresh `not_found` arrives within one check interval of watch delivery, so the install starts one compliance cycle (≤15 min) later.
- **Alerting** is deferred to #6960 W3, which spec §2.6 assigns to #6960; a new built-in alert source also needs its own index migration (`services/builtInAlertRules.ts:14-20`). `monitoring.check_failed` events already fire for derived watches.

*Tenancy*
- `software_compliance_status` has **no RLS today**. It is on `UNREVIEWED_RLS_CLASSIFICATION_DEBT` (`__tests__/integration/rls-coverage.integration.test.ts:1303`, "candidate shape 5 (device-join)").
- An agent-read surface must not rest on it, so E fixes it forward: RLS enabled + forced with device-join policies, moved into `DEVICE_ID_JOIN_POLICY_TABLES` (:1030). The debt list only shrinks.

**D5 — Uninstall, and the W5 contract.**

*Uninstall*
- Uninstall is never implicit.
- Breeze's uninstall is name-based (`software_uninstall {name, version}`, `agent/internal/remote/tools/software.go:126`), so it cannot find zip-installed clients, which have no Add/Remove Programs entry.
- Built-in defs carry a documented `uninstallCommand` that is shown in the UI and never executed:
  - `C:\ControlD\ctrld.exe uninstall`
  - `sudo /usr/local/bin/ctrld uninstall`
  - `"C:\Program Files\nextdns\nextdns.exe" uninstall`
- Deleting the endpoint in the Control D dashboard makes `ctrld` uninstall itself (vendor docs).
- Catalog-driven uninstall is a follow-up.

*Shipped detection rules (the W5 Task 5.2 contract)*

| Key | `detectionRules` (AND) | W5 presence descriptor, asserted equal |
|---|---|---|
| `controld_windows` | `file_exists C:\ControlD\ctrld.exe`, `service_running ctrld` | `presence.windowsService = 'ctrld'` |
| `controld_macos` | `file_exists /usr/local/bin/ctrld`, `service_running ctrld` | `presence.macLaunchdLabel = 'ctrld'` (W5 renames `macProcess`, since launchd labels are not process names) |
| `nextdns_windows` | `file_exists C:\Program Files\nextdns\nextdns.exe`, `service_running nextdns` | `presence.windowsService = 'nextdns'` |

*W5 obligations recorded here (not built here)*
- Assert with `serviceRunningNamesFor(key)`.
- Generate one rule per (vendor, platform) catalog key (`services/securityAgents/managedPolicyGenerator.ts:78` takes one catalog id per vendor today).
- Extend `services/securityAgents/managedRuleApplicability.ts:110` filtering (today `missing` only) to `not_running` and `service_unverified` for off-platform or not-ready rules.
- Replace `detectionRuleName` globs (`'Control D*'` never matches inventory; presence comes from the bridge).
- Flip `enableable`, and set Control D `platforms.macos` to `supported` only after L2.

*Where each piece ships*
- **Agent-shipped (agent release plus owner lab):** B: `service_running` evaluation, `zip`, scripts, the absence-reporting fix.
- **API-only:** A, C, D, E. The periodic bridge works on every agent that runs monitoring watches.

## Global Constraints

- **Public repo.** No customer names, hostnames or IPs. Fixtures use `<provisioning-code>` / `<profile-id>`.
- **Migrations.** Read `apps/api/migrations/README.md` first.
  - Slots: `2026-12-31-234000-software-install-scripts-builtin-key.sql` (PR C) and `2026-12-31-234100-software-compliance-rls-service-watches.sql` (PR E).
  - The newest committed migration at plan time is `2026-12-31-170000-m365-consent-sessions-v2-only.sql`. Slots `210000`/`220000`/`230000`/`233000` are reserved by other plans.
  - Each PR's Task 0 re-runs `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -5` and moves up if something newer landed (`scripts/check-migration-naming.sh` enforces this).
  - Rules: idempotent; no inner `BEGIN;`/`COMMIT;`; never edit a shipped migration; `pnpm db:check-drift` after.
  - Neither file writes rows. Add `SELECT set_config('breeze.scope','system',true);` anyway as a harmless guard.
- **Agent gates.** They live in `apps/api/src/services/softwareInstallAgentSupport.ts` and follow `services/yaraScanRefs.ts:25-40`:
  - The version must be a string. Take the core as `trim().split('-',1)[0]`; `parseComparableVersion` must return non-null; pass when `compareAgentVersions(core, MIN) >= 0` (`services/agentEditionCompat.ts:48`).
  - Unparseable, `dev` or empty means unsupported.
  - Both constants are set to **the first unreleased agent version** when PR C is written (`git tag --sort=-v:refname | head -1`, +1 minor) and re-checked at release cut. A slip makes the gate stricter, never looser.
- **No secret reaches a script.** A secret `var.*` fails the whole device with the existing message. `SecretEnv` delivery for install scripts is a deferred design.
- **Built-in pins** (URL, sha256, version) change only in `builtinDeploymentPackages.ts`. Every bump re-verifies sha256 against the vendor's `checksums.txt` and says so in the PR body.
- **Typecheck.** `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .`; read the exit code directly and never pipe to `tail`. Same for `apps/web` and `packages/shared` when they are touched.
- **Tests.**
  - API: `cd apps/api && npx vitest run <files>`, with no `--` before the files.
  - Shared: `cd packages/shared && npx vitest run <files>`.
  - Web: `cd apps/web && npx vitest run <files>`.
  - Agent: `cd agent && go test -race ./internal/<pkg>/...` while iterating, then `go test -race ./...`.
  - On a loaded host, run small batches with generous timeouts.
- **Integration suites.** `pnpm test` skips the RLS/integration suites. PRs C, D and E run theirs on a per-worktree stack (`pnpm wt-stack`; copy root `.env`, blank AI keys, `BREEZE_WORKSPACE_ENABLED=false`, a free `BREEZE_DOCKER_SUBNET=172.31.N.0/24`), then tear it down and say so.
- **CI.** PRs target `main`, where normal CI runs. A stacked PR gets no CI: run `gh workflow run CI --ref <branch>`.
- **Web copy.** Goes in all **8** locales (`apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}`), with parity enforced by `apps/web/src/lib/i18n/localeParity.test.ts`. Mutations use `runAction` (`no-silent-mutations.test.ts`).

## Review Focus

Failure modes the issue implies that no headline test exercises. Each is pinned in the task that owns the code.

1. **A downgrade between enqueue and delivery.** A command queued for a new agent must be failed at claim if the device now reports an older version. Pinned in C3 (claim-path test).
2. **A telemetry gap on a zip-installed client.** No inventory entry and no fresh service result must read `service_unverified`, not `missing`, so the client is not reinstalled. Pinned in E2.
3. **Restart authority after revocation.** If the policy is deactivated or disarmed, the delivered watch must lose `auto_restart` (or disappear) within one monitoring-cache TTL. It must not wait out `last_checked` aging. Pinned in E4.
4. **Same service watched by a monitor.** One watch is delivered and the monitor's settings win. Pinned in E4.
5. **The macOS managed-preferences file around a failed install.**
   - The pre-script never overwrites a file it did not write.
   - It writes mode 600 and marks the file `BreezeWritten`.
   - Post-install deletes only a marked file.
   - A failed pkg leaves a marked, root-only file, which the next pre-script overwrites and the next successful post-script removes.
   - Pinned in D2 and in lab gate L2.

---

## PR map and file ownership

Merge order: **A → (B ∥ C) → E → D**. Each PR targets `main` after its predecessor merges, and no file appears in two PRs. D merges last because without E a zip client never matches inventory, so it reads as `missing` forever.

| PR | Branch | Owns (exclusively) | If the next PR never ships |
|---|---|---|---|
| **A** shared | `feat/6958-a-shared-install-spec` | `packages/shared/src/validators/softwareDetection.ts`(+test), `packages/shared/src/utils/softwareFileType.ts`(+test), `packages/shared/src/validators/softwareVersionInstallSpec.ts`(new,+test), `packages/shared/src/validators/index.ts`, `packages/shared/src/constants/softwareInstallTimeouts.ts` | Inert types; `zip` writes fail validation until C wires them |
| **B** agent | `feat/6958-b-agent-install-scripts` | `agent/internal/remote/tools/{software_install.go,software_detection.go,software_detection_service_{windows,darwin,linux,other}.go,software_install_archive.go,software_install_scripts.go}`, `software_install_timeouts_test.go`, `testdata/builtin_scripts/*`, `agent/internal/heartbeat/handlers_software_install.go`, `agent/internal/monitoring/{service_darwin.go,service_linux.go}`, `agent/internal/svcquery/svcquery_darwin.go`, their tests | API never sends the new keys (gates stay above every real agent) |
| **C** API dispatch + data model | `feat/6958-c-api-install-scripts` | migration `234000`, `apps/api/src/db/schema/software.ts`, `services/tenantExportPolicyRegistry.ts`, `services/softwareDeployment.ts`, `services/installerVariables.ts`, `services/softwareInstallAgentSupport.ts`(new), `services/installScriptPayload.ts`(new), `services/commandDelivery.ts`, `services/commandAudit.ts`, `services/softwareDependencyIdentity.ts`, `routes/software.ts`, `routes/softwareUploads.ts`, `routes/softwareInstallMethods.ts`, their tests | Scripts dispatchable for user-authored versions; no built-ins |
| **E** compliance bridge | `feat/6958-e-service-running-bridge` | migration `234100`, `apps/api/src/db/schema/softwarePolicies.ts`, `services/softwarePolicyServiceRules.ts`(new,+test), `services/softwarePolicyService.ts`, `jobs/softwareComplianceWorker.ts`(+test), `routes/agents/helpers.ts`, `routes/agents/helpers.softwareServiceWatches.test.ts`(new), `__tests__/integration/rls-coverage.integration.test.ts`, `__tests__/integration/softwareComplianceStatusRls.integration.test.ts`(new) | `service_running` violations for any catalog version that carries the clause; no DNS built-ins yet |
| **D** built-ins + web | `feat/6958-d-builtin-dns-catalog` | `apps/api/src/services/builtinDeploymentPackages.ts`(+test), `__tests__/integration/{builtinDeploymentPackages,builtinCatalogRls}.integration.test.ts`, `routes/softwareBuiltinPackages.ts`(new,+test), `apps/api/src/index.ts`, `services/mcpCoverage.ts`, `__tests__/partner-wide-write-coverage.test.ts`, `apps/web/src/components/software/{BuiltinPackagesPanel.tsx(new),SoftwareCatalog.tsx,DetectionRulesEditor.tsx,SoftwareVersionManager.tsx}`, 8 locale files | n/a |

---

## PR A — shared

### Task A0: Baseline
- [ ] Fresh `origin/main` worktree; `pnpm install`. Run `cd packages/shared && npx vitest run src/validators/softwareDetection.test.ts` and `src/utils/softwareFileType.test.ts`, and record the pass counts.

### Task A1: `service_running` clause

**Files:** Modify `packages/shared/src/validators/softwareDetection.ts`; Test `…/softwareDetection.test.ts`.

**Interfaces:**
- Produces: `DetectionRule` member `{ type: 'service_running'; serviceName: string }`.

- [ ] **Step 1 (red):**
```ts
it('accepts a service_running clause', () => {
  expect(detectionRulesSchema.parse([{ type: 'service_running', serviceName: 'ctrld' }]))
    .toEqual([{ type: 'service_running', serviceName: 'ctrld' }]);
});
it.each(['', '-x', 'a\u0000b', 'a\nb', 'x'.repeat(257)])('rejects serviceName %j', (serviceName) => {
  expect(detectionRulesSchema.safeParse([{ type: 'service_running', serviceName }]).success).toBe(false);
});
it('accepts a display-name style serviceName with spaces', () => {
  expect(detectionRulesSchema.safeParse([{ type: 'service_running', serviceName: 'NextDNS Service' }]).success).toBe(true);
});
```
- [ ] **Step 2:** `npx vitest run src/validators/softwareDetection.test.ts` → FAIL (unknown discriminator).
- [ ] **Step 3:** add a `.strict()` object to the union. `serviceName` is `z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f-][^\x00-\x1f\x7f]*$/)`. Update the header comment (lines 16–21): the clause is portable (SCM / launchd / systemd).
- [ ] **Step 4:** PASS. Commit `feat(shared): service_running detection clause (#6958)`.

### Task A2: `zip`, install-spec rules, timeout budget

**Files:** Modify `packages/shared/src/utils/softwareFileType.ts`, `packages/shared/src/constants/softwareInstallTimeouts.ts`; Create `packages/shared/src/validators/softwareVersionInstallSpec.ts` (export from `validators/index.ts`); Tests alongside.

**Interfaces:**
- Produces:
```ts
export const INSTALL_SCRIPT_MAX_BYTES = 65536;
export type InstallSpecIssue =
  | 'zip_requires_post_install_script'
  | 'scripts_require_single_os'
  | 'script_too_large'
  | 'args_unsupported_for_file_type';
export function validateSoftwareVersionInstallSpec(input: {
  fileType: string | null | undefined;
  supportedOs: unknown;
  silentInstallArgs: string | null | undefined;
  preInstallScript: string | null | undefined;
  postInstallScript: string | null | undefined;
}): InstallSpecIssue[];
export const SOFTWARE_INSTALL_SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
// SOFTWARE_INSTALL_SERVER_TIMEOUT_MS: 55 → 75 min (comment: download 15 + installer 30 + 2 scripts 20 + settle 1 = 66, plus margin)
```
- [ ] **Step 1 (red):**
  - `SOFTWARE_FILE_TYPES` includes `'zip'` and a `.zip` filename infers `'zip'`.
  - A zip with no post-install script → `['zip_requires_post_install_script']`.
  - Scripts with `supportedOs` set to `[]`, `null` or `['windows','macos']` → `['scripts_require_single_os']`.
  - A 65,537-**byte** script → `['script_too_large']`.
  - `silentInstallArgs:'/S'` with `pkg`, `dmg`, `deb` or `zip` → `['args_unsupported_for_file_type']`.
  - `msi` with args, one OS and no scripts → `[]`.
  - A whitespace-only script counts as absent.
  - `SOFTWARE_INSTALL_SERVER_TIMEOUT_MS === 75*60*1000`.
- [ ] **Step 2:** run the test files → FAIL.
- [ ] **Step 3:** implement. Byte length is `new TextEncoder().encode(s).length`.
- [ ] **Step 4:** PASS. Typecheck `packages/shared`, `apps/api` and `apps/web`. Any exhaustive record over `SOFTWARE_FILE_TYPES` that breaks gets its `zip` arm in the PR that owns that file; list each in the PR body. Commit. Open PR A (`Refs #6958`).

---

## PR B — agent (agent-shipped: release + owner lab required)

### Task B1: Evaluate `service_running`; truthful absence

**Files:**
- Modify `agent/internal/remote/tools/software_detection.go`:
  - `DetectionRule.ServiceName string \`json:"serviceName"\``
  - `parseDetectionRules` reads it via `detectionStringField`
  - `evaluateClause` gets a `service_running` case
- Create `software_detection_service_windows.go` and `_darwin.go` (both via `svcquery.GetStatus`), `_linux.go` (`systemctl is-active --quiet -- <unit>`, 5 s timeout) and `_other.go` (unsupported).
- Modify `agent/internal/svcquery/svcquery_darwin.go`: wrap the final not-found error with `ErrServiceNotFound`.
- Modify `agent/internal/monitoring/service_darwin.go`: map errors through `serviceErrorStatus`.
- Modify `agent/internal/monitoring/service_linux.go`: a failure to exec `systemctl` returns `StatusError`, not `not_found`.
- Tests: `software_detection_test.go`, `monitoring/service_status_test.go`, `svcquery/svcquery_test.go`.

**Interfaces:**
- Produces: the package-level test seam `var serviceStatusFn func(name string) (running bool, supported bool)`.

- [ ] **Step 1 (red):** table tests.
  - `serviceStatusFn` stub:
    - running → `{Detected:true, Supported:true}`
    - stopped or not found → `{Detected:false, Supported:true}`
    - lookup error → `{Supported:false}`
  - `[file_exists(present), service_running(stopped)]` → not detected.
  - `TestParseDetectionRules` reads `serviceName`.
  - Darwin: `launchctl list` failing → `StatusError`.
  - Absent label and no plist → `errors.Is(err, svcquery.ErrServiceNotFound)` → `StatusNotFound`.
  - Linux: `systemctl` missing → `StatusError`.
- [ ] **Step 2:** `cd agent && go test -race ./internal/remote/tools/ ./internal/monitoring/ ./internal/svcquery/ -run 'ServiceRunning|ParseDetectionRules|ServiceStatus|NotFound'` → FAIL.
- [ ] **Step 3:** implement. A name starting with `-` is refused before exec. `svcquery_other.go` is not modified.
- [ ] **Step 4:** PASS. Run `go test -race ./internal/mgmtdetect/` to confirm mgmtdetect booleans are unchanged. Commit.

### Task B2: `zip` archives

**Files:** Create `agent/internal/remote/tools/software_install_archive.go`; Modify `software_install.go`:
- `installerPlatforms` gets `zip: windows, darwin, linux`.
- `validateInstallInputs` accepts `zip`.
- `zip` → `extractArchive` instead of `executeInstaller`.

Test: `software_install_archive_test.go`.

**Interfaces:**
- Produces: `func extractArchive(zipPath, destDir string) error`, with `maxArchiveEntries = 1000` and `maxArchiveUncompressedBytes = 1 << 30` (counted from bytes copied, not headers).

- [ ] **Step 1 (red):**
  - `TestExtractArchive` (table):
    - A nested entry `dist/x/ctrld.exe` lands under `destDir`.
    - `../evil`, `/abs`, `C:\x` and symlink entries → error.
    - 1001 entries → error.
    - A zip bomb past the byte cap → error.
  - `TestInstallSoftwareZipRequiresPostInstallScript`: the error is returned before the `downloadFileFn` stub is ever called.
- [ ] **Step 2:** `go test -race ./internal/remote/tools/ -run 'ExtractArchive|Zip'` → FAIL.
- [ ] **Step 3:** implement with `archive/zip`, keeping the unix exec bit, into the existing private install dir.
- [ ] **Step 4:** PASS. Commit.

### Task B3: Pre/post-install scripts

**Files:** Create `agent/internal/remote/tools/software_install_scripts.go` and `testdata/builtin_scripts/{controld_windows_post.ps1,controld_macos_pre.sh,controld_macos_post.sh,nextdns_windows_post.ps1}` (byte copies of D2's constants); Modify `software_install.go` (order per D3), `software_install_timeouts_test.go` (pin `SOFTWARE_INSTALL_SCRIPT_TIMEOUT_MS`), `agent/internal/heartbeat/handlers_software_install.go`; Tests `software_install_scripts_test.go`, `heartbeat/handlers_software_install_test.go`.

**Interfaces:**
- Consumes: payload `preInstallScript` / `postInstallScript` = `{"language":"powershell"|"bash","content":string,"parameters":{string:string},"timeoutSeconds":int}` (C3).
- Produces:
```go
type InstallScriptRunner func(executor.ScriptExecution) (*executor.ScriptResult, error)
type InstallOptions struct{ RunScript InstallScriptRunner }
func InstallSoftwareWithOptions(payload map[string]any, progress ProgressReporter, opts InstallOptions) CommandResult
```
- `InstallSoftwareWithProgress` keeps its signature and calls `InstallSoftwareWithOptions` with a nil runner.
- The agent sets `parameters["install_dir"]` (private dir) and `parameters["install_file"]` (downloaded path), and refuses a server-sent value for either key.
- The result map gains `preInstallScript` / `postInstallScript: {exitCode, output, durationMs, outputTruncated?}`.

- [ ] **Step 1 (red):** fake-runner tests.
  1. The order is exactly `["pre","installer","post"]` (one shared slice).
  2. Pre exits 3 → the installer is never called; `pre_install_script_failed`, `exitCode:3`.
  3. The installer fails → post is never called.
  4. Post exits 1 → `post_install_script_failed`; detection is not run.
  5. Pre-gate satisfied → `skipped:true` and the runner is never called.
  6. A `var_` parameter value echoed on stdout → `[redacted]`.
  7. A server-sent `install_dir` → refused.
  8. A nil runner with a script → `install_script_runner_unavailable`.
  9. `service_running` unmet on polls 1–2 and met on poll 3 → success (fast poll seam).
  10. Staging cleanup happens after post.
  11. **Fixture test**, per `testdata/builtin_scripts/*`: `executor.RenderParameterReferences` succeeds with the documented keys, and executor content validation accepts it. If a vendor script trips a pattern, change the script, never the pattern set.
- [ ] **Step 2:** `go test -race ./internal/remote/tools/ ./internal/heartbeat/ -run 'InstallScript|BuiltinScripts|SoftwareInstall|Timeouts'` → FAIL.
- [ ] **Step 3:** implement.
  - No `RunAs` (the agent service principal), `ScriptType = language`, `Timeout` clamped to 1..1800.
  - `handlers_software_install.go` passes `tools.InstallOptions{RunScript: h.executor.Execute}`.
  - Move the restore checkpoint before the pre-install script.
- [ ] **Step 4:** PASS; `cd agent && go test -race ./...` green; the repo's Go lint target green. Commit. Open PR B (`Refs #6958`). The body says: **agent release required; lab gates L1–L5 owed before any DNS key is offered.**

---

## PR C — API dispatch and data model

### Task C0: Slot check
- [ ] Run `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -5` and keep `234000` unless something newer has landed.

### Task C1: Columns and registration

**Files:** Create `apps/api/migrations/2026-12-31-234000-software-install-scripts-builtin-key.sql`. Modify:
- `apps/api/src/db/schema/software.ts`:
  - `softwareCatalog.builtinPackageKey: varchar('builtin_package_key', { length: 40 })`
  - `softwareVersions.installScriptsEnabled: boolean('install_scripts_enabled').notNull().default(false)`
- `services/tenantExportPolicyRegistry.ts:863`: `builtin_package_key` → `software_catalog.included`

Test: `services/tenantExportPolicy.test.ts`.

```sql
-- #6958. Additive DDL only; no rows written.
SELECT set_config('breeze.scope', 'system', true);
ALTER TABLE software_catalog ADD COLUMN IF NOT EXISTS builtin_package_key varchar(40);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'software_catalog_builtin_package_key_chk') THEN
    ALTER TABLE software_catalog ADD CONSTRAINT software_catalog_builtin_package_key_chk CHECK (
      builtin_package_key IS NULL OR (
        partner_id IS NOT NULL AND org_id IS NULL
        AND builtin_package_key ~ '^[a-z][a-z0-9_]{1,39}$'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS software_catalog_partner_builtin_key_uidx
  ON software_catalog (partner_id, builtin_package_key) WHERE builtin_package_key IS NOT NULL;
-- Stored-but-never-run scripts stay dormant: only a writer holding
-- devices.execute (or the built-in seeder) can enable them.
ALTER TABLE software_versions ADD COLUMN IF NOT EXISTS install_scripts_enabled boolean NOT NULL DEFAULT false;
```
- [ ] **Step 1 (red):** `tenantExportPolicy.test.ts` asserts `software_catalog.included` contains `builtin_package_key`. Then `git grep -n '"software_versions"' apps/api/src/services/tenantExportPolicyRegistry.ts`; there is no entry at plan time (no `org_id`; `orgMergeRegistry.ts:524` `follows-parent`), so `install_scripts_enabled` needs no classification. If an entry exists, classify the column `included`.
- [ ] **Step 2:** migration + schema + registry. `pnpm db:check-drift` clean; the `tenant-export-policy` and org-cascade integration suites pass on the wt-stack. Commit.

### Task C2: Agent gates

**Files:** Create `apps/api/src/services/softwareInstallAgentSupport.ts` + `.test.ts`.

**Interfaces:**
- Produces:
```ts
export const MIN_AGENT_VERSION_INSTALL_SCRIPTS: string;
export const MIN_AGENT_VERSION_SERVICE_RUNNING_RULE: string; // same value (Global Constraints)
export function agentSupportsInstallScripts(agentVersion: unknown): boolean;
export function agentSupportsServiceRunningRule(agentVersion: unknown): boolean;
export function versionNeedsInstallScriptSupport(v: { fileType: string | null; installScriptsEnabled: boolean; preInstallScript: string | null; postInstallScript: string | null }): boolean;
export function stripUnsupportedDetectionClauses(rules: unknown, agentVersion: unknown): unknown[] | undefined; // undefined = send none
export const AGENT_UPDATE_REQUIRED_INSTALL_PREFIX = 'agent_update_required';
```
- [ ] **Step 1 (red):**
  - `agentSupportsInstallScripts` is false for `undefined`, `''`, `'dev'` and MIN minus one patch; true for MIN, `MIN-rc.1` and MIN+1.
  - Strip: `[file_exists, service_running]` with an old agent → `[file_exists]`; only `service_running` → `undefined`; a new agent → unchanged.
  - `versionNeedsInstallScriptSupport` is true for `zip`, or for an enabled non-blank script; it is **false** for a script with `installScriptsEnabled:false`.
- [ ] **Step 2:** FAIL. **Step 3:** implement (`yaraScanRefs.ts:25-40` pattern). **Step 4:** PASS. Commit.

### Task C3: Script payload and dispatch

**Files:**
- Create `apps/api/src/services/installScriptPayload.ts` + `.test.ts`.
- Modify:
  - `services/installerVariables.ts`: export the token regex (:45) and the per-key resolver so both modules share one grammar; no behavior change.
  - `services/softwareDeployment.ts`:
    - version-path payload (~:1043-1073)
    - per-device variable pass (~:917-988)
    - secret scan (~:836-848)
    - the device read in `buildAndDispatchSoftwareInstalls` (:652) must select `agentVersion`
  - `services/commandDelivery.ts`: claim-time gate beside `failClaimedSecretCommandsForUnsupportedAgent`.
  - `services/commandAudit.ts`: a `software_install` branch.
  - `services/softwareDependencyIdentity.ts`.
- Tests: the existing dispatch, claim, audit and fingerprint test files (locate them with `git ls-files apps/api/src/services | grep -iE 'softwareDeployment|commandDelivery|commandAudit|softwareDependencyIdentity'`).

**Interfaces:**
- Produces:
```ts
export type InstallScriptPayload = { language: 'powershell' | 'bash'; content: string; parameters: Record<string, string>; timeoutSeconds: number };
export function scriptLanguageForOs(osType: string): 'powershell' | 'bash' | null;
export function scriptTokenToParameterKey(token: string): string; // 'var.controld_provisioning_code' → 'var_controld_provisioning_code'
export function buildInstallScriptPayload(content: string, osType: string, ctx: InstallerVariableContext):
  | { ok: true; payload: InstallScriptPayload }
  | { ok: false; unresolved: string[] };
```
- [ ] **Step 1 (red):**
  - (a) `buildInstallScriptPayload('x {{var.code}} y {{install.dir}}','windows',{vars:{code:'ab12cd'}})` → content `'x {{var_code}} y {{install_dir}}'`, parameters `{var_code:'ab12cd'}`.
  - (b) A value `'a; Remove-Item C:\\'` appears only in `parameters`.
  - (c) A missing var → `unresolved:['var.code']`.
  - (d) Two tokens mapping to one key → unresolved (collision guard).
  - (e) Dispatch with an enabled post-script and an **old** agent: that device's `deployment_results` is `failed` with `errorMessage` starting `agent_update_required`. No `device_commands` row is created for it; a new-agent device in the same deployment is dispatched.
  - (f) A new agent gets the payload `postInstallScript === buildInstallScriptPayload(...).payload`.
  - (g) A script with `installScriptsEnabled:false`: the payload has no script keys and no gate is applied (today's behavior).
  - (h) Old agent plus `exe` rules with `service_running` → dispatched with the clause stripped.
  - (i) A secret var in a script → `Software deployment templates cannot use secret variable(s) {{var.x}}`.
  - (j) An unresolved script token → the `Could not resolve installer variable(s)` prefix.
  - (k) A scripts are substituted even when `downloadUrl`/args contain no `{{` (the `:801` shortcut must not skip them).
  - (l) A version with no scripts and no zip → payload keys identical to today.
  - (m) **Claim:** a queued `software_install` with script keys, claimed while the device reports an old version → failed `agent_update_required_recorded`, not delivered.
  - (n) **Audit:** `software_install` audit carries `contentMetadata`, not the script body.
  - (o) **Fingerprint:** a version with no enabled scripts fingerprints byte-identical to before; enabling a script changes it.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. Commit.

### Task C4: Routes — validation, `devices.execute`, built-in immutability

**Files:** Modify `apps/api/src/routes/software.ts`:
- `createVersionSchema` ~:592-605
- `POST /catalog/:id/versions` :1131
- multipart upload :1208/:1288
- version PATCH :1440 (single-OS re-check)
- catalog PATCH :1016 and DELETE :1055 guards
- `GET /catalog` select :829, which returns `builtinPackageKey` and `installScriptsEnabled` per latest version

Also modify `routes/softwareUploads.ts` (:154-163, completion :744) and `routes/softwareInstallMethods.ts:113`. Tests: the matching route test files (`git ls-files apps/api/src/routes | grep -iE '^apps/api/src/routes/software(Uploads|InstallMethods)?\.test'`).

- [ ] **Step 1 (red):**
  - (a) On every create path (JSON, multipart, chunked completion), each `InstallSpecIssue` → 400 `{ error, issues }`.
  - (b) A writer with `devices.write` but not `devices.execute` gets 403 on a non-null script. The same body with no script → 201 with `installScriptsEnabled:false`. With `devices.execute` → `installScriptsEnabled:true`.
  - (c) PATCH `supportedOs` to two OSes on a script-enabled version → 400 `scripts_require_single_os`.
  - (d) A row with `builtinPackageKey` set:
    - catalog PATCH/DELETE → 403 outside system scope
    - version create/upload → 403
    - install-method create → 400
  - (e) An S1 row (NULL key) can still take a partner-uploaded version.
  - (f) `POST /catalog` with a `builtinPackageKey` in the body does not set it.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. API typecheck (12 GB, exit code). Integration: `builtinCatalogVersionsRoute.integration.test.ts` on the wt-stack. Commit. Open PR C (`Refs #6958`).

---

## PR E — compliance bridge (merges before D)

### Task E0: Slot check (as C0, for `234100`).

### Task E1: RLS fix-forward and `service_watches`

**Files:** Create `apps/api/migrations/2026-12-31-234100-software-compliance-rls-service-watches.sql`; Modify `apps/api/src/db/schema/softwarePolicies.ts`:
- `softwareComplianceStatus.serviceWatches: jsonb('service_watches').$type<Array<{ name: string }>>()`
- `SoftwarePolicyViolation.type` → `'unauthorized' | 'missing' | 'not_running' | 'service_unverified'`, with an optional `service?: { name: string; observedStatus: 'stopped' | 'not_found' | 'error' | null; observedAt: string | null }`

Also modify `__tests__/integration/rls-coverage.integration.test.ts` (remove `software_compliance_status` from `UNREVIEWED_RLS_CLASSIFICATION_DEBT` :1303 and add it to `DEVICE_ID_JOIN_POLICY_TABLES` :1030, adjusting the debt ceiling). Create `__tests__/integration/softwareComplianceStatusRls.integration.test.ts`.

```sql
-- #6958: (1) fix-forward RLS on software_compliance_status (shape 5,
-- device-join), recorded as RLS debt in rls-coverage; (2) service names the
-- compliance worker asks the agent to watch. DDL only.
SELECT set_config('breeze.scope', 'system', true);
ALTER TABLE software_compliance_status ADD COLUMN IF NOT EXISTS service_watches jsonb;
ALTER TABLE software_compliance_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_compliance_status FORCE ROW LEVEL SECURITY;
-- Four policies (select/insert/update/delete), each DROP POLICY IF EXISTS then
-- CREATE, predicate copied verbatim from an existing DEVICE_ID_JOIN_POLICY_TABLES
-- member's migration (find with: git grep -n "DEVICE_ID_JOIN" -- apps/api/src/__tests__):
--   EXISTS (SELECT 1 FROM devices d WHERE d.id = software_compliance_status.device_id
--           AND public.breeze_has_org_access(d.org_id))
```
- [ ] **Step 1 (red):** `softwareComplianceStatusRls.integration.test.ts`, with two partners, two orgs and devices in each.
  - An org-A session sees only org-A devices' rows and cannot INSERT/UPDATE a row for an org-B device.
  - A partner-scope session sees all its orgs.
  - An agent-shaped context (`scope:'organization'`, `accessibleOrgIds:[orgA]`, `currentPartnerId`) reads its own device's row.
  - System context sees all.
  - `rls-coverage` passes with the table in `DEVICE_ID_JOIN_POLICY_TABLES`.
  - Run on the wt-stack → FAIL before the migration.
- [ ] **Step 2:** sweep readers and writers: `git grep -n "softwareComplianceStatus" apps/api/src -- ':!*.test.ts'`. Each request-path reader or writer must run under `withDbAccessContext` with the device's org accessible; workers run in system context.
  - Run the existing suites: `routes/softwarePolicies.test.ts`, `services/aiToolsCompliance*.test.ts`, `services/userRiskScoring*.test.ts`, `jobs/softwareComplianceWorker.test.ts`, `jobs/softwareRemediationWorker.test.ts`, `__tests__/integration/softwarePoliciesPartnerRls.integration.test.ts`.
  - Fix any path that read the table bare. List each such path in the PR body.
- [ ] **Step 3:** apply. `pnpm db:check-drift` clean. Integration suites (`rls-coverage`, `tenant-export-policy`, org-cascade, the new file) PASS. No export classification is needed: the table has no `org_id` and no registry entry (`migrations/2026-10-16-191500-software-compliance-install-remediation.sql:26`). Commit.

### Task E2: Pure rules

**Files:** Create `apps/api/src/services/softwarePolicyServiceRules.ts` + `.test.ts`.

**Interfaces:**
- Produces:
```ts
export type ServiceObservation = { status: 'running' | 'stopped' | 'not_found' | 'error'; observedAt: Date; agentSupportsAbsence: boolean };
export const SERVICE_STATE_FRESHNESS_MS = 60 * 60 * 1000;
export const MAX_DERIVED_SERVICE_WATCHES = 50;
export function serviceNamesForOs(detectionRules: unknown, supportedOs: unknown, osType: string): string[];
export function applyServiceRules(input: {
  mode: 'allowlist' | 'blocklist' | 'audit';
  violations: SoftwarePolicyViolation[];                 // from evaluateSoftwareInventory
  rules: Array<{ name: string; catalogId?: string; vendor?: string; minVersion?: string; maxVersion?: string }>;
  inventoryMatchedRuleNames: Set<string>;
  serviceNamesByCatalogId: Map<string, string[]>;        // OS-filtered
  observations: Map<string, ServiceObservation>;         // key: watchKey('service', name)
  now: Date;
}): SoftwarePolicyViolation[];
```
- [ ] **Step 1 (red):**
  - One test per row of the D4 table (7).
  - Plus:
    - `mode:'audit'` and `'blocklist'` → violations unchanged.
    - A rule with `minVersion` and no inventory match but service `running` → `missing` is kept (AND semantics).
    - An observation older than 60 min counts as none.
    - `not_found` with `agentSupportsAbsence:false` reads as `error` → `service_unverified`.
    - A rule with no `catalogId` → unchanged.
    - `serviceNamesForOs` → `[]` when `supportedOs` excludes the OS, names when it is empty or null.
  - **Review Focus 2:** no inventory and an empty observation map → `service_unverified`, never `missing`.
- [ ] **Step 2:** FAIL. **Step 3:** implement (pure). **Step 4:** PASS. Commit.

### Task E3: Worker integration

**Files:** Modify `apps/api/src/jobs/softwareComplianceWorker.ts` (`processCheckPolicy` :558) and `services/softwarePolicyService.ts`: `upsertSoftwareComplianceStatuses` (:584) gains `serviceWatches`, and `evaluateSoftwareInventory` (:410) exposes the matched rule names, with no behavior change. Test: `jobs/softwareComplianceWorker.test.ts`.

- [ ] **Step 1 (red):**
  - For a policy whose rules carry service clauses:
    - one chunked query loads the `is_latest` versions (system context);
    - one `DISTINCT ON (device_id, lower(name))` query loads `service_process_check_results` for the chunk's devices and names within 60 min (`watch_type='service'`, newest first);
    - devices' `agentVersion` comes from the existing device load.
  - The upserted row carries `service_watches: [{name:'ctrld'}]`; `not_running` lands in `violations`.
  - Install-remediation enqueue and uninstall remediation are **not** called for `not_running` / `service_unverified`.
  - A policy with no service clauses issues neither query (query-count assertion).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. Rerun the existing `softwareComplianceWorker`, `softwarePolicyInstallRemediation` and `softwarePolicyService` tests. Commit.

### Task E4: Deliver derived watches

**Files:** Modify `apps/api/src/routes/agents/helpers.ts` (`resolveDeviceMonitoringSettings` :2728; new `resolveSoftwarePolicyServiceWatches(deviceId, opts)`); Create `routes/agents/helpers.softwareServiceWatches.test.ts`.

**Interfaces:**
- Produces: `SOFTWARE_SERVICE_WATCH_STALE_MS = 30 * 60 * 1000`; `SOFTWARE_SERVICE_ONLY_CHECK_INTERVAL_SECONDS = 300`.
- The query: `software_compliance_status` ⋈ `software_policies`, filtered by `device_id`, `p.is_active`, `last_checked > now() - 30 min` and `service_watches IS NOT NULL`. It runs in the caller's own context.
- Wire shape:
  - `watch_type: 'service'`, `name`
  - `alert_on_stop: false`, `alert_after_consecutive_failures: 2`
  - `auto_restart: evaluateSoftwarePolicyArming({ mode, enforceMode, remediationOptions }, 'install').armed`
  - `max_restart_attempts: 3`, `restart_cooldown_seconds: 300`

- [ ] **Step 1 (red):**
  - (a) A fresh row on an active armed policy → watch delivered with `auto_restart:true`.
  - (b) A row with `last_checked` 31 min ago → not delivered.
  - (c) Policy deactivated → not delivered. Policy disarmed → `auto_restart:false` (Review Focus 3).
  - (d) A monitor watch `CtrlD` (auto-restart off) plus a derived `ctrld` → one watch, the monitor's (Review Focus 4).
  - (e) Only derived watches → `check_interval_seconds === 300`, kind `resolved`.
  - (f) Monitors present → the existing interval rule applies.
  - (g) A beat policy set (`opts`) with no `software_policy` / `security_agents` link candidate → **zero** extra statements (statement counter; preserves #8142).
  - (h) 60 derived names → 50 delivered.
  - (i) No `withSystemDbAccessContext` on this path.
  - (j) `resolveMonitoringConfigForDisplay` includes derived watches (intended: the device monitoring tab shows the client's service).
- [ ] **Step 2:** `npx vitest run src/routes/agents/helpers.softwareServiceWatches.test.ts src/routes/agents/helpers.monitorWatchDelivery.test.ts` → FAIL.
- [ ] **Step 3:** implement. The existing 120 s monitoring cache covers the result. A cached entry may carry `auto_restart:true` up to 120 s after a disarm, and that bound is accepted and documented in a code comment.
- [ ] **Step 4:** PASS; rerun `helpers.partnerWidePolicies.test.ts`. Typecheck. Commit. Open PR E (`Refs #6958`, `Refs #6960`).

---

## PR D — built-ins and web (merges last)

### Task D1: Pinned definitions, ensure and refresh

**Files:** Modify `apps/api/src/services/builtinDeploymentPackages.ts` (the existing `BuiltinProvider` / `BUILTIN_PACKAGES` / `ensureBuiltinPackage` are untouched); Tests `services/builtinDeploymentPackages.test.ts`, `__tests__/integration/builtinDeploymentPackages.integration.test.ts`, `__tests__/integration/builtinCatalogRls.integration.test.ts`.

**Interfaces:**
- Produces:
```ts
export type BuiltinPackageKey = 'controld_windows' | 'controld_macos' | 'nextdns_windows';
export type TenantVarVendorKey = 'controld' | 'nextdns';
export interface PinnedBuiltinPackageDef {
  key: BuiltinPackageKey; vendorKey: TenantVarVendorKey; name: string; vendor: string;
  category: 'security'; websiteUrl: string; os: 'windows' | 'macos'; hidden: boolean;
  version: string; downloadUrl: string; checksum: string; fileType: 'zip' | 'pkg'; originalFileName: string;
  preInstallScript: string | null; postInstallScript: string | null;
  detectionRules: DetectionRule[]; requiredVars: readonly string[]; uninstallCommand: string;
}
export const BUILTIN_TENANT_VAR_PACKAGES: Readonly<Record<BuiltinPackageKey, PinnedBuiltinPackageDef>>;
export function builtinPackageKeysForVendor(vendor: TenantVarVendorKey): Partial<Record<'windows' | 'macos', BuiltinPackageKey>>;
export function serviceRunningNamesFor(key: BuiltinPackageKey): string[];
export async function ensurePinnedBuiltinPackage(p: { key: BuiltinPackageKey; partnerId: string }): Promise<{ catalogId: string; versionId: string }>;
export async function refreshPinnedBuiltinPackages(): Promise<{ refreshed: number }>;
```

**Values**

| Key | Name | Vendor | `websiteUrl` | `requiredVars` | `hidden` |
|---|---|---|---|---|---|
| `controld_windows` | `Control D (Windows)` | `Control D` | `https://controld.com` | `['controld_provisioning_code']` | `false` |
| `controld_macos` | `Control D (macOS)` | `Control D` | `https://controld.com` | `['controld_provisioning_code']` | `true` until L2 passes |
| `nextdns_windows` | `NextDNS CLI (Windows)` | `NextDNS` | `https://nextdns.io` | `['nextdns_profile_id']` | `false` |

Pins, sha256 values, detection rules and `uninstallCommand` come from D2 and D5. No def sets `silentInstallArgs`.

**Scripts** (exact; the B3 fixtures are byte copies):

`controld_windows` post-install (PowerShell):
```powershell
$ErrorActionPreference = 'Stop'
$src = Get-ChildItem -Path {{install.dir}} -Recurse -Filter 'ctrld.exe' | Select-Object -First 1
if (-not $src) { Write-Error 'ctrld.exe not found in package'; exit 2 }
New-Item -ItemType Directory -Force -Path 'C:\ControlD' | Out-Null
Copy-Item -Force -Path $src.FullName -Destination 'C:\ControlD\ctrld.exe'
& 'C:\ControlD\ctrld.exe' start --cd-org {{var.controld_provisioning_code}}
exit $LASTEXITCODE
```
`controld_macos` pre-install (bash; L2):
```bash
#!/bin/bash
set -euo pipefail
DOMAIN='/Library/Managed Preferences/com.controld.ctrld'
[ -f /Library/LaunchDaemons/ctrld.plist ] && exit 0            # upgrade path keeps identity
if [ -e "$DOMAIN.plist" ] && [ "$(/usr/bin/defaults read "$DOMAIN" BreezeWritten 2>/dev/null)" != "1" ]; then
  exit 0                                                         # MDM-delivered: never overwrite
fi
mkdir -p '/Library/Managed Preferences'
/usr/bin/defaults write "$DOMAIN" ProvisionToken {{var.controld_provisioning_code}}
/usr/bin/defaults write "$DOMAIN" BreezeWritten -bool true
chmod 600 "$DOMAIN.plist"
```
`controld_macos` post-install (bash):
```bash
#!/bin/bash
set -uo pipefail
DOMAIN='/Library/Managed Preferences/com.controld.ctrld'
if [ "$(/usr/bin/defaults read "$DOMAIN" BreezeWritten 2>/dev/null)" = "1" ]; then rm -f "$DOMAIN.plist"; fi
exit 0
```
`nextdns_windows` post-install (PowerShell; `install` self-copies to `C:\Program Files\nextdns\`):
```powershell
$ErrorActionPreference = 'Stop'
& (Join-Path {{install.dir}} 'nextdns.exe') install -profile {{var.nextdns_profile_id}} -report-client-info -auto-activate
exit $LASTEXITCODE
```
- [ ] **Step 1 (red), unit:**
  - Every def passes `detectionRulesSchema` and `validateSoftwareVersionInstallSpec(...) → []`.
  - `checksum` matches `/^[a-f0-9]{64}$/`.
  - `downloadUrl` starts with `https://github.com/` and contains `/releases/download/v<version>/`.
  - `serviceRunningNamesFor('nextdns_windows')` → `['nextdns']`.
  - `builtinPackageKeysForVendor('controld')` → `{windows:'controld_windows', macos:'controld_macos'}`.
  - Each script equals its `agent/internal/remote/tools/testdata/builtin_scripts/*` file (`readFileSync` from the repo root).
  - **Review Focus 5:** the macOS pre-script contains the `BreezeWritten` guard, the marker write and `chmod 600`; the post-script deletes only behind the marker.
- [ ] **Step 2 (red), integration** (wt-stack):
  - `ensurePinnedBuiltinPackage` is idempotent: one catalog row plus one version with `is_latest`, `checksum`, `detection_rules`, `post_install_script` and `install_scripts_enabled = true`.
  - It un-archives a soft-deleted row.
  - `Promise.all` ×5 → one row.
  - `refreshPinnedBuiltinPackages`:
    - with an overridden newer pin → a new latest version, the old row kept;
    - with an **older** pin → no change (no downgrade);
    - archived rows skipped.
  - `builtinCatalogRls`:
    - An org-scope session cannot INSERT a row with `builtin_package_key`.
    - Partner scope reads its own DNS built-ins.
    - Org-scope read of their **versions is denied**. This pins the D1 gap so a later RLS change flips the test deliberately.
- [ ] **Step 3:** implement under `runOutsideDbContext(() => withSystemDbAccessContext(...))`. Insert with `ON CONFLICT (partner_id, builtin_package_key) WHERE builtin_package_key IS NOT NULL DO NOTHING`, then re-select. Refresh runs per row in a transaction with `SELECT … FOR UPDATE`.
- [ ] **Step 4:** PASS. Commit.

### Task D2: Routes and boot refresh

**Files:** Create `apps/api/src/routes/softwareBuiltinPackages.ts` + `.test.ts`. Modify:
- `apps/api/src/index.ts`: mount at `/software/builtin-packages`, and add `void runStartupTaskWithRetry('pinned built-in package refresh', () => refreshPinnedBuiltinPackages(), …)` beside :2017.
- `services/mcpCoverage.ts`: `'softwareBuiltinPackages.ts': { exempt: 'MSP catalog provisioning of executable packages is an operator action; no AI surface by design' }`.
- `__tests__/partner-wide-write-coverage.test.ts`: an entry for the POST.

**Interfaces:**
- `GET /software/builtin-packages` (partner/system scope, `devices.read`) → `{ data: Array<{ key, name, vendor, os, version, requiredVars, uninstallCommand, catalogId: string | null, archived: boolean }> }`; `hidden` defs are omitted.
- `POST /software/builtin-packages/:key` (partner/system scope; `devices.write` + `devices.execute` + MFA + `canManagePartnerWidePolicies`) → `201 { catalogId, versionId }`.
  - Unknown or hidden key → 404.
  - Org scope → 403.
  - Missing `devices.execute` → 403.
  - The partner is always `auth.partnerId`; a body cannot choose it.
- [ ] **Step 1 (red):** the status codes above; `mcp-coverage.test.ts` and `partner-wide-write-coverage.test.ts` pass with the new entries.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. Commit.

### Task D3: Web

**Files:** Create `apps/web/src/components/software/BuiltinPackagesPanel.tsx` + test. Modify:
- `SoftwareCatalog.tsx`: the panel for partner scope, plus a "Built-in" badge when `builtinPackageKey` is set.
- `DetectionRulesEditor.tsx`: a `service_running` option with a `serviceName` input.
- `SoftwareVersionManager.tsx`: an "inactive stored script" notice when a script exists and `installScriptsEnabled` is false.
- 8 locale files.

- [ ] **Step 1 (red):**
  - The panel lists the visible keys.
  - "Add to catalog" uses `runAction` → `POST /software/builtin-packages/controld_windows`, then refreshes. A 401 is silent.
  - `requiredVars` and `uninstallCommand` render.
  - `DetectionRulesEditor` round-trips `{type:'service_running', serviceName:'ctrld'}`.
  - The inactive-script notice renders.
  - `localeParity.test.ts` and `no-silent-mutations.test.ts` pass.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS; web typecheck exit 0. Commit. Open PR D (`Refs #6958`, `Refs #6960`, `Refs #8734`).

---

## Lab gates (owner-run; they block offering the DNS keys to MSPs, not merging)

**Setup:** clean VMs; an agent at or above `MIN_AGENT_VERSION_INSTALL_SCRIPTS` (released or `make dev-push`); a scratch Control D sub-org provisioning code (limit 1, short expiry); a scratch NextDNS profile. Record results in PR D.

| Gate | Steps | Pass |
|---|---|---|
| **L1** Control D Windows | 1. Provision `controld_windows` and deploy to Windows 11 with an armed policy.<br>2. Stop service `ctrld`; wait one compliance cycle. | **After deploy:** `completed`; `C:\ControlD\ctrld.exe` exists; `ctrld` running; the endpoint appears in Control D under the device hostname.<br>**After the stop:** the agent watch restarts the service and the next pass is compliant.<br>**With the policy disarmed:** a `not_running` violation |
| **L2** Control D macOS | Same steps on macOS 15, unmanaged | The pkg postinstall consumes the Breeze-written prefs; `/Library/LaunchDaemons/ctrld.plist` exists; the prefs file is gone afterwards; `launchctl print system/ctrld` shows it running. **On fail,** `controld_macos` stays `hidden:true` and W5 keeps macOS `unsupported` |
| **L3** NextDNS Windows | Provision `nextdns_windows` and deploy | Service `nextdns` running; `C:\Program Files\nextdns\nextdns.exe` exists; queries visible in the profile log |
| **L4** Old agent | Deploy a DNS key to an agent below MIN | Result `agent_update_required`; no `device_commands` row |
| **L5** Secret var | Mark the provisioning-code variable secret on a test org; deploy | The device fails with the secret-variable message; nothing is dispatched |

## Exit checklist (each PR, and all before #6960 W5 starts)

- [ ] Red-first in every task: each test was seen failing before the code, and now passes. Paste counts from real output into each PR body.
- [ ] B: `cd agent && go test -race ./...` green. API/shared/web typechecks exit 0 (12 GB heap, exit code read).
- [ ] C, D, E integration suites on a wt-stack, torn down afterwards: `tenant-export-policy`, org-cascade, `rls-coverage`, `softwareComplianceStatusRls`, `builtinDeploymentPackages`, `builtinCatalogRls`, `builtinCatalogVersionsRoute`, `softwarePoliciesPartnerRls`.
- [ ] `scripts/check-migration-naming.sh` passes; `pnpm db:check-drift` clean.
- [ ] `MIN_AGENT_VERSION_*` equals the agent release that contains PR B (re-checked at release cut).
- [ ] Release notes:
  - The new `zip` file type and install scripts need an agent update.
  - Stored pre-existing scripts stay inactive until re-created.
  - `software_compliance_status` now has RLS.
  - Derived service watches appear in device monitoring tabs.
- [ ] Lab gates L1–L5 recorded. #6960 W5 is unblocked.

## Deferred / follow-ups (file as issues when the PRs open)

- Catalog-driven uninstall: Breeze cannot remove zip-installed clients today.
- NextDNS macOS: needs `tar.gz` support and architecture selection.
- Upgrades for already-installed devices. New pins reach only new installs, because the pre-gate detects the old install. Vendors self-update (`ctrld upgrade`).
- Org-scope read of partner-wide `software_versions` (pre-existing RLS gap, pinned by a D1 test).
- Backfill `builtin_package_key` for Huntress/S1, so "built-in" has a single discriminator.
- Software-compliance alerting on `not_running`: #6960 W3, per spec §2.6.
- Secret tenant variables for install scripts via the executor `SecretEnv` (#3409 PR4b precedent).

## Decisions for Todd (defaults chosen; the plan proceeds on the default)

1. **macOS Control D via Breeze-written managed preferences** relies on vendor behavior that is not documented. **Default:** the key ships `hidden` until L2 passes. **Alternative:** drop macOS from v1 entirely.
2. **Auto-restart of a stopped DNS client when the policy is armed.** **Default:** on, re-derived from the live policy on every resolution. **Alternative:** report-only until #6960 W3 alerting lands.
3. **Alerting deferred to #6960 W3.** **Default:** defer. **Alternative:** add a `software-policy-service` alert bridge here, which costs one more migration (the built-in alert index).
4. **RLS fix-forward on `software_compliance_status` lands inside PR E.** **Default:** yes. It is required before an agent-read surface rests on the table. **Alternative:** a standalone PR first, which is the same work in a different order.

## Self-review

- **Spec coverage.**
  - Gap 1 → B3, C3, C4.
  - Gap 2 → scripts (B3), the macOS pkg pre-script (D1), and the args rejection (A2).
  - Gap 3 → A1 and B1 at install time; E1–E4 for the periodic bridge (Decision 9).
  - Gap 4 → C1, D1–D3.
  - Spec §2.5 (secrets) → C3(i), L5. §2.6 → the D5 contract plus E. The §3 rows for #6958 are all mapped.
  - Out-of-scope items are honored.
- **Type consistency.** `serviceName` (A1/B1/D1); `InstallScriptPayload` (C3 ↔ the B3 payload); `installScriptsEnabled` (C1/C2/C3/C4/D1/D3); `BuiltinPackageKey` and `serviceRunningNamesFor` (D1 ↔ W5); `ServiceObservation` (E2/E3).
- **Review Focus.** Each of the five lines has a named test: C3(m), E2, E4(c), E4(d), D1 step 1.
- **Proportion.** Code blocks are limited to vendor scripts that must be byte-exact, migrations and assertions. Function bodies are left to the implementer.

## Quorum

- **Own position first, then independent `codex exec`** (gpt-6-astra, `xhigh`, read-only) on D1–D5. Every cited file was re-read before acting. A separate Explore pass verified ~150 cited paths/symbols on `origin/main`; 3 path/line misses were corrected.
- **Outcome:** D1, D2, D3 and D5 agree-with-changes; D4 disagree-as-written, resolved on the merits. Every finding is folded in and code-confirmed.
- **D1 changes:**
  - Built-in immutability extended to `builtin_package_key` rows (`routes/software.ts:1016,1055`, `softwareInstallMethods.ts:113`).
  - The provisioning route requires `devices.execute`.
  - Refresh runs under a row lock and only moves forward.
- **D2 changes:**
  - The NextDNS install path corrected to `C:\Program Files\nextdns\nextdns.exe` (`host/service/windows/service.go@v1.47.3`), and the post-script simplified because `install` self-copies.
  - The macOS pre-script preserves MDM-delivered prefs and covers the failure path with a marker.
  - Per-format args made explicit (`args_unsupported_for_file_type`).
  - Staging cleanup moved after the post-script.
- **D3 changes:**
  - Dormant stored scripts stay dormant (`install_scripts_enabled`).
  - Validation on every create path, plus the PATCH single-OS re-check.
  - The claim-time gate (`scriptSecretDelivery.ts` precedent).
  - The script audit branch and fingerprint inclusion.
  - The timeout budget raised (55 → 75 min).
- **D4 changes:**
  - No inventory plus no or stale telemetry → `service_unverified`, not `missing`.
  - An old agent's `not_found` is treated as `error`, and B fixes macOS/Linux absence reporting (`service_darwin.go:12`, `service_linux.go:31`).
  - Allowlist-only, with AND/version constraints preserved.
  - Restart authority re-derived from the live policy; the watch cap and statement-free path kept.
  - **RLS fix-forward on `software_compliance_status`** (it is RLS debt).
- **D5 changes:** W5 needs per-platform catalog references and applicability filtering for the new violation types (recorded in the D5 contract).
- **Codex factual corrections, accepted:**
  - `is_latest` limits automatic selection only, not manual deploys.
  - An earlier false clause short-circuits before an unknown clause is evaluated.
- **Unresolved disagreements:** none. Four product defaults are listed under Decisions for Todd.

---
tracking_issue: LanternOps/breeze#6754
wave: W12 (#6782)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
triage: docs/superpowers/plans/ai-mcp/2026-09-23-ai-full-control-w05-gap-triage.md
depends_on: W11 (#6781, PR #10286) and W19 (#10087) merged to main
branch: feature/6754-ai-full-control/wave-6782
---
# AI full control W12: software catalog, deployments, device software, inventory, fleet findings, custom fields — class review and plan

**Goal:** give chat and MCP the capabilities the W05 triage tagged `W12` (rows #47, #56, #57, #89, #126, #127, #128, plus the two #6141 items on `tools` modules: fleet-finding lifecycle and custom-field writes) as nine new tools, each with a class that survives the spec's class review **before** it is reachable (spec D2). Paths are under `apps/api/src/`.

**Verified against** `origin/main` `214621318e` (2026-10-27; W11 #10286 merged, `KNOWN_MISSING_TOOL_TIERS` gone, `FIXTURE_W03_W04` empty).

## Premises

| # | Check | Result |
|---|---|---|
| 0.1 | #10286 merged and on `origin/main`; `KNOWN_MISSING_TOOL_TIERS` absent | yes (comments only) |
| 0.2 | none of the nine names in registry / `TOOL_TIERS` / `HUMAN_ONLY_TOOLS`; every route module exists | yes / yes (`software.ts`, `softwareInstallMethods.ts`, `softwareInventory.ts`, `packageSearch.ts`, `devices/{software,softwareActions,homebrewBootstrap}.ts`, `fleetFindings.ts`, `customFields.ts`, `devices/customFieldValues.ts`) |
| 0.3 | no `wave-6782` branch or PR | yes |
| 0.4 | #6782 and #6754 open | yes |

## Facts the triage did not have

1. **The "latest" version and the enabled install method are live inputs to unattended installs.** `softwarePolicyInstallRemediation.ts` (`resolvePolicyInstallTarget`, ~L140-180) resolves an armed auto-install policy's target to the catalog item's **enabled install method for the device's platform**, else its `is_latest` version; `automationReferenceAuthorization.ts` (~L170-195) resolves an automation's deploy step to the `is_latest` version; manager deployments with `versionMode: 'latest'` install the current package. So **adding a version (it is auto-promoted, `insertLatestSoftwareVersion`), editing a version's URL / install args / detection, promoting a version, and adding / editing / deleting an install method all change what is installed on customer machines without any further approval.** The triage's "catalog edits t2" holds only for catalog metadata (name, vendor, category, description, icon, website) and for creating a new item (inert until something references it).
2. **Catalog ownership.** `software_catalog` is `org_id` XOR `partner_id` (`software_catalog_one_owner_chk`); built-ins (`builtin_package_key`) and integration rows are immutable outside system scope. Partner-wide create and every write to a partner-wide row need `canManagePartnerWidePolicies` (`routes/software.ts` `authorizeCatalogItemWrite`, POST `/catalog`). `DELETE /catalog/:id` archives (`deleted_at`) when anything references the item, else hard-deletes S3 objects, versions and the row; **there is no restore route**. Catalog rows have no `created_by`.
3. **download-url** returns a presigned S3 URL valid for one hour (a bearer capability to the installer) or the stored raw URL, under `devices:read`, no MFA, no audit.
4. **Deployments.** POST `/deployments` (devices:execute + MFA, self-managed DB context #7347) resolves `targetType` devices / groups / filter / all (`sites` errors) through `resolveSoftwareTargetDeviceIds` with a per-device `canAccessSite` filter, then either `createSoftwareDeployment` (a version) or the private `createManagerDeployments` (a catalog item's winget/Homebrew methods, one deployment per platform). Only `install` is supported; immediate installs dispatch `software_install` and the push runs **after commit** (`commitThenDeliver`). `software_deployments.created_by` is a nullable `users` FK. POST `/deploy` is the deprecated install-only twin (audited `deprecated: true`). Cancel flips **pending** result rows to `cancelled` and purges still-queued commands (in-flight ones run to completion); retry re-dispatches **failed** rows (fingerprint-checked) after commit. All the orchestration is module-private in `routes/software.ts`.
5. **Inventory approve / deny / clear** (`softwareInventory.ts`, devices:write + MFA + `canMutateOrgWideGovernance`) find-or-create the org's `Default Allowlist` / `Default Blocklist` `software_policies` row (`org_id` only, `enforce_mode: false` on create, `created_by` = user) and auto-link it to a `Default … Config` configuration policy assigned at org level (`created_by`, `assigned_by` = user). They **append to an existing default policy whatever its `enforce_mode` / remediation options**: deny into an enforcing blocklist, or clear out of an enforcing allowlist, makes the software a violation that auto-uninstall acts on. Clear removes the entry from both default policies. No partner-wide row is ever written (REST).
6. **Device software.** GET `/devices/:id/software` (devices:read) pages `software_inventory` with a best-effort third-party-update annotation. POST `…/software/update` and `…/software/uninstall` (devices:execute + MFA, site check, not decommissioned) queue `software_update` / `software_uninstall`; uninstall has no undo and no dry run. POST `…/homebrew-bootstrap` (devices:execute + MFA, macOS only) queues `homebrew_bootstrap` with a pinned installer URL + SHA-256; the agent runs it as the signed-in admin console user (20 min), idempotent, no uninstall path.
7. **Package search** (`packageSearch.ts`, devices:read): winget is a local ILIKE over `winget_package_index`; Homebrew is a constant-URL fetch of formulae.brew.sh, Redis-cached 6 h. No SSRF surface (the caller only supplies `q`).
8. **Fleet findings.** `PATCH /fleet-findings/:id` (devices:write + MFA) is `applyFleetFindingLifecycle` (exported): acknowledge (open→acknowledged), dismiss (open/acknowledged→dismissed), reopen (back to open). It locks the finding and refuses a caller who cannot see every member device. `acknowledged_by` / `dismissed_by` are nullable `users` FKs. The cron's reconciler resolves cleared findings. `get_fleet_findings` (t1) already reads.
9. **Custom fields.** Definitions (`customFields.ts`, devices:write + MFA + `canMutateOrgWideGovernance`) are `org_id` XOR `partner_id`; a partner-wide create/edit needs `canManagePartnerWidePolicies`. **DELETE hard-deletes the definition and cascades every device's value** (`device_custom_field_values.definition_id ON DELETE CASCADE`). Values are written by `PATCH /devices/:id/custom-fields` (`devices/customFieldValues.ts`, devices:write + MFA, device site check, all-or-nothing `validateCustomFieldMap`, awaited `createAuditLog` with keys only). **Values are an execution sink and a targeting control**: `installerVariables.ts` substitutes `{{device.customField.x}}` into installer command lines, and `filterEngine`'s `custom.<key>` selects dynamic-group members and deployment targets — and dynamic-group membership feeds an agent's run scope (`triggers.deviceGroupIds`), the same path that made `manage_tags:add/remove` agent-human-only (W02-D2).

## Tools and per-action class review

Q1 reversible within a minute? Q2 leaves the tenant / reaches a person / touches a customer machine? Q3 blast radius? Q4 can an agent grant itself authority? t1 = `TIER1_READ_ACTIONS`; t2 = the user approves unless `auto_approve`; sup = tier-3 supervised. **No W12 surface is four-eyes.**

| Tool / action | Q1 | Q2 | Q3 | Q4 | Triage | **W12** | Route twin / floor |
|---|---|---|---|---|---|---|---|
| `manage_software_catalog:list` / `get` (item + versions + install methods) | read | none | org + own partner's rows | no | read | **t1** | GET `/software/catalog`, `/catalog/:id`, `/catalog/:id/versions`, `/catalog/:id/install-methods`, devices:read |
| `…:create` / `import_package` | yes (archive) | none: a new item is inert until a deployment, automation or policy references it | one org, or the partner (`ownerScope: 'partner'`, gated; create only) | no | t2 | **t2**; `create` with `ownerScope: 'partner'` **sup** (input-aware, QW1) | POST `/catalog`, `/catalog/import-package`, devices:write + MFA |
| `…:update` (name, vendor, category, description, iconUrl, websiteUrl, isManaged) | yes | none | one org item (partner-wide rows refused, W12-D10) | no | t2 | **t2** | PATCH `/catalog/:id`, devices:write + MFA |
| `…:add_version` / `update_version` / `promote_version` | yes (promote the old one) | **device, indirect** (fact 1: armed auto-install policies, automations and `latest` deployments install it unattended) | one org item (partner-wide refused, W12-D10) | no | t2 / promote sup | **sup** (escalated, fact 1) | POST `/catalog/:id/versions`, PATCH `…/versions/:versionId`, POST `…/promote`, devices:write + MFA |
| `…:add_install_method` / `update_install_method` / `delete_install_method` | yes | **device, indirect** (fact 1: auto-install prefers the enabled method) | one org item (partner-wide refused) | no | t2 | **sup** (escalated, fact 1) | POST / PATCH / DELETE `/catalog/:id/install-methods[/:methodId]`, devices:write + MFA |
| `…:archive` | **no** (no restore route; hard delete when unreferenced) | stops new deploys and auto-installs of the item | one org item (partner-wide refused in the tool) | no | t2 | **sup** (escalated: irreversible) | DELETE `/catalog/:id`, devices:write + MFA |
| `search_packages` | read | none (constant upstream) | none | no | read | **t1** | GET `/software/package-search`, devices:read |
| `manage_software_deployments:list` / `get` / `summary` / `results` | read | none | org, site-filtered | no | read | **t1** | GET `/deployments[/summary|/:id|/:id/results]`, devices:read |
| `…:create` | no (installs run) | **device**: `software_install` on every target | ≤ 100 named devices of one org; groups, `all`, `filter` absent (QW3) | no | sup | **sup**; the version / install-method fingerprint is pinned by an effect digest (QW3) | POST `/deployments`, devices:execute + MFA |
| `…:cancel` | n/a (stops pending installs; retry/create redo them) | reduces device effect | one deployment | no | t2 | **t2** | POST `/deployments/:id/cancel`, devices:execute + MFA |
| `…:retry` | no | **device**: re-dispatches failed installs | one deployment's failed rows (site-filtered) | no | sup | **sup** | POST `/deployments/:id/retry`, devices:execute + MFA |
| `get_device_software` | read | none | one device | no | read | **t1** | GET `/devices/:id/software`, devices:read |
| `manage_device_software:update` | no (upgrade) | **device** `software_update` | one device | no | sup | **sup** | POST `/devices/:id/software/update`, devices:execute + MFA |
| `…:uninstall` | **no** | **device** `software_uninstall` | one device | no | sup | **sup**; agent-human-only | POST `/devices/:id/software/uninstall`, devices:execute + MFA |
| `bootstrap_homebrew` | no (no uninstall path) | **device**: runs the pinned Homebrew installer as the console admin | one Mac | no | sup | **sup**; agent-human-only | POST `/devices/:id/homebrew-bootstrap`, devices:execute + MFA |
| `manage_software_inventory:list` / `names` / `devices` | read | none | org, site-filtered | no | read | **t1** | GET `/software-inventory`, `/names`, `/:name/devices`, devices:read |
| `…:approve` | yes (clear) | **device, indirect**: org-assigned allowlist; with an enforcing default allowlist it narrows auto-uninstall | one org | no | sup | **sup** | POST `/software-inventory/approve`, devices:write + MFA |
| `…:deny` / `clear` | yes (clear / approve) | **device, indirect** (fact 5: into an enforcing blocklist, or out of an enforcing allowlist, it triggers auto-uninstall) | one org | no | t2 (triage "sup (writes policy)" covered approve only) | **sup** (escalated, fact 5) | POST `/software-inventory/deny`, `/clear`, devices:write + MFA |
| `manage_fleet_findings:acknowledge` / `dismiss` / `reopen` | yes (reopen) | none | one finding (all member devices visible) | no | t2 | **t2** | PATCH `/fleet-findings/:id`, devices:write + MFA |
| `manage_custom_fields:create_definition` / `update_definition` | yes | none directly | one org; create may be partner-wide (gated); an existing partner-wide row is refused (W12-D10) | no (agent-human-only tool) | t2 | **t2**; partner-wide create **sup** (input-aware, QW1) | POST / PATCH `/custom-fields[/:id]`, devices:write + MFA |
| `…:delete_definition` | **no** (cascades every device's value) | changes dynamic-group membership and installer arguments that use the field | one org (partner-wide refused) | **yes** (run-scope feed, fact 9) | t2 | **sup** (escalated: irreversible) | DELETE `/custom-fields/:id`, devices:write + MFA |
| `…:set_values` | yes (the tool returns the previous values) | installer-argument sink, deployment targeting | one device | **yes** (run-scope feed, fact 9) | t2 | **sup** (escalated, QW1) | PATCH `/devices/:id/custom-fields`, devices:write + MFA |

**Not built (recorded):** `download-url` (fact 3: a bearer URL in a chat transcript is a credential leak with no workflow that needs it); version **upload** (a browser file transfer); version `preInstallScript` / `postInstallScript` (scripts that run as SYSTEM/root — absent from the tool schemas, so the route's conditional `devices:execute` gate never applies); the deprecated POST `/deploy` (POST `/deployments` covers it); deployment `targetType` `all` / `filter` / `sites` (unbounded or unreviewable target sets; `sites` errors in REST); `uninstall` / `update` deployment types (REST rejects them); `download-policy` GET/PUT (the managed-software egress allowlist: human-only network policy); fleet-finding `remediate` (not in the triage row; script/command fan-out to up to 5,000 devices).

### Agent (headless) exposure (spec D4)

| Tool | Exposure |
|---|---|
| every t1 read above | **reachable; skip the allowlist.** Device-scoped reads use `deviceArgs`; org lists apply the site and exact-device axes. |
| `manage_software_catalog` writes, `manage_software_deployments` create/cancel/retry, `manage_software_inventory` writes, `manage_fleet_findings`, `manage_device_software:update` | **reachable as proposals** (t2 via the `agentTier2` lane, sup as tier-3 intents), released under the **agent's own auth** so its site / device ceiling holds. Org-wide config writes (catalog, inventory policy) refuse a site- or device-restricted session (`canMutateOrgWideGovernance`). |
| `bootstrap_homebrew` | **`AGENT_HUMAN_ONLY_TOOLS`** — an explicit, conservative D4 exception (QW6: irreversibility alone is not self-granted authority): it installs a package manager as the console admin with no uninstall path, and no autonomous workflow needs it. |
| `manage_device_software:uninstall` | **`AGENT_HUMAN_ONLY_ACTIONS`** — an explicit, conservative D4 exception (QW6): irreversible removal on a customer machine. |
| `manage_custom_fields` | **`AGENT_HUMAN_ONLY_TOOLS`** (QW6): values select dynamic-group members, which feed an agent's run scope (`triggers.deviceGroupIds`) — the W02-D2 `manage_tags` precedent; definition edits (`scriptWrite`, `deviceTypes`, validation) decide which value writes are admitted. |

## Decisions

- **W12-D1 one PR, nine tools.** The route orchestration the tools need moves **verbatim** out of `routes/software.ts` and `routes/softwareInventory.ts` into services the route and the tool share (`services/softwareDeploymentOps.ts`: target resolution, manager deployments, status map, cancel, retry re-dispatch; `services/softwareInventoryPolicy.ts`: approve / deny / clear). Hono-context coupling is replaced by plain parameters (auth, permissions, an audit callback); the route tests pass unchanged. Device-software, Homebrew, fleet-finding and custom-field tools call the existing exported helpers (`queueCommandForExecution`, `homebrewBootstrapPayload`, `applyFleetFindingLifecycle`, `validateCustomFieldMap`, `persistDeviceCustomFieldValues`).
- **W12-D2 install-target edits are supervised** (fact 1). Supervised, not four-eyes: each is reversible by another edit, and no new device is targeted by the edit itself.
- **W12-D3 users-FK writes record a verified user or NULL.** `software_deployments.created_by`, `software_policies.created_by`, `configuration_policies.created_by`, `config_policy_assignments.assigned_by`, `fleet_findings.acknowledged_by` / `dismissed_by` are nullable `users` FKs. The tools write the caller's id only when it is a `users` row (`verifiedUserIdOrNull`, the `resolveCommandCreatedBy` pattern), else NULL; the audit row carries the AI actor. So no W12 action joins `USER_OWNED_RELEASE_ACTIONS`: an approved agent proposal releases under the agent's own auth and keeps the run's ceiling (the W11 QW5 concern), and no release can 23503.
- **W12-D4 stricter than REST where REST is org-wide.** Catalog writes, inventory policy writes and custom-field definition writes refuse site- or device-restricted sessions (`canMutateOrgWideGovernance`; REST already does for inventory and custom fields). The catalog `archive` refuses a partner-wide item (do it in the web app). Deployment create checks every target device against the caller's site and exact-device axes.
- **W12-D5 MFA parity.** Every W12 write's REST twin carries `requireMfa()`, so each is in `MFA_GATED_TOOL_ACTIONS` and the handler calls `mfaGatedToolError` (agents exempt by design; MCP API keys refused while `ENABLE_2FA` is on).
- **W12-D6 rate limits.** Device-reaching tools (`manage_device_software`, `bootstrap_homebrew`, `manage_software_deployments`) 10/300 s; the rest 20–40/300 s.
- **W12-D7 MCP surface (Todd signs off in the PR).** Every tool is new; nothing is lost. Supervised actions are denied over MCP by default (`MCP_APPROVAL_REQUIRED`) like every tier-3 action. **No loosening:** no existing class moves.
- **W12-D8 fencing.** Every free-text field a tool returns (package names, vendors, versions, hostnames, finding titles, custom-field names and values, release notes) is listed in `RAW_TEXT_FIELDS_BY_TOOL`.
- **W12-D10 the tool never modifies an existing partner-wide row (quorum QW1).** Catalog items and custom-field definitions may be CREATED partner-wide (supervised, `canManagePartnerWidePolicies`); every edit, version / install-method change, archive or delete of an existing partner-wide row is refused ("do it in the web app"). So no W12 surface needs four-eyes or an asserted-owner arm.
- **W12-D11 catalog guarantees stronger than REST (QW2, QW5).** Every version and install-method write goes through `authorizeCatalogItemWrite` (REST's install-method routes accept a visible NULL-org parent without the partner-wide gate) and refuses built-in and integration items; `update_version` refuses a version that carries a pre/post-install script (REST requires `devices:execute` there). Catalog reads return an explicit projection: a version's download URL is reduced to its host, and S3 keys and scripts are never returned (a stored URL can itself be presigned).
- **W12-D12 deployment pin and device axis (QW3, QW7).** `manage_software_deployments:create` has an `EFFECT_DIGEST_RESOLVERS` entry over the same dependency fingerprint retry checks (`fingerprintSoftwareVersionDependency` / the enabled install methods' fingerprints), so a version or method edited between approval and release refuses the release. A session bound to exact devices cannot list or summarise deployments (org-wide aggregates) and can read, cancel or retry one only when every device in it is in its allowlist. `maintenanceWindowId` must belong to the deployment's org.
- **W12-D13 inventory writes (QW4, QW7).** `software_policy_audit.actor_id` also takes the verified-user-or-NULL id; the default policy row is locked `FOR UPDATE` across the read-modify-write of its rules; the tool refuses (409) when the org's same-named default configuration policy carries other feature links, rather than adopting and assigning it. Wording: approve/deny keep any opposite-list entry; clear removes from both lists, so they are not exact inverses (QW8).
- **W12-D9 inventory approve stays org-axis (REST parity).** The brief asked for partner-wide-first like W04's `manage_software_policy`. Approve/deny/clear maintain the org's REST-managed `Default Allowlist` / `Default Blocklist`; they never write a partner-wide row, so `canManagePartnerWidePolicies` has nothing to gate. Partner-wide allowlists stay with `manage_software_policy` (W04), which is partner-wide-first.

### Existing entries, and whether they change

| Map | W12 |
|---|---|
| `TOOL_TIERS` (block after W11) | + 9 (registry tiers: reads 1; `manage_device_software`, `bootstrap_homebrew` 3; the multiplexed `manage_*` 1) |
| `TIER1_READ_ACTIONS` | + every read action above |
| `TIER2_ACTIONS` | catalog create/import_package/update, deployment cancel, fleet-finding acknowledge/dismiss/reopen, custom-field create/update_definition |
| `TIER3_ACTIONS` + `TIER3_SUPERVISED_ACTIONS` | catalog add/update/promote_version, add/update/delete_install_method, archive; deployment create/retry; device-software update/uninstall; bootstrap_homebrew (whole tool); inventory approve/deny/clear; custom-field delete_definition and set_values |
| `TIER3_INPUT_AWARE_ACTIONS` / `isInputAwareTier3` / `TIER_DECIDING_INPUT_KEYS` | + `manage_software_catalog:create`, `manage_custom_fields:create_definition` (`ownerScope: 'partner'` → supervised) |
| `EFFECT_DIGEST_RESOLVERS` | + `manage_software_deployments:create` (W12-D12) |
| `TIER3_FOUR_EYES_*`, `DELIBERATELY_UNPINNED` | unchanged (no four-eyes W12 surface) |
| `AGENT_HUMAN_ONLY_TOOLS` | + `bootstrap_homebrew`, `manage_custom_fields` |
| `AGENT_HUMAN_ONLY_ACTIONS` | + `manage_device_software:uninstall` |
| `USER_OWNED_RELEASE_ACTIONS` | unchanged (W12-D3) |
| `MFA_GATED_TOOL_ACTIONS` | every W12 write |
| `TOOL_PERMISSIONS` | per-action rows from each route (table above) |
| `mcpCoverage.ts` / `FROZEN_GAPS` | burned down: `software.ts`, `softwareInstallMethods.ts`, `softwareInventory.ts`, `packageSearch.ts`, `devices/software.ts`, `devices/softwareActions.ts`, `devices/homebrewBootstrap.ts`; `fleetFindings.ts`, `customFields.ts` gain their write tools |

## Budget (W19 bounds; `AI_TOOL_INDEX=lazy`)

| Measure | main `214621318e` | branch |
|---|---|---|
| Always-on (B1 < 2,560) | 2,494 | 2,494 |
| patching block (B2 < 2,048) | 423 | 705 |
| devices block (B2 < 2,048) | 1,187 | 1,328 |
| largest block | security 1,644 | security 1,644 |
| Worst page turn (B3 < 7,040) | alert 4,731 | alert 4,872 (device 4,069 → 4,210) |

Measured +282 B on the patching line and +141 B on the devices line; no ceiling, `DOMAIN_NOTES` or vocabulary change; none of the nine is `alwaysLoad`. The chat surface grew 296 → 305 tools; the registry is 327, so `MCP_TOOL_COUNT_APPROX` moved 310 → 320 (own commit). D5 turn-1 token capture was not run (AI keys are blanked in worktree stacks).

Domains: the seven software tools join `patching` (the domain of `get_software_compliance` and `manage_software_policy`); `manage_fleet_findings` and `manage_custom_fields` join `devices` (beside `get_fleet_findings` and `query_custom_fields`).

## Quorum (codex `exec`, read-only, xhigh): AGREE WITH CHANGES

- **QW1 (blocking) partner-wide creates and edits, value writes. ACCEPTED** — partner-wide create is supervised (input-aware); existing partner-wide rows are never modified by the tool (W12-D10, instead of codex's four-eyes delete with an asserted owner); `set_values` is supervised.
- **QW2 (blocking) catalog authorization weaker than the plan said. ACCEPTED** — W12-D11.
- **QW3 (blocking) bind deployment effects. ACCEPTED** — groups dropped (named devices ≤ 100) and the dependency fingerprint is pinned (W12-D12).
- **QW4 (blocking) `software_policy_audit.actor_id`. ACCEPTED** — W12-D13.
- **QW5 (blocking) credential-bearing URLs in reads. ACCEPTED** — W12-D11 projection.
- **QW6 agent exposure. ACCEPTED** — `manage_custom_fields` is agent-human-only as a whole tool; uninstall / bootstrap recorded as conservative D4 exceptions.
- **QW7 exact-device axis, child references, config-link adoption, lost updates. ACCEPTED** — W12-D12, W12-D13.
- **QW8 remaining classes and exclusions agreed; reversibility wording. ACCEPTED** — W12-D13.
- **Dissent for Todd:** none outstanding. Codex preferred four-eyes for a partner-wide definition delete; the tool refuses it instead (stricter).

## Tasks

T1 (this doc + quorum) → T4 service extraction, schemas, handlers → T2 guardrail classes → T3 route bindings + permission parity → T5 wiring + index measure → T6 agent catalog → T7 contract rows → T8 web `tierConfig.ts` → T9 docs → T10 prompt-size gate → T11 golden prompts → T12 integration suites → T13 merge main, gates, PR.

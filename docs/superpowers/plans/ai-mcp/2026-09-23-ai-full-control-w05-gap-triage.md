---
tracking_issue: LanternOps/breeze#6754
wave: W05 (#6759)
---

# W05 (#6759) — L3 gap triage for feature #6754

Input: every `{ gap: '#6141' }` entry in `apps/api/src/services/mcpCoverage.ts` on `origin/main` @ `6c5f25667d` (158 route modules). Each module's endpoints were enumerated from the route file, and its gates were read (permission, scope, MFA). Existing `aiTools*.ts` tools were checked for partial coverage. Prior context comes from #6141 and spec `docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md`.

Method caveat: most modules were classified from the endpoint list, header docs and gates. Handler bodies were not read in full. Rows marked (*) had their handler logic spot-read to settle the call.

## Summary

| Bucket | Modules | Meaning |
|---|---|---|
| **BUILD** | **85** | New tool(s) or new actions on an existing `manage_*` tool. Grouped into W06–W18 below. |
| **REMAP** | **3** | An existing tool already covers the module. Change the entry to `{ tools: [...] }` in W06 as a no-code shrink of `FROZEN_GAPS`. |
| **EXEMPT** | **53** | Human-only, transport, credential or UI-plumbing surface. Reasons are listed below. |
| **DEFER** | **17** | Worth having, but low value or high cost now. Each needs an issue number under the new `defer` entry rule. Two of them (devices/stats, tickets/export) are "verify existing coverage first" and may become REMAPs. |
| Total | 158 | |

### New exempt reasons proposed (added to `McpExemptReason` with a doc comment, as `human_only_verification` was)

| Reason | Modules | Rationale |
|---|---|---|
| `human_only_agent_rollback` | agentRollback | Standing spec exclusion |
| `human_only_bulk_destructive` | contracts/bulk, invoices/bulk, quotes/bulk, devices/bulkLifecycle | Standing spec exclusion (bulk destructive billing). Extended to bulk device permanent-delete. The single-item equivalents already have tools. |
| `human_only_approval` | approvals | This module is the human decision gate (passkey assertion-challenge, approve/deny/report-suspicious). An AI that can decide approvals defeats four-eyes. |
| `human_only_ai_governance` | aiProvider, ai/scriptPolicy, partnerAiScriptPolicy, toolSources | The AI must not widen its own authority: unattended lane, BYO LLM key, BYO MCP tool sources and tier/enable per tool. |
| `human_only_tenant_restructure` | orgMerge, orgArchive, devices/moveOrg | These rewrite which tenant owns data (the org-move and merge lock machinery). **Todd should confirm this.** |
| `ai_transport` | ai.ts, scriptAi.ts | The chat and script-builder session transport itself (sessions, messages, interrupt, approve-plan). |
| `mobile_surface` | mobile.ts | The mobile app's aggregate API, analogous to `addin_surface`. Its actions duplicate `manage_alerts` and device tools. |
| `partner_api_surface` | partnerApi/* (7) | Machine-to-machine Partner API for service principals. It duplicates in-product reads that already have tools, and provisioning writes are service-principal-only by design (#3243). |
| `ui_file_transfer` | customFieldImport, devices/customFieldImport, softwareUploads | CSV import preview/commit and chunked binary upload. These are browser file flows. The AI equivalent is a per-row write (custom-field set, catalog version from URL). |
| `breeze_account` | partnerTrust, externalServices | The partner's own relationship with Breeze (trust review request, Breeze billing portal, support forward). |

Existing reasons reused: `identity` (actionIntents, connectedApps, lifecycle, permissionsCatalog, enrollmentKeys, devices/provision), `vendor_console_admin` (OAuth/credential connect flows: c2c/m365Auth, google, m365, m365CustomerGraphActions, tickets/mailboxConnect, stripeConnect, integrations), `internal_plumbing` (config, search, devices/options, devices/tabCounts, devices/removalConfig, patches/appOptions, remote/index, topology/layouts, tunnels, devPush), `platform_admin` (thirdPartyCatalog/list + operations: both are behind `platformAdminMiddleware`, so they were **mis-registered as gaps**).

## Per-module table

Risk: `read` = tier 1; `t2` = tier 2 (reversible, tenant-internal, single-org); `sup` = supervised (touches a customer machine, partner-wide, leaves the tenant, or irreversible); `4e` = four-eyes (irreversible and leaves the tenant or is partner-wide). Size: S ≤ 1 day, M 2–3 days, L ≥ 4 days (tool + parity tests + tier maps + eval prompt).

| # | Module | Class | Wave / reason | Endpoints worth a tool → proposed tool(s) | R/W | Size | Risk |
|---|---|---|---|---|---|---|---|
| 1 | accessReviews.ts (*) | BUILD | W11 | list/get/create reviews, record item decisions → `manage_access_reviews`. **`POST /:id/complete` revokes partner_users rows and refresh families (identity write), so it stays human-only.** | R+W | M | read / t2 (create, decide) / complete = human |
| 2 | accounting/index.ts | BUILD (partial) | W14 | status, owed-operations, customers, mappings, income-accounts, remote-candidates (read); mappings/sync, invoice push, push-bulk → `manage_accounting_sync`. Connect/callback/disconnect/settings stay `vendor_console_admin`. | R+W | M | read / sup (push leaves tenant) |
| 3 | actionIntents.ts | EXEMPT | identity | One-time plaintext reveal of a reset-password credential | — | — | — |
| 4 | agentRollback.ts | EXEMPT | human_only_agent_rollback | Spec standing exclusion | — | — | — |
| 5 | ai.ts | EXEMPT | ai_transport | The chat session transport; usage/budget/admin are governance | — | — | — |
| 6 | ai/scriptPolicy.ts | EXEMPT | human_only_ai_governance | Unattended-lane grant plus lane reset (needs approvals:decide + step-up) | — | — | — |
| 7 | aiAgentSchedules.ts | BUILD | W10 (read) + W16 (write) | list → `list_ai_agent_schedules`; create/update/delete → `manage_ai_agent_schedules` | R+W | S | read / sup (partner-wide policy that runs against customer machines) |
| 8 | aiOperatorTasks.ts | BUILD | W10 + W16 | list/get → `list_operator_tasks`, `get_operator_task`; create → `create_operator_task` | R+W | S | read / sup |
| 9 | aiProvider.ts | EXEMPT | human_only_ai_governance | BYO LLM key and endpoint (credential) | — | — | — |
| 10 | alertTemplates/correlations.ts | BUILD | W07 | correlations list/groups/:alertId (read), analyze → folds into `get_alert_correlations` | R | S | read |
| 11 | alerts/correlations.ts | BUILD | W07 | list/evaluation/get/explain → `get_alert_correlations`; acknowledge/resolve group, feedback, rca-feedback → `manage_alert_correlations` | R+W | M | read / t2 |
| 12 | approvals.ts | EXEMPT | human_only_approval | The human approval gate itself | — | — | — |
| 13 | auditBaselines.ts (*) | BUILD | W11 | list/create baselines, compliance, per-device (read), create apply-request → `manage_audit_baselines`. **The apply-request `decision` action is human-only** (it is an approval). | R+W | M | read / t2 (create) / sup (apply-request) |
| 14 | backup/bmr.ts | DEFER | — | BMR tokens, signing keys and boot media are credentials finished by a human at the physical machine; `recover/*` is recovery-environment transport. Revisit after W17 recovery reads. | — | — | — |
| 15 | backup/bmrRecoveries.ts | BUILD (reads) | W17 | list/get → `list_bmr_recoveries`. create/cancel/reissue-code stay human (the code goes to a person at the machine). | R | S | read |
| 16 | backup/encryption.ts | DEFER | — | Key rotate/delete can orphan every snapshot; key metadata alone is low value | — | — | — |
| 17 | backup/reconcile.ts | DEFER | — | Adopting orphaned S3 snapshots is a rare operator recovery action with a self-managed DB context | — | — | — |
| 18 | backup/verification.ts | BUILD | W17 | health, verifications, recovery-readiness (read); verify → `manage_backup_verification` | R+W | S | read / sup (verify runs on the device) |
| 19 | backup/vss.ts | BUILD | W17 | status/:deviceId → `get_vss_status` (it queries the agent: DEVICES_EXECUTE + MFA) | R | S | read (match the route gate) |
| 20 | billingProfiles.ts | BUILD | W14 | profiles + work-types CRUD, rows, clone → `manage_billing_profiles` | R+W | M | read / sup (partner-wide rates) |
| 21 | c2c/configs.ts | BUILD | W17 | configs CRUD → `manage_c2c_configs` | R+W | S | read / t2 (delete = sup) |
| 22 | c2c/m365Auth.ts | EXEMPT | vendor_console_admin | OAuth consent URL and callback | — | — | — |
| 23 | catalog/enrich.ts | DEFER | — | An AI copy-polish endpoint; the AI can already draft copy and call `manage_catalog` | — | — | — |
| 24 | config.ts | EXEMPT | internal_plumbing | UI feature flags | — | — | — |
| 25 | configurationPolicies/alertRuleTest.ts | BUILD | W07 | POST test → `test_alert_rule` (dry run) | R | S | read |
| 26 | connectedApps.ts | EXEMPT | identity | OAuth client grants and revoke | — | — | — |
| 27 | contracts/bulk.ts | EXEMPT | human_only_bulk_destructive | bulk delete/cancel | — | — | — |
| 28 | contracts/documents.ts | BUILD | W14 | list, patch → `manage_contract_documents` (PDF out of scope) | R+W | S | read / t2 |
| 29 | contracts/generate.ts | BUILD | W14 | generate invoice → new `generate_invoice` action on `manage_contracts` (#6141 P1) | W | S | sup (money) |
| 30 | contracts/periods.ts | BUILD | W14 | period outcome → `period_outcome` action on `get_contract` | R | S | read |
| 31 | contracts/reports.ts | BUILD | W14 | currency-mismatches → `currency_mismatches` action on `list_contracts` | R | S | read |
| 32 | contracts/templates.ts | BUILD | W14 | list/get/usage/create/patch/archive/versions/publish → `manage_contract_templates` (binary upload excluded) | R+W | M | read / sup (publish affects every new contract) |
| 33 | customFieldImport.ts | EXEMPT | ui_file_transfer | CSV import | — | — | — |
| 34 | devPush.ts | EXEMPT | internal_plumbing | Dev-only agent binary push | — | — | — |
| 35 | devices/actuateElevation.ts | DEFER | — | PAM actuator is disabled by default in every env; `request_elevation` covers the product path | — | — | — |
| 36 | devices/aiOrigin.ts | BUILD | W10 | ai-origin, ai-activity → `get_device_ai_activity` | R | S | read |
| 37 | devices/anomalies.ts | BUILD | W07 | list, set status → `manage_device_anomalies` | R+W | S | read / t2 |
| 38 | devices/billing.ts | BUILD | W14 | device → contract lines → `get_device_billing` (partner scope + contracts:read, as the route gates) | R | S | read |
| 39 | devices/bulkLifecycle.ts | EXEMPT | human_only_bulk_destructive | bulk restore / permanent-delete | — | — | — |
| 40 | devices/customFieldImport.ts | EXEMPT | ui_file_transfer | CSV import | — | — | — |
| 41 | devices/diagnose.ts (*) | REMAP | → `take_screenshot`, `get_device_context` | The handler is screenshot + metrics context | — | 0 | — |
| 42 | devices/diagnosticLogs.ts (*) | REMAP | → `search_agent_logs` | Same `agent_logs` table, filtered by device | — | 0 | — |
| 43 | devices/events.ts | BUILD | W13 | device event timeline → `get_device_events` | R | S | read |
| 44 | devices/filesystemSystemCleanup.ts (*) | REMAP | → `system_cleanup` | list/run/status already exist. Cancel is missing: add a `cancel` action (XS). | — | 0 | — |
| 45 | devices/function.ts | BUILD | W13 | get/put → `manage_device_function` | R+W | S | read / t2 |
| 46 | devices/health.ts | BUILD | W13 | agent health latest → `get_device_health` (or fold into `get_device_details`) | R | S | read |
| 47 | devices/homebrewBootstrap.ts | BUILD | W12 | → `bootstrap_homebrew` | W | S | sup (customer machine) |
| 48 | devices/links.ts | BUILD | W13 | link groups CRUD → `manage_device_links` | R+W | S | read / t2 |
| 49 | devices/manual.ts | BUILD | W13 | manual assets CRUD + link → `manage_manual_assets` | R+W | S | read / t2 |
| 50 | devices/moveOrg.ts | EXEMPT | human_only_tenant_restructure | Cross-tenant move (confirm) | — | — | — |
| 51 | devices/options.ts | EXEMPT | internal_plumbing | Picker typeahead | — | — | — |
| 52 | devices/posture.ts | BUILD | W13 | management-posture summary/devices → `get_management_posture` | R | S | read |
| 53 | devices/processSamples.ts | BUILD | W13 | → `get_process_samples` | R | S | read |
| 54 | devices/provision.ts | EXEMPT | identity | Provisioning token issue/fetch (enrollment credential) | — | — | — |
| 55 | devices/removalConfig.ts | EXEMPT | internal_plumbing | One env knob for the Remove dialog | — | — | — |
| 56 | devices/software.ts | BUILD | W12 | installed software per device → `get_device_software` | R | S | read |
| 57 | devices/softwareActions.ts | BUILD | W12 | update/uninstall → `manage_device_software` | W | S | sup (customer machine) |
| 58 | devices/stats.ts | DEFER | — | Fleet counts are largely covered by `query_devices` / `get_executive_summary`. Verify first. | — | — | — |
| 59 | devices/tabCounts.ts | EXEMPT | internal_plumbing | UI badge counts | — | — | — |
| 60 | devices/warranty.ts | BUILD | W13 | get, refresh, expiring → `manage_device_warranty` | R+W | S | read / t2 (refresh is an external lookup, no tenant data out) |
| 61 | devices/watchdogLogs.ts | BUILD | W13 | → `source: 'watchdog'` on `search_agent_logs`, or `get_watchdog_logs` | R | S | read |
| 62 | discoveryAssetProbe.ts | BUILD | W09 | "Check now" probe → `probe_network_asset` | W | S | t2 (agent-side network probe, no state change) |
| 63 | enrollmentKeys.ts | EXEMPT | identity | Enrollment keys/installer links are tenant-admission credentials (abuse history: bulk-use keys). **Todd should confirm.** | — | — | — |
| 64 | externalServices.ts | EXEMPT | breeze_account | Breeze billing portal and support forward | — | — | — |
| 65 | fleetDesign.ts | BUILD | W10 (read) + W16 (write) | list/get/applied → `list_fleet_designs`, `get_fleet_design`; run, apply/preview, apply, rollback, document → `manage_fleet_designs` | R+W | M | read / sup (run) / 4e (apply: partner-wide config writes across devices, scripts and contracts) |
| 66 | google.ts | EXEMPT | vendor_console_admin | Connection credential | — | — | — |
| 67 | integrations.ts | EXEMPT | vendor_console_admin | PSA/monitoring/communication credentials and tests | — | — | — |
| 68 | invoices/bulk.ts | EXEMPT | human_only_bulk_destructive | bulk delete/issue/void | — | — | — |
| 69 | invoices/evidence.ts | BUILD | W14 | line → billed devices → `line_devices` action on `get_invoice` | R | S | read |
| 70 | invoices/pdf.ts | DEFER | — | Binary PDF; revisit when a tool can return an artifact | — | — | — |
| 71 | invoices/settings.ts | BUILD | W14 | partner/org billing settings, currency-impact, reporting-totals → `manage_billing_settings` | R+W | S | read / sup (partner settings = partner-wide) |
| 72 | lifecycle.ts | EXEMPT | identity | Mobile device and OAuth client block/revoke | — | — | — |
| 73 | m365.ts | EXEMPT | vendor_console_admin | Connection credential | — | — | — |
| 74 | m365CustomerGraphActions.ts | EXEMPT | vendor_console_admin | Consent/retest/disconnect. Graph reads already have `m365_query_*`. | — | — | — |
| 75 | mobile.ts | EXEMPT | mobile_surface | Mobile aggregate API | — | — | — |
| 76 | monitoringAssetMetrics.ts | BUILD | W09 | bucketed SNMP metric history → `get_snmp_metrics` | R | S | read |
| 77 | networkKnownGuests.ts | BUILD | W09 | list/add/delete → `manage_known_guests` | R+W | S | read / t2 |
| 78 | notifications.ts | DEFER | — | The caller's own in-app bell; marginal value for the AI | — | — | — |
| 79 | onedrive.ts | DEFER | — | OneDrive helper library picker; niche | — | — | — |
| 80 | orgAccountReadiness.ts | BUILD | W18 | → `get_account_readiness` | R | S | read (per-section grants as the route) |
| 81 | orgArchive.ts | EXEMPT | human_only_tenant_restructure | archive/restore org (confirm; reversible, so it could instead be BUILD four-eyes) | — | — | — |
| 82 | orgAuditRetentionSettings.ts | BUILD (read) | W18 | get → `get_audit_retention`; the PUT stays human (shortening it destroys evidence) | R | S | read |
| 83 | orgBillingProfile.ts | BUILD | W14 | get/put/delete → `org_profile` action on `manage_billing_profiles` | R+W | S | read / t2 |
| 84 | orgMerge.ts | EXEMPT | human_only_tenant_restructure | Merge preview/merge/run status | — | — | — |
| 85 | orgPortalSettings.ts | BUILD | W18 | get/patch → `manage_org_portal_settings` | R+W | S | read / sup (customer-visible) |
| 86 | orgPortalUsers.ts | BUILD (read) | W18 | list → `list_portal_users`; invite/resend/bulk-invite/patch/delete are identity writes | R | S | read |
| 87 | orgSummary.ts | BUILD | W18 | → `get_org_summary` | R | S | read |
| 88 | orgTicketSettings.ts | BUILD | W06 | get/patch → `org_settings` on `manage_ticket_config` | R+W | S | read / t2 |
| 89 | packageSearch.ts | BUILD | W12 | winget/Homebrew search → `search_packages` | R | S | read |
| 90 | partner.ts | DEFER | — | /me + dashboard; `get_executive_summary` overlaps | — | — | — |
| 91 | partnerAiScriptPolicy.ts | EXEMPT | human_only_ai_governance | Partner ceiling on the unattended lane | — | — | — |
| 92–98 | partnerApi/{configuration,contracts,devices,inventory,organizations,provisioning,relationships}.ts | EXEMPT | partner_api_surface | Service-principal machine API | — | — | — |
| 99 | partnerLoginBranding.ts | DEFER | — | Cosmetic, one-time setup | — | — | — |
| 100 | partnerSendingDomains.ts | DEFER | — | DNS verification is completed by a human at the registrar; test-send leaves the tenant | — | — | — |
| 101 | partnerTrust.ts | EXEMPT | breeze_account | Trust review request to Breeze | — | — | — |
| 102 | patchPlan.ts | BUILD | W16 | run now → `run_patch_plan` | W | S | sup |
| 103 | patchPolicies.ts | DEFER | — | Read-only `kind='legacy'` surface superseded by config-policy patch features. Candidate to EXEMPT/retire. | — | — | — |
| 104 | patches/appOptions.ts | EXEMPT | internal_plumbing | Picker for policy app rules | — | — | — |
| 105 | pax8.ts | BUILD (partial) | W15 | integration status, companies, subscriptions (read), sync, subscription link/unlink → `get_pax8_status`, `manage_pax8_subscriptions`. Credential save/test and company↔org map stay `vendor_console_admin`-like human writes. | R+W | M | read / t2 (sync) / sup (link) |
| 106 | pax8Orders.ts | BUILD | W15 | drift, orders, products, provision-details, dependencies (read); draft create/lines/preflight; submit; reconcile → `search_pax8_products`, `manage_pax8_orders` | R+W | L | read / t2 (draft) / 4e (submit: money leaves the tenant, irreversible) |
| 107 | permissionsCatalog.ts | EXEMPT | identity | Permission catalog for the role editor | — | — | — |
| 108 | plugins.ts | DEFER | — | Installing a plugin puts code into the tenant: supply-chain class, low demand | — | — | — |
| 109 | policyManagement/actions.ts | BUILD | W11 | deactivate → new `manage_compliance_policies` (pairs with `query_compliance_policies`) | W | S | t2 (org) / sup (partner-wide) |
| 110 | quotes/bulk.ts | EXEMPT | human_only_bulk_destructive | bulk delete/send | — | — | — |
| 111 | reliability.ts | BUILD | W07 | history, offenders, evaluation, org summary, feedback → actions on `get_fleet_health` + `reliability_feedback` | R+W | S | read / t2 |
| 112 | remote/index.ts | EXEMPT | internal_plumbing | Remote-provider picker | — | — | — |
| 113 | remote/supportSessions.ts | BUILD | W13 | list/get/create/end → `manage_support_sessions` | R+W | S | read / sup (create) / t2 (end) |
| 114 | reports/recipients.ts | BUILD | W18 | list/add/remove/convert → `manage_report_recipients` | R+W | S | read / sup (report data leaves the tenant) |
| 115 | roles.ts | BUILD (read) | W18 | list, get, users, effective-permissions → `list_roles`; writes stay identity | R | S | read |
| 116 | scriptAi.ts | EXEMPT | ai_transport | Script-builder chat transport | — | — | — |
| 117 | scriptBundle.ts | DEFER | — | Bundle export/import; import is bulk content, low frequency | — | — | — |
| 118 | search.ts | EXEMPT | internal_plumbing | Global typeahead; typed search tools already exist | — | — | — |
| 119 | security/compliance.ts | BUILD | W11 | trends, firewall, encryption, password-policy, admin-audit → `get_security_compliance` | R | S | read |
| 120 | security/dashboard.ts | BUILD | W11 | dashboard, score-breakdown → same tool, or extend `get_security_posture` | R | S | read |
| 121 | security/policies.ts | BUILD | W11 | list/create/update → `manage_security_policies` | R+W | S | read / sup (applies to endpoints) |
| 122 | security/recommendations.ts | BUILD | W11 | list, complete, dismiss → `manage_security_recommendations` | R+W | S | read / t2 |
| 123 | security/recoveryKeys.ts | BUILD (partial) | W11 | list, rotate, collect → `manage_recovery_keys`. **`reveal` stays human-only** (plaintext BitLocker key). | R+W | S | read / sup (rotate, collect on device) |
| 124 | security/status.ts | BUILD | W11 | fleet/device status → `get_security_compliance` | R | S | read |
| 125 | snmp.ts | BUILD | W09 | devices CRUD + poll/test, templates CRUD, OID browse/validate, metrics, thresholds CRUD, dashboard → `manage_snmp_devices`, `manage_snmp_templates`, `manage_snmp_thresholds`, `get_snmp_metrics` | R+W | L | read / t2 (thresholds, devices) / sup (template edits hit every device using it) |
| 126 | software.ts | BUILD | W12 | catalog CRUD/versions/promote/download-url, deployments list/summary/create/deploy/cancel/retry/results, inventory, download-policy → `manage_software_catalog`, `manage_software_deployments` | R+W | L | read / sup (deploy, promote) / t2 (catalog edits) |
| 127 | softwareInstallMethods.ts | BUILD | W12 | install methods CRUD, import-package → actions on `manage_software_catalog` | R+W | S | t2 |
| 128 | softwareInventory.ts | BUILD | W12 | list, names, per-name devices (read); approve/deny/clear → `manage_software_inventory` (approve auto-creates an allowlist policy) | R+W | S | read / sup (writes policy) |
| 129 | softwareUploads.ts | EXEMPT | ui_file_transfer | Chunked binary upload | — | — | — |
| 130 | stripeConnect/index.ts | EXEMPT | vendor_console_admin | Stripe secret key | — | — | — |
| 131 | system.ts | DEFER | — | Version/config-status reads are low value; setup-complete is onboarding UI. Revisit with the System page spec (#6768). | — | — | — |
| 132 | systemTools/eventLogs.ts | BUILD | W13 | live event-log browse via the agent → `browse_device_event_log` (complements ingested `search_logs`) | R | S | read |
| 133 | tenantVariables.ts | BUILD | W13 | CRUD → `manage_tenant_variables`; `isSecret` values are never returned | R+W | S | read / t2 (sup when partner-wide) |
| 134 | thirdPartyCatalog/list.ts | EXEMPT | platform_admin | Behind `platformAdminMiddleware` (mis-registered as a gap) | — | — | — |
| 135 | thirdPartyCatalog/operations.ts | EXEMPT | platform_admin | Same | — | — | — |
| 136 | ticketCategories.ts | BUILD | W06 | list/reorder/create/patch/delete → `manage_ticket_config` (`categories`) | R+W | S | read / t2 |
| 137 | ticketChecklistTemplates.ts | BUILD | W06 | templates + items CRUD/reorder → `manage_ticket_checklist_templates` (#6141 P1) | R+W | S | read / t2 |
| 138 | ticketConfig.ts | BUILD | W06 | statuses/priorities/inbound-domains → `manage_ticket_config`; email-inbound list/convert/dismiss → `manage_ticket_inbox` | R+W | M | read / t2 |
| 139 | tickets/attachments.ts | BUILD | W06 | attach-from-artifact, read content (text-safe), delete → `manage_ticket_attachments` | R+W | S | read / t2 |
| 140 | tickets/bulk.ts (*) | BUILD (partial) | W06 | `bulk_update` action (assign/status/priority) on `manage_tickets`; **bulk `delete` excluded** | W | S | t2 |
| 141 | tickets/export.ts | DEFER | — | Billables CSV; `export_dataset` pattern may already fit, so verify | — | — | — |
| 142 | tickets/forms.ts | BUILD | W06 | list/available/create/update/delete → `manage_ticket_forms` | R+W | S | read / sup (customer-visible portal form) |
| 143 | tickets/mailboxConnect.ts | EXEMPT | vendor_console_admin | Mailbox OAuth connect | — | — | — |
| 144 | tickets/ticketResponseTemplates.ts | BUILD | W06 | CRUD → `manage_ticket_response_templates` | R+W | S | read / t2 |
| 145 | timeEntries/suggestions.ts | BUILD | W06 | list, confirm, dismiss, undo → `manage_time_suggestions` | R+W | S | read / t2 |
| 146 | toolSources.ts | EXEMPT | human_only_ai_governance | BYO MCP sources, per-tool tier/enable | — | — | — |
| 147 | topology/diagnostics.ts | BUILD | W08 | collectors, diagnostic run start/get/cancel → `run_topology_diagnostic` | R+W | S | read / t2 |
| 148 | topology/graphs.ts | BUILD | W08 | graph, nodes, node, relationship + evidence, group members, expansions, health → `get_topology_graph` (#6141 P1) | R | M | read |
| 149 | topology/layouts.ts | EXEMPT | internal_plumbing | Canvas layout persistence | — | — | — |
| 150 | topology/manual.ts | BUILD | W08 | manual nodes/relationships CRUD → `manage_topology_manual` | R+W | S | t2 |
| 151 | topology/policies.ts | BUILD | W08 | monitoring policies CRUD → `manage_topology_monitoring` (`policies`) | R+W | S | read / t2 |
| 152 | topology/settings.ts | BUILD | W08 | site settings get/patch → `manage_topology_monitoring` (`settings`) | R+W | S | t2 |
| 153 | topology/targets.ts | BUILD | W08 | probe targets CRUD → `manage_topology_monitoring` (`targets`) | R+W | S | t2 |
| 154 | topology/templateApplications.ts | BUILD | W08 | preview/apply/status → `apply_topology_template` | R+W | S | read (preview) / sup (apply) |
| 155 | topology/templates.ts | BUILD | W08 | templates + versions + publish, site template-options → `manage_topology_templates` | R+W | M | read / sup (publish is partner-wide) |
| 156 | tunnels.ts | EXEMPT | internal_plumbing | Browser tunnel/proxy tickets the AI cannot consume. Allowlist CRUD could be a later DEFER. | — | — | — |
| 157 | unifi/index.ts | BUILD (partial) | W09 | status, hosts, collectors, telemetry, sync-runs, controller-sites (read); sync → `get_unifi_status`, `trigger_unifi_sync`. connect/test/disconnect/mappings/collectors writes stay `vendor_console_admin`. | R+W | S | read / t2 |
| 158 | users.ts | BUILD (read) | W18 | list, get → `list_users`, `get_user` (#6141 P2 "read-only users/roles lists"); every write stays identity | R | S | read |

REMAP (no code; W06 edits `mcpCoverage.ts`): #41, #42, #44.

## Proposed waves (ordered by #6141 user pain)

No incident or remediation gaps remain: `incidents.ts`, `incidentActions.ts` and `remediationSuggestions.ts` are already `tools` entries. Escalation and routing are also covered, by `manage_delivery`. The alerts wave therefore targets correlation and signal triage.

| Wave | Domain | Scope (one line) | Tools (new or extended) | Size |
|---|---|---|---|---|
| **W06** | PSA configuration + ticket ops | Ticket categories/statuses/priorities/forms/response and checklist templates, inbound-email triage, attachments, bulk update, time suggestions, org ticket settings. Also lands the 3 REMAPs. | `manage_ticket_config`, `manage_ticket_checklist_templates`, `manage_ticket_forms`, `manage_ticket_response_templates`, `manage_ticket_inbox`, `manage_ticket_attachments`, `manage_tickets:bulk_update`, `manage_time_suggestions` (8) | M–L |
| **W07** | Alerts: correlation + signal triage | Correlation groups (read, explain, ack/resolve, feedback), rule dry-run, device anomalies, reliability history/offenders/feedback | `get_alert_correlations`, `manage_alert_correlations`, `test_alert_rule`, `manage_device_anomalies`, `get_fleet_health`+ (5) | M |
| **W08** | Network topology | Graph/node/relationship reads, diagnostics, manual nodes, monitoring policies/targets/settings, templates + application | `get_topology_graph`, `run_topology_diagnostic`, `manage_topology_manual`, `manage_topology_monitoring`, `manage_topology_templates`, `apply_topology_template` (6) | L |
| **W09** | SNMP + network monitoring | SNMP devices/templates/thresholds/metrics, asset probe, known guests, UniFi reads + sync | `manage_snmp_devices`, `manage_snmp_templates`, `manage_snmp_thresholds`, `get_snmp_metrics`, `probe_network_asset`, `manage_known_guests`, `get_unifi_status`, `trigger_unifi_sync` (8) | L |
| **W10** | AI-agent reads | Read-back for AI runs: device AI origin/activity, operator tasks, agent schedules, fleet designs | `get_device_ai_activity`, `list_operator_tasks`, `get_operator_task`, `list_ai_agent_schedules`, `list_fleet_designs`, `get_fleet_design` (6) | S–M |
| **W11** | Security policy | Access reviews (without complete), audit baselines + apply-request (without decision), security policies/recommendations/compliance/status, recovery keys (without reveal), compliance-policy deactivate. Also carries the #6141 PAM-rules gap (pam.ts is a `tools` entry, but rules/config/signer groups have no tool). | `manage_access_reviews`, `manage_audit_baselines`, `manage_security_policies`, `manage_security_recommendations`, `get_security_compliance`, `manage_recovery_keys`, `manage_compliance_policies`, `manage_pam_rules` (8) | L |
| **W12** | Software catalog + deployment (+ fleet findings / custom fields) | Deployable catalog, versions, install methods, package search, software deployments, device software read/update/uninstall, inventory approve/deny, Homebrew bootstrap. Also the two #6141 items on `tools` modules: fleet-finding ack/dismiss and custom-field definition/value writes. | `manage_software_catalog`, `manage_software_deployments`, `search_packages`, `get_device_software`, `manage_device_software`, `manage_software_inventory`, `bootstrap_homebrew`, `manage_fleet_findings`, `manage_custom_fields` (9) | L |
| **W13** | Device inventory + ops | Device function, link groups, manual assets, warranty, health, events, process samples, watchdog logs, management posture, live event-log browse, tenant variables, support sessions | `manage_device_function`, `manage_device_links`, `manage_manual_assets`, `manage_device_warranty`, `get_device_health`, `get_device_events`, `get_process_samples`, `search_agent_logs`+watchdog, `get_management_posture`, `browse_device_event_log`, `manage_tenant_variables`, `manage_support_sessions` (12) | L |
| **W14** | Billing lifecycle | Billing profiles/work types/org profile, billing settings, contract templates/documents/generate/period outcome/currency mismatches, invoice line evidence, device billing, accounting sync (reads + push) | `manage_billing_profiles`, `manage_billing_settings`, `manage_contract_templates`, `manage_contract_documents`, `manage_contracts:generate_invoice`, `get_contract`+, `list_contracts`+, `get_invoice`+, `get_device_billing`, `manage_accounting_sync` (10) | L |
| **W15** | Pax8 | Status/companies/subscriptions reads, sync, subscription link, product search, order drafts + preflight, four-eyes submit, drift | `get_pax8_status`, `manage_pax8_subscriptions`, `search_pax8_products`, `manage_pax8_orders`, `get_pax8_drift` (5) | L |
| **W16** | AI schedules / operator tasks / designer writes | Schedule CRUD, operator task create, Fleet Design run/apply/rollback, patch plan run-now. These are writes that make the AI start more AI, so each gets a class review. | `manage_ai_agent_schedules`, `create_operator_task`, `manage_fleet_designs`, `run_patch_plan` (4) | M |
| **W17** | Backup completeness | Verification (health, run, readiness), VSS status, C2C backup configs, BMR recovery reads | `manage_backup_verification`, `get_vss_status`, `manage_c2c_configs`, `list_bmr_recoveries` (4) | S–M |
| **W18** | Org admin + read-only identity | Org summary/account readiness, portal settings, portal user list, audit retention read, users/roles reads, report recipients | `get_org_summary`, `get_account_readiness`, `manage_org_portal_settings`, `list_portal_users`, `get_audit_retention`, `list_users`, `get_user`, `list_roles`, `manage_report_recipients` (9) | M |

Rough total: about 94 new or extended tool surfaces across 13 waves. W08/W09, and W12/W13, could run in parallel because their files are disjoint (`aiToolsNetwork*` vs `aiToolsTopology*`; `aiToolsSoftware*` vs `aiToolsDevice*`).

## DEFER list (each needs an issue per the new `defer` rule)

backup/bmr, backup/encryption, backup/reconcile, catalog/enrich, devices/actuateElevation, devices/stats, invoices/pdf, notifications, onedrive, partner.ts, partnerLoginBranding, partnerSendingDomains, patchPolicies (candidate to retire), plugins, scriptBundle, system.ts, tickets/export (17). devices/stats and tickets/export should be checked against `query_devices`/`get_executive_summary` and `export_dataset` in W06; either may become a REMAP.

## Product judgments for Todd

1. **`human_only_tenant_restructure`** (orgMerge, orgArchive, devices/moveOrg): the alternative is BUILD at four-eyes. Archive is reversible.
2. **enrollmentKeys + devices/provision as `identity`**: techs do ask "give me an installer for Acme", but keys admit devices into a tenant and have an abuse history. The alternative is a read-only key list plus a four-eyes installer link.
3. **`human_only_ai_governance`** also blocks *reads* of the script-lane policy and tool sources. The alternative is read-only tools.
4. **Partial human-only actions inside BUILD modules:** access-review `complete` (it revokes users), audit-baseline apply-request `decision`, recovery-key `reveal`, bulk ticket `delete`, and Pax8 company↔org mapping.
5. **approvals.ts fully exempt**: this includes a read of "what is pending my approval". A read-only list is defensible if the AI must never decide.


## W05 implementation outcome

Applied against `apps/api/src/services/mcpCoverage.ts` and
`apps/api/src/__tests__/mcp-coverage.test.ts` (FROZEN_GAPS shrunk 158 -> 102):

- **85 BUILD** modules kept as `{ gap }`, re-pointed from `#6141` to their
  owning wave issue (W06 #6776 ... W18 #6789, per the wave table above).
- **53 EXEMPT** modules converted to `{ exempt }`. All ten proposed reason
  codes were added to `McpExemptReason` as proposed; existing codes
  (`identity`, `vendor_console_admin`, `internal_plumbing`, `platform_admin`)
  were reused where they already fit. `thirdPartyCatalog/list.ts` and
  `thirdPartyCatalog/operations.ts` moved to `platform_admin` after
  confirming both routers mount `platformAdminMiddleware`.
- **3 REMAP** modules converted to `{ tools }` after reading the handlers:
  `devices/diagnose.ts` -> `take_screenshot` + `get_device_context`,
  `devices/diagnosticLogs.ts` -> `search_agent_logs`,
  `devices/filesystemSystemCleanup.ts` -> `system_cleanup` (the route's
  `cancel` endpoint, #6485 F-5, has no matching tool action yet — a small
  follow-up, not a fresh gap).
- **Verified, not remapped:** `devices/stats.ts` (exact fleet-wide counts by
  status; `query_devices` is a paginated list capped at 100 and
  `get_executive_summary` is a periodic daily/weekly/monthly snapshot —
  neither substitutes) and `tickets/export.ts` (billables CSV; `export_dataset`'s
  dataset enum has no billables/time-entry dataset). Both stayed DEFER.
- **17 DEFER** modules each got one filed issue (#6792-#6808, in the same
  order as the DEFER list above) and their gap ref points at that issue.

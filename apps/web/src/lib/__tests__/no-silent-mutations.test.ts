/**
 * Guard: in the targeted set, every *mutating* fetchWithAuth call site — direct
 * or reached through an imported `src/lib/api/*` wrapper — must be lexically
 * wrapped by `runAction(...)` OR carry an explicit, reasoned
 * `// runaction-exempt:` marker (for the legitimate aggregate / inline-feedback
 * handlers). Whole-file allowlist entries (typed service layers, transport
 * stores) are still skipped via RUN_ACTION_ALLOWLIST.
 *
 * This is an AST check (TypeScript compiler API), not a regex/substring scan.
 * The previous version asserted only that the *file* contained the string
 * "runAction" somewhere — so a new bare mutation added next to existing
 * runAction usage passed unconditionally, and `{ method: opts.method }` /
 * `{ method }` / parenthesised URL args were never matched at all. It had no
 * teeth for the realistic regression. This one is call-local and conservative:
 * a non-literal `method` is treated as potentially-mutating. Imported API
 * wrappers are resolved through TypeScript symbols, including aliases and
 * re-exports, instead of relying on a hand-maintained wrapper-name list.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { RUN_ACTION_ALLOWLIST, RUN_ACTION_MIGRATION_BACKLOG } from '../runActionAllowlist';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '../..'); // apps/web/src
const WEB_ROOT = SRC_ROOT;
const REPO_ROOT = resolve(WEB_ROOT, '../../..');
const API_ROOT = resolve(SRC_ROOT, 'lib/api');
const FIXTURE_ROOT = resolve(__dirname, 'fixtures/no-silent-mutations/src');

// WS-A "targeted set": files that have ADOPTED runAction and must not regress
// to silent mutations. Grows as more handlers migrate (see the backlog).
const TARGET_GLOBS = [
  'src/components/monitoring/conversion/ConversionLedger.tsx',
  'src/components/monitoring/conversion/NeedsConversionPanel.tsx',
  'src/components/monitoring/conversion/ConversionPendingBanner.tsx',
  'src/components/admin/MonitorConversionAdmin.tsx',
  'src/components/configurationPolicies/featureTabs/useFeatureLink.ts',
  // Per-rule legacy convert (POST /monitor-definitions/convert-from-rule).
  'src/components/monitoring/LegacyRulesTable.tsx',
  // Disk Cleanup v2 W01: scan and cleanup-preview failures must surface.
  'src/components/devices/DeviceFilesystemTab.tsx',
  // Disk Cleanup v2 W03: cleanup-execute moved into this panel.
  'src/components/devices/filesystem/CleanupPanel.tsx',
  // Disk Cleanup v2 W04: both native-cleanup mutations (queue the catalog,
  // queue the run) go through runAction. This file is in the targeted set
  // from birth rather than added to the migration backlog — a silent failure
  // here is a tech believing a 90-minute DISM run started when it never did.
  'src/components/devices/filesystem/SystemCleanupPanel.tsx',
  // Network device "Check now" (#5988 W05): the probe reads liveness outside
  // W04's settings writer and must surface every mutation outcome.
  'src/components/devices/networkDevice/useAssetProbe.ts',
  'src/components/alerts/delivery/deliveryActions.ts',
  'src/components/alerts/AlertsPage.tsx',
  'src/components/alerts/AlertDetailPage.tsx',
  // Alert verdict feedback (P2-1 Task 15): submitVerdictFeedback is the one
  // runAction-wrapped POST both the list row and the detail page call — a
  // future bare mutation added here would ship unguarded to both.
  'src/components/alerts/AlertVerdictBadge.tsx',
  // Work types (#4628 W01): create/rename/archive all mutate partner-wide
  // billing configuration, and archiving also rewrites ticket-category
  // defaults -- a silent failure here leaves the tech believing a work type is
  // gone when it is still being stamped.
  'src/components/settings/WorkTypesCard.tsx',
  'src/components/settings/PartnerSettingsPage.tsx',
  'src/components/settings/PartnerAiProviderTab.tsx',
  'src/components/settings/OrgSettingsPage.tsx',
  // Tool catalog W01 PR C (#5216): the Tool Sources surface authors the
  // credentials and risk tiers that decide what the assistant may call on a
  // customer's systems — a silent failure here is a tech believing a tool is
  // disabled when it is not. The API client is listed alongside the two
  // components because it is where the mutating fetches live.
  'src/components/toolSources/api.ts',
  'src/components/toolSources/ToolSourceForm.tsx',
  'src/components/toolSources/DiscoveredToolsTable.tsx',
  'src/components/toolSources/ToolSourceDetail.tsx',
  'src/components/toolSources/ToolTestDrawer.tsx',
  // Execution plane W05 (#5716) — the per-org AI external-processing consent
  // switch and the attach-artifact-to-ticket control. Both mutate through
  // runAction; the count assertion below was bumped by exactly these two.
  'src/components/settings/OrgAiProcessingToggle.tsx',
  'src/components/aiAgents/AttachArtifactToTicket.tsx',
  // Account board (W02): org create and restore go through runAction in the
  // page; the drag/arrow-key reorder PATCH lives in its own hook. Both are
  // listed because TARGET_GLOBS is a literal file list, not directory-wide.
  'src/components/organizations/board/OrganizationsBoardPage.tsx',
  'src/components/organizations/board/useManualOrder.ts',
  // Org merge (org-lifecycle Wave 3): both the preview and the actual merge
  // POST are advisory-then-destructive mutations against a partner's tenant
  // tree, so a silent failure here is exactly the class this guard exists for.
  'src/components/settings/MergeOrgModal.tsx',
  // Org archive (org-lifecycle Wave 5), replacing the org delete flow: the
  // archive POST hides an org, uninstalls its agents, and stops its billing —
  // a silent failure here is exactly the class this guard exists for.
  'src/components/settings/ArchiveOrgModal.tsx',
  'src/components/settings/LoginBrandingCard.tsx',
  'src/components/settings/ConnectSsoCard.tsx',
  'src/components/patches/PatchesPage.tsx',
  'src/components/settings/RolesPage.tsx',
  // AI agent policy rows: a bare fetchWithAuth POST here would silently ship
  // an unreported failure on the surface that governs autonomous agents.
  'src/components/settings/AiAgentsPage.tsx',
  'src/components/settings/AiAgentForm.tsx',
  // Task 13 (#5051): the guided create flow's own POST /ai/agents — the same
  // surface AiAgentForm.tsx's create path already guards, just reached
  // through the four-step flow instead of the drawer.
  'src/components/settings/aiAgents/AgentCreateFlow.tsx',
  // Sweep schedules (P2-2, #4189): the section writes partner-wide baselines
  // and per-org overrides that decide what runs against customer machines on a
  // cron, unattended. A silent create/update/delete here is invisible until the
  // next occurrence fires — or fails to.
  'src/components/settings/AiAgentSchedulesSection.tsx',
  // Graduation (P2-5, #4192): the promote POST raises a four-eyes authority
  // change that widens what an agent may do unattended. A silent failure here
  // reads as "requested" while no approval was ever queued.
  'src/components/settings/AiAgentGraduationPanel.tsx',
  // P2-6 (#4193): Refresh enqueues a fleet-wide 90-day rebuild and the weights
  // drawer re-prices every estimate the MSP shows its customers — a silent
  // failure here is invisible until someone quotes a wrong number.
  'src/components/aiAgents/ImpactPage.tsx',
  // P2-6 Task 11 (#4193): the weights drawer's own PUT/DELETE against
  // /impact/weights are a separate file from ImpactPage.tsx above — this
  // guard's TARGET_GLOBS is a literal file list, not directory-wide, so the
  // drawer needs its own entry or its mutations are invisible to it.
  'src/components/aiAgents/ImpactWeightsDrawer.tsx',
  'src/components/devices/DeviceInfoTab.tsx',
  // Metric anomaly episodes W04: card actions (dismiss/resolve/promote/unsnooze)
  // are the only mutation surface for the rewritten panel.
  'src/components/devices/AnomalyEpisodeCard.tsx',
  // Fleet Designer W02 (#5652): the Function field's PUT is its own file.
  'src/components/devices/DeviceFunctionField.tsx',
  'src/components/devices/DevicePatchStatusTab.tsx',
  'src/components/dnsSecurity/DnsSecurityIntegrationsTab.tsx',
  'src/components/dnsSecurity/AddDnsIntegrationModal.tsx',
  'src/components/dnsSecurity/DnsSecurityPoliciesTab.tsx',
  'src/components/dnsSecurity/AddDnsPolicyModal.tsx',
  'src/components/devices/DeviceSoftwareInventory.tsx',
  'src/components/devices/DeviceLinkedProfilesTab.tsx',
  'src/components/devices/DeviceWarrantyCard.tsx',
  'src/components/devices/PossibleReplacementBanner.tsx',
  'src/components/pam/PamRespondModal.tsx',
  'src/components/pam/PamRevokeModal.tsx',
  'src/components/pam/PamRuleModal.tsx',
  'src/components/pam/PamRulesTab.tsx',
  'src/components/settings/TicketCategoriesPage.tsx',
  'src/components/settings/TicketStatusesTab.tsx',
  'src/components/settings/TicketPrioritiesTab.tsx',
  'src/components/settings/InboundEmailCard.tsx',
  'src/components/settings/EmailTemplatesTab.tsx',
  'src/components/settings/EmailTemplateEditor.tsx',
  'src/components/settings/M365MailboxCard.tsx',
  'src/components/settings/OrgPortalSettingsEditor.tsx',
  'src/components/settings/OrgTicketSettingsEditor.tsx',
  'src/components/alerts/CreateTicketFromAlertDialog.tsx',
  'src/lib/timerActions.ts',
  'src/components/time/TimerWidget.tsx',
  'src/components/time/TimesheetPage.tsx',
  'src/components/tickets/TicketTimeBilling.tsx',
  'src/components/tickets/TicketPartsCard.tsx',
  'src/components/clientAi/OrgsTab.tsx',
  'src/components/clientAi/PolicyEditor.tsx',
  'src/components/clientAi/SessionsTab.tsx',
  'src/components/clientAi/TemplatesTab.tsx',
  'src/components/settings/CatalogItemsTab.tsx',
  'src/components/settings/CatalogDefaultsCard.tsx',
  'src/components/billing/InvoicesPage.tsx',
  'src/components/billing/InvoiceEditor.tsx',
  'src/components/billing/InvoiceDetail.tsx',
  // Invoice → QuickBooks push (Phase C): the button's whole job is to reach an
  // external system of record. A silent failure here reads as "pushed" while
  // the books stay short an invoice, so this file is in the guarded set from
  // its first commit rather than after the first regression.
  'src/components/billing/AccountingSyncCard.tsx',
  'src/components/billing/PartnerBillingSettingsPage.tsx',
  'src/components/billing/BillingRatesTab.tsx',
  'src/components/billing/OrgBillingProfile.tsx',
  'src/components/billing/OrgBillingSettings.tsx',
  'src/components/contracts/ContractEditor.tsx',
  'src/components/contracts/ContractDetail.tsx',
  'src/components/billing/quotes/QuotesPage.tsx',
  'src/components/billing/quotes/QuoteEditor.tsx',
  'src/components/alerts/CorrelatedAlertGroups.tsx',
  'src/components/integrations/SecurityIntegration.tsx',
  // QuickBooks entity mapping workbench: confirm/create/unlink/sync decisions
  // and the income-account save all mutate a partner's accounting linkage —
  // a bare fetchWithAuth here would silently fail a mapping the operator
  // believes was saved.
  'src/components/integrations/QuickbooksMappingWorkbench.tsx',
  'src/components/devices/DeviceVulnerabilitiesTab.tsx',
  'src/components/vulnerabilities/VulnerabilityFleetPage.tsx',
  'src/components/vulnerabilities/SoftwareGroupDrawer.tsx',
  'src/components/vulnerabilities/CveDrawer.tsx',
  'src/components/vulnerabilities/CreateVulnTicketModal.tsx',
  'src/components/vulnerabilities/VulnBulkActionModal.tsx',
  'src/lib/api/vulnerabilities.ts',
  'src/components/settings/TdSynnexEcExpressPanel.tsx',
  'src/components/settings/PartnerServicePrincipalsPage.tsx',
  'src/components/settings/TdSynnexSftpPanel.tsx',
  'src/lib/edr.ts',
  'src/lib/incidents.ts',
  'src/lib/intentApprovals.ts',
  'src/components/approvals/ApprovalsInbox.tsx',
  'src/pages/approvals.astro',
  'src/components/devices/DeviceEdrPanel.tsx',
  'src/components/security/S1ThreatList.tsx',
  'src/components/security/HuntressIncidentList.tsx',
  // Ticket intake/creation: both already route every mutation through
  // runAction, but were never guarded, so a future bare mutation would have
  // shipped with zero CI signal while sibling ticket files stayed covered (#2429).
  'src/components/settings/TicketFormsCard.tsx',
  'src/components/tickets/CreateTicketPage.tsx',
  // Quotes/proposals + contracts send-polish surface: every mutation already
  // routes through runAction (or a typed API wrapper), but these files were
  // never guarded, so a future bare mutation would ship with no CI signal.
  'src/components/billing/quotes/QuoteActions.tsx',
  // Accept on behalf (spec 2026-09-21): the dialog lives in its own file
  // because QuoteActions.tsx is already 1551 lines. It issues an invoice — a
  // silent failure here is a tech who believes a deal is closed and is not.
  'src/components/billing/quotes/AcceptOnBehalfDialog.tsx',
  // Decline on behalf (#6634): a silent failure leaves the quote open while the
  // tech believes the customer's "no" is on record.
  'src/components/billing/quotes/DeclineOnBehalfDialog.tsx',
  // Evidence attach/replace for an on-behalf acceptance (#6633): its own
  // upload mutation, guarded from birth alongside its sibling dialog.
  'src/components/billing/quotes/AcceptanceEvidenceControl.tsx',
  'src/components/billing/quotes/QuoteDocument.tsx',
  // W03 moved these three into the /agreements area; ContractDocumentsSection
  // was deleted (contract detail now embeds SignedAgreementsPage).
  'src/components/agreements/AgreementTemplateEditor.tsx',
  'src/components/agreements/SignedAgreementsPage.tsx',
  'src/components/agreements/TemplatesPage.tsx',
  'src/components/settings/PartnerCompanyTab.tsx',
  // DR plan create/edit + BMR token create (#6495): the DR plan editor's
  // multi-request save (plan write + per-group writes/removals) and the BMR
  // recovery token create both closed silently on success and toasted nothing
  // on failure beyond an inline banner the operator could miss.
  'src/components/dr/DRPlanEditor.tsx',
  'src/components/backup/RecoveryBootstrapTab.tsx',
  // Invoice/quote money-moment hosts (issue / send / delete / title / line
  // mutations): every mutation already routes through runAction, but the files
  // sat outside the guarded set — a future bare mutation on the highest-stakes
  // billing surfaces would have shipped with zero CI signal (PR #2829 review).
  'src/components/billing/InvoiceActions.tsx',
  'src/components/billing/quotes/QuoteHeaderMeta.tsx',
  'src/components/billing/quotes/QuoteLineRows.tsx',
  // Config-policy delete migrated to runAction (#2950). Its confirmation modal
  // is a fixed full-screen overlay that stays open on failure, so the old
  // page-level error banner was painted behind the scrim — an unrecoverable
  // silent failure, not merely an unguarded one.
  'src/components/configurationPolicies/ConfigurationPoliciesPage.tsx',
  // #3531: destructive confirmations whose failures rendered behind the z-50 modal.
  'src/components/settings/ApiKeysPage.tsx',
  'src/components/admin/QuarantinedDevices.tsx',
  'src/components/automations/AutomationsPage.tsx',
  // #5313: create-monitor and site-edit saves confirmed nothing on 2xx.
  'src/components/monitors/NetworkCheckConversionBanner.tsx',
  'src/components/monitors/NetworkMonitorList.tsx',
  'src/components/monitors/MonitorDetailModal.tsx',
  'src/components/settings/SiteDetailPage.tsx',
  'src/components/automations/PoliciesPage.tsx',
  // #3531 sweep: the same hidden-failure pattern (destructive action behind an
  // open overlay, or console-only failure) found outside the original four.
  'src/components/auditBaselines/BaselineList.tsx',
  'src/components/remote/RemoteToolsPage.tsx',
  'src/components/discovery/NetworkBaselinesPanel.tsx',
  'src/components/sensitiveData/PoliciesTab.tsx',
  'src/components/settings/EnrollmentKeyManager.tsx',
  'src/components/settings/UsersPage.tsx',
  'src/components/webhooks/WebhooksPage.tsx',
  // Quick Support: the create/end mutations mint and revoke live remote-access
  // codes, so a silent failure would leave a tech reading out a dead code or
  // believing a session was torn down when it wasn't.
  'src/components/remote/QuickSupportPage.tsx',
  // PSA connections: create/update/delete/status/test all mutate stored PSA
  // credentials or a live connection's state. They were rewritten with bare
  // fetchWithAuth + setError, which the page's error banner only renders when
  // the connection list is empty — so a failed save on a populated page was
  // silent (#3291 review).
  'src/components/psa/PsaConnectionsPage.tsx',
  // CIS hardening: the whole directory has exactly two mutations (baseline
  // create/update, trigger scan) and both now route through runAction. The scan
  // queues work that changes nothing on screen — the results land minutes later
  // on another tab — so before the migration a queued scan and a no-op looked
  // identical to the tech.
  'src/components/cisHardening/CisBaselineForm.tsx',
  'src/components/cisHardening/CisBaselinesTab.tsx',
  // PSA company import (#3246): the commit creates organizations and sites in
  // the partner's tenant tree from a remote list. A silent failure would leave
  // the tech believing a tenant tree was provisioned when nothing was written.
  'src/components/psa/PsaCompanyImport.tsx',
  // Contact CSV import (#3258 W04): preview is advisory, but the commit writes
  // customer PII across a whole organization in one click. The preview table is
  // listed alongside its host because this guard's TARGET_GLOBS is a literal
  // file list, not directory-wide.
  'src/components/organizations/BulkContactImport.tsx',
  'src/components/organizations/ContactImportPreviewTable.tsx',
  // Contact CRUD (#3258 W04): create/update/delete write customer PII, and a
  // silent failure would leave a tech believing a contact was filed.
  'src/components/settings/ContactsCard.tsx',
  // Fleet findings: the lifecycle PATCH (acknowledge/dismiss/reopen) lives in
  // the service, and the two components must not grow their own bare mutations
  // alongside it.
  'src/services/fleetFindings.ts',
  'src/components/fleet/FindingsFeed.tsx',
  'src/components/fleet/FindingDrawer.tsx',
  'src/components/fleet/FixPickerModal.tsx',
  'src/components/fleet/RunProgressPanel.tsx',
  // SSO providers (2026-08-28 pre-release sweep): save already routed through
  // runAction but with no successMessage, while delete and the status toggle
  // bypassed runAction entirely — create/save/delete/toggle all succeeded at
  // the API with no visible confirmation to the admin.
  'src/components/settings/SsoProvidersPage.tsx',
  // Report builder (2026-08-28 pre-release sweep): the create/update POST/PUT
  // returned 201/200 with zero feedback — no toast, redirect, or form reset —
  // so a slow response invited a duplicate-creating double click. The mount at
  // /reports/builder passed no onSubmit, the only success path.
  'src/components/reports/ReportBuilder.tsx',
  // Business reports (#3198 W03): the curated-template create POST is the only
  // mutation in this file and it is runAction-wrapped. A partner-wide create
  // that 403s on the all-organizations access gate must never look identical
  // to one that succeeded.
  'src/components/reports/ReportTemplates.tsx',
  // QuickBooks connection panel (Phase D): connect/disconnect/push-mode/settings
  // -refresh already routed through runAction, but the file was never guarded —
  // so the pull-payments PATCH and the "Sync now" enqueue would have shipped
  // unguarded next to them. A silent failure on either reads as "payment sync
  // is on / a sync is running" while the books and Breeze quietly diverge.
  'src/components/integrations/QuickbooksIntegration.tsx',
  // Partner trust action links approve or suspend an entire partner. Keep the
  // TOTP-confirmed mutation inside runAction so this high-impact result cannot
  // fail without operator feedback.
  'src/components/admin/TrustActionPage.tsx',
  // Partner trust queue actions promote, restrict, or irreversibly suspend a
  // partner. Every POST must retain runAction feedback for the operator.
  'src/components/admin/TrustQueue.tsx',
  // Configuration-policy assignments (pre-release sweep, paper cut): the
  // assign/unassign mutations here were bare fetchWithAuth calls with no
  // toast — a failed assign or unassign looked identical to a successful one.
  'src/components/configurationPolicies/AssignmentsTab.tsx',
  // #4767 — Stop / Force-stop wires the long-dormant cancel endpoint to the UI
  // for the first time. A bare fetchWithAuth here would silently no-op a
  // Force-stop click, which is exactly the "did it work?" ambiguity runAction
  // exists to remove.
  'src/components/scripts/ExecutionHistory.tsx',
  'src/components/scripts/ExecutionDetails.tsx',
  'src/components/scripts/ScriptExecutionsPage.tsx',
  // #4767 review — Cancel run's own POST /automations/runs/:runId/cancel
  // lives inside this component (it has no owning page-level fetch layer),
  // so it needs the same guard as the scripts-side files above.
  'src/components/automations/AutomationRunHistory.tsx',
  // #3257: the RMM custom-field importer. Every preview and commit POST is a
  // multi-tenant write of customer data with a partial-success body — exactly
  // the class this guard exists for, and the class where a silent failure
  // looks identical to "nothing matched".
  'src/components/devices/RmmCustomFieldImport.tsx',
  'src/components/devices/CustomFieldDefinitionImportStep.tsx',
  'src/components/devices/CustomFieldValueImportStep.tsx',
  // Manual asset add/edit modal (#4622 W04): create/update/link/unlink all
  // carry requireMfa() on the API side, so a bare fetchWithAuth here would
  // silently swallow the common MFA_REQUIRED case with no operator feedback.
  'src/components/devices/ManualAssetModal.tsx',
  // #5213 W02 — the manual-network-asset create form. Its POST /devices/network
  // is a brand-new mutation surface; a bare fetchWithAuth here would silently
  // no-op the operator's "Add network asset" submit.
  'src/components/devices/AddNetworkAssetModal.tsx',
  // Script proposal request-changes/promote (#5612 W03): both mutations are
  // runAction-wrapped in this module so no caller — the approval card, the
  // inbox, or a future surface — can invoke them unwrapped.
  'src/lib/api/scriptProposals.ts',
  // Script authoring settings (#5612 W05 Tasks 23-24): both the org and
  // partner ceiling PUTs, and the lane reset POST, decide whether scripts run
  // against customer machines unattended — a silent failure here would leave
  // an operator believing the lane is off (or on) when it is not.
  'src/components/settings/ScriptAuthoringPage.tsx',
  // Fleet Designer W03 (#5653): starting a design run and the apply/rollback
  // flow write configuration policies and device groups against a customer's
  // fleet — a silent failure here reads as "applied" while nothing landed.
  'src/components/fleetDesign/FleetDesignPage.tsx',
  'src/components/fleetDesign/ApplyDrawer.tsx',
  // Monitor Activity tab (#5287 W03 / #5290): the escalation Reset button is
  // this file's only mutation, and a silent failure here would leave a tech
  // believing responses resumed and the recurrence counter cleared when they
  // did not.
  'src/components/monitoring/MonitorActivityTab.tsx',
  // Network device page truth W04 (#5992): single writer for asset-scoped mutations.
  'src/components/devices/networkDevice/settings/useNetworkAssetMutations.ts',
  // Monitor editor + deploy dialog (sweep G1-4): save/delete already routed
  // through runAction, but attach/detach were bare fetchWithAuth calls — a
  // failed detach was silent and a successful one gave no feedback.
  'src/components/monitoring/MonitorEditor.tsx',
  'src/components/monitoring/DeployMonitorDialog.tsx',
  // #4050 (deferred from #4018 / PR #4041): the account-security surface — MFA
  // enable/disable, recovery-code rotation, passkey register/rename/delete, SSO
  // re-auth, password and avatar changes. Every mutation here already reports
  // its outcome, but through section-scoped inline banners rather than
  // runAction, so each existing call site carries a reasoned
  // `runaction-exempt:` marker. The point of guarding the file is the NEXT
  // mutation: without an entry here, a bare fetchWithAuth added beside them
  // ships with zero CI signal on the one page where a silently-failed
  // "Disable MFA" or "Delete passkey" is a security-posture lie.
  'src/components/settings/ProfilePage.tsx',
  // Partner sending domains W05: the client module holds every mutation for the
  // custom-sender-address surface (add / check / remove / identity upsert and
  // clear / test send), each already wrapped in runAction. Guarding the file is
  // about the NEXT mutation — a bare fetchWithAuth added beside them would
  // silently fail on the surface that decides what address a partner's
  // customers see mail from, and would also un-guard every caller, because
  // isMutatingApiWrapper only clears a caller while the wrapper stays wrapped.
  'src/lib/api/sendingDomains.ts',
  // The tab itself has no fetchWithAuth today — it goes through the client
  // above — and is listed so a future direct mutation cannot be added here
  // without CI noticing. TARGET_GLOBS is a literal file list, not directory-wide.
  'src/components/settings/PartnerSendingDomainTab.tsx',
  // Restore-as-VM wizard (bare-metal W05a): the one POST now fans out to three
  // engines (Hyper-V full, instant boot, Linux rebuild → VHDX) through
  // runAction; a bare fetchWithAuth added for a fourth would silently swallow
  // a restore that never started.
  'src/components/backup/VMRestoreWizard.tsx',
  // #6263 W01: these three were built but mounted on no page. /security/scans
  // makes them reachable, so their mutations join the adopted set.
  'src/components/security/SecurityScanManager.tsx',
  'src/components/security/ThreatList.tsx',
  'src/components/security/ThreatDetail.tsx',
  // Alert workflows typed filter (#6367 W05c2 Task 9): the save handler now
  // wraps its create/update POST/PUT in runAction — a silent failure here is
  // a tech believing a workflow's severity/kind restriction is live when the
  // save never landed.
  'src/components/automations/AutomationEditPage.tsx',
  // Device Monitoring tab (#6367 W05c2 Task 10): the escalation reset POST.
  'src/components/devices/DeviceMonitoringTab.tsx',
  // Library Recommended strip (#6367 W05c2 Task 13): the feature-link write
  // that attaches built-ins to a policy.
  'src/components/monitoring/RecommendedMonitors.tsx',
  // Backup provider integration (W03, #6011): these three write partner-level
  // connector credentials and the customer→org mapping that decides whose
  // backup data lands in whose tenant. A silent failure here is invisible until
  // a customer's devices quietly stop appearing.
  'src/components/integrations/BackupProvidersIntegration.tsx',
  'src/components/integrations/BackupProviderConnectionCard.tsx',
  'src/components/integrations/BackupProviderCustomerMapping.tsx',
  // Device-tab external backup (W03, #6011): Unlink detaches a provider row
  // from a Breeze device; a silent failure leaves the tech believing the link
  // is gone while alerts keep firing against it.
  'src/components/backup/ExternalBackupCard.tsx',
];

const absoluteFiles: string[] = TARGET_GLOBS.map((rel) => resolve(WEB_ROOT, '..', rel));
const allowAbsolute = new Set(RUN_ACTION_ALLOWLIST.map((a) => resolve(REPO_ROOT, a.file)));

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type Violation = { line: number; snippet: string };
type TypeAwareContext = {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  apiRoot: string;
};

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/**
 * Classify the options argument of a fetchWithAuth call.
 * Returns true if the call is (or might be) a mutation. Conservative: a
 * non-string-literal `method`, a `{ method }` shorthand, a spread with no
 * explicit safe method, or a non-object options arg all count as mutating.
 */
function isMutatingCall(call: ts.CallExpression): boolean {
  const optionsArg = call.arguments[1];
  if (!optionsArg) return false; // single-arg fetchWithAuth(url) === GET

  if (!ts.isObjectLiteralExpression(optionsArg)) {
    // fetchWithAuth(url, opts) — opts could carry any method. Flag it.
    return true;
  }

  let sawSpread = false;
  for (const prop of optionsArg.properties) {
    if (ts.isSpreadAssignment(prop)) {
      sawSpread = true;
      continue;
    }
    const name =
      prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
        ? prop.name.text
        : null;
    if (name !== 'method') continue;

    if (ts.isShorthandPropertyAssignment(prop)) return true; // { method }
    if (ts.isPropertyAssignment(prop)) {
      const init = prop.initializer;
      if (ts.isStringLiteralLike(init)) {
        const verb = init.text.toUpperCase();
        if (SAFE_METHODS.has(verb)) return false;
        return MUTATING_METHODS.has(verb) ? true : true; // any explicit non-safe verb → flag
      }
      // method: opts.method / cond ? 'PATCH' : 'POST' / `${x}` — can't prove safe.
      return true;
    }
  }
  // No explicit `method`. A spread might inject one → conservative flag;
  // otherwise it defaults to GET (safe).
  return sawSpread;
}

function isWrappedByRunAction(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isCallExpression(cur) && calleeName(cur.expression) === 'runAction') return true;
    cur = cur.parent;
  }
  return false;
}

function resolvedSymbolAt(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  const seen = new Set<ts.Symbol>();
  while (symbol && symbol.flags & ts.SymbolFlags.Alias && !seen.has(symbol)) {
    seen.add(symbol);
    const target = checker.getAliasedSymbol(symbol);
    if (target === symbol) break;
    symbol = target;
  }
  return symbol;
}

function isInside(root: string, file: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedFile = resolve(file);
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}${sep}`);
}

/** Whether an imported lib/api export's implementation issues a mutation. */
function isMutatingApiWrapper(call: ts.CallExpression, context: TypeAwareContext): boolean {
  const symbol = resolvedSymbolAt(call.expression, context.checker);
  if (!symbol) return false;

  return (symbol.declarations ?? []).some((declaration) => {
    if (!isInside(context.apiRoot, declaration.getSourceFile().fileName)) return false;

    let mutates = false;
    const visit = (node: ts.Node): void => {
      if (mutates) return;
      if (
        ts.isCallExpression(node) &&
        calleeName(node.expression) === 'fetchWithAuth' &&
        isMutatingCall(node) &&
        !isWrappedByRunAction(node) &&
        !isExempt(declaration.getSourceFile().text, node)
      ) {
        mutates = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration);
    return mutates;
  });
}

function enclosingStatementStart(node: ts.Node): number {
  let cur: ts.Node = node;
  while (
    cur.parent &&
    !ts.isBlock(cur.parent) &&
    !ts.isSourceFile(cur.parent) &&
    !ts.isModuleBlock(cur.parent) &&
    !ts.isCaseClause(cur.parent) &&
    !ts.isDefaultClause(cur.parent)
  ) {
    cur = cur.parent;
  }
  return cur.getFullStart();
}

function isExempt(src: string, node: ts.Node): boolean {
  // Any `runaction-exempt` marker in the trivia/text between the start of the
  // enclosing statement and the call itself counts. Robust to exact comment
  // attribution (leading-comment-range edge cases) and to the for-loop case.
  const from = enclosingStatementStart(node);
  const window = src.slice(from, node.getStart());
  return /runaction-exempt/i.test(window);
}

function findViolations(
  src: string,
  label = 'sample.tsx',
  context?: TypeAwareContext,
): Violation[] {
  const sf = context?.sourceFile ??
    ts.createSourceFile(label, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const directMutation =
        calleeName(node.expression) === 'fetchWithAuth' && isMutatingCall(node);
      const wrapperMutation = Boolean(context && isMutatingApiWrapper(node, context));
      if (
        (directMutation || wrapperMutation) &&
        !isWrappedByRunAction(node) &&
        !isExempt(src, node)
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        violations.push({
          line: line + 1,
          snippet: node.getText(sf).replace(/\s+/g, ' ').slice(0, 120),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

// ─── Self-check: the analyzer itself has teeth ──────────────────────────────
describe('guard self-checks (AST analyzer)', () => {
  it('flags a bare mutating call not wrapped by runAction', () => {
    expect(findViolations(`fetchWithAuth('/x', { method: 'POST', body: '{}' });`)).toHaveLength(1);
  });

  it('does NOT flag a call wrapped by runAction', () => {
    const src = `runAction({ request: () => fetchWithAuth('/x', { method: 'POST' }), errorFallback: 'e' });`;
    expect(findViolations(src)).toHaveLength(0);
  });

  it('does NOT flag a GET (explicit or single-arg)', () => {
    expect(findViolations(`fetchWithAuth('/x', { method: 'GET' });`)).toHaveLength(0);
    expect(findViolations(`fetchWithAuth('/x');`)).toHaveLength(0);
    expect(findViolations(`fetchWithAuth('/x', { headers: { a: '1' } });`)).toHaveLength(0);
  });

  it('flags a non-literal method (the old regex missed `{ method: opts.method }`)', () => {
    expect(findViolations(`fetchWithAuth(u, { method: opts.method, body: b });`)).toHaveLength(1);
  });

  it('flags a shorthand `{ method }` (old regex missed it)', () => {
    expect(findViolations(`const method='PUT'; fetchWithAuth(u, { method });`)).toHaveLength(1);
  });

  it('flags a parenthesised-URL mutation (old `[^)]*` regex could not cross `)`)', () => {
    expect(findViolations('fetchWithAuth(`/x/${build(id)}`, { method: \'DELETE\' });')).toHaveLength(1);
  });

  it('flags a non-object options arg conservatively', () => {
    expect(findViolations(`fetchWithAuth(u, opts);`)).toHaveLength(1);
  });

  it('honours an explicit runaction-exempt marker on the enclosing statement', () => {
    const src = `// runaction-exempt: aggregate\nconst r = await fetchWithAuth('/x', { method: 'POST' });`;
    expect(findViolations(src)).toHaveLength(0);
  });

  it('honours a runaction-exempt marker inside a for-loop body', () => {
    const src = `for (const id of ids) {\n  // runaction-exempt: inline UI\n  const r = await fetchWithAuth(\`/x/\${id}\`, { method: 'POST' });\n}`;
    expect(findViolations(src)).toHaveLength(0);
  });

  it('still flags a NEW bare mutation added next to existing runAction usage (the realistic regression)', () => {
    const src = `
      await runAction({ request: () => fetchWithAuth('/a', { method: 'POST' }), errorFallback: 'e' });
      await fetchWithAuth('/sneaky', { method: 'DELETE' });
    `;
    // The file "contains runAction" — the OLD substring check passed this.
    const v = findViolations(src);
    expect(v).toHaveLength(1);
    expect(v[0].snippet).toContain('/sneaky');
  });

  it('allowlisted path is present in the allowlist Set', () => {
    const entry = RUN_ACTION_ALLOWLIST[0];
    expect(entry).toBeDefined();
    expect(allowAbsolute.has(resolve(REPO_ROOT, entry.file))).toBe(true);
  });

  it('flags an imported typed mutation wrapper through aliases and API re-exports', () => {
    const componentPath = resolve(FIXTURE_ROOT, 'components/QuoteActions.tsx');
    const apiRoot = resolve(FIXTURE_ROOT, 'lib/api');
    const program = ts.createProgram({
      rootNames: [componentPath],
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    });
    const sourceFile = program.getSourceFile(componentPath);
    expect(sourceFile).toBeDefined();
    expect(
      findViolations(sourceFile!.text, componentPath, {
        sourceFile: sourceFile!,
        checker: program.getTypeChecker(),
        apiRoot,
      }),
    ).toHaveLength(1);
  });
});

// ─── Backlog integrity check ─────────────────────────────────────────────────
describe('migration backlog integrity', () => {
  it('backlog is non-empty (debt is tracked)', () => {
    expect(RUN_ACTION_MIGRATION_BACKLOG.length).toBeGreaterThan(0);
  });

  it('every backlog entry is a string path under apps/web/src/', () => {
    for (const entry of RUN_ACTION_MIGRATION_BACKLOG) {
      expect(typeof entry).toBe('string');
      expect(entry.startsWith('apps/web/src/')).toBe(true);
    }
  });
});

// ─── Main guard ─────────────────────────────────────────────────────────────
describe('no silent mutations in targeted set', () => {
  const configPath = resolve(WEB_ROOT, '..', 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  // .astro files aren't a script kind the TS compiler recognizes, so it never
  // includes them in the program — only feed it files TS can natively parse
  // (.ts/.tsx). Anything else (e.g. .astro) falls back to the legacy
  // no-program, no-wrapper-resolution scan below.
  const TS_NATIVE_EXTENSIONS = new Set(['.ts', '.tsx']);
  const programFiles = absoluteFiles.filter((f) => TS_NATIVE_EXTENSIONS.has(extname(f)));
  const program = ts.createProgram({ rootNames: programFiles, options: parsedConfig.options });
  const checker = program.getTypeChecker();

  it('finds files to scan', () => {
    // 106: 99 since #3989 added OrganizationsPage.tsx, plus MergeOrgModal.tsx
    // (org-lifecycle Wave 3), plus ArchiveOrgModal.tsx (org-lifecycle Wave 5),
    // plus SsoProvidersPage.tsx and ReportBuilder.tsx (2026-08-28 pre-release sweep),
    // plus AlertVerdictBadge.tsx (P2-1 Task 15), plus
    // AiAgentSchedulesSection.tsx (P2-2 Task 13, #4189), plus
    // QuickbooksMappingWorkbench.tsx (QuickBooks entity mapping, Task 6), plus
    // ImpactPage.tsx (P2-6 Task 10, #4193), plus ImpactWeightsDrawer.tsx
    // (P2-6 Task 11, #4193), plus AccountingSyncCard.tsx (QuickBooks invoice
    // push, Phase C Task 7), plus QuickbooksIntegration.tsx (QuickBooks payment
    // pull-back, Phase D Task 7 — the pull-payments PATCH and the "Sync now"
    // enqueue joined four pre-existing unguarded mutations in that file), plus
    // AiAgentGraduationPanel.tsx (P2-5 Task 20, #4192). ApprovalsInbox.tsx was
    // already guarded before P2-5 — Task 21's promote mutation needed no list
    // edit. Also plus BulkContactImport.tsx, ContactImportPreviewTable.tsx and
    // ContactsCard.tsx (#3258 W04, the contacts tab and its CSV importer), plus
    // TrustActionPage.tsx (partner trust probation, #4549 — the TOTP-confirmed
    // approve/suspend action), plus TrustQueue.tsx (partner trust probation,
    // #4549 W07 — the admin trust queue page's approve/suspend actions).
    // NOTE: merge-base held 108; this branch added 1 (TrustActionPage.tsx) and
    // main added 3 in parallel, so the true merged count was 113. A prior
    // commit added 1 more (TrustQueue.tsx) to reach 114. A prior commit added 1
    // more (AssignmentsTab.tsx) to reach 115. A prior commit added 3 more
    // (#4767 — ExecutionHistory.tsx, ExecutionDetails.tsx,
    // ScriptExecutionsPage.tsx) to reach 118. This commit adds 1 more
    // (AutomationRunHistory.tsx), so the count was 119. Task 13 (#5051) adds
    // 1 more (AgentCreateFlow.tsx), so the count is now 120 — bump it
    // deliberately on every merge, never by resolving the hunk.
    // #4622 W04 adds ManualAssetModal.tsx and #5213 W02 adds
    // AddNetworkAssetModal.tsx, so the count is now 125. #5612 W03 adds
    // lib/api/scriptProposals.ts (request-changes + promote), so the count is
    // now 126. #5612 W05 Tasks 23-24 add ScriptAuthoringPage.tsx, so the
    // count is now 127. Fleet Designer W02 (#5652) adds
    // devices/DeviceFunctionField.tsx, so the count is now 128. Fleet
    // Designer W03 (#5653) adds fleetDesign/FleetDesignPage.tsx and
    // fleetDesign/ApplyDrawer.tsx, so the count was 130. Account board (W02,
    // #5723) replaces the deleted OrganizationsPage.tsx entry with two files
    // (OrganizationsBoardPage.tsx, useManualOrder.ts), so the count is now 131.
    // Monitor Activity tab (#5287 W03 / #5290) adds MonitorActivityTab.tsx, so
    // the count is now 132. Agreements W03 (#5825) moves three contracts files
    // into components/agreements/ and DELETES ContractDocumentsSection.tsx
    // (contract detail embeds the shared list instead), so the count is 131.
    // Execution plane W05 (#5716) adds two adopters (AiRunCard attach-to-ticket
    // and the per-org external-processing switch), so the count is 133.
    // Tool catalog W01 PR C (#5216) took the count to 138; sweep G1-4 added
    // MonitorEditor.tsx and DeployMonitorDialog.tsx (140); network device page
    // truth W04 (#5992) adds the network asset single writer: 140 → 141.
    // Network device page truth W05 adds the probe hook: 141 → 142.
    // #4050 adds settings/ProfilePage.tsx (account security): 142 → 143.
    // Partner sending domains W05 adds lib/api/sendingDomains.ts and
    // settings/PartnerSendingDomainTab.tsx: 143 → 145.
    // W01 settings consolidation (#6224): PartnerBillingSettings.tsx ->
    // PartnerBillingSettingsPage.tsx (net 0) then + CatalogDefaultsCard.tsx:
    // 145 → 146.
    // Bare-metal W05a adds backup/VMRestoreWizard.tsx (rebuild engine): 146 → 147.
    // Outbound email templates (PR1 settings UI) add EmailTemplatesTab.tsx
    // and EmailTemplateEditor.tsx: 147 → 149.
    // Disk Cleanup v2 W01 adds DeviceFilesystemTab.tsx: 149 → 150.
    // Work types (#4628 W01) add WorkTypesCard.tsx: 150 → 151.
    // Disk Cleanup v2 W03 adds filesystem/CleanupPanel.tsx: 151 → 152.
    // Disk Cleanup v2 W04 adds filesystem/SystemCleanupPanel.tsx: 152 → 153.
    // Billing profiles W02 adds Rates and the org assignment writer: 153 → 155.
    // DR plan / BMR token create (#6495) adds DRPlanEditor.tsx and
    // RecoveryBootstrapTab.tsx: 155 → 157.
    // #6263 W01 adds SecurityScanManager.tsx, ThreatList.tsx, ThreatDetail.tsx: 157 → 160.
    // Accept on behalf adds quotes/AcceptOnBehalfDialog.tsx: 160 → 161.
    // Decline on behalf (#6634) adds quotes/DeclineOnBehalfDialog.tsx: 161 → 162.
    // Accept-on-behalf evidence (#6633) adds quotes/AcceptanceEvidenceControl.tsx: 162 → 163.
    // Metric anomaly episodes W04 adds devices/AnomalyEpisodeCard.tsx: 163 → 164.
    // Business reports (#3198 W03) add reports/ReportTemplates.tsx: 164 → 165.
    // Alerting W05c2 adopts the shared feature-link mutation hook: 165 → 166.
    // W05c2 adds NeedsConversionPanel, ConversionPendingBanner, MonitorConversionAdmin: 166 → 169.
    // Persistent conversion history adds ConversionLedger (Undo): 169 → 170.
    // LegacyRulesTable (per-rule convert) joins the guard: 170 → 171.
    // Alert workflows typed filter (W05c2 Task 9) adds automations/AutomationEditPage.tsx: 171 → 172.
    // W05c2 Tasks 10 + 13 add devices/DeviceMonitoringTab.tsx and monitoring/RecommendedMonitors.tsx: 172 → 174.
    // #3531 adds ApiKeysPage, QuarantinedDevices, AutomationsPage, PoliciesPage: 174 → 178.
    // #3531 sweep adds BaselineList, RemoteToolsPage, NetworkBaselinesPanel,
    // sensitiveData/PoliciesTab, EnrollmentKeyManager, UsersPage, WebhooksPage: 178 → 185.
    // Backup provider integration (W03 #6011) adds three adopters: 185 → 188.
    // 188 -> 189: ExternalBackupCard.tsx (W03 Task 12, #6011) added to TARGET_GLOBS.
    // #5313 adds monitors/CreateMonitorForm.tsx and settings/SiteDetailPage.tsx: 189 → 191.
    // Network results replace the deleted create form with three mutation adopters: 191 → 193.
    expect(absoluteFiles.length).toBe(193);
    for (const f of absoluteFiles) {
      expect(() => statSync(f)).not.toThrow();
    }
  });

  it('lists every guarded file exactly once', () => {
    // A duplicated entry inflates the count above without adding coverage: the
    // file is scanned twice and the next person to bump the counter inherits an
    // off-by-one that is invisible unless they dedupe the list by hand. Assert
    // it mechanically instead, and name the offenders so the fix is obvious.
    const seen = new Set<string>();
    const duplicates = TARGET_GLOBS.filter((rel) => {
      if (seen.has(rel)) return true;
      seen.add(rel);
      return false;
    });
    expect(duplicates).toEqual([]);
    expect(seen.size).toBe(absoluteFiles.length);
  });

  for (const absPath of absoluteFiles) {
    const webRelLabel = absPath.startsWith(WEB_ROOT) ? 'src' + absPath.slice(WEB_ROOT.length) : absPath;
    if (allowAbsolute.has(absPath)) continue; // whole-file allowlisted — skip

    it(`${webRelLabel}: every mutating fetchWithAuth is wrapped by runAction or explicitly exempt`, () => {
      const sourceFile = program.getSourceFile(absPath);
      // Files the TS compiler doesn't natively parse (e.g. .astro) are never
      // in the program — fall back to the legacy standalone-parse scan
      // (direct fetchWithAuth calls only, no lib/api wrapper resolution).
      const violations = sourceFile
        ? findViolations(sourceFile.text, webRelLabel, { sourceFile, checker, apiRoot: API_ROOT })
        : findViolations(readFileSync(absPath, 'utf8'), webRelLabel);
      expect(
        violations,
        violations.length
          ? `Silent mutation(s) in ${webRelLabel}:\n` +
              violations.map((v) => `  L${v.line}: ${v.snippet}`).join('\n') +
              `\nWrap in runAction(), or add "// runaction-exempt: <reason>" if it is a ` +
              `legitimate aggregate/inline-feedback handler.`
          : undefined
      ).toEqual([]);
    });
  }
});

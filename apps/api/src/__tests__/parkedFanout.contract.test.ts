/**
 * CONTRACT TEST — background selectors leave parked devices out.
 *
 * A device parked in its partner's holding org (`organizations.type =
 * 'unassigned_pool'`) is not managed yet: no scheduled job, worker, partner-wide
 * fan-out or AI device lookup may select it, and nothing may raise offline
 * alerts, notifications or tickets for it. Command delivery refuses it anyway
 * (parkedCommandDelivery.contract.test.ts); this contract is the layer in
 * front of that, so a parked device never becomes a failed job, a Sentry event
 * or a vendor/LLM call either.
 *
 * Discovery (comments stripped first), over non-test files:
 *   - every file under jobs/ that reads the devices table
 *     (`.from(devices)`, `innerJoin(devices`, `leftJoin(devices`, `FROM devices`);
 *   - every file under jobs/ or services/ that carries a Quick Support or
 *     ephemeral-device exclusion (`eq(devices.isEphemeral, false)`,
 *     `'quick_support'`, `excludeQuickSupportOrgs(`, `excludeEphemeralDevices(`,
 *     `isQuickSupportOrgType(`, `isQuickSupportOrg(`, and the hidden-org
 *     visibility helpers `notHiddenOrgType(` / `notInHiddenOrgCondition(` /
 *     `isHiddenOrgType(`) — those mark the places
 *     that already pick targets and exclude "not really our fleet" devices.
 *
 * Each discovered file must be in exactly one of:
 *   - FANOUT_MODULES — must reference a parked-device predicate
 *     (services/unassignedPool/selectorPredicate.ts, `isParkedDevice`,
 *     `isUnassignedPoolOrgType`, or `UNASSIGNED_POOL_ORG_TYPE`);
 *   - VISIBILITY_MODULES — listings, reports, read models and billing counts:
 *     what a human sees, not what runs. The holding org is kept out of every
 *     human org list; these are revisited with the visibility and billing work;
 *   - EXEMPT — with the reason the file cannot reach a parked device, or must
 *     (lifecycle removal and retention).
 * An unclassified file fails; a stale entry (file gone, or no longer
 * discovered and not a listed extra) fails.
 *
 * Plain unit test — reads the source tree only. The behavioural proof lives in
 * integration/parkedDeviceZeroDelivery.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { FANOUT_MODULES } from './parkedFanoutModules';

const SRC = resolve(import.meta.dirname, '..');
const EE = resolve(import.meta.dirname, '../../../../ee');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === '__snapshots__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/** `ee/...` paths resolve under the repo's ee/ tree; everything else under apps/api/src. */
function abs(file: string): string {
  return file.startsWith('ee/') ? join(EE, file.slice(3)) : join(SRC, file);
}

function read(file: string): string {
  return stripComments(readFileSync(abs(file), 'utf8'));
}

/**
 * A read of the devices table, through the Drizzle builder or raw SQL:
 * `.from(devices)`, `innerJoin(devices` (any join), `JOIN devices`,
 * `FROM devices`, and `${devices}` interpolations (with or without `schema.`).
 */
const DEVICE_READ = new RegExp([
  String.raw`\.from\(\s*(?:schema\.)?devices\s*\)`,
  String.raw`(?:inner|left|right|full)Join\(\s*(?:schema\.)?devices\b`,
  String.raw`\bJOIN\s+(?:public\.)?"?devices"?(?!\w)`,
  String.raw`\bFROM\s+(?:public\.)?"?devices"?(?!\w)`,
  String.raw`\$\{\s*(?:schema\.)?devices\s*\}`,
].join('|'), 'i');
const EXCLUSION_MARKERS = /eq\(\s*devices\.isEphemeral,\s*false\s*\)|'quick_support'|excludeQuickSupportOrgs\(|excludeEphemeralDevices\(|isQuickSupportOrgType\(|isQuickSupportOrg\(|notHiddenOrgType\(|notInHiddenOrgCondition\(|isHiddenOrgType\(/;
/**
 * One guard site: a call of a parked-device predicate or helper, or a use of
 * the org-type constant. Import lines are removed before counting.
 */
const GUARD_SITE = /\b(?:notParkedDeviceCondition|notInHoldingOrgCondition|notHoldingOrgCondition|isParkedDevice|isUnassignedPoolOrgType)\(|\bUNASSIGNED_POOL_ORG_TYPE\b/g;

function guardSites(file: string): number {
  const code = read(file).replace(/^import[\s\S]*?;\s*$/gm, '');
  return (code.match(GUARD_SITE) ?? []).length;
}

const rel = (f: string) => relative(SRC, f).replace(/\\/g, '/');
const JOB_FILES = walk(join(SRC, 'jobs')).map(rel);
const SERVICE_FILES = walk(join(SRC, 'services')).map(rel);
const EE_FILES = existsSync(EE) ? walk(EE).map((f) => `ee/${relative(EE, f).replace(/\\/g, '/')}`) : [];

/** Every background/service module that reads devices or carries a Quick Support/ephemeral exclusion. */
function discovered(): string[] {
  const hits = new Set<string>();
  for (const file of [...JOB_FILES, ...SERVICE_FILES, ...EE_FILES]) {
    const code = read(file);
    if (DEVICE_READ.test(code) || EXCLUSION_MARKERS.test(code)) hits.add(file);
  }
  return [...hits].sort();
}


/** What a human sees (listings, reports, read models, billing counts). */
const VISIBILITY_MODULES: Record<string, string> = {
  'services/accounting/accountingMappingService.ts': 'billing: accounting device counts',
  'services/archivedOrgReads.ts': 'listing: archived org reads',
  'services/backupHealthReadModel.ts': 'read model: backup health',
  'services/contractQuantities.ts': 'billing: contract quantities',
  'services/hardwareLifecycleReport.ts': 'report: hardware lifecycle',
  'services/partnerDeviceCapacity.ts': 'billing: partner device capacity',
  'services/portal/backupReadModel.ts': 'read model: portal backups',
  'services/portal/deviceReadModel.ts': 'read model: portal devices',
  'services/portal/securityReadModel.ts': 'read model: portal security',
  'services/reportGenerationService.ts': 'report: per-org report builders',
  'services/reportScope.ts': 'report: scope (already excludes the holding org)',
  'services/reportSeries/combine.ts': 'report: multi-org series Combine candidates, series-eligible orgs only (hidden org types excluded)',
  'services/reportSeries/reconcile.ts': 'report: multi-org series repair sweep, mirrors the targets.ts eligibility rule in SQL',
  'services/reportSeries/targets.ts': 'report: multi-org series target orgs (org-level report definitions, not devices; hidden org types excluded)',
  'services/securityComplianceReport.ts': 'report: security compliance',
  'services/backupProviders/mapping.ts': 'vendor-customer to org mapping: which org a backup customer is shown under; the holding org and Quick Support are never candidates',
  'services/timeSuggestionService.ts': 'billing: time suggestions',
  'jobs/patchComplianceReportWorker.ts': 'report: patch compliance summary for the requesting org',
  // --- examined device readers (jobs, services, ee) ---
  'services/aiAgentRunSiteScope.ts': 'site-allowlist filter for AI run listings shown to a person',
  'services/aiOriginSummary.ts': 'label for one command/execution a person is already viewing',
  'services/aiToolsAiAgentGovernance.ts': 'joins devices only to show hostnames on an AI run listing',
  'services/aiToolsCompliance.ts': 'compliance report joins; device-targeted actions go through the central device gate',
  'services/aiToolsDns.ts': 'joins devices only to show hostname on org-scoped DNS event/policy listings',
  'services/aiToolsHuntress.ts': 'joins devices only for hostname display on org-scoped incident/agent listings',
  'services/alertCorrelationRca.ts': 'human-facing root-cause read model for the alert correlation route',
  'services/automationReadProjection.ts': 'projects automation run history to a viewer\'s allowed sites',
  'services/drReadAuthorization.ts': 'request-path read filtering of DR plans/executions by site/device authority for a human caller',
  'services/endpointManagementReport.ts': 'org-scoped endpoint management report generation for a human reader',
  'services/fleetFindings/query.ts': 'list/detail query layer for the fleet findings feed shown to a human or read-only AI tool',
  'services/identityAccessReport.ts': 'per-org identity/sign-in evidence report for a single orgId supplied by caller',
  'services/managementPostureReport.ts': 'fleet management-posture report/drill-down; org narrowing supplied by the calling route',
  'services/metricAnomalyEpisodeQueries.ts': 'request-scoped episode reads keyed by caller\'s (orgId, deviceId); no fan-out',
  'services/monitors/episodeQueries.ts': 'read models scoped by auth.orgCondition/site/device axes for a human caller',
  'services/monitors/listServiceMonitors.ts': 'scopes candidates via auth.orgCondition/site/device axes, re-checks org access per row',
  'services/partnerTrustEvidenceCard.ts': 'review card for one partner, emailed to human admins; not an action selector',
  'services/patchInstallFailures.ts': 'per-patch failure counts for patch dashboards; RLS-scoped read, no action selection',
  'services/scriptProposals/queries.ts': 'Proposal detail read model for the UI; device ids derived from an org-scoped proposal row',
  'services/softwarePolicyInstallPreview.ts': 'Dry-run device count shown to the operator before confirming a fleet install',
  'services/ticketTriage.ts': 'Site-scoped read model/aggregate for ticket-triage quality stats',
  'services/topology/monitorOverlays.ts': 'Topology map health overlays for a human-scoped graph read',
  'services/topology/presentationGroups.ts': 'Grouped-overview read model for a human-scoped topology graph read: reads device status only to hide decommissioned agents; selects nothing to act on',
  'services/vulnerabilityFleetQueries.ts': 'Fleet triage UI fetch layer, RLS-scoped request read',
  'services/vulnerabilityFleetSql.ts': 'Fleet work-queue aggregation for the triage UI, RLS-scoped',
};

/**
 * Pattern classifications, for families of modules that share one reason.
 * Each pattern must match at least one discovered file.
 */
const EXEMPT_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /^services\/[A-Za-z]+Correlation\.ts$/,
    reason: 'per-org correlation passes over inventory; their org lists come from feature resolution, '
      + 'which leaves the holding org out, and a parked agent cannot submit inventory',
  },
];

function exemptByPattern(file: string): boolean {
  return EXEMPT_PATTERNS.some(({ pattern }) => pattern.test(file));
}

/** Cannot reach a parked device, or must (removal and retention). */
const EXEMPT: Record<string, string> = {
  'services/autopay/enrollmentLifecycle.ts': 'org payment lifecycle rejects hidden orgs; never reads devices or dispatches device work',
  'jobs/alertCorrelation.ts': 'acts only on alerts that already exist; alert creation leaves parked devices out',
  'jobs/backupRetention.ts': 'retention of existing snapshots, not target selection',
  'jobs/backupSlaWorker.ts': 'evaluates org-owned SLA configurations; the holding org owns none',
  'jobs/deviceBulkPurge.ts': 'lifecycle removal must reach every device',
  'jobs/deviceGroupJobs.ts': 'device groups are org-owned; the holding org has none',
  'jobs/dnsSyncJob.ts': 'syncs org-owned DNS integrations; the holding org owns none',
  'jobs/hardwareHealthRetention.ts': 'retention, not target selection',
  'jobs/huntressSync.ts': 'partner-scoped integration; devices are matched only inside orgs named by huntress_org_mappings, which only a person sets (PATCH /huntress/mappings, gated on canAccessOrg, never true for the holding org outside system scope)',
  'jobs/offlineDetector.ts': 'status transition only; its event and alert effects are gated in services/offlineEffectsStore.ts',
  'jobs/patchJobExecutor.ts': 'executes patch jobs already created for selected devices; command delivery refuses parked devices',
  'jobs/parkedDeviceExpiry.ts': 'lifecycle removal: expires parked devices past the parking window; must reach them',
  'jobs/parkedDevicePurge.ts': 'lifecycle removal: hard-purges expired parked devices; must reach them',
  'jobs/quickSupportReaper.ts': 'Quick Support session lifecycle',
  'jobs/removedDevicePurge.ts': 'lifecycle removal must reach every device',
  'jobs/s1Sync.ts': 'partner-scoped integration; devices are matched only inside orgs named by s1_org_mappings, which only a person sets through the SentinelOne mapping route',
  'jobs/staleCommandReaper.ts': 'lifecycle: reaps stale command rows',
  'jobs/ticketNotifyWorker.ts': 'reads the name of the one device already linked to an existing ticket (by id, within the ticket org) for the assignee email; selects no targets',
  'jobs/topologyCollectionRetentionWorker.ts': 'retention, not target selection',
  'jobs/userRiskJobs.ts': 'scores users, not devices; the holding org has no users',
  'services/aiToolsTicketing.ts': 'identity match pinned to the ticket\'s own org',
  'services/auditFallbackOrg.ts': 'request path: reads the org of the one device the request URL named, to file its audit row; not a selector',
  'services/auditOrgResolver.ts': 'resolves the org an audit row belongs to',
  'services/deviceOrgMove/moveDeviceOrgInTransaction.ts': 'request path: moves the one device its caller named, after that caller\'s own checks; not a selector',
  'services/monitors/networkCheckAlertDevice.ts': 'resolves a device inside the org chosen by networkCheckAlertSweep',
  'services/orgAccountReadiness.ts': 'org administration (holding org already guarded)',
  'services/orgArchive.ts': 'org administration (holding org already guarded)',
  'services/orgMerge.ts': 'org administration (holding org already guarded)',
  'services/quickSupportOrg.ts': 'defines the Quick Support helpers',
  'services/securityPosture.ts': 'per-org computation; the org list comes from securityPostureWorker',
  'services/filterEngine.ts': 'evaluates within one caller-supplied org; the holding org is never a caller org, and the holding-area listing will use it',
  'services/topology/originEligibility.ts': 'pinned to the calling technician\'s org and site',
  // --- examined device readers (jobs, services, ee) ---
  'services/abuseSignals/heuristics.ts': 'abuse scoring must count every device of a partner, parked devices included',
  'services/abuseSignals/invariants.ts': 'abuse signals must count every device of a partner, parked devices included',
  'services/abuseSignals/recidivistEndpoint.ts': 'abuse fingerprinting must see every device, parked devices included',
  'services/actionIntents/actorContext.ts': 'derived: single device lookup by id already fixed as the intent\'s own target',
  'services/actionIntents/agentReleaseAuthority.ts': 'derived: single device lookup by id already fixed as the intent\'s own target',
  'services/actionIntents/approvalDeviceName.ts': 'derived: single device lookup by id and org for an approval display name',
  'services/actionIntents/effectDigest.ts': 'derived: single device lookup by id already fixed as the action\'s target',
  'services/actionIntents/intentApprovers.ts': 'derived: resolves tool-call-cited device ids with an org-pinned equality lookup',
  'services/actionIntents/intentService.ts': 'derived: device lookups keyed off the intent/run\'s own target',
  'services/actionIntents/laneQueries.ts': 'derived: device lookup by id and org for lane admission',
  'services/actionIntents/policyDecide.ts': 'derived: single device lookup by id to enrich an existing run\'s policy scope',
  'services/actionIntents/runScriptSnapshot.ts': 'derived: resolves devices from ids passed as tool-call arguments, already through the central device gate',
  'services/agentCertificateBinding.ts': 'agent self-service: certificate lookup for the connecting agent\'s own device (rotation stays allowed for parked devices)',
  'services/agentHealthObservations.ts': 'agent self-service: agent records a health observation for its own device',
  'services/agentOrgRateLimit.ts': 'counts one org\'s devices for rate-limit sizing, not a target selector',
  'services/agentRollback.ts': 'agent self-service: version snapshot for the connecting agent\'s own rollback',
  'services/agentRollbackResult.ts': 'agent self-service: agent reports its own rollback observation',
  'services/aiAgent.ts': 'request path: device lookups gated on canAccessOrg/canAccessSite on the session-creation request path',
  'services/aiAgentSdk.ts': 'request path: device lookup in the caller\'s own db access context',
  'services/aiAgents/alertVerdictSubscriber.ts': 'derived: device lookup by id and org from an existing alert row',
  'services/aiAgents/designEvidence.ts': 'org-pinned: evidence queries pinned to the run\'s org, which the guarded sweep scheduler chose',
  'services/aiAgents/metricAnomalySubscriber.ts': 'derived: device lookup by id and org from an existing metric anomaly row',
  'services/aiAgents/narrativeContext.ts': 'org-pinned: evidence queries pinned to the run\'s org',
  'services/aiAgents/patchEvidence.ts': 'org-pinned: evidence queries pinned to the run\'s org',
  'services/aiAgents/runLoop.ts': 'derived: device lookup by the run\'s own device and org',
  'services/aiAgents/runResourceScope.ts': 'derived: device lookup by id and org for run scope tagging',
  'services/aiAgents/runService.ts': 'org-pinned: device sets resolved from proposed ids, pinned to the run\'s org',
  'services/aiAgents/researchContext.ts': 'derived: single device lookup by id and org for a run that already targets that device',
  'services/aiAgents/runnerPrompt.ts': 'formats already-fetched evidence into a prompt',
  'services/aiAgents/sweepEvidence.ts': 'org-pinned: sweep evidence loaders pinned to one org chosen by the guarded sweep scheduler',
  'services/aiAgents/sweepSubjectProbe.ts': 'derived: re-probes one device already named by an existing sweep finding',
  'services/aiAgents/ticketContext.ts': 'org-pinned: linked-device lookup pinned to the ticket\'s org',
  'services/aiOperator/deviceCommandEvidence.ts': 'derived: device lookup by id and org from a task\'s own row',
  'services/aiOperator/requesterAccessGate.ts': 'request path: rechecks a human requester\'s live org/site access to a task\'s device',
  'services/aiOperator/taskService.ts': 'request path: creates a task for a device named on the request, scoped to the request org',
  'services/aiOperator/verification.ts': 'derived: re-validates a task\'s own device is still in the task\'s org',
  'services/aiTimeEntryProposal.ts': 'derived: loads device site from an existing run row',
  'services/aiToolsAgentLogs.ts': 'request path: single device resolved via the caller\'s own org',
  'services/aiToolsAlerts.ts': 'derived: device info keyed by an access-checked alert\'s device',
  'services/aiToolsBackupShared.ts': 'derived: site lookup by an already-resolved snapshot\'s device',
  'services/aiToolsBrowser.ts': 'org-pinned: device fan-out pinned to a policy row\'s own org',
  'services/aiToolsDR.ts': 'derived: acts on device ids stored in org-owned DR plan rows',
  'services/aiToolsFleet.ts': 'request path: device/alert/rule queries gated by orgWhere/deviceScopeCondition from the chat auth context',
  'services/aiToolsFleetStatus.ts': 'request path: device rows fetched by id from a prior scoped query plus deviceScopeCondition',
  'services/aiToolsHyperv.ts': 'request path: device ids pass the central deviceArgs gate, which never resolves a parked device',
  'services/aiToolsIncident.ts': 'request path: device reach scoped by incidents.orgId join plus site/device scope conditions',
  'services/aiToolsMssql.ts': 'request path: device ids pass the central deviceArgs gate, which never resolves a parked device',
  'services/aiToolsRestoreAuthorization.ts': 'org-pinned: target device must match the snapshot\'s org, always a real org',
  'services/aiToolsSLABackup.ts': 'org-pinned: writes require an explicit real org id; reads are org-scoped compliance views',
  'services/aiToolsSentinelOne.ts': 'org-pinned: actions require an active integration row for the org, which a person configures for real orgs only',
  'services/aiToolsSiteScope.ts': 'derived: shared helper queries devices by a caller-supplied, already-scoped org id',
  'services/alertConditions/handlers/networkCheck.ts': 'derived: evaluates only the device the guarded alert sweep selected',
  'services/alertConditions/utils.ts': 'derived: per-device lookups keyed on a device handed in by a guarded sweep',
  'services/alertService.ts': 'derived: alert creation keyed on a device from guarded worker fan-out; auto-resolve only closes existing rows',
  'services/approvals/decideApprovalRequest.ts': 'request path: human approve/deny handler; device resolved from the approval\'s own intent/org scope',
  'services/automationActionResults.ts': 'derived: ledger keyed on devices seeded by the guarded automation dispatch',
  'services/backupCommandCredentials.ts': 'agent self-service: delivery-time refresh for a command the device fetches from its own queue; backup commands are never queued for a parked device',
  'services/backupJobCreation.ts': 'derived: job creation keyed on devices from the guarded backup scheduler',
  'services/backupProgress.ts': 'agent self-service: agent-reported progress applied only for the calling agent\'s own device/job',
  'services/backupRecoveryCommandIntegrity.ts': 'agent self-service: delivery-time refresh reads the org of the device fetching its own queued command',
  'services/backupStorageSessionStore.ts': 'derived: loads one device already resolved by the command/session caller',
  'services/brainDeviceContext.ts': 'request path: all queries gated by auth.orgCondition from the request\'s auth context',
  'services/callerVerification/gate.ts': 'request path: single id+orgId device check inside a per-request gate flow',
  'services/callerVerification/service.ts': 'request path: device/contact reads scoped via actor and reachable contacts on request paths',
  'services/commandResultHandlers.ts': 'agent self-service: result handlers keyed to the device resolved by the agent transport',
  'services/customFields/import/resolveDevice.ts': 'request path: system-scope read bounded by the caller\'s request-time accessibleOrgIds/site reach',
  'services/customFields/queries.ts': 'request path: per-device reads and writes with the device supplied by the request route',
  'services/deploymentEngine.ts': 'org-pinned: targets resolved via deployment.orgId, a row a person creates for a real org',
  'services/deploymentTargetResolver.ts': 'org-pinned: every target branch filters on the deployment row\'s org',
  'services/deviceConsentPromptCapability.ts': 'request path: reads one capability column of the one device a desktop start names, no enumeration',
  'services/deviceCoverage.ts': 'request path: single-device read enforcing actor.accessibleOrgIds from the request',
  'services/deviceDeletion.ts': 'lifecycle: removes one device and its referencing rows',
  'services/deviceFunction.ts': 'org-pinned: membership check scoped to an explicit org and device pair',
  'services/deviceLifecycle.ts': 'lifecycle: restore/purge of one locked removed device',
  'services/deviceLinkGroups.ts': 'request path: mutations scoped to a link group or caller-supplied devices from link routes and the deletion cascade',
  'services/deviceMtlsCertificateIssuance.ts': 'org-pinned: locks and activates a certificate for one caller-supplied (device, org) pair; not a selector',
  'services/deviceMaintenanceLease.ts': 'request path: locks one device at a time, ids from the maintenance route\'s request',
  'services/deviceRecovery/restoreCheckpoint.ts': 'derived: single deviceId param from AI script lane caller already targeting one chosen device',
  'services/deviceSiteResolver.ts': 'derived: single-device cache lookup keyed on deviceId supplied by an event publisher',
  'services/deviceUninstallDrain.ts': 'lifecycle: device-remove uninstall queue/release/drain-check, all keyed on one deviceId from removal route',
  'services/discoveredAssetSiteMove.ts': 'lifecycle: site move of caller-supplied asset ids inside caller transaction, org-scoped',
  'services/discovery/agentReportedBmcLink.ts': 'agent self-service: agent\'s own in-band report links its own device/org\'s discovered assets',
  'services/fleetDesign/apply.ts': 'request path: request-path apply of a previously approved, org-pinned report-run proposal',
  'services/fleetDesign/preview.ts': 'request path: request-path preview resolving an org-pinned report run under caller auth',
  'services/fleetFindings/dispatch.ts': 'derived: remediation targets re-validated against finding.orgId, then dispatched from stored target rows',
  'services/groupMembership.ts': 'org-pinned: group membership evaluation scoped to group.orgId, from org-owned device-group rows',
  'services/hardwareHealth/ingest.ts': 'agent self-service: ownership-checks device.id+orgId; mounted only under the agent\'s own hardware-health route',
  'services/hardwareHealth/view.ts': 'derived: keyed on a single deviceId from already-authorized callers',
  'services/timeSync/ingest.ts': 'agent self-service: ownership-checks device.id+orgId; mounted only under the agent\'s own time-status route',
  'services/timeSync/view.ts': 'derived: keyed on a single deviceId from already-authorized callers',
  'services/timeSync/settings.ts': 'derived: resolves policy settings for a single deviceId supplied by already-authorized callers (the calling agent\'s heartbeat/ingest, device view, fleet rows already filtered by notParkedDeviceCondition); selects no work',
  'services/timeSync/configUpdate.ts': 'agent self-service: builds the heartbeat time_sync_settings payload for the calling agent\'s own device id',
  'services/timeSync/exports.ts':'derived: daily rows only for the device ids iterateFleetTimeRows already selected with notParkedDeviceCondition',
  'services/helperPermissions.ts': 'agent self-service: runs on the helper route for the calling device\'s own id',
  'services/logReadAuthority.ts': 'request path: log-read authority derived from auth.canAccessOrg/allowedSiteIds on the request path only',
  'services/logSearch.ts': 'org-pinned: background correlation loop pinned per-rule to rule.orgId, an org-owned config row',
  'services/m365Sync/links.ts': 'org-pinned: reconcileDeviceLinks(orgId) called only from post-sync hooks with orgId from a real M365 connection',
  'services/maintenanceService.ts': 'derived: isDeviceInMaintenance keyed on a single deviceId already authorized by the calling route',
  'services/maintenanceSiteScope.ts': 'request path: site-scope gate for maintenance-window read/write, driven by the caller\'s permissions object',
  'services/maintenanceWindowProjection.ts': 'org-pinned: always carries WHERE org_id = orgId, orgId from a per-org report',
  'services/metricAnomalyEpisodes.ts': 'derived: episode assembly operates on orgId handed in by the guarded anomaly worker',
  'services/metricRollups.ts': 'org-pinned: rollupDeviceMetricsRange takes options.orgId from the guarded rollup worker',
  'services/monitors/conversion/equivalence.ts': 'derived: acts on a single deviceId already resolved upstream; no independent selection',
  'services/monitors/conversion/previewScope.ts': 'derived: consumes resolveDeviceIdsForPolicy\'s device/org set; no independent selection here',
  'services/monitors/escalationLatch.ts': 'derived: raises an alert for a single deviceId passed in from the guarded per-device evaluation upstream',
  'services/networkBaseline.ts': 'org-pinned: runs per (orgId, siteId, baselineId) from a config row created only for real orgs',
  'services/notificationDispatcher.ts': 'derived: reads alert.orgId/alert.deviceId off an already-created alerts row; no selection of its own',
  'services/officeAddin/emailContext.ts': 'request path: human tech-auth path; every org lookup filtered by tech.canAccessOrg/accessibleOrgIds',
  'services/offlineAlertEffects.ts': 'derived: acts on an alert-plan effect, which offlineEffectsStore never writes for a parked device',
  'services/pamActuationResult.ts': 'agent self-service: agent posts result for its own deviceId/agentId/commandId only',
  'services/pamReconciliationBinding.ts': 'agent self-service: agent-supplied ids; joins devices only to confirm agent owns them',
  'services/pamToolActionGovernance.ts': 'agent self-service: helper on one device drives its own tool-action elevation request',
  'services/partnerTrust.repo.ts': 'derived: single id lookups (partnerId/orgId/deviceId) supplied by caller, no enumeration',
  'services/partnerTrustPromotion.ts': 'reads one partner\'s device IP classes for a trust decision; no per-device action',
  'services/patchAlerts.ts': 'derived: emitters take deviceId/orgId chosen by upstream job-finalizer/reboot-worker callers',
  'services/patchEligibility.ts': 'derived: takes deviceId/orgId from job executor, AI patch plan, or release effect digest callers',
  'services/peripheralEffectivePolicy.ts': 'derived: resolves policy for one caller-supplied deviceId; not an enumerator',
  'services/psa/ticketScope.ts': 'request path: SQL condition restricts ticket-mapping rows to the request\'s accessibleOrgIds',
  'services/quickSupportEnd.ts': 'lifecycle: Decommissions the one device tied to a caller-given session id; not fan-out',
  'services/recoveryAuthorizationSubject.ts': 'derived: Single id lookups (user/apiKey/grant/run) scoped by orgId; device via aiAgentRuns.deviceId, one row',
  'services/recoveryBootstrap.ts': 'request path: Single device+token lookup keyed on caller-supplied orgId+tokenId from a recovery request',
  'services/reliabilityScoring.ts': 'org-pinned: computeAndPersistOrgReliability scans org devices unfiltered; sole caller already excludes holding org',
  'services/fixMemory/catalog.ts': 'derived: resolveDeviceOs looks up one device by id from an already-resolved alert/anomaly/rca context (moved here from remediationSuggestions.ts by #7275)',
  'services/fixMemory/outcomeWatcher.ts': 'derived: reads the org of the one device named on an existing fix-outcome row; selects outcome rows, never devices',
  'services/fixMemory/signatureLoader.ts': 'derived: looks up the OS of the one device named on the source alert/anomaly row being signed',
  'services/outcomeProbes.ts': 'derived: probes status/lastSeen of the one device named on an existing watch row; reads and decides, never selects work',
  'services/remoteRevocationLease.ts': 'request path: All queries keyed to one sessionId/deviceId from live session/start-capability checks, no enumeration',
  'services/remoteSessionTeardown.ts': 'lifecycle: Resolves agentId for device ids of sessions already marked disconnected; teardown, not selection',
  'services/remoteWsAuthorization.ts': 'request path: Single session lookup by consumed ticket\'s sessionId for WS connect authorization',
  'services/resilienceSiteAuthorization.ts': 'request path: resolveLineage checks one resource id + caller-given orgId; authorization only, no enumeration',
  'services/scriptCancellation.ts': 'derived: deviceId/executionIds derived from scriptExecutions rows created by the guarded scriptDispatch path',
  'services/scriptCommandRevalidation.ts': 'derived: row.deviceId is from a queued device_commands row already created by guarded scriptDispatch',
  'services/scriptExecution.ts': 'request path: Route callers only; device gated by auth.canAccessOrg',
  'services/scriptExitCodeAlerts.ts': 'derived: Acts on the single device tied to the execution row being ingested; no device-set selection',
  'services/scriptProposals/reviewer.ts': 'derived: Reads only proposal.targetDeviceIds, re-filtered by the proposal\'s own orgId',
  'services/scriptSecretDelivery.ts': 'derived: Operates only on already-claimed commands for the calling agent\'s own device',
  'services/sentinelOne/actions.ts': 'request path: orgId/deviceIds from request/AI-chat callers; devices filtered by eq(devices.orgId, params.orgId)',
  'services/softwareDeployment.ts': 'org-pinned: Fan-out always filters eq(devices.orgId, deployment.orgId), an org-owned row from request-created deployments',
  'services/softwareInventoryObservations.ts': 'agent self-service: Agent\'s own inventory-ingest route; acts only on the calling device\'s own row',
  'services/softwarePolicyExecutableRulesAuthorization.ts': 'Pure permission/authorization helper; never reads the devices table',
  'services/softwarePolicyRemediationPreview.ts': 'request path: Preview scoped by the caller\'s own orgCondition/site allowlist from the request path',
  'services/systemCleanup.ts': 'request path: Per-device lock scoped by device.id+orgId passed in from route/AI tool call',
  'services/tenantCascade.ts': 'lifecycle: Org/partner erasure cascade; deletes all rows for the org(s) being erased, including holding org',
  'services/tenantLifecycle.ts': 'lifecycle: Suspend/restore agent credentials tied to org/partner status change (suspend/archive/offboard)',
  'services/tenantOffboarding.ts': 'lifecycle: Queues/cancels self_uninstall drain for all orgs under an offboarding partner',
  'services/threatDetectionReport.ts': 'org-pinned: orgId comes from a report occurrence/config row created only for real customer orgs',
  'services/ticketPush.ts': 'org-pinned: Device lookup keyed by ticket-linked deviceId+orgId for push-recipient site authorization',
  'services/ticketService.ts': 'request path: Device lookups validate deviceId against ticket orgId during human-initiated create/update',
  'services/topology/collectionAuthority.ts': 'agent self-service: Heartbeat/negotiation handshake resolves only the calling agent\'s own device',
  'services/topology/collectionRetention.ts': 'lifecycle: Retention purge of orphaned topology evidence; only checks device absence, never selects a live device',
  'services/topology/discoveryDispatch.ts': 'derived: resolves the one agent discoveryWorker already selected with notParkedDeviceCondition, pinned to the job orgId',
  'services/topology/diagnosticDispatch.ts': 'derived: Dispatches/validates a command bound to a run row created by an upstream diagnostic-run request',
  'services/topology/legacyReplay.ts': 'derived: Reads device existence within a scope already fixed by an upstream per-site topology state row',
  'services/topology/unifiAdapter.ts': 'derived: read-only MAC binding inside a scope fixed by a UniFi site mapping to a real org site; no per-device action',
  'services/topology/unifiAuthority.ts': 'agent self-service: resolves the reporting collector device; advertisement is reached only via listCollectorsForDevice, which refuses parked devices',
  'services/backupAttestation.ts': 'derived: reads the one device a terminal backup result belongs to; backup dispatch already leaves parked devices out',
  'services/backupStorageWriteSessions.ts': 'derived: the device of a backup job being dispatched; backup dispatch already leaves parked devices out',
  'services/topology/aiDiagnosticApproval.ts': "request path: the origin device of one proposal, pinned to the proposing technician's org",
  'services/topology/aiInvestigation.ts': "request path: evidence for one investigation turn in the technician's own topology site",
  'services/topology/monitoringScheduler.ts': 'org-pinned: the origin device of a site-owned topology policy; policy targets resolve through site access, never a holding-org site',
  'services/topology/telemetryArmFence.ts': 'derived: re-reads the collector of an existing telemetry arm inside its claim or sink transaction',
  'services/topology/telemetryArms.ts': "request path: collector picked inside the technician's own topology site; its dispatch persists through the gated command insert",
  'services/drExecutionService.ts': 'org-pinned: the rebuild host of one DR execution, read within that execution\'s org; its commands persist through the gated command insert',
  'services/unassignedPool/admission.ts': 'lifecycle: counts the holding org\'s devices to admit one more parked device; selects no work',
  'services/unassignedPool/parkedExpiry.ts': 'lifecycle removal: expiry and purge of one parked device under the holding-area lock',
  'services/unassignedPool/visibility.ts': 'the hidden-org visibility helpers themselves; select nothing',
  'services/unassignedPool/assignParkedDevice.ts': 'lifecycle: the assignment operation itself; acts on the one parked device a full partner admin named',
  'services/unassignedPool/assignParkedDeviceSteps.ts': 'lifecycle: locked reads of the one named parked device and of its destination identity rows, for the assignment operation',
  'services/unassignedPool/parkedDeviceReads.ts': 'the parked-device list itself, shown only to full partner admins through the pre-assignment routes; reads, never selects work',
  'services/userRiskScoring.ts': 'org-pinned: Devices queried by orgId from job data; upstream org scan requires organizationUsers rows, which holding orgs never have',
  'services/vmRestoreRebuildEngine.ts': 'request path: Human-initiated restore route/AI tool; orgId + rebuildHostDeviceId pre-authorized by caller',
  'services/vulnerabilityManagementReport.ts': 'org-pinned: Report scoped to one real org via service-deliverable occurrence; holding org has no deliverables',
  'services/vulnerabilityRemediation.ts': 'request path: Operator/AI tool remediates explicit device-finding ids under caller\'s auth org condition',
  'services/warrantyPolicyResolution.ts': 'derived: Caller-supplied deviceId; upstream selector already applies notParkedDeviceCondition',
  'ee/workspace/src/services/deviceSummaryService.ts': 'request path: summarize(orgId, deviceId) takes both ids from the calling route, RLS-backed',
};

describe('contract: background selectors leave parked devices out', () => {
  const found = discovered();

  it('discovers the expected shape of the tree (not vacuous)', () => {
    expect(found.length).toBeGreaterThan(60);
    expect(found).toContain('jobs/cisJobs.ts');
    expect(found).toContain('services/featureConfigResolver.ts');
  });

  it('classifies every discovered file exactly once', () => {
    const sets = [FANOUT_MODULES, VISIBILITY_MODULES, EXEMPT];
    const unclassified = found.filter((f) => !sets.some((s) => f in s) && !exemptByPattern(f));
    expect(unclassified, 'classify these in parkedFanout.contract.test.ts').toEqual([]);
    const doubled = found.filter((f) => sets.filter((s) => f in s).length + (exemptByPattern(f) ? 1 : 0) > 1);
    expect(doubled).toEqual([]);
  });

  it('every FANOUT module carries exactly its pinned number of guard sites', () => {
    // Pinned per file so that removing one of several guards (e.g. the org
    // enumeration guard but not the device guard) fails, and a new guarded
    // query updates the pin on purpose.
    const drift = Object.entries(FANOUT_MODULES)
      .filter(([f]) => existsSync(abs(f)))
      .map(([f, { guards }]) => ({ file: f, pinned: guards, found: guardSites(f) }))
      .filter(({ pinned, found }) => pinned !== found);
    expect(drift, 'a guard was added or removed: update the pin, or restore the guard').toEqual([]);
  });

  it('every FANOUT module has at least one guard', () => {
    const zero = Object.entries(FANOUT_MODULES).filter(([, { guards }]) => guards < 1).map(([f]) => f);
    expect(zero).toEqual([]);
  });

  it('has no stale entries', () => {
    const all = { ...FANOUT_MODULES, ...VISIBILITY_MODULES, ...EXEMPT };
    const gone = Object.keys(all).filter((f) => !existsSync(abs(f)));
    expect(gone).toEqual([]);
    // Explicit extras are selectors the discovery patterns do not catch.
    const extras = new Set([
      'routes/updateRingsHelpers.ts',
      'services/configurationPolicy.ts',
      'services/offlineEffectsStore.ts',
      'services/warrantyAlertEvaluator.ts',
      'services/dnsThreatAlerts.ts',
    ]);
    const stale = Object.keys({ ...VISIBILITY_MODULES, ...EXEMPT }).filter((f) => !found.includes(f));
    const staleFanout = Object.keys(FANOUT_MODULES).filter((f) => !found.includes(f) && !extras.has(f));
    const unusedPatterns = EXEMPT_PATTERNS.filter(({ pattern }) => !found.some((f) => pattern.test(f)));
    expect([...stale, ...staleFanout]).toEqual([]);
    expect(unusedPatterns).toEqual([]);
  });

  it('never decides execution with a hidden-org-type list', () => {
    // Quick Support is hidden AND remote-capable; the holding org is hidden
    // AND execution-denied. A shared list would couple the two.
    const offenders = [...JOB_FILES, ...SERVICE_FILES, ...EE_FILES].filter((f) =>
      /HIDDEN_ORG_TYPES/.test(read(f)) && f in FANOUT_MODULES,
    );
    expect(offenders).toEqual([]);
  });
});

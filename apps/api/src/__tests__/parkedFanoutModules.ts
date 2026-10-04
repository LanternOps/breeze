/**
 * The execution-side classification of parkedFanout.contract.test.ts: modules
 * that select target devices or orgs for background work and must carry a
 * parked-device predicate, with the number of guard sites pinned per file.
 *
 * Kept in its own (non-test) module so the holding-org visibility contract
 * (unassignedPoolVisibility.contract.test.ts) can skip exactly these files —
 * execution sites keep their Quick Support exclusion plus the parked
 * predicate and never switch to the visibility list.
 */
/** Target selection for background work: must reference a parked-device predicate. */
export const FANOUT_MODULES: Record<string, { guards: number; reason: string }> = {
  // --- shared resolvers -----------------------------------------------------
  'services/featureConfigResolver.ts': { guards: 4, reason: 'per-device config resolution, partner-wide assignment fan-out, backup and scan device sets' },
  'services/configurationPolicy.ts': { guards: 1, reason: 'effective configuration for a device (no partner-level assignment for a parked device)' },
  'services/policyEvaluationService.ts': { guards: 3, reason: 'policy scope and assignment-target device resolution' },
  'services/monitors/monitorResolver.ts': { guards: 1, reason: 'monitor assignments resolved for a device' },
  'routes/updateRingsHelpers.ts': { guards: 2, reason: 'update-ring partner assignment device resolution' },
  'services/networkExecutorSelection.ts': { guards: 1, reason: 'network monitor executor candidates' },
  'services/automationRuntime.ts': { guards: 2, reason: 'automation owner orgs and target devices' },
  'services/automationWebhookContext.ts': { guards: 1, reason: 'partner-wide automation webhook: owner-context org allowlist the run targets' },
  // --- workers and schedulers ---------------------------------------------
  'jobs/alertWorker.ts': { guards: 2, reason: 'scheduled alert rule evaluation over orgs and devices' },
  'services/monitors/networkCheckAlertSweep.ts': { guards: 2, reason: 'network-check alert sweep org enumeration' },
  'jobs/monitorWorker.ts': { guards: 1, reason: 'partner-wide network monitor org fan-out' },
  'jobs/monitorScriptWorker.ts': { guards: 2, reason: 'partner-wide script monitor org and device fan-out' },
  'jobs/patchSchedulerWorker.ts': { guards: 1, reason: 'patch policy device resolution' },
  'jobs/automationWorker.ts': { guards: 2, reason: 'automation assignment devices and event triggers' },
  'jobs/backupWorker.ts': { guards: 3, reason: 'scheduled backup org enumeration and dispatch' },
  'jobs/cisJobs.ts': { guards: 1, reason: 'scheduled CIS scan targets' },
  'jobs/securityScanJobs.ts': { guards: 1, reason: 'scheduled security scans' },
  'jobs/sensitiveDataJobs.ts': { guards: 2, reason: 'scheduled sensitive-data scans' },
  'jobs/auditBaselineJobs.ts': { guards: 4, reason: 'audit policy collection' },
  'services/auditBaselineService.ts': { guards: 1, reason: 'default audit baseline seeding over orgs' },
  'jobs/maintenanceRebootWorker.ts': { guards: 1, reason: 'maintenance reboot candidates' },
  'jobs/softwareRemediationWorker.ts': { guards: 2, reason: 'software remediation per device' },
  'jobs/softwareComplianceWorker.ts': { guards: 1, reason: 'software policy compliance checks' },
  'jobs/peripheralJobs.ts': { guards: 3, reason: 'peripheral policy distribution and reconciliation' },
  'jobs/discoveryWorker.ts': { guards: 2, reason: 'discovery scan executor selection' },
  'jobs/snmpWorker.ts': { guards: 1, reason: 'SNMP poll executor selection' },
  'jobs/aiAgentSweepScheduler.ts': { guards: 1, reason: 'scheduled AI agent sweeps over partner orgs' },
  'services/aiAgents/patchPlan.ts': { guards: 1, reason: 'AI patch-plan evidence devices' },
  'services/aiAgents/sweepFindings.ts': { guards: 1, reason: 'AI sweep finding devices' },
  'jobs/fleetFindings.ts': { guards: 1, reason: 'fleet findings org scan' },
  'services/fleetFindings/producers.ts': { guards: 3, reason: 'fleet finding eligible devices' },
  'jobs/securityPostureWorker.ts': { guards: 1, reason: 'security posture org scan' },
  'jobs/metricRollups.ts': { guards: 1, reason: 'metric rollup org scan' },
  'jobs/metricAnomalies.ts': { guards: 1, reason: 'metric anomaly org scan' },
  'jobs/reliabilityWorker.ts': { guards: 1, reason: 'reliability org scan' },
  'services/warrantySync.ts': { guards: 2, reason: 'warranty vendor lookups' },
  'services/warrantyAlertEvaluator.ts': { guards: 1, reason: 'warranty alerts' },
  'services/dnsThreatAlerts.ts': { guards: 1, reason: 'DNS threat alerts' },
  'services/offlineEffectsStore.ts': { guards: 2, reason: 'offline event and offline alert plan (no alerts, notifications or tickets for parked devices)' },
  // --- AI tools (model-visible device and org lookups) ----------------------
  'services/aiToolsDevice.ts': { guards: 2, reason: 'query_devices and the tag vocabulary' },
  'services/aiToolsOrgs.ts': { guards: 2, reason: 'organization and site listings' },
  'services/aiToolsAgentMgmt.ts': { guards: 2, reason: 'device verifier and agent-version rollup' },
  'services/aiToolsPeripherals.ts': { guards: 1, reason: 'partner-wide peripheral policy fan-out' },
  'services/timeSync/fleet.ts': { guards: 1, reason: 'fleet time report and list_time_sync_issues AI device lookup' },
  // --- org administration -----------------------------------------------------
  'services/orgImport/index.ts': { guards: 1, reason: 'org import never name-matches the holding org' },
  // --- examined device readers (jobs, services, ee) ---
  'jobs/pamActuationWorker.ts': { guards: 1, reason: 'refuses privileged actuation for a parked device' },
  'services/aiTools.ts': { guards: 1, reason: 'device lookup carries the parked-device predicate' },
  'services/aiToolsAudit.ts': { guards: 1, reason: 'device lookup carries the parked-device predicate' },
  'services/aiToolsBackup.ts': { guards: 5, reason: 'device lookup carries the parked-device predicate' },
  'services/aiToolsBackupVm.ts': { guards: 2, reason: 'device lookup carries the parked-device predicate' },
  'services/aiToolsCisBenchmark.ts': { guards: 1, reason: 'device lookup carries the parked-device predicate' },
  'services/aiToolsFilesystem.ts': { guards: 1, reason: 'device lookup carries the parked-device predicate' },
  'services/aiToolsNetwork.ts': { guards: 1, reason: 'device lookup carries the parked-device predicate' },
  'services/aiToolsPam.ts': { guards: 1, reason: 'device lookup carries the parked-device predicate' },
  'services/aiToolsPerformance.ts': { guards: 1, reason: 'device lookup carries the parked-device predicate' },
  'services/aiToolsPlaybooks.ts': { guards: 1, reason: 'device lookup carries the parked-device predicate' },
  'services/aiToolsRemote.ts': { guards: 1, reason: 'device lookup carries the parked-device predicate' },
  'services/aiToolsScripts.ts': { guards: 1, reason: 'device lookup carries the parked-device predicate' },
  'services/aiToolsSecurity.ts': { guards: 1, reason: 'device lookup carries the parked-device predicate' },
  'services/aiToolsVault.ts': { guards: 4, reason: 'device lookup carries the parked-device predicate' },
  'services/backupProviders/alerts.ts': { guards: 1, reason: 'device lookup carries the parked-device predicate' },
  'services/backupProviders/deviceMatching.ts': { guards: 1, reason: 'device lookup carries the parked-device predicate' },
  'services/commandDispatch.ts': { guards: 1, reason: '1 guarded site: the narrowed (parked) batch claim reads the org type and cancels refused rows. The single-row push claim hands the org type to partitionClaimable (commandClaimEligibility.ts), which carries the parked cancel for both legs and is pinned by parkedCommandDelivery.contract.test.ts' },
  'services/commandQueue.ts': { guards: 1, reason: 'device lookup carries the parked-device predicate' },
  'services/dispatchDeviceCommand.ts': { guards: 1, reason: '1 guarded site: prepareDeviceCommand checks isParkedDevice before persisting a command' },
  'services/monitors/conversion/convert.ts': { guards: 2, reason: 'device lookup carries the parked-device predicate' },
  'services/monitors/conversion/legacyBaseline.ts': { guards: 2, reason: 'device lookup carries the parked-device predicate' },
  'services/peripheralPolicyState.ts': { guards: 1, reason: '1 guarded site' },
  'services/scriptDispatch.ts': { guards: 1, reason: '1 guarded site' },
  'services/subjectAlertOutbox.ts': { guards: 1, reason: 'device lookup carries the parked-device predicate' },
  'services/unifi/unifiCollectorService.ts': { guards: 1, reason: '1 guarded site' },
  'services/wakeOnLan.ts': { guards: 2, reason: '2 guarded sites' },
};

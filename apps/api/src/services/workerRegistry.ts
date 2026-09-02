/**
 * Declarative, lazily-loaded worker registry (wave 3.5d-b, #4086).
 *
 * Replaces the 104-entry static array that used to live in `index.ts`
 * (`initializeWorkers()` / `workerShutdownTasks`). Every entry's module is
 * loaded via a dynamic `import()` thunk instead of a static top-of-file
 * import, so a process that only wants a subset of workers (the `worker`
 * entrypoint, `src/worker.ts`) never pulls in the modules for the workers it
 * doesn't run — in particular, never pulls in the route graph or
 * `routes/agentWs.ts` for a `global`-placement-only process. This is what
 * `workerEntrypointClosure.contract.test.ts` (#4086 Task 5) enforces for each
 * registry entry.
 *
 * This file is itself deliberately EXCLUDED as a seed from that same test's
 * separate SEEDED walk of `worker.ts`'s own `await import(...)` specifiers —
 * this registry's whole point is 104 `load()` thunks that must stay
 * unfollowed, and the seeded walk is static-only regardless (an entry's own
 * runtime closure, dynamic-follow included, is what the per-entry
 * `global`/`socket-owner` test above checks instead). That seeded walk is
 * what actually proves `worker.ts`'s real boot closure — not just its static
 * top-of-file imports — never reaches `routes/agentWs.ts`; see `worker.ts`'s
 * own header for the one explicitly allowlisted residue
 * (`routes/auth/schemas.ts`, an inert schemas/env-flag module).
 *
 * `placement` classifies each entry by whether its module's *runtime* import
 * closure (transitive relative imports, ignoring `import type`) reaches
 * `routes/agentWs.ts` or `services/agentCommandAwait.ts`:
 *
 *   - `'global'`       — safe to run on a process with no agent sockets.
 *   - `'socket-owner'` — reaches socket-local dispatch and must stay on a
 *                        process that can own agent WebSocket connections
 *                        (today, every `BREEZE_ROLE=all`/`api` process).
 *
 * This first-pass classification was produced mechanically (a transitive
 * relative-import closure walk from each entry's module, stopping at
 * `routes/agentWs.ts` / `services/agentCommandAwait.ts`, ignoring
 * `import type`) — see the plan doc's placement note. It intentionally does
 * NOT tree-shake by which export is actually used, so it can over-approximate
 * (e.g. a retention job that merely imports a big shared route-helpers module
 * which itself imports `services/commandQueue` counts as reaching it). That
 * is deliberate: this is the same mechanism `workerEntrypointClosure.contract.test.ts`
 * (Task 5) uses to hold the registry to account, and getting this "loose but
 * mechanical" is safer than a tighter but judgment-based call that the
 * contract test can't independently verify. Task 5's contract test is the
 * final authority and will flip any entry this pass got wrong.
 *
 * DO NOT relitigate placement values by guessing — see CLAUDE.md and the plan
 * doc: run the closure tool, don't reason about it from memory.
 */
import type { BreezeRole } from '../config/env';

export type WorkerPlacement = 'global' | 'socket-owner';

export interface WorkerModule {
  init: () => Promise<void> | void;
  shutdown?: () => Promise<void>;
}

export interface WorkerRegistration {
  name: string;
  placement: WorkerPlacement;
  load: () => Promise<WorkerModule>;
}

export interface StartWorkersHooks {
  onResult: (name: string, ok: boolean, err?: unknown) => void;
}

/**
 * The 104-entry registry, in the exact order the entries used to appear in
 * `index.ts`'s `initializeWorkers()` array (`index.ts:1305-1433` as of the
 * commit that introduced this module). Order matters for the losslessness
 * contract test, not for runtime semantics — every selected entry's `init()`
 * runs concurrently via `Promise.allSettled`, same as today.
 */
export const WORKER_REGISTRY: readonly WorkerRegistration[] = [
  {
    name: 'alertWorkers',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/alertWorker');
      return { init: m.initializeAlertWorkers, shutdown: m.shutdownAlertWorkers };
    },
  },
  {
    name: 'alertCorrelationWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/alertCorrelation');
      return { init: m.initializeAlertCorrelationWorker, shutdown: m.shutdownAlertCorrelationWorker };
    },
  },
  {
    name: 'metricRollupsWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/metricRollups');
      return { init: m.initializeMetricRollupsWorker, shutdown: m.shutdownMetricRollupsWorker };
    },
  },
  {
    name: 'metricRollupMaintenance',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/metricRollupMaintenance');
      return { init: m.initializeMetricRollupMaintenanceWorker, shutdown: m.shutdownMetricRollupMaintenanceWorker };
    },
  },
  {
    name: 'metricAnomaliesWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/metricAnomalies');
      return { init: m.initializeMetricAnomaliesWorker, shutdown: m.shutdownMetricAnomaliesWorker };
    },
  },
  {
    name: 'fleetFindingsWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/fleetFindings');
      return { init: m.scheduleFleetFindingsJobs, shutdown: m.shutdownFleetFindingsJobs };
    },
  },
  {
    name: 'fleetRemediationDispatchWorker',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/fleetRemediationDispatch');
      return { init: m.scheduleFleetRemediationDispatchJobs, shutdown: m.shutdownFleetRemediationDispatchJobs };
    },
  },
  {
    name: 'mlOutputRetention',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/mlOutputRetention');
      return { init: m.initializeMlOutputRetention, shutdown: m.shutdownMlOutputRetention };
    },
  },
  {
    name: 'offlineDetector',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/offlineDetector');
      return { init: m.initializeOfflineDetector, shutdown: m.shutdownOfflineDetector };
    },
  },
  {
    name: 'notificationDispatcher',
    placement: 'global',
    load: async () => {
      const m = await import('../services/notificationDispatcher');
      return { init: m.initializeNotificationDispatcher, shutdown: m.shutdownNotificationDispatcher };
    },
  },
  {
    name: 'webhookDelivery',
    placement: 'global',
    load: async () => {
      // Wraps `getWebhookWorker()` + the delivery-claim/outcome callback
      // wiring that used to be a local `initializeWebhookDeliveryWorker`
      // function in index.ts (moved to services/webhookDeliveryInit.ts so
      // the registry can load it standalone — see that module's header
      // comment for why it isn't just added to workers/webhookDelivery.ts).
      // `index.ts` ALSO calls `getWebhookWorker().stop()` directly in its
      // shutdown preamble (must run before the HTTP server stops accepting
      // requests) — this entry's `shutdown` calling `stop()` again is a
      // harmless no-op (see the module's own doc comment).
      const m = await import('../services/webhookDeliveryInit');
      return { init: m.initializeWebhookDeliveryWorker, shutdown: m.shutdownWebhookDeliveryWorker };
    },
  },
  {
    name: 'webhookDeliveryRecovery',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/webhookDeliveryRecovery');
      return { init: m.initializeWebhookDeliveryRecovery, shutdown: m.shutdownWebhookDeliveryRecovery };
    },
  },
  {
    // socket-owner, not global: its runtime import closure reaches
    // routes/agentWs.ts — jobs/policyEvaluationWorker.ts ->
    // services/policyEvaluationService.ts -> (dynamic `await
    // import('../jobs/automationWorker')` for `enqueueAutomationRun`) ->
    // services/automationRuntime.ts -> services/scriptDispatch.ts ->
    // routes/agentWs.ts. Found by workerEntrypointClosure.contract.test.ts
    // (#4086 Task 5) — flipped from an initial-pass 'global' guess.
    name: 'policyEvaluationWorker',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/policyEvaluationWorker');
      return { init: m.initializePolicyEvaluationWorker, shutdown: m.shutdownPolicyEvaluationWorker };
    },
  },
  {
    name: 'softwareComplianceWorker',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/softwareComplianceWorker');
      return { init: m.initializeSoftwareComplianceWorker, shutdown: m.shutdownSoftwareComplianceWorker };
    },
  },
  {
    name: 'softwareRemediationWorker',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/softwareRemediationWorker');
      return { init: m.initializeSoftwareRemediationWorker, shutdown: m.shutdownSoftwareRemediationWorker };
    },
  },
  {
    name: 'aiAgentRunner',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/aiAgentRunner');
      return { init: m.initializeAiAgentRunner, shutdown: m.shutdownAiAgentRunner };
    },
  },
  {
    // Durable retry lane for run-finished notifications (wave 4a Task 6,
    // #3826). Its only real dependency is `services/aiAgents/runFinishedNotify.ts`
    // (db + recipients + userNotifications) — deliberately NOT `runLoop.ts`'s
    // full SDK-tool graph, so its closure stays `global` (verified by
    // workerEntrypointClosure.contract.test.ts) unlike `aiAgentRunner` above.
    name: 'agentNotifyRetry',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/agentNotifyRetryWorker');
      return { init: m.initializeAgentNotifyRetryWorker, shutdown: m.shutdownAgentNotifyRetryWorker };
    },
  },
  {
    // The fix-held watch's two-phase delayed consumer (wave 6 PR 2, Task 3,
    // #3828). Its only real dependency is `services/aiAgents/fixWatch.ts`
    // (db + alerts/aiAgents schema + recipients + userNotifications) —
    // deliberately NOT `runLoop.ts`'s SDK-tool graph, same reasoning as
    // `agentNotifyRetry` above, so its closure stays `global` (verified by
    // workerEntrypointClosure.contract.test.ts).
    name: 'fixWatchWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/fixWatchWorker');
      return { init: m.initializeFixWatchWorker, shutdown: m.shutdownFixWatchWorker };
    },
  },
  {
    name: 'auditBaselineJobs',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/auditBaselineJobs');
      return { init: m.initializeAuditBaselineJobs, shutdown: m.shutdownAuditBaselineJobs };
    },
  },
  {
    name: 'cisJobs',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/cisJobs');
      return { init: m.initializeCisJobs, shutdown: m.shutdownCisJobs };
    },
  },
  {
    name: 'automationWorker',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/automationWorker');
      return { init: m.initializeAutomationWorker, shutdown: m.shutdownAutomationWorker };
    },
  },
  {
    name: 'securityPostureWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/securityPostureWorker');
      return { init: m.initializeSecurityPostureWorker, shutdown: m.shutdownSecurityPostureWorker };
    },
  },
  {
    name: 'reliabilityWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/reliabilityWorker');
      return { init: m.initializeReliabilityWorker, shutdown: m.shutdownReliabilityWorker };
    },
  },
  {
    name: 'userRiskWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/userRiskJobs');
      return { init: m.initializeUserRiskJobs, shutdown: m.shutdownUserRiskJobs };
    },
  },
  {
    name: 'abuseSignalsWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/abuseSignalsSweep');
      return { init: m.initializeAbuseSignalsWorker, shutdown: m.shutdownAbuseSignalsWorker };
    },
  },
  {
    name: 'userRiskRetention',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/userRiskRetention');
      return { init: m.initializeUserRiskRetention, shutdown: m.shutdownUserRiskRetention };
    },
  },
  {
    name: 'backupVerificationJobs',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/backupVerificationJobs');
      return { init: m.initializeBackupVerificationJobs, shutdown: m.shutdownBackupVerificationJobs };
    },
  },
  {
    name: 'eventLogRetention',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/eventLogRetention');
      return { init: m.initializeEventLogRetention, shutdown: m.shutdownEventLogRetention };
    },
  },
  {
    name: 'logCorrelationWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/logCorrelation');
      return { init: m.initializeLogCorrelationWorker, shutdown: m.shutdownLogCorrelationWorker };
    },
  },
  {
    name: 'agentLogRetention',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/agentLogRetention');
      return { init: m.initializeAgentLogRetention, shutdown: m.shutdownAgentLogRetention };
    },
  },
  {
    name: 'ipHistoryRetention',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/ipHistoryRetention');
      return { init: m.initializeIPHistoryRetention, shutdown: m.shutdownIPHistoryRetention };
    },
  },
  {
    name: 'reliabilityRetention',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/reliabilityRetention');
      return { init: m.initializeReliabilityRetention, shutdown: m.shutdownReliabilityRetention };
    },
  },
  {
    name: 'processSampleRetention',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/processSampleRetention');
      return { init: m.initializeProcessSampleRetention, shutdown: m.shutdownProcessSampleRetention };
    },
  },
  {
    name: 'deviceMetricsRetention',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/deviceMetricsRetention');
      return { init: m.initializeDeviceMetricsRetention, shutdown: m.shutdownDeviceMetricsRetention };
    },
  },
  {
    name: 'serviceProcessCheckRetention',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/serviceProcessCheckRetention');
      return { init: m.initializeServiceProcessCheckRetention, shutdown: m.shutdownServiceProcessCheckRetention };
    },
  },
  {
    name: 'changeLogRetention',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/changeLogRetention');
      return { init: m.initializeChangeLogRetention, shutdown: m.shutdownChangeLogRetention };
    },
  },
  {
    name: 'oauthCleanup',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/oauthCleanup');
      return { init: m.initializeOauthCleanupWorker, shutdown: m.shutdownOauthCleanupWorker };
    },
  },
  {
    name: 'authBrowserTransitionCleanup',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/authBrowserTransitionCleanup');
      return {
        init: m.initializeAuthBrowserTransitionCleanupWorker,
        shutdown: m.shutdownAuthBrowserTransitionCleanupWorker,
      };
    },
  },
  {
    name: 'stripeAccountCacheRefresh',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/stripeAccountCacheRefresh');
      return { init: m.initializeStripeAccountCacheRefreshWorker, shutdown: m.shutdownStripeAccountCacheRefreshWorker };
    },
  },
  {
    name: 'exchangeRateSync',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/exchangeRateSync');
      return { init: m.initializeExchangeRateSyncWorker, shutdown: m.shutdownExchangeRateSyncWorker };
    },
  },
  {
    name: 'oauthRevocationRetryWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/oauthRevocationRetryWorker');
      return { init: m.initializeOAuthRevocationRetryWorker, shutdown: m.shutdownOAuthRevocationRetryWorker };
    },
  },
  {
    name: 'mtlsCertificateRevocationWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/mtlsCertificateRevocation');
      return { init: m.initializeMtlsCertificateRevocationWorker, shutdown: m.shutdownMtlsCertificateRevocationWorker };
    },
  },
  {
    name: 'authEmailWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/authEmailWorker');
      return { init: m.initializeAuthEmailWorker, shutdown: m.shutdownAuthEmailWorker };
    },
  },
  {
    name: 'quoteSendWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/quoteSendQueue');
      return { init: m.initializeQuoteSendWorker, shutdown: m.shutdownQuoteSendWorker };
    },
  },
  {
    name: 'enrollmentKeyCleanup',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/enrollmentKeyCleanup');
      return { init: m.initializeEnrollmentKeyCleanupWorker, shutdown: m.shutdownEnrollmentKeyCleanupWorker };
    },
  },
  {
    name: 'quickSupportReaper',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/quickSupportReaper');
      return { init: m.initializeQuickSupportReaper, shutdown: m.shutdownQuickSupportReaper };
    },
  },
  {
    name: 'softwareUploadSessionCleanup',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/softwareUploadSessionCleanup');
      return { init: m.initializeSoftwareUploadSessionCleanupWorker, shutdown: m.shutdownSoftwareUploadSessionCleanupWorker };
    },
  },
  {
    name: 'softwareRemediationRequestCleanup',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/softwareRemediationRequestCleanup');
      return { init: m.initializeSoftwareRemediationRequestCleanupWorker, shutdown: m.shutdownSoftwareRemediationRequestCleanupWorker };
    },
  },
  {
    name: 'auditRetention',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/auditRetention');
      return { init: m.initializeAuditRetentionWorker, shutdown: m.shutdownAuditRetentionWorker };
    },
  },
  {
    name: 'auditChainVerify',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/auditChainVerify');
      return { init: m.initializeAuditChainVerifyWorker, shutdown: m.shutdownAuditChainVerifyWorker };
    },
  },
  {
    name: 'auditChainAnchor',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/auditChainAnchor');
      return { init: m.initializeAuditChainAnchorWorker, shutdown: m.shutdownAuditChainAnchorWorker };
    },
  },
  {
    name: 'tenantErasure',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/tenantErasure');
      return { init: m.initializeTenantErasureWorker, shutdown: m.shutdownTenantErasureWorker };
    },
  },
  {
    // org-lifecycle Wave 2, Task 4 (#4111): Phase C (audit + erasure handoff)
    // of a completed org merge. Added during the 3.5d-b merge with main —
    // main's static array placed it exactly here, before desktopSessionFinalization.
    // socket-owner: its closure reaches routes/agentWs via services/orgMerge
    // (closure contract test verdict) — same class as the tenant-offboarding family.
    name: 'orgMerge',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/orgMerge');
      return { init: m.initializeOrgMergeWorker, shutdown: m.shutdownOrgMergeWorker };
    },
  },
  {
    name: 'desktopSessionFinalization',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/desktopSessionFinalizationWorker');
      return { init: m.initializeDesktopSessionFinalizationWorker, shutdown: m.shutdownDesktopSessionFinalizationWorker };
    },
  },
  {
    name: 'desktopSessionOrphanRecovery',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../services/desktopSessionOrphanRecovery');
      return { init: m.initializeDesktopSessionOrphanRecovery, shutdown: m.shutdownDesktopSessionOrphanRecovery };
    },
  },
  {
    name: 'playbookRetention',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/playbookRetention');
      return { init: m.initializePlaybookRetention, shutdown: m.shutdownPlaybookRetention };
    },
  },
  {
    name: 'discoveryWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/discoveryWorker');
      return { init: m.initializeDiscoveryWorker, shutdown: m.shutdownDiscoveryWorker };
    },
  },
  {
    name: 'networkBaselineWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/networkBaselineWorker');
      return { init: m.initializeNetworkBaselineWorker, shutdown: m.shutdownNetworkBaselineWorker };
    },
  },
  {
    name: 'snmpWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/snmpWorker');
      return { init: m.initializeSnmpWorker, shutdown: m.shutdownSnmpWorker };
    },
  },
  {
    name: 'monitorWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/monitorWorker');
      return { init: m.initializeMonitorWorker, shutdown: m.shutdownMonitorWorker };
    },
  },
  {
    name: 'unifiWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/unifiWorker');
      return { init: m.initializeUnifiWorker, shutdown: m.shutdownUnifiWorker };
    },
  },
  {
    name: 'unifiTelemetryWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/unifiTelemetryWorker');
      return { init: m.initializeUnifiTelemetryWorker, shutdown: m.shutdownUnifiTelemetryWorker };
    },
  },
  {
    name: 'snmpRetention',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/snmpRetention');
      return { init: m.initializeSnmpRetention, shutdown: m.shutdownSnmpRetention };
    },
  },
  {
    name: 'patchComplianceReportWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/patchComplianceReportWorker');
      return { init: m.initializePatchComplianceReportWorker, shutdown: m.shutdownPatchComplianceReportWorker };
    },
  },
  {
    name: 'reportScheduleWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/reportScheduleWorker');
      return { init: m.initializeReportScheduleWorker, shutdown: m.shutdownReportScheduleWorker };
    },
  },
  {
    name: 'cveEnrichmentWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/cveEnrichmentWorker');
      return { init: m.initializeCveEnrichmentWorker, shutdown: m.shutdownCveEnrichmentWorker };
    },
  },
  {
    name: 'wingetIndexSyncWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/wingetIndexSyncWorker');
      return { init: m.initializeWingetIndexSyncWorker, shutdown: m.shutdownWingetIndexSyncWorker };
    },
  },
  {
    name: 'vulnerabilityJobs',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/vulnerabilityJobs');
      return { init: m.initializeVulnerabilityJobs, shutdown: m.shutdownVulnerabilityJobs };
    },
  },
  {
    name: 'dnsSyncWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/dnsSyncJob');
      return { init: m.initializeDnsSyncJob, shutdown: m.shutdownDnsSyncJob };
    },
  },
  {
    name: 's1SyncWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/s1Sync');
      return { init: m.initializeS1SyncJob, shutdown: m.shutdownS1SyncJob };
    },
  },
  {
    name: 'huntressSyncWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/huntressSync');
      return { init: m.initializeHuntressSyncJob, shutdown: m.shutdownHuntressSyncJob };
    },
  },
  {
    name: 'pax8SyncWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/pax8SyncWorker');
      return { init: m.initializePax8SyncWorkers, shutdown: m.shutdownPax8SyncWorkers };
    },
  },
  {
    name: 'tdSynnexSftpSyncWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/tdSynnexSftpSyncWorker');
      return { init: m.initializeTdSynnexSftpWorkers, shutdown: m.shutdownTdSynnexSftpWorkers };
    },
  },
  {
    name: 'logForwardingWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/logForwardingWorker');
      return { init: m.initializeLogForwardingWorker, shutdown: m.shutdownLogForwardingWorker };
    },
  },
  {
    name: 'patchJobWorker',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/patchJobExecutor');
      return { init: m.initializePatchJobWorkers, shutdown: m.shutdownPatchJobWorkers };
    },
  },
  {
    name: 'patchSchedulerWorker',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/patchSchedulerWorker');
      return { init: m.initializePatchSchedulerWorker, shutdown: m.shutdownPatchSchedulerWorker };
    },
  },
  {
    name: 'maintenanceRebootWorker',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/maintenanceRebootWorker');
      return { init: m.initializeMaintenanceRebootWorker, shutdown: m.shutdownMaintenanceRebootWorker };
    },
  },
  {
    name: 'backupWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/backupWorker');
      return { init: m.initializeBackupWorker, shutdown: m.shutdownBackupWorker };
    },
  },
  {
    name: 'sensitiveDataWorker',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/sensitiveDataJobs');
      return { init: m.initializeSensitiveDataWorkers, shutdown: m.shutdownSensitiveDataWorkers };
    },
  },
  {
    name: 'peripheralJobs',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/peripheralJobs');
      return { init: m.initializePeripheralJobs, shutdown: m.shutdownPeripheralJobs };
    },
  },
  {
    name: 'browserSecurityWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/browserSecurityJobs');
      return { init: m.initializeBrowserSecurityJobs, shutdown: m.shutdownBrowserSecurityJobs };
    },
  },
  {
    name: 'c2cBackupWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/c2cBackupWorker');
      return { init: m.initializeC2cBackupWorker, shutdown: m.shutdownC2cBackupWorker };
    },
  },
  {
    name: 'backupSlaWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/backupSlaWorker');
      return { init: m.initializeBackupSlaWorker, shutdown: m.shutdownBackupSlaWorker };
    },
  },
  {
    name: 'drExecutionWorker',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/drExecutionWorker');
      return { init: m.initializeDrExecutionWorker, shutdown: m.shutdownDrExecutionWorker };
    },
  },
  {
    name: 'recoveryMediaWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/recoveryMediaWorker');
      return { init: m.initializeRecoveryMediaWorker, shutdown: m.shutdownRecoveryMediaWorker };
    },
  },
  {
    name: 'recoveryBootMediaWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/recoveryBootMediaWorker');
      return { init: m.initializeRecoveryBootMediaWorker, shutdown: m.shutdownRecoveryBootMediaWorker };
    },
  },
  {
    name: 'warrantyWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../services/warrantyWorker');
      return { init: m.initializeWarrantyWorker, shutdown: m.shutdownWarrantyWorker };
    },
  },
  {
    name: 'ssoDomainRecheckWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../services/ssoDomainRecheckWorker');
      return { init: m.initializeSsoDomainRecheckWorker, shutdown: m.shutdownSsoDomainRecheckWorker };
    },
  },
  {
    name: 'incidentCorrelationWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/incidentJobs');
      return { init: m.initializeIncidentCorrelationWorker, shutdown: m.shutdownIncidentCorrelationWorker };
    },
  },
  {
    name: 'incidentTimelineEnricher',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/incidentJobs');
      return { init: m.initializeIncidentTimelineEnricher, shutdown: m.shutdownIncidentTimelineEnricher };
    },
  },
  {
    name: 'incidentSlaMonitor',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/incidentJobs');
      return { init: m.initializeIncidentSlaMonitor, shutdown: m.shutdownIncidentSlaMonitor };
    },
  },
  {
    name: 'staleCommandReaper',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/staleCommandReaper');
      return { init: m.initializeStaleCommandReaper, shutdown: m.shutdownStaleCommandReaper };
    },
  },
  {
    name: 'softwareDeploymentScheduler',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/softwareDeploymentScheduler');
      return { init: m.initializeSoftwareDeploymentScheduler, shutdown: m.shutdownSoftwareDeploymentScheduler };
    },
  },
  {
    name: 'pamJobs',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/pamJobs');
      return { init: m.initializePamJobs, shutdown: m.shutdownPamJobs };
    },
  },
  {
    name: 'approvalExpiryReaper',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/approvalExpiryReaper');
      return { init: m.initializeApprovalExpiryReaper, shutdown: m.shutdownApprovalExpiryReaper };
    },
  },
  {
    name: 'offboardingDrainReaper',
    // socket-owner, not global: its static closure is clean, but at RUNTIME
    // it reaches routes/agentWs.ts via a dynamic import one hop out —
    // jobs/offboardingDrainReaper.ts -> services/tenantOffboarding.ts
    // (sweepOffboardingTenants) -> services/tenantLifecycle.ts
    // (disconnectLiveAgentSocketsForOrgIds) -> `await import('../routes/agentWs')`
    // for getConnectedAgentIds()/disconnectAgent(). Those two functions carry
    // no assertSocketLocalDispatchAllowed guard, so on a worker-role process
    // this fails silently (empty connected-id list) instead of loudly,
    // quietly disabling the #2774 offboarding drain's live-socket eviction.
    // Review finding, wave 3.5d-b (#4086).
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/offboardingDrainReaper');
      return { init: m.initializeOffboardingDrainReaper, shutdown: m.shutdownOffboardingDrainReaper };
    },
  },
  {
    name: 'intentOutboxPublisher',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/intentOutboxPublisher');
      return { init: m.initializeIntentOutboxPublisher, shutdown: m.shutdownIntentOutboxPublisher };
    },
  },
  {
    name: 'pamActuationWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/pamActuationWorker');
      return { init: m.initializePamActuationWorker, shutdown: m.shutdownPamActuationWorker };
    },
  },
  {
    name: 'intentExpiryReaper',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/intentExpiryReaper');
      return { init: m.initializeIntentExpiryReaper, shutdown: m.shutdownIntentExpiryReaper };
    },
  },
  {
    name: 'intentReleaseWorker',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/intentReleaseWorker');
      return { init: m.initializeIntentReleaseWorker, shutdown: m.shutdownIntentReleaseWorker };
    },
  },
  {
    name: 'stripeReconcileSweep',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/stripeReconcileSweep');
      return { init: m.initializeStripeReconcileSweep, shutdown: m.shutdownStripeReconcileSweep };
    },
  },
  {
    name: 'ticketAttachmentReaper',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/ticketAttachmentReaper');
      return { init: m.initializeTicketAttachmentReaper, shutdown: m.shutdownTicketAttachmentReaper };
    },
  },
  {
    name: 'quoteExpiryReaper',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/quoteExpiryReaper');
      return { init: m.initializeQuoteExpiryReaper, shutdown: m.shutdownQuoteExpiryReaper };
    },
  },
  {
    name: 'suppressionExpiryReaper',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/suppressionExpiryReaper');
      return { init: m.initializeSuppressionExpiryReaper, shutdown: m.shutdownSuppressionExpiryReaper };
    },
  },
  {
    name: 'ticketNotifyWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/ticketNotifyWorker');
      return { init: m.initializeTicketNotifyWorker, shutdown: m.shutdownTicketNotifyWorker };
    },
  },
  {
    // #3828 wave-6-3 task 2. Same shape/precedent as intentOutboxPublisher —
    // drains ticket_outbox onto the generic eventBus. No agent-socket-local
    // dispatch dependency (unlike e.g. intentReleaseWorker), so 'global'.
    name: 'ticketOutboxPublisher',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/ticketOutboxPublisher');
      return { init: m.initializeTicketOutboxPublisher, shutdown: m.shutdownTicketOutboxPublisher };
    },
  },
  {
    name: 'ticketSlaWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/ticketSlaWorker');
      return { init: m.initializeTicketSlaWorker, shutdown: m.shutdownTicketSlaWorker };
    },
  },
  {
    name: 'inboundEmailWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/inboundEmailWorker');
      return { init: m.initializeInboundEmailWorker, shutdown: m.shutdownInboundEmailWorker };
    },
  },
  {
    name: 'ticketMailboxPollWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/ticketMailboxPollWorker');
      return { init: m.initializeTicketMailboxPollWorker, shutdown: m.shutdownTicketMailboxPollWorker };
    },
  },
  {
    name: 'invoiceWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/invoiceWorker');
      return { init: m.initializeInvoiceWorkers, shutdown: m.shutdownInvoiceWorkers };
    },
  },
  {
    // #3828 wave-6-4 task 2. Same shape/precedent as ticketOutboxPublisher —
    // drains metric_anomaly_incidents' dispatch marker onto the generic
    // eventBus. No agent-socket-local dispatch dependency, so 'global'.
    name: 'metricAnomalyIncidentPublisher',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/metricAnomalyIncidentPublisher');
      return {
        init: m.initializeMetricAnomalyIncidentPublisher,
        shutdown: m.shutdownMetricAnomalyIncidentPublisher,
      };
    },
  },
  {
    name: 'contractWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/contractWorker');
      return { init: m.initializeContractWorkers, shutdown: m.shutdownContractWorkers };
    },
  },
  {
    // Wave 5B (#3827 Task 4): 48h sweep of `ai_unattended_exposure`, the
    // org-wide blast-cap ledger the act + policy-decide lanes share. No
    // route graph / socket import anywhere in its closure — `global`, same
    // placement as every other retention worker above.
    name: 'aiUnattendedExposureRetention',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/aiUnattendedExposureRetention');
      return { init: m.initializeAiUnattendedExposureRetention, shutdown: m.shutdownAiUnattendedExposureRetention };
    },
  },
  {
    // Phase 2 wave P2-1 (alert verdicts), task 13: delayed BullMQ job that
    // admits a verdict run for an alert that stays open and uncorrelated for
    // UNGROUPED_VERDICT_DELAY_MINUTES. Its closure reaches
    // `enqueueVerdictRunForAlert` (alertVerdictSubscriber.ts) ->
    // `createAndEnqueueAgentRun` (runService.ts) -> `routes/agentWs.ts` /
    // `services/agentCommandAwait.ts` (verified by
    // workerEntrypointClosure.contract.test.ts, which is the mechanical
    // authority here — do not relitigate by guessing) — so `socket-owner`,
    // same placement as `aiAgentRunner` above for the identical reason.
    name: 'alertVerdictScheduler',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/alertVerdictScheduler');
      return { init: m.initializeAlertVerdictScheduler, shutdown: m.shutdownAlertVerdictScheduler };
    },
  },
  {
    // Phase 2 wave P2-2 (scheduled sweeps), task 9: the fixed 5-minute tick
    // over `ai_agent_schedules` plus the per-org occurrence fan-out.
    //
    // `global`, NOT `socket-owner` — and deliberately not copied from
    // `alertVerdictScheduler` above, which looks like the same shape.
    // `workerEntrypointClosure.contract.test.ts` (the mechanical authority)
    // was run for BOTH values: this entry's runtime closure reaches neither
    // `routes/agentWs.ts` nor `services/agentCommandAwait.ts`, while
    // `alertVerdictScheduler`'s does — it pulls `alertVerdictSubscriber` ->
    // `aiToolsOrgs` -> `tenantOffboarding` -> `orgMerge` ->
    // `routes/portal/helpers`, a chain this module never imports. Its own
    // deepest AI dependency is `runService.createAndEnqueueAgentRun`, which
    // only INSERTS a run row and enqueues; the socket-touching execution
    // happens later, in `aiAgentRunner` (socket-owner). Flipping this to
    // `socket-owner` would silently exclude the sweeper from `worker`-role
    // processes for no reason.
    name: 'aiAgentSweepScheduler',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/aiAgentSweepScheduler');
      return { init: m.initializeAiAgentSweepScheduler, shutdown: m.shutdownAiAgentSweepScheduler };
    },
  },
  {
    // Phase 2 wave P2-6 (value accounting), task A5: nightly scan + per-org
    // impact rollup fan-out.
    //
    // `global`: its runtime import closure is `services/aiAgents/impactRollup.ts`
    // (db + schema + the frozen IMPACT_FIX_TOOLS literal) — it never reaches
    // `runService.createAndEnqueueAgentRun`, `routes/agentWs.ts` or
    // `services/agentCommandAwait.ts`. Do NOT copy this value by analogy:
    // `workerEntrypointClosure.contract.test.ts` is the mechanical authority
    // and must be run for this entry (see CLAUDE.md — never relitigate
    // placement by guessing).
    name: 'aiAgentImpactRollup',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/aiAgentImpactRollup');
      return { init: m.initializeAiAgentImpactRollupWorker, shutdown: m.shutdownAiAgentImpactRollupWorker };
    },
  },
];

function placementForRole(role: BreezeRole): WorkerPlacement | null {
  if (role === 'all') return null; // null = no filter, everything
  return role === 'worker' ? 'global' : 'socket-owner';
}

function filterByRole(
  entries: readonly WorkerRegistration[],
  role: BreezeRole,
): readonly WorkerRegistration[] {
  const placement = placementForRole(role);
  if (placement === null) return entries;
  return entries.filter((e) => e.placement === placement);
}

/**
 * `all` -> every entry (today's behavior, byte-for-byte). `api` -> only
 * `socket-owner` entries. `worker` -> only `global` entries.
 */
export function selectWorkers(role: BreezeRole): readonly WorkerRegistration[] {
  return filterByRole(WORKER_REGISTRY, role);
}

/**
 * Per-name loaded shutdown functions, populated by `runEntries` as soon as an
 * entry's module has *loaded* — deliberately BEFORE `init()` runs. This
 * mirrors the pre-refactor behavior: the old static `workerShutdownTasks`
 * list in index.ts called every shutdown fn unconditionally on SIGTERM,
 * regardless of whether that worker's init had succeeded, failed partway, or
 * even been reached. Most inits construct a BullMQ `Worker`/`Queue` into
 * module-level state and only then do throwable work (e.g. scheduling a
 * repeatable job against Redis) — a partial init still leaves that
 * Worker/Queue holding a live Redis connection that must be closed on
 * shutdown. Registering the shutdown at load-time (not at successful-init
 * time) restores that behavior exactly. An entry contributes no shutdown task
 * only when its module never loaded at all — not selected for this role, or
 * the dynamic `import()` itself threw.
 */
const loadedShutdowns = new Map<string, () => Promise<void>>();

async function runEntries(
  entries: readonly WorkerRegistration[],
  hooks: StartWorkersHooks,
): Promise<void> {
  await Promise.allSettled(
    entries.map(async (entry) => {
      try {
        const mod = await entry.load();
        if (mod.shutdown) {
          loadedShutdowns.set(entry.name, mod.shutdown);
        }
        await mod.init();
        hooks.onResult(entry.name, true);
      } catch (error) {
        hooks.onResult(entry.name, false, error);
      }
    }),
  );
}

/**
 * Loads+inits every registry entry selected for `role`, with today's
 * `Promise.allSettled` semantics: one entry's failure never blocks another's,
 * and every outcome (success or failure, with the error) is reported via
 * `hooks.onResult` so the caller can drive `workerStatus`/Sentry capture
 * exactly as `index.ts` did with the old inline array.
 */
export async function startRegisteredWorkers(
  role: BreezeRole,
  hooks: StartWorkersHooks,
): Promise<void> {
  await runEntries(selectWorkers(role), hooks);
}

/**
 * Returns the shutdown functions for every entry selected for `role` whose
 * module was actually loaded (by a prior `startRegisteredWorkers` call —
 * loaded, not necessarily init-succeeded, see `runEntries` above) and defines
 * a `shutdown`. An entry that was never selected, never loaded, or defines no
 * `shutdown` contributes nothing.
 */
export async function buildWorkerShutdownTasks(
  role: BreezeRole,
): Promise<Array<() => Promise<void>>> {
  const selected = selectWorkers(role);
  const tasks: Array<() => Promise<void>> = [];
  for (const entry of selected) {
    const shutdown = loadedShutdowns.get(entry.name);
    if (shutdown) tasks.push(shutdown);
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Test seams (workerRegistry.test.ts). Not for production use: real callers
// use `startRegisteredWorkers`/`buildWorkerShutdownTasks` against the real
// `WORKER_REGISTRY`. These take an injectable registry so unit tests can drive
// the load/init/shutdown-tracking logic against small fake entries instead of
// the real 104-entry registry (which would pull in the whole job-module
// graph).
// ---------------------------------------------------------------------------

/** @internal test seam */
export async function _startWorkersForTest(
  entries: readonly WorkerRegistration[],
  role: BreezeRole,
  hooks: StartWorkersHooks,
): Promise<void> {
  await runEntries(filterByRole(entries, role), hooks);
}

/** @internal test seam */
export async function _buildShutdownTasksForTest(
  entries: readonly WorkerRegistration[],
  role: BreezeRole,
): Promise<Array<() => Promise<void>>> {
  const selected = filterByRole(entries, role);
  const tasks: Array<() => Promise<void>> = [];
  for (const entry of selected) {
    const shutdown = loadedShutdowns.get(entry.name);
    if (shutdown) tasks.push(shutdown);
  }
  return tasks;
}

/** @internal test seam — clears the module-level loaded-shutdown tracking. */
export function _resetLoadedShutdownsForTest(): void {
  loadedShutdowns.clear();
}

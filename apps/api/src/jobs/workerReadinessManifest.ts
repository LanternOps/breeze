import type { WorkerReadinessRegistry } from '../services/workerReadinessRegistry';

export type WorkerInitializerClassification =
  | {
      kind: 'consumers';
      initializer: string;
      consumers: readonly string[];
      requiredWhen: 'redis' | 'abuse_signals_enabled';
    }
  | {
      kind: 'non_consumer';
      initializer:
        | 'desktopSessionOrphanRecovery'
        | 'oauthRevocationRetryWorker'
        | 'incidentCorrelationWorker'
        | 'incidentTimelineEnricher'
        | 'incidentSlaMonitor';
    };

const consumers = (
  initializer: string,
  names: readonly string[] = [initializer],
  requiredWhen: 'redis' | 'abuse_signals_enabled' = 'redis',
): WorkerInitializerClassification => ({
  kind: 'consumers',
  initializer,
  consumers: names,
  requiredWhen,
});

export const WORKER_READINESS_MANIFEST: readonly WorkerInitializerClassification[] = [
  consumers('alertWorkers', ['alertWorker']),
  consumers('alertCorrelationWorker'),
  consumers('metricRollupsWorker'),
  consumers('metricRollupMaintenance'),
  consumers('metricAnomaliesWorker'),
  consumers('fleetFindingsWorker'),
  consumers('fleetRemediationDispatchWorker'),
  consumers('mlOutputRetention'),
  consumers('offlineDetector'),
  consumers('notificationDispatcher'),
  consumers('webhookDelivery', ['webhookDeliveryWorker']),
  consumers('policyEvaluationWorker'),
  consumers('softwareComplianceWorker'),
  consumers('softwareRemediationWorker'),
  consumers('aiAgentRunner'),
  consumers('auditBaselineJobs'),
  consumers('cisJobs'),
  consumers('automationWorker'),
  consumers('securityPostureWorker'),
  consumers('reliabilityWorker'),
  consumers('userRiskWorker'),
  consumers('abuseSignalsWorker', ['abuseSignalsWorker'], 'abuse_signals_enabled'),
  consumers('userRiskRetention'),
  consumers('backupVerificationJobs', ['backupVerificationWorker']),
  consumers('eventLogRetention'),
  consumers('logCorrelationWorker'),
  consumers('agentLogRetention'),
  consumers('ipHistoryRetention'),
  consumers('reliabilityRetention'),
  consumers('processSampleRetention'),
  consumers('deviceMetricsRetention'),
  consumers('serviceProcessCheckRetention'),
  consumers('changeLogRetention'),
  consumers('oauthCleanup'),
  consumers('stripeAccountCacheRefresh'),
  consumers('exchangeRateSync'),
  { kind: 'non_consumer', initializer: 'oauthRevocationRetryWorker' },
  consumers('mtlsCertificateRevocationWorker'),
  consumers('authEmailWorker'),
  consumers('quoteSendWorker'),
  consumers('enrollmentKeyCleanup'),
  consumers('quickSupportReaper'),
  consumers('softwareUploadSessionCleanup'),
  consumers('softwareRemediationRequestCleanup'),
  consumers('auditRetention'),
  consumers('auditChainVerify'),
  consumers('auditChainAnchor'),
  consumers('tenantErasure'),
  consumers('desktopSessionFinalization', ['desktopSessionFinalizationWorker']),
  { kind: 'non_consumer', initializer: 'desktopSessionOrphanRecovery' },
  consumers('playbookRetention'),
  consumers('discoveryWorker'),
  consumers('networkBaselineWorker'),
  consumers('snmpWorker'),
  consumers('monitorWorker'),
  consumers('unifiWorker'),
  consumers('unifiTelemetryWorker'),
  consumers('snmpRetention'),
  consumers('patchComplianceReportWorker'),
  consumers('reportScheduleWorker'),
  consumers('cveEnrichmentWorker'),
  consumers('wingetIndexSyncWorker'),
  consumers('vulnerabilityJobs', ['vulnerabilityJobs', 'vulnerabilityMaintenance']),
  consumers('dnsSyncWorker'),
  consumers('s1SyncWorker'),
  consumers('huntressSyncWorker'),
  consumers('pax8SyncWorker'),
  consumers('tdSynnexSftpSyncWorker'),
  consumers('logForwardingWorker'),
  consumers('patchJobWorker', ['patchJobWorker', 'patchJobDeviceWorker']),
  consumers('patchSchedulerWorker'),
  consumers('maintenanceRebootWorker'),
  consumers('backupWorker'),
  consumers('sensitiveDataWorker'),
  consumers('peripheralJobs', ['peripheralAnomalyWorker', 'peripheralPolicyDistributionWorker']),
  consumers('browserSecurityWorker', ['browserSecurityEvalWorker']),
  consumers('c2cBackupWorker'),
  consumers('backupSlaWorker'),
  consumers('drExecutionWorker'),
  consumers('recoveryMediaWorker'),
  consumers('recoveryBootMediaWorker'),
  consumers('warrantyWorker'),
  consumers('ssoDomainRecheckWorker'),
  { kind: 'non_consumer', initializer: 'incidentCorrelationWorker' },
  { kind: 'non_consumer', initializer: 'incidentTimelineEnricher' },
  { kind: 'non_consumer', initializer: 'incidentSlaMonitor' },
  consumers('staleCommandReaper'),
  consumers('softwareDeploymentScheduler'),
  consumers('pamJobs', ['pamExpiryEnforcerWorker', 'pamStaleRequestWorker']),
  consumers('approvalExpiryReaper'),
  consumers('offboardingDrainReaper'),
  consumers('intentOutboxPublisher'),
  consumers('intentExpiryReaper'),
  consumers('intentReleaseWorker'),
  consumers('stripeReconcileSweep'),
  consumers('quoteExpiryReaper'),
  consumers('suppressionExpiryReaper'),
  consumers('ticketNotifyWorker'),
  consumers('ticketSlaWorker'),
  consumers('inboundEmailWorker'),
  consumers('ticketMailboxPollWorker'),
  consumers('invoiceWorker'),
  consumers('contractWorker'),
  // Registry entries main added after Track C's merge base (wave 3.5d-b names).
  // The first six already attach under exactly these names on main; the next
  // six receive their attach in this commit (registry entry name == consumer name).
  consumers('webhookDeliveryRecovery'),
  consumers('agentNotifyRetry'),
  consumers('fixWatchWorker'),
  consumers('authBrowserTransitionCleanup'),
  consumers('orgMerge'),
  consumers('pamActuationWorker'),
  consumers('ticketAttachmentReaper'),
  consumers('ticketOutboxPublisher'),
  consumers('metricAnomalyIncidentPublisher'),
  consumers('aiUnattendedExposureRetention'),
  consumers('alertVerdictScheduler'),
  consumers('aiAgentSweepScheduler'),
  // Started outside WORKER_REGISTRY, role-gated in index.ts / worker.ts.
  consumers('eventDispatch', ['eventDispatch', 'eventDispatchMaintenance']),
  consumers('agentCommandRelay'),
] as const;

export function consumersForInitializer(initializer: string): readonly string[] {
  const classification = WORKER_READINESS_MANIFEST.find(
    (entry) => entry.initializer === initializer,
  );
  return classification?.kind === 'consumers' ? classification.consumers : [];
}

export function declareExpectedConsumers(input: {
  redisAvailable: boolean;
  abuseSignalsEnabled: boolean;
  registry: WorkerReadinessRegistry;
}): void {
  if (!input.redisAvailable) return;

  for (const entry of WORKER_READINESS_MANIFEST) {
    if (entry.kind === 'non_consumer') continue;
    const required = entry.requiredWhen === 'redis' || input.abuseSignalsEnabled;
    for (const name of entry.consumers) input.registry.expect(name, required);
    if (entry.requiredWhen === 'abuse_signals_enabled' && !input.abuseSignalsEnabled) {
      for (const name of entry.consumers) input.registry.disable(name, 'feature_disabled');
    }
  }
}

import type { BreezeRole } from '../config/env';
import type { WorkerReadinessRegistry } from '../services/workerReadinessRegistry';
import { selectWorkers } from '../services/workerRegistry';

export type ConsumerRequirementRule =
  | 'redis'                   // required whenever Redis is available
  | 'abuse_or_partner_trust_enabled' // shared abuse/partner-trust consumer
  | 'audit_chain_verify_enabled' // audit verification kill switch
  | 'event_dispatch_enabled'  // D3a: eventDispatch (EVENT_DISPATCH_MODE !== 'off')
  | 'ai_agents_enabled';      // D3a: aiAgentRunner (AI_AGENTS_ENABLED)

export type WorkerInitializerClassification =
  | {
      kind: 'consumers';
      initializer: string;
      consumers: readonly string[];
      requiredWhen: ConsumerRequirementRule;
      /** D3a: declared (expect(name, false)) and attached, never required, never disabled. Subset of `consumers`. */
      optionalConsumers?: readonly string[];
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
  requiredWhen: ConsumerRequirementRule = 'redis',
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
  // D3a (spec section 4, C1): main's initializeAiAgentRunner returns before
  // constructing/attaching when BREEZE_AI_AGENTS_ENABLED is off (default).
  // socket-owner placement — a plain-required row would pin every api/all
  // process not-ready on the default configuration.
  consumers('aiAgentRunner', ['aiAgentRunner'], 'ai_agents_enabled'),
  consumers('auditBaselineJobs'),
  consumers('cisJobs'),
  consumers('automationWorker'),
  consumers('securityPostureWorker'),
  consumers('reliabilityWorker'),
  consumers('userRiskWorker'),
  consumers('abuseSignalsWorker', ['abuseSignalsWorker'], 'abuse_or_partner_trust_enabled'),
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
  consumers('auditChainVerify', ['auditChainVerify'], 'audit_chain_verify_enabled'),
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
  // Registry entries main added after Track C's merge base (wave 3.5d-b names;
  // registry entry name == consumer name). Rows 1-3 and 10-12 already attached
  // under exactly these names on main; rows 4-9 (authBrowserTransitionCleanup
  // through metricAnomalyIncidentPublisher) received their
  // attachWorkerObservability hook when the manifest was rekeyed to the registry.
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
  // Task 8 merge-forward (origin/main fcd5b498a): three more `global` registry
  // entries, each constructing one Worker and attaching unconditionally (no
  // flag gate before the attach — aiAgentImpactRollup reads
  // BREEZE_AI_AGENTS_ENABLED inside its job processor, not before construction).
  // aiAgentImpactRollup attaches under a name that differs from its registry key.
  consumers('accountingSyncWorker'),
  consumers('aiAgentImpactRollup', ['aiAgentImpactRollupWorker']),
  consumers('aiAgentGraduation'),
  // Task 8 merge-forward (origin/main ff9e10aec): five more `global` registry
  // entries. Each was read, not inferred from its name — none is feature-flag
  // gated, every one constructs exactly one Worker and attaches it
  // unconditionally inside a rethrowing try/catch, so all five are
  // plain-required (`redis`).
  // aiBudgetAlertDeliveryWorker attaches under AI_BUDGET_ALERT_QUEUE
  // ('ai-budget-alert-delivery'), which differs from its registry key, so the
  // row maps the key to that consumer name. Despite the name it reads no AI
  // flag at all (no env/*_ENABLED reference anywhere in the module);
  // accountingReconcileWorker likewise reads no integrations flag — its
  // per-connection gating happens inside the sweep job, at job time.
  consumers('aiBudgetAlertDeliveryWorker', ['ai-budget-alert-delivery']),
  consumers('ticketOutboxRetention'),
  consumers('intentOutboxRetention'),
  consumers('metricAnomalyIncidentRetention'),
  consumers('accountingReconcileWorker'),
  // Started outside WORKER_REGISTRY, role-gated in index.ts / worker.ts.
  // D3a: the dispatch consumer is constructed only when EVENT_DISPATCH_MODE is
  // on (or an off-mode backlog remains — that drain then attaches as
  // optional-running, no readiness effect). Maintenance registration is an
  // isolated failure domain on main (a Redis blip during boot must not pin
  // /ready for a housekeeping job), so it is declared, attached, and never
  // required — and never disabled, since it constructs regardless of the flag.
  {
    kind: 'consumers',
    initializer: 'eventDispatch',
    consumers: ['eventDispatch', 'eventDispatchMaintenance'],
    requiredWhen: 'event_dispatch_enabled',
    optionalConsumers: ['eventDispatchMaintenance'],
  },
  consumers('agentCommandRelay'),
] as const;

export function consumersForInitializer(initializer: string): readonly string[] {
  const classification = WORKER_READINESS_MANIFEST.find(
    (entry) => entry.initializer === initializer,
  );
  return classification?.kind === 'consumers' ? classification.consumers : [];
}

function ruleEnabled(
  rule: ConsumerRequirementRule,
  input: {
    partnerTrustEnabled: boolean;
    auditChainVerifyEnabled: boolean;
    abuseSignalsEnabled: boolean;
    eventDispatchEnabled: boolean;
    aiAgentsEnabled: boolean;
  },
): boolean {
  switch (rule) {
    case 'redis':
      return true;
    case 'abuse_or_partner_trust_enabled':
      return input.abuseSignalsEnabled || input.partnerTrustEnabled;
    case 'audit_chain_verify_enabled':
      return input.auditChainVerifyEnabled;
    case 'event_dispatch_enabled':
      return input.eventDispatchEnabled;
    case 'ai_agents_enabled':
      return input.aiAgentsEnabled;
  }
}

export function declareExpectedConsumers(input: {
  role: BreezeRole;
  redisAvailable: boolean;
  abuseSignalsEnabled: boolean;
  partnerTrustEnabled: boolean;
  auditChainVerifyEnabled: boolean;
  eventDispatchEnabled: boolean;
  aiAgentsEnabled: boolean;
  registry: WorkerReadinessRegistry;
}): void {
  if (!input.redisAvailable) return;

  // Only consumers this process will actually start exist for readiness.
  // Entries not selected for the role are not declared at all (not optional,
  // not disabled) — the public aggregate must not count them.
  const selected = new Set(selectWorkers(input.role).map((entry) => entry.name));
  if (input.role !== 'api') selected.add('eventDispatch');
  if (input.role !== 'worker') selected.add('agentCommandRelay');

  for (const entry of WORKER_READINESS_MANIFEST) {
    if (entry.kind === 'non_consumer') continue;
    if (!selected.has(entry.initializer)) continue;
    const enabled = ruleEnabled(entry.requiredWhen, input);
    const isOptional = (name: string): boolean => entry.optionalConsumers?.includes(name) ?? false;
    for (const name of entry.consumers) input.registry.expect(name, enabled && !isOptional(name));
    if (!enabled) {
      for (const name of entry.consumers) {
        if (!isOptional(name)) input.registry.disable(name, 'feature_disabled');
      }
    }
  }
}

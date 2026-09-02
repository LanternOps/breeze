import { describe, it, expect, beforeEach } from 'vitest';
import {
  WORKER_REGISTRY,
  selectWorkers,
  startRegisteredWorkers,
  buildWorkerShutdownTasks,
  _startWorkersForTest,
  _buildShutdownTasksForTest,
  _resetLoadedShutdownsForTest,
  type WorkerRegistration,
} from './workerRegistry';

// The canonical names, in today's `index.ts:1305-1433` order (see the plan
// doc, Task 1) plus every entry added since (e.g. `agentNotifyRetry`, wave 4a
// Task 6, #3826; `aiUnattendedExposureRetention`, wave 5B Task 4, #3827;
// `authBrowserTransitionCleanup`, auth browser transition Phase 1, #3852;
// `fixWatchWorker`, wave 6 PR 2 Task 3, #3828; `ticketOutboxPublisher`, wave
// 6 PR 3 Task 2, #3828; `metricAnomalyIncidentPublisher`, wave 6 PR 4 Task 2,
// #3828; `alertVerdictScheduler`, Phase 2 wave P2-1 Task 13; `aiAgentImpactRollup`,
// Phase 2 wave P2-6 Task A5, #4193; `aiAgentGraduation`, Phase 2 wave P2-5
// Task 9, #4192; `accountingReconcileWorker`, QuickBooks Phase D Task 4).
// This list is duplicated here deliberately — the whole point of the test is
// to catch drift between the plan's documented contract and the actual
// registry, so it must not import the list from the module under test.
const EXPECTED_119_NAMES = [
  'alertWorkers', 'alertCorrelationWorker', 'metricRollupsWorker', 'metricRollupMaintenance',
  'metricAnomaliesWorker', 'fleetFindingsWorker', 'fleetRemediationDispatchWorker', 'mlOutputRetention',
  'offlineDetector', 'notificationDispatcher', 'webhookDelivery', 'webhookDeliveryRecovery',
  'policyEvaluationWorker', 'softwareComplianceWorker', 'softwareRemediationWorker', 'aiAgentRunner',
  'agentNotifyRetry', 'fixWatchWorker',
  'auditBaselineJobs', 'cisJobs', 'automationWorker', 'securityPostureWorker',
  'reliabilityWorker', 'userRiskWorker', 'abuseSignalsWorker', 'userRiskRetention',
  'backupVerificationJobs', 'eventLogRetention', 'logCorrelationWorker', 'agentLogRetention',
  'ipHistoryRetention', 'reliabilityRetention', 'processSampleRetention', 'deviceMetricsRetention',
  'serviceProcessCheckRetention', 'changeLogRetention', 'oauthCleanup', 'authBrowserTransitionCleanup', 'stripeAccountCacheRefresh',
  'exchangeRateSync', 'oauthRevocationRetryWorker', 'mtlsCertificateRevocationWorker', 'authEmailWorker',
  'quoteSendWorker', 'enrollmentKeyCleanup', 'quickSupportReaper', 'softwareUploadSessionCleanup',
  'softwareRemediationRequestCleanup', 'auditRetention', 'auditChainVerify', 'auditChainAnchor',
  'tenantErasure', 'orgMerge', 'desktopSessionFinalization', 'desktopSessionOrphanRecovery', 'playbookRetention',
  'discoveryWorker', 'networkBaselineWorker', 'snmpWorker', 'monitorWorker',
  'unifiWorker', 'unifiTelemetryWorker', 'snmpRetention', 'patchComplianceReportWorker',
  'reportScheduleWorker', 'cveEnrichmentWorker', 'wingetIndexSyncWorker', 'vulnerabilityJobs',
  'dnsSyncWorker', 's1SyncWorker', 'huntressSyncWorker', 'pax8SyncWorker',
  'tdSynnexSftpSyncWorker', 'logForwardingWorker', 'patchJobWorker', 'patchSchedulerWorker',
  'maintenanceRebootWorker', 'backupWorker', 'sensitiveDataWorker', 'peripheralJobs',
  'browserSecurityWorker', 'c2cBackupWorker', 'backupSlaWorker', 'drExecutionWorker',
  'recoveryMediaWorker', 'recoveryBootMediaWorker', 'warrantyWorker', 'ssoDomainRecheckWorker',
  'incidentCorrelationWorker', 'incidentTimelineEnricher', 'incidentSlaMonitor', 'staleCommandReaper',
  'softwareDeploymentScheduler', 'pamJobs', 'approvalExpiryReaper', 'offboardingDrainReaper',
  'intentOutboxPublisher', 'pamActuationWorker', 'intentExpiryReaper', 'intentReleaseWorker', 'stripeReconcileSweep',
  'ticketAttachmentReaper', 'quoteExpiryReaper', 'suppressionExpiryReaper', 'ticketNotifyWorker', 'ticketOutboxPublisher',
  'ticketSlaWorker', 'inboundEmailWorker', 'ticketMailboxPollWorker', 'invoiceWorker',
  'metricAnomalyIncidentPublisher', 'contractWorker', 'aiUnattendedExposureRetention',
  'alertVerdictScheduler', 'aiAgentSweepScheduler', 'accountingSyncWorker', 'accountingReconcileWorker',
  'aiAgentImpactRollup',
  'aiAgentGraduation',
];

describe('workerRegistry: losslessness', () => {
  it('contains exactly the 119 known names, in order', () => {
    expect(WORKER_REGISTRY.map((e) => e.name)).toEqual(EXPECTED_119_NAMES);
  });

  it('has exactly 119 entries', () => {
    expect(WORKER_REGISTRY.length).toBe(119);
  });

  it('every entry has a well-formed shape', () => {
    for (const entry of WORKER_REGISTRY) {
      expect(typeof entry.name).toBe('string');
      expect(entry.name.length).toBeGreaterThan(0);
      expect(['global', 'socket-owner']).toContain(entry.placement);
      expect(typeof entry.load).toBe('function');
    }
  });

  it('has no duplicate names', () => {
    const names = WORKER_REGISTRY.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('workerRegistry: selectWorkers', () => {
  it("'all' selects every entry", () => {
    expect(selectWorkers('all').length).toBe(119);
    expect(selectWorkers('all')).toEqual(WORKER_REGISTRY);
  });

  it("'api' and 'worker' partition the set with no overlap and no loss", () => {
    const api = selectWorkers('api');
    const worker = selectWorkers('worker');
    expect(api.length + worker.length).toBe(119);

    const apiNames = new Set(api.map((e) => e.name));
    const workerNames = new Set(worker.map((e) => e.name));
    for (const name of apiNames) {
      expect(workerNames.has(name)).toBe(false);
    }
    const union = new Set([...apiNames, ...workerNames]);
    expect(union.size).toBe(119);
  });

  it("'api' selects only socket-owner placements", () => {
    for (const entry of selectWorkers('api')) {
      expect(entry.placement).toBe('socket-owner');
    }
  });

  it("'worker' selects only global placements", () => {
    for (const entry of selectWorkers('worker')) {
      expect(entry.placement).toBe('global');
    }
  });
});

describe('workerRegistry: startRegisteredWorkers / buildWorkerShutdownTasks (injectable seam)', () => {
  function makeEntry(
    name: string,
    placement: 'global' | 'socket-owner',
    opts: { failInit?: boolean; noShutdown?: boolean } = {},
  ): WorkerRegistration {
    return {
      name,
      placement,
      load: async () => ({
        init: async () => {
          if (opts.failInit) throw new Error(`${name} init failed`);
        },
        shutdown: opts.noShutdown ? undefined : async () => {},
      }),
    };
  }

  beforeEach(() => {
    _resetLoadedShutdownsForTest();
  });

  it('loads only entries selected for the role', async () => {
    const entries = [
      makeEntry('fakeGlobalA', 'global'),
      makeEntry('fakeSocketA', 'socket-owner'),
    ];
    const loaded: string[] = [];
    const wrapped = entries.map((e) => ({
      ...e,
      load: async () => {
        loaded.push(e.name);
        return e.load();
      },
    }));

    const results: Array<[string, boolean]> = [];
    await _startWorkersForTest(wrapped, 'worker', {
      onResult: (name, ok) => results.push([name, ok]),
    });

    expect(loaded).toEqual(['fakeGlobalA']);
    expect(results).toEqual([['fakeGlobalA', true]]);
  });

  it("role 'all' loads every entry in the injected set", async () => {
    const entries = [makeEntry('fakeGlobalB', 'global'), makeEntry('fakeSocketB', 'socket-owner')];
    const results: Array<[string, boolean]> = [];
    await _startWorkersForTest(entries, 'all', {
      onResult: (name, ok) => results.push([name, ok]),
    });
    expect(results.map((r) => r[0]).sort()).toEqual(['fakeGlobalB', 'fakeSocketB']);
    expect(results.every((r) => r[1])).toBe(true);
  });

  it('isolates a failing init to its own entry and reports it via onResult', async () => {
    const entries = [
      makeEntry('fakeOk', 'global'),
      makeEntry('fakeFail', 'global', { failInit: true }),
    ];
    const results: Array<[string, boolean, unknown]> = [];
    await _startWorkersForTest(entries, 'worker', {
      onResult: (name, ok, err) => results.push([name, ok, err]),
    });

    const byName: Record<string, { ok: boolean; err: unknown }> = Object.fromEntries(
      results.map(([n, ok, err]) => [n, { ok, err }]),
    );
    expect(byName.fakeOk?.ok).toBe(true);
    expect(byName.fakeFail?.ok).toBe(false);
    expect(byName.fakeFail?.err).toBeInstanceOf(Error);
    expect((byName.fakeFail?.err as Error).message).toBe('fakeFail init failed');
  });

  it('buildWorkerShutdownTasks returns shutdowns only for loaded entries, in registry order', async () => {
    const entries = [
      makeEntry('fakeShutA', 'global'),
      makeEntry('fakeShutB', 'global', { failInit: true }),
      makeEntry('fakeShutC', 'global'),
      makeEntry('fakeShutSocket', 'socket-owner'),
    ];
    await _startWorkersForTest(entries, 'worker', { onResult: () => {} });

    const tasks = await _buildShutdownTasksForTest(entries, 'worker');
    // fakeShutB's module still LOADED (only its init() threw), so its
    // shutdown fn is registered same as fakeShutA/fakeShutC — a partially
    // initialized worker still needs to be torn down on shutdown. Only
    // fakeShutSocket is excluded, because it wasn't selected for the
    // 'worker' role at all (never loaded).
    expect(tasks.length).toBe(3);
    // All returned tasks must be callable without throwing.
    await Promise.all(tasks.map((t) => t()));
  });

  it('an entry whose module loads but whose init() throws still contributes its shutdown task', async () => {
    const loadedNames: string[] = [];
    const entry: WorkerRegistration = {
      name: 'fakePartialInit',
      placement: 'global',
      load: async () => {
        loadedNames.push('fakePartialInit'); // module loaded...
        return {
          init: async () => {
            throw new Error('fakePartialInit init failed');
          },
          shutdown: async () => {},
        };
      },
    };

    const results: Array<[string, boolean]> = [];
    await _startWorkersForTest([entry], 'worker', {
      onResult: (name, ok) => results.push([name, ok]),
    });

    expect(loadedNames).toEqual(['fakePartialInit']); // ...even though init() threw
    expect(results).toEqual([['fakePartialInit', false]]);

    const tasks = await _buildShutdownTasksForTest([entry], 'worker');
    expect(tasks.length).toBe(1);
    await expect(tasks[0]!()).resolves.toBeUndefined();
  });

  it('an entry with no shutdown contributes no shutdown task even though it loaded', async () => {
    const entries = [makeEntry('fakeNoShutdown', 'global', { noShutdown: true })];
    await _startWorkersForTest(entries, 'worker', { onResult: () => {} });
    const tasks = await _buildShutdownTasksForTest(entries, 'worker');
    expect(tasks.length).toBe(0);
  });

  it('an entry never selected for the role contributes no shutdown task', async () => {
    const entries = [makeEntry('fakeSocketOnly', 'socket-owner')];
    await _startWorkersForTest(entries, 'api', { onResult: () => {} });
    // Now build for 'worker' — this entry is socket-owner, so it's excluded
    // by role filtering regardless of whether it loaded.
    const tasks = await _buildShutdownTasksForTest(entries, 'worker');
    expect(tasks.length).toBe(0);
  });
});

describe('workerRegistry: real startRegisteredWorkers / buildWorkerShutdownTasks wiring', () => {
  beforeEach(() => {
    _resetLoadedShutdownsForTest();
  });

  it('exposes the public entry points against the real registry without loading anything for an empty role selection', async () => {
    // Smoke-check the exported (non-test-seam) functions exist and are wired
    // to selectWorkers/the shared loaded-shutdown map, without actually
    // dynamic-importing all 104 real job modules (too heavy for a unit test).
    expect(typeof startRegisteredWorkers).toBe('function');
    expect(typeof buildWorkerShutdownTasks).toBe('function');
    // No entries have been started yet in this process, so shutdown tasks for
    // any role should be empty (no loaded-shutdown state accumulated).
    const tasks = await buildWorkerShutdownTasks('all');
    expect(tasks).toEqual([]);
  });
});

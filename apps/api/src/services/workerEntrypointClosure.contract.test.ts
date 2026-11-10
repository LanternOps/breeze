/**
 * Import-closure contract for the worker/api role split (wave 3.5d-b, #4086).
 *
 * The whole safety argument for a `worker`-role process ("no HTTP route
 * graph, no agent sockets") only holds if it's true at the MODULE level, not
 * just "nobody currently calls the socket functions". A worker-role process
 * that merely happens to import `routes/agentWs.ts` transitively still pays
 * for standing up every route's module-scope side effects, and one wrong
 * function call away from touching an in-memory socket map that is empty on
 * that process (silently wrong) instead of throwing (loudly wrong, which is
 * what `assertSocketLocalDispatchAllowed` is for).
 *
 * This file is pure static analysis: a tiny resolver walks the TRANSITIVE
 * RELATIVE import graph (regex-based — no TS compiler, no runtime `import()`
 * execution) starting from a file, and reports whether it reaches
 * `routes/agentWs.ts` / `services/agentCommandAwait.ts` / anything under
 * `routes/`. Two different traversal modes matter here:
 *
 *   - STATIC-ONLY (`followDynamic: false`): only `import ... from '<spec>'`
 *     (and `export ... from '<spec>'`) edges are followed. This is what
 *     `worker.ts`'s own assertion uses — `workerRegistry.ts`'s 104 entries
 *     are all behind `load: () => import(...)` thunks, and the whole point
 *     of that laziness is that `worker.ts` statically importing the
 *     REGISTRY module must not force-load any of the 104 job modules behind
 *     it. Following dynamic imports for this assertion would defeat its own
 *     purpose.
 *   - DYNAMIC-FOLLOWING (`followDynamic: true`): both static AND dynamic
 *     (`import('<spec>')`) edges are followed. This is what per-entry
 *     placement classification uses — a `global`-placement entry's module
 *     really does run its own `import()`s at runtime (e.g. a lazy relay
 *     helper), so the classification has to see the same graph the process
 *     will actually load, not just its static top-of-file imports.
 *
 * `import type` / `export type` lines are skipped (they vanish at compile
 * time — `tsc` erases them, so they carry no runtime reachability). A mixed
 * import like `import { type Foo, bar } from './m'` is NOT skipped: `bar` is
 * a real runtime binding, so the module is genuinely loaded.
 *
 * Placement is NOT a judgment call — see workerRegistry.ts's header comment
 * and the plan doc (docs/superpowers/plans/ai-mcp/2026-08-27-ai-agents-wave3.5d-b-role-split.md,
 * Task 5). This test is the mechanical authority: an entry marked `global`
 * whose closure reaches socket-local dispatch is a bug in the registry, not
 * in this test — fix it by flipping the entry's placement to `socket-owner`,
 * never by loosening this test. The reverse holds too: a `socket-owner` entry
 * whose closure is clean flips to `global`, or carries a `KEEP_SOCKET_OWNER`
 * reason below.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { WORKER_REGISTRY } from './workerRegistry';
import {
  AGENT_COMMAND_AWAIT,
  AGENT_COMMAND_RELAY,
  AGENT_WS,
  ROUTES_DIR,
  REGISTRY_FILE,
  SRC_ROOT,
  importClosure,
  isSocketLocalClean,
  parseFile,
  parseRegistrySource,
  relPath,
  resolveRelativeSpec,
  socketLocalOffenders,
  stripComments,
} from './workerClosure/closureGraph';

const WORKER_ENTRYPOINT = path.join(SRC_ROOT, 'worker.ts');
const INDEX_TS = path.join(SRC_ROOT, 'index.ts');

/** Worker-entrypoint check (test 1): `worker.ts` must reach NEITHER the two
 * socket-local modules NOR anything under `routes/` at all — a worker
 * process has no HTTP route graph, full stop, so even a route module with no
 * socket code of its own is forbidden here. */
function socketLocalOrRouteOffenders(closure: Set<string>): string[] {
  return [...closure].filter(
    (f) => f === AGENT_WS || f === AGENT_COMMAND_AWAIT || f.startsWith(ROUTES_DIR),
  );
}

// The names WORKER_REGISTRY must contain, in `index.ts`'s original order plus
// every entry added since (deliberately duplicated here, not imported from
// workerRegistry.test.ts — see Task 5 in the plan doc: this is an independent
// contract, not a shared fixture, so an edit that silently drops/renames an
// entry can't slip past both suites at once).
const EXPECTED_NAMES = [
  'psaTicketingWorker',
  'psaTicketingReconciler',
  'topologyReconcileWorker',
  'topologyCollectionRetentionWorker',
  'topologyOutboxWorker',
  'topologyTemplateApplyWorker',
  'topologyDiagnosticWorker',
  'topologyMonitoringWorker',
  'topologyDiagnosticSweeper',
  'topologyTelemetryMaintenance',
  'topologyPresenceWorker',
  'alertWorkers', 'monitorConversionPreviewWorker', 'alertCorrelationWorker', 'metricRollupsWorker', 'metricRollupMaintenance',
  'metricAnomaliesWorker', 'aiBudgetAlertDeliveryWorker', 'connectionHealthReconcileWorker', 'connectionHealthDigestWorker', 'fleetFindingsWorker', 'fleetRemediationDispatchWorker', 'mlOutputRetention', 'aiToolOutputRetention', 'aiTranscriptSweeper',
  'offlineDetector', 'notificationDispatcher', 'webhookDelivery', 'webhookDeliveryRecovery',
  'policyEvaluationWorker', 'softwareComplianceWorker', 'softwareRemediationWorker', 'aiAgentRunner',
  'agentNotifyRetry', 'fixWatchWorker',
  'auditBaselineJobs', 'cisJobs', 'automationWorker', 'securityPostureWorker',
  'reliabilityWorker', 'userRiskWorker', 'abuseSignalsWorker', 'userRiskRetention',
  'backupVerificationJobs', 'eventLogRetention', 'hardwareHealthRetention', 'timeSyncRetention', 'logCorrelationWorker', 'agentLogRetention',
  'ticketOutboxRetention', 'intentOutboxRetention', 'metricAnomalyIncidentRetention', 'wispConcernRetention', 'aiChatSessionExpirySweep', 'wispNudgeDigest',
  'ipHistoryRetention', 'reliabilityRetention', 'processSampleRetention', 'deviceMetricsRetention',
  'm365SyncRetention', 'filesystemCleanupRunRetention',
  'serviceProcessCheckRetention', 'changeLogRetention', 'restorePointAttemptRetention', 'wakeAttemptSweep', 'wakeAttemptRetention', 'webhookDeliveryRetention', 'dnsSecurityRetention', 'oauthCleanup', 'authBrowserTransitionCleanup', 'stripeAccountCacheRefresh',
  'exchangeRateSync', 'oauthRevocationRetryWorker', 'mtlsCertificateRevocationWorker', 'authEmailWorker',
  'quoteSendWorker', 'enrollmentKeyCleanup', 'migrationWindowSweep', 'ticketImportWorker', 'partnerApiIdempotencyRetention', 'quickSupportReaper', 'wispGrantReconciler', 'softwareUploadSessionCleanup',
  'softwareRemediationRequestCleanup', 'auditRetention', 'pamEvidenceRetention', 'auditChainVerify', 'auditChainAnchor',
  'tenantErasure', 'orgMerge', 'deviceBulkPurge', 'removedDevicePurge', 'parkedDeviceExpiry', 'parkedDevicePurge', 'deviceReattachIntentSweep', 'desktopSessionFinalization', 'desktopSessionOrphanRecovery', 'playbookRetention',
  // Helper-uploaded screenshot retention (per-device storage quota).
  'helperScreenshotRetentionWorker',
  // Endpoint messaging (#8742 W02): message/delivery row retention.
  'endpointMessageRetention',
  'discoveryWorker', 'networkBaselineWorker', 'snmpWorker', 'monitorWorker',
  // #5291 W04 — dispatches `script` monitors' diagnostic probes.
  'monitorScriptWorker',
  'unifiWorker', 'unifiTelemetryWorker', 'snmpRetention', 'patchComplianceReportWorker', 'patchReportRetention',
  'reportScheduleWorker', 'cveEnrichmentWorker', 'wingetIndexSyncWorker', 'vulnerabilityJobs',
  'dnsSyncWorker', 's1SyncWorker', 'huntressSyncWorker',
  // Backup provider integration W02 (#6008 / #6010).
  'backupProviderSyncWorker',
  // EDR provider framework W01 (#8164).
  'edrProviderSyncWorker',
  // Security agent coverage reconciliation (#6960 W03).
  'securityAgentCoverageWorker',
  'm365SyncWorker', 'pax8SyncWorker',
  'tdSynnexSftpSyncWorker', 'logForwardingWorker', 'patchJobWorker', 'patchSchedulerWorker',
  'maintenanceRebootWorker', 'oemUpdatesWorker', 'backupWorker', 'backupSnapshotFileIndexWorker', 'backupSnapshotAttestationWorker', 'backupWriteSessionJanitor', 'sensitiveDataWorker', 'securityScanWorker', 'peripheralJobs',
  'deviceGroupJobs', 'partnerGroupEvaluationJobs',
  'browserSecurityWorker', 'c2cBackupWorker', 'backupSlaWorker', 'drExecutionWorker',
  'recoveryMediaWorker', 'warrantyWorker', 'ssoDomainRecheckWorker', 'portalDomainRecheckWorker',
  'incidentCorrelationWorker', 'incidentTimelineEnricher', 'incidentSlaMonitor', 'staleCommandReaper',
  'softwareDeploymentScheduler', 'pamJobs', 'approvalExpiryReaper', 'networkIsolationSweeper', 'workspaceReaper', 'offboardingDrainReaper',
  'intentOutboxPublisher', 'aiOperatorTaskOutboxPublisher', 'aiOperatorTaskWorker', 'pamActuationWorker', 'intentExpiryReaper', 'intentReleaseWorker', 'stripeReconcileSweep',
  'stripeSessionRevocationSweep',
  'ticketAttachmentReaper', 'aiArtifactSweeper', 'quoteExpiryReaper', 'agreementRequestExpiryReaper',
  // Portal registration W3 — daily portal identity drift report.
  'portalIdentityReconcile',
  'agreementRequestAutoReminder', 'suppressionExpiryReaper', 'ticketNotifyWorker', 'ticketOutboxPublisher',
  'callerVerificationPublisher',
  'callerVerificationReconciliation',
  'ticketSlaWorker', 'businessCalendarRecomputeWorker', 'inboundEmailWorker', 'gmailMarkHandledWorker', 'ticketMailboxPollWorker', 'invoiceWorker', 'autopayWorker',
  'metricAnomalyIncidentPublisher', 'contractWorker', 'deliverableWorker', 'aiUnattendedExposureRetention',
  'aiInvocationRetention', 'llmEgressRetention',
  // AI chargeback W10 (#7608) — daily monthly-close sweep.
  'aiChargebackWorker',
  'alertVerdictScheduler', 'aiAgentSweepScheduler',
  // Wisp W05b Task 9 (#9917).
  'wispWakeScheduler',
  'accountingSyncWorker', 'accountingReconcileWorker',
  'aiAgentImpactRollup',
  'aiAgentGraduation',
  'scriptReviewWorker',
  'scriptVerifyWorker',
  'aiBudgetReservationSweep',
  'mfaEnrollmentNoticeWorker',
  'monitorEpisodeRetention',
  // EDR provider framework W02 (#8164).
  'edrDetectionRetentionWorker',
  'reportRunDeliveryReconciler',
  // Tool Catalog W1 (#5215 / #5216), Task A6.
  'toolSourceDiscoveryWorker',
  // Tool catalog W04 (#5219), Task A8.
  'flowRunner', 'flowRunReconciler', 'flowRunRetention', 'flowScheduleTick',
  // Partner sending domains W03 (#6183).
  'sendingDomainsWorker',
  // AI Suggested Fixes W1.
  'fixOutcomeWorker',
  'aiModelDiscoveryWorker',
  // Workload image currency W05 (#8194).
  'imageCurrencyWorker',
  // Trust Center W1 (#8768).
  'trustPageSnapshotWorker',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workerEntrypointClosure contract (#4086 Task 5)', () => {
  it('worker.ts exists (the worker entrypoint this contract is about)', () => {
    expect(fs.existsSync(WORKER_ENTRYPOINT)).toBe(true);
  });

  it('worker.ts static import closure never reaches route modules or socket-local dispatch', () => {
    const closure = importClosure(WORKER_ENTRYPOINT, { followDynamic: false });
    const offenders = socketLocalOrRouteOffenders(closure);
    const indexOffender = closure.has(INDEX_TS) ? [INDEX_TS] : [];
    const all = [...offenders, ...indexOffender];
    expect(
      all,
      all.length > 0
        ? `worker.ts's STATIC import closure reaches: ${all.map(relPath).join(', ')}. ` +
            `This must stay lazy (behind workerRegistry.ts's load() thunks) — a worker-role ` +
            `process must never statically pull in the route graph or socket-local dispatch.`
        : undefined,
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Seeded closure (final-review fix, #4086): the test above only follows
  // worker.ts's own STATIC top-of-file imports, which by design (see
  // worker.ts's header) is almost nothing — every heavier dependency is
  // loaded via `await import(...)` inside `bootWorker()`. That made the test
  // above vacuous against the modules that actually matter: it never walked
  // into services/eventSubscribers.ts or extensions/builtinExtensions.ts at
  // all, so it could not have caught either of these two real routes/-reaching
  // chains that existed before this fix:
  //   (i)  services/eventSubscribers.ts -> jobs/automationWorker.ts ->
  //        services/automationRuntime.ts -> services/scriptDispatch.ts ->
  //        routes/agentWs.ts (now broken: the automation-worker subscriber's
  //        handler dynamically imports automationWorker.ts on first fire).
  //   (ii) extensions/builtinExtensions.ts -> extensions/stageExtension.ts ->
  //        services/aiTools.ts -> services/aiToolsBackup.ts ->
  //        services/commandQueue.ts -> routes/agentWs.ts (now broken:
  //        stageExtension.ts imports the reserved-tool-name check from the
  //        new leaf module services/aiToolNames.ts instead of the full
  //        aiTools.ts hub).
  //
  // This test seeds from the literal `await import('<spec>')` specifiers
  // worker.ts's own source contains, resolves each to a file, and walks
  // EACH one statically (dynamic-follow OFF beyond the seed — a seed module's
  // own further `await import(...)`s are its own lazy boundary, not
  // worker.ts's problem). services/workerRegistry.ts is deliberately EXCLUDED
  // from the seed set: its whole point is 104 `load()` thunks that must stay
  // unfollowed, and this is a static-only walk regardless (see the module
  // header on `importClosure`'s two modes).
  describe('worker.ts SEEDED boot closure (its own dynamic-import specifiers, walked statically from each)', () => {
    /**
     * A specific (seed module, offending route file) pair allowed to remain
     * in the seeded closure, with a reviewer-facing justification. Each entry
     * names the EXACT file reached, not a blanket routes/ exemption — a
     * different, new routes/ file surfacing under an already-allowlisted
     * seed still fails the assertion below.
     */
    const SEEDED_CLOSURE_ALLOWLIST: ReadonlyArray<{
      seedSpec: string;
      offenderRelPath: string;
      reason: string;
    }> = [
      {
        seedSpec: './jobs/aiAgentEnqueuer',
        offenderRelPath: 'routes/auth/schemas.ts',
        reason:
          'jobs/aiAgentEnqueuer.ts -> services/aiAgents/runService.ts -> ' +
          'services/aiAgents/agentAuthContext.ts -> middleware/auth.ts -> ' +
          'routes/auth/schemas.ts. This file is inert data under routes/ (two ' +
          'envFlag()-derived booleans plus Zod schemas) — no socket state, no ' +
          'HTTP handler registration, nothing shaped like routes/agentWs.ts. ' +
          'Breaking this chain means extracting ENABLE_2FA out of ' +
          'middleware/auth.ts — one of the highest-blast-radius files in the ' +
          'app — which needs its own reviewed change, not a rider on this ' +
          'closure-contract fix. Structural residue, reported honestly ' +
          '(#4086 final-review pass) rather than silently patched.',
      },
    ];

    it('worker.ts has dynamic-import seeds to walk (sanity: this test is not vacuous)', () => {
      const { dynamicSpecs } = parseFile(WORKER_ENTRYPOINT);
      expect(dynamicSpecs.length).toBeGreaterThan(0);
    });

    it('every seed reaches no route file beyond the explicit allowlist', () => {
      const { dynamicSpecs } = parseFile(WORKER_ENTRYPOINT);
      const seedSpecs = [...new Set(dynamicSpecs)];
      const seeds = seedSpecs
        .map((spec) => ({ spec, file: resolveRelativeSpec(WORKER_ENTRYPOINT, spec) }))
        .filter((s): s is { spec: string; file: string } => s.file !== null && s.file !== REGISTRY_FILE);

      const allowedPairs = new Map(
        SEEDED_CLOSURE_ALLOWLIST.map((e) => [`${e.seedSpec}::${e.offenderRelPath}`, e]),
      );
      const usedAllowlistKeys = new Set<string>();
      const unexplained: string[] = [];

      for (const { spec, file } of seeds) {
        const closure = importClosure(file, { followDynamic: false });
        const routeOffenders = [...closure].filter(
          (f) => f.startsWith(ROUTES_DIR) || f === AGENT_COMMAND_AWAIT,
        );
        for (const offender of routeOffenders) {
          const key = `${spec}::${relPath(offender)}`;
          if (allowedPairs.has(key)) {
            usedAllowlistKeys.add(key);
          } else {
            unexplained.push(`${spec} (-> ${relPath(file)}) -> ... -> ${relPath(offender)}`);
          }
        }
      }

      expect(
        unexplained,
        unexplained.length > 0
          ? `worker.ts's SEEDED boot closure reaches unexplained route file(s): ${unexplained.join('; ')}. ` +
              `Either break the chain (a lazy dynamic-import conversion — see eventSubscribers.ts's ` +
              `automation-worker handler or services/aiToolNames.ts for the pattern) or add a justified ` +
              `SEEDED_CLOSURE_ALLOWLIST entry above.`
          : undefined,
      ).toEqual([]);

      // Staleness check: every allowlisted pair must still actually occur in
      // the real closure — an entry that no longer fires is stale slack that
      // must be deleted, not kept "just in case".
      const staleEntries = SEEDED_CLOSURE_ALLOWLIST.filter(
        (e) => !usedAllowlistKeys.has(`${e.seedSpec}::${e.offenderRelPath}`),
      );
      expect(
        staleEntries,
        staleEntries.length > 0
          ? `SEEDED_CLOSURE_ALLOWLIST entries no longer match the real closure (delete them): ` +
              staleEntries.map((e) => `${e.seedSpec} -> ${e.offenderRelPath}`).join('; ')
          : undefined,
      ).toEqual([]);
    });
  });

  it('registry losslessness: WORKER_REGISTRY names set-equal the expected-name list', () => {
    const actual = WORKER_REGISTRY.map((e) => e.name);
    expect(new Set(actual)).toEqual(new Set(EXPECTED_NAMES));
    expect(actual.length).toBe(EXPECTED_NAMES.length);
  });

  describe('global-placement entries never reach socket-local dispatch', () => {
    it('collection engine merge provenance does not load the merge engine or socket dispatch', () => {
      const closure = importClosure(path.join(SRC_ROOT, 'services/autopay/collectionEngine.ts'), { followDynamic: true });
      expect([...closure].map(relPath)).not.toContain('services/orgMerge.ts');
      expect(socketLocalOffenders(closure)).toEqual([]);
    });

    const entries = parseRegistrySource();
    // sanity: the source-parsing regex itself must find every registry entry
    expect(entries.length).toBe(EXPECTED_NAMES.length);

    const globalEntries = entries.filter((e) => e.placement === 'global');
    expect(globalEntries.length).toBeGreaterThan(0);

    for (const entry of globalEntries) {
      it(`${entry.name} (-> ${entry.spec})`, () => {
        const target = resolveRelativeSpec(REGISTRY_FILE, entry.spec);
        expect(target, `could not resolve load() spec "${entry.spec}" for entry "${entry.name}"`).not.toBeNull();
        const closure = importClosure(target as string, { followDynamic: true });
        const offenders = socketLocalOffenders(closure);
        expect(
          offenders,
          offenders.length > 0
            ? `"${entry.name}" is placed 'global' but its runtime import closure reaches ` +
                `socket-local dispatch via: ${offenders.map(relPath).join(', ')}. ` +
                `Flip its placement to 'socket-owner' in workerRegistry.ts.`
            : undefined,
        ).toEqual([]);
      });
    }
  });

  // Ratchet (#4142): the check above only forbids a `global` entry from being
  // dirty. This is the reverse: a `socket-owner` entry whose closure is clean
  // is pinned by habit, not by need, and keeps its worker-split capacity on the
  // api container. Placement is mechanical: flip it, or record why it stays.
  describe('socket-owner entries are pinned only for a recorded reason', () => {
    /** socket-owner entries that stay pinned even though their closure is clean. */
    const KEEP_SOCKET_OWNER: ReadonlyArray<{ name: string; reason: string }> = [
      {
        name: 'aiTranscriptSweeper',
        reason:
          "#9050: sweeps disk-local AI transcript files under the api container's CLAUDE_CONFIG_DIR; " +
          'must run where the files are written',
      },
    ];

    const entries = parseRegistrySource();
    const keepNames = new Set(KEEP_SOCKET_OWNER.map((k) => k.name));

    it('no socket-owner entry is pinned by habit: a clean closure means global or a KEEP_SOCKET_OWNER reason', () => {
      const pinnedByHabit = entries
        .filter((e) => e.placement === 'socket-owner' && !keepNames.has(e.name) && isSocketLocalClean(e))
        .map((e) => e.name);
      expect(
        pinnedByHabit,
        pinnedByHabit.length > 0
          ? `these socket-owner entries have a clean closure: flip to 'global' in workerRegistry.ts ` +
              `(or add a KEEP_SOCKET_OWNER entry with a reason): ${pinnedByHabit.join(', ')}`
          : undefined,
      ).toEqual([]);
    });

    it('KEEP_SOCKET_OWNER has no stale entries', () => {
      const stale = KEEP_SOCKET_OWNER.filter((k) => {
        const e = entries.find((x) => x.name === k.name);
        return !e || e.placement !== 'socket-owner' || !isSocketLocalClean(e);
      }).map((k) => k.name);
      expect(
        stale,
        stale.length > 0
          ? `KEEP_SOCKET_OWNER entries that no longer exist, are not socket-owner, or are no longer ` +
              `clean (delete them): ${stale.join(', ')}`
          : undefined,
      ).toEqual([]);
    });
  });

  // #4141: the boundary exemption above is valid ONLY while agentCommandRelay's
  // socket-local access stays a dynamic import behind role guards. A reverted
  // static value-import would make every `global` facade caller load agentWs in
  // a worker process again — so the exemption self-invalidates here.
  describe('the role-safe boundary module holds its side of the bargain', () => {
    it('agentCommandRelay.ts static CLOSURE reaches no socket-local module and no routes/ file', () => {
      // A direct-spec check would be strictly narrower than the exemption it
      // justifies: an INDIRECT static edge (e.g. importing a hub module that
      // value-imports agentWs) or any other route reachability would re-pin
      // agentWs into the worker container while a direct check stays green.
      // importClosure skips boundary modules only when they are non-entry
      // nodes, so walking FROM the relay traverses it fully.
      const closure = importClosure(AGENT_COMMAND_RELAY, { followDynamic: false });
      const offenders = [...closure].filter(
        (f) => f === AGENT_WS || f === AGENT_COMMAND_AWAIT || f.startsWith(ROUTES_DIR),
      );
      expect(
        offenders,
        offenders.length > 0
          ? 'services/agentCommandRelay.ts statically reaches socket-local/route modules again '
            + `(via: ${offenders.map(relPath).join(', ')}) — either restore the lazy role-guarded `
            + 'import shape (#4141) or remove it from ROLE_SAFE_BOUNDARY_MODULES and '
            + 're-classify every facade caller.'
          : undefined,
      ).toEqual([]);
    });

    it('socketLocal() is the only dynamic agentWs edge, hoisted nowhere, and both call sites are role-guarded', () => {
      const src = stripComments(fs.readFileSync(AGENT_COMMAND_RELAY, 'utf8'));
      // The dynamic import must live INSIDE the socketLocal function body —
      // a module-scope hoist (`const p = import('../routes/agentWs')`) would
      // load agentWs at relay-module load, i.e. in every worker process,
      // defeating the boundary while a whole-file match stays green.
      const fnStart = src.indexOf('async function socketLocal');
      expect(fnStart, 'socketLocal() function not found in agentCommandRelay.ts').toBeGreaterThan(-1);
      // The import must sit within the function (its body is tiny — the type
      // annotation plus a single return), never hoisted above it.
      const fnWindow = src.slice(fnStart, fnStart + 500);
      expect(fnWindow).toMatch(/return import\('\.\.\/routes\/agentWs'\)/);
      expect(src.slice(0, fnStart)).not.toMatch(/import\(\s*['"]\.\.\/routes\/agentWs['"]\s*\)/);
      const dynamicAgentWsEdges = src.match(/import\(\s*['"]\.\.\/routes\/agentWs['"]\s*\)/g) ?? [];
      expect(dynamicAgentWsEdges.length, 'exactly one dynamic agentWs edge (inside socketLocal)').toBe(1);
      // Every socketLocal() consumer sits behind a worker-role check: each
      // call must appear on a line/branch whose preceding 300 chars contain
      // the guard. Coarse but comment-stripped and call-site-anchored.
      const callSites = [...src.matchAll(/socketLocal\(\)/g)].map((m) => m.index!);
      const consumerSites = callSites.filter((i) => !src.slice(Math.max(0, i - 40), i).includes('function '));
      expect(consumerSites.length).toBeGreaterThanOrEqual(2);
      for (const i of consumerSites) {
        expect(
          src.slice(Math.max(0, i - 300), i),
          'a socketLocal() consumer lost its breezeRole() !== worker guard',
        ).toMatch(/breezeRole\(\) !== 'worker'/);
      }
    });
  });
});

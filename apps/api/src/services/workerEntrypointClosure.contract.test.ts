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
 * never by loosening this test.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { WORKER_REGISTRY } from './workerRegistry';

const SRC_ROOT = path.resolve(__dirname, '..'); // apps/api/src
const REGISTRY_FILE = path.join(SRC_ROOT, 'services', 'workerRegistry.ts');
const WORKER_ENTRYPOINT = path.join(SRC_ROOT, 'worker.ts');
const INDEX_TS = path.join(SRC_ROOT, 'index.ts');
const AGENT_WS = path.join(SRC_ROOT, 'routes', 'agentWs.ts');
const AGENT_COMMAND_AWAIT = path.join(SRC_ROOT, 'services', 'agentCommandAwait.ts');
const ROUTES_DIR = path.join(SRC_ROOT, 'routes') + path.sep;

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

const RESOLVABLE_EXTS = ['.ts', '.tsx'];

/** Resolves a relative import specifier to an on-disk file. Bare/package
 * specifiers (no leading `.`) return null — they're runtime-safe (node_modules
 * code doesn't reach our route graph) and out of scope for this walk. */
function resolveRelativeSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    ...RESOLVABLE_EXTS.map((ext) => base + ext),
    ...RESOLVABLE_EXTS.map((ext) => path.join(base, `index${ext}`)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// `import ... from '<spec>'` / `export ... from '<spec>'`, excluding
// `import type` / `export type` (pure type-only — erased at compile time).
// Bounded by `[^;]*?` (not `[\s\S]*?`) so the non-greedy match can't cross a
// statement-terminating semicolon and accidentally swallow unrelated code
// between an `export function ...` keyword and some later, unrelated `from`
// token (e.g. inside a Drizzle query) — real import/export-from statements in
// this codebase are always semicolon-terminated, including multi-line ones.
const STATIC_FROM_RE = /\b(?:import|export)\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/g;

// `import('<spec>')` / `await import('<spec>')` — dynamic loads.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Blanks out `//` and `/* *\/` comments (preserving string/template literal
 * contents verbatim, so quoted specifiers inside them still parse correctly)
 * before the import regexes run. Without this, prose like a JSDoc paragraph
 * that MENTIONS `import('./index')` as an example of a pattern the code
 * DELIBERATELY AVOIDS reads as a real dynamic-import edge — which is exactly
 * what `services/sentry.ts`'s header comment does, and which turned nearly
 * every entry's closure into a false-positive hit on `services/commandQueue.ts`
 * (which really does import `routes/agentWs.ts`) via `services/index.ts`'s
 * barrel `export * from './commandQueue'` — a graph edge that exists only in
 * a code sample inside a comment, not in `services/sentry.ts`'s real imports.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src[i];
          i++;
          if (i < n) {
            out += src[i];
            i++;
          }
          continue;
        }
        out += src[i];
        i++;
      }
      if (i < n) {
        out += src[i];
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface ParsedFile {
  staticSpecs: string[];
  dynamicSpecs: string[];
}

const parseCache = new Map<string, ParsedFile>();

function parseFile(file: string): ParsedFile {
  const cached = parseCache.get(file);
  if (cached) return cached;
  const content = stripComments(fs.readFileSync(file, 'utf8'));
  const staticSpecs = [...content.matchAll(STATIC_FROM_RE)].map((m) => m[1]!);
  const dynamicSpecs = [...content.matchAll(DYNAMIC_IMPORT_RE)].map((m) => m[1]!);
  const parsed: ParsedFile = { staticSpecs, dynamicSpecs };
  parseCache.set(file, parsed);
  return parsed;
}

/**
 * Transitive closure of relative-import edges reachable from `entryFile`,
 * as absolute file paths (entryFile itself included). `followDynamic`
 * chooses whether `import('...')` edges are traversed — see the module
 * header comment for why both modes are needed.
 */
/**
 * Role-safe boundary modules (#4141): the walk records them but does NOT
 * traverse their imports. `services/agentCommandRelay.ts` is the ONE module
 * designed to be loaded by every placement: its only socket-local access is a
 * dynamic `import('../routes/agentWs')` inside `breezeRole() !== 'worker'`
 * guards, and 3.5b's runtime assertions make any illegal call THROW rather
 * than silently report agents offline. Treating it as a leaf is what lets the
 * facade's callers (monitor/snmp/backup/discovery/networkBaseline) be
 * `global` — the entire point of the relay. Any OTHER path to agentWs still
 * classifies an entry socket-owner.
 */
const AGENT_COMMAND_RELAY = path.join(SRC_ROOT, 'services', 'agentCommandRelay.ts');
const ROLE_SAFE_BOUNDARY_MODULES = new Set([AGENT_COMMAND_RELAY]);

function importClosure(entryFile: string, opts: { followDynamic: boolean }): Set<string> {
  const visited = new Set<string>();
  const stack: string[] = [entryFile];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    if (file !== entryFile && ROLE_SAFE_BOUNDARY_MODULES.has(file)) continue;
    const { staticSpecs, dynamicSpecs } = parseFile(file);
    const specs = opts.followDynamic ? [...staticSpecs, ...dynamicSpecs] : staticSpecs;
    for (const spec of specs) {
      const resolved = resolveRelativeSpec(file, spec);
      if (resolved && !visited.has(resolved)) stack.push(resolved);
    }
  }
  return visited;
}

/** Worker-entrypoint check (test 1): `worker.ts` must reach NEITHER the two
 * socket-local modules NOR anything under `routes/` at all — a worker
 * process has no HTTP route graph, full stop, so even a route module with no
 * socket code of its own is forbidden here. */
function socketLocalOrRouteOffenders(closure: Set<string>): string[] {
  return [...closure].filter(
    (f) => f === AGENT_WS || f === AGENT_COMMAND_AWAIT || f.startsWith(ROUTES_DIR),
  );
}

/** Per-entry placement check (test 2): narrower than the entrypoint check —
 * a `global`-placement job module is allowed to transitively reach some
 * unrelated route file (e.g. a shared Zod schema module under `routes/`,
 * which is inert data, not socket dispatch code); it must only avoid the two
 * modules that actually hold live agent-socket state / dispatch. Reaching
 * `routes/agentWs.ts` or `services/agentCommandAwait.ts` is what pulls in a
 * module-scope socket registry, not merely landing under `routes/`. */
function socketLocalOffenders(closure: Set<string>): string[] {
  return [...closure].filter((f) => f === AGENT_WS || f === AGENT_COMMAND_AWAIT);
}

function relPath(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Registry source parsing — (name, placement, load-target-spec) triples,
// read straight from workerRegistry.ts's source text rather than via the
// live `WORKER_REGISTRY` import, because the load spec (the string literal
// argument to `await import(...)`) isn't part of the `WorkerRegistration`
// TYPE (only the thunk function value is) and this test must never actually
// INVOKE `load()` — doing so would run the real job module's init-adjacent
// module-scope code. `WORKER_REGISTRY` itself IS imported below, but only
// its plain `name`/`placement` string fields are read.
// ---------------------------------------------------------------------------

interface RegistryEntrySource {
  name: string;
  placement: string;
  spec: string;
}

const ENTRY_SOURCE_RE =
  /name:\s*'([^']+)'[\s\S]*?placement:\s*'([^']+)'[\s\S]*?await import\(\s*['"]([^'"]+)['"]\s*\)/g;

function parseRegistrySource(): RegistryEntrySource[] {
  // stripComments matters here too: one entry's placement doc-comment
  // literally quotes `await import('../routes/agentWs')` while explaining a
  // DIFFERENT module's runtime path (see offboardingDrainReaper's comment in
  // workerRegistry.ts) — without stripping, a naive regex could pick up that
  // quoted mention instead of (or alongside) the entry's own real `load()`
  // import spec.
  const content = stripComments(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  return [...content.matchAll(ENTRY_SOURCE_RE)].map((m) => ({
    name: m[1]!,
    placement: m[2]!,
    spec: m[3]!,
  }));
}

// The names WORKER_REGISTRY must contain, in `index.ts`'s original order plus
// every entry added since (deliberately duplicated here, not imported from
// workerRegistry.test.ts — see Task 5 in the plan doc: this is an independent
// contract, not a shared fixture, so an edit that silently drops/renames an
// entry can't slip past both suites at once).
const EXPECTED_NAMES = [
  'alertWorkers', 'alertCorrelationWorker', 'metricRollupsWorker', 'metricRollupMaintenance',
  'metricAnomaliesWorker', 'aiBudgetAlertDeliveryWorker', 'fleetFindingsWorker', 'fleetRemediationDispatchWorker', 'mlOutputRetention',
  'offlineDetector', 'notificationDispatcher', 'webhookDelivery', 'webhookDeliveryRecovery',
  'policyEvaluationWorker', 'softwareComplianceWorker', 'softwareRemediationWorker', 'aiAgentRunner',
  'agentNotifyRetry', 'fixWatchWorker',
  'auditBaselineJobs', 'cisJobs', 'automationWorker', 'securityPostureWorker',
  'reliabilityWorker', 'userRiskWorker', 'abuseSignalsWorker', 'userRiskRetention',
  'backupVerificationJobs', 'eventLogRetention', 'logCorrelationWorker', 'agentLogRetention',
  'ticketOutboxRetention', 'intentOutboxRetention', 'metricAnomalyIncidentRetention',
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
    const entries = parseRegistrySource();
    expect(entries.length).toBe(123); // sanity: the source-parsing regex itself must find all 123

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

  // #4141: the boundary exemption above is valid ONLY while agentCommandRelay's
  // socket-local access stays a dynamic import behind role guards. A reverted
  // static value-import would make every `global` facade caller load agentWs in
  // a worker process again — so the exemption self-invalidates here.
  describe('the role-safe boundary module holds its side of the bargain', () => {
    it('agentCommandRelay.ts static CLOSURE reaches no socket-local module and no routes/ file', () => {
      // A direct-spec check would be strictly narrower than the exemption it
      // justifies: an INDIRECT static edge (e.g. importing commandQueue, which
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

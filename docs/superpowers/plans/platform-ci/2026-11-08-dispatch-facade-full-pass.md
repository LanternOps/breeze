---
tracking_issue: LanternOps/breeze#11505
---

# Dispatch Facade Full Pass (#4142) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Rigor: HIGH for W2** (cross-process socket eviction, tenant containment, Quick Support teardown). Normal-plus for W1 (command-delivery claims) and W3.

**Goal:** Take the 42 pinned `socket-owner` worker-registry entries to 0. Do it by moving the 11 remaining socket-local importers onto the role-safe facade, adding a fenced cross-process eviction, and making the registry contract test fail when a clean entry stays pinned.

**Architecture:** `services/agentCommandRelay.ts` stays the single door from services into the agent socket map. W1 hardens its outcome contract and moves command sends onto it. W2 adds a list-shaped, connection-fenced `relay-evict` operation to the same per-instance relay shards, plus a second narrow role-safe boundary for the terminal/tunnel *browser*-socket close. W3 moves the device cascade tables out of a route file and migrates the last eviction caller. Placement flips are mechanical. The closure tool and the contract test decide them, never judgement.

**Tech Stack:** TypeScript (Hono API), BullMQ + Redis, Vitest. No schema changes.

**Spec:** Issue #4142 and its 2026-11-08 closure-analysis comment. Prior art this plan builds on: `docs/superpowers/plans/ai-mcp/2026-08-27-ai-agents-wave3.5d-b-role-split.md` (registry and placement, #4086), the relay #4084, per-instance shards #4134, the lazy boundary #4141, and the PAM outcome precedent `jobs/pamActuationWorker.ts:235`. Operator runbook: `docs/deploy/worker-split.md`.

## Global Constraints

- **No migrations, no new tables, no RLS change.** None of the four registration lists (`CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY`, the device/ticket lists) gains or loses a table. W3 *moves* the device cascade list's home (see OD-5), so `docs/agents/tenancy-rls.md` must change in the same PR.
- **Placement is mechanical.** An entry flips to `global` in the same commit its closure becomes clean. The ratchet test added in W1.T1 enforces this. The flip lists below assume the task order given; if you reorder, run the tool and let the ratchet decide.
- **Type-only imports of `routes/agentWs` must be `import type { … }`.** The closure resolver skips `import type` lines but treats `import { type X, y }`, and even `import { type X }`, as a value edge (`workerEntrypointClosure.contract.test.ts:88`).
- **Facade disposition rule (all waves):** `sent` → delivered. `indeterminate`, or a rejected promise → **uncertain**: keep the delivery claim, never retry, never report "unreachable". `offline` / `expired` / `owner_mismatch` / `infrastructure_error` → **not delivered**: release the claim. After W1.T2, `infrastructure_error` means nothing was sent: before the enqueue on the producer side, or before the socket write on the relay consumer.
- **No relay from inside a held DB context.** `bullmqQueue.ts:61` only *warns* in production (it throws under `DB_CONTEXT_TRIPWIRE_STRICT`), so a relay inside a transaction would pin a pooled connection for the full ack wait (#1105). The facade refuses to relay there and answers not-delivered (W1.T2). Do not add a "no-wait" mode. Post-commit work goes through `runAfterDbContextCommit` (`db/index.ts:854`) or the existing `deferDelivery` paths.
- **Default prod is `BREEZE_ROLE=all`.** A placement flip changes behaviour only on worker-split deployments (`--profile worker-split`). A send migration changes behaviour on every multi-instance deployment: an agent on another instance gets relayed instead of a `false`.
- **CPU budget (shared 18-core host):** vitest with `--pool=forks --poolOptions.forks.maxForks=4`. Name test files explicitly, never a whole package. One `tsc` at a time with `NODE_OPTIONS=--max-old-space-size=20480`. Check the exit code, never `| tail` (the pipe hides an OOM).

## Evidence (reproduced 2026-11-08 at `ad73e1d888`)

A scratch copy of the contract test's resolver (same regexes, comment stripping, dynamic-follow, `agentCommandRelay` boundary) reproduces both numbers in the issue comment: **42/49 pinned at baseline**, and **21/49 after the ten named services**. It found 34 "frontier importers": non-route files with a live edge into `routes/` or `agentCommandAwait`. Most of them are route-helper importers, and they reach `agentWs` only *through* one chain: `middleware/apiKeyAuth.ts → services/index.ts` (barrel) `→ mfaEnrollmentSession → remoteSessionTeardown → routes/terminalWs.ts → routes/agentWs.ts`. So four services flip nothing, because the blob stays connected until `tenantLifecycle`, `quickSupportEnd` **and** `remoteSessionTeardown` are all cut.

**Minimal cut (verified 0/49):** 11 files. "socket" = drop only the `agentWs`/`agentCommandAwait` edge. "full" = drop every `routes/` edge.

| Wave.Task | File | Cut | Pinned after | Newly clean → flip |
|---|---|---|---|---|
| (baseline) | — | — | 42 | already clean: `hardwareHealthRetention timeSyncRetention m365SyncWorker peripheralJobs deviceGroupJobs partnerGroupEvaluationJobs` (flip in W1.T1); `aiTranscriptSweeper` (KEEP, #9050 disk-local) |
| W1.T2 | `services/dispatchDeviceCommand.ts` | socket | 42 | — |
| W1.T3 | `services/commandQueue.ts` | socket | 27 | `auditBaselineJobs backupVerificationJobs callerVerificationPublisher callerVerificationReconciliation cisJobs desktopSessionFinalization desktopSessionOrphanRecovery drExecutionWorker endpointMessageRetention fleetRemediationDispatchWorker maintenanceRebootWorker oemUpdatesWorker patchJobWorker patchSchedulerWorker sensitiveDataWorker` |
| W1.T4 | `services/softwareDeployment.ts` | socket (dead import) | 24 | `softwareComplianceWorker softwareDeploymentScheduler softwareRemediationWorker` |
| W1.T5 | `services/scriptDispatch.ts` | socket | 23 | `monitorScriptWorker` |
| W1.T6 | `services/scriptCancellation.ts` | socket | 22 | `staleCommandReaper` |
| W1.T7 | `services/topology/diagnosticDelivery.ts` | socket | 21 | `topologyDiagnosticWorker` |
| W2.T2 | `services/tenantLifecycle.ts` | socket | 21 | — |
| W2.T3 | `services/quickSupportEnd.ts` | socket | 21 | — |
| W2.T4 | `services/remoteSessionTeardown.ts` | full (agentWs + terminalWs + tunnelWs) | 5 | `aiAgentRunner aiOperatorTaskWorker alertVerdictScheduler automationWorker eventLogRetention flowRunner flowRunReconciler flowScheduleTick intentReleaseWorker monitorConversionPreviewWorker offboardingDrainReaper orgMerge pamActuationWorker policyEvaluationWorker scriptVerifyWorker securityScanWorker` |
| W3.T1 | `services/deviceDeletion.ts` | full (`routes/devices/core.ts` data import) | 2 | `deviceBulkPurge quickSupportReaper removedDevicePurge` |
| W3.T2 | `services/unassignedPool/parkedExpiry.ts` | socket | 0 | `parkedDeviceExpiry parkedDevicePurge` |

**Waves, ordered by unpins:** W1 flips 27 (+1 KEEP), W2 flips 16, W3 flips 5. At the end, 208 entries are `global` and 1 is `socket-owner` (`aiTranscriptSweeper`). The remaining 23 frontier importers (`aiTools*`, `desktopStream*`, `hardwareHealth/view`, `orgMerge`, `commandResultHandlers`, `remoteWs*`, …) need **no** change, because once the 11 cuts land their route targets no longer reach `agentWs`.

## Cross-process eviction: where it lands and why

Eviction lands in **W2**, after the dispatch wave. W1 needs no eviction and unpins the most. The 16-entry blob needs eviction (`tenantLifecycle`, `quickSupportEnd`) and the teardown boundary together, so they ship as one wave. W3's `parkedExpiry` reuses W2's primitive.

The design is option (A), which the Codex advisor endorsed with conditions, all adopted here. The relay gains a list-shaped `relay-evict` operation, routed by presence lease to the owner's shard. It is fenced by the lease's `connectionToken`, compared synchronously against the owner's live connection record before `close()`. Each entry gets its own typed outcome. A socket-owning process closes local sockets first. Callers evict post-commit. Options rejected: (B) reusing the `agent-credential:revoked` broadcast, because drain keeps credentials valid (`tenantLifecycle.ts:149`) and Quick Support audits the per-agent outcome (`routes/remote/supportSessions.ts:238`). (C) a hybrid, because it means two transports for one concept.

## Review Focus

1. **A relay attempted inside a caller's transaction**, e.g. `dispatchDeviceCommand` from `routes/devices/commands.ts` inside a request context, or `quickSupportEnd` inside `withSystemDbAccessContext`. Expected: no enqueue, no wait, an immediate not-delivered answer, and the claim released for heartbeat. Test in W1.T2 (facade) and W2.T3 (Quick Support split transactions).
2. **Rolling deploy: an old consumer receives `relay-evict`.** Expected: it sends nothing (the job carries no `agentId`/`sealedCommand`), and the producer maps the old scalar ack to `indeterminate` for every entry. Test in W2.T1.
3. **Redis down or slow during dispatch.** BullMQ's connection has `maxRetriesPerRequest: null` (`redis.ts:221`), so `queue.add` can hang. Expected: one absolute transport deadline. An `add` that rejected or timed out → `indeterminate`. A presence-read failure → `offline` (nothing was sent). Never a hung request. Test in W1.T2.
4. **Interactive command to an agent connected to a different instance.** Today `commandQueue.ts:1387` fast-fails "unreachable" because `isAgentConnected` is local. Expected: fast-fail only when `agentReachability` is `'absent'`. A remote lease (`'connected'`) or an unreadable Redis (`'unknown'`) must not fast-fail. Test in W1.T3.
5. **Tenant sever over a large org**, e.g. 5,000 devices across 3 instances. Expected: one batched presence read per 500 agents, at most `RELAY_EVICT_MAX_ENTRIES` (500) per job, no ack wait, and nothing runs until the outer transaction commits. A rollback drops the work. Test in W2.T2.

---

## Oracle and verification recipe (every task)

- **Authority:** `apps/api/src/services/workerEntrypointClosure.contract.test.ts` (Test API job). After W1.T1 it also fails when a clean entry is still `socket-owner` and has no `KEEP_SOCKET_OWNER` reason.
- **Tool:** `cd apps/api && npx tsx scripts/worker-closure-report.ts [--cut-socket <src-rel>]… [--cut <src-rel>]…`. It prints the pinned count, the clean `socket-owner` names, and the frontier importers. Run it before each task to preview the flips, then after, and paste the before/after pinned counts into the PR body.
- **Per task:** `cd apps/api && npx vitest run src/services/workerEntrypointClosure.contract.test.ts <the task's test files> --pool=forks --poolOptions.forks.maxForks=4`. Always name the contract test explicitly: it reads source through `fs`, so `vitest --changed` does not reliably select it from a service-only diff. Before the PR, also run (still in `apps/api`) `npx vitest run src/__tests__/parkedFanout.contract.test.ts`, `npx vitest --changed origin/main --pool=forks --poolOptions.forks.maxForks=4`, and one `NODE_OPTIONS=--max-old-space-size=20480 npx tsc --noEmit`, checking the exit code.

---

## W1 — Command dispatch onto the facade (42 → 21 pinned; 27 flips)

### Execution split and parallelism (W1)
- One branch `feature/4142-dispatch-facade/w1`, one PR (`Refs #4142`). Tasks run **sequentially**: each task's flip list depends on the cuts before it, and every task touches `workerRegistry.ts` placement lines.
- T1 → Sonnet (mechanical extraction plus a spec'd test). T2, T3 → Opus (claim semantics, retry loop, facade contract). T4–T7 → Sonnet, each given its row of the disposition table below.
- T4–T7 are file-disjoint and *could* be written in parallel worktrees once T2 lands. Their flips still need T3, so the gain is small; stay sequential. At most one vitest process at a time (maxForks 4).
- One independent review (Opus, `superpowers:requesting-code-review`) over the whole branch before the PR.

### Task W1.T1: Closure oracle, ratchet, stale flips

**Files:**
- Create: `apps/api/src/services/workerClosure/closureGraph.ts` (resolver moved out of the test)
- Create: `apps/api/scripts/worker-closure-report.ts`; Modify: `apps/api/package.json` (`"worker:closure": "tsx scripts/worker-closure-report.ts"`)
- Modify: `apps/api/src/services/workerEntrypointClosure.contract.test.ts` (import the resolver; add the ratchet)
- Modify: `apps/api/src/services/workerRegistry.ts` (6 flips plus their stale comments: `m365SyncWorker` 1186–1192, `deviceGroupJobs` 1321–1324, `partnerGroupEvaluationJobs` 1333)
- Modify: `apps/api/src/services/workerRegistry.test.ts:184-194` (`m365SyncWorker` is now `global`)

**Interfaces — Produces** (`closureGraph.ts`, no runtime deps beyond `node:fs`/`node:path`):
```ts
export const SRC_ROOT: string; export const AGENT_WS: string; export const AGENT_COMMAND_AWAIT: string; export const ROUTES_DIR: string;
export const ROLE_SAFE_BOUNDARY_MODULES: ReadonlySet<string>;          // today: { services/agentCommandRelay.ts }
export function stripComments(src: string): string;
export function resolveRelativeSpec(fromFile: string, spec: string): string | null;
export function parseFile(file: string): { staticSpecs: string[]; dynamicSpecs: string[] };
export type EdgeFilter = (from: string, to: string) => boolean;         // true = drop the edge
export function importClosure(entryFile: string, opts: { followDynamic: boolean; dropEdge?: EdgeFilter }): Set<string>;
export function socketLocalOffenders(closure: Set<string>): string[];
export interface RegistryEntrySource { name: string; placement: string; spec: string }
export function parseRegistrySource(): RegistryEntrySource[];
export function isSocketLocalClean(entry: RegistryEntrySource, dropEdge?: EdgeFilter): boolean;
```

- [ ] **Step 1: Write the failing ratchet** in the contract test:
  `KEEP_SOCKET_OWNER: ReadonlyArray<{ name: string; reason: string }> = [{ name: 'aiTranscriptSweeper', reason: '#9050 …' }]`, and
  `it('no socket-owner entry is pinned by habit: a clean closure means global or a KEEP_SOCKET_OWNER reason')`: collect `socket-owner` entries with `isSocketLocalClean` true and not in KEEP, then `expect(list).toEqual([])` with the message "flip to 'global' in workerRegistry.ts".
  `it('KEEP_SOCKET_OWNER has no stale entries')`: every KEEP name exists, is `socket-owner`, and is clean.
- [ ] **Step 2: Run, expect FAIL** listing exactly the 6 baseline-clean names above.
- [ ] **Step 3: Extract** the resolver into `closureGraph.ts`, verbatim behaviour. Change only the optional `dropEdge`. Point the test at it. Write the CLI over the same module. `--cut-socket X` drops X's edges to `AGENT_WS`/`AGENT_COMMAND_AWAIT`; `--cut X` drops every X edge into `ROUTES_DIR` or to `AGENT_COMMAND_AWAIT`.
- [ ] **Step 4: Process-local check for each flip**, recorded in the PR body: grep the entry's job module for local disk paths (`fs.`, `/data`, `os.tmpdir`, `CLAUDE_CONFIG_DIR`), module-scope state that request handlers populate, and per-host queue names. Any hit goes into KEEP with its reason instead of being flipped. The worker container mounts the same `api_data` volume and m365 signing secrets (`deploy/docker-compose.prod.yml:935-943`).
- [ ] **Step 5: Flip the 6; fix the registry comments and `workerRegistry.test.ts`.** Run the contract test and `workerRegistry.test.ts`, expect PASS. The CLI with no cuts prints `pinned 42/49`.
- [ ] **Step 6: Commit** `test(worker-split): closure oracle + clean-pin ratchet; flip 6 stale socket-owner entries (#4142)`.

### Task W1.T2: Harden the facade outcome contract; migrate `dispatchDeviceCommand`

**Files:**
- Modify: `apps/api/src/services/agentCommandRelay.ts`, `apps/api/src/jobs/agentCommandRelayWorker.ts`, `apps/api/src/services/dispatchDeviceCommand.ts:4,70,315-348`
- Test: `services/agentCommandRelay.test.ts`, `jobs/agentCommandRelayWorker.test.ts`, `services/dispatchDeviceCommand.test.ts` (switch its mock from `../routes/agentWs` to `./agentCommandRelay`)

**Interfaces — Produces:**
```ts
export type DispatchDisposition = 'delivered' | 'uncertain' | 'not_delivered';
export function dispatchDisposition(outcome: DispatchOutcome): DispatchDisposition;
export const RELAY_TRANSPORT_DEADLINE_MS = 7_000;   // presence → shard → enqueue → ack, one absolute budget (> the job's 5 s expiresAt)
// local socket or live lease → 'connected'; lease read OK and absent → 'absent'; Redis could not answer → 'unknown'
// (built on socketLocal() + probeAgentPresence, agentPresence.ts:116 — readAgentPresence collapses failure into absence)
export async function agentReachability(agentId: string): Promise<'connected' | 'absent' | 'unknown'>;
// dispatchCommandToAgent: signature unchanged; contract now "never rejects"
// dispatchDeviceCommand result: delivery: 'delivered' | 'indeterminate' | 'queued_offline' | 'queued_live' | 'cancelled'
```

- [ ] **Step 1: Failing tests (facade)**:
  `it('refuses to relay inside a held DB context: infrastructure_error, no enqueue, no ack wait')`, with `hasDbAccessContext` → true, a remote lease, and `expect(queue.add).not.toHaveBeenCalled()`.
  `it('an enqueue that rejects after being issued is indeterminate, not infrastructure_error')`.
  `it('an enqueue that never settles returns indeterminate within RELAY_TRANSPORT_DEADLINE_MS')`, using fake timers.
  `it('never rejects: an unexpected throw before enqueue is infrastructure_error, after enqueue is indeterminate')`.
  `it.each` over `dispatchDisposition`: `sent→delivered`, `indeterminate→uncertain`, the other four → `not_delivered`.
  `it.each` over `agentReachability`: local socket → `connected`; lease → `connected`; no lease → `absent`; probe `unavailable` → `unknown`; worker role never imports `agentWs`.
- [ ] **Step 2: Failing tests (consumer)**:
  `it('re-checks expiry immediately before sendCommandToAgent')`, where the job expires during the claim await, then `expect(send).not.toHaveBeenCalled()` and the ack is `expired`.
  `it('clears its send claim when the local send returns false, so a retry can claim')`.
- [ ] **Step 3: Failing tests (`dispatchDeviceCommand`)**:
  `sent → delivery 'delivered', claim kept`.
  `indeterminate → delivery 'indeterminate', command.status 'sent', releaseClaimedCommandDelivery not called`.
  `offline → release called, delivery 'queued_live'`.
  `a rejected dispatch → claim kept, no throw to the caller`. This last one is the issue's softwareDeploymentScheduler concern: a throw must never strand its CAS claim.
- [ ] **Step 4: Run all three, expect FAIL.**
- [ ] **Step 5: Implement.** In the facade: check `hasDbAccessContext()` on the relay path, before the presence read. Call `queue.add` and separate a synchronous throw (pre-enqueue) from an async rejection (uncertain). Race the add and the ack against the remaining absolute budget. Wrap the body so it never rejects. In the consumer: expiry check right before the send; `DEL` the claim key on a false send. In `dispatchDeviceCommand`: `await dispatchCommandToAgent(claimed.agentId, frame)` and branch on `dispatchDisposition`. Add `'indeterminate'` to the delivery union. `tsc` must show the union's consumers (`patchJobExecutor.ts:1455`, `routes/devices/commands.ts:275,299`, `forceReboot.ts:205`, `softwareDeployment.ts:213-239`, `oemUpdates/dispatch.ts:432,445`) still compile, with `'indeterminate'` taking each one's queued (non-delivered, non-offline) branch.
- [ ] **Step 6: Run, expect PASS**, plus the existing facade-caller suites: `jobs/pamActuationWorker*.test.ts`, `jobs/monitorWorker*.test.ts`, `jobs/snmpWorker*.test.ts`, `jobs/backupWorker*.test.ts`, `jobs/discoveryWorker*.test.ts`. PAM now keeps its claim on an enqueue rejection, which is correct under the uncertainty rule; update its test if one pins the old mapping.
- [ ] **Step 7: Commit** `fix(relay): typed, never-rejecting dispatch outcomes; dispatchDeviceCommand on the facade (#4142)`.

### Disposition table for T3–T7 (per call site)

| Site | Today | After | delivered | uncertain | not delivered |
|---|---|---|---|---|---|
| `commandQueue.ts:313` `rearmIdempotentCommandForDelivery` | `isAgentConnected` | `agentReachability`; return `agent_disconnected` only on `'absent'` (`'unknown'` proceeds to claim + dispatch, which answers) | — | — | — |
| `commandQueue.ts:330` same fn | `sendCommandToAgent` | `dispatchCommandToAgent` | `{delivered:true}` | `{delivered:false, reason:'delivery_indeterminate'}`, claim kept | release, `'delivery_failed'` |
| `commandQueue.ts:1387` `precheckCommandExecution` | `!isAgentConnected` fast-fail | fast-fail only when `agentReachability` is `'absent'` | — | — | — |
| `commandQueue.ts:1610-1660` `dispatchPreparedCommand` | 3× sync retry | retry ≤ `SEND_RETRY_ATTEMPTS` **only while** `status==='offline'`, same command id | break | break, claim kept, fall through to poll, **no** unreachable fast-fail | release; interactive → `DEVICE_UNREACHABLE_ERROR` |
| `softwareDeployment.ts:43` | dead value import | `import type { AgentCommand }` | — | — | — |
| `scriptDispatch.ts:902` `dispatchScriptToDevice` | sync send in try/catch | `await dispatchCommandToAgent` | as today (`deliveryOutcome 'sent'`) | `deliveryOutcome 'indeterminate'`, do **not** stamp the execution running, claim kept | release, as today's `false` |
| `scriptCancellation.ts:545` `deliverCancelCommand` | sync send | `await dispatchCommandToAgent` | `true` | `true` (row is `sent`; the reaper resolves it), claim kept | release, `false` |
| `diagnosticDelivery.ts:21,35` | `isAgentConnected` + send | skip only on `agentReachability === 'absent'`, then `dispatchCommandToAgent` | `true` | `true`, claim kept | release, `false` |

A rejected `dispatchCommandToAgent` promise (now contract-violating) is treated as **uncertain** at every site. `scriptDispatch` currently releases on throw (#3445). Change that to keep-and-rethrow.

### Task W1.T3: `commandQueue` (flips 15)

**Files:** Modify `apps/api/src/services/commandQueue.ts:11,313,330,1387,1610-1660`, `services/workerRegistry.ts` (15 flips). Test: `services/commandQueue.test.ts`, `commandQueue.dbcontext.test.ts`, `commandQueue.refusal.test.ts`, `commandQueueTransitions.test.ts` (mock `./agentCommandRelay`, not `../routes/agentWs`).

**Interfaces — Consumes:** `dispatchCommandToAgent`, `agentReachability`, `dispatchDisposition` (W1.T2).

- [ ] **Step 1: Failing tests:**
  `it('interactive command does not fast-fail when the agent is connected to another instance')` (local false, presence lease present).
  `it('interactive command does not fast-fail when presence cannot be read')` (reachability `unknown`).
  `it('retries only on offline and stops on indeterminate without releasing')`, asserting `dispatchCommandToAgent` was called exactly twice for `[offline, indeterminate]` and release was never called.
  `it('indeterminate on an interactive command polls instead of returning DEVICE_UNREACHABLE_ERROR')`.
  `it('infrastructure_error releases once and does not retry')`.
  `it('rearm: indeterminate keeps the claim and reports delivery_indeterminate')`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement** per the table. **Step 4: Run the tool:** `--cut-socket services/dispatchDeviceCommand.ts --cut-socket services/commandQueue.ts` must report pinned 27.
- [ ] **Step 5:** Process-local check (W1.T1 Step 4) on the 15. Flip them. Run the contract test, the commandQueue suites, `workerRegistry.test.ts`, and `jobs/workerReadinessManifest.test.ts`: expect PASS.
- [ ] **Step 6: Commit** `fix(commandQueue): dispatch through the relay facade; flip 15 entries global (#4142)`.

### Tasks W1.T4–W1.T7 (Sonnet, one commit each)

Same TDD shape per task: (1) failing tests for that site's three disposition columns, with the service test's agentWs mock switched to the facade; (2) FAIL; (3) implement the table row; (4) the tool shows the expected pinned count; (5) process-local check, flips, contract test PASS; (6) commit.

| Task | Files | Tests | Pinned after | Flips |
|---|---|---|---|---|
| W1.T4 | `services/softwareDeployment.ts:43` | `softwareDeployment*.test.ts` (unchanged behaviour); the tool | 24 | 3 |
| W1.T5 | `services/scriptDispatch.ts:32,895-925` | `scriptDispatch.test.ts`, `scriptDispatch.acknowledgement.test.ts`, `.restorePoint`, `.runContext`, `.maintenanceWindow`, `.aiOrigin`, `.aiAuditProvenance` | 23 | `monitorScriptWorker` |
| W1.T6 | `services/scriptCancellation.ts:12,545-556` | `scriptCancellation.request.test.ts`, `scriptCancellation*.test.ts` | 22 | `staleCommandReaper` |
| W1.T7 | `services/topology/diagnosticDelivery.ts` (and fix its header comment, which says the worker is socket-owner) | `topology/diagnosticDelivery.test.ts` | 21 | `topologyDiagnosticWorker` |

### Task W1.T8: Wave close
- [ ] Add a short "which workers run where" note to `docs/deploy/worker-split.md` (27 entries moved to the worker container; link this plan). Put the CLI before/after output in the PR body. Run the full verification recipe, then the independent review, then open the PR.

---

## W2 — Cross-process teardown (21 → 5 pinned; 16 flips) — RIGOR: HIGH

### Execution split and parallelism (W2)
- Branch `feature/4142-dispatch-facade/w2` off `main` **after W1 merges** (no stacked PR: a base ≠ main runs no CI).
- T1 (Opus) first: it defines the eviction API. T2 and T3 (Opus: tenant containment and Quick Support are high blast radius) can run **in parallel** after T1. They are file-disjoint (`tenantLifecycle.ts` vs `quickSupportEnd.ts`), each with its own tests. T4 (Opus) touches only `remoteSessionTeardown.ts`, the new boundary module, and the contract test, so its code can run in parallel with T2/T3. Its flips need T2 and T3, so it **merges into the branch last**.
- Full rigor: TDD, one independent review over the branch, and an owner-run worker-split lab check in the PR (`--profile worker-split`, `BREEZE_API_ROLE=api`). Steps: end a Quick Support session whose agent socket is on the api container; suspend a test org and confirm its agent socket closes within seconds; tear down a terminal session from a worker-side path.

### Task W2.T1: `relay-evict` — fenced, list-shaped eviction

**Files:**
- Modify: `apps/api/src/routes/agentWs.ts`. Add `connectionToken: string` to `ActiveAgentConnection` (set where the lease is written, ~3205). Add `disconnectAgentConnection`.
- Modify: `apps/api/src/services/agentPresence.ts` (batch strict read)
- Modify: `apps/api/src/services/agentCommandRelay.ts` (producer; `socketLocal()` gains `disconnectAgent` and `disconnectAgentConnection`)
- Modify: `apps/api/src/jobs/agentCommandRelayWorker.ts` (dispatch on `job.name`), `apps/api/src/services/agentCommandRelayShard.ts:133-176` (`drainRelayQueue` writes evict-shaped acks for evict jobs)
- Test: `services/agentCommandRelay.evict.test.ts` (new), `jobs/agentCommandRelayWorker.test.ts`, `services/agentCommandRelayShard.test.ts`, `routes/agentWs.disconnectConnection.test.ts` (new)

**Interfaces — Produces:**
```ts
// routes/agentWs.ts — synchronous compare-token-and-close, no await between compare and close()
export function disconnectAgentConnection(agentId: string, connectionToken: string, code: AgentEvictCloseCode, reason: string):
  AgentWsDisconnectResult | 'token_mismatch';
// services/agentPresence.ts — throws on Redis failure (never collapses failure into absence)
export async function readAgentPresenceBatch(agentIds: readonly string[]): Promise<Map<string, AgentPresenceLease | null>>;
// services/agentCommandRelay.ts
export type AgentEvictCloseCode = 4001 | 4040 | 4041;
export const RELAY_EVICT_MAX_ENTRIES = 500;
export interface EvictRequest { agentId: string; code: AgentEvictCloseCode; reason: string } // reason ≤ 120 chars
export type EvictOutcome =
  | { status: 'closed'; via: 'local' | 'relay' }        // close() succeeded on that exact connection (not "agent globally offline")
  | { status: 'close_failed'; via: 'local' | 'relay' }
  | { status: 'not_connected' }                          // lease read OK and absent, or the owner holds no socket
  | { status: 'owner_mismatch' }                         // lease/instance moved, or token_mismatch on the owner
  | { status: 'expired' }
  | { status: 'queued' }                                 // awaitAck:false and enqueue accepted
  | { status: 'indeterminate' }                          // enqueue or ack uncertain, or an old-consumer ack
  | { status: 'unavailable'; reason: string };           // Redis read failed, shard dead, held DB context
export async function evictAgentSockets(requests: readonly EvictRequest[], opts?: { awaitAck?: boolean }):
  Promise<Map<string, EvictOutcome>>;                   // never rejects; awaitAck defaults to true
```
Job: name `relay-evict`, data `{ relayId, targetInstanceId, expiresAt, entries: Array<{ agentId, connectionToken, code, reason }> }`. It deliberately has no top-level `agentId`/`commandId`/`sealedCommand`. Ack: `{ kind: 'evict', outcomes: Record<agentId, EvictOutcome> }`. Nothing is sealed, because no secrets travel. The consumer rejects any code outside the allowlist and any reason over 120 characters.

- [ ] **Step 1: Failing tests (agentWs):**
  `disconnectAgentConnection closes only when the token matches`.
  `returns token_mismatch and leaves a replacement socket open`.
  `returns not-connected when no socket is held`.
- [ ] **Step 2: Failing tests (producer):**
  `local-first: a locally connected agent is closed without touching Redis`.
  `remote agents are grouped by lease instance into ≤ RELAY_EVICT_MAX_ENTRIES-entry jobs, deduplicated`.
  `a presence batch read failure yields unavailable (not not_connected) for remote entries and still closes local ones`.
  `a dead shard yields unavailable`.
  `inside a held DB context: no enqueue, unavailable 'held_db_context'`.
  `awaitAck:false returns queued`.
  `an old-consumer scalar ack ({status:'offline'}) maps every entry to indeterminate` (Review Focus 2).
  `never rejects`.
- [ ] **Step 3: Failing tests (consumer and drain):**
  `relay-evict: per-entry expiry check immediately before each close`.
  `instance or token mismatch → owner_mismatch, no close`.
  `disallowed close code or over-long reason → { status: 'unavailable', reason: 'invalid_request' } for that entry, no close`.
  `unknown job name → ack infrastructure_error, nothing sent`.
  `drainRelayQueue acks a waiting relay-evict job with an owner_mismatch outcome per entry`.
- [ ] **Step 4: Run, expect FAIL.** **Step 5: Implement.** Keep the boundary test green: `socketLocal()` remains the only dynamic `agentWs` edge and every consumer stays role-guarded (`workerEntrypointClosure.contract.test.ts:569-596`). **Step 6: Run, expect PASS**, plus `agentCommandRelayWorker.lifecycle.test.ts` and `agentCommandAwait.test.ts`.
- [ ] **Step 7: Commit** `feat(relay): fenced cross-process agent socket eviction (relay-evict) (#4142)`.

### Task W2.T2: `tenantLifecycle` — fleet-wide sever, post-commit

**Files:** Modify `apps/api/src/services/tenantLifecycle.ts:60-97`. Test `services/tenantLifecycle.test.ts` (mock `./agentCommandRelay`). Callers keep their signature: `tenantLifecycle.ts:140,183,279`, `tenantOffboarding.ts:1640,1673`, `orgMerge.ts:634`.

**Interfaces — Consumes:** `evictAgentSockets`, `runAfterDbContextCommit`. **Produces:** `disconnectLiveAgentSocketsForOrgIds(orgIds: string[], reason: string): Promise<void>` (unchanged signature).

- [ ] **Step 1: Failing tests:**
  `enumerates every device agentId in the orgs (no local-connected filter) and evicts with code 4001 and awaitAck:false`.
  `inside a held context nothing is evicted until the outer transaction commits; a rollback evicts nothing`.
  `5,000 agents → evictAgentSockets receives all of them (batching is the facade's job)`.
  `an eviction failure is captured, never thrown`.
- [ ] **Step 2: FAIL.** **Step 3: Implement.** Keep the device read with the existing savepoint pattern (`#11203`). Register `runAfterDbContextCommit('tenant socket sever', () => evictAgentSockets(...))`. Drop the dynamic `routes/agentWs` import. **Step 4: PASS**, plus `tenantOffboarding*.test.ts` and `orgMerge*.test.ts` that touch the sever.
- [ ] **Step 5: Commit** `fix(tenant): sever live agent sockets on every instance, after commit (#4142)`.

### Task W2.T3: `quickSupportEnd` — send, revoke-commit, evict

**Files:** Modify `apps/api/src/services/quickSupportEnd.ts`. Modify `routes/remote/supportSessions.ts:238` only if the widened union needs a type touch. Test `services/quickSupportEnd.test.ts`, `jobs/quickSupportReaper*.test.ts`.

**Interfaces — Produces:** `EndSupportSessionResult.disconnect: 'closed' | 'close-failed' | 'not-connected' | 'unconfirmed' | null`. Mapping: `closed→'closed'`, `close_failed→'close-failed'`, `not_connected→'not-connected'`, everything else → `'unconfirmed'`. `commandDelivered: boolean` = disposition `delivered` (doc comment unchanged in meaning).

- [ ] **Step 1: Failing tests:**
  `order: support_end dispatched before the revoking transaction opens; eviction runs after it commits`.
  `the revoking write is a CAS on non-terminal status; losing the race returns ended:false and evicts nothing`.
  `relay eviction outcome indeterminate → disconnect 'unconfirmed' (audited, not collapsed into success)`.
  `local agent → disconnect 'closed' via the local path`.
- [ ] **Step 2: FAIL.** **Step 3: Implement** as three phases. Transaction A reads the session and device. Outside any context, `dispatchCommandToAgent(support_end)`. Transaction B revokes, decommissions, and updates the session with `WHERE status NOT IN ('ended','expired')` and `RETURNING`. After commit, `evictAgentSockets([{agentId, code: 4041, reason: 'quick support session ended'}])` with an awaited ack. This also closes today's reconnect-before-commit window. **Step 4: PASS.**
- [ ] **Step 5: Commit** `fix(quick-support): end sessions across instances with a fenced eviction (#4142)`.

### Task W2.T4: `remoteSessionTeardown` boundary (flips 16)

**Files:**
- Create: `apps/api/src/services/remoteSessionSocketLocal.ts`
- Modify: `apps/api/src/services/remoteSessionTeardown.ts:5,36-90` (drop `sendCommandToAgent`; tunnel loop → `Promise.allSettled` with a concurrency bound of 8; `tunnel_close` via `dispatchCommandToAgent`)
- Modify: `apps/api/src/services/workerClosure/closureGraph.ts` (add the module to `ROLE_SAFE_BOUNDARY_MODULES`). Modify the contract test: generalize `'socketLocal() is the only dynamic agentWs edge…'` into a table over boundary modules. Each row lists its file, its allowed `{loaderFn, spec}` dynamic edges, and the guard regex `breezeRole\(\) !== 'worker'`. Each row asserts: a static closure with no `routes/`, exactly the allowed dynamic edges, each inside its loader, none hoisted, and every consumer guarded.
- Modify: `services/workerRegistry.ts` (16 flips). Update the hardcoded placement tests: `index.pam-actuation-worker.test.ts:10,16-20`, `services/workerRegistry.scriptVerifyWorker.test.ts:7-16`, and `jobs/workerReadinessManifest.test.ts:221` (use `aiTranscriptSweeper` as the socket-owner exemplar).
- Test: `services/remoteSessionSocketLocal.test.ts` (new), `services/remoteSessionTeardown.test.ts`

**Interfaces — Produces:**
```ts
export async function closeLocalTerminalSession(sessionId: string): Promise<boolean>; // false on BREEZE_ROLE=worker, without importing routes/terminalWs
export async function closeLocalTunnelSession(tunnelId: string): Promise<boolean>;   // false on worker, without importing routes/tunnelWs
```
`remoteSessionTeardown.ts` itself stays **outside** the exemption, because the walker stops traversing every import of an exempt module.

- [ ] **Step 1: Failing tests:**
  `on worker role both functions return false and never import their route module` (spy on the loader, or `vi.mock` the route module with a throwing factory).
  `on api role they delegate to closeTerminalSession / closeTunnelSession`.
  `tunnel teardown: N tunnels dispatch tunnel_close concurrently (bounded), one failure does not stop the others`.
  Contract: `the boundary table row for remoteSessionSocketLocal holds`.
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: Run the tool** with the W1 + W2 cuts: pinned 5.
- [ ] **Step 5:** Process-local check on the 16. `aiAgentRunner`'s SDK `query()` runs with `persistSession: false` (`services/aiAgents/runLoop.ts:2943`), so no transcripts are written; confirm the same for `aiOperatorTaskWorker`, `alertVerdictScheduler` and `flowRunner` before flipping. Flip; run the contract, readiness-manifest, pam, scriptVerify and teardown suites: PASS.
- [ ] **Step 6: Commit** `refactor(remote): role-safe local session close; flip 16 entries global (#4142)`.

### Task W2.T5: Wave close
- [ ] `docs/deploy/worker-split.md`: eviction now crosses instances, plus the lab-check recipe from the W2 execution split. Run the full verification recipe and the independent review; the PR body carries the lab-check results. The owner holds the merge until the lab check has run.

---

## W3 — Device lifecycle and end state (5 → 0 pinned; 5 flips)

### Execution split and parallelism (W3)
- Branch `feature/4142-dispatch-facade/w3` off `main` after W2 merges. T1 (Sonnet, mechanical, grep-driven) and T2 (Sonnet, using W2's API) are file-disjoint and can be written in parallel. T2's flips need T1, so T1 lands first in the branch. T3 (Sonnet) is docs. One review round (normal rigor; T2 reuses a reviewed primitive).

### Task W3.T1: Move the device cascade tables out of `routes/devices/core.ts` (flips 3)

**Files:**
- Create: `apps/api/src/services/deviceCascadeTables.ts`. It holds `CORE_DEVICE_CASCADE_DELETE_TABLES`, `DEVICE_DETACH_DEVICE_ID_TABLES`, `DEVICE_LINKED_DEVICE_ID_TABLES`, `DEVICE_LINK_DEPENDENT_COLUMNS`, `DEVICE_CASCADE_DELETE_PREDICATES`, `getDeviceCascadeDeleteTables`, `type DeviceCurrentOwnership`, and only the private helpers they need. Its imports must be `db/schema` and `drizzle-orm` only.
- Modify: `routes/devices/core.ts` (imports from the new module, **no re-export**), `services/deviceDeletion.ts:16-24`, and every importer found by `grep -rln "DEVICE_LINKED_DEVICE_ID_TABLES\|DEVICE_DETACH_DEVICE_ID_TABLES\|getDeviceCascadeDeleteTables\|CORE_DEVICE_CASCADE_DELETE_TABLES" apps/api/src`. Today that is `routes/devices/cascadeDelete.test.ts`, `moveOrg.coverage.test.ts`, `services/deviceDeletion*.test.ts`, `networkIsolation/lifecycleRefusals.test.ts`, two integration tests, and the schema comments in `db/schema/aiOperatorTasks.ts` and `abuseSignals.ts`.
- Modify: `docs/agents/tenancy-rls.md:49`, which names the new registration home.

- [ ] **Step 1: Failing test:** add `it('the device cascade tables module reaches no routes/ file')` to the contract test (static closure from `services/deviceCascadeTables.ts`). Before the module exists it fails because the file cannot be resolved.
- [ ] **Step 2: Move; update importers; run** `routes/devices/cascadeDelete.test.ts` (it guards the registration list), `moveOrg.coverage.test.ts`, `services/deviceDeletion*.test.ts`, and the contract test: PASS. The tool shows pinned 2. Process-local check, then flip `deviceBulkPurge`, `quickSupportReaper` and `removedDevicePurge`.
- [ ] **Step 3: Commit** `refactor(devices): device cascade tables live in services; flip 3 entries global (#4142)`.

### Task W3.T2: `parkedExpiry` eviction (flips 2)

**Files:** Modify `apps/api/src/services/unassignedPool/parkedExpiry.ts:34,223-227`. Test: create `services/unassignedPool/parkedExpiry.evict.test.ts` (no direct unit suite exists today); switch `jobs/parkedDeviceExpiry.test.ts` and `jobs/parkedDevicePurge.test.ts` from the agentWs mock to the facade.

- [ ] **Step 1: Failing tests:** `the decommission eviction is registered post-commit with code 4041 and awaitAck:false`; `an eviction failure is reported via report('agent disconnect', …), never thrown`.
- [ ] **Step 2: FAIL → implement** (`runAfterDbContextCommit` + `evictAgentSockets`; the result is discarded as today, since nothing audits it) **→ PASS.** The tool shows pinned 0. Process-local check, then flip `parkedDeviceExpiry` and `parkedDevicePurge`.
- [ ] **Step 3: Commit** `fix(unassigned-pool): evict decommissioned parked devices across instances; flip 2 entries global (#4142)`.

### Task W3.T3: End-state docs
- [ ] Rewrite the "Socket-owner workers" paragraph of `docs/deploy/worker-split.md` (only `aiTranscriptSweeper` plus the relay consumer stay on `api`) and the `workerRegistry.ts` header comment (placement is now "global unless the closure pins it or `KEEP_SOCKET_OWNER` names a reason"). The PR body lists the follow-ups below. Commit `docs(worker-split): end state after the facade pass (#4142)`.

---

## Open Decisions

- **OD-1 — Eviction transport (advisor: AGREE, conditional).** Relay-based, list-shaped, connection-fenced `relay-evict`, landing in W2. Codex's conditions are all adopted: synchronous compare-token-and-close on the owner, bounded and deduplicated batches, distinct `queued`/`unavailable` outcomes, post-commit eviction, queue-protocol discrimination including the shard drain, and old-consumer ack tolerance.
- **OD-2 — Independent drain backstop (advisor DISAGREES on scope).** Codex wants the live socket re-check (`isAgentDeviceStillAuthorized`, `agentWs.ts:1101`) to reject non-active tenants as a *condition* of W2. Today drain-mode WS sever has no backstop beyond the local disconnect itself (`tenantOffboarding.ts:1634`). My position: the gap exists today, and it is wider today (other instances' sockets are never closed). W2 narrows it to "relay consumer down". A fleet-wide admission change carries #8838-class mass-close risk and deserves its own reviewed PR. **Recommend:** file a follow-up issue at W2 kickoff and land it before or alongside W2, not inside it. The owner decides whether W2 waits for it.
- **OD-3 — KEEP list.** `aiTranscriptSweeper` stays `socket-owner` (#9050, disk-local transcripts). Any further KEEP found by a per-entry process-local check is added with its reason and called out in that wave's PR.
- **OD-4 — The facade refuses to relay inside a held DB context.** This changes behaviour for the existing facade callers (monitor/snmp/backup/discovery/PAM/remote sessions): such a call already warned (prod) or threw (strict). It now answers not-delivered. The advisor's Q3 answer agrees: no no-wait mode, use post-commit mechanisms.
- **OD-5 — Device cascade lists move to `services/deviceCascadeTables.ts`, without a re-export.** This changes the documented registration home. The alternative, re-exporting from `routes/devices/core.ts`, leaves two names for one list. Recommend the move plus doc updates.
- **OD-6 — Merge timing.** W1 can merge on green. W2 needs the owner-run worker-split lab check (above). W3 merges on green.

## CI traps for executors

- **The ratchet fires in the commit that unpins an entry.** Flip in that same commit. A placement flip also has hardcoded test pins (`workerRegistry.test.ts:184`, `index.pam-actuation-worker.test.ts:10`, `workerRegistry.scriptVerifyWorker.test.ts:12`, `workerReadinessManifest.test.ts:221`). The readiness manifest itself derives from placements and needs no row edits.
- **Tests that mock `../routes/agentWs` for a migrated service must mock `./agentCommandRelay` instead.** A partial agentWs mock without `isAgentConnected` silently sends the facade down the Redis presence path.
- `import { type AgentCommand }` is a value edge to the resolver. Use `import type`.
- A new file under `apps/api/src/services/` can trip `src/__tests__/parkedFanout.contract.test.ts` (it lives in `__tests__/`, so unit-only runs miss it). Its Lint-job sibling is the per-area gating contract. Run both after T1 (`workerClosure/closureGraph.ts`), W2.T4 (`remoteSessionSocketLocal.ts`) and W3.T1 (`deviceCascadeTables.ts`).
- `vitest --changed` does not reliably select the closure contract test. Always name it.
- Local api `tsc` OOMs at the default heap. Use `NODE_OPTIONS=--max-old-space-size=20480` and read the exit code.
- Do not edit `docs/release-notes/next-release-draft.md` (merge-queue hot spot). Release notes go in the PR body.
- No stacked PRs: each wave branches from `main` after its predecessor merges.

## Out of scope (follow-ups to file)

- Local-only disconnects still in route files (`routes/devices/core.ts:2449,2580` decommission and credential paths) can adopt `evictAgentSockets` later. They run on the api role and do not affect placement.
- `closeTerminalSession`/`closeTunnelSession` return true after a local browser close even when the agent stop went nowhere (`terminalWs.ts:368`, `tunnelWs.ts:361`, Codex Q2). This is existing debt; the new boundary passes the result through unchanged.
- A cross-process browser-socket close broadcast for faster revocation of terminal/tunnel viewers on other instances. Today the owner observes viewer revocation on its revalidation loop.
- OD-2's tenant-status backstop, if not landed alongside W2.

# Learned Networks W06b: SNMP polling, monitors and the asset probe follow the gate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a gated site, SNMP polls, network monitor checks and the asset "Check now" probe run only from an eligible agent as guarded commands, and every case where that cannot happen or cannot be verified reads "not checked", never down.

**Architecture:** One decision function (`evaluateProbeGate`) wraps the W03a gate (E5) and eligibility (E6) for a site-scoped probe. The three producers ask it before choosing an agent and wrap their base command into the `_guarded` type (C5) when it says so. The dispatch record that authorizes an orphaned result (the Redis expectation) carries the allowed gateway ids from the server-written payload, and one verdict function (`verifyProbeResult`, built on E10) decides on every result path whether a result counts. Anything that does not count is written as "not checked" through paths that touch no failure counter and run no alert rule.

**Tech stack:** Hono/TypeScript API, BullMQ workers, Redis (orphaned-result expectations), PostgreSQL + Drizzle, Astro + React web, Vitest.

**Spec:** `docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md` (§8.2 eligibility, §8.4 verification, §12, §13 items 13 and 14).

**Index:** `docs/superpowers/plans/monitoring/2026-11-21-learned-networks.md`. Its Global constraints, Review focus and Cross-wave contract apply to every task here. Names used verbatim: B2, C3, C5, E1, E5, E6, E7, E10, H.

Depends on W03c (merged) and on an agent release that contains W06a. This PR must not merge before that release exists (Task 14). Line numbers are from `9ce08b3071`; W03a edits `commandResultHandlers.ts`, `routes/agents/commands.ts` and `partnerTrust.ts` near the cited lines, so open each file before relying on one.

## Wave constraints

- **Not checked is never down.** On a gated site, "no eligible agent", an agent refusal (`network_mismatch`, `network_changed`) and an unverified result all mean not checked. None writes `offline`, `failed`, `warning` or "no answer", none adds a failure count, none inserts a `network_monitor_results` row, none runs an alert rule, and the `network_check` handler reports `dataAvailable: false` for it, so no alert is raised or resolved.
- **The not-checked codes** are the five `ProbeNotCheckedCode` values (Task 1). They are stored as-is: `snmp_devices.last_status` (varchar 20; the longest code is 19 characters), `network_monitors.last_error` with `last_status = 'unknown'`. No migration.
- **A site that is not gated behaves exactly as before** through all three producers: same agent selection, same base command type, byte-identical payload, same failure accounting. Existing unit suites that mock the database gain one module mock of `services/learnedNetworks/probeGate` returning `unrestricted` (dispatch) or `accept` (results); none of their assertions change. The unchanged-behavior proof is these existing tests, kept green: `services/networkExecutorSelection.test.ts` (all), `services/monitorCommands.test.ts` (all), `jobs/monitorWorker.test.ts` › "picks an online agent in the monitor site when one exists", › "does NOT fall back to an arbitrary org agent…", › "allows an org-wide agent for an unbound (assetless) monitor — behavior preserved"; `routes/discoveryAssetProbe.test.ts` (all); `routes/agentWs.test.ts` › "enqueues an accepted monitor result via runOutsideDbContext (#1105, BREEZE-H)", › "rejects mismatched SNMP device IDs in command results"; `services/commandResultHandlers.snmp.test.ts` (all); `jobs/snmpWorker.oidSpecs.test.ts`, `jobs/snmpWorker.orgAuthority.test.ts`, `jobs/snmpWorkerScheduler.test.ts`; integration `snmpWorkerSiteAuthority.integration.test.ts` › "follows a moved asset to its current site and fails closed when that site has no agent". Task 13 adds the real-Postgres proof with an old agent.
- **Outside the gate, unchanged:** `snmp_devices` rows with no asset have no site (index plan call 12); monitors with neither `site_id` nor `asset_id` (org-wide unbound checks and every partner-wide check, which can hold no site by `network_monitors_site_owner_chk`) are not site work either. Both go through the `siteId: null` branch untouched.
- **A real failure stays a failure.** A guarded result whose `verifiedNetwork` is accepted is handled exactly like a base result, failures included: an SNMP poll that timed out after the proof is recorded through `recordSnmpPollFailure` and keeps its dispatch count; an unanswered guarded ping records `failed`; an `offline` monitor result is recorded as offline. Only a refusal, a result with no accepted `verifiedNetwork`, and "no eligible agent" are not checked.
- **A guarded command that is never answered** reads as it does on a site that is not gated: a pending probe older than 2 minutes reads as failed (`assetReachability.ts:167`), and an SNMP poll keeps its dispatch count. The gate decides where a probe runs and which results count; a silent agent is not a network question. A guarded probe whose dispatch did not send is reset, not stamped failed (Task 11).
- **No site lock in the probe producers.** `evaluateProbeGate` takes no E1 lock and no producer takes one. The guarantee comes from result-time verification against current state (Task 3). Reason under Contract notes.
- **No new send site and no new `devices` reader.** Every send stays in `jobs/snmpWorker.ts`, `jobs/monitorWorker.ts`, `routes/monitors.ts` and `services/assetProbeRun.ts`, so `parkedCommandDelivery.contract.test.ts` needs no entry. `probeGate.ts` reads `sites`, `network_monitors`, `snmp_devices` and `discovered_assets` only (eligibility reads `devices` inside E6, already classified by W03a), so `parkedFanoutModules.ts` needs no entry. Both contract tests run in Done when.
- **Catch around a query:** every new verification and not-checked write that sits inside an existing `try/catch` in `routes/agentWs.ts` or `services/commandResultHandlers.ts` runs inside `withDbTransaction(() => …)` with the catch outside.
- **AI tool text stays unchanged.** `probe_network_asset`'s definition and description are not edited (tool-index budget); only its return shape is tested.

## Review focus (this wave)

1. **A refusal carries no target in its body** (C3: `{"observedGateways":[…]}`; no `monitorId`, `deviceId` or `status`). Each result branch must find it through its expectation and decide before any status mapping. Pinned in Task 7 › "payload-less guarded refusal is not checked", Task 9 › "guarded refusal never reaches recordSnmpPollFailure", Task 11 › "guarded refusal resets the pending probe".
2. **SNMP counts a poll as failed at dispatch** (`markPollDispatched`, `jobs/snmpWorker.ts:297-311`, `offline` at three). A guarded poll that ends not checked must give that count back. Task 9 › "two prior failures plus a refusal leaves two and not offline".
3. **A new `snmp_devices.last_status` value reaches five readers.** `deriveCollection`, `deriveReachability`, the dashboard's `collectionStateOf`, `reachabilityCopy.ts` and the settings `MonitoringSection` each map it, or it reads as healthy or red. Task 10 and Task 12.
4. **Unbound and partner-wide monitors** stay on the org-wide branch. Task 6 › "unbound monitor ignores the gate".
5. **Vacuous negatives.** A result test with no recorded expectation is rejected as unexpected and proves nothing. Every negative result test in Tasks 7, 9, 11 and 13 seeds the expectation from the real builder and has a positive control that is accepted.

## File structure

| Area | Files (line ranges in each task) |
|---|---|
| Shared names and gates | `packages/shared/src/types/discoveryNetworkGate.ts` (B2); `apps/api/src/services/commandMinVersion.ts`; `services/partnerTrust.ts` |
| The decision and the verdict (new) | `apps/api/src/services/learnedNetworks/probeGate.ts`: decision, guarded wrapper, expectation guard, target site, verdict |
| Dispatch record and result routing | `services/orphanedResultExpectations.ts`; `routes/agentWs.ts`; `routes/agents/commands.ts`; `services/commandResultHandlers.ts` |
| Monitors | `services/networkExecutorSelection.ts`; `services/monitorCommands.ts`; `jobs/monitorWorker.ts`; `routes/monitors.ts`; `services/alertConditions/handlers/networkCheck.ts` |
| SNMP | `jobs/snmpWorker.ts`; `services/snmpCollectionState.ts`; `services/assetReachability.ts` |
| Asset probe | `services/assetProbe.ts`; `services/assetProbeRun.ts` |
| Web | `apps/web/src/lib/probeNotChecked.ts` (new) and the seven files in Task 12 |
| Proof (new) | `apps/api/src/__tests__/integration/networkProbeGate.integration.test.ts` |

---

### Task 1: Shared types, version floor, trust classification

**Files:** Modify `packages/shared/src/types/discoveryNetworkGate.ts`, `apps/api/src/services/commandMinVersion.ts:28-38`, `apps/api/src/services/partnerTrust.ts`. Test: `packages/shared/src/types/discoveryNetworkGate.test.ts`, `apps/api/src/services/commandMinVersion.test.ts`.

**Interfaces:**
- Consumes: B2 `GUARDED_COMMAND_TYPES`, `DiscoveryGateFailureCode`; E7 `agentSupportsGuardedCommand`, `GUARDED_DISCOVERY_MIN_AGENT_VERSION`.
- Produces:
```ts
// GUARDED_COMMAND_TYPES gains, beside network_discovery: snmp_poll, network_ping, network_tcp_check,
// network_http_check, network_dns_check, each mapped to '<base>_guarded' (C5).
export type ProbeBaseCommandType = Exclude<keyof typeof GUARDED_COMMAND_TYPES, 'network_discovery'>;
export const PROBE_NOT_CHECKED_CODES = ['no_network_assigned', 'no_agent_on_network',
  'network_mismatch', 'network_changed', 'network_unverified'] as const satisfies readonly DiscoveryGateFailureCode[];
export type ProbeNotCheckedCode = (typeof PROBE_NOT_CHECKED_CODES)[number];
export function isProbeNotCheckedCode(value: unknown): value is ProbeNotCheckedCode;
// apps/api/src/services/commandMinVersion.ts
export const GUARDED_PROBES_MIN_AGENT_VERSION = '999.0.0';
```

- [ ] **Step 1: Write the failing tests**

```ts
// discoveryNetworkGate.test.ts
it('names a guarded type for each probe command', () => {
  expect(GUARDED_COMMAND_TYPES.snmp_poll).toBe('snmp_poll_guarded');
  expect(GUARDED_COMMAND_TYPES.network_dns_check).toBe('network_dns_check_guarded');
});
it('not-checked codes fit snmp_devices.last_status', () => {
  for (const code of PROBE_NOT_CHECKED_CODES) expect(code.length).toBeLessThanOrEqual(20);
  expect(isProbeNotCheckedCode('no_agent_on_network')).toBe(true);
  expect(isProbeNotCheckedCode('offline')).toBe(false);
  expect(isProbeNotCheckedCode(null)).toBe(false);
});
// commandMinVersion.test.ts
it('every guarded probe type needs the guarded probes version, failing closed', () => {
  for (const base of ['snmp_poll', 'network_ping', 'network_tcp_check', 'network_http_check', 'network_dns_check'] as const) {
    expect(COMMAND_MIN_AGENT_VERSION[GUARDED_COMMAND_TYPES[base]]).toBe(GUARDED_PROBES_MIN_AGENT_VERSION);
    expect(agentSupportsGuardedCommand(base, GUARDED_PROBES_MIN_AGENT_VERSION)).toBe(true);
    expect(agentSupportsGuardedCommand(base, '0.0.1')).toBe(false);
    expect(agentSupportsGuardedCommand(base, null)).toBe(false);
    expect(GATED_COMMAND_TYPES).toContain(GUARDED_COMMAND_TYPES[base]);
  }
});
```

- [ ] **Step 2: Run and see them fail**

Run: `cd packages/shared && npx vitest run src/types/discoveryNetworkGate.test.ts` and `cd apps/api && npx vitest run src/services/commandMinVersion.test.ts`
Expected: FAIL (`snmp_poll_guarded` undefined; `GUARDED_PROBES_MIN_AGENT_VERSION` not exported).

- [ ] **Step 3: Implement.** Add the five pairs and the three exports to B2; add the constant and five `COMMAND_MIN_AGENT_VERSION` entries (alphabetical, one comment: "Learned networks W06b: guarded probes. W06b's last task sets the release."). The five types go in `GATED_COMMAND_TYPES` in sort order. If W06a already added them there (its Go handler registration makes `partnerTrust.test.ts` › "classifies every known command type exactly once" require them), leave them.

- [ ] **Step 4: Run and see them pass**, plus `cd apps/api && npx vitest run src/services/partnerTrust.test.ts src/services/commandMinVersion.release.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(learned-networks): guarded probe command types and version floor`

### Task 2: The probe decision

**Files:** Create `apps/api/src/services/learnedNetworks/probeGate.ts`, test `probeGate.test.ts` beside it.

**Interfaces:**
- Consumes: E5 `evaluateDiscoveryGate`; E6 `loadEligibleGuardedAgents`, `explainGuardedAgent`, `explainNoEligibleAgent`, `EligibleAgent`; B2 `ExpectedGateway`, `ExpectedNetwork`, `EXPECTED_GATEWAYS_MAX`, `NoAgentReason`; Task 1 types; `AgentCommand` (type-only, `routes/agentWs`).
- Produces:
```ts
export type ProbeGuard = { allowed: ExpectedGateway[]; agentGatewayIds: string[] };
export type ProbeDispatchNotCheckedCode = Extract<ProbeNotCheckedCode, 'no_network_assigned' | 'no_agent_on_network'>;
export type ProbeGateDecision =
  | { kind: 'unrestricted' }
  | { kind: 'guarded'; allowed: ExpectedGateway[]; agent: EligibleAgent }
  | { kind: 'not_checked'; code: ProbeDispatchNotCheckedCode; reason: NoAgentReason };
// No lock taken. Any DB context.
export async function evaluateProbeGate(input: {
  orgId: string; siteId: string; commandType: ProbeBaseCommandType; agentId?: string;
}): Promise<ProbeGateDecision>;
// type -> GUARDED_COMMAND_TYPES[type]; payload gains expectedNetwork; id unchanged.
export function guardedProbeCommand(command: AgentCommand, guard: ProbeGuard): AgentCommand;
export function expectedNetworkFor(guard: ProbeGuard): ExpectedNetwork;
```

Decision order: E5 with `profile: null`. `unrestricted` → `unrestricted`. `fail` with code `no_network_assigned` → `not_checked`, reason `none_on_network`; any other `fail` code throws (it cannot arise without a profile). `guarded` → with `agentId`, `explainGuardedAgent` (eligible → `guarded`; otherwise `not_checked` `no_agent_on_network`, reason `agents_need_update` for `needs_update`, `none_on_network` for `not_on_network`, `none_online` for the rest); without it, `loadEligibleGuardedAgents({ …, limit: 1 })`, and when empty, `explainNoEligibleAgent` for the reason. `expectedNetworkFor` keeps the agent's own gateways first, then the rest in `allowed` order, cut to `EXPECTED_GATEWAYS_MAX` (index plan call 9).

- [ ] **Step 1: Write the failing tests** (E5 and E6 mocked as modules)

```ts
it('a site that is not gated is unrestricted and reads no eligibility', async () => {
  gate.mockResolvedValue({ kind: 'unrestricted' });
  await expect(evaluateProbeGate({ orgId, siteId, commandType: 'snmp_poll' })).resolves.toEqual({ kind: 'unrestricted' });
  expect(loadEligible).not.toHaveBeenCalled();
});
it('a gated site with no assigned network is not checked', async () => {
  gate.mockResolvedValue({ kind: 'fail', error: { code: 'no_network_assigned', message: 'x' } });
  await expect(evaluateProbeGate({ orgId, siteId, commandType: 'network_ping' }))
    .resolves.toEqual({ kind: 'not_checked', code: 'no_network_assigned', reason: 'none_on_network' });
});
it('passes the command type to eligibility and picks the first eligible agent', async () => {
  gate.mockResolvedValue({ kind: 'guarded', allowed: [office] });
  loadEligible.mockResolvedValue([desktop01]);
  const d = await evaluateProbeGate({ orgId, siteId, commandType: 'network_tcp_check' });
  expect(loadEligible).toHaveBeenCalledWith(expect.objectContaining({ commandType: 'network_tcp_check', allowedGatewayIds: [office.gatewayId], limit: 1 }));
  expect(d).toEqual({ kind: 'guarded', allowed: [office], agent: desktop01 });
});
it('no eligible agent is not checked with the explained reason', async () => {
  gate.mockResolvedValue({ kind: 'guarded', allowed: [office] });
  loadEligible.mockResolvedValue([]); explainNone.mockResolvedValue('agents_need_update');
  await expect(evaluateProbeGate({ orgId, siteId, commandType: 'snmp_poll' }))
    .resolves.toEqual({ kind: 'not_checked', code: 'no_agent_on_network', reason: 'agents_need_update' });
});
it('a pinned agent that is no longer on the network is not checked', async () => { /* explainGuardedAgent → { eligible: false, reason: 'not_on_network' } ⇒ reason 'none_on_network' */ });
it('guardedProbeCommand keeps id and payload and adds expectedNetwork', () => {
  const base = { id: 'mon-1-1', type: 'network_ping', payload: { monitorId: 'm', target: '192.168.1.1' } };
  const g = guardedProbeCommand(base, { allowed: [home, office], agentGatewayIds: [office.gatewayId] });
  expect(g).toEqual({ id: 'mon-1-1', type: 'network_ping_guarded',
    payload: { monitorId: 'm', target: '192.168.1.1', expectedNetwork: { gateways: [office, home] } } });
});
it('expectedNetworkFor cuts at 64 with the agent gateways first', () => { /* 70 allowed, agent behind #69 ⇒ length 64, [0] is #69 */ });
```

`office` is `{ networkId, gatewayId, address: '192.168.1.1', mac: 'a4:2b:b0:11:22:9c' }`; `home` uses `3c:37:86:aa:bb:10`.

- [ ] **Step 2: Run and see them fail.** Run: `cd apps/api && npx vitest run src/services/learnedNetworks/probeGate.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the three functions with the order above.
- [ ] **Step 4: Run and see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(learned-networks): probe gate decision and guarded command wrapper`

### Task 3: The result verdict

**Files:** Modify `apps/api/src/services/learnedNetworks/probeGate.ts`, `probeGate.test.ts`.

**Interfaces:**
- Consumes: E10 `verifyDiscoveryResult`; Task 1 types.
- Produces:
```ts
export type ExpectationGuard = { allowedGatewayIds: string[] };
// Reads expectedNetwork from a payload the server wrote. Null for a base type; null for a
// guarded type whose payload has no readable gateway ids (the caller then records nothing).
export function probeGuardFromCommand(command: { type: string; payload?: Record<string, unknown> | null }): ExpectationGuard | null;
export type ProbeTarget = { kind: 'snmp' | 'monitor' | 'probe'; id: string };
// Current owner org and site of the target: snmp_devices -> discovered_assets.site_id;
// network_monitors.site_id ?? its asset's site_id; discovered_assets.site_id. Null when the row is gone.
export async function currentProbeTargetSite(target: ProbeTarget): Promise<{ orgId: string | null; siteId: string | null } | null>;
export type ProbeResultVerdict =
  | { kind: 'accept' }
  | { kind: 'not_checked'; code: Extract<ProbeNotCheckedCode, 'network_mismatch' | 'network_changed' | 'network_unverified'> };
export async function verifyProbeResult(input: {
  target: { orgId: string | null; siteId: string | null } | null;
  guard: ExpectationGuard | null;
  result: { status: string; errorCode?: string; result?: unknown };
}): Promise<ProbeResultVerdict>;
```

Verdict rules, in order: (1) guard set and `status === 'failed'` with `errorCode` `network_mismatch` or `network_changed` → `not_checked` with that code. (2) guard set and target null → `not_checked` `network_unverified`. (3) no guard and (target null or `siteId` null) → `accept` with no query. (4) otherwise E10 with `profileId: null`, `attempt` `{ mode: 'guarded', allowedGatewayIds }` or `{ mode: 'unrestricted', allowedGatewayIds: [] }`, and `verifiedNetwork` read from `result.result.verifiedNetwork` (guarded only); `ok` → `accept`, else `not_checked` `network_unverified`. Rule 4 is what discards an unrestricted result that lands after its site became gated (§8.4).

- [ ] **Step 1: Write the failing tests**

```ts
it('a refusal is not checked with its own code, before any verification', async () => {
  const v = await verifyProbeResult({ target: { orgId, siteId }, guard: { allowedGatewayIds: [officeGw] },
    result: { status: 'failed', errorCode: 'network_mismatch', result: { observedGateways: [] } } });
  expect(v).toEqual({ kind: 'not_checked', code: 'network_mismatch' });
  expect(verifyDiscovery).not.toHaveBeenCalled();
});
it('a guarded result is accepted only when E10 accepts its verifiedNetwork', async () => {
  const guard = { allowedGatewayIds: [officeGw] };
  verifyDiscovery.mockResolvedValueOnce({ ok: true, networkId });
  await expect(verifyProbeResult({ target: { orgId, siteId }, guard, result: { status: 'completed', result: { verifiedNetwork: vn } } }))
    .resolves.toEqual({ kind: 'accept' });
  expect(verifyDiscovery).toHaveBeenCalledWith({ orgId, siteId, profileId: null, attempt: { mode: 'guarded', ...guard }, verifiedNetwork: vn });
  verifyDiscovery.mockResolvedValueOnce({ ok: false, error: { code: 'network_unverified', message: 'x' } });
  await expect(verifyProbeResult({ target: { orgId, siteId }, guard, result: { status: 'completed', result: {} } }))
    .resolves.toEqual({ kind: 'not_checked', code: 'network_unverified' });
});
it('an unguarded result for a target with no site is accepted without a query', async () => {
  await expect(verifyProbeResult({ target: { orgId, siteId: null }, guard: null, result: { status: 'completed' } }))
    .resolves.toEqual({ kind: 'accept' });
  expect(verifyDiscovery).not.toHaveBeenCalled();
});
it('an unguarded result for a site that is now gated is not checked', async () => { /* E10 unrestricted → ok:false ⇒ network_unverified */ });
it('probeGuardFromCommand reads gateway ids only from guarded types', () => {
  expect(probeGuardFromCommand({ type: 'network_ping', payload: { expectedNetwork: { gateways: [office] } } })).toBeNull();
  expect(probeGuardFromCommand({ type: 'snmp_poll_guarded', payload: { expectedNetwork: { gateways: [office] } } }))
    .toEqual({ allowedGatewayIds: [office.gatewayId] });
  expect(probeGuardFromCommand({ type: 'snmp_poll_guarded', payload: {} })).toBeNull();
});
```

- [ ] **Step 2: Run and see them fail.** `cd apps/api && npx vitest run src/services/learnedNetworks/probeGate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with the rules above. `currentProbeTargetSite` is one query per kind, keyed by primary key.
- [ ] **Step 4: Run and see them pass.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(learned-networks): probe result verdict`

### Task 4: Every list that names a base type names its guarded type

**Files:** Modify `apps/api/src/routes/agentWs.ts:670, 683, 693`, `apps/api/src/routes/agents/commands.ts:94-140`, `apps/api/src/services/commandResultHandlers.ts:1339`, and W03a's E8 contract test `apps/api/src/services/learnedNetworks/scanCommand.contract.test.ts`.

`grep -rn "'snmp_poll'\|'network_ping'\|'network_tcp_check'\|'network_http_check'\|'network_dns_check'" apps/api/src` outside tests, classified:

| Hit | Kind | Action |
|---|---|---|
| `jobs/snmpWorker.ts:825` `type: 'snmp_poll'` | builder | guarded through `guardedProbeCommand` (Task 8) |
| `services/monitorCommands.ts:15-20` `MONITOR_TYPE_TO_COMMAND` | builder | guarded through `guardedProbeCommand` (Task 6) |
| `services/assetProbeRun.ts:99` `type: 'network_ping'` | builder | guarded through `guardedProbeCommand` (Task 11) |
| `routes/agentWs.ts:670` `MONITOR_COMMAND_TYPES` | list | add the four `network_*_guarded` |
| `routes/agentWs.ts:683` `=== 'snmp_poll'` | list | also `snmp_poll_guarded` |
| `routes/agentWs.ts:693` `=== 'network_ping'` with `probeAssetId` | list | also `network_ping_guarded` |
| `routes/agents/commands.ts:108` `REGISTRY_DISPATCHED_COMMAND_TYPES` | list | add `snmp_poll_guarded` |
| `services/commandResultHandlers.ts:1339` `snmp_poll: handleSnmpPollResult` | list | add `snmp_poll_guarded: handleSnmpPollResult` |
| `services/partnerTrust.ts:141-144, 182` `GATED_COMMAND_TYPES` | list | Task 1 |
| `services/aiToolsNetworkProbe.ts:5`, `services/assetProbe.ts:7`, `routes/agentWs.ts:690` | comments | none |
| `data/docsIndex.json:638-658` | generated docs index | none (not hand-edited) |
| `services/monitors/conversion/networkChecks.ts:59` (reads `buildMonitorCommand(row).payload`) | payload read, no send | none; the no-guard payload is unchanged |

Not applicable, verified: `services/commandTypes.ts` and `services/commandOfflinePolicy.ts` name none of the five base types; these commands are never queued as rows by type.

- [ ] **Step 1: Write the failing test.** `scanCommand.contract.test.ts` classifies files as `builder`, `paired` or `toolName` for `network_discovery` and asserts that a `paired` file names the guarded type as often as the base type. Generalize it to a `PROBE_PAIRS` table of the five pairs with its own classes: `builder` for the three builder files (their base literals and the `commandType` arguments they pass to the gate), `paired` for the four list files above, and an `exempt` class with a reason for `services/monitors/conversion/networkChecks.ts`. The discovery assertions stay as W03a wrote them.

```ts
it('every file naming a probe base or guarded type is classified, and no probe classification is stale', ...);
it('only a builder names a probe base type as a command type; no file writes a _guarded probe literal as one', ...);
it('every paired file names each guarded probe type as often as its base type', ...);
  // per paired file and pair: count('<base>') === count('<base>_guarded') + count(GUARDED_COMMAND_TYPES.<base>)
it('finds the known probe sites (not vacuous)', ...); // >= 3 builder, >= 4 paired
```

- [ ] **Step 2: Run and see it fail.** `cd apps/api && npx vitest run src/services/learnedNetworks/scanCommand.contract.test.ts`. Expected: FAIL listing `routes/agentWs.ts`, `routes/agents/commands.ts`, `services/commandResultHandlers.ts`.
- [ ] **Step 3: Implement** the list edits in the table.
- [ ] **Step 4: Run and see it pass**, plus `npx vitest run src/__tests__/parkedCommandDelivery.contract.test.ts src/services/partnerTrust.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(learned-networks): pair the guarded probe types in every command list`

### Task 5: The dispatch record carries the guard

**Files:** Modify `apps/api/src/services/orphanedResultExpectations.ts:56-63, 211-234`, `apps/api/src/routes/agentWs.ts:675-707`. Test: `services/orphanedResultExpectations.test.ts`, `routes/agentWs.test.ts`.

**Interfaces:**
- Consumes: Task 3 `probeGuardFromCommand`, `ExpectationGuard`.
- Produces: each `OrphanedResultExpectation` variant gains `guard?: ExpectationGuard`. Absent means an unrestricted send or a record written before this deploy. `parseStored` rejects a present guard that is not `{ allowedGatewayIds: string[] }` with 1 to 64 non-empty strings (fail closed: the result is then unexpected). The recorder sets `guard` from `probeGuardFromCommand(command)` for the three kinds; for a `_guarded` type where that returns null it records nothing.

- [ ] **Step 1: Write the failing tests**

```ts
// orphanedResultExpectations.test.ts
it('round-trips a guard and rejects a malformed one', async () => {
  await recordOrphanedResultExpectation('c1', { agentId: 'a', kind: 'monitor', targetId: 'm', expiresAt, guard: { allowedGatewayIds: [gw] } });
  expect((await consumeOrphanedResultExpectation('a', 'c1'))?.guard).toEqual({ allowedGatewayIds: [gw] });
  redis.store.set(orphanedResultExpectationKey('a', 'c2'), JSON.stringify({ agentId: 'a', kind: 'snmp', targetId: 'd', expiresAt, guard: { allowedGatewayIds: 'x' } }));
  expect(await consumeOrphanedResultExpectation('a', 'c2')).toBeNull();
});
// agentWs.test.ts, through sendCommandToAgent
it('records the allowed gateway ids for a guarded monitor, snmp and probe send', async () => { /* each built with guardedProbeCommand ⇒ stored guard.allowedGatewayIds equals the payload's gateway ids */ });
it('records no guard for a base send', async () => { /* network_ping with monitorId ⇒ guard undefined */ });
it('records nothing for a guarded send without expectedNetwork', async () => { /* snmp_poll_guarded, payload { deviceId } ⇒ no record */ });
```

- [ ] **Step 2: Run and see them fail.** `cd apps/api && npx vitest run src/services/orphanedResultExpectations.test.ts src/routes/agentWs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see them pass**, plus `pnpm test-stack up` then `pnpm --filter @breeze/api test:integration src/__tests__/integration/orphanedResultExpectations.integration.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(learned-networks): orphaned-result expectations carry the allowed gateways`

### Task 6: Network monitors: selection and dispatch

**Files:** Modify `apps/api/src/services/networkExecutorSelection.ts`, `services/monitorCommands.ts`, `jobs/monitorWorker.ts:160-296`, `routes/monitors.ts:191-202, 534-590`. Test: `services/networkExecutorSelection.test.ts`, `services/monitorCommands.test.ts`, `jobs/monitorWorker.test.ts`, `routes/monitors_actions.test.ts`.

**Interfaces:**
- Consumes: Task 2.
- Produces:
```ts
// networkExecutorSelection.ts. An unrestricted pick is exactly { agentId } (no guard key).
export type NetworkExecutorPick =
  | { agentId: string; guard?: ProbeGuard }
  | { error: 'no_agent_in_site' }
  | { error: 'not_checked'; code: ProbeDispatchNotCheckedCode; reason: NoAgentReason };
selectNetworkExecutor(input: { …existing; commandType: ProbeBaseCommandType }): Promise<NetworkExecutorPick>;
selectMonitorExecutor(monitor: { …existing; monitorType: string }, options): Promise<NetworkExecutorPick | { error: 'site_access_denied' }>;
// monitorCommands.ts
export function monitorCommandTypeFor(monitorType: string): Exclude<ProbeBaseCommandType, 'snmp_poll'>; // throws on unknown
export function buildMonitorCommand(monitor: {…existing}, guard?: ProbeGuard): AgentCommand;
// monitorWorker.ts
export async function recordMonitorNotChecked(monitorId: string, code: ProbeNotCheckedCode, now?: Date): Promise<void>;
```

`selectNetworkExecutor` calls `evaluateProbeGate` only when `siteId` is non-null, before the device query; `unrestricted` runs the existing query unchanged; `guarded` returns `{ agentId: decision.agent.agentId, guard: { allowed, agentGatewayIds: decision.agent.gatewayIds } }`; a pinned `agentId` is passed through to the decision. `recordMonitorNotChecked` writes exactly `last_status = 'unknown'`, `last_error = code`, `last_checked = now`, `updated_at = now`, and nothing else: no `network_monitor_results` row, no `consecutive_failures` change, no alert-rule evaluation. `CheckMonitorInputs` gains `{ status: 'not-checked'; code }` from the first phase only; `processCheckMonitor` then calls `recordMonitorNotChecked` in its own short system context and returns `{ dispatched: false, agentId: null }`. The revalidation read keeps its rule: a changed answer returns without a write. `'ok'` carries `guard`, and `buildMonitorCommand(current.monitor, current.guard)` sends. `POST /monitors/:id/test` on `not_checked` answers 200 `{ data: { monitorId, status: 'not_checked', code, testedAt } }`, sends nothing, writes nothing; with a guard it sends the guarded command.

- [ ] **Step 1: Write the failing tests**

```ts
// networkExecutorSelection.test.ts
it('unbound monitor ignores the gate', async () => {
  await selectMonitorExecutor({ orgId, assetId: null, siteId: null, target: 'http://203.0.113.20/', monitorType: 'http_check' });
  expect(evaluateProbeGate).not.toHaveBeenCalled();
});
it('a gated site returns the eligible agent with its guard', async () => {
  evaluateProbeGate.mockResolvedValue({ kind: 'guarded', allowed: [office], agent: { ...desktop01, gatewayIds: [office.gatewayId] } });
  await expect(selectNetworkExecutor({ orgId, siteId, targetIp: '192.168.1.1', commandType: 'network_ping' }))
    .resolves.toEqual({ agentId: desktop01.agentId, guard: { allowed: [office], agentGatewayIds: [office.gatewayId] } });
});
it('a gated site with no eligible agent is not checked and runs no device query', async () => { /* ⇒ { error: 'not_checked', code: 'no_agent_on_network', reason: 'none_on_network' }; db.select not called */ });
// monitorCommands.test.ts
it('emits the guarded type with expectedNetwork when given a guard', () => {
  const cmd = buildMonitorCommand(tcpMonitor, { allowed: [office], agentGatewayIds: [] });
  expect(cmd.type).toBe('network_tcp_check_guarded');
  expect(cmd.payload).toEqual({ ...buildMonitorCommand(tcpMonitor).payload, expectedNetwork: { gateways: [office] } });
});
// monitorWorker.test.ts
it('gated site with no eligible agent writes unknown/no_agent_on_network and nothing else', async () => {
  pick.mockResolvedValue({ error: 'not_checked', code: 'no_agent_on_network', reason: 'none_on_network' });
  await expect(processCheckMonitor({ type: 'check-monitor', monitorId, orgId })).resolves.toEqual({ dispatched: false, agentId: null });
  expect(updateSet).toEqual({ lastStatus: 'unknown', lastError: 'no_agent_on_network', lastChecked: expect.any(Date), updatedAt: expect.any(Date) });
  expect(insertSpy).not.toHaveBeenCalled();          // no network_monitor_results row
  expect(dispatchCommandToAgent).not.toHaveBeenCalled();
  expect(createSourcedAlert).not.toHaveBeenCalled(); expect(resolveAlert).not.toHaveBeenCalled();
});
it('gated site with an eligible agent dispatches the guarded command', async () => { /* type network_ping_guarded, payload.expectedNetwork.gateways[0] === office */ });
// monitors_actions.test.ts
it('POST /monitors/:id/test answers not_checked and sends nothing on a gated site with no eligible agent', async () => { /* body.data.status === 'not_checked', code 'no_agent_on_network'; sendCommandToAgent not called */ });
```

- [ ] **Step 2: Run and see them fail.** `cd apps/api && npx vitest run src/services/networkExecutorSelection.test.ts src/services/monitorCommands.test.ts src/jobs/monitorWorker.test.ts src/jobs/monitorWorker.dbcontext.test.ts src/routes/monitors_actions.test.ts`. Expected: FAIL on the new tests only.
- [ ] **Step 3: Implement.** Existing fixtures that build monitor objects for `selectMonitorExecutor` gain `monitorType`; existing suites gain the `probeGate` module mock returning `unrestricted`.
- [ ] **Step 4: Run and see them pass.** Same command. Expected: PASS, with every pre-existing test in those files unchanged in its assertions.
- [ ] **Step 5: Commit** `feat(learned-networks): network monitors follow the gate at dispatch`

### Task 7: Network monitors: results and alerts

**Files:** Modify `apps/api/src/routes/agentWs.ts:195-198, 1515-1541, 1641-1706`, `services/alertConditions/handlers/networkCheck.ts:57-66`. Test: `routes/agentWs.test.ts`, `services/alertConditions/handlers/networkCheck.test.ts`.

**Interfaces:**
- Consumes: Task 3 `currentProbeTargetSite`, `verifyProbeResult`; Task 5 expectation `guard`; Task 6 `recordMonitorNotChecked`.
- Produces: no new exports.

Result branch shape. The SNMP expectation peek (`:1540-1541`) becomes one peek when no payload matched, branching on `kind`: `snmp` → Task 9; `monitor` with a `guard` → consume, verdict, and on `not_checked` `recordMonitorNotChecked(targetId, code)`; `monitor` without a guard → fall through unconsumed, as before. In the payload-matched monitor branch, after the expectation matches and before `normalizeMonitorStatus`: `verifyProbeResult({ target: await currentProbeTargetSite({ kind: 'monitor', id }), guard: expectation.guard ?? null, result })`; `not_checked` → `recordMonitorNotChecked`, return; `accept` → the existing path. Verdict and write run in one `withDbTransaction`, catch outside. `normalizeMonitorStatus` keeps its body; refusals never reach it.

Handler: the managed-row select adds `lastStatus` and `lastError`. When `lastStatus === 'unknown' && isProbeNotCheckedCode(lastError)`, return `{ passed: false, dataAvailable: false, description: 'Network check not run: no verified agent on the site network' }` before reading results. The chain that makes this "neither raised nor resolved": `alertService.ts:613` and `:643` skip resolution on `dataState === 'unknown'`; a non-triggering leaf raises nothing; the sweep records an `unknown` observation (`alertService.ts:1555`), which `services/monitors/episodeService.ts:187` never uses to open or close an episode (pinned by `episodeService.test.ts` › "does NOT close an open episode on unknown" and › "does NOT open an episode on unknown"). Task 13 proves the whole chain on real Postgres. A managed row can carry a not-checked code only when it has a site, so it is org-owned (`network_monitors_site_owner_chk`), and its `last_error` belongs to that one org.

- [ ] **Step 1: Write the failing tests**

```ts
// agentWs.test.ts — each seeds the expectation with the guard from guardedProbeCommand(buildMonitorCommand(m), guard)
it('payload-less guarded refusal is not checked', async () => {
  await processOrphanedCommandResult(agentId, deviceId, { type: 'command_result', commandId, status: 'failed',
    errorCode: 'network_mismatch', result: { observedGateways: [{ interfaceName: 'Wi-Fi', address: '192.168.1.1', mac: '3c:37:86:aa:bb:10' }] } });
  expect(recordMonitorNotChecked).toHaveBeenCalledWith(monitorId, 'network_mismatch');
  expect(enqueueMonitorCheckResult).not.toHaveBeenCalled(); expect(recordMonitorCheckResult).not.toHaveBeenCalled();
});
it('a refusal that carries a monitor-shaped offline body is still not checked', async () => {
  /* status 'failed', errorCode 'network_changed', result { monitorId, status: 'offline' } ⇒ recordMonitorNotChecked(monitorId, 'network_changed'); nothing enqueued */
});
it('a guarded result without an accepted verifiedNetwork is not checked', async () => { /* verdict not_checked network_unverified ⇒ recordMonitorNotChecked(monitorId, 'network_unverified') */ });
it('a guarded result with an accepted verifiedNetwork is recorded as before', async () => { /* positive control: enqueueMonitorCheckResult called with status 'offline' */ });
// networkCheck.test.ts
it('a not-checked managed row reports no data, so nothing is raised or resolved', async () => {
  managedRow({ lastStatus: 'unknown', lastError: 'no_agent_on_network' }); results([offline, offline, offline]);
  await expect(networkCheckHandler.evaluate({ type: 'network_check', monitorId: defId, consecutiveFailures: 2 }, deviceId))
    .resolves.toMatchObject({ passed: false, dataAvailable: false });
});
it('unknown with an ordinary error still evaluates results', async () => { /* lastError 'timeout' ⇒ dataAvailable undefined, passed true */ });
```

- [ ] **Step 2: Run and see them fail.** `cd apps/api && npx vitest run src/routes/agentWs.test.ts src/services/alertConditions/handlers/networkCheck.test.ts`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see them pass**, plus `npx vitest run src/services/alertService.test.ts src/services/alertConditions`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(learned-networks): monitor results follow the gate; network_check reports no data when not checked`

### Task 8: SNMP polling: dispatch

**Files:** Modify `apps/api/src/jobs/snmpWorker.ts:325-338, 406-469, 497-590, 796-843`. Test: `jobs/snmpWorker.orgAuthority.test.ts` (or a new `jobs/snmpWorker.networkGate.test.ts` beside it).

**Interfaces:**
- Consumes: Task 2.
- Produces: `PollDispatchInputs` gains `{ status: 'not-checked'; code: ProbeDispatchNotCheckedCode; reason: NoAgentReason }`, and `'ok'` gains `guard?: ProbeGuard`. `buildSnmpPollCommand(deviceId, device, oids, idPrefix?, extras?)` keeps its signature; `SnmpPollCommandExtras` gains `guard?: ProbeGuard`, applied last through `guardedProbeCommand`. New private `recordPollNotChecked(deviceId: string, code: ProbeDispatchNotCheckedCode): Promise<void>` writes only `last_status = code`; it shares nothing with `recordSiteAuthorityFailure`.

In `loadPollDispatchInputs`, after the asset row lock resolves `executionSiteId` (non-null only), call `evaluateProbeGate({ orgId: device.orgId, siteId: executionSiteId, commandType: 'snmp_poll' })` before the device query. `unrestricted` → the existing query and `no-agent` path unchanged. `guarded` → `ok` with `agentId` and `guard`. `not_checked` → `not-checked`. In `processPollDevice`, `not-checked` calls `recordPollNotChecked` in its own short system context and returns `{ dispatched: false, agentId: null }` without `markPollDispatched`. A row with no asset never reaches the decision (plan call 12).

- [ ] **Step 1: Write the failing tests**

```ts
it('gated site with no eligible agent records no_agent_on_network and adds no failure count', async () => {
  evaluateProbeGate.mockResolvedValue({ kind: 'not_checked', code: 'no_agent_on_network', reason: 'none_on_network' });
  await expect(processPollDevice({ type: 'poll-device', deviceId, orgId })).resolves.toEqual({ dispatched: false, agentId: null });
  expect(updateSets).toContainEqual({ lastStatus: 'no_agent_on_network' });
  expect(updateSets.some((s) => 'consecutiveFailures' in s)).toBe(false);
  expect(dispatchCommandToAgent).not.toHaveBeenCalled(); expect(decryptSnmpSecret).not.toHaveBeenCalled();
});
it('gated site sends snmp_poll_guarded to the eligible agent', async () => {
  /* ⇒ dispatchCommandToAgent(desktop01.agentId, expect.objectContaining({ type: 'snmp_poll_guarded',
       payload: expect.objectContaining({ deviceId, expectedNetwork: { gateways: [office] } }) }), { priority: 'probe' }) */
});
it('a row with no asset never asks the gate', async () => { /* device.assetId null ⇒ evaluateProbeGate not called; type 'snmp_poll' */ });
```

- [ ] **Step 2: Run and see them fail.** `cd apps/api && npx vitest run src/jobs/snmpWorker`. Expected: FAIL on the new tests (check the file count includes all five `snmpWorker*` suites).
- [ ] **Step 3: Implement.** Existing suites gain the `probeGate` mock returning `unrestricted`.
- [ ] **Step 4: Run and see them pass**, plus `pnpm --filter @breeze/api test:integration src/__tests__/integration/snmpWorkerSiteAuthority.integration.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(learned-networks): SNMP polling follows the gate at dispatch`

### Task 9: SNMP polling: results on both paths

**Files:** Modify `apps/api/src/routes/agentWs.ts:1540-1592`, `services/commandResultHandlers.ts:357-425`. Test: `routes/agentWs.test.ts`, `services/commandResultHandlers.snmp.test.ts`.

**Interfaces:**
- Consumes: Task 3, Task 5.
- Produces:
```ts
// commandResultHandlers.ts, beside recordSnmpPollFailure. Only for a poll that was dispatched
// (markPollDispatched counted it): gives that count back and replaces any status it set.
export async function recordSnmpPollNotCheckedAfterDispatch(snmpDeviceId: string, code: ProbeNotCheckedCode): Promise<void>;
```
It writes exactly `last_status = code` and `consecutive_failures = GREATEST(consecutive_failures - 1, 0)`. It does not touch `last_error`, `last_error_at`, `last_polled`, `last_poll_attempted_at` or `poll_seq`.

On the WebSocket path, after the expectation is consumed and matched, and before the `status !== 'completed'` test: verdict with `currentProbeTargetSite({ kind: 'snmp', id: snmpDeviceId })` and `expectation.guard`; `not_checked` → `recordSnmpPollNotCheckedAfterDispatch`, return. On the persisted path, `handleSnmpPollResult` does the same with `probeGuardFromCommand(command)` (the stored row's payload, which the server wrote) before its failure branch. Both run in `withDbTransaction`, catch outside.

- [ ] **Step 1: Write the failing tests**

```ts
it('two prior failures plus a refusal leaves two and not offline', async () => {
  // real arithmetic through the SQL fragment: assert the set clause
  await recordSnmpPollNotCheckedAfterDispatch(snmpDeviceId, 'network_mismatch');
  expect(lastSet).toEqual({ lastStatus: 'network_mismatch', consecutiveFailures: sqlMatching(/GREATEST\(.*- 1, 0\)/) });
});
it('guarded refusal never reaches recordSnmpPollFailure', async () => {
  /* WS path, expectation kind 'snmp' with guard; result { status: 'failed', errorCode: 'network_changed' }
     ⇒ recordSnmpPollNotCheckedAfterDispatch(id, 'network_changed'); recordSnmpPollFailure and enqueueSnmpPollResults not called */
});
it('guarded metrics without an accepted verifiedNetwork are discarded as not checked', async () => { /* both paths ⇒ network_unverified; no enqueue */ });
it('guarded metrics with an accepted verifiedNetwork are enqueued as before', async () => { /* positive control, both paths */ });
it('a guarded failure with an accepted verifiedNetwork is a real failure', async () => {
  /* { status: 'failed', error: 'timeout', result: { deviceId, success: false, verifiedNetwork: vn } }, verdict accept
     ⇒ recordSnmpPollFailure(id, …, 'timeout'); recordSnmpPollNotCheckedAfterDispatch not called; both paths */
});
it('the persisted path reads the guard from the stored command payload', async () => {
  /* commandResultHandlers.snmp_poll_guarded({ command: { type: 'snmp_poll_guarded', payload: { deviceId, expectedNetwork } }, … }) ⇒ verifyProbeResult guard { allowedGatewayIds: [office.gatewayId] } */
});
```

The integration test (Task 13) proves the count against real Postgres.

- [ ] **Step 2: Run and see them fail.** `cd apps/api && npx vitest run src/routes/agentWs.test.ts src/services/commandResultHandlers.snmp.test.ts src/services/commandResultHandlers.silentFailures.test.ts`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see them pass.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(learned-networks): SNMP results follow the gate on both result paths`

### Task 10: SNMP status readers say "not checked"

**Files:** Modify `apps/api/src/services/snmpCollectionState.ts:19, 92-100`, `services/assetReachability.ts:31, 94-101`. Test: `snmpCollectionState.test.ts`, `assetReachability.test.ts`.

**Interfaces:** `CollectionStatus` and `SnmpDetailState` each gain `'not_checked'`; both maps send all five `PROBE_NOT_CHECKED_CODES` to it. In `deriveReachability` the SNMP not-checked state is reported in `detail.snmp` and pushes no observation, like the other protocol-class states.

- [ ] **Step 1: Write the failing tests**

```ts
it.each(PROBE_NOT_CHECKED_CODES)('%s is not_checked, never ok', (code) => {
  expect(deriveCollection({ ...base, snmpDevice: { ...dev, lastStatus: code, lastPolled: hourAgo } }).status).toBe('not_checked');
});
it.each(PROBE_NOT_CHECKED_CODES)('%s adds no SNMP observation to reachability', (code) => {
  const r = deriveReachability({ ...input, snmpDevice: { ...snmp, lastStatus: code, lastPolled: minuteAgo } }, now);
  expect(r.detail.snmp?.state).toBe('not_checked');
  expect(r.source).not.toBe('snmp');
});
```

- [ ] **Step 2: Run and see them fail.** `cd apps/api && npx vitest run src/services/snmpCollectionState.test.ts src/services/assetReachability.test.ts`. Expected: FAIL (`ok`, and a positive `snmp` source).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see them pass**, plus `npx vitest run src/services/assetReachabilityLoader.test.ts src/services/aiToolsNetwork.reachability.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(learned-networks): SNMP not-checked states in collection and reachability`

### Task 11: Asset "Check now"

**Files:** Modify `apps/api/src/services/assetProbe.ts`, `services/assetProbeRun.ts:42-186`, `routes/agentWs.ts:1597-1638`. Test: `routes/discoveryAssetProbe.test.ts`, `services/assetProbe.test.ts`, `routes/agentWs.test.ts`, `services/aiToolsNetworkMonitoring.test.ts`.

**Interfaces:**
- Consumes: Tasks 3, 5, 6.
- Produces:
```ts
export type ProbeOutcome =
  | { status: 'ok' | 'failed'; responseMs: number | null; error: string | null }
  | { status: 'not_checked'; code: 'network_mismatch' | 'network_changed' | 'network_unverified'; responseMs: null; error: null };
// CAS on id, last_probe_ref = commandId, last_probe_status = 'pending'. Sets last_probe_status,
// last_probe_at, last_probe_response_ms and last_probe_ref to NULL and updated_at to now. Wakes the waiter.
export async function resetProbeNotChecked(input: { commandId: string; assetId: string; code: …same three… }): Promise<boolean>;
// assetProbeRun.ts: the command runAssetProbe sends, extracted so tests seed expectations from it.
export function buildAssetProbeCommand(input: { assetId: string; ipAddress: string; siteId: string; commandId: string; guard?: ProbeGuard }): AgentCommand;
```

`runAssetProbe` passes `commandType: 'network_ping'`. A `not_checked` pick returns before the stamp, before `onDispatch`, writing nothing: `409 { error: 'Not checked: no agent is on this site’s network', code: 'NO_AGENT_ON_NETWORK', reason }` for `no_agent_on_network`, and `409 { error: 'Not checked: this site requires a network and none is assigned', code: 'NO_NETWORK_ASSIGNED' }`. A guard wraps the command (`probeAssetId` and `probeSiteId` stay in the payload). For a guarded pick whose dispatch does not send, the stamp is reset with `resetProbeNotChecked` (`network_unverified`) instead of stamped `failed`, and the answer is `409 { error: 'Not checked: the probe could not be sent to the agent. Try again shortly.', code: 'DISPATCH_FAILED' }`; an unguarded pick keeps `assetProbeRun.ts:113-158` unchanged. A `not_checked` outcome inside the wait returns `409 { error: 'Not checked: the agent could not confirm it was on this site’s network', code: 'NETWORK_NOT_VERIFIED', reason: <code> }`. In the probe result branch, the verdict (`currentProbeTargetSite({ kind: 'probe', id })`, `expectation.guard`) runs before the status mapping; `not_checked` → `resetProbeNotChecked`, never `applyProbeResult`. `probe_network_asset` already returns `{ error, code }` for a 409; it gains no code change unless its test fails.

- [ ] **Step 1: Write the failing tests**

```ts
// discoveryAssetProbe.test.ts
it('returns 409 NO_AGENT_ON_NETWORK and writes nothing on a gated site with no eligible agent', async () => {
  const res = await post(`/discovery/assets/${assetId}/probe`);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: 'NO_AGENT_ON_NETWORK', reason: 'none_on_network' });
  expect(assetUpdates).toEqual([]); expect(dispatchCommandToAgent).not.toHaveBeenCalled(); expect(writeRouteAudit).not.toHaveBeenCalled();
});
it('sends network_ping_guarded with expectedNetwork and the probe correlation fields', async () => { /* payload has probeAssetId, probeSiteId, expectedNetwork */ });
it('returns 409 NETWORK_NOT_VERIFIED when the agent refuses within the wait', async () => { /* waiter resolved by resetProbeNotChecked */ });
// assetProbe.test.ts
it('resetProbeNotChecked nulls exactly the four probe columns, only for the pending dispatch', async () => {
  expect(lastSet).toEqual({ lastProbeStatus: null, lastProbeAt: null, lastProbeResponseMs: null, lastProbeRef: null, updatedAt: expect.any(Date) });
  expect(whereSql).toMatch(/last_probe_ref.*last_probe_status/);
});
// agentWs.test.ts
it('guarded refusal resets the pending probe and records no negative observation', async () => {
  /* probe- command id, guarded expectation, { status: 'failed', errorCode: 'network_mismatch' } ⇒ resetProbeNotChecked called; applyProbeResult not called */
});
it('a guarded probe with an accepted verifiedNetwork applies as before', async () => { /* positive control ⇒ applyProbeResult status 'ok' */ });
it('a guarded probe that got no answer, with an accepted verifiedNetwork, records failed', async () => { /* result { status: 'offline', verifiedNetwork: vn } ⇒ applyProbeResult status 'failed' */ });
// discoveryAssetProbe.test.ts
it('a guarded dispatch that does not send resets the stamp and answers DISPATCH_FAILED', async () => { /* relay { status: 'offline' } ⇒ resetProbeNotChecked called, applyProbeResult not called, 409 */ });
// aiToolsNetworkMonitoring.test.ts
it('probe_network_asset returns the same refusal', async () => {
  runAssetProbe.mockResolvedValue({ status: 409, body: { error: 'x', code: 'NO_AGENT_ON_NETWORK' } });
  expect(JSON.parse(await call('probe_network_asset', { assetId }))).toEqual({ error: 'x', code: 'NO_AGENT_ON_NETWORK' });
});
```

- [ ] **Step 2: Run and see them fail.** `cd apps/api && npx vitest run src/routes/discoveryAssetProbe.test.ts src/services/assetProbe.test.ts src/routes/agentWs.test.ts src/services/aiToolsNetworkMonitoring.test.ts`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see them pass**, plus `pnpm --filter @breeze/api test:integration src/__tests__/integration/aiToolsNetworkMonitoringScope.integration.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(learned-networks): asset probe follows the gate`

### Task 12: Web: "Not checked"

**Files:** Create `apps/web/src/lib/probeNotChecked.ts`. Modify `apps/web/src/components/monitoring/MonitoringAssetsDashboard.tsx:56-76`, `components/monitors/NetworkMonitorList.tsx:64-69, 294-299`, `components/monitors/MonitorDetailModal.tsx:137, 189-191`, `components/devices/networkDevice/useAssetProbe.ts`, `components/devices/networkDevice/types.ts:22, 27-32, 50`, `components/devices/networkDevice/reachabilityCopy.ts:41-49, 173`, `components/devices/networkDevice/settings/MonitoringSection.tsx:59, 227-230`; locales `apps/web/src/locales/<all eight>/common.json` and `devices.json`. Tests beside each component.

**Interfaces:**
```ts
// apps/web/src/lib/probeNotChecked.ts
export { isProbeNotCheckedCode, type ProbeNotCheckedCode } from '@breeze/shared';
export const NOT_CHECKED_REASON_KEYS: Record<ProbeNotCheckedCode, string>; // 'common:longTail.monitors.notChecked.<code>'
```

Behavior. A monitor is not checked when `lastStatus === 'unknown' && isProbeNotCheckedCode(lastError)`: the list badge reads "Not checked" in the muted style with the reason as its `title`; the detail modal shows the reason in muted text in place of the red raw `lastError`. The dashboard's `collectionStateOf` returns `'not_checked'` (muted) for a not-checked `lastStatus`, tested before `!lastPolled`; such a row does not count in `snmpWarningOrOffline`. On the device page, collection status `not_checked` and SNMP detail `not_checked` are muted, never destructive, and `MonitoringSection` adds `not_checked` to `collectionStates` and maps the five codes to it. `useAssetProbe` adds codes `NO_AGENT_ON_NETWORK`, `NO_NETWORK_ASSIGNED`, `NETWORK_NOT_VERIFIED`; while polling a pending probe, a refreshed asset whose `probe` is `null` sets `NETWORK_NOT_VERIFIED` (only `resetProbeNotChecked` clears a pending stamp to null). Write `cond ? t('a') : t('b')`; dynamic keys go through the static maps.

English copy (exact):

| Key | Text |
|---|---|
| `common:longTail.monitors.notChecked.label` | Not checked |
| `….notChecked.no_agent_on_network` | No agent is on this site's network right now. |
| `….notChecked.no_network_assigned` | This site requires a network, and none is assigned. |
| `….notChecked.network_mismatch` | The agent was not on this site's network. |
| `….notChecked.network_changed` | The agent's network changed during the check. |
| `….notChecked.network_unverified` | The agent's network could not be confirmed. |
| `common:longTail.monitoring.MonitoringAssetsDashboard.collectionState.not_checked` | Not checked |
| `devices:networkDeviceDetailPage.collection.status.notChecked` | Not checked |
| `devices:networkDeviceDetailPage.reachability.detail.snmp.not_checked` | Not checked |
| `devices:networkDeviceDetailPage.settings.monitoring.collectionStatus.not_checked` | Not checked |
| `devices:networkDeviceDetailPage.probe.errors.noAgentOnNetwork` | Not checked: no agent is on this site's network right now. |
| `devices:networkDeviceDetailPage.probe.errors.noNetworkAssigned` | Not checked: this site requires a network, and none is assigned. Assign one under Discovery, Networks. |
| `devices:networkDeviceDetailPage.probe.errors.networkNotVerified` | Not checked: the agent could not confirm it was on this site's network. |

All eight locales (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`) get every key, translated.

- [ ] **Step 1: Write the failing tests**

```tsx
// NetworkMonitorList.test.tsx
it('shows Not checked, muted, with the reason, for a not-checked monitor', async () => {
  mockMonitors([{ ...m, lastStatus: 'unknown', lastError: 'no_agent_on_network' }]);
  const badge = await screen.findByText('Not checked');
  expect(badge.closest('span')).toHaveAttribute('title', "No agent is on this site's network right now.");
  expect(badge.closest('span')?.className).not.toMatch(/red|destructive/);
});
// MonitorDetailModal.test.tsx
it('never prints a not-checked code raw or in red', async () => { /* queryByText('no_agent_on_network') null; reason text present */ });
// MonitoringAssetsDashboard.test.tsx
it('an SNMP row that was not checked reads Not checked and is not counted as a warning', async () => { /* lastStatus 'network_mismatch' */ });
// reachabilityCopy.test.ts
it('not_checked collection status is muted', () => { expect(formatLastPoll({ ...collection, status: 'not_checked' }, t, 'UTC').tone).toBe('muted'); });
// useAssetProbe.test.ts
it.each(['NO_AGENT_ON_NETWORK', 'NO_NETWORK_ASSIGNED', 'NETWORK_NOT_VERIFIED'])('keeps the %s code', async (code) => { /* 409 body { code } ⇒ errorCode === code */ });
it('a pending probe that clears to null reads NETWORK_NOT_VERIFIED', async () => { /* rerender pending → null ⇒ errorCode 'NETWORK_NOT_VERIFIED' */ });
```

- [ ] **Step 2: Run and see them fail.** `cd apps/web && npx vitest run src/components/monitors/NetworkMonitorList.test.tsx src/components/monitors/MonitorDetailModal.test.tsx src/components/monitoring/MonitoringAssetsDashboard.test.tsx src/components/devices/networkDevice/reachabilityCopy.test.ts src/components/devices/networkDevice/useAssetProbe.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, including the locale keys.
- [ ] **Step 4: Run and see them pass**, plus `cd apps/web && npx vitest run src/locales src/lib/__tests__`. Expected: PASS (`translationCoverage`, key-usage and no-silent-mutations suites included).
- [ ] **Step 5: Commit** `feat(learned-networks): web shows not checked for gated probes`

### Task 13: Integration proof on real Postgres

**Files:** Create `apps/api/src/__tests__/integration/networkProbeGate.integration.test.ts`.

Setup. `import './setup'`; mock `services/agentCommandRelay` (`isAgentConnectedAnywhere` → true, `dispatchCommandToAgent` records the command) and `bullmq`, as `snmpWorkerSiteAuthority.integration.test.ts:12-35` does; Redis-backed expectations stay real. Fixture: one org, site Main Office; learned network `192.168.1.0/24` via `192.168.1.1` with fingerprint `a4:2b:b0:11:22:9c` (office) and an unassigned network with `3c:37:86:aa:bb:10` (home), seeded with the admin connection; the site gated through W03c `assignNetwork`. `LAPTOP-JS` is online, assigned to the site, current behind the home fingerprint. `DESKTOP-01`, when a test needs an eligible agent, is current behind the office fingerprint, confirmed now, agent version `GUARDED_PROBES_MIN_AGENT_VERSION`. Targets: an asset inside `192.168.1.0/24`, an ICMP monitor on it with an `offline` alert rule and an active alert for that rule, an SNMP device on it with `consecutive_failures = 2`. Results go through `processOrphanedCommandResult` inside `withDbAccessContext` for the agent's org, as `backupVaultResultIntegrity.integration.test.ts:48-56` does. Every result test first records the expectation from the real builder's command (`recordOrphanedResultExpectation(command.id, { …, guard: probeGuardFromCommand(command) })`, with the guard from `evaluateProbeGate`) and asserts it with `peekOrphanedResultExpectation`. Monitor and SNMP result tests dispatch through the worker first, which captures that command. Asset probe tests never wait out `PROBE_WAIT_MS`: the 409 test returns before the stamp; the result tests write the pending stamp with the admin connection (committed, `last_probe_ref` = `buildProbeCommandId(assetId)`) and seed from `buildAssetProbeCommand`, then deliver the result; the ungated probe test makes the relay answer `{ status: 'offline' }` for that call, so `runAssetProbe` returns at once and the sent command is read from the mock. A managed network check (seeded as `networkCheckSingleAlertDevice.integration.test.ts` does) on the same asset carries an open episode and its open alert.

- [ ] **Step 1: Write the tests** (each asserts the rows, not the mocks). A name ending in `: monitor`, `: SNMP poll` or `: asset probe`, or written with ` / `, is one test per path.

| Test name | Assertions |
|---|---|
| gated site, no eligible agent: monitor is not checked and no alert is raised or resolved | `network_monitors.last_status = 'unknown'`, `last_error = 'no_agent_on_network'`, `consecutive_failures` unchanged; `network_monitor_results` count unchanged; the alert is still `active`; alert count for the org unchanged; no dispatch |
| gated site, no eligible agent: a managed network check keeps its open episode and alert | after the managed row is written not checked, `evaluateNetworkCheckAlertsForOrg(orgId)`: the `monitor_episodes` row's `ended_at` stays null, its alert stays `active`, no new alert; `monitor_device_state.last_state = 'unknown'` |
| gated site: SNMP poll with no eligible agent adds no failure count | `snmp_devices.last_status = 'no_agent_on_network'`, `consecutive_failures = 2`; no dispatch |
| gated site: asset probe returns 409 and writes nothing | status 409, code `NO_AGENT_ON_NETWORK`; the asset's four `last_probe_*` columns and `updated_at` equal their seeded values; no dispatch |
| a refusal with network_mismatch is not checked: monitor | DESKTOP-01 eligible, guarded dispatch; refusal ⇒ `unknown`/`network_mismatch`, no results row, alert untouched |
| a refusal with network_mismatch is not checked: SNMP poll | after dispatch `consecutive_failures = 3` and `offline`; refusal ⇒ `2` and `network_mismatch` |
| a refusal with network_mismatch is not checked: asset probe | pending stamp reset to four NULLs; reachability `detail.probe` absent |
| a guarded result with a fingerprint that is no longer assigned is discarded: monitor / SNMP poll / asset probe | dispatch guarded, then `unassignNetwork`, then a completed result whose `verifiedNetwork` names the office fingerprint ⇒ `network_unverified` state on each path, no results row, no metrics, no `ok` probe |
| a guarded result with an assigned fingerprint is accepted: monitor / SNMP poll / asset probe | positive controls for the two rows above: results row written, metrics job enqueued, probe `ok` |
| ungated site: each producer sends the base command unchanged to an old agent | second site, not gated, agent version `0.100.0`: `snmp_poll`, `network_ping` (monitor) and `network_ping` (probe) dispatched; no `expectedNetwork`; monitor payload equals `buildMonitorCommand(monitor).payload` |

- [ ] **Step 2: Run them.** `pnpm test-stack up`, then `pnpm --filter @breeze/api test:integration src/__tests__/integration/networkProbeGate.integration.test.ts`. Expected: PASS on Tasks 1 to 11. Red step, one local mutation at a time, each restored: drop the `evaluateProbeGate` call from `selectNetworkExecutor` (the three "gated site" dispatch tests fail); drop it from `loadPollDispatchInputs` (the SNMP dispatch test fails); drop the verdict call in each result branch (that path's refusal and unassigned tests fail); make `recordSnmpPollNotCheckedAfterDispatch` leave the count (the SNMP refusal test fails); return `dataAvailable` undefined from the handler (the episode test fails).
- [ ] **Step 3: Check the suite is picked up.** `pnpm --filter @breeze/api test:integration-suite-coverage`. Expected: PASS. Then `pnpm test-stack down`.
- [ ] **Step 4: Commit** `test(learned-networks): real-Postgres proof for gated probes`

### Task 14: Docs, release note, lab leg, follow-ups, version floor

**Files:** `apps/docs/src/content/docs/features/learned-networks.mdx` (W05's page: a new heading "Monitors, SNMP polling and Check now" after "What "requires a network" means", and the version line under "Agent version"), `features/network-monitors.mdx` (under "Monitor Status Lifecycle", line 106), `features/snmp.mdx` (under "Polling Architecture", line 270), `agents/commands.mdx:856-863` (five rows), `docs/release-notes/next-release-draft.md` ("Features / API", line 37), `docs/superpowers/plans/monitoring/evidence/2026-11-21-learned-networks-lab-proof.md` (W05's file), `apps/api/src/services/commandMinVersion.ts`.

- [ ] **Step 1: Docs.** One subsection each: on a site that requires a network, monitors, SNMP polling and "Check now" run only from an agent that has just proven it is behind one of the site's gateways; otherwise the check reads "Not checked" with its reason, records no failure, and raises or resolves no alert; such checks need agents at or above the release named in Step 5; checks with no site (SNMP devices without an asset, monitors with no site or asset) are not affected. Commands table: five `_guarded` rows, "Same payload plus `expectedNetwork`". Never "verified location".
- [ ] **Step 2: Release note**, one entry: "On sites that require a network, network monitors, SNMP polling and Check now run only from an agent on that network. When none is there, the check reads Not checked instead of down, and no alert fires or clears. Agents at or above <version> are required." Rebase just before enqueueing (this file conflicts often).
- [ ] **Step 3: Lab leg.** Insert `## Leg 10: Monitors, SNMP polling and Check now` before `## Result` in W05's evidence file, on W05's rig (site `Lab Office`, router A's network assigned), recording what was done, what was observed, ids and counts, and a verdict; add the leg to `## Result`.
  1. Every `Lab Office` agent stopped except the Linux lab VM, which is behind router B only.
  2. An ICMP monitor (with an `offline` alert rule) and SNMP polling enabled for a device that answers behind router A; note `network_monitor_results` count, `snmp_devices.consecutive_failures` and the org's open alert count; wait two polling intervals.
  3. Must observe: monitor list, monitor detail and asset dashboard read "Not checked" with the reason; the three numbers unchanged; "Check now" on the device returns 409 `NO_AGENT_ON_NETWORK`.
  4. Move the Linux lab VM behind router A and wait a heartbeat: the next check is `network_ping_guarded`, the agent log shows the gateway proof, the monitor reads the device's real status, and a poll writes metrics.
- [ ] **Step 4: File the two follow-ups** (index plan call 12), label `enhancement`, linked to the feature issue:
  - "SNMP devices with no linked asset follow the network gate". Scope: an SNMP polling row with no discovered asset gets a site (through an asset or an explicit site), and from then on follows that site's network gate exactly as asset-bound rows do, including "not checked" when no eligible agent is on the network.
  - "Topology interface polling follows the network gate". Scope: on a site that requires a network, the topology interface poll is sent only to an eligible agent as a guarded command, and "no eligible agent" reads as not checked.
- [ ] **Step 5: Set the version floor.** Once the W06a agent release exists, set `GUARDED_PROBES_MIN_AGENT_VERSION` to that release's version, run `cd apps/api && npx vitest run src/services/commandMinVersion.test.ts` (PASS), and put the version in Step 2's note.
- [ ] **Step 6: Commit** `docs(learned-networks): other producers follow the gate; lab leg; version floor`

---

## Done when

- [ ] `cd packages/shared && npx vitest run src/types/discoveryNetworkGate.test.ts` passes.
- [ ] `cd apps/api && npx vitest run src/services/learnedNetworks src/services/commandMinVersion src/services/partnerTrust.test.ts src/services/orphanedResultExpectations.test.ts src/services/networkExecutorSelection.test.ts src/services/monitorCommands.test.ts src/jobs/monitorWorker src/jobs/snmpWorker src/routes/agentWs.test.ts src/routes/monitors_ src/routes/discoveryAssetProbe.test.ts src/services/assetProbe src/services/commandResultHandlers src/services/alertConditions src/services/alertService.test.ts src/services/snmpCollectionState.test.ts src/services/assetReachability src/services/aiToolsNetworkMonitoring.test.ts` passes, with the file count checked against the list.
- [ ] Contract tests pass: `src/services/learnedNetworks/scanCommand.contract.test.ts`, `src/__tests__/parkedCommandDelivery.contract.test.ts`, `src/__tests__/parkedFanout.contract.test.ts`, `src/__tests__/dbTransactionPromiseAll.contract.test.ts`.
- [ ] `cd apps/web && npx vitest run src/components/monitors src/components/monitoring/MonitoringAssetsDashboard.test.tsx src/components/devices/networkDevice src/locales src/lib/__tests__` passes.
- [ ] With `pnpm test-stack up`: `pnpm --filter @breeze/api test:integration src/__tests__/integration/networkProbeGate.integration.test.ts src/__tests__/integration/snmpWorkerSiteAuthority.integration.test.ts src/__tests__/integration/orphanedResultExpectations.integration.test.ts src/__tests__/integration/aiToolsNetworkMonitoringScope.integration.test.ts` and `pnpm --filter @breeze/api test:integration-suite-coverage` pass; then `pnpm test-stack down`. No table or column changes, so the cascade and export-policy suites are not affected; CI's Integration Tests job runs them anyway.
- [ ] Typecheck green for `@breeze/api`, `@breeze/web`, `@breeze/shared` via turbo.
- [ ] `GUARDED_PROBES_MIN_AGENT_VERSION` equals a released agent version that contains W06a; this PR merges only after that release exists.
- [ ] Lab leg committed; both follow-up issues filed and linked.
- [ ] PR body states: `Closes #<W06b sub-issue>`; that sites which are not gated are unchanged through all three producers (name the Task 13 ungated test); the behavior change on gated sites (checks need agents at or above the version; no eligible agent reads "Not checked"); that probes take no site lock and why (Contract notes 1); the five not-checked codes and where each is stored; the two follow-up issue numbers; every Contract note below.

## Contract notes

1. **The site lock (E1) is not taken by the probe producers.** `loadPollDispatchInputs` locks the asset row (`jobs/snmpWorker.ts:417-424`) and the probe route locks it in `resolveAssetForMutation` before the site is known, while W03c's merge holds the exclusive site lock and then updates `discovered_assets.last_network_id` (W03c plan, merge step 5). Taking the shared site lock after the asset lock inverts E1's order and can deadlock with a merge; the probe route would also hold it through the 8 s wait. The workers send after their read context closes, so a lock would not cover the send either. The guarantee is result-time verification against current state on every result path (Task 3, rule 4 included). E5 and E10 both say their caller holds the shared site lock; `evaluateProbeGate` and `verifyProbeResult` call them without one. The W03a plan asserts only that `lockSitesForNetworkGate` runs in a transaction, not that E5 or E10 see a held lock; that must stay so.
2. **E6 must also require `agent_token_suspended_at IS NULL`**, as `selectNetworkExecutor` does (`services/networkExecutorSelection.ts:74`), so the gated and ungated pickers agree. The W03a plan's E6 query does not list it. If W03a does not add it, `evaluateProbeGate` filters its pick on it and asks again without `limit: 1`.
3. **E10 with `profileId: null`**: the W03a plan evaluates the gate with `profile: null`, so the allowed set is every fingerprint assigned to the site, and it compares the upload's `gatewayId`, `address` and `mac`. `verifyProbeResult` relies on exactly that.
4. **The expectation records no site.** The C5 payload carries no site id (except the probe's `probeSiteId`), so the verdict uses the target's current site, read at result time. A target that moved sites therefore fails verification, which is the intended outcome.
5. **E8's contract test** is `services/learnedNetworks/scanCommand.contract.test.ts` (from the W03a plan, not the index). Its classes are discovery-specific; Task 4 adds a parallel pair table instead of reusing its `toolName` class.
6. **`GATED_COMMAND_TYPES`**: `partnerTrust.test.ts` › "classifies every known command type exactly once" parses the Go handler registry, so W06a's registration of the five types turns that API test red unless the same PR adds them to `GATED_COMMAND_TYPES`. The W06a plan does not mention it. Recommendation: W06a adds them; Task 1 adds them if they are absent.
7. **Outside O7 beyond plan call 12:** monitors with neither site nor asset (including every partner-wide check) are not site work and stay ungated (Wave constraints). Not filed as a follow-up.
8. **`no_network_assigned`** is written for a gated site with no assigned network (index H names only `no_agent_on_network`). It is a distinct code so the reason line can tell the admin to assign a network.
9. **Conflict with the W06a plan: failures after the proof.** W06a returns a failed result from the probe after a successful `Confirm` "as is" (its `runGuardedProbe` step), with no `verifiedNetwork`; it stamps `verifiedNetwork` only on completed results. With this plan's verdict such a failure (for example an SNMP poll that fails as a whole) reads as not checked, so a device that always fails would never show as down. W06a's Contract note 2 asks the opposite: treat every failed guarded result as not checked. Recommendation: W06a stamps `verifiedNetwork` on every result produced after `Confirm` succeeded, failed included; then a refusal, an `invalid_argument` and any pre-proof failure stay not checked, and a real failure stays a failure (Task 9 › "a guarded failure with an accepted verifiedNetwork is a real failure" assumes this). Until one plan changes, the owner decides. Ping, TCP, HTTP and DNS checks are unaffected: W06a reports their `offline` outcome as a completed result with `verifiedNetwork`.
10. **A guarded command that is never answered** is read as on a site that is not gated (Wave constraints). The probe stamp and the SNMP counter carry no "guarded" marker, and adding one would need a migration, which this wave does not take.
11. **Read from plans, not code:** W03c's `assignNetwork` and `unassignNetwork` (E12, confirmed in the W03c plan) seed the gated state in Task 13; the W03a and W06a details cited here come from their plan files, not merged code.

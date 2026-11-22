# Learned Networks W03a: the gate, the command builder, the attempt record, result verification

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every discovery scan dispatch, from the worker and from the AI tool, is decided by one gate, built by one builder, recorded before it leaves, and every result is verified against that record and the current state before any host is stored or returned.

**Architecture:** New services under `apps/api/src/services/learnedNetworks/` (site lock, eligibility, gate, builder, attempt record, verifier) plus the shared types in `packages/shared`. `processDispatchScan` decides under a shared per-site advisory lock, re-decides and records the attempt in one transaction, then sends. Four result paths and the AI tool call one verifier. Nothing can gate a site yet (W03c), so production behavior on every site stays as it is, apart from the five changes listed under the wave constraints.

**Tech stack:** Hono/TypeScript API, Drizzle on PostgreSQL with forced RLS, BullMQ, Vitest (unit and real-Postgres integration), Zod.

**Spec:** `docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md` (sections 8.2, 8.3, 8.4, 14, 15).

**Index:** `docs/superpowers/plans/monitoring/2026-11-21-learned-networks.md`. Its Global constraints, Review focus and Cross-wave contract apply to every task here. Names from contract sections B2, C2 to C4, E1 and E5 to E11 are used verbatim.

## Wave constraints

- **Inert.** `GUARDED_DISCOVERY_MIN_AGENT_VERSION` is `999.0.0` and no route can set `sites.discovery_network_required` or assign a network until W03c. Tests gate a site by writing rows directly: first `UPDATE sites SET discovery_network_required = true`, then insert `learned_networks` with `site_id` (the A6 trigger refuses the other order).
- **Sites that are not gated keep today's selection, command and payload.** The five visible changes, each one intended:
  1. Row 1 of 8.2 applies to every site. A job whose profile moved to another site or org after it was queued fails `profile_moved`. The failure itself is already on main before this wave: `loadDispatchScanInputs` returns `profile-moved` with this plan's `profile_moved` message (`PROFILE_MOVED_MESSAGE`), comparing the profile with the queue payload. This wave replaces that inline check with the gate's row 1 (which reads the job row), so the visible change is only the stored `code`. The `job and profile placement agree` tests in `jobs/discoveryWorker.agentSelection.test.ts` stay green; the message is unchanged.
  2. The job is written `running` with its `agent_id` and `network_dispatch` before the command is sent.
  3. A job that is no longer `scheduled` when the attempt is recorded is not sent.
  4. A refusal result with `errorCode` `network_mismatch` or `network_changed` stores that code on `discovery_jobs.errors`.
  5. A job whose attempt was recorded but whose send never completed (the worker stopped in between) is failed by the 15-minute running expiry (`expireStaleRunningJobs`, `jobs/discoveryWorker.ts:410`). It is `running`, so the 2-minute sweep of `scheduled` jobs does not send it again.

  Existing tests that must stay green without edits to their assertions prove the rest: `jobs/discoveryWorker.agentSelection.test.ts`, `jobs/discoveryWorker.topologyDispatch.test.ts`, `jobs/discoveryWorker.test.ts` (the `processDispatchScan` block at `:1064-1110` and every `processResults` case), `jobs/discoveryQueue.test.ts`, `services/aiToolsNetwork.discovery.test.ts`, `services/commandResultHandlers.silentFailures.test.ts`, `routes/agentWs.test.ts` (discovery cases near `:3040-3175`), `routes/agents/topologyAdjacency.test.ts`, and the integration suites `discoveryWorker.dispatchAfterCommit.integration.test.ts`, `discoveryWorker.bmc.integration.test.ts`, `discoveryWorker.autoLinkMac.integration.test.ts` (the last three run `processResults`), `discoveryProfilePinnedDevice.integration.test.ts`, `topologyDiscoveryTransport.integration.test.ts`, `topologyDiscoveryPhysicalE2E.integration.test.ts`, `runScriptNoHeldTransaction.integration.test.ts` (it drives `network_discovery` end to end). Those files gain `vi.mock` entries for the new modules (gate returns `{ kind: 'unrestricted' }`, verify returns `{ ok: true, networkId: null }`, the lock is a no-op). One assertion changes on purpose: the event order in `jobs/discoveryWorker.dbcontext.test.ts` (Task 7).
- **W01a/W01b names this plan relies on** (W01a's schema is not in this tree yet; the Drizzle property names are the camelCase of the A4 columns): `learnedNetworks`, `learnedNetworkGateways`, `learnedNetworkDevices`, `discoveryProfileSnmpGrants`; `sites.discoveryNetworkRequired`; `devices.networkAttachmentsConfirmedAt`; `discoveryProfiles.networkId`, `.snmpGrantMode`; `discoveryJobs.networkId`, `.networkDispatch`, `.crossNetworkAssetUpdates`; `discoveredAssets.lastNetworkId`. Constants from `services/learnedNetworks/constants.ts` (E2): `NETWORK_ATTACHMENT_FRESHNESS_MS`, `CROSS_NETWORK_WINDOW_DAYS`.
- **Agent versions in fixtures.** Eligible agents use `agentVersion: '999.0.0'`. "Old" is `'0.128.0'`; "unknown" is `'dev'` (`devices.agent_version` is NOT NULL, so unknown is an unparseable string).
- **Refusal codes are compared as raw strings** (`result.errorCode === 'network_mismatch'`). Do not call `isAgentCommandErrorCode` and do not edit `AGENT_COMMAND_ERROR_CODES`: that list belongs to W02c and is pinned to the Go list.
- **Locks.** Order: site locks ascending, then the profile row. Never hold a lock or a DB context across Redis or WebSocket I/O (#1105). The AI tool cannot hold the lock across its 120 s wait; its attempt record is the `device_commands` row, which `dispatchPreparedCommand` inserts with `insertPreparedCommand` before it sends (`services/commandQueue.ts:1616`, insert `:1627`, send `:1682`).
- **Catches.** Lock and verify calls on the result paths run *before* the existing `try` blocks, uncaught, so a failed query fails the transaction instead of being caught next to a later write (`docs/agents/tenancy-rls.md`).
- **Copy.** Messages never say "verified location". All job error text lives in `messages.ts`.

## File structure

| File | Action | Responsibility |
|---|---|---|
| `packages/shared/src/types/discoveryNetworkGate.ts` (+ `.test.ts`) | create | B2 types, constants, MAC predicate, `verifiedNetworkSchema` |
| `packages/shared/src/types/index.ts` | modify | export it beside `./discovery` (`:901`) |
| `apps/api/src/services/commandMinVersion.ts` (+ test) | modify | E7 |
| `services/learnedNetworks/siteLock.ts` (+ test) | create | E1 |
| `services/learnedNetworks/eligibility.ts` | create | E6 |
| `services/learnedNetworks/siteNetworks.ts` | create | site flag, assigned networks, their fingerprints |
| `services/learnedNetworks/snmpGrants.ts` | create | E11 `loadUsableGrantGateways` only (W03b adds the rest) |
| `services/learnedNetworks/messages.ts` | create | every job error sentence |
| `services/learnedNetworks/gate.ts` (+ `gate.test.ts`) | create | E5, `gateProfileFromRow`, `loadGateProfile` |
| `services/learnedNetworks/scanCommand.ts` (+ test, + `.contract.test.ts`) | create | E8 |
| `services/learnedNetworks/attempt.ts` (+ test) | create | E9 |
| `services/learnedNetworks/verify.ts` (+ test) | create | E10 |
| `services/snmpSecrets.ts` | modify | `storedProfileHoldsSnmpSecrets` |
| `jobs/discoveryWorker.ts`, `jobs/discoveryAgentSelection.ts`, `jobs/queueSchemas.ts` | modify | dispatch order, `processResults` |
| `routes/agentWs.ts`, `services/commandResultHandlers.ts`, `routes/agents/topologyAdjacency.ts`, `services/topology/discoveryTransport.ts` | modify | result verification |
| `services/aiToolsNetwork.ts` | modify | the AI tool |
| `routes/agents/commands.ts`, `services/partnerTrust.ts`, `services/commandOfflinePolicy.ts` | modify | name the guarded type |
| `db/schema/discovery.ts:150` | modify | `errors: jsonb('errors').$type<DiscoveryJobError>()` (TypeScript only; no SQL change) |
| `__tests__/parkedFanoutModules.ts` | modify | `eligibility.ts` entry |
| `__tests__/integration/discoveryNetworkGate.integration.test.ts` | create | real-Postgres proofs |

---

### Task 1: Shared types

**Files:** Create `packages/shared/src/types/discoveryNetworkGate.ts`, `packages/shared/src/types/discoveryNetworkGate.test.ts`. Modify `packages/shared/src/types/index.ts:901`.

**Interfaces:** Produces exactly the B2 block of the index (`DISCOVERY_GATE_FAILURE_CODES`, `DiscoveryGateFailureCode`, `NoAgentReason`, `IneligibleReason`, `DiscoveryJobError`, `ExpectedGateway`, `ExpectedNetwork`, `VerifiedNetwork`, `EXPECTED_GATEWAYS_MAX`, `GUARDED_COMMAND_TYPES`, `isSharedVirtualRouterMac`, `verifiedNetworkSchema`), exported from `@breeze/shared`.

- [ ] **Step 1: Write the failing test.** The VRRP and HSRP MACs are the protocol prefixes from spec 8.5, not device MACs.

```ts
import { describe, expect, it } from 'vitest';
import { DISCOVERY_GATE_FAILURE_CODES, EXPECTED_GATEWAYS_MAX, GUARDED_COMMAND_TYPES,
  isSharedVirtualRouterMac, verifiedNetworkSchema } from '../index';

const N = '7f6d2c1e-3b4a-4c5d-8e9f-0a1b2c3d4e5f', G = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const valid = { networkId: N, gatewayId: G, gatewayAddress: '192.168.1.1', gatewayMac: 'a4:2b:b0:11:22:9c', interfaceName: 'Ethernet' };

describe('discoveryNetworkGate shared contract', () => {
  it('fixes the codes, the cap and the guarded type name', () => {
    expect(DISCOVERY_GATE_FAILURE_CODES).toEqual(['profile_moved', 'network_not_assigned', 'credentials_need_reentry',
      'no_network_assigned', 'no_agent_on_network', 'agent_not_eligible', 'network_mismatch', 'network_changed', 'network_unverified']);
    expect(EXPECTED_GATEWAYS_MAX).toBe(64);
    expect(GUARDED_COMMAND_TYPES).toEqual({ network_discovery: 'network_discovery_guarded' });
  });
  it('isSharedVirtualRouterMac matches the VRRP and HSRP prefixes in any case or separator', () => {
    expect(isSharedVirtualRouterMac('00:00:5e:00:01:0a')).toBe(true);
    expect(isSharedVirtualRouterMac('00-00-0C-07-AC-01')).toBe(true);
    expect(isSharedVirtualRouterMac('a4:2b:b0:11:22:9c')).toBe(false);
    expect(isSharedVirtualRouterMac('00:00:5e:00:02:0a')).toBe(false);
    expect(isSharedVirtualRouterMac('not-a-mac')).toBe(false);
  });
  it('verifiedNetworkSchema accepts the C3 shape and nothing looser', () => {
    expect(verifiedNetworkSchema.safeParse(valid).success).toBe(true);
    for (const bad of [{ ...valid, networkId: 'x' }, { ...valid, gatewayAddress: '::1' },
      { ...valid, gatewayAddress: '192.168.1.0/24' }, { ...valid, gatewayMac: 'A4:2B:B0:11:22:9C' },
      { ...valid, gatewayMac: 'a4-2b-b0-11-22-9c' }, { ...valid, interfaceName: '' },
      { ...valid, interfaceName: 'x'.repeat(129) }, { ...valid, gatewayId: undefined }, null, 'x'])
      expect(verifiedNetworkSchema.safeParse(bad).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and see it fail.** `cd packages/shared && npx vitest run src/types/discoveryNetworkGate.test.ts`. Expected: FAIL, the exports do not exist.
- [ ] **Step 3: Implement** the B2 block. `isSharedVirtualRouterMac` lower-cases, turns `-` into `:`, and tests the prefixes `00:00:5e:00:01:` and `00:00:0c:07:ac:` on a string that matches `/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/`. `verifiedNetworkSchema` is a `z.object` with `z.uuid()` ids, an IPv4 host string (`z.ipv4()`), `gatewayMac` matching that lower-case regex, `interfaceName` 1..128 chars. Add `export * from './discoveryNetworkGate';` after `export * from './discovery';`.
- [ ] **Step 4: Run it and see it pass** (same command). Expected: PASS, 3 tests.
- [ ] **Step 5: Commit** `feat(shared): discovery network gate types`.

### Task 2: Minimum agent version for the guarded scan (E7)

**Files:** Modify `apps/api/src/services/commandMinVersion.ts:28-38`, `apps/api/src/services/commandMinVersion.test.ts`.

**Interfaces:** Produces `GUARDED_DISCOVERY_MIN_AGENT_VERSION = '999.0.0'`; `COMMAND_MIN_AGENT_VERSION[GUARDED_COMMAND_TYPES.network_discovery]`; `agentSupportsGuardedCommand(commandType: keyof typeof GUARDED_COMMAND_TYPES, agentVersion: string | null | undefined): boolean`. Consumed by Task 4.

- [ ] **Step 1: Write the failing tests** (append to the existing `describe`):

```ts
it('gates the guarded discovery scan at the 999.0.0 placeholder (W03c sets the release)', () => {
  expect(GUARDED_DISCOVERY_MIN_AGENT_VERSION).toBe('999.0.0');
  expect(COMMAND_MIN_AGENT_VERSION.network_discovery_guarded).toBe(GUARDED_DISCOVERY_MIN_AGENT_VERSION);
  expect(COMMAND_MIN_AGENT_VERSION.network_discovery).toBeUndefined();
});
it('agentSupportsGuardedCommand treats unknown, unparseable and older versions as not supported', () => {
  for (const v of [null, undefined, '', '  ', 'dev', '1.2', '1.2.3.4', 'v999.0.0', '0.128.0', '998.99.99'])
    expect(agentSupportsGuardedCommand('network_discovery', v)).toBe(false);
  for (const v of ['999.0.0', ' 999.0.0 ', '999.0.0-rc.1', '1000.0.0'])
    expect(agentSupportsGuardedCommand('network_discovery', v)).toBe(true);
});
```

- [ ] **Step 2: Run and see it fail.** `cd apps/api && npx vitest run src/services/commandMinVersion.test.ts src/services/commandMinVersion.release.test.ts`. Expected: FAIL on the two new tests only.
- [ ] **Step 3: Implement.** The constant stays in this file (W03c changes one line). Add the entry with a computed key, `[GUARDED_COMMAND_TYPES.network_discovery]: GUARDED_DISCOVERY_MIN_AGENT_VERSION`, so the file holds no command-type literal (Task 6 scans for them). `agentSupportsGuardedCommand` looks up the minimum through `GUARDED_COMMAND_TYPES[commandType]`, returns false when there is none, and otherwise applies the same rule as `versionAtLeast` in `packages/shared/src/validators/endpointMessage.ts:44` (trim, `semverCompare` from `@breeze/shared`, `null` is false, a prerelease of the minimum counts). `versionAtLeast` itself is module-private; do not export it.
- [ ] **Step 4: Run and see it pass** (same command). Expected: PASS, both files.
- [ ] **Step 5: Commit** `feat(api): minimum agent version for guarded discovery scans`.

### Task 3: The per-site lock (E1) and the integration fixtures

**Files:** Create `services/learnedNetworks/siteLock.ts`, `siteLock.test.ts`, `__tests__/integration/discoveryNetworkGate.integration.test.ts`.

**Interfaces:** Produces `lockSitesForNetworkGate(siteIds: readonly string[], mode: 'shared' | 'exclusive'): Promise<void>` and the pure `planSiteLocks(siteIds: readonly string[]): string[]` (distinct, ascending by string compare). Fixture helpers in the integration file, used by Tasks 4, 5, 7, 9, 11 and 13:

```ts
seedSite(): Promise<{ partnerId: string; orgId: string; siteId: string }>
gateSite(orgId: string, siteId: string, networks: Array<Array<{ address: string; mac: string }>>):
  Promise<{ networkIds: string[]; gatewayIds: string[][] }>   // flag first, then networks with site_id, then gateways
seedAgent(o: { orgId: string; siteId: string; hostname: string; version?: string; status?: 'online' | 'offline';
  isEphemeral?: boolean; tokenSuspended?: boolean; behind?: string[]; isCurrent?: boolean; confirmedAgoMs?: number }):
  Promise<{ deviceId: string; agentId: string }>   // tokenSuspended: devices.agent_token_suspended_at = now()
seedProfile(o: { orgId: string; siteId: string; withSecrets?: boolean; grantMode?: 'unrestricted' | 'bound';
  grantGatewayIds?: string[]; pinnedDeviceId?: string; networkId?: string }): Promise<string>   // subnets ['192.168.1.0/24']
seedJob(orgId: string, siteId: string, profileId: string): Promise<string>                      // status 'scheduled'
```

Fingerprints used throughout: **G1** `192.168.1.1` / `a4:2b:b0:11:22:9c`, **G2** `192.168.1.1` / `3c:37:86:aa:bb:10`, **G3** `10.1.2.100` / `00:1a:8c:00:00:01`. Hosts `LAPTOP-JS`, `DESKTOP-01`. `seedAgent` defaults: version `'999.0.0'`, `online`, current rows confirmed now.

- [ ] **Step 1: Write the failing tests.** Unit (`siteLock.test.ts`):

```ts
it('plans one lock per distinct site, ascending', () => {
  expect(planSiteLocks(['c3', 'a1', 'c3', 'b2'])).toEqual(['a1', 'b2', 'c3']);
  expect(planSiteLocks([])).toEqual([]);
});
```

Integration, `describe('site lock')`, each inside `withSystemDbAccessContext`:

```ts
it('an exclusive holder blocks a shared taker', async () => {
  const { siteId } = await seedSite(); const held = deferred(); const release = deferred();
  const holder = withSystemDbAccessContext(async () => {
    await lockSitesForNetworkGate([siteId], 'exclusive'); held.resolve(); await release.promise; });
  await held.promise;
  const err = await withSystemDbAccessContext(async () => {
    await db.execute(sql`set local lock_timeout = '200ms'`);
    await lockSitesForNetworkGate([siteId], 'shared'); }).catch((e) => e);
  expect(pgErrorCode(err)).toBe('55P03');
  release.resolve(); await holder;
});
it('two shared takers do not block each other', async () => { /* same shape, both 'shared'; the second resolves */ });
it('refuses to run outside a transaction', async () => {
  await expect(lockSitesForNetworkGate([randomUUID()], 'shared')).rejects.toThrow(/lockSitesForNetworkGate must run inside/);
});
```

- [ ] **Step 2: Run and see it fail.** `cd apps/api && npx vitest run src/services/learnedNetworks/siteLock.test.ts`; then `pnpm test-stack up` and `pnpm --filter @breeze/api test:integration src/__tests__/integration/discoveryNetworkGate.integration.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement.** `assertInTransaction('lockSitesForNetworkGate')` first. Then, for each id from `planSiteLocks`, one statement, in order: `select pg_advisory_xact_lock_shared(hashtext('learned-network-site'), hashtext(${siteId}))` for `shared`, `pg_advisory_xact_lock(...)` for `exclusive` (two-key form, as `services/discoveryJobCreation.ts:22`). One statement per site because a set-returning form does not fix evaluation order. A `hashtext` collision only makes two sites share a lock.
- [ ] **Step 4: Run and see it pass** (both commands). Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): per-site advisory lock for the discovery network gate`.

### Task 4: Eligibility (E6)

**Files:** Create `services/learnedNetworks/eligibility.ts`. Modify `jobs/discoveryAgentSelection.ts:77-124` (extract the address read), `__tests__/parkedFanoutModules.ts:57`, the integration file.

**Interfaces:** Consumes Task 2 (`agentSupportsGuardedCommand`, `COMMAND_MIN_AGENT_VERSION`), E2 `NETWORK_ATTACHMENT_FRESHNESS_MS`. Produces the three E6 functions verbatim, and in `discoveryAgentSelection.ts`, `loadDeviceAddresses(deviceIds: readonly string[]): Promise<Map<string, string[]>>` (the existing second query of `loadSiteDiscoveryAgentCandidates`, moved without change; that function now calls it).

- [ ] **Step 1: Write the failing tests** (integration, `describe('eligibility')`). One site gated with network N1 = {G1, G3}; G2 on an unassigned network. Table-driven:

```ts
const cases: Array<[string, (ctx: Ctx) => Promise<{ deviceId?: string; agentId?: string }>, IneligibleReason]> = [
  ['unknown device', async () => ({ deviceId: randomUUID() }), 'not_found'],
  ['device of another org', async (c) => ({ deviceId: (await seedAgent({ ...c.otherOrg, hostname: 'DESKTOP-01' })).deviceId }), 'not_found'],
  ['device in a holding org', async (c) => ({ deviceId: (await seedAgent({ ...c.holdingOrg, hostname: 'DESKTOP-01' })).deviceId }), 'parked'],
  ['Quick Support device', async (c) => ({ deviceId: (await seedAgent({ ...c.site, hostname: 'DESKTOP-01', isEphemeral: true, behind: [c.g1] })).deviceId }), 'ephemeral'],
  ['device of another site', async (c) => ({ deviceId: (await seedAgent({ ...c.otherSite, hostname: 'DESKTOP-01', behind: [c.g1] })).deviceId }), 'other_site'],
  ['offline device', async (c) => ({ deviceId: (await seedAgent({ ...c.site, hostname: 'DESKTOP-01', status: 'offline', behind: [c.g1] })).deviceId }), 'offline'],
  ['online, suspended agent token', async (c) => ({ deviceId: (await seedAgent({ ...c.site, hostname: 'DESKTOP-01', tokenSuspended: true, behind: [c.g1] })).deviceId }), 'offline'],
  ['old agent behind G1', async (c) => ({ agentId: (await seedAgent({ ...c.site, hostname: 'DESKTOP-01', version: '0.128.0', behind: [c.g1] })).agentId }), 'needs_update'],
  ['unknown version behind G1', async (c) => ({ deviceId: (await seedAgent({ ...c.site, hostname: 'DESKTOP-01', version: 'dev', behind: [c.g1] })).deviceId }), 'needs_update'],
  ['behind G2 only', async (c) => ({ deviceId: (await seedAgent({ ...c.site, hostname: 'LAPTOP-JS', behind: [c.g2] })).deviceId }), 'not_on_network'],
  ['G1 row not current', async (c) => ({ deviceId: (await seedAgent({ ...c.site, hostname: 'LAPTOP-JS', behind: [c.g1], isCurrent: false })).deviceId }), 'not_on_network'],
  ['G1 confirmed 11 minutes ago', async (c) => ({ deviceId: (await seedAgent({ ...c.site, hostname: 'LAPTOP-JS', behind: [c.g1], confirmedAgoMs: 11 * 60_000 })).deviceId }), 'not_on_network'],
];
it.each(cases)('explainGuardedAgent: %s is %s', async (_n, make, reason) => {
  const c = await ctx(); const target = await make(c);
  const out = await sys(() => explainGuardedAgent({ orgId: c.orgId, siteId: c.siteId, allowedGatewayIds: [c.g1], commandType: 'network_discovery', ...target }));
  expect(out).toMatchObject({ eligible: false, reason });
});
it('explainGuardedAgent: a fresh 999.0.0 agent behind G1 is eligible with its fingerprints', ...);   // { eligible: true, agent: { gatewayIds: [g1] } }
it('loadEligibleGuardedAgents returns only eligible agents, by device id, within the limit', ...);  // all cases above seeded in one site: exactly the eligible ones; limit 1 cuts to the lowest id
it('explainNoEligibleAgent distinguishes none online, none on the network and agents that need updating', ...);
  // no online agent -> 'none_online'; only a suspended-token agent behind G1 -> 'none_online';
  // online 999.0.0 agents behind G2 only -> 'none_on_network';
  // an online '0.128.0' agent behind G1 -> 'agents_need_update'; only 'dev' agents, none behind G1 -> 'agents_need_update'
it('S6 eligibility matches the fingerprint', async () => {
  // N1 = {G1, G3}; LAPTOP-JS behind G1, DESKTOP-01 behind G3 (lower device id, so it would rank first)
  const eligible = await sys(() => loadEligibleGuardedAgents({ orgId, siteId, allowedGatewayIds: [g1], commandType: 'network_discovery' }));
  expect(eligible.map((a) => a.hostname)).toEqual(['LAPTOP-JS']);
  expect(await sys(() => explainGuardedAgent({ orgId, siteId, allowedGatewayIds: [g1], commandType: 'network_discovery', deviceId: desktop })))
    .toMatchObject({ eligible: false, reason: 'not_on_network' });
});
```

- [ ] **Step 2: Run and see it fail** (the integration command from Task 3). Expected: FAIL, module missing.
- [ ] **Step 3: Implement.**
  - `loadEligibleGuardedAgents`: one query, `devices` inner join `learned_network_devices` on `(device_id, org_id)` with `is_current` and `gateway_id = any(allowedGatewayIds)`; where org, `site_id`, `status = 'online'`, `eq(devices.isEphemeral, false)`, `notParkedDeviceCondition()`, `isNull(devices.agentTokenSuspendedAt)` (as `selectNetworkExecutor` does, `services/networkExecutorSelection.ts:74`), `agent_id is not null`, `network_attachments_confirmed_at >= now() - make_interval(secs => NETWORK_ATTACHMENT_FRESHNESS_MS / 1000)`, and the version prefilter below; `group by devices.id`; `array_agg(distinct gateway_id order by gateway_id)` as `gatewayIds`; order by `devices.id`; `limit (limit ?? MAX_DISCOVERY_AGENT_CANDIDATES)`. Then keep rows where `agentSupportsGuardedCommand(commandType, row.agentVersion)`. Empty `allowedGatewayIds` returns `[]` with no query.
  - The prefilter reads the same minimum as the exact check (parse `COMMAND_MIN_AGENT_VERSION[GUARDED_COMMAND_TYPES[commandType]]` into `[maj, min, patch]`). It is a superset of the exact check:

    ```sql
    case when devices.agent_version ~ '^\s*\d{1,9}\.\d{1,9}\.\d{1,9}'
         then string_to_array(substring(btrim(devices.agent_version) from '^(\d+\.\d+\.\d+)'), '.')::int[] >= array[${maj}, ${min}, ${patch}]
         else false end
    ```

  - `explainGuardedAgent`: read one device by `deviceId` or `agentId` with no org filter, selecting `parked: sql<boolean>\`not (${notParkedDeviceCondition()})\``, then the reason in this order: no row → `not_found`; `parked` → `parked`; other org or no `agent_id` → `not_found`; `is_ephemeral` → `ephemeral`; other site → `other_site`; not online, or `agent_token_suspended_at` set → `offline` (B2 has no separate reason for a suspended token, and such an agent cannot take a command, so it reads as offline); `!agentSupportsGuardedCommand` → `needs_update`; then one read of its fresh current memberships among the allowed ids, none → `not_on_network`. `label` is display name, else hostname, else the device id, except for `not_found` and `parked`, where it is the id the caller passed (another org's names are never echoed). Needs-update is decided before not-on-network because an agent below the guard version may not report attachments at all.
  - `explainNoEligibleAgent`: one query over the site's online, non-ephemeral, non-parked agents whose token is not suspended, with, per device, whether it has a fresh current row for an allowed fingerprint. No rows → `none_online`. Any row on the network (it failed only the version) → `agents_need_update`. Every row below the guard version → `agents_need_update`. Otherwise `none_on_network`.
  - `parkedFanoutModules.ts`: add `'services/learnedNetworks/eligibility.ts': { guards: 3, reason: 'guarded discovery agent eligibility, the per-agent explanation and the no-agent reason' }` (one `notParkedDeviceCondition(` per function). `discoveryAgentSelection.ts` and `discoveryWorker.ts` keep 2 and 1.
- [ ] **Step 4: Run and see it pass**: the integration file, then `cd apps/api && npx vitest run src/__tests__/parkedFanout.contract.test.ts src/jobs/discoveryAgentSelection.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): guarded discovery agent eligibility`.

### Task 5: The gate (E5)

**Files:** Create `services/learnedNetworks/siteNetworks.ts`, `snmpGrants.ts`, `messages.ts`, `gate.ts`, `gate.test.ts`. Modify `services/snmpSecrets.ts` (+ its test file).

**Interfaces:** Produces E5 `GateProfile`, `GateDecision`, `evaluateDiscoveryGate` verbatim; E11 `loadUsableGrantGateways` verbatim; and:

```ts
// siteNetworks.ts
export async function loadSiteGateState(orgId: string, siteId: string): Promise<{ gated: boolean; assignedNetworkIds: string[] }>;
  // a missing site reads as { gated: true, assignedNetworkIds: [] } (fails closed)
export async function loadNetworkSiteId(orgId: string, networkId: string): Promise<string | null>; // null: missing or unassigned
export async function loadNetworkGateways(orgId: string, networkIds: readonly string[]): Promise<ExpectedGateway[]>;
  // host(gateway_address), lower-case gateway_mac::text, ordered by network id then gateway id
// gate.ts
export function gateProfileFromRow(row: typeof discoveryProfiles.$inferSelect): GateProfile;
export async function loadGateProfile(profileId: string): Promise<GateProfile | null>;
// snmpSecrets.ts
export function storedProfileHoldsSnmpSecrets(row: { snmpCommunities: string[] | null; snmpCredentials: unknown }): boolean;
// messages.ts
export const GATE_FAILURE_MESSAGES: Record<Exclude<DiscoveryGateFailureCode, 'no_agent_on_network' | 'agent_not_eligible'>, string>;
export const NO_AGENT_MESSAGES: Record<NoAgentReason, string>;
export function agentNotEligibleMessage(label: string, reason: IneligibleReason): string;
```

Exact copy for `messages.ts`. The agent reports every guard failure that is not a mismatch as `network_changed` (a move during the scan, and also a network it could not read or prove at the start), so its sentence must be true in both cases:

| Key | Message |
|---|---|
| `profile_moved` | The profile moved to another site or organization after this scan was queued. The scan was not sent. |
| `network_not_assigned` | The network this profile is limited to is not assigned to its site. The scan was not sent. |
| `credentials_need_reentry` | The profile's saved SNMP credentials are not granted on any network assigned to this site. Re-enter them on the profile. The scan was not sent. |
| `no_network_assigned` | This site requires an assigned network and has none. The scan was not sent. |
| `network_mismatch` | The scan agent is not behind a gateway assigned to this site. Nothing was scanned. |
| `network_changed` | The scan agent could not confirm that it stayed behind a gateway assigned to this site: its network changed or could not be checked. Nothing from this scan was kept. |
| `network_unverified` | The scan result could not be matched to a network assigned to this site now. Its results were discarded. |
| `none_online` | No agent at this site is online. The scan was not sent. |
| `none_on_network` | Agents at this site are online, but none is on an assigned network right now. The scan was not sent. |
| `agents_need_update` | Agents at this site need an update before they can scan an assigned network. The scan was not sent. |
| `agentNotEligibleMessage` | `Scan agent "${label}" cannot run this scan: ${text}. The scan was not run from any other agent.` with `text` per reason: not found, parked in the partner's holding organization, a Quick Support device, assigned to another site, offline, not on an assigned network right now, needs an agent update |

- [ ] **Step 1: Write the failing tests.** `gate.test.ts` mocks `./siteNetworks` and `./snmpGrants`. Fixture: `base: GateProfile = { id: P, orgId: O, siteId: S, networkId: null, snmpGrantMode: 'unrestricted', hasSavedSnmpSecrets: false }`; `gw(id, net)` builds an `ExpectedGateway` with G1's address and MAC.

```ts
it('row 1: a job whose org or site differs from the live profile fails profile_moved', async () => {
  for (const job of [{ orgId: O2, siteId: S }, { orgId: O, siteId: S2 }])
    expect(await evaluateDiscoveryGate({ orgId: O, siteId: S, profile: base, job })).toMatchObject({ kind: 'fail', error: { code: 'profile_moved' } });
  expect(siteNetworks.loadSiteGateState).not.toHaveBeenCalled();
});
it('row 2: a profile network that is unassigned or on another site fails network_not_assigned, gated or not', ...);
  // loadNetworkSiteId -> null and -> S2, with gated true and false: code 'network_not_assigned'
it('row 3: a bound profile with saved secrets is guarded to its usable grants, gated or not', ...);
  // loadUsableGrantGateways called with { orgId: O, profileId: P, siteId: S, networkId: null }; decision.allowed === its result
it('row 3: a bound profile with no usable grant fails credentials_need_reentry', ...);
it('T5 row 3a fails closed', async () => {
  gated(true, [N1]);
  expect(await evaluateDiscoveryGate({ orgId: O, siteId: S, profile: { ...base, hasSavedSnmpSecrets: true } }))
    .toMatchObject({ kind: 'fail', error: { code: 'credentials_need_reentry' } });
  expect(snmpGrants.loadUsableGrantGateways).not.toHaveBeenCalled();
  expect(siteNetworks.loadNetworkGateways).not.toHaveBeenCalled();
});
it('row 4: a site that is not gated is unrestricted', ...);
  // profile without secrets, bound profile without secrets, and profile null: { kind: 'unrestricted' }
it('row 5: a gated site with no assigned network fails no_network_assigned', ...);
it('row 6: allowed fingerprints are those of profile.networkId, else of every assigned network', ...);
  // assigned [N1, N2]; networkId null -> loadNetworkGateways(O, [N1, N2]); networkId N2 -> loadNetworkGateways(O, [N2])
it('S9 evaluation order decides the code', async () => {
  gated(true, []); vi.mocked(siteNetworks.loadNetworkSiteId).mockResolvedValue(null);
  expect(await evaluateDiscoveryGate({ orgId: O, siteId: S, profile: { ...base, networkId: N1 } }))
    .toMatchObject({ kind: 'fail', error: { code: 'network_not_assigned' } });
  expect(await evaluateDiscoveryGate({ orgId: O, siteId: S, profile: base }))
    .toMatchObject({ kind: 'fail', error: { code: 'no_network_assigned' } });
});
it('the AI tool (profile null) starts at row 4', ...);  // gated with N1: guarded to N1's fingerprints; loadNetworkSiteId and grants never called
```

`snmpSecrets.test.ts` gains: `storedProfileHoldsSnmpSecrets` is false for `[]`/`null` and `{ version: 'v3' }`, true for one non-empty community and for `{ authPassword: '<ciphertext>' }`.

Integration, `describe('gate reads')`: `loadNetworkGateways` returns `address: '192.168.1.1'` (no `/32`) and the lower-case MAC; `loadUsableGrantGateways` returns only the profile's grants whose network is assigned to the site, and with `networkId` only that network's.

- [ ] **Step 2: Run and see it fail.** `cd apps/api && npx vitest run src/services/learnedNetworks/gate.test.ts src/services/snmpSecrets.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `evaluateDiscoveryGate` reads lazily in row order, so no row reads what an earlier row made unnecessary. Every `fail` carries `{ code, message: GATE_FAILURE_MESSAGES[code] }`. Row 3 applies when `profile.hasSavedSnmpSecrets && snmpGrantMode === 'bound'`; row 3a when it holds secrets in `unrestricted` mode on a gated site. Row 6 with a network that has no fingerprints returns `guarded` with `allowed: []`; the caller's eligibility then finds no agent. `gateProfileFromRow` sets `hasSavedSnmpSecrets` from `storedProfileHoldsSnmpSecrets`, which uses the same leaves as `hasStoredCommunities` and `hasStoredCredentials` in `subnetChangeWouldRetainSnmpSecrets` (`services/snmpSecrets.ts:219`, `:223`). `loadUsableGrantGateways` joins grants → gateways → networks on `(id, org_id)` with `networks.site_id = siteId` and, when set, `networks.id = networkId`.
- [ ] **Step 4: Run and see it pass**: the unit command and the integration file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): the discovery network gate`.

### Task 6: The shared command builder (E8) and its contract

**Files:** Create `services/learnedNetworks/scanCommand.ts`, `scanCommand.test.ts`, `scanCommand.contract.test.ts`. Modify `services/commandResultHandlers.ts:1323`, `routes/agents/commands.ts:105`, `services/partnerTrust.ts:140`, `services/commandOfflinePolicy.ts:180` (`LIVE`) and `:289` (`EXTRA_ROUTE_TYPES`), `services/commandOfflinePolicy.test.ts:47` and `:69`, `services/commandMinVersion.release.test.ts`.

**Interfaces:** Produces E8 `buildDiscoveryScanCommand` verbatim, and `DISCOVERY_SCAN_FAMILY = 'network_discovery' as const satisfies keyof typeof GUARDED_COMMAND_TYPES` (callers pass it as `commandType`, so they hold no literal).

Every non-test hit for the two literals in `apps/api/src` today, and its class in the contract:

| File:line | Class |
|---|---|
| `jobs/discoveryWorker.ts:859` (`type: 'network_discovery'`) | **builder**: moves to `scanCommand.ts` (Task 7) |
| `services/aiToolsNetwork.ts:978`, 4th argument of `aiExecuteCommand` | **builder**: the AI tool passes `command.type` (Task 13) |
| `services/commandResultHandlers.ts:1323` (registry) | **must name the guarded type** |
| `routes/agents/commands.ts:105` (`REGISTRY_DISPATCHED_COMMAND_TYPES`) | **must name the guarded type** |
| `services/partnerTrust.ts:140` (`GATED_COMMAND_TYPES`; unlisted types fail closed, and `partnerTrust.test.ts:631` requires one class per Go type once W02c lands) | **must name the guarded type** |
| `services/commandOfflinePolicy.ts:180` (`LIVE`) and `:289` (`EXTRA_ROUTE_TYPES`); `defaultOfflinePolicy` throws `UnregisteredCommandTypeError` for an unlisted type, so the AI send would fail | **must name the guarded type** (both lists) |
| `services/aiToolsNetwork.ts:949` (tool definition name, and `aiExecuteCommand`'s tool-name argument) | allowlisted: names the AI tool |
| `services/aiAgentSdkTools.ts:392`, `:3310`; `services/aiToolStandingVerbs.ts:118`; `services/aiToolRateLimits.ts:59`; `services/aiGuardrails.ts:1218`, `:2088`, `:4805`; `services/helperToolFilter.ts:58`, `:138`; `services/toolTimeouts.ts:33`; `services/actionIntents/intentRowTarget.ts:248`; `services/mcpCoverage.ts:548`; `services/aiToolSchemas.ts:1915`; `services/aiToolOutput.ts:1305`; `services/aiAgents/agentToolCatalog.ts:403`; `services/wisp/toolSubjects.ts:347`; `services/llm/toolEval/goldenPrompts.ts:44-45` | allowlisted: names the AI tool `network_discovery` (tier, guardrail, permission, rate limit, timeout, MCP coverage, schema, output fence, catalog, Wisp subjects, eval prompts), not the command type |
| `services/topology/discoveryDispatch.ts:45`, `services/aiToolRateLimits.ts:5` | comments; the scan strips comments |

`services/aiDispatch.ts` and `services/aiRemoteToolsPolicy.ts` (`REMOTE_TOOLS_COMMAND_TYPES`) do not name either type. The AI dispatch policy that does is `aiGuardrails.ts` (tool name, allowlisted).

- [ ] **Step 1: Write the failing tests.** `scanCommand.test.ts`:

```ts
const payload = { jobId: J, subnets: ['192.168.1.0/24'], snmpCommunities: [] };
const gw = (i: number): ExpectedGateway => ({ networkId: 'n-1', gatewayId: `g-${String(i).padStart(2, '0')}`, address: '192.168.1.1', mac: 'a4:2b:b0:11:22:9c' });
it('unrestricted: the unchanged network_discovery command', () => {
  expect(buildDiscoveryScanCommand({ commandId: J, payload, decision: { kind: 'unrestricted' } }))
    .toEqual({ id: J, type: 'network_discovery', payload });
});
it('guarded: the guarded type, the same payload plus expectedNetwork, input untouched', () => {
  const before = structuredClone(payload);
  const cmd = buildDiscoveryScanCommand({ commandId: J, payload, decision: { kind: 'guarded', allowed: [gw(1)] } });
  expect(cmd).toEqual({ id: J, type: 'network_discovery_guarded', payload: { ...payload, expectedNetwork: { gateways: [gw(1)] } } });
  expect(payload).toEqual(before);
});
it('cuts to 64, the agent\'s current fingerprints first, each group by gateway id', () => {
  const allowed = Array.from({ length: 70 }, (_, i) => gw(69 - i));
  const cmd = buildDiscoveryScanCommand({ commandId: J, payload, decision: { kind: 'guarded', allowed: [...allowed, gw(3)] }, agentGatewayIds: ['g-68', 'g-05'] });
  const ids = (cmd.payload.expectedNetwork as ExpectedNetwork).gateways.map((g) => g.gatewayId);
  expect(ids).toHaveLength(64);
  expect(ids.slice(0, 4)).toEqual(['g-05', 'g-68', 'g-00', 'g-01']);
  expect(new Set(ids).size).toBe(64);
});
it('refuses a guarded decision with no allowed fingerprint', () => {
  expect(() => buildDiscoveryScanCommand({ commandId: J, payload, decision: { kind: 'guarded', allowed: [] } })).toThrow();
});
```

`scanCommand.contract.test.ts` reads every non-test `.ts` under `apps/api/src`, strips comments, and asserts:

```ts
const LITERAL = /(['"`])network_discovery(_guarded)?\1|\bnetwork_discovery(_guarded)?\s*:/g;
const CONSTRUCT = /\btype\s*:\s*(['"`]network_discovery(_guarded)?['"`]|GUARDED_COMMAND_TYPES\.network_discovery)/;
const AI_HELPER_TYPE = /\b(aiExecuteCommand|aiExecuteCommandWithSystemPrecheck|aiQueueCommand|aiQueueCommandForExecution)\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*['"`]network_discovery/;
const HELPER_TYPE = /\b(executeCommand|executeCommandWithSystemPrecheck|executeCommandWithCallerPrecheck|queueCommand|queueCommandForExecution)\(\s*[^,]+,\s*['"`]network_discovery/;
const CLASSES: Record<string, { kind: 'builder' } | { kind: 'paired' } | { kind: 'toolName'; reason: string }> = { /* the table above */ };
it('every file naming either type is classified, and no classification is stale', ...);
it('only the builder constructs a discovery scan command', ...);       // CONSTRUCT, AI_HELPER_TYPE, HELPER_TYPE match nowhere else
it('every paired list names the guarded type as often as the base type', ...);
  // per paired file: count of base literals === count of 'network_discovery_guarded' literals + GUARDED_COMMAND_TYPES.network_discovery refs
it('finds the known sites (not vacuous)', ...);  // >= 4 paired, >= 14 toolName; CONSTRUCT matches a fixture string
```

`commandOfflinePolicy.test.ts`: add `'network_discovery_guarded'` to the `extras` list (`:47`) and `expect(defaultOfflinePolicy('network_discovery_guarded')).toEqual({ kind: 'reject' })` beside `:69`. `commandMinVersion.release.test.ts` gains, in its own `it`: the min version is set, `defaultOfflinePolicy(...).kind` is `'reject'`, `EXPLICITLY_CLASSIFIED_COMMAND_TYPES` has it, and `GATED_COMMAND_TYPES` contains it.

- [ ] **Step 2: Run and see it fail.** `cd apps/api && npx vitest run src/services/learnedNetworks/scanCommand src/services/commandOfflinePolicy.test.ts src/services/commandMinVersion.release.test.ts src/services/partnerTrust.test.ts`. Expected: FAIL. (If W02c is already on `main`, `GATED_COMMAND_TYPES` already holds the guarded type, so that one assertion and `partnerTrust.test.ts` are green before this step; every other new assertion is red.) The construction rule also matches `discoveryWorker.ts:859` and `aiToolsNetwork.ts:978`. Commit them in a `PENDING` set the construction check skips (`discoveryWorker.ts` counts as classified while it is pending; `aiToolsNetwork.ts` is classified `toolName`). Step 1 of Task 7 deletes `discoveryWorker.ts` from `PENDING` and Step 1 of Task 13 deletes `aiToolsNetwork.ts`, so each check is red until that task's code lands.
- [ ] **Step 3: Implement.** The guarded order: dedupe by `gatewayId`; fingerprints in `agentGatewayIds` first, then the rest; each group ascending by `gatewayId`; cut to `EXPECTED_GATEWAYS_MAX`. Register `[GUARDED_COMMAND_TYPES.network_discovery]: handleDiscoveryResult`; add the literal `'network_discovery_guarded'` next to each list entry above (classified `GATED`, offline class `live`). In `GATED_COMMAND_TYPES`, add it only if it is not already present: W02c registers the Go handler and adds the entry in its own PR (`partnerTrust.test.ts` parses the Go handler registry), and either PR may land first.
- [ ] **Step 4: Run and see it pass** (same command, plus `src/services/endpointMessaging/registrations.contract.test.ts src/services/commandResultHandlers.security.test.ts`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): one builder for discovery scan commands`.

### Task 7: The attempt record and the dispatch order (E9)

**Files:** Create `services/learnedNetworks/attempt.ts`, `attempt.test.ts`, `jobs/discoveryWorker.networkGate.test.ts`. Modify `jobs/discoveryWorker.ts:272-309`, `:693-913`, `:1931-1947`; `jobs/discoveryAgentSelection.ts:126-194`; `db/schema/discovery.ts:150`; the mocks of `jobs/discoveryWorker.{dbcontext,agentSelection,topologyDispatch}.test.ts` and `jobs/discoveryWorker.test.ts`.

**Interfaces:** Produces E9 `NetworkDispatchRecord` and `recordDispatchAttempt` verbatim, plus, in `attempt.ts` (so every new read sits behind a module the old tests can mock):

```ts
export function parseNetworkDispatchRecord(value: unknown): NetworkDispatchRecord | null | 'invalid'; // null for SQL null
// The live profile row, read FOR SHARE. assertInTransaction; the caller already holds the site lock.
export async function loadProfileForDispatch(profileId: string): Promise<typeof discoveryProfiles.$inferSelect | null>;
// The AI tool's attempt: the persisted command row's type and server-written payload (Task 13).
export async function loadCommandAttempt(commandId: string, deviceId: string):
  Promise<{ mode: 'unrestricted' | 'guarded'; allowedGatewayIds: string[] } | null>;
```

Also: `markJobFailed(jobId: string, error: string | DiscoveryJobError, agentId?: string | null)`; a string becomes `{ message }`. `DispatchAgentCandidate` gains `deviceId`; `PinnedDiscoveryAgentResolution`'s ok branch gains `deviceId`; `validateRequestedAgentForDiscovery` returns `{ ok: true; deviceId }`.

**The record.** `allowedGatewayIds` are the gateway ids in the command's `expectedNetwork` (at most 64, what the agent can prove), `allowedNetworkIds` their distinct networks; both `[]` for `unrestricted`. This keeps the row inside A3's 16 KiB check.

**`processDispatchScan`, new order:**

1. **Phase 1, one system context** (`loadDispatchScanInputs`). The job read (`:692`) also selects `orgId`, `siteId`; these, not the queue payload, are the job's. Profile read as today. Then `lockSitesForNetworkGate([job.siteId, profile.siteId], 'shared')` and `decision1 = evaluateDiscoveryGate({ orgId: job.orgId, siteId: job.siteId, profile: gateProfileFromRow(profile), job })`.
   - `fail`: `markJobFailed(jobId, decision1.error)`, return `{ status: 'gate-failed' }`.
   - `unrestricted`: today's three branches (`:715-746`), unchanged.
   - `guarded`: requested → `explainGuardedAgent({ agentId })`; pinned → `explainGuardedAgent({ deviceId: profile.pinnedDeviceId })`. Not eligible: `markJobFailed(jobId, { code: 'agent_not_eligible', reason, message: agentNotEligibleMessage(label, reason) }, agentIdIfKnown)`, return `invalid-agent`. No fallback to another agent. Site path: `loadEligibleGuardedAgents({ ..., commandType: DISCOVERY_SCAN_FAMILY })`, addresses from `loadDeviceAddresses`, ordered by `rankDiscoveryAgentCandidates(…, profile.subnets)`. Empty: `explainNoEligibleAgent`, then `markJobFailed(jobId, { code: 'no_agent_on_network', reason, message: NO_AGENT_MESSAGES[reason] })`, return `no-agent`. Each candidate keeps its `gatewayIds`.
   - Topology snapshot for `candidates[0]` as today (`:758`). Return `decision1` with the inputs.
2. **Phase 2, no context:** the connectivity walk and the topology re-bind (`:784-830`), unchanged.
3. **Phase 3, one system context (new):** `lockSitesForNetworkGate(same ids, 'shared')`; `loadProfileForDispatch(profileId)` (after the site lock, as the lock order requires; a profile save holds `FOR UPDATE`, so secrets and grants are read from one committed state; a vanished profile fails the job `Profile not found` as `:709` does); `decision2 = evaluateDiscoveryGate(...)` from that row. The command is built from `decision2` and that row, never from `decision1` or the phase-1 row:
   - `decision2` fails → `markJobFailed(jobId, decision2.error)`; nothing is sent.
   - `decision2` unrestricted → the chosen agent is sent the unrestricted command (it is a site agent that is online, not Quick Support and not parked).
   - `decision2` guarded → `explainGuardedAgent({ agentId: chosen.agentId, allowedGatewayIds: decision2.allowed ids })`. Not eligible → `agent_not_eligible` with its reason and label, nothing sent. Eligible → its `gatewayIds` are the ordering hint.
   - Build today's payload object (`:840-855`, decrypting here) and call `buildDiscoveryScanCommand({ commandId: jobId, payload, decision: decision2, agentGatewayIds })`.
   - `recordDispatchAttempt(jobId, record)` with `decidedAt` now, `mode` from `decision2`. `false` (no longer `scheduled`) → return `{ dispatched: false }`, no write.
4. **Phase 4, no context:** `dispatchCommandToAgent(agentId, command)` (`:859`). Not `sent`: today's `markJobFailed` messages (`:861-871`); the status is `running`, which `markJobFailed` accepts. The old phase-4 status flip (`:875-889`) is deleted; `recordDispatchAttempt` did it.

**`discovery_jobs.errors` writers:** the column becomes `jsonb('errors').$type<DiscoveryJobError>()`, so every writer is type-checked. Changed: `discoveryWorker.ts:1941` (`markJobFailed`, gate and eligibility codes), `agentWs.ts:1920` (refusal codes, Task 9), new `network_unverified` writes in Tasks 9 to 11. Unchanged literals that already satisfy the type: `discoveryWorker.ts:430`, `:2148`; `agentWs.ts:1956`, `:1970`; `commandResultHandlers.ts:179`, `:200`; `routes/discovery.ts:1076`.

- [ ] **Step 1: Write the failing tests.** `attempt.test.ts`: `parseNetworkDispatchRecord(null)` is `null`; a valid record round-trips; `{ version: 2 }`, a missing `mode`, non-array ids are `'invalid'`. `discoveryWorker.networkGate.test.ts` copies the depth-tracking harness of `discoveryWorker.dbcontext.test.ts` and mocks `gate`, `eligibility`, `siteLock`, `attempt`:

```ts
it('re-decides and records the attempt inside a context before the send', async () => {
  const r = await __testables.processDispatchScan(DATA);
  expect(r.dispatched).toBe(true);
  expect(ctxState.events).toEqual(['ctx:enter', 'jobStatusSelect@depth1', 'profileSelect@depth1', 'lock@depth1', 'gate@depth1',
    'agentValidateSelect@depth1', 'ctx:exit', 'isAgentConnected@depth0', 'ctx:enter', 'lock@depth1', 'profileForShare@depth1',
    'gate@depth1', 'recordAttempt@depth1', 'ctx:exit', 'wsDispatch@depth0']);
});
it('sends nothing when the attempt record is refused (the job left scheduled)', ...);       // recordDispatchAttempt -> false: dispatch not called, no update
it('a phase-1 gate failure fails the job with its code and sends nothing', ...);           // markJobFailed payload { code: 'credentials_need_reentry', message }
it('a phase-3 re-evaluation that fails fails the job with that code and sends nothing', ...);
it('a site gated between the phases sends guarded only to an eligible chosen agent', ...); // decision1 unrestricted, decision2 guarded: eligible -> type 'network_discovery_guarded'; not -> agent_not_eligible, no send
it('an unsent command fails the job after the attempt was recorded', ...);                 // outcome 'offline': 'Failed to send command to agent'
```

`discoveryWorker.dbcontext.test.ts:219` changes its expected events to the first list above (status write now precedes `wsDispatch`); its other cases change only by the inserted `lock`/`gate`/`recordAttempt` events. Remove `discoveryWorker.ts` from `PENDING` in `scanCommand.contract.test.ts`. Write the integration tests marked **Task 7** under "Integration proofs" below.

- [ ] **Step 2: Run and see it fail.** `cd apps/api && npx vitest run src/jobs/discoveryWorker src/jobs/discoveryAgentSelection.test.ts src/services/learnedNetworks/attempt.test.ts src/services/learnedNetworks/scanCommand.contract.test.ts`, and the integration file. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run and see it pass** (same commands plus `src/__tests__/parkedFanout.contract.test.ts`). Expected: PASS; the existing worker tests pass with only mock additions (`attempt.loadProfileForDispatch` mocked to return the phase-1 profile row).
- [ ] **Step 5: Commit** `feat(api): record the dispatch attempt before a discovery scan is sent`.

### Task 8: The verifier (E10)

**Files:** Create `services/learnedNetworks/verify.ts`, `verify.test.ts`.

**Interfaces:** Produces E10 `VerifyOutcome` and `verifyDiscoveryResult` verbatim, and `attemptFromRecord(value: unknown): { mode: 'unrestricted' | 'guarded'; allowedGatewayIds: readonly string[] } | null` (null → null; `'invalid'` → `{ mode: 'guarded', allowedGatewayIds: [] }`, which fails closed). **Lock contract (amended by W13, #12502):** Verify job-backed host results under the shared site lock at receipt; a rejection fails the active job and queues nothing; accepted results are enqueued after commit and verified again in the transaction that stores discovery assets; adjacency is verified at admission and completed AI results before hosts are returned; guarded refusal codes are kept. No caller holds the site lock across a queue (Redis) round trip.

Algorithm: a null `attempt` is unrestricted. **Unrestricted:** `loadSiteGateState(orgId, siteId).gated` → fail; else `{ ok: true, networkId: null }`. **Guarded:** fail unless `verifiedNetworkSchema` parses `verifiedNetwork`, its `gatewayId` is in `attempt.allowedGatewayIds`, and the gate evaluated now (`profile = profileId ? await loadGateProfile(profileId) : null`, a vanished profile fails; `job = { orgId, siteId }` when a profile is given) is `guarded` with an allowed entry whose `gatewayId`, `address` and `mac` equal the upload's. Success returns that entry's current `networkId`. Every failure is `{ code: 'network_unverified', message: GATE_FAILURE_MESSAGES.network_unverified }`.

- [ ] **Step 1: Write the failing test** (mocks `./gate`, `./siteNetworks`):

```ts
it.each([
  ['null attempt, site not gated', null, false, undefined, { ok: true, networkId: null }],
  ['null attempt, site gated', null, true, undefined, unverified],
  ['unrestricted, site not gated', { mode: 'unrestricted', allowedGatewayIds: [] }, false, undefined, { ok: true, networkId: null }],
  ['unrestricted, site gated since', { mode: 'unrestricted', allowedGatewayIds: [] }, true, undefined, unverified],
])('%s', async (_n, attempt, gated, verifiedNetwork, expected) => { ... });
it('guarded: a malformed verifiedNetwork is unverified', ...);
it('guarded: a fingerprint outside the attempt is unverified', ...);
it('guarded: a fingerprint no longer allowed now is unverified', ...);        // gate -> guarded without it
it('guarded: a current gate failure is unverified', ...);                      // gate -> fail no_network_assigned
it('guarded: an address or MAC that differs from the stored fingerprint is unverified', ...);
it('guarded: a vanished profile is unverified', ...);                          // loadGateProfile -> null
it('guarded: a match returns the fingerprint\'s current network', ...);         // { ok: true, networkId: N1 }
it('attemptFromRecord: null is null, an invalid record fails closed', ...);
```

- [ ] **Step 2: Run and see it fail.** `cd apps/api && npx vitest run src/services/learnedNetworks/verify.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see it pass.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): verify discovery results against the attempt and the current state`.

### Task 9: Verify the direct result branch (`routes/agentWs.ts:1874-1980`)

**Files:** Modify `routes/agentWs.ts`, `routes/agentWs.test.ts`, the integration file.

- [ ] **Step 1: Write the failing test** in `routes/agentWs.test.ts` beside the discovery cases (`:3108`), with `verify` and `siteLock` mocked:

```ts
it('stores a guarded refusal with its code', ...);
  // job running for this agent; result { status: 'failed', errorCode: 'network_mismatch', error: 'x' }:
  // update .set({ status: 'failed', errors: { code: 'network_mismatch', message: GATE_FAILURE_MESSAGES.network_mismatch } })
it('discards an unverified result and enqueues nothing', ...);
  // verify -> { ok: false, error }: errors === error, enqueueDiscoveryResults not called
it('enqueues a verified result with its verifiedNetwork', ...);
  // verify -> ok: enqueueDiscoveryResults called with the parsed verifiedNetwork as the 10th argument
```

Also write the integration tests marked **Task 9** under "Integration proofs".

- [ ] **Step 2: Run and see it fail.** `cd apps/api && npx vitest run src/routes/agentWs.test.ts src/routes/agentWs.enqueueContract.test.ts`, and the integration file. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement.** The job select (`:1876`) adds `profileId`, `networkDispatch`. After the agent and status checks (`:1888-1902`) and before the `try`:
  - A failed result whose `errorCode` is `network_mismatch` or `network_changed` writes `{ code, message: GATE_FAILURE_MESSAGES[code] }` with the same conditional update as `:1915-1923` and returns. Any other failure keeps `:1913-1926`.
  - A completed result with hosts: `lockSitesForNetworkGate([job.siteId], 'shared')`, then `verifyDiscoveryResult({ orgId, siteId, profileId, attempt: attemptFromRecord(job.networkDispatch), verifiedNetwork: discoveryData.verifiedNetwork })`. Not ok: write `errors: outcome.error` (same conditional update) and return. Ok: pass `discoveryData.verifiedNetwork` (when it parsed) to `enqueueDiscoveryResults` (Task 11's 10th argument). Amended by W13 (#12502): the enqueue runs only after the transaction that holds the lock has committed (the live loop awaits it before the ack), and a failed enqueue fails the job in a fresh context while it is still `running`.
- [ ] **Step 4: Run and see it pass** (same command). Expected: PASS, `agentWs.enqueueContract.test.ts` included.
- [ ] **Step 5: Commit** `feat(api): verify discovery results on the direct result branch`.

### Task 10: Verify `handleDiscoveryResult` (`services/commandResultHandlers.ts:120-205`)

**Files:** Modify `services/commandResultHandlers.ts`, `services/commandResultHandlers.test.ts`. Both persisted transports (WebSocket and `routes/agents/commands.ts`) reach this handler for both types after Task 6.

- [ ] **Step 1: Write the failing tests** (`verify`, `siteLock` mocked; `input(type, payload, result)` as in `commandResultHandlers.silentFailures.test.ts`):

```ts
const handler = commandResultHandlers.network_discovery_guarded!;
it('registers one handler for both discovery types', () =>
  expect(handler).toBe(commandResultHandlers.network_discovery));
it('discards an unverified result and enqueues nothing', async () => {
  vi.mocked(verifyDiscoveryResult).mockResolvedValue({ ok: false, error: UNVERIFIED });
  await handler(input('network_discovery_guarded', { jobId: JOB_ID }, { result: { jobId: JOB_ID, hosts: [HOST] } }));
  expect(updateSet()).toMatchObject({ status: 'failed', errors: UNVERIFIED });
  expect(enqueueDiscoveryResults).not.toHaveBeenCalled();
});
it('stores a refusal code', async () => {
  await handler(input('network_discovery_guarded', { jobId: JOB_ID }, { status: 'failed', errorCode: 'network_changed' }));
  expect(updateSet()).toMatchObject({ errors: { code: 'network_changed' } });
});
it('enqueues a verified result with its verifiedNetwork', async () => {
  await handler(input('network_discovery_guarded', { jobId: JOB_ID }, { result: { jobId: JOB_ID, hosts: [HOST], verifiedNetwork: VN } }));
  expect(vi.mocked(enqueueDiscoveryResults).mock.calls[0]![9]).toEqual(VN);
});
it('reads verifiedNetwork from stdout when the REST route delivers the body there (C7)', async () => {
  await handler({ ...input('network_discovery_guarded', { jobId: JOB_ID }, { result: { jobId: JOB_ID, hosts: [HOST] } }),
    stdout: JSON.stringify({ jobId: JOB_ID, hosts: [HOST], verifiedNetwork: VN }) });
  expect(vi.mocked(verifyDiscoveryResult).mock.calls[0]![0]).toMatchObject({ verifiedNetwork: VN });
});
it('does nothing for a command without a jobId (the AI tool)', async () => {
  await handler(input('network_discovery_guarded', { subnets: ['192.168.1.0/24'] }, { result: { hosts: [HOST] } }));
  expect(db.update).not.toHaveBeenCalled(); expect(verifyDiscoveryResult).not.toHaveBeenCalled();
});
```
- [ ] **Step 2: Run and see it fail.** `cd apps/api && npx vitest run src/services/commandResultHandlers.test.ts src/services/commandResultHandlers.silentFailures.test.ts`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement.** The job select (`:144`) adds `profileId`, `networkDispatch`. Lock and verify run before the `try` (`:123`), as in Task 9. Amended by W13 (#12502): an accepted result's enqueue is returned to the transport (`CommandResultAfterCommit`), which runs it after its transaction commits; the WebSocket finalize awaits it before the ack, the REST route registers it with `runAfterDbContextCommit` once its savepoint returned `'recorded'`. A refusal is recorded only when `expectedJobId` is set. `verifiedNetwork` is `result.result.verifiedNetwork` when present, else `JSON.parse(stdout).verifiedNetwork` (the handler's `stdout` argument; on the REST result route the body may arrive only there, index C7; a parse failure is `undefined`).
- [ ] **Step 4: Run and see it pass.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): verify persisted discovery command results`.

### Task 11: Verify in `processResults` and stamp the network

**Files:** Modify `jobs/discoveryWorker.ts:104-114`, `:1031-1850`, `:2031-2063`; `jobs/queueSchemas.ts:233-244`; `jobs/discoveryWorker.test.ts` (mocks); the integration file.

**Interfaces:** `ProcessResultsJobData` gains `verifiedNetwork?: VerifiedNetwork`. The `process-results` schema gains `verifiedNetwork: verifiedNetworkSchema.optional()` (the object is `.strict()`). `enqueueDiscoveryResults` gains a 10th parameter `verifiedNetwork?: VerifiedNetwork | null` after `meta`, and puts the key in the job data only when it is set.

- [ ] **Step 1: Write the failing tests** (integration, `describe('process results')`, calling `processResults` inside `withSystemDbAccessContext`):

```ts
it('a guarded result admitted earlier stores nothing when its fingerprint was unassigned before storing', ...);
  // job running with a guarded record for G1; UPDATE learned_networks SET site_id = NULL; processResults(..., verifiedNetwork G1)
  // -> job failed { code: 'network_unverified' }, discovered_assets for the org empty, returns { newAssets: 0, updatedAssets: 0 }
it('a verified guarded result sets the job network and stamps every asset it writes', ...);
  // two hosts, one new, one existing: both rows last_network_id = N1; job.network_id = N1
it('counts updated assets a guarded scan last saw on another network within 30 days', ...);
  // existing assets: last_network_id N2 seen 3 days ago (counts), N2 seen 40 days ago (no), N1 (no), null (no)
  // -> job.cross_network_asset_updates = 1
it('an unrestricted result leaves last_network_id and the job network null', ...);
```

- [ ] **Step 2: Run and see it fail** (integration command). Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The first job read (`:1019`) adds `siteId`, `profileId`, `networkDispatch`. After the cancelled check: `lockSitesForNetworkGate([job.siteId], 'shared')` and verify, in the storing transaction (the system context the worker opens at `:211`), so the lock is held until the assets are written. Amended by W13 (#12502): the baseline comparison is enqueued by the job wrapper after that transaction commits, never inside it; a failed enqueue fails the BullMQ job, and the retry finds the discovery job `completed`, stores nothing again and only delivers the comparison. Not ok: `markJobFailed(jobId, outcome.error)` and return zero counts before any asset read.
  - The per-host read (`:1191`) adds `lastNetworkId`, `lastSeenAt`. With a guarded `networkId`: the update set (`:1285`) and the insert values (`:1378`) add `lastNetworkId: networkId`. These are the two sighting writes. Not stamped: `:1315` and `:1344` (link clears), `:1483` (auto-link), `:1587` (approval and online on the row just stamped), `:1730` (the offline sweep writes rows this scan did not see).
  - Cross-network count, guarded results only: an update counts when the prior `lastNetworkId` is non-null and differs from `networkId`, and the prior `lastSeenAt` is within `CROSS_NETWORK_WINDOW_DAYS`. No column records when `last_network_id` was stamped; `last_seen_at` is the last sighting by any scan.
  - The completion write (`:1790-1801`) adds `networkId` and, for guarded results, `crossNetworkAssetUpdates`.
- [ ] **Step 4: Run and see it pass**: the integration file, `cd apps/api && npx vitest run src/jobs/discoveryWorker.test.ts src/jobs/discoveryQueue.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): verify discovery results in the storing transaction and record the network`.

### Task 12: Verify the adjacency admission (C4)

**Files:** Modify `routes/agents/topologyAdjacency.ts:27`, `:59`; `services/topology/discoveryTransport.ts:52-58`; `routes/agents/topologyAdjacency.test.ts`.

**Interfaces:** Body schema `z.object({ parentJobId: z.uuid(), report: z.unknown(), verifiedNetwork: z.unknown().optional() }).strict()`. `admitDiscoveryAdjacencyReport` input gains `verifiedNetwork?: unknown`.

- [ ] **Step 1: Write the failing tests.** In `topologyAdjacency.test.ts` (admission mocked, as that file does):

```ts
it('accepts verifiedNetwork in the body and hands it to admission', async () => {
  const res = await post({ parentJobId: JOB_ID, report: REPORT, verifiedNetwork: VN });
  expect(res.status).toBe(200);
  expect(admitDiscoveryAdjacencyReport).toHaveBeenCalledWith(expect.objectContaining({ verifiedNetwork: VN }));
});
it('still rejects unknown body keys', async () =>
  expect((await post({ parentJobId: JOB_ID, report: REPORT, extra: 1 })).status).toBe(400));
```

In a new `services/topology/discoveryTransport.verify.test.ts` (`../../db` with `assertInTransaction` a no-op; `./discoveryDispatch` `evaluateDiscoveryParent`, `../learnedNetworks/verify` and `../learnedNetworks/siteLock` mocked):

```ts
it('rejects a report that fails network verification before any section is ingested', async () => {
  vi.mocked(verifyDiscoveryResult).mockResolvedValue({ ok: false, error: UNVERIFIED });
  expect(await admitDiscoveryAdjacencyReport({ deviceId, orgId, report, verifiedNetwork: VN }))
    .toEqual({ status: 403, body: { error: 'network_unverified' } });   // the shape `reject` (:33) builds
  expect(ingestTopologySourceReport).not.toHaveBeenCalled();
  expect(lockSitesForNetworkGate).toHaveBeenCalledWith([SITE_ID], 'shared');
});
```
- [ ] **Step 2: Run and see it fail.** `cd apps/api && npx vitest run src/routes/agents/topologyAdjacency.test.ts src/services/topology/discoveryTransport.verify.test.ts src/services/topology/discoveryAdjacency.test.ts`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement.** In `admitDiscoveryAdjacencyReport`, right after `evaluateDiscoveryParent` succeeds: `lockSitesForNetworkGate([job.siteId], 'shared')`, then `verifyDiscoveryResult({ orgId: job.orgId, siteId: job.siteId, profileId: job.profileId, attempt: attemptFromRecord(job.networkDispatch), verifiedNetwork: input.verifiedNetwork })`; not ok → `reject(403, 'network_unverified')`. The route passes `body.data.verifiedNetwork`. The report alone does not fail the job; the scan's own result does.
- [ ] **Step 4: Run and see it pass** (same command, then the integration suites `topologyDiscoveryTransport` and `topologyDiscoveryPhysicalE2E`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): verify adjacency reports against the discovery attempt`.

### Task 13: The AI tool (`services/aiToolsNetwork.ts:940-985`)

**Files:** Modify `services/aiToolsNetwork.ts`, `services/aiToolsNetwork.discovery.test.ts`.

The handler, in order:

1. `verifyDeviceAccess(deviceId, auth, true)` as today.
2. One `inToolDbPhase`: `lockSitesForNetworkGate([device.siteId], 'shared')`; `decision = evaluateDiscoveryGate({ orgId: device.orgId, siteId: device.siteId, profile: null })`. `fail` → return `{ error: message, code }`. `guarded` → `explainGuardedAgent({ deviceId, allowedGatewayIds, commandType: DISCOVERY_SCAN_FAMILY })`; not eligible → `{ error: agentNotEligibleMessage(label, reason), code: 'agent_not_eligible', reason }`, nothing sent.
3. `command = buildDiscoveryScanCommand({ commandId: randomUUID(), payload: { subnets, methods }, decision, agentGatewayIds })`; `aiExecuteCommand(auth, 'network_discovery', deviceId, command.type, command.payload, { userId: auth.user.id, timeoutMs: 120000 })`. No lock or context is held across this call. Unrestricted sends exactly today's command.
4. `status: 'failed'` with `errorCode` `network_mismatch` or `network_changed` → `{ error: GATE_FAILURE_MESSAGES[code], code }`.
5. `status: 'completed'`: one `inToolDbPhase`: lock again; `attempt = result.commandId ? await loadCommandAttempt(result.commandId, deviceId) : null` (Task 7; it reads `device_commands.type, payload` by id and device, a table with no RLS; the guarded type gives `{ mode: 'guarded', allowedGatewayIds: payload.expectedNetwork.gateways ids }`, the base type `{ mode: 'unrestricted', allowedGatewayIds: [] }`, no row `null`); `verifiedNetwork` is `JSON.parse(result.stdout).verifiedNetwork` (the stored `stdout` is the JSON of the agent's result body, `routes/agentWs.ts:844-847`; a parse failure is `undefined`). Not ok → `{ error, code: 'network_unverified' }` with no hosts. Ok → `JSON.stringify(result)` as today.
6. Every other result is returned as today.

Contract tests that pin this file: `aiTools.deviceWaitContext.contract.test.ts:66` (self-managed, one wait of 120 s): the wait stays one `aiExecuteCommand` and every DB read is inside `inToolDbPhase`; no edit. `middleware/automationPrincipal.contract.test.ts:87` keys `services/aiToolsNetwork.ts:return isAutomationPrincipal(auth);` by line text: add no `isAutomationPrincipal` call; no edit. `aiTools.userOwnedRelease.contract.test.ts` attributes users-FK writes by brace depth: the handler adds no write; no edit. All three are re-run.

- [ ] **Step 1: Write the failing tests** in `aiToolsNetwork.discovery.test.ts`, with `./learnedNetworks/gate`, `eligibility`, `siteLock`, `attempt`, `verify` mocked and the existing `#8799` cases kept as they are:

```ts
it('refuses with the gate code and sends nothing', ...);                 // gate fail no_network_assigned: aiExecuteCommand not called
it('refuses an ineligible target on a guarded decision', ...);            // { code: 'agent_not_eligible', reason: 'needs_update' }
it('sends the guarded command through the builder to an eligible target', async () => {
  await tool().handler({ deviceId: DEVICE_ID, subnet: '192.168.1.0/24' }, auth);
  const [, , , type, payload] = vi.mocked(aiExecuteCommand).mock.calls[0]!;
  expect(type).toBe('network_discovery_guarded');
  expect(payload).toEqual({ subnets: ['192.168.1.0/24'], methods: ['ping'], expectedNetwork: { gateways: [G1_ENTRY] } });
});
it('returns a refusal code and no hosts', ...);
it('returns no hosts when the result is unverified', ...);                // output has code 'network_unverified', no 'hosts' key
it('passes the unrestricted command type through unchanged', ...);       // 4th argument 'network_discovery'
```

Remove `aiToolsNetwork.ts` from `PENDING` in `scanCommand.contract.test.ts`, and write the integration test marked **Task 13** under "Integration proofs".

- [ ] **Step 2: Run and see it fail.** `cd apps/api && npx vitest run src/services/aiToolsNetwork.discovery.test.ts src/services/learnedNetworks/scanCommand.contract.test.ts`, and the integration file. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see it pass**: `cd apps/api && npx vitest run src/services/aiToolsNetwork src/services/aiTools.deviceWaitContext.contract.test.ts src/services/aiTools.userOwnedRelease.contract.test.ts src/middleware/automationPrincipal.contract.test.ts src/services/learnedNetworks/scanCommand.contract.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): the network_discovery AI tool goes through the gate`.

### Integration proofs in `discoveryNetworkGate.integration.test.ts`

Not a task of its own. Each test below is written in Step 1 of the task marked beside it, and runs red there first. `describe('dispatch and results')`.

**Seams.** Worker: `vi.mock('../../services/agentCommandRelay')` keeps the module but replaces `isAgentConnectedAnywhere` (`async () => true`) and `dispatchCommandToAgent` (`vi.fn(async () => ({ status: 'sent', via: 'local' }))`). "No command sent" means `dispatchCommandToAgent` was not called. `prepareDiscoveryTopologyDispatch` returns `null` (`services/topology/discoveryDispatch`), `enqueueDiscoveryResults` is a `vi.fn` (`jobs/discoveryWorker`, rest kept), and `buildDiscoveryScanCommand`, `decryptSnmpCommunities` and `decryptSnmpCredentials` are pass-through spies. AI tool: copy the `seed`, `callerAuth` and `fakeAgent` helpers of `runScriptNoHeldTransaction.integration.test.ts` and drive the tool through `aiAgentSdkTools.__test__.makeHandler('network_discovery', () => auth)`. The fake agent completes the `device_commands` row with `stdout: JSON.stringify({ hosts: [], hostsScanned: 0, hostsDiscovered: 0 })`. "No command sent" means no `device_commands` row for the device. Results: `processOrphanedCommandResult` inside the agent's org context, as `backupVaultResultIntegrity.integration.test.ts:46-58` does. Dispatch: `__testables.processDispatchScan({ type: 'dispatch-scan', jobId, profileId, orgId, siteId })`.

```ts
// Task 7
it('gated site with no eligible agent sends no command', async () => {
  // gated with N1 = {G1}; LAPTOP-JS online 999.0.0 behind G2 only; DESKTOP-01 online '0.128.0' behind G1
  const r = await __testables.processDispatchScan(data);
  expect(r.dispatched).toBe(false);
  expect(relay.dispatchCommandToAgent).not.toHaveBeenCalled();
  expect(await job(jobId)).toMatchObject({ status: 'failed', networkDispatch: null,
    errors: { code: 'no_agent_on_network', reason: 'agents_need_update' } });
});
// Task 9
it('refusal that arrives right after the send is recorded with its code', async () => {
  // gated N1 = {G1}; LAPTOP-JS eligible behind G1
  relay.dispatchCommandToAgent.mockImplementationOnce(async (agentId) => {
    await asAgent(orgId, () => processOrphanedCommandResult(agentId, deviceId,
      { commandId: jobId, status: 'failed', errorCode: 'network_mismatch', error: 'no expected gateway' }));
    return { status: 'sent', via: 'local' };
  });
  expect((await __testables.processDispatchScan(data)).dispatched).toBe(true);
  expect(await job(jobId)).toMatchObject({ status: 'failed', agentId,
    errors: { code: 'network_mismatch' }, networkDispatch: { mode: 'guarded', allowedGatewayIds: [g1] } });
});
// Task 7
it('ungated site: worker scan unchanged', async () => {
  for (const version of ['0.128.0', 'dev']) {
    // fresh site, never gated; one online agent at `version`; profile with a saved community
    await __testables.processDispatchScan(data);
    const [, cmd] = relay.dispatchCommandToAgent.mock.calls.at(-1)!;
    expect(cmd.type).toBe('network_discovery');
    expect(Object.keys(cmd.payload).sort()).toEqual(['concurrency', 'deepScan', 'excludeIps', 'identifyOS', 'jobId', 'methods',
      'portRanges', 'resolveHostnames', 'snmpCommunities', 'snmpCredentials', 'subnets', 'timeout']);
    expect(await job(jobId)).toMatchObject({ status: 'running', networkDispatch: { mode: 'unrestricted', allowedGatewayIds: [] } });
  }
});
// Task 13 (makeHandler applies no tool rate limit; that is aiAgentSdk.ts:1947 and mcpServer.ts:2469)
it('ungated site: AI tool scan unchanged', async () => {
  for (const version of ['0.128.0', 'dev']) {
    const out = parseToolText(await handler({ deviceId, subnet: '192.168.1.0/24' }));
    const [row] = await commandsFor(deviceId);
    expect(row).toMatchObject({ type: 'network_discovery', payload: { subnets: ['192.168.1.0/24'], methods: ['ping'] } });
    expect(out).toMatchObject({ status: 'completed' });
  }
});
// Task 9 (this and the next two)
it('a guarded result whose fingerprint is not in the attempt is discarded', ...);
  // N1 = {G1} assigned; dispatch to the agent behind G1 (attempt [g1]); then assign N2 = {G3} to the same site;
  // the result names G3, allowed now but not in the attempt: job failed { code: 'network_unverified' }, no enqueue
it('a guarded result whose fingerprint was unassigned after the send is discarded', ...);
  // after the send: UPDATE learned_networks SET site_id = NULL (the site stays gated); result names G1: network_unverified, no enqueue
it('an unrestricted result that arrives after the site became gated is discarded', ...);
  // dispatch on a site that is not gated; then gateSite(...); completed result: network_unverified, no enqueue
// Task 7 (this and the next)
it('a bound credentialed profile is sent only guarded, behind a granted fingerprint', async () => {
  // (a) site not gated, profile with secrets, snmp_grant_mode 'bound', a grant on G1 of an unassigned network:
  //     job failed { code: 'credentials_need_reentry' }; buildDiscoveryScanCommand, both decrypt spies and dispatch not called
  // (b) gate the site with N1 = {G1, G3}; LAPTOP-JS behind G1, DESKTOP-01 behind G3 (ranks first): the one command is
  //     'network_discovery_guarded' to LAPTOP-JS with expectedNetwork.gateways ids [g1]
});
it('a guarded pinned agent that is not eligible fails naming it, with no fallback', ...);
  // pinned DESKTOP-01 is offline, LAPTOP-JS eligible: errors { code: 'agent_not_eligible', reason: 'offline' },
  // message contains '"DESKTOP-01"', dispatch not called
```

Run the whole file with `pnpm --filter @breeze/api test:integration src/__tests__/integration/discoveryNetworkGate.integration.test.ts`, then `pnpm --filter @breeze/api test:integration-suite-coverage` (the file is picked up by `src/__tests__/integration/**/*.test.ts`).

---

## Done when

- [ ] `cd packages/shared && npx vitest run src/types/discoveryNetworkGate.test.ts`: PASS.
- [ ] `cd apps/api && npx vitest run src/services/learnedNetworks src/services/commandMinVersion src/services/commandOfflinePolicy.test.ts src/services/partnerTrust.test.ts src/services/snmpSecrets.test.ts src/jobs/discoveryWorker src/jobs/discoveryAgentSelection.test.ts src/jobs/discoveryQueue.test.ts src/routes/agentWs.test.ts src/routes/agentWs.enqueueContract.test.ts src/services/commandResultHandlers src/routes/agents/topologyAdjacency.test.ts src/services/topology/discoveryAdjacency.test.ts src/services/aiToolsNetwork src/services/endpointMessaging/registrations.contract.test.ts`: PASS. (`src/services/learnedNetworks` with no trailing slash, so substring matching keeps the contract file.)
- [ ] Contract suites: `cd apps/api && npx vitest run src/__tests__/parkedFanout.contract.test.ts src/__tests__/mcp-coverage.test.ts src/services/aiTools.deviceWaitContext.contract.test.ts src/services/aiTools.userOwnedRelease.contract.test.ts src/middleware/automationPrincipal.contract.test.ts src/__tests__/dbTransactionPromiseAll.contract.test.ts`: PASS.
- [ ] Full API unit suite `pnpm --filter @breeze/api test --run`: PASS.
- [ ] `pnpm test-stack up`, then `pnpm --filter @breeze/api test:integration` with each of `src/__tests__/integration/discoveryNetworkGate.integration.test.ts`, `topologyDiscoveryTransport.integration.test.ts`, `topologyDiscoveryPhysicalE2E.integration.test.ts`, `runScriptNoHeldTransaction.integration.test.ts`, `discoveryProfilePinnedDevice.integration.test.ts`, and `src/jobs/discoveryWorker.dispatchAfterCommit.integration.test.ts`, `src/jobs/discoveryWorker.bmc.integration.test.ts`, `src/jobs/discoveryWorker.autoLinkMac.integration.test.ts`, then `pnpm --filter @breeze/api test:integration-suite-coverage`: PASS. Then `pnpm test-stack down`.
- [ ] Typecheck: `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p apps/api` and `-p packages/shared` exit 0 (check the exit code; do not pipe to `tail`).
- [ ] `pnpm db:check-drift` is clean (this wave adds no migration).
- [ ] PR body states: `Closes #<sub-issue>`; inert until W03c (no route gates a site; minimum agent version `999.0.0`); the five changes a site that is not gated can see (wave constraints 1 to 5); the one intended assertion change in `discoveryWorker.dbcontext.test.ts`; the guarded type is registered in the result registry, the REST registry list, the partner-trust gated list and both offline-policy lists; no migration; the Contract notes below.

## Contract notes

1. **Row 3 on a site that is not gated cannot allow any fingerprint.** A6 refuses an assigned network on a site whose flag is false, and row 3 allows only granted fingerprints "that belong to a network assigned to this site". So a bound profile with saved secrets on a site that is not gated always fails `credentials_need_reentry`. The requested proof "sent only as a guarded command to an agent behind a granted fingerprint" on such a site cannot be built. The integration proof `a bound credentialed profile is sent only guarded, behind a granted fingerprint` (written in Task 7) proves the fail-closed half on the site that is not gated and the guarded half after gating. If the owner wants grants to work on a site that is not gated, row 3 or A6 has to change.
2. **`versionAtLeast`** is module-private in `packages/shared/src/validators/endpointMessage.ts:44`. The exact version check is `agentSupportsGuardedCommand` (E7), written to the same rule.
3. **`network_dispatch.allowedGatewayIds`** holds the fingerprints actually sent (at most 64), not every allowed one. That is what the agent can prove, and it stays inside A3's 16 KiB check.
4. **E8 `commandId`** has no use on the AI path (`aiExecuteCommand` writes its own row id). The tool passes a random UUID and uses only `type` and `payload`.
5. **The AI path holds no site lock across its send.** Holding it would hold a transaction through the 120 s wait. The persisted command row is the attempt, and the verifier checks the result against the current state when it returns.
6. **Additive names** the index does not list: `siteNetworks.ts` (`loadSiteGateState`, `loadNetworkSiteId`, `loadNetworkGateways`), `messages.ts`, `gateProfileFromRow`, `loadGateProfile`, `planSiteLocks`, `parseNetworkDispatchRecord`, `loadProfileForDispatch`, `loadCommandAttempt`, `attemptFromRecord`, `DISCOVERY_SCAN_FAMILY`, `loadDeviceAddresses`, and `storedProfileHoldsSnmpSecrets` in `services/snmpSecrets.ts`. E5 now names it as the source of `hasSavedSnmpSecrets`; W03b's `profileWillHoldSnmpSecrets` delegates to it.
7. **Registrations the code map does not name:** `services/commandOfflinePolicy.ts` (`LIVE`, `EXTRA_ROUTE_TYPES`) is a fail-closed registry, and the `process-results` queue schema (`jobs/queueSchemas.ts:233`) and the adjacency body (`topologyAdjacency.ts:27`) are `.strict()`. All three must name the new type or key.
8. **The cross-network count** dates the previous sighting with `discovered_assets.last_seen_at`, since no column records when `last_network_id` was stamped.
9. **Row 1 is visible on sites that are not gated.** The spec puts it before row 4, so a moved profile fails `profile_moved` everywhere.
10. **`enqueueDiscoveryResults`** takes `verifiedNetwork` as a 10th positional parameter, after `meta`, so existing callers are unchanged.
11. **Fixture MACs outside the index list.** Task 1 tests `isSharedVirtualRouterMac` with `00:00:5e:00:01:0a`, `00-00-0C-07-AC-01` and `00:00:5e:00:02:0a`. They are the VRRP and HSRP protocol prefixes named in spec 8.5, not device addresses, and the function cannot be tested without them. The index's fixture list should name them.
12. **E6's suspended-token rule.** Eligibility excludes an agent whose `devices.agent_token_suspended_at` is set (index E6). B2's `IneligibleReason` has no value for it, so `explainGuardedAgent` reports such an agent as `offline`, and `explainNoEligibleAgent` counts it as not online.
13. **`network_changed` covers more than a move.** The agent maps every guard failure that is not a mismatch (a read error, a proof error other than no answer, an unavailable watcher, a move mid-scan) to `network_changed`, so its job sentence does not claim the scan was running.

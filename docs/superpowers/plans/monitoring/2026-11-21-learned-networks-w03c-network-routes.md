# Learned Networks W03c: Network Routes (the Switch)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins can list learned networks with the evidence to tell them apart and assign, unassign, rename, ignore, restore and merge them, and can stop requiring a network on a site. The first assignment gates a site, and the guard's minimum agent version becomes the first release that contains the guarded scan.

**Architecture:** One route module (`routes/discoveryNetworks.ts`, mounted at `/discovery`) over four services in `services/learnedNetworks/`. `list.ts` is the read model, `suggestions.ts` holds the pure suggestion rules, `assignment.ts` the assignment state changes and their preview, and `merge.ts` both merge forms. Every state change takes the exclusive per-site advisory lock (E1) on every site it involves, in ascending order, before touching a row. The gate (W03a) and profile saves (W03b) take the same lock in shared mode, so each sees the state before or after an assignment change, never a mix. Gating a site sets `sites.discovery_network_required`, binds unrestricted credentialed profiles (rule 2), and cancels the site's scheduled and running jobs, all in one transaction.

**Tech stack:** Hono, Zod, Drizzle on PostgreSQL (forced RLS), BullMQ (best-effort queue removal), Vitest.

**Spec:** `docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md` (§8.5; §8.2 "When an assignment change takes effect"; §9 for what the web reads; §10; §13 items 2, 4 and 11).

**Index:** `docs/superpowers/plans/monitoring/2026-11-21-learned-networks.md`. Its Global constraints, Review focus (item 4 is owned here) and Cross-wave contract apply to every task. E12, F and F1 are used verbatim. Sequencing rule 2 and plan call 10 govern Task 7.

## Wave constraints

- **This PR is the switch.** Before it, no site can be gated. It merges last in the API group (W01a, W01b, W03a, W03b merged), and only after an agent release contains W02c. Task 7 finds that release. If none exists, the PR stays open.
- **Consumes, never redefines:** `lockSitesForNetworkGate` (E1), `evaluateDiscoveryGate` (E5), `loadEligibleGuardedAgents` (E6), `agentSupportsGuardedCommand` and `GUARDED_DISCOVERY_MIN_AGENT_VERSION` (E7), `recordDispatchAttempt` (E9), `bindUnrestrictedProfilesOnGating`, `profileWillHoldSnmpSecrets` (E11), `lockProfileForSave` (W03b), `isSharedVirtualRouterMac` and `DiscoveryJobError` (B2), and the constants in E2. W01a, W03a and W03b files did not exist when this plan was written. Open them before relying on a name.
- **Lock order:** exclusive site locks for every site involved (ascending, via one `lockSitesForNetworkGate` call), then rows. Write `sites.discovery_network_required = true` **before** setting `learned_networks.site_id`. The W01a A6 triggers are initially immediate and refuse the reverse order. Never clear the flag while a network is assigned.
- **The site stays gated** through unassign, move-away, merge and site-network loss. Only `stopRequiringNetwork` clears the flag, and only with no network assigned (§5, §13 item 2).
- **Suggestions are computed on read and never applied.** No route here assigns automatically or in bulk (§3, §13 item 11).
- **No AI or MCP tool** for networks (§3 non-goal).
- **Fixtures** (index values only, one org, sites A, B, C): `N1` = `192.168.1.0/24` via `192.168.1.1`, `a4:2b:b0:11:22:9c` (`G1`); `N2` = `10.1.2.0/24` via `10.1.2.100`, `00:1a:8c:00:00:01` (`G2`); `N3` = `192.168.1.0/24` via `192.168.1.1`, `3c:37:86:aa:bb:10` (`G3`, the replacement router); `N_VRRP` = `192.168.1.1` with `00:00:5e:00:01:0a` (the VRRP prefix from §8.5, the same value W03a's tests use; not a device; see Contract notes, item 8). WAN `203.0.113.20`, `198.51.100.7`; hosts `LAPTOP-JS`, `DESKTOP-01`; a discovered host is `192.168.1.1`. Insert with the admin handle; set the site flag before `site_id`.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `apps/api/src/services/learnedNetworks/suggestions.ts` (+ `.test.ts`) | Create | Pure: `suggestSite`, `findReplacementFor`, `displayNameFor`. |
| `apps/api/src/services/learnedNetworks/list.ts` | Create | F1 read model and viewer visibility. |
| `apps/api/src/services/learnedNetworks/assignment.ts` | Create | E12 assignment functions, rename, ignore/restore, `LearnedNetworkError`. |
| `apps/api/src/services/learnedNetworks/merge.ts` | Create | `mergeNetworks` (E12). |
| `apps/api/src/routes/discoveryNetworks.ts` (+ `.test.ts`) | Create | Table F routes. |
| `apps/api/src/index.ts` | Modify after `:1098` | `api.route('/discovery', discoveryNetworksRoutes);` |
| `apps/api/src/services/mcpCoverage.ts` | Modify after `:551` | `MCP_COVERAGE` entry. |
| `apps/api/src/__tests__/parkedFanoutModules.ts` | Modify (`FANOUT_MODULES`, `:12`) | Classify `assignment.ts`. |
| `apps/api/src/__tests__/parkedFanout.contract.test.ts` | Modify (`VISIBILITY_MODULES`, `:120`) | Classify `list.ts`. |
| `apps/api/src/services/commandMinVersion.ts` (+ `.test.ts`) | Modify | Real `GUARDED_DISCOVERY_MIN_AGENT_VERSION` (Task 7). |
| `apps/api/src/__tests__/integration/learnedNetworksList.integration.test.ts` | Create | Read model on real Postgres. |
| `apps/api/src/__tests__/integration/learnedNetworkAssignment.integration.test.ts` | Create | P3, S1, S2, S6, S7, T2b, T4, review focus 4, and the three extras. |

---

### Task 1: Suggestions and replacement detection (pure)

**Files:**
- Create: `apps/api/src/services/learnedNetworks/suggestions.ts`
- Test: `apps/api/src/services/learnedNetworks/suggestions.test.ts`

**Interfaces:**
- Consumes: `normalizeDeclaredPrefix` (`services/topology/siteNetworkDeclarations.ts:19`); `SUGGESTION_MIN_SITE_DEVICES` (E2).
- Produces:

```ts
export type NetworkSuggestion = { siteId: string; siteName: string; reason: 'declared_prefix' | 'site_devices' };
export type ReplacementFor = { networkId: string; displayName: string; siteId: string; siteName: string };
export function displayNameFor(n: { name: string | null; prefix: string | null; gatewayAddresses: readonly string[] }): string;
export function suggestSite(input: {
  prefix: string | null;
  declaredPrefixesBySite: ReadonlyMap<string, ReadonlySet<string>>; // normalized, sites the viewer may see
  recentSiteDeviceCounts: ReadonlyMap<string, number>;              // devices assigned to each site, seen on this network in 14 days
  siteNames: ReadonlyMap<string, string>;
}): NetworkSuggestion | null;
export function findReplacementFor(
  candidate: { prefix: string | null; gatewayAddresses: readonly string[] },
  assigned: ReadonlyArray<ReplacementFor & { prefix: string | null; gatewayAddresses: readonly string[] }>,
): ReplacementFor | null;
```

Rules:
- `displayNameFor`: `name` when set. Otherwise `"<prefix> via <first gateway address>"`, or the first gateway address alone when `prefix` is null. "First" means oldest `first_seen_at`, so the caller passes addresses in that order.
- `suggestSite`, declared prefix: when `normalizeDeclaredPrefix(prefix)` equals a declared prefix of exactly one site, suggest that site with `declared_prefix`. Equality is exact; containment never counts.
- `suggestSite`, site devices: otherwise, among sites with at least `SUGGESTION_MIN_SITE_DEVICES` (2) devices, suggest the single site with the highest count, with `site_devices`. A tie at the top, or no qualifying site, gives `null`.
- `findReplacementFor`: the first assigned network (input order, `assigned_at` ascending) whose normalized prefix equals the candidate's and which shares at least one gateway address. A null prefix never matches.

- [ ] **Step 1: Write the failing tests**

```ts
const names = new Map([['site-a', 'Main Office'], ['site-b', 'Warehouse']]);
it('declared prefix wins on exact equality', () => {
  const declared = new Map([['site-a', new Set(['192.168.1.0/24'])], ['site-b', new Set(['10.1.2.0/24'])]]);
  expect(suggestSite({ prefix: '192.168.1.0/24', declaredPrefixesBySite: declared, recentSiteDeviceCounts: new Map(), siteNames: names }))
    .toEqual({ siteId: 'site-a', siteName: 'Main Office', reason: 'declared_prefix' });
});
it('two declaring sites fall through to site devices', () => {
  const declared = new Map([['site-a', new Set(['192.168.1.0/24'])], ['site-b', new Set(['192.168.1.0/24'])]]);
  expect(suggestSite({ prefix: '192.168.1.0/24', declaredPrefixesBySite: declared,
    recentSiteDeviceCounts: new Map([['site-b', 2], ['site-a', 1]]), siteNames: names }))
    .toEqual({ siteId: 'site-b', siteName: 'Warehouse', reason: 'site_devices' });
});
it.each([[new Map([['site-a', 1]])], [new Map([['site-a', 3], ['site-b', 3]])]])(
  'no suggestion below two devices or on a tie', (counts) => {
    expect(suggestSite({ prefix: null, declaredPrefixesBySite: new Map(), recentSiteDeviceCounts: counts, siteNames: names })).toBeNull();
  });
it('a new router on the same address and prefix looks like a replacement', () => {
  const office = { networkId: 'n1', displayName: 'Main Office LAN', siteId: 'site-a', siteName: 'Main Office',
    prefix: '192.168.1.0/24', gatewayAddresses: ['192.168.1.1'] };
  expect(findReplacementFor({ prefix: '192.168.1.0/24', gatewayAddresses: ['192.168.1.1'] }, [office]))
    .toEqual({ networkId: 'n1', displayName: 'Main Office LAN', siteId: 'site-a', siteName: 'Main Office' });
  expect(findReplacementFor({ prefix: '10.1.2.0/24', gatewayAddresses: ['192.168.1.1'] }, [office])).toBeNull();
});
it('display name falls back to "<prefix> via <gateway>"', () => {
  expect(displayNameFor({ name: null, prefix: '192.168.1.0/24', gatewayAddresses: ['192.168.1.1'] })).toBe('192.168.1.0/24 via 192.168.1.1');
  expect(displayNameFor({ name: null, prefix: null, gatewayAddresses: ['10.1.2.100'] })).toBe('10.1.2.100');
});
```

- [ ] **Step 2: Run to verify it fails.** `cd apps/api && npx vitest run src/services/learnedNetworks/suggestions.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `suggestions.ts`.**
- [ ] **Step 4: Run to verify it passes.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(api): learned network suggestions and replacement detection"`

---

### Task 2: The list read model

**Files:**
- Create: `apps/api/src/services/learnedNetworks/list.ts`
- Test: `apps/api/src/__tests__/integration/learnedNetworksList.integration.test.ts`

**Interfaces:**
- Consumes: Task 1; `readOrgNetworkDeclarations` (`siteNetworkDeclarations.ts:78`); `isSharedVirtualRouterMac` (B2); E2 constants.
- Produces:

```ts
export type NetworkViewer = { orgId: string; allowedSiteIds: readonly string[] | null }; // null = unrestricted
export type LearnedNetworksList = { data: LearnedNetworkListItem[]; sites: LearnedNetworkSite[]; limitReached: boolean }; // F1 exactly
export async function listLearnedNetworks(viewer: NetworkViewer, now: Date, perOrgMax?: number): Promise<LearnedNetworksList>;
export async function loadNetworkForViewer(viewer: NetworkViewer, networkId: string):
  Promise<{ id: string; siteId: string | null; ignoredAt: Date | null } | 'not_found' | 'denied'>;
```

Queries are set-based: one query per aggregate over all visible network ids, never one per network. The org cap is 5,000. Let `W = now - SUGGESTION_WINDOW_DAYS` and `F = now - NETWORK_ATTACHMENT_FRESHNESS_MS`. A device row reaches a network through its fingerprint: `learned_network_devices d JOIN learned_network_gateways g ON g.id = d.gateway_id AND g.org_id = d.org_id JOIN devices dv ON dv.id = d.device_id AND dv.org_id = d.org_id`.

- **Visibility (§8.5).** For `allowedSiteIds = S`: visible when `ln.site_id = ANY(S)`, or `ln.site_id IS NULL` and a device row on it has `dv.site_id = ANY(S)`. Empty `S` sees nothing. `loadNetworkForViewer` returns `'denied'` for an existing, invisible network. For a restricted viewer every device aggregate counts only `dv.site_id = ANY(S)`, and `sites`, `bySite` and suggestions name only sites in `S`.
- **Devices.** `recentCount`: distinct devices with `d.last_seen_at >= W`. `currentCount`: distinct devices with `d.is_current AND dv.status = 'online' AND dv.network_attachments_confirmed_at >= F` (the §6 "currently behind"). `bySite`: recent devices grouped by non-null `dv.site_id`, with the site name, count descending. `sample`: up to 5 recent devices by newest `d.last_seen_at`, as `{ deviceId, hostname: dv.hostname }`.
- **Other fields.** `wanAddresses`: every row, `last_seen_at` descending. `gateways`: `first_seen_at` ascending, with `sharedVirtualRouterMac: isSharedVirtualRouterMac(mac)`. `profileCount`: profiles with `network_id = ln.id` (in `S` when set). `state`: `assigned` when `site_id` is set, `ignored` when `ignored_at` is set, else `needs_review`; `data` is ordered by state in that order (`needs_review` first), then `last_seen_at` descending. `suggestion` and `replacementFor`: `needs_review` only, else `null`; declarations come from `readOrgNetworkDeclarations(db, orgId).bySite`. `sites`: every site of the org the viewer can access (every org site when `allowedSiteIds` is null, else those in `S`), including sites with no assigned network and no profile, as `{ siteId, siteName, networkRequired, assignedNetworkCount }`. W04 reads the gated flag of any site from it. `limitReached`: the org's network count is at least the cap, whoever the viewer is.

- [ ] **Step 1: Write the failing integration tests**

```ts
it('counts recent and current devices by the 14-day window and the freshness rule', async () => {
  // N1: LAPTOP-JS current + online + confirmed now; DESKTOP-01 last seen 13 days ago, not current;
  //     a third device last seen 15 days ago; a fourth current but confirmed 11 minutes ago.
  const [n1] = (await listLearnedNetworks({ orgId, allowedSiteIds: null }, NOW)).data.filter((n) => n.id === N1);
  expect(n1.devices.recentCount).toBe(3);
  expect(n1.devices.currentCount).toBe(1);
  expect(n1.devices.sample.map((d) => d.hostname)).toEqual(['LAPTOP-JS', 'DESKTOP-01', null]);
  expect(n1.devices.bySite).toEqual([{ siteId: siteA, siteName: 'Main Office', count: 2 }, { siteId: siteB, siteName: 'Warehouse', count: 1 }]);
});
it('lists WAN history newest first and flags a shared virtual-router MAC', async () => {
  const n1 = await item(N1);
  expect(n1.wanAddresses.map((w) => w.address)).toEqual(['203.0.113.20', '198.51.100.7']);
  expect((await item(N_VRRP)).gateways[0].sharedVirtualRouterMac).toBe(true);
});
it('suggests a site and flags a likely replacement only for networks that need review', async () => {
  // site A declares 192.168.1.0/24 through an enabled profile; N1 assigned to A; N3 unassigned, same address and prefix
  const n3 = await item(N3);
  expect(n3.state).toBe('needs_review');
  expect(n3.suggestion).toEqual({ siteId: siteA, siteName: 'Main Office', reason: 'declared_prefix' });
  expect(n3.replacementFor).toMatchObject({ networkId: N1, siteId: siteA });
  expect((await item(N1)).suggestion).toBeNull();
});
it('a site-restricted viewer sees its sites\' networks and unassigned networks its devices were seen on', async () => {
  // N1 assigned to A; N2 unassigned, seen only by a site-B device; N3 unassigned, seen by a site-A device
  const list = await listLearnedNetworks({ orgId, allowedSiteIds: [siteA] }, NOW);
  expect(list.data.map((n) => n.id).sort()).toEqual([N1, N3].sort());
  expect(list.sites.map((s) => s.siteId)).toEqual([siteA]);
  expect(await loadNetworkForViewer({ orgId, allowedSiteIds: [siteA] }, N2)).toBe('denied');
  expect((await listLearnedNetworks({ orgId, allowedSiteIds: [] }, NOW)).data).toEqual([]);
});
it('lists every accessible site, including one with no network', async () => {
  // N1 assigned to A; sites B and C have no network and no profile
  const { sites } = await listLearnedNetworks({ orgId, allowedSiteIds: null }, NOW);
  expect(sites.map((s) => s.siteId).sort()).toEqual([siteA, siteB, siteC].sort());
  expect(sites.find((s) => s.siteId === siteC)).toEqual({ siteId: siteC, siteName: expect.any(String),
    networkRequired: false, assignedNetworkCount: 0 });
  expect(sites.find((s) => s.siteId === siteA)).toMatchObject({ networkRequired: true, assignedNetworkCount: 1 });
});
it('reports limitReached at the per-org cap', async () => {
  // fixture has 4 networks in the org
  expect((await listLearnedNetworks({ orgId, allowedSiteIds: null }, NOW, 4)).limitReached).toBe(true);
  expect((await listLearnedNetworks({ orgId, allowedSiteIds: null }, NOW, 5)).limitReached).toBe(false);
});
```

`listLearnedNetworks` takes the cap as an optional third argument, `perOrgMax = LEARNED_NETWORKS_PER_ORG_MAX`, so the test does not insert 5,000 rows.

- [ ] **Step 2: Run to verify it fails.** `pnpm test-stack up`, then `pnpm --filter @breeze/api test:integration src/__tests__/integration/learnedNetworksList.integration.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `list.ts`.** Its device aggregates join `devices`, so `parkedFanout.contract.test.ts` discovers it: add `'services/learnedNetworks/list.ts': 'read model: learned networks list (device counts and samples for the Networks tab); selects no targets and dispatches nothing'` to `VISIBILITY_MODULES` (`__tests__/parkedFanout.contract.test.ts:120`).
- [ ] **Step 4: Run to verify it passes.** Same command, plus `cd apps/api && npx vitest run src/__tests__/parkedFanout.contract.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(api): learned networks list read model with site-restricted visibility"`

---

### Task 3: Assignment, unassignment, stop requiring, rename, ignore and restore

**Files:**
- Create: `apps/api/src/services/learnedNetworks/assignment.ts`
- Modify: `apps/api/src/__tests__/parkedFanoutModules.ts` (`FANOUT_MODULES`)
- Test: `apps/api/src/__tests__/integration/learnedNetworkAssignment.integration.test.ts`

**Interfaces:**
- Consumes: E1, E6, E7, E11 (`bindUnrestrictedProfilesOnGating`), `getDiscoveryQueue` (`jobs/discoveryWorker.ts:80`), `runAfterDbContextCommit` (`db/index.ts:860`), `notParkedDeviceCondition` (`services/unassignedPool/selectorPredicate.ts:36`).
- Produces: E12 verbatim (`AssignmentEffects`, `previewAssignment`, `assignNetwork`, `unassignNetwork`, `stopRequiringNetwork`), plus:

```ts
export type LearnedNetworkErrorCode = 'not_found' | 'site_not_found' | 'network_ignored' | 'network_assigned'
  | 'site_has_networks' | 'invalid_merge' | 'source_assigned' | 'concurrent_change';
export class LearnedNetworkError extends Error { constructor(readonly code: LearnedNetworkErrorCode, message: string); }
export function assignmentNeedsConfirmation(e: AssignmentEffects): boolean;
export async function renameNetwork(input: { orgId: string; networkId: string; name: string | null }): Promise<void>;
export async function setNetworkIgnored(input: { orgId: string; networkId: string; ignored: boolean }): Promise<void>;
export const GATING_CANCEL_MESSAGE = 'Cancelled: this site now requires scans to run on one of its assigned networks.';
```

**`previewAssignment`** (read-only, no lock). `siteId` is the target, or null for unassign; `cur` is the network's current site.
- `gatesSite`: `siteId` is set and its `discovery_network_required` is false. `profilesPointed`: profiles with `network_id = networkId`.
- `siteLosesLastNetwork`: `cur` is set, `siteId !== cur`, and this is `cur`'s only assigned network.
- `profilesFailingClosed`: 0 unless the network leaves `cur`; then the distinct profiles pointed at it, plus every profile of `cur` when `siteLosesLastNetwork`.
- `agents` (target site; zeros on unassign): `online` = devices with `site_id = siteId`, status `online`, `is_ephemeral = false`, `notParkedDeviceCondition()`, `agent_token_suspended_at IS NULL`, an agent id; `onNetwork` = of those, an `is_current` row on a fingerprint of this network and `network_attachments_confirmed_at >= now - NETWORK_ATTACHMENT_FRESHNESS_MS`; `needUpdate` = of `onNetwork`, `agentSupportsGuardedCommand(DISCOVERY_SCAN_FAMILY, agentVersion)` false (`DISCOVERY_SCAN_FAMILY` from W03a's `scanCommand.ts`, so this file holds no discovery command-type literal for the E8 contract test to flag). Eligible is `onNetwork - needUpdate`.
- `sharedVirtualRouterMac`: `siteId` is set and any fingerprint passes `isSharedVirtualRouterMac`.

`assignmentNeedsConfirmation(e)` is `e.gatesSite || e.siteLosesLastNetwork || e.profilesFailingClosed > 0 || e.sharedVirtualRouterMac`.

**`assignNetwork`**, in one transaction (the caller's):
1. Read the network in the org. Missing → `not_found`. `ignored_at` set → `network_ignored`. Already on `siteId` → return without writing.
2. `lockSitesForNetworkGate([siteId, cur].filter(Boolean), 'exclusive')`.
3. Re-read the network `FOR UPDATE`. If its site or `ignored_at` changed → `concurrent_change`.
4. Read the target site in the org (`site_not_found` if missing). `gating = !discovery_network_required`.
5. If gating: `UPDATE sites SET discovery_network_required = true`.
6. Update the network: `site_id`, `assigned_by`, `assigned_at = now()`, `updated_at = now()`.
7. If gating: call `bindUnrestrictedProfilesOnGating({ orgId, siteId, networkId, actorUserId })`, then cancel jobs best effort with the statement below, then `runAfterDbContextCommit('learned-network-gating', …)` removes `discovery-dispatch-<id>` for each returned id from `getDiscoveryQueue()`, ignoring failures. `SKIP LOCKED` means gating never waits on a job row a worker holds; a skipped job is stopped by the gate's re-evaluation under the site lock, or by result verification (§8.4).

```sql
UPDATE discovery_jobs SET status = 'cancelled', completed_at = now(), updated_at = now(),
       errors = jsonb_build_object('message', $GATING_CANCEL_MESSAGE)
 WHERE id IN (SELECT id FROM discovery_jobs
               WHERE org_id = $org AND site_id = $site AND status IN ('scheduled','running')
               FOR UPDATE SKIP LOCKED)
RETURNING id
```

A move leaves `cur` gated and never touches its profiles.

**`unassignNetwork`:** network missing → `not_found`; unassigned → return. Take the exclusive lock on `cur`, re-read `FOR UPDATE`, then clear `site_id`, `assigned_by` and `assigned_at`. Grants and profile `network_id` stay as they are.

**`stopRequiringNetwork`:** take the exclusive lock on the site. The site must exist in the org (`site_not_found`). If any network is assigned to it → `site_has_networks`. Otherwise clear the flag.

**`renameNetwork`** sets `name` (trimmed; null clears). **`setNetworkIgnored`**: `ignored: true` is `UPDATE … SET ignored_at = now() WHERE id AND org_id AND site_id IS NULL`, and zero rows on an existing network → `network_assigned` (so a race with assign never surfaces the CHECK as a 500); `ignored: false` clears `ignored_at`. Neither takes a site lock, since neither changes what the gate reads.

- [ ] **Step 1: Write the failing integration tests**

```ts
it('assign preview counts eligible and outdated agents', async () => {
  // site A not gated. Online: DESKTOP-01 (agentVersion '999.0.0', current on G1, confirmed now),
  // LAPTOP-JS ('0.1.0', current on G1, confirmed now), D3 (no membership), D4 (current on G1, confirmed 11 min ago).
  // D5 offline but current on G1. D6 is_ephemeral = true, online, current on G1 (fixture write).
  // A parked device lives in the holding org, so it cannot sit on site A; notParkedDeviceCondition is pinned by parkedFanout.contract.test.ts.
  const e = await inOrg(() => previewAssignment({ orgId, networkId: N1, siteId: siteA }));
  expect(e).toEqual({ gatesSite: true, profilesPointed: 0, profilesFailingClosed: 0, siteLosesLastNetwork: false,
    agents: { online: 4, onNetwork: 2, needUpdate: 1 }, sharedVirtualRouterMac: false });
  expect(assignmentNeedsConfirmation(e)).toBe(true);
});
it('the first assignment gates the site, binds unrestricted credentialed profiles and cancels its jobs', async () => {
  // P (secrets, unrestricted) on A; job J1 scheduled, J2 running, on A
  await inOrg(() => assignNetwork({ orgId, networkId: N1, siteId: siteA, actorUserId }));
  expect((await siteRow(siteA)).discoveryNetworkRequired).toBe(true);
  expect(allowed(await gateFor(P))).toEqual([G1]);
  for (const j of [J1, J2]) expect(await jobRow(j)).toMatchObject({ status: 'cancelled', errors: { message: GATING_CANCEL_MESSAGE } });
});
it("unassigning a site's last network makes its next dispatch fail no_network_assigned", async () => {
  await assigned(N1, siteA);
  await inOrg(() => unassignNetwork({ orgId, networkId: N1, actorUserId }));
  const job = await scheduledJob(profileWithoutSecrets);
  await __testables.processDispatchScan({ type: 'dispatch-scan', jobId: job, profileId: profileWithoutSecrets, orgId, siteId: siteA });
  expect(relay.dispatchCommandToAgent).not.toHaveBeenCalled();
  expect((await jobRow(job)).errors).toMatchObject({ code: 'no_network_assigned' });
});
it('stopRequiringNetwork is refused while a network is assigned', async () => {
  await assigned(N1, siteA);
  await expect(inOrg(() => stopRequiringNetwork({ orgId, siteId: siteA, actorUserId }))).rejects.toMatchObject({ code: 'site_has_networks' });
  expect((await siteRow(siteA)).discoveryNetworkRequired).toBe(true);
});
it('deleting a site returns its networks to unassigned', async () => {
  await assigned(N1, siteC);
  await admin().delete(sites).where(eq(sites.id, siteC));
  expect(await networkRow(N1)).toMatchObject({ siteId: null, id: N1 });
});
it('an ignored network cannot be assigned until restored', async () => {
  await inOrg(() => setNetworkIgnored({ orgId, networkId: N2, ignored: true }));
  await expect(inOrg(() => assignNetwork({ orgId, networkId: N2, siteId: siteA, actorUserId }))).rejects.toMatchObject({ code: 'network_ignored' });
  await expect(admin().execute(sql`UPDATE learned_networks SET site_id = ${siteA} WHERE id = ${N2}`)).rejects.toMatchObject({ code: '23514' });
  await inOrg(() => setNetworkIgnored({ orgId, networkId: N2, ignored: false }));
  await inOrg(() => assignNetwork({ orgId, networkId: N2, siteId: siteA, actorUserId }));
  expect((await networkRow(N2)).siteId).toBe(siteA);
});
it('S1 bound profile stays bound across un-gate and re-assign', async () => {
  await assigned(N1, siteA); const P = await createProfileViaRoute(siteA, { snmpCommunities: ['public-a'] }); // bound {G1}
  await inOrg(() => unassignNetwork({ orgId, networkId: N1, actorUserId }));
  await inOrg(() => stopRequiringNetwork({ orgId, siteId: siteA, actorUserId }));
  expect(allowed(await gateFor(P))).toBe('credentials_need_reentry');           // never 'unrestricted'
  await inOrg(() => assignNetwork({ orgId, networkId: N2, siteId: siteA, actorUserId }));
  expect(await profileRow(P)).toMatchObject({ snmpGrantMode: 'bound' });
  expect(allowed(await gateFor(P))).toBe('credentials_need_reentry');           // G2 never granted
});
it('S2 bound with no grants never becomes unrestricted', async () => {
  await assigned(N1, siteA); await inOrg(() => unassignNetwork({ orgId, networkId: N1, actorUserId }));
  const P = await createProfileViaRoute(siteA, { snmpCommunities: ['public-a'] });   // gated, no network
  expect(await grantRows(P)).toEqual([]);
  await inOrg(() => stopRequiringNetwork({ orgId, siteId: siteA, actorUserId }));
  expect(await profileRow(P)).toMatchObject({ snmpGrantMode: 'bound' });
  expect(allowed(await gateFor(P))).toBe('credentials_need_reentry');
});
it("T2b gating binds only to the profile's network", async () => {
  // Site A not gated. Admin fixture: P1 (secrets, unrestricted, network_id N2 — unassigned) and P2 (secrets, unrestricted, network_id null).
  await inOrg(() => assignNetwork({ orgId, networkId: N1, siteId: siteA, actorUserId }));
  expect(await profileRow(P1)).toMatchObject({ snmpGrantMode: 'bound' });
  expect(await grantRows(P1)).toEqual([]);
  expect(allowed(await gateFor(P2))).toEqual([G1]);
  await inOrg(() => assignNetwork({ orgId, networkId: N2, siteId: siteA, actorUserId })); // not a transition
  expect(allowed(await gateFor(P1))).toBe('credentials_need_reentry');
});
```

`gateFor`, `allowed`, `grantRows` and `profileRow` are the W03b helpers. Copy them into this file's fixture section. `relay` is `vi.mock('../../services/agentCommandRelay')`, with `isAgentConnectedAnywhere` resolving true and `dispatchCommandToAgent` recording the commands.

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @breeze/api test:integration src/__tests__/integration/learnedNetworkAssignment.integration.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `assignment.ts`.** Add `'services/learnedNetworks/assignment.ts': { guards: 1, reason: 'assign preview counts the site\'s online agents (Quick Support and parked devices out)' }` to `FANOUT_MODULES`. The guard count must equal the number of `notParkedDeviceCondition(` calls in the file.
- [ ] **Step 4: Run to verify it passes.** The same command, plus `cd apps/api && npx vitest run src/__tests__/parkedFanout.contract.test.ts`. Expected: PASS.
- [ ] **Step 5: Prove S1, S2 and T2b discriminate.** Make each change below, see the named test go red, and revert:
  - S1 and S2: `stopRequiringNetwork` also resets the site's profiles to `unrestricted`.
  - T2b: `bindUnrestrictedProfilesOnGating` ignores `network_id`.
- [ ] **Step 6: Commit.** `git commit -m "feat(api): assign, unassign and stop requiring learned networks; gating binds profiles and cancels jobs"`

---

### Task 4: Merge

**Files:**
- Create: `apps/api/src/services/learnedNetworks/merge.ts`
- Test: `apps/api/src/__tests__/integration/learnedNetworkAssignment.integration.test.ts`

**Interfaces:**
- Consumes: `LearnedNetworkError` (Task 3), E1, `WAN_ADDRESSES_PER_NETWORK_MAX` (E2).
- Produces: `mergeNetworks` (E12, verbatim).

**`mergeNetworks`**, in one transaction:
1. **Validate.** Load target and source in the org (`not_found`).
   - `invalid_merge` when: source equals target; `replaces_gateway` names no retired id; `additional_gateway` names any; or a retired id is not a gateway of the target.
   - Source assigned → `source_assigned`. Unassign it first, so a merge never silently takes a network away from a site.
2. **Lock.** Let `S` be `{target.site_id}` plus the `site_id` of every profile whose `network_id` is the source or the target, without nulls. `lockSitesForNetworkGate(S, 'exclusive')`. Then lock those profiles `FOR UPDATE ORDER BY id`. If the target's site or that profile site set changed since the read → `concurrent_change`.
3. **Clear digests (index A8).** Before any gateway row is deleted or re-pointed, and before membership rows (the heartbeat's lock order: devices, then membership rows): `UPDATE devices SET network_attachment_digest = NULL WHERE org_id = $org AND id IN (SELECT m.device_id FROM learned_network_devices m WHERE m.org_id = $org AND m.gateway_id = ANY($affected))`, where `$affected` is the retired ids plus every gateway of the source. The next report from each of those devices is then applied, not confirmed, so a device behind a retired router learns it again as a new network. This is a worker-side write outside the agent path, like W01b's retention.
4. **Retire** (`replaces_gateway` only): `DELETE FROM learned_network_gateways WHERE id = ANY($retired) AND network_id = $target`. Device rows and grants on those fingerprints go with them (FK cascade, §8.3 rule 3).
5. **Move fingerprints:** `UPDATE learned_network_gateways SET network_id = $target WHERE network_id = $source`.
6. **Re-point:** `discovery_profiles.network_id`, `discovery_jobs.network_id` and `discovered_assets.last_network_id` from source to target.
7. **WAN:**
   - Insert the source's WAN rows into the target. `ON CONFLICT (network_id, address)` keeps `LEAST(first_seen_at)` and `GREATEST(last_seen_at)`.
   - Then delete the target's rows beyond the newest `WAN_ADDRESSES_PER_NETWORK_MAX` by `last_seen_at`.
8. **Target times:** `first_seen_at = LEAST`, `last_seen_at = GREATEST`, `updated_at = now()`. The target keeps its name, prefix and assignment.
9. **Delete the source network.**

Nothing else in this wave deletes or re-points gateway or membership rows: assign, unassign, rename, ignore, restore and stop requiring touch only `learned_networks` and `sites`.

Neither form inserts a grant.

- [ ] **Step 1: Write the failing tests**

```ts
it('S6 merged gateway is not granted', async () => {
  await assigned(N1, siteA); const P = await createProfileViaRoute(siteA, { snmpCommunities: ['public-a'] }); // {G1}
  // N3 unassigned; LAPTOP-JS (eligible version) is current only on G3
  await inOrg(() => mergeNetworks({ orgId, targetNetworkId: N1, sourceNetworkId: N3, mode: 'additional_gateway', retiredGatewayIds: [], actorUserId }));
  expect(await grantRows(P)).toEqual([G1]);
  expect(allowed(await gateFor(P))).toEqual([G1]);                       // credentials never offered behind G3
  expect(allowed(await gateFor(profileWithoutSecrets))).toEqual([G1, G3].sort()); // the network itself did grow
});
it('S7 only named fingerprints are retired', async () => {
  await assigned(N1, siteA);
  await expect(inOrg(() => mergeNetworks({ orgId, targetNetworkId: N1, sourceNetworkId: N3, mode: 'replaces_gateway',
    retiredGatewayIds: [G3], actorUserId }))).rejects.toMatchObject({ code: 'invalid_merge' });   // G3 is the source's
  await inOrg(() => mergeNetworks({ orgId, targetNetworkId: N1, sourceNetworkId: N2, mode: 'additional_gateway', retiredGatewayIds: [], actorUserId }));
  await inOrg(() => mergeNetworks({ orgId, targetNetworkId: N1, sourceNetworkId: N3, mode: 'replaces_gateway', retiredGatewayIds: [G1], actorUserId }));
  expect(allowed(await gateFor(profileWithoutSecrets))).toEqual([G2, G3].sort());  // G2 kept, G1 gone
  expect(await gatewayExists(G1)).toBe(false);
});
it('merge re-points profiles, jobs, assets and WAN rows and deletes the source', async () => {
  // N3 unassigned with WAN 198.51.100.7 and 203.0.113.20; N1 has 203.0.113.20 (older first_seen_at);
  // a profile, a job and an asset reference N3
  await inOrg(() => mergeNetworks({ orgId, targetNetworkId: N1, sourceNetworkId: N3, mode: 'additional_gateway', retiredGatewayIds: [], actorUserId }));
  expect(await networkRow(N3)).toBeUndefined();
  expect([(await profileRow(Pn3)).networkId, (await jobRow(Jn3)).networkId, (await assetRow(An3)).lastNetworkId]).toEqual([N1, N1, N1]);
  expect(await wanRows(N1)).toEqual([
    { address: '203.0.113.20', firstSeenAt: OLDER, lastSeenAt: NEWER }, { address: '198.51.100.7', firstSeenAt: expect.any(Date), lastSeenAt: expect.any(Date) }]);
  expect(await grantCount()).toBe(grantCountBefore);
});
it('merge clears the attachment digest of devices whose memberships it removes or re-points', async () => {
  // N1 = {G1} assigned to A; N3 = {G3} unassigned; N2 = {G2} not part of the merge. DESKTOP-01 current on G1,
  // LAPTOP-JS current on G3, a third device D3 current on G2; all three have devices.network_attachment_digest set.
  await inOrg(() => mergeNetworks({ orgId, targetNetworkId: N1, sourceNetworkId: N3, mode: 'replaces_gateway',
    retiredGatewayIds: [G1], actorUserId }));
  expect((await deviceRow(desktop01)).networkAttachmentDigest).toBeNull();   // its G1 row was deleted with G1
  expect((await deviceRow(laptopJs)).networkAttachmentDigest).toBeNull();    // its G3 gateway was re-pointed to N1
  expect((await deviceRow(d3)).networkAttachmentDigest).not.toBeNull();      // G2's network is not in the merge
});
it('a merge never takes an assigned source', async () => {
  await assigned(N2, siteB);
  await expect(inOrg(() => mergeNetworks({ orgId, targetNetworkId: N1, sourceNetworkId: N2, mode: 'additional_gateway',
    retiredGatewayIds: [], actorUserId }))).rejects.toMatchObject({ code: 'source_assigned' });
});
```

- [ ] **Step 2: Run to verify it fails.** Same integration command as Task 3. Expected: FAIL (`mergeNetworks` missing).
- [ ] **Step 3: Implement `merge.ts`.**
- [ ] **Step 4: Run to verify it passes.** Expected: PASS.
- [ ] **Step 5: Prove S6 and S7 discriminate.** Make each change below, see red, and revert:
  - S6: copy the source's fingerprints into the profiles' grants.
  - S7: delete every target gateway on `replaces_gateway`.
  - Digest: drop step 3. The digest test fails on DESKTOP-01 and LAPTOP-JS.
- [ ] **Step 6: Commit.** `git commit -m "feat(api): learned network merge, additional and replacement gateway"`

---

### Task 5: Concurrency, P3 and T4

**Files:**
- Test: `apps/api/src/__tests__/integration/learnedNetworkAssignment.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 4; `__testables.processDispatchScan` and `processResults` (`jobs/discoveryWorker.ts:919`, `:1031`); `recordDispatchAttempt` (E9); `applySnmpGrantRulesOnSave` (E11); `verifyDiscoveryResult` (E10).

Determinism follows `networkIsolationLifecycleLockOrder.integration.test.ts`. Each participant runs on its own connection: the assignment in `runOutsideDbContext(() => withDbAccessContext(orgCtx, …))`, the worker functions in their own system contexts, a profile save through the integration client. **Barriers** are wrapped seams (partial `vi.mock(…, importOriginal)`) that record `pg_backend_pid()`, signal `reached` and await `release`, once: `lockSitesForNetworkGate` after an `'exclusive'` call returns; `recordDispatchAttempt` after it returns true, inside the dispatch's locked transaction; `bindUnrestrictedProfilesOnGating` before it runs; `applySnmpGrantRulesOnSave` after it returns (the save has decided its mode and not committed). **Ordering points** come from Postgres, never sleeps: `waitBlockedBy(pid, 'advisory' | 'row')` polls `pg_stat_activity` for `pid = ANY(pg_blocking_pids(…))`. **Holding a job row** ("cancel skipped" variants): a third connection runs `SELECT … FROM discovery_jobs WHERE id = $job FOR UPDATE` in an open `getTestDb().transaction` and rolls back on cue. Bound every wait at 10 s, drain with `Promise.allSettled`, assert no `40P01`.

Fixture for P3: site A not gated; profile P without secrets on A; scheduled job J; one online device on A with `agentVersion '0.1.0'` and no membership; N1 unassigned. A result carries one host, `192.168.1.1`, shaped as `DiscoveredHostResult` (`jobs/discoveryWorker.ts:144`). `jobData(J)` is `{ type: 'dispatch-scan', jobId: J, profileId: P, orgId, siteId: siteA }`. Relay seams, `processResults` input and "no command sent" follow the W03a plan's integration section ("Seams").

- [ ] **Step 1: Write the failing tests**

```ts
describe('assignment change racing a dispatch', () => it.each([
  ['assign first, cancel lands', 'assign', false],
  ['assign first, cancel skipped', 'assign', true],
  ['dispatch first, cancel lands', 'dispatch', false],
  ['dispatch first, cancel skipped', 'dispatch', true],
] as const)('%s', async (_n, first, holdJobRow) => {
  if (first === 'assign') {
    const a = pauseOnce('lockSitesForNetworkGate:exclusive'); const assign = assignN1ToA();
    await a.reached;
    const hold = holdJobRow ? await holdRow(J) : null;           // cancel will SKIP LOCKED past J
    const dispatch = runOutsideDbContext(() => __testables.processDispatchScan(jobData(J)));
    await waitBlockedBy(a.pid, 'advisory'); a.release(); await hold?.releaseAfter(assign);
    await settleNo40P01(assign, dispatch);
    expect(relay.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect((await jobRow(J)).networkDispatch).toBeNull();
    expect(await jobRow(J)).toMatchObject(holdJobRow
      ? { status: 'failed', errors: { code: 'no_agent_on_network' } }  // re-evaluated under the lock: gated now
      : { status: 'cancelled' });
  } else {
    const d = pauseOnce('recordDispatchAttempt'); const dispatch = runOutsideDbContext(() => __testables.processDispatchScan(jobData(J)));
    await d.reached;
    const b = holdJobRow ? pauseOnce('bindUnrestrictedProfilesOnGating') : null;
    const assign = assignN1ToA(); await waitBlockedBy(d.pid, 'advisory'); d.release();
    if (b) { await b.reached; const hold = await holdRow(J); b.release(); await hold.releaseAfter(assign); }
    await settleNo40P01(assign, dispatch);
    expect(relay.commands().map((c) => c.type)).toEqual(['network_discovery']); // allowed by the state it was decided under
    await processResults({ jobId: J, orgId, siteId: siteA, hosts: [HOST], verifiedNetwork: undefined } as any);
    expect(await assetCount(orgId)).toBe(0);                                   // nothing written after gating
    expect(await jobRow(J)).toMatchObject(holdJobRow ? { status: 'failed', errors: { code: 'network_unverified' } } : { status: 'cancelled' });
  }
}));
describe('T4 assign against save', () => it.each(['assign first', 'save first'] as const)('%s', async (order) => {
  // site A not gated, N1 unassigned; P (no secrets) on B moves to A with fresh secrets in the save.
  // The save-side barrier sits after applySnmpGrantRulesOnSave returns: the save has decided its mode and not committed.
  const first = order === 'assign first' ? pauseOnce('lockSitesForNetworkGate:exclusive') : pauseOnce('applySnmpGrantRulesOnSave:after');
  const a = order === 'assign first' ? assignN1ToA() : saveMoveToA(P, 'public-a');
  await first.reached;
  const b = order === 'assign first' ? saveMoveToA(P, 'public-a') : assignN1ToA();
  await waitBlockedBy(first.pid, 'advisory'); first.release();
  await settleNo40P01(a, b);
  expect(await profileRow(P)).toMatchObject({ siteId: siteA, snmpGrantMode: 'bound' });
  expect(allowed(await gateFor(P))).toEqual([G1]);   // never unrestricted on a gated site (row 3a)
}));
```

- [ ] **Step 2: Run to verify each goes red without its safeguard.** Make each change, see the named case fail, and revert:
  - Make `assignNetwork` skip `lockSitesForNetworkGate`. T4 `save first` then ends `unrestricted` on a gated site (row 3a). The assign commits while the save is paused with its mode already decided. The P3 `assign first` cases never reach their barrier and fail at the 10 s bound.
  - Make `verifyDiscoveryResult` accept an unrestricted attempt without reading the site's current flag. P3 `dispatch first, cancel skipped` stores the host.
  - Drop `SKIP LOCKED` from the gating cancel. Both P3 `cancel skipped` cases time out, because gating waits on a job row.
- [ ] **Step 3: Run to verify they pass**, three consecutive runs. Expected: PASS.
- [ ] **Step 4: Commit.** `git commit -m "test(api): P3 and T4 prove assignment changes and dispatches or saves serialize on the site lock"`

---

### Task 6: Routes, mounting and route contracts

**Files:**
- Create: `apps/api/src/routes/discoveryNetworks.ts`, `apps/api/src/routes/discoveryNetworks.test.ts`
- Modify: `apps/api/src/index.ts` (after `:1098`), `apps/api/src/services/mcpCoverage.ts` (after `:551`)

**Interfaces:**
- Consumes: Tasks 2 to 4; `resolveOrgIdForAuth` (`services/assetAccessScope.ts:27`; `resolveOrgId` in `routes/discovery.ts` is file-local); `canAccessSite`, `PERMISSIONS`, `UserPermissions` (`services/permissions`); `requireMfa`, `requirePermission`, `requireScope`, `authMiddleware` (`middleware/auth`); `writeRouteAudit` (`services/auditEvents.ts:241`).
- Produces: `export const discoveryNetworksRoutes = new Hono();`

Every route uses `requireScope('organization', 'partner', 'system')`. Reads use `requirePermission(DEVICES_READ)`. Writes use `requirePermission(DEVICES_WRITE)` and `requireMfa()`. The org comes from `resolveOrgIdForAuth(auth, query.orgId)`. The viewer is `{ orgId, allowedSiteIds: permissions?.allowedSiteIds ?? null }`. Each `:id` write first calls `loadNetworkForViewer` (`not_found` gives 404, `denied` gives 403 `Access to this site denied`).

```ts
const orgQuery = z.object({ orgId: z.string().guid().optional() });
const networkParams = z.object({ id: z.string().guid() });
const renameNetworkSchema = z.object({ name: z.string().trim().min(1).max(255).nullable() }).strict();
const assignNetworkSchema = z.object({ siteId: z.string().guid(), confirmed: z.boolean().optional() }).strict();
const unassignNetworkSchema = z.object({ confirmed: z.boolean().optional() }).strict();
const mergeNetworksSchema = z.object({
  sourceNetworkId: z.string().guid(),
  mode: z.enum(['additional_gateway', 'replaces_gateway']),
  retiredGatewayIds: z.array(z.string().guid()).max(EXPECTED_GATEWAYS_MAX).optional(),
}).strict().superRefine((v, ctx) => {
  const n = v.retiredGatewayIds?.length ?? 0;
  if (v.mode === 'replaces_gateway' && n === 0) ctx.addIssue({ code: 'custom', path: ['retiredGatewayIds'], message: 'Name at least one retired gateway' });
  if (v.mode === 'additional_gateway' && n > 0) ctx.addIssue({ code: 'custom', path: ['retiredGatewayIds'], message: 'Only a replacement retires gateways' });
});
const stopRequiringSchema = z.object({ confirmed: z.literal(true) }).strict();
```

| Route | Site access required | Calls | Success | Audit `action` (`resourceType`) |
|---|---|---|---|---|
| `GET /networks` | — (visibility in the service) | `listLearnedNetworks(viewer, new Date())` | `200` F1 | — |
| `PATCH /networks/:id` | network visible | `renameNetwork` | `200 { success: true }` | `discovery.network.rename` (`learned_network`) |
| `POST /networks/:id/assign` | target site, and the current site on a move | `previewAssignment` → 409 rule → `assignNetwork` | `200 { success: true }` | `discovery.network.assign`, details `{ siteId, previousSiteId, effects }` |
| `POST /networks/:id/unassign` | current site | `previewAssignment(siteId: null)` → 409 rule → `unassignNetwork` | `200 { success: true }` | `discovery.network.unassign`, details `{ previousSiteId, effects }` |
| `POST /networks/:id/ignore`, `/restore` | network visible | `setNetworkIgnored` | `200 { success: true }` | `discovery.network.ignore` / `discovery.network.restore` |
| `POST /networks/:id/merge` | target visible and its site, if assigned; source visible | `mergeNetworks` | `200 { success: true }` | `discovery.network.merge`, details `{ sourceNetworkId, mode, retiredGatewayIds }` |
| `POST /sites/:siteId/stop-requiring-network` | `canAccessSite(permissions, siteId)` **inside this handler** (the site-scope scanner matches `/sites/:param` and reads only the route file) | `stopRequiringNetwork` | `200 { success: true }` | `discovery.site.stop_requiring_network` (`site`) |

**409 rule.** Without `confirmed: true`, when `assignmentNeedsConfirmation(effects)` holds, answer `409 { error: 'Confirmation required', code: 'CONFIRMATION_REQUIRED', effects }` and write nothing. The preview runs before the lock; a change between preview and commit weakens nothing the gate enforces, so the confirmation is advisory. An assignment to the network's current site returns 200 with no audit row.

**Errors.** `LearnedNetworkError` maps to: `not_found` 404; `site_not_found` 404; `network_ignored` 409 `NETWORK_IGNORED`; `network_assigned` 409 `NETWORK_ASSIGNED`; `site_has_networks` 409 `NETWORK_ASSIGNED`; `source_assigned` 409 `SOURCE_ASSIGNED`; `invalid_merge` 400 `INVALID_MERGE`; `concurrent_change` 409 `CONCURRENT_CHANGE`. These are application throws after successful queries: catch only this class, rethrow the rest, no savepoint needed.

**Wiring.** `index.ts`: `api.route('/discovery', discoveryNetworksRoutes);` after `:1098`, with a comment that no path overlaps the other discovery routers. `mcpCoverage.ts`: `'discoveryNetworks.ts': { exempt: 'internal_plumbing', note: 'Learned networks list and assignment (learned networks spec 8.5). AI and MCP tools that list or assign learned networks are a non-goal of the spec (section 3).' },`

- [ ] **Step 1: Write the failing route tests**

In `routes/discoveryNetworks.test.ts`, partially mock `../middleware/auth` replacing only `authMiddleware` (so `requirePermission`, `requireMfa` and `requireScope` stay real), mock `getUserPermissions` in `../services/permissions` per test, pin `ENABLE_2FA` true by partially mocking `./auth/schemas`, and mock the four services and `writeRouteAudit`.

```ts
it('GET needs devices:read', async () => { perms([]); expect((await get('/discovery/networks')).status).toBe(403); });
it.each(WRITE_ROUTES)('%s needs devices:write', async (method, path, body) => {
  perms([DEVICES_READ]); expect((await call(method, path, body)).status).toBe(403);
});
it.each(WRITE_ROUTES)('%s needs MFA', async (method, path, body) => {
  perms([DEVICES_WRITE]); mfa(false);
  const res = await call(method, path, body);
  expect(res.status).toBe(403); expect((await res.json()).code).toBe('MFA_REQUIRED');
});
it('a site-restricted user lists only through its viewer', async () => {
  restrict([SITE_A]); await get('/discovery/networks');
  expect(listLearnedNetworks).toHaveBeenCalledWith({ orgId: ORG, allowedSiteIds: [SITE_A] }, expect.any(Date));
});
it('a site-restricted user cannot assign to, or move from, a site it cannot access', async () => {
  restrict([SITE_A]);
  expect((await post(`/discovery/networks/${N}/assign`, { siteId: SITE_B, confirmed: true })).status).toBe(403);
  networkOn(SITE_B);
  expect((await post(`/discovery/networks/${N}/assign`, { siteId: SITE_A, confirmed: true })).status).toBe(403);
  expect((await post(`/discovery/sites/${SITE_B}/stop-requiring-network`, { confirmed: true })).status).toBe(403);
  expect(assignNetwork).not.toHaveBeenCalled(); expect(stopRequiringNetwork).not.toHaveBeenCalled();
});
it('assign answers 409 CONFIRMATION_REQUIRED with the effects, then assigns once confirmed', async () => {
  vi.mocked(previewAssignment).mockResolvedValue(GATING_EFFECTS);
  const first = await post(`/discovery/networks/${N}/assign`, { siteId: SITE_A });
  expect(first.status).toBe(409);
  expect(await first.json()).toEqual({ error: 'Confirmation required', code: 'CONFIRMATION_REQUIRED', effects: GATING_EFFECTS });
  expect(assignNetwork).not.toHaveBeenCalled();
  expect((await post(`/discovery/networks/${N}/assign`, { siteId: SITE_A, confirmed: true })).status).toBe(200);
  expect(assignNetwork).toHaveBeenCalledTimes(1);
  expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'discovery.network.assign' }));
});
it('a second network on an already gated site needs no confirmation', async () => {
  vi.mocked(previewAssignment).mockResolvedValue({ ...GATING_EFFECTS, gatesSite: false });
  expect((await post(`/discovery/networks/${N}/assign`, { siteId: SITE_A })).status).toBe(200);
});
it.each([
  [{ sourceNetworkId: N2, mode: 'replaces_gateway' }], [{ sourceNetworkId: N2, mode: 'additional_gateway', retiredGatewayIds: [G1] }],
])('merge body %j is a 400', async (body) => { expect((await post(`/discovery/networks/${N}/merge`, body)).status).toBe(400); });
it('maps service refusals', async () => {
  vi.mocked(assignNetwork).mockRejectedValueOnce(new LearnedNetworkError('network_ignored', 'x'));
  expect((await post(`/discovery/networks/${N}/assign`, { siteId: SITE_A, confirmed: true })).status).toBe(409);
  vi.mocked(stopRequiringNetwork).mockRejectedValueOnce(new LearnedNetworkError('site_has_networks', 'x'));
  const res = await post(`/discovery/sites/${SITE_A}/stop-requiring-network`, { confirmed: true });
  expect(res.status).toBe(409); expect((await res.json()).code).toBe('NETWORK_ASSIGNED');
  expect((await post(`/discovery/sites/${SITE_A}/stop-requiring-network`, {})).status).toBe(400);
});
it.each(AUDITED)('%s writes audit action %s', async (route, action) => { /* call route; expect writeRouteAudit action */ });
```

`WRITE_ROUTES` lists all seven write routes with a valid body. `AUDITED` pairs each write route with its action from the table.

- [ ] **Step 2: Run to verify it fails.** `cd apps/api && npx vitest run src/routes/discoveryNetworks.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement the route file, the mount and the coverage entry.**
- [ ] **Step 4: Run the route tests and the route contracts.**

Run: `cd apps/api && npx vitest run src/routes/discoveryNetworks.test.ts src/__tests__/writeRoutePermissionGate.contract.test.ts src/__tests__/mcp-coverage.test.ts src/__tests__/parkedFanout.contract.test.ts`, then `pnpm -F @breeze/api test:site-scope-coverage`.
Expected: PASS. A failure in a contract test is fixed in the route, never by adding an allowlist entry.

- [ ] **Step 5: Commit.** `git commit -m "feat(api): learned network routes under /discovery"`

---

### Task 7: The guard's minimum agent version (gate: an agent release contains W02c)

**Files:**
- Modify: `apps/api/src/services/commandMinVersion.ts` (`GUARDED_DISCOVERY_MIN_AGENT_VERSION`, added by W03a)
- Test: `apps/api/src/services/commandMinVersion.test.ts`

- [ ] **Step 1: Find the release.**

```bash
gh pr list --state merged --search "Closes #<W02c sub-issue>" --json number,mergeCommit -q '.[0].mergeCommit.oid'
git fetch origin --tags
git tag --contains <that sha> --sort=v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1
```

Take the first final tag, never an rc, without the `v`. Call it `X.Y.Z`.
- **If the output is empty, stop.** Leave this PR open, note "waiting for the agent release that contains W02c" on the wave issue, and do not merge (sequencing rule 2).
- `semverCompare` ignores prerelease suffixes (`packages/shared/src/utils/semverCompare.ts:3`), so an rc build of `X.Y.Z` compares equal. An rc of `X.Y.Z` cut before W02c merged would be offered the guarded command and refuse it as an unknown type. That fails closed: the job fails and nothing is scanned.

- [ ] **Step 2: Write the failing test**

```ts
it('guarded discovery requires the first release that contains the guarded scan', () => {
  expect(GUARDED_DISCOVERY_MIN_AGENT_VERSION).toBe('X.Y.Z');
  expect(COMMAND_MIN_AGENT_VERSION.network_discovery_guarded).toBe('X.Y.Z');
  expect(agentSupportsGuardedCommand('network_discovery', 'X.Y.Z')).toBe(true);
  expect(agentSupportsGuardedCommand('network_discovery', '<the final release before X.Y.Z>')).toBe(false);
  expect(agentSupportsGuardedCommand('network_discovery', null)).toBe(false);
  expect(agentSupportsGuardedCommand('network_discovery', 'garbage')).toBe(false);
});
```

- [ ] **Step 3: Run to verify it fails.** `cd apps/api && npx vitest run src/services/commandMinVersion.test.ts`. Expected: FAIL (`'999.0.0'` is not `'X.Y.Z'`).
- [ ] **Step 4: Set `GUARDED_DISCOVERY_MIN_AGENT_VERSION = 'X.Y.Z'`.** Add a comment naming the release and the W02c PR.
- [ ] **Step 5: Run it and the suites that read the version.**

Run: `cd apps/api && npx vitest run src/services/commandMinVersion.test.ts src/services/learnedNetworks`, then `pnpm --filter @breeze/api test:integration src/__tests__/integration/discoveryNetworkGate.integration.test.ts src/__tests__/integration/learnedNetworkAssignment.integration.test.ts`.
Expected: PASS. The `'0.1.0'` fixture agents stay below the guard and the `'999.0.0'` ones above it.

- [ ] **Step 6: Commit.** `git commit -m "feat(api): guarded discovery minimum agent version is X.Y.Z"`

---

## Done when

- [ ] `cd apps/api && npx vitest run src/services/learnedNetworks src/routes/discoveryNetworks.test.ts src/services/commandMinVersion.test.ts src/routes/discovery.test.ts src/__tests__/writeRoutePermissionGate.contract.test.ts src/__tests__/mcp-coverage.test.ts src/__tests__/parkedFanout.contract.test.ts src/__tests__/credentialOriginBindingCoverage.test.ts` passes. Check the reported file count: `src/services/learnedNetworks` is a substring filter.
- [ ] `pnpm -F @breeze/api test:site-scope-coverage` and `pnpm --filter @breeze/api test:integration-suite-coverage` pass.
- [ ] `pnpm test-stack up`, then `pnpm --filter @breeze/api test:integration src/__tests__/integration/learnedNetworkAssignment.integration.test.ts src/__tests__/integration/learnedNetworksList.integration.test.ts src/__tests__/integration/discoveryNetworkGate.integration.test.ts src/__tests__/integration/discoverySnmpGrants.integration.test.ts` passes, and the output names all four P3 cases (`assignment change racing a dispatch: …`), S1, S2, S6, S7, T2b, both `T4 assign against save` cases and `assign preview counts eligible and outdated agents`.
- [ ] Merge deletes rows across the five tables, so run the contract suites too: `pnpm --filter @breeze/api test:integration src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts`, then `pnpm test-stack down`.
- [ ] `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"` prints `exit=0`.
- [ ] Task 7 is done with a real `X.Y.Z`. The PR is not merged while the version is `999.0.0`.
- [ ] The PR body states: `Closes #<W03c sub-issue>`; that this is the switch, with the release `X.Y.Z` and the W02c PR it contains; that it merges only after W01a, W01b, W03a and W03b are on `main`, and API and workers deploy together (assignment must not be reachable until every API and worker process enforces the gate; the deploy's version-parity assertion covers this); which effects require confirmation (Contract notes, item 3); the red seen for P3, S1, S2, S6, S7, T2b and T4; and that no AI or MCP tool is added.

## Contract notes

1. **`replacementFor`** is `{ networkId, displayName, siteId, siteName }` when set (index F1; Task 1's `ReplacementFor`).
2. **F1 has one `suggestion`, and the list has no paging.** When two sites tie, the suggestion is `null` (Task 1). The list returns every visible network; the 5,000-network cap bounds it, and the aggregates are set-based. If W04 needs paging, it adds a query parameter to F and states it there.
3. **Which effects need confirmation** follows index E12: `gatesSite`, `siteLosesLastNetwork`, `profilesFailingClosed > 0` and `sharedVirtualRouterMac`. §8.5 names the profile and last-network effects; review focus 4 (agent counts before a site is gated) and the §8.5 shared virtual-router warning account for the other two.
4. **`AssignmentEffects.agents`** follows the comment in index E12, computed directly in Task 3 rather than by calling E6 per device: `online` (the site's online agents, not ephemeral, not parked, token not suspended), `onNetwork` (of those, behind one of this network's fingerprints now), `needUpdate` (of `onNetwork`, below the guard version). The eligible count is `onNetwork - needUpdate`.
5. **B2 has no failure code for a job cancelled by gating.** This plan writes status `cancelled` with a message-only `DiscoveryJobError` (`GATING_CANCEL_MESSAGE`) and does not add a code.
6. **New exports beyond E12:** `LearnedNetworkError`, `assignmentNeedsConfirmation`, `renameNetwork`, `setNetworkIgnored` and `GATING_CANCEL_MESSAGE` (`assignment.ts`); `listLearnedNetworks`, `loadNetworkForViewer` and `NetworkViewer` (`list.ts`); `suggestSite`, `findReplacementFor` and `displayNameFor` (`suggestions.ts`).
7. **A merge never takes an assigned source** (`source_assigned`, index plan call 15). The admin unassigns it first, which goes through the confirmation.
8. **Fixture values outside the index list.** `00:00:5e:00:01:0a` is the VRRP prefix §8.5 names; `isSharedVirtualRouterMac` cannot be tested without it (W03a's note 11 says the same). Recommended: add it to the index's fixture list.
9. **T2b's starting state can only come from a fixture.** `profile.network_id` is checked on every save (index plan call 14), so no save produces an unrestricted, credentialed profile whose `network_id` names a network not assigned to its site, yet spec rule 2 names that state. T2b builds it with admin writes.
10. **Merge clears digests (index A8).** Merge step 3 nulls `devices.network_attachment_digest` for every device with a membership on a retired fingerprint or on a fingerprint moved from the source, before the gateway rows change. No other function in this wave deletes or re-points gateway or membership rows.

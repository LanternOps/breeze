# Learned Networks W04: Networks tab, profile form, Profiles notice, Jobs and Assets

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can see every learned network, tell the office from a home, assign, unassign, rename,
ignore, restore and merge networks, stop requiring a network, and see on Profiles, Jobs and Assets what
the network gate did.

**Architecture:** The API gains the read-side fields of index F2 (one loader module, mocked in the route
tests and proven on real Postgres) and one read route for the scan-agent picker. The web adds a seventh
Discovery tab (`#networks`) backed by an F1 mapper, a panel split into list, row and dialog files, and
small changes to the profile form, Profiles list, Jobs list and Assets list. Every mutation goes through
`runAction`; a `409 CONFIRMATION_REQUIRED` opens a dialog built from the response's `effects`.

**Tech stack:** Astro + React islands, Vitest + jsdom + Testing Library, i18next, Hono, Drizzle,
PostgreSQL.

**Spec:** `docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md`
(sections 9, 10, 8.5).

**Index:** `docs/superpowers/plans/monitoring/2026-11-21-learned-networks.md`. Its Global constraints,
Review focus and Cross-wave contract apply to every task here (sections F, F1, F2, G, B2 are used verbatim).

## Wave constraints

- Depends on W03c merged: `routes/discoveryNetworks.ts`, `services/learnedNetworks/{list,assignment,merge}.ts`
  and the shared `types/discoveryNetworkGate.ts` (B2) exist. Before Task 1 run
  `grep -n "discoveryNetworkGate" packages/shared/src/types/index.ts`; the web imports
  `DISCOVERY_GATE_FAILURE_CODES`, `DiscoveryGateFailureCode`, `NoAgentReason`, `IneligibleReason` from
  `@breeze/shared`. If the re-export is missing, add it in Task 1.
- Copy is fixed by the tables at the end of this plan. No user-facing string says "verified location",
  and none contains an em dash. Plurals use `_one` and `_other`. Write `cond ? t('a') : t('b')`.
- `data-testid` values are fixed by the table at the end. Tests query by test id or by exact copy.
- The page fires no new request on mount. New data is fetched by the Networks panel when its tab is open,
  or by loader props the profile form calls. `DiscoveryPage.test.tsx` feeds responses in order with
  `mockResolvedValueOnce`, so an extra mount fetch would break every existing case there.
- Components render through `ResponsiveTable` (desktop table and mobile cards both in the DOM). Scope
  row assertions with `within(screen.getByTestId('responsive-table-desktop'))`.
- Fixtures use only the index's synthetic values, plus the site names `Main Office` and `Warehouse` (as
  W03c's fixtures) and the network name `Main Office LAN`. A shared virtual-router fixture MAC is `00:00:5e:00:01:0a` (the VRRP range).
- Index line numbers checked against this checkout and unchanged: `DiscoveryPage.tsx` `:29`, `:278`,
  `:291`, `:393`, `:458-488`, `:531-546`, `:707`; `DiscoveryJobList.tsx` `:94`, `:135`, `:476-527`;
  `DiscoveredAssetList.tsx` `:167`, `:268-340` (filter state and memos; the chip row renders at
  `:584-669`); `routes/discovery.ts` `:67-78`, `:249`, `:266`, `:402`, `:425`, `:624-645`, `:818-843`,
  `:1091`, `:1103-1246`, `:1372-1491`. Profile detail, create and update return
  `serializeDiscoveryProfile` (`:236`), which spreads the whole row.

## End-to-end decision

**No Playwright spec in this wave. The W05 lab proof is the end-to-end evidence**, and it walks assign,
the gated Profiles notice, unassign and stop requiring in the real UI (W05 legs 2 and 9). Reasons:

1. No existing helper seeds learned networks. `e2e-tests/helpers/` holds topology seeders only, and the
   psql runners in `tests/sites-reachability.spec.ts` and `tests/tenant-isolation.spec.ts` are private
   functions over their own SQL files. A spec needs a new seed fixture.
2. Every action on the tab is behind `requireMfa()`, which passes only when `ENABLE_2FA` is off or the
   session carries `mfa: true` (`apps/api/src/middleware/auth.ts:1173-1176`; default on at
   `routes/auth/schemas.ts:14`). `tests/topology-operations.spec.ts:17` runs with `ENABLE_2FA=false` for
   this reason, and `ci.yml` never sets it, so such a spec would most likely run only on a developer's
   stack. This is inferred: no listed CI spec's MFA-gated write path was traced. The decision rests on
   reason 1.

Every element a future spec needs carries a test id from the table below.

## File structure

| File | Change |
|---|---|
| `apps/api/src/services/learnedNetworks/readFields.ts` | Create. F2 loaders for profiles, jobs and assets. |
| `apps/api/src/services/learnedNetworks/agentNetworkStatus.ts` | Create. Per-agent network status for the scan-agent picker. |
| `apps/api/src/routes/discovery.ts` | Modify list and detail picks (`:624-645`, `:733`), jobs (`:1123-1246`), assets (`:1402-1489`). |
| `apps/api/src/routes/discoveryNetworks.ts` | Modify: add `GET /sites/:siteId/network-agents`. |
| `apps/api/src/services/learnedNetworks/list.ts` | Modify: gateway `vendor` (index F1; contract note 1). Display names reuse W03c's `displayNameFor` (`suggestions.ts`). |
| `apps/api/src/__tests__/integration/learnedNetworkReadFields.integration.test.ts` | Create. |
| `apps/web/src/locales/<8 locales>/discovery.json`, `lib/i18n/learnedNetworksCopy.test.ts` | New keys; plural and copy-rule test. |
| `apps/web/src/components/discovery/learnedNetworkTypes.ts` | Create. F1 types and mapper. |
| `.../discovery/LearnedNetworksPanel.tsx`, `LearnedNetworkRow.tsx`, `LearnedNetworkDialogs.tsx` | Create. Panel owns fetch and every mutation; row and dialogs are presentational. |
| `.../discovery/discoveryJobFailures.ts` | Create. Failure code to sentence. |
| `.../discovery/DiscoveryPage.tsx`, `DiscoveryProfileForm.tsx`, `DiscoveryProfileList.tsx`, `DiscoveryJobList.tsx`, `DiscoveredAssetList.tsx` | Modify. Tests beside each; `DiscoveryJobList.test.tsx` is new. |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | Add the panel to `TARGET_GLOBS` (beside `:395`). |
| `docs/superpowers/plans/monitoring/2026-11-21-learned-networks.md` | No change expected: F, F1 and F2 already carry `vendor`, the `replacementFor` shape, the `sites` rule, the display-name rule and the `network-agents` route. Amend it in the same PR only if this wave changes one of them. |

---

### Task 1: API read fields (F2)

**Files:** create `services/learnedNetworks/readFields.ts`,
`__tests__/integration/learnedNetworkReadFields.integration.test.ts`; modify `routes/discovery.ts`,
`routes/discovery.test.ts`, `services/learnedNetworks/list.ts`.

**Interfaces (produces):**

```ts
export type ProfileNetworkReadFields = {
  snmpGrantNetworks: Array<{ networkId: string; name: string }>;   // name = display name, never null
  networkRequired: boolean;                                         // sites.discovery_network_required
};
export async function loadProfileNetworkReadFields(
  profiles: ReadonlyArray<{ id: string; siteId: string }>): Promise<Map<string, ProfileNetworkReadFields>>;
export async function loadNetworkDisplayNames(networkIds: readonly string[]): Promise<Map<string, string>>;
// true: last_network_id is a network assigned to the asset's site. false: the site is gated and it is not.
// null: no site, or the site is not gated.
export async function loadAssetAssignedNetworkStatus(
  assets: ReadonlyArray<{ id: string; siteId: string | null; lastNetworkId: string | null }>,
): Promise<Map<string, boolean | null>>;
```

A network is in `snmpGrantNetworks` when at least one of its fingerprints has a grant for the profile.
Display name everywhere is the one W03c builds for F1 `displayName` (`name`, else `"<prefix> via
<gateway>"`): call W03c's `displayNameFor({ name, prefix, gatewayAddresses })` from
`services/learnedNetworks/suggestions.ts`, passing gateway addresses in `first_seen_at` order. Each loader
issues one query for the whole batch (no per-row query).

Response additions (explicit picks):

| Route | Adds |
|---|---|
| `GET /profiles` (`:624-645`) and `GET /profiles/:id` (`:733`) | `networkId`, `snmpGrantMode`, `snmpGrantNetworks`, `networkRequired`. Detail already spreads `networkId` and `snmpGrantMode`; add the other two. |
| `GET /jobs` real rows (`:1123-1176`) | `networkId`, `networkName` (from `loadNetworkDisplayNames`, null when no network), `crossNetworkAssetUpdates`; `errors` passes through unchanged (stored as `DiscoveryJobError`). |
| `GET /jobs` synthetic pending rows (`:1225-1241`) | `networkId: null`, `networkName: null`, `crossNetworkAssetUpdates: null`. |
| `GET /assets` (`:1444-1489`) | `seenOnAssignedNetwork` from `loadAssetAssignedNetworkStatus`, `null` when absent from the map. The single-asset route is unchanged; `mapAsset` tolerates the field missing. |

`list.ts` gateway objects gain `vendor: string | null` from `lookupMacVendor` (`services/macVendorLookup.ts:8`).

- [ ] **Step 1: Write the failing route tests** in `routes/discovery.test.ts`. Mock
  `../services/learnedNetworks/readFields` at module level the way `assetReachabilityLoader` is mocked
  (`:25-29`), driving each map per test.

```ts
it('profile list and detail carry networkId, snmpGrantMode, snmpGrantNetworks and networkRequired', async () => {
  // loader returns { snmpGrantNetworks: [{ networkId: NET_A, name: 'Main Office LAN' }], networkRequired: true }
  expect(listBody.data[0]).toMatchObject({ networkId: NET_A, snmpGrantMode: 'bound',
    snmpGrantNetworks: [{ networkId: NET_A, name: 'Main Office LAN' }], networkRequired: true });
  expect(detailBody).toMatchObject({ networkId: NET_A, snmpGrantMode: 'bound', networkRequired: true });
});
it('jobs list carries network fields and the coded error unchanged', async () => {
  expect(job).toMatchObject({ networkId: NET_A, networkName: '192.168.1.0/24 via 192.168.1.1',
    crossNetworkAssetUpdates: 3,
    errors: { code: 'no_agent_on_network', reason: 'none_on_network', message: 'No eligible agent' } });
});
it('synthetic pending job rows carry null network fields', async () => {
  expect(pending).toMatchObject({ id: `next-${PROFILE_ID}`, networkId: null, networkName: null, crossNetworkAssetUpdates: null });
});
it('asset list carries seenOnAssignedNetwork, null when the loader has no entry', async () => {
  expect(byId.get('asset-a').seenOnAssignedNetwork).toBe(false);
  expect(byId.get('asset-b').seenOnAssignedNetwork).toBeNull();
});
```

- [ ] **Step 2: Write the failing integration test** `learnedNetworkReadFields.integration.test.ts`
  (real Postgres, one org, sites `Main Office` (gated) and a second site (not gated), networks
  `192.168.1.0/24` via `192.168.1.1` / `a4:2b:b0:11:22:9c` named `Main Office LAN` and assigned, and
  `192.168.1.0/24` via `192.168.1.1` / `3c:37:86:aa:bb:10` unnamed and unassigned):

```ts
it('snmpGrantNetworks names each network holding a granted fingerprint, display name when unnamed');
  // grants on both fingerprints -> [{ name: 'Main Office LAN' }, { name: '192.168.1.0/24 via 192.168.1.1' }]
it('networkRequired follows sites.discovery_network_required');
  // a profile on Main Office -> true; a profile on the second site -> false
it('seenOnAssignedNetwork is true, false or null by site gating and last network');
  // gated site: last network assigned -> true; other network -> false; none -> false
  // site not gated -> null for every asset
it('jobs read the display name of the network they scanned');
  // loadNetworkDisplayNames([assigned, unnamed]) -> 'Main Office LAN' and '192.168.1.0/24 via 192.168.1.1'
```

- [ ] **Step 3: Run both and see them fail.**
  `cd apps/api && npx vitest run src/routes/discovery.test.ts`: FAIL on the new cases.
  `pnpm test-stack up && pnpm --filter @breeze/api test:integration src/__tests__/integration/learnedNetworkReadFields.integration.test.ts`:
  FAIL (module not found).
- [ ] **Step 4: Implement** `readFields.ts`, the picks above and `vendor`. Register the integration file
  if `test:integration-suite-coverage` asks.
- [ ] **Step 5: Run and see pass:** the two commands above, plus
  `pnpm --filter @breeze/api test:integration-suite-coverage`. Then `pnpm test-stack down`.
- [ ] **Step 6: Commit** `feat(api): learned network read fields on profiles, jobs and assets`.

### Task 2: API scan-agent network status

**Files:** create `services/learnedNetworks/agentNetworkStatus.ts`; modify `routes/discoveryNetworks.ts`,
its test, `__tests__/parkedFanoutModules.ts`; extend the Task 1 integration file.

**Interfaces (produces):**

```ts
// Index F: per agent, on an allowed network or the IneligibleReason from E6.
export type AgentNetworkStatus = 'on_network' | Extract<IneligibleReason, 'offline' | 'needs_update' | 'not_on_network'>;
export async function loadSiteAgentNetworkStatus(input: {
  orgId: string; siteId: string; networkId: string | null; now: Date;
}): Promise<Array<{ deviceId: string; status: AgentNetworkStatus }>>;
```

Route: `GET /discovery/sites/:siteId/network-agents?networkId=<uuid>&orgId=<uuid>`, `devices:read`,
site access required (403 otherwise), response `{ data: [{ deviceId, status }] }`. No second
eligibility rule: the service resolves the allowed gateway ids (fingerprints of `networkId` when it is
assigned to the site, else of every network assigned to the site), calls E6
`loadEligibleGuardedAgents({ orgId, siteId, allowedGatewayIds, commandType: DISCOVERY_SCAN_FAMILY, limit: 500 })`
(`DISCOVERY_SCAN_FAMILY` from W03a's `scanCommand.ts`; a `'network_discovery'` literal in this file would fail
W03a's `scanCommand.contract.test.ts`)
and marks those `on_network`. Every other device of the site that is not ephemeral and not parked gets the
`IneligibleReason` E6's `explainGuardedAgent` would give it, decided in one query in the same order:
`offline` (not online, or its agent token is suspended), then `needs_update`
(`agentSupportsGuardedCommand(DISCOVERY_SCAN_FAMILY, agentVersion)` is false), else `not_on_network`.
Ephemeral and parked devices, and devices of other sites, are not listed, so `not_found`, `other_site`,
`ephemeral` and `parked` never occur here.

- [ ] **Step 1: Failing tests.** Route test: `network-agents answers 403 for a site outside the caller's
  allowlist` and `network-agents passes networkId through and returns the service rows`. Integration:

```ts
it('network-agents: E6-eligible devices are on_network, the rest carry the E6 reason');
  // gated Main Office with the assigned network: DESKTOP-01 999.0.0 current and fresh -> on_network;
  // LAPTOP-JS 999.0.0 behind the unassigned fingerprint -> not_on_network; a '0.1.0' agent behind the
  // assigned fingerprint -> needs_update; an offline 999.0.0 agent -> offline; an ephemeral device -> absent
it('network-agents: a networkId narrows the allowed gateway ids passed to E6');
  // two assigned networks; networkId = the second -> loadEligibleGuardedAgents gets only its gateway ids
```

- [ ] **Step 2: Run, see fail:** `cd apps/api && npx vitest run src/routes/discoveryNetworks.test.ts`
  and the integration command from Task 1.
- [ ] **Step 3: Implement**, and add `'services/learnedNetworks/agentNetworkStatus.ts'` to
  `FANOUT_MODULES` with `guards` equal to its `notParkedDeviceCondition(` calls (1 for the one query over the
  site's other devices) and reason `scan-agent picker network status`.
- [ ] **Step 4: Run, see pass:** the commands above plus
  `cd apps/api && npx vitest run src/__tests__/parkedFanout.contract.test.ts` and
  `pnpm -F @breeze/api test:site-scope-coverage`.
- [ ] **Step 5: Commit** `feat(api): scan-agent network status for the discovery profile form`.

### Task 3: Locale keys in all eight locales

**Files:** `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/discovery.json`;
create `apps/web/src/lib/i18n/learnedNetworksCopy.test.ts`; modify `translationCoverage.test.ts`.

Keys and English values: the copy tables at the end. Translate every value (follow
`locales/TERMINOLOGY.md`: site, agent, policy terms; keep `{{...}}`, `VRRP`, `HSRP`, `SNMP`, `WAN`).
`learnedNetworks.row.wan` stays identical to English (acronym plus an address). Raise each locale's
`discovery.json` cap by exactly what the coverage test reports, with one comment per key naming why it
is identical; translate any other identical value instead of raising the cap.

- [ ] **Step 1: Failing test** `learnedNetworksCopy.test.ts`:

```ts
const PLURALS = ['learnedNetworks.row.wanEarlier', 'learnedNetworks.row.recentDevices',
  'learnedNetworks.row.bySite', 'learnedNetworks.row.onItNow', 'learnedNetworks.row.devicesOnItNow',
  'learnedNetworks.row.usedByProfiles', 'learnedNetworks.confirm.agents', 'learnedNetworks.confirm.needUpdate',
  'learnedNetworks.confirm.profilesFailingClosed', 'discoveryJobList.crossNetwork'];
it.each(PLURALS)('%s has _one and _other with {{count}} in every locale', ...);
it('no new English value contains an em dash or "verified location"', () => {
  // walk en learnedNetworks, discoveryProfileForm.network, discoveryJobList.failures,
  // discoveryProfileList.networkNotice*, discoveredAssetList.filters.notOnAssignedNetwork
  expect(value.includes(String.fromCharCode(0x2014))).toBe(false); // no em dash
  expect(value.toLowerCase()).not.toContain('verified location');
});
```

- [ ] **Step 2: Run, see fail:** `cd apps/web && npx vitest run src/lib/i18n/learnedNetworksCopy.test.ts`.
- [ ] **Step 3: Add the keys** to all eight files.
- [ ] **Step 4: Run, see pass:** `cd apps/web && npx vitest run src/lib/i18n src/locales` (parity,
  coverage, terminology, extraction quality, key usage, plurals).
- [ ] **Step 5: Commit** `feat(web): learned network strings in all eight locales`. The PR body carries
  both machine-draft lines from `apps/web/src/locales/README.md`.

### Task 4: F1 types and mapper

**Files:** create `components/discovery/learnedNetworkTypes.ts` and `learnedNetworkTypes.test.ts`.

**Interfaces (produces):**

```ts
// LearnedNetwork, LearnedNetworkGateway, LearnedNetworkWanAddress, LearnedNetworkDevices,
// LearnedNetworkSite mirror F1 field for field, with two additions: gateway `vendor: string | null`
// (contract note 1) and `replacementFor: { networkId: string; displayName: string; siteId: string; siteName: string } | null`
// (index F1, note 3).
export type LearnedNetworkState = 'needs_review' | 'assigned' | 'ignored';
export type LearnedNetworkList = { networks: LearnedNetwork[]; sites: LearnedNetworkSite[]; limitReached: boolean };
export type AssignmentEffectsView = { gatesSite: boolean; profilesPointed: number; profilesFailingClosed: number;
  siteLosesLastNetwork: boolean; agents: { online: number; onNetwork: number; needUpdate: number };
  sharedVirtualRouterMac: boolean };                       // index E12 AssignmentEffects, on the web
export type LearnedNetworkMergeMode = 'additional_gateway' | 'replaces_gateway';
export function mapLearnedNetworkList(raw: unknown): LearnedNetworkList;
export function parseAssignmentEffects(body: unknown): AssignmentEffectsView | null;  // reads body.effects
```

- [ ] **Step 1: Failing tests.** `F1_FIXTURE` is the index F1 JSON with real values (two networks from the
  fixture list, one assigned to `Main Office`, gateway `vendor: 'TP-Link'` on one and `null` on the other,
  `replacementFor: { networkId, displayName: 'Main Office LAN', siteId, siteName: 'Main Office' }` on the
  unassigned one).

```ts
it('a full F1 response round-trips with every field kept', () => {
  expect(mapLearnedNetworkList(F1_FIXTURE)).toEqual(
    { networks: F1_FIXTURE.data, sites: F1_FIXTURE.sites, limitReached: false });
});
it('drops a row whose state is not one of the three and keeps the rest');
  // F1_FIXTURE plus a row with state 'archived' -> networks equals F1_FIXTURE.data
it('a missing vendor maps to null');
  // a gateway without the vendor key -> vendor: null
it('parseAssignmentEffects reads effects from a 409 body and returns null without one');
  // { code: 'CONFIRMATION_REQUIRED', effects: E } -> E; {} and { effects: { gatesSite: 'yes' } } -> null
```

- [ ] **Step 2: Run, see fail:** `cd apps/web && npx vitest run src/components/discovery/learnedNetworkTypes.test.ts`.
- [ ] **Step 3: Implement.** Hand-written guards, no new dependency.
- [ ] **Step 4: Run, see pass.** **Step 5: Commit** `feat(web): learned network types and mapper`.

### Task 5: Networks panel, read-only states

**Files:** create `LearnedNetworksPanel.tsx`, `LearnedNetworkRow.tsx`, `LearnedNetworksPanel.test.tsx`.

**Interfaces:**

```ts
export type LearnedNetworksPanelProps = { currentOrgId: string | null };          // default export
export type LearnedNetworkRowProps = {
  network: LearnedNetwork; sites: LearnedNetworkSite[]; busy: boolean;
  onAssign: (network: LearnedNetwork, siteId: string) => void;
  onUnassign: (network: LearnedNetwork) => void;
  onRename: (network: LearnedNetwork, name: string | null) => void;
  onIgnore: (network: LearnedNetwork) => void;
  onRestore: (network: LearnedNetwork) => void;
  onMerge: (target: LearnedNetwork) => void;
  onMergeReplacement: (source: LearnedNetwork, targetNetworkId: string) => void;
};                                                                                 // default export
```

The panel fetches `GET /discovery/networks?orgId=<currentOrgId>` on mount and after every successful
mutation, and maps with `mapLearnedNetworkList`. Groups in order: Needs review, Assigned, Ignored
(collapsed until its toggle is pressed). Row layout follows spec 9's sketch:

- Line 1: for an assigned network the site name first; then `displayName`; then per gateway its MAC and,
  when not null, its vendor; then `row.wan` with the newest WAN address by `lastSeenAt` and, when there
  are more, `row.wanEarlier` with the count of the others.
- Line 2 (evidence), parts joined by ` · `. Needs review and Ignored: `row.recentDevices` (or
  `row.oneRecentDevice` when `recentCount === 1` and `sample[0].hostname` is set), each `bySite` entry
  as `row.bySite`, then `row.onItNow` or `row.notOnItNow`. Assigned: `row.devicesOnItNow`, then
  `row.usedByProfiles` when `profileCount > 0`.
- Line 3: `row.suggestion` when `suggestion` is set; `row.replacementFor` with the
  `actions.mergeReplacement` button when `replacementFor` is set; `row.sharedMac` when any gateway has
  `sharedVirtualRouterMac`.
- Actions: Needs review: site select, Assign, Ignore. Assigned: Rename, Merge, Unassign. Ignored: Restore.
- Above the groups: `limitReached` notice; one banner per `sites[]` entry with `networkRequired &&
  assignedNetworkCount === 0` (`siteNoNetwork` text and the Stop requiring button).

- [ ] **Step 1: Failing tests** (fetch mocked as in `DiscoveryPage.test.tsx:9-11`; F1 fixture from Task 4
  with `recentCount: 5, currentCount: 3, bySite: [{ siteName: 'Main Office', count: 4 }]` on the first
  row, `recentCount: 1, currentCount: 0, sample: [{ hostname: 'LAPTOP-JS' }]` on the second, an assigned
  row with `currentCount: 7, profileCount: 2` and three WAN addresses, and two ignored rows):

```ts
it('groups rows into Needs review (2), Assigned (1) and a collapsed Ignored (2)', () => {
  expect(screen.getByTestId('learned-networks-group-needs-review')).toHaveTextContent('Needs review (2)');
  expect(screen.queryByTestId(`learned-network-row-${IGNORED_1}`)).toBeNull();
  fireEvent.click(screen.getByTestId('learned-networks-ignored-toggle'));
  expect(screen.getByTestId(`learned-network-row-${IGNORED_1}`)).toBeInTheDocument();
});
it('evidence lines read as spec 9', () => {
  expect(screen.getByTestId(`learned-network-evidence-${NET_1}`))
    .toHaveTextContent('5 devices in the last 14 days · 4 assigned to Main Office · 3 on it now');
  expect(screen.getByTestId(`learned-network-evidence-${NET_2}`))
    .toHaveTextContent('1 device in the last 14 days (LAPTOP-JS) · not on it now');
  expect(screen.getByTestId(`learned-network-evidence-${NET_ASSIGNED}`))
    .toHaveTextContent('7 devices on it now · used by 2 profiles');
  expect(screen.getByTestId(`learned-network-row-${NET_ASSIGNED}`)).toHaveTextContent('WAN 203.0.113.20 (+2 earlier)');
});
it('shows the suggestion, the replacement hint and the shared virtual-router warning', () => {
  expect(screen.getByTestId(`learned-network-suggestion-${NET_1}`)).toHaveTextContent('Likely Main Office');
  expect(screen.getByTestId(`learned-network-replacement-${NET_2}`)).toHaveTextContent('Looks like a replacement for Main Office LAN');
  expect(screen.getByTestId(`learned-network-shared-mac-${NET_VRRP}`)).toBeInTheDocument();   // MAC 00:00:5e:00:01:0a
});
it('shows the limit notice when limitReached is true');
  // limitReached true -> learned-networks-limit-reached has the limitReached copy; false -> absent
it('shows loading, then error with a retry that refetches, then empty');
  // pending fetch -> learned-networks-loading; reject -> learned-networks-error; click -retry -> fetch called twice;
  // { data: [], sites: [], limitReached: false } -> learned-networks-empty
it('a gated site with no network shows its banner and Stop requiring button');
  // sites [{ siteId: S, siteName: 'Main Office', networkRequired: true, assignedNetworkCount: 0 }]
  // -> learned-networks-site-no-network-S reads 'Main Office requires a network but has none assigned...';
  // learned-networks-stop-requiring-S present; a site with assignedNetworkCount 1 gets no banner
```

- [ ] **Step 2: Run, see fail:** `cd apps/web && npx vitest run src/components/discovery/LearnedNetworksPanel.test.tsx`.
- [ ] **Step 3: Implement** the panel's fetch and grouping and the row. No mutation yet.
- [ ] **Step 4: Run, see pass.** **Step 5: Commit** `feat(web): Networks panel groups and evidence`.

### Task 6: Networks panel, actions and confirmations

**Files:** create `LearnedNetworkDialogs.tsx`; modify `LearnedNetworksPanel.tsx`, its test,
`apps/web/src/lib/__tests__/no-silent-mutations.test.ts`.

**Interfaces:**

```ts
export type PendingConfirmation =
  | { kind: 'assign'; network: LearnedNetwork; siteId: string; siteName: string; effects: AssignmentEffectsView }
  | { kind: 'unassign'; network: LearnedNetwork; effects: AssignmentEffectsView }
  | { kind: 'stopRequiring'; site: LearnedNetworkSite };
export function NetworkConfirmDialog(props: { pending: PendingConfirmation | null; busy: boolean;
  onCancel: () => void; onConfirm: () => void }): JSX.Element;               // wraps shared ConfirmDialog
export function MergeNetworksDialog(props: {
  target: LearnedNetwork | null; candidates: LearnedNetwork[];
  preset?: { sourceNetworkId: string; mode: LearnedNetworkMergeMode };
  busy: boolean; onCancel: () => void;
  onConfirm: (input: { sourceNetworkId: string; mode: LearnedNetworkMergeMode; retiredGatewayIds: string[] }) => void;
}): JSX.Element;
```

Every request is `runAction({ request, errorFallback, successMessage, onUnauthorized, suppressErrorToast })`
with the routes of index F. Assign and unassign first post without `confirmed`, with
`suppressErrorToast: (status, code) => status === 409 && code === 'CONFIRMATION_REQUIRED'`. On that
`ActionError`, `parseAssignmentEffects(err.body)` builds the pending confirmation; Confirm re-posts with
`confirmed: true`. A 200 on the first post skips the dialog. Rename sends `{ name: trimmed || null }`.
Merge candidates are all other networks; for `replaces_gateway` the dialog lists the target's gateways
as checkboxes and keeps Merge disabled until one is ticked. Merge as replacement opens the dialog with
target `replacementFor.networkId`, source the row, mode `replaces_gateway`. Stop requiring always
confirms, then posts `{ confirmed: true }`. Caller catch pattern from CLAUDE.md (`ActionError` 401
returns; other `ActionError`s are already toasted).

Assign dialog lines, in order and only when their condition holds (keys in the copy table):
`confirm.gatesSite` (gatesSite); `confirm.agents` with `count = agents.online`, `onNetwork` (onNetwork >
0) or `confirm.noAgentOnNetwork` (onNetwork = 0); `confirm.needUpdate` with `count = agents.needUpdate`
(> 0); `confirm.credentials` (gatesSite); `confirm.profilesFailingClosed` (> 0); `confirm.lastNetwork`
with the network's current `siteName` (siteLosesLastNetwork); `row.sharedMac`
(sharedVirtualRouterMac). Unassign dialog: `confirm.profilesFailingClosed`, `confirm.lastNetwork`, then
`confirm.unassignKeepsGate` when the site loses its last network.

- [ ] **Step 1: Failing tests** (effects fixture `{ gatesSite: true, profilesPointed: 0,
  profilesFailingClosed: 0, siteLosesLastNetwork: false, agents: { online: 4, onNetwork: 2, needUpdate: 1 },
  sharedVirtualRouterMac: false }`):

```ts
it('assign that answers 200 posts { siteId } and toasts without a dialog');
  // lastBody(assign) === { siteId: SITE_MAIN }; learned-network-confirm-dialog absent; success toast shown; list refetched
it('assign that answers 409 CONFIRMATION_REQUIRED opens the dialog from effects and does not toast an error', async () => {
  expect(screen.getByTestId('learned-network-confirm-dialog')).toHaveTextContent(
    '2 of 4 online agents at Main Office are on this network now.');
  expect(screen.getByTestId('learned-network-effect-need-update')).toHaveTextContent(
    '1 online agent at Main Office needs an update before it can run these scans.');
  expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  fireEvent.click(screen.getByTestId('learned-network-confirm-submit'));
  expect(lastBody('/discovery/networks/NET_1/assign')).toEqual({ siteId: SITE_MAIN, confirmed: true });
});
it('with no agent on the network the dialog says scans will fail until one is');
  // effects.agents.onNetwork 0 -> learned-network-effect-agents reads the confirm.noAgentOnNetwork sentence
it('a 409 whose only effect is a shared virtual-router MAC shows the warning and re-posts confirmed', async () => {
  // effects { gatesSite: false, profilesPointed: 0, profilesFailingClosed: 0, siteLosesLastNetwork: false,
  //           agents: { online: 2, onNetwork: 2, needUpdate: 0 }, sharedVirtualRouterMac: true }
  expect(screen.getByTestId('learned-network-effect-shared-mac')).toHaveTextContent('shared virtual-router MAC');
  expect(screen.queryByTestId('learned-network-effect-gates')).toBeNull();
  fireEvent.click(screen.getByTestId('learned-network-confirm-submit'));
  expect(lastBody(`/discovery/networks/${NET_VRRP}/assign`)).toEqual({ siteId: SITE_MAIN, confirmed: true });
});
it('an assign confirmation for a move lists failing profiles and the last-network effect', async () => {
  // The panel offers Assign only on Needs review rows, so render NetworkConfirmDialog directly with
  // pending { kind: 'assign', network: NET_ASSIGNED (on Main Office), siteId: SITE_B, siteName: 'Warehouse',
  //   effects: { gatesSite: false, profilesPointed: 2, profilesFailingClosed: 2, siteLosesLastNetwork: true,
  //              agents: { online: 1, onNetwork: 1, needUpdate: 0 }, sharedVirtualRouterMac: false } }
  expect(screen.getByTestId('learned-network-effect-profiles')).toHaveTextContent('2 profiles point at this network');
  expect(screen.getByTestId('learned-network-effect-last-network')).toHaveTextContent('Main Office will have no network left.');
  expect(screen.queryByTestId('learned-network-effect-gates')).toBeNull();
});
it('unassign lists failing profiles and the last-network effect, then re-posts confirmed', async () => {
  expect(screen.getByTestId('learned-network-effect-keeps-gate')).toHaveTextContent('Main Office still requires a network after this.');
  expect(lastBody(`/discovery/networks/${NET_ASSIGNED}/unassign`)).toEqual({ confirmed: true });
});
it('rename sends null for an empty name');
  // rename input '   ' then save -> lastBody(PATCH /discovery/networks/NET_ASSIGNED) === { name: null }
it('ignore and restore post to their routes and refetch');
  // -ignore-NET_1 -> POST /discovery/networks/NET_1/ignore; -restore-IGNORED_1 -> .../restore; GET called after each
it('merge as an additional gateway posts sourceNetworkId and mode');
  // -> lastBody(POST /discovery/networks/NET_ASSIGNED/merge) === { sourceNetworkId: NET_2, mode: 'additional_gateway',
  //    retiredGatewayIds: [] } (W03c's schema accepts an empty list for this mode); the retire checkboxes are not shown
it('merge replacing a gateway keeps Merge disabled until a gateway is ticked, then posts retiredGatewayIds', async () => {
  expect(screen.getByTestId('learned-network-merge-submit')).toBeDisabled();
  fireEvent.click(screen.getByTestId(`learned-network-merge-retire-${GW_A}`));
  fireEvent.click(screen.getByTestId('learned-network-merge-submit'));
  expect(lastBody(`/discovery/networks/${NET_ASSIGNED}/merge`)).toEqual(
    { sourceNetworkId: NET_2, mode: 'replaces_gateway', retiredGatewayIds: [GW_A] });
});
it('merge as replacement presets target, source and replaces_gateway from replacementFor');
  // -merge-replacement-NET_2 -> merge dialog open with target replacementFor.networkId, source NET_2,
  //    -merge-mode-replaces checked, submit disabled until a retire box is ticked
it('stop requiring confirms, then posts { confirmed: true }');
  // -stop-requiring-S -> dialog with confirm.stopRequiringBody; nothing posted until submit;
  //    then lastBody(POST /discovery/sites/S/stop-requiring-network) === { confirmed: true }
```

  Add `'src/components/discovery/LearnedNetworksPanel.tsx'` to `TARGET_GLOBS` next to `:395`.
- [ ] **Step 2: Run, see fail:** `cd apps/web && npx vitest run src/components/discovery/LearnedNetworksPanel.test.tsx src/lib/__tests__/no-silent-mutations.test.ts`.
- [ ] **Step 3: Implement** the dialogs and the handlers. Keep each file under about 500 lines.
- [ ] **Step 4: Run, see pass.** **Step 5: Commit** `feat(web): assign, merge and stop requiring on the Networks tab`.

### Task 7: Job failures, Network column, cross-network count

**Files:** create `discoveryJobFailures.ts`, `discoveryJobFailures.test.ts`, `DiscoveryJobList.test.tsx`;
modify `DiscoveryJobList.tsx`.

**Interfaces:**

```ts
// discoveryJobFailures.ts. One literal t() key per case (a switch, no template keys).
export function describeJobFailure(
  input: { code: DiscoveryGateFailureCode | null; reason: string | null; message: string | null },
  t: TFunction): string | null;      // unknown or missing code: the server message
// DiscoveryJobList.tsx: export mapJob; DiscoveryJob gains
//   networkId: string | null; networkName: string | null; crossNetworkAssetUpdates: number | null;
//   errorCode: DiscoveryGateFailureCode | null; errorReason: NoAgentReason | IneligibleReason | null;
// ApiDiscoveryJob gains networkId?, networkName?, crossNetworkAssetUpdates?, and errors may be
//   { message: string; code?: string; reason?: string }.
```

A Network column follows Status (`colSpan` 10 → 11; pending rows show the existing empty-cell placeholder). The cell shows `networkName`
and, when `crossNetworkAssetUpdates > 0`, `crossNetwork` with `crossNetworkHint` as its `title`. The
status cell shows `describeJobFailure(...)` in place of the raw message.

- [ ] **Step 1: Failing tests.**

```ts
// discoveryJobFailures.test.ts, t = i18n.getFixedT('en', 'discovery')
it.each(DISCOVERY_GATE_FAILURE_CODES)('%s maps to its sentence, not the raw message or a key', (code) => {
  const text = describeJobFailure({ code, reason: null, message: 'raw' }, t);
  expect(text).not.toBe('raw'); expect(text).not.toMatch(/^discoveryJobList\./);
});
it.each(['none_online', 'none_on_network', 'agents_need_update'])('no_agent_on_network + %s has its own sentence');
  // equals the copy-table sentence for that reason, and differs from the no-reason noAgentOnNetwork sentence
it.each(['not_found', 'other_site', 'offline', 'ephemeral', 'parked', 'not_on_network', 'needs_update'])(
  'agent_not_eligible + %s has its own sentence');
  // equals the copy-table sentence for that reason, and differs from the no-reason agentNotEligible sentence
it('agents_need_update reads "Agents here need updating..."', () => {
  expect(describeJobFailure({ code: 'no_agent_on_network', reason: 'agents_need_update', message: null }, t))
    .toBe('Agents here need updating. Update the agents at this site to the current version, then run the scan again.');
});
it('falls back to the server message for a missing or unknown code');
  // { code: null, message: 'raw' } and { code: 'something_new', message: 'raw' } -> 'raw'; no message -> null
// DiscoveryJobList.test.tsx (fetch mocked)
it('mapJob keeps code, reason, networkId, networkName and crossNetworkAssetUpdates');
  // API job with errors { code: 'no_agent_on_network', reason: 'none_online', message: 'm' } -> errorCode,
  // errorReason set; networkId/networkName/crossNetworkAssetUpdates copied; missing ones -> null
it('a failed job shows the failure sentence in place of the raw message');
  // discovery-job-error-j1 has the noAgentNoneOnline sentence and not the server message
it('the Network column shows the network name and the cross-network count', () => {
  expect(desktop().getByTestId('discovery-job-network-j1')).toHaveTextContent('Main Office LAN');
  expect(desktop().getByTestId('discovery-job-cross-network-j1'))
    .toHaveTextContent('3 devices were last seen by a scan on another network');
});
it('a pending row shows a dash in the Network column');
  // synthetic next-<profileId> row -> its Network cell shows the existing empty-cell placeholder
it('a job with an uncoded error still shows its message');
  // errors { message: GATING_CANCEL_MESSAGE } (no code) -> discovery-job-error-<id> shows that message
```

- [ ] **Step 2: Run, see fail:** `cd apps/web && npx vitest run src/components/discovery/discoveryJobFailures.test.ts src/components/discovery/DiscoveryJobList.test.tsx`.
- [ ] **Step 3: Implement.** **Step 4: Run, see pass.**
- [ ] **Step 5: Commit** `feat(web): job failure sentences and the network scanned`.

### Task 8: Profile form: Network select, agent marks, credential notice

**Files:** modify `DiscoveryProfileForm.tsx`, `DiscoveryProfileForm.test.tsx`.

**Interfaces (produces, used by Task 10):** exported from `DiscoveryProfileForm.tsx`:

```ts
export type SiteNetworkOption = { id: string; displayName: string; prefix: string | null };
export type SiteNetworkOptions = { networkRequired: boolean; networks: SiteNetworkOption[] };
export type AgentNetworkStatus = 'on_network' | 'offline' | 'not_on_network' | 'needs_update';   // Task 2's values
export type SavedCredentialBinding = { mode: 'unrestricted' | 'bound'; networks: Array<{ networkId: string; name: string }> };
```

`DiscoveryProfileFormValues` gains `networkId?: string` (`''` = any). New props:
`loadSiteNetworks?: (siteId: string) => Promise<SiteNetworkOptions>`,
`loadAgentNetworkStatus?: (siteId: string, networkId: string) => Promise<Record<string, AgentNetworkStatus>>`,
`savedCredentialBinding?: SavedCredentialBinding`.

- The Network select shows only when the chosen site's `networkRequired` is true; first option
  `network.any` (value `''`), then each network's `displayName`. Help text `network.helpAny` or
  `network.helpOne`. Changing the site clears `networkId` (restored when returning to the original site,
  as the pin does at `:306-312`).
- Choosing a network whose `prefix` is set and differs from the range text shows the `network.fillRange`
  button; pressing it replaces the range text with the prefix.
- On a gated site the scan-agent options are labelled `network.agentNotOnNetwork` or
  `network.agentNeedsUpdate` by status; an `offline` status keeps the picker's existing offline label and
  adds nothing. Reload on site or network change.
- With `savedCredentialBinding.mode === 'bound'`: `network.credentialsBound` with the names joined by
  `Intl.ListFormat` in the active language, or `network.credentialsNowhere` when the list is empty; plus
  one `network.credentialsNotSentOn` line per network of the site that is not in the list.

- [ ] **Step 1: Failing tests.**

```ts
it('shows the Network select only for a gated site, defaulting to Any of this site\'s networks');
  // loadSiteNetworks -> { networkRequired: false } -> discovery-profile-network-select absent;
  // { networkRequired: true, networks: [NET_A] } -> select present, value '', first option "Any of this site's networks"
it('offers to fill the range from the chosen network prefix', () => {
  fireEvent.click(screen.getByTestId('discovery-profile-network-fill-range'));
  expect(screen.getByDisplayValue('192.168.1.0/24')).toBeInTheDocument();
});
it('marks scan agents that are not on an allowed network or need an update', () => {
  expect(screen.getByRole('option', { name: 'LAPTOP-JS (not on an allowed network)' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'DESKTOP-01 (needs an agent update)' })).toBeInTheDocument();
});
it('names the networks saved credentials are bound to and the ones they are not sent on', () => {
  expect(screen.getByTestId('discovery-profile-credentials-binding')).toHaveTextContent(
    'Saved SNMP credentials are sent only on: Main Office LAN.');
  expect(screen.getByTestId('discovery-profile-credentials-not-sent-NET_B')).toHaveTextContent(
    'Saved SNMP credentials are not sent on 10.1.2.0/24 via 10.1.2.100 until they are re-entered.');
});
it('submits networkId, and clears it when the site changes');
  // choose NET_A, submit -> onSubmit values.networkId === NET_A; change site -> '' ; back to the original site -> NET_A
```

- [ ] **Step 2: Run, see fail:** `cd apps/web && npx vitest run src/components/discovery/DiscoveryProfileForm.test.tsx`.
- [ ] **Step 3: Implement.** **Step 4: Run, see pass.**
- [ ] **Step 5: Commit** `feat(web): profile network select and credential binding notice`.

### Task 9: Profiles notice and Assets filter

**Files:** modify `DiscoveryProfileList.tsx`, `DiscoveredAssetList.tsx` and their tests.

**Interfaces:** `DiscoveryProfileList` prop `ungatedSites?: Array<{ siteId: string; siteName: string }>`;
each renders `networkNotice` and a link `<a href="#networks">` with `networkNoticeLink`.
`DiscoveredAsset` and `ApiDiscoveryAsset` gain `seenOnAssignedNetwork?: boolean | null`; `mapAsset`
keeps it (`undefined` maps to `null`, so the detail fetch at `DiscoveryPage.tsx:382` is unaffected). A
toggle chip `filters.notOnAssignedNetwork` with the count of assets whose value is `false` shows only
when that count is above 0, and filters to them.

- [ ] **Step 1: Failing tests.**

```ts
it('shows one notice per site that is not gated, linking to #networks', () => {
  expect(screen.getByTestId('discovery-profile-site-network-link-site-1')).toHaveAttribute('href', '#networks');
});
it('mapAsset keeps seenOnAssignedNetwork and maps a missing value to null');
  // true -> true, false -> false, null -> null, key absent -> null
it('the Not seen on an assigned network chip counts and filters assets with false', () => {
  expect(screen.getByTestId('discovered-assets-filter-not-on-assigned-network')).toHaveTextContent(
    'Not seen on an assigned network1');
});
it('the chip is hidden when no asset is false');
  // assets with true and null only -> discovered-assets-filter-not-on-assigned-network absent
```

- [ ] **Step 2: Run, see fail:** `cd apps/web && npx vitest run src/components/discovery/DiscoveryProfileList.test.tsx src/components/discovery/DiscoveredAssetList.test.tsx`.
- [ ] **Step 3: Implement.** **Step 4: Run, see pass.**
- [ ] **Step 5: Commit** `feat(web): no-network notice and the not-on-assigned-network filter`.

### Task 10: Discovery page: seventh tab and loaders

**Files:** modify `DiscoveryPage.tsx`, `DiscoveryPage.test.tsx`.

**Interfaces (consumes):** the Task 8 form types and props, Task 9's `ungatedSites` prop, Task 5's panel.

- `DISCOVERY_TABS` becomes `['assets', 'profiles', 'jobs', 'topology', 'changes', 'baselines', 'networks']`;
  label `discoveryPage.tabs.networks`; hash `#networks`; renders `<LearnedNetworksPanel currentOrgId={currentOrgId} />`.
  Every tab button gets `data-testid={`discovery-tab-${id}`}`.
- `ApiDiscoveryProfile` gains `networkId?`, `snmpGrantMode?`, `snmpGrantNetworks?`, `networkRequired?`.
  `formInitialValues` sets `networkId: editingProfile.networkId ?? ''`; the payload (`:531-546`) sends
  `networkId: values.networkId || null`.
- Gated flag and networks for the form come from `GET /discovery/networks?orgId=` (F1) through
  `loadSiteNetworks(siteId): Promise<SiteNetworkOptions>`: `networkRequired` from `sites[]`, networks are
  rows with `state === 'assigned' && siteId === siteId`. Agent marks come from
  `loadAgentNetworkStatus(siteId, networkId): Promise<Record<string, AgentNetworkStatus>>` over the Task 2
  route. `savedCredentialBinding` comes from the edited profile's `snmpGrantMode` and `snmpGrantNetworks`.
- `ungatedSites` for the Profiles list: distinct `siteId` of profiles with `networkRequired === false`,
  named from `siteOptions`; a site with no known name is skipped.

- [ ] **Step 1: Failing tests.** Stub `vi.mock('./LearnedNetworksPanel', () => ({ default: () => <div>Networks tab</div> }))`;
  extend the form stub with buttons that call `loadSiteNetworks('site-1')` and
  `loadAgentNetworkStatus('site-1', '')` and store the results.

```ts
it('#networks opens the Networks tab and the tab button writes the hash', ...);
  // location.hash '#networks' on mount -> 'Networks tab' stub rendered; click discovery-tab-jobs then
  // discovery-tab-networks -> window.location.hash === '#networks'
it('shows the no-network notice for a site whose profiles report networkRequired false', () => {
  expect(screen.getByTestId('discovery-profile-site-network-notice-site-1')).toHaveTextContent(
    'HQ has no assigned network. Scans can run from any of its agents, wherever they are.');
});
it('loadSiteNetworks reads F1 and returns the site flag and its assigned networks', () => {
  expect(fetchWithAuthMock).toHaveBeenCalledWith('/discovery/networks?orgId=org-1');
  expect(result).toEqual({ networkRequired: true,
    networks: [{ id: NET_A, displayName: 'Main Office LAN', prefix: '192.168.1.0/24' }] });
});
it('loadAgentNetworkStatus maps rows by deviceId');
  // loadAgentNetworkStatus('site-1', '') -> GET /discovery/sites/site-1/network-agents?orgId=org-1 (no networkId
  // param for Any); response { data: [{ deviceId: 'd1', status: 'offline' }] } -> { d1: 'offline' }
it('PATCH and POST carry networkId, null for Any');
  // form submit with networkId NET_A -> body.networkId === NET_A; with '' -> body.networkId === null
```

- [ ] **Step 2: Run, see fail:** `cd apps/web && npx vitest run src/components/discovery/DiscoveryPage.test.tsx`.
- [ ] **Step 3: Implement.** **Step 4: Run, see pass** (existing cases unchanged).
- [ ] **Step 5: Commit** `feat(web): Networks tab on Discovery`.

---

## Copy: `learnedNetworks` (namespace `discovery`)

| Key | English |
|---|---|
| `title` | Networks |
| `description` | Networks your agents have reported, told apart by their gateway. Assign the office network to its site so that site's scans run only there. |
| `loading` | Loading networks... |
| `errors.fetch` | Could not load networks. |
| `tryAgain` | Try again |
| `empty` | No networks reported yet. Networks appear here after agents on a supported version check in. |
| `limitReached` | This organization has 5,000 learned networks, the most Breeze keeps. New networks are not recorded until unassigned networks unseen for 90 days are removed. |
| `groups.needsReview` / `groups.assigned` / `groups.ignored` | Needs review ({{count}}) / Assigned ({{count}}) / Ignored ({{count}}) |
| `siteNoNetwork` | {{site}} requires a network but has none assigned. Its scans do not run until you assign one. |
| `row.wan` | WAN {{address}} |
| `row.wanEarlier_one` / `_other` | (+{{count}} earlier) / (+{{count}} earlier) |
| `row.recentDevices_one` / `_other` | {{count}} device in the last 14 days / {{count}} devices in the last 14 days |
| `row.oneRecentDevice` | 1 device in the last 14 days ({{hostname}}) |
| `row.bySite_one` / `_other` | {{count}} assigned to {{site}} / {{count}} assigned to {{site}} |
| `row.onItNow_one` / `_other` | {{count}} on it now / {{count}} on it now |
| `row.notOnItNow` | not on it now |
| `row.devicesOnItNow_one` / `_other` | {{count}} device on it now / {{count}} devices on it now |
| `row.usedByProfiles_one` / `_other` | used by {{count}} profile / used by {{count}} profiles |
| `row.suggestion` | Likely {{site}} |
| `row.replacementFor` | Looks like a replacement for {{name}} |
| `row.sharedMac` | This gateway uses a shared virtual-router MAC (VRRP or HSRP). Another network using the same group and address would look identical. |
| `actions.chooseSite` | Choose a site |
| `actions.assign` / `actions.ignore` / `actions.restore` | Assign to site / Ignore / Restore |
| `actions.rename` / `actions.merge` / `actions.unassign` | Rename / Merge… / Unassign |
| `actions.mergeReplacement` | Merge as replacement |
| `actions.showIgnored` / `actions.hideIgnored` | Show / Hide |
| `actions.stopRequiring` | Stop requiring a network |
| `rename.placeholder` | Name, for example Main Office LAN |
| `rename.help` | Leave empty to show the range and gateway. |
| `confirm.assignTitle` | Assign {{network}} to {{site}}? |
| `confirm.gatesSite` | {{site}} will require a network. From then on its scans run only from an agent that has just proved it is behind one of the site's assigned gateways. |
| `confirm.agents_one` / `_other` | {{onNetwork}} of {{count}} online agent at {{site}} is on this network now. / {{onNetwork}} of {{count}} online agents at {{site}} are on this network now. |
| `confirm.noAgentOnNetwork` | No online agent at {{site}} is on this network right now, so its scans will fail until one is. |
| `confirm.needUpdate_one` / `_other` | {{count}} online agent at {{site}} needs an update before it can run these scans. / {{count}} online agents at {{site}} need an update before they can run these scans. |
| `confirm.credentials` | Profiles at {{site}} with saved SNMP credentials will send them only on this network. |
| `confirm.profilesFailingClosed_one` / `_other` | {{count}} profile points at this network and will stop scanning until you change it. / {{count}} profiles point at this network and will stop scanning until you change them. |
| `confirm.lastNetwork` | {{site}} will have no network left. Its scans stop until you assign one or stop requiring a network. |
| `confirm.assign` | Assign |
| `confirm.unassignTitle` | Unassign {{network}} from {{site}}? |
| `confirm.unassignKeepsGate` | {{site}} still requires a network after this. |
| `confirm.unassign` | Unassign |
| `confirm.stopRequiringTitle` | Stop requiring a network for {{site}}? |
| `confirm.stopRequiringBody` | Scans for {{site}} may again run from any of its agents, wherever they are. Saved SNMP credentials stay limited to the networks they were entered for. |
| `confirm.stopRequiring` | Stop requiring |
| `merge.title` | Merge a network into {{network}} |
| `merge.source` / `merge.chooseSource` | Network to merge in / Choose a network |
| `merge.additional` | Additional gateway |
| `merge.additionalHelp` | Both routers serve this network at the same time, for example a high-availability pair. |
| `merge.replaces` | Replaces a gateway |
| `merge.replacesHelp` | The other network's router took over from a router on this network. Tick the gateways being retired. They stop counting as this network. |
| `merge.retire` | Retire {{address}} ({{mac}}) |
| `merge.credentials` | Saved SNMP credentials are not sent through the merged gateway until they are re-entered. |
| `merge.submit` | Merge |
| `toasts.assigned` / `toasts.unassigned` | {{network}} assigned to {{site}}. / {{network}} unassigned. |
| `toasts.renamed` / `toasts.ignored` / `toasts.restored` | Network renamed. / {{network}} ignored. / {{network}} restored. |
| `toasts.merged` / `toasts.stoppedRequiring` | {{source}} merged into {{target}}. / {{site}} no longer requires a network. |
| `errors.assign` / `errors.unassign` / `errors.rename` | Could not assign the network. / Could not unassign the network. / Could not rename the network. |
| `errors.ignore` / `errors.restore` / `errors.merge` / `errors.stopRequiring` | Could not ignore the network. / Could not restore the network. / Could not merge the networks. / Could not stop requiring a network. |

## Copy: other groups

| Key | English |
|---|---|
| `discoveryPage.tabs.networks` | Networks |
| `discoveryProfileForm.network.label` | Network |
| `discoveryProfileForm.network.any` | Any of this site's networks |
| `discoveryProfileForm.network.helpAny` / `helpOne` | Scans run on any network assigned to this site. / Scans run only on this network. |
| `discoveryProfileForm.network.fillRange` | Use {{prefix}} as the scan range |
| `discoveryProfileForm.network.loadError` | Could not load this site's networks. |
| `discoveryProfileForm.network.agentNotOnNetwork` | {{name}} (not on an allowed network) |
| `discoveryProfileForm.network.agentNeedsUpdate` | {{name}} (needs an agent update) |
| `discoveryProfileForm.network.credentialsBound` | Saved SNMP credentials are sent only on: {{networks}}. |
| `discoveryProfileForm.network.credentialsNotSentOn` | Saved SNMP credentials are not sent on {{network}} until they are re-entered. |
| `discoveryProfileForm.network.credentialsNowhere` | Saved SNMP credentials are not sent on any network until they are re-entered. |
| `discoveryProfileList.networkNotice` | {{site}} has no assigned network. Scans can run from any of its agents, wherever they are. |
| `discoveryProfileList.networkNoticeLink` | Assign a network |
| `discoveryJobList.columns.network` | Network |
| `discoveryJobList.crossNetwork_one` / `_other` | {{count}} device was last seen by a scan on another network / {{count}} devices were last seen by a scan on another network |
| `discoveryJobList.crossNetworkHint` | Another place may use the same address range. Check these devices on the Assets tab. |
| `discoveredAssetList.filters.notOnAssignedNetwork` | Not seen on an assigned network |

## Copy: `discoveryJobList.failures`

| Code (and reason) | Key | English |
|---|---|---|
| `profile_moved` | `profileMoved` | This job was created before its profile moved to another site, so it did not run. Run the profile again from the Profiles tab. |
| `network_not_assigned` | `networkNotAssigned` | The network this profile is limited to is no longer assigned to its site. Edit the profile and choose another network, or assign the network to the site again. |
| `credentials_need_reentry` | `credentialsNeedReentry` | The saved SNMP credentials are not allowed on this site's networks. Edit the profile and re-enter the SNMP credentials. |
| `no_network_assigned` | `noNetworkAssigned` | This site requires a network but has none assigned. Assign one on the Networks tab, or stop requiring a network. |
| `no_agent_on_network` (no reason) | `noAgentOnNetwork` | No agent at this site is on an assigned network right now. Run the scan again when one is. |
| `no_agent_on_network` + `none_online` | `noAgentNoneOnline` | No agent at this site is online. Bring an agent at the site online, then run the scan again. |
| `no_agent_on_network` + `none_on_network` | `noAgentNoneOnNetwork` | Agents at this site are online, but none is on an assigned network right now. Run the scan when an agent is at the site, or pin an agent that stays there. |
| `no_agent_on_network` + `agents_need_update` | `noAgentNeedUpdate` | Agents here need updating. Update the agents at this site to the current version, then run the scan again. |
| `agent_not_eligible` (no reason) | `agentNotEligible` | The chosen scan agent cannot scan this site. Pick another agent or Automatic. |
| `agent_not_eligible` + `not_found` | `agentNotFound` | The chosen scan agent no longer exists. Edit the profile and pick another agent or Automatic. |
| `agent_not_eligible` + `other_site` | `agentOtherSite` | The chosen scan agent is not assigned to this site. Pick an agent from this site, or Automatic. |
| `agent_not_eligible` + `offline` | `agentOffline` | The chosen scan agent is offline. Bring it online, or set the scan agent to Automatic. |
| `agent_not_eligible` + `ephemeral` | `agentEphemeral` | The chosen scan agent is a temporary support session and cannot scan. Pick an installed agent or Automatic. |
| `agent_not_eligible` + `parked` | `agentParked` | The chosen scan agent is parked and cannot scan. Pick another agent or Automatic. |
| `agent_not_eligible` + `not_on_network` | `agentNotOnNetwork` | The chosen scan agent is not on an assigned network right now. Run the scan when it is back at the site, or set the scan agent to Automatic. |
| `agent_not_eligible` + `needs_update` | `agentNeedsUpdate` | The chosen scan agent needs an update before it can scan this site. Update the agent, then run the scan again. |
| `network_mismatch` | `networkMismatch` | The agent was not behind an assigned gateway when the scan started, so nothing was scanned. Check that the agent is at the site. If the router was replaced, merge the new network on the Networks tab. |
| `network_changed` | `networkChanged` | The agent could not confirm that it stayed behind an assigned gateway: its network changed or could not be checked. Nothing from this scan was saved. Run the scan again, and check that the agent is at the site if it repeats. |
| `network_unverified` | `networkUnverified` | The result could not be matched to an assigned network, so it was discarded. Run the scan again, and check the site's networks on the Networks tab if it repeats. |

## Test ids

| Element | `data-testid` |
|---|---|
| Discovery tab buttons | `discovery-tab-<id>` (all seven) |
| Panel; loading; error; retry; empty; limit notice | `learned-networks-panel`; `-loading`; `-error`; `-retry`; `-empty`; `-limit-reached` |
| Groups; ignored toggle | `learned-networks-group-needs-review`, `-group-assigned`, `-group-ignored`; `learned-networks-ignored-toggle` |
| Gated site with no network; its button | `learned-networks-site-no-network-<siteId>`; `learned-networks-stop-requiring-<siteId>` |
| Row; evidence; suggestion; replacement; shared MAC | `learned-network-row-<id>`; `-evidence-<id>`; `-suggestion-<id>`; `-replacement-<id>`; `-shared-mac-<id>` |
| Row controls | `learned-network-site-select-<id>`, `-assign-<id>`, `-ignore-<id>`, `-restore-<id>`, `-rename-<id>`, `-rename-input-<id>`, `-rename-save-<id>`, `-merge-<id>`, `-merge-replacement-<id>`, `-unassign-<id>` |
| Confirmation dialog; submit; effect lines | `learned-network-confirm-dialog`; `learned-network-confirm-submit`; `learned-network-effect-gates`, `-effect-agents`, `-effect-need-update`, `-effect-credentials`, `-effect-profiles`, `-effect-last-network`, `-effect-shared-mac`, `-effect-keeps-gate` |
| Merge dialog | `learned-network-merge-dialog`, `-merge-source-select`, `-merge-mode-additional`, `-merge-mode-replaces`, `-merge-retire-<gatewayId>`, `-merge-submit` |
| Profile form | `discovery-profile-network-select`, `discovery-profile-network-fill-range`, `discovery-profile-network-error`, `discovery-profile-credentials-binding`, `discovery-profile-credentials-not-sent-<networkId>` |
| Profiles notice; link | `discovery-profile-site-network-notice-<siteId>`; `discovery-profile-site-network-link-<siteId>` |
| Jobs | `discovery-job-network-<jobId>`, `discovery-job-cross-network-<jobId>`, `discovery-job-error-<jobId>` |
| Assets chip | `discovered-assets-filter-not-on-assigned-network` |

## Done when

- [ ] `cd apps/web && npx vitest run src/components/discovery src/lib/i18n src/locales src/lib/__tests__/no-silent-mutations.test.ts`
  passes (check the file count includes `LearnedNetworksPanel.test.tsx`, `DiscoveryJobList.test.tsx`,
  `learnedNetworkTypes.test.ts`, `discoveryJobFailures.test.ts`, `learnedNetworksCopy.test.ts`).
- [ ] `cd apps/web && npx tsc --noEmit -p .; echo "exit $?"` prints `exit 0`.
- [ ] `cd apps/api && npx vitest run src/routes/discovery.test.ts src/routes/discoveryNetworks.test.ts src/__tests__/parkedFanout.contract.test.ts`
  passes; `pnpm -F @breeze/api test:site-scope-coverage` passes.
- [ ] `pnpm test-stack up`, then
  `pnpm --filter @breeze/api test:integration src/__tests__/integration/learnedNetworkReadFields.integration.test.ts`
  and `pnpm --filter @breeze/api test:integration-suite-coverage` pass; `pnpm test-stack down`.
- [ ] `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .; echo "exit $?"` prints `exit 0` (never pipe to `tail`).
- [ ] Every field this wave reads matches the index's F, F1 and F2 as written; the index is amended in the
  same PR only if this wave changed one of them.
- [ ] PR body: `Closes #<W04 sub-issue>`; the settings line is not applicable (no setting added); the
  end-to-end decision above and that W05's lab proof carries the browser walk; the two
  machine-draft lines from `apps/web/src/locales/README.md`; the `discovery.json` cap bump and why;
  that nothing changes for a site until a network is assigned.

## Contract notes

1. **Gateway vendor.** Index F1 says W04 adds `vendor: string | null` to each F1 gateway from
   `lookupMacVendor` (`apps/api/src/services/macVendorLookup.ts:8`); spec 9 shows it. Task 1 does that in
   `list.ts`.
2. **Display name rule for `networkName` and `snmpGrantNetworks[].name`** is the F1 `displayName` rule
   (index F1, never null), computed with W03c's `displayNameFor` from `suggestions.ts`.
3. **`replacementFor`** is `{ networkId, displayName, siteId, siteName }` when set (index F1, W03c Task 1).
   The mapper and fixture use all four fields.
4. **F1 `sites` lists every site the caller can access in the org**, with `networkRequired`, including
   sites with no network and no profile (index F1; W03c pins it with a test). The assign site select and the
   new-profile form read the gated flag from it.
5. **`seenOnAssignedNetwork` is `boolean | null`, not `boolean`.** As a plain boolean every asset at a site
   that is not gated reads as "not seen on an assigned network", so the filter would flag a whole
   inventory in an org that has never gated a site. `null` means the asset's site is not gated; the chip
   counts only `false`.
6. **The scan-agent picker reads `GET /discovery/sites/:siteId/network-agents`** (index F, owned by this
   wave, Task 2). Each row is `on_network` or the E6 `IneligibleReason` for that device (`offline`,
   `needs_update` or `not_on_network`; the route lists only the site's devices that are not ephemeral or
   parked, so the other reasons do not occur).
7. **`AssignmentEffects.agents.needUpdate`** counts, of the site's online agents on the network, those below
   the guard version (index E12). The copy ("N online agents at <site> need an update") is true under it.
8. **Which assign effects need confirmation** (index E12): `gatesSite`, `siteLosesLastNetwork`,
   `profilesFailingClosed > 0`, `sharedVirtualRouterMac`. Each has a dialog line and a test in Task 6.

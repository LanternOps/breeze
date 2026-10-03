---
title: Topology "belongs to" vs "is at" — site assignment vs observed network location
tracking_issue: LanternOps/breeze#7884
spec: docs/superpowers/specs/monitoring/2026-10-03-topology-site-location-design.md
status: approved 2026-10-03 — advisor quorum complete (Fable + Codex gpt-6-astra xhigh); anchor resolved by tie-break
waves: W1 (assignment vs observation + move hardening), W2 (anchors, fingerprints, presence, visitors), W3 (daily summaries, suggestions, dismissal)
---

# Topology Site Location Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate a device's administrative site ("belongs to") from the network it is observed on ("is at") in the topology map. Render cross-site visitors under a strict, leak-free visibility rule, and suggest (never perform) wrong-site moves through a hardened, audited move action.

**Architecture:** W1 is presentation-only. Graph network cards learn whether their prefix is declared for the viewed site (exact match against discovery profiles and network baselines), undeclared networks move to an "Other / unidentified networks" roster, and `PATCH /devices/:id` gains an expected-source-site guard plus a `device.site_move` audit. W2 adds an org-level read model (`topology_org_presence_state`, `topology_site_fingerprints`, `topology_device_presence`), refreshed by a worker from published route, membership and neighbour evidence, and served by `GET /topology/sites/:siteId/presence` with an app-layer site gate. W3 adds prospective daily summaries (`topology_device_presence_days`), suggestion eligibility, and `devices.site_assignment_confirmed_at`.

**Tech Stack:** Hono + Drizzle + PostgreSQL (RLS), BullMQ-free interval worker (same shape as `topologyTelemetryMaintenance.ts`), Zod schemas in `@breeze/shared`, React + Cytoscape explorer, Vitest (unit, integration, RLS coverage), Playwright for manual verification.

**Spec:** `docs/superpowers/specs/monitoring/2026-10-03-topology-site-location-design.md` (referred to as **S§n**). Read it before any task. Section numbers below cite it.

## Global Constraints

- No automatic site reassignment, ever. No code path writes `devices.site_id` except an explicit user request through `PATCH /devices/:id` (or the existing move-org route).
- The copy never says "away". Unmatched devices are "Other / unidentified networks" (S§4.3).
- Matching is exact normalized IPv4 prefix equality against enabled `discovery_profiles.subnets` and `network_baselines.subnet`. There is no containment (S§6.2).
- Inference from agents assigned to a site is never an anchor. It only corroborates a declared prefix (S§6.3).
- Consumer-default prefixes need gateway-MAC corroboration from at least 2 distinct observers assigned to the declaring site, excluding the subject device (S§6.3, S§6.5).
- Site visibility = `canAccessSite(current)` ∧ `canAccessSite(ctx.permissions)` ∧ `siteAccessCheck(ctx.auth.allowedSiteIds)`. Naming B requires B. An A-owned visitor on B requires A. Hidden matches serialize exactly like unrecognized entries (S§8).
- Presence DTOs carry `authority: false` and never carry another site's canonical node, relationship or interface IDs (S§8 R6).
- AI/MCP unchanged: no `services/topology/ai*` file may import presence modules (S§14).
- Bounds: fingerprints ≤ 1,024 per org; declaring sites ≤ 256 per org; devices ≤ 20,000 per org evaluation (batches of 1,000); presence response `assigned` ≤ 1,000 and `visitors` ≤ 500; presence days ≤ 8 rows per device per day, retained 35 days, written at most once per 60 min per row (S§7, S§10).
- Evaluation cadence: tick every 60 s, ≤ 20 orgs per tick, dirty debounce 30 s, hourly re-evaluation, `fresh_until ≤ now + 75 min` (S§7.4).
- Suggestion eligibility: ≥ 7 distinct UTC days, span ≥ 7 × 24 h, within 30 days, no competing rows, no unexplained gap > 36 h (S§10.2).
- Migrations: `YYYY-MM-DD-HHMMSS-<slug>.sql`, sorting after the newest **committed** migration on `origin/main` at authoring time; idempotent; no inner `BEGIN`/`COMMIT`; never edit a shipped migration.
- Every new `org_id` table: RLS shape 1 in the creating migration, `CORE_ORG_CASCADE_DELETE_ORDER`, an `orgMergeRegistry` policy, and a `CORE_TENANT_EXPORT_POLICY` classification (jsonb → `excludedOpen`). Device-keyed tables go in the device cascade, org-denormalized and move-delete lists (S§15).
- Web mutations go through `runAction`. Copy lives in `apps/web/src/locales/*/topology.json` (English source; other locales get the English string until translated, per the existing parity test).
- Running one test file: `cd apps/api && npx vitest run <path>`. Never `pnpm --filter … test -- --run`.

## Review Focus

1. **Site-restricted viewer and a hidden match.** A user restricted to site A must get the same JSON for a device visiting hidden site B as for a genuinely unrecognized device: no name, no ID, no count, no reason. Pinned in W2 Task 6, test `hidden visiting match is byte-identical to unrecognized`.
2. **Token ceiling narrower than the role.** A user API key that inherits `allowedSiteIds` = [A] while the user's role is unrestricted must still not see B. Pinned in W2 Task 6, test `API key site ceiling hides other-site visitors`.
3. **Concurrent site moves.** Two technicians move the same device at once (one through the suggestion, one through the device page). Exactly one succeeds and the other gets 409, never a silent overwrite. Pinned in W1 Task 4 integration test `concurrent PATCH site moves: one wins, one 409`.
4. **A messy discovery profile.** `subnets` holding `10.1.5.1/24`, `10.1.5.0-10.1.5.255`, `10.0.0.0/8` and garbage must declare exactly `10.1.5.0/24`. The supernet claims nothing, and the ignored count reports 3. Pinned in W1 Task 1 `normalizeDeclaredPrefix` table test plus the integration read.
5. **Offline weekend vs evaluator outage.** A desktop off from Friday to Monday (stale rows) must stay eligible. An evaluator outage of 40 h (no rows) or limited coverage (`unknown` rows) must break eligibility. Pinned in W3 Task 2 table tests `stale weekend explains the gap` and `40h hole without rows is unexplained`.

---

## File Structure

| File | Wave | Responsibility |
|---|---|---|
| `apps/api/src/services/topology/siteNetworkDeclarations.ts` (+ `.test.ts`) | W1 (org reader W2) | `normalizeDeclaredPrefix`, `readSiteNetworkDeclarations`, `readOrgNetworkDeclarations` |
| `apps/api/src/services/topology/presentationGroups.ts` (+ test) | W1 | Mark `lan` cards declared or undeclared; emit empty declared cards |
| `apps/api/src/services/topology/graph.ts` | W1 | Pass declarations into grouping (overview and logical only) |
| `packages/shared/src/validators/topology.ts` (+ test) | W1/W2 | `group.declaration`; `TOPOLOGY_CONSUMER_DEFAULT_PREFIXES`, `isTopologyConsumerDefaultPrefix` |
| `packages/shared/src/validators/topologyPresence.ts` (+ test) | W2 (W3 suggestion) | `presenceResponseSchema`, enums |
| `apps/api/src/routes/devices/schemas.ts`, `routes/devices/core.ts`, `routes/devices/core.siteMove.test.ts` | W1 (W3 evidence) | `expectedSiteId`, guard, `siteMoveTrigger`, `device.site_move` audit |
| `apps/web/src/components/topology/renderProjection.ts` (+ test) | W1/W2 | Roster split; visitor nodes |
| `apps/web/src/components/topology/TopologySiteRoster.tsx` (+ test) | W1 (W2/W3 sections) | Roster panel |
| `apps/web/src/components/topology/visitorPlacement.ts` (+ test) | W2 | Pure visitor-to-card placement |
| `apps/web/src/components/topology/useTopologyPresence.ts` (+ test), `topologyApi.ts` | W2 | Presence fetch |
| `apps/web/src/components/devices/ChangeSiteModal.tsx`, `DeviceSettingsModal.tsx` (+ tests) | W1 | Send `expectedSiteId`, 409 handling, implication copy |
| `apps/api/migrations/<date>-<time>-topology-presence-read-model.sql` | W2 | Three tables, RLS, triggers |
| `apps/api/src/db/schema/topologyPresence.ts` | W2/W3 | Drizzle definitions (exported from `db/schema/index.ts`) |
| `apps/api/src/services/topology/presenceClassifier.ts` (+ test) | W2 | Pure S§4.1 and S§4.2 |
| `apps/api/src/services/topology/presenceInputs.ts` | W2 | SQL readers: anchor evidence, device attachments |
| `apps/api/src/services/topology/presenceEvaluator.ts` (+ test) | W2/W3 | Org evaluation transaction |
| `apps/api/src/jobs/topologyPresenceWorker.ts` (+ test) | W2 | Interval tick, scheduling, retention (W3) |
| `apps/api/src/services/topology/presenceVisibility.ts`, `presenceRead.ts` (+ tests) | W2 | Site gate, DTO assembly |
| `apps/api/src/routes/topology/presence.ts` | W2 | `GET /topology/sites/:siteId/presence` |
| `apps/api/src/services/topology/presenceEligibility.ts` (+ test) | W3 | Pure S§10.2 |
| `apps/api/src/routes/devices/siteAssignmentConfirmation.ts` (+ test) | W3 | PUT/DELETE confirmation |
| `apps/api/migrations/<date>-<time>-topology-presence-days-and-confirmation.sql` | W3 | Days table, suggestion columns, devices column, reset trigger |
| Registries: `services/tenantCascade.ts`, `services/orgMergeRegistry.ts`, `services/tenantExportPolicyRegistry.ts`, `routes/devices/core.ts` lists | W2/W3 | S§15 |
| `apps/api/src/__tests__/integration/topology-presence-fixtures.ts` | W2 | Two-site org fixture over the real collection seam |
| `apps/api/scripts/seed-topology-demo{,.lib}.ts` (branch `feat/topology-demo-seed`) | W1/W3 | Lakeside demo |

---

## Wave 1: Separate assignment from observation; move hardening

Branch: `feature/7884-topology-site-location/wave-<sub-issue#>` (sub-issue from `get_feature_status LanternOps/breeze#7884`). No migration.

### Task 1: Site network declarations (reader and normalizer)

**Files:**
- Create: `apps/api/src/services/topology/siteNetworkDeclarations.ts`
- Test: `apps/api/src/services/topology/siteNetworkDeclarations.test.ts`
- Test: `apps/api/src/__tests__/integration/topologySiteDeclarations.integration.test.ts`

**Interfaces:**
- Consumes: `parsePrefix(prefix)` from `services/topology/ipAddress.ts`; `scoped(scope, alias)` from `graphRead.ts`.
- Produces:
  - `normalizeDeclaredPrefix(text: string): string | null`
  - `type DeclarationKind = 'discovery_profile' | 'network_baseline'`
  - `type DeclarationSource = { kind: DeclarationKind; id: string }`
  - `type SiteNetworkDeclarations = { prefixes: Map<string, DeclarationSource[]>; ignored: number }`
  - `readSiteNetworkDeclarations(tx: Pick<typeof db,'execute'>, scope: TopologyScope): Promise<SiteNetworkDeclarations>`

- [ ] **Step 1: Write the failing unit test**

```ts
import { describe, expect, it } from 'vitest';
import { normalizeDeclaredPrefix } from './siteNetworkDeclarations';

describe('normalizeDeclaredPrefix', () => {
  it.each([
    ['10.1.5.0/24', '10.1.5.0/24'],
    ['10.1.5.1/24', '10.1.5.0/24'],          // host bits zeroed
    [' 192.168.1.0/24 ', '192.168.1.0/24'],
    ['10.0.0.0/8', '10.0.0.0/8'],             // valid declaration; exact matching makes it claim nothing smaller
    ['172.16.4.0/22', '172.16.4.0/22'],
  ])('accepts %s → %s', (input, expected) => expect(normalizeDeclaredPrefix(input)).toBe(expected));
  it.each([
    '10.1.5.0-10.1.5.255', '10.1.5.7', '10.1.5.0/31', '10.1.5.7/32', '10.0.0.0/7',
    'fd00::/64', '2001:db8::/48', 'garbage', '', '10.1.5.0/33', '300.1.1.0/24',
  ])('rejects %s', (input) => expect(normalizeDeclaredPrefix(input)).toBeNull());
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/api && npx vitest run src/services/topology/siteNetworkDeclarations.test.ts`
Expected: FAIL, "Cannot find module './siteNetworkDeclarations'".

- [ ] **Step 3: Implement**

```ts
import { sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import type { db } from '../../db';
import { parsePrefix } from './ipAddress';

/** Spec S§6.2: exact-match anchors only. IPv4, length 8–30, host bits zeroed. */
export function normalizeDeclaredPrefix(text: string): string | null {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(trimmed)) return null;
  const parsed = parsePrefix(trimmed);
  if (!parsed || parsed.family !== 'ipv4' || parsed.length < 8 || parsed.length > 30) return null;
  const octets = trimmed.split('/')[0]!.split('.').map(Number);
  const value = ((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!;
  const mask = parsed.length === 0 ? 0 : (0xffffffff << (32 - parsed.length)) >>> 0;
  const network = (value & mask) >>> 0;
  return `${network >>> 24}.${(network >>> 16) & 255}.${(network >>> 8) & 255}.${network & 255}/${parsed.length}`;
}

export type DeclarationKind = 'discovery_profile' | 'network_baseline';
export type DeclarationSource = { kind: DeclarationKind; id: string };
export type SiteNetworkDeclarations = { prefixes: Map<string, DeclarationSource[]>; ignored: number };

type Row = { kind: DeclarationKind; id: string; site_id: string; raw: string };

export function foldDeclarations(rows: Row[]): { bySite: Map<string, Map<string, DeclarationSource[]>>; ignored: number } {
  const bySite = new Map<string, Map<string, DeclarationSource[]>>();
  let ignored = 0;
  for (const row of rows) {
    const prefix = normalizeDeclaredPrefix(row.raw);
    if (!prefix) { ignored++; continue; }
    const site = bySite.get(row.site_id) ?? new Map<string, DeclarationSource[]>();
    const sources = site.get(prefix) ?? [];
    if (!sources.some((s) => s.kind === row.kind && s.id === row.id)) sources.push({ kind: row.kind, id: row.id });
    site.set(prefix, sources); bySite.set(row.site_id, site);
  }
  return { bySite, ignored };
}

/** Enabled discovery profiles' subnets + network baselines, for ONE site (W1 graph read). */
export async function readSiteNetworkDeclarations(tx: Pick<typeof db, 'execute'>, scope: TopologyScope): Promise<SiteNetworkDeclarations> {
  const rows = await tx.execute<Row>(sql`
    SELECT 'discovery_profile' AS kind, p.id, p.site_id, s.subnet AS raw
      FROM discovery_profiles p CROSS JOIN LATERAL unnest(p.subnets) AS s(subnet)
      WHERE p.org_id = ${scope.orgId}::uuid AND p.site_id = ${scope.siteId}::uuid AND p.enabled
    UNION ALL
    SELECT 'network_baseline', b.id, b.site_id, b.subnet
      FROM network_baselines b WHERE b.org_id = ${scope.orgId}::uuid AND b.site_id = ${scope.siteId}::uuid
    ORDER BY 1, 2, 4 LIMIT 4097`);
  const folded = foldDeclarations([...rows].slice(0, 4096));
  return { prefixes: folded.bySite.get(scope.siteId) ?? new Map(), ignored: folded.ignored + Math.max(0, rows.length - 4096) };
}
```

Also add a `foldDeclarations` unit test: two sources for the same prefix are merged; a duplicate source is not duplicated; `ignored` counts rejected entries.

- [ ] **Step 4: Run the unit tests and confirm they pass**

Run: `cd apps/api && npx vitest run src/services/topology/siteNetworkDeclarations.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the integration test (real Postgres, RLS)**

`topologySiteDeclarations.integration.test.ts`, using `setupTestEnvironment` and `withDbAccessContext(orgContext(orgId), …)` as in `topologyNeighbourCorroboration.integration.test.ts`:
- Site A: an enabled profile with subnets `['10.1.5.1/24','10.1.5.0-10.1.5.255','10.0.0.0/8','junk']`, plus a disabled profile with `['10.9.9.0/24']` and a baseline `10.1.2.0/24`.
- Site B (same org): a profile with `10.1.7.0/24`.
- Org 2: a profile with `10.1.2.0/24`.
- Expect `readSiteNetworkDeclarations(scope A)` to equal the prefixes `{10.0.0.0/8, 10.1.2.0/24, 10.1.5.0/24}`, with `ignored === 2`. Site B's and the disabled profile's prefixes must be absent. Under org-2 context, A's declarations must be invisible (RLS).

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/topologySiteDeclarations.integration.test.ts` (needs `pnpm test-stack up`).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/topology/siteNetworkDeclarations.ts apps/api/src/services/topology/siteNetworkDeclarations.test.ts apps/api/src/__tests__/integration/topologySiteDeclarations.integration.test.ts
git commit -m "feat(topology): read and normalize per-site declared networks (site location W1)"
```

### Task 2: Declared/undeclared network cards in the graph (+ spec amendments)

**Files:**
- Modify: `packages/shared/src/validators/topology.ts:275-305` (group schema) and its test file
- Modify: `apps/api/src/services/topology/presentationGroups.ts` (input type :19-41, `readPresentationGroupInput` :496, `networkNode` :384, card ordering :445)
- Modify: `apps/api/src/services/topology/graph.ts:198-204`
- Test: `apps/api/src/services/topology/presentationGroups.test.ts`, `apps/api/src/services/topology/graph.test.ts` (one fixture), `aiRead`/`aiEvidence` tests
- Docs: `docs/superpowers/specs/monitoring/2026-09-15-intelligent-network-topology-collection.md` (after C:186), `docs/superpowers/plans/monitoring/2026-10-02-topology-grouped-overview.md` (Q2), with the exact text from S§13

**Interfaces:**
- Consumes: `readSiteNetworkDeclarations` (Task 1).
- Produces:
  - `PresentationGroupInput.declarations?: { prefix: string; sources: DeclarationKind[] }[]`
  - Shared `group.declaration?: { state: 'declared' | 'undeclared'; sources: ('discovery_profile'|'network_baseline')[] }`
  - Empty declared cards: `group.kind: 'network'`, `basis: 'declared_site_network'` (new enum value), `members: []`, `observerCount: 0`

- [ ] **Step 1: Write the failing shared schema test**

```ts
it('accepts a declared lan group and an empty declared card; rejects an unknown declaration state', () => {
  const base = sampleNetworkGroupNode(); // existing helper in the topology validator test file
  expect(presentationNodeSchema.safeParse({ ...base, group: { ...base.group, declaration: { state: 'declared', sources: ['discovery_profile'] } } }).success).toBe(true);
  expect(presentationNodeSchema.safeParse({ ...base, group: { ...base.group, basis: 'declared_site_network', members: [], canonicalNodeIds: [], observerCount: 0,
    declaration: { state: 'declared', sources: ['network_baseline'] } } }).success).toBe(true);
  expect(presentationNodeSchema.safeParse({ ...base, group: { ...base.group, declaration: { state: 'maybe', sources: [] } } }).success).toBe(false);
});
```

If `sampleNetworkGroupNode` does not exist, build the node inline from the fields at `topology.ts:261-306`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/shared && npx vitest run src/validators/topology.test.ts`
Expected: FAIL (strict object rejects `declaration`).

- [ ] **Step 3: Extend the schema**

In the `group` object, add `'declared_site_network'` to the `basis` enum and add:
```ts
    /** Site location W1 (S§9): whether this lan card's prefix is declared for the viewed site (exact match). */
    declaration: z.object({
      state: z.enum(['declared', 'undeclared']),
      sources: z.array(z.enum(['discovery_profile', 'network_baseline'])).max(2),
    }).strict().optional(),
```
Run the test again. Expected: PASS.

- [ ] **Step 4: Write failing grouping tests** (in `presentationGroups.test.ts`, reusing `lan()` and `build()`)

```ts
describe('site declarations (site location W1)', () => {
  it('marks a lan card declared only on exact prefix match', () => {
    const input = lan([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.100' }, { n: 2, prefix: '10.1.5.0/24', gateway: '10.1.5.1' }]);
    input.declarations = [{ prefix: '10.1.2.0/24', sources: ['discovery_profile'] }, { prefix: '10.1.0.0/16', sources: ['network_baseline'] }];
    const cards = build(input).nodes.filter((n) => n.group?.kind === 'network');
    const byPrefix = Object.fromEntries(cards.map((c) => [c.group!.prefix, c.group!.declaration]));
    expect(byPrefix['10.1.2.0/24']).toEqual({ state: 'declared', sources: ['discovery_profile'] });
    expect(byPrefix['10.1.5.0/24']).toEqual({ state: 'undeclared', sources: [] }); // the /16 supernet claims nothing
  });
  it('emits an empty declared card for a declared prefix no observer reports', () => {
    const input = lan([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.100' }]);
    input.declarations = [{ prefix: '10.1.9.0/24', sources: ['network_baseline'] }];
    const empty = build(input).nodes.find((n) => n.group?.prefix === '10.1.9.0/24');
    expect(empty?.group).toMatchObject({ kind: 'network', basis: 'declared_site_network', members: [], observerCount: 0, declaration: { state: 'declared' } });
    expect(presentationNodeSchema.parse(empty)).toBeTruthy();
  });
  it('never marks non-lan cards (overlay, link-local) and leaves cards unmarked when declarations are absent', () => {
    const input = lan([{ n: 1, prefix: '100.64.0.0/10' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.100' }]);
    expect(build(input).nodes.every((n) => n.group?.declaration === undefined)).toBe(true);
    input.declarations = [{ prefix: '100.64.0.0/10', sources: ['discovery_profile'] }];
    const overlay = build(input).nodes.find((n) => n.group?.prefix === '100.64.0.0/10');
    expect(overlay?.group?.declaration).toBeUndefined();
  });
});
```

- [ ] **Step 5: Run them and confirm they fail**

Run: `cd apps/api && npx vitest run src/services/topology/presentationGroups.test.ts`
Expected: the three new tests FAIL.

- [ ] **Step 6: Implement**

- In `PresentationGroupInput`, add `declarations?: { prefix: string; sources: DeclarationKind[] }[];` (type import from `./siteNetworkDeclarations`).
- In `networkNode` (:384), when `input.declarations` is defined and the candidate class is `lan`, set
  `declaration: { state: match ? 'declared' : 'undeclared', sources: match?.sources ?? [] }`, where `match` is the declaration whose prefix equals the candidate's normalized prefix (`normalizeDeclaredPrefix(candidate.prefix)`).
- After the candidate loop, for each declaration whose prefix has no `lan` candidate, emit an empty card with id key `declared|<prefix>`, label `<prefix>`, `basis: 'declared_site_network'`, `networkClass: 'lan'`, `members: []`, `canonicalNodeIds: []`, `observerCount: 0`, `gatewayAddresses: []`, `conflict: false`, and a `frontierToken` from `tokenFor({ kind: 'network', key })`. Make `presentationGroupMembers` return an empty member set for that key.
- Card order (:445): declared cards first, then undeclared, then non-lan, then unidentified.
- In `readPresentationGroupInput` (:496): `const declarations = await readSiteNetworkDeclarations(tx, scope); input.declarations = [...declarations.prefixes].map(([prefix, sources]) => ({ prefix, sources: [...new Set(sources.map((s) => s.kind))].sort() }));`
- `graph.ts` needs no change beyond the input, because AI reads already pass `presentationGroups: false` (`aiEvidence.ts:233`, `aiRead.ts:76`).

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `cd apps/api && npx vitest run src/services/topology/presentationGroups.test.ts src/services/topology/graph.test.ts src/services/topology/aiRead.test.ts src/services/topology/aiEvidence.test.ts`
Expected: PASS. If `graph.test.ts`'s ordered mocks break because of the new `execute` call, add one mocked result `[]` for the declarations read at the position the new statement runs.

- [ ] **Step 8: Integration assertion**

In `topologySiteDeclarations.integration.test.ts`, add a graph read through `topologyGraphRoutes` for a site with two observers (10.1.2.0/24 via .100, which a profile declares; 10.1.5.0/24 via .1, undeclared) plus a baseline `10.1.9.0/24`. Expect cards: `10.1.2.0/24` declared, `10.1.5.0/24` undeclared, and an empty `10.1.9.0/24` card declared. Also call `getTopologyGraph(ctx, query, { presentationGroups: false })` and assert `JSON.stringify(body)` does not contain `"declaration"`.

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/topologySiteDeclarations.integration.test.ts`
Expected: PASS.

- [ ] **Step 9: Apply the spec amendments**

Paste the two blocks from S§13 verbatim: after C:186 in the collection spec, and appended to the Q2 bullet of GO's "Quorum resolution".

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/validators/topology.ts packages/shared/src/validators/topology.test.ts apps/api/src/services/topology/presentationGroups.ts apps/api/src/services/topology/presentationGroups.test.ts apps/api/src/services/topology/graph.test.ts apps/api/src/__tests__/integration/topologySiteDeclarations.integration.test.ts docs/superpowers/specs/monitoring/2026-09-15-intelligent-network-topology-collection.md docs/superpowers/plans/monitoring/2026-10-02-topology-grouped-overview.md
git commit -m "feat(topology): declared vs undeclared network cards on the site map (site location W1)"
```

### Task 3: Web roster "Other / unidentified networks"

**Files:**
- Modify: `apps/web/src/components/topology/renderProjection.ts` (`compileTopologyRender` :63) and `renderProjection.test.ts`
- Create: `apps/web/src/components/topology/TopologySiteRoster.tsx`, `TopologySiteRoster.test.tsx`
- Modify: `apps/web/src/components/topology/TopologyExplorer.tsx` (toolbar :175-213), `TopologyInspectorSections.tsx` (`GroupSummary` :56), `TopologyList.tsx`
- Modify: `apps/web/src/locales/*/topology.json`

**Interfaces:**
- Consumes: `group.declaration` (Task 2).
- Produces:
  - `compileTopologyRender(graph, { showAllNetworks, showOtherNetworks })` returns `{ …existing, roster: RosterNetwork[], siteHasDeclarations: boolean }`
  - `type RosterNetwork = { groupId: string; prefix: string | null; gatewayAddresses: string[]; kind: 'undeclared' | 'unidentified'; memberNodeIds: string[] }`
  - `<TopologySiteRoster siteName roster nodesById onSelect presence? />` (`presence` is added in W2)

- [ ] **Step 1: Write failing projection tests**

```ts
it('moves undeclared lan cards to the roster only when the site declares at least one network', () => {
  const graph = groupedGraphFixture([{ prefix: '10.1.2.0/24', declaration: 'declared', members: 20 }, { prefix: '10.1.5.0/24', declaration: 'undeclared', members: 2 }]);
  const out = compileTopologyRender(graph, { showAllNetworks: false, showOtherNetworks: false });
  expect(out.siteHasDeclarations).toBe(true);
  expect(out.nodes.some((n) => n.kind === 'group' && n.prefix === '10.1.5.0/24')).toBe(false);
  expect(out.roster).toEqual([expect.objectContaining({ prefix: '10.1.5.0/24', kind: 'undeclared', memberNodeIds: expect.any(Array) })]);
  // its gateway card goes too, when only undeclared networks route through it
  expect(out.nodes.some((n) => n.kind === 'gateway' && n.label.includes('10.1.5.1'))).toBe(false);
});
it('keeps every card on the canvas when the site declares nothing', () => {
  const graph = groupedGraphFixture([{ prefix: '10.1.2.0/24', declaration: 'undeclared', members: 20 }, { prefix: '10.1.5.0/24', declaration: 'undeclared', members: 2 }]);
  const out = compileTopologyRender(graph, { showAllNetworks: false, showOtherNetworks: false });
  expect(out.siteHasDeclarations).toBe(false);
  expect(out.roster.filter((r) => r.kind === 'undeclared')).toEqual([]);
});
it('the toggle puts undeclared cards back on the canvas, and the unidentified group is always listed in the roster', () => { /* … */ });
```

`groupedGraphFixture` goes in `topologyFixtures.ts`. It builds a `GraphResponse` with `network_group` and `gateway_group` presentation nodes and member endpoints, the same way the existing grouped fixtures do.

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd apps/web && npx vitest run src/components/topology/renderProjection.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the projection change**

`siteHasDeclarations = presentation.nodes.some(n => n.group?.declaration?.state === 'declared')`. When true and `!showOtherNetworks`, exclude `lan` cards whose `declaration.state === 'undeclared'`, their members, and gateway cards connected only to excluded cards. Push them into `roster`. The `unidentified` group is always pushed into `roster` (`kind: 'unidentified'`) as well as staying on the canvas, which is the existing behaviour.

- [ ] **Step 4: Write the failing roster component test**

```tsx
it('renders a collapsed roster with a count chip, expands to networks and devices, and selects a device', async () => {
  const onSelect = vi.fn();
  render(<TopologySiteRoster siteName="Main Office" roster={[{ groupId: 'g1', prefix: '10.1.5.0/24', gatewayAddresses: ['10.1.5.1'], kind: 'undeclared', memberNodeIds: [D1, D2] }]}
    nodesById={nodes} onSelect={onSelect} />);
  expect(screen.getByRole('button', { name: /Other \/ unidentified networks \(2\)/ })).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(screen.getByRole('button', { name: /Other \/ unidentified networks/ }));
  expect(screen.getByText('10.1.5.0/24 via 10.1.5.1')).toBeInTheDocument();
  expect(screen.getByText('Not declared for Main Office')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /DESKTOP-0NPDOPV/ }));
  expect(onSelect).toHaveBeenCalledWith({ kind: 'node', id: D1 });
  expect(screen.queryByText(/away/i)).toBeNull();
});
```

- [ ] **Step 5: Implement `TopologySiteRoster.tsx`, the toolbar toggle and the hint**

- A collapsible region (`aria-expanded`, `data-testid="topology-site-roster"`), collapsed by default.
- The toggle checkbox "Show other networks on the map" goes next to the existing "show all networks" box (`TopologyExplorer.tsx:199`). Its state lives in the hash (`useHashState`), following the URL-state rule.
- When `!siteHasDeclarations`, show the hint banner (`data-testid="topology-declare-hint"`): "No networks are declared for <site>. Devices are grouped by the networks they report. Declare this site's networks in a discovery profile so Breeze can tell visitors and misassigned devices apart." The banner links to `/discovery#profiles`.
- The header copy above the canvas reads "Devices assigned to <site>, grouped by the network each one reports".
- Inspector `GroupSummary`: "Declared for this site (discovery profile)" or "Not declared for <site>". An empty declared card reads "Declared for <site> — no device reports this network".
- `TopologyList` gets a "Declared" column.
- Add all keys to `en/topology.json` and the same English strings to the other locales.

- [ ] **Step 6: Run the web tests and confirm they pass**

Run: `cd apps/web && npx vitest run src/components/topology/`
Expected: PASS, including `TopologyExplorer.accessibility.test.tsx` and the locale parity tests.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/topology apps/web/src/locales
git commit -m "feat(topology): 'Other / unidentified networks' roster for undeclared networks (site location W1)"
```

### Task 4: Move hardening, API

**Files:**
- Modify: `apps/api/src/routes/devices/schemas.ts:207-220`
- Modify: `apps/api/src/routes/devices/core.ts:1814-1973`
- Test: create `apps/api/src/routes/devices/core.siteMove.test.ts` (copy the PATCH harness from `core.permissions.test.ts:143-233`)
- Test: create `apps/api/src/__tests__/integration/deviceSiteMoveGuard.integration.test.ts`

**Interfaces:**
- Produces:
  - `updateDeviceSchema` gains `expectedSiteId?: string` (guid) and `siteMoveTrigger?: 'manual' | 'topology_suggestion'`
  - 409 body `{ error: 'device_site_changed', currentSiteId?: string }`
  - Audit action `device.site_move` with `details: { fromSiteId, fromSiteName, toSiteId, toSiteName, expectedSiteId, trigger, suggestionState?, evidence? }`
  - Exported helper `siteMoveAuditDetails(input): Record<string, unknown>` in `core.ts`, which W3 extends

- [ ] **Step 1: Write the failing route tests** (`core.siteMove.test.ts`)

```ts
it('rejects with 409 when expectedSiteId differs from the current site, without writing', async () => {
  const res = await patch(deviceId, { siteId: SITE_B, expectedSiteId: SITE_C });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: 'device_site_changed', currentSiteId: SITE_A });
  expect(updateCalls).toHaveLength(0);
});
it('omits currentSiteId from the 409 when the caller cannot access the current site', async () => { /* allowedSiteIds = [SITE_B]; source check already 403s — assert 403, not 409 leak */ });
it('guards the UPDATE on the site read at the access check, even without expectedSiteId', async () => {
  updateReturningRows = [];               // simulate a concurrent move: the guarded UPDATE matches 0 rows
  const res = await patch(deviceId, { siteId: SITE_B });
  expect(res.status).toBe(409);
  expect(lastUpdateWhereSql()).toContain('site_id'); // the WHERE includes devices.site_id = SITE_A
  expect(denormalizedSiteUpdates).toHaveLength(0);   // savepoint rolled back, so no topology_node_bindings rewrite
});
it('writes a device.site_move audit with old/new site and the trigger', async () => {
  const res = await patch(deviceId, { siteId: SITE_B, expectedSiteId: SITE_A });
  expect(res.status).toBe(200);
  expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    action: 'device.site_move',
    details: expect.objectContaining({ fromSiteId: SITE_A, toSiteId: SITE_B, expectedSiteId: SITE_A, trigger: 'manual' }),
  }));
  expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'device.update' }));
});
it('does not write device.site_move when siteId is unchanged', async () => { /* … */ });
it('rejects an unknown siteMoveTrigger with 400', async () => { /* … */ });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd apps/api && npx vitest run src/routes/devices/core.siteMove.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Schema: `expectedSiteId: z.string().guid().optional(), siteMoveTrigger: z.enum(['manual', 'topology_suggestion']).optional()`. Strip both from `updates` before building the SET object, and from `changedFields`.
- After `getDeviceWithOrgAndSiteCheck`: `if (data.expectedSiteId && data.expectedSiteId !== device.siteId) return c.json({ error: 'device_site_changed', ...(canAccessSite(perms, device.siteId) ? { currentSiteId: device.siteId } : {}) }, 409);`
- In the `siteChanged` transaction: `.where(and(eq(devices.id, deviceId), eq(devices.siteId, device.siteId)))`. If `!row`, throw a local `SiteMoveConflict` inside the savepoint, so the denormalized loop never runs. Catch it outside and return the same 409 body (with `currentSiteId` re-read and gated by `canAccessSite`).
- After a successful site change, call `writeRouteAudit(c, { orgId, action: 'device.site_move', resourceType: 'device', resourceId, resourceName, details: siteMoveAuditDetails({ from: device.siteId, fromName, to: data.siteId, toName, expectedSiteId: data.expectedSiteId ?? null, trigger: data.siteMoveTrigger ?? 'manual' }) })`. The site names come from the destination lookup already done at core.ts:1842-1862 and one extra select for the source name.

- [ ] **Step 4: Run them and confirm they pass**

Run: `cd apps/api && npx vitest run src/routes/devices/core.siteMove.test.ts src/routes/devices/core.permissions.test.ts`
Expected: PASS.

- [ ] **Step 5: Integration test, concurrency against real Postgres**

`deviceSiteMoveGuard.integration.test.ts`: org with sites A, B and C, a device in A, and an org-admin with MFA claim (`setupTestEnvironment`). Fire `Promise.all([patch({siteId: B}), patch({siteId: C})])` through the real app.
- Expect statuses sorted `[200, 409]`.
- Expect the final `devices.site_id` to be the 200's target.
- Expect exactly one `audit_logs` row with `action = 'device.site_move'` (poll up to 2 s, because the audit is post-commit).
- Expect `topology_node_bindings.site_id` (when seeded) to match the final site.

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceSiteMoveGuard.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/devices/schemas.ts apps/api/src/routes/devices/core.ts apps/api/src/routes/devices/core.siteMove.test.ts apps/api/src/__tests__/integration/deviceSiteMoveGuard.integration.test.ts
git commit -m "fix(devices): expected-site guard and site-move audit on PATCH /devices/:id (site location W1)"
```

### Task 5: Move hardening, web

**Files:**
- Modify: `apps/web/src/components/devices/ChangeSiteModal.tsx:61-75`, `DeviceSettingsModal.tsx:80-94` and their tests
- Modify: `apps/web/src/locales/*/devices.json` (or the namespace these modals use)

- [ ] **Step 1: Write the failing tests**

```tsx
it('sends expectedSiteId with the current site and shows the policy-implication note', async () => {
  render(<ChangeSiteModal device={{ id: 'd1', siteId: 'site-a', hostname: 'PC-1' }} sites={sites} open onClose={vi.fn()} />);
  expect(screen.getByText(/configuration policies, maintenance windows, alert routing and reports/)).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText(/Site/), 'site-b');
  await userEvent.click(screen.getByRole('button', { name: /Move/ }));
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/devices/d1'), expect.objectContaining({
    method: 'PATCH', body: JSON.stringify({ siteId: 'site-b', expectedSiteId: 'site-a' }) }));
});
it('on 409 device_site_changed shows "This device was moved by someone else — reload to see its current site" and does not close', async () => { /* … */ });
```

Leave the network-asset use of `ChangeSiteModal` (`networkDevice/settings/IdentitySection.tsx`) unchanged. Gate the new field on the device variant only.

- [ ] **Step 2: Run them and confirm they fail.** Run: `cd apps/web && npx vitest run src/components/devices/ChangeSiteModal.test.tsx src/components/devices/DeviceSettingsModal.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement.** Add `expectedSiteId: device.siteId` to the device PATCH body. On `ActionError` with status 409 and body `error === 'device_site_changed'`, show the inline message. The note copy comes from S§10.3: "Moving changes which site's configuration policies, maintenance windows, alert routing and reports apply to <device>. Breeze will not move it back automatically."

- [ ] **Step 4: Run them and confirm they pass,** including `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices apps/web/src/locales
git commit -m "feat(web): send expected site and explain policy impact when moving a device (site location W1)"
```

### Task 6: Demo seed, Lakeside (branch `feat/topology-demo-seed`)

Do this on top of `feat/topology-demo-seed` (or `main`, once it merges). It is read-only for the docs branch.

**Files:**
- Modify: `apps/api/scripts/seed-topology-demo.lib.ts` (constants :43-49, `device()` :85, `demoDevices()` :96-140)
- Modify: `apps/api/scripts/seed-topology-demo.ts` (`seedInventory` :129-188, `neighborRows` :206-234, `fullReport` :236-295)
- Test: `apps/api/scripts/seed-topology-demo.lib.test.ts`

**Interfaces:**
- Produces: `DEMO_LAKESIDE_SITE_ID = '7090106e-de70-4a00-8000-00000000517f'`, `DEMO_LAKESIDE_SITE_NAME = 'Harbor Dental — Lakeside'`, `HOME_LAN = { prefix: '192.168.1.0/24', base: '192.168.1.', gateway: '192.168.1.1' }`, and `DemoDevice.siteId: 'main' | 'lakeside'`, `DemoDevice.lan: 'main' | 'second' | 'home'`.

- [ ] **Step 1: Write the failing fixture-count test**

```ts
it('seeds a Lakeside sister site owning 10.1.5.0/24 with misassigned, travelling and home-network devices', () => {
  const devices = demoDevices();
  const on = (site: string, lan: string) => devices.filter((d) => d.siteId === site && d.lan === lan).map((d) => d.hostname).sort();
  expect(on('main', 'second')).toEqual(['DESKTOP-0NPDOPV', 'WIN-92H1M08M1HB']);           // the 2 misassigned desktops
  expect(on('lakeside', 'second').length).toBeGreaterThanOrEqual(3);                      // Lakeside's own observers: gateway + ≥2 for MAC corroboration
  expect(on('lakeside', 'main')).toEqual(['LAPTOP-LOV-01']);                               // travelling laptop (visiting Main Office)
  expect(on('main', 'home')).toEqual(['LAPTOP-HOME-01']);                                  // home network laptop on 192.168.1.0/24
  expect(demoDiscoveryProfiles()).toEqual(expect.arrayContaining([
    expect.objectContaining({ siteId: DEMO_SITE_ID, subnets: ['10.1.2.0/24'] }),
    expect.objectContaining({ siteId: DEMO_LAKESIDE_SITE_ID, subnets: ['10.1.5.0/24'] }),
  ]));
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `cd apps/api && npx vitest run scripts/seed-topology-demo.lib.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

- Add a `siteId` field to `device()` (default `'main'`). Rename the existing `SURGERY-01` and add a fresh online second-LAN desktop so that exactly two Main-Office-assigned devices sit on 10.1.5.0/24, named `DESKTOP-0NPDOPV` and `WIN-92H1M08M1HB` and both fresh with `['neighbors']`.
- Reassign `SURGERY-02` and `CBCT-01` to Lakeside, and add `LAKESIDE-FD-01` and `LAKESIDE-OP-01` (fresh, `['neighbors']`, Lakeside, second LAN). Lakeside then has ≥ 2 fresh MAC-corroborating observers.
- Add `LAPTOP-LOV-01` (Lakeside, `lan: 'main'`, fresh, `['neighbors']`).
- Add `LAPTOP-HOME-01` (Main Office, `lan: 'home'`, fresh, `['neighbors']`, home router MAC `demoMac(9, 1)`).
- Move the discovery profile insert into `demoDiscoveryProfiles()`: Main "Main LAN sweep" `['10.1.2.0/24']`, Lakeside "Lakeside LAN sweep" `['10.1.5.0/24']`.
- In `seedInventory`, insert the Lakeside `sites` row and use `siteId` per device.
- In `fullReport`/`neighborRows`, add the `home` branch using `HOME_LAN`.
- Report each agent through the site it is assigned to. `publishUntilClean`/`reconcileTopologySite` must run for both sites.

- [ ] **Step 4: Run it and confirm it passes.** Then do a manual check on a `wt-stack`: run the seed (header :5-14) and confirm in the browser that Main Office's map shows `10.1.5.0/24` and `192.168.1.0/24` only in the roster, while Lakeside's map shows its own card.

- [ ] **Step 5: Commit** on the seed branch: `feat(seed): Lakeside sister site for site-location demo`.

### W1 gate

- [ ] `pnpm --filter @breeze/api test`, `pnpm --filter @breeze/web test`, `pnpm --filter @breeze/shared test` (full suites).
- [ ] Integration: `topologySiteDeclarations`, `deviceSiteMoveGuard`, `topologyBaselineAcceptance`, `topologyNeighbourCorroboration`.
- [ ] Playwright browser gates `topology-worker` and `topology-baseline` stay green.
- [ ] PR body: `Closes #<this wave's sub-issue>`; Settings rule 9 does not apply (no settings page).

---

## Wave 2: Anchors, fingerprints, bounded authorized presence, visitors

Branch: `feature/7884-topology-site-location/wave-<sub-issue#>` (sub-issue from `get_feature_status LanternOps/breeze#7884`).

### Task 1: Read-model migration, Drizzle schema, tenancy registrations

**Files:**
- Create: `apps/api/migrations/2026-12-05-120000-topology-presence-read-model.sql`. Before committing, run `ls apps/api/migrations | sort | tail -1` on current `origin/main` and rename so the file sorts after it.
- Create: `apps/api/src/db/schema/topologyPresence.ts`; export it from `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, alphabetical)
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (`REPOINT_TABLES` :728; `SPECIAL` :132 for `keep-survivor`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (near the topology entries :851-881)
- Modify: `apps/api/src/routes/devices/core.ts` (`CORE_DEVICE_ORG_DENORMALIZED_TABLES` :298, `CORE_DEVICE_ORG_MOVE_DELETE_TABLES` :409, `CORE_DEVICE_CASCADE_DELETE_TABLES` :541)
- Test: `apps/api/src/__tests__/integration/topologyPresenceReadModel.integration.test.ts`

**Interfaces:**
- Produces Drizzle tables `topologyOrgPresenceState`, `topologySiteFingerprints`, `topologyDevicePresence` with the columns in S§7.1 (camelCase), and SQL functions `breeze_topology_presence_mark_dirty(org uuid)` (SECURITY DEFINER) and triggers listed below.

- [ ] **Step 1: Write the failing integration test**

```ts
describe('topology presence read model — tenancy + invalidation', () => {
  it('forces RLS: a cross-org insert into each presence table fails with 42501', async () => {
    for (const table of ['topology_org_presence_state', 'topology_site_fingerprints', 'topology_device_presence']) {
      await expect(asOrg(orgA, () => insertRow(table, { orgId: orgB.id /* forged */ }))).rejects.toMatchObject({ code: '42501' });
    }
  });
  it('marks the org dirty when a discovery profile subnet changes, a baseline is added, or a site graph revision advances', async () => { /* assert dirty_at set after each */ });
  it('deletes the device presence row and marks dirty when devices.site_id changes', async () => { /* … */ });
  it('cross-org device move deletes the device presence rows (no restamp across a site FK)', async () => {
    // seed a presence row with matched_site_id = a source-org site, run moveDeviceOrgInTransaction, expect 0 rows and no 23503
  });
  it('org cascade delete removes all presence rows', async () => { /* cascadeDeleteOrg */ });
});
```

- [ ] **Step 2: Run it and confirm it fails** (the relations do not exist).

- [ ] **Step 3: Write the migration** (idempotent; no `BEGIN`; writes no rows)

```sql
CREATE TABLE IF NOT EXISTS topology_org_presence_state (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  fingerprint_version bigint NOT NULL DEFAULT 0 CHECK (fingerprint_version >= 0),
  coverage varchar(16) NOT NULL DEFAULT 'not_configured' CHECK (coverage IN ('complete','limited','not_configured')),
  coverage_reason varchar(64),
  dirty_at timestamptz,
  evaluated_at timestamptz,
  next_evaluation_at timestamptz,
  input_digest varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS topology_site_fingerprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  site_id uuid NOT NULL,
  family varchar(8) NOT NULL DEFAULT 'ipv4' CHECK (family = 'ipv4'),
  prefix cidr NOT NULL,
  gateway_address inet,
  status varchar(16) NOT NULL CHECK (status IN ('anchored','unconfirmed','ambiguous')),
  consumer_default boolean NOT NULL DEFAULT false,
  declared_by text[] NOT NULL DEFAULT '{}' CHECK (cardinality(declared_by) <= 2),
  declaration_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(declaration_ids) <= 32),
  observer_device_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(observer_device_ids) <= 64),
  gateway_macs jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(gateway_macs) = 'array' AND jsonb_array_length(gateway_macs) <= 16),
  neighbor_coverage varchar(16) NOT NULL DEFAULT 'limited' CHECK (neighbor_coverage IN ('complete','limited')),
  fingerprint_version bigint NOT NULL,
  evaluated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_site_fingerprints_site_fk FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_site_fingerprints_key_uniq
  ON topology_site_fingerprints (org_id, site_id, prefix, coalesce(gateway_address, '0.0.0.0'::inet));
CREATE INDEX IF NOT EXISTS topology_site_fingerprints_org_prefix_idx ON topology_site_fingerprints (org_id, prefix);
CREATE TABLE IF NOT EXISTS topology_device_presence (
  device_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  assigned_site_id uuid NOT NULL,
  state varchar(16) NOT NULL CHECK (state IN ('home','visiting','unrecognized','ambiguous','stale','unknown')),
  reason varchar(48),
  matched_site_id uuid,
  declaring_site_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(declaring_site_ids) <= 8),
  prefix cidr, gateway_address inet, gateway_mac macaddr,
  mac_corroborated boolean NOT NULL DEFAULT false,
  evidence jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 8),
  observed_at timestamptz, fresh_until timestamptz,
  fingerprint_version bigint NOT NULL,
  evaluated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_device_presence_device_fk FOREIGN KEY (device_id, org_id) REFERENCES devices (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT topology_device_presence_matched_site_fk FOREIGN KEY (matched_site_id, org_id) REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT topology_device_presence_visiting_chk CHECK ((state = 'visiting') = (matched_site_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS topology_device_presence_visiting_idx ON topology_device_presence (org_id, matched_site_id) WHERE state = 'visiting';
CREATE INDEX IF NOT EXISTS topology_device_presence_assigned_idx ON topology_device_presence (org_id, assigned_site_id);
-- RLS shape 1 for all three, using the four standard policies (copy the exact DO $$ … pg_policies existence-check blocks
-- from 2026-10-22-150100-topology-foundation.sql: breeze_org_isolation_select/insert/update/delete with breeze_has_org_access(org_id)).
ALTER TABLE topology_org_presence_state ENABLE ROW LEVEL SECURITY; ALTER TABLE topology_org_presence_state FORCE ROW LEVEL SECURITY;
ALTER TABLE topology_site_fingerprints ENABLE ROW LEVEL SECURITY; ALTER TABLE topology_site_fingerprints FORCE ROW LEVEL SECURITY;
ALTER TABLE topology_device_presence ENABLE ROW LEVEL SECURITY; ALTER TABLE topology_device_presence FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION breeze_topology_presence_mark_dirty(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO topology_org_presence_state (org_id, dirty_at) VALUES (p_org, now())
  ON CONFLICT (org_id) DO UPDATE SET dirty_at = coalesce(topology_org_presence_state.dirty_at, now()), updated_at = now();
END $$;

CREATE OR REPLACE FUNCTION breeze_topology_presence_declarations_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN PERFORM breeze_topology_presence_mark_dirty(OLD.org_id); END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN PERFORM breeze_topology_presence_mark_dirty(NEW.org_id); END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS breeze_topology_presence_profiles ON discovery_profiles;
CREATE TRIGGER breeze_topology_presence_profiles AFTER INSERT OR DELETE OR UPDATE OF subnets, enabled, site_id, org_id ON discovery_profiles
  FOR EACH ROW EXECUTE FUNCTION breeze_topology_presence_declarations_changed();
DROP TRIGGER IF EXISTS breeze_topology_presence_baselines ON network_baselines;
CREATE TRIGGER breeze_topology_presence_baselines AFTER INSERT OR DELETE OR UPDATE OF subnet, site_id, org_id ON network_baselines
  FOR EACH ROW EXECUTE FUNCTION breeze_topology_presence_declarations_changed();

CREATE OR REPLACE FUNCTION breeze_topology_presence_device_moved() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    DELETE FROM topology_device_presence WHERE device_id = NEW.id;
    PERFORM breeze_topology_presence_mark_dirty(OLD.org_id);
    IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN PERFORM breeze_topology_presence_mark_dirty(NEW.org_id); END IF;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS breeze_topology_presence_device_moved ON devices;
CREATE TRIGGER breeze_topology_presence_device_moved AFTER UPDATE OF site_id, org_id ON devices
  FOR EACH ROW EXECUTE FUNCTION breeze_topology_presence_device_moved();

CREATE OR REPLACE FUNCTION breeze_topology_presence_graph_published() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.graph_revision > OLD.graph_revision THEN PERFORM breeze_topology_presence_mark_dirty(NEW.org_id); END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS breeze_topology_presence_graph_published ON topology_site_state;
CREATE TRIGGER breeze_topology_presence_graph_published AFTER UPDATE OF graph_revision ON topology_site_state
  FOR EACH ROW EXECUTE FUNCTION breeze_topology_presence_graph_published();
```

Check the existing grants pattern: if `ensureAppRole.ts` restricts `EXECUTE` on SECURITY DEFINER functions, add `REVOKE ALL ON FUNCTION … FROM PUBLIC` as the existing cascade triggers do.

- [ ] **Step 4: Drizzle schema plus registrations**

- `CORE_ORG_CASCADE_DELETE_ORDER`: `topology_device_presence` (after `topology_config_templates`), `topology_org_presence_state` (after `topology_observations`), `topology_site_fingerprints` (after `topology_relationships`).
- `orgMergeRegistry`: `topology_device_presence` and `topology_site_fingerprints` go in `REPOINT_TABLES`. `topology_org_presence_state` goes in `SPECIAL` as `{ kind: 'keep-survivor' }`.
- Export policy:
  - `topology_org_presence_state`: everything `included`.
  - `topology_site_fingerprints`: `gateway_macs` → `excludedOpen`, the rest `included`.
  - `topology_device_presence`: `evidence` → `excludedOpen`, the rest `included`.
- `topology_device_presence` also goes in `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES` and `CORE_DEVICE_ORG_MOVE_DELETE_TABLES`. In `moveDeviceOrgInTransaction.ts`, the move-delete loop (:851) runs after the denormalized restamp loop. Restamping `org_id` would violate the composite `matched_site_id` FK unless it is deferred, so either move the core delete loop before the restamp loop or skip move-delete tables in the restamp loop. Pin the choice with the integration test from Step 1 and a `moveOrg.test.ts` ordering assertion.

- [ ] **Step 5: Run the contract suites**

```bash
cd apps/api && npx vitest run src/routes/devices/moveOrg.coverage.test.ts src/routes/devices/cascadeDelete.test.ts src/services/orgMerge.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/topologyPresenceReadModel.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm db:check-drift
```
Expected: all PASS. Then, as `breeze_app` (`docker exec -it <test-pg> psql -U breeze_app`), forge a cross-tenant insert into each table and confirm it fails with `new row violates row-level security policy`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations apps/api/src/db/schema apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/routes/devices/core.ts apps/api/src/services/deviceOrgMove apps/api/src/__tests__/integration/topologyPresenceReadModel.integration.test.ts
git commit -m "feat(topology): presence read-model tables, RLS, invalidation triggers (site location W2)"
```

### Task 2: Shared consumer-default list and presence DTO

**Files:**
- Modify: `packages/shared/src/validators/topology.ts` (near `topologyNetworkClass` :206)
- Create: `packages/shared/src/validators/topologyPresence.ts` (+ `.test.ts`), exported from the validators index

**Interfaces:**
- Produces:
  - `TOPOLOGY_CONSUMER_DEFAULT_PREFIXES: readonly string[]`
  - `isTopologyConsumerDefaultPrefix(prefix: string): boolean`
  - `presenceResponseSchema`, `PresenceResponse`
  - `PRESENCE_STATES = ['home','visiting','unrecognized','ambiguous','stale','unknown'] as const`
  - `PRESENCE_REASONS = ['not_declared','own_gateway_mismatch','own_gateway_mac_conflict','multiply_declared','declared_unconfirmed','gateway_mismatch','consumer_uncorroborated','gateway_mac_conflict','coverage_limited','no_fresh_observation','not_current'] as const`

- [ ] **Step 1: Write the failing tests**

```ts
it.each([['192.168.1.0/24', true], ['192.168.69.0/24', true /* inside 192.168.68.0/22 */], ['192.168.68.0/24', true], ['10.1.5.0/24', false], ['10.0.0.0/24', true], ['10.0.0.0/16', true /* overlaps */], ['172.16.5.0/24', false]])(
  'isTopologyConsumerDefaultPrefix(%s) = %s', (prefix, expected) => expect(isTopologyConsumerDefaultPrefix(prefix)).toBe(expected));
it('presence response: strict, authority false, bounded', () => {
  expect(presenceResponseSchema.safeParse(samplePresence()).success).toBe(true);
  expect(presenceResponseSchema.safeParse({ ...samplePresence(), authority: true }).success).toBe(false);
  expect(presenceResponseSchema.safeParse({ ...samplePresence(), visitors: Array(501).fill(sampleVisitor()) }).success).toBe(false);
  expect(presenceResponseSchema.safeParse({ ...samplePresence(), visitors: [{ ...sampleVisitor(), canonicalNodeId: 'x' }] }).success).toBe(false); // R6
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `cd packages/shared && npx vitest run src/validators/topologyPresence.test.ts src/validators/topology.test.ts`.

- [ ] **Step 3: Implement** the constant with the exact list from S§6.5. `isTopologyConsumerDefaultPrefix` returns true if the IPv4 ranges overlap (either contains the other). Build the schema from S§9 with `.strict()` everywhere, `schemaVersion: z.literal(1)`, `authority: z.literal(false)`, `assigned.max(1000)`, `visitors.max(500)`, `declaredNetworks.max(256)`, and `suggestion: suggestionSchema.nullable()` (W2 always emits `null`).

- [ ] **Step 4: Run them and confirm they pass. Step 5: Commit** `feat(shared): consumer-default prefixes and topology presence DTO (site location W2)`.

### Task 3: Pure presence classifier

**Files:**
- Create: `apps/api/src/services/topology/presenceClassifier.ts`, `presenceClassifier.test.ts`

**Interfaces:**
- Consumes: `isTopologyConsumerDefaultPrefix` (Task 2).
- Produces:

```ts
export type PresenceAttachment = { prefix: string; gateway: string; mac: string | null; confirmedAt: string; freshUntil: string;
  relationshipIds: string[]; observerNodeId: string; interfaceName: string | null };
export type FingerprintRow = { siteId: string; prefix: string; gatewayAddress: string | null; status: 'anchored' | 'unconfirmed' | 'ambiguous';
  consumerDefault: boolean; observerDeviceIds: string[]; gatewayMacs: { mac: string; observerDeviceIds: string[] }[]; neighborCoverage: 'complete' | 'limited' };
export type FingerprintIndex = { coverage: 'complete' | 'limited'; declarers: Map<string, string[]>; rows: Map<string, FingerprintRow[]> /* key `${siteId}|${prefix}` */ };
export type AttachmentClass = { classification: 'home' | 'visiting' | 'unrecognized' | 'ambiguous' | 'unknown'; siteId: string | null;
  reason: PresenceReason | null; declaringSiteIds: string[]; macCorroborated: boolean };
export type DevicePresence = { state: PresenceState; reason: PresenceReason | null; matchedSiteId: string | null; declaringSiteIds: string[];
  attachment: PresenceAttachment | null; macCorroborated: boolean; evidence: (PresenceAttachment & AttachmentClass)[] };
export function buildFingerprintIndex(rows: FingerprintRow[], coverage: 'complete' | 'limited'): FingerprintIndex;
export function corroboratedMacs(index: FingerprintIndex, siteId: string, prefix: string, gateway: string, excludeDeviceId: string): Set<string> | null;
export function classifyAttachment(a: PresenceAttachment, deviceId: string, assignedSiteId: string, index: FingerprintIndex): AttachmentClass;
export function classifyDevicePresence(input: { deviceId: string; assignedSiteId: string; attachments: PresenceAttachment[]; index: FingerprintIndex; now: Date }): DevicePresence;
```

- [ ] **Step 1: Write failing table tests**, one per S§4.1/§4.2 branch:

```ts
const A = 'site-a', B = 'site-b', C = 'site-c', D = 'dev-1';
const fp = (o: Partial<FingerprintRow> & Pick<FingerprintRow, 'siteId' | 'prefix'>): FingerprintRow => ({ gatewayAddress: null, status: 'anchored', consumerDefault: false,
  observerDeviceIds: ['o1'], gatewayMacs: [], neighborCoverage: 'complete', ...o });
const att = (prefix: string, gateway: string, mac: string | null = null): PresenceAttachment => ({ prefix, gateway, mac, confirmedAt: T0, freshUntil: T1, relationshipIds: ['r1'], observerNodeId: 'n1', interfaceName: 'eth0' });
const index = (rows: FingerprintRow[], coverage: 'complete' | 'limited' = 'complete') => buildFingerprintIndex(rows, coverage);

it.each<[string, FingerprintRow[], PresenceAttachment, Partial<AttachmentClass>]>([
  ['undeclared → unrecognized', [], att('10.1.5.0/24', '10.1.5.1'), { classification: 'unrecognized', reason: 'not_declared' }],
  ['own declared + own gateway → home', [fp({ siteId: A, prefix: '10.1.2.0/24', gatewayAddress: '10.1.2.100', observerDeviceIds: [D] })], att('10.1.2.0/24', '10.1.2.100'), { classification: 'home', siteId: A }],
  ['own declared, other gateway → unrecognized own_gateway_mismatch', [fp({ siteId: A, prefix: '10.1.2.0/24', gatewayAddress: '10.1.2.100' })], att('10.1.2.0/24', '10.1.2.254'), { classification: 'unrecognized', reason: 'own_gateway_mismatch' }],
  ['B declared + B gateway (non-consumer) → visiting B', [fp({ siteId: B, prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1' })], att('10.1.5.0/24', '10.1.5.1'), { classification: 'visiting', siteId: B, macCorroborated: false }],
  ['B declared, no B observer → declared_unconfirmed', [fp({ siteId: B, prefix: '10.1.5.0/24', status: 'unconfirmed', observerDeviceIds: [] })], att('10.1.5.0/24', '10.1.5.1'), { classification: 'unrecognized', reason: 'declared_unconfirmed', siteId: B }],
  ['B declared, other gateway → gateway_mismatch', [fp({ siteId: B, prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1' })], att('10.1.5.0/24', '10.1.5.254'), { classification: 'unrecognized', reason: 'gateway_mismatch' }],
  ['non-consumer MAC conflict vetoes', [fp({ siteId: B, prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1', gatewayMacs: [{ mac: 'aa:aa:aa:aa:aa:01', observerDeviceIds: ['o1', 'o2'] }] })], att('10.1.5.0/24', '10.1.5.1', 'bb:bb:bb:bb:bb:02'), { classification: 'unrecognized', reason: 'gateway_mac_conflict' }],
  ['consumer prefix needs MAC from ≥2 B observers', [fp({ siteId: B, prefix: '192.168.1.0/24', gatewayAddress: '192.168.1.1', consumerDefault: true, gatewayMacs: [{ mac: 'aa:aa:aa:aa:aa:01', observerDeviceIds: ['o1'] }] })], att('192.168.1.0/24', '192.168.1.1', 'aa:aa:aa:aa:aa:01'), { classification: 'unrecognized', reason: 'consumer_uncorroborated' }],
  ['consumer prefix with 2-observer MAC → visiting', [fp({ siteId: B, prefix: '192.168.1.0/24', gatewayAddress: '192.168.1.1', consumerDefault: true, gatewayMacs: [{ mac: 'aa:aa:aa:aa:aa:01', observerDeviceIds: ['o1', 'o2'] }] })], att('192.168.1.0/24', '192.168.1.1', 'aa:aa:aa:aa:aa:01'), { classification: 'visiting', siteId: B, macCorroborated: true }],
  ['consumer prefix, B neighbour coverage limited → uncorroborated', [fp({ siteId: B, prefix: '192.168.1.0/24', gatewayAddress: '192.168.1.1', consumerDefault: true, neighborCoverage: 'limited', gatewayMacs: [{ mac: 'aa:aa:aa:aa:aa:01', observerDeviceIds: ['o1', 'o2'] }] })], att('192.168.1.0/24', '192.168.1.1', 'aa:aa:aa:aa:aa:01'), { classification: 'unrecognized', reason: 'consumer_uncorroborated' }],
  ['declared by B and C → ambiguous', [fp({ siteId: B, prefix: '192.168.1.0/24', status: 'ambiguous' }), fp({ siteId: C, prefix: '192.168.1.0/24', status: 'ambiguous' })], att('192.168.1.0/24', '192.168.1.1'), { classification: 'ambiguous', reason: 'multiply_declared' }],
  ['declared by A and C, own gateway, no conflict → home (refinement)', [fp({ siteId: A, prefix: '192.168.1.0/24', gatewayAddress: '192.168.1.1', status: 'ambiguous', consumerDefault: true }), fp({ siteId: C, prefix: '192.168.1.0/24', status: 'ambiguous' })], att('192.168.1.0/24', '192.168.1.1'), { classification: 'home', siteId: A }],
])('%s', (_name, rows, a, expected) => expect(classifyAttachment(a, D, A, index(rows))).toMatchObject(expected));

it('excludes the subject device from MAC corroboration (leave-one-out)', () => {
  const rows = [fp({ siteId: B, prefix: '192.168.1.0/24', gatewayAddress: '192.168.1.1', consumerDefault: true, gatewayMacs: [{ mac: 'aa:aa:aa:aa:aa:01', observerDeviceIds: [D, 'o1'] }] })];
  expect(classifyAttachment(att('192.168.1.0/24', '192.168.1.1', 'aa:aa:aa:aa:aa:01'), D, A, index(rows)).classification).toBe('unrecognized');
});
it('org coverage limited turns a would-be visit into unknown', () => {
  expect(classifyAttachment(att('10.1.5.0/24', '10.1.5.1'), D, A, index([fp({ siteId: B, prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1' })], 'limited')).classification).toBe('unknown');
});
describe('classifyDevicePresence', () => {
  it('no attachments → stale/no_fresh_observation', () => { /* … */ });
  it('home wins over a simultaneous visit (multi-homed)', () => { /* … */ });
  it('visiting one site plus an unrecognized side network → visiting', () => { /* … */ });
  it('visiting two sites → ambiguous', () => { /* … */ });
  it('expired attachment (freshUntil <= now) is ignored', () => { /* … */ });
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `cd apps/api && npx vitest run src/services/topology/presenceClassifier.test.ts`.

- [ ] **Step 3: Implement** S§4.1 in order.

```ts
export function classifyAttachment(a: PresenceAttachment, deviceId: string, assigned: string, index: FingerprintIndex): AttachmentClass {
  const declarers = index.declarers.get(a.prefix) ?? [];
  const base = { declaringSiteIds: declarers, macCorroborated: false };
  if (!declarers.length) return { ...base, classification: 'unrecognized', siteId: null, reason: 'not_declared' };
  if (declarers.includes(assigned)) {
    const own = (index.rows.get(`${assigned}|${a.prefix}`) ?? []).filter((r) => r.gatewayAddress === a.gateway);
    if (own.length) {
      const macs = corroboratedMacs(index, assigned, a.prefix, a.gateway, deviceId);
      const conflict = !!a.mac && !!macs && macs.size > 0 && !macs.has(a.mac);
      if (!conflict) return { ...base, classification: 'home', siteId: assigned, reason: null, macCorroborated: !!a.mac && !!macs?.has(a.mac) };
      if (declarers.length === 1) return { ...base, classification: 'unrecognized', siteId: assigned, reason: 'own_gateway_mac_conflict' };
    } else if (declarers.length === 1) return { ...base, classification: 'unrecognized', siteId: assigned, reason: 'own_gateway_mismatch' };
  }
  if (declarers.length >= 2) return { ...base, classification: 'ambiguous', siteId: null, reason: 'multiply_declared' };
  const b = declarers[0]!;
  if (index.coverage === 'limited') return { ...base, classification: 'unknown', siteId: null, reason: 'coverage_limited' };
  const rows = index.rows.get(`${b}|${a.prefix}`) ?? [];
  if (!rows.some((r) => r.gatewayAddress)) return { ...base, classification: 'unrecognized', siteId: b, reason: 'declared_unconfirmed' };
  if (!rows.some((r) => r.gatewayAddress === a.gateway)) return { ...base, classification: 'unrecognized', siteId: b, reason: 'gateway_mismatch' };
  const macs = corroboratedMacs(index, b, a.prefix, a.gateway, deviceId);
  if (rows[0]!.consumerDefault) {
    return a.mac && macs?.has(a.mac)
      ? { ...base, classification: 'visiting', siteId: b, reason: null, macCorroborated: true }
      : { ...base, classification: 'unrecognized', siteId: b, reason: 'consumer_uncorroborated' };
  }
  if (a.mac && macs && macs.size > 0 && !macs.has(a.mac)) return { ...base, classification: 'unrecognized', siteId: b, reason: 'gateway_mac_conflict' };
  return { ...base, classification: 'visiting', siteId: b, reason: null, macCorroborated: !!a.mac && !!macs?.has(a.mac) };
}
export function corroboratedMacs(index: FingerprintIndex, siteId: string, prefix: string, gateway: string, exclude: string): Set<string> | null {
  const rows = (index.rows.get(`${siteId}|${prefix}`) ?? []).filter((r) => r.gatewayAddress === gateway);
  if (!rows.length || rows.some((r) => r.neighborCoverage === 'limited')) return null;
  const out = new Set<string>();
  for (const r of rows) for (const m of r.gatewayMacs) if (m.observerDeviceIds.filter((id) => id !== exclude).length >= 2) out.add(m.mac);
  return out;
}
```

`classifyDevicePresence` drops attachments with `Date.parse(freshUntil) <= now`, classifies the rest, and applies the S§4.2 table in order. The chosen `attachment` is the deciding one (home, then the visiting one, then the first by prefix order). `evidence` holds at most 8 entries.

- [ ] **Step 4: Run them and confirm they pass. Step 5: Commit** `feat(topology): pure presence classifier (site location W2)`.

### Task 4: Anchor evidence and attachment readers

**Files:**
- Modify: `apps/api/src/services/topology/siteNetworkDeclarations.ts` (add `readOrgNetworkDeclarations`)
- Create: `apps/api/src/services/topology/presenceInputs.ts`
- Modify: `apps/api/src/services/topology/neighborEvidence.ts` (`readNeighborEvidence` :223 gains `options?: { freshnessHorizonSeconds?: number }`, default unchanged)
- Create: `apps/api/src/__tests__/integration/topology-presence-fixtures.ts`
- Test: `apps/api/src/__tests__/integration/topologyPresenceInputs.integration.test.ts`

**Interfaces:**
- Produces:
  - `readOrgNetworkDeclarations(tx, orgId): Promise<{ bySite: Map<string, Map<string, DeclarationSource[]>>; ignored: number }>`
  - `readSiteAnchorEvidence(tx, scope, prefixes: string[], horizonSeconds: number): Promise<{ prefix: string; gateway: string; observerDeviceId: string; mac: string | null; confirmedAt: string }[] & { neighborCoverage: 'complete'|'limited' }>`. Only devices whose live `devices.site_id = scope.siteId` count.
  - `readDeviceAttachments(tx, scope): Promise<Map<deviceId, PresenceAttachment[]>>`. Fresh only. IPv4 `lan` class only, via `topologyNetworkClass(prefix, interfaceKind)`. Tunnel interfaces excluded. Gateways on the same interface and context. MAC from the device's own neighbour row (NC gateway policy, `coverage === 'complete'` only).
  - Fixture `twoSiteOrg(opts)` returns `{ orgId, siteA, siteB, report(deviceId, siteId, { prefix, gateway, mac?, neighbors? }), publish(siteId), users: { both, onlyA, onlyB }, apiKeyOnlyA }`. It reports through `negotiateTopologyContext` → `ingestTopologyNetworkContext` → `reconcileTopologySite`, as `topologyNeighbourCorroboration.integration.test.ts` does.

- [ ] **Step 1: Write the failing integration tests**

```ts
it('anchor evidence counts only devices assigned to the declaring site, within the horizon', async () => {
  const f = await twoSiteOrg();
  await f.report(LOV1, f.siteB, { prefix: '10.1.5.0/24', gateway: '10.1.5.1', mac: GW_MAC });        // Lakeside-assigned
  await f.report(MIS1, f.siteA, { prefix: '10.1.5.0/24', gateway: '10.1.5.1', mac: GW_MAC });        // misassigned to Main Office
  await f.publish(f.siteA); await f.publish(f.siteB);
  const ev = await system(() => readSiteAnchorEvidence(db, { orgId: f.orgId, siteId: f.siteB }, ['10.1.5.0/24'], 7 * 86400));
  expect(ev.map((e) => e.observerDeviceId)).toEqual([LOV1]);       // MIS1 never anchors Lakeside
});
it('device attachments exclude tunnels, non-lan prefixes and expired evidence, and pair gateways by interface', async () => { /* … */ });
it('readOrgNetworkDeclarations returns every site of the org and none of another org', async () => { /* … */ });
```

- [ ] **Step 2: Run them and confirm they fail. Step 3: Implement** the SQL by reusing the CTE shape of `readPresentationGroupInput` (`site_nodes`, `rels`, `memberships` with `observedFreshUntilSql`), joined to `topology_node_bindings` → `devices` for the observer's device ID and live `site_id`. The horizon variant replaces `> now()` with `> now() - make_interval(secs => ${horizon})` on the confirmation time. **Step 4: Run them and confirm they pass. Step 5: Commit** `feat(topology): anchor evidence and attachment readers for presence (site location W2)`.

### Task 5: Evaluator and worker

**Files:**
- Create: `apps/api/src/services/topology/presenceEvaluator.ts` (+ `.test.ts` for pure helpers: caps, `fresh_until`, digest)
- Create: `apps/api/src/jobs/topologyPresenceWorker.ts` (+ `.test.ts`)
- Modify: worker boot (wherever `topologyTelemetryMaintenance` is started; `grep -rn "startTopologyTelemetryMaintenance" apps/api/src`)
- Test: `apps/api/src/__tests__/integration/topologyPresenceEvaluation.integration.test.ts`

**Interfaces:**
- Produces:
  - `evaluateOrgPresence(orgId: string, now?: Date): Promise<{ status: 'evaluated' | 'busy' | 'not_configured'; version: bigint; devices: number; coverage: 'complete'|'limited'|'not_configured' }>`
  - `runTopologyPresenceTick(now?: Date): Promise<{ evaluated: number; busy: number; failed: number }>`
  - `TOPOLOGY_PRESENCE_INTERVAL_MS = 60_000`, `PRESENCE_ORGS_PER_TICK = 20`, `PRESENCE_DIRTY_DEBOUNCE_MS = 30_000`, `PRESENCE_REEVALUATE_MS = 3_600_000`, `PRESENCE_FRESH_CAP_MS = 75 * 60_000`, `FINGERPRINT_CAP = 1024`, `DECLARING_SITE_CAP = 256`, `DEVICE_CAP = 20_000`, `ANCHOR_HORIZON_SECONDS = 7 * 86_400`

- [ ] **Step 1: Write the failing integration test** (the Main Office/Lakeside scenario from the spec)

```ts
it('Main Office/Lakeside: misassigned desktops visit Lakeside, Lakeside laptop visits Main Office, home laptop unrecognized', async () => {
  const f = await twoSiteOrg({ declare: { A: ['10.1.2.0/24'], B: ['10.1.5.0/24'] } });
  await f.report(W1, f.siteA, lanA); await f.report(W2, f.siteA, lanA);                    // Main Office own
  await f.report(L1, f.siteB, lanB); await f.report(L2, f.siteB, lanB);                    // Lakeside own
  await f.report(MIS1, f.siteA, lanB); await f.report(MIS2, f.siteA, lanB);                // misassigned
  await f.report(LAP, f.siteB, lanA);                                                      // travelling
  await f.report(HOME, f.siteA, { prefix: '192.168.1.0/24', gateway: '192.168.1.1', mac: HOME_MAC });
  await f.publishAll();
  const r = await evaluateOrgPresence(f.orgId);
  expect(r.coverage).toBe('complete');
  const rows = await f.presenceRows();
  expect(rows[MIS1]).toMatchObject({ state: 'visiting', matched_site_id: f.siteB, assigned_site_id: f.siteA });
  expect(rows[LAP]).toMatchObject({ state: 'visiting', matched_site_id: f.siteA });
  expect(rows[HOME]).toMatchObject({ state: 'unrecognized', reason: 'not_declared' });
  expect(rows[W1]).toMatchObject({ state: 'home' });
  expect(new Set(Object.values(rows).map((x) => x.fingerprint_version))).toEqual(new Set([r.version.toString()]));
});
it('a Lakeside with no own observers yields declared_unconfirmed for the misassigned desktops (bootstrap gap, S§6.4)', async () => { /* … */ });
it('two evaluators race: one gets busy (advisory lock), versions never interleave', async () => { /* Promise.all two evaluateOrgPresence */ });
it('fresh_until never exceeds now + 75 min and never exceeds the supporting evidence', async () => { /* … */ });
it('clears dirty_at only when dirty_at <= evaluation start (a change during evaluation stays dirty)', async () => { /* … */ });
it('not_configured org: no declarations → all fingerprints and presence rows deleted', async () => { /* … */ });
```

- [ ] **Step 2: Run it and confirm it fails. Step 3: Implement** S§7.2 exactly, in one `runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(...)))` per org. Take `pg_try_advisory_xact_lock(hashtext('topology_presence:' || orgId))` first and return `busy` if it fails. Stamp `fingerprint_version = state.fingerprint_version + 1`. Delete presence rows for devices no longer bound. The worker selects due orgs with:

```sql
SELECT org_id FROM topology_org_presence_state
WHERE (dirty_at IS NOT NULL AND dirty_at <= now() - interval '30 seconds')
   OR (coverage <> 'not_configured' AND (next_evaluation_at IS NULL OR next_evaluation_at <= now()))
ORDER BY dirty_at NULLS LAST, next_evaluation_at NULLS FIRST LIMIT 20
```

- [ ] **Step 4: Run it and confirm it passes,** plus the unit tests for the worker scheduling (fake timers, single in-flight tick as in `topologyTelemetryMaintenance.ts`). **Step 5: Commit** `feat(topology): presence evaluator and worker (site location W2)`.

### Task 6: Presence read, visibility gate, route (mandatory leak tests)

**Files:**
- Create: `apps/api/src/services/topology/presenceVisibility.ts`, `presenceRead.ts` (+ `.test.ts`)
- Create: `apps/api/src/routes/topology/presence.ts`; mount in `apps/api/src/routes/topology/index.ts`
- Test: `apps/api/src/__tests__/integration/topologyPresenceVisibility.integration.test.ts`
- Test: `apps/api/src/services/topology/aiPresenceIsolation.test.ts`

**Interfaces:**
- Consumes: `graphAuthority(ctx)` and `topologyReadEtag` (`graphCursor.ts`); `requireTopologySiteCapability('read')` (`routes/topology/middleware.ts`).
- Produces:
  - `siteVisibility(ctx: TopologyRequestContext, current: UserPermissions): (siteId: string) => boolean`
  - `readSitePresence(ctx: TopologyRequestContext, now?: Date): Promise<{ body: PresenceResponse; etag: string }>`
  - Route `GET /topology/sites/:siteId/presence` with 200 + ETag, 304 on `If-None-Match`, and the same 404/403 mapping as graphs.

- [ ] **Step 1: Write the failing leak tests** (real Postgres; all mandatory)

```ts
describe('presence visibility — cross-site leak tests', () => {
  it('viewer with A and B: B shows the A-owned visitors; A roster names Lakeside', async () => { /* users.both */ });
  it('viewer with only A: hidden visiting match is byte-identical to unrecognized', async () => {
    const onlyA = await get(f.users.onlyA, f.siteA);
    const mis = onlyA.assigned.find((x) => x.deviceId === MIS1)!;
    const home = onlyA.assigned.find((x) => x.deviceId === HOME)!;                  // genuinely unrecognized (not_declared)
    const shape = (x: typeof mis) => ({ state: x.state, reason: x.reason, matchedSite: x.matchedSite, declaringSites: x.declaringSites,
      macCorroborated: x.macCorroborated, suggestion: x.suggestion, keys: Object.keys(x).sort() });
    expect(shape(mis)).toEqual(shape(home));                                         // identical apart from the device's own identity/evidence
    expect(mis).toMatchObject({ state: 'unrecognized', reason: null, matchedSite: null, declaringSites: null, suggestion: null });
    expect(JSON.stringify(onlyA)).not.toContain(f.siteB);
    expect(JSON.stringify(onlyA)).not.toContain('Lakeside');
    expect(onlyA.counts.observedElsewhere).toBe(0);
  });
  it('viewer with only B: A-owned visitors are absent, uncounted, untruncated', async () => {
    const onlyB = await get(f.users.onlyB, f.siteB);
    expect(onlyB.visitors).toEqual([]);
    expect(onlyB.counts.visiting).toBe(0);
    expect(onlyB.truncated.visitors).toBe(false);
    expect(JSON.stringify(onlyB)).not.toContain(MIS1);
    expect(JSON.stringify(onlyB)).not.toContain(f.siteA);
  });
  it('API key site ceiling hides other-site visitors even when the role is unrestricted', async () => { /* apiKeyOnlyA on site A: like onlyA */ });
  it('ambiguous is shown as unrecognized unless every declaring site is visible', async () => { /* site C declares 192.168.1.0/24 too */ });
  it('declared_unconfirmed hint names B only for B viewers', async () => { /* … */ });
  it('visitor DTO never carries site A canonical node/relationship ids', async () => {
    const both = await get(f.users.both, f.siteB);
    const aIds = await f.canonicalIds(f.siteA);
    for (const id of aIds) expect(JSON.stringify(both.visitors)).not.toContain(id);
  });
  it('ETag differs between onlyA and both for the same site', async () => { /* … */ });
  it('expired, version-mismatched or assignment-mismatched rows present as stale/not_current', async () => { /* … */ });
  it('a user from another org gets 404 for the site', async () => { /* … */ });
});
```

`aiPresenceIsolation.test.ts`:

```ts
it('no AI topology module imports presence modules', () => {
  const files = globSync('src/services/topology/ai*.ts', { cwd: API_ROOT });
  for (const f of files) expect(readFileSync(join(API_ROOT, f), 'utf8')).not.toMatch(/presence(Read|Evaluator|Classifier|Visibility|Inputs)/);
});
```

- [ ] **Step 2: Run them and confirm they fail. Step 3: Implement**

- `siteVisibility` combines the three checks from S§8. `current` comes from the same re-read `graphAuthority` performs; expose the permissions it fetched as an extra return field instead of fetching twice.
- `readSitePresence` runs in the request's RLS context with bounded statements:
  - (a) Presence rows for devices with live `site_id = viewed` and state ≠ home, `LIMIT 1001`.
  - (b) Visiting rows with `matched_site_id = viewed`, joined to live `devices.site_id ≠ viewed`, `LIMIT 501`, filtered by `visible(devices.site_id)` **before** counting and truncation.
  - (c) The viewed site's fingerprints.
  - (d) The org state row.
- Serialize hidden matches through one function, `asUnrecognized(row)`, so the byte-identical guarantee has a single code path. It sets `state: 'unrecognized'`, `reason: null`, `matchedSite: null`, `declaringSites: null`, `suggestion: null` and `macCorroborated: false`.
- Serialize a reason only when it names a visible site. `not_declared` always serializes as `null` (S§8 R4).
- Look up site names only for visible IDs.
- Presentation IDs: `presentation:overview:<scopeHash>:visitor-<sha256(deviceId).slice(0,40)>`.

- [ ] **Step 4: Run them and confirm they pass. Step 5: Commit** `feat(topology): site-gated presence endpoint (site location W2)`.

### Task 7: Web, visitors, badges, roster sections, declaration copy

**Files:**
- Modify: `apps/web/src/components/topology/topologyApi.ts` (add `presence(siteId)`), create `useTopologyPresence.ts` (+ test)
- Create: `apps/web/src/components/topology/visitorPlacement.ts` (+ test)
- Modify: `renderProjection.ts` (visitor nodes, hide visiting devices from home cards), `TopologyCanvas.tsx` (visitor tile style: dashed border, "Visiting" badge, neutral colour token), `TopologyInspector.tsx`, `TopologySiteRoster.tsx` (sections "Observed at other sites", "Other / unidentified networks", "Location unknown")
- Modify: `apps/web/src/components/discovery/DiscoveryProfileForm.tsx`, `NetworkBaselinesPanel.tsx` (note "Subnets here also identify this site's networks on the topology map.")
- Modify: locales

**Interfaces:**
- Produces:
  - `placeVisitors(groups: PresentationNode[], visitors: PresenceResponse['visitors']): { byGroup: Map<groupId, Visitor[]>; unplaced: Visitor[] }`
  - `compileTopologyRender(graph, opts, presence?)`

- [ ] **Step 1: Write failing tests**

```ts
it('places a visitor in the card with the same prefix whose gateway set contains its gateway, preferring declared cards', () => {
  const groups = [card('g1', '10.1.5.0/24', ['10.1.5.1'], 'declared'), card('g2', '10.1.5.0/24', ['10.1.5.254'], 'undeclared')];
  expect(placeVisitors(groups, [visitor('v1', '10.1.5.0/24', '10.1.5.1')]).byGroup.get('g1')).toHaveLength(1);
  expect(placeVisitors(groups, [visitor('v2', '10.1.9.0/24', '10.1.9.1')]).unplaced).toHaveLength(1);
});
it('home map: a visiting device leaves its network card and appears under "Observed at other sites"', () => { /* renderProjection + roster */ });
it('visitor tile: badge "Visiting", subtitle "Assigned to Main Office", not pinnable, no Diagnose action, not counted in card members', () => { /* … */ });
it('hidden match (state unrecognized, reason null) renders under "Other / unidentified networks" with no hint', () => { /* … */ });
it('never renders the word "away"', () => { /* scan rendered text of every roster section */ });
```

- [ ] **Step 2: Run them and confirm they fail. Step 3: Implement** to S§4.3 and S§9. The presence refresh never re-runs layout when only `freshUntil` or `observedAt` change (key the layout input on visitor IDs plus card IDs). **Step 4: Run them and confirm they pass,** including accessibility tests: visitor tiles carry a text alternative "Visiting device, assigned to <A>". **Step 5: Commit** `feat(web): render cross-site visitors and presence roster (site location W2)`.

### W2 gate

- [ ] Full API, web and shared suites. Run every contract command from W2 Task 1 Step 5 again on the final branch.
- [ ] Seed (W1 Task 6) on a `wt-stack`, then with Playwright as a user with both sites:
  - Main Office map: the two desktops are under "Observed at other sites", LAPTOP-HOME-01 is under "Other / unidentified networks", and LAPTOP-LOV-01 renders in the 10.1.2.0/24 card with the "Visiting" badge.
  - Lakeside map: the two desktops render as visitors in the 10.1.5.0/24 card.
- [ ] Repeat as an org user restricted to Main Office. The desktops show as unidentified, "Lakeside" appears nowhere in the page, and the network panel shows nothing about Lakeside.
- [ ] Browser gates `topology-worker`, `topology-baseline` and `topology-performance` stay green.
- [ ] PR: `Closes #<this wave's sub-issue>`; one independent review round (Sonnet or Opus, because tenancy is touched).

---

## Wave 3: Daily presence summaries, suggestions, dismissal

Branch: `feature/7884-topology-site-location/wave-<sub-issue#>` (sub-issue from `get_feature_status LanternOps/breeze#7884`).

### Task 1: Migration — presence days, suggestion columns, `devices.site_assignment_confirmed_at`

**Files:**
- Create: `apps/api/migrations/2026-12-05-130000-topology-presence-days-and-confirmation.sql`. As in W2, rename it to sort after the newest committed migration.
- Modify: `apps/api/src/db/schema/topologyPresence.ts`, `apps/api/src/db/schema/devices.ts` (`siteAssignmentConfirmedAt: timestamp('site_assignment_confirmed_at', { withTimezone: true })`)
- Modify: registries:
  - `tenantCascade.ts`: `topology_device_presence_days` right after `topology_device_presence`
  - `orgMergeRegistry.ts`: `REPOINT_TABLES`
  - `tenantExportPolicyRegistry.ts`: the new table with all columns `included`; the 4 new `topology_device_presence` columns in `included`; `site_assignment_confirmed_at` added to the `devices` entry's `included` (:387)
  - `routes/devices/core.ts`: cascade, org-denormalized and move-delete lists
- Test: extend `topologyPresenceReadModel.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('clears site_assignment_confirmed_at on any site_id or org_id change, and only then', async () => {
  await setConfirmed(device, '2026-10-01T00:00:00Z');
  await update(device, { displayName: 'x' });            expect(await confirmed(device)).not.toBeNull();
  await update(device, { siteId: siteB });               expect(await confirmed(device)).toBeNull();
});
it('presence days: RLS forge fails 42501; cascade on device delete; unique (device, day, assigned site, match key)', async () => { /* … */ });
```

Run the unit `tenantExportPolicyRegistry`-adjacent test first. It fails until the `devices` column is classified, which proves the column-addition contract fires.

- [ ] **Step 2: Run them and confirm they fail. Step 3: Implement**

```sql
ALTER TABLE devices ADD COLUMN IF NOT EXISTS site_assignment_confirmed_at timestamptz;
ALTER TABLE topology_device_presence ADD COLUMN IF NOT EXISTS suggested_site_id uuid;
ALTER TABLE topology_device_presence ADD COLUMN IF NOT EXISTS suggestion_first_at timestamptz;
ALTER TABLE topology_device_presence ADD COLUMN IF NOT EXISTS suggestion_last_at timestamptz;
ALTER TABLE topology_device_presence ADD COLUMN IF NOT EXISTS suggestion_days smallint CHECK (suggestion_days IS NULL OR suggestion_days BETWEEN 0 AND 31);
DO $$ BEGIN
  ALTER TABLE topology_device_presence ADD CONSTRAINT topology_device_presence_suggested_site_fk
    FOREIGN KEY (suggested_site_id, org_id) REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS topology_device_presence_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  device_id uuid NOT NULL,
  day date NOT NULL,
  assigned_site_id uuid NOT NULL,
  state varchar(16) NOT NULL CHECK (state IN ('home','visiting','unrecognized','ambiguous','stale','unknown')),
  matched_site_id uuid,
  match_key varchar(80) NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  observation_count integer NOT NULL DEFAULT 1 CHECK (observation_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_device_presence_days_device_fk FOREIGN KEY (device_id, org_id) REFERENCES devices (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT topology_device_presence_days_assigned_site_fk FOREIGN KEY (assigned_site_id, org_id) REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT topology_device_presence_days_matched_site_fk FOREIGN KEY (matched_site_id, org_id) REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_device_presence_days_key_uniq ON topology_device_presence_days (device_id, day, assigned_site_id, match_key);
CREATE INDEX IF NOT EXISTS topology_device_presence_days_org_device_idx ON topology_device_presence_days (org_id, device_id, day);
ALTER TABLE topology_device_presence_days ENABLE ROW LEVEL SECURITY; ALTER TABLE topology_device_presence_days FORCE ROW LEVEL SECURITY;
-- four breeze_org_isolation_* policies, same blocks as W2

CREATE OR REPLACE FUNCTION breeze_devices_site_assignment_confirmation_reset() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN NEW.site_assignment_confirmed_at := NULL; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS breeze_devices_site_assignment_confirmation_reset ON devices;
CREATE TRIGGER breeze_devices_site_assignment_confirmation_reset BEFORE UPDATE OF site_id, org_id ON devices
  FOR EACH ROW EXECUTE FUNCTION breeze_devices_site_assignment_confirmation_reset();
```

- [ ] **Step 4: Run the contract suites** (the same commands as W2 Task 1 Step 5, plus `pnpm db:check-drift`). **Step 5: Commit** `feat(topology): presence day summaries and site-assignment confirmation column (site location W3)`.

### Task 2: Pure eligibility

**Files:**
- Create: `apps/api/src/services/topology/presenceEligibility.ts`, `presenceEligibility.test.ts`

**Interfaces:**
- Produces:

```ts
export type PresenceDayRow = { day: string; assignedSiteId: string; state: PresenceState; matchedSiteId: string | null; firstObservedAt: string; lastObservedAt: string };
export type Suggestion = { siteId: string; days: number; firstObservedAt: string; lastObservedAt: string };
export const SUGGESTION_MIN_DAYS = 7, SUGGESTION_MIN_SPAN_MS = 7 * 86_400_000, SUGGESTION_WINDOW_MS = 30 * 86_400_000, SUGGESTION_MAX_GAP_MS = 36 * 3_600_000, DAY_ROW_EXTENSION_MS = 3_600_000;
export function evaluateSuggestion(input: { now: Date; assignedSiteId: string; confirmedAt: string | null;
  current: { valid: boolean; state: PresenceState; matchedSiteId: string | null }; anchoredUniquely: boolean; days: PresenceDayRow[] }): Suggestion | null;
```

- [ ] **Step 1: Write failing table tests**

```ts
const day = (d: number, state: PresenceState, matched: string | null = B, from = 8, to = 18, assigned = A): PresenceDayRow =>
  ({ day: iso(d).slice(0, 10), assignedSiteId: assigned, state, matchedSiteId: state === 'visiting' ? matched : null, firstObservedAt: at(d, from), lastObservedAt: at(d, to) });
const nightly = (d: number) => day(d, 'stale', null, 18, 32);            // offline overnight → explained (stale rows)
const base = { now: NOW, assignedSiteId: A, confirmedAt: null, current: { valid: true, state: 'visiting' as const, matchedSiteId: B }, anchoredUniquely: true };
const nineDays = range(1, 10).flatMap((d) => [day(d, 'visiting'), nightly(d)]);

it('9 visiting days spanning > 7 days with nightly stale rows → suggestion', () => expect(evaluateSuggestion({ ...base, days: nineDays })).toMatchObject({ siteId: B, days: 9 }));
it('6 days → none', () => expect(evaluateSuggestion({ ...base, days: nineDays.filter((r) => dayIndex(r) <= 6) })).toBeNull());
it('7 distinct days but span < 7×24h → none', () => { /* 7 rows on consecutive days with first 08:00, last day 07:00 */ });
it('any home row since first B observation → none', () => expect(evaluateSuggestion({ ...base, days: [...nineDays, day(5, 'home', null)] })).toBeNull());
it('visiting another site or ambiguous → none', () => { /* … */ });
it('stale weekend explains the gap', () => { /* Fri visiting, Sat+Sun stale rows only, Mon visiting → still eligible */ });
it('40h hole without rows is unexplained', () => { /* remove the rows covering a 40h interval → null */ });
it('unknown rows do not explain a gap', () => { /* replace the stale rows of a 40h stretch with unknown → null */ });
it('rows from a previous assignment are ignored', () => { /* assigned = C for days 1-5 → only days 6-10 count → null */ });
it('confirmedAt set → none; current row invalid or not visiting B → none; B no longer anchored uniquely → none', () => { /* … */ });
it('rows older than 30 days do not count', () => { /* … */ });
```

- [ ] **Step 2: Run them and confirm they fail. Step 3: Implement** S§10.2 literally.

```ts
export function evaluateSuggestion(input: Parameters<typeof evaluateSuggestion>[0]): Suggestion | null {
  const { now, assignedSiteId, confirmedAt, current, anchoredUniquely } = input;
  if (confirmedAt || !current.valid || current.state !== 'visiting' || !current.matchedSiteId || !anchoredUniquely) return null;
  const B = current.matchedSiteId; const since = now.getTime() - SUGGESTION_WINDOW_MS;
  const rows = input.days.filter((r) => r.assignedSiteId === assignedSiteId && Date.parse(r.lastObservedAt) >= since);
  const bRows = rows.filter((r) => r.state === 'visiting' && r.matchedSiteId === B).sort((x, y) => Date.parse(x.firstObservedAt) - Date.parse(y.firstObservedAt));
  const distinct = new Set(bRows.map((r) => r.day));
  if (distinct.size < SUGGESTION_MIN_DAYS) return null;
  const first = Date.parse(bRows[0]!.firstObservedAt); const last = Math.max(...bRows.map((r) => Date.parse(r.lastObservedAt)));
  if (last - first < SUGGESTION_MIN_SPAN_MS) return null;
  const tail = rows.filter((r) => Date.parse(r.lastObservedAt) >= first);
  if (tail.some((r) => r.state === 'home' || r.state === 'ambiguous' || (r.state === 'visiting' && r.matchedSiteId !== B))) return null;
  const covered = tail.filter((r) => r.state !== 'unknown').map((r) => [Date.parse(r.firstObservedAt), Date.parse(r.lastObservedAt) + DAY_ROW_EXTENSION_MS] as const)
    .sort((x, y) => x[0] - y[0]);
  let reach = first;
  for (const [start, end] of covered) { if (start - reach > SUGGESTION_MAX_GAP_MS) return null; reach = Math.max(reach, end); }
  if (now.getTime() - reach > SUGGESTION_MAX_GAP_MS) return null;
  return { siteId: B, days: distinct.size, firstObservedAt: new Date(first).toISOString(), lastObservedAt: new Date(last).toISOString() };
}
```

- [ ] **Step 4: Run them and confirm they pass. Step 5: Commit** `feat(topology): wrong-site suggestion eligibility (site location W3)`.

### Task 3: Evaluator writes day rows and suggestions; retention

**Files:**
- Modify: `apps/api/src/services/topology/presenceEvaluator.ts` (step 6 of S§7.2), `apps/api/src/jobs/topologyPresenceWorker.ts` (retention)
- Test: `apps/api/src/__tests__/integration/topologyPresenceSuggestions.integration.test.ts`

**Interfaces:**
- Consumes: `evaluateSuggestion` (Task 2).
- Produces: `upsertPresenceDay(tx, row, now)` with the 60-min throttle (`ON CONFLICT … DO UPDATE … WHERE topology_device_presence_days.last_observed_at <= now() - interval '60 minutes'`); `prunePresenceDays(now): Promise<number>`, which deletes ≤ 10,000 rows older than 35 days per tick.

- [ ] **Step 1: Write the failing integration tests**

```ts
it('writes one day row per device per (assigned site, match key), throttled to once per 60 min', async () => { /* evaluate twice within 10 min → observation_count 1 */ });
it('seeded 9-day visiting history + current visiting → suggested_site_id = B with days 9; a home row in between → null', async () => { /* insert days via system ctx, evaluate */ });
it('confirmed device gets no suggestion; moving it clears the confirmation and the presence row', async () => { /* … */ });
it('prunes rows older than 35 days', async () => { /* … */ });
```

- [ ] **Step 2: Run them and confirm they fail. Step 3: Implement** (read each batch's day rows for the last 31 days in one statement keyed by device IDs, and the confirmation column from `devices`). **Step 4: Run them and confirm they pass. Step 5: Commit** `feat(topology): prospective presence days and suggestions in the evaluator (site location W3)`.

### Task 4: Confirmation routes and suggestion-sourced move evidence

**Files:**
- Create: `apps/api/src/routes/devices/siteAssignmentConfirmation.ts` (+ `.test.ts`); mount next to the core device routes
- Modify: `apps/api/src/routes/devices/core.ts` (`siteMoveTrigger: 'topology_suggestion'` → server-side evidence lookup), `core.siteMove.test.ts`

**Interfaces:**
- Produces:
  - `PUT /devices/:id/site-assignment-confirmation` → `{ confirmedAt }`
  - `DELETE /devices/:id/site-assignment-confirmation` → `{ confirmedAt: null }`
  - Middleware for both: `requireScope('organization','partner','system')`, `requirePermission(devices, write)`, `requireMfa()`, `getDeviceWithOrgAndSiteCheck`
  - Audits `device.site_assignment_confirmed` / `device.site_assignment_unconfirmed`, with `details: { siteId }`
  - `siteMoveAuditDetails` gains `suggestionState: 'eligible' | 'not_eligible'` and `evidence`

- [ ] **Step 1: Write failing tests**

```ts
it('PUT sets confirmedAt and audits the actor; DELETE clears it', async () => { /* … */ });
it('PUT is 403 for a user restricted away from the device site, 403 without devices:write', async () => { /* … */ });
it('topology_suggestion move records server-derived evidence from the presence row, ignoring any client evidence', async () => {
  presenceRow = { suggested_site_id: SITE_B, suggestion_days: 9, prefix: '10.1.5.0/24', gateway_address: '10.1.5.1', mac_corroborated: true, /* … */ };
  const res = await patch(deviceId, { siteId: SITE_B, expectedSiteId: SITE_A, siteMoveTrigger: 'topology_suggestion', evidence: { forged: true } });
  expect(res.status).toBe(200);
  const details = auditCall('device.site_move').details;
  expect(details).toMatchObject({ trigger: 'topology_suggestion', suggestionState: 'eligible', evidence: { matchedSiteId: SITE_B, days: 9, prefix: '10.1.5.0/24' } });
  expect(JSON.stringify(details)).not.toContain('forged');
});
it('topology_suggestion move when no longer eligible still moves and records not_eligible', async () => { /* … */ });
```

The `evidence` key must also be rejected by the strict schema (400) or stripped. Pick strict and assert 400 in a separate test.

- [ ] **Step 2: Run them and confirm they fail. Step 3: Implement. Step 4: Run them and confirm they pass. Step 5: Commit** `feat(devices): site-assignment confirmation and suggestion-sourced move evidence (site location W3)`.

### Task 5: Suggestions in the presence read and web UI (leak tests extended)

**Files:**
- Modify: `apps/api/src/services/topology/presenceRead.ts`, `topologyPresenceVisibility.integration.test.ts`
- Modify: `apps/web/src/components/topology/TopologySiteRoster.tsx`, `TopologyInspector.tsx`, `TopologyCanvas.tsx`; create `SiteMoveSuggestion.tsx` (+ test)
- Modify: locales

- [ ] **Step 1: Write failing tests**

API leak tests to add:
- `suggestion is null for onlyA viewers (would name B)`
- `suggestion on B's visitor requires A and B`
- `site header suggestion count counts only visible`

Web:

```tsx
it('shows the suggestion copy with day count and date range, and never "always"/"away"', () => { /* … */ });
it('"Move to Lakeside" PATCHes siteId + expectedSiteId + siteMoveTrigger via runAction and refetches presence', async () => { /* … */ });
it('"Move to Lakeside" is hidden without devices:write; "Keep at Main Office" PUTs the confirmation', async () => { /* … */ });
it('confirmed device shows "Suggestions off" with a "Turn on" action that DELETEs the confirmation', async () => { /* … */ });
it('409 device_site_changed shows the reload message', async () => { /* … */ });
```

- [ ] **Step 2: Run them and confirm they fail. Step 3: Implement** to S§10.3. The confirm dialog uses the S§10.3 implication copy. All mutations go through `runAction`. Permissions come from the graph `permissions` block, extended with `canMoveDevices` derived from `devices:write`. **Step 4: Run them and confirm they pass,** including `no-silent-mutations.test.ts`. **Step 5: Commit** `feat(web): wrong-site suggestions with one-click audited move and dismissal (site location W3)`.

### Task 6: Demo seed history and end-to-end check (branch `feat/topology-demo-seed` or main)

**Files:**
- Modify: `apps/api/scripts/seed-topology-demo.ts` and `.lib.ts`

- [ ] **Step 1: Write the failing lib test.** `demoPresenceHistory()` returns 9 days of `visiting`(Lakeside) rows plus nightly `stale` rows for DESKTOP-0NPDOPV and WIN-92H1M08M1HB, and 3 mixed days for LAPTOP-LOV-01. Mark them with a code comment as synthetic demo history (W3 is prospective in production).
- [ ] **Step 2: Run it and confirm it fails. Step 3: Implement.** Insert the rows after the first `evaluateOrgPresence` in the seed run, then evaluate again so suggestions appear. **Step 4: Run it and confirm it passes,** then on a `wt-stack` with Playwright:
  - Main Office's roster shows "Probably assigned to the wrong site" for the two desktops.
  - "Move to Lakeside" moves one, and the audit log shows `device.site_move` with evidence.
  - "Keep at Main Office" on the other shows "Suggestions off".
  - The travelling laptop shows no suggestion (3 days).
- [ ] **Step 5: Commit** `feat(seed): synthetic presence history for the site-location demo`.

### W3 gate

- [ ] Full suites and every contract suite, including `tenant-export-policy` (new `devices` column) and the full `orgMerge.test.ts`.
- [ ] Leak tests all green. Manual browser check as a Main-Office-only user: no suggestions and no "Lakeside" anywhere.
- [ ] Tear down `wt-stack` / `test-stack`.
- [ ] PR: `Closes #<this wave's sub-issue>`; one independent review round (tenancy touched); `complete_wave`; close the feature when all three waves are merged.

---

## Self-review notes

- Spec coverage: S§4 → W1 T3, W2 T3/T7. S§5/S§6 → W1 T1, W2 T3/T4. S§7 → W2 T1/T5. S§8 → W2 T6. S§9 → W2 T2/T6/T7. S§10 → W3 T2/T3/T5. S§11 → W3 T1/T4. S§12 → W1 T4/T5, W3 T4. S§13 → W1 T2 Step 9. S§14 → W2 T6. S§15 → W2 T1, W3 T1.
- Owner decisions (S§17, 2026-10-03): Q1 no admin-declared gateway in v1; Q2 dismissals do not expire. Neither is a task.

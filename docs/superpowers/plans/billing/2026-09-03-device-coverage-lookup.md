---
tracking_issue: LanternOps/breeze#3205
---

# Device Coverage Lookup and Coverage-Notice Deep Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer "which contract line bills this device?" on the device page and "which devices are the 3 Unknown?" on the contract page, both derived live from the same predicate the billing run uses, with no new table, column or migration.

**Architecture:** The private `lineMatches` in `contractCoverage.ts` becomes `coverageMatch(line, row, snapshot) → 'org'|'site'|'role'|'group'|null` — one predicate behind both the contract page's uncovered warning and the device page's panel, so they cannot disagree. A new `services/deviceCoverage.ts` builds a **one-device** `OrgDeviceSnapshot` from two new single-row exports (`billableDeviceById` in `contractQuantities.ts`, `groupIncludesDevice` in `groupMembership.ts`, the latter proved equal to `resolveEffectiveGroupMembers` by a real-DB parity test) and runs the unchanged predicate over it. `GET /devices/:id/billing` gates on `partner|system` + `devices:read` + `contracts:read`. On the web, the contract coverage notice's role buckets become links to `/devices#orgId=<uuid>&filtersV2=<base64url>`, the devices list learns the `orgId` hash key in a layout effect, and the device Overview gains a Billing card.

**Tech Stack:** Postgres 16, Drizzle ORM, Hono, Vitest (unit + `vitest.integration.config.ts` real-DB suites), React + react-i18next (8 locales), Astro.

**Spec:** `docs/superpowers/specs/billing/2026-09-03-device-coverage-lookup-design.md`

**Wave:** #3205 W06 (wave sub-issue #4655). Branch from `main` **after** W02 (#4648) merges: `feature/3205-device-coverage/wave-4655`. Every W02 symbol this plan consumes (`OrgDeviceSnapshot`, `GroupMembers`, `CoverageLine.deviceGroupId`, `assertResolvable`, `lineMatches`, `GroupEvaluationError`, `GroupForResolution`, `resolveEffectiveGroupMembers`, `contract_lines.device_group_id` / `device_group_name`) lands in W02 — do not start until `git log origin/main` shows its squash commit.

## Global Constraints

- **Coverage is derived live from the same predicate, over `active` contracts only.** No table, no cache; `active` is the *eligible* set ("could this line bill this device?"), never a claim about the billing calendar.
- **Columns before tables, and this wave has neither.** No migration, no column, no table: no RLS work, no cascade-list registration, no export-policy classification, no org-merge policy.
- **`contractService.ts` is not edited by this wave.** `orgSnapshot`, `DeviceCache`, `groupIdsOf`, `resolvableLines` and `EMPTY_SNAPSHOT` stay private exactly where W02 put them — no move, no re-export, no new import edge into the billing graph.
- **The lookup builds a ONE-DEVICE `OrgDeviceSnapshot`.** Loading every billable device in the org to answer a question about one device is O(org) work for an O(1) answer; nothing in this wave scales with the customer's fleet.
- **A group-evaluation failure is a 500 with a code, never an empty list.** Reporting "not billed" for an unevaluable group is the silent zero this feature exists to prevent. No error path returns `lines`.
- **Not-billable is a third state, decided by `billableDeviceById`, with no 500 for concurrent drift.** Exactly one of three states holds: `notBillable === true → lines = [], uncovered === false`; `notBillable === false → uncovered === (lines.length === 0)`.
- **`matchedBy` names the line's device-set *selector*, and is never a set.** A site-scoped role line is `role`, not `role`+`site`; only `per_device` splits (`org` when unscoped, `site` when scoped).
- **`unknown` cannot be selected by a `per_device_role` line; `per_device` and `per_device_group` lines can and do bill it** (the roadmap's "`unknown` is never billable" is corrected here).
- **The route requires `requireScope('partner','system')` + `devices:read` + `contracts:read`.** `contract_lines.description` is operator-authored free text that routinely carries the rate. Organization-scoped users get 403, which is the status quo for every contracts read route, not a regression.
- **API keys are excluded by construction.** `API_KEY_SCOPE_POLICIES` has no `contracts:read` scope, so no key can satisfy the gate; no extra check is added.
- **The deep link carries org scope: `#orgId=<uuid>&filtersV2=<base64url>`.** Hash state, never query params (CLAUDE.md). Adoption is a **layout** effect declared above `useAdvancedFilterIds`, because the filter preview is a passive effect keyed on the filter alone and never re-runs when the org changes.
- **No fleet-wide covered/uncovered column or filter on the devices list**, no persisted coverage, no portal exposure, no AI tool change, no monetary field of any kind in the payload.
- Run one test file with `cd apps/api && npx vitest run <path>` (never `pnpm --filter … test -- --run`). Integration suites: `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>` with `DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test` (the `worktree-stack` skill, or `docker compose -f docker-compose.test.yml up -d`). API typecheck: `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`.
- The integration harness `TRUNCATE ... CASCADE`s core tenant tables in a `beforeEach`, so **every integration test seeds inline** — never a `beforeAll` fixture.
- `devices.site_id` is **NOT NULL**: every seeded device needs a site in its own org.

---

## File map

| File | Change |
|---|---|
| `apps/api/src/services/contractCoverage.ts` (+ `.test.ts`) | `DEVICE_COUNTED_LINE_TYPES`, `CoverageMatchReason`, `coverageMatch`; `lineMatches` becomes `matchReason(...) !== null` |
| `apps/api/src/services/contractQuantities.ts` | `billableDeviceById` (reuses `billableDeviceConds`) |
| `apps/api/src/__tests__/integration/contractQuantities.integration.test.ts` | `billableDeviceById` cases |
| `apps/api/src/services/groupMembership.ts` | `DeviceForMembership`, `groupIncludesDevice` |
| `apps/api/src/__tests__/integration/groupMembership.parity.integration.test.ts` (new) | mandatory anti-drift parity vs `resolveEffectiveGroupMembers` |
| `apps/api/src/services/deviceCoverage.ts` (new, + `deviceCoverage.test.ts`) | `contractLinesCoveringDevice`, `DeviceCoverageError`, query-count contract |
| `apps/api/src/__tests__/integration/deviceCoverage.integration.test.ts` (new) | real-DB coverage, cross-check with `uncoveredByRole`, one-device vs full-org equivalence |
| `apps/api/src/routes/devices/billing.ts` (new, + `billing.test.ts`) | `GET /devices/:id/billing` |
| `apps/api/src/routes/devices/index.ts`, `index.test.ts` | mount + mount-order assertion |
| `apps/web/src/lib/api/devices.ts` (new) | `DeviceBillingCoverage` types + `getDeviceBilling` |
| `apps/web/src/components/devices/orgHash.ts` (new, + `orgHash.test.ts`) | `readOrgIdFromHash`, `useOrgIdFromHash` |
| `apps/web/src/components/devices/filterUrl.ts` (+ `.test.ts`) | isomorphic `toBase64Url` |
| `apps/web/src/components/contracts/deviceCoverageLinks.ts` (new, + `.test.ts`) | `devicesUrlForRole` |
| `apps/web/src/components/contracts/DeviceCoverageNotice.tsx` (+ `.test.tsx`) | structured-key i18n, per-role links, `orgId` prop |
| `apps/web/src/components/contracts/ContractDetail.tsx`, `ContractEditor.tsx` | pass `orgId` to the notice |
| `apps/web/src/components/devices/DevicesPage.tsx` (+ new `DevicesPage.deepLink.test.tsx`) | `useOrgIdFromHash()` above `useAdvancedFilterIds` |
| `apps/web/src/components/devices/DeviceBillingCard.tsx` (new, + `.test.tsx`) | Overview Billing card, four states |
| `apps/web/src/components/devices/DeviceDetails.tsx` | mount the card behind `can('contracts','read')` |
| `apps/web/src/locales/*/billing.json`, `*/common.json`, `*/devices.json` | keys in 8 locales |
| `apps/docs/src/content/docs/features/contracts.mdx`, `devices.mdx` | coverage links, Billing card |
| `docs/release-notes/next-release-draft.md` | billing section |

---

### Task 1: `coverageMatch` — one predicate, with the reason attached

**Files:**
- Modify: `apps/api/src/services/contractCoverage.ts` — W02 leaves `isDeviceLine` as a hand-written `||` chain, `assertResolvable`, and the private `lineMatches`; this task replaces all three regions and adds two exports.
- Test: `apps/api/src/services/contractCoverage.test.ts` — append after the final `describe('uncoveredByRole', …)` block. The module-level fixtures W02 creates (`A`, `B`, `devices`, `G_VIP`, `G_SITE_B`, `snapshot`, `line`) are reused as-is.

**Interfaces:**
- Consumes (from W02): `CoverageLine { lineType, siteId, deviceRoles, deviceGroupId }`, `OrgDeviceSnapshot { devices, groups }`, `GroupMembers { siteId, memberIds }`, `DeviceSnapshotRow { id, role, siteId }`, `assertResolvable(line, snapshot)`, `quantityFor`, `uncoveredByRole`.
- Produces:

```ts
export const DEVICE_COUNTED_LINE_TYPES = ['per_device', 'per_device_role', 'per_device_group'] as const;
export type DeviceCountedLineType = typeof DEVICE_COUNTED_LINE_TYPES[number];
export type CoverageMatchReason = 'org' | 'site' | 'role' | 'group';
export function isDeviceLine(line: Pick<CoverageLine, 'lineType'>): boolean;
export function coverageMatch(line: CoverageLine, row: DeviceSnapshotRow, snapshot: OrgDeviceSnapshot): CoverageMatchReason | null;
```

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/contractCoverage.test.ts` (and extend the top import to
`import { coverageMatch, DEVICE_COUNTED_LINE_TYPES, isDeviceLine, quantityFor, uncoveredByRole, type CoverageLine, type CoverageMatchReason, type OrgDeviceSnapshot } from './contractCoverage';`
plus `import { CONTRACT_LINE_TYPES } from '@breeze/shared';`):

```ts
// #3205 W06: coverageMatch is the SAME predicate as the private lineMatches,
// with the reason attached. The parity block at the bottom is the anti-drift
// assertion: every quantity W02 computes must equal the number of devices
// coverageMatch calls covered, over W02's own truth-table fixtures.
describe('coverageMatch (#3205 W06)', () => {
  const rowOf = (id: string) => devices.find((d) => d.id === id)!;
  const why = (l: CoverageLine, id: string): CoverageMatchReason | null => coverageMatch(l, rowOf(id), snapshot);

  it('per_device names the selector: org-wide vs one site', () => {
    expect(why(line({ lineType: 'per_device' }), 'ws1')).toBe('org');
    expect(why(line({ lineType: 'per_device', siteId: A }), 'ws1')).toBe('site');
    expect(why(line({ lineType: 'per_device', siteId: B }), 'ws1')).toBeNull();
  });

  it('a site-scoped role line is role, not site (Decision 3)', () => {
    expect(why(line({ lineType: 'per_device_role', deviceRoles: ['server'] }), 'srv1')).toBe('role');
    expect(why(line({ lineType: 'per_device_role', siteId: A, deviceRoles: ['server'] }), 'srv1')).toBe('role');
    expect(why(line({ lineType: 'per_device_role', siteId: B, deviceRoles: ['server'] }), 'srv1')).toBeNull();
    expect(why(line({ lineType: 'per_device_role', deviceRoles: ['printer'] }), 'srv1')).toBeNull();
  });

  it('a group covers its members, and a site-bound group does not reach off-site', () => {
    expect(why(line({ lineType: 'per_device_group', deviceGroupId: G_VIP }), 'ws1')).toBe('group');
    expect(why(line({ lineType: 'per_device_group', deviceGroupId: G_VIP }), 'ws2')).toBeNull();
    expect(why(line({ lineType: 'per_device_group', deviceGroupId: G_SITE_B }), 'ws3')).toBe('group');
    expect(why(line({ lineType: 'per_device_group', deviceGroupId: G_SITE_B }), 'ws1')).toBeNull(); // member, wrong site
  });

  it('an unknown-role device is billable by non-role lines (roadmap correction)', () => {
    expect(why(line({ lineType: 'per_device' }), 'unk1')).toBe('org');
    expect(why(line({ lineType: 'per_device_role', deviceRoles: ['workstation', 'server'] }), 'unk1')).toBeNull();
    const s: OrgDeviceSnapshot = {
      devices,
      groups: new Map([['g-unk', { siteId: null, memberIds: new Set(['unk1']) }]]),
    };
    expect(coverageMatch(line({ lineType: 'per_device_group', deviceGroupId: 'g-unk' }), rowOf('unk1'), s)).toBe('group');
  });

  it('throws on an unresolvable line, exactly like quantityFor', () => {
    expect(() => why(line({ lineType: 'per_device_role', deviceRoles: null }), 'srv1')).toThrow(/without device roles/);
    expect(() => why(line({ lineType: 'per_device_group' }), 'srv1')).toThrow(/without a device group/);
    expect(() => why(line({ lineType: 'per_device_group', deviceGroupId: 'nope' }), 'srv1')).toThrow(/group nope is not in the snapshot/);
  });

  it('returns null for every non-device-counted line type', () => {
    for (const lineType of ['flat', 'per_seat', 'manual'] as const) {
      expect(why(line({ lineType }), 'srv1')).toBeNull();
    }
  });

  it('DEVICE_COUNTED_LINE_TYPES and isDeviceLine agree over every contract line type', () => {
    for (const lineType of CONTRACT_LINE_TYPES) {
      expect(isDeviceLine({ lineType })).toBe((DEVICE_COUNTED_LINE_TYPES as readonly string[]).includes(lineType));
    }
    expect([...DEVICE_COUNTED_LINE_TYPES].sort()).toEqual(['per_device', 'per_device_group', 'per_device_role']);
  });

  it('PARITY: quantityFor counts exactly the devices coverageMatch calls covered', () => {
    const lines: CoverageLine[] = [
      line({ lineType: 'per_device' }),
      line({ lineType: 'per_device', siteId: A }),
      line({ lineType: 'per_device_role', deviceRoles: ['server'] }),
      line({ lineType: 'per_device_role', deviceRoles: ['workstation', 'server'] }),
      line({ lineType: 'per_device_role', siteId: B, deviceRoles: ['workstation', 'switch'] }),
      line({ lineType: 'per_device_group', deviceGroupId: G_VIP }),
      line({ lineType: 'per_device_group', deviceGroupId: G_SITE_B }),
    ];
    for (const l of lines) {
      expect(quantityFor(snapshot, l)).toBe(devices.filter((r) => coverageMatch(l, r, snapshot) !== null).length);
    }
    // …and the uncovered tally is exactly the complement, which is what makes
    // the contract page's warning and the device page's panel one answer.
    expect(uncoveredByRole(snapshot, lines).total)
      .toBe(devices.filter((r) => !lines.some((l) => coverageMatch(l, r, snapshot) !== null)).length);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/contractCoverage.test.ts`
Expected: FAIL — `coverageMatch is not a function` / `DEVICE_COUNTED_LINE_TYPES` is not exported (the W02 describes stay green).

- [ ] **Step 3: Implement**

In `apps/api/src/services/contractCoverage.ts`, replace `isDeviceLine` and the private `lineMatches` with:

```ts
/** The three line types whose quantity is a device count. The SQL filter in
 *  deviceCoverage.ts and the pure predicate below are both defined from this,
 *  so they cannot drift when a later wave adds a type (#3205 W06). */
export const DEVICE_COUNTED_LINE_TYPES = ['per_device', 'per_device_role', 'per_device_group'] as const;
export type DeviceCountedLineType = typeof DEVICE_COUNTED_LINE_TYPES[number];

export function isDeviceLine(line: Pick<CoverageLine, 'lineType'>): boolean {
  return (DEVICE_COUNTED_LINE_TYPES as readonly string[]).includes(line.lineType);
}

/** WHY a line bills a device — the line's device-set SELECTOR, never a set.
 *  A site-scoped role line is 'role': the operator's answer to "why is this
 *  billed?" is "it is a server"; the site narrows that set rather than being a
 *  second reason, and the row carries the line's siteId verbatim anyway. */
export type CoverageMatchReason = 'org' | 'site' | 'role' | 'group';

/** The private core. No assert: quantityFor/uncoveredByRole pre-assert once per
 *  line, so asserting per row would be O(n) waste. */
function matchReason(line: CoverageLine, row: DeviceSnapshotRow, snapshot: OrgDeviceSnapshot): CoverageMatchReason | null {
  if (line.siteId !== null && line.siteId !== row.siteId) return null;
  switch (line.lineType) {
    case 'per_device': return line.siteId === null ? 'org' : 'site';
    case 'per_device_role': return line.deviceRoles?.includes(row.role) ? 'role' : null;
    case 'per_device_group': {
      const g = snapshot.groups.get(line.deviceGroupId!)!;   // assertResolvable proved both
      return g.memberIds.has(row.id) && (g.siteId === null || g.siteId === row.siteId) ? 'group' : null;
    }
    default: return null;
  }
}

function lineMatches(line: CoverageLine, row: DeviceSnapshotRow, snapshot: OrgDeviceSnapshot): boolean {
  return matchReason(line, row, snapshot) !== null;
}

/** The single predicate behind BOTH the contract page's uncovered warning and
 *  the device page's coverage panel (#3205 W06): quantityFor/uncoveredByRole ask
 *  only "does it match?", deviceCoverage.ts also asks "why?". They cannot
 *  disagree, because there is one function. */
export function coverageMatch(
  line: CoverageLine, row: DeviceSnapshotRow, snapshot: OrgDeviceSnapshot,
): CoverageMatchReason | null {
  assertResolvable(line, snapshot);
  return matchReason(line, row, snapshot);
}
```

`quantityFor` and `uncoveredByRole` keep calling `lineMatches` unchanged; `assertResolvable` is untouched.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/contractCoverage.test.ts && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
Expected: PASS (every W02 case still green); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractCoverage.ts apps/api/src/services/contractCoverage.test.ts
git commit -m "feat(billing): coverageMatch — one coverage predicate that also says why (#3205 W06)"
```

---

### Task 2: Single-device primitives — `billableDeviceById` and `groupIncludesDevice`

**Files:**
- Modify: `apps/api/src/services/contractQuantities.ts` — add after `snapshotContractDevices` (W02 leaves it at roughly `:46-63`).
- Modify: `apps/api/src/services/groupMembership.ts` — add after `resolveEffectiveGroupMembers`, which W02 inserts after `isFilterConditionGroup` (`:57-61` today).
- Create: `apps/api/src/__tests__/integration/groupMembership.parity.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/contractQuantities.integration.test.ts` — append a `describe` and extend the import at `:29`.

**Interfaces:**
- Consumes: W02's `GroupForResolution`, `GroupEvaluationError`, `resolveEffectiveGroupMembers`; `billableDeviceConds` (module-private, unchanged); `deviceMatchesFilter(deviceId, filter)` from `filterEngine.ts`; `isFilterConditionGroup` (module-private).
- Produces:

```ts
// contractQuantities.ts
export async function billableDeviceById(deviceId: string, orgId: string): Promise<DeviceSnapshotRow | null>;
// groupMembership.ts
export type DeviceForMembership = Pick<typeof devices.$inferSelect, 'id' | 'siteId'>;
export async function groupIncludesDevice(group: GroupForResolution, device: DeviceForMembership): Promise<boolean>;
```

> **Recorded deviation from the spec's illustrative ordering.** The spec's sketch puts the pinned short-circuit *above* the `isFilterConditionGroup` check, which would make `groupIncludesDevice` return `true` for a pinned member of a group whose filter is malformed — while `resolveEffectiveGroupMembers` throws for that group whatever the device. That is a parity break, and parity is the spec's own binding rule ("returns **exactly** `deviceId ∈ (matched ∪ pinned)`"). The implementation below therefore validates the filter shape first. Nothing is lost: `isFilterConditionGroup` is a pure in-memory shape check, and the pinned row still short-circuits the expensive half (`deviceMatchesFilter` under a 500 ms timeout), which is what "read order is pinned-row-first" is actually protecting.

- [ ] **Step 1a: Write the failing parity integration test**

Create `apps/api/src/__tests__/integration/groupMembership.parity.integration.test.ts`:

```ts
/**
 * #3205 W06 mandatory anti-drift test. Two definitions of group membership now
 * exist — resolveEffectiveGroupMembers (whole group, billing + evaluator) and
 * groupIncludesDevice (one device, the device coverage panel). This file is the
 * reason they cannot drift: for EVERY group x EVERY device in the fixture,
 * groupIncludesDevice(group, device) === (matched ∪ pinned).has(device.id).
 *
 * The trailing site clause on groupIncludesDevice's filter branch is the one
 * place drift could hide: evaluateFilter narrows by allowedSiteIds inside its
 * SQL, deviceMatchesFilter (filterEngine.ts:668) takes no site argument.
 */
import './setup';
import { describe, it, expect, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices, deviceGroups, deviceGroupMemberships } from '../../db/schema';

const { deviceMatchesFilterSpy } = vi.hoisted(() => ({ deviceMatchesFilterSpy: vi.fn() }));
vi.mock('../../services/filterEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/filterEngine')>();
  deviceMatchesFilterSpy.mockImplementation(actual.deviceMatchesFilter);
  return { ...actual, deviceMatchesFilter: deviceMatchesFilterSpy };
});

import { GroupEvaluationError, groupIncludesDevice, resolveEffectiveGroupMembers } from '../../services/groupMembership';

const SERVER_FILTER = { operator: 'AND' as const, conditions: [{ field: 'deviceRole', operator: 'equals', value: 'server' }] };

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `PP ${sfx}`, slug: `pp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'PA', slug: `pa-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'PB', slug: `pb-${sfx}` },
    ]).returning({ id: organizations.id });
    const orgId = oA!.id;
    // devices.site_id is NOT NULL — every device needs a site in its OWN org.
    const [sA, sB] = await db.insert(sites).values([
      { orgId, name: `A-${sfx}` }, { orgId, name: `B-${sfx}` },
    ]).returning({ id: sites.id });
    const [sOther] = await db.insert(sites).values({ orgId: oB!.id, name: `O-${sfx}` }).returning({ id: sites.id });
    const dev = (agent: string, role: string, siteId: string, extra: Record<string, unknown> = {}) => ({
      orgId, siteId, agentId: `${agent}-${sfx}`, hostname: agent, status: 'online', deviceRole: role,
      osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0', ...extra,
    });
    const [srvA, srvB, wsA, wsB] = await db.insert(devices).values([
      dev('srv-a', 'server', sA!.id), dev('srv-b', 'server', sB!.id),
      dev('ws-a', 'workstation', sA!.id), dev('ws-b', 'workstation', sB!.id),
    ]).returning({ id: devices.id, siteId: devices.siteId });
    const [otherOrgDev] = await db.insert(devices)
      .values([{ ...dev('srv-other', 'server', sOther!.id), orgId: oB!.id, siteId: sOther!.id }])
      .returning({ id: devices.id, siteId: devices.siteId });
    return {
      orgId, orgB: oB!.id, siteA: sA!.id, siteB: sB!.id,
      all: [srvA!, srvB!, wsA!, wsB!],
      srvA: srvA!, srvB: srvB!, wsA: wsA!, wsB: wsB!, otherOrgDev: otherOrgDev!,
    };
  });
}

async function group(orgId: string, values: Partial<typeof deviceGroups.$inferInsert>) {
  return withSystemDbAccessContext(async () => {
    const [g] = await db.insert(deviceGroups)
      .values({ orgId, name: `G ${Math.random().toString(36).slice(2, 6)}`, type: 'static', ...values })
      .returning();
    return g!;
  });
}

const member = (groupId: string, deviceId: string, orgId: string, isPinned = false) =>
  withSystemDbAccessContext(() => db.insert(deviceGroupMemberships).values({ groupId, deviceId, orgId, isPinned }));

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('groupIncludesDevice parity with resolveEffectiveGroupMembers (real DB) #3205 W06', () => {
  runDb('every group x every device: groupIncludesDevice === (matched ∪ pinned).has(id)', async () => {
    const f = await seed();
    const gStatic = await group(f.orgId, { type: 'static' });
    await member(gStatic.id, f.wsA.id, f.orgId);
    await member(gStatic.id, f.srvB.id, f.orgId);

    const gDynamic = await group(f.orgId, { type: 'dynamic', filterConditions: SERVER_FILTER });
    await member(gDynamic.id, f.wsB.id, f.orgId, true);   // pinned, filter does NOT match
    await member(gDynamic.id, f.srvA.id, f.orgId);        // materialized, filter DOES match

    const gNullFilter = await group(f.orgId, { type: 'dynamic', filterConditions: null });
    await member(gNullFilter.id, f.wsA.id, f.orgId, true);
    await member(gNullFilter.id, f.srvA.id, f.orgId);     // not pinned → not a member

    const gSiteBound = await group(f.orgId, { type: 'dynamic', siteId: f.siteA, filterConditions: SERVER_FILTER });
    await member(gSiteBound.id, f.srvB.id, f.orgId, true); // pinned OFF-SITE: in memberIds, narrowed later by coverageMatch

    for (const g of [gStatic, gDynamic, gNullFilter, gSiteBound]) {
      const { matched, pinned } = await withSystemDbAccessContext(() => resolveEffectiveGroupMembers(g));
      const union = new Set([...matched, ...pinned]);
      for (const d of f.all) {
        const actual = await withSystemDbAccessContext(() => groupIncludesDevice(g, d));
        expect({ group: g.id, device: d.id, actual }).toEqual({ group: g.id, device: d.id, actual: union.has(d.id) });
      }
    }
  });

  runDb('a malformed non-null filter throws invalid_filter from BOTH functions, for every device', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'dynamic', filterConditions: { nope: true } });
    await member(g.id, f.wsA.id, f.orgId, true);   // even a PINNED device must throw: the group is unevaluable
    await expect(withSystemDbAccessContext(() => resolveEffectiveGroupMembers(g)))
      .rejects.toMatchObject({ name: 'GroupEvaluationError', groupId: g.id, reason: 'invalid_filter' });
    for (const d of f.all) {
      await expect(withSystemDbAccessContext(() => groupIncludesDevice(g, d)))
        .rejects.toMatchObject({ name: 'GroupEvaluationError', groupId: g.id, reason: 'invalid_filter' });
    }
    expect(new GroupEvaluationError(g.id, 'invalid_filter')).toBeInstanceOf(Error);
  });

  runDb('a membership row forged with another org_id is invisible', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'static' });
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO device_group_memberships (device_id, group_id, org_id)
      VALUES (${f.otherOrgDev.id}::uuid, ${g.id}::uuid, ${f.orgB}::uuid)
    `));
    expect(await withSystemDbAccessContext(() => groupIncludesDevice(g, f.otherOrgDev))).toBe(false);
  });

  runDb('a pinned device short-circuits: deviceMatchesFilter is never called', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'dynamic', filterConditions: SERVER_FILTER });
    await member(g.id, f.wsB.id, f.orgId, true);
    deviceMatchesFilterSpy.mockClear();
    expect(await withSystemDbAccessContext(() => groupIncludesDevice(g, f.wsB))).toBe(true);
    expect(deviceMatchesFilterSpy).not.toHaveBeenCalled();
    // …and the non-pinned path DOES reach the filter.
    expect(await withSystemDbAccessContext(() => groupIncludesDevice(g, f.srvA))).toBe(true);
    expect(deviceMatchesFilterSpy).toHaveBeenCalledTimes(1);
  });

  runDb('a site-bound group does not match an off-site device through the filter branch', async () => {
    const f = await seed();
    const g = await group(f.orgId, { type: 'dynamic', siteId: f.siteA, filterConditions: SERVER_FILTER });
    expect(await withSystemDbAccessContext(() => groupIncludesDevice(g, f.srvA))).toBe(true);   // server at site A
    expect(await withSystemDbAccessContext(() => groupIncludesDevice(g, f.srvB))).toBe(false);  // server at site B
  });
});
```

- [ ] **Step 1b: Write the failing `billableDeviceById` cases**

In `apps/api/src/__tests__/integration/contractQuantities.integration.test.ts`, extend the service import at `:29` to include `billableDeviceById` and `snapshotContractDevices`, add `and, eq` from `drizzle-orm` and `devices` from `../../db/schema` if they are not already imported, and append:

```ts
describe('billableDeviceById (#3205 W06)', () => {
  const runDb = it.runIf(!!process.env.DATABASE_URL);

  runDb('returns the snapshot row for a billable device and null for every excluded one', async () => {
    const f = await seedFixture();
    const rows = await withSystemDbAccessContext(() => snapshotContractDevices(f.orgId));
    const billable = rows[0]!;
    await expect(withSystemDbAccessContext(() => billableDeviceById(billable.id, f.orgId)))
      .resolves.toEqual({ id: billable.id, role: billable.role, siteId: billable.siteId });

    const [decommissioned] = await withSystemDbAccessContext(() => db
      .select({ id: devices.id }).from(devices)
      .where(and(eq(devices.orgId, f.orgId), eq(devices.status, 'decommissioned' as never))).limit(1));
    await expect(withSystemDbAccessContext(() => billableDeviceById(decommissioned!.id, f.orgId))).resolves.toBeNull();

    // Right device, wrong org — the org predicate, not just the id.
    await expect(withSystemDbAccessContext(() => billableDeviceById(billable.id, crypto.randomUUID()))).resolves.toBeNull();
    await expect(withSystemDbAccessContext(() => billableDeviceById(crypto.randomUUID(), f.orgId))).resolves.toBeNull();
  });

  runDb('excludes an ephemeral device', async () => {
    const f = await seedFixture();
    const [eph] = await withSystemDbAccessContext(() => db.insert(devices).values({
      orgId: f.orgId, siteId: f.siteAId, agentId: `eph-${Math.random().toString(36).slice(2, 8)}`,
      hostname: 'eph', status: 'online', deviceRole: 'server', osType: 'linux', osVersion: '22.04',
      architecture: 'x86_64', agentVersion: '1.0.0', isEphemeral: true,
    }).returning({ id: devices.id }));
    await expect(withSystemDbAccessContext(() => billableDeviceById(eph!.id, f.orgId))).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify both fail**

Run:
```bash
cd apps/api && DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/groupMembership.parity.integration.test.ts \
  src/__tests__/integration/contractQuantities.integration.test.ts
```
Expected: FAIL — `groupIncludesDevice is not a function`; `billableDeviceById is not a function`.

- [ ] **Step 3: Implement `groupIncludesDevice`**

In `apps/api/src/services/groupMembership.ts`, immediately after `resolveEffectiveGroupMembers`:

```ts
export type DeviceForMembership = Pick<typeof devices.$inferSelect, 'id' | 'siteId'>;

/**
 * Is this ONE device in this group, as billing defines membership (#3205 W06)?
 * The single-device twin of resolveEffectiveGroupMembers: returns exactly
 * `deviceId ∈ (matched ∪ pinned)`, proved by groupMembership.parity.integration.test.ts.
 *
 * The site clause on the filter branch is PARITY, not an optimization:
 * evaluateFilter narrows by allowedSiteIds inside its SQL, deviceMatchesFilter
 * (filterEngine.ts:668) takes no site argument. The pinned branch carries no
 * site clause because `pinned` carries none either — a site-bound group's
 * off-site pinned member IS in memberIds and is narrowed out later, by
 * coverageMatch's group branch.
 *
 * Filter-shape validation runs BEFORE the pinned short-circuit: an unevaluable
 * group throws for every device, exactly as resolveEffectiveGroupMembers does.
 * The shape check is a pure in-memory test, so the pinned row still skips the
 * expensive half (deviceMatchesFilter, a compiled filter under a 500 ms timeout).
 *
 * Every membership read predicates on group_id AND the group's own org_id: the
 * membership table's RLS is org-only, so a forged row carrying another tenant's
 * org_id and this group's id is visible to a system context.
 */
export async function groupIncludesDevice(group: GroupForResolution, device: DeviceForMembership): Promise<boolean> {
  const [membership] = await db
    .select({ isPinned: deviceGroupMemberships.isPinned })
    .from(deviceGroupMemberships)
    .where(and(
      eq(deviceGroupMemberships.groupId, group.id),
      eq(deviceGroupMemberships.orgId, group.orgId),
      eq(deviceGroupMemberships.deviceId, device.id),
    ))
    .limit(1);

  if (group.type !== 'dynamic') return membership !== undefined;

  const filter = group.filterConditions;
  const hasFilter = filter !== null && filter !== undefined;
  if (hasFilter && !isFilterConditionGroup(filter)) {
    throw new GroupEvaluationError(group.id, 'invalid_filter');
  }
  if (membership?.isPinned) return true;
  if (!hasFilter) return false;
  if (group.siteId !== null && group.siteId !== device.siteId) return false;
  try {
    return await deviceMatchesFilter(device.id, filter as FilterConditionGroup);
  } catch (err) {
    throw new GroupEvaluationError(group.id, 'engine_error', err);
  }
}
```

`resolveEffectiveGroupMembers` and `evaluateGroupMembership` are untouched. `and`, `eq`, `db`, `deviceGroupMemberships`, `devices`, `deviceMatchesFilter` and `FilterConditionGroup` are all already imported by this file.

- [ ] **Step 4: Implement `billableDeviceById`**

In `apps/api/src/services/contractQuantities.ts`, after `snapshotContractDevices`:

```ts
/** The one billable device, as the snapshot sees it — the single-device twin of
 *  snapshotContractDevices, sharing billableDeviceConds so a fourth predicate
 *  added later applies to the device coverage panel automatically (#3205 W06).
 *  null = decommissioned, ephemeral, in another org, or gone. */
export async function billableDeviceById(deviceId: string, orgId: string): Promise<DeviceSnapshotRow | null> {
  const [row] = await db
    .select({ id: devices.id, role: devices.deviceRole, siteId: devices.siteId })
    .from(devices)
    .where(and(...billableDeviceConds(orgId), eq(devices.id, deviceId)))
    .limit(1);
  return row ?? null;
}
```

- [ ] **Step 5: Run both suites**

Run:
```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
npx vitest run src/services/groupMembership.materialization.test.ts src/services/groupMembership.siteScope.test.ts src/services/groupMembership.manualMembership.test.ts
DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/groupMembership.parity.integration.test.ts \
  src/__tests__/integration/groupMembership.resolve.integration.test.ts \
  src/__tests__/integration/contractQuantities.integration.test.ts
```
Expected: all PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/groupMembership.ts apps/api/src/services/contractQuantities.ts apps/api/src/__tests__/integration/groupMembership.parity.integration.test.ts apps/api/src/__tests__/integration/contractQuantities.integration.test.ts
git commit -m "feat(billing): single-device membership + billable-device primitives, with real-DB parity proof (#3205 W06)"
```

---

### Task 3: `services/deviceCoverage.ts` — the one-device lookup

**Files:**
- Create: `apps/api/src/services/deviceCoverage.ts`
- Create: `apps/api/src/services/deviceCoverage.test.ts`
- Create: `apps/api/src/__tests__/integration/deviceCoverage.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 `coverageMatch`, `DEVICE_COUNTED_LINE_TYPES`, `CoverageMatchReason`, `DeviceCountedLineType`, `CoverageLine`, `OrgDeviceSnapshot`, `GroupMembers`; Task 2 `billableDeviceById`, `groupIncludesDevice`; W02 `GroupEvaluationError`; `PG_UUID_REGEX` from `../utils/uuid`.
- Produces:

```ts
export interface DeviceCoverageLine {
  contractId: string; contractName: string; contractStatus: ContractStatusValue;
  lineId: string; lineType: DeviceCountedLineType; description: string;
  matchedBy: CoverageMatchReason;
  siteId: string | null;
  deviceRoles: readonly string[] | null;
  deviceGroup: { id: string; name: string } | null;
}
export interface DeviceBillingCoverage {
  deviceId: string; orgId: string; deviceRole: string; siteId: string | null;
  notBillable: boolean;
  notBillableReason: 'decommissioned' | 'ephemeral' | 'not_billable' | null;
  lines: DeviceCoverageLine[];
  uncovered: boolean;
}
export type DeviceCoverageErrorCode = 'DEVICE_NOT_FOUND' | 'GROUP_EVALUATION_FAILED';
export class DeviceCoverageError extends Error { status: 404 | 500; code: DeviceCoverageErrorCode; details?: Record<string, unknown>; }
export interface DeviceCoverageActor { accessibleOrgIds: string[] | null }
export async function contractLinesCoveringDevice(deviceId: string, actor: DeviceCoverageActor): Promise<DeviceBillingCoverage>;
```

- [ ] **Step 1: Write the failing unit test**

Create `apps/api/src/services/deviceCoverage.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable Drizzle chain mock — the contractService.test.ts pattern. Every
// builder method returns the same chain; awaiting it yields the next queued
// result. contractQuantities and groupMembership are DELIBERATELY NOT mocked:
// their reads go through this same db, which is what makes the query-count
// assertions below a real contract rather than a restatement of the mocks.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

const { selectMock, deviceMatchesFilterMock } = vi.hoisted(() => ({
  selectMock: vi.fn(), deviceMatchesFilterMock: vi.fn(),
}));

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'orderBy', 'innerJoin', 'leftJoin', 'groupBy']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(results.shift() ?? []).then(resolve);
  selectMock.mockImplementation(() => chain);
  return {
    db: { select: selectMock },
    hasDbAccessContext: () => true,
    getCurrentDbAccessContext: () => ({ scope: 'system', orgId: null }),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
  };
});
// groupMembership pulls the peripheral queue in transitively; it opens BullMQ at
// import time and this suite never schedules anything.
vi.mock('../jobs/peripheralJobs', () => ({ schedulePeripheralPolicyDevice: vi.fn() }));
vi.mock('./filterEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./filterEngine')>();
  return { ...actual, deviceMatchesFilter: deviceMatchesFilterMock };
});

import { GroupEvaluationError } from './groupMembership';
import { contractLinesCoveringDevice, DeviceCoverageError } from './deviceCoverage';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const SITE_A = '33333333-3333-4333-8333-333333333333';
const SITE_B = '44444444-4444-4444-8444-444444444444';
const GROUP_ID = '55555555-5555-4555-8555-555555555555';

const identity = (over: Record<string, unknown> = {}) => [{
  id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_A, deviceRole: 'server',
  status: 'online', isEphemeral: false, ...over,
}];
const billableRow = [{ id: DEVICE_ID, role: 'server', siteId: SITE_A }];
const contractLineRow = (over: Record<string, unknown> = {}) => ({
  contractId: 'c1', contractName: 'Acme MSA', contractStatus: 'active',
  line: {
    id: 'l1', lineType: 'per_device_role', description: 'Managed servers', siteId: null,
    deviceRoles: ['server'], deviceGroupId: null, deviceGroupName: null, sortOrder: 0,
    ...over,
  },
});
const groupRow = (over: Record<string, unknown> = {}) => ({
  id: GROUP_ID, orgId: ORG_ID, name: 'VIP Laptops', type: 'static', siteId: null, filterConditions: null, ...over,
});
const actor = { accessibleOrgIds: [ORG_ID] };

beforeEach(() => {
  results.length = 0;
  vi.clearAllMocks();
  deviceMatchesFilterMock.mockResolvedValue(false);
});

describe('contractLinesCoveringDevice (#3205 W06)', () => {
  it('rejects a malformed id as DEVICE_NOT_FOUND with ZERO queries', async () => {
    await expect(contractLinesCoveringDevice('not-a-uuid', actor))
      .rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND', status: 404 });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('a missing device and a device outside accessibleOrgIds are the SAME 404', async () => {
    queueResult([]);
    await expect(contractLinesCoveringDevice(DEVICE_ID, actor)).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND', status: 404 });
    queueResult(identity({ orgId: 'other-org' }));
    await expect(contractLinesCoveringDevice(DEVICE_ID, actor)).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND', status: 404 });
  });

  it('accessibleOrgIds null (system/worker) reaches any org', async () => {
    queueResult(identity({ orgId: 'some-other-org' }));
    queueResult(billableRow);
    queueResult([]);
    const res = await contractLinesCoveringDevice(DEVICE_ID, { accessibleOrgIds: null });
    expect(res).toMatchObject({ orgId: 'some-other-org', uncovered: true, notBillable: false });
  });

  it.each([
    ['decommissioned', { status: 'decommissioned' }, 'decommissioned'],
    ['ephemeral', { isEphemeral: true }, 'ephemeral'],
    ['a concurrent move (neither flag set)', {}, 'not_billable'],
  ])('not billable — %s — labels the reason, does no contract work, and never throws', async (_n, over, reason) => {
    queueResult(identity(over));
    queueResult([]);   // billableDeviceById → null
    const res = await contractLinesCoveringDevice(DEVICE_ID, actor);
    expect(res).toMatchObject({ notBillable: true, notBillableReason: reason, lines: [], uncovered: false });
    expect(selectMock).toHaveBeenCalledTimes(2);   // identity + billableDeviceById, nothing else
  });

  it('billable with no active contract lines: 3 reads, no group query, uncovered', async () => {
    queueResult(identity());
    queueResult(billableRow);
    queueResult([]);
    const res = await contractLinesCoveringDevice(DEVICE_ID, actor);
    expect(res).toMatchObject({ notBillable: false, notBillableReason: null, lines: [], uncovered: true });
    expect(selectMock).toHaveBeenCalledTimes(3);
  });

  it('projects a role line: matchedBy role, roles verbatim, no deviceGroup', async () => {
    queueResult(identity());
    queueResult(billableRow);
    queueResult([contractLineRow()]);
    const res = await contractLinesCoveringDevice(DEVICE_ID, actor);
    expect(res.uncovered).toBe(false);
    expect(res.lines).toEqual([{
      contractId: 'c1', contractName: 'Acme MSA', contractStatus: 'active', lineId: 'l1',
      lineType: 'per_device_role', description: 'Managed servers', matchedBy: 'role',
      siteId: null, deviceRoles: ['server'], deviceGroup: null,
    }]);
  });

  it('per_device splits org vs site, and a line at another site does not cover', async () => {
    queueResult(identity());
    queueResult(billableRow);
    queueResult([
      contractLineRow({ id: 'l-org', lineType: 'per_device', deviceRoles: null, description: 'All devices' }),
      contractLineRow({ id: 'l-site', lineType: 'per_device', deviceRoles: null, siteId: SITE_A, description: 'HQ devices' }),
      contractLineRow({ id: 'l-other', lineType: 'per_device', deviceRoles: null, siteId: SITE_B, description: 'Branch devices' }),
    ]);
    const res = await contractLinesCoveringDevice(DEVICE_ID, actor);
    expect(res.lines.map((l) => [l.lineId, l.matchedBy, l.siteId]))
      .toEqual([['l-org', 'org', null], ['l-site', 'site', SITE_A]]);
  });

  it('a static group line: batch read + 1 membership read + 0 deviceMatchesFilter', async () => {
    queueResult(identity());
    queueResult(billableRow);
    queueResult([contractLineRow({
      id: 'l-g', lineType: 'per_device_group', deviceRoles: null,
      deviceGroupId: GROUP_ID, deviceGroupName: 'VIP Laptops', description: 'VIP',
    })]);
    queueResult([groupRow()]);
    queueResult([{ isPinned: false }]);   // membership row exists → static member
    const res = await contractLinesCoveringDevice(DEVICE_ID, actor);
    expect(res.lines).toEqual([expect.objectContaining({
      matchedBy: 'group', deviceRoles: null, deviceGroup: { id: GROUP_ID, name: 'VIP Laptops' },
    })]);
    expect(selectMock).toHaveBeenCalledTimes(5);
    expect(deviceMatchesFilterMock).not.toHaveBeenCalled();
  });

  it('a group bound to ANOTHER site is skipped entirely: no membership read, no filter run', async () => {
    queueResult(identity());
    queueResult(billableRow);
    queueResult([contractLineRow({
      id: 'l-g', lineType: 'per_device_group', deviceRoles: null,
      deviceGroupId: GROUP_ID, deviceGroupName: 'Branch VIPs',
    })]);
    queueResult([groupRow({ type: 'dynamic', siteId: SITE_B, filterConditions: { operator: 'AND', conditions: [] } })]);
    const res = await contractLinesCoveringDevice(DEVICE_ID, actor);
    expect(res).toMatchObject({ lines: [], uncovered: true });
    expect(selectMock).toHaveBeenCalledTimes(4);
    expect(deviceMatchesFilterMock).not.toHaveBeenCalled();
  });

  it('a group line whose group is gone covers nothing and does NOT throw (Decision 7)', async () => {
    queueResult(identity());
    queueResult(billableRow);
    queueResult([
      contractLineRow({ id: 'l-null', lineType: 'per_device_group', deviceRoles: null, deviceGroupId: null, deviceGroupName: 'Retired' }),
      contractLineRow({ id: 'l-gone', lineType: 'per_device_group', deviceRoles: null, deviceGroupId: GROUP_ID, deviceGroupName: 'Deleted' }),
    ]);
    queueResult([]);   // batch read returns nothing for GROUP_ID
    const res = await contractLinesCoveringDevice(DEVICE_ID, actor);
    expect(res).toMatchObject({ lines: [], uncovered: true });
  });

  it('a GroupEvaluationError REJECTS as GROUP_EVALUATION_FAILED — it never resolves with lines: []', async () => {
    queueResult(identity());
    queueResult(billableRow);
    queueResult([contractLineRow({
      id: 'l-g', lineType: 'per_device_group', deviceRoles: null,
      deviceGroupId: GROUP_ID, deviceGroupName: 'VIP Laptops',
    })]);
    queueResult([groupRow({ type: 'dynamic', filterConditions: { nope: true } })]);
    const err = await contractLinesCoveringDevice(DEVICE_ID, actor).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceCoverageError);
    expect(err).toMatchObject({
      status: 500, code: 'GROUP_EVALUATION_FAILED',
      details: { groupId: GROUP_ID, groupName: 'VIP Laptops', reason: 'invalid_filter' },
    });
    expect(new GroupEvaluationError(GROUP_ID, 'engine_error')).toBeInstanceOf(Error);
  });

  it('any other error propagates unchanged — never swallowed into an empty coverage', async () => {
    const boom = new Error('kaboom');
    // mockImplementationOnce jumps the queue, so this hits the FIRST read.
    selectMock.mockImplementationOnce(() => { throw boom; });
    await expect(contractLinesCoveringDevice(DEVICE_ID, actor)).rejects.toBe(boom);
  });

  it('the three-state invariant holds on every fixture', async () => {
    const fixtures: Array<() => void> = [
      () => { queueResult(identity({ status: 'decommissioned' })); queueResult([]); },
      () => { queueResult(identity()); queueResult(billableRow); queueResult([]); },
      () => { queueResult(identity()); queueResult(billableRow); queueResult([contractLineRow()]); },
    ];
    for (const setup of fixtures) {
      results.length = 0;
      setup();
      const r = await contractLinesCoveringDevice(DEVICE_ID, actor);
      expect(r.uncovered).toBe(!r.notBillable && r.lines.length === 0);
      if (r.notBillable) { expect(r.lines).toEqual([]); expect(r.uncovered).toBe(false); }
    }
  });
});
```

- [ ] **Step 2: Write the failing integration test**

Create `apps/api/src/__tests__/integration/deviceCoverage.integration.test.ts`:

```ts
/**
 * #3205 W06 acceptance bar, real Postgres as breeze_app: the device panel's
 * answer is the contract page's answer, computed from a ONE-DEVICE snapshot,
 * and equals what the full-org snapshot would say for every device.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  partners, organizations, sites, devices, deviceGroups, deviceGroupMemberships, contracts, contractLines,
} from '../../db/schema';
import { contractLinesCoveringDevice } from '../../services/deviceCoverage';
import { snapshotContractDevices, groupMembersForBilling } from '../../services/contractQuantities';
import { coverageMatch, uncoveredByRole, type CoverageLine, type GroupMembers, type OrgDeviceSnapshot } from '../../services/contractCoverage';

const SERVER_FILTER = { operator: 'AND' as const, conditions: [{ field: 'deviceRole', operator: 'equals', value: 'server' }] };
const SYSTEM_ACTOR = { accessibleOrgIds: null };

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `CP ${sfx}`, slug: `cp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'CA', slug: `ca-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'CB', slug: `cb-${sfx}` },
    ]).returning({ id: organizations.id });
    const orgId = oA!.id;
    const [sA, sB] = await db.insert(sites).values([
      { orgId, name: `A-${sfx}` }, { orgId, name: `B-${sfx}` },
    ]).returning({ id: sites.id });
    const [sOther] = await db.insert(sites).values({ orgId: oB!.id, name: `O-${sfx}` }).returning({ id: sites.id });
    const dev = (agent: string, role: string, siteId: string, extra: Record<string, unknown> = {}) => ({
      orgId, siteId, agentId: `${agent}-${sfx}`, hostname: agent, status: 'online', deviceRole: role,
      osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0', ...extra,
    });
    const [srvA, srvB, wsA, unk, decom] = await db.insert(devices).values([
      dev('srv-a', 'server', sA!.id), dev('srv-b', 'server', sB!.id), dev('ws-a', 'workstation', sA!.id),
      dev('unk-a', 'unknown', sA!.id), dev('decom-a', 'server', sA!.id, { status: 'decommissioned' }),
    ]).returning({ id: devices.id, siteId: devices.siteId });
    const [otherOrgDev] = await db.insert(devices)
      .values([{ ...dev('srv-o', 'server', sOther!.id), orgId: oB!.id, siteId: sOther!.id }])
      .returning({ id: devices.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId, name: 'Acme MSA', status: 'active', intervalMonths: 1,
      startDate: '2026-07-01', nextBillingAt: '2026-08-01', currencyCode: 'USD', billingTiming: 'advance',
    }).returning({ id: contracts.id });
    return {
      partnerId: p!.id, orgId, orgB: oB!.id, siteA: sA!.id, siteB: sB!.id, contractId: c!.id,
      srvA: srvA!, srvB: srvB!, wsA: wsA!, unk: unk!, decom: decom!, otherOrgDev: otherOrgDev!,
    };
  });
}

type F = Awaited<ReturnType<typeof seed>>;

const addLine = (f: F, values: Partial<typeof contractLines.$inferInsert>, contractId = f.contractId) =>
  withSystemDbAccessContext(async () => {
    const [l] = await db.insert(contractLines).values({
      contractId, orgId: f.orgId, description: 'line', unitPrice: '10.00', taxable: false,
      lineType: 'per_device', ...values,
    } as typeof contractLines.$inferInsert).returning({ id: contractLines.id });
    return l!.id;
  });

const addGroup = (f: F, values: Partial<typeof deviceGroups.$inferInsert>) =>
  withSystemDbAccessContext(async () => {
    const [g] = await db.insert(deviceGroups)
      .values({ orgId: f.orgId, name: `G ${Math.random().toString(36).slice(2, 6)}`, type: 'static', ...values })
      .returning();
    return g!;
  });

const addContract = (f: F, status: string) =>
  withSystemDbAccessContext(async () => {
    const [c] = await db.insert(contracts).values({
      partnerId: f.partnerId, orgId: f.orgId, name: `C-${status}`, status: status as never,
      intervalMonths: 1, startDate: '2026-07-01', currencyCode: 'USD',
    }).returning({ id: contracts.id });
    return c!.id;
  });

const coverage = (deviceId: string, actor = SYSTEM_ACTOR) =>
  withSystemDbAccessContext(() => contractLinesCoveringDevice(deviceId, actor));

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('contractLinesCoveringDevice (real DB) #3205 W06', () => {
  runDb('HEADLINE: a device on a billed group AND a role line lists both, ordered by contract then sortOrder', async () => {
    const f = await seed();
    const g = await addGroup(f, { type: 'static' });
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships)
      .values({ groupId: g.id, deviceId: f.srvA.id, orgId: f.orgId }));
    await addLine(f, { lineType: 'per_device_group', deviceGroupId: g.id, deviceGroupName: g.name, description: 'VIP', sortOrder: 0 });
    await addLine(f, { lineType: 'per_device_role', deviceRoles: ['server'] as never, description: 'Managed servers', sortOrder: 1 });

    const res = await coverage(f.srvA.id);
    expect(res.lines.map((l) => [l.matchedBy, l.description]))
      .toEqual([['group', 'VIP'], ['role', 'Managed servers']]);
    expect(res.lines[0]!.deviceGroup).toEqual({ id: g.id, name: g.name });
    expect(res).toMatchObject({ uncovered: false, notBillable: false, deviceRole: 'server' });
  });

  runDb('CROSS-CHECK with the contract page: covered here IFF absent from uncoveredByRole', async () => {
    const f = await seed();
    const g = await addGroup(f, { type: 'static' });
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships)
      .values({ groupId: g.id, deviceId: f.wsA.id, orgId: f.orgId }));
    await addLine(f, { lineType: 'per_device_role', deviceRoles: ['server'] as never, sortOrder: 0 });
    await addLine(f, { lineType: 'per_device_group', deviceGroupId: g.id, deviceGroupName: g.name, sortOrder: 1 });

    const lines = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.contractId, f.contractId)));
    const snapshot = await withSystemDbAccessContext(async (): Promise<OrgDeviceSnapshot> => ({
      devices: await snapshotContractDevices(f.orgId),
      groups: new Map<string, GroupMembers>([[g.id, await groupMembersForBilling(g)]]),
    }));
    const tally = uncoveredByRole(snapshot, lines as unknown as CoverageLine[]);

    for (const d of [f.srvA, f.srvB, f.wsA, f.unk]) {
      const res = await coverage(d.id);
      const inSnapshot = snapshot.devices.find((r) => r.id === d.id)!;
      const uncoveredHere = !lines.some((l) => coverageMatch(l as unknown as CoverageLine, inSnapshot, snapshot) !== null);
      expect({ id: d.id, uncovered: res.uncovered }).toEqual({ id: d.id, uncovered: uncoveredHere });
    }
    expect(tally.byRole.unknown).toBe(1);   // unk1 is billable but no role/group line reaches it
  });

  runDb('ONE-DEVICE vs FULL-ORG snapshot equivalence, including an off-site pinned member', async () => {
    const f = await seed();
    const g = await addGroup(f, { type: 'dynamic', siteId: f.siteA, filterConditions: SERVER_FILTER });
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships)
      .values({ groupId: g.id, deviceId: f.srvB.id, orgId: f.orgId, isPinned: true }));  // off-site pin
    await addLine(f, { lineType: 'per_device_group', deviceGroupId: g.id, deviceGroupName: g.name, sortOrder: 0 });
    await addLine(f, { lineType: 'per_device', siteId: f.siteB, description: 'Branch devices', sortOrder: 1 });

    const lines = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.contractId, f.contractId)));
    const full = await withSystemDbAccessContext(async (): Promise<OrgDeviceSnapshot> => ({
      devices: await snapshotContractDevices(f.orgId),
      groups: new Map<string, GroupMembers>([[g.id, await groupMembersForBilling(g)]]),
    }));

    for (const row of full.devices) {
      const expected = lines
        .filter((l) => coverageMatch(l as unknown as CoverageLine, row, full) !== null)
        .map((l) => l.id).sort();
      const actual = (await coverage(row.id)).lines.map((l) => l.lineId).sort();
      expect({ id: row.id, actual }).toEqual({ id: row.id, actual: expected });
    }
  });

  runDb('only ACTIVE contracts count: draft does not cover, activating the same contract does', async () => {
    const f = await seed();
    const draftId = await addContract(f, 'draft');
    await addLine(f, { lineType: 'per_device_role', deviceRoles: ['server'] as never }, draftId);
    expect((await coverage(f.srvA.id)).uncovered).toBe(true);
    await withSystemDbAccessContext(() => db.update(contracts).set({ status: 'active' }).where(eq(contracts.id, draftId)));
    expect((await coverage(f.srvA.id)).lines).toHaveLength(1);
  });

  runDb('a paused contract does not cover; an active contract with nextBillingAt NULL DOES', async () => {
    const f = await seed();
    const pausedId = await addContract(f, 'paused');
    await addLine(f, { lineType: 'per_device' }, pausedId);
    expect((await coverage(f.srvA.id)).uncovered).toBe(true);
    await withSystemDbAccessContext(() => db.update(contracts).set({ nextBillingAt: null }).where(eq(contracts.id, f.contractId)));
    await addLine(f, { lineType: 'per_device', description: 'All devices' });
    expect((await coverage(f.srvA.id)).lines).toEqual([expect.objectContaining({ matchedBy: 'org' })]);
  });

  runDb('a per_device line at another site does not cover; at the device site it covers with matchedBy site', async () => {
    const f = await seed();
    await addLine(f, { lineType: 'per_device', siteId: f.siteB, description: 'Branch' });
    expect((await coverage(f.srvA.id)).uncovered).toBe(true);
    await addLine(f, { lineType: 'per_device', siteId: f.siteA, description: 'HQ' });
    expect((await coverage(f.srvA.id)).lines).toEqual([expect.objectContaining({ matchedBy: 'site', siteId: f.siteA })]);
  });

  runDb('a group line whose group was deleted does not cover and does NOT throw', async () => {
    const f = await seed();
    const g = await addGroup(f, { type: 'static' });
    await addLine(f, { lineType: 'per_device_group', deviceGroupId: g.id, deviceGroupName: g.name });
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM device_groups WHERE id = ${g.id}::uuid`));
    await expect(coverage(f.srvA.id)).resolves.toMatchObject({ uncovered: true, lines: [] });
  });

  runDb('a malformed dynamic filter rejects with GROUP_EVALUATION_FAILED — never uncovered: true', async () => {
    const f = await seed();
    const g = await addGroup(f, { type: 'dynamic', filterConditions: { broken: true } });
    await addLine(f, { lineType: 'per_device_group', deviceGroupId: g.id, deviceGroupName: g.name });
    await expect(coverage(f.srvA.id)).rejects.toMatchObject({
      status: 500, code: 'GROUP_EVALUATION_FAILED', details: { groupId: g.id, reason: 'invalid_filter' },
    });
  });

  runDb('a decommissioned device in an org with a broken group is notBillable, with no throw', async () => {
    const f = await seed();
    const g = await addGroup(f, { type: 'dynamic', filterConditions: { broken: true } });
    await addLine(f, { lineType: 'per_device_group', deviceGroupId: g.id, deviceGroupName: g.name });
    await expect(coverage(f.decom.id)).resolves.toMatchObject({
      notBillable: true, notBillableReason: 'decommissioned', lines: [], uncovered: false,
    });
  });

  runDb('a stale materialized dynamic membership is ignored: coverage follows the LIVE set', async () => {
    const f = await seed();
    const g = await addGroup(f, { type: 'dynamic', filterConditions: SERVER_FILTER });
    await withSystemDbAccessContext(() => db.insert(deviceGroupMemberships)
      .values({ groupId: g.id, deviceId: f.srvA.id, orgId: f.orgId }));   // materialized, not pinned
    await addLine(f, { lineType: 'per_device_group', deviceGroupId: g.id, deviceGroupName: g.name });
    expect((await coverage(f.srvA.id)).lines).toHaveLength(1);
    await withSystemDbAccessContext(() => db.update(devices).set({ deviceRole: 'workstation' }).where(eq(devices.id, f.srvA.id)));
    expect((await coverage(f.srvA.id)).uncovered).toBe(true);            // stale row is NOT consulted
  });

  runDb('an unknown-role device is covered by an org-wide per_device line', async () => {
    const f = await seed();
    await addLine(f, { lineType: 'per_device', description: 'All devices' });
    expect((await coverage(f.unk.id)).lines).toEqual([expect.objectContaining({ matchedBy: 'org' })]);
  });

  runDb('cross-org: a device in org B is DEVICE_NOT_FOUND for an actor restricted to org A', async () => {
    const f = await seed();
    await expect(coverage(f.otherOrgDev.id, { accessibleOrgIds: [f.orgId] }))
      .rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND', status: 404 });
    await expect(coverage('99999999-9999-4999-8999-999999999999', { accessibleOrgIds: [f.orgId] }))
      .rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND', status: 404 });
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run:
```bash
cd apps/api && npx vitest run src/services/deviceCoverage.test.ts
DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test \
  npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceCoverage.integration.test.ts
```
Expected: BOTH FAIL — `Cannot find module './deviceCoverage'`.

- [ ] **Step 4: Implement `deviceCoverage.ts`**

Create `apps/api/src/services/deviceCoverage.ts`:

```ts
/**
 * "Which contract lines bill this device?" (#3205 W06).
 *
 * The transpose of the billing path's per-line question, over the SAME
 * predicate: a ONE-DEVICE OrgDeviceSnapshot fed to contractCoverage's
 * coverageMatch. Nothing is re-derived — only the input set is narrowed to the
 * one row the caller asked about, so this costs O(1) reads instead of the
 * O(org) snapshot generateDueInvoice builds. contractService.ts's orgSnapshot /
 * DeviceCache stay exactly where W02 put them; this module does not import them.
 *
 * Derived live, every time, over `active` contracts only: "could this line bill
 * this device?", deliberately not "will it bill this period?" (that depends on
 * the billing calendar and belongs to W07's per-period evidence).
 *
 * The service re-checks the org itself so non-route callers (#4606, a worker)
 * cannot skip it; the ROUTE still owns the site axis, because the site allowlist
 * lives in the Hono permissions context and never in accessibleOrgIds.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { contractLines, contracts, deviceGroups, devices } from '../db/schema';
import { PG_UUID_REGEX } from '../utils/uuid';
import { billableDeviceById } from './contractQuantities';
import { GroupEvaluationError, groupIncludesDevice } from './groupMembership';
import {
  coverageMatch,
  DEVICE_COUNTED_LINE_TYPES,
  type CoverageLine,
  type CoverageMatchReason,
  type DeviceCountedLineType,
  type GroupMembers,
  type OrgDeviceSnapshot,
} from './contractCoverage';

export type ContractStatusValue = (typeof contracts.$inferSelect)['status'];

export interface DeviceCoverageLine {
  contractId: string;
  contractName: string;
  /** Always 'active' in W06; typed for #4606 / W07. */
  contractStatus: ContractStatusValue;
  lineId: string;
  lineType: DeviceCountedLineType;
  description: string;
  matchedBy: CoverageMatchReason;
  /** The line's own site narrowing, verbatim. Non-null implies it equals the device's siteId. */
  siteId: string | null;
  /** per_device_role only; null on every other type. */
  deviceRoles: readonly string[] | null;
  /** per_device_group only. `name` is the line's stamped device_group_name. */
  deviceGroup: { id: string; name: string } | null;
}

export interface DeviceBillingCoverage {
  deviceId: string;
  orgId: string;
  deviceRole: string;
  siteId: string | null;
  notBillable: boolean;
  notBillableReason: 'decommissioned' | 'ephemeral' | 'not_billable' | null;
  lines: DeviceCoverageLine[];
  /** Derived: !notBillable && lines.length === 0. Never true for a not-billable device. */
  uncovered: boolean;
}

export type DeviceCoverageErrorCode = 'DEVICE_NOT_FOUND' | 'GROUP_EVALUATION_FAILED';

/** Owned here rather than reusing ContractServiceError: a device route has no
 *  handleContractError, and the billing error taxonomy should not leak into it. */
export class DeviceCoverageError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 500,
    public readonly code: DeviceCoverageErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DeviceCoverageError';
  }
}

/** null accessibleOrgIds = unrestricted (system/worker); otherwise the caller's orgs. */
export interface DeviceCoverageActor {
  accessibleOrgIds: string[] | null;
}

/** 404 for missing AND for cross-org, never 403: a probe must not be able to
 *  distinguish "exists elsewhere" from "does not exist" (getDeviceWithOrgCheck
 *  returns null for both). */
function deviceNotFound(): DeviceCoverageError {
  return new DeviceCoverageError('Device not found', 404, 'DEVICE_NOT_FOUND');
}

export async function contractLinesCoveringDevice(
  deviceId: string,
  actor: DeviceCoverageActor,
): Promise<DeviceBillingCoverage> {
  // devices.id is uuid-typed: a malformed param would reach Postgres as 22P02
  // and surface as a 500 (#2968). Same lesson as helpers.ts:174-176.
  if (!PG_UUID_REGEX.test(deviceId)) throw deviceNotFound();

  const [device] = await db
    .select({
      id: devices.id, orgId: devices.orgId, siteId: devices.siteId,
      deviceRole: devices.deviceRole, status: devices.status, isEphemeral: devices.isEphemeral,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) throw deviceNotFound();
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(device.orgId)) throw deviceNotFound();

  const base = {
    deviceId: device.id, orgId: device.orgId,
    deviceRole: device.deviceRole, siteId: device.siteId,
  };

  // The unforked billableDeviceConds verdict. null = decommissioned, ephemeral,
  // or moved org AT THIS INSTANT. Two reads a millisecond apart are allowed to
  // disagree: a benign race gets a correct notBillable with a vaguer reason,
  // never a 500. Returning here also means a not-billable device does NO group
  // work, so it can never fail on an unrelated broken group.
  const row = await billableDeviceById(deviceId, device.orgId);
  if (!row) {
    const notBillableReason = device.status === 'decommissioned'
      ? 'decommissioned' as const
      : device.isEphemeral ? 'ephemeral' as const : 'not_billable' as const;
    return { ...base, notBillable: true, notBillableReason, lines: [], uncovered: false };
  }

  const rows = await db
    .select({
      contractId: contracts.id,
      contractName: contracts.name,
      contractStatus: contracts.status,
      line: contractLines,
    })
    .from(contractLines)
    .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
    .where(and(
      eq(contracts.orgId, device.orgId),
      eq(contracts.status, 'active'),
      eq(contractLines.orgId, device.orgId),   // defence in depth beside W02's (contract_id, org_id) FK
      inArray(contractLines.lineType, [...DEVICE_COUNTED_LINE_TYPES]),
    ))
    .orderBy(contracts.name, contractLines.sortOrder);
  if (rows.length === 0) {
    return { ...base, notBillable: false, notBillableReason: null, lines: [], uncovered: true };
  }

  const referencedGroupIds = [...new Set(
    rows.filter((r) => r.line.lineType === 'per_device_group' && r.line.deviceGroupId)
        .map((r) => r.line.deviceGroupId!),
  )];

  const groups = new Map<string, GroupMembers>();
  if (referencedGroupIds.length > 0) {
    const groupRows = await db
      .select({
        id: deviceGroups.id, orgId: deviceGroups.orgId, name: deviceGroups.name,
        type: deviceGroups.type, siteId: deviceGroups.siteId, filterConditions: deviceGroups.filterConditions,
      })
      .from(deviceGroups)
      .where(and(inArray(deviceGroups.id, referencedGroupIds), eq(deviceGroups.orgId, device.orgId)));

    for (const g of groupRows) {
      // Coverage-level short-circuit: coverageMatch's group branch requires
      // g.siteId === null || g.siteId === row.siteId, so a group bound to a
      // different site cannot cover this device however it is pinned. Keeping
      // the skip HERE rather than inside groupIncludesDevice is what lets that
      // function stay literally parity-testable against resolveEffectiveGroupMembers.
      if (g.siteId !== null && g.siteId !== device.siteId) {
        groups.set(g.id, { siteId: g.siteId, memberIds: new Set() });
        continue;
      }
      try {
        const included = await groupIncludesDevice(g, { id: device.id, siteId: device.siteId });
        groups.set(g.id, { siteId: g.siteId, memberIds: included ? new Set([device.id]) : new Set() });
      } catch (err) {
        // A group we cannot evaluate is an ERROR, never an empty list (#3205 W02
        // decision 3): reporting "not billed" for an unevaluable group is the
        // silent zero this feature exists to prevent.
        if (err instanceof GroupEvaluationError) {
          throw new DeviceCoverageError(
            `Device group "${g.name}" could not be evaluated (${err.reason})`,
            500, 'GROUP_EVALUATION_FAILED',
            { groupId: g.id, groupName: g.name, reason: err.reason },
          );
        }
        throw err;
      }
    }
  }

  const snapshot: OrgDeviceSnapshot = { devices: [row], groups };
  const out: DeviceCoverageLine[] = [];
  for (const r of rows) {
    const l = r.line;
    // A null device_group_id, or a group id the org-predicated read did not
    // return, cannot match — the same answer uncoveredByRole gives on the
    // contract page. The contract page already flags the orphaned line.
    if (l.lineType === 'per_device_group' && (l.deviceGroupId === null || !groups.has(l.deviceGroupId))) continue;

    const coverageLine: CoverageLine = {
      lineType: l.lineType,
      siteId: l.siteId,
      deviceRoles: l.deviceRoles,
      deviceGroupId: l.deviceGroupId,
    };
    const why = coverageMatch(coverageLine, row, snapshot);
    if (why === null) continue;

    out.push({
      contractId: r.contractId,
      contractName: r.contractName,
      contractStatus: r.contractStatus,
      lineId: l.id,
      lineType: l.lineType as DeviceCountedLineType,
      description: l.description,
      matchedBy: why,
      siteId: l.siteId,
      deviceRoles: l.lineType === 'per_device_role' ? l.deviceRoles : null,
      // The stamped device_group_name, not a fourth query: it is what W02
      // designed the stamp for, and a resolvable line's group exists by
      // definition, so the only drift is a rename after line creation.
      deviceGroup: l.lineType === 'per_device_group' && l.deviceGroupId
        ? { id: l.deviceGroupId, name: l.deviceGroupName ?? '' }
        : null,
    });
  }

  return { ...base, notBillable: false, notBillableReason: null, lines: out, uncovered: out.length === 0 };
}
```

- [ ] **Step 5: Run both to verify they pass**

Run:
```bash
cd apps/api && npx vitest run src/services/deviceCoverage.test.ts
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test \
  npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceCoverage.integration.test.ts
```
Expected: both PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/deviceCoverage.ts apps/api/src/services/deviceCoverage.test.ts apps/api/src/__tests__/integration/deviceCoverage.integration.test.ts
git commit -m "feat(billing): contractLinesCoveringDevice — live per-device contract coverage over a one-device snapshot (#3205 W06)"
```

---

### Task 4: Route — `GET /devices/:id/billing`

**Files:**
- Create: `apps/api/src/routes/devices/billing.ts`
- Create: `apps/api/src/routes/devices/billing.test.ts`
- Modify: `apps/api/src/routes/devices/index.ts` — import beside `warrantyRoutes` (`:21`), mount in the sub-resource block after `warrantyRoutes` (`:114`)
- Modify: `apps/api/src/routes/devices/index.test.ts` — a second mount-order assertion

**Interfaces:**
- Consumes: `contractLinesCoveringDevice`, `DeviceCoverageError`; `getDeviceWithOrgAndSiteCheck` + `SITE_ACCESS_DENIED` (`./helpers`); `authMiddleware`, `requireScope`, `requirePermission` (`../../middleware/auth`); `PERMISSIONS` (`../../services/permissions`).
- Produces: `export const billingRoutes: Hono` serving `GET /:id/billing` → `200 { data: DeviceBillingCoverage }`, `403 { error: 'Access to this site denied' }`, `404 { error: 'Device not found', code: 'DEVICE_NOT_FOUND' }`, `500 { error, code: 'GROUP_EVALUATION_FAILED', details: { groupId, groupName, reason } }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/devices/billing.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { requirePermissionMock, requireScopeMock, coveringMock, siteDenied } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(() => async (_c: any, next: any) => next()),
  requireScopeMock: vi.fn(() => async (_c: any, next: any) => next()),
  coveringMock: vi.fn(),
  siteDenied: Symbol('SITE_ACCESS_DENIED'),
}));

vi.mock('../../db', () => ({ db: { select: vi.fn() } }));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123' }, scope: 'partner', orgId: null,
      accessibleOrgIds: ['org-123'], canAccessOrg: (orgId: string) => orgId === 'org-123',
    });
    return next();
  }),
  requireScope: requireScopeMock,
  requirePermission: requirePermissionMock,
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: siteDenied,
}));

vi.mock('../../services/deviceCoverage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/deviceCoverage')>();
  return { ...actual, contractLinesCoveringDevice: coveringMock };
});

import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { DeviceCoverageError } from '../../services/deviceCoverage';
import { billingRoutes } from './billing';

const registeredPermissionCalls = [...requirePermissionMock.mock.calls];
const registeredScopeCalls = [...requireScopeMock.mock.calls];

const DEVICE = { id: 'device-1', orgId: 'org-123', siteId: 'site-1' };
const PAYLOAD = {
  deviceId: 'device-1', orgId: 'org-123', deviceRole: 'server', siteId: 'site-1',
  notBillable: false, notBillableReason: null, uncovered: false,
  lines: [{
    contractId: 'c1', contractName: 'Acme MSA', contractStatus: 'active', lineId: 'l1',
    lineType: 'per_device_role', description: 'Managed servers', matchedBy: 'role',
    siteId: null, deviceRoles: ['server'], deviceGroup: null,
  }],
};

describe('GET /devices/:id/billing (#3205 W06)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.onError((err, c) => c.json({ unhandled: err.message }, 500));
    app.route('/devices', billingRoutes);
  });

  it('gates on devices:read AND contracts:read — a devices:read-only caller cannot reach it', () => {
    expect(registeredPermissionCalls).toContainEqual(['devices', 'read']);
    expect(registeredPermissionCalls).toContainEqual(['contracts', 'read']);
  });

  it('registers partner+system scopes only — an organization token is refused', () => {
    expect(registeredScopeCalls).toContainEqual(['partner', 'system']);
    expect(registeredScopeCalls.flat()).not.toContain('organization');
  });

  it('site-denied → 403 and no coverage work', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);
    const res = await app.request('/devices/device-1/billing', { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Access to this site denied' });
    expect(coveringMock).not.toHaveBeenCalled();
  });

  it('the chokepoint 404 and the service 404 share ONE body shape', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null);
    const fromChokepoint = await app.request('/devices/device-1/billing', { headers: { Authorization: 'Bearer t' } });
    expect(fromChokepoint.status).toBe(404);
    expect(await fromChokepoint.json()).toEqual({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });

    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(DEVICE as never);
    coveringMock.mockRejectedValueOnce(new DeviceCoverageError('Device not found', 404, 'DEVICE_NOT_FOUND'));
    const fromService = await app.request('/devices/device-1/billing', { headers: { Authorization: 'Bearer t' } });
    expect(fromService.status).toBe(404);
    expect(await fromService.json()).toEqual({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
  });

  it('happy path returns the { data } envelope and passes accessibleOrgIds through', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(DEVICE as never);
    coveringMock.mockResolvedValueOnce(PAYLOAD);
    const res = await app.request('/devices/device-1/billing', { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: PAYLOAD });
    expect(coveringMock).toHaveBeenCalledWith('device-1', { accessibleOrgIds: ['org-123'] });
  });

  it('GROUP_EVALUATION_FAILED → 500 with code + details, and NO lines key', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(DEVICE as never);
    coveringMock.mockRejectedValueOnce(new DeviceCoverageError(
      'Device group "VIP Laptops" could not be evaluated (invalid_filter)', 500, 'GROUP_EVALUATION_FAILED',
      { groupId: 'g1', groupName: 'VIP Laptops', reason: 'invalid_filter' },
    ));
    const res = await app.request('/devices/device-1/billing', { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: 'Device group "VIP Laptops" could not be evaluated (invalid_filter)',
      code: 'GROUP_EVALUATION_FAILED',
      details: { groupId: 'g1', groupName: 'VIP Laptops', reason: 'invalid_filter' },
    });
    expect(body).not.toHaveProperty('lines');
  });

  it('an unrecognised throw propagates instead of being swallowed into a 200', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(DEVICE as never);
    coveringMock.mockRejectedValueOnce(new Error('kaboom'));
    const res = await app.request('/devices/device-1/billing', { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ unhandled: 'kaboom' });
  });
});
```

Append to `apps/api/src/routes/devices/index.test.ts`, inside the existing `describe('device router mount order', …)`:

```ts
  it('mounts the billing sub-resource after core parameter routes (#3205 W06)', () => {
    const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    expect(source).toContain("import { billingRoutes } from './billing'");
    const billingMount = source.indexOf("deviceRoutes.route('/', billingRoutes)");
    const coreMount = source.indexOf("deviceRoutes.route('/', coreRoutes)");
    expect(billingMount).toBeGreaterThan(-1);
    expect(billingMount).toBeGreaterThan(coreMount);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/devices/billing.test.ts src/routes/devices/index.test.ts`
Expected: FAIL — `Cannot find module './billing'`, and the mount-order case fails on the missing import string.

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/devices/billing.ts`:

```ts
import { Hono } from 'hono';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { PERMISSIONS } from '../../services/permissions';
import { contractLinesCoveringDevice, DeviceCoverageError } from '../../services/deviceCoverage';

export const billingRoutes = new Hono();

billingRoutes.use('*', authMiddleware);

// GET /devices/:id/billing — which active contract lines bill this device (#3205 W06).
// Gated on devices:read AND contracts:read: contract_lines.description is
// operator-authored free text that routinely carries the rate, so this is
// billing data wearing a device URL. requireScope matches every contracts read
// route (routes/contracts/contracts.ts:16) — organization-scoped users cannot
// read contract data anywhere today, and this route is not the exception.
// API keys are excluded by construction: API_KEY_SCOPE_POLICIES
// (services/apiKeyScopes.ts:3-34) has no contracts:read scope to grant.
billingRoutes.get(
  '/:id/billing',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  requirePermission(PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    // The ONLY site-axis gate (the allowlist lives in the permissions context,
    // not in accessibleOrgIds). The service re-checks the org for non-route callers.
    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      // One 404 body shape for BOTH sources (here and the service's own org
      // check). Sibling device routes return a bare { error }; a client that
      // must branch on `code` for the 500 should not also branch on shape here.
      return c.json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' }, 404);
    }

    try {
      const data = await contractLinesCoveringDevice(deviceId, { accessibleOrgIds: auth.accessibleOrgIds });
      return c.json({ data });
    } catch (err) {
      // A group we cannot evaluate is an ERROR, never an empty list (#3205 W02
      // decision 3): reporting "not billed" for an unevaluable group is the
      // silent zero this feature exists to prevent. No error path returns `lines`.
      if (err instanceof DeviceCoverageError) {
        return c.json(
          { error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) },
          err.status,
        );
      }
      throw err;
    }
  },
);
```

In `apps/api/src/routes/devices/index.ts`, add beside the `warrantyRoutes` import (`:21`):

```ts
import { billingRoutes } from './billing';
```

and in the sub-resource block, immediately after `deviceRoutes.route('/', warrantyRoutes);` (`:114`):

```ts
// #3205 W06: GET /:id/billing. :id-prefixed, so it cannot be shadowed by core's
// /:id matcher — mounted here with the other sub-resources, and pinned by
// index.test.ts so a later static sibling cannot silently reorder it.
deviceRoutes.route('/', billingRoutes);
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/devices/billing.test.ts src/routes/devices/index.test.ts && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/devices/billing.ts apps/api/src/routes/devices/billing.test.ts apps/api/src/routes/devices/index.ts apps/api/src/routes/devices/index.test.ts
git commit -m "feat(api): GET /devices/:id/billing behind devices:read + contracts:read (#3205 W06)"
```

---

### Task 5: Web — coverage-notice deep links, the `orgId` hash key, isomorphic encoder

**Files:**
- Create: `apps/web/src/lib/api/devices.ts`
- Create: `apps/web/src/components/devices/orgHash.ts`, `apps/web/src/components/devices/orgHash.test.ts`
- Modify: `apps/web/src/components/devices/filterUrl.ts:7-13` (+ `filterUrl.test.ts`)
- Create: `apps/web/src/components/contracts/deviceCoverageLinks.ts`, `deviceCoverageLinks.test.ts`
- Modify: `apps/web/src/components/contracts/DeviceCoverageNotice.tsx` (+ `DeviceCoverageNotice.test.tsx`)
- Modify: `apps/web/src/components/contracts/ContractDetail.tsx:335`, `apps/web/src/components/contracts/ContractEditor.tsx:1186`
- Modify: `apps/web/src/components/devices/DevicesPage.tsx` (import block `:20`, hook call above `:214`)
- Create: `apps/web/src/components/devices/DevicesPage.deepLink.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json` and `.../common.json`

**Interfaces:**
- Produces:

```ts
// lib/api/devices.ts
export interface DeviceCoverageLine { contractId: string; contractName: string; contractStatus: ContractStatus; lineId: string; lineType: 'per_device' | 'per_device_role' | 'per_device_group'; description: string; matchedBy: 'org' | 'site' | 'role' | 'group'; siteId: string | null; deviceRoles: string[] | null; deviceGroup: { id: string; name: string } | null }
export interface DeviceBillingCoverage { deviceId: string; orgId: string; deviceRole: string; siteId: string | null; notBillable: boolean; notBillableReason: 'decommissioned' | 'ephemeral' | 'not_billable' | null; lines: DeviceCoverageLine[]; uncovered: boolean }
export function getDeviceBilling(deviceId: string): Promise<Response>
// components/devices/orgHash.ts
export function readOrgIdFromHash(hash: string): string | null
export function useOrgIdFromHash(): void
// components/contracts/deviceCoverageLinks.ts
export function devicesUrlForRole(role: string, orgId: string | null): string | null
// DeviceCoverageNotice.tsx
export default function DeviceCoverageNotice(props: { uncovered: UncoveredDevices | null | undefined; orgId: string | null }): JSX.Element | null
export function formatUncoveredBreakdown(byRole: Record<string, number>): string   // unchanged, toast path only
```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/devices/orgHash.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readOrgIdFromHash } from './orgHash';

const ORG = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('readOrgIdFromHash (#3205 W06)', () => {
  it('reads the uuid from either fragment order and tolerates a leading #', () => {
    expect(readOrgIdFromHash(`#orgId=${ORG}&filtersV2=abc`)).toBe(ORG);
    expect(readOrgIdFromHash(`filtersV2=abc&orgId=${ORG}`)).toBe(ORG);
    expect(readOrgIdFromHash(`#deviceClass=agent&orgId=${ORG}&filtersV2=abc`)).toBe(ORG);
  });
  it('ignores a missing key, an empty value and anything that is not a uuid', () => {
    expect(readOrgIdFromHash('')).toBeNull();
    expect(readOrgIdFromHash('#filtersV2=abc')).toBeNull();
    expect(readOrgIdFromHash('#orgId=')).toBeNull();
    expect(readOrgIdFromHash('#orgId=not-a-uuid')).toBeNull();
    expect(readOrgIdFromHash("#orgId='; DROP TABLE devices;--")).toBeNull();
  });
});
```

Create `apps/web/src/components/contracts/deviceCoverageLinks.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { devicesUrlForRole } from './deviceCoverageLinks';
import { decodeFilterFromHash } from '../devices/filterUrl';
import { readOrgIdFromHash } from '../devices/orgHash';
import { DEVICE_ROLES } from '@/lib/deviceRoles';

const ORG = '0f8fad5b-d9cb-469f-a165-70867728950e';

afterEach(() => { vi.unstubAllGlobals(); });

describe('devicesUrlForRole (#3205 W06)', () => {
  it('round-trips EVERY device role through the devices list own decoder', () => {
    for (const role of DEVICE_ROLES) {
      const url = devicesUrlForRole(role, ORG)!;
      expect(url.startsWith(`/devices#orgId=${ORG}&filtersV2=`)).toBe(true);
      const hash = url.slice(url.indexOf('#'));
      expect(decodeFilterFromHash(hash)).toEqual({
        operator: 'AND',
        conditions: [{ field: 'deviceRole', operator: 'equals', value: role }],
      });
      expect(readOrgIdFromHash(hash)).toBe(ORG);
    }
  });

  it("includes 'unknown', the bucket the notice most often shows", () => {
    const hash = devicesUrlForRole('unknown', ORG)!.slice(devicesUrlForRole('unknown', ORG)!.indexOf('#'));
    expect(decodeFilterFromHash(hash)!.conditions[0]).toMatchObject({ field: 'deviceRole', value: 'unknown' });
  });

  it('without an org there is no orgId fragment, and the filter half still decodes', () => {
    const url = devicesUrlForRole('server', null)!;
    expect(url).toBe('/devices#filtersV2=' + url.split('filtersV2=')[1]);
    expect(url).not.toContain('orgId=');
    expect(decodeFilterFromHash(url.slice(url.indexOf('#')))).toMatchObject({ operator: 'AND' });
  });

  it('a role the filter engine does not know returns null, never a dead link', () => {
    expect(devicesUrlForRole('toaster', ORG)).toBeNull();
    expect(devicesUrlForRole('', ORG)).toBeNull();
  });

  it('produces byte-identical output with no window (the isomorphic-encoder guarantee)', () => {
    const withWindow = devicesUrlForRole('server', ORG);
    vi.stubGlobal('window', undefined);
    expect(devicesUrlForRole('server', ORG)).toBe(withWindow);
  });
});
```

Append to `apps/web/src/components/devices/filterUrl.test.ts`:

```ts
describe('toBase64Url is isomorphic (#3205 W06)', () => {
  it('encodes identically with and without window, for ASCII and non-ASCII', () => {
    const nonAscii: FilterConditionGroup = {
      operator: 'AND',
      conditions: [{ field: 'tags', operator: 'contains', value: 'café — 東京' }],
    };
    const before = [encodeFilterToHash(sampleFilter), encodeFilterToHash(nonAscii)];
    vi.stubGlobal('window', undefined);
    try {
      expect([encodeFilterToHash(sampleFilter), encodeFilterToHash(nonAscii)]).toEqual(before);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(before[0]).not.toBe('');
    // Unpadded base64url alphabet only.
    expect(before[1]!.replace('filtersV2=', '')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('still round-trips what the new encoder produces', () => {
    const nonAscii: FilterConditionGroup = {
      operator: 'AND',
      conditions: [{ field: 'tags', operator: 'contains', value: 'café — 東京' }],
    };
    expect(decodeFilterFromHash(`#${encodeFilterToHash(nonAscii)}`)).toEqual(nonAscii);
  });
});
```

(add `vi` to that file's vitest import.)

Rewrite `apps/web/src/components/contracts/DeviceCoverageNotice.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DeviceCoverageNotice, { formatUncoveredBreakdown } from './DeviceCoverageNotice';
import { devicesUrlForRole } from './deviceCoverageLinks';

const ORG = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('DeviceCoverageNotice (#3205, links #3205 W06)', () => {
  it('renders nothing when not applicable', () => {
    const { container } = render(<DeviceCoverageNotice uncovered={null} orgId={ORG} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('confirms full coverage at zero', () => {
    render(<DeviceCoverageNotice uncovered={{ total: 0, byRole: {} }} orgId={ORG} />);
    expect(screen.getByTestId('contract-coverage-ok')).toBeInTheDocument();
  });

  it('renders one link per bucket, largest first, pointing at the devices list', () => {
    render(<DeviceCoverageNotice uncovered={{ total: 5, byRole: { printer: 2, unknown: 3 } }} orgId={ORG} />);
    const links = screen.getAllByTestId('contract-coverage-role-link') as HTMLAnchorElement[];
    expect(links.map((a) => a.textContent)).toEqual(['3 Unknown', '2 Printer']);
    expect(links[0]!.getAttribute('href')).toBe(devicesUrlForRole('unknown', ORG));
    expect(links[1]!.getAttribute('href')).toBe(devicesUrlForRole('printer', ORG));
    expect(screen.getByTestId('contract-coverage-warning').textContent).toContain('5');
  });

  it('without an org the links still work, without the orgId fragment', () => {
    render(<DeviceCoverageNotice uncovered={{ total: 3, byRole: { unknown: 3 } }} orgId={null} />);
    const link = screen.getByTestId('contract-coverage-role-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(devicesUrlForRole('unknown', null));
    expect(link.getAttribute('href')).not.toContain('orgId=');
  });

  it('a rogue role renders as plain text; the other buckets stay links', () => {
    render(<DeviceCoverageNotice uncovered={{ total: 4, byRole: { toaster: 3, server: 1 } }} orgId={ORG} />);
    expect(screen.getAllByTestId('contract-coverage-role-link')).toHaveLength(1);
    expect(screen.getByTestId('contract-coverage-warning').textContent).toContain('3 toaster');
  });

  it('composes lead + buckets structurally — formatUncoveredBreakdown is NOT called by the component', () => {
    const spy = vi.spyOn({ formatUncoveredBreakdown }, 'formatUncoveredBreakdown');
    render(<DeviceCoverageNotice uncovered={{ total: 2, byRole: { server: 2 } }} orgId={ORG} />);
    const text = screen.getByTestId('contract-coverage-warning').textContent!;
    expect(text).toContain('2');
    expect(text).toContain('2 Server');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('formatUncoveredBreakdown still returns the joined string for the generate toast', () => {
    expect(formatUncoveredBreakdown({ access_point: 1, server: 4 })).toBe('4 Server, 1 Access Point');
  });
});
```

Create `apps/web/src/components/devices/DevicesPage.deepLink.test.tsx`. **Copy the entire mock block from `DevicesPage.orgScope.test.tsx:1-60` (org store, event stream, navigation, toast, presentational children) with two deliberate omissions: do NOT mock `./filterUrl`, and do NOT mock `../../hooks/useAdvancedFilterIds`** — this file exists precisely because both existing suites stub the decoder, so nothing proves real hash adoption today. Then:

```tsx
const ORG_FROM_HASH = '0f8fad5b-d9cb-469f-a165-70867728950e';
const FILTER = { operator: 'AND' as const, conditions: [{ field: 'deviceRole', operator: 'equals', value: 'unknown' }] };

// Ordering probe: every selectOrganization call and every /filters/preview
// request is appended here, so the assertion is about ORDER, not just calls.
const events: string[] = [];

describe('DevicesPage deep link (#3205 W06)', () => {
  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
    orgStoreState.currentOrgId = 'a-different-org';
    orgStoreState.selectOrganization = vi.fn((id: string) => {
      events.push(`selectOrganization:${id}`);
      orgStoreState.currentOrgId = id;
    });
    vi.mocked(fetchWithAuth).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/filters/preview')) {
        events.push(`preview:${String(init?.body)}`);
        return { ok: true, json: async () => ({ data: { deviceIds: [] } }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ data: [] }) } as unknown as Response;
    });
    // The real encoder builds the hash, so this test cannot drift from the producer.
    window.location.hash = `#orgId=${ORG_FROM_HASH}&${encodeFilterToHash(FILTER)}`;
  });

  afterEach(() => { window.location.hash = ''; });

  it('adopts the org from the hash BEFORE the filter preview fires', async () => {
    render(<DevicesPage />);
    await waitFor(() => expect(events.some((e) => e.startsWith('preview:'))).toBe(true));
    const orgAt = events.findIndex((e) => e === `selectOrganization:${ORG_FROM_HASH}`);
    const previewAt = events.findIndex((e) => e.startsWith('preview:'));
    expect(orgAt).toBeGreaterThanOrEqual(0);
    expect(orgAt).toBeLessThan(previewAt);   // layout effect before passive effect
  });

  it('posts the decoded filter to /filters/preview', async () => {
    render(<DevicesPage />);
    await waitFor(() => expect(events.some((e) => e.startsWith('preview:'))).toBe(true));
    const body = JSON.parse(events.find((e) => e.startsWith('preview:'))!.slice('preview:'.length));
    expect(body.conditions).toEqual(FILTER);
    expect(body.idsOnly).toBe(true);
  });

  it('the hash mirror preserves the orgId fragment', async () => {
    render(<DevicesPage />);
    await waitFor(() => expect(window.location.hash).toContain('filtersV2='));
    expect(window.location.hash).toContain(`orgId=${ORG_FROM_HASH}`);
  });

  it('a hash with no orgId leaves the current org alone', async () => {
    window.location.hash = `#${encodeFilterToHash(FILTER)}`;
    render(<DevicesPage />);
    await waitFor(() => expect(events.some((e) => e.startsWith('preview:'))).toBe(true));
    expect(events.some((e) => e.startsWith('selectOrganization:'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run:
```bash
cd apps/web && npx vitest run src/components/devices/orgHash.test.ts src/components/contracts/deviceCoverageLinks.test.ts src/components/devices/filterUrl.test.ts src/components/contracts/DeviceCoverageNotice.test.tsx src/components/devices/DevicesPage.deepLink.test.tsx
```
Expected: FAIL — `orgHash`/`deviceCoverageLinks` modules do not exist; the notice has no `orgId` prop; `encodeFilterToHash` differs with `window` stubbed away; `selectOrganization` is never called.

- [ ] **Step 3: Isomorphic `toBase64Url`**

Replace `apps/web/src/components/devices/filterUrl.ts:7-13` with:

```ts
// Pure, isomorphic base64url. The old body returned '' when `window` was
// undefined, so any link built from encodeFilterToHash during SSR was silently
// `/devices#` (#3205 W06). Byte-identical to the old btoa path for every input:
// unescape(encodeURIComponent(s)) IS the UTF-8 byte sequence TextEncoder emits.
const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    out += B64URL_ALPHABET[a >> 2]! + B64URL_ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += B64URL_ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += B64URL_ALPHABET[c & 63]!;
  }
  return out;   // base64url, unpadded — as before
}
```

`fromBase64Url` is untouched: decoding only ever runs client-side and already guards.

- [ ] **Step 4: `orgHash.ts`**

Create `apps/web/src/components/devices/orgHash.ts`:

```ts
// The org a coverage-notice deep link pins the devices list to (#3205 W06).
// Hash state (never query params) per CLAUDE.md, and a distinct `orgId=` key
// that cooperates with filterUrl.ts and deviceClassFilter.ts — each writer
// preserves the other's fragments.
//
// READ-ONLY on purpose: the org SELECTOR owns the store, so this page never
// writes the fragment back. A mirror writer would fight the selector for
// ownership of the same key.
import { useEffect, useLayoutEffect } from 'react';
import { useOrgStore } from '../../stores/orgStore';

const HASH_KEY = 'orgId';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readOrgIdFromHash(hash: string): string | null {
  if (!hash) return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of raw.split('&')) {
    const [k, v] = part.split('=');
    if (k === HASH_KEY && v && UUID_RE.test(v)) return v;
  }
  return null;
}

// useLayoutEffect warns during SSR (it is a no-op there); useEffect is the
// server-safe stand-in — the useHashState.ts (#2421) convention.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Adopt `#orgId=<uuid>` into the org store. A LAYOUT effect, and that is
 * load-bearing: React runs every layout effect in a commit before any passive
 * effect, and useAdvancedFilterIds' preview fetch is a passive effect keyed on
 * the FILTER alone (useAdvancedFilterIds.ts:40) — it never re-runs when the org
 * changes, so a preview that fired first would be computed against the wrong org
 * and never corrected. Pinned by DevicesPage.deepLink.test.tsx.
 *
 * Safety: the hash cannot widen access. /filters/preview validates the pinned
 * org with ensureOrgAccess and 403s otherwise (routes/filters.ts:142-148), the
 * list is org-scoped by the same auth, and an org the user cannot see is reset
 * by the store's next fetchOrganizations (orgStore.ts:259-261). The uuid shape
 * is validated before the store is touched.
 */
export function useOrgIdFromHash(): void {
  useIsomorphicLayoutEffect(() => {
    const apply = () => {
      const id = readOrgIdFromHash(window.location.hash);
      if (!id) return;
      const { currentOrgId, selectOrganization } = useOrgStore.getState();
      if (id !== currentOrgId) selectOrganization(id);
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);
}
```

- [ ] **Step 5: `deviceCoverageLinks.ts`**

Create `apps/web/src/components/contracts/deviceCoverageLinks.ts`:

```ts
// The one producer of coverage-notice deep links (#3205 W06). Built from the
// devices list's OWN hash format so producer and consumer cannot drift:
// `#orgId=…` (orgHash.ts) + `#filtersV2=…` (filterUrl.ts, DevicesPage.tsx:195).
import { encodeFilterToHash } from '../devices/filterUrl';
import { DEVICE_ROLES } from '@/lib/deviceRoles';

/** The devices list filtered to one device role, in one org. Returns null for a
 *  role the filter engine does not know, so an unexpected device_role value
 *  renders as plain text rather than a link that matches nothing. */
export function devicesUrlForRole(role: string, orgId: string | null): string | null {
  if (!(DEVICE_ROLES as readonly string[]).includes(role)) return null;
  const encoded = encodeFilterToHash({
    operator: 'AND',
    conditions: [{ field: 'deviceRole', operator: 'equals', value: role }],
  });
  if (!encoded) return null;
  return orgId ? `/devices#orgId=${orgId}&${encoded}` : `/devices#${encoded}`;
}
```

- [ ] **Step 6: `DeviceCoverageNotice.tsx`**

Replace the component (keeping `formatUncoveredBreakdown` byte-for-byte, because `ContractDetail.tsx:196` needs a plain string for its toast):

```tsx
import { useTranslation } from 'react-i18next';
import { getDeviceRoleLabel } from '@/lib/deviceRoles';
import { devicesUrlForRole } from './deviceCoverageLinks';
import type { UncoveredDevices } from '../../lib/api/contracts';

/** "3 Unknown, 2 Printer" — largest bucket first. Still a plain string, for the
 *  post-generate toast (ContractDetail.tsx:196). The component below renders the
 *  same buckets STRUCTURALLY instead of interpolating this, so each bucket can
 *  carry its own link and stay a translated unit. */
export function formatUncoveredBreakdown(byRole: Record<string, number>): string {
  return Object.entries(byRole)
    .sort(([, a], [, b]) => b - a)
    .map(([role, n]) => `${n} ${getDeviceRoleLabel(role)}`)
    .join(', ');
}

/**
 * #3205: devices on the org that no device-counted line on the contract bills.
 * null/undefined = not applicable (no device-counted line) → render nothing;
 * 0 = every device is covered; >0 = warn with a linked per-role breakdown.
 *
 * i18n is STRUCTURAL, not concatenated (#3205 W06): the breakdown is a
 * variable-length list, which <Trans>'s fixed component placeholders model
 * badly, and gluing translated fragments is the EnrollmentKeyManager.tsx:507
 * trap. Lead sentence and each bucket are separate keys; buckets are joined by
 * a RENDERED common:lists.separator, never Array.join over translated strings.
 */
export default function DeviceCoverageNotice({
  uncovered,
  orgId,
}: {
  uncovered: UncoveredDevices | null | undefined;
  orgId: string | null;
}) {
  const { t } = useTranslation('billing');
  if (!uncovered) return null;
  if (uncovered.total === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground" data-testid="contract-coverage-ok">
        {t('contracts.shared.coverage.allCovered')}
      </p>
    );
  }
  const buckets = Object.entries(uncovered.byRole).sort(([, a], [, b]) => b - a);
  const separator = t('common:lists.separator');
  return (
    <p
      className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
      data-testid="contract-coverage-warning"
    >
      {t('contracts.shared.coverage.uncoveredLead', { count: uncovered.total })}{' '}
      {buckets.map(([role, n], i) => {
        const label = t('contracts.shared.coverage.roleBucket', { count: n, role: getDeviceRoleLabel(role) });
        const href = devicesUrlForRole(role, orgId);
        return (
          <span key={role}>
            {i > 0 ? separator : ''}
            {href ? (
              <a href={href} className="underline underline-offset-2 hover:no-underline" data-testid="contract-coverage-role-link">
                {label}
              </a>
            ) : (
              <span>{label}</span>
            )}
          </span>
        );
      })}
    </p>
  );
}
```

Call sites: `ContractDetail.tsx:335` → `<DeviceCoverageNotice uncovered={estimate?.uncoveredDevices} orgId={contract.orgId} />`; `ContractEditor.tsx:1186` → `<DeviceCoverageNotice uncovered={liveEstimate?.uncoveredDevices} orgId={orgId || null} />`.

- [ ] **Step 7: `DevicesPage.tsx`**

Add to the import block beside the `filterUrl` import (`:20`):

```ts
import { useOrgIdFromHash } from './orgHash';
```

and immediately **above** the `useAdvancedFilterIds` call (`:214`):

```ts
  // #3205 W06: a coverage-notice deep link pins the org in the hash. Adoption is a
  // LAYOUT effect, and its position above useAdvancedFilterIds is load-bearing:
  // React runs every layout effect in a commit before any passive effect, and the
  // filter preview (useAdvancedFilterIds.ts:40) is a passive effect keyed on the
  // FILTER alone — it never re-runs when the org changes, so a preview that fired
  // first would be computed against the wrong org and never corrected.
  // Pinned by DevicesPage.deepLink.test.tsx.
  useOrgIdFromHash();
```

- [ ] **Step 8: `lib/api/devices.ts`**

Create `apps/web/src/lib/api/devices.ts`:

```ts
// Typed fetch wrappers for device-scoped reads that are not part of the device
// list/detail core. Same convention as contracts.ts:1-13 — no generic api
// client; each wrapper calls fetchWithAuth (which auto-injects the active
// orgId) and returns the raw Response so callers keep 401 handling.
import { fetchWithAuth } from '../../stores/auth';
import type { ContractStatus } from './contracts';

export type DeviceCoverageMatchReason = 'org' | 'site' | 'role' | 'group';
export type DeviceCountedLineType = 'per_device' | 'per_device_role' | 'per_device_group';

/** One active contract line that bills this device (#3205 W06). Carries no money. */
export interface DeviceCoverageLine {
  contractId: string;
  contractName: string;
  contractStatus: ContractStatus;
  lineId: string;
  lineType: DeviceCountedLineType;
  description: string;
  matchedBy: DeviceCoverageMatchReason;
  siteId: string | null;
  deviceRoles: string[] | null;
  deviceGroup: { id: string; name: string } | null;
}

export interface DeviceBillingCoverage {
  deviceId: string;
  orgId: string;
  deviceRole: string;
  siteId: string | null;
  notBillable: boolean;
  notBillableReason: 'decommissioned' | 'ephemeral' | 'not_billable' | null;
  lines: DeviceCoverageLine[];
  /** Derived server-side: !notBillable && lines.length === 0. */
  uncovered: boolean;
}

/** GET /devices/:id/billing — requires devices:read AND contracts:read, partner scope. */
export function getDeviceBilling(deviceId: string): Promise<Response> {
  return fetchWithAuth(`/devices/${deviceId}/billing`);
}
```

- [ ] **Step 9: i18n — two billing keys and one common key in all eight locales**

`billing.json`, under `contracts.shared.coverage` (leave `uncovered` and `allCovered` exactly as they are — `uncovered` is still the toast's string):

| locale | `uncoveredLead` | `roleBucket` |
|---|---|---|
| en | `{{count}} device(s) on this organization are not billed by any line on this contract:` | `{{count}} {{role}}` |
| de-DE | `{{count}} Gerät(e) dieser Organisation werden von keiner Position dieses Vertrags abgerechnet:` | `{{count}} {{role}}` |
| es-419 | `{{count}} dispositivo(s) de esta organización no se facturan en ninguna línea de este contrato:` | `{{count}} {{role}}` |
| fr-CA | `{{count}} appareil(s) de cette organisation ne sont facturés par aucune ligne de ce contrat :` | `{{count}} {{role}}` |
| fr-FR | `{{count}} appareil(s) de cette organisation ne sont facturés par aucune ligne de ce contrat :` | `{{count}} {{role}}` |
| it-IT | `{{count}} dispositivo/i di questa organizzazione non sono fatturati da alcuna riga di questo contratto:` | `{{count}} {{role}}` |
| pt-BR | `{{count}} dispositivo(s) desta organização não são cobrados por nenhuma linha deste contrato:` | `{{count}} {{role}}` |
| tr-TR | `Bu kuruluştaki {{count}} cihaz bu sözleşmedeki hiçbir satırda faturalandırılmıyor:` | `{{count}} {{role}}` |

(The `(s)` form mirrors the existing `uncovered` key rather than introducing i18next plural suffixes, which nothing else in this namespace uses.)

`common.json` gains a new top-level `lists` object in all eight locales:

```json
  "lists": { "separator": ", " },
```

- [ ] **Step 10: Run**

Run:
```bash
cd apps/web && npx vitest run src/components/devices/orgHash.test.ts src/components/contracts/deviceCoverageLinks.test.ts src/components/devices/filterUrl.test.ts src/components/contracts/DeviceCoverageNotice.test.tsx src/components/devices/DevicesPage src/components/contracts/ContractDetail src/components/contracts/ContractEditor src/lib/i18n
npx tsc --noEmit -p tsconfig.json 2>&1 | head
```
Expected: PASS, including `localeParity.test.ts` and both pre-existing `DevicesPage` suites; tsc clean.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/lib/api/devices.ts apps/web/src/components/devices/orgHash.ts apps/web/src/components/devices/orgHash.test.ts apps/web/src/components/devices/filterUrl.ts apps/web/src/components/devices/filterUrl.test.ts apps/web/src/components/devices/DevicesPage.tsx apps/web/src/components/devices/DevicesPage.deepLink.test.tsx apps/web/src/components/contracts/deviceCoverageLinks.ts apps/web/src/components/contracts/deviceCoverageLinks.test.ts apps/web/src/components/contracts/DeviceCoverageNotice.tsx apps/web/src/components/contracts/DeviceCoverageNotice.test.tsx apps/web/src/components/contracts/ContractDetail.tsx apps/web/src/components/contracts/ContractEditor.tsx apps/web/src/locales/*/billing.json apps/web/src/locales/*/common.json
git commit -m "feat(web): coverage-notice role deep links, #orgId hash adoption, isomorphic base64url (#3205 W06)"
```

---

### Task 6: Web — the device Overview "Billing" card

**Files:**
- Create: `apps/web/src/components/devices/DeviceBillingCard.tsx`
- Create: `apps/web/src/components/devices/DeviceBillingCard.test.tsx`
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx` — mount after `<DeviceWarrantyCard deviceId={device.id} compact />` (`:714`)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/devices.json`

**Interfaces:**
- Consumes: Task 5 `getDeviceBilling`, `DeviceBillingCoverage`, `DeviceCoverageLine`; `usePermissions` (`@/lib/permissions`); `getDeviceRoleLabel` (`@/lib/deviceRoles`); `loginPathWithNext` + `navigateTo` (the `DeviceWarrantyCard.tsx:10` 401 convention).
- Produces: `export default function DeviceBillingCard({ deviceId }: { deviceId: string })`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/devices/DeviceBillingCard.test.tsx`:

```tsx
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuth, navigateTo, canMock } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(), navigateTo: vi.fn(), canMock: vi.fn(() => true),
}));
vi.mock('../../stores/auth', () => ({ fetchWithAuth }));
vi.mock('@/lib/navigation', () => ({ navigateTo }));
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ permissions: [], can: canMock }) }));

import DeviceBillingCard from './DeviceBillingCard';

const DEVICE_ID = 'device-1';
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) }) as unknown as Response;
const fail = (status: number, body: unknown) => ({ ok: false, status, json: async () => body }) as unknown as Response;

const base = {
  deviceId: DEVICE_ID, orgId: 'org-1', deviceRole: 'server', siteId: 'site-1',
  notBillable: false, notBillableReason: null, uncovered: false, lines: [],
};

beforeEach(() => { vi.clearAllMocks(); canMock.mockReturnValue(true); });

describe('DeviceBillingCard (#3205 W06)', () => {
  it('renders NOTHING and fetches NOTHING without contracts:read', () => {
    canMock.mockReturnValue(false);
    const { container } = render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('shows a skeleton first, then the covered rows with matchedBy chips and contract links', async () => {
    fetchWithAuth.mockResolvedValueOnce(ok({
      ...base,
      lines: [
        { contractId: 'c1', contractName: 'Acme MSA', contractStatus: 'active', lineId: 'l1', lineType: 'per_device_role', description: 'Managed servers', matchedBy: 'role', siteId: null, deviceRoles: ['server'], deviceGroup: null },
        { contractId: 'c2', contractName: 'Beta Retainer', contractStatus: 'active', lineId: 'l2', lineType: 'per_device_group', description: 'VIP', matchedBy: 'group', siteId: null, deviceRoles: null, deviceGroup: { id: 'g1', name: 'VIP Laptops' } },
      ],
    }));
    render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    expect(screen.getByTestId('device-billing-loading')).toBeInTheDocument();
    const rows = await screen.findAllByTestId('device-billing-line');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Acme MSA');
    expect(rows[0]!.textContent).toContain('Role: Server');
    expect(rows[1]!.textContent).toContain('Group: VIP Laptops');
    expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe('/contracts/c1');
    expect(rows[1]!.querySelector('a')!.getAttribute('href')).toBe('/contracts/c2');
    expect(fetchWithAuth).toHaveBeenCalledWith(`/devices/${DEVICE_ID}/billing`);
  });

  it('org-wide and site chips are distinct', async () => {
    fetchWithAuth.mockResolvedValueOnce(ok({
      ...base,
      lines: [
        { contractId: 'c1', contractName: 'A', contractStatus: 'active', lineId: 'l1', lineType: 'per_device', description: 'All', matchedBy: 'org', siteId: null, deviceRoles: null, deviceGroup: null },
        { contractId: 'c1', contractName: 'A', contractStatus: 'active', lineId: 'l2', lineType: 'per_device', description: 'HQ', matchedBy: 'site', siteId: 'site-1', deviceRoles: null, deviceGroup: null },
      ],
    }));
    render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    const rows = await screen.findAllByTestId('device-billing-line');
    expect(rows[0]!.textContent).toContain('Org-wide');
    expect(rows[1]!.textContent).toContain('This site');
  });

  it('uncovered shows the copy, the role chip and a contracts link', async () => {
    fetchWithAuth.mockResolvedValueOnce(ok({ ...base, uncovered: true }));
    render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    const el = await screen.findByTestId('device-billing-uncovered');
    expect(el.textContent).toMatch(/no active contract line/i);
    expect(el.textContent).toContain('Server');
    expect(screen.getByTestId('device-billing-uncovered').querySelector('a')!.getAttribute('href')).toBe('/contracts');
  });

  it.each([
    ['decommissioned', /decommissioned/i],
    ['ephemeral', /ephemeral/i],
    ['not_billable', /not currently billable/i],
  ])('not billable (%s) shows its own copy and NOT the uncovered copy', async (reason, pattern) => {
    fetchWithAuth.mockResolvedValueOnce(ok({ ...base, notBillable: true, notBillableReason: reason, uncovered: false }));
    render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    expect((await screen.findByTestId('device-billing-not-billable')).textContent).toMatch(pattern);
    expect(screen.queryByTestId('device-billing-uncovered')).toBeNull();
  });

  it('a GROUP_EVALUATION_FAILED 500 names the group, offers Retry, and never says "not billed"', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(fail(500, { error: 'boom', code: 'GROUP_EVALUATION_FAILED', details: { groupId: 'g1', groupName: 'VIP Laptops', reason: 'invalid_filter' } }))
      .mockResolvedValueOnce(ok({ ...base, uncovered: true }));
    render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    const err = await screen.findByTestId('device-billing-error');
    expect(err.textContent).toContain('VIP Laptops');
    expect(screen.queryByTestId('device-billing-uncovered')).toBeNull();
    fireEvent.click(screen.getByTestId('device-billing-retry'));
    await screen.findByTestId('device-billing-uncovered');
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('a generic 500 renders the generic message', async () => {
    fetchWithAuth.mockResolvedValueOnce(fail(500, { error: 'nope' }));
    render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    expect((await screen.findByTestId('device-billing-error')).textContent).toMatch(/couldn't load/i);
  });

  it('401 redirects to login and renders no card content', async () => {
    fetchWithAuth.mockResolvedValueOnce(fail(401, {}));
    render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(screen.queryByTestId('device-billing-line')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/devices/DeviceBillingCard.test.tsx`
Expected: FAIL — `Cannot find module './DeviceBillingCard'`.

- [ ] **Step 3: Implement the card**

Create `apps/web/src/components/devices/DeviceBillingCard.tsx`:

```tsx
// #3205 W06: "who pays for this box?" as an Overview CARD, beside warranty and
// reliability — not a tab (the bar already carries 28 behind OverflowTabs, the
// panel is at most a handful of rows, and a card does not fetch while the user
// is on Software/Patches). Read-only, so no runAction; the loading/error/retry
// triad is the read convention (DeviceWarrantyCard.tsx:101-110, ContractDetail.tsx:336-341).
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Receipt } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { usePermissions } from '@/lib/permissions';
import { getDeviceRoleIcon, getDeviceRoleLabel } from '@/lib/deviceRoles';
import { getDeviceBilling, type DeviceBillingCoverage, type DeviceCoverageLine } from '../../lib/api/devices';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

type CardError = { code?: string; groupName?: string };

export default function DeviceBillingCard({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('devices');
  const { can } = usePermissions();
  // Decision 8: the gate is checked BEFORE the component fetches, so a tech
  // without billing access sees no card and issues no request — rather than a
  // request that 403s and an error state for a permission they never had.
  const allowed = can('contracts', 'read');

  const [data, setData] = useState<DeviceBillingCoverage | null>(null);
  const [error, setError] = useState<CardError | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getDeviceBilling(deviceId);
      if (res.status === 401) { UNAUTHORIZED(); return; }
      const body = await res.json().catch(() => null) as { data?: DeviceBillingCoverage; code?: string; details?: { groupName?: string } } | null;
      if (!res.ok || !body?.data) {
        setError({ code: body?.code, groupName: body?.details?.groupName });
        setData(null);
        return;
      }
      setData(body.data);
    } catch {
      setError({});
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => { if (allowed) void load(); }, [allowed, load]);

  if (!allowed) return null;

  const shell = (children: ReactNode) => (
    <div className="rounded-lg border bg-card p-4 shadow-xs">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Receipt className="h-4 w-4" />
        {t('deviceBillingCard.title')}
      </div>
      {children}
    </div>
  );

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-4 shadow-xs animate-pulse" data-testid="device-billing-loading">
        <div className="h-4 w-24 rounded bg-muted" />
        <div className="mt-3 h-6 w-48 rounded bg-muted" />
      </div>
    );
  }

  // The error branch returns BEFORE the uncovered branch, so the card can never
  // render "not billed" for a coverage failure (Decision 6, structurally).
  if (error || !data) {
    return shell(
      <p className="mt-2 text-sm text-muted-foreground" data-testid="device-billing-error">
        {error?.code === 'GROUP_EVALUATION_FAILED'
          ? t('deviceBillingCard.error.groupEvaluation', { group: error.groupName ?? '' })
          : t('deviceBillingCard.error.generic')}{' '}
        <button
          type="button"
          onClick={() => void load()}
          data-testid="device-billing-retry"
          className="font-medium text-primary hover:underline"
        >
          {t('common:actions.retry')}
        </button>
      </p>,
    );
  }

  if (data.notBillable) {
    const key = data.notBillableReason ?? 'not_billable';
    return shell(
      <p className="mt-2 text-sm text-muted-foreground" data-testid="device-billing-not-billable">
        {t(/* i18n-dynamic */ `deviceBillingCard.notBillable.${key}`)}
      </p>,
    );
  }

  if (data.uncovered) {
    const RoleIcon = getDeviceRoleIcon(data.deviceRole);
    return shell(
      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-testid="device-billing-uncovered">
        <span>{t('deviceBillingCard.uncovered')}</span>
        <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
          <RoleIcon className="h-3 w-3" />
          {getDeviceRoleLabel(data.deviceRole)}
        </span>
        <a href="/contracts" className="font-medium text-primary hover:underline">
          {t('deviceBillingCard.viewContracts')}
        </a>
      </p>,
    );
  }

  return shell(
    <ul className="mt-2 space-y-2">
      {data.lines.map((line) => (
        <li key={line.lineId} className="flex flex-wrap items-center gap-2 text-sm" data-testid="device-billing-line">
          <a href={`/contracts/${line.contractId}`} className="font-medium text-primary hover:underline">
            {line.contractName}
          </a>
          <span className="text-muted-foreground">{line.description}</span>
          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
            {matchedByLabel(t, line)}
          </span>
        </li>
      ))}
    </ul>,
  );
}

/** Overlap is legal and visible: two lines from two contracts both render. */
function matchedByLabel(t: (k: string, o?: Record<string, unknown>) => string, line: DeviceCoverageLine): string {
  switch (line.matchedBy) {
    case 'org': return t('deviceBillingCard.matchedBy.org');
    case 'site': return t('deviceBillingCard.matchedBy.site');
    case 'role': return t('deviceBillingCard.matchedBy.role', { role: (line.deviceRoles ?? []).map(getDeviceRoleLabel).join(', ') });
    case 'group': return t('deviceBillingCard.matchedBy.group', { group: line.deviceGroup?.name ?? '' });
  }
}
```

In `apps/web/src/components/devices/DeviceDetails.tsx`, import the card beside the other Overview cards and render it after `<DeviceWarrantyCard deviceId={device.id} compact />` (`:714`):

```tsx
            <DeviceBillingCard deviceId={device.id} />
```

The card gates itself on `contracts:read`, so `DeviceDetails` needs no permission logic.

- [ ] **Step 4: i18n — `deviceBillingCard` in all eight locales**

`devices.json` gains a `deviceBillingCard` object (alphabetically between `deviceAnomaliesPanel` and `deviceBootPerformanceTab`):

| key | en | de-DE | es-419 |
|---|---|---|---|
| `title` | Billing | Abrechnung | Facturación |
| `uncovered` | No active contract line bills this device. | Keine aktive Vertragsposition rechnet dieses Gerät ab. | Ninguna línea de contrato activa factura este dispositivo. |
| `viewContracts` | View contracts | Verträge anzeigen | Ver contratos |
| `notBillable.decommissioned` | Not billed — this device is decommissioned | Nicht abgerechnet — dieses Gerät ist stillgelegt | No facturado — este dispositivo está dado de baja |
| `notBillable.ephemeral` | Not billed — this device is an ephemeral support-session device | Nicht abgerechnet — dieses Gerät ist ein temporäres Support-Sitzungsgerät | No facturado — este dispositivo es de sesión de soporte efímera |
| `notBillable.not_billable` | Not billed — this device is not currently billable | Nicht abgerechnet — dieses Gerät ist derzeit nicht abrechenbar | No facturado — este dispositivo no es facturable actualmente |
| `error.generic` | Couldn't load billing coverage. | Abrechnungsabdeckung konnte nicht geladen werden. | No se pudo cargar la cobertura de facturación. |
| `error.groupEvaluation` | A device group on an active contract couldn't be evaluated ({{group}}). Coverage is unknown. | Eine Gerätegruppe eines aktiven Vertrags konnte nicht ausgewertet werden ({{group}}). Die Abdeckung ist unbekannt. | No se pudo evaluar un grupo de dispositivos de un contrato activo ({{group}}). La cobertura es desconocida. |
| `matchedBy.org` | Org-wide | Organisationsweit | Toda la organización |
| `matchedBy.site` | This site | Dieser Standort | Este sitio |
| `matchedBy.role` | Role: {{role}} | Rolle: {{role}} | Rol: {{role}} |
| `matchedBy.group` | Group: {{group}} | Gruppe: {{group}} | Grupo: {{group}} |

| key | fr-CA / fr-FR | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|
| `title` | Facturation | Fatturazione | Faturamento | Faturalama |
| `uncovered` | Aucune ligne de contrat active ne facture cet appareil. | Nessuna riga di contratto attiva fattura questo dispositivo. | Nenhuma linha de contrato ativa cobra este dispositivo. | Bu cihazı faturalandıran etkin bir sözleşme satırı yok. |
| `viewContracts` | Voir les contrats | Vedi contratti | Ver contratos | Sözleşmeleri görüntüle |
| `notBillable.decommissioned` | Non facturé — cet appareil est mis hors service | Non fatturato — questo dispositivo è dismesso | Não cobrado — este dispositivo está desativado | Faturalandırılmıyor — bu cihaz hizmet dışı bırakıldı |
| `notBillable.ephemeral` | Non facturé — cet appareil est un appareil de session de support éphémère | Non fatturato — questo dispositivo è un dispositivo di sessione di supporto effimera | Não cobrado — este dispositivo é de sessão de suporte efêmera | Faturalandırılmıyor — bu cihaz geçici bir destek oturumu cihazı |
| `notBillable.not_billable` | Non facturé — cet appareil n'est pas facturable actuellement | Non fatturato — questo dispositivo non è attualmente fatturabile | Não cobrado — este dispositivo não é cobrável no momento | Faturalandırılmıyor — bu cihaz şu anda faturalandırılabilir değil |
| `error.generic` | Impossible de charger la couverture de facturation. | Impossibile caricare la copertura di fatturazione. | Não foi possível carregar a cobertura de faturamento. | Faturalama kapsamı yüklenemedi. |
| `error.groupEvaluation` | Un groupe d'appareils d'un contrat actif n'a pas pu être évalué ({{group}}). La couverture est inconnue. | Non è stato possibile valutare un gruppo di dispositivi di un contratto attivo ({{group}}). La copertura è sconosciuta. | Não foi possível avaliar um grupo de dispositivos de um contrato ativo ({{group}}). A cobertura é desconhecida. | Etkin bir sözleşmedeki bir cihaz grubu değerlendirilemedi ({{group}}). Kapsam bilinmiyor. |
| `matchedBy.org` | Toute l'organisation | Intera organizzazione | Toda a organização | Kuruluş geneli |
| `matchedBy.site` | Ce site | Questa sede | Este site | Bu konum |
| `matchedBy.role` | Rôle : {{role}} | Ruolo: {{role}} | Função: {{role}} | Rol: {{role}} |
| `matchedBy.group` | Groupe : {{group}} | Gruppo: {{group}} | Grupo: {{group}} | Grup: {{group}} |

- [ ] **Step 5: Run**

Run:
```bash
cd apps/web && npx vitest run src/components/devices/DeviceBillingCard.test.tsx src/components/devices/DeviceDetails src/lib/i18n && npx tsc --noEmit -p tsconfig.json 2>&1 | head
```
Expected: PASS (including `localeParity.test.ts`); tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/DeviceBillingCard.tsx apps/web/src/components/devices/DeviceBillingCard.test.tsx apps/web/src/components/devices/DeviceDetails.tsx apps/web/src/locales/*/devices.json
git commit -m "feat(web): device Overview Billing card behind contracts:read (#3205 W06)"
```

---

### Task 7: Docs and release-notes draft

**Files:**
- Modify: `apps/docs/src/content/docs/features/contracts.mdx` — the paragraph after the "Contract Lines" table (the "Device roles come from…" paragraph)
- Modify: `apps/docs/src/content/docs/features/devices.mdx` — a new section after "## The Device List" / before "## VPN Presence"
- Modify: `docs/release-notes/next-release-draft.md`

- [ ] **Step 1: `contracts.mdx`**

Replace the "Device roles come from the agent's automatic classification…" paragraph with:

```md
Device roles come from the agent's automatic classification, a network discovery scan, or a manual override on the device. A device whose role is still **Unknown** is never billed by a per-device-role line, though a per-device or per-device-group line bills it like any other machine. The contract's estimate and each generated invoice report how many devices on the organization are not billed by any line, broken down by role -- and each role in that breakdown is a **link** to the devices list, already filtered to that role in that customer's organization, so you can classify them or add a line before the next period. The link carries the organization, so opening it in a new tab switches your org scope to the contract's customer.

Coverage is worked out **live** every time you look at it -- nothing is stored -- and only **active** contracts count. A device covered by a draft contract still reads "no active contract line bills this device" on its own page until the contract is activated, even though the draft contract's own estimate counts it: the two answer different questions.
```

- [ ] **Step 2: `devices.mdx`**

Insert after the "## The Device List" section (before "## VPN Presence"):

```md
## Billing Coverage

The device **Overview** tab carries a **Billing** card answering "which contract line bills this device?". It needs **Contracts read** access and a partner-scoped login, so techs without billing access do not see it at all. It shows one of four things:

- **Covered** -- one row per active contract line that bills the device, with the contract name, the line description, and *why* it matches: **Org-wide**, **This site**, **Role: Server**, or **Group: VIP Laptops**. Two contracts can both bill the same device; both rows show.
- **Not billed by any line** -- no active contract line reaches this device.
- **Not billed** -- the device is decommissioned or an ephemeral support-session machine, so it is excluded from billing entirely. Nothing is wrong.
- **Coverage unknown** -- a device group on an active contract could not be evaluated (a broken filter, for example). The card says so and offers a retry rather than reporting the device as unbilled.

Only **active** contracts count, and the answer is computed live from the same rule the billing run uses, so the card and the contract's own coverage warning can never disagree.
```

- [ ] **Step 3: `next-release-draft.md`**

Add a section (after the existing entries, above any trailing TODO block):

```md
## Device billing coverage and coverage-notice deep links (#3205 W06)

**Self-Hosting / Upgrade Notes**

- No migration, no schema change, no new env var, no feature flag.
- New route `GET /api/v1/devices/:id/billing`, gated on **partner or system**
  scope plus **both** `devices:read` and `contracts:read`. API keys cannot reach
  it: there is no `contracts:read` API-key scope.

**Behaviour worth naming so it is not read as a bug**

- The device Overview **Billing** card needs Contracts read access and a
  partner-scoped login; organization-scoped users do not see it, matching every
  other contracts screen.
- The card counts **active** contracts only, so a device covered by a *draft*
  contract still reads "no active contract line bills this device" until the
  contract is activated.
- A deep link from a contract's coverage warning carries its organization, so a
  pasted link switches the recipient's org scope to the contract's org.
```

- [ ] **Step 4: Build and commit**

Run: `cd apps/docs && pnpm build 2>&1 | tail -3`
Expected: build succeeds.

```bash
git add apps/docs/src/content/docs/features/contracts.mdx apps/docs/src/content/docs/features/devices.mdx docs/release-notes/next-release-draft.md
git commit -m "docs(billing): device coverage card and coverage-notice deep links (#3205 W06)"
```

---

### Task 8: Full verification and pull request

**Files:** none new.

- [ ] **Step 1: Full local verification on a fresh test stack**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
cd ../web && npx tsc --noEmit -p tsconfig.json
cd ../../packages/shared && npx tsc --noEmit -p tsconfig.json
cd ../.. && pnpm lint
pnpm --filter @breeze/shared test --run
pnpm --filter @breeze/api test --run
pnpm --filter @breeze/web test --run
# real DB (worktree-stack, or docker compose -f docker-compose.test.yml up -d)
cd apps/api && DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/groupMembership.parity.integration.test.ts \
  src/__tests__/integration/deviceCoverage.integration.test.ts \
  src/__tests__/integration/contractQuantities.integration.test.ts \
  src/__tests__/integration/groupMembership.resolve.integration.test.ts \
  src/__tests__/integration/contractDeviceGroups.integration.test.ts \
  src/__tests__/integration/contractDeviceRoles.integration.test.ts \
  src/__tests__/integration/contractService.integration.test.ts \
  src/__tests__/integration/dynamicGroupMembershipMaterialization.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
npx vitest run --config vitest.config.rls.ts
```
Expected: all green. `rls-coverage` and the cascade/export suites are run as a **negative** check — this wave adds no table and no column, so they must be untouched and green.

Then the manual checks from the spec: on a seeded stack, open a device billed by a role line **and** a group line and confirm both rows; decommission it and confirm the not-billable state; break a group's filter and confirm the panel errors rather than saying "not billed"; sign in as an org-scoped user and confirm no card and a 403 from the route; from a contract with uncovered devices in org A while the selector sits on org B, **copy** the "3 Unknown" link, paste it in a new tab, and confirm the list lands on org A filtered to Unknown.

- [ ] **Step 2: Tear down the test stack, push, open the PR**

```bash
git push -u origin feature/3205-device-coverage/wave-4655
gh pr create --repo LanternOps/breeze --base main --title "feat(billing): device coverage lookup and coverage-notice deep links (#3205 W06)" --body "$(cat <<'EOF'
Closes #4655
Refs #3205

Spec: `docs/superpowers/specs/billing/2026-09-03-device-coverage-lookup-design.md`
Plan: `docs/superpowers/plans/billing/2026-09-03-device-coverage-lookup.md`

## What

- `contractCoverage.ts` exports `coverageMatch(line, row, snapshot) → 'org'|'site'|'role'|'group'|null`; the private `lineMatches` becomes `coverageMatch(...) !== null`. One predicate now answers both "does this line bill this device?" and "why?", so the contract page's uncovered warning and the device page's panel cannot disagree.
- New `services/deviceCoverage.ts` answers "which active contract lines bill this device?" from a **one-device** `OrgDeviceSnapshot` — O(1) reads instead of the O(org) snapshot generation builds. `contractService.ts` is not edited; `orgSnapshot`/`DeviceCache` stay exactly where W02 put them.
- Two single-device primitives make that possible without forking anything: `billableDeviceById` (reuses `billableDeviceConds`, so a future predicate applies here automatically) and `groupIncludesDevice` (the twin of `resolveEffectiveGroupMembers`, proved equal to it by a real-DB parity test over every group × every device).
- Three states, never two: covered / uncovered / **not billable** (decommissioned, ephemeral, or a benign concurrent move). A group that cannot be evaluated is a 500 with `GROUP_EVALUATION_FAILED` and never an empty list — no error path returns `lines`.
- `GET /devices/:id/billing`, `requireScope('partner','system')` + `devices:read` **and** `contracts:read` (line descriptions carry operator pricing prose). API keys are excluded by construction — `API_KEY_SCOPE_POLICIES` has no `contracts:read` scope.
- Web: the coverage warning's role buckets are now links to `/devices#orgId=<uuid>&filtersV2=<base64url>` built by one producer module and round-trip-tested against the list's real decoder; the devices list adopts `#orgId=` in a **layout** effect declared above `useAdvancedFilterIds` (its passive preview never re-runs when the org changes); `toBase64Url` is isomorphic now, so an SSR-rendered link is no longer silently `/devices#`.
- Web: a device Overview **Billing** card, gated on `contracts:read` before it mounts or fetches, with covered / uncovered / not-billable / error-with-retry states.

## Migrations

None. No table, no column, no RLS work, no cascade-list registration, no export-policy classification (Decision 12, written down rather than inferred because the registration checklist fires on new columns too).

## Tests

`coverageMatch` truth table plus a parity assertion that `quantityFor` counts exactly the devices it calls covered; the mandatory real-DB membership parity suite (static / dynamic / null-filter / site-bound / pinned, forged-org row, pinned short-circuit, malformed filter throwing from both functions); service unit tests including the **query-count contract** (2 / 3 / 5 / 4 `db.select` calls, 0 `deviceMatchesFilter`) and the three-state invariant; service integration tests including the cross-check with `uncoveredByRole` and one-device-vs-full-org equivalence for every device in the fixture; route tests for both gates, the absent `organization` scope, one 404 body shape, and a 500 with no `lines` key; mount-order assertion; web round-trip, hash, deep-link ordering, notice and card suites; locale parity across all eight locales.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01AXFWi7tAV9LWM2UCNMPrpZ
EOF
)"
```

Stop here. Do not merge. Report the PR URL and anything that was skipped or failed.

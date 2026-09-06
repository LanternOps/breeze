# Device Coverage Lookup and Coverage-Notice Deep Links

**Date:** 2026-09-03
**Status:** Fable-reviewed + Codex quorum folded 2026-09-03
**Tracking issue:** LanternOps/breeze#3205, wave 6 (LanternOps/breeze#4655)
**Roadmap:** `docs/superpowers/specs/billing/2026-09-02-device-set-billing-roadmap.md` (§W06 + "Settled across all waves")
**Depends on:** W02 — `docs/superpowers/specs/billing/2026-09-02-contract-lines-per-device-group-design.md` and its plan `docs/superpowers/plans/billing/2026-09-02-contract-lines-per-device-group.md` (assumed merged)
**Consumers:** LanternOps/breeze#4606 (SLA by contract tier); W07 (billing evidence) — see Hand-off

## Problem

Two questions have no answer in the product today.

**"Which contract line bills this device?"** A tech looking at a server cannot tell whether it is on a contract, on which line, or at what tier. W01 and W02 built the machinery that decides this every billing run — `lineMatches` over one `OrgDeviceSnapshot` — but the answer is computed inside `generateDueInvoice` and thrown away. #4606 (SLA by contract tier) needs exactly this device → line relation and cannot be started without it.

**"Which devices are the 3 Unknown?"** The W01 coverage notice on the contract editor and detail pages says *"3 devices are not billed by any line on this contract: 3 Unknown"* and stops there. The operator has to leave the page, open the devices list, work out which filter reproduces the sentence, and apply it by hand. The warning names the problem and hides the evidence — the exact failure mode "silence is a bug" exists to prevent, one step removed.

Both are read-only questions over data that already exists. Neither needs a table.

## Findings that shape the design (verified 2026-09-03)

Line numbers are against this worktree (`billing-by-units`, wave-1 code) except where a finding is explicitly a post-W02 shape from the W02 spec/plan.

### Device routes and the access chokepoint

- `apps/api/src/routes/devices/index.ts:36` builds one `deviceRoutes` Hono app. Static paths mount **before** `coreRoutes` (`:44-88`, each with a comment naming the `/:id` collision it dodges); `:id`-prefixed sub-resources mount after (`:93-117`). `core.ts` registers exactly ten paths — `/onboarding-token`, `/`, `/:id` (GET/PATCH/DELETE), `/:id/remote-access-launch`, `/:id/management-posture`, `/:id/agent-token/rotate`, `/:id/restore`, `/:id/permanent` (verified by reading each handler's first argument at `core.ts:448,567,1015,1261,1357,1383,1508,1569,1682,1782`). **There is no wildcard under `/:id`**, so a new `/:id/billing` mounted in the sub-resource block cannot be shadowed.
- `apps/api/src/routes/devices/index.test.ts:5-12` asserts mount order for `agentRollbackRoutes` vs `coreRoutes` by reading `index.ts` as source text. **A new sub-resource gets its own assertion in this file** — the file is the repo's mount-order contract, and "it happens to be `:id`-prefixed so ordering cannot bite" is exactly the reasoning that stops being true when someone later adds a static sibling.
- **The chokepoint** is `getDeviceWithOrgAndSiteCheck` (`apps/api/src/routes/devices/helpers.ts:159-204`). It returns the device row, `null` (missing **or** org-denied → 404), or the `SITE_ACCESS_DENIED` sentinel (`helpers.ts:142`) → 403. It reads the site allowlist from the Hono `permissions` context and **throws a 500 `HTTPException` when that context is absent** (`:189-194`), so a route that forgets `requirePermission` fails loudly instead of granting cross-site access. A `PG_UUID_REGEX` guard at `:174-176` (regex at `apps/api/src/utils/uuid.ts:36`) turns a malformed path param into the same `null`/404 rather than a 22P02 → 500 (#2968).
- `ensureOrgAccess` (`helpers.ts:67-81`) is the org axis: `organization` scope → `auth.orgId === orgId`; `partner` scope → `auth.canAccessOrg(orgId)`; `system` → always true. So both org- and partner-scoped tokens reach device detail through different branches of the same helper. `auth.accessibleOrgIds` (`apps/api/src/middleware/auth.ts:104`, populated at `:662,721`) is the list form of the same fact; `canAccessOrg` is derived from it (`:280-281`).
- **Route to mirror:** `apps/api/src/routes/devices/warranty.ts:15-39` (`GET /devices/:id/warranty`) — `authMiddleware` on the sub-router (`:12`), then per-route `requireScope(...)` (`:17`), `requirePermission(...)` (`:18`), then the chokepoint with the 403-before-404 order (`:23-29`). `apps/api/src/routes/devices/alerts.ts:23-39` is the same shape. Both return a bare `{ error: 'Device not found' }` with **no** `code` (`warranty.ts:28`, `alerts.ts:38`).
- **Route test to mirror:** `apps/api/src/routes/devices/alerts.test.ts:1-63` — mocks `../../db`, `../../middleware/auth` and `./helpers`, captures `requirePermissionMock.mock.calls` at import time to assert the registered permission (`:38,49-51`), and proves the site-denied branch does no DB work (`:53-62`).

### Permissions and scopes

- The canonical registry is `packages/shared/src/constants/permissions.ts`: `DEVICES_READ: { resource: 'devices', action: 'read' }` at **`:21`** (block comment `// Devices` at `:20`), `CONTRACTS_READ: { resource: 'contracts', action: 'read' }` at **`:73`**. The API re-exports the whole object as `PERMISSIONS` (`apps/api/src/services/permissions.ts:280`, importing `PERMISSION_GRANTS` at `:5`), which is why route code reads `PERMISSIONS.DEVICES_READ`.
- **Every contracts read route is `requireScope('partner', 'system')`** — `apps/api/src/routes/contracts/contracts.ts:16` builds `const scopes = requireScope('partner','system')` and `:17` `const readPerm = requirePermission(PERMISSIONS.CONTRACTS_READ...)`; both are applied to `GET /`, `GET /:id/estimate` and `GET /:id` (`:59,67,71`). **An organization-scoped user cannot read contract data anywhere in the product today.**
- **No `contracts:read` API-key scope exists.** `API_KEY_SCOPE_POLICIES` (`apps/api/src/services/apiKeyScopes.ts:3-34`) enumerates `devices:*`, `scripts:*`, `alerts:*`, `reports:*`, `users:read` and the coarse `ai:*` gates — nothing for contracts. An API key therefore can never satisfy a `contracts:read` gate, which excludes API keys from this route by construction rather than by an extra check.

### Contracts: what counts as "active", and how lines are read

- `contractStatusEnum` is `draft | active | paused | cancelled | expired` (`apps/api/src/db/schema/contracts.ts:9-11`). **`active` is the only *eligible* status, not a sufficient condition:** the worker selects `eq(contracts.status, 'active')` (`apps/api/src/jobs/contractWorker.ts:53`) and `generateDueInvoice` refuses unless the contract is active **and** `nextBillingAt` is non-null and due (`apps/api/src/services/contractService.ts:1067`). So "active" is the right filter for *"could this line ever bill this device?"*; it is deliberately not a claim that an invoice is imminent.
- `contractLines` (`schema/contracts.ts:57-80`) carries `contractId`, `orgId`, `lineType`, `description`, `siteId`, `deviceRoles`, `sortOrder`; W02 adds `deviceGroupId` + the stamped `deviceGroupName`, a `(device_group_id, org_id)` composite FK and a `(contract_id, org_id)` composite FK. `contracts_id_org_uq` already exists (`:54`).
- `listContracts` (`contractService.ts:144-184`) resolves **every** line of every contract on the page (`:178`) to compute `estimatedPeriodValue`, and `getContract` (`:135-142`) returns all lines for one contract. Neither is the shape a per-device lookup wants; W06 reads with its own narrow join.
- Errors travel as `ContractServiceError(message, status, code, details)` (`apps/api/src/services/contractTypes.ts:76-91`), serialized by `handleContractError` (`apps/api/src/routes/contracts/contracts.ts:50-57`) as `{ error, code, details? }`. `contractActorFrom` (`:34-49`) builds a `ContractActor`; **device routes do not build one** and must not have to.

### The pure coverage helpers (wave 1 today, W02 shape assumed)

- Today `contractCoverage.ts` holds `lineMatches` as a **private** function (`apps/api/src/services/contractCoverage.ts:31-36`), consumed by `quantityFor` (`:40-48`) and `uncoveredByRole` (`:53-67`). `isDeviceLine` (`:21-23`) is a hand-written `||` chain.
- After W02 (plan Task 4): `OrgDeviceSnapshot { devices: readonly DeviceSnapshotRow[]; groups: ReadonlyMap<string, GroupMembers> }`, `GroupMembers { siteId, memberIds }`, `CoverageLine { lineType, siteId, deviceRoles, deviceGroupId }`, `DeviceSnapshotRow { id, role, siteId }`, `assertResolvable`, and `lineMatches` gaining the group branch `g.memberIds.has(row.id) && (g.siteId === null || g.siteId === row.siteId)`. **The site narrowing of a site-bound group lives in `lineMatches`, not in `memberIds`** — `memberIds` is the unnarrowed `matched ∪ pinned` union. This is load-bearing for Decision 1's parity argument.
- `billableDeviceConds` (`apps/api/src/services/contractQuantities.ts:9-17`) is declared "the one set of 'is this device billable' predicates … never fork these conditions": `org_id = $1`, `status <> 'decommissioned'`, `is_ephemeral = false`. `snapshotContractDevices` (`:51-58`) is its only billing-path consumer.
- After W02 (plan Task 5, Step 4) `contractService.ts` privately holds `OrgSnapshotEntry`, `DeviceCache`, `EMPTY_SNAPSHOT`, `groupIdsOf`, `orgSnapshot(orgId, dc, groupIds)` and `resolvableLines`. `orgSnapshot` loads **every billable device in the org** and resolves each group via `groupMembersForBilling` → `resolveEffectiveGroupMembers`, translating `GroupEvaluationError` into `ContractServiceError(…, 500, 'GROUP_EVALUATION_FAILED', …)`. A group id absent from the `(id, org_id)` query is absent from the map, which callers treat as "deleted".
- W02 adds `resolveEffectiveGroupMembers(group) → { matched, pinned }` to `groupMembership.ts`: static → `matched` = every org-predicated row, `pinned` = ∅; dynamic with a null filter → `matched` = ∅, `pinned` = pinned rows; dynamic with a malformed non-null filter → `GroupEvaluationError('invalid_filter')`; dynamic with a valid filter → `matched` = `evaluateFilter(filter, { orgId, allowedSiteIds: group.siteId ? [group.siteId] : null })`, engine errors wrapped as `GroupEvaluationError('engine_error')`.
- **A single-device matcher already exists and is already the group system's own primitive.** `deviceMatchesFilter(deviceId, filter)` (`apps/api/src/services/filterEngine.ts:668-683`) compiles the same `buildGroupSQL` used by `evaluateFilter` and runs it against one device id under the same `withFilterStatementTimeout` guard (asserted by `apps/api/src/services/filterEngine.test.ts:340-341`). `groupMembership.ts` already calls it on both single-device paths (`:193`, `:551`). **It takes no `allowedSiteIds`** — `evaluateFilter` applies the group's site narrowing inside its SQL, `deviceMatchesFilter` does not, so any caller that wants matched-set parity must apply the site condition itself.

### Roadmap correction folded in

- The roadmap's "**`unknown` is never billable**" (Settled across all waves) is being corrected by Fable to: **`unknown` cannot be selected by a `per_device_role` line; `per_device` and `per_device_group` lines can and do bill it.** That is what the code has always done — `lineMatches`' `per_device` branch returns true for every row regardless of role, and a group's `memberIds` are device ids with no role predicate. W06 depends on the corrected reading: an unclassified device covered by an org-wide `per_device` line correctly reports `matchedBy: 'org'`, and `uncoveredByRole`'s own comment (`contractCoverage.ts:52`) already says "'unknown' rows can only be covered by a per_device line".

### Web

- `apps/web/src/components/contracts/DeviceCoverageNotice.tsx` renders one `<p>`: `formatUncoveredBreakdown` (`:6-11`) joins `byRole` into `"3 Unknown, 2 Printer"`, largest bucket first, interpolated into `contracts.shared.coverage.uncovered` (`:33`). `null`/`undefined` → nothing; `total === 0` → the `contract-coverage-ok` line (`:21-27`).
- Two component call sites: `ContractEditor.tsx:1186`, `ContractDetail.tsx:335`. **`formatUncoveredBreakdown` has a third consumer**: `ContractDetail.tsx:196` interpolates it into a post-generate toast, which is a plain string and must stay one.
- Both pages have the org: `ContractDetail.tsx:96` destructures `contract` (a `ContractSummary` carrying `orgId` — `apps/web/src/lib/api/contracts.ts:30-53`); `ContractEditor.tsx:73` holds `orgId` as state (`''` before an org is chosen).
- Both estimates start `null` (`ContractDetail.tsx:105`, `ContractEditor.tsx:93`) and are filled by a `useEffect` fetch, so the notice renders nothing during SSR even though the pages are `client:load` islands (`apps/web/src/pages/contracts/[id].astro:12`, `index.astro:7`). Contract detail lives at `/contracts/<id>`.
- **`#orgId=` is an established hash key in this product** — the contracts landing page hands the hash to `ContractsList`, which owns an `#orgId=…&status=…` filter fragment (`apps/web/src/components/contracts/ContractsTabs.tsx:9-15`, and `parseTab` at `:18-21` reads the fragment with `URLSearchParams`). **The Devices page** — not the app — has no org fragment: `DevicesPage`'s only hash consumers are `decodeFilterFromHash` and `readDeviceClassFromHash` (`DevicesPage.tsx:195,200`), and those two modules are its only hash writers (`filterUrl.ts:44-58`, `deviceClassFilter.ts:51-69`).
- The devices list already parses the filter half of the deep link: `DevicesPage.tsx:195` seeds `advancedFilter` with `useHashState(null, (h) => decodeFilterFromHash(h) ?? undefined)`; `:214` resolves it through `useAdvancedFilterIds`; `:339` applies the id set to the rendered rows. `decodeFilterFromHash` (`apps/web/src/components/devices/filterUrl.ts:28-42`) reads `#filtersV2=<base64url(JSON)>` (`HASH_KEY` at `:5`, encoder at `:23-26`). Each writer preserves the other's fragments (`filterUrl.ts:49-52`, `deviceClassFilter.ts:57-59`), so a third `orgId=` fragment survives both.
- `useHashState` (`apps/web/src/lib/useHashState.ts:47-71`) adopts the hash in a **layout** effect post-mount and re-adopts on `hashchange` (the #2421 SSR-safe pattern).
- `useAdvancedFilterIds` (`apps/web/src/hooks/useAdvancedFilterIds.ts:40-59`) POSTs to `/filters/preview` from a **passive** `useEffect` whose dependency is the filter alone — **it does not re-run when the org scope changes**. `fetchWithAuth` injects the active orgId as `?orgId=`.
- **The pinned org is validated server-side.** `apps/api/src/routes/filters.ts:138-151`: a `?orgId=` query is checked with `ensureOrgAccess(pinnedOrgId, auth)` and returns **403** when the caller cannot reach it; without the pin the preview spans `getOrgIdsForAuth(auth)`. A forged `#orgId=` in a pasted URL therefore cannot widen access.
- The org scope comes from `useOrgScope` (`apps/web/src/hooks/useOrgScope.ts:49-62`) over a persisted zustand store (`apps/web/src/stores/orgStore.ts:104`), whose public setters are `selectOrganization(orgId)` / `selectAllOrgs()` (`:86-96,140-169`). A cached org that no longer exists is reset on the next `fetchOrganizations` (`:259-261`).
- **No existing `DevicesPage` test exercises the real hash decoder** — both suites mock the module (`DevicesPage.test.tsx:100-104` returns a fixed `status equals online` group; `DevicesPage.orgScope.test.tsx:48`). Hash-adoption behaviour on that page is currently unproven end to end.
- `filtersV2` (`DevicesPage.tsx:210`, `filterUrl.ts:83-96`) is default-ON with a `localStorage`/hash opt-out (#968, one release window). It gates only the hash **mirror** effect (`:677`) and which filter bar renders (`:1397`) — **not** the filtering itself (`:339`). An opted-out user following a deep link gets a correctly filtered list with no chip to clear it.
- `navigateTo` (`apps/web/src/lib/navigation.ts:7-29`) routes through Astro's client router behind `getSafeNext` (`apps/web/src/lib/authNext.ts:9-15`), which checks only the leading `/`, `//`/`/\` and control characters — **it preserves the fragment**.
- `filterUrl.ts:7-13` `toBase64Url` **returns `''` when `typeof window === 'undefined'`** and otherwise uses `btoa`. Any link built from `encodeFilterToHash` during SSR is silently empty.
- `deviceRole` is `varchar(30) NOT NULL DEFAULT 'unknown'` (`apps/api/src/db/schema/devices.ts:63`) and the filter engine registers `deviceRole` as an `enum` field whose `enumValues` **include `'unknown'`** (`apps/api/src/services/filterEngine.ts:78-79`). `FilterCondition` is `{ field, operator, value }` (`packages/shared/src/types/filters.ts:82-86`); `FilterConditionGroup` is `{ operator: 'AND'|'OR', conditions }` (`:105-108`). The web role list is `apps/web/src/lib/deviceRoles.ts:18-23`.
- Device detail (`apps/web/src/components/devices/DeviceDetails.tsx`): 28 core tabs (`:175-204`) behind `OverflowTabs` (`:626-630`), hash-selected via `tabFromHash` (`:219-224`) + `useHashState` (`:318`). The Overview tab hosts self-fetching read-only cards — `DeviceReliabilityPanel` (`:710`), `DevicePerformanceGraphs` (`:712`), `DeviceWarrantyCard compact` (`:714`). `DeviceWarrantyCard.tsx:101-110` is the local `loading`/`error` pattern and `:10` the 401 → `loginPathWithNext()` convention.
- `apps/web/src/lib/api/contracts.ts:1-13`: no generic api client; wrappers call `fetchWithAuth` and return the raw `Response`. `runAction` guards mutations; a read follows `ContractDetail.tsx:119-135` + the retry button at `:336-341`.
- `<Trans>` with `components={{ … }}` is established (`LoginBrandingCard.tsx:163,191`, `PartnerEventLogsTab.tsx:87`), with a known markup-escaping gotcha (`EnrollmentKeyManager.tsx:507`, `EnrollmentKeyManager.test.tsx:561`). Eight locales: `de-DE, en, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR`.

### AI tools

- `get_device_details` (`apps/api/src/services/aiToolsDevice.ts:141-191`) is **tier 1, auto-execute**, and already spreads the whole device row plus hardware/network/disks/metrics.
- Its gate is `verifyDeviceAccess` (`apps/api/src/services/aiTools.ts:140-165`): helper-device lock, `allowedDeviceIds`, `auth.orgCondition(devices.orgId)`, `auth.canAccessSite` — **and nothing about billing permissions**.

## Decisions

1. **The lookup builds a ONE-DEVICE `OrgDeviceSnapshot`. `orgSnapshot`/`DeviceCache` stay exactly where W02 put them.** Loading every billable device in the org to answer a question about one device is the wrong shape: it is O(org) work for an O(1) answer on a page that a tech opens dozens of times a day, and it scales with the customer's fleet rather than with the contract. W02's placement in `contractService.ts` stands untouched — no move, no re-export, no new import edge into the billing graph.

   The snapshot the service builds is a genuine `OrgDeviceSnapshot`, just a one-row one:

   ```ts
   const row = await billableDeviceById(deviceId, device.orgId);   // DeviceSnapshotRow | null
   const snapshot: OrgDeviceSnapshot = {
     devices: row ? [row] : [],
     groups: new Map(referencedGroupIds.map((id) => [id, membersForThisDevice(id)])),
   };
   ```

   where each `GroupMembers` is `{ siteId: group.siteId, memberIds: included ? new Set([deviceId]) : new Set() }`. `coverageMatch(line, row, snapshot)` then runs **unchanged** — the same predicate, the same site narrowing, the same group branch that `generateDueInvoice` runs. Nothing about the answer is re-derived; only the input set is narrowed to the one row the caller asked about.

   Two new exports make this possible without forking anything:

   - **`billableDeviceById(deviceId, orgId): Promise<DeviceSnapshotRow | null>`** in `contractQuantities.ts` — `and(...billableDeviceConds(orgId), eq(devices.id, deviceId))`, selecting the same three columns as `snapshotContractDevices`. It **reuses `billableDeviceConds`**, which is the module's stated invariant ("never fork these conditions"), so a fourth predicate added later applies to the device panel automatically.
   - **`groupIncludesDevice(group, device): Promise<boolean>`** in `groupMembership.ts`, the single-device twin of `resolveEffectiveGroupMembers`, returning **exactly** membership in `matched ∪ pinned`:

     | Group | `groupIncludesDevice` |
     |---|---|
     | static | an org-predicated membership row exists for `(group.id, group.orgId, device.id)` |
     | dynamic | a **pinned** org-predicated row exists **OR** (`filterConditions` is a valid `FilterConditionGroup` **AND** `deviceMatchesFilter(device.id, filter)` **AND** (`group.siteId === null || group.siteId === device.siteId`)) |
     | dynamic, `filterConditions` null | pinned row only |
     | dynamic, malformed non-null filter | throws `GroupEvaluationError(group.id, 'invalid_filter')` |
     | any engine error / timeout | throws `GroupEvaluationError(group.id, 'engine_error')` |

     The trailing site condition on the filter branch is **not** an optimization — it is parity. `evaluateFilter` applies `allowedSiteIds: [group.siteId]` inside its SQL; `deviceMatchesFilter` takes no site argument (`filterEngine.ts:668-671`), so without that clause the two definitions of `matched` would disagree for exactly the site-bound-group case. It is the one place this design could silently drift, which is why the parity test below is mandatory. The pinned branch carries no site condition, because `resolveEffectiveGroupMembers`' `pinned` set carries none either.

     Read order is pinned-row-first: a membership read is an index hit, `deviceMatchesFilter` is a compiled filter under a 500 ms timeout, so a pinned device short-circuits the expensive half.

   **Site short-circuit, one level up.** The snapshot builder skips `groupIncludesDevice` entirely — no membership read, no filter evaluation, `memberIds: new Set()` — for any group whose `siteId` is non-null and differs from the device's `siteId`. This is sound at the *coverage* level, not the membership level: `coverageMatch`'s group branch requires `g.siteId === null || g.siteId === row.siteId`, so such a group cannot cover this device however it is pinned. Keeping the skip in the builder rather than inside `groupIncludesDevice` is what lets `groupIncludesDevice` stay literally parity-testable against `resolveEffectiveGroupMembers`.

   **Parity is proved, not asserted.** An integration test seeds one org with static, dynamic, null-filter, site-bound and pinned groups, then asserts that for **every** group × **every** device, `groupIncludesDevice(group, device)` equals `deviceId ∈ (matched ∪ pinned)` from `resolveEffectiveGroupMembers(group)`. Two definitions of group membership now exist; this test is the reason they cannot drift.

2. **One predicate answers both "does this line bill this device?" and "why?".** `contractCoverage.ts` exports `coverageMatch(line, row, snapshot): 'org' | 'site' | 'role' | 'group' | null`; the private `lineMatches` becomes `coverageMatch(...) !== null`. Consequence: for one contract, a device appears in `uncoveredByRole`'s tally **iff** no line of that contract appears in `contractLinesCoveringDevice`'s answer. The contract page's warning and the device page's panel cannot disagree, because there is one function.

3. **`matchedBy` names the line's device-set *selector*, and is never a set.** It is a function of `lineType` plus — only for `per_device` — whether `siteId` is set:

   | Line | `siteId` | `matchedBy` |
   |---|---|---|
   | `per_device` | `null` | `org` |
   | `per_device` | set | `site` |
   | `per_device_role` | `null` or set | `role` |
   | `per_device_group` | always `null` (W02 CHECK) | `group` |

   **A site-scoped role line is `role`, not `role`+`site`.** The operator's answer to "why is this billed?" is "it is a server" — the site is a narrowing of that set, not a second reason, and the device is by construction at that site anyway. A set would push combinatorics into every consumer for information the row already carries: the projection includes the line's `siteId` verbatim. `org` vs `site` **is** a selector difference — "every device you own" and "every device at this location" are different promises to the customer — which is why `per_device` is the one type that splits.

4. **Coverage is derived live from the same predicate, over `active` contracts only.** No table, no cache. `active` is the *eligible* set: the worker filters on it (`contractWorker.ts:53`) and `generateDueInvoice` additionally requires a due `nextBillingAt` (`contractService.ts:1067`), so the panel answers "could this line bill this device?" — deliberately not "will it bill this period?", which depends on the billing calendar and belongs to W07's per-period evidence. A `draft` contract's line therefore does not cover, even while the editor's own per-contract notice counts it; the two answer different questions and are not reconciled by widening the filter.

5. **Not-billable is a third state, decided by `billableDeviceById`, with no 500 for concurrent drift.** A device excluded by `billableDeviceConds` is not "uncovered" — nothing is wrong, and telling an operator a decommissioned box is unbilled is noise that trains them to ignore the panel. The flow is: the route's chokepoint read (404/403 as today) → the service's identity/authz read → `billableDeviceById`. When it returns `null` the device was decommissioned, ephemeral, or moved org **at this instant**, and the reason label comes from the identity row: `status === 'decommissioned'` → `'decommissioned'`; `isEphemeral` → `'ephemeral'`; otherwise `'not_billable'` (the honest label for "it no longer satisfies the predicates and the row does not say why" — a device moved between the two reads, or a predicate added to `billableDeviceConds` without updating this labelling). **There is no `SNAPSHOT_DISAGREEMENT` error:** two reads a millisecond apart are allowed to disagree, and a 500 on a benign race would be a worse answer than a correct `notBillable` with a slightly vaguer reason.

   Exactly one of three states holds, and `uncovered` is derived:
   ```
   notBillable === true   → lines = [],           uncovered === false
   notBillable === false  → uncovered === (lines.length === 0)
   ```

   Returning early also means a not-billable device performs no group work at all, so it can never fail on an unrelated broken group.

6. **A group-evaluation failure is a 500 with a code, never an empty list.** `GroupEvaluationError` from `groupIncludesDevice` is translated to `DeviceCoverageError(…, 500, 'GROUP_EVALUATION_FAILED', { groupId, groupName, reason })`; the route returns `{ error, code, details }` and the card renders its error state with retry. The blast radius is minimal by construction: only groups named by device-counted lines of **active** contracts in this org, at this device's site, are evaluated — a broken group on a draft contract, on another org's contract, or at another site cannot break the panel. `deviceCoverage.ts` owns its own error class rather than leaking `ContractServiceError` into a device route that has no `handleContractError`.

7. **A group line whose group is gone covers nothing, and says so by omission.** `resolvableLines` semantics apply: a null `device_group_id`, or a group id that does not come back from the org-predicated group read, cannot match. The device is then correctly not covered *by that line* — the same answer `uncoveredByRole` gives on the contract page, and consistent with generation refusing the line outright (`GROUP_DELETED`, 409). W06 does not surface the orphaned line on the device panel; the contract page already flags it.

8. **The route requires `requireScope('partner','system')` + `devices:read` + `contracts:read`; the card is gated on `contracts:read` before it mounts.** This narrows the roadmap's "behind the existing `devices:read` + org/site chokepoint", and the reason is concrete: `contract_lines.description` is operator-authored free text that in practice carries the rate ("Managed servers @ $40"), so a `devices:read`-only gate would hand operator pricing prose to any tech with device access. Three consequences, each deliberate:

   - **Organization-scoped users get 403, and that is the status quo, not a regression.** Every contracts read route is already `requireScope('partner','system')` (`routes/contracts/contracts.ts:16,59,67,71`); an org-scoped user cannot see contract data anywhere today. W06 does not become the one endpoint that leaks it.
   - **API keys are excluded by construction.** `API_KEY_SCOPE_POLICIES` (`apiKeyScopes.ts:3-34`) has no `contracts:read` scope, so no key can satisfy the gate. No extra check is needed and none is added — if a `contracts:read` scope is ever introduced, this route inherits it intentionally.
   - **The web card checks `can('contracts','read')` before it mounts or fetches**, so a device page for a tech without billing access renders no card and issues no request — rather than firing a request that 403s and showing an error state for a permission they were never going to have.

   The payload still carries no money (no `unitPrice`, no quantity, no period value): with both gates, that is defence in depth rather than the whole defence. The route still calls `getDeviceWithOrgAndSiteCheck` because it is the **only** place the site axis is enforced (the allowlist lives in the Hono `permissions` context, not in an org id list); the service re-checks the org so non-route callers (#4606, a worker) cannot skip it.

9. **The deep link carries org scope: `#orgId=<uuid>&filtersV2=<base64url>`.** `#orgId=` is not a new mechanism — the contracts area already owns an `#orgId=…&status=…` fragment (`ContractsTabs.tsx:9-15`); W06 teaches the Devices page the same key. The list adopts it into the org store **before** the filter preview runs, so a pasted or copied URL reproduces the contract page's view exactly, not "that role filter in whatever org you happened to have selected". The link stays a real `<a href>`, so copy, middle-click and open-in-new-tab all work — which is the whole point of putting the org in the URL rather than writing the store on click.

   **Safety:** the hash cannot widen access. `/filters/preview` validates the pinned org with `ensureOrgAccess` and 403s otherwise (`routes/filters.ts:142-148`), the devices list is org-scoped by the same auth, and an org id the user cannot see is reset by the store's next `fetchOrganizations` (`orgStore.ts:259-261`). `readOrgIdFromHash` additionally validates the UUID shape before touching the store.

   **Ordering is the correctness risk, and it is explicit.** `useAdvancedFilterIds`' fetch is a passive `useEffect` keyed on the filter alone — it does **not** re-run when the org changes (`useAdvancedFilterIds.ts:40-59`). If the preview fired before the store write landed, the id set would be computed against the wrong org and never recomputed. Adoption is therefore a **layout** effect (React runs every layout effect in a commit before any passive effect, the same guarantee `useHashState` relies on), declared above the `useAdvancedFilterIds` call, with a comment saying so and a mounted regression test pinning it.

   Rejected: writing the org store from the notice's `onClick` (same-tab only — middle-click and copy silently land in the wrong org, which is worse than no org in the link because it looks like it worked); `?orgId=` query params (CLAUDE.md forbids them for transient UI state).

10. **`toBase64Url` in `filterUrl.ts` becomes isomorphic.** It currently returns `''` on the server (`filterUrl.ts:8`), so any SSR-rendered link built from `encodeFilterToHash` is silently `/devices#`. W06 is safe from that only by accident (the notice's content does not exist until a client fetch resolves). A ten-line pure encoder removes the class rather than depending on the accident, and is covered by a test asserting byte-identical output with and without `window`. `fromBase64Url` keeps `atob` — decoding only ever runs client-side and already guards.

11. **No `device_billing` AI tool, and no contract data in `get_device_details`.** In order of weight: (a) `verifyDeviceAccess` has **no billing permission axis** (`aiTools.ts:140-165`), so a device tool would hand contract names and line descriptions to any AI actor with device access — and Decision 8 has just established that billing prose needs `contracts:read`; (b) `get_device_details` is tier-1 **auto-execute**, so every incidental lookup would run live group evaluations and one broken group would break an unrelated troubleshooting answer; (c) coverage is billing-domain data that `manage_contracts` owns. When #4606 gives the model a reason to want a device's tier, the right shape is a billing-tool read with its own gate, specified there.

12. **Columns before tables, and this wave has neither.** No migration, no column, no table: no RLS work, no cascade-list registration, no export-policy classification, no org-merge policy. Written down rather than inferred, because the registration checklist fires on new columns as well as new tables.

## Design

### API — `apps/api/src/services/contractQuantities.ts` (one export)

```ts
/** The one billable device, as the snapshot sees it — the single-device twin of
 *  snapshotContractDevices, sharing billableDeviceConds so a future predicate
 *  applies to the device panel automatically. null = decommissioned, ephemeral,
 *  in another org, or gone. */
export async function billableDeviceById(deviceId: string, orgId: string): Promise<DeviceSnapshotRow | null> {
  const [row] = await db
    .select({ id: devices.id, role: devices.deviceRole, siteId: devices.siteId })
    .from(devices)
    .where(and(...billableDeviceConds(orgId), eq(devices.id, deviceId)))
    .limit(1);
  return row ?? null;
}
```

`orgSnapshot`, `DeviceCache`, `groupIdsOf`, `resolvableLines` and `EMPTY_SNAPSHOT` stay private in `contractService.ts` exactly as W02 leaves them. `contractService.ts` is not edited by this wave.

### API — `apps/api/src/services/groupMembership.ts` (one export)

```ts
export type DeviceForMembership = {
  id: string;
  orgId: string;
  siteId: string | null;
  isEphemeral: boolean;
};

/**
 * Is this ONE device in this group, as billing defines membership (#3205 W06)?
 * The single-device twin of resolveEffectiveGroupMembers: returns
 * `deviceId ∈ (matched ∪ pinned)` for billing-eligible devices (same org, not
 * ephemeral). Other-org and ephemeral devices are refused up front. Proved by
 * groupMembership.parity.integration.test.ts.
 *
 * The site clause on the filter branch is PARITY, not an optimization:
 * evaluateFilter narrows by allowedSiteIds inside its SQL, deviceMatchesFilter
 * (filterEngine.ts:668) takes no site argument. The pinned branch carries no
 * site clause because `pinned` carries none either — a site-bound group's
 * off-site pinned member IS in memberIds and is narrowed out later, by
 * coverageMatch's group branch.
 */
export async function groupIncludesDevice(group: GroupForResolution, device: DeviceForMembership): Promise<boolean> {
  if (device.orgId !== group.orgId || device.isEphemeral) return false;

  const pinnedFirst = /* org-predicated membership read: (group_id, org_id, device_id) → { isPinned } | undefined */;

  if (group.type !== 'dynamic') return pinnedFirst !== undefined;
  if (group.filterConditions !== null && group.filterConditions !== undefined
      && !isFilterConditionGroup(group.filterConditions)) {
    throw new GroupEvaluationError(group.id, 'invalid_filter');
  }
  if (pinnedFirst?.isPinned) return true;
  if (group.filterConditions === null || group.filterConditions === undefined) return false;
  if (group.siteId !== null && group.siteId !== device.siteId) return false;
  try {
    return await deviceMatchesFilter(device.id, group.filterConditions);
  } catch (err) {
    throw new GroupEvaluationError(group.id, 'engine_error', err);
  }
}
```

The eligibility guard is required because `deviceMatchesFilter` carries no org or ephemeral predicate.

A pinned member of a malformed group still throws `GroupEvaluationError(group.id, 'invalid_filter')`; filter-shape validation precedes the pinned short-circuit.

Every membership read predicates on `group_id` **and** the group's own `org_id` — W02's finding that the membership table's RLS is org-only, so a forged row carrying another tenant's `org_id` and this group's id is visible to a system context. `resolveEffectiveGroupMembers` and `evaluateGroupMembership` are untouched.

### API — `apps/api/src/services/contractCoverage.ts` (one export, one constant)

```ts
/** The three line types whose quantity is a device count. The SQL filter in
 *  deviceCoverage and the pure predicate below are both defined from this, so
 *  they cannot drift when W03/W04 add a type. */
export const DEVICE_COUNTED_LINE_TYPES = ['per_device', 'per_device_role', 'per_device_group'] as const;
export type DeviceCountedLineType = typeof DEVICE_COUNTED_LINE_TYPES[number];

export function isDeviceLine(line: Pick<CoverageLine, 'lineType'>): boolean {
  return (DEVICE_COUNTED_LINE_TYPES as readonly string[]).includes(line.lineType);
}

export type CoverageMatchReason = 'org' | 'site' | 'role' | 'group';

/** The single predicate behind BOTH the contract page's uncovered warning and
 *  the device page's coverage panel: quantityFor/uncoveredByRole ask only
 *  "does it match?", deviceCoverage also asks "why?". They cannot disagree. */
export function coverageMatch(
  line: CoverageLine, row: DeviceSnapshotRow, snapshot: OrgDeviceSnapshot,
): CoverageMatchReason | null {
  assertResolvable(line, snapshot);
  return matchReason(line, row, snapshot);
}
```

`matchReason` is the private core (no assert — the loops in `quantityFor`/`uncoveredByRole` pre-assert once, so per-row asserting would be O(n) waste) and `lineMatches` becomes `matchReason(...) !== null`. Its body is W02's `lineMatches` with each `true` replaced by the reason:

```ts
function matchReason(line, row, snapshot): CoverageMatchReason | null {
  if (line.siteId !== null && line.siteId !== row.siteId) return null;
  switch (line.lineType) {
    case 'per_device':      return line.siteId === null ? 'org' : 'site';
    case 'per_device_role': return line.deviceRoles?.includes(row.role) ? 'role' : null;
    case 'per_device_group': {
      const g = snapshot.groups.get(line.deviceGroupId!)!;   // assertResolvable proved both
      return g.memberIds.has(row.id) && (g.siteId === null || g.siteId === row.siteId) ? 'group' : null;
    }
    default: return null;
  }
}
```

W02's `contractCoverage.test.ts` cases stay green unchanged.

### API — `apps/api/src/services/deviceCoverage.ts` (new)

```ts
export interface DeviceCoverageLine {
  contractId: string;
  contractName: string;
  contractStatus: ContractStatus;      // always 'active' in W06; typed for #4606/W07
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

export class DeviceCoverageError extends Error {
  constructor(message: string, public status: 404 | 500,
              public code: DeviceCoverageErrorCode, public details?: Record<string, unknown>);
}

/** null accessibleOrgIds = unrestricted (system/worker); otherwise the caller's orgs. */
export interface DeviceCoverageActor { accessibleOrgIds: string[] | null }

export async function contractLinesCoveringDevice(
  deviceId: string, actor: DeviceCoverageActor,
): Promise<DeviceBillingCoverage>
```

Algorithm:

1. **UUID guard.** `PG_UUID_REGEX.test(deviceId)` fails → `DEVICE_NOT_FOUND` (404), before any query. Same 22P02-becomes-500 lesson as `helpers.ts:174-176`.
2. **Identity + org check (device read 1).** Select `{ id, orgId, siteId, deviceRole, status, isEphemeral }` by id. Missing, **or** `actor.accessibleOrgIds !== null && !includes(orgId)` → `DEVICE_NOT_FOUND`. 404 for both, never 403, so a cross-org probe cannot distinguish "exists elsewhere" from "does not exist" — matching `getDeviceWithOrgCheck`'s `null` for both.
3. **Billability (device read 2).** `const row = await billableDeviceById(deviceId, device.orgId)`. `null` → return `notBillable: true` with the label from Decision 5 (`decommissioned` → `ephemeral` → `not_billable`), `lines: []`, `uncovered: false`. **No contract query, no group work.**
4. **Active contracts and their device-counted lines**, one join:
   ```ts
   const rows = await db.select({
       contractId: contracts.id, contractName: contracts.name, contractStatus: contracts.status,
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
   ```
   Empty → return `{ lines: [], uncovered: true }`. No group query.
5. **Groups, batched then per-group.** One org-predicated `inArray(deviceGroups.id, referencedIds)` read for the group rows (`id, orgId, name, type, siteId, filterConditions`). Then per group: skip with `memberIds: ∅` when `group.siteId !== null && group.siteId !== row.siteId` (Decision 1's coverage-level short-circuit); otherwise `groupIncludesDevice(group, device)`, wrapping `GroupEvaluationError` as `DeviceCoverageError(…, 500, 'GROUP_EVALUATION_FAILED', { groupId, groupName: group.name, reason })`. A referenced id absent from the batch read is absent from the map (Decision 7).
6. **Project.** Build the one-device `OrgDeviceSnapshot`, then for each line whose group (if any) is in the map, `const why = coverageMatch(line, row, snapshot)`; when non-null push the projection (`deviceGroup` from `line.deviceGroupId` + the stamped `line.deviceGroupName`; `deviceRoles` only on role lines; `siteId` verbatim). `uncovered = out.length === 0`.

On the group name: the stamped `device_group_name` is used rather than a fourth query for the live name. It is what W02 designed the stamp for, and a resolvable line's group exists by definition, so the only drift is a rename after line creation. If #4606 needs the live name, the batch read at step 5 already selects it.

**RLS/context:** every read is org-scoped (`devices`, `contracts`, `contract_lines`, `device_groups`, `device_group_memberships`) in the caller's own org, served by the same policies for partner and system scopes. `deviceMatchesFilter` inside a request transaction is what `groupMembership.ts:193,551` already does today.

### Performance

Per request, with the one-device path:

| Read | Count | Why it is irreducible |
|---|---|---|
| Device (route chokepoint) | 1 | The only site-axis gate; the allowlist lives in the Hono `permissions` context. |
| Device (service identity/authz) | 1 | The service is self-guarding for #4606 and worker callers, and supplies the `notBillableReason` label. |
| Device (`billableDeviceById`) | 1 | The unforked `billableDeviceConds` verdict — the one source of truth for billability. |
| Contracts ⋈ lines | 1 | Skipped when the device is not billable. |
| `device_groups` batch | ≤1 | One `inArray`, only when a group line exists. |
| Membership row | ≤1 per referenced group at the device's site | Skipped entirely for a group at another site. |
| `deviceMatchesFilter` | ≤1 per **dynamic** group at the device's site, not already pinned | Under the existing 500 ms `withFilterStatementTimeout`. |

All three device reads are primary-key lookups. The contracts join is covered by `contracts_org_status_idx` (`schema/contracts.ts:48`) and `contract_lines_contract_sort_idx` (`:77`). Nothing scales with the org's fleet size — which was the point of Decision 1.

**This is pinned, not asserted:** the service unit test counts queries. `db.select` call counts are asserted for four shapes — not billable (2 device reads, nothing else), billable with no active contracts (3 reads, no group query), billable with one static group line (adds the batch read + 1 membership read, **0** `deviceMatchesFilter`), and a dynamic group at another site (adds the batch read, **0** membership reads and **0** `deviceMatchesFilter`).

### API — `apps/api/src/routes/devices/billing.ts` (new)

```ts
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
billingRoutes.get('/:id/billing',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  requirePermission(PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    // The ONLY site-axis gate (the allowlist lives in the permissions context,
    // not in accessibleOrgIds). The service re-checks the org for non-route callers.
    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) return c.json({ error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' }, 404);

    try {
      const data = await contractLinesCoveringDevice(deviceId, { accessibleOrgIds: auth.accessibleOrgIds });
      return c.json({ data });
    } catch (err) {
      // A group we cannot evaluate is an ERROR, never an empty list (#3205 W02
      // decision 3): reporting "not billed" for an unevaluable group is the
      // silent zero this feature exists to prevent.
      if (err instanceof DeviceCoverageError) {
        return c.json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, err.status);
      }
      throw err;
    }
  });
```

**One 404 body shape.** Both 404 sources — the chokepoint and the service's own org check — return `{ error: 'Device not found', code: 'DEVICE_NOT_FOUND' }`. This deliberately differs from the sibling device routes, which return a bare `{ error }` (`warranty.ts:28`, `alerts.ts:38`): a client that must branch on `code` for the 500 should not have to branch on shape for the 404.

Mounted in `apps/api/src/routes/devices/index.ts` in the sub-resource block beside `warrantyRoutes` (`deviceRoutes.route('/', billingRoutes);`), with a matching assertion in `index.test.ts`.

Success body:

```json
{ "data": {
  "deviceId": "…", "orgId": "…", "deviceRole": "server", "siteId": "…",
  "notBillable": false, "notBillableReason": null, "uncovered": false,
  "lines": [{
    "contractId": "…", "contractName": "Acme MSA", "contractStatus": "active",
    "lineId": "…", "lineType": "per_device_role", "description": "Managed servers",
    "matchedBy": "role", "siteId": null, "deviceRoles": ["server"], "deviceGroup": null
  }]
} }
```

Error bodies: `404 { error, code: 'DEVICE_NOT_FOUND' }`; `403 { error: 'Access to this site denied' }`; `500 { error, code: 'GROUP_EVALUATION_FAILED', details: { groupId, groupName, reason } }`. **No error path returns `lines`.**

### Web — API module and the Billing card

`apps/web/src/lib/api/devices.ts` (new) holds the `DeviceBillingCoverage` / `DeviceCoverageLine` types and one wrapper returning the raw `Response`, per the `contracts.ts:1-13` convention:

```ts
export function getDeviceBilling(deviceId: string): Promise<Response> {
  return fetchWithAuth(`/devices/${deviceId}/billing`);
}
```

**`apps/web/src/components/devices/DeviceBillingCard.tsx`** — an **Overview card**, not a tab, rendered after `DeviceWarrantyCard` (`DeviceDetails.tsx:714`). A tab was rejected: the panel is at most a handful of rows, the bar already carries 28 tabs behind `OverflowTabs`, and "who pays for this box?" belongs beside warranty and reliability. Rendering on Overview also means it does not fetch while the user is on Software/Patches/etc.

**Permission gate first (Decision 8):** `DeviceDetails` renders the card only when `can('contracts','read')`. The component itself is never mounted otherwise, so no request is made and no error state appears for a permission the user was never going to have.

- **Loading** (`device-billing-loading`) — a skeleton row. Fetch on mount keyed by `deviceId`; no polling.
- **Error** (`device-billing-error`) — message + Retry, the `ContractDetail.tsx:336-341` shape. For `code === 'GROUP_EVALUATION_FAILED'`, a specific string naming `details.groupName`: *"A device group on an active contract couldn't be evaluated (VIP Laptops). Coverage is unknown."* `401` → `UNAUTHORIZED()` (`DeviceWarrantyCard.tsx:10`). **The error branch returns before the uncovered branch**, so the card can never render "not billed" for a failure — the structural guarantee behind Decision 6.
- **Not billable** (`device-billing-not-billable`) — *"Not billed — this device is decommissioned"* / *"…is an ephemeral support-session device"* / *"…is not currently billable"*. No warning styling.
- **Uncovered** (`device-billing-uncovered`) — *"No active contract line bills this device."* plus the role chip (`getDeviceRoleIcon`/`getDeviceRoleLabel`) and a link to `/contracts`.
- **Covered** — one row per line (`device-billing-line`): contract name linking to `/contracts/<contractId>`, the status pill, the line description, and a `matchedBy` chip — *Org-wide* / *This site* / *Role: Server* / *Group: VIP Laptops*. Two lines from two contracts both render; overlap is legal and visible.

Read-only, so no `runAction`; the loading/error/retry triad is the read convention.

### Web — the deep link

**`apps/web/src/components/devices/orgHash.ts`** (new, mirroring `deviceClassFilter.ts`):

```ts
const HASH_KEY = 'orgId';

/** The org a deep link pins the devices list to (#3205 W06). Read-only: the org
 *  SELECTOR owns the store, so this page never writes the fragment back — a
 *  mirror writer would fight the selector for ownership of the same key. */
export function readOrgIdFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of raw.split('&')) {
    const [k, v] = part.split('=');
    if (k === HASH_KEY && v && UUID_RE.test(v)) return v;
  }
  return null;
}
```

**`apps/web/src/components/contracts/deviceCoverageLinks.ts`** (new) — the one producer:

```ts
import { encodeFilterToHash } from '../devices/filterUrl';
import { DEVICE_ROLES } from '@/lib/deviceRoles';

/** The devices list filtered to one device role, in one org, through the list's
 *  OWN hash format (#orgId=… + #filtersV2=…, DevicesPage.tsx:195 and orgHash.ts).
 *  Returns null for a role the filter engine does not know, so an unexpected
 *  device_role value renders as plain text rather than a link matching nothing. */
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

For `role = 'unknown'` the filter half is
`filtersV2=eyJvcGVyYXRvciI6IkFORCIsImNvbmRpdGlvbnMiOlt7ImZpZWxkIjoiZGV2aWNlUm9sZSIsIm9wZXJhdG9yIjoiZXF1YWxzIiwidmFsdWUiOiJ1bmtub3duIn1dfQ`
(base64url, unpadded) — pinned by the round-trip test, not by hand.

**`filterUrl.ts`** — replace the `btoa` body of `toBase64Url` (`:7-13`) with a pure encoder so the function works identically on the server:

```ts
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);           // isomorphic; no btoa, no Buffer
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += B64[c & 63]!;
  }
  return out;                                          // base64url, unpadded — as before
}
```

`fromBase64Url` is untouched. Output is byte-identical for every existing input, asserted by a test.

**`DevicesPage.tsx`** — one new hook call, declared **above** the `useAdvancedFilterIds` call at `:214`:

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

`useOrgIdFromHash` (co-located in `orgHash.ts`) reads the hash in a `useIsomorphicLayoutEffect`, and calls `useOrgStore.getState().selectOrganization(id)` when the parsed id differs from `currentOrgId`. It also subscribes to `hashchange`, matching `useHashState`'s contract. It never writes the fragment.

**`DeviceCoverageNotice.tsx`** — gains `orgId: string | null` and renders the breakdown as inline links:

- `formatUncoveredBreakdown` stays exactly as it is — `ContractDetail.tsx:196` needs a plain string for its toast.
- Call sites: `ContractDetail.tsx:335` → `orgId={contract.orgId}`; `ContractEditor.tsx:1186` → `orgId={orgId || null}`.
- `devicesUrlForRole(role, orgId) === null` → that bucket renders as plain text. The sentence never degrades into a dead link.
- `data-testid="contract-coverage-role-link"` on each anchor.

**i18n — structured keys, not concatenation and not `<Trans>`.** The breakdown is a **variable-length list** of role buckets, which `<Trans>`'s fixed `components={{ … }}` placeholders model badly, and concatenating translated fragments is the trap `EnrollmentKeyManager.tsx:507` documents. The sentence is therefore split into two keys the component composes structurally:

- `contracts.shared.coverage.uncoveredLead` — *"{{count}} device is not billed by any line on this contract:"* (plural-aware, **no** `breakdown` interpolation).
- `contracts.shared.coverage.roleBucket` — *"{{count}} {{role}}"* — rendered once per bucket inside its own `<a>` or `<span>`, so each bucket is a translated unit rather than a fragment glued to its neighbours.
- Buckets are joined by a rendered `common:lists.separator` (`", "`), never by `Array.join` over translated strings.

`contracts.shared.coverage.uncovered` (the single-string form) stays for the toast path.

### Docs

- `apps/docs/src/content/docs/features/contracts.mdx` — the coverage warning's role links; that coverage is derived live and never stored; that only **active** contracts count, so a draft contract's line does not show on a device even though the editor's own notice counts it; that the panel needs Contracts read access.
- `apps/docs/src/content/docs/features/devices.mdx` — the Overview "Billing" card and its four states.
- Release notes entry under billing.

## Hand-off to W07 (billing evidence)

W07 writes one `invoice_line_devices` row per counted device at generation. **It must not call `contractLinesCoveringDevice` N times** — that would run the one-device path once per device, inverting this wave's cost model and re-reading the contract set for every row. The shared shape instead:

- W07 extends the **generation** snapshot (`snapshotContractDevices`, `DeviceSnapshotRow`) with `hostname`, which it needs for the evidence row and which the one-device path gets for free from the same column list.
- `contractCoverage.ts` gains `matchingDevicesForLine(snapshot, line): DeviceSnapshotRow[]` — the plural form of `coverageMatch`, filtering `snapshot.devices` over the **same** `matchReason` core. `quantityFor` becomes `matchingDevicesForLine(...).length`, so the count and the evidence list are the same computation by construction and an invoice can never say "12" beside eleven rows.
- `contractLinesCoveringDevice` (one device, many lines) and `matchingDevicesForLine` (one line, many devices) are the two transposes of one predicate. W06 owns the first, W07 the second, neither re-implements matching.

## Out of scope

From the roadmap, unchanged:

- **A fleet-wide covered/uncovered column or filter on the devices list.** It cannot filter before pagination without evaluating every group for every page; if wanted it is a batched pre-pagination design under #4606 or the reporting feature.
- **Persisting coverage.** Derived live, every time. W07 persists *evidence per invoice*, a different artefact (a snapshot at generation, not a live answer).
- **Portal exposure** — a #4562 wave.

Added by this spec:

- Draft, paused, cancelled and expired contracts (Decision 4), and any claim about *when* a line will next bill (Decision 4; that is W07's).
- Surfacing an orphaned `per_device_group` line on the device panel (Decision 7).
- Any AI tool change (Decision 11).
- Live device-group names on the coverage rows (the stamped name is used).
- Batch coverage for many devices — deliberately single-device; W07 and #4606 use `matchingDevicesForLine` instead (see Hand-off).
- Seat coverage (`per_seat` bills users, not devices) and monetary fields of any kind.
- Writing `#orgId=` back to the hash from the devices page (the org selector owns the store; a mirror writer would contend for the key).

## Testing

Red first for each unit, then implement.

**Pure helpers — `apps/api/src/services/contractCoverage.test.ts`** (extends W02's file; every W02 case stays green unchanged):
- `coverageMatch` table-driven over one-row snapshots: unscoped `per_device` → `'org'`; site-scoped `per_device` at the device's site → `'site'`, elsewhere → `null`; matching `per_device_role` → `'role'`, **and a site-scoped role line at the device's site also → `'role'`, not `'site'`** (Decision 3, pinned); non-matching role line → `null`; group containing the device → `'group'`; site-bound group with an off-site device → `null`.
- **`unknown` is billable by non-role lines** (roadmap correction): an `unknown`-role device matches an org-wide `per_device` line → `'org'`, matches a group line it belongs to → `'group'`, and never matches a `per_device_role` line.
- `coverageMatch` throws for a role line with no roles, a group line with no id, and a group id absent from the snapshot.
- `DEVICE_COUNTED_LINE_TYPES` ⇔ `isDeviceLine` parity over every `ContractLineType`.

**Membership parity — `apps/api/src/__tests__/integration/groupMembership.parity.integration.test.ts`** (real DB, the mandatory anti-drift test for Decision 1):
- Seed one org with: a static group; a dynamic group on `deviceRole = 'server'`; a dynamic group with a null filter; a site-bound dynamic group; and pinned rows including one off-site pin and one pin that the filter does not match.
- For **every** group × **every** device in the fixture, assert `groupIncludesDevice(group, device) === resolveEffectiveGroupMembers(group) → (matched ∪ pinned).has(device.id)`.
- A malformed non-null filter throws `GroupEvaluationError('invalid_filter')` from **both** functions.
- A membership row forged with another org's `org_id` is invisible to `groupIncludesDevice` (the org-predicated read).
- A pinned device short-circuits: `deviceMatchesFilter` is spied and **not called**.

**Service unit — `apps/api/src/services/deviceCoverage.test.ts`** (Drizzle mocks, the `contractService.test.ts` chained-resolver pattern):
- The three-state invariant as a property over each fixture: `uncovered === (!notBillable && lines.length === 0)`; `notBillable ⇒ lines.length === 0 && !uncovered`.
- Malformed id, missing device, and a device outside `accessibleOrgIds` all → `DEVICE_NOT_FOUND` 404 (never 403, never distinguishable). Malformed id issues **zero** queries.
- `accessibleOrgIds: null` reaches any org.
- `billableDeviceById → null` with `status: 'decommissioned'` → reason `decommissioned`; with `isEphemeral` → `ephemeral`; with **neither** (the concurrent-move race) → `not_billable` **and no throw** (Decision 5 — the explicit replacement for the removed `SNAPSHOT_DISAGREEMENT`).
- `GroupEvaluationError` → `DeviceCoverageError` 500 `GROUP_EVALUATION_FAILED` with `groupId`/`groupName`/`reason`; **the promise rejects, it never resolves with `lines: []`**.
- Any other error propagates unchanged.
- **Query counts** (the Performance section's contract), asserted on `db.select` call counts: not billable → 2 device reads and nothing else; billable, no active contracts → 3 reads, no group query; billable + one static group line → + batch read + 1 membership read + **0** `deviceMatchesFilter`; billable + a dynamic group at **another** site → + batch read + **0** membership reads + **0** `deviceMatchesFilter`.
- Projection: `deviceGroup` carries the stamped name; `deviceRoles` null on non-role lines; `siteId` verbatim.

**Service integration — `apps/api/src/__tests__/integration/deviceCoverage.integration.test.ts`** (real Postgres as `breeze_app`, seeded like W02's `contractDeviceGroups.integration.test.ts`):
- **Headline:** a server that is a member of a billed group *and* matched by a `per_device_role` line lists **both**, `matchedBy: 'group'` and `'role'`, ordered by contract name then `sortOrder`.
- **Cross-check with the contract page (Decision 2):** for one contract, the device appears in `uncoveredByRole(fullSnapshot, lines)`'s tally **iff** no line of that contract is in `contractLinesCoveringDevice(...).lines`. Four fixtures: covered by role, covered by group, uncovered, unknown-role.
- **One-device vs full-org snapshot equivalence (Decision 1, end to end):** for every device in the fixture org, the set of covering line ids from `contractLinesCoveringDevice` equals the set computed by running `coverageMatch` over W02's full `orgSnapshot` — including a site-bound group with an off-site pinned member (the case the builder's site short-circuit skips).
- A `per_device` line scoped to another site does not cover; scoped to the device's site covers with `matchedBy: 'site'`.
- A `draft` contract's line does not cover; flipping it to `active` makes the same device covered.
- A `paused` contract's line does not cover. An `active` contract with `nextBillingAt = NULL` **does** cover (Decision 4: eligible, not imminent).
- A group line whose group was deleted does not cover **and does not throw**; the device reads `uncovered`.
- A malformed dynamic filter → rejects with `GROUP_EVALUATION_FAILED` 500 and `details.groupId` — **never** `uncovered: true`.
- A decommissioned device in an org that also has a malformed group → `notBillable: true` with no throw (the step-3 short-circuit under real data).
- A stale materialized dynamic membership (W02's setup: materialize, then `UPDATE devices SET device_role`) → coverage follows the **live** set.
- Cross-org: a device in org B is `DEVICE_NOT_FOUND` for an actor restricted to org A.

**Route — `apps/api/src/routes/devices/billing.test.ts`** (mirrors `alerts.test.ts`):
- `registeredPermissionCalls` contains **both** `['devices','read']` and `['contracts','read']`.
- The registered scopes are `('partner','system')` — **`'organization'` is absent** (assert on the captured `requireScope` mock args, so a later widening is a test failure).
- `SITE_ACCESS_DENIED` → 403 and `contractLinesCoveringDevice` **not** called.
- Chokepoint `null` → 404 with `{ error, code: 'DEVICE_NOT_FOUND' }`; the service's own `DEVICE_NOT_FOUND` produces the **same body shape**.
- Happy path → 200 with the `{ data }` envelope and the full shape.
- `GROUP_EVALUATION_FAILED` → 500 with `code` and `details`, **and the body has no `lines` key**.
- An unrecognised throw propagates (no swallow into a 200).
- **Mount order:** extend `apps/api/src/routes/devices/index.test.ts` with an assertion that `billingRoutes` is sourced and mounted after `coreRoutes`, matching the existing rollback assertion.

**Web — `apps/web/src/components/contracts/deviceCoverageLinks.test.ts`:**
- Round-trip for **every** `DEVICE_ROLES` value, `'unknown'` included: the `filtersV2=` half decodes via the real `decodeFilterFromHash` to `{ operator: 'AND', conditions: [{ field: 'deviceRole', operator: 'equals', value: role }] }`.
- With an org: the URL is `/devices#orgId=<uuid>&filtersV2=…` and `readOrgIdFromHash` returns that uuid. Without: no `orgId=` fragment, and the filter half still decodes.
- A role outside `DEVICE_ROLES` → `null`.
- With `window` deleted from the test global, output is byte-identical (the isomorphic-encoder guarantee).

**Web — `apps/web/src/components/devices/orgHash.test.ts`:** `readOrgIdFromHash` returns the uuid from either fragment order, ignores a non-uuid value, ignores a missing key, and tolerates a leading `#`.

**Web — `apps/web/src/components/devices/DevicesPage.deepLink.test.tsx`** (new file; item 5's regression test):
- Mounts `DevicesPage` with `window.location.hash = '#orgId=<uuid>&filtersV2=<real encoding>'` and **does not mock `./filterUrl` or `./orgHash`** — the existing suites both stub the decoder (`DevicesPage.test.tsx:100-104`, `DevicesPage.orgScope.test.tsx:48`), so no test proves real hash adoption today.
- Asserts `selectOrganization` was called with the hash uuid **before** the first `/filters/preview` request, and that the request carries that org (the layout-before-passive ordering Decision 9 rests on).
- Asserts the decoded filter reaches `/filters/preview` as the posted `conditions`.
- Asserts the mirror effect (`writeFilterToHash`, `DevicesPage.tsx:677`) **preserves** the `orgId=` fragment — the `filterUrl.ts:49-52` preservation rule, now load-bearing for a third key.

**Web — `apps/web/src/components/devices/filterUrl.test.ts`:** `encodeFilterToHash` returns the same string with and without `window`, for ASCII and for a non-ASCII tag value; the existing decode round-trips still pass.

**Web — `DeviceCoverageNotice.test.tsx`** (extends the existing suite):
- With `orgId`, each bucket renders an anchor whose `href` equals `devicesUrlForRole(role, orgId)`; bucket text and largest-first order unchanged.
- `orgId={null}` → links without the `orgId=` fragment (still useful), never a dead link.
- A rogue role key → plain text for that bucket, links for the others.
- The lead sentence comes from `uncoveredLead` and each bucket from `roleBucket` — assert the rendered text, and that `formatUncoveredBreakdown` is **not** called by the component (it belongs to the toast path now).
- `total === 0` and `null` branches unchanged; `formatUncoveredBreakdown` still returns the joined string for `ContractDetail.tsx:196`.

**Web — `DeviceBillingCard.test.tsx`:**
- **Not rendered at all without `contracts:read`** — no card, and `fetchWithAuth` not called (Decision 8).
- Loading skeleton, then each of the four states from a mocked response.
- Covered: two lines from two contracts render two rows with the right `matchedBy` chips and contract links.
- Uncovered: the "no active contract line" copy plus the role chip.
- Not billable: the decommissioned, ephemeral and generic strings; **no** uncovered copy.
- Error: a 500 with `GROUP_EVALUATION_FAILED` renders the group-named message and a working Retry; **the uncovered copy is absent**. A generic 500 renders the generic message.
- 401 → the login redirect, no card content.

**i18n:** `tr-TR` locale-parity for every new key in all eight locales.

**Manual:** on a seeded stack, open a device billed by a role line and a group line and confirm both rows; decommission it and confirm the not-billable state; break a group's filter and confirm the panel errors rather than saying "not billed"; sign in as an org-scoped user and confirm no card and a 403 from the route; from a contract with uncovered devices in org A while the selector sits on org B, **copy** the "3 Unknown" link, paste it in a new tab, and confirm the list lands on org A filtered to Unknown.

## Rollout

No migration, no schema change, no feature flag, no tenancy or cascade registration (Decision 12). `contractService.ts` is not edited. The `toBase64Url` change (Decision 10) is byte-identical for every existing input and proved so by a test. Everything else is additive: two service exports, one new service, one new route, one new card, one hash key, and links inside an existing notice.

Ship with the next release. Three behaviours worth naming in the release notes so they are not read as bugs:

- The Billing card needs **Contracts read** access and a partner-scoped login; org-scoped users do not see it, matching every other contracts screen.
- The card counts **active** contracts only, so a device covered by a draft contract still reads "no active contract line bills this device" until the contract is activated.
- A deep link from the coverage notice carries its org, so a pasted link switches the recipient's org scope to the contract's org.

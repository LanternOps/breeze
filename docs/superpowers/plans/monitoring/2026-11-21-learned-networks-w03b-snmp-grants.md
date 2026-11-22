# Learned Networks W03b: Saved SNMP Credentials Follow Fingerprints

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A discovery profile's saved SNMP secrets are sent only behind the gateway fingerprints they were entered for, decided by an explicit mode (`unrestricted` or `bound`) and per-fingerprint grants that only a full re-entry or a site's transition into gated can widen.

**Architecture:** Pure predicates classify a save (`isFullSnmpReentry`, `profileWillHoldSnmpSecrets`). DB writers in `services/learnedNetworks/snmpGrants.ts` replace grants on a full re-entry, shrink them on every other save, and bind unrestricted profiles when a site becomes gated (`bindUnrestrictedProfilesOnGating`, called by W03c). The profile create and update handlers take the shared site lock and the profile row lock before reading retained secrets, so destination, secrets, mode and grants commit together in the request transaction. Nothing in this wave can gate a site, so in production it changes no behavior until W03c.

**Tech stack:** Hono, Drizzle on PostgreSQL (forced RLS), Vitest (unit and real-Postgres integration).

**Spec:** `docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md` (§8.3 in full; §8.2 rows 2, 3 and 3a; §15 credential rows).

**Index:** `docs/superpowers/plans/monitoring/2026-11-21-learned-networks.md`. Its Global constraints, Review focus and Cross-wave contract apply to every task here. Names from E1, E5 and E11 are used verbatim.

## Wave constraints

- **Depends on W03a** (merged): `lockSitesForNetworkGate` (E1, `services/learnedNetworks/siteLock.ts`), `evaluateDiscoveryGate` (E5, `gate.ts`), `loadUsableGrantGateways` (E11, already in `snmpGrants.ts`). Consume them only through those signatures. The schema (`discoveryProfileSnmpGrants`, `discoveryProfiles.networkId`, `discoveryProfiles.snmpGrantMode`, `learnedNetworks`, `learnedNetworkGateways`, `sites.discoveryNetworkRequired`) comes from W01a. These files did not exist when this plan was written; open them before relying on a name.
- **No migration, no new table, no new column.** Nothing here touches tenancy registrations.
- **Only the two profile handlers write a profile's destination or secrets.** The other writers of `discovery_profiles` are the baseline worker's auto-created profile (`jobs/networkBaselineWorker.ts:294`), which has no secrets and no `networkId`, and the device org move, which clears only `pinned_device_id` (`services/deviceOrgMove/moveDeviceOrgInTransaction.ts:468`). Neither needs the lock order or the grant rules. The route suites that mock `db` and reach `POST`/`PATCH /profiles` are all in `routes/discovery.test.ts`. The other suites that import the router are integration suites on real Postgres: `discoveryProfilesLastRun`, `topology-*`.
- **Lock order (E1, §8.3):** site locks in ascending id, shared mode, both sites on a move; then the profile row `FOR UPDATE`; retained secrets are read only from that locked row. Every DB write of this wave runs after the last early return of its handler, so the request transaction commits destination, secrets, mode and grants together or not at all. A handler that returns a 4xx without throwing commits an empty transaction; none of the writes may precede such a return.
- **Kept exactly as is:** the retained-secret rejection (`routes/discovery.ts:821-846`, `subnetChangeWouldRetainSnmpSecrets`), its error string, and every existing route test's assertions. Existing tests may only gain rig setup for the new modules.
- **Unaffected:** a profile that holds no secrets, and an `unrestricted` profile on a site that is not gated, save and run exactly as before. The existing tests that show it are listed in Task 3, Step 7.
- **`networkId` rule (§8.3):** it may be set only to a network assigned to the profile's site at save time, and a save that would leave it pointing anywhere else is rejected. This plan reads the sentence literally: every save whose resulting `networkId` is non-null is checked, including a save that does not mention `networkId`. Changing `networkId` never needs a secret re-entry, because grants are only ever added by rule 1 or rule 2.
- **Credential tests assert that the secrets are not sent:** each drives `evaluateDiscoveryGate` for the profile and asserts the decision (`unrestricted`, `guarded` with an exact fingerprint set, or `fail` with `credentials_need_reentry`). A grants-table assertion alone is never the proof.
- **Fixtures:** only the index's synthetic values. Five sites in one org:
  - **A** (gated): `N_A` = `192.168.1.0/24` via `192.168.1.1`, MAC `a4:2b:b0:11:22:9c` (gateway `G_A`); `N_A2` = `10.1.2.0/24` via `10.1.2.100`, MAC `00:1a:8c:00:00:01` (`G_A2`).
  - **B** (gated): `N_B` = `192.168.1.0/24` via `192.168.1.1`, MAC `3c:37:86:aa:bb:10` (`G_B`).
  - **C** (not gated): `N_C`, unassigned, `192.168.1.0/24` via `192.168.1.1`, MAC `00:1a:8c:00:00:01` (`G_C`).
  - **D**: not gated, no network.
  - **E**: gated, no network.

  A second org holds one network for the cross-org case. Plaintexts are `public-a` and `public-b`; the v3 user is `poller`. `setup.ts` truncates before each test, so every test rebuilds this fixture.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `apps/api/src/services/snmpSecrets.ts` | Modify `:6` | Export the secret key set as `SNMP_SECRET_FIELD_NAMES` (alias of `SECRET_FIELD_NAMES`) so the predicates walk the same keys the merge helpers do. |
| `apps/api/src/services/learnedNetworks/snmpGrants.ts` | Modify (W03a created it) | Secret-state model, predicates, grant writers, `assertProfileNetworkAssignable`, `bindUnrestrictedProfilesOnGating`. |
| `apps/api/src/services/learnedNetworks/snmpGrants.test.ts` | Create or extend | Pure predicate tests, including T3. |
| `apps/api/src/services/learnedNetworks/profileSaveLock.ts` | Create | `lockProfileForSave`: the lock order for profile writers, in one place. |
| `apps/api/src/routes/discovery.ts` | Modify `:405-453`, `:654-713`, `:773-979` | `networkId` on both schemas; lock, rule checks and grant write in create and update. |
| `apps/api/src/routes/discovery.test.ts` | Modify | Rig for the new modules; new describe for the W03b wiring. |
| `apps/api/src/__tests__/integration/discoverySnmpGrants.integration.test.ts` | Create | S3, S4, S5, T1, T2a, T4 and rule 2 on real Postgres. |
| `apps/api/src/services/snmpSecrets.ts` `storedProfileHoldsSnmpSecrets` (W03a) | Reuse | `profileWillHoldSnmpSecrets` delegates to it, so the gate (`gateProfileFromRow`) and the grant rules share one definition (Contract notes, item 1). |

---

### Task 1: The secret-state model and the full re-entry predicate

**Files:**
- Modify: `apps/api/src/services/snmpSecrets.ts:6`
- Modify: `apps/api/src/services/learnedNetworks/snmpGrants.ts`
- Test: `apps/api/src/services/learnedNetworks/snmpGrants.test.ts`

**Interfaces:**
- Consumes: `isMaskedSnmpSecret` (`snmpSecrets.ts:22`), `SNMP_SECRET_FIELD_NAMES` (new export), `storedProfileHoldsSnmpSecrets` (`snmpSecrets.ts`, W03a), `gateProfileFromRow` (`gate.ts`, W03a).
- Produces:

```ts
/** What a profile stores. Communities: discovery_profiles.snmp_communities (ciphertexts, positional).
 *  Credentials: discovery_profiles.snmp_credentials (jsonb; secret leaves are ciphertexts under
 *  SNMP_SECRET_FIELD_NAMES keys, at any depth, possibly in arrays). A secret is HELD when its
 *  stored value is a non-empty string. */
export type SnmpSecretState = { communities: readonly string[]; credentials: unknown };
/** The request body. undefined = field omitted (column untouched, every stored secret in it retained).
 *  credentials null = cleared. Entry/leaf semantics are exactly mergeEncryptSnmpCommunities and
 *  mergeEncryptSnmpCredentials: a masked entry retains the stored value at the same index/key (or
 *  nothing, if none is stored there); a non-empty plaintext is fresh; '' is dropped; a leaf key
 *  omitted inside a supplied credentials object is dropped, not retained. */
export type SnmpSecretPatch = { communities?: readonly string[]; credentials?: unknown };
export const EMPTY_SNMP_SECRET_STATE: SnmpSecretState; // { communities: [], credentials: null }
export function profileWillHoldSnmpSecrets(next: SnmpSecretState): boolean;
export function isFullSnmpReentry(input: { existing: SnmpSecretState; incoming: SnmpSecretPatch }): boolean;
export function snmpPatchSuppliesSecret(incoming: SnmpSecretPatch): boolean; // any fresh plaintext secret
```

- [ ] **Step 1: Write the failing tests**

```ts
import { MASKED_SNMP_SECRET as M } from '../snmpSecrets';
const V3_STORED = { version: 'v3', username: 'poller', authPassphrase: 'enc:a1', privacyPassphrase: 'enc:p1' };
const V3_FRESH = { version: 'v3', username: 'poller', authPassphrase: 'auth-b', privacyPassphrase: 'priv-b' };
const STORED: SnmpSecretState = { communities: ['enc:c1'], credentials: V3_STORED };

describe('T3 full re-entry table', () => {
  it.each<[string, SnmpSecretState, SnmpSecretPatch, boolean]>([
    ['all fresh', STORED, { communities: ['public-b'], credentials: V3_FRESH }, true],
    ['one masked', STORED, { communities: ['public-b'], credentials: { ...V3_FRESH, privacyPassphrase: M } }, false],
    ['one masked community beside a fresh one', { ...STORED, communities: ['enc:c1', 'enc:c2'] },
      { communities: ['public-b', M], credentials: V3_FRESH }, false],
    ['a field omitted while a stored value is retained', STORED, { communities: ['public-b'] }, false],
    ['secrets cleared', STORED, { communities: [], credentials: null }, false],
    ['v3 only', { communities: [], credentials: V3_STORED }, { credentials: V3_FRESH }, true],
    ['community only', { communities: ['enc:c1'], credentials: null }, { communities: ['public-b'] }, true],
    ['create', EMPTY_SNMP_SECRET_STATE, { communities: ['public-a'], credentials: V3_FRESH }, true],
    ['create without secrets', EMPTY_SNMP_SECRET_STATE, {}, false],
    ['masked entry with nothing stored at its index', { communities: [], credentials: null },
      { communities: ['public-b', M] }, true],
    ['v3 leaf omitted inside the supplied object (it clears)', { communities: [], credentials: V3_STORED },
      { credentials: { version: 'v3', username: 'poller', authPassphrase: 'auth-b' } }, true],
  ])('%s', (_name, existing, incoming, expected) => {
    expect(isFullSnmpReentry({ existing, incoming })).toBe(expected);
  });
});

describe('profileWillHoldSnmpSecrets', () => {
  it.each<[string, SnmpSecretState, boolean]>([
    ['nothing', EMPTY_SNMP_SECRET_STATE, false],
    ['empty strings only', { communities: [''], credentials: { version: 'v3', authPassphrase: '' } }, false],
    ['community', { communities: ['enc:c1'], credentials: null }, true],
    ['v3 only, nested in an array', { communities: [], credentials: [{ authPassphrase: 'enc:a1' }] }, true],
    ['non-secret keys only', { communities: [], credentials: { version: 'v3', username: 'poller' } }, false],
  ])('%s', (_n, state, expected) => expect(profileWillHoldSnmpSecrets(state)).toBe(expected));
});

it('snmpPatchSuppliesSecret is true for one fresh leaf among masks and false for masks only', () => {
  expect(snmpPatchSuppliesSecret({ communities: [M], credentials: { ...V3_FRESH, authPassphrase: M } })).toBe(true);
  expect(snmpPatchSuppliesSecret({ communities: [M], credentials: { authPassphrase: M } })).toBe(false);
  expect(snmpPatchSuppliesSecret({})).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/learnedNetworks/snmpGrants.test.ts`
Expected: FAIL, `isFullSnmpReentry` (and the other two) not exported.

- [ ] **Step 3: Implement in `snmpGrants.ts`**

`isFullSnmpReentry` is pure and never encrypts or decrypts. It walks the post-save secret set with the merge helpers' retention rules and answers `false` as soon as one held secret was not fresh plaintext in `incoming`; it answers `false` when nothing will be held (a save that holds no secret re-entered nothing). Communities: omitted means each non-empty stored entry is retained; supplied means index `i` is retained iff the entry is masked and `existing.communities[i]` is non-empty. Credentials: omitted means every non-empty stored leaf is retained; `null` means none held; supplied means a parallel walk of `incoming` against `existing` by key (and by index inside arrays), where a masked leaf is retained iff the stored leaf at the same path is non-empty. Do not reuse `subnetChangeWouldRetainSnmpSecrets`; it answers a different question and returns early. Do not write the eight-asterisk literal in this non-test file (it would trip `credentialOriginBindingCoverage.test.ts`); use `isMaskedSnmpSecret`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/learnedNetworks/snmpGrants.test.ts src/services/snmpSecrets.test.ts src/__tests__/credentialOriginBindingCoverage.test.ts`
Expected: PASS.

- [ ] **Step 5: One definition of "holds secrets"**

`profileWillHoldSnmpSecrets(next)` is `storedProfileHoldsSnmpSecrets({ snmpCommunities: [...next.communities], snmpCredentials: next.credentials })` (W03a, `services/snmpSecrets.ts`), which W03a's `gateProfileFromRow` already uses for `GateProfile.hasSavedSnmpSecrets`. Add to `snmpGrants.test.ts`: for every row of the `profileWillHoldSnmpSecrets` table, `gateProfileFromRow({ ...ROW, snmpCommunities, snmpCredentials }).hasSavedSnmpSecrets` equals the expected value (the v3-only row included). Run it and see it pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/snmpSecrets.ts apps/api/src/services/learnedNetworks/snmpGrants.ts apps/api/src/services/learnedNetworks/snmpGrants.test.ts
git commit -m "feat(api): SNMP secret-state model and full re-entry predicate for learned networks"
```

---

### Task 2: Grant writers and rule 2

**Files:**
- Modify: `apps/api/src/services/learnedNetworks/snmpGrants.ts`
- Test: `apps/api/src/__tests__/integration/discoverySnmpGrants.integration.test.ts` (create; this task adds the fixture and the service-level tests)

**Interfaces:**
- Consumes: Task 1; W01a schema exports; `evaluateDiscoveryGate` (E5); `lockSitesForNetworkGate` (E1).
- Produces (E11, verbatim, plus one error class):

```ts
export async function freshGrantSet(input: { orgId: string; siteId: string; networkId: string | null }):
  Promise<{ mode: 'unrestricted' | 'bound'; gatewayIds: string[] }>;
export async function applySnmpGrantRulesOnSave(input: {
  orgId: string; profileId: string; siteId: string; networkId: string | null;
  fullReentry: boolean; suppliedAnySecret: boolean; willHoldSecrets: boolean; actorUserId: string;
}): Promise<void>;
export class ProfileNetworkNotAssignableError extends Error { readonly code = 'NETWORK_NOT_ASSIGNABLE'; }
export async function assertProfileNetworkAssignable(input: { orgId: string; siteId: string; networkId: string | null }): Promise<void>;
export async function bindUnrestrictedProfilesOnGating(input: {
  orgId: string; siteId: string; networkId: string; actorUserId: string;
}): Promise<number>;
```

Behavior, decided here:

- `freshGrantSet`: site not gated → `{ mode: 'unrestricted', gatewayIds: [] }`. Gated → `{ mode: 'bound', gatewayIds }`, the ids of every `learned_network_gateways` row whose network has `site_id = siteId` (and `id = networkId` when set), in the org, sorted. A gated site with no assigned network, or a `networkId` not assigned to it, gives `bound` with `[]`.
- `applySnmpGrantRulesOnSave`:
  - `willHoldSecrets` false → no write. A profile holding nothing can only gain secrets through a save that is a full re-entry, which replaces whatever it held.
  - `fullReentry` (rule 1) → delete the profile's grants, insert `freshGrantSet(...)` with `granted_by = actorUserId`, `granted_at = now()`, set `snmp_grant_mode` to its mode.
  - Otherwise (rule 4, and a save that supplies no secret) → never insert, never change the mode; delete the grants not effective for the profile as saved. **Effective for the profile as saved** is exactly:

```sql
DELETE FROM discovery_profile_snmp_grants g
 WHERE g.org_id = $org AND g.profile_id = $profile
   AND NOT EXISTS (
     SELECT 1 FROM learned_network_gateways lg
       JOIN learned_networks ln ON ln.id = lg.network_id AND ln.org_id = lg.org_id
      WHERE lg.id = g.gateway_id AND lg.org_id = g.org_id
        AND ln.site_id = $siteId                       -- the profile's site after the save
        AND ($networkId::uuid IS NULL OR ln.id = $networkId))  -- its network_id after the save
```

  - Throw if `fullReentry && !suppliedAnySecret` (a caller bug).
- `assertProfileNetworkAssignable`: `networkId` null → return. Otherwise a `learned_networks` row with that id, `org_id = orgId` and `site_id = siteId` must exist, else throw `ProfileNetworkNotAssignableError` with message `Choose a network that is assigned to this profile's site.` The query succeeds and the throw is an application error, so the caller's catch needs no savepoint; it must rethrow anything else.
- `bindUnrestrictedProfilesOnGating` (rule 2). The caller holds the exclusive site lock and has already set the site flag and assigned the network. Lock the site's `unrestricted` profiles `FOR UPDATE ORDER BY id`. Keep those for which `profileWillHoldSnmpSecrets` is true. Set each to `bound`. Insert grants for the fingerprints of `networkId` only when the profile's `network_id` is null or equals `networkId`; a profile pointed at another network gets no grants. Return the number of profiles changed. Profiles without secrets and already-`bound` profiles are untouched.

- [ ] **Step 1: Write the failing integration tests**

Fixture (top of the file, reused by Tasks 4 and 5): `createIntegrationTestClient(app)` with `app.route('/discovery', discoveryRoutes)`, then sites B to E (`createSite`), the second org, and the networks in "Wave constraints". Insert them with the admin handle (`getTestDb()`). **Set `sites.discovery_network_required = true` before setting `learned_networks.site_id`**; the W01a A6 triggers refuse the reverse order. Helpers:

```ts
// Reads the live profile, builds GateProfile with W03a's gateProfileFromRow, and evaluates
// under the shared site lock in the org's RLS context.
async function gateFor(profileId: string): Promise<GateDecision>;
const allowed = (d: GateDecision) => d.kind === 'guarded' ? d.allowed.map((g) => g.gatewayId).sort() : d.kind === 'fail' ? d.error.code : d.kind;
async function grantRows(profileId: string): Promise<string[]>;      // gateway ids, sorted
async function storedCommunities(profileId: string): Promise<string[]>; // decryptSnmpCommunities
```

```ts
it('rule 2 binds unrestricted credentialed profiles to the gating network', async () => {
  // site C (not gated): P1 (secrets, unrestricted), P2 (no secrets), P3 (secrets, bound, no grants; admin insert)
  await gateSiteAndAssign(siteC, N_C);                 // flag true, then site_id, in one system-context tx
  const n = await inSystemTx(() => bindUnrestrictedProfilesOnGating({ orgId, siteId: siteC, networkId: N_C, actorUserId }));
  expect(n).toBe(1);
  expect(allowed(await gateFor(P1))).toEqual([G_C]);
  expect(allowed(await gateFor(P3))).toBe('credentials_need_reentry');
  expect((await profileRow(P2)).snmpGrantMode).toBe('unrestricted');
});
it('rule 1 on a site that is not gated leaves the profile unrestricted with no grants', async () => {
  const id = await createProfile({ siteId: siteD, snmpCommunities: ['public-a'] });   // via POST in Task 3
  expect((await profileRow(id)).snmpGrantMode).toBe('unrestricted');
  expect(await grantRows(id)).toEqual([]);
  expect(allowed(await gateFor(id))).toBe('unrestricted');
});
it('a profile created with secrets on a gated site with no network is bound with no grants', async () => {
  const id = await createProfile({ siteId: siteE, snmpCommunities: ['public-a'] });
  expect((await profileRow(id)).snmpGrantMode).toBe('bound');
  expect(allowed(await gateFor(id))).toBe('credentials_need_reentry');
});
```

The second and third tests go red until Task 3 wires create; write them now so Task 3 has its red.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test-stack up`, then `pnpm --filter @breeze/api test:integration src/__tests__/integration/discoverySnmpGrants.integration.test.ts`
Expected: FAIL, `bindUnrestrictedProfilesOnGating` not exported.

- [ ] **Step 3: Implement the five exports in `snmpGrants.ts`**

All of them use the ambient `db` and require a held context (`assertInTransaction`). None opens a savepoint.

- [ ] **Step 4: Run to verify the rule 2 test passes**

Run the same command. Expected: `rule 2 binds…` PASS; the two create tests still FAIL (Task 3).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/learnedNetworks/snmpGrants.ts apps/api/src/__tests__/integration/discoverySnmpGrants.integration.test.ts
git commit -m "feat(api): SNMP grant writers and rule 2 binding for learned networks"
```

---

### Task 3: Wire the profile create and update handlers

**Files:**
- Create: `apps/api/src/services/learnedNetworks/profileSaveLock.ts`
- Modify: `apps/api/src/routes/discovery.ts` (`createProfileSchema` `:405`, `updateProfileSchema` `:428`, create `:654-713`, update `:773-979`)
- Test: `apps/api/src/routes/discovery.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2; `lockSitesForNetworkGate` (E1).
- Produces:

```ts
export type LockedProfileForSave = {
  id: string; orgId: string; siteId: string; networkId: string | null; snmpGrantMode: 'unrestricted' | 'bound';
  subnets: string[] | null; excludeIps: string[] | null; snmpCommunities: string[] | null; snmpCredentials: unknown;
  deepScan: boolean | null; pinnedDeviceId: string | null;
};
/** Shared site locks for every id in siteIds (deduplicated, ascending), then
 *  SELECT … FROM discovery_profiles WHERE id = $profileId AND org_id = $orgId FOR UPDATE.
 *  Null when the row is gone. Must run inside the request transaction. */
export async function lockProfileForSave(input: {
  orgId: string; profileId: string; siteIds: readonly string[];
}): Promise<LockedProfileForSave | null>;
```

Both schemas gain `networkId: z.string().guid().nullable().optional()`.

**Create handler, in order** (insertion points in the existing handler):
1. After the pin check (`:673-676`): `await lockSitesForNetworkGate([body.siteId], 'shared')`.
2. Then `assertProfileNetworkAssignable({ orgId, siteId: body.siteId, networkId: body.networkId ?? null })`; on `ProfileNetworkNotAssignableError` return `400 { error: err.message, code: 'NETWORK_NOT_ASSIGNABLE' }`.
3. The insert (`:678`) also writes `networkId: body.networkId ?? null`.
4. After the insert, before `writeRouteAudit` (`:700`): `applySnmpGrantRulesOnSave({ …, profileId: profile.id, siteId: profile.siteId, networkId: profile.networkId, fullReentry: isFullSnmpReentry({ existing: EMPTY_SNMP_SECRET_STATE, incoming: { communities: body.snmpCommunities, credentials: body.snmpCredentials } }), suppliedAnySecret: snmpPatchSuppliesSecret(…same incoming…), willHoldSecrets: profileWillHoldSnmpSecrets({ communities: profile.snmpCommunities ?? [], credentials: profile.snmpCredentials }), actorUserId: auth.user.id })`.

**Update handler, in order:**
1. The unlocked read at `:791-802` keeps its select. It serves the 404, the site-access check (`:804`) and the lock set only.
2. Directly after the site-access check: `const locked = await lockProfileForSave({ orgId: existing.orgId, profileId, siteIds: [existing.siteId, ...(updates.siteId ? [updates.siteId] : [])] })`. Null → 404. `locked.siteId !== existing.siteId` → `409 { error: 'This profile changed while it was being saved. Reload it and try again.', code: 'PROFILE_CHANGED' }`. The locks were taken for the sites the request saw, so a profile moved in between cannot be saved under them.
3. From here on every read of the stored profile uses `locked`: the oversized-subnet check (`:810-816`), `siteChanged` (`:818`), the retained-secret rejection (`:827-843`, unchanged apart from reading `locked`), the site-move target (`:849-863`), the pin check (`:872-884`), and both merge calls (`:894-895`).
4. After the pin check: `assertProfileNetworkAssignable({ orgId: locked.orgId, siteId: effectiveSiteId, networkId: updates.networkId !== undefined ? updates.networkId : locked.networkId })`, same 400 mapping. `setValues.networkId` is set when `updates.networkId !== undefined`.
5. After `if (!updated) return …500` (`:955-957`), before `writeRouteAudit` (`:959`): `applySnmpGrantRulesOnSave({ orgId: updated.orgId, profileId: updated.id, siteId: updated.siteId, networkId: updated.networkId, fullReentry: isFullSnmpReentry({ existing: { communities: locked.snmpCommunities ?? [], credentials: locked.snmpCredentials }, incoming: { communities: updates.snmpCommunities, credentials: updates.snmpCredentials } }), suppliedAnySecret: snmpPatchSuppliesSecret(…), willHoldSecrets: profileWillHoldSnmpSecrets({ communities: updated.snmpCommunities ?? [], credentials: updated.snmpCredentials }), actorUserId: auth.user.id })`. This is after the asset-move branch's catch (`:942-948`), so no early return follows a grant write.

- [ ] **Step 1: Rig the existing tests**

In `routes/discovery.test.ts`, mock `../services/learnedNetworks/siteLock` (`lockSitesForNetworkGate` resolves), `../services/learnedNetworks/snmpGrants` (spread `importOriginal` so the pure predicates and the error class stay real; `applySnmpGrantRulesOnSave` and `assertProfileNetworkAssignable` resolve) and `../services/learnedNetworks/profileSaveLock`. `lockProfileForSave` resolves the same row the test's existing `mockProfileLookup(profile)` supplies: extend that helper to set both. No existing assertion changes.

- [ ] **Step 2: Write the failing route tests** (new `describe('W03b profile saves: lock order and SNMP grants')`)

```ts
it('reads retained secrets from the locked row, not the unlocked read', async () => {
  mockUnlocked({ ...PROFILE, snmpCommunities: [], snmpCredentials: null });
  mockLocked({ ...PROFILE, snmpCommunities: ['enc:v1:mock-community'] });
  const res = await patch({ siteId: SITE_B });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: 'Adding or changing subnets requires re-entering the SNMP credentials, or clearing them' });
  expect(db.update).not.toHaveBeenCalled();
});
it('locks both sites of a move before the profile row', async () => {
  await patch({ siteId: SITE_B, snmpCommunities: ['public-b'] });
  expect(lockProfileForSave).toHaveBeenCalledWith({ orgId: ORG, profileId: PROFILE_ID, siteIds: [SITE, SITE_B] });
});
it('returns 409 PROFILE_CHANGED when the locked row is on another site', async () => {
  mockLocked({ ...PROFILE, siteId: SITE_B });
  const res = await patch({ name: 'renamed' });
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe('PROFILE_CHANGED');
  expect(db.update).not.toHaveBeenCalled();
  expect(applySnmpGrantRulesOnSave).not.toHaveBeenCalled();
});
it('maps a refused networkId to 400 NETWORK_NOT_ASSIGNABLE without writing', async () => {
  vi.mocked(assertProfileNetworkAssignable).mockRejectedValueOnce(new ProfileNetworkNotAssignableError('x'));
  const res = await patch({ networkId: NETWORK_ID });
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe('NETWORK_NOT_ASSIGNABLE');
  expect(db.update).not.toHaveBeenCalled();
});
it('checks a stored networkId against the destination of a site move', async () => {
  mockLocked({ ...PROFILE, networkId: NETWORK_ID, snmpCommunities: [] });
  await patch({ siteId: SITE_B });
  expect(assertProfileNetworkAssignable).toHaveBeenCalledWith({ orgId: ORG, siteId: SITE_B, networkId: NETWORK_ID });
});
it('passes the save classification to applySnmpGrantRulesOnSave after the update', async () => {
  mockLocked({ ...PROFILE, snmpCommunities: ['enc:c1'], snmpCredentials: null });
  mockProfileUpdate({ ...PROFILE, snmpCommunities: ['enc:new'], networkId: null });
  await patch({ snmpCommunities: ['public-b'] });
  expect(applySnmpGrantRulesOnSave).toHaveBeenCalledWith(expect.objectContaining({
    profileId: PROFILE_ID, siteId: SITE, networkId: null, fullReentry: true, suppliedAnySecret: true, willHoldSecrets: true,
  }));
});
it('create takes the shared site lock and applies rule 1 for a create with secrets', async () => {
  await post({ ...VALID_CREATE, snmpCommunities: ['public-a'] });
  expect(lockSitesForNetworkGate).toHaveBeenCalledWith([SITE], 'shared');
  expect(applySnmpGrantRulesOnSave).toHaveBeenCalledWith(expect.objectContaining({ fullReentry: true }));
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/discovery.test.ts`
Expected: the seven new tests FAIL; every existing test PASSES.

- [ ] **Step 4: Implement `profileSaveLock.ts` and the handler changes above**

- [ ] **Step 5: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/discovery.test.ts src/services/learnedNetworks/snmpGrants.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the two create tests from Task 2**

Run: `pnpm --filter @breeze/api test:integration src/__tests__/integration/discoverySnmpGrants.integration.test.ts`
Expected: PASS.

- [ ] **Step 7: Confirm the unaffected paths**

Run: `cd apps/api && npx vitest run src/routes/discovery.test.ts src/services/snmpSecrets.test.ts`, then `pnpm --filter @breeze/api test:integration src/__tests__/integration/discoveryProfilePinnedDevice.integration.test.ts src/__tests__/integration/discoveryProfileDeleteFk.integration.test.ts src/__tests__/integration/discoveryProfilesLastRun.integration.test.ts`.
Expected: PASS, with these existing tests unchanged: `describe('PATCH /profiles/:id SNMP credential origin binding')` (`discovery.test.ts:3410`, every case), `POST /discovery/profiles › encrypts and masks SNMP profile secrets` (`:1667`), `describe('PATCH /profiles/:id siteId (profile site move)')` (`:3192`), and the pinned-device cases (`:3713-3857`).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/learnedNetworks/profileSaveLock.ts apps/api/src/routes/discovery.ts apps/api/src/routes/discovery.test.ts
git commit -m "feat(api): profile saves lock sites then the profile and commit SNMP grants with the secrets"
```

---

### Task 4: Credential sequences S3, S5, T1, T2a on real Postgres

**Files:**
- Test: `apps/api/src/__tests__/integration/discoverySnmpGrants.integration.test.ts`

**Interfaces:**
- Consumes: the Task 2 fixture and helpers; the routes from Task 3 through the integration client. `setupTestEnvironment` mints `mfa: false`; if the integration env enforces `ENABLE_2FA`, mint the fixture token with `mfa: true` via `createAccessToken`.

Starting state for each test, unless it says otherwise: profile P on site A, created through `POST /discovery/profiles` with `snmpCommunities: ['public-a']` and `snmpCredentials: { version: 'v3', username: 'poller', authPassphrase: 'auth-a', privacyPassphrase: 'priv-a' }`, so it is `bound` with grants on `G_A` and `G_A2`.

- [ ] **Step 1: Write the failing tests**

```ts
it('S3 partial entry grants nothing', async () => {
  await setNetworkIdDirect(P, N_A);                 // admin: P narrowed, grants already {G_A}
  await shrinkGrantsDirect(P, [G_A]);
  const res = await client.patch(`/discovery/profiles/${P}`, {
    snmpCommunities: ['public-b'],
    snmpCredentials: { version: 'v3', username: 'poller', authPassphrase: M, privacyPassphrase: M },
    networkId: null,                                 // widen the narrowing in the same save
  });
  expect(res.status).toBe(200);
  expect(allowed(await gateFor(P))).toEqual([G_A]);  // never G_A2
  expect(await storedCommunities(P)).toEqual(['public-b']);
});
it('S5 grants come from the profile as saved', async () => {
  await client.patch(`/discovery/profiles/${P}`, { networkId: N_A, snmpCommunities: [M] }); // shrink to G_A
  const res = await client.patch(`/discovery/profiles/${P}`, {
    networkId: N_A2, snmpCommunities: ['public-b'], snmpCredentials: null,          // full re-entry
  });
  expect(res.status).toBe(200);
  expect(allowed(await gateFor(P))).toEqual([G_A2]); // not G_A, not both
  const moved = await client.patch(`/discovery/profiles/${P}`, {
    siteId: siteB, networkId: null, snmpCommunities: ['public-a'], snmpCredentials: null,
  });
  expect(moved.status).toBe(200);
  expect(allowed(await gateFor(P))).toEqual([G_B]);
});
it('T1 partial rotation shrinks grants', async () => {
  const narrowed = await client.patch(`/discovery/profiles/${P}`, {
    networkId: N_A, snmpCommunities: ['public-b'],
    snmpCredentials: { version: 'v3', username: 'poller', authPassphrase: M, privacyPassphrase: M },
  });
  expect(narrowed.status).toBe(200);
  expect(allowed(await gateFor(P))).toEqual([G_A]);
  const widened = await client.patch(`/discovery/profiles/${P}`, { networkId: null, snmpCommunities: ['public-a'],
    snmpCredentials: { version: 'v3', username: 'poller', authPassphrase: M, privacyPassphrase: M } });
  expect(widened.status).toBe(200);
  expect(allowed(await gateFor(P))).toEqual([G_A]);  // the secret supplied while narrowed never reaches N_A2
});
it("T2a save rejects a network not assigned to the profile's site", async () => {
  for (const networkId of [N_B, unassignedNetwork, otherOrgNetwork]) {
    const res = await client.patch(`/discovery/profiles/${P}`, { networkId, snmpCommunities: ['public-b'], snmpCredentials: null });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('NETWORK_NOT_ASSIGNABLE');
  }
  await client.patch(`/discovery/profiles/${P}`, { networkId: N_A, snmpCommunities: [M] });
  const leftBehind = await client.patch(`/discovery/profiles/${P}`, { siteId: siteB, snmpCommunities: ['public-b'], snmpCredentials: null });
  expect(leftBehind.status).toBe(400);
  expect((await profileRow(P)).siteId).toBe(siteA);
  expect(await storedCommunities(P)).toEqual(['public-a']);
  expect(allowed(await gateFor(P))).toEqual([G_A]);   // G_B never allowed
});
```

- [ ] **Step 2: Run to verify each goes red without its rule**

Run: `pnpm --filter @breeze/api test:integration src/__tests__/integration/discoverySnmpGrants.integration.test.ts`
These four pass once Task 3 is in, so prove each discriminates. Change one line at a time, see the named test fail, and revert:
- S3 and T1: make the non-full branch of `applySnmpGrantRulesOnSave` insert `freshGrantSet`.
- S5: union the fresh set with the existing grants.
- T2a: make `assertProfileNetworkAssignable` return early.
Record each red in the PR body.

- [ ] **Step 3: Run to verify they pass** (same command). Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/discoverySnmpGrants.integration.test.ts
git commit -m "test(api): credential sequences S3 S5 T1 T2a send secrets only behind granted fingerprints"
```

---

### Task 5: Concurrency, S4 and T4

**Files:**
- Test: `apps/api/src/__tests__/integration/discoverySnmpGrants.integration.test.ts`

**Interfaces:**
- Consumes: `lockProfileForSave` (Task 3), `lockSitesForNetworkGate` (E1), `bindUnrestrictedProfilesOnGating` (Task 2).

Determinism follows `networkIsolationLifecycleLockOrder.integration.test.ts`:
- Each request runs on its own pooled connection inside its own request transaction.
- A barrier is a wrapped seam: `vi.mock('../../services/learnedNetworks/profileSaveLock', async (orig) => ({ ...await orig(), lockProfileForSave: vi.fn((await orig()).lockProfileForSave) }))`. Its `mockImplementationOnce` calls the real function, records `pg_backend_pid()`, signals `locked`, and awaits `release`.
- An ordering point is proven by Postgres, never by a sleep: `waitBlockedBy(blockerPid, kind)` polls `pg_stat_activity` for a backend with `blockerPid = ANY(pg_blocking_pids(pid))`, where `kind` is `'advisory'` (`wait_event = 'advisory'`) or `'row'` (`wait_event_type = 'Lock'` and `wait_event IN ('transactionid','tuple')`). Bound every wait with 10 s, and always drain both requests with `Promise.allSettled` in `finally`.
- Every test asserts that no outcome carries SQLSTATE `40P01`.

- [ ] **Step 1: Write the failing tests**

```ts
// X = masked save: PATCH { name: 'renamed', snmpCommunities: [M] } (credentials omitted, retained).
// Y = move: PATCH { siteId: siteB, snmpCommunities: ['public-b'], snmpCredentials: null } (full re-entry).
describe("S4 concurrent saves never pair one save's secrets with another's grants", () =>
  it.each(['mover first', 'masked save first'] as const)('%s', async (order) => {
    const first = order === 'mover first' ? moveY : maskedX;
    const second = order === 'mover first' ? maskedX : moveY;
    const barrier = pauseNextProfileLock();                 // wraps lockProfileForSave once
    const a = first(); await barrier.locked;
    const b = second(); await waitBlockedBy(barrier.pid, 'row');
    barrier.release();
    const [ra, rb] = await Promise.allSettled([a, b]);
    expectNo40P01(ra, rb);
    if (order === 'mover first') expect(await statusOf(rb)).toBe(409);   // X saw site A, row is now on B
    expect(await storedCommunities(P)).toEqual(['public-b']);
    expect((await profileRow(P)).siteId).toBe(siteB);
    expect(allowed(await gateFor(P))).toEqual([G_B]);       // never 'public-a' behind G_B
  }));

// P1 (secrets, unrestricted) on C moves to D; P2 (secrets, unrestricted) on D moves to C; both with fresh secrets.
// A third transaction (the exclusive participant) gates site C while both saves wait.
it('T4 opposing moves do not deadlock', async () => {
  const participant = holdExclusive([siteC, siteD]);        // system tx: lockSitesForNetworkGate(…,'exclusive'), signal, await release,
                                                            // then flag C, assign N_C, bindUnrestrictedProfilesOnGating(C, N_C)
  await participant.locked;
  const s1 = moveProfile(P1, siteD, 'public-b'); const s2 = moveProfile(P2, siteC, 'public-b');
  await waitBlockedCount(participant.pid, 'advisory', 2);
  // Neither save holds a profile row while it waits on a site lock:
  await expect(getTestDb().transaction((tx) => tx.execute(sql`
    SELECT id FROM discovery_profiles WHERE id IN (${P1}, ${P2}) FOR UPDATE NOWAIT`))).resolves.toBeDefined();
  participant.release();
  const outcomes = await Promise.allSettled([participant.done, s1, s2]);
  expectNo40P01(...outcomes);
  expect(await statuses(s1, s2)).toEqual([200, 200]);
  expect(allowed(await gateFor(P1))).toBe('unrestricted'); // D is not gated
  expect(allowed(await gateFor(P2))).toEqual([G_C]);       // C gated before P2 arrived; full re-entry binds it
});
```

- [ ] **Step 2: Run to verify they fail for the right reason**

Run: `pnpm --filter @breeze/api test:integration src/__tests__/integration/discoverySnmpGrants.integration.test.ts`
Each test needs a red before it is trusted. Revert each change after seeing it.
- **S4:** move the retained-secret read and the merge back to the unlocked row (`existing`), and drop the `PROFILE_CHANGED` check. In `mover first`, X then writes `public-a` onto a profile Y moved to site B. The gate assertion fails: `public-a` stored with `[G_B]` allowed.
- **T4:** swap the order inside `lockProfileForSave`, taking the row first and the site locks second. The `NOWAIT` statement fails with `55P03`. Without that check, the participant's `bindUnrestrictedProfilesOnGating` and the save holding P1 deadlock (`40P01`).

- [ ] **Step 3: Run to verify they pass** (same command, three consecutive runs). Expected: PASS each time.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/discoverySnmpGrants.integration.test.ts
git commit -m "test(api): S4 and T4 prove the profile save lock order on real Postgres"
```

---

## Done when

- [ ] `cd apps/api && npx vitest run src/services/learnedNetworks/snmpGrants.test.ts src/routes/discovery.test.ts src/services/snmpSecrets.test.ts src/__tests__/credentialOriginBindingCoverage.test.ts` passes (file count 4, no skipped test).
- [ ] `pnpm test-stack up`, then `pnpm --filter @breeze/api test:integration src/__tests__/integration/discoverySnmpGrants.integration.test.ts src/__tests__/integration/discoveryProfilePinnedDevice.integration.test.ts src/__tests__/integration/discoveryProfileDeleteFk.integration.test.ts src/__tests__/integration/discoveryProfilesLastRun.integration.test.ts` passes. The output lists S3, S4 (both orders), S5, T1, T2a and T4 by name. Then `pnpm test-stack down`.
- [ ] W03a's gate suite still passes: `pnpm --filter @breeze/api test:integration src/__tests__/integration/discoveryNetworkGate.integration.test.ts` and `cd apps/api && npx vitest run src/services/learnedNetworks/gate.test.ts`.
- [ ] `pnpm --filter @breeze/api test:integration-suite-coverage` passes.
- [ ] `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"` prints `exit=0`. Read the exit code; do not pipe through `tail`.
- [ ] No contract suite beyond these is required: this wave adds no table or column. If W01a's schema changed under it, run `tenantCascade`, `orgMergeRegistry` and `tenant-export-policy` integration suites as well.
- [ ] The PR body states:
  - `Closes #<W03b sub-issue>`.
  - Inert until W03c: no route can gate a site.
  - The lock order, and that retained secrets are read only from the locked row.
  - The `networkId` rule as implemented: every save with a non-null resulting `networkId` is checked.
  - The red seen for S3, S4, S5, T1, T2a and T4.
  - The three existing route describes that still pass unchanged.

## Contract notes

1. **One definition of "holds secrets".** Index E5 states that `GateProfile.hasSavedSnmpSecrets` comes from W03a's `storedProfileHoldsSnmpSecrets` (`services/snmpSecrets.ts`) and that `profileWillHoldSnmpSecrets` (E11) must agree with it. Two definitions that disagree on a v3-only profile would skip gate row 3 for it, so Task 1 Step 5 makes `profileWillHoldSnmpSecrets` delegate to W03a's function and pins agreement with a test.
2. **`suppliedAnySecret` and `willHoldSecrets` do not select a rule on their own.** Rule 4 and the no-secret save run the same shrink. This plan uses `willHoldSecrets: false` as "no write" and `suppliedAnySecret` only as an invariant check (`fullReentry` implies it). The parameters stay as the index fixes them.
3. **New exports beyond E11:** `EMPTY_SNMP_SECRET_STATE`, `snmpPatchSuppliesSecret`, `ProfileNetworkNotAssignableError` (`snmpGrants.ts`), `lockProfileForSave` (`profileSaveLock.ts`), `SNMP_SECRET_FIELD_NAMES` (`snmpSecrets.ts`). W03c's T4 pauses a save after `applySnmpGrantRulesOnSave` returns, so the handler must call it through the module import (not a local alias), as Task 3 places it.
4. **`actorUserId: string`** while `granted_by` is nullable. The handlers pass `auth.user.id`. Both routes are behind `requireMfa`, which refuses automation principals (`middleware/auth.ts:1150`). That a non-automation principal always carries `auth.user` is inferred, not read.

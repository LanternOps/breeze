# OneDrive Helper — Phase 4 (UPN Reporting + Server-Side graph_group Tagging) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `graph_group`-targeted libraries actually mount: the agent reports each signed-in user's UPN, the server resolves Entra group membership per UPN (cached) and tags each `graph_group` library with the allowed UPNs, and the agent mounts those libraries only for matching sessions.

**Architecture:** The loop spans two heartbeats: heartbeat N ingests `signedInUpns` into `onedrive_device_state` (new jsonb column); heartbeat N+1's `buildOnedriveHelperConfigUpdate` reads them, resolves membership per UPN via the Phase-1 `resolveUserGroupMembership` behind a TTL cache, and attaches `allowedUpns` to each enabled `graph_group` library. On the agent, `PartitionLibraries` becomes per-session: a `graph_group` rule applies iff the session's own UPN (from that session's `Business1\UserEmail`) is in `allowedUpns` (case-insensitive). Everything stays fail-closed: no UPN, no groupId, no tag, Graph error → not mounted, surfaced as pending.

**Tech Stack:** One idempotent SQL migration (new column), Drizzle, Zod, Hono, Vitest (unit + integration), Go 1.25.10 (`-race`, `GOOS=windows` cross-build), Microsoft Graph v1.0 (existing `getToken`/`graphFetch`).

## Global Constraints

- **Node:** prefix node/pnpm/vitest commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.
- **Branch:** `feat/onedrive-helper-phase4` (stacked on phase 3). Worktree: `/Users/toddhebebrand/breeze/.claude/worktrees/onedrive-helper-phase2`.
- **Migration rules (CLAUDE.md):** `apps/api/migrations/2026-07-09-onedrive-signed-in-upns.sql`, idempotent (`ADD COLUMN IF NOT EXISTS`), no inner BEGIN/COMMIT, never edit shipped migrations. The column is on an existing RLS-covered table — no policy changes needed.
- **Wire contracts (additive only, never break Phase 2/3 fields):**
  - Heartbeat ingest `onedriveDeviceState` gains `signedInUpns?: string[]` (zod: `z.array(z.string().max(320)).max(16).default([])` — 320 = max SMTP address length; 16 sessions is far above any real RDS host we target).
  - Delivery `onedrive_helper_settings.libraries[]` entries gain `allowedUpns: string[]` (always present, `[]` when not a tagged graph_group rule) — additive, older agents ignore it.
- **Fail-closed invariants:** `graph_group` rules with no `groupId` are never tagged (groupName-only Graph rules stay pending — resolving names is out of scope, documented); Graph errors are logged and produce NO tag (never a stale or guessed one); a session with no readable UPN never matches; UPN comparison is case-insensitive (`strings.EqualFold` / lowercase normalization).
- **Graph cost control:** membership resolution happens ONLY when the winning policy has ≥1 enabled `graph_group` library with a `groupId` AND the device has reported ≥1 UPN. Results cached in-process per `(orgId, lowercased upn)` with a 30-minute TTL (`GROUP_MEMBERSHIP_CACHE_TTL_MS = 30 * 60 * 1000`). Errors are not cached.
- **No UI changes** in this phase (the device panel/rollup keep working — additive fields only). No unmount behavior (Sub-project B).
- **Go gates for every agent task:** `go test -race ./internal/onedrivehelper/...` (+ `./internal/heartbeat/` where touched), `GOOS=windows GOARCH=amd64 go build ./...`, `GOOS=windows GOARCH=amd64 go vet ./internal/onedrivehelper/`, `gofmt -l` empty.

---

## File Structure

**Create:**
- `apps/api/migrations/2026-07-09-onedrive-signed-in-upns.sql`

**Modify:**
- `apps/api/src/db/schema/onedriveHelper.ts` — `signedInUpns` column on `onedriveDeviceState`
- `apps/api/src/routes/agents/heartbeat.ts` — zod field + upsert includes it
- `apps/api/src/services/onedriveGraph.ts` — `resolveUserGroupMembershipCached` + exported `clearGroupMembershipCache` (tests)
- `apps/api/src/services/onedriveGraph.test.ts` — cache tests
- `apps/api/src/routes/agents/helpers.ts` — tagging in `resolveDeviceOnedriveSettings` / `OnedriveConfigUpdate` library type gains `allowedUpns`
- `apps/api/src/__tests__/integration/onedrive-helper-config-delivery.integration.test.ts` — UPN ingest + tagging cases
- `agent/internal/onedrivehelper/onedrivehelper.go` — `LibraryRule.AllowedUpns`, `DeviceState.SignedInUpns`, `PartitionLibraries` per-session signature, `containsFold` helper
- `agent/internal/onedrivehelper/onedrivehelper_test.go` — updated/new table tests
- `agent/internal/onedrivehelper/onedrivehelper_windows.go` — per-session UPN read + threading; reader reports UPNs

---

## Task 1: Ingest — `signed_in_upns` column + heartbeat field

**Files:**
- Create: `apps/api/migrations/2026-07-09-onedrive-signed-in-upns.sql`
- Modify: `apps/api/src/db/schema/onedriveHelper.ts`, `apps/api/src/routes/agents/heartbeat.ts`
- Test: extend `apps/api/src/__tests__/integration/onedrive-helper-config-delivery.integration.test.ts`

**Interfaces:**
- Produces: `onedriveDeviceState.signedInUpns` (jsonb, NOT NULL, default `[]`); heartbeat payload `onedriveDeviceState.signedInUpns` persisted on upsert (insert + conflict-update). Consumed by Task 3.

- [ ] **Step 1: Write the failing integration test** — extend the existing "persists reported onedrive device state" pattern in the delivery integration file: post a heartbeat whose `onedriveDeviceState` includes `signedInUpns: ['Todd@example.com', 'second@example.com']`, assert the row's `signedInUpns` equals it; post a second heartbeat WITHOUT the field and assert it resets to `[]` (the zod default flows through the upsert — this pins the no-stale-UPN behavior).
- [ ] **Step 2: Run to confirm failure** (column/field don't exist). Integration run mechanics: same as the file's other tests (`vitest.integration.config.ts`, breeze-postgres-test :5433).
- [ ] **Step 3: Migration**

```sql
-- apps/api/migrations/2026-07-09-onedrive-signed-in-upns.sql
-- Phase 4: agents report the UPNs of signed-in OneDrive users so delivery can
-- tag graph_group libraries per user. Additive, idempotent.
ALTER TABLE onedrive_device_state
  ADD COLUMN IF NOT EXISTS signed_in_upns JSONB NOT NULL DEFAULT '[]'::jsonb;
```

- [ ] **Step 4: Drizzle column** — `signedInUpns: jsonb('signed_in_upns').notNull().default([]),` next to `entitledLibraries`.
- [ ] **Step 5: Heartbeat zod + upsert** — add `signedInUpns: z.array(z.string().max(320)).max(16).default([])` to the `onedriveDeviceState` object in the heartbeat schema; include `signedInUpns: s.signedInUpns` in BOTH the insert values and the `onConflictDoUpdate.set` of the existing upsert.
- [ ] **Step 6: Gates** — integration test PASS; `pnpm db:check-drift` (export `DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"` first — if the shared local DB lacks branch migrations, note the known ledger caveat rather than fighting it); `tsc --noEmit`.
- [ ] **Step 7: Commit** — `feat(onedrive-helper): ingest signed-in UPNs from the agent heartbeat`

---

## Task 2: Cached group-membership resolution

**Files:**
- Modify: `apps/api/src/services/onedriveGraph.ts`
- Test: extend `apps/api/src/services/onedriveGraph.test.ts`

**Interfaces:**
- Produces: `resolveUserGroupMembershipCached(orgId: string, upn: string): Promise<DirectInvokeResult>` — same result shape as the uncached fn; cache key `(orgId, upn.toLowerCase())`; TTL `GROUP_MEMBERSHIP_CACHE_TTL_MS` (exported const, 30 min); errors NOT cached; `clearGroupMembershipCache()` exported for tests. Consumed by Task 3.

- [ ] **Step 1: Failing tests** (existing mocked-`graphFetch` harness; call `clearGroupMembershipCache()` in `beforeEach`):

```typescript
describe('resolveUserGroupMembershipCached', () => {
  beforeEach(() => { vi.clearAllMocks(); clearGroupMembershipCache(); });

  it('second call within TTL hits the cache (no second Graph call)', async () => {
    (graphFetch as any).mockResolvedValueOnce({ kind: 'ok', data: { value: [{ id: 'g-1' }] } });
    const a = await resolveUserGroupMembershipCached('org-1', 'User@Contoso.com');
    const b = await resolveUserGroupMembershipCached('org-1', 'user@contoso.com'); // case-insensitive key
    expect((a as any).data.groupIds).toEqual(['g-1']);
    expect(b).toEqual(a);
    expect(graphFetch).toHaveBeenCalledTimes(1);
  });

  it('errors are not cached (next call retries)', async () => {
    (graphFetch as any)
      .mockResolvedValueOnce({ kind: 'error', code: 'throttled', message: 'x' })
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [{ id: 'g-2' }] } });
    const a = await resolveUserGroupMembershipCached('org-1', 'u@contoso.com');
    expect(a.kind).toBe('error');
    const b = await resolveUserGroupMembershipCached('org-1', 'u@contoso.com');
    expect((b as any).data.groupIds).toEqual(['g-2']);
    expect(graphFetch).toHaveBeenCalledTimes(2);
  });

  it('distinct orgs do not share cache entries', async () => {
    (graphFetch as any)
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [{ id: 'g-1' }] } })
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [{ id: 'g-9' }] } });
    await resolveUserGroupMembershipCached('org-1', 'u@contoso.com');
    const b = await resolveUserGroupMembershipCached('org-2', 'u@contoso.com');
    expect((b as any).data.groupIds).toEqual(['g-9']);
    expect(graphFetch).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run → FAIL** (not exported).
- [ ] **Step 3: Implement** (append to `onedriveGraph.ts`):

```typescript
export const GROUP_MEMBERSHIP_CACHE_TTL_MS = 30 * 60 * 1000;

type CacheEntry = { at: number; result: DirectInvokeResult };
const groupMembershipCache = new Map<string, CacheEntry>();

export function clearGroupMembershipCache(): void {
  groupMembershipCache.clear();
}

/** TTL-cached transitive group membership. Delivery calls this once per
 * reported UPN per heartbeat; without the cache that is a Graph round-trip
 * per user per minute per device. Errors are never cached (fail closed but
 * retry next heartbeat). */
export async function resolveUserGroupMembershipCached(orgId: string, upn: string): Promise<DirectInvokeResult> {
  const key = `${orgId} ${upn.toLowerCase()}`;
  const hit = groupMembershipCache.get(key);
  if (hit && Date.now() - hit.at < GROUP_MEMBERSHIP_CACHE_TTL_MS) return hit.result;
  const result = await resolveUserGroupMembership(orgId, upn);
  if (result.kind === 'ok') groupMembershipCache.set(key, { at: Date.now(), result });
  return result;
}
```

- [ ] **Step 4: Whole file green + tsc.** 
- [ ] **Step 5: Commit** — `feat(onedrive-helper): TTL-cached Graph group membership for delivery tagging`

---

## Task 3: Delivery tagging — `allowedUpns` per graph_group library

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts` (`OnedriveConfigUpdate` library type + `resolveDeviceOnedriveSettings`)
- Test: extend the delivery integration test

**Interfaces:**
- Consumes: Task 1 column, Task 2 cached resolver.
- Produces: every delivered library object gains `allowedUpns: string[]` — non-empty only for enabled `graph_group` rules with a `groupId` where ≥1 reported UPN's transitive groups include that groupId. UPNs are delivered in their reported casing.

- [ ] **Step 1: Failing integration test** — in the delivery file (mock `../../services/onedriveGraph` at module level for these cases — integration config still supports `vi.mock`; check how other integration tests in the directory mock services, and if none do, mock via `vi.mock` at top with `importActual` passthrough for anything else the file needs):

```typescript
it('tags graph_group libraries with allowed UPNs from reported sign-ins', async () => {
  // seed: policy with libraries [graph_group g-fin, everyone] (existing seed helper),
  // device state row with signedInUpns ['todd@contoso.com','other@contoso.com']
  // mock: resolveUserGroupMembershipCached → todd ∈ [g-fin, g-x]; other ∈ [g-x]
  const cfg = await buildOnedriveHelperConfigUpdate(deviceId);
  const fin = cfg!.libraries.find((l) => l.libraryId === 'lib-fin')!;
  expect(fin.allowedUpns).toEqual(['todd@contoso.com']);
  const all = cfg!.libraries.find((l) => l.libraryId === 'lib-all')!;
  expect(all.allowedUpns).toEqual([]);
});

it('does not call Graph when the policy has no graph_group libraries', async () => { /* everyone-only policy + UPNs present → resolver mock not called */ });
it('does not call Graph when no UPNs reported', async () => { /* graph_group policy, no state row / empty upns → not called; allowedUpns [] */ });
it('graph_group with only groupName stays untagged', async () => { /* groupId null, groupName set → resolver not called for it, allowedUpns [] */ });
it('Graph error leaves the library untagged (fail closed)', async () => { /* mock error for one upn, ok for another → only the ok upn can appear */ });
```

- [ ] **Step 2: Run → FAIL** (`allowedUpns` undefined / Graph mock uncalled assertions invert).
- [ ] **Step 3: Implement** in `helpers.ts`:
  - `OnedriveConfigUpdate['libraries'][n]` type gains `allowedUpns: string[]`.
  - In `resolveDeviceOnedriveSettings`, after loading `libs`:

```typescript
  // Phase 4: tag enabled graph_group libraries with the reported UPNs whose
  // transitive Entra membership includes the rule's groupId. Fail closed:
  // no UPNs / no groupId / Graph error → no tag → the agent never mounts it.
  const graphRules = libs.filter((l) => l.targetingMode === 'graph_group' && l.groupId);
  const upns = ((state?.signedInUpns as string[] | undefined) ?? []).filter(
    (u): u is string => typeof u === 'string' && u.length > 0
  );
  const allowedByLib = new Map<string, string[]>();
  if (graphRules.length > 0 && upns.length > 0) {
    for (const upn of upns) {
      const res = await resolveUserGroupMembershipCached(device.orgId, upn);
      if (res.kind !== 'ok') {
        console.warn(`[agents] graph_group tagging: membership lookup failed for device ${deviceId}: ${res.code}`);
        continue;
      }
      const groupIds = new Set(((res.data as { groupIds: string[] }).groupIds ?? []));
      for (const rule of graphRules) {
        if (rule.groupId && groupIds.has(rule.groupId)) {
          const arr = allowedByLib.get(rule.id) ?? [];
          arr.push(upn);
          allowedByLib.set(rule.id, arr);
        }
      }
    }
  }
```

  where `state` is the device's `onedrive_device_state` row — load it alongside the existing device lookup (`db.select().from(onedriveDeviceState).where(eq(onedriveDeviceState.deviceId, deviceId)).limit(1)`) ONLY when the winner has libraries (place the query after `libs` load, before mapping). In the final `libraries: libs.map(...)`, add `allowedUpns: allowedByLib.get(l.id) ?? []`.
- [ ] **Step 4: All delivery integration tests green** (incl. Phase 1/2 cases — the added field must not break them) + `tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(onedrive-helper): tag graph_group libraries with allowed UPNs at delivery`

---

## Task 4: Agent pure core — per-session partition + UPN fields

**Files:**
- Modify: `agent/internal/onedrivehelper/onedrivehelper.go`, `onedrivehelper_test.go`

**Interfaces:**
- Produces:
  - `LibraryRule.AllowedUpns []string` with tag `json:"allowedUpns"`; `DeviceState.SignedInUpns []string` with tag `json:"signedInUpns"` (never nil on the wire — same rule as the other arrays).
  - New signature `PartitionLibraries(rules []LibraryRule, isLocalGroupMember func(string) bool, sessionUpn string) (apply, pending []LibraryRule)` — `graph_group`: apply iff `sessionUpn != ""` AND `AllowedUpns` contains it case-insensitively; otherwise pending. `everyone`/`local_ad_group`/unknown behavior unchanged.
  - `func containsFold(xs []string, x string) bool` (pure helper).

- [ ] **Step 1: Failing tests** — update `TestPartitionLibraries` for the new signature and add graph cases:

```go
	// graph_group with a matching AllowedUpns entry (case-insensitive) applies;
	// non-member, empty AllowedUpns, and empty sessionUpn are pending (fail closed).
	{LibraryID: "l-graph-yes", TargetingMode: "graph_group", GroupID: "g-1", AllowedUpns: []string{"Todd@Contoso.com"}},
	{LibraryID: "l-graph-no", TargetingMode: "graph_group", GroupID: "g-1", AllowedUpns: []string{"other@contoso.com"}},
	{LibraryID: "l-graph-untagged", TargetingMode: "graph_group", GroupID: "g-1"},
```

  with `sessionUpn = "todd@contoso.com"` → apply contains `l-graph-yes`; pending contains `l-graph-no`, `l-graph-untagged`; and a second call with `sessionUpn = ""` → all three pending. Also `TestParseConfig` gains a case where a library carries `allowedUpns` and `base`+`signedInUpns` round-trip. Add `TestContainsFold` (match, case-fold match, miss, empty slice, empty needle → false).
- [ ] **Step 2: RED** (signature mismatch compiles fail).
- [ ] **Step 3: Implement** — struct fields; `containsFold` via `strings.EqualFold` loop (empty needle returns false); `PartitionLibraries` gains the `sessionUpn` param and a `case "graph_group":` branch ABOVE the default (so unknown modes still fail closed via default):

```go
		case "graph_group":
			if sessionUpn != "" && containsFold(r.AllowedUpns, sessionUpn) {
				apply = append(apply, r)
			} else {
				pending = append(pending, r)
			}
```

  Update the function doc comment: graph_group now applies when the server tagged the session's UPN; untagged/unmatched stays pending.
- [ ] **Step 4: GREEN** with `-race`; `gofmt -l` empty. NOTE: `onedrivehelper_windows.go` will not compile against the new signature until Task 5 — that file is build-tagged windows, so local `-race` tests pass; run `GOOS=windows go build ./...` EXPECTING failure here and note it (Task 5 fixes it) — do NOT gate this task's commit on the windows build.
- [ ] **Step 5: Commit** — `feat(onedrive-helper): per-session graph_group partition + UPN wire fields`

---

## Task 5: Agent Windows — per-session UPN read + reporting

**Files:**
- Modify: `agent/internal/onedrivehelper/onedrivehelper_windows.go`

**Interfaces:**
- Consumes: Task 4 signature.
- Produces: `Apply` resolves each session's UPN from `HKU\<SID>\SOFTWARE\Microsoft\OneDrive\Accounts\Business1` value `UserEmail` (empty string when absent/unreadable — fail closed), passes it to `PartitionLibraries`; `readDeviceState` populates `SignedInUpns` (deduped case-insensitively, original casing preserved, `[]string{}` never nil) from the same per-session reads.

- [ ] **Step 1: Implement**
  - New helper in the windows file:

```go
// sessionUpn reads the signed-in user's UPN from the session's own OneDrive
// account key. Empty when the user isn't signed in to OneDrive Business or the
// value is unreadable — callers treat empty as "cannot match graph_group rules"
// (fail closed).
func sessionUpn(sid string) string {
	k, err := registry.OpenKey(registry.USERS, sid+`\`+accountKeySuffix, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, err := k.GetStringValue("UserEmail")
	if err != nil {
		return ""
	}
	return v
}
```

  - In `Apply`'s per-session loop: `upn := sessionUpn(s.sid)` then `apply, _ := PartitionLibraries(cfg.Libraries, isMember, upn)`.
  - In `readDeviceState`: collect each signed-in session's `UserEmail` (it already opens the `acct` key per session — read the value there rather than reopening), dedupe with `containsFold`, assign `state.SignedInUpns` (initialize `[]string{}` in the struct literal like the other arrays).
- [ ] **Step 2: Gates** — `go test -race ./internal/onedrivehelper/... ./internal/heartbeat/` (heartbeat seam test still green — `Apply` signature unchanged), `GOOS=windows GOARCH=amd64 go build ./...` now clean, windows vet, gofmt.
- [ ] **Step 3: Commit** — `feat(onedrive-helper): per-session UPN resolution + signed-in UPN reporting`

---

## Task 6: Live verification (VM + stack)

No new code. The phase4 branch must be running on the stack (`pnpm wt-stack up --rebuild` — note the project is keyed on the branch name, so this creates ANOTHER stack (`breeze-wt-feat-onedrive-helper-phase4`) with an empty DB: recreate org/site/key/policy fixtures and re-enroll the VM as done for phase 3, and tear the phase3 stack down after. Push the freshly built agent to the VM (build `GOOS=windows`, scp, stop service, swap exe, start — enrollment persists if the same stack; after a stack swap re-enroll).

- [ ] **Step 1: UPN reporting** — after a heartbeat, `signed_in_upns` on the device row contains the VM user's OneDrive UPN (`Todd@lanternops.io`).
- [ ] **Step 2: Fail-closed graph rule** — add a `graph_group` library (any groupId GUID, e.g. a made-up one) to the policy: delivered with `allowedUpns: []` (no M365 connection on the stack org → tagging skipped, warn logged), agent does NOT write its AutoMount value, reader shows it neither mounted nor drifted (pending is not entitled).
- [ ] **Step 3 (optional — requires Todd):** connect the stack org to the real M365 tenant (Entra app + admin consent through `/integrations#m365`), point the graph rule at a real group containing todd@lanternops.io, and observe the full loop: tag → per-session mount. If the connection isn't available, record the step as deferred-with-coverage (the tagging path is integration-tested with mocked Graph; the agent path is unit-tested).
- [ ] **Step 4:** log results in `docs/testing/FEATURE_TEST_LOG.md` (local-only).

---

## Self-Review (completed during authoring)

**Spec coverage:** Spec §3 "API pre-resolves graph_group gates per reported logged-in user(s)" → Tasks 1–3. §4 "UPN source: OneDrive's own account registry `UserEmail`" → Task 5 (the spec's `whoami /upn` fallback is deliberately dropped: a UPN that isn't signed in to OneDrive can't mount anything, so the OneDrive-reported identity is the only one that matters — recorded here as a scope decision, not an omission). Multi-session/RDS → per-session UPN + per-session partition. Fail-closed + cost control → Global Constraints, enforced by tests in Tasks 2–4.

**Placeholder scan:** Task 1/2/4/5 carry real SQL/TS/Go; Task 3's test block names exact seeds/mocks per case with the assertion values spelled out; the one adaptation point (how integration tests mock a service module) points at the concrete file to imitate.

**Type consistency:** `signedInUpns` spelled identically in migration (snake), Drizzle, zod, Go tag, and delivery reads; `allowedUpns` identical in `OnedriveConfigUpdate`, integration assertions, and Go `LibraryRule`; `PartitionLibraries(rules, isLocalGroupMember, sessionUpn)` matches between Task 4 tests/impl and Task 5 call site; `resolveUserGroupMembershipCached` name matches Tasks 2 and 3; Task 4 explicitly sequences the temporary windows-build break that Task 5 heals.

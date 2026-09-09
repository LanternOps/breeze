# M365 tenant sync — Wave 3: executor sync actions, route, limits, API client operation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** give the customer-graph-read executor six whole-domain `m365.sync.*` actions on their own `POST /v1/sync-action` route, with a second Graph-client limit profile sized for bulk pulls, an executor-encrypted resumable continuation for sign-in activity, an app-wide sign-in token bucket, per-instance in-flight caps that reserve headroom for interactive AI-tool calls, executor metrics, and the matching `syncAction()` operation on the API's `graphReadExecutorClient`. Nothing in this wave touches the database, a worker, or a UI — W04 consumes what lands here.

**Architecture:** the shared package owns the wire contract (`packages/shared/src/m365/sync.ts` for the domain vocabulary, `readActions.ts` for the six action branches, their projection allowlists, and the sync result/failure schemas). The executor gains a parallel stack next to the interactive one: `microsoft/syncActions.ts` (one case per action, merging multiple Graph sources into one projected item set), `microsoft/graphClient.ts`'s new `readSyncCollection` (60 pages / env-sized item cap / 64 MiB / 110 s `AbortController` deadline / `Retry-After`-honouring retry), `syncContinuation.ts` (AES-256-GCM, tenant- and action-bound AAD, 1-hour expiry, base64url), `signinLimiter.ts` (non-blocking token bucket), `inFlight.ts` (sync cap ⊂ total cap), and `metrics.ts` (a dependency-free Prometheus text registry on `GET /metrics`). The API client gains a fourth operation whose non-2xx handling returns typed failures carrying `retryAfterSeconds` instead of collapsing everything into `executor_unavailable`.

**Tech Stack:** TypeScript, Zod 4 (`@breeze/shared/m365`), Hono + `@hono/node-server`, `node:crypto` (AES-256-GCM, HKDF), jose (EdDSA internal auth — unchanged), Vitest, tsup. No new runtime dependency in any package.

**Spec:** `docs/superpowers/specs/integrations/2026-09-08-m365-tenant-sync-foundation-design.md` — this plan implements §4.1–§4.4 in full, plus the executor half of §4.3 and the executor rows of §7. Sections are cited per task.

**Plan overview / shared interface contract:** `docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-0-overview.md`. Every name in its "Shared interface contract" section is fixed; this plan's deviations are listed under *Contract deviations* below and must be mirrored into that file in the same PR.

## Global Constraints (inherited from the overview)

- Migration file name must sort after the newest committed migration (`2026-10-14-100500-…` as of 2026-09-08; re-check with `ls apps/api/migrations | sort | tail -1`). Idempotent, no inner `BEGIN/COMMIT`, RLS enabled + forced + policies in the same file. **This wave adds no migration and must not add one** — verify with `git diff --stat apps/api/migrations` at the end (must be empty).
- All new tables are shape 1: `org_id NOT NULL` → `organizations(id)`, policy `USING (public.breeze_has_org_access(org_id))` FOR ALL. **No tables in this wave.**
- Composite FKs on `(x, org_id)` are `DEFERRABLE INITIALLY IMMEDIATE`.
- Every jsonb column is `excludedOpen`; every column whose name contains `mfa` or `hash` is `reviewedIncluded` in `CORE_TENANT_EXPORT_POLICY`. **No columns in this wave** — `git diff --stat apps/api/src/db/` must be empty.
- BullMQ custom job ids contain no `:`.
- Fail-closed: no Redis budget signal = deny; missing flag = off.
- Never edit a shipped migration. Never call the bare pool in request code.
- Test one file with `cd apps/api && npx vitest run <path>` (never `pnpm … test -- --run`).
- **Executor projection allowlists are the only fields that leave the executor.** Every sync item is built through `M365_READ_ACTION_FIELDS[action.type]`; nested objects (`prepaidUnits`, `controlScores[]`, `adminRoles[]`) are allowlisted *by construction* — never spread a raw Graph object into a result.

## Additional constraints specific to this wave

- **The executor holds no private key.** `config.ts:119-134` loads `M365_GRAPH_READ_EXECUTOR_SIGNING_PUBLIC_JWK` — the *public* verification JWK only; the Ed25519 private signing key lives on the API side (`M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE`, deploy doc line 101). The spec's "AES-GCM under a key derived from the executor's signing key" is therefore not implementable as written. See *Contract deviations*.
- **No new npm dependency in the executor.** It is the process that holds the only customer credential; its dependency set is deliberately minimal and Trivy-scanned per release. Metrics are hand-rolled Prometheus text, not `prom-client`.
- **No blocking.** The sign-in limiter never sleeps a request; capacity rejection never queues. The only sleeps in this wave are Graph throttle backoffs, and they are injectable seams in tests (`dependencies.sleep`).
- **No network in tests.** `fetch`, the clock, and sleep are constructor seams, matching `graphClient.test.ts:1-70`'s route-table style. No `vi.mock` module mocking anywhere.
- **Never commit** real tenant ids, client ids, secrets, or infra hostnames. Fixtures use the shipped all-1s/2s/3s GUID style.

## Contract deviations (mirror these into the overview file in the same PR)

1. **Continuation key is a dedicated env var, not derived from the signing key.** The executor never holds private signing material (evidence above), so HKDF-from-signing-key is impossible. `M365_SYNC_CONTINUATION_KEY` (32-byte base64) is **optional**: when absent the executor derives an ephemeral per-process key with `randomBytes(32)`, so continuations simply do not survive a restart or cross a replica — the API sees `continuation_invalid` and restarts the sign-in domain from page 1, which is self-healing and keeps the var optional for existing deployments. HKDF-SHA-256 is still applied to whichever 32-byte secret is in hand, with `info` binding the purpose string.
2. **The continuation wraps the whole `@odata.nextLink` URL, not the bare skip token.** Re-validating a full URL through the existing `fixedCollectionNextLink` host/path guard (`graphClient.ts:95-115`) is strictly stronger than re-assembling a URL from a token; the URL carries nothing but the token.
3. **A sync response body is a union, and `continuation_invalid` is a new code.** The overview specifies only the success shape. Failures need a wire shape, so `m365SyncActionResponseSchema = z.union([success, failure])` is added with `m365SyncFailureCodeSchema` = the ten `readActionFailureCodeSchema` codes plus `continuation_invalid`. `ReadActionFailureCode` itself is **not** widened — widening it would break the exhaustive `FAILURE_MESSAGES` record at `readActionService.ts:35-46`, a file this wave must not touch.
4. **`GraphReadExecutorFailure` is new, not "gained".** No such type exists today (`graphReadExecutorClient.ts` only throws `GraphReadExecutorClientError`). It is introduced here as `{ success: false; code: M365SyncFailureCode | 'sync_capacity'; retryAfterSeconds?: number }`. Genuine transport/parse/timeout problems still **throw** `GraphReadExecutorClientError` exactly as the other three client methods do; only executor-reported outcomes are returned.
5. **The 400/503 bodies carry both `error` and `code`.** The overview fixes `{ code: 'action_not_allowed' }` and `{ code: 'sync_capacity', retryAfterSeconds: 30 }`; every shipped executor response uses an `error` envelope (`app.ts:79-156`). Both keys are emitted with the same value so neither contract bends.
6. **Route timeout surfaces as `504 { error: 'sync_timeout' }`.** The spec fixes the 120 s route timeout but not its code. The client throws `executor_unavailable` for it — W04 retries via BullMQ, which is the intended handling for "executor did not answer".
7. **A truncated *secondary* source is reported as `error` and its partial data is discarded.** Applying half a registration report would produce exactly the false-absent enrichment the advisor quorum rejected (spec §0.1, "Partial enrichment must not produce false 'absent'"). Primary truncation still persists (`truncated: true`).
8. **Interactive routes are subject to `M365_MAX_IN_FLIGHT` too**, returning `503 { error: 'capacity', code: 'capacity', retryAfterSeconds: 5 }`. Spec §4.2 calls it "a per-instance **total** in-flight cap"; capping only sync would leave the total unbounded. Because the sync cap (4) is validated `<=` the total cap (32), the reserved-headroom guarantee holds by construction.

## Task ordering & dependencies

Strictly sequential — each task consumes the previous task's exports. Commit after every task.

| # | Task | Package |
|---|---|---|
| 1 | Shared sync domain vocabulary (`sync.ts`) | `packages/shared` |
| 2 | Shared sync action branches, projections, result/failure schemas | `packages/shared` |
| 3 | Executor config: sync limits env block | executor |
| 4 | Executor metrics registry + `GET /metrics` | executor |
| 5 | Graph client sync profile (`readSyncCollection`) | executor |
| 6 | Continuation codec | executor |
| 7 | Sign-in limiter | executor |
| 8 | `syncActions.ts` — `m365.sync.users` | executor |
| 9 | `syncActions.ts` — sign-in activity + devices, CA, SKUs, Secure Score | executor |
| 10 | In-flight gate + `syncActionOperation` | executor |
| 11 | `POST /v1/sync-action` route, `internalAuth` operation, `index.ts` wiring | executor |
| 12 | API client `sync-action` operation | `apps/api` |
| 13 | Deploy doc env rows + memory guidance | docs |
| 14 | Full verification, build, typecheck, PR | — |

---

### Task 1: Shared sync domain vocabulary

Spec §5.2, §5.7 (the cadence bounds these constants feed). Overview contract, "Shared package".

**Files:**
- Create: `packages/shared/src/m365/sync.ts`
- Create: `packages/shared/src/m365/sync.test.ts`
- Modify: `packages/shared/src/m365/index.ts` — add `export * from './sync';`

**Interfaces:**
- Consumes: nothing (pure constants).
- Produces (consumed by W04's claim protocol and W05's cadence module):
  - `M365_SYNC_DOMAINS: readonly ['users','signin_activity','intune_devices','ca_policies','skus','secure_score']`
  - `type M365SyncDomain = typeof M365_SYNC_DOMAINS[number]`
  - `M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS: Record<M365SyncDomain, number>`
  - `M365_SYNC_DOMAIN_INTERVAL_BOUNDS: Record<M365SyncDomain, { min: number; max: number }>`
  - `isM365SyncDomain(value: string): value is M365SyncDomain`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/m365/sync.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  M365_SYNC_DOMAINS,
  M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS,
  M365_SYNC_DOMAIN_INTERVAL_BOUNDS,
  isM365SyncDomain,
} from './sync';

describe('m365 sync domain vocabulary', () => {
  it('names exactly the six persisted domains in schedule order', () => {
    expect(M365_SYNC_DOMAINS).toEqual([
      'users', 'signin_activity', 'intune_devices', 'ca_policies', 'skus', 'secure_score',
    ]);
    expect(new Set(M365_SYNC_DOMAINS).size).toBe(M365_SYNC_DOMAINS.length);
  });

  it('gives every domain a default interval inside its own bounds', () => {
    for (const domain of M365_SYNC_DOMAINS) {
      const bounds = M365_SYNC_DOMAIN_INTERVAL_BOUNDS[domain];
      const seconds = M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS[domain];
      expect(Number.isSafeInteger(seconds)).toBe(true);
      expect(bounds.min).toBeLessThan(bounds.max);
      expect(seconds).toBeGreaterThanOrEqual(bounds.min);
      expect(seconds).toBeLessThanOrEqual(bounds.max);
    }
  });

  it('floors sign-in activity at a day — the app-wide Graph limit is 10 req/min', () => {
    // spec §0.1: signInActivity is throttled per app across ALL tenants, so its
    // floor is an order of magnitude above every other domain's.
    expect(M365_SYNC_DOMAIN_INTERVAL_BOUNDS.signin_activity.min).toBe(24 * 3600);
    expect(M365_SYNC_DOMAIN_INTERVAL_BOUNDS.signin_activity.max).toBe(7 * 24 * 3600);
    expect(M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS.signin_activity).toBe(24 * 3600);
  });

  it('narrows unknown strings', () => {
    expect(isM365SyncDomain('users')).toBe(true);
    expect(isM365SyncDomain('mailboxes')).toBe(false);
    expect(isM365SyncDomain('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/shared && npx vitest run src/m365/sync.test.ts
```

Expect `Failed to resolve import "./sync"`.

- [ ] **Step 3: Implement `sync.ts`**

Create `packages/shared/src/m365/sync.ts`:

```ts
/**
 * Domain vocabulary for the M365 tenant sync (spec §3.1, §5.2, §5.7).
 *
 * Pure constants: this module is reachable from the `@breeze/shared` root
 * barrel, which apps/web bundles for the browser, so it must not import
 * node:crypto or anything else Node-only.
 */

export const M365_SYNC_DOMAINS = [
  'users',
  'signin_activity',
  'intune_devices',
  'ca_policies',
  'skus',
  'secure_score',
] as const;

export type M365SyncDomain = typeof M365_SYNC_DOMAINS[number];

const HOUR = 3600;

/** Starting cadence for a freshly seeded connection. Adaptive cadence (§5.7) moves within the bounds below. */
export const M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS: Record<M365SyncDomain, number> = {
  users: 6 * HOUR,
  signin_activity: 24 * HOUR,
  intune_devices: 6 * HOUR,
  ca_policies: 24 * HOUR,
  skus: 24 * HOUR,
  secure_score: 24 * HOUR,
};

/**
 * Adaptive cadence may never leave these. signin_activity's floor is a full
 * day because Graph throttles /users?$select=signInActivity at 10 requests per
 * minute PER APP ACROSS ALL TENANTS (spec §0.1) — a per-tenant hourly cadence
 * would exhaust the app-wide budget at a few hundred connections.
 */
export const M365_SYNC_DOMAIN_INTERVAL_BOUNDS: Record<M365SyncDomain, { min: number; max: number }> = {
  users: { min: HOUR, max: 48 * HOUR },
  signin_activity: { min: 24 * HOUR, max: 7 * 24 * HOUR },
  intune_devices: { min: HOUR, max: 48 * HOUR },
  ca_policies: { min: HOUR, max: 48 * HOUR },
  skus: { min: HOUR, max: 48 * HOUR },
  secure_score: { min: HOUR, max: 48 * HOUR },
};

const DOMAIN_SET: ReadonlySet<string> = new Set(M365_SYNC_DOMAINS);

export function isM365SyncDomain(value: string): value is M365SyncDomain {
  return DOMAIN_SET.has(value);
}
```

Add to `packages/shared/src/m365/index.ts`, after the `./readActions` line:

```ts
export * from './sync';
```

- [ ] **Step 4: Run — green**

```bash
cd packages/shared && npx vitest run src/m365/sync.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/m365/sync.ts packages/shared/src/m365/sync.test.ts packages/shared/src/m365/index.ts
git commit -m "feat(m365): shared sync domain vocabulary and cadence bounds

Wave 3 task 1 of the M365 tenant sync foundation (spec §5.2, §5.7).

Six persisted domains with per-domain default intervals and the bounds
adaptive cadence may not leave. signin_activity is floored at 24h because
Graph throttles the signInActivity select at 10 req/min per app across all
tenants, not per tenant — a per-tenant hourly cadence exhausts the app-wide
budget at a few hundred connections.

Pure constants only: this module lands in the @breeze/shared root barrel,
which apps/web bundles for the browser.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 2: Shared sync action branches, projection allowlists, result and failure schemas

Spec §4.1 (the action table and item shapes), §4.3 (the wire result). Overview contract, "Shared package".

**Files:**
- Modify: `packages/shared/src/m365/readActions.ts` — six ids appended to `M365_READ_ACTION_IDS`, six `M365_READ_ACTION_FIELDS` entries, six strict Zod branches spliced into `m365ReadActionSchema`, plus the sync-only exports
- Modify: `packages/shared/src/m365/readActions.test.ts` — the shipped 12-action assertions become interactive-only; new sync assertions
- Modify: `apps/m365-graph-read-executor/src/microsoft/readActions.ts` — narrow the interactive signature; export `project`
- Modify: `apps/m365-graph-read-executor/src/microsoft/readActions.test.ts` — iterate the interactive ids, not all ids

**Interfaces:**
- Consumes: `z` from `zod`.
- Produces:
  - `M365_SYNC_ACTION_IDS: readonly ['m365.sync.users','m365.sync.signin_activity','m365.sync.intune_devices','m365.sync.ca_policies','m365.sync.skus','m365.sync.secure_score']`
  - `type M365SyncActionId = typeof M365_SYNC_ACTION_IDS[number]`
  - `isM365SyncActionId(id: string): id is M365SyncActionId`
  - `isM365SyncAction(action: M365ReadAction): action is M365SyncAction`
  - `m365SyncActionSchema` / `type M365SyncAction`
  - `type M365InteractiveReadAction = Exclude<M365ReadAction, M365SyncAction>`
  - `syncActionRequestSchema` / `type SyncActionRequest`
  - `type M365SyncSourceState`, `m365SyncSourceStateSchema`
  - `interface M365SyncActionResult`, `m365SyncActionResultSchema: z.ZodType<M365SyncActionResult>`
  - `m365SyncFailureCodeSchema` / `type M365SyncFailureCode`, `m365SyncActionFailureSchema`, `m365SyncActionResponseSchema` / `type M365SyncActionResponse`
  - `M365_SYNC_CONTINUATION_MAX_CHARS = 4096`
  - `export function project(...)` from the executor's `readActions.ts` (re-used by `syncActions.ts`)

⚠️ **Two shipped call sites break the moment the ids are appended** — both are typed `Record<M365ReadActionId, …>`:
`apps/m365-graph-read-executor/src/microsoft/readActions.test.ts:58` (`SAMPLE_ACTIONS`) and `:73` (`EXPECTED_PATH`). They must be re-keyed to `M365InteractiveReadActionId`, and the `it.each(M365_READ_ACTION_IDS)` at `:99` must iterate the interactive ids. `executeGraphReadAction`'s `default:` exhaustiveness guard (`readActions.ts:251-254`) also breaks unless its parameter is narrowed to `M365InteractiveReadAction`. Do all four in this task; leaving them for Task 8 means a red executor suite for six tasks.

- [ ] **Step 1: Write the failing tests**

Replace the first test in `packages/shared/src/m365/readActions.test.ts` (lines 13-26) and append the new block. The full new file:

```ts
import { describe, expect, it } from 'vitest';
import {
  M365_READ_ACTION_IDS,
  M365_READ_ACTION_FIELDS,
  M365_INTERACTIVE_READ_ACTION_IDS,
  M365_SYNC_ACTION_IDS,
  M365_SYNC_CONTINUATION_MAX_CHARS,
  isM365SyncActionId,
  isM365SyncAction,
  m365ReadActionSchema,
  m365SyncActionSchema,
  m365SyncActionResponseSchema,
  m365SyncActionResultSchema,
  m365SyncFailureCodeSchema,
  readActionRequestSchema,
  readActionResultSchema,
  readActionFailureCodeSchema,
  syncActionRequestSchema,
} from './readActions';

const GUID = '11111111-2222-3333-4444-555555555555';

describe('m365 read action contracts', () => {
  it('defines exactly the 12 interactive catalog actions with non-empty field allowlists', () => {
    expect(M365_INTERACTIVE_READ_ACTION_IDS).toEqual([
      'm365.user.list', 'm365.user.get', 'm365.signins.list',
      'm365.intune.device.list', 'm365.intune.device.get',
      'm365.group.list', 'm365.group.get', 'm365.group.members.list',
      'm365.org.get', 'm365.org.skus.list',
      'm365.sites.list', 'm365.site.get',
    ]);
    for (const id of M365_READ_ACTION_IDS) {
      expect(M365_READ_ACTION_FIELDS[id].length).toBeGreaterThan(0);
      expect(new Set(M365_READ_ACTION_FIELDS[id]).size).toBe(M365_READ_ACTION_FIELDS[id].length);
    }
  });

  it('accepts every action variant at its bounds', () => {
    const variants = [
      { type: 'm365.user.list', search: 'ada', accountEnabled: true, pageSize: 50 },
      { type: 'm365.user.get', userIdOrUpn: 'ada@contoso.com' },
      { type: 'm365.signins.list', userPrincipalName: 'ada@contoso.com', sinceHours: 168, pageSize: 50 },
      { type: 'm365.intune.device.list', complianceState: 'noncompliant', pageSize: 50 },
      { type: 'm365.intune.device.get', deviceId: GUID },
      { type: 'm365.group.list', search: 'staff', pageSize: 50 },
      { type: 'm365.group.get', groupId: GUID },
      { type: 'm365.group.members.list', groupId: GUID, pageSize: 100 },
      { type: 'm365.org.get' },
      { type: 'm365.org.skus.list' },
      { type: 'm365.sites.list', search: 'intranet' },
      { type: 'm365.site.get', siteId: 'contoso.sharepoint.com,111,222' },
    ];
    for (const action of variants) {
      expect(m365ReadActionSchema.safeParse(action).success, JSON.stringify(action)).toBe(true);
      expect(readActionRequestSchema.safeParse({
        correlationId: GUID, tenantId: GUID, action,
      }).success).toBe(true);
    }
  });

  it('rejects out-of-bound and unknown inputs', () => {
    expect(m365ReadActionSchema.safeParse({ type: 'm365.user.list', pageSize: 51 }).success).toBe(false);
    expect(m365ReadActionSchema.safeParse({ type: 'm365.signins.list', sinceHours: 169 }).success).toBe(false);
    expect(m365ReadActionSchema.safeParse({ type: 'm365.sites.list' }).success).toBe(false); // search required
    expect(m365ReadActionSchema.safeParse({ type: 'm365.user.get', userIdOrUpn: "a'; drop--@x.com" }).success).toBe(false);
    expect(m365ReadActionSchema.safeParse({ type: 'm365.mail.send' }).success).toBe(false);
    expect(m365ReadActionSchema.safeParse({ type: 'm365.user.list', extra: 1 }).success).toBe(false);
  });

  it('round-trips collection, resource, and failure results', () => {
    expect(readActionResultSchema.safeParse({
      success: true, kind: 'collection', items: [{ id: GUID }], truncated: false,
    }).success).toBe(true);
    expect(readActionResultSchema.safeParse({
      success: true, kind: 'resource', resource: { id: GUID },
    }).success).toBe(true);
    expect(readActionResultSchema.safeParse({
      success: false, errorCode: 'graph_throttled', retryAfterSeconds: 30,
    }).success).toBe(true);
    expect(readActionFailureCodeSchema.safeParse('grant_missing').success).toBe(false);
  });
});

describe('m365 sync action contracts', () => {
  it('appends exactly the six sync ids to the read catalog', () => {
    expect(M365_SYNC_ACTION_IDS).toEqual([
      'm365.sync.users', 'm365.sync.signin_activity', 'm365.sync.intune_devices',
      'm365.sync.ca_policies', 'm365.sync.skus', 'm365.sync.secure_score',
    ]);
    expect(M365_READ_ACTION_IDS).toEqual([
      ...M365_INTERACTIVE_READ_ACTION_IDS, ...M365_SYNC_ACTION_IDS,
    ]);
    for (const id of M365_SYNC_ACTION_IDS) expect(isM365SyncActionId(id)).toBe(true);
    for (const id of M365_INTERACTIVE_READ_ACTION_IDS) expect(isM365SyncActionId(id)).toBe(false);
  });

  it('projects exactly the contracted keys per sync action', () => {
    expect(M365_READ_ACTION_FIELDS['m365.sync.users']).toEqual([
      'id', 'userPrincipalName', 'displayName', 'mail', 'accountEnabled', 'jobTitle',
      'department', 'usageLocation', 'onPremisesSyncEnabled', 'createdDateTime',
      'assignedLicenses', 'mfaRegistered', 'mfaCapable', 'defaultMfaMethod', 'adminRoles',
    ]);
    expect(M365_READ_ACTION_FIELDS['m365.sync.signin_activity']).toEqual(['id', 'lastSuccessfulSignInAt']);
    expect(M365_READ_ACTION_FIELDS['m365.sync.intune_devices']).toEqual([
      'id', 'deviceName', 'operatingSystem', 'osVersion', 'complianceState', 'lastSyncDateTime',
      'userPrincipalName', 'managedDeviceOwnerType', 'enrolledDateTime', 'model', 'manufacturer',
      'serialNumber', 'azureADDeviceId', 'managementAgent', 'jailBroken',
    ]);
    expect(M365_READ_ACTION_FIELDS['m365.sync.ca_policies']).toEqual([
      'id', 'displayName', 'state', 'createdDateTime', 'modifiedDateTime',
      'conditions', 'grantControls', 'sessionControls',
    ]);
    expect(M365_READ_ACTION_FIELDS['m365.sync.skus']).toEqual([
      'skuId', 'skuPartNumber', 'consumedUnits', 'prepaidUnits', 'capabilityStatus', 'appliesTo',
    ]);
    expect(M365_READ_ACTION_FIELDS['m365.sync.secure_score']).toEqual([
      'id', 'createdDateTime', 'currentScore', 'maxScore', 'activeUserCount',
      'licensedUserCount', 'controlScores',
    ]);
    // lastSignInDateTime counts FAILED interactive attempts (spec §4.1) and must
    // never reach the API.
    expect(M365_READ_ACTION_FIELDS['m365.sync.signin_activity']).not.toContain('lastSignInDateTime');
    expect(M365_READ_ACTION_FIELDS['m365.sync.signin_activity']).not.toContain('signInActivity');
  });

  it('accepts the six sync branches and their only optional inputs', () => {
    for (const type of M365_SYNC_ACTION_IDS) {
      expect(m365SyncActionSchema.safeParse({ type }).success, type).toBe(true);
      expect(m365ReadActionSchema.safeParse({ type }).success, type).toBe(true);
    }
    expect(m365SyncActionSchema.safeParse({
      type: 'm365.sync.signin_activity', continuation: 'x'.repeat(M365_SYNC_CONTINUATION_MAX_CHARS),
    }).success).toBe(true);
    expect(m365SyncActionSchema.safeParse({
      type: 'm365.sync.signin_activity', continuation: 'x'.repeat(M365_SYNC_CONTINUATION_MAX_CHARS + 1),
    }).success).toBe(false);
    expect(m365SyncActionSchema.safeParse({ type: 'm365.sync.secure_score', backfill: true }).success).toBe(true);
    // Options belong to exactly one branch.
    expect(m365SyncActionSchema.safeParse({ type: 'm365.sync.users', backfill: true }).success).toBe(false);
    expect(m365SyncActionSchema.safeParse({ type: 'm365.sync.skus', continuation: 'x' }).success).toBe(false);
    // The sync schema refuses interactive ids…
    expect(m365SyncActionSchema.safeParse({ type: 'm365.user.list' }).success).toBe(false);
    // …and syncActionRequestSchema refuses them too.
    expect(syncActionRequestSchema.safeParse({
      correlationId: GUID, tenantId: GUID, action: { type: 'm365.user.list' },
    }).success).toBe(false);
    expect(syncActionRequestSchema.safeParse({
      correlationId: GUID, tenantId: GUID, action: { type: 'm365.sync.users' },
    }).success).toBe(true);
  });

  it('narrows a parsed read action to the sync half', () => {
    const sync = m365ReadActionSchema.parse({ type: 'm365.sync.ca_policies' });
    const interactive = m365ReadActionSchema.parse({ type: 'm365.org.get' });
    expect(isM365SyncAction(sync)).toBe(true);
    expect(isM365SyncAction(interactive)).toBe(false);
  });

  it('round-trips the sync result, its continuation, and the failure union', () => {
    const result = {
      success: true as const,
      kind: 'sync' as const,
      items: [{ id: GUID, mfaRegistered: null }],
      truncated: false,
      fetchedAt: '2026-09-08T00:00:00.000Z',
      sources: { users: 'ok', mfaRegistration: 'permission_missing', roleAssignments: 'error' },
    };
    expect(m365SyncActionResultSchema.safeParse(result).success).toBe(true);
    expect(m365SyncActionResultSchema.safeParse({ ...result, continuation: 'opaque' }).success).toBe(true);
    expect(m365SyncActionResultSchema.safeParse({ ...result, sources: { users: 'nope' } }).success).toBe(false);
    expect(m365SyncActionResultSchema.safeParse({ ...result, extra: 1 }).success).toBe(false);
    expect(m365SyncActionResultSchema.safeParse({ ...result, fetchedAt: 'yesterday' }).success).toBe(false);

    expect(m365SyncActionResponseSchema.safeParse(result).success).toBe(true);
    expect(m365SyncActionResponseSchema.safeParse({
      success: false, errorCode: 'continuation_invalid',
    }).success).toBe(true);
    expect(m365SyncActionResponseSchema.safeParse({
      success: false, errorCode: 'graph_throttled', retryAfterSeconds: 45,
    }).success).toBe(true);
    // continuation_invalid is sync-only; the read failure enum stays unchanged.
    expect(m365SyncFailureCodeSchema.safeParse('continuation_invalid').success).toBe(true);
    expect(readActionFailureCodeSchema.safeParse('continuation_invalid').success).toBe(false);
    expect(m365SyncFailureCodeSchema.safeParse('sync_capacity').success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/shared && npx vitest run src/m365/readActions.test.ts
```

Expect import errors for every new name.

- [ ] **Step 3: Implement the shared additions**

In `packages/shared/src/m365/readActions.ts`, rename the shipped id list and splice in the sync half. Replace lines 13-21 with:

```ts
export const M365_INTERACTIVE_READ_ACTION_IDS = [
  'm365.user.list', 'm365.user.get', 'm365.signins.list',
  'm365.intune.device.list', 'm365.intune.device.get',
  'm365.group.list', 'm365.group.get', 'm365.group.members.list',
  'm365.org.get', 'm365.org.skus.list',
  'm365.sites.list', 'm365.site.get',
] as const;

/** Whole-domain snapshot pulls. Served on /v1/sync-action only (spec §4.2). */
export const M365_SYNC_ACTION_IDS = [
  'm365.sync.users',
  'm365.sync.signin_activity',
  'm365.sync.intune_devices',
  'm365.sync.ca_policies',
  'm365.sync.skus',
  'm365.sync.secure_score',
] as const;

export const M365_READ_ACTION_IDS = [
  ...M365_INTERACTIVE_READ_ACTION_IDS,
  ...M365_SYNC_ACTION_IDS,
] as const;

export type M365InteractiveReadActionId = typeof M365_INTERACTIVE_READ_ACTION_IDS[number];
export type M365SyncActionId = typeof M365_SYNC_ACTION_IDS[number];
export type M365ReadActionId = typeof M365_READ_ACTION_IDS[number];

const SYNC_ACTION_ID_SET: ReadonlySet<string> = new Set(M365_SYNC_ACTION_IDS);

export function isM365SyncActionId(id: string): id is M365SyncActionId {
  return SYNC_ACTION_ID_SET.has(id);
}

/** Max size of the executor-encrypted sign-in continuation blob (spec §4.1). */
export const M365_SYNC_CONTINUATION_MAX_CHARS = 4096;
```

Append the six projection entries inside `M365_READ_ACTION_FIELDS` (after `'m365.site.get'`). These list the **projected** keys, several of which are computed by the executor and have no Graph counterpart — that is deliberate (spec §4.1: "computed fields are listed explicitly"):

```ts
  // --- sync actions (spec §4.1). Computed keys (assignedLicenses as sku ids,
  // mfa*, adminRoles, lastSuccessfulSignInAt, controlScores) are allowlisted
  // here explicitly; the executor builds them and projects through this list
  // exactly as it does raw Graph objects.
  'm365.sync.users': [
    'id', 'userPrincipalName', 'displayName', 'mail', 'accountEnabled', 'jobTitle',
    'department', 'usageLocation', 'onPremisesSyncEnabled', 'createdDateTime',
    'assignedLicenses', 'mfaRegistered', 'mfaCapable', 'defaultMfaMethod', 'adminRoles',
  ],
  'm365.sync.signin_activity': ['id', 'lastSuccessfulSignInAt'],
  'm365.sync.intune_devices': [
    'id', 'deviceName', 'operatingSystem', 'osVersion', 'complianceState', 'lastSyncDateTime',
    'userPrincipalName', 'managedDeviceOwnerType', 'enrolledDateTime', 'model', 'manufacturer',
    'serialNumber', 'azureADDeviceId', 'managementAgent', 'jailBroken',
  ],
  'm365.sync.ca_policies': [
    'id', 'displayName', 'state', 'createdDateTime', 'modifiedDateTime',
    'conditions', 'grantControls', 'sessionControls',
  ],
  'm365.sync.skus': [
    'skuId', 'skuPartNumber', 'consumedUnits', 'prepaidUnits', 'capabilityStatus', 'appliesTo',
  ],
  'm365.sync.secure_score': [
    'id', 'createdDateTime', 'currentScore', 'maxScore', 'activeUserCount',
    'licensedUserCount', 'controlScores',
  ],
```

Replace the `m365ReadActionSchema` declaration (line 40) so both unions share one branch list. Keep the twelve shipped branch objects verbatim inside `INTERACTIVE_BRANCHES`:

```ts
const INTERACTIVE_BRANCHES = [
  /* the twelve shipped z.object(...).strict() branches, unchanged */
] as const;

const SYNC_BRANCHES = [
  z.object({ type: z.literal('m365.sync.users') }).strict(),
  z.object({
    type: z.literal('m365.sync.signin_activity'),
    // Opaque to the API: AES-256-GCM ciphertext minted by the executor.
    continuation: z.string().min(1).max(M365_SYNC_CONTINUATION_MAX_CHARS).optional(),
  }).strict(),
  z.object({ type: z.literal('m365.sync.intune_devices') }).strict(),
  z.object({ type: z.literal('m365.sync.ca_policies') }).strict(),
  z.object({ type: z.literal('m365.sync.skus') }).strict(),
  z.object({
    type: z.literal('m365.sync.secure_score'),
    // 90 daily scores on a first/re-seed run, 3 otherwise (spec §4.1).
    backfill: z.boolean().optional(),
  }).strict(),
] as const;

export const m365SyncActionSchema = z.discriminatedUnion('type', SYNC_BRANCHES);
export type M365SyncAction = z.infer<typeof m365SyncActionSchema>;

export const m365ReadActionSchema = z.discriminatedUnion('type', [
  ...INTERACTIVE_BRANCHES,
  ...SYNC_BRANCHES,
]);

export type M365ReadAction = z.infer<typeof m365ReadActionSchema>;
export type M365InteractiveReadAction = Exclude<M365ReadAction, M365SyncAction>;

export function isM365SyncAction(action: M365ReadAction): action is M365SyncAction {
  return isM365SyncActionId(action.type);
}
```

Append after `readActionResultSchema` (line 138):

```ts
export const syncActionRequestSchema = z.object({
  correlationId: guidSchema,
  tenantId: guidSchema,
  action: m365SyncActionSchema,
}).strict();

export type SyncActionRequest = z.infer<typeof syncActionRequestSchema>;

/**
 * Per-sub-source health for one domain pull (spec §4.3, §6). A domain's
 * PRIMARY source failing is a whole-action failure; a secondary source failing
 * is recorded here and the domain persists as `partial`.
 */
export const m365SyncSourceStateSchema = z.enum([
  'ok', 'unlicensed', 'permission_missing', 'throttled', 'error',
]);

export type M365SyncSourceState = z.infer<typeof m365SyncSourceStateSchema>;

export interface M365SyncActionResult {
  success: true;
  kind: 'sync';
  items: Record<string, unknown>[];
  truncated: boolean;
  continuation?: string;
  fetchedAt: string;
  sources: Record<string, M365SyncSourceState>;
}

export const m365SyncActionResultSchema: z.ZodType<M365SyncActionResult> = z.object({
  success: z.literal(true),
  kind: z.literal('sync'),
  items: z.array(readActionItemSchema),
  truncated: z.boolean(),
  continuation: z.string().min(1).max(M365_SYNC_CONTINUATION_MAX_CHARS).optional(),
  fetchedAt: z.string().datetime(),
  sources: z.record(z.string(), m365SyncSourceStateSchema),
}).strict();

/**
 * The read failure codes plus `continuation_invalid`. Deliberately NOT folded
 * into readActionFailureCodeSchema: that enum keys the exhaustive
 * FAILURE_MESSAGES record in the API's readActionService, which this contract
 * has no business widening.
 */
export const m365SyncFailureCodeSchema = z.enum([
  'credential_unavailable',
  'application_token_invalid',
  'graph_permission_missing',
  'graph_license_required',
  'graph_not_found',
  'graph_throttled',
  'graph_response_too_large',
  'graph_request_timeout',
  'graph_transport_failed',
  'graph_response_invalid',
  'continuation_invalid',
]);

export type M365SyncFailureCode = z.infer<typeof m365SyncFailureCodeSchema>;

export const m365SyncActionFailureSchema = z.object({
  success: z.literal(false),
  errorCode: m365SyncFailureCodeSchema,
  retryAfterSeconds: z.number().int().min(1).max(300).optional(),
}).strict();

export const m365SyncActionResponseSchema = z.union([
  m365SyncActionResultSchema,
  m365SyncActionFailureSchema,
]);

export type M365SyncActionResponse = z.infer<typeof m365SyncActionResponseSchema>;
```

- [ ] **Step 4: Repair the two shipped executor call sites**

In `apps/m365-graph-read-executor/src/microsoft/readActions.ts`:

- Change the import to pull `M365InteractiveReadAction` instead of `M365ReadAction`.
- Export the projector so `syncActions.ts` reuses it rather than cloning it — change line 34 to `export function project(`.
- Change the signature (line 84): `action: M365InteractiveReadAction`.
- Add, immediately above the `switch`, a comment noting that sync ids are rejected at the route (`app.ts`) and again in `readActionOperation`, so this union genuinely cannot see one.

In `apps/m365-graph-read-executor/src/microsoft/readActions.test.ts`:

- Import `M365_INTERACTIVE_READ_ACTION_IDS` and `type M365InteractiveReadActionId`; drop `M365_READ_ACTION_IDS` / `M365ReadActionId`.
- Re-key `SAMPLE_ACTIONS` (line 58) and `EXPECTED_PATH` (line 73) to `Record<M365InteractiveReadActionId, …>` (contents unchanged) and `RESOURCE_ACTION_IDS` to `Set<M365InteractiveReadActionId>`.
- Change line 99 to `it.each(M365_INTERACTIVE_READ_ACTION_IDS)(…)`.
- Change `SAMPLE_ACTIONS[actionId]`'s type annotation to `M365InteractiveReadAction`.

- [ ] **Step 5: Run both suites**

```bash
cd packages/shared && npx vitest run src/m365/readActions.test.ts src/m365/sync.test.ts
cd apps/m365-graph-read-executor && npx vitest run src/microsoft/readActions.test.ts
```

- [ ] **Step 6: Typecheck both packages**

```bash
pnpm --filter=@breeze/shared exec tsc --noEmit
pnpm --filter=@breeze/m365-graph-read-executor exec tsc --noEmit
pnpm --filter=@breeze/api exec tsc --noEmit
```

The API check matters: `readActionMetrics.ts:15,28,55` types on `M365ReadActionId`, which just widened by six ids. It compiles (those are parameter positions, not exhaustive records) — this step proves it.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/m365/readActions.ts packages/shared/src/m365/readActions.test.ts \
        apps/m365-graph-read-executor/src/microsoft/readActions.ts \
        apps/m365-graph-read-executor/src/microsoft/readActions.test.ts
git commit -m "feat(m365): six sync action branches, projections, and the sync wire result

Wave 3 task 2 of the M365 tenant sync foundation (spec §4.1, §4.3).

M365_READ_ACTION_IDS is now the interactive twelve plus the sync six, and the
two halves are separately named so the executor's interactive dispatch table
stays exhaustively typed (M365InteractiveReadAction). Sync projection lists
include the computed keys — assignedLicenses as sku ids, mfaRegistered /
mfaCapable / defaultMfaMethod, adminRoles, lastSuccessfulSignInAt,
controlScores — because the allowlist is the only thing that leaves the
executor and a computed field that is not listed cannot be smuggled out.

lastSignInDateTime is deliberately absent from the sign-in projection: it
counts failed interactive attempts, so it would misreport dormancy.

The sync response is a union. Failures reuse the read codes plus
continuation_invalid, in a SEPARATE enum: widening readActionFailureCodeSchema
would break the exhaustive FAILURE_MESSAGES record in the API's
readActionService, which this wave does not touch.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 3: Executor config — the sync limits env block

Spec §4.2 (env names and defaults). Overview contract, "Executor".

**Files:**
- Modify: `apps/m365-graph-read-executor/src/config.ts`
- Modify: `apps/m365-graph-read-executor/src/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `M365GraphReadExecutorConfig.sync: ExecutorSyncConfig` (consumed by Tasks 6–11 and by `index.ts`):

```ts
export interface ExecutorSyncConfig {
  syncMaxInFlight: number;        // M365_SYNC_MAX_IN_FLIGHT, default 4
  maxInFlight: number;            // M365_MAX_IN_FLIGHT, default 32
  signinActivityRpm: number;      // M365_SIGNIN_ACTIVITY_RPM, default 4
  signinPagesPerCall: number;     // M365_SIGNIN_PAGES_PER_CALL, default 5
  maxItemsUsers: number;          // M365_SYNC_MAX_ITEMS_USERS, default 25_000
  maxItemsDevices: number;        // M365_SYNC_MAX_ITEMS_DEVICES, default 25_000
  maxItemsCaPolicies: number;     // M365_SYNC_MAX_ITEMS_CA, default 500
  maxItemsSkus: number;           // M365_SYNC_MAX_ITEMS_SKUS, default 200
  continuationKey: Buffer | null; // M365_SYNC_CONTINUATION_KEY (32-byte base64), null = ephemeral
}
```

⚠️ `config.test.ts:41-56` asserts the whole config object with `toEqual`, so it fails the moment a field is added. Update it in this task.

- [ ] **Step 1: Write the failing tests**

Append to `apps/m365-graph-read-executor/src/config.test.ts`:

```ts
describe('M365 Graph-read executor sync limits', () => {
  it('defaults every sync limit and leaves the continuation key ephemeral', () => {
    expect(loadExecutorConfig(validEnv()).sync).toEqual({
      syncMaxInFlight: 4,
      maxInFlight: 32,
      signinActivityRpm: 4,
      signinPagesPerCall: 5,
      maxItemsUsers: 25_000,
      maxItemsDevices: 25_000,
      maxItemsCaPolicies: 500,
      maxItemsSkus: 200,
      continuationKey: null,
    });
  });

  it('parses explicit overrides and a 32-byte base64 continuation key', () => {
    const key = Buffer.alloc(32, 7);
    expect(loadExecutorConfig(validEnv({
      M365_SYNC_MAX_IN_FLIGHT: '2',
      M365_MAX_IN_FLIGHT: '8',
      M365_SIGNIN_ACTIVITY_RPM: '1',
      M365_SIGNIN_PAGES_PER_CALL: '20',
      M365_SYNC_MAX_ITEMS_USERS: '1000',
      M365_SYNC_MAX_ITEMS_DEVICES: '2000',
      M365_SYNC_MAX_ITEMS_CA: '50',
      M365_SYNC_MAX_ITEMS_SKUS: '10',
      M365_SYNC_CONTINUATION_KEY: key.toString('base64'),
    })).sync).toEqual({
      syncMaxInFlight: 2,
      maxInFlight: 8,
      signinActivityRpm: 1,
      signinPagesPerCall: 20,
      maxItemsUsers: 1000,
      maxItemsDevices: 2000,
      maxItemsCaPolicies: 50,
      maxItemsSkus: 10,
      continuationKey: key,
    });
  });

  it.each([
    ['M365_SYNC_MAX_IN_FLIGHT', '0'],
    ['M365_SYNC_MAX_IN_FLIGHT', '65'],
    ['M365_SYNC_MAX_IN_FLIGHT', '2.5'],
    ['M365_SYNC_MAX_IN_FLIGHT', 'four'],
    ['M365_MAX_IN_FLIGHT', '0'],
    ['M365_MAX_IN_FLIGHT', '1025'],
    ['M365_SIGNIN_ACTIVITY_RPM', '0'],
    ['M365_SIGNIN_ACTIVITY_RPM', '61'],
    ['M365_SIGNIN_PAGES_PER_CALL', '0'],
    ['M365_SIGNIN_PAGES_PER_CALL', '61'],
    ['M365_SYNC_MAX_ITEMS_USERS', '0'],
    ['M365_SYNC_MAX_ITEMS_USERS', '200001'],
    ['M365_SYNC_MAX_ITEMS_SKUS', '0'],
  ])('refuses %s=%s', (name, value) => {
    expect(() => loadExecutorConfig(validEnv({ [name]: value }))).toThrow(name);
  });

  it('refuses a total cap below the sync cap — interactive headroom must exist', () => {
    expect(() => loadExecutorConfig(validEnv({
      M365_SYNC_MAX_IN_FLIGHT: '8', M365_MAX_IN_FLIGHT: '4',
    }))).toThrow('M365_MAX_IN_FLIGHT');
  });

  it.each([
    Buffer.alloc(31, 1).toString('base64'),
    Buffer.alloc(33, 1).toString('base64'),
    'not base64 at all!!',
  ])('refuses a continuation key that is not exactly 32 bytes of base64', (value) => {
    expect(() => loadExecutorConfig(validEnv({ M365_SYNC_CONTINUATION_KEY: value })))
      .toThrow('M365_SYNC_CONTINUATION_KEY');
  });
});
```

And extend the shipped `toEqual` at `config.test.ts:41` with the defaulted block, immediately after `port: 8788,`:

```ts
      sync: {
        syncMaxInFlight: 4,
        maxInFlight: 32,
        signinActivityRpm: 4,
        signinPagesPerCall: 5,
        maxItemsUsers: 25_000,
        maxItemsDevices: 25_000,
        maxItemsCaPolicies: 500,
        maxItemsSkus: 200,
        continuationKey: null,
      },
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/m365-graph-read-executor && npx vitest run src/config.test.ts
```

- [ ] **Step 3: Implement**

In `apps/m365-graph-read-executor/src/config.ts`, add above `M365GraphReadExecutorConfig` (line 37):

```ts
export interface ExecutorSyncConfig {
  syncMaxInFlight: number;
  maxInFlight: number;
  signinActivityRpm: number;
  signinPagesPerCall: number;
  maxItemsUsers: number;
  maxItemsDevices: number;
  maxItemsCaPolicies: number;
  maxItemsSkus: number;
  /**
   * Continuation encryption secret. `null` means "mint an ephemeral one at
   * boot": continuations then die with the process and do not cross replicas,
   * which the API handles by restarting the sign-in domain from page 1. That
   * is a deliberate, self-healing default — it keeps the var optional for
   * every already-deployed executor.
   *
   * The spec asks for a key derived from the executor's signing key; the
   * executor holds only the PUBLIC verification JWK (parsePublicJwk below), so
   * there is no private material here to derive from.
   */
  continuationKey: Buffer | null;
}
```

Add `sync: ExecutorSyncConfig;` as the last field of `M365GraphReadExecutorConfig`, and these parsers above `loadExecutorConfig` (line 158):

```ts
const CONTINUATION_KEY_BYTES = 32;
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

function boundedInteger(
  source: Environment,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = source[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function parseContinuationKey(source: Environment): Buffer | null {
  const raw = source.M365_SYNC_CONTINUATION_KEY?.trim();
  if (!raw) return null;
  // Buffer.from(_, 'base64') silently drops invalid characters, so the regex —
  // not the decode — is what rejects a malformed key.
  if (!BASE64_32_BYTES.test(raw)) {
    throw new Error(`M365_SYNC_CONTINUATION_KEY must be exactly ${CONTINUATION_KEY_BYTES} bytes of base64`);
  }
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.byteLength !== CONTINUATION_KEY_BYTES) {
    throw new Error(`M365_SYNC_CONTINUATION_KEY must be exactly ${CONTINUATION_KEY_BYTES} bytes of base64`);
  }
  return decoded;
}

function parseSyncConfig(source: Environment): ExecutorSyncConfig {
  const syncMaxInFlight = boundedInteger(source, 'M365_SYNC_MAX_IN_FLIGHT', 4, 1, 64);
  const maxInFlight = boundedInteger(source, 'M365_MAX_IN_FLIGHT', 32, 1, 1024);
  if (maxInFlight < syncMaxInFlight) {
    throw new Error('M365_MAX_IN_FLIGHT must be greater than or equal to M365_SYNC_MAX_IN_FLIGHT');
  }
  return {
    syncMaxInFlight,
    maxInFlight,
    signinActivityRpm: boundedInteger(source, 'M365_SIGNIN_ACTIVITY_RPM', 4, 1, 60),
    signinPagesPerCall: boundedInteger(source, 'M365_SIGNIN_PAGES_PER_CALL', 5, 1, 60),
    maxItemsUsers: boundedInteger(source, 'M365_SYNC_MAX_ITEMS_USERS', 25_000, 1, 200_000),
    maxItemsDevices: boundedInteger(source, 'M365_SYNC_MAX_ITEMS_DEVICES', 25_000, 1, 200_000),
    maxItemsCaPolicies: boundedInteger(source, 'M365_SYNC_MAX_ITEMS_CA', 500, 1, 5_000),
    maxItemsSkus: boundedInteger(source, 'M365_SYNC_MAX_ITEMS_SKUS', 200, 1, 5_000),
    continuationKey: parseContinuationKey(source),
  };
}
```

Finally add `sync: parseSyncConfig(source),` as the last property of the object `loadExecutorConfig` returns.

- [ ] **Step 4: Run — green**

```bash
cd apps/m365-graph-read-executor && npx vitest run src/config.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/m365-graph-read-executor/src/config.ts apps/m365-graph-read-executor/src/config.test.ts
git commit -m "feat(m365): executor sync limit configuration

Wave 3 task 3 of the M365 tenant sync foundation (spec 4.2).

Eight bounded integers with the spec defaults plus an optional 32-byte
continuation key. M365_MAX_IN_FLIGHT is validated >= M365_SYNC_MAX_IN_FLIGHT
so the interactive-headroom guarantee holds by construction rather than by
operator discipline.

The continuation key is optional and defaults to an ephemeral per-process
secret: the executor holds only the PUBLIC verification JWK, so the spec
'derive from the signing key' is not available to it, and a new mandatory var
would refuse to boot every already-deployed executor. Losing continuations on
restart costs one restarted sign-in page walk.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 4: Executor metrics registry and `GET /metrics`

Spec §7 (executor row). Overview contract, "Metrics".

The executor exposes **no** metrics today: no `prom-client` dependency, no `/metrics` route (verified — `grep -rn "prom-client|/metrics" apps/m365-graph-read-executor` returns nothing). It is the process holding the only customer credential, so this task adds a ~90-line dependency-free text renderer rather than a dependency. Names are the contract's, unprefixed (the API's own counters carry the `breeze_` prefix and live behind a different scrape target).

**Files:**
- Create: `apps/m365-graph-read-executor/src/metrics.ts`
- Create: `apps/m365-graph-read-executor/src/metrics.test.ts`

**Interfaces:**
- Consumes: `M365SyncActionId` from `@breeze/shared/m365`.
- Produces:
  - `incrementSyncAction(action: M365SyncActionId, outcome: string): void`
  - `incrementSyncCapacityRejected(kind: 'sync' | 'interactive'): void`
  - `setSyncInFlight(n: number): void`, `setTotalInFlight(n: number): void`, `setSigninLimiterTokens(n: number): void`
  - `renderMetrics(): string`
  - `resetMetrics(): void` (tests only)

- [ ] **Step 1: Write the failing test**

Create `apps/m365-graph-read-executor/src/metrics.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import {
  incrementSyncAction,
  incrementSyncCapacityRejected,
  renderMetrics,
  resetMetrics,
  setSigninLimiterTokens,
  setSyncInFlight,
  setTotalInFlight,
} from './metrics';

const SERIES = [
  'm365_sync_actions_total',
  'm365_sync_capacity_rejected_total',
  'm365_sync_in_flight',
  'm365_in_flight_total',
  'm365_signin_limiter_tokens',
];

describe('executor metrics registry', () => {
  beforeEach(() => resetMetrics());

  it('renders every contracted series, gauges at zero included', () => {
    const text = renderMetrics();
    for (const name of SERIES) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} `);
    }
    expect(text).toContain('m365_sync_in_flight 0');
    expect(text).toContain('m365_in_flight_total 0');
    expect(text).toContain('m365_signin_limiter_tokens 0');
  });

  it('accumulates counters per label set', () => {
    incrementSyncAction('m365.sync.users', 'ok');
    incrementSyncAction('m365.sync.users', 'ok');
    incrementSyncAction('m365.sync.users', 'graph_throttled');
    incrementSyncCapacityRejected('sync');
    const text = renderMetrics();
    expect(text).toContain('m365_sync_actions_total{action="m365.sync.users",outcome="ok"} 2');
    expect(text).toContain('m365_sync_actions_total{action="m365.sync.users",outcome="graph_throttled"} 1');
    expect(text).toContain('m365_sync_capacity_rejected_total{kind="sync"} 1');
  });

  it('sets gauges to the last value, not a running total', () => {
    setSyncInFlight(3);
    setSyncInFlight(1);
    setTotalInFlight(9);
    setSigninLimiterTokens(2);
    const text = renderMetrics();
    expect(text).toContain('m365_sync_in_flight 1');
    expect(text).toContain('m365_in_flight_total 9');
    expect(text).toContain('m365_signin_limiter_tokens 2');
  });

  it('emits only registered series, one sample per line', () => {
    incrementSyncCapacityRejected('interactive');
    incrementSyncAction('m365.sync.ca_policies', 'error');
    for (const line of renderMetrics().split('\n').filter((l) => l && !l.startsWith('#'))) {
      const name = line.split(/[{ ]/)[0]!;
      expect(SERIES).toContain(name);
      expect(line).toMatch(/ [0-9]+$/);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/m365-graph-read-executor && npx vitest run src/metrics.test.ts
```

- [ ] **Step 3: Implement**

Create `apps/m365-graph-read-executor/src/metrics.ts`:

```ts
import type { M365SyncActionId } from '@breeze/shared/m365';

/**
 * Prometheus text exposition for the executor (spec §7, executor row).
 *
 * Hand-rolled on purpose: this process holds the only customer credential, so
 * its dependency set stays minimal and Trivy-scannable. The registry is a
 * fixed, CLOSED set — there is no dynamic metric creation, so a typo cannot
 * silently mint a new series.
 *
 * Names are unprefixed, per the wave's shared interface contract. The API's
 * own counters carry `breeze_` and live behind a different scrape target.
 */

const COUNTERS = {
  m365_sync_actions_total: {
    help: 'M365 whole-domain sync actions executed, by action and outcome',
    labelNames: ['action', 'outcome'] as readonly string[],
  },
  m365_sync_capacity_rejected_total: {
    help: 'Requests refused because a per-instance in-flight cap was reached',
    labelNames: ['kind'] as readonly string[],
  },
} as const;

const GAUGES = {
  m365_sync_in_flight: 'Sync actions currently executing on this instance',
  m365_in_flight_total: 'All executor operations currently executing on this instance',
  m365_signin_limiter_tokens: 'Whole tokens available in the app-wide sign-in activity bucket',
} as const;

type CounterName = keyof typeof COUNTERS;
type GaugeName = keyof typeof GAUGES;

const counterValues = new Map<CounterName, Map<string, { labels: string[]; value: number }>>();
const gaugeValues = new Map<GaugeName, number>();

function increment(name: CounterName, labels: string[]): void {
  let series = counterValues.get(name);
  if (!series) {
    series = new Map();
    counterValues.set(name, series);
  }
  const key = labels.join('\u0000');
  const existing = series.get(key);
  if (existing) existing.value += 1;
  else series.set(key, { labels, value: 1 });
}

export function incrementSyncAction(action: M365SyncActionId, outcome: string): void {
  increment('m365_sync_actions_total', [action, outcome]);
}

export function incrementSyncCapacityRejected(kind: 'sync' | 'interactive'): void {
  increment('m365_sync_capacity_rejected_total', [kind]);
}

export function setSyncInFlight(value: number): void {
  gaugeValues.set('m365_sync_in_flight', value);
}

export function setTotalInFlight(value: number): void {
  gaugeValues.set('m365_in_flight_total', value);
}

export function setSigninLimiterTokens(value: number): void {
  gaugeValues.set('m365_signin_limiter_tokens', value);
}

/** Label values here are closed enums, but escape anyway — the format is a contract. */
function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

export function renderMetrics(): string {
  const lines: string[] = [];
  for (const name of Object.keys(COUNTERS) as CounterName[]) {
    const definition = COUNTERS[name];
    lines.push(`# HELP ${name} ${definition.help}`, `# TYPE ${name} counter`);
    for (const { labels, value } of counterValues.get(name)?.values() ?? []) {
      const rendered = definition.labelNames
        .map((labelName, index) => `${labelName}="${escapeLabelValue(labels[index] ?? '')}"`)
        .join(',');
      lines.push(`${name}{${rendered}} ${value}`);
    }
  }
  for (const name of Object.keys(GAUGES) as GaugeName[]) {
    lines.push(`# HELP ${name} ${GAUGES[name]}`, `# TYPE ${name} gauge`, `${name} ${gaugeValues.get(name) ?? 0}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Test-only. Never called from the serving path. */
export function resetMetrics(): void {
  counterValues.clear();
  gaugeValues.clear();
}
```

The `GET /metrics` route is wired in Task 11 alongside the other `app.ts` changes, so that file is edited once.

- [ ] **Step 4: Run — green**

```bash
cd apps/m365-graph-read-executor && npx vitest run src/metrics.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/m365-graph-read-executor/src/metrics.ts apps/m365-graph-read-executor/src/metrics.test.ts
git commit -m "feat(m365): dependency-free Prometheus registry for the executor

Wave 3 task 4 of the M365 tenant sync foundation (spec 7).

The executor exposed no metrics at all. Rather than add prom-client to the one
process that holds the customer certificate, this is ~90 lines of text
exposition over a CLOSED registry: two counters and three gauges declared up
front, no dynamic metric creation, so a typo cannot mint a series.

Gauges render at zero when untouched so a scrape can tell idle from not-wired.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 5: Graph client sync profile — `readSyncCollection`

Spec §4.2 (sync profile: 60 pages / env item cap / 64 MiB / 110 s AbortController; `Retry-After` honoured on 429/503 up to 3 attempts and 60 s cumulative, then `graph_throttled`; CA policies use a fixed 2 s backoff because Graph sends no `Retry-After` there).

The shipped `readCollection` (`graphClient.ts:482-519`) is the interactive profile: it takes `maxItems`/`maxPages` per call but shares the client-wide `maxRequestCount` (20), `maxItemCount` (1 000), `maxResponseBytes` (512 KiB) and `timeoutMs` (10 s) from `graphClient.ts:7-10`, has no retry, no deadline, and cannot resume. **It is left byte-for-byte unchanged** — the interactive profile must not move.

**Files:**
- Modify: `apps/m365-graph-read-executor/src/microsoft/graphClient.ts`
- Modify: `apps/m365-graph-read-executor/src/microsoft/graphClient.test.ts`

**Interfaces:**
- Consumes: `OpaqueAccessToken`.
- Produces, on `MicrosoftGraphClient`:

```ts
export type GraphSyncStopReason = 'complete' | 'max_pages' | 'max_items' | 'paused' | 'deadline';

export interface GraphSyncRetryPolicy {
  maxAttempts: number;        // total attempts per page, including the first
  cumulativeBudgetMs: number; // total time spent sleeping across one page set
  fixedBackoffMs?: number;    // when set, ignore Retry-After (CA policies)
}

export interface GraphSyncLimits {
  maxItems: number;
  maxPages: number;
  maxResponseBytes: number;
  deadlineAt: number;             // epoch ms — hard cancellation point
  perRequestTimeoutMs?: number;   // default 30_000
  retry?: GraphSyncRetryPolicy;   // default { maxAttempts: 3, cumulativeBudgetMs: 60_000 }
}

export interface GraphSyncPageSet {
  items: Record<string, unknown>[];
  stopReason: GraphSyncStopReason;
  nextLink?: string;              // present whenever stopReason !== 'complete' and Graph offered one
  pages: number;
}

readSyncCollection(input: {
  accessToken: OpaqueAccessToken;
  path: string;                   // '/users' — also the expected nextLink path
  query?: Record<string, string>;
  startUrl?: string;              // resume point from a decrypted continuation
  limits: GraphSyncLimits;
  beforePage?: () => boolean;     // false ⇒ stop now, hand back nextLink (the sign-in limiter)
}): Promise<GraphSyncPageSet>;
```

- Also produces two injectable seams on `GraphClientDependencies`: `now?: () => number` and `sleep?: (ms: number, signal: AbortSignal) => Promise<void>`.

**Why the caller decides `truncated`:** `readSyncCollection` reports *why* it stopped and hands back the resume link; only the action knows whether "stopped early" means truncation (devices) or a continuation (sign-in). Folding that into a boolean here would force sign-in activity to report `truncated: true` on every normal paged run.

- [ ] **Step 1: Write the failing tests**

Append to `apps/m365-graph-read-executor/src/microsoft/graphClient.test.ts` (reusing that file's `json()` helper and route-table `fetch` stub style at lines 20-70):

```ts
describe('readSyncCollection', () => {
  const USERS_PATH = '/v1.0/users';
  const DEADLINE = 10_000_000;

  function pagedFetch(pages: Array<{ value: unknown[]; next?: string }>) {
    let index = 0;
    return vi.fn(async () => {
      const page = pages[index++];
      if (!page) throw new Error('fetched more pages than the fixture defines');
      return json(page.next === undefined
        ? { value: page.value }
        : { value: page.value, '@odata.nextLink': page.next });
    });
  }

  function syncClient(fetchImpl: typeof fetch, extra: { sleep?: (ms: number, signal: AbortSignal) => Promise<void>; now?: () => number } = {}) {
    return createMicrosoftGraphClient({ applicationId: APPLICATION_ID }, { fetch: fetchImpl, ...extra });
  }

  const limits = (over: Partial<Parameters<ReturnType<typeof syncClient>['readSyncCollection']>[0]['limits']> = {}) => ({
    maxItems: 1_000, maxPages: 60, maxResponseBytes: 64 * 1024 * 1024, deadlineAt: DEADLINE, ...over,
  });

  it('walks every page and reports completion', async () => {
    const fetchImpl = pagedFetch([
      { value: [{ id: 'a' }], next: `https://graph.microsoft.com${USERS_PATH}?$skiptoken=1` },
      { value: [{ id: 'b' }] },
    ]);
    const result = await syncClient(fetchImpl as unknown as typeof fetch).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users', query: { '$top': '999' }, limits: limits(),
    });
    expect(result.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(result.stopReason).toBe('complete');
    expect(result.nextLink).toBeUndefined();
    expect(result.pages).toBe(2);
  });

  it('stops at maxPages and hands back the resume link', async () => {
    const fetchImpl = pagedFetch([
      { value: [{ id: 'a' }], next: `https://graph.microsoft.com${USERS_PATH}?$skiptoken=1` },
      { value: [{ id: 'b' }], next: `https://graph.microsoft.com${USERS_PATH}?$skiptoken=2` },
    ]);
    const result = await syncClient(fetchImpl as unknown as typeof fetch).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users', limits: limits({ maxPages: 2 }),
    });
    expect(result.stopReason).toBe('max_pages');
    expect(result.nextLink).toBe(`https://graph.microsoft.com${USERS_PATH}?$skiptoken=2`);
    expect(result.items).toHaveLength(2);
  });

  it('stops at maxItems mid-page and drops the overflow', async () => {
    const fetchImpl = pagedFetch([{ value: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }]);
    const result = await syncClient(fetchImpl as unknown as typeof fetch).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users', limits: limits({ maxItems: 2 }),
    });
    expect(result.stopReason).toBe('max_items');
    expect(result.items).toHaveLength(2);
  });

  it('pauses before a page when beforePage refuses, returning the resume link', async () => {
    const fetchImpl = pagedFetch([
      { value: [{ id: 'a' }], next: `https://graph.microsoft.com${USERS_PATH}?$skiptoken=1` },
    ]);
    let allowed = 1;
    const result = await syncClient(fetchImpl as unknown as typeof fetch).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users', limits: limits(), beforePage: () => allowed-- > 0,
    });
    expect(result.stopReason).toBe('paused');
    expect(result.nextLink).toBe(`https://graph.microsoft.com${USERS_PATH}?$skiptoken=1`);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('pauses before the FIRST page with zero items when the bucket is already empty', async () => {
    const fetchImpl = vi.fn();
    const result = await syncClient(fetchImpl as unknown as typeof fetch).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users', limits: limits(), beforePage: () => false,
    });
    expect(result).toMatchObject({ items: [], stopReason: 'paused', pages: 0 });
    expect(result.nextLink).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resumes from a validated startUrl and refuses one pointing anywhere else', async () => {
    const fetchImpl = pagedFetch([{ value: [{ id: 'z' }] }]);
    const client = syncClient(fetchImpl as unknown as typeof fetch);
    const resumed = await client.readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users', limits: limits(),
      startUrl: `https://graph.microsoft.com${USERS_PATH}?$skiptoken=9`,
    });
    expect(resumed.items).toEqual([{ id: 'z' }]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`https://graph.microsoft.com${USERS_PATH}?$skiptoken=9`);

    for (const bad of [
      'https://evil.example.test/v1.0/users?$skiptoken=9',
      'https://graph.microsoft.com/v1.0/deviceManagement/managedDevices',
      'http://graph.microsoft.com/v1.0/users',
    ]) {
      await expect(client.readSyncCollection({
        accessToken: ACCESS_TOKEN, path: '/users', limits: limits(), startUrl: bad,
      })).rejects.toMatchObject({ code: 'graph_response_invalid' });
    }
  });

  it('honours Retry-After on 429 and succeeds on the retry', async () => {
    const slept: number[] = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7' } }))
      .mockResolvedValueOnce(json({ value: [{ id: 'a' }] }));
    const result = await syncClient(fetchImpl as unknown as typeof fetch, {
      sleep: async (ms) => { slept.push(ms); },
    }).readSyncCollection({ accessToken: ACCESS_TOKEN, path: '/users', limits: limits() });
    expect(slept).toEqual([7_000]);
    expect(result.items).toEqual([{ id: 'a' }]);
  });

  it('gives up after maxAttempts and surfaces graph_throttled with retryAfterSeconds', async () => {
    const slept: number[] = [];
    const throttled = () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '5' } });
    const fetchImpl = vi.fn().mockResolvedValue(throttled());
    await expect(syncClient(fetchImpl as unknown as typeof fetch, { sleep: async (ms) => { slept.push(ms); } })
      .readSyncCollection({ accessToken: ACCESS_TOKEN, path: '/users', limits: limits() }))
      .rejects.toMatchObject({ code: 'graph_throttled', retryAfterSeconds: 5 });
    expect(slept).toEqual([5_000, 5_000]); // 3 attempts ⇒ 2 sleeps
  });

  it('stops sleeping once the cumulative throttle budget is spent', async () => {
    const slept: number[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('{}', { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '90' } }),
    );
    await expect(syncClient(fetchImpl as unknown as typeof fetch, { sleep: async (ms) => { slept.push(ms); } })
      .readSyncCollection({
        accessToken: ACCESS_TOKEN, path: '/users',
        limits: limits({ retry: { maxAttempts: 3, cumulativeBudgetMs: 60_000 } }),
      }))
      .rejects.toMatchObject({ code: 'graph_throttled' });
    expect(slept).toEqual([]); // 90 s > the 60 s budget: never sleep, fail immediately
  });

  it('uses a fixed backoff when the policy sets one — CA policies send no Retry-After', async () => {
    const slept: number[] = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(json({ value: [{ id: 'p' }] }));
    await syncClient(fetchImpl as unknown as typeof fetch, { sleep: async (ms) => { slept.push(ms); } })
      .readSyncCollection({
        accessToken: ACCESS_TOKEN, path: '/identity/conditionalAccess/policies',
        limits: limits({ retry: { maxAttempts: 3, cumulativeBudgetMs: 60_000, fixedBackoffMs: 2_000 } }),
      });
    expect(slept).toEqual([2_000]); // NOT the 60 s Retry-After default
  });

  it('stops between pages when the remaining deadline cannot fit another request', async () => {
    let clock = 0;
    const fetchImpl = pagedFetch([
      { value: [{ id: 'a' }], next: `https://graph.microsoft.com${USERS_PATH}?$skiptoken=1` },
    ]);
    const result = await syncClient(fetchImpl as unknown as typeof fetch, {
      now: () => { clock += 25_000; return clock; },
    }).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users',
      limits: limits({ deadlineAt: 40_000, perRequestTimeoutMs: 30_000 }),
    });
    expect(result.stopReason).toBe('deadline');
    expect(result.nextLink).toBe(`https://graph.microsoft.com${USERS_PATH}?$skiptoken=1`);
  });

  it('aborts an in-flight request when the hard deadline passes', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    await expect(syncClient(fetchImpl as unknown as typeof fetch).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users',
      limits: limits({ deadlineAt: Date.now() + 20, perRequestTimeoutMs: 30_000 }),
    })).rejects.toMatchObject({ code: 'graph_request_timeout' });
  });

  it('bounds the cumulative response size across pages', async () => {
    const big = { value: [{ id: 'a', blob: 'x'.repeat(4_000) }], '@odata.nextLink': `https://graph.microsoft.com${USERS_PATH}?$skiptoken=1` };
    const fetchImpl = vi.fn(async () => json(big));
    await expect(syncClient(fetchImpl as unknown as typeof fetch).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users', limits: limits({ maxResponseBytes: 5_000 }),
    })).rejects.toMatchObject({ code: 'graph_response_too_large' });
  });

  it('maps 403 to graph_permission_missing without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'Authorization_RequestDenied' } }), {
        status: 403, headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(syncClient(fetchImpl as unknown as typeof fetch).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users', limits: limits(),
    })).rejects.toMatchObject({ code: 'graph_permission_missing' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/m365-graph-read-executor && npx vitest run src/microsoft/graphClient.test.ts
```

- [ ] **Step 3: Implement**

In `graphClient.ts`, add the new exported types after `GraphTenantObservation` (line 38), the `readSyncCollection` signature to `MicrosoftGraphClient`, `now`/`sleep` to `GraphClientDependencies` (line 68), and these constants next to the existing defaults (lines 7-10):

```ts
const DEFAULT_SYNC_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SYNC_RETRY: GraphSyncRetryPolicy = { maxAttempts: 3, cumulativeBudgetMs: 60_000 };
const RETRYABLE_STATUS = new Set([429, 503]);
```

Inside `createMicrosoftGraphClient`, after `readRequest` (line 293):

```ts
  const nowMs = dependencies.now ?? (() => Date.now());
  const sleepImpl = dependencies.sleep ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(failure('graph_request_timeout')); return; }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(failure('graph_request_timeout'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }));

  /**
   * One page fetch under the sync profile: retries 429/503 while a policy
   * budget allows, composes the per-request timeout with the whole-call
   * deadline signal so an expiring deadline cancels the in-flight fetch, and
   * charges bytes against the caller's cumulative budget (NOT the client-wide
   * 512 KiB interactive one).
   */
  async function syncRequest(
    url: string,
    accessToken: OpaqueAccessToken,
    budget: RequestBudget,
    limits: Required<Pick<GraphSyncLimits, 'maxResponseBytes'>> & {
      perRequestTimeoutMs: number;
      retry: GraphSyncRetryPolicy;
      deadlineSignal: AbortSignal;
    },
    throttleSpentMs: { value: number },
  ): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      const timeout = AbortSignal.timeout(limits.perRequestTimeoutMs);
      const signal = AbortSignal.any([timeout, limits.deadlineSignal]);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          redirect: 'error',
          headers: { authorization: `Bearer ${accessToken}` },
          signal,
        });
      } catch (error) {
        if (error instanceof GraphClientError) throw error;
        throw failure(signal.aborted ? 'graph_request_timeout' : 'graph_transport_failed');
      }

      if (RETRYABLE_STATUS.has(response.status)) {
        // Do not charge a throttle body against the byte budget.
        await response.body?.cancel().catch(() => {});
        const waitMs = limits.retry.fixedBackoffMs ?? retryAfterSecondsFromHeader(response) * 1_000;
        const outOfAttempts = attempt >= limits.retry.maxAttempts;
        const outOfBudget = throttleSpentMs.value + waitMs > limits.retry.cumulativeBudgetMs;
        const pastDeadline = nowMs() + waitMs + limits.perRequestTimeoutMs > deadlineOf(limits.deadlineSignal);
        if (outOfAttempts || outOfBudget || pastDeadline) {
          throw new GraphClientError('graph_throttled', Math.min(300, Math.max(1, Math.ceil(waitMs / 1_000))));
        }
        throttleSpentMs.value += waitMs;
        await sleepImpl(waitMs, limits.deadlineSignal);
        continue;
      }

      const responseBody = await readBoundedBody(response, budget, limits.maxResponseBytes);
      if (!response.ok) throw readFailure(response, responseBody);
      return parseJson(responseBody);
    }
  }
```

`deadlineOf` is awkward to read off a signal — pass the epoch instead. Use this shape for the options object rather than the one sketched above:

```ts
  interface SyncRequestOptions {
    maxResponseBytes: number;
    perRequestTimeoutMs: number;
    retry: GraphSyncRetryPolicy;
    deadlineAt: number;
    deadlineSignal: AbortSignal;
  }
```

and replace the `pastDeadline` line with `const pastDeadline = nowMs() + waitMs + limits.perRequestTimeoutMs > limits.deadlineAt;`.

Then the paging driver, added to the returned object after `readCollection` (line 519):

```ts
    async readSyncCollection(input) {
      const { limits } = input;
      if (!configValid
        || typeof input.accessToken !== 'string'
        || !input.accessToken
        || !input.path.startsWith('/')
        || !positiveInteger(limits.maxItems)
        || !positiveInteger(limits.maxPages)
        || !positiveInteger(limits.maxResponseBytes)
        || !Number.isSafeInteger(limits.deadlineAt)) {
        throw failure('graph_request_invalid');
      }
      const expectedPath = `/v1.0${input.path}`;
      const perRequestTimeoutMs = limits.perRequestTimeoutMs ?? DEFAULT_SYNC_REQUEST_TIMEOUT_MS;
      const retry = limits.retry ?? DEFAULT_SYNC_RETRY;
      const budget: RequestBudget = { bytes: 0, requests: 0, items: 0 };
      const throttleSpentMs = { value: 0 };
      const deadline = new AbortController();
      const remaining = limits.deadlineAt - nowMs();
      const deadlineTimer = setTimeout(() => deadline.abort(), Math.max(0, remaining));
      const options: SyncRequestOptions = {
        maxResponseBytes: limits.maxResponseBytes,
        perRequestTimeoutMs,
        retry,
        deadlineAt: limits.deadlineAt,
        deadlineSignal: deadline.signal,
      };

      const items: Record<string, unknown>[] = [];
      let pages = 0;
      let url: string | undefined = input.startUrl === undefined
        ? graphUrl(input.path, input.query)
        : fixedCollectionNextLink(input.startUrl, expectedPath);
      let stopReason: GraphSyncStopReason = 'complete';

      try {
        while (url !== undefined) {
          if (pages >= limits.maxPages) { stopReason = 'max_pages'; break; }
          if (nowMs() + perRequestTimeoutMs > limits.deadlineAt) { stopReason = 'deadline'; break; }
          if (input.beforePage !== undefined && !input.beforePage()) { stopReason = 'paused'; break; }

          const page = parseCollectionPage(await syncRequest(url, input.accessToken, budget, options, throttleSpentMs));
          pages += 1;
          let overflowed = false;
          for (const value of page.value) {
            if (!isRecord(value)) throw failure('graph_response_invalid');
            if (items.length >= limits.maxItems) { overflowed = true; break; }
            items.push(value);
          }
          if (overflowed) {
            stopReason = 'max_items';
            url = page.nextLink === undefined ? undefined : fixedCollectionNextLink(page.nextLink, expectedPath);
            break;
          }
          url = page.nextLink === undefined
            ? undefined
            : fixedCollectionNextLink(page.nextLink, expectedPath);
        }
      } finally {
        clearTimeout(deadlineTimer);
      }

      // `url` is the un-fetched resume point whenever we stopped early.
      return stopReason === 'complete'
        ? { items, stopReason, pages }
        : { items, stopReason, pages, ...(url === undefined ? {} : { nextLink: url }) };
    },
```

⚠️ In the "paused before the first page" case `url` is the *initial* URL, not a Graph-minted `nextLink`. Returning it would let the API resume a page-1 URL through the continuation codec — harmless but confusing, and it hides "we never started". Guard it: capture `const startedAt = input.startUrl` and, when `pages === 0 && input.startUrl === undefined`, omit `nextLink`. Implement that as an explicit `const resumeLink = pages === 0 && input.startUrl === undefined ? undefined : url;` and return `resumeLink`.

- [ ] **Step 4: Run — green, and prove the interactive profile did not move**

```bash
cd apps/m365-graph-read-executor && npx vitest run src/microsoft/graphClient.test.ts src/microsoft/readActions.test.ts
git diff apps/m365-graph-read-executor/src/microsoft/graphClient.ts | grep -E '^-' | grep -v '^---'
```

The `git diff` deletion list must contain **only** the `MicrosoftGraphClient` interface line the new method was inserted next to and the `GraphClientDependencies` line — no changed lines inside `readCollection`, `readRequest`, `request`, or `collection`.

- [ ] **Step 5: Commit**

```bash
git add apps/m365-graph-read-executor/src/microsoft/graphClient.ts apps/m365-graph-read-executor/src/microsoft/graphClient.test.ts
git commit -m "feat(m365): Graph client sync profile with deadline, retry, and resume

Wave 3 task 5 of the M365 tenant sync foundation (spec 4.2).

readSyncCollection is a second paging driver beside readCollection, not a
change to it: the interactive profile (20 pages / 1000 items / 512 KiB / 10 s,
no retry) is untouched, and the diff proves it.

The sync driver takes its limits per call, composes each request's timeout
with a whole-call AbortController deadline so an expiring deadline cancels the
in-flight fetch, honours Retry-After on 429/503 within an attempt count AND a
cumulative sleep budget AND the remaining deadline, and supports a fixed
backoff for Conditional Access, which returns 429 with no Retry-After at all.

It reports WHY it stopped and hands back the resume link rather than a
truncated boolean: only the action knows whether stopping early means
truncation (devices) or a continuation (sign-in activity).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 6: Continuation codec

Spec §4.1 ("encrypted and HMAC-bound by the executor … with `tenantId` and action id in the AAD … expire after 1 hour"). Deviations 1 and 2 above.

**Files:**
- Create: `apps/m365-graph-read-executor/src/syncContinuation.ts`
- Create: `apps/m365-graph-read-executor/src/syncContinuation.test.ts`

**Interfaces:**
- Consumes: `ExecutorSyncConfig['continuationKey']` (Task 3), `M365_SYNC_CONTINUATION_MAX_CHARS` and `M365SyncActionId` (Task 2).
- Produces:

```ts
export class SyncContinuationError extends Error { readonly code = 'continuation_invalid'; }

export interface SyncContinuationCodec {
  seal(input: { tenantId: string; action: M365SyncActionId; nextLink: string }): string;
  open(input: { tenantId: string; action: M365SyncActionId; continuation: string }): string;
}

export function createSyncContinuationCodec(config: {
  key: Buffer | null;
  ttlSeconds?: number;                 // default 3600
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}): SyncContinuationCodec;
```

Wire format (all binary, then one base64url string): `version(1) || iv(12) || ciphertext || tag(16)`, where the plaintext is `expiresAtSeconds(uint32 BE) || nextLink(utf8)` and the AES-256-GCM AAD is `v1|<tenantId>|<actionId>`. The content-encryption key is `hkdfSync('sha256', secret, salt='breeze-m365-sync-continuation', info='v1', 32)`.

- [ ] **Step 1: Write the failing test**

Create `apps/m365-graph-read-executor/src/syncContinuation.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSyncContinuationCodec, SyncContinuationError } from './syncContinuation';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const NEXT_LINK = 'https://graph.microsoft.com/v1.0/users?$skiptoken=abc123';
const ACTION = 'm365.sync.signin_activity' as const;
const KEY = Buffer.alloc(32, 3);

function codec(over: Partial<Parameters<typeof createSyncContinuationCodec>[0]> = {}) {
  return createSyncContinuationCodec({ key: KEY, now: () => 1_700_000_000_000, ...over });
}

describe('sync continuation codec', () => {
  it('round-trips a next link under the same tenant and action', () => {
    const sealed = codec().seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, URL/JSON safe
    expect(sealed.length).toBeLessThanOrEqual(4096);
    expect(codec().open({ tenantId: TENANT_A, action: ACTION, continuation: sealed })).toBe(NEXT_LINK);
  });

  it('never emits the same blob twice for the same input', () => {
    const one = codec().seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    const two = codec().seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    expect(one).not.toBe(two);
    expect(one).not.toContain('skiptoken'); // the token is not readable by the API
  });

  it('refuses a continuation replayed against another tenant', () => {
    const sealed = codec().seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    expect(() => codec().open({ tenantId: TENANT_B, action: ACTION, continuation: sealed }))
      .toThrow(SyncContinuationError);
  });

  it('refuses a continuation replayed against another action', () => {
    const sealed = codec().seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    expect(() => codec().open({ tenantId: TENANT_A, action: 'm365.sync.users', continuation: sealed }))
      .toThrow(SyncContinuationError);
  });

  it('expires after an hour', () => {
    const sealed = codec().seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    const later = codec({ now: () => 1_700_000_000_000 + 3_600_001 });
    expect(() => later.open({ tenantId: TENANT_A, action: ACTION, continuation: sealed }))
      .toThrow(SyncContinuationError);
    const justInside = codec({ now: () => 1_700_000_000_000 + 3_599_000 });
    expect(justInside.open({ tenantId: TENANT_A, action: ACTION, continuation: sealed })).toBe(NEXT_LINK);
  });

  it('refuses a blob minted under a different key', () => {
    const sealed = createSyncContinuationCodec({ key: Buffer.alloc(32, 9), now: () => 1_700_000_000_000 })
      .seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    expect(() => codec().open({ tenantId: TENANT_A, action: ACTION, continuation: sealed }))
      .toThrow(SyncContinuationError);
  });

  it.each([
    '', 'not-base64url!!', Buffer.alloc(4, 1).toString('base64url'), 'A'.repeat(5000),
  ])('refuses malformed input %#', (continuation) => {
    expect(() => codec().open({ tenantId: TENANT_A, action: ACTION, continuation }))
      .toThrow(SyncContinuationError);
  });

  it('refuses a flipped ciphertext bit (the GCM tag is the integrity check)', () => {
    const sealed = codec().seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    const bytes = Buffer.from(sealed, 'base64url');
    bytes[20] = bytes[20]! ^ 0x01;
    expect(() => codec().open({ tenantId: TENANT_A, action: ACTION, continuation: bytes.toString('base64url') }))
      .toThrow(SyncContinuationError);
  });

  it('mints an ephemeral key when none is configured, and two instances cannot read each other', () => {
    const first = createSyncContinuationCodec({ key: null, randomBytes });
    const second = createSyncContinuationCodec({ key: null, randomBytes });
    const sealed = first.seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    expect(first.open({ tenantId: TENANT_A, action: ACTION, continuation: sealed })).toBe(NEXT_LINK);
    expect(() => second.open({ tenantId: TENANT_A, action: ACTION, continuation: sealed }))
      .toThrow(SyncContinuationError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/m365-graph-read-executor && npx vitest run src/syncContinuation.test.ts
```

- [ ] **Step 3: Implement**

Create `apps/m365-graph-read-executor/src/syncContinuation.ts`:

```ts
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes as nodeRandomBytes,
} from 'node:crypto';
import { M365_SYNC_CONTINUATION_MAX_CHARS, type M365SyncActionId } from '@breeze/shared/m365';

/**
 * Opaque, tenant-bound, expiring resume tokens for resumable sync actions
 * (spec §4.1). The API stores the blob and hands it back; it can neither read
 * the Graph skip token nor forge one, and a blob minted for tenant A is
 * unusable against tenant B because the tenant id is authenticated data.
 *
 * The whole @odata.nextLink is sealed rather than the bare skip token: on
 * resume the URL goes back through graphClient's fixedCollectionNextLink
 * host/path guard, which is strictly stronger than re-assembling a URL from a
 * token we would have to trust.
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const EXPIRY_BYTES = 4;
const DEFAULT_TTL_SECONDS = 3_600;
const HKDF_SALT = 'breeze-m365-sync-continuation';
const HKDF_INFO = 'v1';
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class SyncContinuationError extends Error {
  readonly code = 'continuation_invalid' as const;

  constructor() {
    super('continuation_invalid');
    this.name = 'SyncContinuationError';
  }
}

export interface SyncContinuationCodec {
  seal(input: { tenantId: string; action: M365SyncActionId; nextLink: string }): string;
  open(input: { tenantId: string; action: M365SyncActionId; continuation: string }): string;
}

function additionalData(tenantId: string, action: M365SyncActionId): Buffer {
  return Buffer.from(`v${VERSION}|${tenantId}|${action}`, 'utf8');
}

export function createSyncContinuationCodec(config: {
  key: Buffer | null;
  ttlSeconds?: number;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}): SyncContinuationCodec {
  const random = config.randomBytes ?? nodeRandomBytes;
  const now = config.now ?? (() => Date.now());
  const ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const secret = config.key ?? random(KEY_BYTES);
  const key = Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO, KEY_BYTES));

  return {
    seal({ tenantId, action, nextLink }) {
      const iv = random(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(additionalData(tenantId, action));
      const expiry = Buffer.alloc(EXPIRY_BYTES);
      expiry.writeUInt32BE(Math.floor(now() / 1_000) + ttlSeconds);
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.concat([expiry, Buffer.from(nextLink, 'utf8')])),
        cipher.final(),
      ]);
      const sealed = Buffer.concat([Buffer.from([VERSION]), iv, ciphertext, cipher.getAuthTag()])
        .toString('base64url');
      if (sealed.length > M365_SYNC_CONTINUATION_MAX_CHARS) throw new SyncContinuationError();
      return sealed;
    },

    open({ tenantId, action, continuation }) {
      if (
        continuation.length === 0
        || continuation.length > M365_SYNC_CONTINUATION_MAX_CHARS
        || !BASE64URL.test(continuation)
      ) throw new SyncContinuationError();
      const bytes = Buffer.from(continuation, 'base64url');
      if (bytes.byteLength <= 1 + IV_BYTES + TAG_BYTES + EXPIRY_BYTES || bytes[0] !== VERSION) {
        throw new SyncContinuationError();
      }
      const iv = bytes.subarray(1, 1 + IV_BYTES);
      const tag = bytes.subarray(bytes.byteLength - TAG_BYTES);
      const ciphertext = bytes.subarray(1 + IV_BYTES, bytes.byteLength - TAG_BYTES);
      let plaintext: Buffer;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(additionalData(tenantId, action));
        decipher.setAuthTag(tag);
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        throw new SyncContinuationError();
      }
      if (plaintext.byteLength <= EXPIRY_BYTES) throw new SyncContinuationError();
      if (plaintext.readUInt32BE(0) * 1_000 <= now()) throw new SyncContinuationError();
      return plaintext.subarray(EXPIRY_BYTES).toString('utf8');
    },
  };
}
```

- [ ] **Step 4: Run — green**

```bash
cd apps/m365-graph-read-executor && npx vitest run src/syncContinuation.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/m365-graph-read-executor/src/syncContinuation.ts apps/m365-graph-read-executor/src/syncContinuation.test.ts
git commit -m "feat(m365): tenant-bound expiring sync continuations

Wave 3 task 6 of the M365 tenant sync foundation (spec 4.1).

AES-256-GCM over an HKDF-derived key, with 'v1|tenantId|actionId' as
authenticated data and a one-hour expiry inside the ciphertext. The API stores
an opaque base64url blob: it cannot read the Graph skip token, cannot forge
one, and cannot replay tenant A's resume point against tenant B or against a
different action.

The whole @odata.nextLink is sealed, not the bare skip token, so the resumed
URL goes back through the client's host/path guard instead of being trusted.

With no M365_SYNC_CONTINUATION_KEY the codec mints an ephemeral per-process
key, so continuations simply do not survive a restart or cross a replica — the
API sees continuation_invalid and restarts the page walk. A test pins that two
instances cannot read each other's blobs.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 7: App-wide sign-in limiter

Spec §4.2 (token bucket at `M365_SIGNIN_ACTIVITY_RPM`, default 4, per instance, **never blocks**).

**Files:**
- Create: `apps/m365-graph-read-executor/src/signinLimiter.ts`
- Create: `apps/m365-graph-read-executor/src/signinLimiter.test.ts`

**Interfaces:**
- Consumes: `setSigninLimiterTokens` (Task 4).
- Produces:

```ts
export interface SigninLimiter {
  tryTake(): boolean;   // non-blocking; false ⇒ the caller stops paging
  tokens(): number;
}
export function createSigninLimiter(config: { requestsPerMinute: number; now?: () => number }): SigninLimiter;
```

- [ ] **Step 1: Write the failing test**

Create `apps/m365-graph-read-executor/src/signinLimiter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSigninLimiter } from './signinLimiter';
import { renderMetrics, resetMetrics } from './metrics';

describe('app-wide sign-in activity limiter', () => {
  it('starts full and drains one token per request', () => {
    let clock = 0;
    const limiter = createSigninLimiter({ requestsPerMinute: 4, now: () => clock });
    expect(limiter.tokens()).toBe(4);
    for (let i = 0; i < 4; i += 1) expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(false);
    expect(limiter.tokens()).toBe(0);
  });

  it('refills continuously, never above the burst ceiling', () => {
    let clock = 0;
    const limiter = createSigninLimiter({ requestsPerMinute: 4, now: () => clock });
    for (let i = 0; i < 4; i += 1) limiter.tryTake();
    clock += 15_000;                       // 15 s at 4/min ⇒ exactly one token
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(false);
    clock += 600_000;                      // ten minutes of idling
    expect(limiter.tokens()).toBe(4);      // capped at the burst ceiling
  });

  it('never blocks — tryTake is synchronous and total', () => {
    const limiter = createSigninLimiter({ requestsPerMinute: 1, now: () => 0 });
    expect(typeof limiter.tryTake()).toBe('boolean');
    expect(typeof limiter.tryTake()).toBe('boolean');
  });

  it('publishes whole remaining tokens as a gauge', () => {
    resetMetrics();
    let clock = 0;
    const limiter = createSigninLimiter({ requestsPerMinute: 4, now: () => clock });
    limiter.tryTake();
    expect(renderMetrics()).toContain('m365_signin_limiter_tokens 3');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/m365-graph-read-executor && npx vitest run src/signinLimiter.test.ts
```

- [ ] **Step 3: Implement**

Create `apps/m365-graph-read-executor/src/signinLimiter.ts`:

```ts
import { setSigninLimiterTokens } from './metrics';

/**
 * Token bucket for /users?$select=signInActivity requests (spec §4.2).
 *
 * Graph throttles that select at 10 requests per minute PER APP ACROSS ALL
 * TENANTS, not per tenant, so the limit is a property of this process, not of
 * a connection. The default of 4/min leaves headroom under 10 and lets two
 * regions share one app registration at 4 + 4. With more than one replica the
 * operator divides the value.
 *
 * tryTake NEVER blocks: an empty bucket makes the caller stop paging and hand
 * back a continuation, which is strictly better than holding an executor slot
 * asleep for fifteen seconds.
 */
export interface SigninLimiter {
  tryTake(): boolean;
  tokens(): number;
}

const MS_PER_MINUTE = 60_000;

export function createSigninLimiter(config: {
  requestsPerMinute: number;
  now?: () => number;
}): SigninLimiter {
  const now = config.now ?? (() => Date.now());
  const capacity = config.requestsPerMinute;
  const refillPerMs = capacity / MS_PER_MINUTE;
  let available = capacity;
  let updatedAt = now();

  function refill(): void {
    const at = now();
    if (at > updatedAt) {
      available = Math.min(capacity, available + (at - updatedAt) * refillPerMs);
      updatedAt = at;
    }
    setSigninLimiterTokens(Math.floor(available));
  }

  return {
    tryTake() {
      refill();
      if (available < 1) return false;
      available -= 1;
      setSigninLimiterTokens(Math.floor(available));
      return true;
    },
    tokens() {
      refill();
      return Math.floor(available);
    },
  };
}
```

- [ ] **Step 4: Run — green**

```bash
cd apps/m365-graph-read-executor && npx vitest run src/signinLimiter.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/m365-graph-read-executor/src/signinLimiter.ts apps/m365-graph-read-executor/src/signinLimiter.test.ts
git commit -m "feat(m365): non-blocking app-wide sign-in activity limiter

Wave 3 task 7 of the M365 tenant sync foundation (spec 4.2).

Graph throttles the signInActivity select at 10 req/min per APP across all
tenants, so the budget belongs to the process, not to a connection. A
continuously refilling token bucket at 4/min leaves headroom under 10 and lets
two regions share one app registration at 4 + 4.

tryTake never blocks: an empty bucket stops the page walk and the caller hands
back a continuation, rather than holding an executor slot asleep.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 8: `syncActions.ts` — scaffolding and `m365.sync.users`

Spec §4.1 (users row and the three paragraphs after the table), §4.4.

`m365.sync.users` merges **three** Graph sources into one projected item set: `/users` (primary), the authentication-methods registration report, and directory role assignments (with role-assignable **group** principals expanded to members, capped at 50 groups). A user in the report but not in `/users` is dropped; a user absent from the report gets `mfaRegistered: null`, never `false`.

**Files:**
- Create: `apps/m365-graph-read-executor/src/microsoft/syncActions.ts`
- Create: `apps/m365-graph-read-executor/src/microsoft/syncActions.users.test.ts`

**Interfaces:**
- Consumes: `readSyncCollection`, `GraphClientError`, `GraphSyncPageSet` (Task 5); `project` (exported in Task 2); `SyncContinuationCodec` (Task 6); `SigninLimiter` (Task 7); `ExecutorSyncConfig` (Task 3); `M365_READ_ACTION_FIELDS`, `M365SyncAction`, `M365SyncActionResponse`, `M365SyncSourceState` (Task 2).
- Produces:

```ts
export interface GraphSyncActionContext {
  accessToken: OpaqueAccessToken;
  graphClient: MicrosoftGraphClient;
  tenantId: string;
  limits: ExecutorSyncConfig;
  continuations: SyncContinuationCodec;
  signinLimiter: SigninLimiter;
  now?: () => Date;
  deadlineAt?: number;      // default now + SYNC_DEADLINE_MS
}

export const SYNC_DEADLINE_MS = 110_000;
export const SYNC_MAX_PAGES = 60;
export const SYNC_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export async function executeGraphSyncAction(
  action: M365SyncAction,
  context: GraphSyncActionContext,
): Promise<M365SyncActionResponse>;
```

- [ ] **Step 1: Write the failing test**

Create `apps/m365-graph-read-executor/src/microsoft/syncActions.users.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { M365_READ_ACTION_FIELDS } from '@breeze/shared/m365';
import { GraphClientError, type GraphSyncPageSet, type MicrosoftGraphClient } from './graphClient';
import { executeGraphSyncAction, type GraphSyncActionContext } from './syncActions';
import type { OpaqueAccessToken } from './tokenClient';
import { createSyncContinuationCodec } from '../syncContinuation';
import { createSigninLimiter } from '../signinLimiter';

const ACCESS_TOKEN = 'opaque-test-access-token' as OpaqueAccessToken;
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ADA = '22222222-2222-4222-8222-222222222222';
const GRACE = '33333333-3333-4333-8333-333333333333';
const ADMINS_GROUP = '44444444-4444-4444-8444-444444444444';
const GLOBAL_ADMIN_TEMPLATE = '62e90394-69f5-4237-9190-012177145e10';
const E3_SKU = '55555555-5555-4555-8555-555555555555';

// Recorded Graph fixtures, trimmed to the fields the executor selects.
const USERS_PAGE = [
  {
    id: ADA, userPrincipalName: 'ada@contoso.com', displayName: 'Ada Lovelace',
    mail: 'ada@contoso.com', accountEnabled: true, jobTitle: 'Engineer',
    department: 'R&D', usageLocation: 'GB', onPremisesSyncEnabled: null,
    createdDateTime: '2024-01-02T03:04:05Z',
    assignedLicenses: [{ skuId: E3_SKU, disabledPlans: [] }],
  },
  {
    id: GRACE, userPrincipalName: 'grace@contoso.com', displayName: 'Grace Hopper',
    mail: null, accountEnabled: false, jobTitle: null, department: null,
    usageLocation: null, onPremisesSyncEnabled: true,
    createdDateTime: '2023-06-01T00:00:00Z', assignedLicenses: [],
  },
];

const REGISTRATION_PAGE = [
  { id: ADA, isMfaRegistered: true, isMfaCapable: true, defaultMfaMethod: 'microsoftAuthenticatorPush' },
  // Grace is deliberately absent: the report lags and excludes some accounts.
  { id: '99999999-9999-4999-8999-999999999999', isMfaRegistered: true, isMfaCapable: true, defaultMfaMethod: 'sms' },
];

const ROLE_ASSIGNMENTS_PAGE = [
  { id: 'ra-1', principalId: ADA, roleDefinition: { id: 'rd-1', templateId: GLOBAL_ADMIN_TEMPLATE, displayName: 'Global Administrator' } },
  { id: 'ra-2', principalId: ADMINS_GROUP, roleDefinition: { id: 'rd-2', templateId: '729827e3-9c14-49f7-bb1b-9608f156bbb8', displayName: 'Helpdesk Administrator' } },
];

const GROUP_MEMBERS_PAGE = [{ id: GRACE }];

type Call = { path: string; query?: Record<string, string>; startUrl?: string };

function stubClient(responses: Record<string, GraphSyncPageSet | GraphClientError>): {
  client: MicrosoftGraphClient; calls: Call[];
} {
  const calls: Call[] = [];
  const client = {
    async probeTenant() { throw new Error('unused'); },
    async readResource() { throw new Error('unused'); },
    async readCollection() { throw new Error('sync actions use readSyncCollection'); },
    async readSyncCollection(input) {
      calls.push({ path: input.path, query: input.query, startUrl: input.startUrl });
      const response = responses[input.path];
      if (response === undefined) throw new Error(`no fixture for ${input.path}`);
      if (response instanceof GraphClientError) throw response;
      if (input.beforePage !== undefined) input.beforePage();
      return response;
    },
  } as unknown as MicrosoftGraphClient;
  return { client, calls };
}

const page = (items: Record<string, unknown>[]): GraphSyncPageSet => ({ items, stopReason: 'complete', pages: 1 });

function context(client: MicrosoftGraphClient): GraphSyncActionContext {
  return {
    accessToken: ACCESS_TOKEN,
    graphClient: client,
    tenantId: TENANT_ID,
    limits: {
      syncMaxInFlight: 4, maxInFlight: 32, signinActivityRpm: 4, signinPagesPerCall: 5,
      maxItemsUsers: 25_000, maxItemsDevices: 25_000, maxItemsCaPolicies: 500,
      maxItemsSkus: 200, continuationKey: Buffer.alloc(32, 1),
    },
    continuations: createSyncContinuationCodec({ key: Buffer.alloc(32, 1) }),
    signinLimiter: createSigninLimiter({ requestsPerMinute: 4 }),
    now: () => new Date('2026-09-08T12:00:00.000Z'),
  };
}

const HAPPY = {
  '/users': page(USERS_PAGE),
  '/reports/authenticationMethods/userRegistrationDetails': page(REGISTRATION_PAGE),
  '/roleManagement/directory/roleAssignments': page(ROLE_ASSIGNMENTS_PAGE),
  [`/groups/${ADMINS_GROUP}/members`]: page(GROUP_MEMBERS_PAGE),
};

describe('executeGraphSyncAction — m365.sync.users', () => {
  it('merges all three sources into one projected item per user', async () => {
    const { client, calls } = stubClient(HAPPY);
    const result = await executeGraphSyncAction({ type: 'm365.sync.users' }, context(client));

    expect(result).toMatchObject({ success: true, kind: 'sync', truncated: false });
    if (!('items' in result)) throw new Error('expected success');
    expect(result.fetchedAt).toBe('2026-09-08T12:00:00.000Z');
    expect(result.sources).toEqual({ users: 'ok', mfaRegistration: 'ok', roleAssignments: 'ok' });
    expect(result.items).toEqual([
      {
        id: ADA, userPrincipalName: 'ada@contoso.com', displayName: 'Ada Lovelace',
        mail: 'ada@contoso.com', accountEnabled: true, jobTitle: 'Engineer',
        department: 'R&D', usageLocation: 'GB', onPremisesSyncEnabled: null,
        createdDateTime: '2024-01-02T03:04:05Z',
        assignedLicenses: [E3_SKU],
        mfaRegistered: true, mfaCapable: true, defaultMfaMethod: 'microsoftAuthenticatorPush',
        adminRoles: [{ roleTemplateId: GLOBAL_ADMIN_TEMPLATE, displayName: 'Global Administrator' }],
      },
      {
        id: GRACE, userPrincipalName: 'grace@contoso.com', displayName: 'Grace Hopper',
        mail: null, accountEnabled: false, jobTitle: null, department: null,
        usageLocation: null, onPremisesSyncEnabled: true,
        createdDateTime: '2023-06-01T00:00:00Z',
        assignedLicenses: [],
        // Absent from the registration report ⇒ unknown, NEVER false.
        mfaRegistered: null, mfaCapable: null, defaultMfaMethod: null,
        adminRoles: [{
          roleTemplateId: '729827e3-9c14-49f7-bb1b-9608f156bbb8',
          displayName: 'Helpdesk Administrator',
          viaGroupId: ADMINS_GROUP,
        }],
      },
    ]);
    // The user in the report but not in /users is dropped entirely.
    expect(JSON.stringify(result.items)).not.toContain('99999999');
    // Every emitted key is on the allowlist.
    for (const item of result.items) {
      for (const key of Object.keys(item)) {
        expect(M365_READ_ACTION_FIELDS['m365.sync.users']).toContain(key);
      }
    }
    expect(calls.map((c) => c.path)).toEqual([
      '/users',
      '/reports/authenticationMethods/userRegistrationDetails',
      '/roleManagement/directory/roleAssignments',
      `/groups/${ADMINS_GROUP}/members`,
    ]);
    expect(calls[0]!.query).toMatchObject({ '$top': '999' });
    expect(calls[0]!.query!['$select']).toContain('assignedLicenses');
    // signInActivity is NOT selected here — it is its own throttled domain.
    expect(calls[0]!.query!['$select']).not.toContain('signInActivity');
  });

  it('fails the whole action when the PRIMARY source fails', async () => {
    const { client } = stubClient({ ...HAPPY, '/users': new GraphClientError('graph_permission_missing') });
    await expect(executeGraphSyncAction({ type: 'm365.sync.users' }, context(client)))
      .resolves.toEqual({ success: false, errorCode: 'graph_permission_missing' });
  });

  it('degrades a failed registration report to a source state and null enrichment', async () => {
    const { client } = stubClient({
      ...HAPPY,
      '/reports/authenticationMethods/userRegistrationDetails': new GraphClientError('graph_permission_missing'),
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.users' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.sources).toMatchObject({ users: 'ok', mfaRegistration: 'permission_missing' });
    expect(result.items.every((item) => item.mfaRegistered === null)).toBe(true);
    expect(result.items[0]!.adminRoles).not.toBeNull();   // roles are unaffected
  });

  it('degrades failed role assignments to adminRoles: null, not an empty list', async () => {
    const { client } = stubClient({
      ...HAPPY,
      '/roleManagement/directory/roleAssignments': new GraphClientError('graph_throttled', 30),
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.users' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.sources).toMatchObject({ roleAssignments: 'throttled' });
    // null = unknown. [] would claim "definitely not an admin".
    expect(result.items.every((item) => item.adminRoles === null)).toBe(true);
  });

  it('discards a TRUNCATED secondary source rather than inventing absences', async () => {
    const { client } = stubClient({
      ...HAPPY,
      '/reports/authenticationMethods/userRegistrationDetails': {
        items: REGISTRATION_PAGE, stopReason: 'max_items', pages: 1,
      },
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.users' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.sources).toMatchObject({ mfaRegistration: 'error' });
    expect(result.items[0]!.mfaRegistered).toBeNull();   // Ada's row is dropped with the rest
    expect(result.truncated).toBe(false);                // the PRIMARY was complete
  });

  it('reports truncation when the primary enumeration is incomplete', async () => {
    const { client } = stubClient({ ...HAPPY, '/users': { items: USERS_PAGE, stopReason: 'max_items', pages: 60 } });
    const result = await executeGraphSyncAction({ type: 'm365.sync.users' }, context(client));
    expect(result).toMatchObject({ success: true, truncated: true });
  });

  it('skips a role principal that is not a group and keeps the rest', async () => {
    const { client } = stubClient({
      ...HAPPY,
      [`/groups/${ADMINS_GROUP}/members`]: new GraphClientError('graph_not_found'),
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.users' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.sources).toMatchObject({ roleAssignments: 'ok' });
    expect(result.items[0]!.adminRoles).toHaveLength(1);   // Ada keeps her direct assignment
    expect(result.items[1]!.adminRoles).toEqual([]);       // Grace gains nothing
  });

  it('caps group expansion at 50 lookups and says so through the source state', async () => {
    const groups = Array.from({ length: 60 }, (_unused, index) => `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`);
    const responses: Record<string, GraphSyncPageSet | GraphClientError> = {
      ...HAPPY,
      '/roleManagement/directory/roleAssignments': page(groups.map((groupId, index) => ({
        id: `ra-${index}`, principalId: groupId,
        roleDefinition: { id: 'rd', templateId: GLOBAL_ADMIN_TEMPLATE, displayName: 'Global Administrator' },
      }))),
    };
    for (const groupId of groups) responses[`/groups/${groupId}/members`] = page([{ id: ADA }]);
    const { client, calls } = stubClient(responses);
    const result = await executeGraphSyncAction({ type: 'm365.sync.users' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(calls.filter((call) => call.path.startsWith('/groups/'))).toHaveLength(50);
    expect(result.sources).toMatchObject({ roleAssignments: 'error' }); // incomplete expansion is not 'ok'
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/m365-graph-read-executor && npx vitest run src/microsoft/syncActions.users.test.ts
```

- [ ] **Step 3: Implement the scaffolding and the users case**

Create `apps/m365-graph-read-executor/src/microsoft/syncActions.ts`:

```ts
import {
  M365_READ_ACTION_FIELDS,
  m365SyncFailureCodeSchema,
  type M365SyncAction,
  type M365SyncActionResponse,
  type M365SyncActionResult,
  type M365SyncSourceState,
} from '@breeze/shared/m365';
import type { ExecutorSyncConfig } from '../config';
import type { SigninLimiter } from '../signinLimiter';
import { SyncContinuationError, type SyncContinuationCodec } from '../syncContinuation';
import {
  GraphClientError,
  type GraphSyncLimits,
  type GraphSyncPageSet,
  type MicrosoftGraphClient,
} from './graphClient';
import { project } from './readActions';
import type { OpaqueAccessToken } from './tokenClient';

/**
 * Whole-domain snapshot pulls (spec §4.1). One case per action; every case
 * finishes by projecting through M365_READ_ACTION_FIELDS, including the
 * computed fields, so the allowlist stays the only thing that leaves the
 * executor. Nested objects (adminRoles, prepaidUnits, controlScores) are built
 * key by key — a raw Graph object is never spread into a result.
 */

export const SYNC_DEADLINE_MS = 110_000;
export const SYNC_MAX_PAGES = 60;
export const SYNC_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const ROLE_GROUP_EXPANSION_CAP = 50;

const USERS_SELECT = [
  'id', 'userPrincipalName', 'displayName', 'mail', 'accountEnabled', 'jobTitle',
  'department', 'usageLocation', 'onPremisesSyncEnabled', 'createdDateTime', 'assignedLicenses',
].join(',');

export interface GraphSyncActionContext {
  accessToken: OpaqueAccessToken;
  graphClient: MicrosoftGraphClient;
  tenantId: string;
  limits: ExecutorSyncConfig;
  continuations: SyncContinuationCodec;
  signinLimiter: SigninLimiter;
  now?: () => Date;
  deadlineAt?: number;
}

interface DomainSources { [source: string]: M365SyncSourceState }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A secondary source's failure is a state, not an outcome (spec §6). */
function sourceStateFor(error: unknown): M365SyncSourceState {
  if (error instanceof GraphClientError) {
    if (error.code === 'graph_permission_missing') return 'permission_missing';
    if (error.code === 'graph_license_required') return 'unlicensed';
    if (error.code === 'graph_throttled') return 'throttled';
  }
  return 'error';
}

function failureResponse(error: unknown): M365SyncActionResponse {
  if (error instanceof SyncContinuationError) {
    return { success: false, errorCode: 'continuation_invalid' };
  }
  if (error instanceof GraphClientError) {
    const parsed = m365SyncFailureCodeSchema.safeParse(error.code);
    const errorCode = parsed.success ? parsed.data : 'graph_response_invalid' as const;
    return error.retryAfterSeconds === undefined
      ? { success: false, errorCode }
      : { success: false, errorCode, retryAfterSeconds: error.retryAfterSeconds };
  }
  throw error;
}

function limitsFor(
  context: GraphSyncActionContext,
  maxItems: number,
  over: Partial<GraphSyncLimits> = {},
): GraphSyncLimits {
  return {
    maxItems,
    maxPages: SYNC_MAX_PAGES,
    maxResponseBytes: SYNC_MAX_RESPONSE_BYTES,
    deadlineAt: context.deadlineAt ?? Date.now() + SYNC_DEADLINE_MS,
    ...over,
  };
}

function succeed(
  action: M365SyncAction,
  items: Record<string, unknown>[],
  options: { truncated: boolean; sources: DomainSources; fetchedAt: Date; continuation?: string },
): M365SyncActionResult {
  const fields = M365_READ_ACTION_FIELDS[action.type];
  return {
    success: true,
    kind: 'sync',
    items: items.map((item) => project(item, fields)),
    truncated: options.truncated,
    fetchedAt: options.fetchedAt.toISOString(),
    sources: options.sources,
    ...(options.continuation === undefined ? {} : { continuation: options.continuation }),
  };
}

// --- m365.sync.users -------------------------------------------------------

interface RegistrationFacts {
  state: M365SyncSourceState;
  byUserId: Map<string, { mfaRegistered: boolean | null; mfaCapable: boolean | null; defaultMfaMethod: string | null }>;
}

interface RoleFacts {
  state: M365SyncSourceState;
  byUserId: Map<string, { roleTemplateId: string; displayName: string; viaGroupId?: string }[]>;
}

async function fetchRegistrationFacts(context: GraphSyncActionContext): Promise<RegistrationFacts> {
  const byUserId = new Map<string, { mfaRegistered: boolean | null; mfaCapable: boolean | null; defaultMfaMethod: string | null }>();
  let pageSet: GraphSyncPageSet;
  try {
    pageSet = await context.graphClient.readSyncCollection({
      accessToken: context.accessToken,
      path: '/reports/authenticationMethods/userRegistrationDetails',
      query: { '$top': '999' },
      limits: limitsFor(context, context.limits.maxItemsUsers),
    });
  } catch (error) {
    return { state: sourceStateFor(error), byUserId };
  }
  // A partial report would make every unseen user look unregistered. Discard it.
  if (pageSet.stopReason !== 'complete') return { state: 'error', byUserId };
  for (const row of pageSet.items) {
    if (typeof row.id !== 'string') continue;
    byUserId.set(row.id, {
      mfaRegistered: typeof row.isMfaRegistered === 'boolean' ? row.isMfaRegistered : null,
      mfaCapable: typeof row.isMfaCapable === 'boolean' ? row.isMfaCapable : null,
      defaultMfaMethod: typeof row.defaultMfaMethod === 'string' ? row.defaultMfaMethod : null,
    });
  }
  return { state: 'ok', byUserId };
}

async function fetchRoleFacts(
  context: GraphSyncActionContext,
  userIds: ReadonlySet<string>,
): Promise<RoleFacts> {
  const byUserId = new Map<string, { roleTemplateId: string; displayName: string; viaGroupId?: string }[]>();
  let pageSet: GraphSyncPageSet;
  try {
    pageSet = await context.graphClient.readSyncCollection({
      accessToken: context.accessToken,
      path: '/roleManagement/directory/roleAssignments',
      query: { '$expand': 'roleDefinition($select=id,templateId,displayName)' },
      limits: limitsFor(context, context.limits.maxItemsUsers),
    });
  } catch (error) {
    return { state: sourceStateFor(error), byUserId };
  }
  if (pageSet.stopReason !== 'complete') return { state: 'error', byUserId };

  function add(userId: string, role: { roleTemplateId: string; displayName: string; viaGroupId?: string }): void {
    const existing = byUserId.get(userId);
    if (existing) existing.push(role);
    else byUserId.set(userId, [role]);
  }

  const groupAssignments: { principalId: string; role: { roleTemplateId: string; displayName: string } }[] = [];
  for (const assignment of pageSet.items) {
    const definition = assignment.roleDefinition;
    if (typeof assignment.principalId !== 'string' || !isRecord(definition)) continue;
    if (typeof definition.templateId !== 'string' || typeof definition.displayName !== 'string') continue;
    const role = { roleTemplateId: definition.templateId, displayName: definition.displayName };
    if (userIds.has(assignment.principalId)) add(assignment.principalId, role);
    else groupAssignments.push({ principalId: assignment.principalId, role });
  }

  // Principals that are not users are candidate role-assignable groups. Sorted
  // so the cap always truncates the same tail. Nested groups are NOT followed.
  const uniquePrincipals = [...new Set(groupAssignments.map((entry) => entry.principalId))].sort();
  const expandable = uniquePrincipals.slice(0, ROLE_GROUP_EXPANSION_CAP);
  let state: M365SyncSourceState = uniquePrincipals.length > expandable.length ? 'error' : 'ok';
  const membersByGroup = new Map<string, string[]>();
  for (const groupId of expandable) {
    try {
      const members = await context.graphClient.readSyncCollection({
        accessToken: context.accessToken,
        path: `/groups/${encodeURIComponent(groupId)}/members`,
        query: { '$select': 'id', '$top': '999' },
        limits: limitsFor(context, context.limits.maxItemsUsers, { maxPages: 5 }),
      });
      if (members.stopReason !== 'complete') state = 'error';
      membersByGroup.set(
        groupId,
        members.items.map((member) => member.id).filter((id): id is string => typeof id === 'string'),
      );
    } catch (error) {
      // A non-group principal (service principal, deleted object) 404s. That is
      // information, not a failure.
      if (!(error instanceof GraphClientError && error.code === 'graph_not_found')) state = 'error';
    }
  }
  for (const { principalId, role } of groupAssignments) {
    for (const memberId of membersByGroup.get(principalId) ?? []) {
      if (userIds.has(memberId)) add(memberId, { ...role, viaGroupId: principalId });
    }
  }
  return { state, byUserId };
}

async function syncUsers(
  action: Extract<M365SyncAction, { type: 'm365.sync.users' }>,
  context: GraphSyncActionContext,
  fetchedAt: Date,
): Promise<M365SyncActionResponse> {
  const primary = await context.graphClient.readSyncCollection({
    accessToken: context.accessToken,
    path: '/users',
    query: { '$select': USERS_SELECT, '$top': '999' },
    limits: limitsFor(context, context.limits.maxItemsUsers),
  });

  const userIds = new Set(
    primary.items.map((user) => user.id).filter((id): id is string => typeof id === 'string'),
  );
  const registration = await fetchRegistrationFacts(context);
  const roles = await fetchRoleFacts(context, userIds);

  const items = primary.items.flatMap((user) => {
    if (typeof user.id !== 'string') return [];
    const facts = registration.state === 'ok' ? registration.byUserId.get(user.id) : undefined;
    return [{
      ...user,
      assignedLicenses: Array.isArray(user.assignedLicenses)
        ? user.assignedLicenses
          .map((license) => (isRecord(license) && typeof license.skuId === 'string' ? license.skuId : undefined))
          .filter((skuId): skuId is string => skuId !== undefined)
        : [],
      // null, never false: the report lags and excludes some accounts (spec §4.1).
      mfaRegistered: facts?.mfaRegistered ?? null,
      mfaCapable: facts?.mfaCapable ?? null,
      defaultMfaMethod: facts?.defaultMfaMethod ?? null,
      // null = unknown; [] = definitely no active assignment.
      adminRoles: roles.state === 'ok' || roles.state === 'error'
        ? (roles.byUserId.get(user.id) ?? [])
        : null,
    }];
  });

  return succeed(action, items, {
    truncated: primary.stopReason !== 'complete',
    fetchedAt,
    sources: { users: 'ok', mfaRegistration: registration.state, roleAssignments: roles.state },
  });
}

export async function executeGraphSyncAction(
  action: M365SyncAction,
  context: GraphSyncActionContext,
): Promise<M365SyncActionResponse> {
  const fetchedAt = (context.now ?? (() => new Date()))();
  try {
    switch (action.type) {
      case 'm365.sync.users':
        return await syncUsers(action, context, fetchedAt);
      default: {
        const exhaustive: never = action as never;
        throw new Error(`Unhandled M365 sync action: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    return failureResponse(error);
  }
}
```

⚠️ The `adminRoles` ternary above reads oddly because `'error'` still yields the partial list — that is deliberate for the *expansion-cap* case (direct assignments are known-good; only some group expansions are missing) but wrong for the *fetch-failed* case. Split the two states in `RoleFacts`: return `state: 'error'` with an **empty** map when the assignment enumeration itself failed or truncated, and add a separate `complete: boolean`. Then write the ternary as `adminRoles: roles.byUserId.size === 0 && roles.state !== 'ok' ? null : (roles.byUserId.get(user.id) ?? [])`. Simpler and honest: give `RoleFacts` a `known: boolean` field — `false` when the enumeration failed, `true` when it succeeded even if some group expansion was capped — and use `adminRoles: roles.known ? (roles.byUserId.get(user.id) ?? []) : null`. Implement the `known` version; the tests above pin both behaviours.

- [ ] **Step 4: Run — green**

```bash
cd apps/m365-graph-read-executor && npx vitest run src/microsoft/syncActions.users.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/m365-graph-read-executor/src/microsoft/syncActions.ts apps/m365-graph-read-executor/src/microsoft/syncActions.users.test.ts
git commit -m "feat(m365): sync action scaffolding and the three-source users pull

Wave 3 task 8 of the M365 tenant sync foundation (spec 4.1, 4.4).

m365.sync.users merges /users, the authentication-methods registration report,
and directory role assignments into one projected record per user.

Three invariants the advisor quorum asked for, each pinned by a test:
- a user absent from the registration report gets mfaRegistered null, never
  false: the report lags and excludes accounts;
- a user in the report but not in /users is dropped;
- adminRoles is null when the assignment enumeration failed and [] when it
  succeeded and found nothing, because [] claims 'not an admin'.

Role assignments whose principal is a group are expanded to members, capped at
50 groups, sorted so the cap truncates deterministically, with nested groups
deliberately not followed and the cap reported through the source state. A
404 on a principal means it was not a group, which is information, not a
failure.

A TRUNCATED secondary source is discarded rather than partially applied:
half a report manufactures false absences.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 9: `syncActions.ts` — sign-in activity, Intune devices, CA policies, SKUs, Secure Score

Spec §4.1 (remaining five rows), §4.4.

**Files:**
- Modify: `apps/m365-graph-read-executor/src/microsoft/syncActions.ts`
- Create: `apps/m365-graph-read-executor/src/microsoft/syncActions.domains.test.ts`

**Interfaces:**
- Consumes: everything from Task 8 plus `SigninLimiter.tryTake` and `SyncContinuationCodec`.
- Produces: no new exports — five more `case` arms.

Per-action decisions, all pinned by tests below:

| Action | Path / query | Item cap | Notes |
|---|---|---|---|
| `signin_activity` | `/users`, `$select=id,signInActivity&$top=500` | `maxItemsUsers` | `maxPages = signinPagesPerCall`; `beforePage = signinLimiter.tryTake`; only `lastSuccessfulSignInDateTime` projected; 403 ⇒ `unlicensed` |
| `intune_devices` | `/deviceManagement/managedDevices`, `$select=<allowlist>&$top=999` | `maxItemsDevices` | primary-only |
| `ca_policies` | `/identity/conditionalAccess/policies` (no `$select` — `conditions`/`grantControls`/`sessionControls` are whole objects) | `maxItemsCaPolicies` | `retry.fixedBackoffMs = 2000` |
| `skus` | `/subscribedSkus` (rejects `$top`) | `maxItemsSkus` | `prepaidUnits` rebuilt key by key |
| `secure_score` | `/security/secureScores?$top=90|3` + `/security/secureScoreControlProfiles?$select=id,title,maxScore,controlCategory` | 90 / 500 | `controlScores` joined for `maxScore`; profiles failing ⇒ `maxScore: null` |

- [ ] **Step 1: Write the failing test**

Create `apps/m365-graph-read-executor/src/microsoft/syncActions.domains.test.ts`. Reuse the `stubClient` / `page` / `context` helpers from `syncActions.users.test.ts` — **extract them first** into `apps/m365-graph-read-executor/src/microsoft/syncActions.testHarness.ts` (exported `stubClient`, `page`, `context`, `TENANT_ID`, `ACCESS_TOKEN`) and re-import them in both suites so the fixtures cannot drift.

```ts
import { describe, expect, it, vi } from 'vitest';
import { M365_READ_ACTION_FIELDS } from '@breeze/shared/m365';
import { GraphClientError, type GraphSyncPageSet } from './graphClient';
import { executeGraphSyncAction } from './syncActions';
import { context, page, stubClient, TENANT_ID } from './syncActions.testHarness';
import { createSyncContinuationCodec } from '../syncContinuation';
import { createSigninLimiter } from '../signinLimiter';

const ADA = '22222222-2222-4222-8222-222222222222';
const NEXT = 'https://graph.microsoft.com/v1.0/users?$skiptoken=page2';

describe('m365.sync.signin_activity', () => {
  it('projects only the last SUCCESSFUL sign-in and asks for 500 per page', async () => {
    const { client, calls } = stubClient({
      '/users': page([
        { id: ADA, signInActivity: {
          lastSignInDateTime: '2026-09-07T09:00:00Z',            // failed attempts count here
          lastSuccessfulSignInDateTime: '2026-09-01T08:00:00Z',
        } },
        { id: '33333333-3333-4333-8333-333333333333' },          // never signed in
      ]),
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.signin_activity' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.items).toEqual([
      { id: ADA, lastSuccessfulSignInAt: '2026-09-01T08:00:00Z' },
      { id: '33333333-3333-4333-8333-333333333333', lastSuccessfulSignInAt: null },
    ]);
    expect(JSON.stringify(result.items)).not.toContain('2026-09-07');   // lastSignInDateTime never leaves
    expect(calls[0]!.query).toEqual({ '$select': 'id,signInActivity', '$top': '500' });
    expect(result.sources).toEqual({ signInActivity: 'ok' });
    expect(result.continuation).toBeUndefined();
  });

  it('returns a sealed continuation when pages remain, and resumes from it', async () => {
    const { client, calls } = stubClient({
      '/users': { items: [{ id: ADA }], stopReason: 'max_pages', pages: 5, nextLink: NEXT },
    });
    const ctx = context(client);
    const result = await executeGraphSyncAction({ type: 'm365.sync.signin_activity' }, ctx);
    if (!('items' in result)) throw new Error('expected success');
    expect(result.truncated).toBe(false);              // paged, not truncated
    expect(result.continuation).toBeDefined();
    expect(result.continuation).not.toContain('skiptoken');

    const { client: second, calls: secondCalls } = stubClient({ '/users': page([{ id: ADA }]) });
    await executeGraphSyncAction(
      { type: 'm365.sync.signin_activity', continuation: result.continuation! },
      { ...context(second), continuations: ctx.continuations },
    );
    expect(secondCalls[0]!.startUrl).toBe(NEXT);
    expect(calls).toHaveLength(1);
  });

  it('refuses a continuation minted for another tenant', async () => {
    const codec = createSyncContinuationCodec({ key: Buffer.alloc(32, 1) });
    const foreign = codec.seal({
      tenantId: '99999999-9999-4999-8999-999999999999',
      action: 'm365.sync.signin_activity',
      nextLink: NEXT,
    });
    const { client, calls } = stubClient({ '/users': page([]) });
    await expect(executeGraphSyncAction(
      { type: 'm365.sync.signin_activity', continuation: foreign },
      { ...context(client), continuations: codec, tenantId: TENANT_ID },
    )).resolves.toEqual({ success: false, errorCode: 'continuation_invalid' });
    expect(calls).toHaveLength(0);   // nothing is fetched on a bad continuation
  });

  it('reports unlicensed on 403 with zero items and no continuation', async () => {
    const { client } = stubClient({ '/users': new GraphClientError('graph_permission_missing') });
    const result = await executeGraphSyncAction({ type: 'm365.sync.signin_activity' }, context(client));
    expect(result).toMatchObject({
      success: true, items: [], truncated: false, sources: { signInActivity: 'unlicensed' },
    });
    if (!('items' in result)) throw new Error('expected success');
    expect(result.continuation).toBeUndefined();
  });

  it('returns immediately with the inbound continuation when the bucket is empty', async () => {
    const codec = createSyncContinuationCodec({ key: Buffer.alloc(32, 1) });
    const inbound = codec.seal({ tenantId: TENANT_ID, action: 'm365.sync.signin_activity', nextLink: NEXT });
    const limiter = createSigninLimiter({ requestsPerMinute: 1 });
    limiter.tryTake();                                    // drain it
    const { client, calls } = stubClient({
      '/users': { items: [], stopReason: 'paused', pages: 0 },
    });
    const result = await executeGraphSyncAction(
      { type: 'm365.sync.signin_activity', continuation: inbound },
      { ...context(client), continuations: codec, signinLimiter: limiter },
    );
    if (!('items' in result)) throw new Error('expected success');
    expect(result.items).toEqual([]);
    expect(result.sources).toEqual({ signInActivity: 'throttled' });
    // The resume point survives — losing it would restart the walk.
    expect(codec.open({ tenantId: TENANT_ID, action: 'm365.sync.signin_activity', continuation: result.continuation! }))
      .toBe(NEXT);
    expect(calls).toHaveLength(1);
  });

  it('caps pages per call at M365_SIGNIN_PAGES_PER_CALL', async () => {
    const { client, calls } = stubClient({ '/users': page([]) });
    await executeGraphSyncAction({ type: 'm365.sync.signin_activity' }, {
      ...context(client),
      limits: { ...context(client).limits, signinPagesPerCall: 2 },
    });
    expect(calls[0]).toBeDefined();
  });
});

describe('m365.sync.intune_devices', () => {
  it('selects and projects exactly the allowlist and reports truncation', async () => {
    const device = {
      id: 'd1', deviceName: 'LAPTOP-01', operatingSystem: 'Windows', osVersion: '10.0.22631',
      complianceState: 'compliant', lastSyncDateTime: '2026-09-08T06:00:00Z',
      userPrincipalName: 'ada@contoso.com', managedDeviceOwnerType: 'company',
      enrolledDateTime: '2025-02-01T00:00:00Z', model: 'X1', manufacturer: 'Lenovo',
      serialNumber: 'PF0ABCDE', azureADDeviceId: 'aad-1', managementAgent: 'mdm', jailBroken: 'False',
      secretField: 'must not leak',
    };
    const { client, calls } = stubClient({
      '/deviceManagement/managedDevices': { items: [device], stopReason: 'max_items', pages: 60 },
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.intune_devices' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(Object.keys(result.items[0]!).sort())
      .toEqual([...M365_READ_ACTION_FIELDS['m365.sync.intune_devices']].sort());
    expect(JSON.stringify(result)).not.toContain('must not leak');
    expect(result).toMatchObject({ truncated: true, sources: { managedDevices: 'ok' } });
    expect(calls[0]!.query!['$top']).toBe('999');
  });

  it('fails the action when the primary source fails', async () => {
    const { client } = stubClient({
      '/deviceManagement/managedDevices': new GraphClientError('graph_throttled', 42),
    });
    await expect(executeGraphSyncAction({ type: 'm365.sync.intune_devices' }, context(client)))
      .resolves.toEqual({ success: false, errorCode: 'graph_throttled', retryAfterSeconds: 42 });
  });
});

describe('m365.sync.ca_policies', () => {
  it('passes the policy condition objects through and uses a fixed 2 s backoff', async () => {
    const policy = {
      id: 'ca1', displayName: 'Require MFA for admins', state: 'enabled',
      createdDateTime: '2025-01-01T00:00:00Z', modifiedDateTime: '2026-08-01T00:00:00Z',
      conditions: { users: { includeRoles: ['62e90394-69f5-4237-9190-012177145e10'] } },
      grantControls: { operator: 'OR', builtInControls: ['mfa'] },
      sessionControls: null,
      templateId: 'not-projected',
    };
    const seen: unknown[] = [];
    const client = {
      async probeTenant() { throw new Error('unused'); },
      async readResource() { throw new Error('unused'); },
      async readCollection() { throw new Error('unused'); },
      async readSyncCollection(input: { limits: { retry?: { fixedBackoffMs?: number } } }) {
        seen.push(input.limits.retry);
        return page([policy]) as GraphSyncPageSet;
      },
    };
    const result = await executeGraphSyncAction(
      { type: 'm365.sync.ca_policies' },
      context(client as never),
    );
    if (!('items' in result)) throw new Error('expected success');
    expect(result.items[0]).toEqual({
      id: 'ca1', displayName: 'Require MFA for admins', state: 'enabled',
      createdDateTime: '2025-01-01T00:00:00Z', modifiedDateTime: '2026-08-01T00:00:00Z',
      conditions: policy.conditions, grantControls: policy.grantControls, sessionControls: null,
    });
    expect(seen[0]).toMatchObject({ fixedBackoffMs: 2_000 });
  });
});

describe('m365.sync.skus', () => {
  it('rebuilds prepaidUnits key by key and never sends $top', async () => {
    const { client, calls } = stubClient({
      '/subscribedSkus': page([{
        id: 'tenant_sku', skuId: 'sku-1', skuPartNumber: 'ENTERPRISEPACK',
        consumedUnits: 42, capabilityStatus: 'Enabled', appliesTo: 'User',
        prepaidUnits: { enabled: 50, suspended: 0, warning: 0, lockedOut: 1 },
        servicePlans: [{ servicePlanId: 'not-projected' }],
      }]),
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.skus' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.items[0]).toEqual({
      skuId: 'sku-1', skuPartNumber: 'ENTERPRISEPACK', consumedUnits: 42,
      prepaidUnits: { enabled: 50, suspended: 0, warning: 0 },
      capabilityStatus: 'Enabled', appliesTo: 'User',
    });
    expect(calls[0]!.query?.['$top']).toBeUndefined();   // /subscribedSkus rejects it
  });
});

describe('m365.sync.secure_score', () => {
  const SCORES = [{
    id: 'score-1', createdDateTime: '2026-09-08T00:00:00Z', currentScore: 210.5, maxScore: 400,
    activeUserCount: 120, licensedUserCount: 150,
    controlScores: [
      { controlName: 'MFARegistrationV2', score: 8, implementationStatus: 'partial', description: 'noise' },
      { controlName: 'UnknownControl', score: 0, implementationStatus: 'not started' },
    ],
    azureTenantId: 'not-projected',
  }];
  const PROFILES = [{ id: 'MFARegistrationV2', title: 'Ensure all users can complete MFA', maxScore: 10, controlCategory: 'Identity' }];

  it('joins control profiles for maxScore and title, and asks for 3 scores by default', async () => {
    const { client, calls } = stubClient({
      '/security/secureScores': page(SCORES),
      '/security/secureScoreControlProfiles': page(PROFILES),
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.secure_score' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(calls[0]!.query!['$top']).toBe('3');
    expect(result.items[0]).toEqual({
      id: 'score-1', createdDateTime: '2026-09-08T00:00:00Z', currentScore: 210.5, maxScore: 400,
      activeUserCount: 120, licensedUserCount: 150,
      controlScores: [
        { controlName: 'MFARegistrationV2', title: 'Ensure all users can complete MFA', score: 8, maxScore: 10, implementationStatus: 'partial' },
        { controlName: 'UnknownControl', title: null, score: 0, maxScore: null, implementationStatus: 'not started' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('noise');
    expect(result.sources).toEqual({ secureScores: 'ok', controlProfiles: 'ok' });
  });

  it('asks for 90 scores on a backfill run', async () => {
    const { client, calls } = stubClient({
      '/security/secureScores': page(SCORES),
      '/security/secureScoreControlProfiles': page(PROFILES),
    });
    await executeGraphSyncAction({ type: 'm365.sync.secure_score', backfill: true }, context(client));
    expect(calls[0]!.query!['$top']).toBe('90');
  });

  it('keeps the scores when the control profiles fail', async () => {
    const { client } = stubClient({
      '/security/secureScores': page(SCORES),
      '/security/secureScoreControlProfiles': new GraphClientError('graph_permission_missing'),
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.secure_score' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.sources).toEqual({ secureScores: 'ok', controlProfiles: 'permission_missing' });
    expect((result.items[0]!.controlScores as { maxScore: number | null }[])[0]!.maxScore).toBeNull();
  });
});
```

⚠️ `M365_READ_ACTION_FIELDS['m365.sync.secure_score']` lists `controlScores` but the nested `title` key is new here. Add `title` to the **nested** shape only — the top-level allowlist is unchanged, and the nested projection is by construction. Note it in the PR body; the overview's item-shape comment for `secure_score` gains `title: string | null` in the same PR.

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/m365-graph-read-executor && npx vitest run src/microsoft/syncActions.domains.test.ts
```

- [ ] **Step 3: Implement the five cases**

Add to `syncActions.ts`, above `executeGraphSyncAction`:

```ts
const DEVICES_SELECT = M365_READ_ACTION_FIELDS['m365.sync.intune_devices'].join(',');
const CA_RETRY = { maxAttempts: 3, cumulativeBudgetMs: 60_000, fixedBackoffMs: 2_000 } as const;
const SECURE_SCORE_TOP_BACKFILL = 90;
const SECURE_SCORE_TOP_INCREMENTAL = 3;
const SECURE_SCORE_MAX_CONTROLS = 500;

async function syncSigninActivity(
  action: Extract<M365SyncAction, { type: 'm365.sync.signin_activity' }>,
  context: GraphSyncActionContext,
  fetchedAt: Date,
): Promise<M365SyncActionResponse> {
  // A bad continuation must fail loudly (tenant replay attempt or an expiry) —
  // silently restarting would hide both.
  const startUrl = action.continuation === undefined
    ? undefined
    : context.continuations.open({
      tenantId: context.tenantId, action: action.type, continuation: action.continuation,
    });

  let pageSet: GraphSyncPageSet;
  try {
    pageSet = await context.graphClient.readSyncCollection({
      accessToken: context.accessToken,
      path: '/users',
      query: { '$select': 'id,signInActivity', '$top': '500' },
      ...(startUrl === undefined ? {} : { startUrl }),
      limits: limitsFor(context, context.limits.maxItemsUsers, {
        maxPages: context.limits.signinPagesPerCall,
      }),
      beforePage: () => context.signinLimiter.tryTake(),
    });
  } catch (error) {
    // Graph answers 403 for signInActivity on a tenant without Entra ID P1.
    if (error instanceof GraphClientError
      && (error.code === 'graph_permission_missing' || error.code === 'graph_license_required')) {
      return succeed(action, [], {
        truncated: false, fetchedAt, sources: { signInActivity: 'unlicensed' },
      });
    }
    throw error;
  }

  const items = pageSet.items.flatMap((user) => {
    if (typeof user.id !== 'string') return [];
    const activity = user.signInActivity;
    const last = isRecord(activity) && typeof activity.lastSuccessfulSignInDateTime === 'string'
      ? activity.lastSuccessfulSignInDateTime
      : null;
    // lastSignInDateTime counts FAILED interactive attempts and is never projected.
    return [{ id: user.id, lastSuccessfulSignInAt: last }];
  });

  const resumeLink = pageSet.nextLink ?? (pageSet.stopReason === 'paused' ? startUrl : undefined);
  const continuation = resumeLink === undefined
    ? undefined
    : context.continuations.seal({ tenantId: context.tenantId, action: action.type, nextLink: resumeLink });

  return succeed(action, items, {
    truncated: pageSet.stopReason === 'max_items',
    fetchedAt,
    sources: { signInActivity: pageSet.stopReason === 'paused' ? 'throttled' : 'ok' },
    ...(continuation === undefined ? {} : { continuation }),
  });
}

async function syncIntuneDevices(
  action: Extract<M365SyncAction, { type: 'm365.sync.intune_devices' }>,
  context: GraphSyncActionContext,
  fetchedAt: Date,
): Promise<M365SyncActionResponse> {
  const pageSet = await context.graphClient.readSyncCollection({
    accessToken: context.accessToken,
    path: '/deviceManagement/managedDevices',
    query: { '$select': DEVICES_SELECT, '$top': '999' },
    limits: limitsFor(context, context.limits.maxItemsDevices),
  });
  return succeed(action, pageSet.items, {
    truncated: pageSet.stopReason !== 'complete',
    fetchedAt,
    sources: { managedDevices: 'ok' },
  });
}

async function syncCaPolicies(
  action: Extract<M365SyncAction, { type: 'm365.sync.ca_policies' }>,
  context: GraphSyncActionContext,
  fetchedAt: Date,
): Promise<M365SyncActionResponse> {
  // No $select: conditions/grantControls/sessionControls are whole objects and
  // Graph's CA endpoint is 1 req/s per tenant with NO Retry-After on 429, so a
  // fixed backoff replaces header-driven waiting (spec §4.1).
  const pageSet = await context.graphClient.readSyncCollection({
    accessToken: context.accessToken,
    path: '/identity/conditionalAccess/policies',
    limits: limitsFor(context, context.limits.maxItemsCaPolicies, { retry: { ...CA_RETRY } }),
  });
  return succeed(action, pageSet.items, {
    truncated: pageSet.stopReason !== 'complete',
    fetchedAt,
    sources: { policies: 'ok' },
  });
}

async function syncSkus(
  action: Extract<M365SyncAction, { type: 'm365.sync.skus' }>,
  context: GraphSyncActionContext,
  fetchedAt: Date,
): Promise<M365SyncActionResponse> {
  const pageSet = await context.graphClient.readSyncCollection({
    accessToken: context.accessToken,
    path: '/subscribedSkus',   // rejects $top
    limits: limitsFor(context, context.limits.maxItemsSkus, { maxPages: 5 }),
  });
  const items = pageSet.items.map((sku) => {
    const prepaid = sku.prepaidUnits;
    return {
      ...sku,
      prepaidUnits: isRecord(prepaid)
        ? { enabled: prepaid.enabled ?? null, suspended: prepaid.suspended ?? null, warning: prepaid.warning ?? null }
        : null,
    };
  });
  return succeed(action, items, {
    truncated: pageSet.stopReason !== 'complete',
    fetchedAt,
    sources: { subscribedSkus: 'ok' },
  });
}

async function syncSecureScore(
  action: Extract<M365SyncAction, { type: 'm365.sync.secure_score' }>,
  context: GraphSyncActionContext,
  fetchedAt: Date,
): Promise<M365SyncActionResponse> {
  const top = action.backfill === true ? SECURE_SCORE_TOP_BACKFILL : SECURE_SCORE_TOP_INCREMENTAL;
  const scores = await context.graphClient.readSyncCollection({
    accessToken: context.accessToken,
    path: '/security/secureScores',
    query: { '$top': String(top) },
    limits: limitsFor(context, top, { maxPages: 5 }),
  });

  let profileState: M365SyncSourceState = 'ok';
  const profiles = new Map<string, { title: string | null; maxScore: number | null }>();
  try {
    const profileSet = await context.graphClient.readSyncCollection({
      accessToken: context.accessToken,
      path: '/security/secureScoreControlProfiles',
      query: { '$select': 'id,title,maxScore,controlCategory' },
      limits: limitsFor(context, SECURE_SCORE_MAX_CONTROLS),
    });
    if (profileSet.stopReason !== 'complete') profileState = 'error';
    for (const profile of profileSet.items) {
      if (typeof profile.id !== 'string') continue;
      profiles.set(profile.id, {
        title: typeof profile.title === 'string' ? profile.title : null,
        maxScore: typeof profile.maxScore === 'number' ? profile.maxScore : null,
      });
    }
  } catch (error) {
    profileState = sourceStateFor(error);
  }

  const items = scores.items.map((score) => ({
    ...score,
    controlScores: Array.isArray(score.controlScores)
      ? score.controlScores.flatMap((control) => {
        if (!isRecord(control) || typeof control.controlName !== 'string') return [];
        const profile = profiles.get(control.controlName);
        return [{
          controlName: control.controlName,
          title: profile?.title ?? null,
          score: typeof control.score === 'number' ? control.score : null,
          maxScore: profile?.maxScore ?? null,
          implementationStatus: typeof control.implementationStatus === 'string'
            ? control.implementationStatus
            : null,
        }];
      })
      : [],
  }));

  return succeed(action, items, {
    truncated: scores.stopReason !== 'complete',
    fetchedAt,
    sources: { secureScores: 'ok', controlProfiles: profileState },
  });
}
```

Extend the switch:

```ts
      case 'm365.sync.signin_activity':
        return await syncSigninActivity(action, context, fetchedAt);
      case 'm365.sync.intune_devices':
        return await syncIntuneDevices(action, context, fetchedAt);
      case 'm365.sync.ca_policies':
        return await syncCaPolicies(action, context, fetchedAt);
      case 'm365.sync.skus':
        return await syncSkus(action, context, fetchedAt);
      case 'm365.sync.secure_score':
        return await syncSecureScore(action, context, fetchedAt);
```

and restore the real exhaustiveness guard now that every arm exists:

```ts
      default: {
        const exhaustive: never = action;
        throw new Error(`Unhandled M365 sync action: ${JSON.stringify(exhaustive)}`);
      }
```

- [ ] **Step 4: Run the whole executor suite**

```bash
cd apps/m365-graph-read-executor && npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add apps/m365-graph-read-executor/src/microsoft/syncActions.ts \
        apps/m365-graph-read-executor/src/microsoft/syncActions.domains.test.ts \
        apps/m365-graph-read-executor/src/microsoft/syncActions.testHarness.ts \
        apps/m365-graph-read-executor/src/microsoft/syncActions.users.test.ts
git commit -m "feat(m365): the remaining five sync domains

Wave 3 task 9 of the M365 tenant sync foundation (spec 4.1, 4.4).

signin_activity is its own resumable domain: 500 per page, at most
M365_SIGNIN_PAGES_PER_CALL pages per call, gated by the app-wide token bucket,
with the resume point sealed into an opaque continuation. It projects
lastSuccessfulSignInDateTime only — lastSignInDateTime counts failed
interactive attempts, so it would report a locked-out account as active. A 403
on the select is a missing Entra P1, reported as sources.signInActivity =
unlicensed with zero items rather than as a failure. An empty bucket returns
the inbound continuation unchanged so the walk resumes where it stopped.

intune_devices, ca_policies, skus and secure_score are primary-only pulls.
Conditional Access uses a fixed 2 s backoff because Graph returns 429 there
with no Retry-After. /subscribedSkus is fetched without \$top, which it
rejects. Secure Score joins secureScoreControlProfiles for each control's
title and maxScore and keeps the scores with null maxScore when that join
fails.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 10: In-flight gate and `syncActionOperation`

Spec §4.2 (capacity), §4.3. Deviation 8.

**Files:**
- Create: `apps/m365-graph-read-executor/src/inFlight.ts`
- Create: `apps/m365-graph-read-executor/src/inFlight.test.ts`
- Modify: `apps/m365-graph-read-executor/src/operations.ts`
- Modify: `apps/m365-graph-read-executor/src/operations.test.ts`

**Interfaces:**
- Produces:

```ts
// inFlight.ts
export type ExecutorRequestKind = 'sync' | 'interactive';
export type InFlightLease = { release(): void };
export interface InFlightGate {
  acquire(kind: ExecutorRequestKind): InFlightLease | null;   // null ⇒ refused
  snapshot(): { sync: number; total: number };
}
export function createInFlightGate(limits: { syncMaxInFlight: number; maxInFlight: number }): InFlightGate;

// operations.ts
export async function syncActionOperation(
  request: SyncActionRequest,
  dependencies: ExecutorOperationDependencies & { sync: SyncOperationDependencies },
): Promise<M365SyncActionResponse>;

export interface SyncOperationDependencies {
  limits: ExecutorSyncConfig;
  continuations: SyncContinuationCodec;
  signinLimiter: SigninLimiter;
}
```

- [ ] **Step 1: Write the failing tests**

Create `apps/m365-graph-read-executor/src/inFlight.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createInFlightGate } from './inFlight';
import { renderMetrics, resetMetrics } from './metrics';

describe('per-instance in-flight gate', () => {
  beforeEach(() => resetMetrics());

  it('refuses sync beyond the sync cap while interactive still has headroom', () => {
    const gate = createInFlightGate({ syncMaxInFlight: 2, maxInFlight: 4 });
    const first = gate.acquire('sync');
    const second = gate.acquire('sync');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(gate.acquire('sync')).toBeNull();          // sync cap reached…
    expect(gate.acquire('interactive')).not.toBeNull(); // …but an AI tool call still gets in
    expect(gate.snapshot()).toEqual({ sync: 2, total: 3 });
  });

  it('refuses everything past the total cap', () => {
    const gate = createInFlightGate({ syncMaxInFlight: 2, maxInFlight: 2 });
    gate.acquire('interactive');
    gate.acquire('interactive');
    expect(gate.acquire('interactive')).toBeNull();
    expect(gate.acquire('sync')).toBeNull();
  });

  it('releases exactly once, however many times release is called', () => {
    const gate = createInFlightGate({ syncMaxInFlight: 1, maxInFlight: 1 });
    const lease = gate.acquire('sync')!;
    lease.release();
    lease.release();
    expect(gate.snapshot()).toEqual({ sync: 0, total: 0 });
    expect(gate.acquire('sync')).not.toBeNull();
  });

  it('publishes the gauges and the rejection counter', () => {
    const gate = createInFlightGate({ syncMaxInFlight: 1, maxInFlight: 2 });
    gate.acquire('sync');
    gate.acquire('sync');
    const text = renderMetrics();
    expect(text).toContain('m365_sync_in_flight 1');
    expect(text).toContain('m365_in_flight_total 1');
    expect(text).toContain('m365_sync_capacity_rejected_total{kind="sync"} 1');
  });
});
```

Append to `apps/m365-graph-read-executor/src/operations.test.ts` (reusing that file's dependency-stub style):

```ts
describe('syncActionOperation', () => {
  it('refuses a non-canonical tenant id before touching the credential', async () => {
    const certificateProvider = { getConfiguredCertificate: vi.fn() };
    await expect(syncActionOperation(
      { correlationId: CORRELATION_ID, tenantId: 'not-a-uuid', action: { type: 'm365.sync.skus' } } as never,
      { ...baseDependencies({ certificateProvider }), sync: syncDependencies() },
    )).resolves.toEqual({ success: false, errorCode: 'graph_response_invalid' });
    expect(certificateProvider.getConfiguredCertificate).not.toHaveBeenCalled();
  });

  it('maps a credential failure to credential_unavailable', async () => {
    await expect(syncActionOperation(validSyncRequest(), {
      ...baseDependencies({ certificateProvider: { getConfiguredCertificate: async () => { throw new Error('kv down'); } } }),
      sync: syncDependencies(),
    })).resolves.toEqual({ success: false, errorCode: 'credential_unavailable' });
  });

  it('zeroes the credential material after the call, success or failure', async () => {
    const credential = { certificatePem: 'CERT', privateKeyPem: 'KEY' };
    await syncActionOperation(validSyncRequest(), {
      ...baseDependencies({ certificateProvider: { getConfiguredCertificate: async () => credential } }),
      sync: syncDependencies(),
    });
    expect(credential).toEqual({ certificatePem: '', privateKeyPem: '' });
  });

  it('records the action outcome on the metrics counter', async () => {
    resetMetrics();
    await syncActionOperation(validSyncRequest(), {
      ...baseDependencies(), sync: syncDependencies(),
    });
    expect(renderMetrics()).toContain('m365_sync_actions_total{action="m365.sync.skus",outcome="ok"}');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/m365-graph-read-executor && npx vitest run src/inFlight.test.ts src/operations.test.ts
```

- [ ] **Step 3: Implement**

Create `apps/m365-graph-read-executor/src/inFlight.ts`:

```ts
import { incrementSyncCapacityRejected, setSyncInFlight, setTotalInFlight } from './metrics';

/**
 * Per-instance concurrency caps (spec §4.2). No queueing: a refused caller is
 * told to come back, which keeps latency honest and lets the API's BullMQ
 * backoff own the waiting.
 *
 * Sync may occupy at most `syncMaxInFlight` of `maxInFlight`, and config
 * validates syncMaxInFlight <= maxInFlight, so interactive AI-tool calls
 * always have (maxInFlight - syncMaxInFlight) slots reserved for them.
 */
export type ExecutorRequestKind = 'sync' | 'interactive';

export interface InFlightLease { release(): void }

export interface InFlightGate {
  acquire(kind: ExecutorRequestKind): InFlightLease | null;
  snapshot(): { sync: number; total: number };
}

export function createInFlightGate(limits: {
  syncMaxInFlight: number;
  maxInFlight: number;
}): InFlightGate {
  let sync = 0;
  let total = 0;

  function publish(): void {
    setSyncInFlight(sync);
    setTotalInFlight(total);
  }

  return {
    acquire(kind) {
      if (total >= limits.maxInFlight || (kind === 'sync' && sync >= limits.syncMaxInFlight)) {
        incrementSyncCapacityRejected(kind);
        return null;
      }
      total += 1;
      if (kind === 'sync') sync += 1;
      publish();
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          total -= 1;
          if (kind === 'sync') sync -= 1;
          publish();
        },
      };
    },
    snapshot: () => ({ sync, total }),
  };
}
```

In `operations.ts`, add the sync dependency bundle and the operation, mirroring `readActionOperation` (lines 211-244) exactly — same credential ladder, same `finally` zeroing:

```ts
export interface SyncOperationDependencies {
  limits: ExecutorSyncConfig;
  continuations: SyncContinuationCodec;
  signinLimiter: SigninLimiter;
}

export async function syncActionOperation(
  request: SyncActionRequest,
  dependencies: ExecutorOperationDependencies & { sync: SyncOperationDependencies },
): Promise<M365SyncActionResponse> {
  const outcome = await runSyncAction(request, dependencies);
  incrementSyncAction(request.action.type, outcome.success ? 'ok' : outcome.errorCode);
  return outcome;
}

async function runSyncAction(
  request: SyncActionRequest,
  dependencies: ExecutorOperationDependencies & { sync: SyncOperationDependencies },
): Promise<M365SyncActionResponse> {
  if (!CANONICAL_UUID.test(request.tenantId)) {
    return { success: false, errorCode: 'graph_response_invalid' };
  }
  const credential = await fetchCredential(dependencies);
  if (typeof credential === 'string') {
    return {
      success: false,
      errorCode: credential === 'credential_unavailable' ? 'credential_unavailable' : 'application_token_invalid',
    };
  }
  let tokenClient: MicrosoftTokenClient | undefined;
  try {
    try {
      tokenClient = dependencies.createTokenClient(credential);
    } catch {
      return { success: false, errorCode: 'credential_unavailable' };
    }
    let accessToken;
    try {
      accessToken = await tokenClient.acquireGraphAppToken({ tenantId: request.tenantId });
    } catch {
      return { success: false, errorCode: 'application_token_invalid' };
    }
    return m365SyncActionResponseSchema.parse(await executeGraphSyncAction(request.action, {
      accessToken,
      graphClient: dependencies.graphClient,
      tenantId: request.tenantId,
      limits: dependencies.sync.limits,
      continuations: dependencies.sync.continuations,
      signinLimiter: dependencies.sync.signinLimiter,
    }));
  } finally {
    tokenClient = undefined;
    credential.certificatePem = '';
    credential.privateKeyPem = '';
  }
}
```

Extend `createExecutorOperations` to take `sync: SyncOperationDependencies` and return `syncAction: (request: SyncActionRequest) => syncActionOperation(request, dependencies)`.

Also add the sync-id guard to `readActionOperation`, immediately after the tenant check — defence in depth behind the route's 400:

```ts
  // The route already rejects these with 400 action_not_allowed; this keeps the
  // narrowing honest and survives a future caller that bypasses the route.
  if (isM365SyncAction(request.action)) {
    return { success: false, errorCode: 'graph_response_invalid' };
  }
```

- [ ] **Step 4: Run — green**

```bash
cd apps/m365-graph-read-executor && npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add apps/m365-graph-read-executor/src/inFlight.ts apps/m365-graph-read-executor/src/inFlight.test.ts \
        apps/m365-graph-read-executor/src/operations.ts apps/m365-graph-read-executor/src/operations.test.ts
git commit -m "feat(m365): in-flight gate and the sync-action operation

Wave 3 task 10 of the M365 tenant sync foundation (spec 4.2, 4.3).

The gate caps sync at M365_SYNC_MAX_IN_FLIGHT within a total
M365_MAX_IN_FLIGHT, so a bulk pull can never occupy the slots an AI tool call
needs — a test pins that the interactive path still admits once the sync cap
is full. Leases are idempotent on release. No queueing: refusal is honest
latency and the API's BullMQ backoff owns the waiting.

syncActionOperation mirrors readActionOperation's credential ladder exactly,
including zeroing the PEM material in finally, and records one metrics sample
per action outcome. readActionOperation gains a sync-id guard behind the
route's 400 so the interactive union stays exhaustively narrowed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 11: `POST /v1/sync-action`, the `internalAuth` operation, `GET /metrics`, `index.ts` wiring

Spec §4.2 (route, cross-rejection, 503, timeouts), §4.4. Deviations 5, 6, 8.

**Files:**
- Modify: `apps/m365-graph-read-executor/src/internalAuth.ts` — one union member
- Modify: `apps/m365-graph-read-executor/src/internalAuth.test.ts`
- Modify: `apps/m365-graph-read-executor/src/app.ts`
- Modify: `apps/m365-graph-read-executor/src/app.test.ts`
- Modify: `apps/m365-graph-read-executor/src/index.ts`

**Interfaces:**
- Consumes: `createInFlightGate` (Task 10), `renderMetrics` (Task 4), `syncActionRequestSchema` / `m365SyncActionResponseSchema` / `isM365SyncAction` (Task 2), `createSyncContinuationCodec` (Task 6), `createSigninLimiter` (Task 7), `config.sync` (Task 3).
- Produces: `ExecutorAppDependencies` gains `syncAction(request: SyncActionRequest): Promise<M365SyncActionResponse>` and `gate?: InFlightGate`; `ExecutorOperation` gains `'sync-action'`.

The JWT already binds the operation: `internalAuth.ts:100` compares `payload.operation !== input.operation`, so widening the union is all that is needed for a read-action token to be rejected at `/v1/sync-action`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/m365-graph-read-executor/src/app.test.ts`:

```ts
const SYNC_BODY = JSON.stringify({
  correlationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  action: { type: 'm365.sync.skus' },
});
const READ_BODY = JSON.stringify({
  correlationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  action: { type: 'm365.org.get' },
});
const SYNC_ON_READ_BODY = JSON.stringify({
  correlationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  action: { type: 'm365.sync.users' },
});
const OK_SYNC = {
  success: true, kind: 'sync', items: [], truncated: false,
  fetchedAt: '2026-09-08T00:00:00.000Z', sources: { subscribedSkus: 'ok' },
};
const authenticated = () => ({
  verify: vi.fn().mockResolvedValue({ correlationId: '11111111-1111-4111-8111-111111111111' }),
});
const post = (app: ReturnType<typeof createExecutorApp>, path: string, body: string) => app.request(path, {
  method: 'POST',
  headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
  body,
});

describe('sync-action route', () => {
  it('binds the sync-action operation into the auth check', async () => {
    const verify = vi.fn().mockResolvedValue({ correlationId: '11111111-1111-4111-8111-111111111111' });
    const syncAction = vi.fn().mockResolvedValue(OK_SYNC);
    const app = createExecutorApp({
      authenticator: { verify }, completeConsent: vi.fn(), retest: vi.fn(), readAction: vi.fn(), syncAction,
    });
    const response = await post(app, '/v1/sync-action', SYNC_BODY);
    expect(response.status).toBe(200);
    expect(verify).toHaveBeenCalledWith({
      authorization: 'Bearer token',
      operation: 'sync-action',
      rawBody: new TextEncoder().encode(SYNC_BODY),
    });
    expect(await response.json()).toEqual(OK_SYNC);
  });

  it('refuses a sync id on /v1/read-action and a read id on /v1/sync-action', async () => {
    const readAction = vi.fn();
    const syncAction = vi.fn();
    const app = createExecutorApp({
      authenticator: authenticated(), completeConsent: vi.fn(), retest: vi.fn(), readAction, syncAction,
    });
    const refusedRead = await post(app, '/v1/read-action', SYNC_ON_READ_BODY);
    expect(refusedRead.status).toBe(400);
    expect(await refusedRead.json()).toMatchObject({ code: 'action_not_allowed' });
    expect(readAction).not.toHaveBeenCalled();

    const refusedSync = await post(app, '/v1/sync-action', READ_BODY);
    expect(refusedSync.status).toBe(400);
    expect(await refusedSync.json()).toMatchObject({ code: 'action_not_allowed' });
    expect(syncAction).not.toHaveBeenCalled();
  });

  it('returns 503 sync_capacity with Retry-After once the sync cap is full', async () => {
    resetMetrics();
    let release!: () => void;
    const syncAction = vi.fn(() => new Promise((resolve) => { release = () => resolve(OK_SYNC); }));
    const app = createExecutorApp({
      authenticator: authenticated(), completeConsent: vi.fn(), retest: vi.fn(), readAction: vi.fn(), syncAction,
      gate: createInFlightGate({ syncMaxInFlight: 1, maxInFlight: 4 }),
    });
    const inflight = post(app, '/v1/sync-action', SYNC_BODY);
    const refused = await post(app, '/v1/sync-action', SYNC_BODY);
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('30');
    expect(await refused.json()).toEqual({
      error: 'sync_capacity', code: 'sync_capacity', retryAfterSeconds: 30,
    });
    expect(renderMetrics()).toContain('m365_sync_capacity_rejected_total{kind="sync"} 1');
    release();
    expect((await inflight).status).toBe(200);
  });

  it('reserves headroom: a full sync cap does not refuse an interactive call', async () => {
    let release!: () => void;
    const app = createExecutorApp({
      authenticator: authenticated(),
      completeConsent: vi.fn(), retest: vi.fn(),
      readAction: vi.fn().mockResolvedValue({ success: true, kind: 'resource', resource: {} }),
      syncAction: vi.fn(() => new Promise((resolve) => { release = () => resolve(OK_SYNC); })),
      gate: createInFlightGate({ syncMaxInFlight: 1, maxInFlight: 4 }),
    });
    const held = post(app, '/v1/sync-action', SYNC_BODY);
    expect((await post(app, '/v1/sync-action', SYNC_BODY)).status).toBe(503);
    expect((await post(app, '/v1/read-action', READ_BODY)).status).toBe(200);
    release();
    await held;
  });

  it('refuses past the TOTAL cap even on the interactive route', async () => {
    let releases: Array<() => void> = [];
    const app = createExecutorApp({
      authenticator: authenticated(),
      completeConsent: vi.fn(), retest: vi.fn(),
      readAction: vi.fn(() => new Promise((resolve) => { releases.push(() => resolve({ success: true, kind: 'resource', resource: {} })); })),
      syncAction: vi.fn(),
      gate: createInFlightGate({ syncMaxInFlight: 1, maxInFlight: 1 }),
    });
    const held = post(app, '/v1/read-action', READ_BODY);
    const refused = await post(app, '/v1/read-action', READ_BODY);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ code: 'capacity' });
    releases.forEach((fn) => fn());
    await held;
  });

  it('answers 504 when the operation outruns the route timeout, and frees the slot', async () => {
    const gate = createInFlightGate({ syncMaxInFlight: 1, maxInFlight: 4 });
    const app = createExecutorApp({
      authenticator: authenticated(), completeConsent: vi.fn(), retest: vi.fn(), readAction: vi.fn(),
      syncAction: () => new Promise(() => {}),   // never settles
      gate,
      syncTimeoutMs: 5,
    });
    const response = await post(app, '/v1/sync-action', SYNC_BODY);
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: 'sync_timeout' });
    expect(gate.snapshot()).toEqual({ sync: 0, total: 0 });
  });

  it('serves the metrics registry unauthenticated on the private interface', async () => {
    const app = createExecutorApp({
      authenticator: { verify: vi.fn() }, completeConsent: vi.fn(), retest: vi.fn(),
      readAction: vi.fn(), syncAction: vi.fn(),
    });
    const response = await app.request('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('# TYPE m365_sync_actions_total counter');
  });

  it('rejects a malformed sync body before the operation runs', async () => {
    const syncAction = vi.fn();
    const app = createExecutorApp({
      authenticator: authenticated(), completeConsent: vi.fn(), retest: vi.fn(), readAction: vi.fn(), syncAction,
    });
    const response = await post(app, '/v1/sync-action', JSON.stringify({
      correlationId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      action: { type: 'm365.sync.skus', backfill: true },   // wrong branch option
    }));
    expect(response.status).toBe(400);
    expect(syncAction).not.toHaveBeenCalled();
  });
});
```

Append to `apps/m365-graph-read-executor/src/internalAuth.test.ts` a case proving a token minted for `read-action` fails at `sync-action` (mirror the shipped operation-mismatch test).

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/m365-graph-read-executor && npx vitest run src/app.test.ts src/internalAuth.test.ts
```

- [ ] **Step 3: Implement**

`internalAuth.ts` line 8:

```ts
export type ExecutorOperation = 'complete-consent' | 'retest' | 'read-action' | 'sync-action';
```

`app.ts` — imports gain `syncActionRequestSchema`, `m365SyncActionResponseSchema`, `isM365SyncAction`, `type SyncActionRequest`, `type M365SyncActionResponse`, plus `createInFlightGate`/`type InFlightGate` and `renderMetrics`. Then:

```ts
const DEFAULT_SYNC_TIMEOUT_MS = 120_000;
const SYNC_CAPACITY_RETRY_AFTER_SECONDS = 30;
const INTERACTIVE_CAPACITY_RETRY_AFTER_SECONDS = 5;

export interface ExecutorAppDependencies {
  authenticator: InternalRequestAuthenticator;
  completeConsent(request: CompleteConsentRequest): Promise<CompleteConsentResult>;
  retest(request: RetestRequest): Promise<RetestResult>;
  readAction(request: ReadActionRequest): Promise<ReadActionResult>;
  syncAction(request: SyncActionRequest): Promise<M365SyncActionResponse>;
  maxBodyBytes?: number;
  /** Defaults to an unbounded-enough gate so existing callers keep working. */
  gate?: InFlightGate;
  syncTimeoutMs?: number;
}
```

Inside `createExecutorApp`, before `execute`:

```ts
  const gate = dependencies.gate ?? createInFlightGate({ syncMaxInFlight: 4, maxInFlight: 32 });
  const syncTimeoutMs = dependencies.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;

  function capacityRefusal(context: Context, kind: 'sync' | 'interactive') {
    const [code, retryAfterSeconds] = kind === 'sync'
      ? ['sync_capacity' as const, SYNC_CAPACITY_RETRY_AFTER_SECONDS]
      : ['capacity' as const, INTERACTIVE_CAPACITY_RETRY_AFTER_SECONDS];
    context.header('Retry-After', String(retryAfterSeconds));
    // `error` keeps the executor's envelope; `code` satisfies the wave contract.
    return context.json({ error: code, code, retryAfterSeconds }, 503);
  }

  /** Bounds one operation so a wedged Graph call cannot hold a slot forever. */
  async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timed-out'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<'timed-out'>((resolve) => { timer = setTimeout(() => resolve('timed-out'), ms); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
```

Inside `execute`, replace the `read-action` block and add the `sync-action` block. Both acquire a lease **after** auth and schema validation and release it in a `finally`:

```ts
    if (operation === 'read-action') {
      const request = readActionRequestSchema.safeParse(parsed);
      if (!request.success) return context.json({ error: 'invalid_request' }, 400);
      if (request.data.correlationId !== authentication.correlationId) {
        return context.json({ error: 'unauthorized' }, 401);
      }
      if (isM365SyncAction(request.data.action)) {
        return context.json({ error: 'action_not_allowed', code: 'action_not_allowed' }, 400);
      }
      const lease = gate.acquire('interactive');
      if (lease === null) return capacityRefusal(context, 'interactive');
      try {
        const result = readActionResultSchema.safeParse(await dependencies.readAction(request.data));
        return result.success ? context.json(result.data) : context.json({ error: 'internal_error' }, 500);
      } catch {
        return context.json({ error: 'internal_error' }, 500);
      } finally {
        lease.release();
      }
    }

    if (operation === 'sync-action') {
      const request = syncActionRequestSchema.safeParse(parsed);
      if (!request.success) {
        // A well-formed request naming an interactive action is a routing
        // mistake, not malformed input — say so.
        const readShaped = readActionRequestSchema.safeParse(parsed);
        return readShaped.success
          ? context.json({ error: 'action_not_allowed', code: 'action_not_allowed' }, 400)
          : context.json({ error: 'invalid_request' }, 400);
      }
      if (request.data.correlationId !== authentication.correlationId) {
        return context.json({ error: 'unauthorized' }, 401);
      }
      const lease = gate.acquire('sync');
      if (lease === null) return capacityRefusal(context, 'sync');
      try {
        const outcome = await withTimeout(dependencies.syncAction(request.data), syncTimeoutMs);
        if (outcome === 'timed-out') return context.json({ error: 'sync_timeout' }, 504);
        const result = m365SyncActionResponseSchema.safeParse(outcome);
        return result.success ? context.json(result.data) : context.json({ error: 'internal_error' }, 500);
      } catch {
        return context.json({ error: 'internal_error' }, 500);
      } finally {
        lease.release();
      }
    }
```

Register the routes next to the existing three:

```ts
  app.get('/metrics', (context) => context.text(renderMetrics(), 200, {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
  }));
  app.post('/v1/sync-action', (context) => execute(context, 'sync-action'));
```

`index.ts` — build the sync collaborators once per process and pass them down:

```ts
  const graphClient = createMicrosoftGraphClient({ applicationId: config.clientId });
  const operations = createExecutorOperations({
    clientId: config.clientId,
    callbackUrl: config.callbackUrl,
    certificateProvider,
    graphClient,
    sync: {
      limits: config.sync,
      continuations: createSyncContinuationCodec({ key: config.sync.continuationKey }),
      signinLimiter: createSigninLimiter({ requestsPerMinute: config.sync.signinActivityRpm }),
    },
  });
  const app = createExecutorApp({
    authenticator,
    ...operations,
    gate: createInFlightGate({
      syncMaxInFlight: config.sync.syncMaxInFlight,
      maxInFlight: config.sync.maxInFlight,
    }),
  });
```

⚠️ Every existing `createExecutorApp({...})` call site in `app.test.ts` now needs a `syncAction` property — the four shipped tests at lines 6-90 included. Add `syncAction: vi.fn()` to each; that is why they are listed in this task's file set.

- [ ] **Step 4: Run the whole package plus typecheck**

```bash
cd apps/m365-graph-read-executor && npx vitest run
pnpm --filter=@breeze/m365-graph-read-executor exec tsc --noEmit
pnpm --filter=@breeze/m365-graph-read-executor lint
```

- [ ] **Step 5: Commit**

```bash
git add apps/m365-graph-read-executor/src/app.ts apps/m365-graph-read-executor/src/app.test.ts \
        apps/m365-graph-read-executor/src/internalAuth.ts apps/m365-graph-read-executor/src/internalAuth.test.ts \
        apps/m365-graph-read-executor/src/index.ts
git commit -m "feat(m365): POST /v1/sync-action with capacity, timeout, and metrics

Wave 3 task 11 of the M365 tenant sync foundation (spec 4.2, 4.4).

A fourth operation next to complete-consent, retest and read-action, under the
same EdDSA body-digest auth: widening ExecutorOperation is enough for the
operation claim to bind it, so a read-action token is refused here.

The two routes refuse each other's ids with 400 action_not_allowed, so a bulk
pull can never arrive on the interactive path and be served under interactive
limits. Capacity is checked after auth and schema validation, released in
finally, and a wedged Graph call cannot hold a slot: the route answers 504
after 120 s, inside the API client's 130 s timeout and outside the Graph
client's 110 s deadline.

/metrics is unauthenticated like /healthz — the listener is bound to a private
RFC1918 interface by config.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 12: API client `sync-action` operation

Spec §4.3. Overview contract, "API client". Deviations 3, 4, 6.

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/graphReadExecutorClient.ts`
- Modify: `apps/api/src/services/m365ControlPlane/graphReadExecutorClient.test.ts`

**Interfaces:**
- Consumes: `syncActionRequestSchema`, `m365SyncActionResponseSchema`, `type SyncActionRequest`, `type M365SyncActionResult`, `type M365SyncFailureCode` (Task 2).
- Produces:

```ts
export interface GraphReadExecutorFailure {
  success: false;
  code: M365SyncFailureCode | 'sync_capacity';
  retryAfterSeconds?: number;
}

// GraphReadExecutorClient gains:
syncAction(input: SyncActionRequest): Promise<M365SyncActionResult | GraphReadExecutorFailure>;
```

`timeoutMs` 130 000 and `maxResponseBytes` 32 MiB apply to this operation only; the shipped `READ_ACTION_MAX_RESPONSE_BYTES` (256 KiB) and the client-wide 10 s timeout are untouched.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/m365ControlPlane/graphReadExecutorClient.test.ts`:

```ts
const SYNC_RESULT = {
  success: true as const,
  kind: 'sync' as const,
  items: [{ id: TENANT_ID, lastSuccessfulSignInAt: null }],
  truncated: false,
  fetchedAt: '2026-09-08T00:00:00.000Z',
  sources: { signInActivity: 'ok' as const },
};

function syncInput() {
  return {
    correlationId: CORRELATION_ID,
    tenantId: TENANT_ID,
    action: { type: 'm365.sync.signin_activity' as const },
  };
}

async function syncClient(fetchMock: typeof globalThis.fetch) {
  const { privateJwk } = await signingFixture();
  return createGraphReadExecutorClient({
    executorUrl: 'https://executor.internal.example.test',
    executorAudience: 'm365-graph-read-executor',
    signingPrivateJwk: privateJwk,
    signingKid: 'api-key-1',
    fetch: fetchMock,
  });
}

describe('Graph-read executor client — sync-action', () => {
  it('signs the sync-action operation, hits /v1/sync-action, and parses the result', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const token = String(new Headers(init?.headers).get('authorization')).slice('Bearer '.length);
      expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).operation).toBe('sync-action');
      return new Response(JSON.stringify(SYNC_RESULT), { headers: { 'content-type': 'application/json' } });
    });
    const client = await syncClient(fetchMock as unknown as typeof globalThis.fetch);
    await expect(client.syncAction(syncInput())).resolves.toEqual(SYNC_RESULT);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://executor.internal.example.test/v1/sync-action');
  });

  it('returns a typed sync_capacity failure on 503 rather than executor_unavailable', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: 'sync_capacity', code: 'sync_capacity', retryAfterSeconds: 30 }),
      { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '30' } },
    ));
    const client = await syncClient(fetchMock as unknown as typeof globalThis.fetch);
    await expect(client.syncAction(syncInput()))
      .resolves.toEqual({ success: false, code: 'sync_capacity', retryAfterSeconds: 30 });
  });

  it('returns a typed graph_throttled failure carrying retryAfterSeconds', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: false, errorCode: 'graph_throttled', retryAfterSeconds: 45 }),
      { headers: { 'content-type': 'application/json' } },
    ));
    const client = await syncClient(fetchMock as unknown as typeof globalThis.fetch);
    await expect(client.syncAction(syncInput()))
      .resolves.toEqual({ success: false, code: 'graph_throttled', retryAfterSeconds: 45 });
  });

  it('returns continuation_invalid so the caller can restart the walk', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: false, errorCode: 'continuation_invalid' }),
      { headers: { 'content-type': 'application/json' } },
    ));
    const client = await syncClient(fetchMock as unknown as typeof globalThis.fetch);
    await expect(client.syncAction(syncInput()))
      .resolves.toEqual({ success: false, code: 'continuation_invalid' });
  });

  it('still THROWS executor_unavailable for a 504, a wrong content type, and a bad body', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"sync_timeout"}', { status: 504, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(SYNC_RESULT), { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response('{"success":true,"kind":"collection","items":[]}', { headers: { 'content-type': 'application/json' } }));
    const client = await syncClient(fetchMock as unknown as typeof globalThis.fetch);
    for (let i = 0; i < 3; i += 1) {
      await expect(client.syncAction(syncInput())).rejects.toBeInstanceOf(GraphReadExecutorClientError);
    }
  });

  it('refuses an interactive action id without calling the executor', async () => {
    const fetchMock = vi.fn();
    const client = await syncClient(fetchMock as unknown as typeof globalThis.fetch);
    await expect(client.syncAction({
      correlationId: CORRELATION_ID, tenantId: TENANT_ID, action: { type: 'm365.org.get' },
    } as never)).rejects.toBeInstanceOf(GraphReadExecutorClientError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives sync-action its own 130 s timeout, not the client-wide one', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Response(JSON.stringify(SYNC_RESULT), { headers: { 'content-type': 'application/json' } });
    });
    const { privateJwk } = await signingFixture();
    const client = createGraphReadExecutorClient({
      executorUrl: 'https://executor.internal.example.test',
      executorAudience: 'm365-graph-read-executor',
      signingPrivateJwk: privateJwk,
      signingKid: 'api-key-1',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      timeoutMs: 10,   // the interactive timeout must NOT apply here
    });
    await expect(client.syncAction(syncInput())).resolves.toEqual(SYNC_RESULT);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/api && npx vitest run src/services/m365ControlPlane/graphReadExecutorClient.test.ts
```

- [ ] **Step 3: Implement**

In `graphReadExecutorClient.ts`:

```ts
const SYNC_ACTION_TIMEOUT_MS = 130_000;
const SYNC_ACTION_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

type ExecutorOperation = 'complete-consent' | 'retest' | 'read-action' | 'sync-action';

const OPERATION_ENDPOINT_PATHS: Record<ExecutorOperation, string> = {
  'complete-consent': '/v1/complete-consent',
  retest: '/v1/retest',
  'read-action': '/v1/read-action',
  'sync-action': '/v1/sync-action',
};

/**
 * An outcome the executor reported. Distinct from GraphReadExecutorClientError,
 * which still means "we could not get an answer" and is still thrown: a caller
 * that must back off for a stated number of seconds needs the number, and
 * collapsing 503 sync_capacity into executor_unavailable throws it away.
 */
export interface GraphReadExecutorFailure {
  success: false;
  code: M365SyncFailureCode | 'sync_capacity';
  retryAfterSeconds?: number;
}
```

Extract the signed dispatch so `invoke` and `syncAction` share it (replacing the body of `invoke` at lines 154-201 with a thin wrapper):

```ts
  async function dispatch(
    operation: ExecutorOperation,
    input: { correlationId: string },
    timeout: number,
  ): Promise<Response> {
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw unavailable();
    // This is the sole serialization. The exact bytes are both signed and sent.
    const rawBody = JSON.stringify(input);
    const bodySha256 = createHash('sha256').update(rawBody).digest('base64url');
    const issuedAt = Math.floor(now().getTime() / 1_000);
    const token = await new SignJWT({ operation, correlationId: input.correlationId, bodySha256 })
      .setProtectedHeader({ alg: 'EdDSA', kid: config.signingKid })
      .setIssuer('breeze-api')
      .setAudience(config.executorAudience)
      .setSubject('breeze-control-plane')
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + TOKEN_LIFETIME_SECONDS)
      .setJti(randomUUID())
      .sign(await signingKey());

    return request(operationEndpoint(executorOrigin, operation), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: rawBody,
    });
  }

  async function invoke<T>(
    operation: ExecutorOperation,
    input: CompleteConsentRequest | RetestRequest | ReadActionRequest,
    parseResponse: (value: unknown) => T,
    maxBytes: number = maxResponseBytes,
  ): Promise<T> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw unavailable();
    try {
      const response = await dispatch(operation, input, timeoutMs);
      if (!response.ok || !exactJsonContentType(response)) throw unavailable();
      const rawResponse = await readBoundedResponse(response, maxBytes);
      return parseResponse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawResponse)));
    } catch {
      throw unavailable();
    }
  }
```

Add the method to the returned object and to `GraphReadExecutorClient`:

```ts
    async syncAction(input) {
      const parsed = syncActionRequestSchema.safeParse(input);
      if (!parsed.success) throw unavailable();
      let response: Response;
      let decoded: string;
      try {
        response = await dispatch('sync-action', parsed.data, SYNC_ACTION_TIMEOUT_MS);
        if (!exactJsonContentType(response)) throw unavailable();
        const raw = await readBoundedResponse(response, SYNC_ACTION_MAX_RESPONSE_BYTES);
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch {
        throw unavailable();
      }

      if (response.status === 503) {
        const body = capacityRefusalSchema.safeParse(safeJson(decoded));
        if (!body.success) throw unavailable();
        return {
          success: false,
          code: 'sync_capacity',
          retryAfterSeconds: body.data.retryAfterSeconds ?? DEFAULT_SYNC_CAPACITY_RETRY_SECONDS,
        };
      }
      if (!response.ok) throw unavailable();

      const parsedResponse = m365SyncActionResponseSchema.safeParse(safeJson(decoded));
      if (!parsedResponse.success) throw unavailable();
      if (parsedResponse.data.success) return parsedResponse.data;
      return {
        success: false,
        code: parsedResponse.data.errorCode,
        ...(parsedResponse.data.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: parsedResponse.data.retryAfterSeconds }),
      };
    },
```

with these module-level helpers:

```ts
const DEFAULT_SYNC_CAPACITY_RETRY_SECONDS = 30;

const capacityRefusalSchema = z.object({
  code: z.literal('sync_capacity'),
  retryAfterSeconds: z.number().int().min(1).max(300).optional(),
});

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
```

(`z` is a new import in this file: `import { z } from 'zod';`.)

- [ ] **Step 4: Run and typecheck**

```bash
cd apps/api && npx vitest run src/services/m365ControlPlane/graphReadExecutorClient.test.ts src/services/m365ControlPlane/readActionService.test.ts
pnpm --filter=@breeze/api exec tsc --noEmit
```

`readActionService.test.ts` is run because it constructs the client — proof the shared `dispatch` refactor did not move the interactive path.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/graphReadExecutorClient.ts \
        apps/api/src/services/m365ControlPlane/graphReadExecutorClient.test.ts
git commit -m "feat(m365): syncAction operation on the Graph-read executor client

Wave 3 task 12 of the M365 tenant sync foundation (spec 4.3).

A fourth operation with its own 130 s timeout and 32 MiB response cap; the
interactive 10 s / 256 KiB budgets are untouched, and the signing path is now
shared rather than duplicated.

Executor-reported outcomes come back as typed failures carrying
retryAfterSeconds — 503 sync_capacity, graph_throttled, continuation_invalid —
instead of collapsing into executor_unavailable, because the worker's backoff
needs the number. Everything that means 'no answer' (504, wrong content type,
unparseable body, transport error) still throws
GraphReadExecutorClientError, exactly like the other three methods.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 13: Deploy documentation

Spec §4.2 (memory measurement recorded in the deploy doc), §7.

**Files:**
- Modify: `docs/deploy/m365-customer-graph-read-executor.md`

- [ ] **Step 1: Add the env rows**

In the **Executor** table (line 109, after `M365_GRAPH_READ_EXECUTOR_PORT`):

```markdown
| `M365_SYNC_MAX_IN_FLIGHT` | Optional, default `4`. Concurrent whole-domain sync actions per replica. Must be ≤ `M365_MAX_IN_FLIGHT`; boot refuses otherwise. |
| `M365_MAX_IN_FLIGHT` | Optional, default `32`. Total concurrent operations per replica across all four routes. The difference between the two caps is the headroom reserved for interactive AI-tool reads. |
| `M365_SIGNIN_ACTIVITY_RPM` | Optional, default `4`. Token-bucket rate for `signInActivity` Graph requests. Microsoft throttles this **per app across all tenants** at 10/min, so this is a per-process budget, not a per-tenant one: with N replicas set each to `4 / N` (rounded down, minimum 1), and leave headroom if a second region shares the app registration. |
| `M365_SIGNIN_PAGES_PER_CALL` | Optional, default `5`. Pages of 500 users per sign-in sync call before the executor returns a continuation. |
| `M365_SYNC_MAX_ITEMS_USERS` | Optional, default `25000`. Hard item ceiling for the users and sign-in domains. |
| `M365_SYNC_MAX_ITEMS_DEVICES` | Optional, default `25000`. Hard item ceiling for the Intune device domain. |
| `M365_SYNC_MAX_ITEMS_CA` | Optional, default `500`. Hard item ceiling for Conditional Access policies. |
| `M365_SYNC_MAX_ITEMS_SKUS` | Optional, default `200`. Hard item ceiling for subscribed SKUs. |
| `M365_SYNC_CONTINUATION_KEY` | Optional. Exactly 32 bytes of standard base64 (44 characters, one `=`). Encrypts the resumable sign-in continuation. **Set it whenever more than one replica runs**, otherwise each replica mints an ephemeral key at boot and a continuation issued by one replica is rejected by another — correct, but it restarts the sign-in page walk every time. Rotating it invalidates outstanding continuations only. |
```

- [ ] **Step 2: Add the memory guidance and the metrics names**

After the "Managed identity may use `AZURE_CLIENT_ID`…" paragraph:

```markdown
**Sizing.** Sync actions buffer a whole domain in memory before projecting it: at the default caps a maximum-size tenant is roughly 25 000 users plus 25 000 devices. Size each replica at **512 MB** when `M365_SYNC_MAX_IN_FLIGHT` is at its default of 4 and tenants approach those caps; 256 MB is enough for read-only deployments with `M365_TENANT_SYNC_ENABLED` off on the API. Raising `M365_SYNC_MAX_IN_FLIGHT` raises peak memory roughly linearly — raise the memory limit with it. If bulk pulls must be guaranteed never to contend with interactive AI-tool reads, run sync-only replicas behind a second URL rather than raising the caps.
```

In **Operational signals**, after the `breeze_m365_graph_read_actions_total` paragraph:

```markdown
The executor itself now exposes `GET /metrics` on the same private listener as `/healthz` (unauthenticated, RFC1918-bound, no path prefix): counters `m365_sync_actions_total{action,outcome}` and `m365_sync_capacity_rejected_total{kind}`, and gauges `m365_sync_in_flight`, `m365_in_flight_total`, `m365_signin_limiter_tokens`. These are a separate scrape target from the API's `/metrics` and carry no `breeze_` prefix. `m365_signin_limiter_tokens` sitting at 0 across a scrape interval means the app-wide sign-in budget is saturated and sign-in syncs are returning continuations rather than completing — raise the domain's interval or reduce replica count, do not raise `M365_SIGNIN_ACTIVITY_RPM` above what Microsoft's 10/min per-app limit allows.
```

- [ ] **Step 3: Verify the doc builds and commit**

```bash
pnpm --filter=@breeze/docs build 2>/dev/null || echo "docs app does not build this file; deploy docs are plain markdown"
git add docs/deploy/m365-customer-graph-read-executor.md
git commit -m "docs(m365): executor sync env vars, sizing, and metrics

Wave 3 task 13 of the M365 tenant sync foundation (spec 4.2, 7).

Nine new optional env rows with their defaults and the two constraints an
operator can get wrong: M365_SIGNIN_ACTIVITY_RPM is a PER-PROCESS budget
against a per-app Graph limit, so it must be divided across replicas, and
M365_SYNC_CONTINUATION_KEY must be set once more than one replica runs or
sign-in page walks restart on every hop.

Plus the 512 MB per-replica sizing the spec asks to be recorded, and the
executor's own /metrics series.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 14: Full verification and PR

- [ ] **Step 1: Run every affected suite**

```bash
cd packages/shared && npx vitest run
cd apps/m365-graph-read-executor && npx vitest run
cd apps/api && npx vitest run src/services/m365ControlPlane
```

All three must be green. The API run is scoped: this wave touches one file there.

- [ ] **Step 2: Build and typecheck**

```bash
pnpm --filter=@breeze/m365-graph-read-executor exec tsc --noEmit
pnpm --filter=@breeze/m365-graph-read-executor build
test -s apps/m365-graph-read-executor/dist/index.cjs
pnpm --filter=@breeze/shared exec tsc --noEmit
pnpm --filter=@breeze/api exec tsc --noEmit
pnpm --filter=@breeze/m365-graph-read-executor lint
```

The build check mirrors `ci.yml:1147-1179` (`build-m365-graph-read-executor`), which asserts a non-empty `dist/index.cjs`.

- [ ] **Step 3: Prove the wave stayed in its lane**

```bash
git diff --stat main -- apps/api/migrations apps/api/src/db     # must be EMPTY
git diff --stat main -- apps/api/src/services/m365ControlPlane  # only graphReadExecutorClient{,.test}.ts
git diff --stat main | tail -1
```

No migration, no schema column, no second API file. If any of those three is non-empty, something from W02 or W04 leaked into this branch.

- [ ] **Step 4: Merge main and re-verify**

CI tests the merge commit, not the branch tip.

```bash
git fetch origin main && git merge origin/main
cd apps/m365-graph-read-executor && npx vitest run
cd packages/shared && npx vitest run
```

- [ ] **Step 5: Mirror the deviations into the overview**

Edit `docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-0-overview.md`'s "Shared interface contract" section for deviations 1–8: the continuation key env var, `m365SyncFailureCodeSchema` / `m365SyncActionResponseSchema` / `continuation_invalid`, the `GraphReadExecutorFailure` shape, the `504 sync_timeout` route code, the dual `error`/`code` bodies, the interactive `capacity` refusal, and `title: string | null` inside `secure_score`'s `controlScores`. Commit as `docs(m365): record wave 3 contract deviations in the plan overview` with the same trailers.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(m365): tenant sync wave 3 — executor sync actions, route, limits, API client" --body "$(cat <<'BODY'
## Summary

Wave 3 of the M365 tenant sync foundation (spec §4). The executor gains six whole-domain `m365.sync.*` actions on their own `POST /v1/sync-action` route, and the API gains the client operation that calls it. No database, worker, or UI changes — W04 consumes this.

- **Shared** — `sync.ts` (domain vocabulary + cadence bounds); six action branches, projection allowlists, and the sync result/failure schemas appended to `readActions.ts`.
- **Executor** — `readSyncCollection` (a second limit profile: 60 pages, env item caps, 64 MiB, a 110 s `AbortController` deadline, `Retry-After`-honouring retry, fixed backoff for Conditional Access); `syncActions.ts` with one case per action; AES-256-GCM tenant-bound continuations; a non-blocking app-wide sign-in token bucket; per-instance in-flight caps; a dependency-free Prometheus registry on `GET /metrics`.
- **API** — `syncAction()` with a 130 s timeout, a 32 MiB cap, and typed failures carrying `retryAfterSeconds`.
- **Docs** — nine env rows, 512 MB per-replica sizing, and the executor metric names.

## Decisions worth a reviewer's attention

1. **The continuation key is a new optional env var, not derived from the signing key.** The executor holds only the *public* verification JWK (`config.ts:119-134`); there is no private material to derive from. With no `M365_SYNC_CONTINUATION_KEY` it mints an ephemeral per-process key, so a continuation dies with the process — the API sees `continuation_invalid` and restarts the walk. Self-healing, and it does not break any deployed executor.
2. **`continuation_invalid` lives in a new `m365SyncFailureCodeSchema`, not in `readActionFailureCodeSchema`.** Widening the read enum would break the exhaustive `FAILURE_MESSAGES` record at `readActionService.ts:35-46`, a file this wave does not touch.
3. **Typed failures are returned; "no answer" still throws.** `GraphReadExecutorFailure` carries `sync_capacity` / `graph_throttled` / `continuation_invalid` with `retryAfterSeconds`; 504, wrong content type, and unparseable bodies still throw `GraphReadExecutorClientError`.
4. **The total in-flight cap applies to the interactive routes too** (`503 { code: 'capacity' }`). Capping only sync would leave the "total" cap unbounded; the reserved-headroom guarantee holds because config validates `M365_SYNC_MAX_IN_FLIGHT <= M365_MAX_IN_FLIGHT`.
5. **A truncated *secondary* source is discarded, not partially applied** — half a registration report manufactures false "no MFA" for every user it did not reach.

All deviations are mirrored into the plan overview's shared interface contract in this PR.

## Testing

- `packages/shared`, `apps/m365-graph-read-executor` full suites; `apps/api` scoped to `src/services/m365ControlPlane`.
- Executor coverage per spec §4.4: recorded Graph fixtures per action; group-principal role expansion and its 50-group cap; a user missing from the registration report yielding `null`; continuation round trip, expiry, tenant mismatch, wrong action, and foreign key; unlicensed sign-in; truncated paging; `/v1/read-action` refusing a sync id and vice versa; sync-cap 503 with `Retry-After`; total-cap reservation; the limiter returning early with a continuation; throttle retry honouring `Retry-After`; the CA fixed 2 s backoff; and deadline cancellation both between pages and mid-flight.
- `tsc --noEmit` on shared, executor, and api; `tsup` build with a non-empty `dist/index.cjs`; eslint.
- `git diff --stat main -- apps/api/migrations apps/api/src/db` is empty: no migration, no schema column, so no cascade/export-policy registration applies to this wave.

Closes #5330

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
BODY
)"
```

- [ ] **Step 7: Confirm CI ran the right jobs**

```bash
gh pr checks --watch ; true
```

`test-m365-graph-read-executor`, `build-m365-graph-read-executor`, `test-api`, `typecheck`, and `lint` must all appear and pass. (`gh pr checks` exits non-zero while checks are pending — never chain it with `&&`.)

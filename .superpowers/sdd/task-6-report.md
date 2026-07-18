# Task 6 report — runtime extension operations

**Status:** DONE
**Commits:** `8c69e8c8a` (feature), `e181697f1` (integration coverage for `listAll`)
**Branch:** `feat/runtime-ext-02-operations` (from `5f040f443`)

> Note: this path previously held a stale `task-6-report.md` from an unrelated
> feature (`339430939`, partner-api reconstruction) that reused the filename. It
> is preserved in git history; overwritten here per this plan's convention
> (tasks 2–5 reports occupy the same paths).

---

## 1. Files

**Created**
| File | Purpose |
|---|---|
| `apps/api/src/routes/extensionsAdmin.ts` | Platform-admin router (list / doctor / enable / disable) |
| `apps/api/src/routes/extensionsAdmin.test.ts` | 13 tests |
| `apps/api/scripts/breezectl.lib.ts` | All CLI logic (unit-testable, no `main()` on import) |
| `apps/api/scripts/breezectl.ts` | Thin argv/exit-code shell (`#!/usr/bin/env tsx`) |
| `apps/api/scripts/breezectl.test.ts` | 21 tests |
| `apps/api/src/extensions/trust.ts` | Shared publisher trust-anchor resolver |

**Modified**
| File | Change |
|---|---|
| `apps/api/src/extensions/stateStore.ts` | `listAll()` on store + `listRows()` on backend & Drizzle backend |
| `apps/api/src/extensions/jobHost.ts` | `resyncExtensionSchedules()` export |
| `apps/api/src/extensions/reconciler.ts` | `defaultTrustFor` extracted → imports `resolveTrustedPublisher` |
| `apps/api/src/index.ts` | Mount `extensionsAdminRoutes` |
| `apps/api/tsup.config.ts` | `scripts/breezectl` entry |
| `apps/api/package.json` | `breezectl` + `breezectl:dev` scripts |
| 4 test files | In-memory `ExtensionStateBackend` fakes gained `listRows()` |
| `extensionState.integration.test.ts` | Real-SQL `listAll` coverage |

**Not modified: `apps/api/Dockerfile`** — see §8.

---

## 2. Mount-path decision (deviation from brief)

The brief says `/api/v1/extensions`. **Shipped at `/api/v1/admin/extensions`.**

Every other platform-admin surface in this repo lives under `/api/v1/admin/*`
(`adminRoutes`, `accountDeletionAdminRoutes`), and `platformAdminMiddleware`'s
audit-action builder explicitly strips a `/api/v1/admin/` prefix
(`platformAdmin.ts:51`) to derive the `platform_admin.<route>` action name.
Mounting at `/api/v1/extensions` would have produced mis-shaped audit action
strings and split the platform-admin surface across two prefixes. Not mounted at
both paths: two routes to one privileged mutation doubles the audit/authz
surface for no operator benefit.

**Ordering matters and is deliberate.** `extensionsAdminRoutes` carries its own
`routes.use('*', platformAdminMiddleware)` (mirroring `routes/admin/index.ts`),
so it is registered *before* `api.route('/admin', adminRoutes)`:

```ts
api.route('/admin/extensions', extensionsAdminRoutes);
api.route('/admin', adminRoutes);
```

Registered the other way round, `adminRoutes`' `use('*')` gate would *also*
match these paths — authenticating and audit-logging every request twice. I did
not assume Hono's ordering semantics here; I verified empirically with a
throwaway probe test that specific-before-generic runs **only** the specific
gate. Keeping the self-gate (rather than mounting inside `adminRoutes` ungated)
means the router is safe if it is ever remounted elsewhere.

---

## 3. How `listAll` was added

No list-all method existed. Added along the established three-layer seam:

- `ExtensionStateBackend.listRows(): Promise<ExtensionStateRecord[]>`
- `DrizzleExtensionStateBackend.listRows()` — `select().from(installedExtensions).orderBy(name)`, wrapped in `withSystemDbAccessContext` like every other backend call (mandatory: `installed_extensions` is FORCE-RLS system-only)
- `ExtensionStateStore.listAll()` — pass-through, no filtering, so an operator sees failed and disabled rows too

All four in-memory backend fakes (`reconciler.test.ts`, `stateStore.test.ts`,
`migrator.test.ts`, `extensionMigrator.integration.test.ts`) implement the new
method — a required interface member, so omitting one is a compile error.

**Second commit rationale:** unit tests exercise `listAll` only through in-memory
fakes, which cannot catch a broken `ORDER BY` or a *missing* system-scope
wrapper — RLS would silently filter every row to an empty list and the fake-backed
test would still pass. Added a real-Postgres assertion.

---

## 4. Disable → job-host re-sync (carried-over spec gap, closed)

Task 5's gap: `ExtensionJobHost.sync()` ran only at boot, so a disabled
extension kept its BullMQ repeatable entries until the next restart. The
processor skipped the ticks, but the schedules lingered.

`jobHost.ts` now exports:

```ts
export async function resyncExtensionSchedules(
  registry: JobHostRegistry = extensionContributionRegistry,
  queue: JobHostQueue = getExtensionJobsQueue(),
): Promise<void>
```

`sync()` derives its desired set from `registry.listActive()`, which excludes
withdrawn snapshots — so *withdraw then resync* is exactly the removal we want.
The `store` dep is only read by `process()`, never by `sync()`, so it is a
never-called stub; the helper needs no database.

`applyEnabled` does three things in order:
1. `stateStore.setEnabled` — durable, fleet-wide source of truth
2. registry `withdraw`/`activate` — local replica's in-process view. `withdraw` **preserves the staged snapshot** and flips only its `enabled` field, so a disable is fully reversible via `activate({...snapshot, enabled: true})` without a restart.
3. `resyncSchedules()` — removes the disabled extension's repeatables now; restores them on enable.

**Redis-unavailable behavior:** step 3 is best-effort by design. The flag lives
in PostgreSQL and is authoritative on its own (gateway re-checks per request,
processor per tick), so a Redis outage must not block an operator shutting off a
misbehaving extension. A throw is caught, logged server-side with the raw error,
and returns **HTTP 200 with `scheduleSyncDeferred: true`** — the raw error never
reaches the response. Next boot's `sync()` reconciles leftovers. Tested
(`ECONNREFUSED` case asserts 200, flag flipped, and no `ECONNREFUSED` in the body).

The disable-drops-repeatables test wires the route's resync to a **real**
`ExtensionJobHost` over a **real** registry with a fake queue, so it proves the
end-to-end effect rather than that a spy was called.

---

## 5. CLI auth mechanism

**No blocker — the decision works against the real middleware.** `authMiddleware`
(`auth.ts:323-330`) accepts `Authorization: Bearer <access token>`, and
`platformAdminMiddleware` then requires `isPlatformAdmin === true`. An operator's
existing platform-admin access token satisfies both. The CLI never mints
credentials.

| Env | Purpose |
|---|---|
| `BREEZE_ADMIN_TOKEN` | platform-admin access token (list/doctor/enable/disable) |
| `PUBLIC_API_URL` → `PUBLIC_APP_URL` → `BREEZE_SERVER` | server origin (same fallback chain as `recover-stuck-agents.ts:108-119`) |
| `BREEZE_EXTENSIONS_CONFIG` / `BREEZE_EXTENSIONS_ROOT` | path to `extensions.yaml` |

Either missing env fails with an actionable message naming the variable (tested).

**`list`/`doctor` go through the API too**, not the DB. Justification: `doctor`'s
most valuable fields — recomputed compatibility reasons, fault-attribution
presence, live route namespace / jobs / AI tools — exist only in the *running
server's* in-process registry and cannot be derived from PostgreSQL at all. A
DB-direct path would produce a strictly worse `doctor` and a second, unaudited
read surface. One transport for all four runtime verbs.

**Failure bodies are never echoed.** On a non-2xx the CLI reports method, path,
and status, plus a hint for 401/403 — an error body can carry request context,
and shell history and CI logs are not a place to spill it (tested).

---

## 6. Filesystem lock design

None existed (only pg advisory locks). Built an `O_EXCL` advisory lock in
`breezectl.lib.ts`:

- Lockfile `<configPath>.breezectl.lock`, created with `openSync(path, 'wx')` — atomic create-or-fail
- Body records `{pid, at}` for a human debugging a leftover
- **Released in a `finally`**, so it survives a mid-edit throw (tested for both success and failure paths)
- **Staleness is judged on the lockfile's mtime, not its body** — a crashed process's self-reported timestamp is untrusted input. Older than 15 min → logged and broken; younger → refuse, with a message telling the operator to wait or remove it manually. A live concurrent edit is never stomped.

Scope: protects against concurrent `breezectl` runs on one host. It does *not*
protect against a deployment pipeline overwriting the file wholesale — documented
in the module header.

Writes are atomic: temp file in the same directory + `renameSync`.

---

## 7. `trustFor` — extracted, not exported

`defaultTrustFor` was private at `reconciler.ts:381`. **Extracted** to
`src/extensions/trust.ts` as `resolveTrustedPublisher`; `reconciler.ts` imports it
(`trustFor: resolveTrustedPublisher`) and its now-unused `node:crypto`/`readFileSync`
imports were removed.

Extraction rather than re-export because `reconciler.ts` transitively pulls in the
Drizzle pool, `postgres`, Hono, the audit service and the whole app graph. A CLI
importing it for one key-load would inherit all of that — and, worse, would gain
the *ability* to reach PostgreSQL. `trust.ts` depends only on `node:crypto`,
`node:fs`, and config types. One implementation of key loading, so an operator's
pre-flight `verify` is byte-for-byte the same trust decision the server makes at boot.

---

## 8. Dockerfile — no change needed

The runner stage already copies the whole dist tree
(`COPY --from=builder .../apps/api/dist ./apps/api/dist`, line 70) and
`apps/api/package.json` (line 71), with `WORKDIR /app/apps/api` (line 79). So both
`node dist/scripts/breezectl.cjs …` and `pnpm breezectl …` work in the stock image
the moment tsup emits the entry. Per instructions, no cosmetic edit was made.

---

## 9. Sanitization

- **Error text is reconstructed from the coarse persisted `last_error_category`** via a fixed lookup table. The persisted `last_error_message` is *never read*. This is stronger than filtering it: even a row written by some future code path with a chatty message cannot leak, because the field is not on the read path at all. Unknown category → generic fallback.
- **Fault attribution is a boolean** (`codeLoaded`), never the extracted-root path.
- `artifactDigest` **is** exposed — it is the public content address of a signed bundle and the exact value an operator pins in `extensions.yaml`, not a secret.
- Tested with a row whose message contains `/srv/keys/lanternops.pem token=s3cr3t-value`; asserts neither the secret, the path, nor the field name appears in the response.
- `doctor` returns `compatibility: null` when the bundle is not loaded in this replica, rather than guessing — a fabricated "compatible" would be worse than an honest unknown.

---

## 10. Source-of-truth guarantee

`extensions.yaml` remains the only store of desired state. `install`/`upgrade`
acquire the lock, verify writability, parse, replace **exactly one** selection,
re-validate the whole document through the server's own
`parseExtensionDeploymentConfig`, show a diff, then commit atomically.

The read-only refusal message names the deployment pipeline rather than
suggesting `chmod` — a read-only mount is a correctly locked-down deployment, not
a bug to work around:

> `<path>` is not writable, so breezectl cannot **change deployment configuration** on this host. Extension selections are desired state: change them in your deployment configuration (Helm values, ConfigMap, or image build) and redeploy.

Writability is probed on **both** the file (`open` in append mode — proves
permission without truncating) **and** the directory (atomic rename needs a
writable dir; otherwise the failure would surface later as a raw `EROFS`).

**`breezectl.lib.ts` imports no database module** — not the Drizzle client, not
the state store, not the reconciler. It is *structurally* incapable of writing
desired state to PostgreSQL. Asserted three ways:
1. a test over the file's import list (rejects `/db`, `drizzle`, `postgres`, `stateStore`, `reconciler`);
2. a grep of the **built** bundle for `drizzle-orm` / `postgres` / `installed_extensions` / `DATABASE_URL` — all absent;
3. bundle size: **36 KB vs `recover-stuck-agents.cjs`'s 4 MB** (that script does import the DB).

---

## 11. Commands and results

```
$ pnpm -F @breeze/api test:run src/extensions src/routes/extensionsAdmin.test.ts scripts/breezectl.test.ts
  Test Files  18 passed (18)
       Tests  216 passed (216)

$ pnpm -F @breeze/api test:run src/extensions src/routes/extensionsAdmin.test.ts scripts/breezectl.test.ts src/routes/admin
  Test Files  21 passed (21)
       Tests  255 passed (255)

$ NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project tsconfig.json
  (no output) TSC_EXIT=0

$ pnpm exec eslint <10 changed src files>
  0 errors, 3 warnings   # warnings = "File ignored because no matching configuration"
                         # for scripts/*.ts — pre-existing; scripts/ is outside the
                         # eslint config (recover-stuck-agents.ts is too).

$ pnpm -F @breeze/api build
  CJS dist/scripts/breezectl.cjs            36.34 KB
  CJS dist/scripts/recover-stuck-agents.cjs 4.01 MB
  CJS dist/index.cjs                        13.33 MB
  CJS ⚡️ Build success in 334ms

$ pnpm test:integration --run .../extensionState.integration.test.ts .../extensionMigrator.integration.test.ts
  Test Files  2 passed (2)
       Tests  5 passed (5)      # 4 before the listAll addition
  # trailing "Vite server did not exit" notice is a pre-existing teardown quirk,
  # not a test failure

$ pnpm -F @breeze/api test:run          # FULL unit suite — regression gate
  Test Files  1100 passed | 5 skipped (1105)
       Tests  14969 passed | 51 skipped (15020)
```

**Built-CLI smoke test** (beyond the unit tests): ran `dist/scripts/breezectl.cjs`
directly — unknown-noun prints usage and exits 1; `extensions install` against a
temp config emitted the diff, the comment-loss notice, and wrote correct
normalized YAML.

### The typecheck gate earned its keep

216 green tests coexisted with **8 real production type errors** in
`extensionsAdmin.ts` — exactly the failure mode flagged in the task. Root cause:
I had typed `applyEnabled`'s context as
`Parameters<Parameters<Hono['get']>[1]>[0]`, which resolves to `never`, silently
disabling all type checking inside the function. Fixed by importing Hono's
`Context` type properly. That in turn surfaced that `c.req.param('name')` is
`string | undefined` on a bare `Context` — fixed with a real 400 guard rather
than a cast, which is a genuine behavioral improvement.

---

## 12. Deviations from the brief

1. **Mount path** `/api/v1/admin/extensions`, not `/api/v1/extensions` — §2.
2. **CLI split into `breezectl.ts` + `breezectl.lib.ts`** — the brief names only `breezectl.ts`. Follows the existing `recover-stuck-agents.ts` / `.lib.ts` pattern; a single file would execute `main()` on import and be untestable.
3. **Dockerfile untouched** — §8, per instructions.
4. **Comments are not preserved** — `js-yaml` cannot round-trip them and is the only YAML library present. Per the brief, normalized YAML is emitted after a diff; the CLI states the loss explicitly before writing (asserted by test).
5. **Extra commit** for the `listAll` integration test — §3.
6. **Stale-lock test fixed, not the implementation** — my first draft simulated staleness in the lockfile *body*; the implementation correctly judges mtime. Backdating the mtime is the faithful simulation.

---

## 13. Concerns

None blocking. Three worth recording:

1. **Registry mutation is replica-local.** ~~Nothing today reads that field on a path where it matters more than the DB check.~~ **THIS CLAIM WAS WRONG — see §14, Critical 1 and Important 2.** Two consumers DID trust the replica-local `enabled` flag with no DB re-check: `executeTool` (extension AI tools — extension code execution) and `ExtensionJobHost.sync` (repeatable schedule reconciliation). Both are fixed in §14. The corrected statement: `enable`/`disable` updates the in-process registry only on the replica that served the request, and every consumer whose decision gates extension code or durable queue state now re-reads `installed_extensions.enabled` per operation rather than trusting the snapshot. A future consumer that trusts the registry's `enabled` alone would reintroduce the same class of bug and would need cross-replica invalidation (pub/sub) instead.

2. **Schedule resync is racy under concurrent flips across replicas.** Two operators disabling different extensions on different replicas at the same instant each resync from their own registry view. `sync()` is idempotent and reconciles to the desired set, and the boot sync is the backstop, so this self-corrects — but a brief window can exist where one replica's resync re-adds a repeatable the other just removed. The processor's per-tick `isEnabled` check means no *disabled* work actually runs, so the impact is schedule churn, not incorrect execution.

3. **`breezectl` install/upgrade validates in non-production mode** (`production: false`), so a missing digest is a loud WARNING rather than a hard error. Intentional — an operator must be able to inspect and repair a config on a workstation, and the server re-validates under real production rules at boot. The warning states plainly that the config will be rejected at boot.

---

## 14. FIX pass — independent review (Changes-requested)

An independent review of 8c69e8c8a + e181697f1 returned 1 Critical, 1 Important,
and several Minor findings. All were applied except review Minors 5 and 6
(activate-throw-after-`setEnabled`; unmatched-method double-audit), which the
task explicitly accepted as risk and which are untouched.

### Critical 1 — `disable` did not stop extension AI tools on other replicas

**The bug.** `executeTool` resolved extension-contributed tools through
`extensionContributionRegistry.getAiTool()`, which filters only on the
**in-memory** `snapshot.enabled` flag. That flag is replica-local. Replicas A and
B both run extension `X`; `breezectl extensions disable X` lands on A; A flips
the database flag, withdraws `X` from its own registry, and re-syncs schedules.
B's registry keeps `X.enabled === true` **indefinitely** — no cross-replica
invalidation, no restart. The next AI chat request routed to B would advertise
`X`'s tools and run `X`'s handler. The emergency shutoff silently failed for the
extension-**code-execution** surface, the one that most warrants it.

**Approach chosen for the owner lookup.** `getAiTool` returns a `RegistryAiTool`
which carries no owner. Two options were on the table: widen that return type, or
add a lookup. Added `ExtensionContributionRegistry.findAiToolOwner(name): string
| undefined` — the smaller change: widening `getAiTool`'s return would have
touched all three of its call sites (`resolveExtensionTool`, `getToolTier`,
`loader.test.ts`) and every destructuring of `.validateInput` / `.tier`, whereas
the new method leaves every existing call site byte-identical. It iterates with
the SAME order and enabled-filter as `getAiTool`, so a tool resolved there is
guaranteed to be matched to that tool's owner.

**The gate.** `executeTool` gained an optional 5th parameter
`store: AiToolEnabledStore = defaultExtensionEnabledStore()` (a lazily-built
`createExtensionStateStore()`, so a core-only deployment never constructs it).
Immediately after resolution and **before** helper scoping, input validation, and
the handler:

```ts
if (!coreTool && extensionTool) {
  const owner = registry.findAiToolOwner(toolName);
  if (!owner || !(await store.isEnabled(owner))) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
}
```

- The refusal shape **matches the existing convention exactly**: the pre-existing
  unresolvable-tool path is `throw new Error(\`Unknown tool: ${toolName}\`)`, not
  a JSON error object. A disabled tool is therefore indistinguishable from a
  withdrawn one, which is already what the registry-withdraw tests assert.
- `executeTool` was **already `async`**, so no signature change rippled into any
  call site. No core AI call site changed.
- **Core tools are untouched**: the `!coreTool` guard means the core path makes
  no additional database read (asserted by test).
- `getToolDefinitions()` was **not** filtered. It is synchronous and called from
  the chat hot path; making it async to add a per-definition DB read would have
  rippled into every core AI call site — exactly the "STOP AND ASK" condition in
  the brief. Gating `executeTool` is the load-bearing part: a stale replica may
  still *advertise* a disabled extension's tool, but calling it is refused. This
  is the same posture the HTTP gateway already takes (routes stay mounted; the
  gate returns 503).
- The `extensionsAdmin.ts` header comment, which asserted "every replica honors a
  flip immediately" while listing only routes and jobs, was **corrected** to name
  all three re-check points (gateway per request, `jobHost.process` per tick,
  `executeTool` per invocation) plus `jobHost.sync`.

### Important 2 — a stale replica permanently re-added a disabled extension's repeatables

**The bug.** `ExtensionJobHost.sync()` derived its desired set from
`registry.listActive()` — the same replica-local flag — and
`resyncExtensionSchedules` passed a store stub `{ isEnabled: async () => true }`,
defeating the DB check entirely. Disable `X` on replica A (A removes `X`'s
repeatable from Redis); later enable an **unrelated** extension `Y` via replica
B; B's registry still shows `X` enabled, so B's `sync()` **re-adds** `X`'s
repeatable, which then ticks forever. `process()`'s per-tick DB check still
skipped the work, so nothing wrong ran — but the "disable removes future repeat
schedules without a restart" guarantee was durably broken and the queue
accumulated permanent churn. It did **not** self-correct: B never converged
without a restart.

**Fix.** `sync()` now intersects `listActive()` with a real
`await this.store.isEnabled(snapshot.name)` before contributing any of that
snapshot's jobs to the desired set. The `{ isEnabled: async () => true }` stub in
`resyncExtensionSchedules` was deleted; the function now takes a
`store: JobHostStore = createExtensionStateStore()` third parameter and builds
the host with the real store. The ownership filter (only `extension-`-prefixed
repeatables are ever removed) is intact and untouched, so foreign workers'
repeatables are still never disturbed. A disabled extension's existing
repeatable is *removed* on the next sync, because it is no longer in `desired`
and the ownership filter still matches it.

### Minor 3 — stale-lock break could hand the lock to two runs

`withLock` broke a >15-min-old lock with `unlinkSync` + `openSync(..,'wx')`. Two
runs judging the same lock stale could interleave: the second unlinks the first's
**fresh** lock and succeeds, so both ran a read-modify-write and one selection
edit was lost. The `finally` then unlinked by **path** unconditionally, possibly
destroying another live process's lock.

**Fix.** A `randomUUID()` nonce is written into the lockfile body on acquire.
`readLockNonce()` reads it back, and:
- **before** running the closure, a nonce mismatch means a concurrent break
  replaced our lockfile — we never held the lock, so we throw
  `lost a race for the lock ...` rather than proceeding into an interleaved
  read-modify-write;
- in the `finally`, the lockfile is unlinked **only** when its nonce is still
  ours; otherwise the run logs that it is not releasing a lock another run now
  holds. `closeSync(fd)` moved into its own `finally` so the descriptor is never
  leaked if the nonce write throws.

### Minor 4 — docstring sent operators down a dead end

`breezectl.ts` claimed `pnpm breezectl` works in the stock image. The runner stage
is a bare `node:24-alpine` with npm removed and pnpm installed only in
base/builder, so it does not. The in-container usage block now shows only
`node dist/scripts/breezectl.cjs ...` (which does work — `dist` is copied
wholesale and `WORKDIR` is `/app/apps/api`) and states explicitly that
`pnpm breezectl` is a local-dev-only entry point. The `package.json` script is
kept, as it is genuinely useful for local dev. §8's "no Dockerfile change needed"
conclusion was correct and stands.

### Minor 7 — `upgrade` could not clear `required`

`args.flags.required === true ? true : (current?.required ?? false)` carried the
old value forward with no way to demote — an operator had to hand-edit the YAML.
Added a `--not-required` boolean flag (registered in `BOOLEAN_FLAGS`) and a
`resolveRequired(args, current)` helper: `--required` promotes,
`--not-required` demotes, neither carries `current` forward, and passing both
throws `--required and --not-required are mutually exclusive`. Both flags are
documented in `USAGE` with an explicit note on the carry-forward default.

### Minor 8 — writability probe could leave a temp file

`assertWritable`'s directory probe wrote `.breezectl-probe-<pid>` and unlinked it
in the same `try`. The `unlinkSync` moved into a `finally` (itself
try/catch-wrapped), so the probe is removed even if the write path throws.

### Also fixed (typecheck gate)

`src/__tests__/integration/extensionState.integration.test.ts:126` had a
pre-existing `TS2532: Object is possibly 'undefined'` introduced by e181697f1
(`ours[1].updatedAt`). Changed to `ours[1]?.updatedAt` so the required typecheck
gate reaches 0 errors.

### Regression tests and pre-fix failure evidence

New tests:

| Test | File | Covers |
|---|---|---|
| `refuses to run an extension AI handler whose durable flag is false, even though the local registry snapshot still says enabled` | `src/extensions/extensionLifecycle.test.ts` | **Critical 1.** Sets up the exact stale-replica state (asserts `registry.get(...).enabled === true` and `getAiTool(...)` still resolves) with the store reporting `false`; asserts `executeTool` rejects with `/unknown tool/i` **and that the handler was NOT called**. |
| `runs the same handler once the durable flag reads enabled` | same | The gate does not break the happy path. |
| `never consults the enabled store for a core tool` | same | Core path takes no extra DB read — `isEnabled` is never called. |
| `does not schedule an extension whose durable enabled flag is false, even when the local registry still lists it active` | `src/extensions/jobHost.test.ts` | **Important 2.** `listActive()` returns the disabled extension; asserts its existing repeatable is **removed** and only the healthy extension's is added. |
| `stamps an owner nonce into the lockfile` | `scripts/breezectl.test.ts` | Minor 3 — nonce is present and the lock is still released normally. |
| `does not remove a lockfile that another run now owns` | same | Minor 3 — release is conditional on ownership. |
| `promotes with --required and demotes with --not-required` | same | Minor 7 — promote, carry-forward, demote. |
| `rejects --required together with --not-required` | same | Minor 7 — mutual exclusion. |

The pre-existing `extensionLifecycle.test.ts` `executeTool` call sites were
updated to pass an `enabledStore()` stub — required, since `executeTool` now
re-reads the flag and would otherwise construct a real database-backed store in a
unit test.

**Pre-fix run** (implementation files stashed, new tests present):

```
 FAIL  src/extensions/extensionLifecycle.test.ts > ... snapshot still says enabled
   TypeError: registry.findAiToolOwner is not a function

 FAIL  src/extensions/jobHost.test.ts > ... even when the local registry still lists it active
   AssertionError: expected [] to deeply equal [ 'stale-key' ]

 FAIL  scripts/breezectl.test.ts > required flag > rejects --required together with --not-required
   AssertionError: expected [Function] to throw error matching /mutually exclusive/i
     but got 'flag --not-required requires a value'

 Test Files  3 failed (3)
      Tests  6 failed | 40 passed (46)
```

All 6 new tests fail against the pre-fix code; the 40 pre-existing tests in those
files continue to pass, so the new tests fail for the intended reason rather than
because the harness is broken.

**Post-fix run:**

```
$ pnpm -F @breeze/api test:run src/extensions src/routes/extensionsAdmin.test.ts \
    scripts/breezectl.test.ts src/services/aiTools

 Test Files  100 passed (100)
      Tests  1282 passed (1282)
   Duration  21.67s
```

### Verification

| Gate | Result |
|---|---|
| `pnpm -F @breeze/api test:run src/extensions src/routes/extensionsAdmin.test.ts scripts/breezectl.test.ts src/services/aiTools` | **100 files / 1282 tests passed** |
| `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project tsconfig.json` (apps/api) | **exit 0, 0 errors** |
| `pnpm exec eslint <changed apps/api files>` | **0 errors** (the three `scripts/breezectl*.ts` files report `File ignored because no matching configuration was supplied` — `scripts/` is outside this package's eslint config, pre-existing) |
| `pnpm -F @breeze/api build` | **Build success**, `dist/scripts/breezectl.cjs` 37.80 KB (still database-free — the no-DB-import property test passes) |

---

# FINAL-REVIEW FIX (whole-branch review, post-81819167e)

The final whole-branch review returned NOT-READY with 1 Critical + 2 Important —
all three are CROSS-TASK SEAM bugs, invisible to the six per-task reviews because
each sits in the gap between two components that were reviewed separately. All
three are fixed below, each with a regression test verified to FAIL against the
pre-fix code.

## Critical 1 — RLS scope escalation silently no-ops inside a request context

`withDbAccessContext` (db/index.ts:245) SHORT-CIRCUITS when a DB context is
already open: `if (dbContextStorage.getStore()) return fn();`. Since
`withSystemDbAccessContext` is just `withDbAccessContext(SYSTEM_DB_ACCESS_CONTEXT, fn)`,
a bare call to it from inside an ambient TENANT context does **not** set
`breeze.scope='system'` — it inherits the caller's scope. `installed_extensions`
is FORCE-RLS with a `system_only` policy, so every read is filtered to ZERO ROWS
and every write matches ZERO ROWS, **both without erroring**.

`DrizzleExtensionStateBackend` used the bare form in all eight operations. Real
consequences on the request path:

1. **Extension AI tools permanently unreachable.** `aiAgentSdkTools.ts:337` runs
   `withDbAccessContext({scope:'organization'|'partner'}, () => executeTool(...))`,
   so the gate at `services/aiTools.ts:405-410` always saw `isEnabled === false`
   → `Unknown tool`. Same via `scriptBuilderTools.ts:92-99`.
2. **Every extension AGENT route 503s forever.** `agentAuth.ts:455-470` wraps
   `next()` in an organization-scoped context, and the agent wrapper gate
   (`gateway.ts:172-177`) runs inside it.
3. **Platform-admin enable/disable silently no-ops.** `authMiddleware` opens a
   context for the JWT's `scope` (auth.ts:577); `isPlatformAdmin` is orthogonal
   to `scope`, so a partner/org-scoped admin JWT got `listAll() === []` and a
   `setEnabled` that updated 0 rows while returning 200.

**Fix** — `apps/api/src/extensions/stateStore.ts`. Added a private helper and
routed ALL EIGHT operations through it (`upsertObserved`, `setEnabled`, `getRow`,
`listRows`, `recordFailure`, `recordActive`, `insertSchemaFloor`,
`listSchemaFloors`):

```ts
private asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}
```

`runOutsideDbContext` exits BOTH the tx-routing store and the metadata store, so
the nested `withSystemDbAccessContext` opens a genuinely fresh transaction that
really does set the GUC. This is the repo's canonical escalation idiom, used at
~20 sites (`oauth/adapter.ts:26`, `routes/lifecycle.ts:76`,
`jobs/contractWorker.ts:85`); `services/scriptBuilderTools.ts:86-90` documents
the exact hazard in a comment. The extension store never adopted it.

`withDbAccessContext` itself was NOT touched — the short-circuit is intentional
core behavior relied on elsewhere.

Non-agent gateway, boot reconciler, and BullMQ jobHost were already fine (no
ambient context open). That asymmetry is why 1282 tests passed: every unit test
injects a fake `isEnabled` or an in-memory backend, and the existing integration
test opens `withSystemDbAccessContext` itself at top level. No test called the
real store from inside an ambient tenant context — until now.

## Important 2 — sync() deleted live schedules for extensions this replica doesn't know

`apps/api/src/extensions/jobHost.ts`. The desired set is
`listActive()` ∩ `isEnabled`, but REMOVAL applied to EVERY `extension-*`
repeatable in Redis — including extensions this replica never activated.

Scenario: replica A activates optional extension `x` and schedules
`extension-x-sweep`. On replica B, `x` failed at `acquire` (transient HTTPS 503);
optional, so B booted fine WITHOUT `x` in its registry. An operator later enables
unrelated extension `y` on B → `resyncExtensionSchedules()` → B's desired set has
no `x` → B DELETES `x`'s repeatable. `x` is `enabled=true` in the DB and live on
A, but its cron never fires again ANYWHERE until A restarts. Nothing converges it.

This is the OPPOSITE direction from 81819167e (which correctly closed
resurrection of a disabled extension). Both now hold simultaneously.

**Fix** — removal is now scoped to repeatables this replica can account for:

```ts
const owner = resolveRepeatableExtensionName(
  entry.id, (name) => this.registry.get(name) !== undefined);
if (owner === null) continue;   // not ours to reason about — preserve
```

Present-but-DISABLED still gets removed (it IS in the registry, so the check
passes and the `enabled` intersection drops it). Only ABSENT-from-registry is
preserved. A lingering repeatable for an unknown extension is inert — `process()`
returns early when it cannot resolve the definition — which is strictly safer
than deleting a live one.

### jobId → extension-name parsing approach

`extension-<name>-<job>` has **no positional answer**: both the extension name
and the job name may contain hyphens (`extension-acme-billing-nightly-sweep`).
Two rejected approaches and why:

- *Naive split on `-`* — reads the owner of the above as `acme`, misses it in the
  registry, and would wrongly PRESERVE a genuinely stale schedule forever.
- *Subtract the job name from the end* (`id.endsWith('-' + entry.name)`) — looks
  exact, but **breaks on a renamed job**: a repeatable keeps its original jobId
  when its BullMQ job name changes, so the id no longer ends with the current
  name. This was implemented first and immediately failed the pre-existing test
  `replaces a renamed repeatable that kept the same jobId` (id
  `extension-demo-sweep`, name `sweep-old`) — caught before commit.

The shipped approach matches against **names the replica actually knows**:
`resolveRepeatableExtensionName(id, isKnown)` walks each hyphen boundary after
the `extension-` prefix, shortest-first, and returns the first candidate
`isKnown` accepts; the final segment is never a candidate alone because the job
part is non-empty. `extension-acme-billing-nightly-sweep` tries `acme`,
`acme-billing` → hit. `extension-x-sweep` tries `x` → miss → null → preserved.
Renames are unaffected because the job name is never consulted.

## Important 3 — verified bytes re-read from disk without re-verification

`verifyExtensionBundle` hashes every member through one `readBoundedZipDirectory`
handle and then CLOSES it (bundleVerifier.ts:343). BOTH consumers re-opened the
same path and TRUSTED the fresh read:

- `reconciler.ts` `extractVerifiedPayload` wrote each member to the extracted
  root without comparing against `bundle.files.get(member).sha256` — and that
  tree is `import()`ed at reconciler.ts:279.
- `migrator.ts` `readBundleMigrations` took the member LIST and the SQL bytes
  from `archive.files.keys()`, not from the verified `bundle.files`.

Anyone able to write the artifact-store root (`/data/extensions/artifacts`, a
mounted volume — a compromised sibling container, any non-root process with write
access) can swap the archive between verify and extract: **arbitrary code
execution and arbitrary DDL with a full signature bypass.**

**Fix** — one shared guard in `bundleVerifier.ts`, matching the existing digest
form (bare lowercase hex from `sha256Hex`, as stored in `bundle.files`):

```ts
export function assertVerifiedMemberBytes(member, bytes, expectedSha256): void {
  if (sha256Hex(bytes) !== expectedSha256) throw new Error(
    `archive member "${member}" changed on disk after verification — integrity re-check failed`);
}
```

- `extractVerifiedPayload` now iterates `bundle.files` ENTRIES and re-hashes each
  read before writing it. A mismatch throws; the existing `catch` removes the
  temp tree, so nothing is committed and no `.verified` marker is ever written.
- `readBundleMigrations` now derives its member list from `bundle.files` (its
  parameter type widened from `Pick<…,'archivePath'|'manifest'>` to include
  `'files'`) and re-hashes each read before using the SQL. This closes BOTH
  tampering directions: altered bytes throw, and an ADDED post-verify `.sql`
  member is never seen at all.

## Also (cheap, same round)

- `services/aiTools.ts` — the comment claiming the store is "built on first
  extension-tool call" was inaccurate: `store: AiToolEnabledStore = defaultExtensionEnabledStore()`
  is a DEFAULT PARAMETER, evaluated on EVERY `executeTool` call including core-tool
  calls. Comment corrected to state that plainly, and to note why it is harmless
  (construction is a bare `new` with no I/O, memoized; no DB work happens until
  `isEnabled` runs, which only the extension branch reaches). Behavior unchanged.
- `extensions/config.ts` — one-line comment at the NODE_ENV canonicalization
  noting that `validateConfig()` (validate.ts:546 `z.enum`, called at
  index.ts:1579 BEFORE `reconcileExtensions` at :1596) is the load-bearing gate
  rejecting an unknown NODE_ENV before this trust decision. Comment only.

## Regression tests + pre-fix failure evidence

Source fixes were stashed (`git stash push -- <the 5 source files>`), leaving the
new tests against pre-fix code. Recorded output:

```
FAIL src/extensions/jobHost.test.ts > ExtensionJobHost.sync > preserves a repeatable for an extension absent from this replica registry, while still removing a present-but-disabled one
FAIL src/extensions/migrator.test.ts > readBundleMigrations … > rejects a migration whose on-disk bytes no longer match the verified hash
FAIL src/extensions/migrator.test.ts > readBundleMigrations … > ignores an unverified migration member that only exists on disk
FAIL src/extensions/reconciler.test.ts > extractVerifiedPayload … > throws and commits nothing when a member no longer matches its verified hash
  Test Files  3 failed (3)
       Tests  4 failed | 26 passed (30)
```

```
FAIL src/__tests__/integration/extensionState.integration.test.ts > ExtensionStateStore … > reads and writes correctly when called from INSIDE an ambient tenant DB context
AssertionError: expected false to be true
 ❯ src/__tests__/integration/extensionState.integration.test.ts:174:18
    174|     expect(seen).toBe(true);
  Test Files  1 failed (1)
       Tests  1 failed | 3 passed (4)
```

`expected false to be true` is the Critical reproduced exactly: `isEnabled`
returning the RLS-filtered `row?.enabled ?? false` instead of the true value.

| Fix | Covering test | File |
|---|---|---|
| Critical 1 | `reads and writes correctly when called from INSIDE an ambient tenant DB context` | `src/__tests__/integration/extensionState.integration.test.ts` |
| Important 2 | `preserves a repeatable for an extension absent from this replica registry, while still removing a present-but-disabled one` | `src/extensions/jobHost.test.ts` |
| Important 2 (parsing) | `recovers hyphenated extension names so their stale schedules are still removed` | `src/extensions/jobHost.test.ts` |
| Important 3 (extract) | `throws and commits nothing when a member no longer matches its verified hash` + `extracts every verified member when the bytes still match` | `src/extensions/reconciler.test.ts` |
| Important 3 (migrate) | `rejects a migration whose on-disk bytes no longer match the verified hash` + `ignores an unverified migration member that only exists on disk` | `src/extensions/migrator.test.ts` |

The single integration test pins all THREE Critical failure surfaces at once: the
read path (agent routes + AI-tool gate) via `isEnabled`, the write path
(platform-admin enable/disable) via `setEnabled` asserted through a separate
connection, and the admin list path via `listAll`.

## Verification (post-fix)

| Command | Result |
|---|---|
| `pnpm -F @breeze/api test:run src/extensions src/routes/extensionsAdmin.test.ts src/services/aiTools.test.ts scripts/breezectl.test.ts` | **18 files / 230 tests passed** |
| `pnpm test:integration --run src/__tests__/integration/extensionState.integration.test.ts src/__tests__/integration/extensionMigrator.integration.test.ts` (Docker :5433) | **2 files / 6 tests passed** |
| `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project tsconfig.json` (apps/api) | **exit 0, 0 errors** |
| `pnpm exec eslint <11 changed apps/api files>` | **exit 0, 0 errors** |
| `pnpm -F @breeze/api build` | **Build success in 262ms** (`dist/index.cjs` 13.34 MB, `dist/scripts/breezectl.cjs` 37.80 KB) |

The shared `breeze-postgres-test` container was reused via the idempotent
`test:docker:up` path; `test:docker:down -v` was never run.

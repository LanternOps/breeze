# #1105 — Design proposal: stop transactions being held across slow non-DB work

**Status:** proposal (for review)
**Issue:** #1105 — *Mass agent reconnect can poison the Postgres pool (idle-in-transaction timeouts on `config_policy_assignments`) → heartbeat 500s + login outage*
**Author:** Claude (Opus 4.8) for @ToddHebebrand
**Date:** 2026-06-16
**Already shipped (do not re-propose):** #1116 (heartbeat releases its RLS txn before the trust-keyset fetch), #1313 (patch scheduler enqueues outside the system txn), #1441 (Phase-1 tripwire *scaffolding*: held-context duration warn + the `assertOutsideHeldDbContext` helper + the `runOutsideDbContext` escape hatch — all warn-only, **not yet wired** into the slow-work primitives and not yet throwing in CI). Phase 1 below is now "wire #1441's helper in + flip CI to throw," not "build the tripwire."

---

## 1. Problem

The API connects to Postgres as the unprivileged, forced-RLS role `breeze_app`. To make per-request RLS policies work, `withDbAccessContext` (`apps/api/src/db/index.ts:138`) sets six `breeze.*` GUCs and runs the caller's whole callback **inside a single transaction**:

```ts
return baseDb.transaction(async (tx) => {
  await tx.execute(sql`select set_config('breeze.scope', ${context.scope}, true)`);
  // …5 more SET LOCAL GUCs…
  return dbContextStorage.run(tx, fn);   // <-- the ENTIRE callback runs in here
});
```

`SET LOCAL` (the `true` third arg) ties each GUC to the transaction, so a transaction is *required* to scope them. The cost: **the pooled connection is held for the full duration of `fn`**. When `fn` does slow non-DB work — a Redis/BullMQ enqueue, an HTTP fetch, a per-device loop — the connection sits `idle in transaction` across that work.

### The cascade (observed in production, US droplet)

1. A mass agent reconnect (control-plane restart, agent-service restart storm) fires dozens of concurrent heartbeats.
2. `agentAuthMiddleware` wrapped each heartbeat in `withDbAccessContext(...) → await next()`, so each heartbeat held one pooled connection in an open transaction while it read `config_policy_assignments` **and** did slow work (Redis enqueue, event publish).
3. Those connections sat `idle in transaction` for 20–30 s → `idle_in_transaction_session_timeout` killed them.
4. The next caller to grab a killed connection saw `write CONNECTION_CLOSED postgres:5432`. This is **connection poisoning, not exhaustion** — total connections were ~36/100, but the killed-while-in-transaction connections cascaded.
5. Web login (which needs a transaction) failed throughout. `docker compose restart api` cleared it instantly.

This is a **txn-around-slow-work** foot-gun: any code path that runs slow non-DB work inside a held `withDbAccessContext` transaction can reproduce it, and a mass reconnect is the trigger that turns it into an outage.

> **Cross-reference:** the US droplet's managed Postgres sits at `max_connections=25` at steady state (see `ops_us_db_conn_ceiling`), so it has *no headroom* to absorb a burst of long-held connections — the same workload survives on EU's larger ceiling. Any fix should be validated against the US ceiling, not EU.

---

## 2. What is already shipped (and why the issue is still open)

Three PRs have landed — two **targeted** fixes (#1116/#1313) that are the template for the pattern, plus #1441's **detection scaffolding** — but none removes the foot-gun class:

| PR | What it did | Pattern established |
|----|-------------|---------------------|
| **#1116** | Heartbeat now opts out of the request-long wrap and self-manages a **short-lived** `withDbAccessContext` that is **released before** `getActiveTrustKeyset()` (which needs its own second connection). | *DB work in a short bracket; second-connection / slow work strictly after the bracket closes.* |
| **#1313** | `patchSchedulerWorker.scanAndCreateJobs` collects job IDs inside the system context and does the BullMQ enqueue **after** the context returns. | *Collect inside; enqueue (Redis/remote) outside.* |
| **#1441** | Shipped the Phase-1 tripwire **scaffolding** in `db/index.ts`: a held-context duration warn in `withDbAccessContext`'s `finally` (`getHeldContextWarnMs`, ~`:158`), the `assertOutsideHeldDbContext(operation)` guard (`:304`, warn-only; throws only when `DB_CONTEXT_TRIPWIRE_STRICT` is set), and the `runOutsideDbContext` escape hatch (`:212`). | *Detection scaffolding — but `assertOutsideHeldDbContext` has **no callers yet** and CI doesn't throw, so it surfaces nothing until Phase 1 wires it into the slow-work primitives.* |

The agent middleware encodes the heartbeat carve-out explicitly (`apps/api/src/middleware/agentAuth.ts`):

```ts
// #1105 — high-frequency routes that self-manage their DB context …
const SELF_MANAGED_DB_CONTEXT_ACTIONS = new Set(['heartbeat']);
// …
if (SELF_MANAGED_DB_CONTEXT_ACTIONS.has(action)) { await next(); return; }
await withDbAccessContext({ scope:'organization', orgId: device.orgId, … }, async () => { await next(); });
```

**The remaining architectural gap:**

- The carve-out is a **per-route allowlist of one** (`heartbeat`). Every *other* agent route still runs its entire handler inside one transaction. Any future agent route (or any addition to an existing one) that does Redis/HTTP/loop work inside the handler silently reintroduces #1105.
- The same default applies to the **web/user middleware**: the convenient request-long wrap is the default everywhere, so the foot-gun isn't agent-specific.
- Avoiding it depends entirely on **developer discipline** — there is no mechanism that *detects* "slow work inside a held context." #1116 and #1313 were each found by hand after an incident.

So the issue stays open not because a specific worker is unfixed, but because the **default is unsafe and the foot-gun is undetectable**.

---

## 3. Constraints any fix must respect

1. **GUC isolation is a tenant-isolation boundary.** GUCs must never leak from one request to the next on a reused pooled connection — that would be a cross-tenant data bug. The current `SET LOCAL` + transaction-commit auto-reset is *correct and safe*; any redesign must preserve an equally airtight reset.
2. **Implicit cross-statement atomicity is widely relied on.** ~15–25 handlers do multiple writes with **no explicit `db.transaction(...)`** and depend on the wrapping transaction for atomicity. Examples (each two deletes that must both apply or neither):
   - `routes/software.ts:564-565` (versions + catalog), `routes/groups.ts:618-621`, `routes/sso.ts:595-596`, `routes/analytics.ts:674-675`, `routes/deployments.ts:457-460`, `routes/psa.ts:519-520`.
   - A naive "one short transaction per statement" model would silently break these (a crash between the two deletes leaves an orphan).
3. **Hot paths can't afford per-statement overhead.** Heartbeat issues many statements; opening a transaction + 6×`set_config` per statement is a large round-trip tax. Whatever the model, the GUC setup cost must be amortized across a handler's statements, not paid per statement.
4. **Driver:** postgres-js (`postgres` npm), pool `max` from `DB_POOL_MAX`. Reserved connections are available via `sql.reserve()` but not currently used.
5. **Forced RLS means failures are silent.** A write with no/!wrong context matches 0 rows under `breeze_app` with no error (the #1375 trap). The existing `proxiedDb` contextless-write guard (`reportContextlessWrite`, `db/index.ts:245`) warns on this; any redesign must keep that tripwire working.

---

## 4. Options considered

### Option A — Keep the model; add a *tripwire* for slow work inside a held context
Instrument the context so that **acquiring a second pooled connection** or performing a **known-slow op (Redis/BullMQ/HTTP)** while a `withDbAccessContext` transaction is held emits a warning + Sentry, and **throws in test/CI**.

- ➕ Cheap, no behavior change, ships in days. Surfaces *every* existing and future instance (what #1116/#1313 needed a production incident to find).
- ➕ Composes with every other option — it's the detection layer.
- ➖ Doesn't by itself remove the foot-gun; it makes it loud.

### Option B — Context = values; one short transaction per *atomic unit*
Store context **values** in the ALS (not a live `tx`). Open a transaction only around an explicit unit of work; between units no connection is held.

- ➕ Removes the foot-gun at the root — slow work between units holds nothing.
- ➖ Breaks implicit cross-statement atomicity (constraint 2) unless every multi-write handler adopts an explicit bracket — a 15–25 site migration.
- ➖ If taken to per-*statement* transactions, pays the GUC tax per statement (constraint 3). Only viable at per-*handler* granularity — which is Option D.

### Option C — Reserved connection + session GUCs + guaranteed RESET
`sql.reserve()` one connection per request, `SET` (session, not LOCAL) the GUCs, run the handler, `RESET ALL`/`DISCARD` in a `finally`. No open transaction → `idle_in_transaction_session_timeout` never fires.

- ➕ Slow work no longer poisons: the failure mode degrades from *poisoning* (killed-in-txn cascade) to *pool-busy* (requests queue for a free connection), which **self-heals** instead of cascading.
- ➕ Preserves atomicity (handlers can still open explicit transactions on the reserved connection).
- ➖ Still pins a connection for the whole request — under a mass reconnect with US's 25-connection ceiling, that's pool-busy/timeout, better than an outage but not free.
- ➖ Isolation now depends on the `finally` reset firing (vs. Postgres auto-reset on commit). A missed reset = cross-tenant leak. Higher-stakes correctness surface.

### Option D — Generalize the #1116 self-managed pattern (recommended core)
Make handlers **bracket their DB work** in a short `withDbAccessContext` and keep slow work outside it — exactly what heartbeat does today — and **stop the middleware from wrapping the whole request** for the high-risk surface (agent routes first).

- ➕ Proven (heartbeat, patch scheduler already do this). Preserves atomicity *within* a bracket and GUC isolation (unchanged mechanism).
- ➕ Incremental and route-by-route; no big-bang rewrite; no per-statement GUC tax.
- ➖ Requires touching handlers and judgment about where the bracket ends. Without Option A's tripwire, the same discipline problem persists.

---

## 5. Recommendation — phased: **A (tripwire) + D (generalize), C as the contingency**

Keep the GUC mechanism (`SET LOCAL` in a transaction) — it is correct and isolation-safe. The bug is *how long the transaction is held*, not how GUCs are set. Fix the **default** and make violations **loud**.

### Phase 1 — Wire in the tripwire (highest leverage, low risk)
The single most valuable step, because it converts an invisible foot-gun into a CI failure. **#1441 already built the machinery** (the held-context marker, the duration warn, the `assertOutsideHeldDbContext` guard, and the `runOutsideDbContext` escape hatch — see §2); what's left is to actually *use* it, since the guard has no callers and never throws by default today.

- Call `assertOutsideHeldDbContext(<op>)` from the two slow-work primitives:
  - the BullMQ/Redis enqueue helpers (`enqueue*`, the queue `add` wrappers),
  - the outbound HTTP/`fetch` helper(s) and `getActiveTrustKeyset`-style second-connection acquirers.
- Make CI fail on a hit: either default `DB_CONTEXT_TRIPWIRE_STRICT` on under `NODE_ENV=test`, or have the guard throw in test directly. Prod stays warn-only (`console.warn` + `captureMessage`, like the existing `proxiedDb` guard). The `runOutsideDbContext(...)` escape hatch already silences intentional cases.
- The *duration* warn (`getHeldContextWarnMs`) already exists from #1441 and catches slow loops that aren't a single tagged primitive — confirm a sensible default `DB_CONTEXT_TRIPWIRE_WARN_MS` is set where it matters.

**Deliverable:** every current txn-around-slow-work site lights up in one CI run. Triage that list; each becomes a Phase-2 bracket.

### Phase 2 — Generalize self-managed contexts on the agent path
Agent routes are the mass-reconnect blast radius, so do them first.

- Flip `agentAuthMiddleware`: instead of an allowlist of self-managed actions (`heartbeat`), make **self-management the default** for agent routes — the middleware resolves the device/org and stashes the *context values* on `c`, but does **not** open the request-long transaction. Provide a one-line helper (`withAgentDbContext(c, fn)`) handlers call around their DB work.
- Migrate each agent route flagged by Phase 1 to bracket its DB work and move Redis/HTTP/loops after the bracket (the #1116/#1313 shape). Add a per-route call-order regression test mirroring `heartbeat.test.ts:280` ("DB context released before the slow op").
- Heartbeat's remaining in-bracket slow work (`maybeQueueThresholdFilesystemAnalysis` at `heartbeat.ts:437`, the `publishEvent` calls) is a concrete first target: collect intent inside the bracket, fire after it closes — the #1313 shape.

### Phase 3 — Decide the web-route default (contingency on Phase 1 data)
If Phase 1 shows the foot-gun is rare on web routes, leave the convenient request-long wrap as the web default (atomicity for free) and rely on the tripwire. If it shows the pattern is pervasive, adopt **Option C (reserved connection + session GUC + `finally` reset)** for the web middleware: it makes *any* slow work non-poisoning by construction, at the cost of a higher-stakes reset path that must be covered by Phase-4 isolation tests. Treat C as the safety net, not the default ambition.

### Phase 4 — Tests / guardrails (ship with Phases 1–2)
- **Real-DB GUC-isolation test** (new, in `__tests__/integration/`): run request A under org scope, return its connection to the pool, run request B under a *different* scope, and assert via `current_setting('breeze.scope', true)` that no GUC from A leaked into B. We currently have RLS-policy coverage but **no pooled-reuse leakage test** — this is the guardrail that lets us change context handling safely.
- **Tripwire unit tests:** enqueue/HTTP inside a held context throws in test; inside `runOutsideDbContext` it does not.
- **Per-route call-order tests** for each migrated agent route (pattern: `heartbeat.test.ts:280`).
- Run the migrated agent path under a simulated reconnect storm against a **25-connection** ceiling (US parity) and confirm no `idle in transaction` accumulation.

---

## 6. Risks & non-goals

- **Risk: GUC leak if we ever move off `SET LOCAL`.** Phase 1/2 keep `SET LOCAL`, so isolation is unchanged. Only Phase 3-Option-C introduces a reset-on-release path; it must not ship without the Phase-4 leakage test green.
- **Risk: breaking implicit atomicity during Phase 2.** Each migrated handler must keep its multi-write set inside a single bracket; the tripwire does not catch a lost atomicity guarantee, so Phase-2 migrations need a human read of each handler's write set (constraint 2).
- **Risk: tripwire false positives.** Some contextless second-connection acquisitions are intentional (`device_commands` agent-WS path, the audit-admin pool). Mirror the existing `proxiedDb` allowlist approach; warn-only in prod until the CI list is clean.
- **Non-goal:** raising `max_connections` or pool size. That widens the window, it doesn't remove the cascade — and US is already at its managed ceiling.
- **Non-goal:** rewriting `withDbAccessContext`'s GUC mechanism. It is correct; the work is about lifetime and detection.

---

## 7. Suggested sequencing

1. **PR 1 (Phase 1):** wire #1441's `assertOutsideHeldDbContext` into the enqueue/HTTP primitives + flip CI to throw (default-strict under `NODE_ENV=test`) + unit tests. The guard, duration warn, and escape hatch already shipped in #1441 — this is the wiring that makes them bite. Warn-only in prod, throw in CI. *Ships the detection; merges fast.*
2. **PR 2 (Phase 4a):** real-DB GUC-isolation integration test. *Unblocks safe changes.*
3. **PR 3 (Phase 2):** agent middleware default flip + migrate the Phase-1-flagged agent routes (start with heartbeat's residual enqueues) + per-route call-order tests.
4. **PR 4 (Phase 3, conditional):** web-route decision; Option C only if the data warrants it.

Phases 1–2 close the practical outage risk (the agent reconnect path) and make regressions impossible to merge silently. Phase 3 is a deliberate, data-driven follow-up rather than a speculative rewrite.

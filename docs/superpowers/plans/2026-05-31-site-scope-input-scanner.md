# Plan: extend the site-scope contract scanner to catch input-sourced / list-style device reads

**Status:** IMPLEMENTED (detector + baseline ratchet) — triage/burn-down ongoing.
**Date:** 2026-05-31
**Related:** PR #864/#868 (original SP2 site-scope sweep + `:deviceId` scanner); PR #1036 (fixed the first 6 input-sourced handlers); branch `chore/site-scope-input-scanner` (this scanner).

## What shipped vs. what's deferred

**Shipped (this PR):**
- `analyzeRouteSource` (pure, unit-tested) + `findDeviceScopedTables` (schema-derived) + the
  `touchesDeviceData` detector + `findRoutesTouchingDeviceData` in `routeScan.ts`.
- A second contract test in `site-scope-coverage.integration.test.ts` wired into CI (the
  `test-api` job — it's static analysis, no DB, so it gates PRs there rather than in the
  non-blocking smoke-test where `rls-coverage` lives). **Note:** neither site-scope contract test
  ran in CI before this PR — the `test:site-scope-coverage` script existed but was never invoked.
- **Baseline ratchet:** the detector found **93** pre-existing handlers. Rather than block on
  triaging all 93 at once, they're enumerated in `SITE_SCOPE_INPUT_BASELINE` (frozen, shrink-only,
  explicitly labeled *not vetted safe*). The test fails on any NEW offender, so the blind spot is
  closed for all new/edited code immediately. A "no stale entries" test makes the ratchet
  one-directional — fixing a handler forces removal of its baseline entry.

**Deferred (burn-down backlog — the 93):** triage each baseline entry into either a real
site-scope fix (narrow by accessible devices) or a vetted `SITE_SCOPE_INPUT_EXEMPT` entry
(agent/system token path, or org-wide aggregate). Calibration during this PR showed the 93 is a
genuine mix: e.g. `routes/agents/*` are agent-token paths (likely exempt), while `softwareInventory`,
`remote/sessions`, and `metrics` have **zero** site-scope references anywhere (likely real gaps).
Detector caveat: it's coarse — a flagged handler in a file that gates *other* handlers may be a
false positive (gate via a helper/path the slice misses) or a real per-handler miss; triage
confirms which.

## Problem

`apps/api/src/__tests__/helpers/routeScan.ts` + `site-scope-coverage.integration.test.ts`
only flag handlers whose **URL pattern** names a device (`:deviceId` / `:deviceIds` /
`:device_id`) or sits under `/sites/:param`. It deliberately does **not** scan body-level
device references — see routeScan.ts:180-186 ("too numerous to lock in").

That gap is exactly where this branch found 6 live cross-site leaks, all of which the
scanner passed clean:

| Handler | How the deviceId entered |
|---|---|
| `browserSecurity GET /extensions`, `/violations` | query param + list-style (org-only) |
| `sentinelOne GET /threats` | query param |
| `peripheralControl GET /activity` | query param |
| `huntress GET /incidents` | query param |
| `dnsSecurity GET /events`, `/stats` | query param |
| `analytics GET /capacity`, `POST /query` | query param + **request body array** |

We need a second detector for the input-sourced / list-style class.

## Approach (chosen): static, input-sourced "smell"

Add a detector alongside the existing `:deviceId`-URL one. A route handler is flagged when
its body **touches device-scoped data** and references **no site-scope gate** — and is not
allowlisted.

### "Touches device-scoped data" signals (within the handler slice)

Reuse the existing per-route slicing (bounded by the next route def + `HANDLER_SLICE_BYTES`).
Flag if the slice matches any of:

1. A Drizzle condition on a device/site column of a **known device-scoped table**:
   `eq(<tbl>.deviceId, …)`, `inArray(<tbl>.deviceId, …)`, `eq(<tbl>.siteId, …)`,
   `inArray(<tbl>.siteId, …)`.
2. A join to devices: `innerJoin(\s*devices\b` / `leftJoin(\s*devices\b`.

To keep precision, signal (1) is restricted to columns of tables in a generated
`DEVICE_SCOPED_TABLES` set (see below) rather than any `*.deviceId` property access — this
avoids false hits on plain-JS `someRow.deviceId` reads that aren't queries.

### "Has a site-scope gate" tokens

Extend `CANONICAL_GATE_NAMES` with the tokens this codebase now uses:

```
requireSiteAccess, canAccessDeviceSite, getDeviceWithOrgAndSiteCheck, canAccessSite,   // existing
resolveSiteAllowedDeviceIds, hasDeniedDeviceSite, hasDeniedThreatDeviceSite, allowedSiteIds   // add
```

`allowedSiteIds` as a bare token is a safe catch-all: every correct gate path references it
(directly or via a helper), and the local-helper-wrapper resolution (`findLocalGateWrappers`)
already propagates gates reached through file-local helpers.

### Generated device-scoped table list

`DEVICE_SCOPED_TABLES` = every Drizzle table in `apps/api/src/db/schema/` declaring a
`device_id`/`deviceId` or `site_id`/`siteId` column. Generate at test-time by scanning the
schema source (regex for `pgTable('…', { … device_id / site_id … })`) so it can't drift as
tables are added. Emit the resolved set in the failure message for debuggability.

## Implementation steps (TDD)

1. **`routeScan.ts`** — add `findDeviceScopedTables()` (schema scan) and a second pass in
   `findRoutesTouchingDevices()` that sets a new `RouteInfo.touchesDeviceData` flag using the
   signals above. Keep the existing `usesSiteScopeGate` computation; widen the gate token list.
   Unit-test the helper against fixtures (a gated handler, an ungated query-param handler, an
   agent/system handler, an org-wide aggregate) — RED first.
2. **`site-scope-coverage.integration.test.ts`** — add a second `it(...)` that fails on
   `touchesDeviceData && !usesSiteScopeGate && !allowlisted`. New allowlist
   `SITE_SCOPE_INPUT_EXEMPT: ReadonlySet<string>` with the **same discipline** as today's set:
   every entry carries a one-line justification; default action on a new offender is to fix the
   handler, not allowlist it. Add the companion "no stale entries" guard test.
3. **Triage pass (the real work).** Run the new detector once; it will flag a large initial
   set (every device-data read/write, including legit ones). Triage each into:
   - **real gap** → fix the handler (TDD, same pattern as this branch), OR
   - **exempt** → allowlist with reason. Legit exempt classes already identified:
     - agent/system paths (agent-token auth, no user `permissions` context) — e.g. agent
       ingest/heartbeat routes;
     - org-wide aggregates that take no device/site input by design (e.g.
       `dnsSecurity /top-blocked`, analytics `/executive-summary`, `/os-distribution`, `/sla`);
     - routes already gated through a pattern the token list somehow misses (prefer fixing the
       token list over allowlisting).
   This triage is likely to surface additional real gaps — treat finds as new fixes.
4. Run full affected suite + `tsc --noEmit`. Document the initial allowlist size in the PR.

## Risks / tradeoffs

- **False positives → allowlist churn.** Mitigated by the schema-scoped table list + the
  established justified-allowlist mechanism. The `allowedSiteIds` catch-all token keeps gated
  handlers green.
- **Static, not reachability-aware.** It can't tell whether a site-restricted user can actually
  reach an agent/system handler. That's fine: those go in the allowlist with a reason. The
  detector's job is "device data touched without a visible gate," not proof of exploitability.
- **Won't catch non-route surfaces.** The AI-tools layer (`services/aiTools*.ts`) is the same
  bug class but lives outside `routes/`; it is handled by a separate plan
  (`2026-05-31-ai-tools-site-scope.md`), not this scanner.

## Out of scope

- Runtime/integration seeded-user contract test (considered, rejected as heavier-maintenance for
  now; can layer on later if the static scanner proves insufficient).
- The AI-tools layer (separate plan/PR).

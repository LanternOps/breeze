# Feature velocity: what slowed the partner-sending-domains build, and what would fix it

**Date:** 2026-09-18 · **Case study:** feature #6180 (spec → 6 waves, 4 landed at time of writing) · **Audience:** engineering

## Summary

The code was not the slow part. Each wave was implemented in 1–2 hours of agent
time and executed its plan almost verbatim (zero aborted tasks across four
waves). Roughly ten hours of wall-clock went to the feature, and most of it was
spent **waiting** (CI, merge queue, local test suites) and **re-discovering
facts the repository already knows** (registration lists, DB-context traps,
BullMQ job-id semantics). Those are structural, and they tax every feature, not
just this one.

Six changes would remove most of the recurring cost. The first two are the
highest leverage and each is a day or two of work:

1. Encode the recurring traps in API shape (types/runtime guards), not in
   comments and memory.
2. Declare a table's tenancy shape once and derive every registration list
   from it.

Then: move mechanical source-scan guards into ESLint; split `apps/api` so
typecheck and unit tests are cheap; give stacked PRs real CI; kill the two known
flakes.

## Where the time went

Measured on #6180. Times are wall-clock as observed from the orchestrating
session; agent time is the subagent's own duration.

| Sink | Observed cost | Root cause |
|---|---|---|
| CI + merge queue per PR | ~30 min CI + ~40 min queue per PR, × 5 serial PRs; plus 3 reruns at ~30 min each (Windows `securefs` flake, customer-PII guard, golden set-equality) | Waves form a dependency chain, so every hop pays the full pipeline. `ci.yml` runs only on `main`-based PRs, so a stacked wave gets no signal until its parent lands. |
| Hidden contract lists | Spec missed 2 (`ALLOWED_WITHOUT_CAPABILITY_CHECK`, `envComposeParity`); planners found 2 more (readiness manifest rule, schedule-registry slot); implementers hit 3 in CI (PII domain guard, golden-test set-equality, migration-naming false positive on stacked branches) | The same fact — "this table is partner-axis", "this worker is conditional" — must be restated in 4–6 registries. Nothing surfaces them until a contract test goes red. |
| Known traps re-found by review | BullMQ stable `jobId` + retained records (already documented in `accountingSyncWorker.ts`); `withSystemDbAccessContext` is a no-op inside a request (3rd recurrence: #1105, #6124, W03); transient vs terminal provider errors; `local_part` reaching a header unsanitised | The knowledge lives in code comments and session memory, not in the shape of the API. Each costs a review round (~40 min) plus a fix round (~15 min) plus a CI cycle. |
| Local verification | full API unit suite ~20 min (2,500 files / 47k tests); `tsc` needs `--max-old-space-size=12288`; the serial local integration run self-contaminates and takes 40+ min | `apps/api` is one package; unit and integration tests share a tree; two integration files fail with `ECONNREFUSED` in every unit run. |
| Stacked-branch friction | 4 rebases, 1 conflict, `--no-verify` on every stacked push | Pre-push migration guard diffs against `origin/main`, so a stacked branch always "adds" its parent's migration. |
| Planning | ~3 h for ~29k lines of plans | Paid off (few aborts), but authors spent much of it re-deriving line numbers, helper signatures, and idioms. |
| Rate limits | 3 agents killed mid-task, ~1 h lost | Not a code problem. |

What was *not* slow: writing the code, writing the tests, the review rounds
themselves (three agents, ~5 min each, and they found real defects on every
wave — keep them).

## What would fix it

### 1. Traps become API shape, not documentation

Each of these has now bitten two or more times. Turning them into something the
compiler or the runtime refuses removes a review round per wave.

| Trap | Recurrences | Change |
|---|---|---|
| `withSystemDbAccessContext` returns `fn()` unchanged when a request context is already open, so an "escalation" inside a handler silently keeps the caller's partner scope | #1105, #6124, W03 (#6199) | Make `withSystemDbAccessContext` **throw** when called inside a request context. Provide `escalateFromRequest(fn)` (= `runOutsideDbContext(() => withSystemDbAccessContext(fn))`) as the only sanctioned path, and lint-forbid calling `runOutsideDbContext` directly outside `db/`. |
| BullMQ silently drops `add()` when a job with the same `jobId` sits in the completed/failed set | `accountingSyncWorker`, W03 | A `queue.addWithStableId(name, id, data)` helper in `jobs/queueHelpers.ts` that always sets `removeOnComplete: true, removeOnFail: true`; lint-forbid `jobId:` in a raw `queue.add` call. |
| Transient provider errors committed as terminal state | W02 (Resend adapter), W03 (`provision()`), W04 (`static` classifier) | One `ProviderError` hierarchy in `services/providers/errors.ts` with `retryable: boolean` decided by the adapter that saw the HTTP/SMTP response. Workers `commitFailed` only on `retryable === false`; everything else rethrows. |
| Partner-editable string reaches an email header | W04 (`local_part`) | Route schemas import the shared Zod validator by convention; a lint rule forbids `z.string()` for any field whose name matches `/localPart|displayName|domain/` in `routes/**` unless it comes from `@breeze/shared`. |
| Caught `23505`/`23503` inside a request transaction aborts the transaction (surfaces as 500) | #5907, W03 | A `db.insertIgnoringConflict()` / savepoint helper; lint-forbid `catch` of a Postgres error code inside `withDbAccessContext` callbacks. |

### 2. Declare tenancy once, derive the lists

A new `org_id`/`partner_id` table today needs entries in up to seven places:
`PARTNER_TENANT_TABLES` or the org auto-discovery, `INTENTIONAL_UNSCOPED`,
`CORE_ORG_CASCADE_DELETE_ORDER`, the device lists, `CORE_TENANT_EXPORT_POLICY`,
`ALLOWED_WITHOUT_CAPABILITY_CHECK`, the org-merge registry. Missing one is a CI
red at best (most run only in the Integration job) and a GDPR-erasure bug at
worst (5 shipped instances per `CLAUDE.md`).

Proposal: a `tenantTable()` wrapper around `pgTable` in `db/schema/_tenancy.ts`
that takes the shape as data:

```ts
export const partnerSendingDomains = tenantTable('partner_sending_domains', {
  tenancy: { axis: 'partner' },                 // 'org' | 'partner' | 'dual' | 'device' | 'user' | 'system'
  erasure: { orgCascade: false, exportPolicy: null },
  writes: { partnerWideGate: 'not-applicable' }, // or 'required' | { exempt: '<reason>' }
}, { ...columns });
```

The contract tests then **read** the declaration instead of hand-maintained
arrays: RLS coverage asserts the policy matches `tenancy.axis`; the cascade test
derives its order from FK topology plus the declared axis; the export-policy
test only demands per-column buckets for tables that declare `orgCascade`; the
partner-wide-write test reads `writes`. The arrays stay for one release as a
cross-check, then go. A new table becomes one declaration next to its columns,
which is the only place a new author looks.

### 3. Mechanical source-scan guards move into ESLint

Twenty-three test files under `apps/api/src` walk the source tree with
`readdirSync`/regex. Some genuinely need to (they compare against the Drizzle
schema). The purely lexical ones — `deliverRaw` scope, "no route imports the
provider registry", customer-PII domains, `/* i18n-dynamic */` markers,
"no `from:` in `sendEmail` calls" — are `no-restricted-imports` /
`no-restricted-syntax` rules with a custom message. They fail in the editor in
seconds instead of 30 minutes into CI, and they do not need a planted-violation
control test to prove they bite.

### 4. Make `apps/api` cheap to verify

- TypeScript project references (`services/`, `routes/`, `jobs/`, `db/`) so a
  one-file change typechecks its project, not 12 GB of the whole tree.
- Separate vitest projects for unit and integration so `npx vitest run` never
  starts the two `ECONNREFUSED` files, and the integration project runs
  sharded locally the way CI does (the serial run self-contaminates today).
- A `pnpm test:changed` script (vitest `--changed origin/main`) as the
  documented pre-push check; the full suite stays a CI concern.

### 5. Real CI for stacked PRs

- `ci.yml` `pull_request.branches: [main, 'feature/**']` so a wave stacked on
  its parent gets the same signal as a `main`-based PR. The queue still
  evaluates the merge ref, so nothing is lost.
- `check-migration-naming.sh --against-ref` should diff against
  `git merge-base HEAD origin/main`, not `origin/main`, so a stacked branch does
  not "add" its parent's migration. Every stacked push in this feature needed
  `--no-verify`, which is a habit we do not want.

### 6. Kill the two known flakes

`Test Agent (Windows)` `securefs` `TestInstallFileConcurrentReplacement`
(observed 09-14 and twice this run) and the release asset-upload flake each cost
a 30-minute rerun on every PR they hit, repo-wide. Quarantine or fix; a flake
that reruns weekly is a standing tax on merge throughput.

## What not to change

- **Paste-complete plans.** The planning hours were repaid: four waves ran with
  no aborted tasks and few deviations, and each deviation was documented in the
  PR body.
- **Three-reviewer rounds.** They found a silent job-drop, a kill switch that
  could not see other partners, a header-injection vector, and a transient-error
  path that permanently failed domains — all before merge. Cheap relative to a
  production incident.
- **The contract tests themselves.** Their history is 5/5 catches vs 0/5 for
  human review. The proposal is to feed them from one declaration, not to
  weaken them.

## Suggested order

1. Tenancy declaration (§2) — removes the most frequent surprise, and the plan
   docs' "registration lists" sections shrink to one line.
2. DB-context guard + BullMQ helper (§1, first two rows) — each is a few hours
   and closes a trap that has recurred three times.
3. ESLint migration of lexical guards (§3).
4. Stacked-PR CI + merge-base guard (§5).
5. `apps/api` project references and vitest projects (§4).
6. Flake quarantine (§6) — can run in parallel with any of the above.

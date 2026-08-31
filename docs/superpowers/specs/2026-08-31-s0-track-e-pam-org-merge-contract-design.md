---
tracking_issue: LanternOps/breeze#4060
---

# S0 Track E — Organization-Merge Contract for Durable PAM Actuation Evidence

**Date:** 2026-08-31
**Status:** Proposed — awaiting owner approval (nothing below is implemented)
**Applies to:** PR #4105 (`fix/s0-pam-actuation-lifecycle`); repairs the 7 org-merge CI reds on run 33359724948
**Governing priors:** `docs/superpowers/specs/tenancy-rls/2026-08-26-org-lifecycle-merge-archive-design.md` (merge registry contract), `docs/superpowers/specs/2026-08-26-s0-track-e-pam-device-move-guard-design.md` (device no-transfer ruling)

## Decision (normative summary)

An organization merge never re-tenants, deletes, or bypasses durable PAM
actuation evidence. A loser organization holding **any** `pam_actuations` or
`pam_actuation_results` row is not mergeable: the merge is refused fail-closed
at preview, at job start before the fence, and authoritatively inside the
Phase-B transaction before the table walk. Survivor-side PAM evidence never
blocks and is never touched.

This extends the approved device no-transfer ruling — "a device identity that
has entered the durable PAM lifecycle cannot be reassigned to another
organization," with no force flag, system-scope bypass, audit-admin bypass,
state-based exception, or automatic deletion — to the org-granular
reassignment a merge performs. An org merge repoints every loser device; it is
the same operation the guard forbids, executed in bulk. The merge therefore
inherits the same answer, not a carve-out around it.

The mechanism is a new, generic merge-registry policy class `blocks-merge`.
PAM evidence is its first member; the class itself is reusable for any future
table whose rows must forbid rather than follow a merge.

## Why no other classification is available (verified constraints)

1. **Repoint is physically unreachable.** `pam_actuation_results` has
   `UPDATE, DELETE, TRUNCATE` revoked from `breeze_app` and an unconditional
   `BEFORE UPDATE OR DELETE` trigger (`pam_actuation_results_block_mutation`)
   raising `42501`; the GUC escape (`breeze.allow_audit_retention=1`) covers
   DELETE only (`apps/api/migrations/2026-09-16-pam-actuation-lifecycle.sql:184-206`).
   There is no UPDATE path for any role the merge can assume.
2. **Lockstep is structurally required and structurally impossible.** The
   composite FKs `pam_actuation_results(actuation_id, org_id) →
   pam_actuations(id, org_id)`, `(device_id, org_id) → devices(id, org_id)`,
   and `pam_actuations(elevation_request_id, org_id) →
   elevation_requests(id, org_id)` carry no `ON UPDATE CASCADE`; any partial
   repoint of the chain fails at COMMIT (`23503`). Because (1) freezes the
   child, the whole chain is frozen.
3. **The devices repoint is trigger-blocked.** `devices_pam_history_move_guard`
   (`apps/api/migrations/2026-09-17-pam-device-move-guard.sql`) raises `23514`
   on any `devices.org_id` change while the device has a `pam_actuations` row
   in its current org — deliberately state-blind. The merge's
   `UPDATE devices SET org_id = <survivor> WHERE org_id = <loser>` trips it
   for every loser org that ever ran an elevation.
4. **`leave-for-erasure` cannot express PAM evidence.** Erasure-bound rows
   must survive Phase B in place, but the loser's devices are repointed in
   Phase B, so `pam_actuations(device_id, org_id) → devices(id, org_id)`
   breaks at COMMIT. Making it "work" needs in-transaction deletion under
   `breeze_audit_admin` plus the retention GUC plus a merge carve-out on the
   devices guard — three explicit bypasses of Track E protections, plus the
   destruction of privileged-access evidence for a client who continues to
   exist under the survivor. Merge is consolidation, not offboarding; the
   `audit_logs` destruction precedent does not transfer.
5. **Operational failure mode of any fudge.** The reconciliation resolver is
   deliberately opaque: any binding whose `org_id` no longer matches
   collapses to `unresolved`, the endpoint fails closed permanently
   (`binding_unresolved`, protocol pinned, no repair path), with no server
   alarm beyond a heartbeat counter. This was observed empirically in the
   rc.2 lab when ledger bindings went stale. A merge that moved or destroyed
   evidence would do this to every PAM-touched device it "consolidated."
6. **Prior rulings.** The device-move-guard design explicitly rejected
   privileged evidence transfer, delete-and-recreate, and source-owned
   historical evidence (the last as "a separate tenancy design"), and states
   "Audit-admin retention is not a device-move mechanism." This design adds
   no new rejection — it applies the recorded ones to the merge path the
   earlier design did not enumerate.

## Registry contract

New policy class in `apps/api/src/services/orgMergeRegistry.ts`:

```ts
| { kind: 'blocks-merge'; note: string }
```

Entries:

- `pam_actuations` → `{ kind: 'blocks-merge', note: 'durable PAM lifecycle evidence is source-frozen; a loser org holding any row is not mergeable (extends devices_pam_history_move_guard to org granularity)' }`
- `pam_actuation_results` → `{ kind: 'blocks-merge', note: 'append-only PAM evidence; UPDATE revoked and trigger-blocked for every app role; rows cannot exist without a pam_actuations parent, listed for registry completeness and belt-and-braces counting' }`

Semantics:

- **Non-mutating.** `blocks-merge` joins `leave-for-erasure`, `derived`,
  `follows-parent`, `loser-shell` in the contract test's `NON_MUTATING` set.
- **Blocking predicate:** `EXISTS (SELECT 1 FROM <table> WHERE org_id = <loser>)`,
  state-blind, matching the device guard's deliberately state-blind predicate.
  Survivor rows are never consulted.
- **Walk executor** (`runPolicy`): defense-in-depth assertion only — if a
  `blocks-merge` table is reached with any loser row, throw. It must never be
  the first line of defense, because `devices` (a parent) is repointed
  earlier in the parents-first walk and would raise `23514` before the walk
  reaches `pam_actuations`. The authoritative check is pre-walk (below).

## Preview and operator behavior

`previewOrgMerge` changes (additive):

- `OrgMergePreview.verdict` gains `'blocked'`, which takes precedence over
  `'too-large'`.
- New field `blockers: string[]` (empty when none). `warnings` is unchanged.
- Each `blocks-merge` table with loser rows appears in `tables[]` with
  `policy: 'blocks-merge'`, its `loserRows` count, and `wouldDrop: 0`
  (nothing is dropped — the merge is refused).
- Blocker text (one entry, counts interpolated):

  > merge blocked: the merged-away organization holds durable PAM lifecycle
  > evidence (N pam_actuations row(s), M pam_actuation_results row(s)).
  > Privileged-access evidence is never re-tenanted, destroyed, or bypassed
  > by a merge. If the surviving organization is the one without PAM
  > evidence, merge in the opposite direction; otherwise these organizations
  > cannot be merged. Audit-admin retention is not a merge mechanism.

Operator surfaces:

- `POST /orgs/organizations/:id/merge` re-runs the preview (as it already
  does for `too-large`) and refuses `verdict === 'blocked'` with **422**,
  code `ORG_MERGE_BLOCKED`, body carrying the blocker strings. No fence, no
  drain, no disruption to either org. Mirrors the existing `too-large`
  refusal shape; like it, the route-level refusal writes no audit event.
- `MergeOrgModal` renders `blockers` as a distinct blocking panel (not a
  destruction warning) and disables the confirm input while any blocker is
  present.
- Direction matters and the UI/docs say so: PAM evidence blocks only on the
  loser side. If exactly one of the two orgs has PAM history, that org must
  be the survivor. If both have PAM history, the pair is not mergeable —
  the same explicit operational trade-off the device guard recorded, at org
  granularity (see Roadmap).

## Execution behavior (worker + engine)

1. **Pre-fence check (worker, courtesy):** before `fenceLoser`, run the
   blocking predicate; on hit, fail the job with the `ORG_MERGE_BLOCKED`
   reason and write the existing org-less `org.merge.failed` audit (with the
   blocker strings in details). The loser is never fenced, drained, or
   epoch-bumped for a merge that cannot succeed.
2. **Authoritative in-transaction check (engine):** in Phase B, immediately
   after `assertPairStillMergeable` and before the registry walk, re-run the
   predicate inside the transaction. On hit, throw typed
   `OrgMergeBlockedError` (`code: 'ORG_MERGE_BLOCKED'`) → normal failure
   path: full rollback, unfence, `org.merge.failed` audit. This is the
   TOCTOU guard; ordering before the walk is mandatory (see Walk executor).
3. The refusal must always surface as `OrgMergeBlockedError`, never as the
   device trigger's `23514` — reaching the trigger means the pre-walk check
   was bypassed, and a contract test treats that as a defect.

## Trigger-classification contract (Guard B repair)

`orgMergeRegistry.integration.test.ts` currently keys
`ORG_ID_BLOCKING_TRIGGERS` / `ORG_ID_BENIGN_TRIGGERS` by **table name**,
which silently absorbs the new, genuinely blocking
`devices_pam_history_move_guard` under the pre-existing benign `devices`
entry (partner-export watermark freeze). This design tightens the contract:

- Re-key both maps by `table.trigger` and migrate every existing entry
  (mechanical; no classification changes to existing triggers).
- Add `pam_actuation_results.pam_actuation_results_block_mutation` →
  **BLOCKING** (raises on every UPDATE).
- Add `pam_actuations.pam_actuations_transition_guard` → **BLOCKING** after
  the §Hardening change lands in the same PR (the guard then raises on
  `org_id` change). Without that hardening it would be benign-by-the-letter,
  which misstates intent; the hardening makes the classification true.
- New third map `ORG_ID_CONDITIONALLY_BLOCKING_TRIGGERS`:
  `devices.devices_pam_history_move_guard` → `{ dischargedBy:
  'pam_actuations', requiredPolicyKind: 'blocks-merge', note: 'cannot fire
  during a merge: any loser org satisfying its predicate is refused by the
  blocks-merge policy before the devices repoint' }`. The contract test
  asserts the discharging table exists in the registry with exactly the
  named policy kind — so if PAM's policy is ever weakened, the devices
  guard's classification goes red with it.
- `NON_MUTATING` gains `'blocks-merge'`; the existing "blocking trigger ⇒
  non-mutating policy" violation check then passes for both PAM tables.

## Hardening (same PR, explicit decision — not inference)

New migration (implementation-dated): `CREATE OR REPLACE` of
`pam_actuations_transition_guard()` adding, ahead of its existing checks:

```sql
IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = 'PAM actuation tenancy is immutable';
END IF;
```

Rationale: today the parent's `org_id` is technically mutable by
`breeze_app` while every child's is not — an asymmetry only the deferred FK
chain closes, and only at COMMIT. This makes the parent's tenancy
immutability direct, immediate, and classifiable as BLOCKING truthfully. It
adds no new semantics; it enforces an invariant every existing test already
assumes. (RLS, grants, and all other PAM contracts unchanged.)

## Rejected alternatives (recorded, with reasons)

- **`leave-for-erasure` (destroy with the loser shell, disclosed in
  preview).** Physically unreachable without three explicit bypasses
  (§constraint 4); destroys privileged-access evidence of a continuing
  client; bricks PAM on the very devices being consolidated (§constraint 5).
  The `action_intents`/`ai_agent_runs` precedent is offboarding-shaped and
  does not transfer to consolidation.
- **Repoint with an org-restamp trigger carve-out (Track D
  `agent_rollback_events` pattern).** Already rejected for PAM as
  "privileged evidence transfer": accepted endpoint evidence tenancy would
  become mutable. The endpoint's frozen ledger binds the original org
  identity; a server-side restamp diverges from endpoint attestation and
  lands in §constraint 5's permanent fail-closed state.
- **Retention-based unblocking guidance.** Deleting evidence to enable a
  merge inverts "Audit-admin retention is not a device-move mechanism." The
  preview text explicitly forecloses it. Deliberate org offboarding
  (archive → purge → erasure) remains the sanctioned way evidence reaches
  end-of-life; it is not a merge and this design does not touch it.

## Out of scope / roadmap

- **Ownership-epoch / evidence-continuity model** (the
  `org_merge_events`-lookup shape used for quote tokens, applied to PAM
  bindings; or the "source-owned historical evidence" snapshot model the
  device-move design deferred). This is the eventual answer for merging two
  orgs that both hold PAM history, and for making PAM-touched orgs mergeable
  at all. It is a separate tenancy design with agent-protocol impact; file
  as a roadmap issue when this design is approved.
- Archive/erasure behavior for PAM tables: unchanged (already handled by
  `tenantCascade` under `breeze_audit_admin` + retention GUC).
- Site moves, device deletion, elevation tables' existing `repoint`
  policies: unchanged.

## Testing contract (all RED before implementation)

1. **Registry contract** (`orgMergeRegistry.integration.test.ts`): both PAM
   tables present with `blocks-merge` (Guard A green); `blocks-merge` in
   `NON_MUTATING`; trigger maps re-keyed `table.trigger` with the three new
   entries; conditionally-blocking discharge assertion (policy kind of
   `pam_actuations` must be `blocks-merge`).
2. **Gauntlet fixture closes the `action_intents`-trap class:** the merge
   integration fixture gains a PAM chain (elevation_request → actuation →
   result) in the loser org. Then:
   - preview returns `verdict: 'blocked'`, correct per-table `loserRows`,
     `wouldDrop: 0`, one blocker string;
   - execute route refuses 422 `ORG_MERGE_BLOCKED` with no fence applied
     (loser status unchanged, no WS close, no epoch bump);
   - engine invoked past the route (test hook): in-tx check throws
     `OrgMergeBlockedError`, full rollback, loser unfenced,
     `org.merge.failed` audit written, loser byte-identical (durable
     snapshot pattern from the PAM suites);
   - the surfaced error is never the trigger's `23514` (ordering defect
     detector);
   - survivor-side-only PAM evidence: merge proceeds, PAM rows and their
     devices byte-identical after.
3. **Existing gauntlet stays green** for PAM-free orgs (no behavior change).
4. **Unit:** verdict precedence (`blocked` > `too-large`), preview shape,
   route 422 body, worker pre-fence refusal writes `org.merge.failed`
   without fencing.
5. **Hardening:** as `breeze_app` with org context, `UPDATE pam_actuations
   SET org_id` → `42501`; all existing transition-guard tests stay green.

## Security / tenancy checklist

- No new grants, no RLS changes, no GUC changes, no new bypass of any kind.
- `blocks-merge` introduces no SQL that writes any table.
- The devices guard, composite FK chain, append-only enforcement, RLS
  force, and the device-move 409 contract are byte-for-byte untouched.
- System scope remains not-an-ownership-bypass: the merge job's system
  context gains no PAM privilege.

## CI mapping (run 33359724948)

- 7 org-merge failures → green by this design: `orgMerge.test.ts` (1),
  `orgMergeCustomExecutors.integration.test.ts` (1),
  `orgMergeRegistry.integration.test.ts` (2), `orgMerge.integration.test.ts` (3).
- 2 remaining failures (`index.pam-actuation-worker.test.ts`) are a
  **companion repair outside this contract**: `src/index.ts` must register
  `['pamActuationWorker', initializePamActuationWorker]` in the
  readiness-tracked worker manifest and call `shutdownPamActuationWorker`
  before `closeRedis`. The tests exist and are already RED; wiring only.

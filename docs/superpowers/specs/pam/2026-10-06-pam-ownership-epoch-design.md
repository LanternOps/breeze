---
tracking_issue: LanternOps/breeze#4477
parent_tracker: LanternOps/breeze#4060
implementation_plan: ../../plans/pam/2026-10-06-pam-ownership-epoch.md
---

# PAM Ownership Epochs — Evidence Continuity Across Device Move and Org Merge

**Date:** 2026-10-06
**Status:** Proposed — awaiting owner approval. Nothing below is implemented.
**Direction:** candidate 1 from #4477 (ownership-epoch lookup), chosen by the
owner 2026-09-22 and taken through the advisor quorum (Fable + Codex
`xhigh`, 2026-10-05). Both advisors agree on the direction. The Codex review
added five corrections, folded in below and listed in §Quorum record.

**Governing priors (all still in force until the final wave ships):**

- `docs/superpowers/specs/2026-08-26-s0-track-e-pam-device-move-guard-design.md`: device no-transfer guard
- `docs/superpowers/specs/2026-08-31-s0-track-e-pam-org-merge-contract-design.md`: `blocks-merge`
- `docs/superpowers/specs/2026-08-26-s0-track-e-pam-reconciliation-binding-design.md`: frozen resolver v1
- `docs/superpowers/specs/tenancy-rls/2026-08-26-org-lifecycle-merge-archive-design.md`: merge registry and Phase C

## 1. Decision (normative summary)

PAM evidence never changes tenant. **The device changes epoch instead.**

Each change to a device's organization appends an immutable *ownership epoch*
row: (device, epoch number, organization). Every PAM row (`elevation_requests`
that reached actuation, `elevation_audit`, `pam_actuations`,
`pam_actuation_results`) is anchored to the exact epoch in which it was
created. Its composite foreign keys point at that epoch row, not at the live
`devices` row. The live device can then move to another organization while
every historical row keeps an exact, never-rewritten `(device_id, org_id)`
ownership at the time it was written.

Binding and result resolution follow the device's epoch lineage, not the
device's current `org_id`. A binding that was valid before a move or merge
therefore resolves deterministically after it. It never collapses to
`unresolved`. A historical-epoch binding resolves to a terminal *retired*
disposition, which records nothing new and lets the endpoint drop the ledger
entry durably.

A device or loser org may change ownership only when every actuation in the
departing epoch is **closed** (§5). An open grant never crosses a tenant
boundary.

For merges, the loser org's PAM evidence keeps the loser's `org_id`. The loser
shell is therefore placed under an **evidence hold** and is not erased in
Phase C. Users of the survivor read the held history through a SELECT-only,
lineage-based RLS branch. The hold is released, and the shell erased, through
the existing erasure machinery when the survivor itself is erased or when
audit retention expires.

The current device-move guard and `blocks-merge` remain the fail-closed
default until the final wave, which flips both behind a flag after the
real-PostgreSQL matrix passes. The design weakens neither guard ahead of that
proof. It replaces them with a stricter, state-aware model.

## 2. How this applies "candidate 1"

The quote-token precedent (`services/orgMergeProvenance.ts:resolveMergedOrgIds`)
keeps an old capability resolvable by walking a lineage record
(`org_merge_events`) instead of rewriting the capability. Applied here:

| Quote tokens | PAM ownership epochs |
|---|---|
| Capability = token carrying the old `orgId` | Capability = endpoint ledger entry carrying the old `orgId` |
| Lineage = `org_merge_events` (org granularity) | Lineage = `device_ownership_epochs` (device granularity, written for **both** move and merge) |
| Row was repointed; the token is widened to find it | Evidence is **not** repointed; the device's lineage proves the old org was a prior owner of this device identity |

Device granularity is required for two reasons. First, a device move creates
no `org_merge_events` row. Second, an org-level lookup alone cannot keep the
composite foreign keys exact. `org_merge_events` is still used, for one
purpose: read authorization of held loser history by the survivor (§7).

## 3. Verified current-state facts this design depends on

All facts were checked against `origin/main` at `9b9f3fc28d`.

1. **The append-only results table cannot be restamped.**
   `pam_actuation_results` has UPDATE, DELETE, and TRUNCATE revoked from
   `breeze_app`, plus `pam_actuation_results_block_mutation`. See
   `migrations/2026-09-16-pam-actuation-lifecycle.sql:184-206`.
2. **The composite FKs pin evidence to the live device.**
   `pam_actuations(device_id, org_id) → devices(id, org_id)` and the matching
   results FK are both `DEFERRABLE INITIALLY DEFERRED`. See lines 60-66 and
   106-111 of the same migration. `elevation_requests.device_id → devices.id`
   and `elevation_audit(elevation_request_id, org_id) → elevation_requests`
   are at `db/schema/elevations.ts:92` and
   `migrations/2026-05-26-a-elevation-requests.sql:287-295`.
3. **`pam_actuations` tenancy is directly immutable.** See
   `migrations/2026-09-25-pam-actuation-org-immutable.sql`.
4. **The resolver and the result transaction both require
   `actuation.org_id = device.org_id` on the live row.** See
   `services/pamReconciliationBinding.ts` (`owned_actuations` CTE) and
   `services/pamActuationResult.ts:79-87`. Both run under the agent's
   current-org RLS context (`routes/agents/pamReconciliation.ts:88`).
5. **The agent's org identity is set only at enrollment.**
   `cfg.OrgID = enrollResp.OrgID` at `agent/internal/agentapp/main.go:1455`.
   Nothing refreshes it after a server-side org change.
   `validatePamLifetimeLocalIdentity` (`agent/internal/heartbeat/handlers_actuate.go:130-138`)
   rejects any PAM v2 command whose `orgId` differs from the enrolled value.
   **After any move, a new-epoch PAM command would be refused on the
   endpoint.** Peripheral v2 (`agent/internal/peripheral/v2.go:66`) and Track D rollback
   (`handlers_rollback_backend.go:179`) have the same stale-identity
   dependency.
6. **The endpoint ledger never drops cleaned entries.** Restart re-reconciles
   every entry (`pamlifetime/manager.go:395`). Entry identity is matched on
   `requestId`, `deviceId`, and `orgId` (`pamlifetime/store.go:351-354`).
7. **Merge Phase C erases the loser shell.** The job enqueues the erasure at
   `jobs/orgMerge.ts:201`. The offboarding sweeper retries it independently at
   `services/tenantOffboarding.ts:1706`. `org_merge_events.survivor_org_id`
   cascades on survivor deletion
   (`migrations/2026-09-12-100001-org-lifecycle-foundations.sql:76`).
8. **Device deletion removes registered children by `device_id` alone.** See
   `services/deviceDeletion.ts:339` and `getDeviceCascadeDeleteTables()`.
9. **`elevation_requests` is rewritten on device move and site move**
   (`routes/devices/core.ts:327`, `:528`) and repointed on merge (registry
   `repoint` list).
10. **Erasure can already be refused for a hold.**
    `tenant.erasure.refused_legal_hold` is precedent for an erasure-refusing
    hold (`tenantCascadeLegalHold.integration.test.ts`).

## 4. Data model

### 4.1 `device_ownership_epochs` (new, append-only)

```sql
CREATE TABLE device_ownership_epochs (
  device_id   uuid        NOT NULL,          -- NO FK to devices (see 4.4)
  epoch       integer     NOT NULL CHECK (epoch >= 1),
  org_id      uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id     uuid,                          -- site at epoch start (display only)
  cause       text        NOT NULL CHECK (cause IN ('enrollment','backfill','device_move','org_merge','unspecified')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, epoch),
  UNIQUE (device_id, org_id, epoch)          -- composite FK target
);
```

- **Tenancy:** Shape 1 (`breeze_has_org_access(org_id)`) plus the system
  branch, plus the lineage SELECT branch of §7.
- **Writes:** only by triggers. Insert happens when a device is created and
  when `devices.org_id` changes. UPDATE is revoked and trigger-blocked.
  DELETE happens only through org erasure (FK cascade) or the exact-epoch
  device deletion of §4.4.
- `devices` gains `ownership_epoch integer NOT NULL DEFAULT 1`. A guard
  rejects any caller-written change. Only the org-change trigger may advance
  it, by exactly +1.

### 4.2 `device_ownership_epoch_closures` (new, append-only)

```sql
CREATE TABLE device_ownership_epoch_closures (
  device_id uuid NOT NULL, epoch integer NOT NULL, org_id uuid NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now(),
  hostname_snapshot varchar(255), display_name_snapshot varchar(255), site_id_snapshot uuid,
  PRIMARY KEY (device_id, epoch),
  FOREIGN KEY (device_id, org_id, epoch) REFERENCES device_ownership_epochs(device_id, org_id, epoch) ON DELETE CASCADE
);
```

This table is the display source for source-org history after the device has
left that org. It has one row per closed epoch. Its RLS uses the same shape as
the epochs table and resolves through the closed epoch's `org_id`, never
through the live device. The snapshot is for display only. Site scope uses
event-time site ownership (§7.3).

### 4.3 Epoch anchoring of the PAM chain

The following tables gain `device_epoch integer NOT NULL`:
`elevation_requests`, `pam_actuations`, and `pam_actuation_results`.
`elevation_audit` stays anchored through its existing composite FK to the
request.

| Table | FK removed | FK added |
|---|---|---|
| `elevation_requests` | `device_id → devices(id)` | `(device_id, org_id, device_epoch) → device_ownership_epochs` |
| `pam_actuations` | `(device_id, org_id) → devices(id, org_id)` | `(device_id, org_id, device_epoch) → device_ownership_epochs` |
| `pam_actuation_results` | `(device_id, org_id) → devices(id, org_id)` | `(actuation_id, device_id, org_id, device_epoch) → pam_actuations(id, device_id, org_id, device_epoch)` (new unique key) |

**Backfill.** All three tables gain `device_epoch` as `DEFAULT 1 NOT NULL`,
so every existing row is in epoch 1 without any UPDATE. This uniform approach
is required by the append-only `pam_actuation_results` and is used for the
other two tables for consistency. `ADD COLUMN … DEFAULT` with a constant is a
catalog-only change in PostgreSQL 11+ and rewrites no tuple. The append-only
trigger is a row-level `BEFORE UPDATE` and does not fire.

The column default is then dropped on `elevation_requests` and
`pam_actuations`, whose insert guard sets the value. It is kept on
`pam_actuation_results`, where the composite FK to the actuation enforces the
correct value.

Each new FK is added `NOT VALID` and then `VALIDATE`d. Neither step mutates a
row. A test asserts the results table is byte-identical before and after the
migration. Byte-identical means the same row count and the same `md5` over the
pre-existing columns.

**Freeze triggers.** `(device_id, org_id, device_epoch)` is immutable on all
three tables, using the same `42501` style as
`pam_actuations_transition_guard`.

**Insert guard.** A new `elevation_requests` or `pam_actuations` row must
carry `device_epoch = devices.ownership_epoch` and `org_id = devices.org_id`.
The guard reads that device row `FOR SHARE`.

**Lock order:** the device row first, then the actuation row. This applies to
insert, dispatch, result, and move alike. The result transaction gains an
explicit device `FOR SHARE` read ahead of its existing actuation
`FOR UPDATE`.

### 4.4 Device deletion, re-specified

The epoch table has no FK to `devices`, so deleting a device in its current
org cannot cascade into an earlier org's evidence. Device permanent deletion
removes PAM-chain rows **scoped by exact current epoch**, as
`(device_id, org_id, device_epoch) = (d.id, d.org_id, d.ownership_epoch)`,
and then removes that epoch's row. Earlier-epoch rows are another org's
evidence and are left in place, even when that earlier org is the same org
(A → B → A).

`device_ownership_epochs` and the closures table are registered in
`CORE_DEVICE_CASCADE_DELETE_TABLES` with an exact-epoch predicate. The plan
extends the deletion helper to accept a per-table predicate.

Erasing an org removes its epochs and their entire chain through the org
cascade, under `breeze_audit_admin` plus the retention GUC. This is the
existing mechanism; the change is that the cascade now reaches the rows via
the epoch FK.

### 4.5 Ledger retirement markers (new, system-only)

```sql
CREATE TABLE pam_ledger_retirements (
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  actuation_id uuid NOT NULL,
  retired_epoch integer NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, actuation_id)
);
```

These rows are written by the org-change trigger in the same transaction as
the epoch closure, one row per actuation of the departing epoch. They carry
only identifiers, with no org and no evidence. RLS is **system scope only**
and the table is listed as intentionally system-scoped, like
`device_commands`.

They are the authority that lets an endpoint drop an old ledger entry *after
the source org has been erased*. Without them, erasing the source org would
remove the lookup authority and wedge PAM admission on that device
permanently. The rows live exactly as long as the live device.

## 5. Closed actuation (the transfer precondition)

An actuation is **closed** only when all of the following hold:

- `desired_state = 'cleanup'`, `observed_state = 'cleaned'`, and
  `cleaned_at IS NOT NULL`; and
- a `pam_actuation_results` row exists with `result_kind = 'cleaned'` at the
  actuation's current `generation`. This is accepted endpoint proof, not a
  server assertion.

Every other state blocks transfer: `failed`, `legacy_untracked`,
`cleanup_pending`, `verified_active`, and every in-flight state (see Open
Decision OD3). A closed actuation cannot reopen. The cleanup tombstone is
already irreversible, and W2 adds a check that `observed_state` cannot leave
`cleaned`.

The predicate lives in exactly one SQL function,
`pam_actuation_is_closed(pam_actuations)`. The route check, the merge
pre-walk, and the device trigger all call it.

## 6. Binding and result resolution

### 6.1 Lookup authority

The resolver and the result transaction stop using the RLS-scoped live-org
join. A `SECURITY DEFINER` SQL function,
`breeze_pam_epoch_binding(agent_id, device_id, candidates jsonb)`, verifies
that the agent owns the device on the live `devices` row. It then classifies
each candidate by `actuation.device_id = device_id` together with
membership of `(device_id, actuation.org_id, actuation.device_epoch)` in that
device's epoch lineage.

The function returns **only dispositions and a command ID**, never evidence or
org IDs, so it adds no read surface for users of the destination org. It is
`STABLE`, has a pinned `search_path`, and has `EXECUTE` granted to
`breeze_app` only.

### 6.2 Dispositions

| Candidate | v1 response (frozen) | v2 response |
|---|---|---|
| current epoch | unchanged: `bound` / `duplicate` / `stale` / `unresolved` | same |
| historical epoch, actuation closed, or a retirement marker exists | `stale` (agent disposes, records nothing, opens admission) | `retired` |
| historical epoch, not closed | cannot exist (§5 precondition); `unresolved` if seen | `unresolved` |
| future generation, foreign, contradictory | `unresolved` (opaque, unchanged) | `unresolved` |

- **v2 adds one disposition, `retired`.** It authorizes the agent to remove
  the ledger entry durably. Reusing `stale` alone only disposes the
  observation; the next restart reconciles the same tombstone again, forever.
- **v1 keeps working.** v1 is unchanged for current-epoch candidates. For
  historical ones, v1 agents get `stale`. That widens the documented meaning
  of `stale` ("server has moved past this observation") and must be recorded
  in the reconciliation-binding spec as an amendment. A v1 agent therefore
  never wedges after a move. It re-presents the tombstone each boot, which is
  bounded by ledger size and harmless (OD1, OD2).
- **The result transaction never writes evidence into a historical epoch.** A
  structured result for a historical-epoch actuation acknowledges `stale`
  (v1) or `retired` (v2) and inserts nothing. The source org's evidence stays
  byte-identical after the move.

### 6.3 Agent identity refresh (agent-shipped)

The server-authored identity snapshot is
`{ deviceId, orgId, siteId, ownershipEpoch }`. It is delivered on the
authenticated heartbeat response and on WebSocket (re)connect.

The agent persists it atomically, using the existing `saveToLocked` path.
It accepts the snapshot only when `ownershipEpoch` is strictly greater than
the stored value, or equal with a same-epoch site change. It then publishes
one synchronized snapshot to every identity consumer: the PAM handler,
peripheral v2, and the Track D rollback engine, which today copies identity
at construction (`handlers_rollback_backend.go:179`) and must be rebuilt or
read through the shared snapshot.

PAM v2 admission stays closed between a move and the refresh. The server does
not dispatch new-epoch PAM commands until the device has acknowledged the
identity capability and reports the current epoch. This is the same gating
pattern as `pam_lifetime_protocol_version`.

Ledger entries are not rewritten. A historical entry keeps its original
`orgId` and is removed only on `retired`.

## 7. Org merge: evidence hold and survivor read access

### 7.1 Evidence hold

The new `org_evidence_holds(loser_org_id PK, partner_id, survivor_org_id,
merge_event_id, reason, created_at)` table is Shape 3, partner-axis, like
`org_merge_events`.

It is written in the merge Phase B transaction when the loser holds any PAM
chain row. It is also written transitively. When an org that is itself the
survivor of a held shell merges away, a hold row is written for it too, so
A → B → C keeps A's lineage alive (OD7).

Phase C erasure and the sweeper's erasure retry (`tenantOffboarding.ts:1706`)
both **skip** held shells. The shell is stamped `deleted_at`, is
non-operational, and stays out of every org list, but it is not erased. The
skip writes a `tenant.erasure.deferred_evidence_hold` audit, following the
legal-hold precedent.

### 7.2 Hold release

Releasing a hold is an explicit erasure-path action and never a merge action.
There are two triggers:

- **Survivor erasure.** Erasing the survivor erases its held shells first.
- **Retention expiry.** The existing PAM retention path, `breeze_audit_admin`
  plus `breeze.allow_audit_retention`, deletes the held chain. A shell with
  no remaining chain rows releases its hold and is erased by the sweeper.

Nothing else releases a hold (OD6).

### 7.3 Survivor read access and read-path rules

- A new SELECT-only policy on `pam_actuations`, `pam_actuation_results`,
  `elevation_requests`, `elevation_audit`, `device_ownership_epochs`, and the
  closures table uses `breeze_has_merged_lineage_access(org_id)`. That is a
  `SECURITY DEFINER` function that walks `org_merge_events` forward from
  `org_id`. The walk is capped at depth 5, is partner-pinned on every hop,
  and is true only when a survivor in the chain passes
  `breeze_has_org_access`. It is never added to a `FOR ALL` policy.
- **Device-move source history stays with the source org under plain org
  RLS.** The target org never sees it. The target's history for the device
  starts at the target's own epoch.
- **History reads never join the live `devices` row without matching
  `(device_id, org_id)` against the evidence row.** A historical row renders
  device display from the epoch closure snapshot. W5 sweeps every reader: the
  `routes/pam.ts` list and detail reads (`:277` and siblings),
  `services/pamAuditExport.ts`, AI tools that read PAM rows, and the alert
  bridges. A static contract test forbids an unscoped
  `pam_* JOIN devices ON device_id` in `apps/api/src`.
- **Site scope** for historical rows uses the event-time `site_id` stamped on
  `elevation_requests`. Device and site move rewriters now exclude
  historical-epoch rows (`WHERE device_epoch = d.ownership_epoch`). Within
  the current epoch, site moves keep today's behavior.

## 8. Operations, re-specified

| Operation | Precondition | Effect on PAM chain | Effect on epochs |
|---|---|---|---|
| Device move A → B | all actuations in the current epoch closed; else `409 PAM_DEVICE_MOVE_ACTIVE` | none; rows stay A-stamped; pending un-actuated requests expired (OD4) | close epoch n (closure + retirement markers), open n+1 in B |
| Org merge L → S | all L actuations closed; else `422 ORG_MERGE_BLOCKED` (existing code, new reason) | none; L-stamped rows stay; L shell held | each L device: close epoch, open epoch in S (cause `org_merge`) |
| Device permanent delete | unchanged | delete current-epoch chain only | delete current epoch and its markers |
| Org erasure | refused while the org holds a hold for another survivor's lineage (via §7.2) | entire org chain via audit-admin cascade | org's epochs cascade |
| Site move within org | unchanged | current-epoch rows only | none |

Merge registry: `pam_actuations` and `pam_actuation_results` move from
`blocks-merge` to a new non-mutating kind, `{ kind: 'epoch-frozen' }`. Its
pre-walk predicate is "any loser actuation not closed". The
`elevation_requests` entry becomes `custom`: repoint only un-actuated rows
(which are expired first per OD4) and leave actuated rows. `elevation_audit`
follows its request. Both epoch tables and `org_evidence_holds` get explicit
entries.

`ORG_ID_CONDITIONALLY_BLOCKING_TRIGGERS` re-keys the devices trigger's
discharge to `epoch-frozen`. `blocks-merge` stays as a reusable class; it
still has other members.

## 9. Concurrency

- **Actuation-create vs move.** The insert guard's device `FOR SHARE`
  conflicts with the move's `UPDATE devices`. Either the actuation commits in
  epoch n and the move's closed-check sees it open and refuses, or the move
  commits first and the insert sees epoch n+1 / org B and is rejected.
- **Result vs move.** The result transaction locks the device row before the
  actuation row. A cleaned result racing a move either completes before the
  move (making the actuation closed) or runs after it (and then resolves as
  historical).
- **Merge.** The Phase B pre-walk closed-check runs under the existing org
  SHARE locks. The per-device trigger re-checks during the `devices` repoint
  (TOCTOU guard, as today). The surfaced refusal must be the typed error,
  never the trigger's `23514`.
- **Supported isolation.** READ COMMITTED (the app default) is proven by the
  two-connection tests. SERIALIZABLE gets one smoke test.

## 10. Rollout

1. Schema and lineage land first, with the guards unchanged. With no move
   possible, behavior is byte-identical.
2. Resolver v2 and result-path lineage land server-side next.
3. The agent identity refresh and `retired` ledger retirement ship in an agent
   release.
4. Holds and survivor read access follow.
Items 1–4 are not strictly ordered. Holds (4) depend only on (1), and the
plan runs them in parallel with (2).

5. **Enablement wave:** flag `PAM_OWNERSHIP_EPOCH_TRANSFER` (default off). The
   flag switches the move route, the device trigger predicate (via a GUC the
   trigger reads, never a code-only switch), and the merge policy. It is
   turned on only after the two-org real-PG matrix and the mixed-version
   agent lab pass.

Server first, agents second. An agent without identity refresh simply never
receives new-epoch PAM commands, because dispatch is gated on the identity
capability. It fails closed, confined to PAM. No deployment, canary, or
rollout claim is made here; those stay governed by #4060.

## 11. Testing contract (all RED before implementation)

**Two-org real-PG matrix**, run for both device move and org merge:

- survivor-only history, loser-only history, and both sides holding history;
- open (non-closed) actuation refusal;
- A → B → A and A → B → C;
- source erasure, then agent restart (retirement marker path);
- held-shell sweeper recovery;
- device deletion after a move;
- site move after a move;
- forged cross-partner lineage;
- merge depth overflow.

**Two-connection races:** insert vs move, result vs move, dispatch vs move,
and merge vs actuation insert.

**Byte-identical evidence** (`md5` of every pre-existing PAM-chain row) after
every refused *and* every completed operation.

**Attestation continuity:** for every ledger entry valid before an operation,
the post-operation resolver returns `bound`, `duplicate`, `stale`, or
`retired`, and never `unresolved`. This is asserted over a generated ledger
covering every lifecycle state.

**Agent tests** (Go race): identity refresh monotonicity, synchronized
snapshot across PAM, peripheral, and rollback, `retired` ledger removal with
fsync, and v1/v2 negotiation. A **mixed-version** check confirms a v1 agent
against a v2 server never wedges.

**RLS coverage** registrations, migration drift and naming, API typecheck, and
the Go race gates must all pass at the exact candidate head.

## 12. Non-goals

- No override of, carve-out from, or weakening of `blocks-merge` or the
  device-move guard before the enablement wave. The enablement wave replaces
  them with a stricter predicate; it does not bypass them.
- No retention-based unblocking. No repoint of any PAM-chain row. No evidence
  transfer.
- No new privileged mover. No grant of UPDATE on any evidence table.
- No deployment, canary, or rollout claim.

## 13. Open decisions

Each has a recommendation. None blocks writing the plan.

- **OD1 — Resolver contract for historical candidates.**
  - (a) v2 `retired` plus v1 `stale` compatibility.
  - (b) `stale` only, with no agent change.
  - **Recommend (a).** `stale` cannot authorize dropping a ledger entry, so
    old tombstones would be reconciled forever.
- **OD2 — v1 agents after a move.**
  - (a) `stale`.
  - (b) `unresolved` until upgraded.
  - **Recommend (a).** (b) wedges PAM on every moved device that runs an
    older agent.
- **OD3 — Closed predicate.**
  - (a) Cleaned with endpoint proof only.
  - (b) Also `failed` where the lifecycle proves there is no residue.
  - **Recommend (a)** for v1 of this feature. Widening later is additive.
- **OD4 — Pending un-actuated elevation requests at move or merge.**
  - (a) Expire them with reason `ownership_changed`.
  - (b) Repoint them.
  - (c) Block the move.
  - **Recommend (a).** The approval was made under the source org's policy.
- **OD5 — Merge evidence custody.**
  - (a) Evidence-hold shell.
  - (b) A separate evidence-owner entity, which needs a broader FK migration
    across every PAM-chain table.
  - **Recommend (a).** Both advisors agree.
- **OD6 — Hold release triggers.**
  - (a) Survivor erasure plus retention expiry only.
  - (b) Also a manual admin release.
  - **Recommend (a).** A manual release is evidence destruction by another
    name.
- **OD7 — Lineage depth.**
  - (a) Transitive holds, and refuse a merge whose resulting lineage would
    exceed depth 5 while holds exist.
  - (b) Flatten lineage by writing extra `org_merge_events` rows.
  - **Recommend (a).** It needs no rewriting of immutable events.
- **OD8 — Retirement authority after source erasure.**
  - (a) A system-only `pam_ledger_retirements` table.
  - (b) Agent-local retirement on identity refresh, with no server proof.
  - **Recommend (a).** (b) lets a forged or replayed refresh discard ledger
    state.
- **OD9 — Identity refresh scope.**
  - (a) A generic agent identity snapshot, consumed by PAM, peripheral, and
    rollback.
  - (b) PAM-only.
  - **Recommend (a).** The stale enrolled org ID is a shared defect, and
    fixing it once avoids three divergent copies.
- **OD10 — Survivor visibility of held loser history.**
  - (a) Org-scoped survivor users, via the lineage RLS branch.
  - (b) Partner-scope users only, who see the held shell through partner
    access already.
  - **Recommend (a).** Consolidation means the continuing client's
    org-scoped admins can audit their own privileged-access history.
- **OD11 — Site scope for historical rows.**
  - (a) Event-time stamped `site_id`.
  - (b) A per-site epoch table.
  - **Recommend (a).** The rows already carry the site, and the rewriters
    only need an epoch filter.

## 14. Quorum record (2026-10-05)

Fable's position was candidate 1 at device granularity: epoch FKs,
closed-only transfer, evidence-hold shells, a lineage RLS read branch, and an
agent identity refresh.

Codex (`gpt-6-astra`, `xhigh`, read-only) **agreed with the direction** and
required the following corrections, all adopted:

1. Freeze `(device_id, org_id, device_epoch)` after insert, and use one lock
   order: device before actuation.
2. Make "closed" durable, requiring an accepted cleaned result.
3. Lineage lookups must run in a narrow definer function, because the agent
   route's current-org RLS would otherwise hide historical rows.
4. A disposition rename is not enough. Ledger retirement needs a durable
   authority that survives source-org erasure (§4.5).
5. Holds must cover the sweeper retry path and transitive lineage
   (A → B → C), and device deletion must be scoped by exact epoch rather than
   current org (A → B → A).

Codex additionally confirmed the stale-enrolled-org premise (fact 5). No
unresolved disagreement remains.

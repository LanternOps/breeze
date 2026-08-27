---
tracking_issue: https://github.com/LanternOps/breeze/issues/4060
parent_plan: ../plans/2026-08-24-s0-track-e-pam-actuation.md
implementation_plan: ../plans/2026-08-26-s0-track-e-pam-device-move-guard.md
---

# Track E PAM Device Organization-Move Guard Design

## Purpose

Close the exact-head integration failure caused by cross-organization device
moves attempting to rewrite append-only `pam_actuation_results`, while
preserving the frozen PAM lifecycle, result, tenancy, and command-ownership
contracts.

This is a wrap-first addendum to Track E. It does not redesign historical PAM
ownership, transfer evidence between tenants, or begin Task 8.

## Repository Finding

The device move transaction currently treats `pam_actuations` and
`pam_actuation_results` as ordinary denormalized device children and executes:

```sql
UPDATE pam_actuation_results
SET org_id = $target_org
WHERE device_id = $device;
```

That statement is invalid by design. `pam_actuation_results` is append-only,
the application role has no `UPDATE` privilege, and the append-only trigger is
an independent second guard.

Removing only that statement is also invalid. Both PAM tables carry deferred
composite `(device_id, org_id)` ownership foreign keys to `devices`, and results
also carry `(actuation_id, org_id)` ownership to `pam_actuations`. Allowing the
device to move while leaving the rows behind would fail those constraints or
require weakening them.

## Decision

A durable `pam_actuations` row makes that device identity non-transferable
between organizations.

`POST /devices/:id/move-org` returns HTTP `409` with code
`PAM_DEVICE_MOVE_BLOCKED` whenever an owned `pam_actuations` row exists for the
device, regardless of desired state, observed state, generation, or whether a
result has been recorded. The database independently rejects every direct
`devices.org_id` change under the same condition.

There is no force flag, system-scope bypass, audit-admin bypass, state-based
exception, or automatic deletion/retention operation. A completed, failed,
cleaned, or legacy-untracked lifecycle still proves that this device identity
has durable PAM ownership history and remains non-transferable.

This is intentionally conservative. A future transfer feature requires its own
approved design for immutable historical ownership, device deletion/erasure,
read projections, and tenant-visible lineage. It is not inferred here.

## Why the Guard Covers Every Actuation State

Blocking only active or unresolved rows does not solve the frozen-schema
conflict. A cleaned actuation still has an immutable result and both rows still
carry the same composite device/organization ownership. Re-stamping the
cleaned result would still violate append-only evidence; leaving it behind
would still violate the device ownership foreign key.

The predicate is therefore exact and stable:

```sql
EXISTS (
  SELECT 1
  FROM pam_actuations
  WHERE device_id = OLD.id
    AND org_id = OLD.org_id
)
```

No lifecycle-state list is maintained, so a future state cannot accidentally
become transferable by omission.

## Considered Approaches

### Selected: reject organization moves after first durable PAM actuation

This keeps all current schema, RLS, append-only, device-erasure, result, and
command-binding contracts intact. It changes only the eligibility of the
existing move operation and removes PAM tables from a rewrite registry they
can never validly participate in.

The operational trade-off is explicit: a device identity that has entered the
durable PAM lifecycle cannot be reassigned to another organization. Ordinary
devices with no PAM actuation remain movable.

### Rejected for this addendum: source-owned historical evidence

Leaving completed PAM history in the source organization while moving the
device would require replacing the composite live-device foreign keys with a
snapshot or ownership-epoch model. It would also change device deletion and
erasure behavior, decide whether `elevation_requests` stays in the source
organization, and audit every read path to prevent current target-organization
device metadata from leaking into source history.

That can be a future feature, but it is a separate tenancy design rather than a
CI repair or Track E wrap item.

### Rejected: privileged evidence transfer

Granting `UPDATE`, disabling the append-only trigger, or introducing a
privileged mover would make accepted endpoint evidence tenant ownership
mutable. An audit row describing that mutation would not restore immutability.

### Rejected: delete and recreate evidence

Deletion would erase accepted endpoint evidence and recreation would fabricate
a new ownership event. Audit-admin retention is not a device-move mechanism.

## API Contract

The route performs an early owned-scope check inside the move transaction and
before changing `devices.org_id`:

```ts
export async function assertPamDeviceOrgMoveAllowed(
  tx: PamDeviceMoveTx,
  input: { deviceId: string; sourceOrgId: string },
): Promise<void>;
```

When blocked, it throws `PamDeviceMoveBlockedError`. The route maps only that
typed error, or the exact database guard constraint, to:

```json
{
  "error": "Device organization move is blocked because durable PAM lifecycle evidence exists",
  "code": "PAM_DEVICE_MOVE_BLOCKED"
}
```

The response contains no actuation ID, command ID, result count, state,
generation, subject username, executable identity, or evidence. Authorization
for both source and target organizations remains unchanged and runs before the
transaction, so the response is not a cross-tenant enumeration surface.

The failed move writes the existing source-side `device.move_org.failed` audit
with the stable failure code only. It writes no target-side success audit,
disconnects no agent, schedules no peripheral reconciliation, and changes no
device, ticket, PAM, command, or evidence row.

## Database Contract

An additive migration creates a `BEFORE UPDATE OF org_id` trigger on `devices`.
When `NEW.org_id IS DISTINCT FROM OLD.org_id` and an exact source-owned
`pam_actuations` row exists, it raises SQLSTATE `23514` with constraint name
`devices_pam_history_move_guard`.

The trigger is the authority for route, background, extension, and direct-SQL
writers. The TypeScript service exists for the stable HTTP response and an
early, readable failure; it is not the security boundary.

The migration also replaces the dynamic device-child discovery function with
its full current body plus two deliberate exclusions:

```text
pam_actuations
pam_actuation_results
```

The route's `CORE_DEVICE_ORG_DENORMALIZED_TABLES` removes those same two names.
The two tables remain in device cascade-delete registration and organization
cascade/retention registration; this addendum changes organization moves only.

No existing migration is edited or renamed. The fix-forward migration is
`2026-09-17-pam-device-move-guard.sql`, ordered after the Track E lifecycle
migration.

## Concurrency and Ordering

The device row update and the existing composite PAM foreign keys provide the
serialization boundary:

- if a PAM actuation commits first, the move guard sees it and rejects the
  move;
- if the device organization update owns the row first, a concurrent actuation
  insert for the old `(device_id, org_id)` cannot commit after the move; and
- no execution can commit both a moved device and a source-owned PAM actuation
  that contradict each other.

The route check runs after the source/target organization SHARE locks and
before the device update. The database trigger rechecks under the device row
update, so a check/use race cannot bypass the rule.

No PAM row is locked or mutated. No network, Redis, queue, audit fan-out, or
agent disconnect occurs inside the ownership check.

## Security and Tenancy Invariants

- `pam_actuation_results` remains append-only with unchanged grants and
  trigger.
- The composite device/organization and actuation/organization foreign keys
  remain unchanged.
- PAM RLS remains enabled and forced with the same policies.
- Exact command, agent, device, organization, actuation, generation, target
  role, and command-type checks remain unchanged.
- The reconciliation resolver remains opaque for foreign or contradictory
  candidates.
- System scope is not an ownership bypass.
- Device permanent deletion and organization erasure retain their existing
  explicit cascade and audit-admin behavior.

## Verification Plan

Strict RED/GREEN tests must prove:

1. the exact-head move failure reproduces before the change;
2. a device with no PAM actuation still moves successfully;
3. one row in each representative state—`pending_dispatch`, `verified_active`,
   `cleanup_pending`, `cleaned`, `failed`, and `legacy_untracked`—returns the
   same `409 PAM_DEVICE_MOVE_BLOCKED`;
4. a result-only bypass fixture is impossible under the existing foreign key;
5. blocked moves leave source/target device, ticket, PAM, command, and result
   rows unchanged, add exactly one source-side failed-move audit carrying only
   the stable failure code, and add no target-side success audit;
6. direct SQL `devices.org_id` mutation raises `23514` with
   `devices_pam_history_move_guard`;
7. a two-connection actuation-create versus device-move race has only two
   valid outcomes: actuation wins and move is blocked, or move wins and the
   stale-source actuation cannot commit;
8. neither route nor dynamic trigger executes an `UPDATE` against either PAM
   table on an allowed move;
9. the append-only privilege/trigger tests remain unchanged and green;
10. existing agent-run ownership, currency, site, device-move coverage, RLS,
    cascade-delete, migration naming, and drift gates remain green.

## Rollout and Recovery

This is server-only behavior and must land before any further Track E evidence
claim. It needs no agent protocol or local-ledger change.

Operators receive a stable conflict instead of a generic 500. This addendum
defines no override or automated remediation. If organization transfer for a
PAM-touched device becomes a shipping requirement, work stops at the conflict
until the separate historical-ownership design is approved.

## Scope Non-Claims

- No PAM evidence transfer or ownership detachment.
- No command-ID bypass or durable-agent-ledger expansion.
- No dispatch wire-contract repair.
- No internally ordered Task 6 `received` production transport.
- No native signed-Windows execution, physical enforcement, deployment,
  hosted reachability, customer mutation, canary, or rollout evidence.
- No Task 8 work.

## Completion Condition

This addendum is implemented only when the API and database enforce the same
no-transfer predicate, both PAM tables are absent from every organization-move
rewrite path, all named focused and regression gates pass, exact-head core CI
is green, and the tracker/PR record the non-transferable-device behavior.

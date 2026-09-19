# Track E Task 7C PAM `received` Observation Transport Design

## Purpose

Close the remaining pre-Task-8 Task 6 transport gap: the Windows PAM lifetime
manager emits `received` after the suspended process is resumed and before it
verifies active Job Object membership, but production currently transports
only the manager's singular returned result.

This design gives that internally ordered `received` observation its own
durable, authenticated, exact-command transport. It preserves the frozen
`pamlifetime.Manager` interface, the strict v2 command and result shapes, the
durable PAM ledger, and the existing `recordPamActuationResult` transaction.

## Current Defect

`lifecycleManager.Apply` currently performs this order:

```text
persist desired active generation
create suspended process
create/configure Job Object
assign process to Job Object
persist process identity
resume primary thread
construct and internally emit received
verify active Job Object membership
construct and internally emit verified_active
return verified_active
```

The Windows production constructor supplies a nil internal observer. The
heartbeat command handler receives only the returned `verified_active` or
`failed` result and carries that singular result through the ordinary command
result flow. The `received` observation therefore has no production transport.

Sending `received` through the ordinary `POST .../result` flow is not safe.
That route normally terminalizes `device_commands` before invoking the PAM
result transaction. A `received` observation is supplemental evidence, not a
terminal command outcome. The duplicate-apply path can also legitimately
return singular `received`, so the server cannot infer transport intent from
the result state alone.

## Decision

Use an invocation-scoped, synchronous durable handoff from the manager to the
heartbeat transport, followed by an asynchronous acknowledged REST submission
through a new agent-authenticated supplemental observation route.

The new route calls the existing frozen PAM result transaction. It does not
create another result transaction and never mutates `device_commands`.

## Frozen Boundaries

The implementation must preserve all of these boundaries:

- `pamlifetime.Manager` remains exactly:

  ```go
  type Manager interface {
      Apply(context.Context, ApplyCommand) Result
      Cleanup(context.Context, CleanupCommand) Result
      Reconcile(context.Context) []Result
      SetEnabled(context.Context, bool) error
  }
  ```

- The strict apply command remains the existing twelve JSON keys. No command
  ID is added to `ApplyCommand` or the durable ledger.
- The strict PAM result remains the existing v2 result schema.
- `recordPamActuationResult` remains the only transaction allowed to append PAM
  evidence or advance observed endpoint state.
- Exact agent, device, organization, command, actuation, generation, desired
  state, and target-role ownership checks are not weakened.
- The `pam-reconciliation` on-disk namespace remains readable and is not
  renamed or migrated.
- WebSocket result behavior is unchanged.
- No migration, new table, command-ID bypass, ledger expansion, alternate
  unauthenticated result path, Task 8 work, or entitlement disposition is in
  scope.

## Agent Manager Boundary

The concrete Windows lifecycle manager gains an additional exported method,
while the frozen `Manager` interface remains unchanged:

```go
func (m *lifecycleManager) ApplyWithReceivedObservation(
    ctx context.Context,
    cmd ApplyCommand,
    handoff func(Result) error,
) Result
```

The heartbeat package defines the narrow optional interface it requires:

```go
type pamReceivedObservationManager interface {
    ApplyWithReceivedObservation(
        context.Context,
        pamlifetime.ApplyCommand,
        func(pamlifetime.Result) error,
    ) pamlifetime.Result
}
```

`lifecycleManager.Apply` delegates to the same internal implementation without
a production handoff so existing unit seams and the frozen interface remain
valid. The v2 heartbeat apply handler requires the narrow interface after its
existing reconciliation, verification-availability, policy, and local-identity
checks. A purported v2-capable manager that lacks it fails closed before any OS
actuation.

The invocation callback is passed directly down the call stack. It is never
installed in mutable manager-global state, so concurrent commands cannot steal
or overwrite another command's binding.

## Required Apply Ordering

For a new apply, the exact order becomes:

```text
validate identity, generation, hash, and server-bounded lifetime
persist desired active generation
create suspended process
create/configure non-inheritable kill-on-close Job Object
assign process to Job Object
persist PID, creation time, boot ID, and Job Object name
resume primary thread
construct received with a new observation UUID
durably enqueue (exact authenticated command ID, received observation)
signal the PAM result retry loop
verify active Job Object membership
return verified_active through the existing singular command result flow
```

The durable enqueue, not a network acknowledgement, is the synchronous handoff
barrier. Network submission remains asynchronous and retryable. This avoids
holding verification on a network round trip while still ensuring that normal
verification cannot overtake local durable custody of `received`.

The existing duplicate-apply branch does not call this handoff because it did
not resume a new process and did not internally emit the ordered Task 6
observation. Its existing singular return behavior is unchanged.

## Durable-Handoff Failure

If the exact-command outbox enqueue fails after resume:

1. active verification does not run;
2. the manager marks that actuation and generation unresolved using its
   existing generation-aware unresolved gate;
3. the still-armed ownership defers close the Job Object and process handles,
   causing kill-on-close to terminate the process tree;
4. account deprovision is attempted by the existing failure cleanup;
5. the returned singular result is `failed` with stable failure code
   `received_observation_handoff_failed`; and
6. PAM apply admission and capability remain closed until reconciliation or a
   verified cleanup resolves that generation.

The failure path does not claim `cleaned`. Deprovision ambiguity, missing
negative token evidence, or persistence ambiguity remains unresolved and
fail-closed.

A process crash between `ResumeThread` and the immediate enqueue call cannot be
made atomic with the OS resume operation. The existing kill-on-close Job Object
contains the process tree, and the next startup reconciliation supplies the
ownership-preserving recovery evidence. The implementation must not move
`received` before `ResumeThread` merely to remove this unavoidable crash
window.

## Durable Outbox Reuse

The heartbeat handler enqueues the received observation directly into the
existing non-expiring PAM outbox with the command ID from the authenticated
command envelope:

```go
outbox.Enqueue(cmd.ID, received)
```

It does not call the reconciliation binding resolver before enqueue because the
live handler already possesses the exact command ID. The outbox continues to
validate canonical command and observation UUIDs, write owner-only files via
temporary-file flush and atomic rename, coalesce identical content, and retain
entries until an acknowledged classification.

The existing rejected re-resolution rules remain authoritative:

- `applied`, `duplicate`, or `stale` removes the pending entry;
- `rejected` re-resolves exact ownership;
- rotation to a newer command rebinds only when the resolver proves it;
- duplicate or stale removes the entry;
- unresolved retains it; and
- binding to the same rejecting command quarantines it.

No existing on-disk entry gains a required field, so agents can restart across
the change without an outbox migration.

Outbox submission selects the new supplemental route only when the stored
observation state is `received`. Every other stored reconciliation observation
continues to use the existing acknowledged `/result` route. Startup
`Manager.Reconcile` does not currently emit `received`, and tests must freeze
that routing boundary.

## Supplemental REST Route

Add this route under the existing agent-authenticated router:

```text
POST /api/v1/agents/:id/commands/:commandId/pam-observations
```

The strict request is:

```ts
type PamReceivedObservationRequest = {
  protocolVersion: 1;
  observation: PamAgentResultV2 & { state: 'received' };
};
```

The acknowledgement reuses the established protocol:

```ts
type PamResultAcknowledgement = {
  protocolVersion: 1;
  classification: 'applied' | 'duplicate' | 'stale' | 'rejected';
};
```

The route must:

1. require the primary agent role through the existing agent authentication
   middleware;
2. reject noncanonical command IDs;
3. enforce the drain claim allowlist;
4. apply a streaming `bodyLimit` of 32 KiB before JSON validation;
5. validate a strict body with no unknown keys;
6. rate-limit by the authenticated device using the existing PAM
   reconciliation limiter;
7. load the command by exact command ID and authenticated device ID;
8. require command type `pam_apply_v2` and `target_role = 'agent'`;
9. call `recordPamActuationResult` with the authenticated agent ID, device ID,
   path command ID, and validated observation; and
10. return only the transaction's acknowledgement classification.

The route accepts a valid late `received` observation even if the command row
is already terminal, because it never rewrites that row and the frozen result
transaction classifies reordered evidence as `stale`. This makes lost-response
retries safe without adding a terminal-row exception to command mutation.

Any missing command, device mismatch, role mismatch, drain restriction,
malformed body, non-`received` state, or unsupported command type is rejected
before the result transaction. Foreign ownership remains indistinguishable
from an unavailable command according to the existing agent-route convention.

## Server Persistence Semantics

The supplemental route does not update command status, completion time, stored
result, or payload. It does not invoke the ordinary command terminal compare-
and-set.

All PAM evidence mutation remains inside `recordPamActuationResult`, which
rechecks:

- the actuation ID;
- authenticated device ownership;
- exact `current_command_id` ownership;
- authenticated agent ownership through the device row;
- exact generation;
- legal state ordering; and
- observation idempotency.

An accepted `received` observation appends immutable evidence and advances only
the PAM observed state. It does not set `session_started_at`; that remains
exclusive to accepted `verified_active` evidence.

## Ordering, Retry, and Race Outcomes

The system must produce these outcomes:

- `received` accepted before `verified_active`: both observations are durable,
  and verified active becomes current endpoint truth.
- `verified_active` wins the network race: later `received` is acknowledged
  `stale`, removed from the outbox, and cannot regress endpoint truth.
- acknowledgement is lost after apply: retry returns `duplicate` and removes
  the outbox entry.
- command ownership rotates before submission: the frozen transaction rejects;
  re-resolution disposes stale evidence or rebinds only to an authoritatively
  proven current command.
- server route is absent or transport is unavailable: the entry remains
  durable and retries with bounded backoff.
- agent restarts with a pending received observation: it reloads the existing
  entry and retries before advertising received-transport readiness.
- outbox content is unreadable or a received observation is quarantined: new
  apply admission remains closed; cleanup remains available.

## Capability and Telemetry

Durable observation transport readiness is an apply-admission prerequisite,
not a cleanup prerequisite. `pamReconciled` represents only local lifecycle
manager and startup reconciliation readiness. A transport failure, unreadable
outbox, or blocked or quarantined observation of any state drops advertised
PAM lifetime capability to zero and blocks `pam_apply_v2`, while
`pam_cleanup_v2`, disable cleanup, and startup reconciliation remain able to
reduce privilege. An ordinary acknowledged non-`received` pending observation
retains its existing non-blocking behavior; a pending `received` observation
blocks apply until acknowledged because this transport is the pre-verification
durable handoff barrier.

These conditions live in a separate apply-only readiness predicate. They must
not set the existing `pamReconciled` gate false because
`handlePamCleanupV2` relies on that gate and must remain available to reduce
privilege, including when the blocked or quarantined evidence is
`verified_active`, `cleaned`, or `failed` rather than `received`.

The existing PAM reconciliation heartbeat object gains one optional count:

```ts
receivedObservationPendingCount: number
```

Its blocking reason uses stable value `received_observation_transport` when a
pending received entry cannot obtain acknowledgement, is unreadable, or is
quarantined. Logs include only actuation ID, generation, observation ID, count,
reason, and the local outbox path; they never include usernames, executable
paths, credentials, tokens, or raw evidence.

The server must land first. Promoting an agent that implements this design is
forbidden until the route is registered in route scans/audits and the server
acknowledgement gate passes. An older server returns missing-route/acknowledgement
failure, causing the agent to retain evidence and close further apply admission
instead of silently discarding observations.

## Verification Requirements

Strict RED/GREEN coverage must prove:

- the Windows manager orders resume, durable received handoff, active
  verification, and returned `verified_active` exactly;
- a handoff failure prevents verification, closes the Job Object/process tree,
  attempts deprovision, marks the exact generation unresolved, and returns the
  stable failure code;
- the heartbeat handler binds only the envelope command ID and rejects a v2
  manager without the received-observation method;
- durable enqueue happens before the handler can return the singular terminal
  result;
- restart reload, acknowledgement loss, duplicate, stale, rejected
  re-resolution, quarantine, and unreadable-outbox behavior remain correct;
- the new route enforces authentication, device ownership, target role, command
  type, drain restrictions, strict schema, streaming body cap, and per-device
  rate limit;
- valid `received` evidence does not mutate `device_commands`;
- two-organization real-PostgreSQL tests prove zero foreign-scope rows, command
  changes, PAM evidence, or audit side effects;
- accepted `received` followed by `verified_active` persists both in legal
  order, while reversed arrival classifies received as stale;
- the ordinary REST terminal result route is unchanged;
- WebSocket terminal and orphan behavior is unchanged;
- the strict cross-language v2 command fixture still passes;
- API typecheck, RLS coverage, Go race, Windows amd64 agentapp compile,
  migration drift/naming, diff checks, and exact-candidate core CI pass.

## Rollout and Recovery

This change is server-first and remains internal-lab-only. It authorizes no
production deployment, hosted admission change, customer-device mutation,
canary, or rollout.

Recovery uses the existing operator PAM ledger-reset procedure only for a
genuine quarantined invariant violation. Transport outage, lost
acknowledgement, or ownership rotation is never cleared by deleting evidence;
normal retry and authoritative re-resolution must settle those states.

## Rejected Alternatives

### Special-case `received` on the ordinary result route

Rejected because the same state can be the frozen manager's singular return on
a duplicate apply. The server cannot distinguish supplemental evidence from a
terminal return, so skipping command terminalization could leave a command
permanently nonterminal.

### Return an ordered result slice from `Manager.Apply`

Rejected because it changes the frozen singular manager contract and delivers
the slice only after verification, which does not create a durable handoff
between resume and verification.

### Store the command ID in the PAM ledger

Rejected because the durable ledger contract intentionally excludes the
ephemeral server command binding. Exact live command ownership already exists
at the heartbeat envelope and remains revalidated by the server.

### Add another PAM result transaction

Rejected because duplicate persistence logic would create divergent ownership,
ordering, and tenant checks. The supplemental route must call the existing
transaction.

### Treat server dispatch as `received`

Rejected because server delivery intent is not endpoint evidence that the
process was resumed inside the named Job Object.

## Completion Non-Claims

- This design does not implement Task 8 or prove the Windows failure matrix.
- It does not provide native signed-Windows, physical enforcement, deployment,
  hosted reachability, customer mutation, canary, or rollout evidence.
- It does not resolve the shipping entitlement-removal owner/Product
  disposition.
- It does not change cleanup truth, weaken exact ownership, expand the durable
  ledger, add a migration, relax strict decoding, or add a WebSocket
  supplemental path.

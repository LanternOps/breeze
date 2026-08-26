---
tracking_issue: https://github.com/LanternOps/breeze/issues/4060
implementation_plan: ../plans/2026-08-24-s0-track-e-pam-actuation.md
---

# Track E Task 7 PAM Reconciliation Binding Design

## Purpose

Close only Track E Task 7 Step 3: transport structured startup
`Manager.Reconcile` evidence through the existing authenticated command-result
path without adding a command ID to the durable PAM ledger or weakening exact
command, agent, device, organization, actuation, or generation ownership.

The durable ledger intentionally contains actuation, request, device,
organization, generation, desired state, process, Job Object, boot, and timing
identity, but not the current `device_commands.id`. After a restart, the agent
can re-verify endpoint state and produce a `PamAgentResultV2`, but it cannot
address the existing result endpoint until the server supplies the exact
current owning command ID.

## Scope

This design adds:

1. a read-only, agent-authenticated reconciliation-binding resolver;
2. an agent startup evidence buffer and binding/transport barrier;
3. non-expiring, non-evictable PAM reconciliation entries in the existing
   durable command-result outbox; and
4. a narrow REST/WebSocket rule that lets a terminal PAM command forward a
   supplemental structured observation to the existing shared PAM handler
   without rewriting the terminal `device_commands` row.

This design does not:

- add `commandId` to the PAM ledger;
- add a result-writing endpoint or a second PAM result transaction;
- infer command ownership from actuation identity inside the result
  transaction;
- add a `pam_reconcile_v2` command type;
- weaken result validation or tenant boundaries;
- solve the separate Task 6 internally ordered `received` observation gap;
- begin Task 8; or
- claim native Windows, deployment, hosted, or rollout evidence.

## Considered Approaches

### Selected: resolve the existing current command binding

The authenticated agent presents only startup observation correlation keys.
The server resolves each key to the exact current PAM command after checking
the complete ownership chain. The agent then submits the evidence through the
existing command-result transport, and the existing PAM result transaction
revalidates the binding before any mutation.

This preserves the original command owner, avoids ledger expansion, and keeps
one evidence-writing authority.

### Rejected: create `pam_reconcile_v2` commands

Creating a new command after every restart would provide an ordinary command
identity, but it would rotate `pam_actuations.current_command_id`, add a new
protocol command, and introduce additional late-result and generation races.
That is broader than Task 7 Step 3.

### Rejected: store or bypass command identity

Persisting `commandId` in the PAM ledger violates its frozen contract. Allowing
the result service to look up a command from actuation identity would remove
the caller-supplied exact-command proof and weaken the frozen ownership check.

## Architecture

### Startup evidence barrier

`Manager.Reconcile` continues to run before PAM v2 command admission. Its
results are staged in a bounded in-memory buffer owned by the heartbeat/PAM
transport layer. The buffer is bounded by the number of ledger entries returned
by that reconciliation pass; results are never silently evicted.

PAM admission and capability telemetry remain fail-closed until every staged
result reaches one of these authoritative dispositions:

- `bound`: paired with the returned command ID and durably queued for result
  submission;
- `duplicate`: the observation already exists in append-only PAM results; or
- `stale`: the server has a newer actuation generation.

An `unresolved` result keeps admission closed and capability telemetry at zero.
The agent retries resolution with bounded backoff. A transport outage therefore
cannot create new PAM work before startup evidence has an ownership-preserving
handoff.

A crash before binding loses only the in-memory copy. The next startup reruns
reconciliation and emits fresh evidence from durable endpoint/ledger state. A
crash after binding is covered by the durable result outbox.

### Binding resolver

The resolver is a read-only route under the existing agent-authenticated API
surface:

```http
POST /api/v1/agents/:agentId/pam/reconciliation-bindings
```

Request:

```ts
type PamReconciliationBindingRequest = {
  protocolVersion: 1;
  candidates: Array<{
    observationId: string;
    actuationId: string;
    generation: number;
  }>;
};
```

Response:

```ts
type PamReconciliationBindingDisposition =
  | { status: 'bound'; observationId: string; commandId: string }
  | { status: 'duplicate'; observationId: string }
  | { status: 'stale'; observationId: string }
  | { status: 'unresolved'; observationId: string };

type PamReconciliationBindingResponse = {
  protocolVersion: 1;
  dispositions: PamReconciliationBindingDisposition[];
};
```

The route rejects malformed protocol versions, invalid UUIDs, non-positive
generations, duplicate candidate keys, and oversized batches. Agents chunk
larger ledgers into bounded requests.

For `bound`, one short database read verifies all of the following:

- the authenticated agent resolves to the request device and organization;
- `pam_actuations.id`, `device_id`, and `org_id` match that scope;
- the candidate generation equals the current actuation generation;
- `pam_actuations.current_command_id` is non-null;
- that exact command exists and belongs to the same device; and
- its type is compatible with the current PAM desired state:
  `pam_apply_v2` for active or `pam_cleanup_v2` for cleanup.

The terminal command payload is not an ownership source because terminal
payload erasure may already have removed it. The immutable server-authored
`pam_actuations.current_command_id` relationship, reinforced by the command
device/type checks, is the binding authority.

The resolver returns:

- `duplicate` when the exact observation already exists for the actuation and
  generation;
- `stale` only when the candidate generation is lower than the current
  generation; and
- opaque `unresolved` for missing, foreign, future-generation, commandless, or
  contradictory ownership.

The opaque response avoids turning guessed actuation IDs into a cross-tenant
existence oracle. The resolver accepts no evidence and performs no state
mutation.

### Existing result transport

After `bound`, the agent wraps the original `PamAgentResultV2` in the existing
command-result envelope, associates it with the returned command ID, and
persists it to the existing durable result outbox. Submission uses the existing
REST or WebSocket command-result transport.

The current REST and WebSocket paths normally short-circuit a terminal
`device_commands` row. A shared supplemental-PAM helper runs after the normal
command/device/role authorization checks but before that terminal short
circuit. It activates only when:

- the command type is `pam_apply_v2` or `pam_cleanup_v2`; and
- the structured body parses as `PamAgentResultV2`.

The helper invokes the existing shared PAM handler and
`recordPamActuationResult`. It never rewrites the terminal command status,
result, payload, completion time, or other command columns. Non-PAM terminal
behavior is unchanged. Nonterminal PAM results continue through the existing
normal path and are not double-dispatched.

Both transports expose the existing PAM transaction classification:
`applied`, `duplicate`, `stale`, or `rejected`. The frozen transaction remains
the final authority and still requires the submitted command ID to equal
`pam_actuations.current_command_id` while matching agent, device,
organization, actuation, and generation identity.

## Agent Result-Outbox Rules

Bound startup observations use the existing durable command-result outbox with
a PAM reconciliation source marker. These entries are keyed by command and
observation identity and have different retention rules from ordinary entries:

- they are not evicted by the ordinary pending-entry cap;
- they do not expire by age;
- transport failure retains them for bounded retry;
- `applied`, `duplicate`, or `stale` removes them;
- `rejected` moves them to a durable quarantine state and keeps PAM admission
  closed; and
- no failure path silently drops them.

Non-PAM outbox capacity, expiry, ordering, and eviction behavior remain
unchanged.

## Concurrency and Ordering

The binding read does not hold a lock across the network. Ownership may change
after resolution because a newer cleanup generation becomes current. This is
safe by construction: the result transaction rechecks the exact current
command and generation. A result that loses that race is `stale` or `rejected`
and cannot mutate endpoint truth.

The agent does not open PAM admission merely because local reconciliation
completed. It opens only after ownership resolution has handed every result to
the durable result transport or authoritatively disposed of it as duplicate or
stale. Concurrent command delivery therefore cannot overtake unresolved
startup evidence.

Binding requests and submissions are idempotent. Repeated binding reads return
the same current command while ownership is unchanged. Repeated result
submissions are deduplicated by immutable observation identity in the existing
PAM result transaction.

## Failure Semantics

- Authentication failure or malformed input fails closed.
- Network and server failures retain staged/outbox evidence and retry with
  bounded backoff.
- `unresolved` retains the staged result and keeps capability zero.
- `rejected` quarantines the durable result and keeps capability zero. Task 7
  provides no automatic quarantine-clear path.
- `stale` records no new PAM result and permits the newer server generation to
  proceed.
- No resolver or transport failure can claim `verified_active` or `cleaned`.

## Verification Plan

Implementation follows strict RED/GREEN TDD.

API unit and real-Postgres tests must prove:

- exact current binding for the authenticated device and organization;
- two-organization foreign attempts return opaque `unresolved` with zero side
  effects;
- missing, wrong-device, wrong-command-type, future-generation, commandless,
  and replaced-command cases fail closed;
- exact duplicate and stale classification;
- ownership change between binding and submission cannot mutate state;
- terminal REST and WebSocket PAM observations have identical classifications
  and database effects;
- supplemental observations never rewrite the terminal command row; and
- all accepted observations still pass the frozen result transaction.

Go unit/race tests must prove:

- startup admission stays closed until every reconciliation result is bound,
  duplicate, or stale;
- offline startup and resolver failure retry without dropping evidence;
- crash before binding is recovered by the next reconciliation;
- crash after binding is recovered from the durable outbox;
- rejected evidence is quarantined and keeps admission closed;
- PAM reconciliation entries survive ordinary outbox age/cap eviction;
- concurrent command arrival cannot overtake the startup barrier; and
- non-PAM outbox behavior remains unchanged.

Required gates are focused API tests, the two-tenant real-Postgres integration
test, API typecheck, Go race tests for agentapp/heartbeat/pamlifetime, and the
Windows amd64 agentapp cross-compile. These gates are code evidence only; they
do not replace Task 8 native signed-Windows evidence.

## Completion Condition

Task 7 Step 3 may be checked only when the resolver, startup barrier, durable
handoff, supplemental terminal observation handling, and all stated gates are
implemented and passing. Task 8 remains blocked until then.

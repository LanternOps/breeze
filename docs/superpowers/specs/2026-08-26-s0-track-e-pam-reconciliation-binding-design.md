---
tracking_issue: https://github.com/LanternOps/breeze/issues/4060
implementation_plan: ../plans/2026-08-24-s0-track-e-pam-actuation.md
step3_implementation_plan: ../plans/2026-08-26-s0-track-e-pam-reconciliation-binding.md
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

## Preconditions

The branch's PAM dispatch payload does not currently decode under the agent's
strict apply/cleanup wire contract: the worker emits
`elevationRequestId`/`requestRevision`/`targetExecutablePath`-shaped fields and
omits `protocolVersion`, `requestId`, `deviceId`, `orgId`, `serverTime`, and
`maxRemainingLifetimeMs`, while the agent decoder requires exactly the plan's
contract and rejects unknown fields. That defect predates this design and is
recorded as a separate Track E precondition in tracker issue #4060; until it is
fixed, this design's gates are code evidence for the reconciliation path only
and cannot constitute end-to-end apply evidence.

## Scope

This design adds:

1. a read-only, agent-authenticated reconciliation-binding resolver;
2. deterministic observation identity for reconciliation evidence;
3. an agent startup evidence buffer and binding/transport barrier;
4. an acknowledged, REST-only reconciliation result submission whose response
   carries the PAM transaction classification;
5. non-expiring, non-evictable PAM reconciliation entries in the durable
   command-result outbox, coalesced by deterministic identity; and
6. a narrow REST rule that lets a terminal PAM command forward a supplemental
   structured observation to the existing shared PAM handler without rewriting
   the terminal `device_commands` row; and
7. an operator runbook at
   `docs/runbooks/pam-reconciliation-ledger-reset.md` for the only manual
   quarantine-clear operation.

This design does not:

- add `commandId` to the PAM ledger;
- add a result-writing endpoint or a second PAM result transaction (the
  classification acknowledgement is returned by the existing result route, not
  a new writer);
- infer command ownership from actuation identity inside the result
  transaction;
- add a `pam_reconcile_v2` command type;
- change WebSocket command-result behavior in any way: terminal WS results
  continue into the existing orphan handling, and no supplemental WS path is
  added;
- weaken result validation or tenant boundaries;
- solve the separate Task 6 internally ordered `received` observation gap;
- fix the pre-existing dispatch wire-contract defect named in Preconditions;
- begin Task 8; or
- claim native Windows, deployment, hosted, or rollout evidence.

## Considered Approaches

### Selected: resolve the existing current command binding

The authenticated agent presents only startup observation correlation keys.
The server resolves each key to the exact current PAM command after checking
the complete ownership chain. The agent then submits the evidence through the
existing REST command-result transport, reads the acknowledged classification,
and the existing PAM result transaction revalidates the binding before any
mutation.

This preserves the original command owner, avoids ledger expansion, and keeps
one evidence-writing authority.

### Rejected: create `pam_reconcile_v2` commands

Creating a new command after every restart would provide an ordinary command
identity, but it would rotate `pam_actuations.current_command_id`, add a new
protocol command, and introduce additional late-result and generation races.
That is broader than Task 7 Step 3.

### Rejected: re-deliver PAM command metadata on reconnect

Command delivery claims `pending` rows only and transitions them to `sent`; a
claimed command is never re-delivered, and the WebSocket path delivers no
reconnect batches. Re-delivering PAM command identity after restart would be a
new delivery protocol, and it would still not provide an acknowledged
classification or terminal-row handling. The read-only resolver is narrower.

### Rejected: store or bypass command identity

Persisting `commandId` in the PAM ledger violates its frozen contract. Allowing
the result service to look up a command from actuation identity would remove
the caller-supplied exact-command proof and weaken the frozen ownership check.

## Architecture

### Observation identity

Reconciliation observation IDs are deterministic. The implementation uses
RFC 4122 UUIDv5 with the standard URL namespace. Its UTF-8 name is the literal
prefix `https://breezermm.com/protocol/pam-reconciliation-observation/v1/`
followed by the compact JSON encoding of this ordered array:

```text
[lowercase-canonical-actuation-uuid,base-10-generation,state,bootId]
```

The array form and JSON escaping make field boundaries unambiguous. The ledger
already persists boot identity. Consequences:

- resubmission after a crash within the same boot reproduces the same
  observation ID, so the resolver's `duplicate` disposition and the result
  transaction's observation-identity dedup are reachable and authoritative;
- a reboot with an available native boot ID produces a genuinely new
  observation of post-boot state under a new ID, which is recorded as new
  evidence;
- process restarts within one boot cannot multiply outbox or quarantine
  entries; across distinct boots, new evidence intentionally creates new
  entries, so this is a per-boot bound rather than a lifetime disk bound; and
- within one boot, the first recorded observation per (`actuationId`,
  `generation`, `state`) is authoritative; later same-key observations
  classify `duplicate`.

When the native boot ID is unavailable, the existing
`windows-boot-unavailable` marker is part of the name. Those failure
observations intentionally coalesce rather than claiming distinct boots, and
the manager's unresolved state keeps PAM admission closed. Determinism provides
idempotence only. `bootId` is agent-supplied, so it is not an abuse guard;
server-side rate limits below remain required.

### Startup evidence barrier

`Manager.Reconcile` continues to run before PAM v2 command admission. Its
results are staged in a bounded in-memory buffer owned by the heartbeat/PAM
transport layer. The buffer is bounded by the number of ledger entries returned
by that reconciliation pass; results are never silently evicted.

PAM admission and capability telemetry remain fail-closed until every staged
result reaches one of these authoritative dispositions:

- `bound`: paired with the returned command ID and durably queued for result
  submission, where the outbox enqueue has confirmed durable persistence;
- `duplicate`: the observation already exists in append-only PAM results; or
- `stale`: the server has a newer actuation generation.

An `unresolved` result keeps admission closed and capability telemetry at zero.
A failed durable enqueue is not a handoff: the result stays staged and
admission stays closed. The agent retries resolution and enqueue with bounded
backoff. A transport outage therefore cannot create new PAM work before
startup evidence has an ownership-preserving durable handoff.

A crash before binding loses only the in-memory copy. The next startup reruns
reconciliation and, within the same boot, regenerates identical observation
identity from durable endpoint/ledger state. A crash after binding is covered
by the durable result outbox.

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
larger ledgers into bounded requests. The route additionally carries a
request-size (Content-Length) cap and a per-device rate limit following the
existing elevation-requests route pattern; the shared per-agent budget is not
a sufficient guard for a batched enumeration endpoint.

The route requires the authenticated primary agent role. Watchdog credentials
pass the shared agent authentication middleware but are refused here, and the
resolved command must target the agent role.

One short database read first verifies the owned actuation scope:

- the authenticated agent resolves to the request device and organization;
- `pam_actuations.id`, `device_id`, and `org_id` match that scope.

Only after that owned-scope check does the resolver classify generation and
observation identity. A lower candidate generation is `stale`; a higher one is
opaque `unresolved`; and an existing exact observation for the same owned
actuation and generation is `duplicate`. For a remaining same-generation
candidate to be `bound`, the read additionally verifies all of the following:

- `pam_actuations.current_command_id` is non-null;
- that exact command exists, belongs to the same device, and targets the
  agent role; and
- its type is compatible with the current PAM desired state:
  `pam_apply_v2` for active or `pam_cleanup_v2` for cleanup.

`pam_actuations.current_command_id` is server-authored and changes on exactly
two paths: the cleanup lifecycle nulls it in the same update that raises the
generation, and the dispatch worker sets it only while it is null. A command
is therefore never replaced within a generation. The window between a
generation bump and the worker's re-bind leaves the column null; a candidate
arriving in that window is a routine `unresolved` that resolves on retry.

The terminal command payload is not an ownership source: payload content is
not the binding authority, and no delivery surface replays it after claim. The
server-authored `current_command_id` relationship, reinforced by the command
device/role/type checks, is the binding authority.

The resolver therefore returns:

- `duplicate` when the exact observation already exists for the actuation and
  generation;
- `stale` only when the candidate generation is lower than the current
  generation; and
- opaque `unresolved` for missing, foreign, future-generation, commandless, or
  contradictory ownership.

No observation lookup runs before the owned actuation-scope verification, and
no command ID is returned until the exact current-command checks pass. The
opaque response avoids turning guessed actuation IDs into a cross-tenant
existence oracle. The resolver accepts no evidence and performs no state
mutation.

### Acknowledged result submission

After `bound`, the agent wraps the original `PamAgentResultV2` in the existing
command-result envelope, associates it with the returned command ID, persists
it to the durable result outbox, and submits it over the existing REST
command-result route only. Reconciliation results are never submitted over the
WebSocket path, whose behavior this design leaves untouched.

The REST route's response for a PAM structured result carries the frozen
transaction's classification back to the agent:

```ts
type PamResultAcknowledgement = {
  protocolVersion: 1;
  classification: 'applied' | 'duplicate' | 'stale' | 'rejected';
};
```

This requires the shared PAM result handler to return its classification to
the REST route instead of discarding it; the handler-registry return type
change is part of this design's budget. An HTTP success without a readable
classification is a transport failure: the outbox entry is retained and
retried. Only an acknowledged classification disposes an entry.

The REST path normally short-circuits a terminal `device_commands` row. A
supplemental-PAM helper runs after the normal command/device/role
authorization checks but before that terminal short circuit. It activates only
when:

- the command type is `pam_apply_v2` or `pam_cleanup_v2`; and
- the structured body parses as `PamAgentResultV2`.

The helper invokes the existing shared PAM handler and
`recordPamActuationResult`, and returns the acknowledgement above. It never
rewrites the terminal command status, result, payload, completion time, or
other command columns. Non-PAM terminal behavior is unchanged. Nonterminal PAM
results continue through the existing normal path — now also returning the
acknowledgement — and are not double-dispatched.

Supplemental acceptance on terminal commands is an authenticated append
surface and is rate-limited per device alongside the resolver limit.
Deterministic observation identity bounds accepted evidence per boot;
the rate limit bounds attempts.

The frozen transaction remains the final authority and still requires the
submitted command ID to equal `pam_actuations.current_command_id` while
matching agent, device, organization, actuation, and generation identity.

### Rejected re-resolution

An acknowledged `rejected` is not immediately quarantined. The agent first
re-runs binding resolution for that observation:

- `duplicate` or `stale` disposes the entry; this is the expected outcome when
  ownership rotated between binding and submission, because a generation bump
  makes the candidate generation lower and the resolver classifies it `stale`;
- `unresolved` retains the entry and retries with bounded backoff;
- `bound` to a different command atomically replaces only the outbox binding
  and retries submission under the newly authoritative command; and
- `bound` to the same command that just rejected is a genuine contradiction:
  the entry moves to durable quarantine and PAM admission stays closed.

Quarantined entries are re-resolved on every startup, so quarantine
self-clears once the server-side contradiction resolves. A persistent
quarantine indicates an invariant violation, is visible in telemetry, and is
cleared only by the documented operator procedure — never silently.

## Agent Result-Outbox Rules

Bound startup observations use the durable command-result outbox with a PAM
reconciliation source marker. The existing outbox is a WebSocket-flush backup
keyed by command ID alone; PAM reconciliation entries are a distinct keyed
namespace within it: keyed by command and observation identity, flushed
through the acknowledged REST submission above, and never through the
WebSocket flush. Their retention rules differ from ordinary entries:

- enqueue confirms durable persistence and reports failure to the caller; a
  failed enqueue keeps the result staged and admission closed;
- they are not evicted by the ordinary pending-entry cap;
- they do not expire by age;
- transport failure — including a missing resolver or acknowledgement on an
  older server — retains them for bounded retry;
- an acknowledged `applied`, `duplicate`, or `stale` removes them;
- an acknowledged `rejected` enters the re-resolution rule above, and only a
  contradictory re-resolution quarantines;
- deterministic observation identity coalesces re-enqueues, bounding entries
  by ledger size per boot; and
- no failure path silently drops them.

Non-PAM outbox capacity, expiry, ordering, flush, and eviction behavior remain
unchanged.

## Concurrency and Ordering

The binding read does not hold a lock across the network. Ownership may change
after resolution because a newer cleanup generation becomes current. This is
safe by construction: the result transaction rechecks the exact current
command and generation, and a result that loses that race is acknowledged
`stale` — or `rejected` and then classified `stale` by re-resolution — and
cannot mutate endpoint truth or wedge the agent.

The agent does not open PAM admission merely because local reconciliation
completed. It opens only after ownership resolution has handed every result to
the durable result transport or authoritatively disposed of it as duplicate or
stale. Concurrent command delivery therefore cannot overtake unresolved
startup evidence.

Binding requests and submissions are idempotent. Repeated binding reads return
the same current command while ownership is unchanged. Repeated result
submissions reproduce the same deterministic observation identity within a
boot and are deduplicated by the existing PAM result transaction.

## Rollout and Recovery

Server first, agents second. An agent with this behavior talking to a server
without the resolver route or the classification acknowledgement treats the
missing surface as a transport failure: evidence is retained, resolution
retries with bounded backoff, and PAM admission and capability stay at zero on
any device holding ledger entries. That wedge is confined to PAM and is
intentional, so the release and fleet-promote ordering must deploy the server
before promoting agents, and the promote gate must state it.

Wedged devices must be visible, not inferred: the agent reports its
reconciliation state (unresolved, quarantined, and awaiting-acknowledgement
counts, with the blocking reason) through diagnostic logs and the existing
capability telemetry surface, so a device pinned at capability zero is
identifiable server-side.

Future-generation observations remain opaque `unresolved` and fail closed;
a server restored from an older backup can pin devices in this state, which
the same telemetry surfaces. Re-resolution can dispose a quarantine only when
the server later returns `duplicate` or `stale`; there is no administrative
API, ad hoc local file deletion outside the runbook, or silent automatic
override. The implementation must add
`docs/runbooks/pam-reconciliation-ledger-reset.md`, and that reviewed,
operator-driven ledger reset is the only manual quarantine-clear procedure.

## Failure Semantics

- Authentication failure or malformed input fails closed.
- Network and server failures — including missing resolver or acknowledgement
  surfaces on an older server — retain staged/outbox evidence and retry with
  bounded backoff.
- A failed durable enqueue keeps the result staged and admission closed.
- `unresolved` retains the staged result and keeps capability zero.
- `rejected` triggers re-resolution; only a contradictory re-resolution
  quarantines the durable result and keeps capability zero.
- `stale` records no new PAM result and permits the newer server generation to
  proceed.
- No resolver or transport failure can claim `verified_active` or `cleaned`.

## Route Registration Prerequisites

The resolver route is intentionally absent from the drain-allowed agent path
list, so it fails closed during tenant/device drain. The route must be
registered in the agent route-scan and fallback-audit registries like any new
agent surface; those registrations are part of this design's budget, not
follow-ups.

## Verification Plan

Implementation follows strict RED/GREEN TDD.

API unit and real-Postgres tests must prove:

- exact current binding for the authenticated device and organization;
- two-organization foreign attempts return opaque `unresolved` with zero side
  effects, and no observation lookup runs before owned-scope verification;
- missing, wrong-device, wrong-command-type, wrong-target-role,
  future-generation, commandless (including the post-bump pre-dispatch null
  window), and replaced-command cases fail closed;
- watchdog credentials are refused by the resolver;
- resolver batch, size, and per-device rate limits reject over-budget input;
- exact duplicate and stale classification;
- ownership change between binding and submission cannot mutate state and
  acknowledges `stale` or `rejected`;
- the REST result route returns the frozen transaction's classification for
  both nonterminal and supplemental terminal PAM observations;
- supplemental terminal REST observations reach the shared handler with
  identical database effects to nonterminal ones and are rate-limited;
- supplemental observations never rewrite the terminal command row;
- WebSocket terminal PAM results are unchanged: they follow the existing
  orphan handling, receive no supplemental dispatch, and are never
  double-dispatched; and
- all accepted observations still pass the frozen result transaction.

Go unit/race tests must prove:

- observation identity follows the exact UUIDv5 canonicalization above, is
  deterministic within a boot and distinct across available native boot IDs,
  and resubmission within a boot classifies duplicate end to end;
- unavailable-boot-ID failure observations coalesce on the existing marker and
  cannot open admission;
- startup admission stays closed until every reconciliation result is bound
  with a confirmed durable enqueue, duplicate, or stale;
- a failed durable enqueue keeps admission closed and is retried;
- offline startup, resolver failure, and missing-acknowledgement responses
  retry without dropping evidence;
- crash before binding is recovered by the next reconciliation with identical
  observation identity in the same boot;
- crash after binding is recovered from the durable outbox without creating a
  second outbox entry;
- an acknowledged `rejected` re-resolves: a stale re-resolution disposes the
  entry, a different binding retries under that exact command, and only the
  same rejected binding quarantines;
- quarantined evidence keeps admission closed and is re-resolved on startup;
- PAM reconciliation entries survive ordinary outbox age/cap eviction;
- concurrent command arrival cannot overtake the startup barrier; and
- non-PAM outbox and WebSocket flush behavior remain unchanged.

Required gates are focused API tests, the two-tenant real-Postgres integration
test, API typecheck, Go race tests for agentapp/heartbeat/pamlifetime, and the
Windows amd64 agentapp cross-compile. These gates are code evidence only; they
do not replace Task 8 native signed-Windows evidence, and per Preconditions
they do not constitute end-to-end apply evidence until the dispatch
wire-contract defect is fixed.

## Completion Condition

Task 7 Step 3 may be checked only when the resolver, deterministic observation
identity, startup barrier, acknowledged REST submission with the
handler-classification return path, durable handoff with confirmed enqueue,
rejected re-resolution, supplemental terminal REST observation handling,
rollout telemetry, and all stated gates are implemented and passing. Task 8
remains blocked until then.

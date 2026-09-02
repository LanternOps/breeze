---
tracking_issue: https://github.com/LanternOps/breeze/issues/4060
parent_plan: ../plans/2026-08-24-s0-track-e-pam-actuation.md
---

# Track E PAM Dispatch Wire-Contract Repair Design

## Objective

Repair the pre-existing server-to-agent PAM v2 command mismatch before Track E
Task 8. The API dispatch worker must emit the exact `PamApplyV2` or
`PamCleanupV2` shape already frozen in the parent Track E plan, and the strict
agent decoder must accept the stored command without an adapter, alias, or
weakened validation rule.

This is a server-conformance repair. It is not a new dispatch system, protocol
version, result path, ledger field, migration, or endpoint-actuation claim.

## Current Defect

`processPamActuationEvent` currently stores a shared payload shape for both PAM
command types. It includes `elevationRequestId`, `requestRevision`,
`targetExecutablePath`, and `targetExecutableHash`, and it omits required
`protocolVersion`, `requestId`, `deviceId`, `orgId`, `serverTime`, and
`maxRemainingLifetimeMs` fields.

The agent decodes into distinct `pamlifetime.ApplyCommand` and
`pamlifetime.CleanupCommand` structures through a JSON decoder configured with
`DisallowUnknownFields`. The current payload therefore fails before the PAM
lifetime manager can apply or clean anything. The reconciliation transport can
be locally correct while end-to-end apply remains impossible through this
dispatch path.

## Frozen Contract

The parent plan remains authoritative:

```ts
type PamApplyV2 = {
  protocolVersion: 2;
  actuationId: string;
  generation: number;
  requestId: string;
  deviceId: string;
  orgId: string;
  targetPath: string;
  targetHash: string | null;
  subjectUsername: string;
  expiresAt: string;
  serverTime: string;
  maxRemainingLifetimeMs: number;
};

type PamCleanupV2 = {
  protocolVersion: 2;
  actuationId: string;
  generation: number;
  requestId: string;
  deviceId: string;
  orgId: string;
};
```

No additional key is permitted. `requestId` is the owning
`elevation_requests.id`; `requestRevision` remains server-side actuation
identity and is not added to the agent ledger or wire contract.

## Considered Approaches

### Selected: make the server emit the frozen v2 contract

Add one pure, typed payload builder on the API side. It returns a discriminated
apply or cleanup command with exact keys. The worker continues to own command
admission, generation locking, capability checks, command insertion, and
`current_command_id` binding.

This is the smallest repair and preserves every established ownership and
strict-decoding boundary.

### Rejected: accept the current aliases in the agent

Relaxing the decoder or adding aliases would preserve incorrect server output,
permit multiple wire spellings, and still leave the agent without the exact
device, organization, and lifetime-bound fields. The agent must remain strict.

### Rejected: introduce PAM protocol v3

There is no semantic protocol change to negotiate. A new version would add
capability, rollout, and compatibility scope solely to correct a server payload
that never matched the already-approved v2 contract.

## Components

### Typed server payload builder

Create `apps/api/src/jobs/pamActuationCommandPayload.ts`. It owns only command
shape construction and lifetime arithmetic. Its input contains the already
locked and ownership-verified actuation snapshot plus one captured server time.

For `active`, it returns `pam_apply_v2` and the exact apply payload. Field
mapping is fixed:

```text
actuation.id                   -> actuationId
actuation.generation           -> generation
actuation.elevation_request_id -> requestId
actuation.device_id            -> deviceId
actuation.org_id               -> orgId
actuation.target_executable_path -> targetPath
actuation.target_executable_hash -> targetHash
actuation.subject_username     -> subjectUsername
actuation.expires_at           -> expiresAt
captured server time           -> serverTime
expiresAt - serverTime         -> maxRemainingLifetimeMs
```

The captured server time is taken once after the locked row is returned. The
remaining lifetime must be a positive safe integer number of milliseconds. A
missing, elapsed, or unrepresentable active expiry returns the existing
`expired_before_dispatch` blocked disposition and creates no command.

For `cleanup`, the builder returns `pam_cleanup_v2` with only
`protocolVersion`, `actuationId`, `generation`, `requestId`, `deviceId`, and
`orgId`. Target and lifetime fields are omitted, not serialized as null.

### Dispatch worker integration

`processPamActuationEvent` retains its existing row lock and verifies exact
actuation generation, absence of a current command, request/device/organization
identity, and persisted protocol capability before calling the builder.

The worker inserts the builder's command type and payload, explicitly targets
the primary agent role, and binds the inserted command ID to the same exact
actuation generation in the existing system-context transaction. It does not
publish separately, change queue semantics, rotate an already-bound command,
or modify result handling.

### Cross-language contract fixture

Add one canonical JSON fixture under `packages/shared/src/fixtures/` containing
an exact apply command and exact cleanup command. TypeScript tests compare the
builder output byte-for-value to the fixture. A Go heartbeat test loads the
same file, passes each payload through `decodePamLifetimePayload`, and compares
the decoded structures to the expected command fields.

The fixture is test evidence, not a runtime schema or a second protocol owner.
The frozen parent-plan contract remains authoritative.

## Data and Ownership Flow

```text
PAM outbox event
  -> worker locks exact actuation generation
  -> worker joins owning request and device
  -> worker verifies org equality and device capability >= 2
  -> builder creates one exact apply or cleanup v2 payload
  -> worker inserts one primary-agent device command
  -> worker binds that exact command ID to that actuation generation
  -> existing heartbeat/WebSocket delivery forwards stored payload unchanged
  -> strict agent decoder accepts the single frozen shape
  -> existing manager and result transaction remain unchanged
```

No field is inferred on the agent. The server supplies the device and
organization identities from the same locked, ownership-verified row used to
bind the command. Cleanup generation rotation and the ordinary null window
remain unchanged.

## Error Handling

- Missing, elapsed, non-positive, or unrepresentable apply lifetime: retain
  `expired_before_dispatch`, insert no command, and bind no command ID.
- Request/device/organization mismatch: retain `identity_mismatch` and insert no
  command.
- Missing protocol-v2 capability: retain `pam_protocol_v2_unsupported` and
  insert no command.
- Cleanup: does not require target or expiry data and cannot inherit apply-only
  fields.
- Duplicate outbox delivery after binding: returns `duplicate` without creating
  a second command.
- Stale generation: returns `stale` before payload construction.

No fallback legacy payload, alias, retry-time command replacement, or decoder
relaxation is introduced.

## Verification

Strict RED/GREEN evidence must prove:

1. the current worker payload fails exact comparison with the frozen apply and
   cleanup fixtures;
2. the builder emits every required field with no unknown field;
3. cleanup contains no apply-only key;
4. `serverTime + maxRemainingLifetimeMs` equals `expiresAt` exactly;
5. expired and invalid apply lifetimes create no command;
6. the Go strict decoder accepts both canonical fixtures without production
   decoder changes;
7. a real-PostgreSQL worker transaction stores the exact apply and cleanup
   payloads, uses the exact owning device/org/request/generation, targets the
   primary agent role, and binds the inserted command once;
8. duplicate, stale, capability, and identity failure paths remain fail-closed;
9. existing PAM lifecycle, reconciliation binding, result, RLS, API typecheck,
   Go race, and Windows amd64 compile gates still pass; and
10. exact-head core CI records every conclusion with only the expected Main Red
    Alert permitted to skip.

These gates prove cross-language wire compatibility and server transaction
behavior. They are not native Windows execution, physical enforcement,
deployment, hosted reachability, or rollout evidence.

## Rollout and Recovery

No protocol rollout is required. Agents advertise PAM lifetime protocol 2 only
when the existing strict v2 manager is available; the server already gates
dispatch on that persisted capability. Deploying the server repair makes its
payload conform to those agents.

Recovery uses the existing outbox retry and command lifecycle. The repair adds
no feature flag, compatibility mode, replay endpoint, or operator mutation.

## Scope Non-Claims

- No agent production decoder, manager, ledger, Job Object, account, or result
  behavior changes.
- No command-ID bypass or reconciliation ownership change.
- No schema or migration change.
- No alternate dispatch or result transport.
- No Task 6 internally ordered `received` transport.
- No entitlement-removal disposition.
- No Task 8 files or exact-candidate Windows evidence.
- No deployment, hosted validation, customer mutation, canary, or rollout.

## Completion Condition

This repair is complete only when the API stores the exact frozen v2 payload
for both command types, the unchanged strict Go decoder accepts the shared
fixtures, real-PostgreSQL ownership and atomic binding evidence passes, all
named local gates pass, exact-head core CI is green, and issue #4060 plus PR
#4105 record the exact tested SHA and remaining non-claims.

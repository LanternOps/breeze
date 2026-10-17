# PAM Reconciliation Server-First Promote Gate

This document defines the promotion gate; it does not perform a deployment or
rollout. It contains no deployment credentials or hosted addresses, and this
branch makes no claim of production, hosted, or customer-device execution.

The order is immutable:

1. Deploy and verify `POST /api/v1/agents/:id/commands/:commandId/pam-observations`.
2. Prove `applied`, `duplicate`, `stale`, and `rejected` acknowledgements on an
   authorized disposable fixture.
3. Verify the route is primary-agent-only, drain-blocked, rate/body-limited,
   and registered in the route and audit scans.
4. Promote an agent with the received-observation callback only after steps 1-3 pass.
5. Stop when `receivedObservationPendingCount` persists beyond one retry
   interval or `blockingReason` is `received_observation_transport`.

## Server verification gate

Before an agent candidate is eligible for promotion, archive evidence that the
authorized disposable fixture proves:

- the authenticated primary-agent resolver returns only owned, same-generation
  exact current-command bindings;
- foreign device/organization/actuation inputs remain opaque and return no
  command ID;
- the PAM REST result response carries protocol version 1 and exactly one of
  `applied`, `duplicate`, `stale`, or `rejected` from the frozen result
  transaction; and
- command/device/organization/actuation/generation ownership checks remain
  enforced on result submission.

Record the exact deployed server SHA, fixture identity, UTC time, resolver
request/result, acknowledgement request/result, and ownership/isolation test
results. Do not use customer data or a customer device as the fixture.

## Fail-closed compatibility contract

An older server response, a 404 resolver route, any non-success response, or an
HTTP 200 without a readable protocol-v1 acknowledgement is transport failure.
The agent retains durable evidence and retries; it never treats HTTP success
alone as result acceptance.

For a device with unresolved or quarantined ledger evidence, those failures
intentionally pin PAM capability to zero. A durably queued observation awaiting
acknowledgement remains visible in telemetry and is not silently discarded.
Missing routes or acknowledgements remain transport failures. Never delete
durable evidence to recover from an outage; only the reviewed ledger-reset
procedure may clear a genuine invariant quarantine.

## Promotion monitoring and stop criteria

Monitor `securityCapabilities.pamReconciliation` by cohort throughout
promotion. Stop immediately when any of these occur:

- `unresolvedCount` or `quarantinedCount` rises above the approved disposable
  baseline;
- `blockingReason` reports `resolver_unavailable`, `binding_unresolved`,
  `enqueue_failed`, `quarantined`, `outbox_unreadable`, or
  `received_observation_transport` unexpectedly;
- `receivedObservationPendingCount` persists beyond one retry interval;
- acknowledgement responses disappear, become malformed, or return an unknown
  classification;
- the resolver returns 404 or any unexpected status;
- a foreign-scope or ownership-isolation probe differs from the archived
  server-first evidence; or
- agent logs show a persistent same-command rejection.

Stopping promotion does not authorize a ledger reset. Any manual recovery must
follow `docs/runbooks/pam-reconciliation-ledger-reset.md` under its own approved
incident/change record.

## Known native UAC dialog limitation

UAC capture observes Microsoft-Windows-LUA event 15028 after Windows starts the
native consent flow. An initial native UAC prompt can therefore appear before
the Breeze dialog. Capture does not intercept elevation before Windows displays
its prompt.

The current pending-request flow also leaves the native prompt open while the
Breeze dialog waits for technician approval. This persistent parallel dialog is
a separate limitation from the initial appearance: `RunPamFlow` does not cancel
the native request when it enters the remote-approval state, and `pam_apply_v2`
launches through the managed token/job lifecycle independently of that prompt.
The legacy log message mentioning `actuate_elevation` in the wait state does not
identify the command actually dispatched; verify `commandType=pam_apply_v2` in
agent logs to confirm v2 execution.

A safe handoff needs a locally retained binding from the captured request to
the exact native consent process and window, including the requesting session
and process creation identity. Cancellation must revalidate that binding, refuse
ambiguous or reused identities, and confirm the native request was cancelled
without treating that as elevation proof. Preserve the captured target and its
approval-time integrity checks for the later managed launch. The current
newest-consent-process attribution and foreground Escape dismissal do not
provide this request binding. Do not suppress arbitrary consent windows, kill
all consent processes, or disable Windows UAC as a workaround.

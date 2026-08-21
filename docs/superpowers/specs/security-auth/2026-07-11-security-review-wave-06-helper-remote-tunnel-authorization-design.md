# Security Review Wave 6: Helper, Remote, and Tunnel Authorization Design

**Date:** 2026-07-11
**Status:** Approved for planning
**Findings:** SR1-15, SR1-16, SR1-17, SR1-27
**Source:** `internal/security-findings/2026-07-11-playbook-01-multi-tenant-rls-authz.md`
**Reviewed baseline:** `origin/main` at `0f05c1faa274f9c49b96ef57b829d9dbf2989477`

## Objective

Re-evaluate current tenant lifecycle, user authority, ownership, MFA, and device site scope whenever
Breeze mints or exercises helper/remote/tunnel capabilities. Previously authorized sessions must not
remain a credential-minting shortcut after suspension or access reduction.

## Shared current-authorization services

### Tenant lifecycle assertion

Extract the active partner/organization check used by main agent authentication into a shared leaf
service. Both main agent and helper bearer authentication call the same function and receive the
same suspended/inactive semantics. The helper path must not copy a subset of status checks.

### Device capability assertion

Create one current device-access service for remote desktop and tunnels:

```ts
interface DeviceCapabilityRequest {
  auth: AuthContext;
  deviceId: string;
  sessionId?: string;
  capability: 'remote_desktop' | 'tunnel';
  operation: 'mint' | 'close';
}

async function authorizeCurrentDeviceCapability(
  request: DeviceCapabilityRequest,
): Promise<AuthorizedDeviceCapability>;
```

It loads the current user membership, tenant lifecycle, permission set, MFA state, session owner,
device organization/site, and active session record from authoritative storage. It returns
server-derived partner/org/site/device/session IDs. It never trusts authorization decisions cached
in an older session.

Remote desktop uses the established `remote:access` permission. Tunnel mint and close use a new
canonical `tunnels:access` permission so ordinary remote-desktop authority does not silently include
network tunneling. Partner Admin and the built-in roles whose existing product contract includes
tunnels receive the grant explicitly; custom roles do not inherit it.

## Helper bearer authentication — SR1-15

After token signature/expiry and helper/device binding validation, helper authentication calls the
shared tenant lifecycle assertion. Suspended partner, suspended organization, decommissioned device,
or otherwise inactive tenant state rejects the request identically to main agent authentication.

The response does not reveal which parent axis was suspended. Existing helper token format,
rotation, and IPC/wire contracts remain unchanged.

## Remote credential mint — SR1-16

Every WebSocket/viewer/remote-desktop ticket mint re-runs the shared current capability assertion.
The route requires current remote permission, required MFA, session ownership or explicitly allowed
administrator override, and access to the device's current site. A stale remote session record is a
resource locator only, not proof of authorization.

Site moves and membership reductions take effect before the next ticket mint. Already-issued
short-lived viewer tickets retain their existing cryptographic expiry; this wave does not add a
revocation protocol to the viewer wire format.

## Tunnel mint and close — SR1-17/SR1-27

Tunnel WebSocket ticket mint requires current tunnel/remote permission, MFA, session ownership,
active tenant/device, and current device-site access. Tunnel close uses the same capability service
and authorization matrix as mint, with `operation='close'`; visibility alone is insufficient.

Close remains idempotent for an already-closed authorized session. A caller who no longer has
authority receives a denial without learning additional tunnel metadata. System-initiated cleanup
uses an explicit system actor path rather than impersonating a user request.

## Ordering and race behavior

Authorization occurs immediately before credential signing or close mutation. The service locks or
compare-and-sets the session record when ownership/status can change concurrently. The signed ticket
contains only server-derived axes and a short expiry.

External signaling occurs after the database transition commits. If authorization changes between
the final check and an external send, the ticket verifier/consumer must still enforce signed device
and session bindings; the implementation plan must add a deterministic race test at the closest
available boundary.

## MFA and permission behavior

Routes use live `requirePermission` and `requireMfa` middleware, then service-level defense for
non-route callers. Missing MFA, permission, membership, ownership, site access, or active lifecycle
all fail before ticket signing and before queue/WebSocket side effects.

Default role grants preserve intended Partner Admin/technician access. Existing custom roles retain
access only if they already hold the chosen canonical permission; no broad new grant is automatic.

## Audit and telemetry

Audit successful and denied credential mint/close actions with actor, device, session, capability,
and stable reason code. Never log bearer tokens, signed viewer/WS tickets, SDP/ICE details, tunnel
secrets, or full headers. Helper suspension denials use bounded security telemetry without token
contents.

## Rollout

Suspended tenants and users whose permissions/sites were reduced lose helper and new remote/tunnel
credentials immediately. This is intended. Existing agent/helper/viewer message formats do not
change, so API and agent releases remain wire-compatible.

Rollback can restore stale authorization behavior and therefore requires explicit risk acceptance;
there is no data migration to undo.

## Verification

- Shared lifecycle tests compare main agent and helper results for active/suspended partner/org and
  inactive device states.
- Credential matrices cover unauthenticated, missing permission, missing MFA, wrong owner, wrong org,
  hidden site, moved device, reduced access, closed session, and success.
- Deferred-promise tests reduce site/permission or suspend the tenant between session creation and
  mint/close, proving no credential/signaling side effect.
- Tunnel close and mint share contract tests so their authorization cannot drift.
- Ticket claims are asserted to contain only server-derived IDs and expected expiry.
- API typecheck/build, relevant agent tests, route scans, and `git diff --check` pass.

## Non-goals

- Changing agent, helper, viewer, WebRTC, or tunnel wire formats.
- Revoking an already-issued viewer ticket before its current short expiry.
- Treating stale session ownership as current authorization.
- Adding unrelated remote transport or performance changes.

# Security Review Wave 4: Atomic Provisioning Quota Design

**Date:** 2026-07-11
**Status:** Approved for planning
**Finding:** SR1-04
**Source:** `internal/security-findings/2026-07-11-playbook-01-multi-tenant-rls-authz.md`
**Reviewed baseline:** `origin/main` at `0f05c1faa274f9c49b96ef57b829d9dbf2989477`

## Objective

Enforce `partners.max_devices` across every provisioning scope without relying on request-RLS-visible
counts, and serialize quota consumption so concurrent requests cannot exceed capacity.

## Security boundary

Ordinary route authorization still determines whether the caller may provision into the target
organization and site. Only after those checks succeed may a narrowly scoped privileged operation
derive the authoritative partner from the target organization, count partner devices, reserve
capacity, and insert the device.

The request may provide organization/site identifiers but never a partner ID. The privileged
operation resolves the partner through persisted organization/site relationships and rejects any
mismatch before quota work.

## Atomic service contract

Introduce one service entry point:

```ts
interface ProvisionAuthorizedDeviceInput {
  orgId: string;
  siteId: string;
  deviceValues: AuthorizedDeviceInsert;
}

async function provisionDeviceWithinPartnerQuota(
  input: ProvisionAuthorizedDeviceInput,
): Promise<ProvisionedDevice>;
```

The route calls it only after current permission and site authorization. The service enters system
database context outside any held request transaction, then opens one transaction that:

1. Reads and locks the authoritative organization/site relationship.
2. Locks the owning partner row with `FOR UPDATE`, creating a per-partner quota serialization point.
3. Reads `max_devices` from that locked row.
4. Counts all partner devices that are not decommissioned outside request RLS.
5. Rejects when the next device would exceed a finite limit.
6. Inserts the device with the authoritative org, site, and partner-derived relationships.
7. Returns the inserted row before releasing the lock.

The count and insert never occur in separate transactions. A SQL function is not required; a
Drizzle/postgres transaction is acceptable if the lock and count are demonstrably issued on the same
connection and every provisioning path uses the service.

## Quota semantics

- `max_devices IS NULL` means unlimited.
- Only persisted devices with lifecycle state other than decommissioned count toward capacity.
- A partner exactly at the limit cannot provision another device.
- A partner already over the limit may manage or decommission existing devices but cannot provision.
- Decommission and concurrent provisioning serialize through the same partner lock when they change
  quota consumption, or the provisioning transaction re-evaluates after any decommission commit.
- Failed/rolled-back inserts consume no capacity.
- Repeated enrollment/provision requests retain existing idempotency or conflict behavior; quota
  hardening must not create duplicate devices.

## Error contract

Quota exhaustion returns a stable conflict response such as `DEVICE_LIMIT_REACHED` without revealing
other organizations' device counts. Logs/audit may record partner ID, configured limit, and bounded
count under system visibility. Authorization failures remain indistinguishable from missing target
resources where existing route contracts require 404.

Database errors roll back the quota decision and insert. External network, queue, or notification
work occurs only after the transaction commits.

## Audit

Successful provisioning and quota denial emit append-only events with actor type, authoritative
partner/org/site, device ID on success, and a bounded reason code. Do not log enrollment secrets,
agent tokens, hardware identifiers not already allowed by the audit schema, or full request bodies.

## Rollout and compatibility

No data migration is required unless implementation adds an explicit quota-reservation table; the
preferred partner-row lock design does not. The behavioral change is immediate: org/selected callers
that previously undercounted are denied at the true partner limit.

If other provisioning entry points exist, the implementation cannot ship until they either use the
same service or are proven not to create counted devices. Rollback may reintroduce over-provisioning,
so operators should not roll back solely to bypass a legitimate quota denial.

## Verification

- Unit tests cover unlimited, below limit, exact limit, over limit, and decommissioned-device counts.
- Authorization tests prove wrong org/site/partner inputs never enter privileged quota code.
- Real PostgreSQL tests create two concurrent final-slot requests and prove exactly one insert commits.
- A concurrent decommission/provision test proves results follow lock acquisition/commit order.
- Selected/none/org-scope tests prove the count includes devices hidden by request RLS.
- Failure tests prove rollback leaves no device and no reservation residue.
- Existing enrollment/provisioning integration tests, RLS coverage, API typecheck/build, and
  `git diff --check` pass under OrbStack.

## Non-goals

- Changing pricing, billing, or the meaning of `max_devices`.
- Blocking management of already-provisioned devices for over-limit partners.
- Accepting a request-controlled partner ID for quota selection.
- Performing external work while holding the quota transaction.

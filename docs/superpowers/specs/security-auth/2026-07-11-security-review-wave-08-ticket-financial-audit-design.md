# Security Review Wave 8: Ticket Financial Audit Coverage Design

**Date:** 2026-07-11
**Status:** Approved for planning
**Finding:** SR1-24
**Source:** `internal/security-findings/2026-07-11-playbook-01-multi-tenant-rls-authz.md`
**Reviewed baseline:** `origin/main` at `0f05c1faa274f9c49b96ef57b829d9dbf2989477`

## Objective

Make every ticket-part financial mutation inseparable from an append-only audit record while
preserving the existing ticket-parts HTTP contract and organization/site authorization.

## Current boundary

`apps/api/src/routes/tickets/parts.ts` supplies an actor to `addTicketPart`, `updateTicketPart`, and
`deleteTicketPart`. The service currently ignores the actor on update/delete and performs part writes
without a durable audit event. Update/delete also load the current row before a separate write,
allowing the financial before-state to change between capture and mutation.

Ticket parts remain organization-scoped with forced RLS. This wave adds atomic audit coverage rather
than changing tenancy or permissions.

## Atomic audit architecture

Extend the audit service with a transaction-aware insert that shares the existing payload sanitizer
and append-only schema:

```ts
async function createAuditLogInTransaction(
  tx: DatabaseTransaction,
  params: CreateAuditLogParams,
): Promise<void>;
```

Each part service opens one transaction and performs authorization-compatible row access, mutation,
and audit insert on that transaction. If either mutation or audit fails, both roll back. Fire-and-
forget `writeAuditEvent` is not sufficient for this financial boundary.

The transaction-aware helper does not weaken append-only protections and is not exported to request
code as a general raw audit-table writer. It always sanitizes details and supplies the same actor,
IP/user-agent snapshot, result, and initiated-by semantics as existing audit events.

## Mutation contracts

### Create

Insert the part and then audit `ticket_part.created` in the same transaction. The event uses the
returned part ID and authoritative ticket/org relationship. Failure to write the event rolls back
the part.

### Update

Load and lock the current part with `FOR UPDATE`, authorize its authoritative ticket, calculate the
validated update, write it with an expected row match, and audit `ticket_part.updated` with bounded
before/after financial fields. A concurrent update serializes and captures the state it actually
replaces.

### Delete

Load and lock the part, capture bounded fields and actor, delete it, and audit
`ticket_part.deleted` before commit. The audit record survives the part deletion; a failed audit
rolls back the delete.

## Audit payload

Common fields:

```ts
{
  partnerId,
  orgId,
  ticketId,
  partId,
  actorUserId,
  operation,
  before?,
  after?
}
```

`before`/`after` are allowlists containing only:

- `catalogItemId`
- `partNumber`
- `vendor`
- `quantity`
- `unitPrice`
- `costBasis`
- `isBillable`
- `billingStatus`

Description and notes are excluded because they may contain customer content and are not necessary
for the financial trail. Numeric values use the persisted fixed-decimal string representation so
the audit reflects exact stored amounts. Missing fields are omitted rather than serialized as an
unbounded object diff.

Audit `resourceType` is `ticket_part`, `resourceId` is the part UUID, and `resourceName` may use the
bounded part number when present. Error payloads contain stable codes, not raw database or request
bodies.

## Actor and route integration

The route continues deriving `TimeEntryActor` through `timeActorFrom(c)`, but the service must consume
it for all three operations. Capture IP/user-agent request metadata before entering lower-level
transactions if required by the audit helper. System/automation callers supply an explicit actor
type rather than a fabricated user.

Existing `tickets:write`, partner/system scope, scoped ticket lookup, validation, status codes, and
response DTOs remain unchanged.

## Error and retry behavior

- Mutation failure: no audit success event and no data change.
- Audit failure: mutation rolls back and the API returns a server error.
- Duplicate client retry follows existing API semantics; the implementation does not introduce an
  idempotency key. Each committed mutation has exactly one corresponding event.
- Delete of a missing/inaccessible part retains the existing not-found behavior and emits no success
  event.

## Rollout

This wave is additive and has no ticket-part data migration. If the transaction-aware audit helper
requires a new index or constraint, add it through an idempotent date-prefixed migration without
editing shipped audit migrations.

Rollback removes new event production but must not delete existing audit rows or weaken append-only
database protections.

## Verification

- Unit tests cover create/update/delete happy paths and exact allowlisted payloads.
- Actor tests prove update/delete no longer discard the supplied actor.
- Failure-injection tests prove audit failure rolls back each mutation and mutation failure writes no
  success audit.
- Real PostgreSQL concurrency tests prove two updates serialize and each audit before-state matches
  the row it actually replaced.
- Delete tests prove the audit survives deletion with captured financial state.
- Multi-tenant/site tests prove cross-org or hidden-ticket parts remain inaccessible and unaudited.
- Audit sanitizer/append-only integration tests remain green.
- API typecheck/build, focused route/service tests, migration checks if applicable, and
  `git diff --check` pass.

## Non-goals

- Changing ticket-part API schemas, permissions, pricing calculations, or invoice generation.
- Storing free-form descriptions/notes in audit details.
- Replacing the repository-wide audit subsystem with a new event platform.
- Backfilling historical ticket-part changes that were never audited.

# Security Review Wave 8: Ticket Financial Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Produce complete, actor-attributed, transactionally durable audit records for ticket-part financial mutations.

**Architecture:** Add a transaction-aware audit primitive and execute each part mutation plus audit insert in the same database transaction. Lock rows before update/delete so before/after values reflect the serialized mutation.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL, Vitest, OrbStack.

**Global Constraints:** Preserve API request/response shapes; audit catalog item, part number, vendor, quantity, unit price, cost basis, billable flag, and billing status; do not include free-text description/notes; audit failure must roll back the mutation.

**Finding:** SR1-24.

**Design:** `docs/superpowers/specs/2026-07-11-security-review-wave-08-ticket-financial-audit-design.md`

## File map

- Modify `apps/api/src/services/auditService.ts` and `auditService.test.ts`.
- Modify `apps/api/src/services/timeEntryService.ts` only if its transaction types are the canonical reusable pattern.
- Modify `apps/api/src/routes/tickets/parts.ts` and `parts.test.ts`.
- Add `apps/api/src/__tests__/integration/ticketPartsAudit.integration.test.ts`.

## Task 1: Transaction-aware audit primitive

- [ ] Add failing tests proving a caller-supplied transaction is used and no nested/out-of-context transaction is opened.
- [ ] Export the transaction type and primitive:

```ts
export async function createAuditLogInTransaction(
  tx: DbTransaction,
  params: CreateAuditLogParams,
): Promise<void>;
```

- [ ] Share audit-row construction with `createAuditLog`; keep existing async retry behavior unchanged for non-transactional callers.
- [ ] Run `pnpm --filter=@breeze/api test -- services/auditService.test.ts`; expect GREEN after implementation.
- [ ] Commit: `feat(audit): support transactional audit writes`.

## Task 2: Audit part creation atomically

- [ ] Add route tests asserting action `ticket_part.created`, actor identity, ticket/org target, and sanitized financial `after` fields.
- [ ] Add a failure test where audit insert throws and assert the part insert is rolled back.
- [ ] Wrap create in one request-context transaction and call `createAuditLogInTransaction` before commit.
- [ ] Ensure the previously ignored actor parameter is required and threaded from authenticated context.
- [ ] Run `pnpm --filter=@breeze/api test -- routes/tickets/parts.test.ts`; expect GREEN.
- [ ] Commit: `fix(tickets): atomically audit part creation`.

## Task 3: Lock and audit update/delete

- [ ] Add failing tests for `ticket_part.updated` with exact `before`/`after` financial fields and `ticket_part.deleted` with exact `before` fields.
- [ ] Add tests proving description and notes are excluded and no-op updates have an explicit, documented audit outcome.
- [ ] Within the transaction, select the scoped part and parent ticket `FOR UPDATE`, then update/delete and insert the audit record.
- [ ] Preserve not-found and cross-org behavior without revealing existence.
- [ ] Add rollback tests for audit failure on both update and delete.
- [ ] Run the route and audit service tests; expect GREEN.
- [ ] Commit: `fix(tickets): lock and audit part financial changes`.

## Task 4: Real database and concurrency verification

- [ ] Add an OrbStack-backed integration test that concurrently updates one part from two connections and proves each audit `before` value equals the prior committed state.
- [ ] Assert create/update/delete each produce one audit row with actor, org, ticket, part id, action, and allowed financial fields.
- [ ] Force audit insertion failure and verify no part mutation commits.
- [ ] Run the new integration test, `pnpm --filter=@breeze/api test -- routes/tickets/parts.test.ts services/auditService.test.ts`, `pnpm exec tsc --noEmit -p apps/api/tsconfig.json`, and `git diff --check`.
- [ ] Commit: `test(tickets): prove transactional part audit trail`.

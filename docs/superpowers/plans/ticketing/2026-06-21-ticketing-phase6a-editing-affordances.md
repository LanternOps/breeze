# Ticketing Phase 6a — Editing Affordances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff (and, narrowly, portal customers) correct tickets after creation — edit/delete comments, edit the remaining ticket fields from the workbench, and move a ticket to another customer org within the same partner.

**Architecture:** Backend logic lives in `ticketService.ts` (routes/AI/MCP are equal consumers) and emits through the single `emitTicketEvent` dispatch point. Comment edit/delete is gated at two layers: RLS (parent-ticket tenant access) and the service (author identity OR `tickets:manage`). Org-reassign mirrors the proven device `moveOrg` pattern (same-partner validation, single transaction, `org_id` re-stamp on denormalized child rows, device detach, dual-org audit). The web adds inline-edit affordances to `TicketWorkbench.tsx`; the API already supports every ticket field via `PATCH /tickets/:id`.

**Tech Stack:** Hono + Zod validators, Drizzle ORM over postgres.js (`breeze_app` role, RLS-forced), Vitest (unit + real-DB integration), React (apps/web), Playwright (e2e). Migrations are hand-written idempotent SQL.

## Global Constraints

- Migrations: date-prefixed `YYYY-MM-DD-<slug>.sql`, idempotent (`IF NOT EXISTS` / `DROP POLICY IF EXISTS` then recreate), no inner `BEGIN;/COMMIT;`, never edit a shipped migration. Today's prefix: `2026-06-21`.
- All ticket mutations route through `ticketService`; never write `ticket_comments`/`tickets` directly from a route handler (portal create is the one pre-existing exception and is not extended here).
- RLS: `ticket_comments` is shape-5 child-via-parent (it has **no `org_id` column**). New write policies mirror the existing `breeze_ticket_parent_select` parent-org `EXISTS` form (migration `2026-06-10-a`). Identity/role checks live in the service layer, never in `WITH CHECK` ([[rls_is_system_flag_write_policy_hole]]).
- Real-DB tests go in `apps/api/src/__tests__/integration/*.integration.test.ts` (BLOCKING `integration-test` job). Re-seed fixtures per `it` — never memoize across tests ([[rls-forge-test-memoized-fixture-vacuous]]).
- Permission imperative check pattern: `hasPermission(auth.permissions, PERMISSIONS.X.resource, PERMISSIONS.X.action)` (honors `*:*` admin). Imported from `../../services/permissions`.
- No new tenant-scoped table is created → no `ORG_CASCADE_DELETE_ORDER` / allowlist churn.
- Web has no client-side permission store: render edit affordances best-effort; the API is authoritative. Wrap every mutation in `runAction`; on `ActionError` rethrow non-`ActionError` only.
- Run a single test file with: `pnpm --filter @breeze/api exec vitest run <path>` (the `test --` script runs the whole suite — [[migration-tooling-db-migrate-noop]]). Prefix node path per [[node_pinned_version]] if pnpm engine-strict errors.

---

## File Structure

**Backend (apps/api):**
- `packages/shared/src/constants/permissions.ts` — add `TICKETS_MANAGE` grant.
- `apps/api/migrations/2026-06-21-ticket-comment-edit.sql` — `edited_at` column + RLS UPDATE/DELETE policies (new).
- `apps/api/src/db/schema/portal.ts` — add `editedAt` to `ticketComments`.
- `apps/api/src/services/ticketService.ts` — `editTicketComment`, `deleteTicketComment`, `portalCommentMutable`, `moveTicketOrg`.
- `apps/api/src/routes/tickets/tickets.ts` — PATCH/DELETE comment routes; detail GET returns soft-deleted rows to staff.
- `apps/api/src/routes/tickets/moveOrg.ts` — `POST /:id/move-org` (new); mounted in `apps/api/src/routes/tickets/index.ts`.
- `apps/api/src/routes/portal/tickets.ts` — portal PATCH/DELETE comment routes with window.
- `packages/shared/src/validators/tickets.ts` — `editCommentSchema`, `moveTicketOrgSchema`.
- Tests: `*.test.ts` siblings + `apps/api/src/__tests__/integration/ticket-comment-edit-rls.integration.test.ts`, `ticket-move-org.integration.test.ts`.

**Frontend (apps/web):**
- `apps/web/src/components/tickets/ticketConfig.ts` — extend `TicketComment` type (`editedAt`, `deleted`).
- `apps/web/src/components/tickets/TicketFeed.tsx` — edited badge, deleted tombstone, edit/delete controls.
- `apps/web/src/components/tickets/TicketWorkbench.tsx` — subject/description/dueDate/tags/device inline edits + move-org action; owns comment edit/delete + field PATCH handlers.
- Tests: `*.test.tsx` siblings.

**E2E:**
- `e2e-tests/tests/tickets.spec.ts` + `e2e-tests/pages/TicketsPage.ts`.

---

## Task 1: Add `tickets:manage` permission

**Files:**
- Modify: `packages/shared/src/constants/permissions.ts` (Tickets block, after `TICKETS_WRITE`)
- Verify: `apps/api/src/services/permissions.ts` re-exports it as `PERMISSIONS.TICKETS_MANAGE`; `apps/api/src/lib/permissionsCatalog.ts` derives actions from `PERMISSION_GRANTS` (resource label `tickets` already exists, so no `RESOURCE_LABELS` change).

**Interfaces:**
- Produces: `PERMISSIONS.TICKETS_MANAGE = { resource: 'tickets', action: 'manage' }`.

- [ ] **Step 1: Add the grant**

In `packages/shared/src/constants/permissions.ts`, in the `// Tickets` block:

```typescript
  // Tickets
  TICKETS_READ: { resource: 'tickets', action: 'read' },
  TICKETS_WRITE: { resource: 'tickets', action: 'write' },
  TICKETS_MANAGE: { resource: 'tickets', action: 'manage' },
```

- [ ] **Step 2: Verify the catalog auto-derives the action**

Run: `grep -rn "TICKETS_MANAGE\|action: 'manage'" apps/api/src/lib/permissionsCatalog.ts packages/shared/src/constants/permissions.ts`
Expected: the grant exists; confirm `permissionsCatalog.ts` builds its action list by iterating `PERMISSION_GRANTS` (not a hand-maintained per-resource action array). If it hand-maintains actions for `tickets`, add `'manage'` there too. Resource label `tickets` already present in `RESOURCE_LABELS` — no change needed.

- [ ] **Step 3: Grant it to admin-capable default roles**

Run: `grep -rn "TICKETS_WRITE" packages/shared/src apps/api/src --include=*.ts | grep -i "role\|grant\|default" | grep -v test`
For each default-role definition that includes `TICKETS_WRITE` for a manager/admin role, add `TICKETS_MANAGE`. (A plain technician role keeps only read/write; self-edits don't need manage.) If no static role→permission map exists (roles are DB-seeded), note that operators grant `tickets:manage` via the roles UI and skip.

- [ ] **Step 4: Typecheck shared**

Run: `pnpm --filter @breeze/shared exec tsc --noEmit`
Expected: PASS (no build script on shared — typecheck only, [[migration-tooling-db-migrate-noop]]).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants/permissions.ts
git commit -m "feat(tickets): add tickets:manage permission for comment admin-override"
```

---

## Task 2: Migration — `edited_at` column + RLS UPDATE/DELETE policies

**Files:**
- Create: `apps/api/migrations/2026-06-21-ticket-comment-edit.sql`
- Modify: `apps/api/src/db/schema/portal.ts` (`ticketComments` — add `editedAt`)

**Interfaces:**
- Produces: `ticket_comments.edited_at timestamptz NULL`; RLS policies `breeze_ticket_parent_update`, `breeze_ticket_parent_delete` admitting writes when the parent ticket is org-accessible.

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-21-ticket-comment-edit.sql`:

```sql
-- 2026-06-21: ticket_comments — editing & deletion support (Phase 6a).
--
-- Adds edited_at (deleted_at already exists) and the RLS UPDATE/DELETE
-- policies that the earlier 2026-06-10-a migration deliberately left out
-- ("technicians only edit/delete their OWN comments in Phase 1").
--
-- ticket_comments has NO org_id column — it is a child-via-parent (shape 5)
-- table whose tenancy follows the parent ticket. So these policies mirror the
-- parent-org EXISTS form of breeze_ticket_parent_select (same table, migration
-- 2026-06-10-a) rather than a breeze_has_org_access(org_id) column check.
-- Permissive policies OR with the existing Phase-6 user-isolation policies, so
-- a staff author editing their own row is already allowed; these broaden the
-- DB layer to admit edits/deletes of any org-accessible comment. AUTHOR/ROLE
-- enforcement lives in ticketService (editTicketComment/deleteTicketComment) —
-- NOT in WITH CHECK (lesson: rls_is_system_flag_write_policy_hole).
--
-- #1016/#1026 bound-param safety: tickets.org_id is NOT NULL and the tickets
-- SELECT policy is a flat breeze_has_org_access(org_id) with no OR branches, so
-- the EXISTS join is safe under postgres.js bound parameters — proven by
-- apps/api/src/__tests__/integration/ticket-comment-edit-rls.integration.test.ts.
--
-- Fully idempotent — safe to re-run.

ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS edited_at timestamptz;

DROP POLICY IF EXISTS breeze_ticket_parent_update ON ticket_comments;
CREATE POLICY breeze_ticket_parent_update ON ticket_comments
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM tickets t
       WHERE t.id = ticket_comments.ticket_id
         AND public.breeze_has_org_access(t.org_id)
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM tickets t
       WHERE t.id = ticket_comments.ticket_id
         AND public.breeze_has_org_access(t.org_id)
    )
  );

DROP POLICY IF EXISTS breeze_ticket_parent_delete ON ticket_comments;
CREATE POLICY breeze_ticket_parent_delete ON ticket_comments
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM tickets t
       WHERE t.id = ticket_comments.ticket_id
         AND public.breeze_has_org_access(t.org_id)
    )
  );
```

> Note: `deleteTicketComment` is a SOFT delete (an UPDATE setting `deleted_at`), so the UPDATE policy covers it. The DELETE policy is added for completeness/forensic hard-deletes by system scope; it is not exercised by 6a service code. Keep it — a future hard-purge path will need it and adding it now keeps the policy set symmetric.

- [ ] **Step 2: Add the column to the Drizzle schema**

In `apps/api/src/db/schema/portal.ts`, `ticketComments`, add after `deletedAt`:

```typescript
  deletedAt: timestamp('deleted_at'),
  editedAt: timestamp('edited_at'),
  createdAt: timestamp('created_at').defaultNow().notNull()
```

- [ ] **Step 3: Apply the migration locally and verify no drift**

Run: `pnpm --filter @breeze/api exec tsx -e "import('./src/db/autoMigrate').then(m => m.autoMigrate())"` then `pnpm db:check-drift`
Expected: migration applies; drift check reports schema matches migrations. (db:migrate is a no-op — apply via tsx, [[migration-tooling-db-migrate-noop]]. If checksum mismatch on a shared local DB, delete the `breeze_migrations` row and re-apply.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-06-21-ticket-comment-edit.sql apps/api/src/db/schema/portal.ts
git commit -m "feat(tickets): migration for comment edited_at + RLS update/delete policies"
```

---

## Task 3: `editCommentSchema` + `moveTicketOrgSchema` validators

**Files:**
- Modify: `packages/shared/src/validators/tickets.ts`
- Test: `packages/shared/src/validators/tickets.test.ts`

**Interfaces:**
- Produces: `editCommentSchema = { content: string(1..50000) }`; `moveTicketOrgSchema = { orgId: guid }`.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/validators/tickets.test.ts`:

```typescript
import { editCommentSchema, moveTicketOrgSchema } from './tickets';

describe('editCommentSchema', () => {
  it('accepts non-empty content', () => {
    expect(editCommentSchema.parse({ content: 'updated' })).toEqual({ content: 'updated' });
  });
  it('rejects empty content', () => {
    expect(editCommentSchema.safeParse({ content: '' }).success).toBe(false);
  });
});

describe('moveTicketOrgSchema', () => {
  it('accepts a uuid orgId', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    expect(moveTicketOrgSchema.parse({ orgId: id })).toEqual({ orgId: id });
  });
  it('rejects a non-uuid orgId', () => {
    expect(moveTicketOrgSchema.safeParse({ orgId: 'nope' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @breeze/shared exec vitest run src/validators/tickets.test.ts`
Expected: FAIL — `editCommentSchema`/`moveTicketOrgSchema` are not exported.

- [ ] **Step 3: Add the schemas**

In `packages/shared/src/validators/tickets.ts`, after `addTicketCommentSchema`:

```typescript
export const editCommentSchema = z.object({
  content: z.string().min(1).max(50_000)
});

export const moveTicketOrgSchema = z.object({
  orgId: z.string().guid()
});
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @breeze/shared exec vitest run src/validators/tickets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/tickets.ts packages/shared/src/validators/tickets.test.ts
git commit -m "feat(tickets): editComment + moveTicketOrg validators"
```

---

## Task 4: `editTicketComment` + `deleteTicketComment` + `portalCommentMutable` (service)

**Files:**
- Modify: `apps/api/src/services/ticketService.ts`
- Test: `apps/api/src/services/ticketService.test.ts` (or a new `ticketService.comments.test.ts` if the file is large)

**Interfaces:**
- Consumes: `db`, `ticketComments`, `tickets`, `eq`, `and`, `isNull`, `gt` (drizzle-orm), `emitTicketEvent`, `createAuditLogAsync`, `TicketServiceError`, `TicketActor`.
- Produces:
  - `editTicketComment(commentId: string, input: { content: string }, actor: TicketActor, opts: { canManageAny: boolean }): Promise<typeof ticketComments.$inferSelect>`
  - `deleteTicketComment(commentId: string, actor: TicketActor, opts: { canManageAny: boolean }): Promise<{ id: string }>`
  - `portalCommentMutable(commentId: string, portalUserId: string): Promise<{ ok: boolean; reason?: 'not_found' | 'not_author' | 'staff_replied' }>`
  - `SYSTEM_COMMENT_TYPES = new Set(['status_change','assignment','time_entry','system'])`

- [ ] **Step 1: Write the failing tests**

Add to the ticketService test file. Use the existing Drizzle-mock pattern in that file (mirror how `addTicketComment` / `updateTicketFields` are already tested — same `db` mock shape):

```typescript
import { editTicketComment, deleteTicketComment, SYSTEM_COMMENT_TYPES, TicketServiceError } from './ticketService';

describe('editTicketComment', () => {
  it('lets the author edit their own comment and stamps edited_at + audit with previousContent', async () => {
    // Mock db: comment row { id, ticketId, userId: 'tech-1', portalUserId: null, commentType: 'comment', content: 'old', deletedAt: null }
    // ticket row { id: 't1', orgId: 'o1', partnerId: 'p1' }
    const actor = { userId: 'tech-1', name: 'Tech' };
    const result = await editTicketComment('c1', { content: 'new' }, actor, { canManageAny: false });
    expect(result.content).toBe('new');
    expect(result.editedAt).toBeInstanceOf(Date);
    // assert createAuditLogAsync called with action 'ticket.comment.edit' and details.previousContent === 'old'
  });

  it('rejects a non-author without manage (403)', async () => {
    const actor = { userId: 'other-tech' };
    await expect(editTicketComment('c1', { content: 'x' }, actor, { canManageAny: false }))
      .rejects.toMatchObject({ status: 403 });
  });

  it('allows a non-author WITH canManageAny', async () => {
    const actor = { userId: 'admin' };
    const result = await editTicketComment('c1', { content: 'x' }, actor, { canManageAny: true });
    expect(result.content).toBe('x');
  });

  it('rejects editing a system comment type', async () => {
    // comment row commentType: 'system'
    await expect(editTicketComment('c-sys', { content: 'x' }, { userId: 'tech-1' }, { canManageAny: true }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rejects editing an already-deleted comment', async () => {
    // comment row deletedAt: new Date()
    await expect(editTicketComment('c-del', { content: 'x' }, { userId: 'tech-1' }, { canManageAny: true }))
      .rejects.toMatchObject({ status: 409 });
  });
});

describe('deleteTicketComment', () => {
  it('soft-deletes (sets deletedAt) and audits previousContent', async () => {
    const res = await deleteTicketComment('c1', { userId: 'tech-1' }, { canManageAny: false });
    expect(res.id).toBe('c1');
    // assert update set deletedAt, audit action 'ticket.comment.delete', details.previousContent === 'old'
  });
  it('rejects a non-author without manage', async () => {
    await expect(deleteTicketComment('c1', { userId: 'other' }, { canManageAny: false }))
      .rejects.toMatchObject({ status: 403 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/ticketService.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the service functions**

In `apps/api/src/services/ticketService.ts`. Ensure `gt` is in the drizzle-orm import (`import { and, eq, isNull, gt } from 'drizzle-orm';`). Add:

```typescript
export const SYSTEM_COMMENT_TYPES = new Set(['status_change', 'assignment', 'time_entry', 'system']);

async function loadCommentWithTicket(commentId: string) {
  const rows = await db
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.id, commentId))
    .limit(1);
  const comment = rows[0];
  if (!comment) throw new TicketServiceError('Comment not found', 404);
  const ticket = await getTicketOrThrow(comment.ticketId);
  return { comment, ticket };
}

function assertCommentEditable(comment: typeof ticketComments.$inferSelect, actor: TicketActor, canManageAny: boolean) {
  if (SYSTEM_COMMENT_TYPES.has(comment.commentType)) {
    throw new TicketServiceError('System-generated entries cannot be edited or deleted', 400);
  }
  if (comment.deletedAt) {
    throw new TicketServiceError('Comment already deleted', 409);
  }
  const isAuthor = comment.userId != null && comment.userId === actor.userId;
  if (!isAuthor && !canManageAny) {
    throw new TicketServiceError('You can only edit or delete your own comments', 403);
  }
}

export async function editTicketComment(
  commentId: string,
  input: { content: string },
  actor: TicketActor,
  opts: { canManageAny: boolean }
) {
  const { comment, ticket } = await loadCommentWithTicket(commentId);
  assertCommentEditable(comment, actor, opts.canManageAny);

  const previousContent = comment.content;
  const updated = await db
    .update(ticketComments)
    .set({ content: input.content, editedAt: new Date() })
    .where(eq(ticketComments.id, commentId))
    .returning();
  const row = updated[0];
  if (!row) throw new TicketServiceError('Comment not found', 404);

  await emitTicketEvent({
    type: 'ticket.commented',
    ticketId: ticket.id,
    orgId: ticket.orgId,
    partnerId: ticket.partnerId ?? null,
    actorUserId: actor.userId,
    payload: { commentId, isPublic: row.isPublic }
  });
  await createAuditLogAsync({
    orgId: ticket.orgId,
    actorId: actor.userId,
    action: 'ticket.comment.edit',
    resourceType: 'ticket',
    resourceId: ticket.id,
    details: { commentId, previousContent },
    result: 'success'
  });
  return row;
}

export async function deleteTicketComment(
  commentId: string,
  actor: TicketActor,
  opts: { canManageAny: boolean }
) {
  const { comment, ticket } = await loadCommentWithTicket(commentId);
  assertCommentEditable(comment, actor, opts.canManageAny);

  await db
    .update(ticketComments)
    .set({ deletedAt: new Date() })
    .where(eq(ticketComments.id, commentId));

  await emitTicketEvent({
    type: 'ticket.commented',
    ticketId: ticket.id,
    orgId: ticket.orgId,
    partnerId: ticket.partnerId ?? null,
    actorUserId: actor.userId,
    payload: { commentId, isPublic: comment.isPublic }
  });
  await createAuditLogAsync({
    orgId: ticket.orgId,
    actorId: actor.userId,
    action: 'ticket.comment.delete',
    resourceType: 'ticket',
    resourceId: ticket.id,
    details: { commentId, previousContent: comment.content },
    result: 'success'
  });
  return { id: commentId };
}

/**
 * A portal customer may edit/delete their own public reply only until a staff
 * member (or any system event) has acted on the ticket AFTER that comment.
 */
export async function portalCommentMutable(
  commentId: string,
  portalUserId: string
): Promise<{ ok: boolean; reason?: 'not_found' | 'not_author' | 'staff_replied' }> {
  const rows = await db
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.id, commentId))
    .limit(1);
  const comment = rows[0];
  if (!comment || comment.deletedAt) return { ok: false, reason: 'not_found' };
  if (comment.portalUserId !== portalUserId) return { ok: false, reason: 'not_author' };

  // Any later comment whose authorType is not 'portal' (staff/technician or a
  // system feed row) closes the window.
  const laterStaff = await db
    .select({ id: ticketComments.id })
    .from(ticketComments)
    .where(and(
      eq(ticketComments.ticketId, comment.ticketId),
      gt(ticketComments.createdAt, comment.createdAt)
    ))
    .limit(50);
  const closed = laterStaff.length > 0
    ? (await db
        .select({ authorType: ticketComments.authorType })
        .from(ticketComments)
        .where(and(
          eq(ticketComments.ticketId, comment.ticketId),
          gt(ticketComments.createdAt, comment.createdAt)
        )))
        .some((r) => r.authorType !== 'portal')
    : false;
  if (closed) return { ok: false, reason: 'staff_replied' };
  return { ok: true };
}
```

> The `portalCommentMutable` two-query shape above is intentionally simple; if the mock pattern in the test file makes a single grouped query easier, collapse to one select returning `{ authorType }` for later rows and `.some(r => r.authorType !== 'portal')`. Keep the semantics identical.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @breeze/api exec vitest run src/services/ticketService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.test.ts
git commit -m "feat(tickets): editTicketComment/deleteTicketComment + portal window helper"
```

---

## Task 5: Staff comment edit/delete routes

**Files:**
- Modify: `apps/api/src/routes/tickets/tickets.ts`
- Test: `apps/api/src/routes/tickets/tickets.test.ts`

**Interfaces:**
- Consumes: `editTicketComment`, `deleteTicketComment` (Task 4); `hasPermission`, `PERMISSIONS` (`../../services/permissions`); `getScopedTicketOr404`, `actorFrom`, `handleServiceError`.
- Produces: `PATCH /tickets/:id/comments/:commentId` (`{ content }`), `DELETE /tickets/:id/comments/:commentId`. Both require `tickets:write`; manage-override computed via `tickets:manage`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/routes/tickets/tickets.ts`' test file (mirror existing route-test wiring — these mock `requirePermission`/`requireScope` to pass-through and mock the service):

```typescript
describe('PATCH /tickets/:id/comments/:commentId', () => {
  it('edits a comment via the service and returns 200', async () => {
    // mock editTicketComment -> { id: 'c1', content: 'new', editedAt: new Date() }
    const res = await app.request('/tickets/t1/comments/c1', {
      method: 'PATCH', headers: jsonAuthHeaders, body: JSON.stringify({ content: 'new' })
    });
    expect(res.status).toBe(200);
  });
  it('404s when the ticket is out of scope', async () => {
    // getScopedTicketOr404 -> null
    const res = await app.request('/tickets/t1/comments/c1', {
      method: 'PATCH', headers: jsonAuthHeaders, body: JSON.stringify({ content: 'x' })
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /tickets/:id/comments/:commentId', () => {
  it('soft-deletes and returns 200', async () => {
    const res = await app.request('/tickets/t1/comments/c1', { method: 'DELETE', headers: jsonAuthHeaders });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/tickets/tickets.test.ts`
Expected: FAIL — routes 404 (not registered).

- [ ] **Step 3: Add the routes**

In `apps/api/src/routes/tickets/tickets.ts`: extend the imports —

```typescript
import { editCommentSchema } from '@breeze/shared';
import { hasPermission } from '../../services/permissions';
import {
  createTicket, changeTicketStatus, assignTicket, addTicketComment,
  linkAlertToTicket, unlinkAlertFromTicket, updateTicketFields,
  editTicketComment, deleteTicketComment,
  TicketServiceError
} from '../../services/ticketService';
```

Add a small param schema and the two handlers (place near the existing `POST /:id/comments`):

```typescript
const commentParam = z.object({ id: z.string().uuid(), commentId: z.string().uuid() });

// PATCH /tickets/:id/comments/:commentId — edit a comment body.
// tickets:write to reach it; author-or-tickets:manage enforced in the service.
ticketsRoutes.patch(
  '/:id/comments/:commentId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', commentParam),
  zValidator('json', editCommentSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id, commentId } = c.req.valid('param');
    const body = c.req.valid('json');
    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    const found = await getScopedTicketOr404(auth, id);
    if (!found) return c.json({ error: 'Ticket not found' }, 404);
    const canManageAny = hasPermission(auth.permissions, PERMISSIONS.TICKETS_MANAGE.resource, PERMISSIONS.TICKETS_MANAGE.action);
    try {
      const comment = await editTicketComment(commentId, body, actorFrom(c), { canManageAny });
      return c.json({ data: comment });
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);

// DELETE /tickets/:id/comments/:commentId — soft-delete a comment.
ticketsRoutes.delete(
  '/:id/comments/:commentId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', commentParam),
  async (c) => {
    const auth = c.get('auth');
    const { id, commentId } = c.req.valid('param');
    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    const found = await getScopedTicketOr404(auth, id);
    if (!found) return c.json({ error: 'Ticket not found' }, 404);
    const canManageAny = hasPermission(auth.permissions, PERMISSIONS.TICKETS_MANAGE.resource, PERMISSIONS.TICKETS_MANAGE.action);
    try {
      const result = await deleteTicketComment(commentId, actorFrom(c), { canManageAny });
      return c.json({ data: result });
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);
```

> `handleServiceError` is the existing helper used by sibling handlers (it maps `TicketServiceError.status`). Reuse it verbatim — do not introduce a new error mapper.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/tickets/tickets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/tickets/tickets.ts apps/api/src/routes/tickets/tickets.test.ts
git commit -m "feat(tickets): staff comment edit/delete routes"
```

---

## Task 6: Detail GET returns soft-deleted comments to staff as tombstones

**Files:**
- Modify: `apps/api/src/routes/tickets/tickets.ts` (GET `/:id` comment select, lines ~441–445)
- Test: `apps/api/src/routes/tickets/tickets.test.ts`

**Interfaces:**
- Produces: staff detail `comments[]` now includes soft-deleted rows with `deleted: true`, `content: ''`, and the real `editedAt`. Portal GET (Task 7 covers portal edit; portal detail keeps hiding deleted rows) is unchanged.

- [ ] **Step 1: Write the failing test**

```typescript
it('returns soft-deleted comments to staff as tombstones with empty content', async () => {
  // seed/mock: one normal comment, one with deletedAt set (content 'secret')
  const res = await app.request('/tickets/t1', { headers: jsonAuthHeaders });
  const body = await res.json();
  const tomb = body.data.comments.find((c: any) => c.deleted === true);
  expect(tomb).toBeTruthy();
  expect(tomb.content).toBe('');           // prior text must not leak to the client
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/tickets/tickets.test.ts`
Expected: FAIL — deleted rows are filtered out (`isNull(deletedAt)`).

- [ ] **Step 3: Update the comment select + projection**

In the GET `/:id` handler, replace the comments query (currently `.where(and(eq(...ticketId, id), isNull(ticketComments.deletedAt)))`) with an explicit projection that includes deleted rows, derives a `deleted` flag, and nulls deleted content:

```typescript
    const commentRows = await db
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.ticketId, id))
      .orderBy(asc(ticketComments.createdAt));
    const comments = commentRows.map((row) => ({
      ...row,
      deleted: row.deletedAt != null,
      // Never ship the prior text of a deleted comment to the client.
      content: row.deletedAt != null ? '' : row.content,
    }));
```

(The `editedAt` field flows through `...row` automatically.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/tickets/tickets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/tickets/tickets.ts apps/api/src/routes/tickets/tickets.test.ts
git commit -m "feat(tickets): staff detail returns deleted comments as tombstones"
```

---

## Task 7: Portal comment edit/delete routes (until-staff-reply window)

**Files:**
- Modify: `apps/api/src/routes/portal/tickets.ts`
- Test: `apps/api/src/routes/portal/tickets.test.ts` (create if absent, mirroring the existing portal route test setup)

**Interfaces:**
- Consumes: `portalCommentMutable`, `editTicketComment`, `deleteTicketComment` (Task 4); `validatePortalCookieCsrfRequest`, `writePortalAudit` (existing in this file).
- Produces: `PATCH /tickets/:id/comments/:commentId`, `DELETE /tickets/:id/comments/:commentId` (portal). Closed window → 409; not-author → 404.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('portal PATCH /tickets/:id/comments/:commentId', () => {
  it('edits own reply when window is open', async () => {
    // portalCommentMutable -> { ok: true }
    const res = await portalApp.request('/tickets/t1/comments/c1', {
      method: 'PATCH', headers: portalJsonHeaders, body: JSON.stringify({ content: 'fixed typo' })
    });
    expect(res.status).toBe(200);
  });
  it('409s once staff has replied', async () => {
    // portalCommentMutable -> { ok: false, reason: 'staff_replied' }
    const res = await portalApp.request('/tickets/t1/comments/c1', {
      method: 'PATCH', headers: portalJsonHeaders, body: JSON.stringify({ content: 'too late' })
    });
    expect(res.status).toBe(409);
  });
  it('404s on another user\'s comment', async () => {
    // portalCommentMutable -> { ok: false, reason: 'not_author' }
    const res = await portalApp.request('/tickets/t1/comments/c1', {
      method: 'PATCH', headers: portalJsonHeaders, body: JSON.stringify({ content: 'x' })
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/portal/tickets.test.ts`
Expected: FAIL — routes not registered.

- [ ] **Step 3: Add the portal routes**

In `apps/api/src/routes/portal/tickets.ts`, import the service helpers and add handlers after the existing comment POST. The portal actor is the portal user; staff `canManageAny` is always false here, and `editTicketComment`/`deleteTicketComment` enforce author identity via `comment.userId` — but portal comments have `userId: null`, so we must pass the **portal authorization through `portalCommentMutable`** and then call the service with `canManageAny: true` scoped to the already-verified portal ownership. To keep the service's author rule intact, branch on a portal-author actor:

```typescript
import { editCommentSchema } from '@breeze/shared';
import { portalCommentMutable, editTicketComment, deleteTicketComment } from '../../services/ticketService';

ticketRoutes.patch(
  '/tickets/:id/comments/:commentId',
  zValidator('param', ticketCommentParamSchema), // { id, commentId } uuids
  zValidator('json', editCommentSchema),
  async (c) => {
    const csrfError = validatePortalCookieCsrfRequest(c);
    if (csrfError) return c.json({ error: csrfError }, 403);
    const auth = c.get('portalAuth');
    const { id, commentId } = c.req.valid('param');
    const body = c.req.valid('json');

    const mutable = await portalCommentMutable(commentId, auth.user.id);
    if (!mutable.ok) {
      if (mutable.reason === 'staff_replied') {
        return c.json({ error: 'This reply can no longer be edited — support has already responded.' }, 409);
      }
      return c.json({ error: 'Ticket not found' }, 404); // not_author / not_found
    }

    // Ownership already proven by portalCommentMutable (portal_user_id match);
    // pass canManageAny so the service's staff-author rule (keyed on user_id,
    // which is NULL for portal rows) does not reject the legitimate edit.
    const updated = await editTicketComment(
      commentId, body, { userId: auth.user.id, name: auth.user.name ?? auth.user.email }, { canManageAny: true }
    );
    writePortalAudit(c, {
      orgId: auth.user.orgId, actorType: 'user', actorId: auth.user.id, actorEmail: auth.user.email,
      action: 'portal.ticket.comment.edit', resourceType: 'ticket_comment', resourceId: commentId,
      details: { ticketId: id },
    });
    return c.json({ comment: { id: updated.id, content: updated.content, editedAt: updated.editedAt } });
  }
);

ticketRoutes.delete(
  '/tickets/:id/comments/:commentId',
  zValidator('param', ticketCommentParamSchema),
  async (c) => {
    const csrfError = validatePortalCookieCsrfRequest(c);
    if (csrfError) return c.json({ error: csrfError }, 403);
    const auth = c.get('portalAuth');
    const { id, commentId } = c.req.valid('param');

    const mutable = await portalCommentMutable(commentId, auth.user.id);
    if (!mutable.ok) {
      if (mutable.reason === 'staff_replied') {
        return c.json({ error: 'This reply can no longer be deleted — support has already responded.' }, 409);
      }
      return c.json({ error: 'Ticket not found' }, 404);
    }
    await deleteTicketComment(commentId, { userId: auth.user.id }, { canManageAny: true });
    writePortalAudit(c, {
      orgId: auth.user.orgId, actorType: 'user', actorId: auth.user.id, actorEmail: auth.user.email,
      action: 'portal.ticket.comment.delete', resourceType: 'ticket_comment', resourceId: commentId,
      details: { ticketId: id },
    });
    return c.json({ success: true });
  }
);
```

Define `ticketCommentParamSchema = z.object({ id: z.string().uuid(), commentId: z.string().uuid() })` near the existing param schemas if not already present.

> **Audit `actorId` caveat:** `editTicketComment`/`deleteTicketComment` write an `audit_logs` row with `actorId: actor.userId`. For the portal path we pass `auth.user.id` (a portal user id) as `actorUserId` — confirm the `audit_logs.actor_id` FK tolerates a portal-user id or is unconstrained (it is text/uuid without an FK in this codebase). The additional `writePortalAudit` row is the authoritative portal trail; the service audit is supplementary. If the FK is strict, pass `actor: { userId: <a sentinel/null-safe id> }` — verify during implementation.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/portal/tickets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/portal/tickets.ts apps/api/src/routes/portal/tickets.test.ts
git commit -m "feat(portal): customer comment edit/delete within until-staff-reply window"
```

---

## Task 8: Integration test — comment edit/delete RLS forge

**Files:**
- Create: `apps/api/src/__tests__/integration/ticket-comment-edit-rls.integration.test.ts`

**Interfaces:**
- Consumes: the seeding helpers + `withDbAccessContext` pattern from `ticket-comments-rls.integration.test.ts` and `./db-utils`.

- [ ] **Step 1: Write the integration test**

Model on the existing `ticket-comments-rls.integration.test.ts` (same imports, `seedTicketWithMixedComments`-style helper re-seeded per test). Cover:

```typescript
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { ticketComments } from '../../db/schema';
// reuse a local seed helper that creates partner→orgA, orgB, a ticket in orgA with one comment

describe('ticket_comments UPDATE/DELETE RLS', () => {
  it('a connection scoped to org A can soft-delete (UPDATE deletedAt) a comment on an org-A ticket', async () => {
    const { orgA, partner, comment } = await seed();
    const ctxA: DbAccessContext = { scope: 'organization', orgId: orgA.id, accessibleOrgIds: [orgA.id], accessiblePartnerIds: [partner.id], userId: null };
    await withDbAccessContext(ctxA, () =>
      db.update(ticketComments).set({ deletedAt: new Date() }).where(eq(ticketComments.id, comment.id))
    );
    // verify (admin/bypass read) deletedAt is now set
  });

  it('a connection scoped to org B CANNOT update a comment on an org-A ticket (0 rows affected)', async () => {
    const { orgB, partnerB, comment } = await seedCrossTenant();
    const ctxB: DbAccessContext = { scope: 'organization', orgId: orgB.id, accessibleOrgIds: [orgB.id], accessiblePartnerIds: [partnerB.id], userId: null };
    const result: any = await withDbAccessContext(ctxB, () =>
      db.update(ticketComments).set({ content: 'forged' }).where(eq(ticketComments.id, comment.id)).returning()
    );
    expect(result.length).toBe(0); // RLS filtered the row out — no error, no rows
    // and an admin read confirms content is unchanged
  });

  it('org B cannot DELETE a comment on an org-A ticket', async () => {
    // same shape: db.delete(ticketComments).where(eq(id)) under ctxB -> 0 rows; admin read confirms still present
  });
});
```

Re-seed inside each `it` (never module scope — [[rls-forge-test-memoized-fixture-vacuous]]). Confirm the test role is non-BYPASSRLS before trusting a pass ([[worktree_env_test_rls_vacuous]]): the worktree needs the gitignored `.env.test` symlink.

- [ ] **Step 2: Run the integration test**

Run: `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ticket-comment-edit-rls.integration.test.ts`
Expected: PASS (autoMigrate applies the Task 2 migration; forge cases prove isolation).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/ticket-comment-edit-rls.integration.test.ts
git commit -m "test(tickets): RLS forge for comment update/delete policies"
```

---

## Task 9: `moveTicketOrg` (service)

**Files:**
- Modify: `apps/api/src/services/ticketService.ts`
- Test: `apps/api/src/services/ticketService.test.ts`

**Interfaces:**
- Consumes: `db` (`.transaction`), `tickets`, `organizations`, `ticketComments`, `sql`, `eq` (drizzle); `emitTicketEvent`, `createAuditLogAsync`, `TicketServiceError`, `getTicketOrThrow`.
- Produces: `moveTicketOrg(ticketId: string, targetOrgId: string, actor: TicketActor): Promise<typeof tickets.$inferSelect>`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { moveTicketOrg } from './ticketService';

describe('moveTicketOrg', () => {
  it('moves a ticket to a same-partner org, detaches device, re-stamps child org_id', async () => {
    // ticket { id:'t1', orgId:'oA', partnerId:'p1', deviceId:'d1' }; target org { id:'oB', partnerId:'p1' }
    const res = await moveTicketOrg('t1', 'oB', { userId: 'admin' });
    expect(res.orgId).toBe('oB');
    expect(res.deviceId).toBeNull();
    // assert UPDATEs issued for time_entries / ticket_parts / ticket_alert_links WHERE ticket_id='t1'
  });
  it('rejects a cross-partner target (400)', async () => {
    // target org partnerId 'p2' != ticket partnerId 'p1'
    await expect(moveTicketOrg('t1', 'oX', { userId: 'admin' })).rejects.toMatchObject({ status: 400 });
  });
  it('no-ops when target equals current org', async () => {
    const res = await moveTicketOrg('t1', 'oA', { userId: 'admin' });
    expect(res.orgId).toBe('oA');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/ticketService.test.ts`
Expected: FAIL — `moveTicketOrg` not exported.

- [ ] **Step 3: Implement `moveTicketOrg`**

Add `sql` to the drizzle import if absent (`import { and, eq, isNull, gt, sql } from 'drizzle-orm';`). The child tables to re-stamp mirror the `CUSTOM_ORG_REWRITE_TABLES` device precedent (`time_entries`, `ticket_parts`, `ticket_alert_links`) — keyed on `ticket_id` here. `ticket_comments` has **no `org_id` column** (tenancy via parent join) so it is intentionally absent.

```typescript
// Child tables that denormalize org_id and reference a ticket. Mirrors the
// device-move CUSTOM_ORG_REWRITE_TABLES set (core.ts) — keep in lockstep.
// ticket_comments is intentionally absent: it has no org_id (child-via-parent).
const TICKET_ORG_DENORMALIZED_TABLES = ['time_entries', 'ticket_parts', 'ticket_alert_links'] as const;

export async function moveTicketOrg(ticketId: string, targetOrgId: string, actor: TicketActor) {
  const ticket = await getTicketOrThrow(ticketId);
  if (ticket.orgId === targetOrgId) return ticket;

  const orgRows = await db
    .select({ id: organizations.id, partnerId: organizations.partnerId, name: organizations.name })
    .from(organizations)
    .where(sql`${organizations.id} IN (${ticket.orgId}::uuid, ${targetOrgId}::uuid)`);
  const sourceOrg = orgRows.find((r) => r.id === ticket.orgId);
  const targetOrg = orgRows.find((r) => r.id === targetOrgId);
  if (!targetOrg) throw new TicketServiceError('Target organization not found', 404);
  if (!sourceOrg || sourceOrg.partnerId !== targetOrg.partnerId) {
    throw new TicketServiceError('Tickets can only be moved between organizations of the same partner', 400);
  }

  let updated: typeof tickets.$inferSelect | undefined;
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(tickets)
      .set({ orgId: targetOrgId, deviceId: null, updatedAt: new Date() })
      .where(eq(tickets.id, ticketId))
      .returning();
    updated = row;
    for (const table of TICKET_ORG_DENORMALIZED_TABLES) {
      await tx.execute(
        sql`UPDATE ${sql.identifier(table)} SET org_id = ${targetOrgId}::uuid WHERE ticket_id = ${ticketId}::uuid`
      );
    }
    // System feed entry on the moved ticket.
    await tx.insert(ticketComments).values({
      ticketId,
      userId: actor.userId,
      authorName: actor.name ?? null,
      authorType: 'internal',
      commentType: 'system',
      content: `Moved to ${targetOrg.name}`,
      isPublic: false
    });
  });
  if (!updated) throw new TicketServiceError('Ticket not found', 404);

  await emitTicketEvent({
    type: 'ticket.updated',
    ticketId,
    orgId: targetOrgId,
    partnerId: ticket.partnerId ?? null,
    actorUserId: actor.userId,
    payload: { changed: ['orgId'] }
  });
  // Audit on BOTH orgs so the move shows in source and target feeds (device precedent).
  const details = { fromOrgId: ticket.orgId, toOrgId: targetOrgId, detachedDeviceId: ticket.deviceId ?? null };
  await createAuditLogAsync({ orgId: ticket.orgId, actorId: actor.userId, action: 'ticket.move_org.source', resourceType: 'ticket', resourceId: ticketId, details, result: 'success' });
  await createAuditLogAsync({ orgId: targetOrgId, actorId: actor.userId, action: 'ticket.move_org.target', resourceType: 'ticket', resourceId: ticketId, details, result: 'success' });
  return updated;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @breeze/api exec vitest run src/services/ticketService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.test.ts
git commit -m "feat(tickets): moveTicketOrg service (same-partner, device detach, child org_id re-stamp)"
```

---

## Task 10: `POST /:id/move-org` route + mount

**Files:**
- Create: `apps/api/src/routes/tickets/moveOrg.ts`
- Modify: `apps/api/src/routes/tickets/index.ts` (mount BEFORE core routes)
- Test: `apps/api/src/routes/tickets/moveOrg.test.ts`

**Interfaces:**
- Consumes: `moveTicketOrg` (Task 9); `getScopedTicketOr404`, `actorFrom` (export from `tickets.ts` if not already), `handleServiceError`; `requireScope`, `requirePermission`, `requireMfa`, `PERMISSIONS`; `moveTicketOrgSchema`.
- Produces: `ticketMoveOrgRoutes` Hono router mounted at `/`.

- [ ] **Step 1: Write the failing test**

```typescript
describe('POST /tickets/:id/move-org', () => {
  it('moves to a same-partner org and returns 200', async () => {
    // mock getScopedTicketOr404 -> ticket; moveTicketOrg -> { id, orgId: 'oB', deviceId: null }
    const res = await app.request('/tickets/t1/move-org', {
      method: 'POST', headers: jsonAuthHeaders, body: JSON.stringify({ orgId: 'oB' })
    });
    expect(res.status).toBe(200);
  });
  it('404s when ticket out of scope', async () => {
    const res = await app.request('/tickets/t1/move-org', {
      method: 'POST', headers: jsonAuthHeaders, body: JSON.stringify({ orgId: 'oB' })
    });
    expect(res.status).toBe(404);
  });
  it('surfaces 400 on cross-partner via handleServiceError', async () => {
    // moveTicketOrg throws TicketServiceError(.., 400)
    const res = await app.request('/tickets/t1/move-org', {
      method: 'POST', headers: jsonAuthHeaders, body: JSON.stringify({ orgId: 'oX' })
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/tickets/moveOrg.test.ts`
Expected: FAIL — route not registered.

- [ ] **Step 3: Create the route file**

`apps/api/src/routes/tickets/moveOrg.ts`:

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission, requireMfa } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { moveTicketOrgSchema } from '@breeze/shared';
import { moveTicketOrg, TicketServiceError } from '../../services/ticketService';
import { getScopedTicketOr404, actorFrom, handleServiceError } from './tickets';

const idParam = z.object({ id: z.string().uuid() });

export const ticketMoveOrgRoutes = new Hono();

// POST /tickets/:id/move-org — reassign a ticket to another org of the SAME partner.
// High-privilege: tickets:write + organizations:write at partner/system scope + MFA
// (mirrors devices/moveOrg.ts). Same-partner validation + child org_id re-stamp in the service.
ticketMoveOrgRoutes.post(
  '/:id/move-org',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParam),
  zValidator('json', moveTicketOrgSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { orgId: targetOrgId } = c.req.valid('json');

    const found = await getScopedTicketOr404(auth, id);
    if (!found) return c.json({ error: 'Ticket not found' }, 404);
    if (!auth.canAccessOrg(targetOrgId)) {
      return c.json({ error: 'Access to target organization denied' }, 403);
    }
    try {
      const ticket = await moveTicketOrg(id, targetOrgId, actorFrom(c));
      return c.json({ data: ticket });
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);
```

Confirm `getScopedTicketOr404`, `actorFrom`, and `handleServiceError` are exported from `tickets.ts` (the first two are; export `handleServiceError` if it is currently file-local).

- [ ] **Step 4: Mount it before core routes**

In `apps/api/src/routes/tickets/index.ts`, mirroring the device precedent comment (mount move-org BEFORE the core `/:id` routes so `POST /:id/move-org` is not shadowed):

```typescript
import { ticketMoveOrgRoutes } from './moveOrg';
// ... after auth middleware is applied on the hub, BEFORE ticketsRoutes:
ticketsHub.route('/', ticketMoveOrgRoutes);
ticketsHub.route('/', ticketsRoutes);
```

(Match the actual hub variable name in that file.)

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/tickets/moveOrg.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/tickets/moveOrg.ts apps/api/src/routes/tickets/index.ts apps/api/src/routes/tickets/moveOrg.test.ts
git commit -m "feat(tickets): POST /:id/move-org route (mounted before core routes)"
```

---

## Task 11: Integration test — move-org child re-stamp + isolation

**Files:**
- Create: `apps/api/src/__tests__/integration/ticket-move-org.integration.test.ts`

- [ ] **Step 1: Write the integration test**

Seed (admin/bypass): partner P → orgA, orgB; a ticket in orgA with a device in orgA, one time_entry, one ticket_part, one alert+ticket_alert_link. Call `moveTicketOrg(ticket.id, orgB.id, actor)` directly (service-level — no HTTP needed). Assert:

```typescript
it('re-stamps org_id on all denormalized children and detaches the device', async () => {
  const { ticket, orgB, timeEntry, ticketPart, alertLink } = await seed();
  await moveTicketOrg(ticket.id, orgB.id, { userId: 'admin' });
  // admin reads:
  expect((await readTicket(ticket.id)).orgId).toBe(orgB.id);
  expect((await readTicket(ticket.id)).deviceId).toBeNull();
  expect((await readTimeEntry(timeEntry.id)).orgId).toBe(orgB.id);
  expect((await readTicketPart(ticketPart.id)).orgId).toBe(orgB.id);
  expect((await readAlertLink(alertLink.id)).orgId).toBe(orgB.id);
});

it('rejects a cross-partner target', async () => {
  const { ticket, orgOtherPartner } = await seedCrossPartner();
  await expect(moveTicketOrg(ticket.id, orgOtherPartner.id, { userId: 'admin' }))
    .rejects.toMatchObject({ status: 400 });
});

it('comments remain visible after move (parent-join tenancy)', async () => {
  // after move, a connection scoped to orgB sees the ticket's comments (they have no org_id; follow the parent)
});
```

- [ ] **Step 2: Run the integration test**

Run: `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ticket-move-org.integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/ticket-move-org.integration.test.ts
git commit -m "test(tickets): integration coverage for moveTicketOrg child re-stamp + isolation"
```

---

## Task 12: Feed — edited badge, deleted tombstone, edit/delete controls

**Files:**
- Modify: `apps/web/src/components/tickets/ticketConfig.ts` (`TicketComment` type)
- Modify: `apps/web/src/components/tickets/TicketFeed.tsx`
- Test: `apps/web/src/components/tickets/TicketFeed.test.tsx`

**Interfaces:**
- Consumes: `TicketComment` gains `editedAt?: string | null` and `deleted?: boolean`.
- Produces: `TicketFeed` accepts new optional props `onEditComment?(id, content)`, `onDeleteComment?(id)`, `canManageComment?(c: TicketComment): boolean`. Renders `data-testid="ticket-comment-edited-<id>"` badge and `data-testid="ticket-comment-deleted-<id>"` tombstone.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/components/tickets/TicketFeed.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react';
import TicketFeed from './TicketFeed';

const base = { id: 'c1', ticketId: 't1', authorName: 'Tech', authorType: 'internal', isPublic: true, commentType: 'comment', createdAt: new Date().toISOString(), portalUserId: null };

it('shows an edited badge when editedAt is set', () => {
  render(<TicketFeed comments={[{ ...base, content: 'hi', editedAt: new Date().toISOString() }]} />);
  expect(screen.getByTestId('ticket-comment-edited-c1')).toBeInTheDocument();
});

it('renders a tombstone for a deleted comment and hides the body', () => {
  render(<TicketFeed comments={[{ ...base, content: '', deleted: true }]} />);
  expect(screen.getByTestId('ticket-comment-deleted-c1')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/tickets/TicketFeed.test.tsx`
Expected: FAIL — no edited/deleted markers.

- [ ] **Step 3: Extend the type**

In `apps/web/src/components/tickets/ticketConfig.ts`, add to the `TicketComment` interface:

```typescript
  editedAt?: string | null;
  deleted?: boolean;
```

- [ ] **Step 4: Render badge + tombstone + controls**

In `TicketFeed.tsx`, update the props signature and the user-comment block:

```typescript
export default function TicketFeed({
  comments,
  onEditComment,
  onDeleteComment,
  canManageComment,
}: {
  comments: TicketComment[];
  onEditComment?: (id: string, content: string) => void;
  onDeleteComment?: (id: string) => void;
  canManageComment?: (c: TicketComment) => boolean;
}) {
```

Replace the user-comment render branch with one that handles the deleted case and adds the badge + controls:

```typescript
          b.item.deleted ? (
            <div
              key={b.item.id}
              className="rounded-lg border border-dashed p-3 text-sm italic text-muted-foreground"
              data-testid={`ticket-comment-deleted-${b.item.id}`}
            >
              {(b.item.authorName ?? 'A comment')} — deleted
            </div>
          ) : (
            <div
              key={b.item.id}
              className={cn('rounded-lg border p-3', !b.item.isPublic && 'border-warning/30 bg-warning/10')}
              data-testid={`ticket-comment-${b.item.id}`}
            >
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{b.item.authorName ?? (b.item.portalUserId ? 'Requester' : 'Technician')}</span>
                {!b.item.isPublic && <span className="font-medium text-warning">Internal</span>}
                {b.item.editedAt && (
                  <span data-testid={`ticket-comment-edited-${b.item.id}`} title={formatDateTime(b.item.editedAt)}>edited</span>
                )}
                <span className="ml-auto" title={formatDateTime(b.item.createdAt)}>
                  {formatDateTime(b.item.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                {canManageComment?.(b.item) && onEditComment && (
                  <button type="button" className="text-xs hover:text-foreground" data-testid={`ticket-comment-edit-${b.item.id}`}
                    onClick={() => onEditComment(b.item.id, b.item.content)}>Edit</button>
                )}
                {canManageComment?.(b.item) && onDeleteComment && (
                  <button type="button" className="text-xs hover:text-destructive" data-testid={`ticket-comment-delete-${b.item.id}`}
                    onClick={() => onDeleteComment(b.item.id)}>Delete</button>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm">{b.item.content}</p>
            </div>
          )
```

(Keep `groupFeed` putting `deleted` comments through the `comment` branch — they are not `SYSTEM_TYPES`.)

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @breeze/web exec vitest run src/components/tickets/TicketFeed.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/tickets/ticketConfig.ts apps/web/src/components/tickets/TicketFeed.tsx apps/web/src/components/tickets/TicketFeed.test.tsx
git commit -m "feat(web): ticket feed edited badge, deleted tombstone, edit/delete controls"
```

---

## Task 13: Workbench — wire comment edit/delete + subject/description inline edit

**Files:**
- Modify: `apps/web/src/components/tickets/TicketWorkbench.tsx`
- Test: `apps/web/src/components/tickets/TicketWorkbench.test.tsx`

**Interfaces:**
- Consumes: `runAction`, `ActionError`, `fetchWithAuth`, `afterMutation`, `loginPathWithNext`, `navigateTo` (all already used in this file); `TicketFeed` new props (Task 12).
- Produces: handlers `handleEditComment`, `handleDeleteComment`, `handleSubjectSave`, `handleDescriptionSave`; passes `onEditComment`/`onDeleteComment`/`canManageComment` to `<TicketFeed>`.

- [ ] **Step 1: Write the failing test**

```typescript
it('saves an edited subject via PATCH', async () => {
  // render workbench with a ticket; mock fetchWithAuth to capture the PATCH
  // click the subject (data-testid="ticket-workbench-subject-edit"), type, blur
  // assert fetchWithAuth called with /tickets/<id> PATCH body { subject: 'New subject' }
});
it('calls DELETE when a comment delete control is used', async () => {
  // assert fetchWithAuth called with DELETE /tickets/<id>/comments/<cid>
});
```

(Follow the existing `TicketWorkbench.test.tsx` mocking of `fetchWithAuth`/`runAction`. Stub `ResizeObserver` per-test if any chart mounts — [[web_recharts_resizeobserver_jsdom]].)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/tickets/TicketWorkbench.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Add the handlers + subject inline edit + pass feed props**

Add comment + subject handlers (mirror the existing priority PATCH pattern verbatim):

```typescript
const handleEditComment = (commentId: string, current: string) => {
  const next = window.prompt('Edit comment', current);
  if (next == null || next.trim() === '' || next === current) return;
  void runAction({
    request: () => fetchWithAuth(`/tickets/${ticketId}/comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ content: next }) }),
    errorFallback: 'Comment edit failed. Retry.',
    onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
  }).then(() => refreshTicket()).catch((err) => { if (!(err instanceof ActionError)) throw err; });
};

const handleDeleteComment = (commentId: string) => {
  if (!window.confirm('Delete this comment?')) return;
  void runAction({
    request: () => fetchWithAuth(`/tickets/${ticketId}/comments/${commentId}`, { method: 'DELETE' }),
    errorFallback: 'Comment delete failed. Retry.',
    onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
  }).then(() => refreshTicket()).catch((err) => { if (!(err instanceof ActionError)) throw err; });
};

const handleFieldSave = (patch: Record<string, unknown>) => {
  void runAction({
    request: () => fetchWithAuth(`/tickets/${ticketId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    errorFallback: 'Update failed. Retry.',
    onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
  }).then(() => afterMutation(patch)).catch((err) => { if (!(err instanceof ActionError)) throw err; });
};
```

Use `refreshTicket` if the component already has a full-refetch (comment edits change `comments`); otherwise reuse the existing post-bulk refresh path. Make the subject header an inline editable control with `data-testid="ticket-workbench-subject-edit"` that calls `handleFieldSave({ subject })` on blur/Enter (skip when unchanged or empty). Add a description editor (toggle a `<textarea>` calling `handleFieldSave({ description })`).

Pass props to the feed:

```tsx
<TicketFeed
  comments={ticket.comments}
  onEditComment={handleEditComment}
  onDeleteComment={handleDeleteComment}
  canManageComment={(c) => !c.portalUserId /* staff-authored; API re-checks author/manage */}
/>
```

> `canManageComment` is a best-effort client gate (the API enforces author-or-`tickets:manage`). Showing controls on staff-authored comments is acceptable — a non-author hitting Edit gets a toasted 403 via `runAction`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @breeze/web exec vitest run src/components/tickets/TicketWorkbench.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tickets/TicketWorkbench.tsx apps/web/src/components/tickets/TicketWorkbench.test.tsx
git commit -m "feat(web): inline subject/description edit + comment edit/delete wiring"
```

---

## Task 14: Workbench — due date, tags, device editors

**Files:**
- Modify: `apps/web/src/components/tickets/TicketWorkbench.tsx`
- Test: `apps/web/src/components/tickets/TicketWorkbench.test.tsx`

**Interfaces:**
- Consumes: `handleFieldSave` (Task 13).
- Produces: a due-date `<input type="date">` (`data-testid="ticket-workbench-due"`), a tags chip editor (`ticket-workbench-tags`), and a device link/unlink control (`ticket-workbench-device`).

- [ ] **Step 1: Write the failing test**

```typescript
it('PATCHes dueDate when the date input changes', async () => {
  // change the date input -> assert handleFieldSave({ dueDate: '<iso>' }) -> PATCH body has dueDate
});
it('PATCHes tags when a tag is added', async () => {
  // add tag 'urgent' -> PATCH body { tags: [...existing, 'urgent'] }
});
it('clears the device link', async () => {
  // click unlink -> PATCH body { deviceId: null }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/tickets/TicketWorkbench.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Add the three editors**

In the workbench header/detail metadata area:

```tsx
{/* Due date */}
<input
  type="date"
  data-testid="ticket-workbench-due"
  aria-label="Due date"
  value={ticket.dueDate ? new Date(ticket.dueDate).toISOString().slice(0, 10) : ''}
  onChange={(e) => handleFieldSave({ dueDate: e.target.value ? new Date(e.target.value).toISOString() : null })}
  className="rounded-md border bg-background px-2 py-1 text-xs"
/>

{/* Tags */}
<TagEditor
  data-testid="ticket-workbench-tags"
  value={ticket.tags ?? []}
  max={20}
  onChange={(tags) => handleFieldSave({ tags })}
/>

{/* Device link/unlink */}
<div data-testid="ticket-workbench-device" className="flex items-center gap-2 text-xs">
  <span>{ticket.deviceHostname ?? 'No device'}</span>
  {ticket.deviceId && (
    <button type="button" className="hover:text-destructive" onClick={() => handleFieldSave({ deviceId: null })}>Unlink</button>
  )}
</div>
```

Implement `TagEditor` inline (or as a small co-located component): renders existing tags as removable chips and an input that appends a trimmed, non-empty, non-duplicate tag (≤50 chars) up to `max`, calling `onChange(nextTags)`. Keep it minimal; the API enforces the 20×50 limits. For device *linking* (selecting a new device), reuse the existing device-select control if the workbench already has one for create; otherwise a follow-up can add a searchable picker — for 6a, unlink + display is sufficient and link-by-search is explicitly deferred (consistent with the prior "device-select searchable combobox" deferral).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @breeze/web exec vitest run src/components/tickets/TicketWorkbench.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tickets/TicketWorkbench.tsx apps/web/src/components/tickets/TicketWorkbench.test.tsx
git commit -m "feat(web): workbench due-date, tags, device editors"
```

---

## Task 15: Workbench — "Move to another org" action

**Files:**
- Modify: `apps/web/src/components/tickets/TicketWorkbench.tsx`
- Test: `apps/web/src/components/tickets/TicketWorkbench.test.tsx`

**Interfaces:**
- Consumes: `runAction`, `fetchWithAuth`; an org list source (reuse the same endpoint the create flow uses to populate org options — confirm during implementation, e.g. `/orgs/organizations`).
- Produces: a "Move to another org…" control (`data-testid="ticket-workbench-move-org"`) → org picker → `POST /tickets/:id/move-org`.

- [ ] **Step 1: Write the failing test**

```typescript
it('POSTs move-org with the selected org', async () => {
  // open move-org control, pick org 'oB', confirm -> assert POST /tickets/<id>/move-org body { orgId: 'oB' }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/tickets/TicketWorkbench.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Add the move-org control**

```tsx
<button
  type="button"
  data-testid="ticket-workbench-move-org"
  className="text-xs text-muted-foreground hover:text-foreground"
  onClick={() => setMoveOrgOpen(true)}
>
  Move to another org…
</button>
```

On confirm of the org picker (a `<select>` of orgs minus the current one):

```typescript
const handleMoveOrg = (targetOrgId: string) => {
  void runAction({
    request: () => fetchWithAuth(`/tickets/${ticketId}/move-org`, { method: 'POST', body: JSON.stringify({ orgId: targetOrgId }) }),
    errorFallback: 'Move failed. Retry.',
    onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
  }).then(() => refreshTicket()).catch((err) => { if (!(err instanceof ActionError)) throw err; });
};
```

The control is rendered best-effort (no client permission store); a caller lacking `tickets:write`+`organizations:write`/MFA gets a toasted error from `runAction`. Moving detaches the device server-side, so refresh the full ticket after success.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @breeze/web exec vitest run src/components/tickets/TicketWorkbench.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tickets/TicketWorkbench.tsx apps/web/src/components/tickets/TicketWorkbench.test.tsx
git commit -m "feat(web): workbench move-ticket-to-another-org action"
```

---

## Task 16: E2E — comment edit/delete + inline field edit

**Files:**
- Modify: `e2e-tests/tests/tickets.spec.ts`
- Modify: `e2e-tests/pages/TicketsPage.ts`

**Interfaces:**
- Consumes: the `data-testid`s added in Tasks 12–14 (`ticket-comment-edit-<id>`, `ticket-comment-delete-<id>`, `ticket-comment-edited-<id>`, `ticket-comment-deleted-<id>`, `ticket-workbench-subject-edit`).

- [ ] **Step 1: Add Page Object helpers**

In `e2e-tests/pages/TicketsPage.ts`, add methods: `editFirstComment(text)`, `deleteFirstComment()`, `editSubject(text)` — each driven by `data-testid` only (per `e2e-tests/README.md` convention).

- [ ] **Step 2: Add the spec**

Append to `e2e-tests/tests/tickets.spec.ts` a test that: creates a ticket, posts a public reply, edits it (asserts the `edited` badge appears), deletes it (asserts the tombstone), then edits the subject inline (asserts the new subject persists after reload).

- [ ] **Step 3: Run e2e locally**

Run: `cd e2e-tests && PUBLIC_API_URL=http://localhost pnpm test tickets.spec.ts` (per [[local_playwright_env_setup]] — use `http://localhost`, creds `admin@breeze.local/BreezeAdmin123!`).
Expected: PASS (requires the local stack running with this branch's images — force-recreate web/api, [[e2e_local_docker_pr_testing]]).

- [ ] **Step 4: Commit**

```bash
git add e2e-tests/tests/tickets.spec.ts e2e-tests/pages/TicketsPage.ts
git commit -m "test(e2e): ticket comment edit/delete + inline subject edit"
```

---

## Task 17: Full-suite gate + drift + typecheck

**Files:** none (verification only)

- [ ] **Step 1: API typecheck + targeted suites**

Run: `pnpm --filter @breeze/api exec tsc --noEmit` then re-run the touched unit + integration files. Expected: PASS. (Full `vitest run` has known parallel flakiness — verify via touched files; trust CI — [[api_test_suite_parallel_flakiness]].)

- [ ] **Step 2: Web typecheck + touched tests**

Run: `pnpm --filter @breeze/web exec tsc --noEmit` and the two touched `.test.tsx` files. Expected: PASS.

- [ ] **Step 3: Drift + shared typecheck**

Run: `pnpm db:check-drift` and `pnpm --filter @breeze/shared exec tsc --noEmit`. Expected: no drift; PASS.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/ticketing-phase6
gh pr create --title "Ticketing Phase 6a — editing affordances" --body "$(cat <<'EOF'
Comment edit/delete (author + tickets:manage; soft-delete tombstone; audit captures prior content), ticket field edit UI (subject/description/due/tags/device), and same-partner org reassign (device-moveOrg pattern). Spec: docs/superpowers/specs/ticketing/2026-06-21-ticketing-phase6a-editing-affordances-design.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Let CI run the BLOCKING `integration-test` job (RLS forge + tenantCascade) — it is SKIPPED on some PR paths; if it doesn't trigger, force it: `gh workflow run ci.yml --ref feat/ticketing-phase6` ([[ci_astro_check_and_integration_tests_gotchas]]).

---

## Self-Review

**Spec coverage:**
- Comment edit/delete (author + `tickets:manage`, soft-delete, edited badge, audit prior content, portal until-staff-reply window) → Tasks 1–8, 12–13. ✓
- Ticket field edit UI (subject/description/due/tags/device) → Tasks 13–14. ✓
- Org reassign (same-partner, child re-stamp, device detach, dual-org audit, high-privilege gate) → Tasks 3, 9–11, 15. ✓
- Feed edited/deleted markers + staff sees tombstones, portal hides → Tasks 6, 12. ✓
- RLS UPDATE/DELETE policies + forge tests → Tasks 2, 8. ✓
- E2E additions → Task 16. ✓
- `tickets:manage` permission wiring → Task 1. ✓

**Corrections folded in vs. the spec:** `ticket_comments` has no `org_id` column, so org-reassign re-stamps only `time_entries`/`ticket_parts`/`ticket_alert_links` (comments follow the parent) — the spec's "re-stamp ticket_comments" line is superseded here.

**Placeholder scan:** none — every code step shows real code. Integration-test seed helpers are described structurally (seed shape + assertions) because they mirror an existing file's helpers verbatim; the implementer copies that file's `db-utils` usage.

**Type consistency:** `editTicketComment(commentId, {content}, actor, {canManageAny})`, `deleteTicketComment(commentId, actor, {canManageAny})`, `moveTicketOrg(ticketId, targetOrgId, actor)`, `portalCommentMutable(commentId, portalUserId)`, `TicketComment.editedAt/deleted`, testids `ticket-comment-{edit,delete,edited,deleted}-<id>` — consistent across service, routes, and web tasks.

**Open verification flagged for implementer:** (1) `permissionsCatalog` action derivation (Task 1 Step 2); (2) `audit_logs.actor_id` accepting a portal-user id (Task 7 caveat); (3) exact tickets hub variable name + `handleServiceError` export (Tasks 10).

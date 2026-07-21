# Ticketing Integrity Hardening + Site-Axis Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three ticketing-v1 integrity follow-ups (assignee tenant validation, cross-partner category/parent FK checks) and implement the spec §7 site-axis ticket scoping (device-derived; deviceless tickets visible to site-restricted users).

**Architecture:** Tenant validation lives in the service layer (`ticketService.ts`) so routes, bulk, portal, and AI tools all inherit it; parentId checks live in the categories route (no service exists there). DB-level composite FKs (`(category_id, partner_id)` / `(parent_id, partner_id)`) back the app checks, following the `users (org_id, partner_id) → organizations` precedent. Site scoping is app-layer on top of RLS (house pattern from alerts/#1204): a shared `deviceInSiteScope` helper gates per-ticket routes via `getScopedTicketOr404`, and an IN-subquery condition filters list/stats.

**Tech Stack:** Hono routes, Drizzle ORM, Vitest (Drizzle mocks), hand-written idempotent SQL migrations, real-DB integration tests.

**Product decisions (locked with Todd, 2026-06-10):** Device-derived site model (no `tickets.site_id` column); deviceless tickets remain visible to site-restricted users (matches alerts semantics).

**Out of scope:** AI-tools-layer site scoping (known project-wide aiTools scanner gap, tracked separately in `project_aitools_sitescope_layer`); Phases 2-4 (SLA, time tracking, email-to-ticket).

**Environment notes for the executor:**
- Run Node tooling with the pinned Node: prefix commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.
- Run test files individually (`npx vitest run <file>`), not the full suite — the full parallel suite has known pre-existing flakiness. Trust CI for the full matrix.
- All `npx vitest` commands below run from `apps/api/`.
- Integration tests need the local docker Postgres (`breeze-postgres` container) running.

---

## File Structure

| File | Change |
|---|---|
| `apps/api/src/services/ticketService.ts` | Add `resolveTicketPartnerId`, `assertAssigneeInPartner`, `assertCategoryInPartner`; wire into `createTicket`, `assignTicket`, `updateTicketFields` |
| `apps/api/src/services/ticketService.test.ts` | New validation tests; add `users`/`ticketCategories` to schema mock |
| `apps/api/src/routes/ticketCategories.ts` | parentId same-partner + self-parent checks on POST/PATCH |
| `apps/api/src/routes/ticketCategories.test.ts` | parentId validation tests |
| `apps/api/migrations/2026-06-10-c-ticket-category-tenant-fks.sql` | New: UNIQUE(id, partner_id) + two composite FKs + cleanup |
| `apps/api/src/routes/tickets/tickets.ts` | `deviceInSiteScope` helper, site gate in `getScopedTicketOr404`, `ticketSiteScopeCondition` for list/stats, write-side guards on POST `/` and PATCH `/:id` |
| `apps/api/src/routes/tickets/tickets.test.ts` | Site-scope tests; add `siteId` to devices schema mock |
| `apps/api/src/__tests__/integration/site-scope-coverage.integration.test.ts` | Remove the 4 tickets exemption entries |
| `apps/docs/src/content/docs/features/ticketing.mdx` | Document site-scoped visibility |

---

### Task 1: Service-layer assignee tenant validation

**Files:**
- Modify: `apps/api/src/services/ticketService.ts`
- Test: `apps/api/src/services/ticketService.test.ts`

- [ ] **Step 1: Add `users` and `ticketCategories` to the test file's schema mock**

In `ticketService.test.ts`, the `vi.mock('../db/schema', ...)` block (currently lines 56-65) becomes:

```ts
vi.mock('../db/schema', () => ({
  tickets: { id: 'id', orgId: 'orgId', status: 'status', assignedTo: 'assignedTo' },
  ticketComments: {},
  ticketAlertLinks: { ticketId: 'ticketId', alertId: 'alertId' },
  organizations: { id: 'id', partnerId: 'partnerId' },
  alerts: { id: 'id', orgId: 'orgId' },
  devices: { id: 'id', orgId: 'orgId' },
  users: { id: 'id', partnerId: 'partnerId' },
  ticketCategories: { id: 'id', partnerId: 'partnerId' },
  ticketStatusEnum: { enumValues: ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'] },
  ticketSourceEnum: { enumValues: ['portal', 'email', 'alert', 'manual', 'api', 'ai'] }
}));
```

- [ ] **Step 2: Write the failing tests**

Add to `ticketService.test.ts`. Select-call order matters: `dbMocks.selectResult` is consumed once per `db.select(...).limit(1)` in source order. After this task, `createTicket` selects: **org → device (if deviceId) → assignee (if assigneeId) → category (if categoryId)**. `assignTicket` selects: **ticket → assignee (if assigneeId, plus an org lookup first ONLY when ticket.partnerId is null)**.

```ts
describe('assignee tenant validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
    allocateMock.mockResolvedValue('T-2026-0042');
  });

  it('createTicket rejects an assignee from another partner with 400', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])      // org
      .mockResolvedValueOnce([{ id: 'u-evil', partnerId: 'p-OTHER' }]); // assignee

    const err = await createTicket(
      { orgId: 'o-1', subject: 'x', source: 'manual', assigneeId: 'u-evil' }, actor
    ).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(allocateMock).not.toHaveBeenCalled(); // rejected before burning a counter value
  });

  it('createTicket rejects a nonexistent assignee with 404', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }]) // org
      .mockResolvedValueOnce([]);                                // assignee missing

    const err = await createTicket(
      { orgId: 'o-1', subject: 'x', source: 'manual', assigneeId: 'u-ghost' }, actor
    ).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(404);
  });

  it('createTicket accepts a same-partner assignee', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])  // org
      .mockResolvedValueOnce([{ id: 'u-99', partnerId: 'p-1' }]); // assignee
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-2', orgId: 'o-1', internalNumber: 'T-2026-0043', status: 'open' }]);

    await createTicket({ orgId: 'o-1', subject: 'Test', source: 'manual', assigneeId: 'u-99' }, actor);

    expect(valuesMock.mock.calls[0]![0]).toMatchObject({ status: 'open', assignedTo: 'u-99' });
  });

  it('assignTicket rejects an assignee from another partner with 400', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'new', assignedTo: null }]) // ticket
      .mockResolvedValueOnce([{ id: 'u-evil', partnerId: 'p-OTHER' }]);                                        // assignee

    const err = await assignTicket('t-1', 'u-evil', actor).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('assignTicket resolves partner via the org when ticket.partnerId is null (legacy row)', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: null, status: 'new', assignedTo: null }]) // ticket
      .mockResolvedValueOnce([{ partnerId: 'p-1' }])                                                          // org fallback
      .mockResolvedValueOnce([{ id: 'u-2', partnerId: 'p-1' }]);                                              // assignee
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', assignedTo: 'u-2', status: 'open' }]);

    const t = await assignTicket('t-1', 'u-2', actor);
    expect(t.assignedTo).toBe('u-2');
  });

  it('assignTicket skips validation when unassigning (null assignee)', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', assignedTo: 'u-2' }]); // ticket only
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', assignedTo: null }]);

    const t = await assignTicket('t-1', null, actor);
    expect(t.assignedTo).toBeNull();
    expect(dbMocks.selectResult).toHaveBeenCalledTimes(1); // no user lookup
  });
});
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketService.test.ts -t 'assignee tenant validation'`
Expected: FAIL — cross-partner cases resolve instead of throwing (validation doesn't exist yet).

- [ ] **Step 4: Implement the validation in `ticketService.ts`**

Update the schema import (line 4) to include `users` and `ticketCategories` (`ticketCategories` is used in Task 2; adding it now avoids touching the import twice):

```ts
import { tickets, ticketComments, ticketAlertLinks, organizations, alerts, devices, users, ticketCategories, ticketStatusEnum, ticketSourceEnum } from '../db/schema';
```

Add these helpers after `getTicketOrThrow` (after line 49):

```ts
/**
 * Resolve the partner a ticket belongs to. tickets.partner_id is stamped on
 * every create since Phase 1a but is nullable for legacy rows — fall back to
 * the org's partner for those.
 */
async function resolveTicketPartnerId(ticket: { partnerId: string | null; orgId: string }): Promise<string | null> {
  if (ticket.partnerId) return ticket.partnerId;
  const rows = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, ticket.orgId))
    .limit(1);
  return rows[0]?.partnerId ?? null;
}

/**
 * Tenant guard: an assignee must be a user of the same partner as the ticket.
 * users.partner_id is NOT NULL (every user belongs to exactly one MSP), so a
 * same-partner equality check is the complete cross-tenant boundary.
 */
async function assertAssigneeInPartner(assigneeId: string, partnerId: string | null) {
  const rows = await db
    .select({ id: users.id, partnerId: users.partnerId })
    .from(users)
    .where(eq(users.id, assigneeId))
    .limit(1);
  const assignee = rows[0];
  if (!assignee) throw new TicketServiceError('Assignee not found', 404);
  if (!partnerId || assignee.partnerId !== partnerId) {
    throw new TicketServiceError('Assignee must belong to the same partner as the ticket', 400);
  }
}
```

In `createTicket`, after the device cross-org guard (after line 95) and **before** `allocateInternalTicketNumber` (so a rejected create doesn't burn a counter value):

```ts
  if (input.assigneeId) {
    await assertAssigneeInPartner(input.assigneeId, org.partnerId);
  }
```

In `assignTicket`, after `const prevAssignedTo = ticket.assignedTo;` (line 349):

```ts
  if (assigneeId) {
    await assertAssigneeInPartner(assigneeId, await resolveTicketPartnerId(ticket));
  }
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketService.test.ts -t 'assignee tenant validation'`
Expected: PASS (6 tests)

- [ ] **Step 6: Run the whole file; fix any select-order drift in existing tests**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketService.test.ts`

The pre-existing test `inserts with status open when assigneeId is provided` uses a blanket `mockResolvedValue([{ id: 'o-1', partnerId: 'p-1' }])`, which now also serves the assignee lookup and happens to pass (`partnerId: 'p-1'` matches). Make it explicit rather than coincidental — replace its mock setup with:

```ts
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])   // org
      .mockResolvedValueOnce([{ id: 'u-99', partnerId: 'p-1' }]); // assignee
```

If any `createTicketFromAlert` test passes `assigneeId` in overrides, add the assignee row to its select sequence the same way (alert → org → assignee).
Expected: PASS, all tests.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.test.ts
git commit -m "fix(tickets): validate assignee belongs to the ticket's partner"
```

---

### Task 2: Service-layer categoryId partner validation

**Files:**
- Modify: `apps/api/src/services/ticketService.ts`
- Test: `apps/api/src/services/ticketService.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `ticketService.test.ts`. `updateTicketFields` selects: **ticket → device (if deviceId is a string) → category (if categoryId is a string)**.

```ts
describe('category tenant validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
    allocateMock.mockResolvedValue('T-2026-0042');
  });

  it('createTicket rejects a category from another partner with 400', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])        // org
      .mockResolvedValueOnce([{ id: 'cat-1', partnerId: 'p-OTHER' }]); // category

    const err = await createTicket(
      { orgId: 'o-1', subject: 'x', source: 'manual', categoryId: 'cat-1' }, actor
    ).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(allocateMock).not.toHaveBeenCalled();
  });

  it('createTicket rejects a nonexistent category with 404', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }]) // org
      .mockResolvedValueOnce([]);                                // category missing

    const err = await createTicket(
      { orgId: 'o-1', subject: 'x', source: 'manual', categoryId: 'cat-ghost' }, actor
    ).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(404);
  });

  it('createTicket accepts a same-partner category', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])    // org
      .mockResolvedValueOnce([{ id: 'cat-1', partnerId: 'p-1' }]); // category
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-3', orgId: 'o-1', internalNumber: 'T-2026-0044', status: 'new' }]);

    await createTicket({ orgId: 'o-1', subject: 'x', source: 'manual', categoryId: 'cat-1' }, actor);

    expect(valuesMock.mock.calls[0]![0]).toMatchObject({ categoryId: 'cat-1' });
  });

  it('updateTicketFields rejects a cross-partner category with 400', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', categoryId: null, subject: 'Printer' }]) // ticket
      .mockResolvedValueOnce([{ id: 'cat-1', partnerId: 'p-OTHER' }]);                                              // category

    const err = await updateTicketFields('t-1', { categoryId: 'cat-1' }, actor).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('updateTicketFields allows clearing the category (null) without a lookup', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', categoryId: 'cat-1', subject: 'Printer' }]); // ticket only
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', categoryId: null }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]); // system feed comment insert

    const t = await updateTicketFields('t-1', { categoryId: null }, actor);
    expect(t.categoryId).toBeNull();
    expect(dbMocks.selectResult).toHaveBeenCalledTimes(1); // no category lookup
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketService.test.ts -t 'category tenant validation'`
Expected: FAIL — cross-partner cases resolve instead of throwing.

- [ ] **Step 3: Implement**

Add this helper next to `assertAssigneeInPartner` in `ticketService.ts`:

```ts
/** Tenant guard: a ticket's category must belong to the ticket's partner. */
async function assertCategoryInPartner(categoryId: string, partnerId: string | null) {
  const rows = await db
    .select({ id: ticketCategories.id, partnerId: ticketCategories.partnerId })
    .from(ticketCategories)
    .where(eq(ticketCategories.id, categoryId))
    .limit(1);
  const category = rows[0];
  if (!category) throw new TicketServiceError('Category not found', 404);
  if (!partnerId || category.partnerId !== partnerId) {
    throw new TicketServiceError('Category must belong to the same partner as the ticket', 400);
  }
}
```

In `createTicket`, directly after the assignee check added in Task 1 (still before `allocateInternalTicketNumber`):

```ts
  if (input.categoryId) {
    await assertCategoryInPartner(input.categoryId, org.partnerId);
  }
```

In `updateTicketFields`, after the device cross-org guard (after line 290; `null` clears the category and needs no lookup):

```ts
  if (typeof fields.categoryId === 'string') {
    await assertCategoryInPartner(fields.categoryId, await resolveTicketPartnerId(ticket));
  }
```

- [ ] **Step 4: Run the file to verify everything passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketService.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.test.ts
git commit -m "fix(tickets): validate categoryId belongs to the ticket's partner"
```

---

### Task 3: ticket_categories parentId validation (routes)

**Files:**
- Modify: `apps/api/src/routes/ticketCategories.ts`
- Test: `apps/api/src/routes/ticketCategories.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `ticketCategories.test.ts` (reuses the existing `makeApp`/`resetAuth`/`dbSelectResult` fixtures; `dbSelectResult` serves `where(...).limit(1)` lookups):

```ts
describe('parentId tenant validation', () => {
  const CAT_ID = '3f2f1d8e-1111-4222-8333-444455556666';
  const PARENT_ID = '9a8b7c6d-2222-4333-8444-555566667777';

  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('POST rejects a parent category from another partner with 400', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: PARENT_ID, partnerId: 'p-OTHER' }]); // parent lookup
    const res = await makeApp().request('/ticket-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sub', parentId: PARENT_ID })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Parent category not found');
  });

  it('POST rejects a nonexistent parent with 400', async () => {
    dbSelectResult.mockResolvedValueOnce([]); // parent lookup
    const res = await makeApp().request('/ticket-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sub', parentId: PARENT_ID })
    });
    expect(res.status).toBe(400);
  });

  it('POST accepts a same-partner parent', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: PARENT_ID, partnerId: 'p-1' }]); // parent lookup
    dbInsertReturning.mockResolvedValue([{ id: CAT_ID, name: 'Sub', partnerId: 'p-1', parentId: PARENT_ID }]);
    const res = await makeApp().request('/ticket-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sub', parentId: PARENT_ID })
    });
    expect(res.status).toBe(201);
  });

  it('PATCH rejects making a category its own parent with 400', async () => {
    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: CAT_ID })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Category cannot be its own parent');
  });

  it('PATCH rejects a cross-partner parent with 400', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: PARENT_ID, partnerId: 'p-OTHER' }]); // parent lookup
    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: PARENT_ID })
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error', 'Parent category not found');
  });

  it('PATCH accepts a same-partner parent', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: PARENT_ID, partnerId: 'p-1' }]); // parent lookup
    dbUpdateReturning.mockResolvedValue([{ id: CAT_ID, partnerId: 'p-1', parentId: PARENT_ID }]);
    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: PARENT_ID })
    });
    expect(res.status).toBe(200);
  });

  it('PATCH under system scope validates the parent against the category own partner', async () => {
    resetAuth({ scope: 'system', partnerId: null });
    dbSelectResult
      .mockResolvedValueOnce([{ partnerId: 'p-1' }])                     // target category lookup
      .mockResolvedValueOnce([{ id: PARENT_ID, partnerId: 'p-OTHER' }]); // parent lookup
    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: PARENT_ID })
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/ticketCategories.test.ts -t 'parentId tenant validation'`
Expected: FAIL — cross-partner POST/PATCH currently return 201/200.

- [ ] **Step 3: Implement in `ticketCategories.ts`**

In the **POST** handler, after the `if (!auth.partnerId)` guard (after line 79) and before the insert:

```ts
    const body = c.req.valid('json');

    // Tenant guard: a parent category must exist within the same partner.
    // The DB composite FK (parent_id, partner_id) backs this; checking here
    // returns a clean 400 instead of a constraint-violation 500.
    if (body.parentId) {
      const parentRows = await db
        .select({ id: ticketCategories.id, partnerId: ticketCategories.partnerId })
        .from(ticketCategories)
        .where(eq(ticketCategories.id, body.parentId))
        .limit(1);
      const parent = parentRows[0];
      if (!parent || parent.partnerId !== auth.partnerId) {
        return c.json({ error: 'Parent category not found' }, 400);
      }
    }
```

(The existing `const body = c.req.valid('json');` at line 80 moves up to feed this check — don't declare it twice.)

In the **PATCH** handler, after `const body = c.req.valid('json');` (line 104) and before building `conditions`:

```ts
    if (typeof body.parentId === 'string') {
      if (body.parentId === id) {
        return c.json({ error: 'Category cannot be its own parent' }, 400);
      }
      // Partner scope: the caller's partner is authoritative. System scope:
      // resolve the target category's partner and validate against that.
      let targetPartnerId: string | null = auth.scope === 'partner' ? (auth.partnerId ?? null) : null;
      if (!targetPartnerId) {
        const catRows = await db
          .select({ partnerId: ticketCategories.partnerId })
          .from(ticketCategories)
          .where(eq(ticketCategories.id, id))
          .limit(1);
        targetPartnerId = catRows[0]?.partnerId ?? null;
        if (!targetPartnerId) return c.json({ error: 'Category not found' }, 404);
      }
      const parentRows = await db
        .select({ id: ticketCategories.id, partnerId: ticketCategories.partnerId })
        .from(ticketCategories)
        .where(eq(ticketCategories.id, body.parentId))
        .limit(1);
      const parent = parentRows[0];
      if (!parent || parent.partnerId !== targetPartnerId) {
        return c.json({ error: 'Parent category not found' }, 400);
      }
    }
```

- [ ] **Step 4: Run the whole file to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/ticketCategories.test.ts`
Expected: PASS, all tests (existing + 7 new).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/ticketCategories.ts apps/api/src/routes/ticketCategories.test.ts
git commit -m "fix(tickets): validate category parentId is same-partner, reject self-parent"
```

---

### Task 4: DB composite tenant FKs (migration)

**Files:**
- Create: `apps/api/migrations/2026-06-10-c-ticket-category-tenant-fks.sql`
- Modify (comments only): `apps/api/src/db/schema/tickets.ts`, `apps/api/src/db/schema/portal.ts`

Precedent: `users (org_id, partner_id) → organizations (id, partner_id)` — composite FKs live in hand-written SQL only (no Drizzle `foreignKey()`), documented with a schema comment. The `-c-` infix makes this sort after today's `-a-`/`-b-` migrations (same-day ordering rule).

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-10-c-ticket-category-tenant-fks.sql`:

```sql
-- Cross-partner FK hardening (ticketing v1 follow-up).
-- tickets.category_id and ticket_categories.parent_id were plain id FKs, so a
-- forged request could reference another partner's category. App-layer checks
-- land in the same PR; these composite FKs enforce the boundary at the DB
-- level too (precedent: users (org_id, partner_id) -> organizations).
--
-- The original simple FKs (ON DELETE SET NULL) are kept: their per-row SET
-- NULL runs before the composite NO ACTION check at end of statement, so
-- category deletes still null out references cleanly. MATCH SIMPLE means rows
-- with NULL category_id/parent_id (or legacy NULL tickets.partner_id) pass.

-- FK target: (id, partner_id) must be unique.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_categories_id_partner_id_key') THEN
    ALTER TABLE ticket_categories ADD CONSTRAINT ticket_categories_id_partner_id_key UNIQUE (id, partner_id);
  END IF;
END $$;

-- Clean up any pre-existing cross-partner references before adding the FKs
-- (idempotent; no-op on healthy data).
UPDATE tickets t SET category_id = NULL
WHERE t.category_id IS NOT NULL AND t.partner_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM ticket_categories tc
    WHERE tc.id = t.category_id AND tc.partner_id = t.partner_id
  );

UPDATE ticket_categories c SET parent_id = NULL
WHERE c.parent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM ticket_categories p
    WHERE p.id = c.parent_id AND p.partner_id = c.partner_id
  );

-- A ticket's category must belong to the ticket's partner.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_category_partner_fkey') THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_category_partner_fkey
      FOREIGN KEY (category_id, partner_id) REFERENCES ticket_categories (id, partner_id);
  END IF;
END $$;

-- A category's parent must belong to the same partner.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_categories_parent_partner_fkey') THEN
    ALTER TABLE ticket_categories ADD CONSTRAINT ticket_categories_parent_partner_fkey
      FOREIGN KEY (parent_id, partner_id) REFERENCES ticket_categories (id, partner_id);
  END IF;
END $$;
```

- [ ] **Step 2: Document the SQL-only constraints in the Drizzle schema**

In `apps/api/src/db/schema/tickets.ts`, extend the comment on `parentId` (line 20):

```ts
  // Composite FK (parent_id, partner_id) -> (id, partner_id) lives in SQL only
  // (2026-06-10-c migration) — same-partner parents enforced at the DB level.
  parentId: uuid('parent_id').references((): AnyPgColumn => ticketCategories.id, { onDelete: 'set null' }),
```

In `apps/api/src/db/schema/portal.ts`, extend the comment on `categoryId` (line 71):

```ts
  categoryId: uuid('category_id'), // FK created in SQL; no .references() here to avoid an import cycle with schema/tickets.ts. Composite (category_id, partner_id) -> ticket_categories also in SQL (2026-06-10-c) — same-partner categories enforced at the DB level.
```

- [ ] **Step 3: Apply the migration twice against the local DB (idempotency check)**

```bash
docker exec -i breeze-postgres psql -U breeze -d breeze < apps/api/migrations/2026-06-10-c-ticket-category-tenant-fks.sql
docker exec -i breeze-postgres psql -U breeze -d breeze < apps/api/migrations/2026-06-10-c-ticket-category-tenant-fks.sql
```

Expected: both runs complete without errors; second run is a no-op (DO blocks skip, UPDATEs touch 0 rows). (autoMigrate will later record it in `breeze_migrations`; manual pre-apply is safe because the file is idempotent.)

- [ ] **Step 4: Forge a cross-partner reference to prove the FK blocks it**

```bash
docker exec -i breeze-postgres psql -U breeze -d breeze <<'SQL'
BEGIN;
INSERT INTO partners (id, name) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'fk-test-p1'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'fk-test-p2');
INSERT INTO ticket_categories (id, partner_id, name) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'fk-test-cat-p1');
-- Cross-partner parent: must fail with ticket_categories_parent_partner_fkey
INSERT INTO ticket_categories (partner_id, name, parent_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000002', 'fk-test-child', 'bbbbbbbb-0000-0000-0000-000000000001');
ROLLBACK;
SQL
```

Expected: ERROR `insert or update on table "ticket_categories" violates foreign key constraint "ticket_categories_parent_partner_fkey"`. The transaction rolls back regardless, leaving no test rows. (If the `partners` insert fails on other NOT NULL columns, add the minimum required columns — inspect with `\d partners` — the point is the FK error on the last insert.)

- [ ] **Step 5: Run migration-ordering regression test and drift check**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/db/autoMigrate.test.ts
cd /Users/toddhebebrand/breeze && export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
```

Expected: ordering test PASS; drift check clean (constraints added in SQL-only don't register as drift — precedent: the users composite FK).

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-06-10-c-ticket-category-tenant-fks.sql apps/api/src/db/schema/tickets.ts apps/api/src/db/schema/portal.ts
git commit -m "fix(tickets): composite (id, partner_id) FKs for category and parent references"
```

---

### Task 5: Site-axis gate on per-ticket routes (`getScopedTicketOr404`)

**Files:**
- Modify: `apps/api/src/routes/tickets/tickets.ts`
- Test: `apps/api/src/routes/tickets/tickets.test.ts`

Every per-ticket route (GET/PATCH `/:id`, status, assign, comments, alert links, and the bulk loop) resolves the ticket through `getScopedTicketOr404` — gating there covers them all. Semantics: a site-restricted caller (`auth.allowedSiteIds` defined — org-scope users only) gets 404 for a ticket whose device is outside their sites; deviceless tickets stay visible (locked product decision). A restricted caller is denied for a device with no site assignment (matches `siteAccessCheck` semantics).

- [ ] **Step 1: Add `siteId` to the devices schema mock in `tickets.test.ts`**

In the `vi.mock('../../db/schema', ...)` block, change the `devices` line to:

```ts
  devices: { id: 'id', hostname: 'hostname', orgId: 'orgId', siteId: 'siteId' },
```

- [ ] **Step 2: Write the failing tests**

Add to `tickets.test.ts`. `dbSelectMock` serves both the `from().where().limit(1)` lookup path (ticket fetch, device fetch) and the triple-leftJoin list/decoration path — sequence with `mockResolvedValueOnce`.

```ts
describe('site-axis scoping — per-ticket routes', () => {
  const SITE_AUTH = {
    ...DEFAULT_AUTH,
    scope: 'organization' as string,
    orgId: 'org-1' as string | null,
    partnerId: null as string | null,
    allowedSiteIds: ['site-1']
  };

  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = SITE_AUTH as typeof authRef.current;
  });

  it('GET /tickets/:id returns 404 for a ticket whose device is outside the caller sites', async () => {
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: 'd-1' }]) // ticket fetch
      .mockResolvedValueOnce([{ siteId: 'site-OTHER' }]);                            // device fetch
    const res = await makeApp().request(`/tickets/${TICKET_ID}`);
    expect(res.status).toBe(404);
  });

  it('GET /tickets/:id returns 404 when the ticket device has no site (restricted caller)', async () => {
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: 'd-1' }]) // ticket fetch
      .mockResolvedValueOnce([{ siteId: null }]);                                    // device fetch
    const res = await makeApp().request(`/tickets/${TICKET_ID}`);
    expect(res.status).toBe(404);
  });

  it('GET /tickets/:id keeps deviceless tickets visible to site-restricted callers', async () => {
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: null }]) // ticket fetch
      .mockResolvedValueOnce([{ orgName: 'Org', deviceHostname: null, assigneeName: null }]) // decoration
      .mockResolvedValueOnce([]); // alert links
    const res = await makeApp().request(`/tickets/${TICKET_ID}`);
    expect(res.status).toBe(200);
  });

  it('POST /tickets/:id/assign is blocked (404) for an out-of-site ticket', async () => {
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: 'd-1' }]) // ticket fetch
      .mockResolvedValueOnce([{ siteId: 'site-OTHER' }]);                            // device fetch
    const res = await makeApp().request(`/tickets/${TICKET_ID}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigneeId: null })
    });
    expect(res.status).toBe(404);
    expect(serviceMocks.assignTicket).not.toHaveBeenCalled();
  });

  it('unrestricted callers (no allowedSiteIds) skip the device lookup entirely', async () => {
    authRef.current = { ...DEFAULT_AUTH } as typeof authRef.current; // partner scope, unrestricted
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, deviceId: 'd-1' }])                                  // ticket fetch
      .mockResolvedValueOnce([{ orgName: 'Org', deviceHostname: 'host', assigneeName: null }])       // decoration
      .mockResolvedValueOnce([]);                                                                     // alert links
    const res = await makeApp().request(`/tickets/${TICKET_ID}`);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/tickets/tickets.test.ts -t 'site-axis scoping — per-ticket routes'`
Expected: FAIL — the out-of-site cases currently return 200 (only the deviceless/unrestricted tests may pass).

- [ ] **Step 4: Implement in `tickets.ts`**

Add a helper after `getScopedTicketOr404` (after line 80):

```ts
/**
 * Site-axis (sub-org) device gate. `auth.allowedSiteIds` is only populated for
 * organization-scope users with a site restriction — everyone else passes.
 * A restricted caller is denied for a device with no site assignment
 * (matches siteAccessCheck semantics in middleware/auth.ts).
 */
async function deviceInSiteScope(auth: AuthContext, deviceId: string): Promise<boolean> {
  if (!auth.allowedSiteIds) return true;
  const rows = await db
    .select({ siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  const siteId = rows[0]?.siteId;
  return !!siteId && auth.allowedSiteIds.includes(siteId);
}
```

In `getScopedTicketOr404`, replace the final `return rows[0] ?? null;` (line 79) with:

```ts
  const ticket = rows[0] ?? null;
  if (!ticket) return null;

  // Site-axis restriction (spec §7): a device-bound ticket is visible only when
  // its device's site is in the caller's allowlist. Deviceless (org-level)
  // tickets stay visible — they aren't site-bound (matches alerts semantics).
  if (ticket.deviceId && !(await deviceInSiteScope(auth, ticket.deviceId))) {
    return null;
  }
  return ticket;
```

- [ ] **Step 5: Run the file to verify everything passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/tickets/tickets.test.ts`
Expected: PASS, all tests (existing tests use unrestricted auth contexts and are unaffected).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/tickets/tickets.ts apps/api/src/routes/tickets/tickets.test.ts
git commit -m "feat(tickets): site-axis gate on per-ticket routes via getScopedTicketOr404"
```

---

### Task 6: Site-axis filter on list and stats

**Files:**
- Modify: `apps/api/src/routes/tickets/tickets.ts`
- Test: `apps/api/src/routes/tickets/tickets.test.ts`

An IN-subquery condition (`tickets.deviceId IN (SELECT id FROM devices WHERE site_id = ANY(allowed))`) rather than a join, so the same condition drops into the list query, its count query, and the stats query without structural changes. Empty allowlist = deviceless tickets only (alerts semantics).

- [ ] **Step 1: Write the failing tests**

Add to `tickets.test.ts` inside a new describe (same `SITE_AUTH` shape as Task 5 — redeclare it locally):

```ts
describe('site-axis scoping — list and stats', () => {
  const SITE_AUTH = {
    ...DEFAULT_AUTH,
    scope: 'organization' as string,
    orgId: 'org-1' as string | null,
    partnerId: null as string | null,
    allowedSiteIds: ['site-1']
  };

  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = SITE_AUTH as typeof authRef.current;
  });

  it('GET /tickets returns 403 when filtering by an out-of-site deviceId', async () => {
    dbSelectMock.mockResolvedValueOnce([{ siteId: 'site-OTHER' }]); // device lookup
    const res = await makeApp().request('/tickets?deviceId=9a8b7c6d-2222-4333-8444-555566667777');
    expect(res.status).toBe(403);
    expect(await res.json()).toHaveProperty('error', 'Device not found or access denied');
  });

  it('GET /tickets returns 403 when filtering by a nonexistent deviceId', async () => {
    dbSelectMock.mockResolvedValueOnce([]); // device lookup
    const res = await makeApp().request('/tickets?deviceId=9a8b7c6d-2222-4333-8444-555566667777');
    expect(res.status).toBe(403);
  });

  it('GET /tickets succeeds for a site-restricted caller (condition applied, no crash)', async () => {
    dbSelectMock.mockResolvedValue([]); // list rows (subquery is built, never executed)
    const res = await makeApp().request('/tickets');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  it('GET /tickets/stats succeeds for a site-restricted caller', async () => {
    dbGroupByMock.mockResolvedValue([
      { status: 'open', assignedTo: 'u-1', breached: false, count: 2 }
    ]);
    const res = await makeApp().request('/tickets/stats');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ open: 2, mine: 2 });
  });
});
```

(The route mocks never execute SQL, so these list/stats tests are smoke-level — they prove the condition builds without throwing and the handlers still work. The behavioral proof for the filter itself is the integration scanner in Task 8 plus the `deviceInSiteScope` unit tests in Tasks 5/7.)

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/tickets/tickets.test.ts -t 'site-axis scoping — list and stats'`
Expected: the two 403 tests FAIL (currently 200); the smoke tests may already pass.

- [ ] **Step 3: Implement in `tickets.ts`**

Add next to `deviceInSiteScope`:

```ts
/**
 * Site-axis list condition (spec §7): device-bound tickets are limited to
 * devices in the caller's allowed sites; deviceless (org-level) tickets stay
 * visible. Uses an IN-subquery on devices instead of a join so the same
 * condition works for the list, count, and stats queries unchanged. Empty
 * allowlist = deviceless tickets only. Returns undefined for unrestricted
 * callers (partner/system scope, or org users without a site restriction).
 */
function ticketSiteScopeCondition(auth: AuthContext): SQL | undefined {
  const allowed = auth.allowedSiteIds;
  if (!allowed) return undefined;
  if (allowed.length === 0) return isNull(tickets.deviceId);
  return or(
    isNull(tickets.deviceId),
    inArray(
      tickets.deviceId,
      db.select({ id: devices.id }).from(devices).where(inArray(devices.siteId, allowed))
    )
  )!;
}
```

In the **GET `/`** handler: replace the plain deviceId filter line (line 167, `if (q.deviceId) conditions.push(eq(tickets.deviceId, q.deviceId));`) with a site-checked version, and append the scope condition after the org/partner conditions:

```ts
    if (q.deviceId) {
      // Site gate on the explicit device filter (alerts pattern): a restricted
      // caller asking for a device outside their sites gets a hard 403, not an
      // empty list, so the failure is visible.
      if (!(await deviceInSiteScope(auth, q.deviceId))) {
        return c.json({ error: 'Device not found or access denied' }, 403);
      }
      conditions.push(eq(tickets.deviceId, q.deviceId));
    }
    const siteCondition = ticketSiteScopeCondition(auth);
    if (siteCondition) conditions.push(siteCondition);
```

In the **GET `/stats`** handler, after `const conditions: SQL[] = scopeResult;` (line 118):

```ts
    // Site-axis restriction: stats must not leak counts for out-of-site
    // device-bound tickets (deviceless tickets remain counted).
    const siteCondition = ticketSiteScopeCondition(auth);
    if (siteCondition) conditions.push(siteCondition);
```

- [ ] **Step 4: Run the file to verify everything passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/tickets/tickets.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/tickets/tickets.ts apps/api/src/routes/tickets/tickets.test.ts
git commit -m "feat(tickets): site-axis filtering on ticket list and stats"
```

---

### Task 7: Write-side site guards (create + device reassignment)

**Files:**
- Modify: `apps/api/src/routes/tickets/tickets.ts`
- Test: `apps/api/src/routes/tickets/tickets.test.ts`

A site-restricted caller must not open a ticket against, or move a ticket onto, a device outside their sites (mirror of automations #1204 write-side enforcement). Deviceless creates stay allowed. The PATCH route's *existing-ticket* gate already comes from Task 5; this adds the *new device* check.

- [ ] **Step 1: Write the failing tests**

Add to `tickets.test.ts`:

```ts
describe('site-axis scoping — write guards', () => {
  const SITE_AUTH = {
    ...DEFAULT_AUTH,
    scope: 'organization' as string,
    orgId: 'org-1' as string | null,
    partnerId: null as string | null,
    allowedSiteIds: ['site-1']
  };
  const DEVICE_ID = '9a8b7c6d-2222-4333-8444-555566667777';

  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = SITE_AUTH as typeof authRef.current;
  });

  it('POST /tickets returns 403 for a deviceId outside the caller sites', async () => {
    dbSelectMock.mockResolvedValueOnce([{ siteId: 'site-OTHER' }]); // device lookup
    const res = await makeApp().request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID, subject: 'x', deviceId: DEVICE_ID })
    });
    expect(res.status).toBe(403);
    expect(serviceMocks.createTicket).not.toHaveBeenCalled();
  });

  it('POST /tickets allows a deviceless create for a site-restricted caller', async () => {
    serviceMocks.createTicket.mockResolvedValue({ id: 't-1', orgId: ORG_ID, internalNumber: 'T-2026-0042' });
    const res = await makeApp().request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID, subject: 'x' })
    });
    expect(res.status).toBe(201);
  });

  it('PATCH /tickets/:id returns 403 when moving a ticket onto an out-of-site device', async () => {
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: null }]) // ticket fetch (in scope: deviceless)
      .mockResolvedValueOnce([{ siteId: 'site-OTHER' }]);                           // new device lookup
    const res = await makeApp().request(`/tickets/${TICKET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID })
    });
    expect(res.status).toBe(403);
    expect(serviceMocks.updateTicketFields).not.toHaveBeenCalled();
  });

  it('PATCH /tickets/:id allows clearing the device (null) without a lookup', async () => {
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: 'd-1' }]) // ticket fetch
      .mockResolvedValueOnce([{ siteId: 'site-1' }]);                                // existing device gate (Task 5)
    serviceMocks.updateTicketFields.mockResolvedValue({ ...STUB_TICKET, deviceId: null });
    const res = await makeApp().request(`/tickets/${TICKET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: null })
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/tickets/tickets.test.ts -t 'site-axis scoping — write guards'`
Expected: the two 403 tests FAIL (service mocks get called / 201/200 returned).

- [ ] **Step 3: Implement in `tickets.ts`**

In the **POST `/`** handler, after the `canAccessOrg` check (after line 245):

```ts
    // Site-axis guard: a site-restricted caller may only open device-bound
    // tickets for devices in their allowed sites (deviceless org-level tickets
    // are fine — they aren't site-bound).
    if (body.deviceId && !(await deviceInSiteScope(auth, body.deviceId))) {
      return c.json({ error: 'Device not found or access denied' }, 403);
    }
```

In the **PATCH `/:id`** handler, after the `getScopedTicketOr404` not-found check (after line 332; `null` clears the device and needs no gate):

```ts
    // Site-axis guard on the NEW device (the existing ticket's device was
    // already gated by getScopedTicketOr404 above).
    if (typeof body.deviceId === 'string' && !(await deviceInSiteScope(auth, body.deviceId))) {
      return c.json({ error: 'Device not found or access denied' }, 403);
    }
```

- [ ] **Step 4: Run the file to verify everything passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/tickets/tickets.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/tickets/tickets.ts apps/api/src/routes/tickets/tickets.test.ts
git commit -m "feat(tickets): site-axis write guards on ticket create and device reassignment"
```

---

### Task 8: Retire the site-scope scanner exemptions

**Files:**
- Modify: `apps/api/src/__tests__/integration/site-scope-coverage.integration.test.ts`

The scanner test exempted `routes/tickets/tickets.ts:GET /` and `GET /:id` in two sets (`SITE_SCOPE_INPUT_EXEMPT` lines 184-190 and `SITE_SCOPE_INPUT_EXEMPT_USER_SESSION_OK` lines 222-228) because site scoping was deferred. Now that the routes are gated, the exemptions must go — the scanner's "no stale entries" check enforces that retired exemptions are removed.

- [ ] **Step 1: Remove the four exemption entries (and their comment blocks)**

From `SITE_SCOPE_INPUT_EXEMPT`, delete:

```ts
  // ---- Org-scoped ticket list + detail: join devices only to decorate
  // deviceHostname on ticket rows. The list endpoint accepts an optional
  // ?deviceId filter (org/partner-tenant-scoped, NOT site-gated); the detail
  // endpoint takes no device-id input. Site-axis ticket scoping is a
  // deferred product decision (PR #1196 follow-up, Phase 1b).
  'routes/tickets/tickets.ts:GET /',
  'routes/tickets/tickets.ts:GET /:id',
```

From `SITE_SCOPE_INPUT_EXEMPT_USER_SESSION_OK`, delete:

```ts
  // Org-scoped ticket list + detail reached via user auth: devices joins
  // decorate deviceHostname only. The list endpoint accepts an optional
  // ?deviceId filter (org/partner-tenant-scoped, NOT site-gated); the detail
  // endpoint takes no device-id input. Site-axis ticket scoping deferred
  // (PR #1196 follow-up, Phase 1b).
  'routes/tickets/tickets.ts:GET /',
  'routes/tickets/tickets.ts:GET /:id',
```

- [ ] **Step 2: Run the integration scanner (needs the local docker Postgres up)**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.config.site-scope-coverage.ts
```

Expected: PASS. The scanner is file-local — `tickets.ts` now contains `auth.allowedSiteIds` / site-gate usage, which is what it detects. **If it still flags the tickets handlers**, read the gate-detection markers in `apps/api/src/__tests__/helpers/routeScan.ts` and align the implementation's identifier usage with what the scanner greps for (do NOT re-add the exemption).

- [ ] **Step 3: Run the RLS coverage contract test (sanity — no new tables, must stay green)**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.config.rls-coverage.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/site-scope-coverage.integration.test.ts
git commit -m "test(tickets): retire site-scope scanner exemptions for ticket routes"
```

---

### Task 9: Docs + final verification

**Files:**
- Modify: `apps/docs/src/content/docs/features/ticketing.mdx`

- [ ] **Step 1: Document site-scoped visibility**

In `features/ticketing.mdx`, find the section covering permissions/queue visibility (grep for `permission` or `visibility`; if no such section exists, add this after the queue/filters section):

```mdx
### Site-scoped technicians

Organization users restricted to specific sites only see tickets whose device
belongs to one of their sites. Tickets with no device attached (general,
org-level requests) remain visible to every technician in the organization.
Site-restricted users also can't create tickets against — or move tickets
onto — devices outside their sites.
```

Match the surrounding heading level and tone; adjust wording to fit the page's voice if needed.

- [ ] **Step 2: Run the remaining affected test files individually**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run \
  src/services/ticketService.test.ts \
  src/routes/tickets/tickets.test.ts \
  src/routes/ticketCategories.test.ts \
  src/db/autoMigrate.test.ts
```

Expected: PASS. (Do not gate on the full parallel suite — known pre-existing flakiness; CI is the arbiter.)

- [ ] **Step 3: Type-check the API**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```

Expected: no NEW errors (pre-existing errors in `agents.test.ts` and `apiKeyAuth.test.ts` are known).

- [ ] **Step 4: Commit docs**

```bash
git add apps/docs/src/content/docs/features/ticketing.mdx
git commit -m "docs(tickets): document site-scoped ticket visibility"
```

---

## Self-Review Notes

- **Spec coverage:** assignee validation → Task 1; categoryId cross-partner → Task 2 + Task 4 (DB); parentId cross-partner → Task 3 + Task 4 (DB); spec §7 site scoping (read) → Tasks 5-6; site scoping (write, #1204 parity) → Task 7; scanner debt retirement → Task 8; docs → Task 9.
- **Coverage inheritance:** bulk endpoint inherits site gating via `getScopedTicketOr404` (out-of-scope tickets → `skipped`) and assignee validation via `assignTicket` (cross-partner assignee → `TicketServiceError` → `skipped`). Portal and AI-tool creates inherit assignee/category validation via `createTicket`. No bulk-specific changes needed.
- **Type consistency:** `deviceInSiteScope(auth, deviceId)` and `ticketSiteScopeCondition(auth)` are used with those exact names in Tasks 5, 6, 7. `resolveTicketPartnerId` / `assertAssigneeInPartner` / `assertCategoryInPartner` defined in Task 1/2 and only used in `ticketService.ts`.
- **Known judgment calls:** site gate returns 404 on per-ticket routes (invisible = not found) but 403 on explicit `?deviceId` filters and write guards (alerts precedent: visible failure for explicit device requests). `assigneeId` cross-partner is 400 (not 404) since the assignee exists — mirrors the device cross-org guard's 400.

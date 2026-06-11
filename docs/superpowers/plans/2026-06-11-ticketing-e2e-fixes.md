# Ticketing e2e Findings — Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 8 bugs (plus two one-line UX items) from `docs/superpowers/specs/2026-06-11-ticketing-e2e-findings.md` in one PR on branch `worktree-ticketing-review-followups`.

**Architecture:** Three small API fixes (PATCH error hint, requester defaults from actor, org-scope category reads via system DB context — same pattern as `ticketService.assertCategoryInPartner`). Web fixes center on a new `lib/authScope.ts` JWT-claims helper (extracted from Sidebar) so ticketing pages stop calling partner-only endpoints under org scope, plus workbench assignment/pending-reason UI, bulk `skippedReasons` warning toasts, and a real settings page for categories (edit/parent/SLA fields against the existing PATCH endpoint).

**Tech Stack:** Hono + Drizzle (API, vitest with chained Drizzle mocks), React + Astro islands (web, vitest + jsdom + testing-library), `runAction` for all mutations.

**Out of scope (UX notes deliberately deferred):** queue sort control, device-select search/grouping, sticky composer tab, cross-tab bulk selection, site-restricted banner, "Breaching soon" empty state, feed old→new for field edits.

**Execution groups (sequential):**
- **Group A (API):** Tasks 1–3
- **Group B (web, workbench + small components):** Tasks 4–8
- **Group C (web, queue + create):** Tasks 9–10 (depends on B: `refreshToken` prop, `authScope`, warning toast)
- **Group D (web, settings):** Task 11
- **Task 12:** full verification

Conventions for every task: test files live alongside sources; run web tests with
`PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run <file> --root apps/web`
and API tests with `--root apps/api`. Commit after each task with the message given in the task.

---

### Task 1 (API): PATCH /tickets/:id — pointed error when `status`/`assigneeId` sent

Bug 8g: `updateTicketSchema` strips unknown keys, so `PATCH {status}` falls into the generic "No fields to update" 400.

**Files:**
- Modify: `apps/api/src/routes/tickets/tickets.ts` (~line 400, the empty-body branch)
- Test: `apps/api/src/routes/tickets/tickets.test.ts`

- [ ] **Step 1: Write failing tests** in the existing PATCH describe block of `tickets.test.ts`, matching the file's existing `makeApp()` style:

```typescript
it('400 with a status-route hint when only status is sent', async () => {
  const res = await makeApp().request('/tickets/11111111-1111-4111-8111-111111111111', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'open' })
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/POST \/tickets\/:id\/status/);
});

it('400 with an assign-route hint when only assigneeId is sent', async () => {
  const res = await makeApp().request('/tickets/11111111-1111-4111-8111-111111111111', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assigneeId: '22222222-2222-4222-8222-222222222222' })
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/POST \/tickets\/:id\/assign/);
});
```

- [ ] **Step 2: Run to verify both fail** (they currently get `No fields to update`).
- [ ] **Step 3: Implement** — replace the empty-body branch in the PATCH handler:

```typescript
if (Object.keys(body).length === 0) {
  // zod strips unknown keys, so a {status}/{assigneeId} body lands here looking
  // empty — point callers at the dedicated routes instead of a generic 400.
  const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (raw && 'status' in raw) {
    return c.json({ error: 'Status is not updatable via PATCH — use POST /tickets/:id/status' }, 400);
  }
  if (raw && ('assigneeId' in raw || 'assignedTo' in raw)) {
    return c.json({ error: 'Assignee is not updatable via PATCH — use POST /tickets/:id/assign' }, 400);
  }
  return c.json({ error: 'No fields to update' }, 400);
}
```

- [ ] **Step 4: Run the test file; all pass.**
- [ ] **Step 5: Commit** `fix(tickets): point PATCH callers at the status/assign routes`

---

### Task 2 (API): default requester to the acting technician on non-portal tickets

Bug 8d: manual tickets have `submitterName/Email = null` → rail shows "Unknown". `actorFrom(c)` already carries `name` and `email`.

**Files:**
- Modify: `apps/api/src/services/ticketService.ts` (`createTicket` insertValues, ~line 228)
- Test: `apps/api/src/services/ticketService.test.ts` (or wherever createTicket is unit-tested; add alongside existing createTicket tests)

- [ ] **Step 1: Write failing test:** createTicket with `source: 'manual'` and actor `{ userId: 'u-1', name: 'Tech One', email: 'tech@msp.com' }` inserts `submitterName: 'Tech One'`, `submitterEmail: 'tech@msp.com'`, `submittedBy: null`. Assert via the existing insert-mock capture pattern in that file. Also a case with an actor lacking name/email → both null.
- [ ] **Step 2: Run; fails (currently null).**
- [ ] **Step 3: Implement** in insertValues:

```typescript
submittedBy: isPortal ? input.submittedBy : null,
// Non-portal tickets default the requester to the acting user — a technician
// logging a ticket is its requester unless the portal supplied one.
submitterEmail: isPortal ? input.submitterEmail : (actor.email ?? null),
submitterName: isPortal ? (input.submitterName ?? null) : (actor.name ?? null),
```

- [ ] **Step 4: Run service tests; pass.**
- [ ] **Step 5: Commit** `fix(tickets): default requester to the acting user on non-portal tickets`

---

### Task 3 (API): org-scope `GET /ticket-categories` returns the MSP's categories

Bug 7: the org branch already resolves the org's partner and filters by `partner_id`, but partner-axis RLS hides the rows from org-scoped request contexts → `[]`. Product call (per findings): org users get **read-only** visibility of their MSP's categories. Write routes stay partner/system.

**Files:**
- Modify: `apps/api/src/routes/ticketCategories.ts` (org branch of GET `/`)
- Test: `apps/api/src/routes/ticketCategories.test.ts`

- [ ] **Step 1: Write failing test:** under an org-scope auth context, GET `/` runs its category read through `runOutsideDbContext` + `withSystemDbAccessContext` (mock both as pass-through spies like `tickets.test.ts` does) and returns the partner's category rows.
- [ ] **Step 2: Run; fails** (current code queries `db` directly; spies not called).
- [ ] **Step 3: Implement** — import `runOutsideDbContext, withSystemDbAccessContext` from `../db` and wrap only the category SELECT in the org branch:

```typescript
// The org→partner resolution above stays in the request context (RLS lets an
// org user read their own org row). The category read runs in a system DB
// context: ticket_categories is partner-axis RLS, invisible to org-scoped
// request contexts. The explicit partnerId filter — derived from auth.orgId,
// never from caller input — is the security boundary, same pattern as
// ticketService.assertCategoryInPartner. Org users get read-only visibility
// of their MSP's categories; the write routes below remain partner/system.
const data = await runOutsideDbContext(() =>
  withSystemDbAccessContext(() =>
    db
      .select()
      .from(ticketCategories)
      .where(eq(ticketCategories.partnerId, partnerId))
      .orderBy(asc(ticketCategories.sortOrder), asc(ticketCategories.name))
  )
);
return c.json({ data });
```

- [ ] **Step 4: Run the route test file; pass.**
- [ ] **Step 5: Commit** `fix(tickets): org-scope category reads run in system DB context (read-only MSP catalog)`

---

### Task 4 (web): `lib/authScope.ts` — JWT claims helper, Sidebar refactor

Foundation for Tasks 9–10. Sidebar currently inline-decodes the JWT to read `scope`.

**Files:**
- Create: `apps/web/src/lib/authScope.ts`
- Create: `apps/web/src/lib/authScope.test.ts`
- Modify: `apps/web/src/components/layout/Sidebar.tsx` (~lines 292–304) to use the helper

- [ ] **Step 1: Write failing tests** (forge a token: `x.${btoa(JSON.stringify({scope:'organization',orgId:'org-1',partnerId:null}))}.y`; set it via `useAuthStore.setState({ tokens: { accessToken, expiresInSeconds: 900 } })`). Cases: org-scope claims decoded; missing token → all-null; malformed token → all-null; base64url payload (`-`/`_` chars) decoded.
- [ ] **Step 2: Run; fails (module missing).**
- [ ] **Step 3: Implement:**

```typescript
import { useAuthStore } from '../stores/auth';

export interface JwtClaims {
  scope: 'system' | 'partner' | 'organization' | null;
  orgId: string | null;
  partnerId: string | null;
}

const NO_CLAIMS: JwtClaims = { scope: null, orgId: null, partnerId: null };

/**
 * Decode the access-token claims WITHOUT verification. Browser-side only, used
 * to avoid known 403s (partner-only endpoints under org scope) and to pre-fill
 * context — never as an authorization decision; the server re-checks everything.
 * Returns all-null when the token is absent or undecodable; callers must fall
 * through to server behavior in that case.
 */
export function getJwtClaims(): JwtClaims {
  const token = useAuthStore.getState().tokens?.accessToken;
  if (!token) return NO_CLAIMS;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return {
      scope: payload.scope === 'system' || payload.scope === 'partner' || payload.scope === 'organization' ? payload.scope : null,
      orgId: typeof payload.orgId === 'string' ? payload.orgId : null,
      partnerId: typeof payload.partnerId === 'string' ? payload.partnerId : null
    };
  } catch {
    return NO_CLAIMS;
  }
}
```

- [ ] **Step 4: Refactor Sidebar** to `const { scope } = getJwtClaims();` replacing the inline decode (keep the existing `if (scope !== null && scope !== 'partner') return;` behavior). Run Sidebar tests if any.
- [ ] **Step 5: Run new tests; pass. Commit** `refactor(web): extract JWT claims decode into lib/authScope`

---

### Task 5 (web): HelpPanel Cmd+Shift+H

Bug 4: with Shift held, `e.key` is `'H'`.

**Files:**
- Modify: `apps/web/src/components/help/HelpPanel.tsx:16`
- Test: `apps/web/src/components/help/HelpPanel.test.tsx` (create if missing)

- [ ] **Step 1: Failing test:** render, dispatch `new KeyboardEvent('keydown', { key: 'H', metaKey: true, shiftKey: true, bubbles: true })` on window, assert the panel toggles open (mock `useHelpStore` or assert on its state).
- [ ] **Step 2: Implement:** `if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'h') {`
- [ ] **Step 3: Tests pass. Commit** `fix(web): Cmd+Shift+H help shortcut matches shifted key`

---

### Task 6 (web): SlaChip renders nothing when no SLA

UX note (explicit in findings): the "–" placeholder on every row reads as broken.

**Files:**
- Modify: `apps/web/src/components/tickets/SlaChip.tsx:5` → `if (s.kind === 'none') return null;`
- Test: update `SlaChip.test.tsx` / any queue-list test asserting the "–".

- [ ] **Step 1: Update/write test:** no-SLA ticket renders nothing (`container.firstChild` null).
- [ ] **Step 2: Implement; run web ticket component tests** (`SlaChip`, `TicketQueueList`, `TicketsPage`) to catch layout assertions on "–".
- [ ] **Step 3: Commit** `fix(web): drop the misleading SLA dash placeholder`

---

### Task 7 (web): `warning` toast type

Needed by Task 9's partial-success bulk toast.

**Files:**
- Modify: `apps/web/src/components/shared/Toast.tsx`
- Test: `apps/web/src/components/shared/Toast.test.tsx` (follow existing tests if present)

- [ ] **Step 1: Failing test:** `showToast({ type: 'warning', message: 'heads up' })` renders with `data-toast-type="warning"`, `role="status"`, and a triangle icon.
- [ ] **Step 2: Implement:** extend the union `type: 'success' | 'error' | 'undo' | 'warning'`; import `AlertTriangle` from lucide; render branch:

```tsx
const isWarning = toast.type === 'warning';
// container className: error styles unchanged; warning gets
// 'bg-card border-warning/50' ; icon:
{isError ? <XCircle className="h-4 w-4 shrink-0" />
  : isWarning ? <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
  : <CheckCircle className="h-4 w-4 shrink-0 text-success" />}
```

- [ ] **Step 3: Tests pass. Commit** `feat(web): warning toast variant`

---

### Task 8 (web): TicketWorkbench — assign select, pending-reason prompt, resolution-note visibility, not-found copy, refresh prop, login next

Bugs 2, 6 (label), 8a, 8c, 5 (workbench half), 8f (workbench call sites), plus the not-found copy UX line.

**Files:**
- Modify: `apps/web/src/components/tickets/TicketWorkbench.tsx`
- Test: `apps/web/src/components/tickets/TicketWorkbench.test.tsx`

- [ ] **Step 1: Write failing tests** (use the file's existing fetch-mock style):
  1. **Assignee select replaces the unassign button.** With detail `{assignedTo: null, assigneeName: null}` and `/users` → `{data:[{id:'u-9',name:'Tech',email:'t@x'}]}`: a `select[data-testid="ticket-workbench-assignee"]` shows value `''` ("Unassigned"); changing it to `u-9` POSTs `/tickets/t-1/assign` with `{assigneeId:'u-9'}`.
  2. **No bogus unassign:** with `assignedTo: null`, firing `change` with value `''` does NOT call `/assign`.
  3. **Unassign works:** with `assignedTo:'u-9'`, selecting `''` POSTs `{assigneeId:null}`.
  4. **MSP staff label:** detail `{assignedTo:'partner-u', assigneeName:null}` and `/users` list not containing `partner-u` → the select shows an option labeled `MSP staff` selected.
  5. **Degraded mode:** `/users` rejects → no select; when assigned, a button labeled `Assignee: Tech ✕` unassigns on click; when unassigned, a plain `Unassigned` span (no button, no POST possible).
  6. **Pending prompt:** choosing status `pending` does NOT immediately POST; a form `ticket-workbench-pending-form` appears; typing a reason and submitting POSTs `/status` `{status:'pending', pendingReason:'vendor reply'}`; submitting empty posts `{status:'pending'}` (no pendingReason key).
  7. **on_hold prompts too** (same form, submit posts `{status:'on_hold'}`).
  8. **Resolution note hidden after reopen:** detail with `resolutionNote:'fixed'` and `status:'open'` → no "Resolution" rail entry; with `status:'resolved'` → entry shown.
  9. **Not-found copy:** 404 → text `Ticket not found. It may have been deleted, or you may not have access to it.`
  10. **refreshToken prop:** rerender with `refreshToken={1}` refetches the ticket (fetch called again).
- [ ] **Step 2: Run; fail.**
- [ ] **Step 3: Implement:**

Props: `refreshToken?: number`. Add effect:

```typescript
// Bulk actions in the queue mutate tickets behind the pane's back; the parent
// bumps refreshToken after a bulk apply so the detail can't go stale.
useEffect(() => { if (refreshToken) void load(); }, [refreshToken, load]);
```

Assignees fetch (once, graceful):

```typescript
// null = picker hidden (no USERS_READ etc.); degrade to a label + unassign-only button.
const [assignees, setAssignees] = useState<Array<{ id: string; name: string | null; email: string }> | null>(null);
useEffect(() => {
  let cancelled = false;
  void fetchWithAuth('/users')
    .then(async (r) => (r.ok ? r.json() : null))
    .then((body) => {
      if (cancelled || !body) return;
      const rows = Array.isArray(body) ? body : (body as { data?: unknown }).data;
      if (Array.isArray(rows)) setAssignees(rows.filter((u) => u.id));
    })
    .catch(() => { /* degraded mode keeps the unassign-only affordance */ });
  return () => { cancelled = true; };
}, []);
```

Replace the unassign button block:

```tsx
{assignees !== null ? (
  <select
    value={ticket.assignedTo ?? ''}
    onChange={(e) => {
      const next = e.target.value || null;
      if (next === (ticket.assignedTo ?? null)) return; // no-op guard: never write a bogus feed entry
      void mutate('/assign', { assigneeId: next }, next ? 'Assigned' : 'Unassigned');
    }}
    className="max-w-[180px] rounded-md border px-2 py-1 text-xs"
    data-testid="ticket-workbench-assignee"
    aria-label="Assignee"
  >
    <option value="">Unassigned</option>
    {ticket.assignedTo && !assignees.some((u) => u.id === ticket.assignedTo) && (
      // Assignee exists but is RLS-invisible to this caller (partner staff seen
      // from org scope) — show a redacted label instead of pretending unassigned.
      <option value={ticket.assignedTo}>{ticket.assigneeName ?? 'MSP staff'}</option>
    )}
    {assignees.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
  </select>
) : ticket.assignedTo ? (
  <button
    type="button"
    onClick={() => void mutate('/assign', { assigneeId: null }, 'Unassigned')}
    className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
    data-testid="ticket-workbench-unassign"
  >
    Assignee: {ticket.assigneeName ?? 'MSP staff'} ✕
  </button>
) : (
  <span className="rounded-md border px-2 py-1 text-xs text-muted-foreground" data-testid="ticket-workbench-unassigned">Unassigned</span>
)}
```

Pending prompt (mirror the resolve form; reset both on `ticketId` change):

```typescript
const [pendingOpen, setPendingOpen] = useState<'pending' | 'on_hold' | null>(null);
const [pendingReason, setPendingReason] = useState('');

const onStatusChange = useCallback(async (status: TicketStatus) => {
  if (status === 'resolved') { setResolveOpen(true); return; }
  if (status === 'pending' || status === 'on_hold') { setPendingOpen(status); return; }
  await mutate('/status', { status }, 'Status updated');
}, [mutate]);

const submitPending = useCallback(async () => {
  if (!pendingOpen) return;
  const reason = pendingReason.trim();
  await mutate('/status', { status: pendingOpen, ...(reason ? { pendingReason: reason } : {}) }, 'Status updated');
  setPendingOpen(null);
  setPendingReason('');
}, [mutate, pendingOpen, pendingReason]);
```

```tsx
{pendingOpen && (
  <div className="mt-2 rounded-md border bg-muted/30 p-2" data-testid="ticket-workbench-pending-form">
    <label className="text-xs font-medium" htmlFor="pending-reason">
      What are you waiting on? (optional)
    </label>
    <textarea
      id="pending-reason"
      value={pendingReason}
      onChange={(e) => setPendingReason(e.target.value)}
      rows={2}
      maxLength={500}
      className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
      data-testid="ticket-workbench-pending-reason"
    />
    <div className="mt-1.5 flex justify-end gap-2">
      <button type="button" onClick={() => { setPendingOpen(null); setPendingReason(''); }} className="rounded-md border px-2 py-1 text-xs hover:bg-muted">Cancel</button>
      <button type="button" onClick={() => void submitPending()} className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-white" data-testid="ticket-workbench-pending-submit">
        {pendingOpen === 'pending' ? 'Set pending' : 'Put on hold'}
      </button>
    </div>
  </div>
)}
```

Rail resolution-note visibility:

```tsx
{ticket.resolutionNote && (ticket.status === 'resolved' || ticket.status === 'closed') && (
  <div><dt className="text-xs text-muted-foreground">Resolution</dt><dd>{ticket.resolutionNote}</dd></div>
)}
```

Not-found copy: `setError('Ticket not found. It may have been deleted, or you may not have access to it.');`

Login next: every `navigateTo('/login', { replace: true })` in this file becomes `navigateTo(loginPathWithNext(), { replace: true })` — add to `apps/web/src/lib/navigation.ts` (or a sibling) once:

```typescript
/** Login URL that round-trips the current location through LoginPage's ?next= handling. */
export function loginPathWithNext(): string {
  if (typeof window === 'undefined') return '/login';
  const here = window.location.pathname + window.location.search + window.location.hash;
  return here && here !== '/' ? `/login?next=${encodeURIComponent(here)}` : '/login';
}
```

(Check `apps/web/src/lib/authNext.ts` `getSafeNext` accepts such values — it does for same-origin relative paths.)

- [ ] **Step 4: Run TicketWorkbench tests; all pass. Also run TicketsPage tests (workbench mock shape may need the new prop).**
- [ ] **Step 5: Commit** `fix(tickets): workbench assignment picker, pending-reason prompt, stale-note/not-found fixes`

---

### Task 9 (web): TicketsPage — org-scope hygiene, bulk partial-outcome toast, pane refresh, queue MSP-staff label

Bugs 8e, 8b, 5 (queue half), 6 (queue label), 8f.

**Files:**
- Modify: `apps/web/src/components/tickets/TicketsPage.tsx`
- Modify: `apps/web/src/components/tickets/TicketQueueList.tsx` (only if it renders assignee names)
- Test: `apps/web/src/components/tickets/TicketsPage.test.tsx`

- [ ] **Step 1: Failing tests:**
  1. With mocked `getJwtClaims` → `{scope:'organization', orgId:'org-1'}`: no fetch to `/orgs/organizations`; `tickets-filter-org` absent.
  2. Partner scope with a single org in the response: `tickets-filter-org` absent; with two orgs: present.
  3. Bulk response `{data:{updated:0, skipped:2, failed:0, total:2, skippedReasons:{OUT_OF_SCOPE:1, INVALID_TRANSITION:1}}}` → `showToast` called with `type:'warning'` and a message containing `0 updated`, `2 skipped`, `out of your scope`, `invalid status change`. No success toast.
  4. Bulk response `{updated:3, skipped:0, failed:0}` → success toast `3 updated`.
  5. After a successful bulk apply, the workbench receives an incremented `refreshToken` (assert via the mocked TicketWorkbench's props, or fetch-count on `/tickets/:id` if unmocked).
- [ ] **Step 2: Run; fail.**
- [ ] **Step 3: Implement:**

Imports: `import { getJwtClaims } from '@/lib/authScope';`, `loginPathWithNext`.

Options effect — skip the orgs call under org scope (claims may be null pre-token; that case keeps today's behavior and the fetch degrades silently):

```typescript
const orgScoped = getJwtClaims().scope === 'organization';
// inside the effect:
const [orgRes, catRes, userRes] = await Promise.allSettled([
  orgScoped ? Promise.resolve(null) : fetchWithAuth('/orgs/organizations?limit=100').then(readJson),
  fetchWithAuth('/ticket-categories').then(readJson),
  fetchWithAuth('/users').then(readJson)
]);
```

Org filter render condition (hides the useless single-org filter too):

```tsx
{!orgScoped && orgs.length > 1 && (
  <select ... data-testid="tickets-filter-org" ...>...</select>
)}
```

Bulk apply — replace `successMessage` with explicit outcome toasts:

```typescript
const SKIP_REASON_LABELS: Record<string, string> = {
  OUT_OF_SCOPE: 'out of your scope',
  INVALID_TRANSITION: 'invalid status change',
  ASSIGNEE_NOT_FOUND: 'assignee not found',
  ASSIGNEE_WRONG_PARTNER: 'assignee belongs to another partner',
  CONCURRENT_MODIFICATION: 'modified by someone else',
  TICKET_PARTNER_UNRESOLVABLE: 'ticket partner unresolvable',
  OTHER: 'other errors'
};
```

```typescript
const result = await runAction<{ data: { updated: number; skipped: number; failed: number; total: number; skippedReasons?: Record<string, number> } }>({
  request: () => fetchWithAuth('/tickets/bulk', { method: 'POST', body: JSON.stringify(body) }),
  errorFallback: 'Bulk update failed. Retry.',
  onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
});
const { updated, skipped, failed, skippedReasons } = result.data;
const missed = skipped + failed;
if (missed > 0) {
  const reasons = Object.entries(skippedReasons ?? {})
    .map(([code, n]) => `${n} ${SKIP_REASON_LABELS[code] ?? code.toLowerCase().replace(/_/g, ' ')}`)
    .join(', ');
  showToast({ type: 'warning', message: `${updated} updated, ${missed} skipped${reasons ? ` — ${reasons}` : ''}` });
} else {
  showToast({ type: 'success', message: `${updated} updated` });
}
clearBulkSelection();
setPaneRefresh((t) => t + 1);
void fetchTickets();
void fetchStats();
```

Pane refresh: `const [paneRefresh, setPaneRefresh] = useState(0);` and pass `refreshToken={paneRefresh + resolveToken * 0}`… no — pass a dedicated prop: `<TicketWorkbench ticketId={selected.id} refreshToken={paneRefresh} resolveRequestToken={resolveToken} onChanged={...} />`.

Queue-list label: if `TicketQueueList` renders `assigneeName`, apply `t.assigneeName ?? (t.assignedTo ? 'MSP staff' : null)`; if it doesn't render assignees, skip.

Login next: replace `/login` navigations in this file with `loginPathWithNext()`.

- [ ] **Step 4: Run TicketsPage (+ QueueList) tests; pass.**
- [ ] **Step 5: Commit** `fix(tickets): org-scope queue hygiene, partial-bulk warning toasts, pane refresh after bulk`

---

### Task 10 (web): CreateTicketPage works under org scope

Bug 1 (HIGH) + hierarchy labels in the category select (cheap once parentId is fetched).

**Files:**
- Modify: `apps/web/src/components/tickets/CreateTicketPage.tsx`
- Test: `apps/web/src/components/tickets/CreateTicketPage.test.tsx`

- [ ] **Step 1: Failing tests** (mock `@/lib/authScope` per test):
  1. Org scope (`{scope:'organization', orgId:'org-1'}`): no fetch to `/orgs/organizations`; no org select rendered; device fetch fires for `org-1`; submitting subject-only POSTs `/tickets` with `orgId:'org-1'`.
  2. Org-scope fallback: claims null but orgs fetch 403s **and** a second `getJwtClaims` call (post-token) returns `orgId` → form still usable. (If awkward to simulate, simply assert: 403 + claims `{scope:'organization',orgId:'org-1'}` → no dead-end error screen.)
  3. Partner scope unchanged: orgs fetch happens, select rendered, 403/500 → existing `create-ticket-load-error` screen.
  4. Category options render hierarchy labels: categories `[{id:'p',name:'Hardware',parentId:null},{id:'c',name:'Printers',parentId:'p'}]` → option text `Hardware / Printers` for `c`.
- [ ] **Step 2: Run; fail.**
- [ ] **Step 3: Implement:**

```typescript
interface CategoryOption { id: string; name: string; parentId: string | null }
const [categories, setCategories] = useState<CategoryOption[]>([]);
const [orgLocked, setOrgLocked] = useState(false); // org-scoped: org comes from the session, no picker

const loadOptions = useCallback(async () => {
  setLoadError(false);
  const claims = getJwtClaims();
  const orgScoped = claims.scope === 'organization' && !!claims.orgId;
  try {
    const [orgRes, catRes] = await Promise.all([
      // Org-scoped users can't list organizations (and don't need to — the org
      // is fixed by the session); skip the call instead of dead-ending on 403.
      orgScoped ? Promise.resolve(null) : fetchWithAuth('/orgs/organizations?limit=100'),
      fetchWithAuth('/ticket-categories')
    ]);
    if (orgScoped) {
      setOrgId(claims.orgId!);
      setOrgLocked(true);
    } else if (orgRes && orgRes.ok) {
      const b = await orgRes.json();
      setOrgs((b.data ?? b.organizations ?? []).map((o: { id: string; name: string }) => ({ id: o.id, name: o.name })));
    } else {
      // 403 here usually means an org-scoped session whose token landed after
      // mount — fall back to the claims before declaring failure.
      const late = getJwtClaims();
      if (orgRes?.status === 403 && late.scope === 'organization' && late.orgId) {
        setOrgId(late.orgId);
        setOrgLocked(true);
      } else {
        setLoadError(true);
        return;
      }
    }
    if (catRes.ok) {
      const cb = await catRes.json();
      setCategories(
        (cb.data ?? [])
          .filter((c: { isActive: boolean }) => c.isActive)
          .map((c: { id: string; name: string; parentId: string | null }) => ({ id: c.id, name: c.name, parentId: c.parentId ?? null }))
      );
    }
  } catch {
    setLoadError(true);
  }
}, []);
```

Render: wrap the Organization field in `{!orgLocked && (<div>…org select…</div>)}`. Category option labels:

```typescript
const categoryLabel = useMemo(() => {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return (c: CategoryOption) => {
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    return parent ? `${parent.name} / ${c.name}` : c.name;
  };
}, [categories]);
```

```tsx
{categories.map((c) => <option key={c.id} value={c.id}>{categoryLabel(c)}</option>)}
```

Login next on `onUnauthorized` here too.

- [ ] **Step 4: Run; pass.**
- [ ] **Step 5: Commit** `fix(tickets): org-scoped users can create tickets in the UI`

---

### Task 11 (web): `/settings/ticketing` — edit, hierarchy, SLA/billing/priority fields

Bug 3. Use the existing `PATCH /ticket-categories/:id` (validators: `ticketCategoryInputSchema` — name, color, parentId, defaultPriority, responseSlaMinutes, resolutionSlaMinutes, defaultBillable, defaultHourlyRate, sortOrder, isActive). Note `defaultHourlyRate` arrives from the API as a **string** (numeric column) and must be sent as a **number|null**.

**Files:**
- Modify: `apps/web/src/components/settings/TicketCategoriesPage.tsx` (full rework)
- Test: `apps/web/src/components/settings/TicketCategoriesPage.test.tsx`

**Design:**
- `Category` interface gains `parentId: string | null`, `defaultBillable: boolean`, `defaultHourlyRate: string | null`, `sortOrder: number`.
- **Hierarchy display:** order rows parent-first then its children (sorted by `sortOrder`, `name`); indent child names (`pl-6` + `└` prefix or muted parent breadcrumb). Children of inactive/missing parents render at root level (defensive).

```typescript
function hierarchyOrder(cats: Category[]): Array<Category & { depth: number }> {
  const roots = cats.filter((c) => !c.parentId || !cats.some((p) => p.id === c.parentId));
  const childrenOf = (id: string) => cats.filter((c) => c.parentId === id);
  const out: Array<Category & { depth: number }> = [];
  for (const r of [...roots].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))) {
    out.push({ ...r, depth: 0 });
    for (const ch of childrenOf(r.id).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))) {
      out.push({ ...ch, depth: 1 });
    }
  }
  return out;
}
```

- **Create form:** name + color + parent select (`None` + active root categories).
- **Edit:** per-row `Edit` button (`data-testid="ticket-category-edit-<id>"`) opens an inline edit panel below the row (single `editingId` state) with: name (text), color (color input), parent (select excluding self and its children), default priority (select None/low/normal/high/urgent), response SLA minutes + resolution SLA minutes (number inputs, empty → null), billable by default (checkbox), default hourly rate (number input, empty → null). `Save` PATCHes via `runAction` with:

```typescript
const payload = {
  name: draft.name.trim(),
  color: draft.color,
  parentId: draft.parentId || null,
  defaultPriority: draft.defaultPriority || null,
  responseSlaMinutes: draft.responseSlaMinutes === '' ? null : Number(draft.responseSlaMinutes),
  resolutionSlaMinutes: draft.resolutionSlaMinutes === '' ? null : Number(draft.resolutionSlaMinutes),
  defaultBillable: draft.defaultBillable,
  defaultHourlyRate: draft.defaultHourlyRate === '' ? null : Number(draft.defaultHourlyRate)
};
```

- **Table columns:** Name (indented), Color swatch, Defaults (e.g. `High · 1h response · 8h resolve · $150/h`, dash when none), Status, actions (Edit / Deactivate). Keep all existing `data-testid`s (`ticket-categories-table`, `ticket-category-row-<id>`, `ticket-category-toggle-<id>`, name/color inputs, create button).

- [ ] **Step 1: Failing tests:**
  1. Hierarchy: parent + child render in order with the child indented (assert row order + a `data-depth="1"` attr or `└` text).
  2. Create with parent: choosing a parent POSTs `{name, color, parentId}`.
  3. Edit flow: click `ticket-category-edit-<id>` → panel shows prefilled values (incl. SLA minutes and hourly rate parsed from string); save PATCHes `/ticket-categories/<id>` with the typed values (numbers, not strings; empty SLA → null).
  4. Self-exclusion: the parent select inside the edit panel contains neither the category itself nor its children.
- [ ] **Step 2: Run; fail. Step 3: Implement. Step 4: Run; pass.**
- [ ] **Step 5: Commit** `feat(tickets): category settings — edit, hierarchy, SLA/billing/priority defaults`

---

### Task 12: Verification sweep

- [ ] Run all touched web test files in one pass: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/tickets src/components/settings/TicketCategoriesPage.test.tsx src/components/shared/Toast.test.tsx src/components/help src/lib/authScope.test.ts --root apps/web`
- [ ] Run API tests: `npx vitest run src/routes/tickets src/routes/ticketCategories.test.ts src/services/ticketService.test.ts --root apps/api`
- [ ] Type-check both: `npx tsc --noEmit` in `apps/api` (pre-existing errors in `agents.test.ts`/`apiKeyAuth.test.ts` are known) and `apps/web` (`npx astro check` or the repo's web typecheck script if present).
- [ ] Run `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (all mutations still flow through `runAction`).
- [ ] Commit any stragglers.

## Self-review notes

- Spec coverage: bugs 1→T10, 2→T8, 3→T11, 4→T5, 5→T8+T9, 6→T8+T9, 7→T3, 8a→T8, 8b→T7+T9, 8c→T8, 8d→T2, 8e→T9, 8f→T8/T9/T10, 8g→T1; UX one-liners (SLA dash, not-found copy)→T6/T8. Deferred items listed up top.
- Bulk-to-`pending` sends no reason (service nulls it) — acceptable; the prompt is a single-ticket affordance.
- `tokens` are not persisted in the auth store, so `getJwtClaims()` can be all-null at first paint; both consumers fall back to server behavior (and CreateTicketPage re-reads claims on 403).

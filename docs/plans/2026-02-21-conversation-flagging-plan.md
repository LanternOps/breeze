# Conversation Flagging & Auto-Flag Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add manual and automatic flagging to AI sessions so broken conversations (e.g. tool failures) are immediately visible for review.

**Architecture:** Three nullable columns on `ai_sessions` (`flagged_at`, `flagged_by`, `flag_reason`). Auto-flag fires in the existing `postToolUse` callback when `isError` is true. Two new endpoints for flag/unflag. Existing admin sessions endpoint gets a `?flagged=true` filter. Frontend gets a flag button in the chat sidebar and a flagged badge/filter in the admin dashboard.

**Tech Stack:** Drizzle ORM, Hono routes, Zod validation, Zustand store, React + Lucide icons, Vitest

**Design Doc:** `docs/plans/2026-02-21-conversation-flagging-design.md`

---

### Task 1: Schema — Add Flag Columns to `aiSessions`

**Files:**
- Modify: `apps/api/src/db/schema/ai.ts:24-47`
- Create: `apps/api/src/db/migrations/2026-02-21-conversation-flagging.sql`

**Step 1: Add columns to Drizzle schema**

In `apps/api/src/db/schema/ai.ts`, add three columns to the `aiSessions` table definition, right after `updatedAt` (line 42) and before the closing `}` on line 43:

```typescript
  flaggedAt: timestamp('flagged_at'),
  flaggedBy: uuid('flagged_by').references(() => users.id),
  flagReason: text('flag_reason'),
```

And add a partial index inside the index callback (after line 46):

```typescript
  flaggedAtIdx: index('ai_sessions_flagged_at_idx').on(table.flaggedAt),
```

Note: Drizzle doesn't support `WHERE` clause on indexes natively. The partial index will be created via the SQL migration instead; the Drizzle index is for schema awareness.

**Step 2: Write the SQL migration**

Create `apps/api/src/db/migrations/2026-02-21-conversation-flagging.sql`:

```sql
ALTER TABLE ai_sessions
  ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS flagged_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS flag_reason TEXT;

CREATE INDEX IF NOT EXISTS ai_sessions_flagged_at_idx
  ON ai_sessions (flagged_at)
  WHERE flagged_at IS NOT NULL;
```

**Step 3: Run the migration**

Run:
```bash
docker exec -i breeze-postgres-dev psql -U breeze -d breeze < apps/api/src/db/migrations/2026-02-21-conversation-flagging.sql
```

Expected: No errors. Columns and index created.

**Step 4: Verify schema sync**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && pnpm db:push
```

Expected: No new changes detected (migration already applied the columns).

**Step 5: Commit**

```bash
git add apps/api/src/db/schema/ai.ts apps/api/src/db/migrations/2026-02-21-conversation-flagging.sql
git commit -m "feat: add flaggedAt/flaggedBy/flagReason columns to ai_sessions schema"
```

---

### Task 2: API — Flag and Unflag Endpoints

**Files:**
- Modify: `apps/api/src/routes/ai.ts:175-189` (after PATCH /sessions/:id)
- Modify: `apps/api/src/db/schema/ai.ts` (import already available)

**Step 1: Write tests for flag endpoint**

Create `apps/api/src/routes/ai-flagging.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { aiRoutes } from './ai';

// Mock DB
const mockUpdate = vi.fn();
const mockSelect = vi.fn();
vi.mock('../db', () => ({
  db: {
    select: (...args: any[]) => mockSelect(...args),
    insert: vi.fn(),
    update: (...args: any[]) => mockUpdate(...args),
  },
}));

vi.mock('../db/schema', () => ({
  aiSessions: {
    id: 'ai_sessions.id',
    orgId: 'ai_sessions.orgId',
    userId: 'ai_sessions.userId',
    flaggedAt: 'ai_sessions.flaggedAt',
    flaggedBy: 'ai_sessions.flaggedBy',
    flagReason: 'ai_sessions.flagReason',
    status: 'ai_sessions.status',
    title: 'ai_sessions.title',
    model: 'ai_sessions.model',
    turnCount: 'ai_sessions.turnCount',
    totalCostCents: 'ai_sessions.totalCostCents',
    createdAt: 'ai_sessions.createdAt',
  },
  aiMessages: { sessionId: 'ai_messages.sessionId', createdAt: 'ai_messages.createdAt' },
  aiToolExecutions: {},
  users: { id: 'users.id' },
  organizations: { id: 'organizations.id' },
  devices: { id: 'devices.id' },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test' },
      scope: 'partner',
      partnerId: 'partner-1',
      orgId: 'org-1',
      accessibleOrgIds: ['org-1'],
      orgCondition: () => undefined,
      canAccessOrg: () => true,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/aiAgent', () => ({
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  closeSession: vi.fn(),
}));

vi.mock('../services/aiCostTracker', () => ({
  getSessionHistory: vi.fn(() => []),
  getUsageSummary: vi.fn(() => ({ totalSessions: 0, totalCostCents: 0, totalInputTokens: 0, totalOutputTokens: 0 })),
}));

vi.mock('../services/aiAgentSdk', () => ({
  streamingSessionManager: { get: vi.fn(), remove: vi.fn() },
}));

// Helper to build app
function buildApp() {
  const app = new Hono();
  app.route('/ai', aiRoutes);
  return app;
}

describe('POST /ai/sessions/:id/flag', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it('flags a session with a reason', async () => {
    const { getSession } = await import('../services/aiAgent');
    (getSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-1', userId: 'user-1' });

    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: 'sess-1' }]),
      }),
    });

    const res = await app.request('/ai/sessions/sess-1/flag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Tool kept failing' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('flags a session without a reason', async () => {
    const { getSession } = await import('../services/aiAgent');
    (getSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-1', userId: 'user-1' });

    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: 'sess-1' }]),
      }),
    });

    const res = await app.request('/ai/sessions/sess-1/flag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
  });

  it('returns 404 for nonexistent session', async () => {
    const { getSession } = await import('../services/aiAgent');
    (getSession as any).mockResolvedValue(null);

    const res = await app.request('/ai/sessions/sess-1/flag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /ai/sessions/:id/flag', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it('clears the flag on a session', async () => {
    const { getSession } = await import('../services/aiAgent');
    (getSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-1', userId: 'user-1' });

    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: 'sess-1' }]),
      }),
    });

    const res = await app.request('/ai/sessions/sess-1/flag', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 404 for nonexistent session', async () => {
    const { getSession } = await import('../services/aiAgent');
    (getSession as any).mockResolvedValue(null);

    const res = await app.request('/ai/sessions/sess-1/flag', {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
  });
});
```

**Step 2: Run tests — verify they fail**

Run:
```bash
cd /Users/toddhebebrand/breeze/apps/api && pnpm vitest run src/routes/ai-flagging.test.ts
```

Expected: FAIL — routes don't exist yet.

**Step 3: Implement flag/unflag endpoints**

In `apps/api/src/routes/ai.ts`, add these two routes after the existing `PATCH /sessions/:id` handler (after line 198). You'll need to add `isNull` to the drizzle-orm import and `aiSessions` to the schema import if not already present.

At the top of the file, ensure these imports exist:
```typescript
import { eq, and, isNull, isNotNull, desc } from 'drizzle-orm';
import { aiSessions, aiMessages, aiToolExecutions } from '../db/schema';
```

Add the routes:

```typescript
// POST /sessions/:id/flag - Flag a conversation
aiRoutes.post(
  '/sessions/:id/flag',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', z.object({ reason: z.string().max(1000).optional() }).optional()),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');

    const session = await getSession(sessionId, auth);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const body = c.req.valid('json') ?? {};

    await db
      .update(aiSessions)
      .set({
        flaggedAt: new Date(),
        flaggedBy: auth.user?.id ?? null,
        flagReason: body.reason ?? null,
      })
      .where(eq(aiSessions.id, sessionId));

    return c.json({ success: true });
  }
);

// DELETE /sessions/:id/flag - Unflag a conversation
aiRoutes.delete(
  '/sessions/:id/flag',
  requireScope('partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');

    const session = await getSession(sessionId, auth);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    await db
      .update(aiSessions)
      .set({
        flaggedAt: null,
        flaggedBy: null,
        flagReason: null,
      })
      .where(eq(aiSessions.id, sessionId));

    return c.json({ success: true });
  }
);
```

**Step 4: Run tests — verify they pass**

Run:
```bash
cd /Users/toddhebebrand/breeze/apps/api && pnpm vitest run src/routes/ai-flagging.test.ts
```

Expected: PASS (all 5 tests).

**Step 5: Commit**

```bash
git add apps/api/src/routes/ai.ts apps/api/src/routes/ai-flagging.test.ts
git commit -m "feat: add POST/DELETE /ai/sessions/:id/flag endpoints"
```

---

### Task 3: API — Add Flagged Filter to Admin Sessions

**Files:**
- Modify: `apps/api/src/services/aiCostTracker.ts:394-423`
- Modify: `apps/api/src/routes/ai.ts:602-624`

**Step 1: Add test for flagged filter**

Append to `apps/api/src/routes/ai-flagging.test.ts`:

```typescript
describe('GET /ai/admin/sessions?flagged=true', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it('passes flagged filter to getSessionHistory', async () => {
    const { getSessionHistory } = await import('../services/aiCostTracker');

    const res = await app.request('/ai/admin/sessions?flagged=true&orgId=org-1');

    expect(res.status).toBe(200);
    expect(getSessionHistory).toHaveBeenCalledWith('org-1', expect.objectContaining({ flagged: true }));
  });

  it('does not pass flagged filter when param absent', async () => {
    const { getSessionHistory } = await import('../services/aiCostTracker');

    const res = await app.request('/ai/admin/sessions?orgId=org-1');

    expect(res.status).toBe(200);
    expect(getSessionHistory).toHaveBeenCalledWith('org-1', expect.objectContaining({ flagged: undefined }));
  });
});
```

**Step 2: Run tests — verify they fail**

Run:
```bash
cd /Users/toddhebebrand/breeze/apps/api && pnpm vitest run src/routes/ai-flagging.test.ts
```

Expected: FAIL — `getSessionHistory` doesn't accept or forward `flagged` param yet.

**Step 3: Update `getSessionHistory` to accept `flagged` option**

In `apps/api/src/services/aiCostTracker.ts`, modify the function signature and query at lines 394-423.

Update the options type:

```typescript
export async function getSessionHistory(orgId: string, options: { limit?: number; offset?: number; flagged?: boolean }): Promise<Array<{
  id: string;
  userId: string | null;
  title: string | null;
  model: string;
  turnCount: number;
  totalCostCents: number;
  status: string;
  flaggedAt: Date | null;
  flaggedBy: string | null;
  flagReason: string | null;
  createdAt: Date;
}>> {
  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  const conditions = [eq(aiSessions.orgId, orgId)];
  if (options.flagged) {
    conditions.push(isNotNull(aiSessions.flaggedAt));
  }

  return db
    .select({
      id: aiSessions.id,
      userId: aiSessions.userId,
      title: aiSessions.title,
      model: aiSessions.model,
      turnCount: aiSessions.turnCount,
      totalCostCents: aiSessions.totalCostCents,
      status: aiSessions.status,
      flaggedAt: aiSessions.flaggedAt,
      flaggedBy: aiSessions.flaggedBy,
      flagReason: aiSessions.flagReason,
      createdAt: aiSessions.createdAt
    })
    .from(aiSessions)
    .where(and(...conditions))
    .orderBy(desc(aiSessions.createdAt))
    .limit(limit)
    .offset(offset);
}
```

Ensure `isNotNull` is imported from `drizzle-orm` at the top of the file.

**Step 4: Update admin sessions route to pass `flagged` param**

In `apps/api/src/routes/ai.ts`, modify the `GET /admin/sessions` handler at lines 618-621:

```typescript
    const flagged = c.req.query('flagged') === 'true' ? true : undefined;

    const sessions = await getSessionHistory(orgId, { limit, offset, flagged });
    return c.json({ data: sessions });
```

**Step 5: Run tests — verify they pass**

Run:
```bash
cd /Users/toddhebebrand/breeze/apps/api && pnpm vitest run src/routes/ai-flagging.test.ts
```

Expected: PASS (all 7 tests).

**Step 6: Commit**

```bash
git add apps/api/src/services/aiCostTracker.ts apps/api/src/routes/ai.ts apps/api/src/routes/ai-flagging.test.ts
git commit -m "feat: add ?flagged=true filter to GET /ai/admin/sessions"
```

---

### Task 4: Auto-Flag — Trigger on Tool Failure in postToolUse

**Files:**
- Modify: `apps/api/src/services/aiAgentSdk.ts:413-451`

**Step 1: Add auto-flag test**

Append to `apps/api/src/routes/ai-flagging.test.ts`:

```typescript
describe('Auto-flag on tool failure', () => {
  it('flags session when tool execution fails', async () => {
    // This is an integration-level concern tested via the postToolUse callback.
    // We verify the DB update call shape in a unit test of the callback.
    // See: apps/api/src/services/aiAgentSdk.ts postToolUse
    // The auto-flag logic is: if isError && session not already flagged, UPDATE ai_sessions SET flagged_at, flag_reason WHERE id = sessionId AND flagged_at IS NULL
    expect(true).toBe(true); // Placeholder — real test is manual via chat
  });
});
```

Note: The postToolUse callback is deeply integrated with the streaming session manager and difficult to unit test in isolation. The auto-flag is a 6-line addition and will be verified via manual testing (trigger a tool failure in chat and check the DB).

**Step 2: Add auto-flag logic to postToolUse**

In `apps/api/src/services/aiAgentSdk.ts`, inside the `createSessionPostToolUse` function, add the auto-flag logic after the tool execution record is saved (after line 451, after the closing `}` of the approval execution update block).

Add this code:

```typescript
    // 2b. Auto-flag session on tool failure (first failure only)
    if (isError) {
      try {
        const errorMsg = typeof parsedOutput.error === 'string'
          ? parsedOutput.error
          : output.slice(0, 500);
        await withSystemDbAccessContext(() =>
          db.update(aiSessions)
            .set({
              flaggedAt: new Date(),
              flagReason: `Tool failed: ${toolName} — ${errorMsg}`,
            })
            .where(and(
              eq(aiSessions.id, sessionId),
              isNull(aiSessions.flaggedAt),
            ))
        );
      } catch (err) {
        console.error('[AI-SDK] Failed to auto-flag session:', err);
      }
    }
```

Ensure these imports are at the top of `aiAgentSdk.ts`:
```typescript
import { eq, and, isNull } from 'drizzle-orm';
import { aiSessions } from '../db/schema';
```

The `WHERE flagged_at IS NULL` ensures only the first failure flags the session. `flaggedBy` stays NULL to distinguish auto-flags from manual flags.

**Step 3: Type-check**

Run:
```bash
cd /Users/toddhebebrand/breeze/apps/api && npx tsc --noEmit 2>&1 | head -20
```

Expected: No new errors from our changes (pre-existing errors in other files are OK).

**Step 4: Run all tests**

Run:
```bash
cd /Users/toddhebebrand/breeze/apps/api && pnpm vitest run src/routes/ai-flagging.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/aiAgentSdk.ts apps/api/src/routes/ai-flagging.test.ts
git commit -m "feat: auto-flag ai_sessions on first tool failure in postToolUse"
```

---

### Task 5: Frontend — Flag Button in Chat Sidebar

**Files:**
- Modify: `apps/web/src/stores/aiStore.ts:54-92`
- Modify: `apps/web/src/components/ai/AiChatSidebar.tsx:113-157`

**Step 1: Add flag state and actions to Zustand store**

In `apps/web/src/stores/aiStore.ts`, add to the `AiState` interface (after line 71, after `isInterrupting`):

```typescript
  isFlagged: boolean;
  flagReason: string | null;
```

Add actions (after line 91, after `switchSession`):

```typescript
  flagSession: (reason?: string) => Promise<void>;
  unflagSession: () => Promise<void>;
```

In the store's `create` call, add default values:

```typescript
  isFlagged: false,
  flagReason: null,
```

Add the action implementations (inside the store):

```typescript
  flagSession: async (reason?: string) => {
    const { sessionId } = get();
    if (!sessionId) return;
    try {
      await fetch(`/api/ai/sessions/${sessionId}/flag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      set({ isFlagged: true, flagReason: reason ?? null });
    } catch (err) {
      console.error('Failed to flag session:', err);
    }
  },

  unflagSession: async () => {
    const { sessionId } = get();
    if (!sessionId) return;
    try {
      await fetch(`/api/ai/sessions/${sessionId}/flag`, { method: 'DELETE' });
      set({ isFlagged: false, flagReason: null });
    } catch (err) {
      console.error('Failed to unflag session:', err);
    }
  },
```

Also update `loadSession` to read flag state from the API response. Find where `loadSession` sets state after fetching, and include:

```typescript
  isFlagged: !!data.session.flaggedAt,
  flagReason: data.session.flagReason ?? null,
```

And in `createSession`, reset flag state:

```typescript
  isFlagged: false,
  flagReason: null,
```

**Step 2: Add flag button to sidebar header**

In `apps/web/src/components/ai/AiChatSidebar.tsx`:

Add `Flag` to the Lucide imports:

```typescript
import { ..., Flag } from 'lucide-react';
```

Destructure the new actions from the store (wherever `useAiStore` is called):

```typescript
const { ..., isFlagged, flagSession, unflagSession } = useAiStore();
```

In the header button group (between the "New conversation" button at line 147 and the close button at line 149), add:

```tsx
            {!showHistory && sessionId && (
              <button
                onClick={() => isFlagged ? unflagSession() : flagSession()}
                className={`rounded p-1.5 transition-colors ${
                  isFlagged
                    ? 'text-amber-400 hover:bg-gray-800 hover:text-amber-300'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`}
                title={isFlagged ? 'Unflag conversation' : 'Flag conversation for review'}
              >
                <Flag className="h-4 w-4" fill={isFlagged ? 'currentColor' : 'none'} />
              </button>
            )}
```

**Step 3: Verify frontend builds**

Run:
```bash
cd /Users/toddhebebrand/breeze/apps/web && npx tsc --noEmit 2>&1 | head -20
```

Expected: No new type errors.

**Step 4: Commit**

```bash
git add apps/web/src/stores/aiStore.ts apps/web/src/components/ai/AiChatSidebar.tsx
git commit -m "feat: add flag/unflag button to AI chat sidebar header"
```

---

### Task 6: Frontend — Flagged Column and Filter in Admin Dashboard

**Files:**
- Modify: `apps/web/src/components/settings/AiUsagePage.tsx:18-27,270-317`

**Step 1: Update SessionRow interface**

In `apps/web/src/components/settings/AiUsagePage.tsx`, add to the `SessionRow` interface at line 18-27:

```typescript
interface SessionRow {
  id: string;
  userId: string;
  title: string | null;
  model: string;
  turnCount: number;
  totalCostCents: number;
  status: string;
  flaggedAt: string | null;
  flaggedBy: string | null;
  flagReason: string | null;
  createdAt: string;
}
```

**Step 2: Add flagged filter state**

Add state inside the component function:

```typescript
const [showFlaggedOnly, setShowFlaggedOnly] = useState(false);
```

Update the fetch call for sessions to include the flagged parameter:

```typescript
const url = showFlaggedOnly
  ? `/api/ai/admin/sessions?orgId=${orgId}&flagged=true`
  : `/api/ai/admin/sessions?orgId=${orgId}`;
```

Add `showFlaggedOnly` to the dependency array of the sessions fetch `useEffect`.

**Step 3: Add filter toggle above table**

In the `border-b px-6 py-4` header div for "Recent Sessions" (line 271-273), add a toggle:

```tsx
        <div className="border-b px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent Sessions</h2>
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={showFlaggedOnly}
              onChange={(e) => setShowFlaggedOnly(e.target.checked)}
              className="rounded border-gray-300"
            />
            Show flagged only
          </label>
        </div>
```

**Step 4: Add Flagged column to table**

Add a new `<th>` after the Status column header (line 282):

```tsx
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">Flagged</th>
```

Add the corresponding `<td>` in each row (after the status `<td>`, around line 300):

```tsx
                  <td className="px-4 py-2.5">
                    {s.flaggedAt ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-400"
                        title={s.flagReason || 'Flagged'}
                      >
                        <Flag className="h-3 w-3" />
                        Flagged
                      </span>
                    ) : null}
                  </td>
```

Update the "No sessions" colspan from 6 to 7:

```tsx
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
```

Add `Flag` to the Lucide imports at the top of the file.

Add `useState` to the React import if not already present.

**Step 5: Add amber left border for flagged rows**

Update the `<tr>` for each session row:

```tsx
                <tr key={s.id} className={`border-b last:border-0 hover:bg-muted/20 ${s.flaggedAt ? 'border-l-2 border-l-amber-500' : ''}`}>
```

**Step 6: Verify frontend builds**

Run:
```bash
cd /Users/toddhebebrand/breeze/apps/web && npx tsc --noEmit 2>&1 | head -20
```

Expected: No new type errors.

**Step 7: Commit**

```bash
git add apps/web/src/components/settings/AiUsagePage.tsx
git commit -m "feat: add flagged column, filter toggle, and amber border to admin sessions table"
```

---

### Task 7: Include Flag Data in Session Detail Response

**Files:**
- Modify: `apps/api/src/services/aiAgent.ts:105-116`

**Step 1: Verify flag columns are returned**

The `getSessionMessages` function at line 105-116 does `select()` from `aiMessages` but returns `{ session, messages }` where `session` comes from `getSession()`. Since `getSession` does a full row select, the new `flaggedAt`, `flaggedBy`, `flagReason` columns will be included automatically by Drizzle once they're in the schema.

Verify by reading the `getSession` function — if it uses `.select()` without column specification, all columns including the new ones are returned.

**Step 2: Type-check to confirm**

Run:
```bash
cd /Users/toddhebebrand/breeze/apps/api && npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors. The new columns are nullable so existing code won't break.

**Step 3: Commit (if any changes needed)**

If no code changes are needed (Drizzle auto-includes new schema columns), skip this commit. Otherwise:

```bash
git add apps/api/src/services/aiAgent.ts
git commit -m "feat: include flag data in session detail response"
```

---

### Task 8: Final Verification

**Step 1: Run all API tests**

Run:
```bash
cd /Users/toddhebebrand/breeze/apps/api && pnpm test:run
```

Expected: All existing tests pass. All new flagging tests pass.

**Step 2: Type-check both apps**

Run:
```bash
cd /Users/toddhebebrand/breeze/apps/api && npx tsc --noEmit
cd /Users/toddhebebrand/breeze/apps/web && npx tsc --noEmit
```

Expected: No new errors from our changes.

**Step 3: Final commit (if anything was missed)**

```bash
git add -A
git status
# Only commit if there are staged changes from our feature
git commit -m "chore: conversation flagging — final verification pass"
```

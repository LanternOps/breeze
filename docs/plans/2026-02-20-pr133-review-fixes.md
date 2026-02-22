# PR #133 Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all issues identified in the PR #133 code review across four areas: critical auth bypass, schema type annotations, service logic bugs, and test coverage gaps.

**Architecture:** Changes are isolated to four files: `logs.ts` (route fix), `eventLogs.ts` (schema annotations), `logSearch.ts` (logic fixes), `logSearch.test.ts` (expanded unit tests), and `logs.test.ts` (expanded route tests). No migrations needed — the schema changes are TypeScript-only type annotations.

**Tech Stack:** Hono (routes), Drizzle ORM (schema), Vitest (tests), TypeScript

---

## Task 1: Fix Multi-Tenant Authorization Bypass (CRITICAL)

**Files:**
- Modify: `apps/api/src/routes/logs.ts:354-375`

The `POST /logs/correlation/detect` endpoint's rules-based path calls `runCorrelationRules` without org scoping when `body.orgId` is absent. An authenticated user with no `orgId` causes `runCorrelationRules` to run across ALL organizations.

**Step 1: Read the current route handler**

Re-read `apps/api/src/routes/logs.ts` lines 302–375 to confirm the exact code before editing.

**Step 2: Apply the fix**

Replace the rules path (everything after the `if (body.pattern) { ... }` block) with:

```typescript
// Rules-based path: orgId is required (no pattern provided means broad rule run)
const orgId = resolveSingleOrgId(auth, body.orgId);
if (!orgId) {
  return c.json({ error: 'orgId is required for this scope' }, 400);
}

const detections = await runCorrelationRules({
  orgId,
  ruleIds: body.ruleIds,
});
```

This replaces:
```typescript
if (body.orgId && !auth.canAccessOrg(body.orgId)) {
  return c.json({ error: 'Access denied for requested org' }, 403);
}

const detections = await runCorrelationRules({
  orgId: body.orgId,
  ruleIds: body.ruleIds,
});
```

**Step 3: Run the existing tests to confirm no regression**

```bash
pnpm -C apps/api test:run src/routes/logs.test.ts
```
Expected: all 5 existing tests pass

**Step 4: Commit**

```bash
git add apps/api/src/routes/logs.ts
git commit -m "fix(logs): require orgId resolution for rules-based correlation detect

Without this, a caller omitting orgId causes runCorrelationRules to
fetch and execute active correlation rules across all organizations,
violating multi-tenant data isolation."
```

---

## Task 2: Fix Schema Type Annotations in `eventLogs.ts`

**Files:**
- Modify: `apps/api/src/db/schema/eventLogs.ts`

Two issues:
- `details: jsonb('details')` is missing `.$type<Record<string, unknown>>()`, unlike every other JSONB column in the file
- `timestamp: timestamp('timestamp')` is missing `{ withTimezone: true }`, making storage timezone-dependent

**Step 1: Add `.$type<>()` to `details` column**

Change line 36:
```typescript
// Before
details: jsonb('details'),
// After
details: jsonb('details').$type<Record<string, unknown>>(),
```

**Step 2: Add `{ withTimezone: true }` to `timestamp` column**

Change line 30:
```typescript
// Before
timestamp: timestamp('timestamp').notNull(),
// After
timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
```

**Step 3: Build to confirm no type errors**

```bash
pnpm -C apps/api build
```
Expected: clean build, no TypeScript errors

**Step 4: Commit**

```bash
git add apps/api/src/db/schema/eventLogs.ts
git commit -m "fix(schema): add .\$type annotation to details jsonb and timezone to timestamp"
```

---

## Task 3: Fix Redundant `levelsAtOrAbove` Condition

**Files:**
- Modify: `apps/api/src/services/logSearch.ts:558-561`

`levelsAtOrAbove` always returns a non-empty array (minimum 1 element). The `if (allowedLevels.length > 0)` guard is always true and adds `WHERE level IN (...)` to every trends query even when no filter is requested.

**Step 1: Apply the fix**

Change lines 558–561:
```typescript
// Before
const allowedLevels = levelsAtOrAbove(input.minLevel);
if (allowedLevels.length > 0) {
  conditions.push(inArray(deviceEventLogs.level, allowedLevels));
}

// After
if (input.minLevel) {
  conditions.push(inArray(deviceEventLogs.level, levelsAtOrAbove(input.minLevel)));
}
```

**Step 2: Run tests**

```bash
pnpm -C apps/api test:run src/services/logSearch.test.ts
```
Expected: all tests pass

**Step 3: Commit**

```bash
git add apps/api/src/services/logSearch.ts
git commit -m "fix(logSearch): skip redundant level IN clause when minLevel not set"
```

---

## Task 4: Fix Double Sanitization in `runPatternDetection`

**Files:**
- Modify: `apps/api/src/services/logSearch.ts:755-759`

`buildMessagePatternCondition` calls `sanitizeCorrelationPattern` internally. Then `runPatternDetection` calls it again on the same pattern. The outer caller `detectPatternCorrelation` already sanitizes the pattern at line 826 before passing it in, so `runPatternDetection` receives an already-sanitized pattern.

**Step 1: Apply the fix**

The function receives `pattern` (already sanitized by the caller). Remove the redundant call:

```typescript
// Before (lines 755-759)
const detected = buildMessagePatternCondition(pattern, isRegex);
const sanitizedPattern = sanitizeCorrelationPattern(pattern, isRegex);
const condition = forceLike
  ? ilike(deviceEventLogs.message, `%${escapeLike(sanitizedPattern)}%`)
  : detected.condition;

// After
const detected = buildMessagePatternCondition(pattern, isRegex);
const condition = forceLike
  ? ilike(deviceEventLogs.message, `%${escapeLike(pattern)}%`)
  : detected.condition;
```

**Step 2: Run tests**

```bash
pnpm -C apps/api test:run src/services/logSearch.test.ts
```
Expected: all tests pass

**Step 3: Commit**

```bash
git add apps/api/src/services/logSearch.ts
git commit -m "fix(logSearch): remove duplicate sanitizeCorrelationPattern call in runPatternDetection"
```

---

## Task 5: Expand `logSearch.test.ts` — parseTimeRange and cursor tests

**Files:**
- Modify: `apps/api/src/services/logSearch.test.ts`

The test file currently exports only `mergeSavedLogSearchFilters` and `sanitizeCorrelationPattern`. We need to test `parseTimeRange` and `decodeSearchCursor` — but they're private functions. The route tests cover their error paths via HTTP status. For unit coverage, we test the exported `searchFleetLogs` behavior for time range errors (they propagate), and we add direct cursor tests via the encode/decode exported symbols.

Looking at the code: `encodeSearchCursor` and `decodeSearchCursor` are NOT exported. The route error handling catches them via message string matching. We can test the behavior through the route layer in `logs.test.ts` (Task 6). For `logSearch.test.ts`, we expand the `sanitizeCorrelationPattern` coverage.

**Step 1: Add missing `sanitizeCorrelationPattern` tests**

Append to the existing `describe('sanitizeCorrelationPattern', ...)` block:

```typescript
  it('rejects empty text pattern', () => {
    expect(() => sanitizeCorrelationPattern('   ', false)).toThrow(/empty/i);
  });

  it('rejects text pattern exceeding 1000 characters', () => {
    expect(() => sanitizeCorrelationPattern('a'.repeat(1001), false)).toThrow(/too long/i);
  });

  it('rejects regex with too many meta characters', () => {
    // 61 meta chars — over the 60-char limit
    const pattern = Array.from({ length: 31 }, () => '(.*)').join('');
    expect(() => sanitizeCorrelationPattern(pattern, true)).toThrow(/too complex/i);
  });

  it('rejects syntactically invalid regex', () => {
    expect(() => sanitizeCorrelationPattern('[unclosed', true)).toThrow(/invalid regex/i);
  });

  it('accepts valid regex pattern', () => {
    expect(sanitizeCorrelationPattern('error.*timeout', true)).toBe('error.*timeout');
  });
```

**Step 2: Add a `levelsAtOrAbove` behavior test via `getLogTrends` (optional, via integration)**

This is tested indirectly. Skip — the fix in Task 3 is straightforward enough to not require a unit test for the private helper.

**Step 3: Run the expanded tests**

```bash
pnpm -C apps/api test:run src/services/logSearch.test.ts
```
Expected: all tests pass (including 5 new `sanitizeCorrelationPattern` tests)

**Step 4: Commit**

```bash
git add apps/api/src/services/logSearch.test.ts
git commit -m "test(logSearch): expand sanitizeCorrelationPattern coverage for edge cases"
```

---

## Task 6: Expand `logs.test.ts` — Route Coverage Gaps

**Files:**
- Modify: `apps/api/src/routes/logs.test.ts`

Missing coverage:
1. `POST /logs/search` with nonexistent `savedQueryId` → 404
2. `POST /logs/search` when service throws time-range error → 400
3. `POST /logs/correlation/detect` rules path without orgId (multi-tenant fix verification)
4. `GET /logs/queries` → returns list
5. `POST /logs/queries` → returns 201
6. `GET /logs/queries/:id` → 404 when not found

**Step 1: Add tests**

Append the following inside the `describe('logs routes', ...)` block in `logs.test.ts`:

```typescript
  it('returns 404 when savedQueryId does not exist', async () => {
    getSavedLogSearchQueryMock.mockResolvedValue(null);

    const res = await app.request('/logs/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ savedQueryId: '22222222-2222-2222-2222-222222222222' }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it('returns 400 when search service throws a time range error', async () => {
    searchFleetLogsMock.mockRejectedValue(new Error('Invalid time range. start must be before end.'));

    const res = await app.request('/logs/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeRange: { start: '2026-02-21T01:00:00Z', end: '2026-02-21T00:00:00Z' } }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 400 for rules-based correlation detect when orgId cannot be resolved (multi-tenant fix)', async () => {
    // Partner/system scope with no single resolvable org
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: ['aaa', 'bbb'],
        user: { id: 'partner-user' },
        canAccessOrg: () => true,
        orgCondition: () => undefined,
      });
      return next();
    });

    const res = await app.request('/logs/correlation/detect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}), // no pattern, no orgId
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/orgId/i);
    expect(runCorrelationRulesMock).not.toHaveBeenCalled();
  });

  it('runs correlation rules scoped to resolved orgId', async () => {
    runCorrelationRulesMock.mockResolvedValue([]);

    const res = await app.request('/logs/correlation/detect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}), // no pattern — uses rules path
    });

    expect(res.status).toBe(200);
    expect(runCorrelationRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: '11111111-1111-1111-1111-111111111111' }),
    );
  });

  it('GET /logs/queries returns list of saved queries', async () => {
    listSavedLogSearchQueriesMock.mockResolvedValue([
      { id: 'q-1', name: 'My Query' },
    ]);

    const res = await app.request('/logs/queries');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('q-1');
  });

  it('POST /logs/queries creates a saved query and returns 201', async () => {
    createSavedLogSearchQueryMock.mockResolvedValue({ id: 'new-query-id', name: 'My Search' });

    const res = await app.request('/logs/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My Search', filters: {} }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe('new-query-id');
  });

  it('GET /logs/queries/:id returns 404 when query not found', async () => {
    getSavedLogSearchQueryMock.mockResolvedValue(null);

    const res = await app.request('/logs/queries/44444444-4444-4444-4444-444444444444');
    expect(res.status).toBe(404);
  });
```

**Step 2: Run the tests**

```bash
pnpm -C apps/api test:run src/routes/logs.test.ts
```
Expected: all tests pass (including the new 6 tests above)

**Step 3: Commit**

```bash
git add apps/api/src/routes/logs.test.ts
git commit -m "test(logs): add route coverage for 404/400 paths, multi-tenant auth fix, and missing CRUD routes"
```

---

## Task 7: Final Verification

**Step 1: Run full test suite for changed files**

```bash
pnpm -C apps/api test:run src/routes/logs.test.ts src/services/logSearch.test.ts
```
Expected: All tests pass

**Step 2: Run lint**

```bash
pnpm -C apps/api lint -- src/routes/logs.ts src/services/logSearch.ts src/db/schema/eventLogs.ts
```
Expected: No lint errors

**Step 3: Run build**

```bash
pnpm -C apps/api build
```
Expected: Clean build

---

## Out of Scope (Pre-existing Issues)

The silent-failure-hunter identified issues in files NOT changed by this PR:
- `networkBaselineWorker.ts`, `ipHistoryRetention.ts`, `networkBaseline.ts` — pre-existing, separate follow-up
- `playbooks.ts`, `ai.ts`, `streamingSessionManager.ts` — pre-existing, separate follow-up
- `propose_action_plan` RBAC — not in this PR's `TOOL_TIERS`; separate follow-up

The type-design-analyzer's `PlaybookStep` discriminated union and `SavedLogSearchFilters.search` deprecation suggestions are architectural refactors with migration implications. Track separately.

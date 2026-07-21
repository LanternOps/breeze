# Quote Line Move-Between-Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a quote author move a line item (and its bundle children) from one pricing panel (`line_items` block) to another via a "Move to…" menu on the line row, persisted through a dedicated API endpoint.

**Architecture:** New `moveQuoteLineSchema` validator → new `PATCH /quotes/:id/lines/:lineId/move` route → new `moveLineToBlock` service method (transactional append-to-end, bundle children follow). Web: new `moveLine` client wrapper + optimistic cross-panel move in `QuoteEditor.tsx` (a `lineBlockOverride` map layered over the existing `lineOrder` optimistic-reorder state) + a small fixed-position dropdown on the line row.

**Tech Stack:** Hono + zod v4 (`.guid()`, not `.uuid()`), Drizzle ORM, Vitest (API route tests mock the service; service logic is tested in the real-DB integration suite), React + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/billing/2026-07-05-quote-line-move-between-panels-design.md`

## Global Constraints

- Zod v4: uuid fields use `z.string().guid()` (repo convention in `packages/shared/src/validators/quotes.ts`).
- No DB migration — `quote_lines.block_id` is already a mutable nullable FK; RLS unchanged.
- Web mutations go through `runAction` (`apps/web/src/lib/runAction.ts`); errors surfaced via `handleActionError` (same pattern as `moveBlock`/`moveLine` in `QuoteEditor.tsx`).
- Test files live alongside source files; real-DB service tests go in `apps/api/src/__tests__/integration/quoteService.integration.test.ts`.
- Error responses use `QuoteServiceError(message, status, code)`; routes map them via `handleServiceError`.
- All work happens on the current branch `ToddHebebrand/quotes`. Commit after each task.
- Integration tests need the docker test DB: `cd apps/api && pnpm test:docker:up` first (they auto-skip via `it.runIf(!!process.env.DATABASE_URL)` when no DB is configured — if you cannot bring the DB up, note it and rely on CI's smoke-test job).

---

### Task 1: Shared validator `moveQuoteLineSchema`

**Files:**
- Modify: `packages/shared/src/validators/quotes.ts` (after `reorderLinesSchema`, ~line 105)
- Test: `packages/shared/src/validators/quotes.test.ts`

**Interfaces:**
- Produces: `moveQuoteLineSchema` (zod object `{ blockId: guid }`) and type `MoveQuoteLineInput`, exported from `@breeze/shared` (the validators barrel already re-exports this file — `reorderLinesSchema` reaches routes the same way).

- [ ] **Step 1: Write the failing tests**

Open `packages/shared/src/validators/quotes.test.ts`, look at how existing describes import schemas from `'./quotes'`, and append this block (adjusting the import line to match the file's existing import statement — add `moveQuoteLineSchema` to it):

```ts
describe('moveQuoteLineSchema', () => {
  const BLOCK_ID = '33333333-3333-3333-3333-333333333333';

  it('accepts a guid blockId', () => {
    const r = moveQuoteLineSchema.safeParse({ blockId: BLOCK_ID });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.blockId).toBe(BLOCK_ID);
  });

  it('rejects a non-guid blockId', () => {
    expect(moveQuoteLineSchema.safeParse({ blockId: 'not-a-guid' }).success).toBe(false);
  });

  it('rejects a missing blockId', () => {
    expect(moveQuoteLineSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a null blockId (moving to "no panel" is not supported)', () => {
    expect(moveQuoteLineSchema.safeParse({ blockId: null }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && pnpm vitest run src/validators/quotes.test.ts`
Expected: FAIL — `moveQuoteLineSchema` is not exported.

- [ ] **Step 3: Add the schema**

In `packages/shared/src/validators/quotes.ts`, directly after the `export type ReorderBlocksInput = ...` line (~107):

```ts
// Move a line to a different pricing-table (line_items) block on the same
// quote. The service appends it to the end of the target block's sort order;
// bundle children follow their parent.
export const moveQuoteLineSchema = z.object({ blockId: z.string().guid() });
export type MoveQuoteLineInput = z.infer<typeof moveQuoteLineSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/shared && pnpm vitest run src/validators/quotes.test.ts`
Expected: PASS (all existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/quotes.ts packages/shared/src/validators/quotes.test.ts
git commit -m "feat(quotes): moveQuoteLineSchema validator for cross-panel line moves"
```

---

### Task 2: Service `moveLineToBlock` + real-DB integration tests

**Files:**
- Modify: `apps/api/src/services/quoteService.ts` (append after `reorderLines`, ~line 467)
- Test: `apps/api/src/__tests__/integration/quoteService.integration.test.ts`

**Interfaces:**
- Consumes: existing helpers `loadDraft`, `QuoteServiceError`, `db`, schema tables `quoteLines`/`quoteBlocks` (all already imported in the file; `and`, `eq`, `sql` already imported from drizzle-orm).
- Produces: `export async function moveLineToBlock(quoteId: string, lineId: string, targetBlockId: string, actor: QuoteActor)` → returns the updated `quote_lines` row. Error codes: `LINE_NOT_FOUND` (404), `LINE_IS_BUNDLE_CHILD` (400), `BLOCK_NOT_FOUND` (404), `BLOCK_NOT_LINE_ITEMS` (400), plus `loadDraft`'s `QUOTE_NOT_FOUND`/`ORG_DENIED`/`NOT_A_DRAFT`.

- [ ] **Step 1: Write the failing integration tests**

Append to `apps/api/src/__tests__/integration/quoteService.integration.test.ts`. Add `moveLineToBlock` and `addBlock` to the existing `from '../../services/quoteService'` import (addBlock is already imported), and add `quoteBlocks` to the `from '../../db/schema/quotes'` import. Then append inside the top-level `describe('quoteService (breeze_app, real DB)', ...)` block:

```ts
  // ---- moveLineToBlock ------------------------------------------------------

  /** Seed a quote with two pricing blocks and three manual lines: A1, A2 in
   *  blockA; B1 in blockB. Returns everything the move tests need. */
  async function seedTwoPanelQuote(fx: Fixture) {
    return withDbAccessContext(fx.ctxA, async () => {
      const quote = await createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA);
      const blockA = await addBlock(quote.id, { blockType: 'line_items', content: {} }, fx.actorA);
      const blockB = await addBlock(quote.id, { blockType: 'line_items', content: {} }, fx.actorA);
      const mk = (name: string, blockId: string) =>
        addManualLine(quote.id, {
          sourceType: 'manual', name, description: null, quantity: 1, unitPrice: 10,
          taxable: false, customerVisible: true, recurrence: 'one_time', blockId,
        }, fx.actorA);
      const lineA1 = await mk('A1', blockA.id);
      const lineA2 = await mk('A2', blockA.id);
      const lineB1 = await mk('B1', blockB.id);
      return { quote, blockA, blockB, lineA1, lineA2, lineB1 };
    });
  }

  runDb('moveLineToBlock appends the line to the end of the target block', async () => {
    const fx = await seedFixture();
    const s = await seedTwoPanelQuote(fx);

    const moved = await withDbAccessContext(fx.ctxA, () =>
      moveLineToBlock(s.quote.id, s.lineA1.id, s.blockB.id, fx.actorA)
    );
    expect(moved.blockId).toBe(s.blockB.id);
    expect(moved.sortOrder).toBeGreaterThan(s.lineB1.sortOrder);

    const rows = await withDbAccessContext(fx.ctxA, () =>
      db.select({ id: quoteLines.id, blockId: quoteLines.blockId, sortOrder: quoteLines.sortOrder })
        .from(quoteLines).where(eq(quoteLines.quoteId, s.quote.id))
    );
    const inB = rows.filter((r) => r.blockId === s.blockB.id).sort((a, b) => a.sortOrder - b.sortOrder);
    expect(inB.map((r) => r.id)).toEqual([s.lineB1.id, s.lineA1.id]);
    const inA = rows.filter((r) => r.blockId === s.blockA.id);
    expect(inA.map((r) => r.id)).toEqual([s.lineA2.id]);
  });

  runDb('moveLineToBlock is a no-op success when the line is already in the target block', async () => {
    const fx = await seedFixture();
    const s = await seedTwoPanelQuote(fx);
    const moved = await withDbAccessContext(fx.ctxA, () =>
      moveLineToBlock(s.quote.id, s.lineA1.id, s.blockA.id, fx.actorA)
    );
    expect(moved.blockId).toBe(s.blockA.id);
    expect(moved.sortOrder).toBe(s.lineA1.sortOrder); // untouched
  });

  runDb('moveLineToBlock rejects a non-line_items target block', async () => {
    const fx = await seedFixture();
    const s = await seedTwoPanelQuote(fx);
    const heading = await withDbAccessContext(fx.ctxA, () =>
      addBlock(s.quote.id, { blockType: 'heading', content: { text: 'Summary', level: 2 } }, fx.actorA)
    );
    await expect(withDbAccessContext(fx.ctxA, () =>
      moveLineToBlock(s.quote.id, s.lineA1.id, heading.id, fx.actorA)
    )).rejects.toMatchObject({ code: 'BLOCK_NOT_LINE_ITEMS', status: 400 });
  });

  runDb('moveLineToBlock 404s when the target block belongs to another quote', async () => {
    const fx = await seedFixture();
    const s = await seedTwoPanelQuote(fx);
    const other = await withDbAccessContext(fx.ctxA, async () => {
      const q2 = await createQuote({ orgId: fx.orgA.id, currencyCode: 'USD' }, fx.actorA);
      return addBlock(q2.id, { blockType: 'line_items', content: {} }, fx.actorA);
    });
    await expect(withDbAccessContext(fx.ctxA, () =>
      moveLineToBlock(s.quote.id, s.lineA1.id, other.id, fx.actorA)
    )).rejects.toMatchObject({ code: 'BLOCK_NOT_FOUND', status: 404 });
  });

  runDb('moveLineToBlock moves bundle children with their parent, in order', async () => {
    const fx = await seedFixture();
    const s = await seedTwoPanelQuote(fx);
    // Seed two bundle children under lineA1 directly (system scope bypasses RLS
    // for the seed, matching the sibling seed helpers in this file).
    const [c1, c2] = await withSystemDbAccessContext(async () => {
      const mkChild = async (name: string, sortOrder: number) => {
        const [row] = await db.insert(quoteLines).values({
          quoteId: s.quote.id, orgId: fx.orgA.id, blockId: s.blockA.id,
          sourceType: 'bundle', parentLineId: s.lineA1.id, name,
          quantity: '1.00', unitPrice: '5.00', lineTotal: '5.00',
          taxable: false, customerVisible: true, recurrence: 'one_time', sortOrder,
        }).returning();
        return row!;
      };
      return [await mkChild('child-1', 10), await mkChild('child-2', 11)];
    });

    await withDbAccessContext(fx.ctxA, () =>
      moveLineToBlock(s.quote.id, s.lineA1.id, s.blockB.id, fx.actorA)
    );
    const rows = await withDbAccessContext(fx.ctxA, () =>
      db.select({ id: quoteLines.id, blockId: quoteLines.blockId, sortOrder: quoteLines.sortOrder })
        .from(quoteLines).where(eq(quoteLines.quoteId, s.quote.id))
    );
    const inB = rows.filter((r) => r.blockId === s.blockB.id).sort((a, b) => a.sortOrder - b.sortOrder);
    expect(inB.map((r) => r.id)).toEqual([s.lineB1.id, s.lineA1.id, c1.id, c2.id]);
  });

  runDb('moveLineToBlock rejects moving a bundle child directly', async () => {
    const fx = await seedFixture();
    const s = await seedTwoPanelQuote(fx);
    const child = await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(quoteLines).values({
        quoteId: s.quote.id, orgId: fx.orgA.id, blockId: s.blockA.id,
        sourceType: 'bundle', parentLineId: s.lineA1.id, name: 'child',
        quantity: '1.00', unitPrice: '5.00', lineTotal: '5.00',
        taxable: false, customerVisible: true, recurrence: 'one_time', sortOrder: 10,
      }).returning();
      return row!;
    });
    await expect(withDbAccessContext(fx.ctxA, () =>
      moveLineToBlock(s.quote.id, child.id, s.blockB.id, fx.actorA)
    )).rejects.toMatchObject({ code: 'LINE_IS_BUNDLE_CHILD', status: 400 });
  });
```

Note: if the `quote_lines` insert in the child seeds fails typecheck on a required column, check `apps/api/src/db/schema/quotes.ts:81` for NOT NULL columns without defaults and add them — do not weaken the test.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && pnpm test:docker:up
pnpm test:integration src/__tests__/integration/quoteService.integration.test.ts
```
Expected: FAIL — `moveLineToBlock` is not exported. (If the docker DB can't start, the `runDb` tests skip; in that case verify the failure mode by the import error and continue, noting it for CI.)

- [ ] **Step 3: Implement the service method**

Append to `apps/api/src/services/quoteService.ts` after `reorderLines`:

```ts
/**
 * Move a line to a different line_items block on the SAME quote, appending it
 * (and any bundle children, preserving their relative order) to the end of the
 * target block's sort order. Bundle children can never be moved independently
 * — they ride with their parent. Totals are untouched: a move changes no
 * amounts, so there is no recomputeAndPersist here.
 */
export async function moveLineToBlock(
  quoteId: string,
  lineId: string,
  targetBlockId: string,
  actor: QuoteActor
) {
  await loadDraft(quoteId, actor);
  const [line] = await db.select().from(quoteLines)
    .where(and(eq(quoteLines.id, lineId), eq(quoteLines.quoteId, quoteId))).limit(1);
  if (!line) throw new QuoteServiceError('Line not found', 404, 'LINE_NOT_FOUND');
  if (line.parentLineId) {
    throw new QuoteServiceError('Bundle child lines move with their parent', 400, 'LINE_IS_BUNDLE_CHILD');
  }
  const [block] = await db.select({ id: quoteBlocks.id, blockType: quoteBlocks.blockType })
    .from(quoteBlocks)
    .where(and(eq(quoteBlocks.id, targetBlockId), eq(quoteBlocks.quoteId, quoteId))).limit(1);
  if (!block) throw new QuoteServiceError('Block not found', 404, 'BLOCK_NOT_FOUND');
  if (block.blockType !== 'line_items') {
    throw new QuoteServiceError('Target block is not a pricing table', 400, 'BLOCK_NOT_LINE_ITEMS');
  }
  if (line.blockId === targetBlockId) return line; // already there — no-op

  const [maxRow] = await db
    .select({ max: sql<number>`COALESCE(MAX(${quoteLines.sortOrder}), -1)` })
    .from(quoteLines)
    .where(and(eq(quoteLines.quoteId, quoteId), eq(quoteLines.blockId, targetBlockId)));
  const base = Number(maxRow?.max ?? -1) + 1;

  await db.transaction(async (tx) => {
    await tx.update(quoteLines).set({ blockId: targetBlockId, sortOrder: base })
      .where(and(eq(quoteLines.id, lineId), eq(quoteLines.quoteId, quoteId)));
    const children = await tx.select({ id: quoteLines.id }).from(quoteLines)
      .where(and(eq(quoteLines.quoteId, quoteId), eq(quoteLines.parentLineId, lineId)))
      .orderBy(quoteLines.sortOrder);
    for (const [i, child] of children.entries()) {
      await tx.update(quoteLines).set({ blockId: targetBlockId, sortOrder: base + 1 + i })
        .where(eq(quoteLines.id, child.id));
    }
  });

  const [updated] = await db.select().from(quoteLines).where(eq(quoteLines.id, lineId)).limit(1);
  return updated!;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && pnpm test:integration src/__tests__/integration/quoteService.integration.test.ts`
Expected: PASS (all pre-existing + 6 new; or SKIPPED if no DB — then at minimum `pnpm vitest run src/routes/quotes` must still pass to prove nothing broke at compile level).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteService.ts apps/api/src/__tests__/integration/quoteService.integration.test.ts
git commit -m "feat(quotes): moveLineToBlock service — cross-panel line move with bundle children"
```

---

### Task 3: Route `PATCH /:id/lines/:lineId/move`

**Files:**
- Modify: `apps/api/src/routes/quotes/quotes.ts` (imports at lines 7-16; new route after the `PATCH /:id/lines/:lineId` handler, ~line 98)
- Test: `apps/api/src/routes/quotes/quotes.test.ts`

**Interfaces:**
- Consumes: `moveQuoteLineSchema` (Task 1), `moveLineToBlock` (Task 2), existing `lineParam`, `scopes`, `writePerm`, `quoteActorFrom`, `handleServiceError`.
- Produces: `PATCH /quotes/:id/lines/:lineId/move`, body `{ blockId }`, responds `{ data: <updated line row> }`.

- [ ] **Step 1: Write the failing route tests**

In `apps/api/src/routes/quotes/quotes.test.ts`:

1. Add `moveLineToBlock: vi.fn(),` to the `vi.mock('../../services/quoteService', ...)` factory (after `reorderLines: vi.fn(),` at line 18). **This is required** — once the route imports `moveLineToBlock`, a mock factory without it throws "No export defined on mock".
2. The file defines `QUOTE_ID` and `BLOCK_ID` at top level, but `LINE_ID` only as a local const inside another describe (line ~237) — so the new describe declares its own. Append this describe inside `describe('quote crud + lines routes', ...)`:

```ts
  describe('PATCH /:id/lines/:lineId/move', () => {
    const LINE_ID = '44444444-4444-4444-4444-444444444444';
    it('returns 200 { data: line } and calls moveLineToBlock with ids + actor', async () => {
      (svc.moveLineToBlock as any).mockResolvedValue({ id: LINE_ID, blockId: BLOCK_ID, sortOrder: 3 });
      const res = await app().request(`/${QUOTE_ID}/lines/${LINE_ID}/move`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blockId: BLOCK_ID }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.blockId).toBe(BLOCK_ID);
      expect(svc.moveLineToBlock).toHaveBeenCalledWith(QUOTE_ID, LINE_ID, BLOCK_ID, expect.anything());
    });

    it('400s on a non-guid blockId without calling the service', async () => {
      const res = await app().request(`/${QUOTE_ID}/lines/${LINE_ID}/move`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blockId: 'nope' }),
      });
      expect(res.status).toBe(400);
      expect(svc.moveLineToBlock).not.toHaveBeenCalled();
    });

    it('maps QuoteServiceError to its status + code', async () => {
      (svc.moveLineToBlock as any).mockRejectedValue(
        new QuoteServiceError('Target block is not a pricing table', 400, 'BLOCK_NOT_LINE_ITEMS')
      );
      const res = await app().request(`/${QUOTE_ID}/lines/${LINE_ID}/move`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blockId: BLOCK_ID }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('BLOCK_NOT_LINE_ITEMS');
    });

    it('is blocked by the write-permission gate', async () => {
      gate.permGate = async (c: any) => c.json({ error: 'forbidden' }, 403);
      const res = await app().request(`/${QUOTE_ID}/lines/${LINE_ID}/move`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blockId: BLOCK_ID }),
      });
      expect(res.status).toBe(403);
      expect(svc.moveLineToBlock).not.toHaveBeenCalled();
    });
  });
```


- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && pnpm vitest run src/routes/quotes/quotes.test.ts`
Expected: FAIL — the new describe's requests hit 404 (route doesn't exist yet).

- [ ] **Step 3: Add the route**

In `apps/api/src/routes/quotes/quotes.ts`:
- Add `moveQuoteLineSchema` to the `@breeze/shared` import list (line 7-11).
- Add `moveLineToBlock` to the `quoteService` import list (line 12-16).
- Insert after the `quoteCrudRoutes.patch('/:id/lines/:lineId', ...)` handler (line ~98):

```ts
quoteCrudRoutes.patch('/:id/lines/:lineId/move', scopes, writePerm, zValidator('param', lineParam), zValidator('json', moveQuoteLineSchema), async (c) => {
  try { const p = c.req.valid('param'); return c.json({ data: await moveLineToBlock(p.id, p.lineId, c.req.valid('json').blockId, quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && pnpm vitest run src/routes/quotes/quotes.test.ts`
Expected: PASS (all existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/quotes/quotes.ts apps/api/src/routes/quotes/quotes.test.ts
git commit -m "feat(quotes): PATCH /quotes/:id/lines/:lineId/move endpoint"
```

---

### Task 4: Web client wrapper `moveLine`

**Files:**
- Modify: `apps/web/src/lib/api/quotes.ts` (after `reorderLines`, ~line 164)

**Interfaces:**
- Produces: `moveLine(id: string, lineId: string, body: { blockId: string }): Promise<Response>` — same thin `fetchWithAuth` shape as every other wrapper in the file (caller wraps in `runAction`).

- [ ] **Step 1: Add the wrapper**

```ts
/** Move a line to a different pricing-table block
 *  (PATCH /quotes/:id/lines/:lineId/move). The server appends it to the end of
 *  the target block's sort order; bundle children follow their parent. */
export function moveLine(id: string, lineId: string, body: { blockId: string }): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/lines/${lineId}/move`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}
```

No dedicated test — the wrapper is exercised by the Task 6 component tests (mirrors how `reorderLines` is covered).

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/lib/api/quotes.ts
git commit -m "feat(quotes): web client wrapper for line move endpoint"
```

---

### Task 5: QuoteEditor UI — "Move to…" menu + optimistic cross-panel move

**Files:**
- Modify: `apps/web/src/components/billing/quotes/QuoteEditor.tsx`
- Modify (mock lists only): `QuoteEditor.test.tsx`, `QuoteEditor.reorder.test.tsx`, `QuoteEditor.editline.test.tsx`, `QuoteEditor.costmarkup.test.tsx`, `QuoteEditor.removeblock.test.tsx` (all in the same directory)

**Interfaces:**
- Consumes: `moveLine` from `../../../lib/api/quotes` (Task 4), existing `runAction`/`handleActionError`/`refresh`/`applyOrder`/`lineOrder`/`lineReorderBase` machinery.
- Produces (component-internal, but the Task 6 tests rely on these exact names/testids):
  - `QuoteEditor`-level handler `moveLineTo(line: QuoteLine, targetBlockId: string): void`
  - `BlockCard` props: `moveTargets: { id: string; label: string }[]`, `onMoveLineToBlock: (line: QuoteLine, targetBlockId: string) => void`
  - `EditableLineRow` props: `moveTargets: { id: string; label: string }[]`, `onMoveTo: (line: QuoteLine, targetBlockId: string) => void`
  - Testids: trigger `quote-line-move-to-${line.id}`, menu `quote-line-move-to-menu-${line.id}`, per-target item `quote-line-move-to-${line.id}-${target.id}`

All edits below are in `QuoteEditor.tsx` unless noted.

- [ ] **Step 1: Imports**

- Line 2: add `FolderInput` to the lucide import.
- Lines 7-19: add `moveLine as moveLineApi,` to the `../../../lib/api/quotes` import list.

- [ ] **Step 2: Optimistic cross-panel state**

After the `const [lineOrder, setLineOrder] = ...` declaration (~line 380), add:

```ts
  // Cross-panel move override: lineId → target blockId. Layered UNDER lineOrder
  // (the override changes which panel a line filters into; lineOrder then fixes
  // its position within that panel). Cleared when fresh server data lands, same
  // as lineOrder.
  const [lineBlockOverride, setLineBlockOverride] = useState<Record<string, string>>({});
```

Extend the existing lines-reset effect (~line 392) from

```ts
  useEffect(() => { setLineOrder({}); lineReorderBase.current = {}; }, [lines]);
```

to

```ts
  useEffect(() => { setLineOrder({}); lineReorderBase.current = {}; setLineBlockOverride({}); }, [lines]);
```

Change `linesForBlock` (~line 516) to filter on the effective block id:

```ts
  const linesForBlock = useCallback(
    (blockId: string) =>
      applyOrder(
        lines
          .filter((l) => (lineBlockOverride[l.id] ?? l.blockId) === blockId)
          .sort((a, b) => a.sortOrder - b.sortOrder),
        lineOrder[blockId],
      ),
    [lines, lineOrder, lineBlockOverride],
  );
```

- [ ] **Step 3: Panel list + labels**

After `sortedBlocks` (~line 514), add:

```ts
  // The quote's pricing panels, in document order — the "Move to…" menu offers
  // every panel except the line's own. Label precedence mirrors the BlockCard
  // header: the author's table label, else "Pricing table N" by position.
  const pricingBlocks = useMemo(
    () => sortedBlocks.filter((b) => b.blockType === 'line_items'),
    [sortedBlocks],
  );
  const pricingBlockLabel = useCallback((b: QuoteBlock) => {
    const label = ((b.content?.label as string | undefined) ?? '').trim();
    if (label) return label;
    return `Pricing table ${pricingBlocks.findIndex((x) => x.id === b.id) + 1}`;
  }, [pricingBlocks]);
```

- [ ] **Step 4: The move handler**

After `moveLine` (the chevron reorder callback, ends ~line 895), add:

```ts
  // Cross-panel move: optimistic on both panels at once (the line leaves its
  // source table and appends to the target, bundle children in tow), committed
  // via the dedicated move endpoint. No debounce — unlike the chevrons, a move
  // is one discrete action. Failure reverts both panels and re-pulls the
  // authoritative server order (same recovery shape as moveBlock/moveLine).
  const moveLineTo = useCallback((line: QuoteLine, targetBlockId: string) => {
    const sourceBlockId = line.blockId;
    if (!sourceBlockId || sourceBlockId === targetBlockId) return;
    const movedIds = [line.id, ...lines.filter((l) => l.parentLineId === line.id).map((l) => l.id)];
    const sourceIds = (lineReorderBase.current[sourceBlockId] ?? linesForBlock(sourceBlockId).map((l) => l.id))
      .filter((id) => !movedIds.includes(id));
    const targetIds = [
      ...(lineReorderBase.current[targetBlockId] ?? linesForBlock(targetBlockId).map((l) => l.id))
        .filter((id) => !movedIds.includes(id)),
      ...movedIds,
    ];
    lineReorderBase.current = { ...lineReorderBase.current, [sourceBlockId]: sourceIds, [targetBlockId]: targetIds };
    setLineBlockOverride((m) => {
      const n = { ...m };
      for (const id of movedIds) n[id] = targetBlockId;
      return n;
    });
    setLineOrder((m) => ({ ...m, [sourceBlockId]: sourceIds, [targetBlockId]: targetIds }));
    void (async () => {
      try {
        await runAction({
          request: () => moveLineApi(quote.id, line.id, { blockId: targetBlockId }),
          errorFallback: 'Could not move the line.',
          successMessage: 'Line moved',
          onUnauthorized: UNAUTHORIZED,
        });
        refresh();
      } catch (err) {
        handleActionError(err, 'Could not move the line.');
        setLineBlockOverride((m) => {
          const n = { ...m };
          for (const id of movedIds) delete n[id];
          return n;
        });
        setLineOrder((m) => { const n = { ...m }; delete n[sourceBlockId]; delete n[targetBlockId]; return n; });
        delete lineReorderBase.current[sourceBlockId];
        delete lineReorderBase.current[targetBlockId];
        refresh();
      }
    })();
  }, [lines, linesForBlock, quote.id, refresh]);
```

- [ ] **Step 5: Thread props through BlockCard**

In the `sortedBlocks.map` render (~line 956), add two props to `<BlockCard>` next to `onMoveLine`:

```tsx
                onMoveLineToBlock={moveLineTo}
                moveTargets={
                  block.blockType === 'line_items'
                    ? pricingBlocks.filter((b) => b.id !== block.id).map((b) => ({ id: b.id, label: pricingBlockLabel(b) }))
                    : []
                }
```

In `BlockCard`'s destructuring + props type (~lines 1232-1262), add:

```ts
  moveTargets, onMoveLineToBlock,
```
and to the type:
```ts
  /** Other pricing panels this block's lines can move to (empty → control hidden). */
  moveTargets: { id: string; label: string }[];
  onMoveLineToBlock: (line: QuoteLine, targetBlockId: string) => void;
```

In `BlockCard`'s `<EditableLineRow>` render (~line 1493), add:

```tsx
                        moveTargets={moveTargets}
                        onMoveTo={onMoveLineToBlock}
```

- [ ] **Step 6: The row control in EditableLineRow**

Add to `EditableLineRow`'s destructuring + props type (~lines 1822-1837):

```ts
  moveTargets, onMoveTo,
```
```ts
  /** Other pricing panels (empty → the Move-to control is hidden). */
  moveTargets: { id: string; label: string }[];
  onMoveTo: (line: QuoteLine, targetBlockId: string) => void;
```

Inside the component body (next to the other `useState` hooks, ~line 1856), add the menu state. The menu is `position: fixed` (anchored from the trigger's rect at open time) because the pricing table sits in an `overflow-x-auto` wrapper — an absolutely-positioned menu would be clipped by the scroll container on the last row:

```ts
  // "Move to…" menu. Fixed-position so the overflow-x-auto table wrapper can't
  // clip it; closes on outside click or Escape.
  const [movePos, setMovePos] = useState<{ top: number; left: number } | null>(null);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!movePos) return;
    const onDown = (e: MouseEvent) => {
      if (moveMenuRef.current && !moveMenuRef.current.contains(e.target as Node)) setMovePos(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMovePos(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [movePos]);
```

In the actions cell (~line 2173), between `<MoveControls .../>` and the Remove button, add:

```tsx
          {moveTargets.length > 0 && !line.parentLineId && (
            <div ref={moveMenuRef}>
              <button
                type="button"
                onClick={(e) => {
                  if (movePos) { setMovePos(null); return; }
                  const r = e.currentTarget.getBoundingClientRect();
                  setMovePos({ top: r.bottom + 4, left: r.right });
                }}
                disabled={removeBusy}
                aria-label="Move line to another pricing table"
                aria-haspopup="menu"
                aria-expanded={movePos !== null}
                data-testid={`quote-line-move-to-${line.id}`}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
              >
                <FolderInput className="h-4 w-4" aria-hidden />
              </button>
              {movePos && (
                <div
                  role="menu"
                  aria-label="Move line to"
                  style={{ position: 'fixed', top: movePos.top, left: movePos.left, transform: 'translateX(-100%)' }}
                  className="z-50 min-w-40 rounded-md border bg-card py-1 shadow-md"
                  data-testid={`quote-line-move-to-menu-${line.id}`}
                >
                  <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Move to</p>
                  {moveTargets.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="menuitem"
                      onClick={() => { setMovePos(null); onMoveTo(line, t.id); }}
                      data-testid={`quote-line-move-to-${line.id}-${t.id}`}
                      className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
```

- [ ] **Step 7: Add `moveLine` to the existing factory mocks**

The component now imports `moveLine`, so every test file that mocks `../../../lib/api/quotes` with a plain factory must include it or vitest throws "No 'moveLine' export defined on mock". Add the line `  moveLine: vi.fn(),` to the factory object in each of:

- `QuoteEditor.test.tsx` (~line 27)
- `QuoteEditor.reorder.test.tsx` (~line 34)
- `QuoteEditor.editline.test.tsx` (~line 34)
- `QuoteEditor.costmarkup.test.tsx` (~line 33)
- `QuoteEditor.removeblock.test.tsx` (~line 27)

(`QuoteEditor.distributor.test.tsx` and the `QuoteDetail.*` files spread `importOriginal` — no change needed. `QuoteEditor.permissions.test.tsx`: check whether it factory-mocks the module; if yes, add the line there too.)

- [ ] **Step 8: Run the whole existing QuoteEditor suite**

Run: `cd apps/web && pnpm vitest run src/components/billing/quotes`
Expected: PASS — everything existing still green (the new control renders only when ≥2 pricing panels exist; every existing fixture has at most one, so no snapshot/behavior churn).

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/billing/quotes/QuoteEditor.tsx apps/web/src/components/billing/quotes/QuoteEditor.test.tsx apps/web/src/components/billing/quotes/QuoteEditor.reorder.test.tsx apps/web/src/components/billing/quotes/QuoteEditor.editline.test.tsx apps/web/src/components/billing/quotes/QuoteEditor.costmarkup.test.tsx apps/web/src/components/billing/quotes/QuoteEditor.removeblock.test.tsx apps/web/src/components/billing/quotes/QuoteEditor.permissions.test.tsx
git commit -m "feat(quotes): Move-to menu on quote lines — cross-panel move in the editor"
```

(Drop `QuoteEditor.permissions.test.tsx` from the add list if it needed no change.)

---

### Task 6: Component tests `QuoteEditor.moveline.test.tsx`

**Files:**
- Create: `apps/web/src/components/billing/quotes/QuoteEditor.moveline.test.tsx`

**Interfaces:**
- Consumes: testids from Task 5 (`quote-line-move-to-${id}`, `quote-line-move-to-menu-${id}`, `quote-line-move-to-${id}-${blockId}`, existing `quote-block-lines-${blockId}`), `moveLine` mock.

- [ ] **Step 1: Write the test file**

Model the harness on `QuoteEditor.reorder.test.tsx` (same auth/toast/catalog/api mocks — copy its mock preamble verbatim, adding `moveLine: vi.fn(),` and importing `moveLine` instead of the reorder fns). Full file:

```tsx
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { moveLine } from '../../../lib/api/quotes';

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
  ),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

vi.mock('../../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: [] }) } as unknown as Response,
  ),
  createCatalogItem: vi.fn(),
  catalogItemImagePath: vi.fn().mockReturnValue('/catalog/x/image'),
}));

const okResponse = () =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: { ok: true } }) } as unknown as Response);

vi.mock('../../../lib/api/quotes', () => ({
  addBlock: vi.fn(),
  deleteBlock: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  reorderBlocks: vi.fn(),
  reorderLines: vi.fn(),
  moveLine: vi.fn(),
  uploadQuoteImage: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const mkTable = (id: string, sortOrder: number, label?: string): QuoteDetailData['blocks'][number] => ({
  id, quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
  content: label ? { label } : {}, sortOrder, createdAt: '2026-06-01T00:00:00Z',
});

const mkLine = (id: string, blockId: string, sortOrder: number): QuoteDetailData['lines'][number] => ({
  id, quoteId: 'q-1', blockId, orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: null, description: `Line ${id}`, quantity: '1.00',
  unitPrice: '50.00', taxable: false, customerVisible: true, lineTotal: '50.00',
  recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder,
  createdAt: '2026-06-01T00:00:00Z',
});

const quote: QuoteDetailData['quote'] = {
  id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
  currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '150.00', taxRate: null,
  taxTotal: '0.00', total: '150.00', oneTimeTotal: '150.00', monthlyRecurringTotal: '0.00',
  annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
  termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
  convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
};

const twoPanels: QuoteDetailData = {
  quote,
  blocks: [mkTable('blk-1', 0, 'Services'), mkTable('blk-2', 1, 'Hardware')],
  lines: [mkLine('l-1', 'blk-1', 0), mkLine('l-2', 'blk-1', 1), mkLine('l-3', 'blk-2', 2)],
};

const onePanel: QuoteDetailData = {
  quote,
  blocks: [mkTable('blk-1', 0, 'Services')],
  lines: [mkLine('l-1', 'blk-1', 0)],
};

const moveLineMock = vi.mocked(moveLine);

describe('QuoteEditor — move line between pricing panels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    moveLineMock.mockResolvedValue(okResponse());
  });

  it('hides the Move-to control when the quote has a single pricing panel', async () => {
    render(<QuoteEditor detail={onePanel} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-line-move-to-l-1')).not.toBeInTheDocument();
  });

  it('lists only the OTHER panels, labeled, in the Move-to menu', async () => {
    render(<QuoteEditor detail={twoPanels} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-line-move-to-l-1'));
    const menu = screen.getByTestId('quote-line-move-to-menu-l-1');
    expect(within(menu).getByTestId('quote-line-move-to-l-1-blk-2')).toHaveTextContent('Hardware');
    expect(within(menu).queryByTestId('quote-line-move-to-l-1-blk-1')).not.toBeInTheDocument();
  });

  it('falls back to "Pricing table N" for an unlabeled target panel', async () => {
    const unlabeled: QuoteDetailData = {
      ...twoPanels,
      blocks: [mkTable('blk-1', 0, 'Services'), mkTable('blk-2', 1)],
    };
    render(<QuoteEditor detail={unlabeled} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-line-move-to-l-1'));
    expect(screen.getByTestId('quote-line-move-to-l-1-blk-2')).toHaveTextContent('Pricing table 2');
  });

  it('moves the line optimistically and PATCHes the move endpoint', async () => {
    const onChanged = vi.fn();
    render(<QuoteEditor detail={twoPanels} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-line-move-to-l-1'));
    fireEvent.click(screen.getByTestId('quote-line-move-to-l-1-blk-2'));

    // Optimistic: l-1's qty input now renders inside blk-2's table, after l-3.
    const targetTable = screen.getByTestId('quote-block-lines-blk-2');
    expect(within(targetTable).getByTestId('quote-line-qty-l-1')).toBeInTheDocument();
    const sourceTable = screen.getByTestId('quote-block-lines-blk-1');
    expect(within(sourceTable).queryByTestId('quote-line-qty-l-1')).not.toBeInTheDocument();

    await waitFor(() => expect(moveLineMock).toHaveBeenCalledWith('q-1', 'l-1', { blockId: 'blk-2' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('reverts the optimistic move and toasts when the PATCH fails', async () => {
    moveLineMock.mockResolvedValue(
      { ok: false, status: 500, statusText: 'err', json: vi.fn().mockResolvedValue({ error: 'boom' }) } as unknown as Response,
    );
    render(<QuoteEditor detail={twoPanels} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-line-move-to-l-1'));
    fireEvent.click(screen.getByTestId('quote-line-move-to-l-1-blk-2'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    // Reverted: l-1 back in blk-1's table.
    await waitFor(() => {
      const sourceTable = screen.getByTestId('quote-block-lines-blk-1');
      expect(within(sourceTable).getByTestId('quote-line-qty-l-1')).toBeInTheDocument();
    });
  });
});
```

(The qty testid `quote-line-qty-${id}` is confirmed at QuoteEditor.tsx:2118.)

- [ ] **Step 2: Run the new tests**

Run: `cd apps/web && pnpm vitest run src/components/billing/quotes/QuoteEditor.moveline.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/billing/quotes/QuoteEditor.moveline.test.tsx
git commit -m "test(quotes): cross-panel line move component coverage"
```

---

### Task 7: Full verification sweep

- [ ] **Step 1: Run every touched suite**

```bash
cd packages/shared && pnpm vitest run
cd ../../apps/api && pnpm vitest run src/routes/quotes
cd ../web && pnpm vitest run src/components/billing/quotes
```
Expected: all PASS.

- [ ] **Step 2: Integration suite (if the docker test DB is up)**

```bash
cd ../api && pnpm test:integration src/__tests__/integration/quoteService.integration.test.ts
```
Expected: PASS (or skipped-without-DB, noted in the handoff).

- [ ] **Step 3: Verify end-to-end if a dev stack is available**

Use the `verify` skill / dev stack if available: open a draft quote with two pricing tables, move a line via the new menu, reload, confirm it persisted; try a quote with one panel (control hidden).

- [ ] **Step 4: Final commit if anything moved**

```bash
git status --short   # should be clean; commit any stragglers with context
```

# Quote Designer: Move Line Items Between Pricing Panels

**Date:** 2026-07-05
**Status:** Approved design, pending implementation

## Problem

In the quote designer, line items live inside pricing panels (`quote_blocks` rows with
`blockType = 'line_items'`; each `quote_lines` row references its panel via a nullable
`blockId` and orders within it via `sortOrder`). Today a line can be reordered within
its panel (chevron controls, `PATCH /quotes/:id/blocks/:blockId/lines/reorder`), but
there is no way to move a line to a *different* panel:

- `updateQuoteLineSchema` does not accept `blockId` and `updateLine` never writes it.
- `reorderLines` is scoped to a single block and rejects foreign line IDs.

The DB already supports the move — only the API and UI need to expose it.

## Decisions

- **Interaction:** a "Move to…" menu action on the line item row (no drag-and-drop; the
  app has no DnD library and the existing pattern is discrete controls).
- **Picker scope:** lists *existing* pricing panels only; the moved line is appended to
  the end of the chosen panel. No "create new panel" option.
- **Persistence:** a dedicated move endpoint, mirroring the existing dedicated reorder
  endpoints, rather than overloading the totals-recomputing `updateLine` path.

## API

### Validator (`packages/shared/src/validators/quotes.ts`)

```ts
export const moveQuoteLineSchema = z.object({ blockId: z.string().guid() });
```

### Route (`apps/api/src/routes/quotes/quotes.ts`)

`PATCH /quotes/:id/lines/:lineId/move` — body `{ blockId }`, mounted alongside the
existing reorder routes, same auth/tenancy middleware as the other line mutations.

### Service (`apps/api/src/services/quoteService.ts`)

`moveLineToBlock(quoteId, lineId, targetBlockId, ctx)` — single transaction:

1. Load the line; error if not found or if `parentLineId` is set (bundle children move
   with their parent, never independently).
2. Verify the target block belongs to the same quote and has `blockType = 'line_items'`;
   reject otherwise. If the line is already in the target block, return success (no-op).
3. Update the line: `blockId = target`, `sortOrder = max(sortOrder in target block) + 1`.
4. Bundle children (rows with `parentLineId = lineId`) get the same target `blockId` and
   sortOrders immediately after the parent, preserving their relative order.
5. No totals recompute — a move changes no amounts.

No schema migration; `quote_lines.blockId` is already a mutable nullable FK. RLS
unaffected (existing org-scoped policies on `quotes`/`quote_blocks`/`quote_lines`).

## Web

### Client (`apps/web/src/lib/api/quotes.ts`)

`moveLine(quoteId, lineId, { blockId })` → `PATCH /quotes/:id/lines/:lineId/move`.

### UI (`apps/web/src/components/billing/quotes/QuoteEditor.tsx`)

- `EditableLineRow` actions cell gains a "Move to…" icon button (lucide `FolderInput`,
  `data-testid="quote-line-move-to-${line.id}"`). Rendered only when the quote has ≥2
  `line_items` blocks and the line is not a bundle child.
- Clicking opens a small dropdown listing the *other* pricing panels, labeled by the
  author's table label ("Hardware"), falling back to "Pricing table N" by position
  when a panel has no label.
- Selecting a panel performs an optimistic move: update the line's `blockId` in local
  state (lines are a flat array), append its ID to the target panel's optimistic
  `lineOrder`, then persist via `runAction`-wrapped `moveLine`. On failure, revert the
  optimistic state (same pattern as the existing reorder revert); `runAction` surfaces
  the error toast.
- No debounce — a move is a single discrete action, unlike chevron reordering.

## Testing

- **Validator:** `moveQuoteLineSchema` accept/reject cases in
  `packages/shared/src/validators/quotes.test.ts`.
- **Service/route** (alongside existing quote service/route tests): happy path;
  cross-quote target block rejected; non-`line_items` target rejected; bundle children
  follow parent; moving a bundle child directly rejected; moved line appended at end of
  target sort order; same-block move is a no-op success.
- **Web:** new `QuoteEditor.moveline.test.tsx` — button hidden with a single panel;
  dropdown lists only other panels; optimistic move renders line under target panel;
  API called with correct payload; revert on API failure.

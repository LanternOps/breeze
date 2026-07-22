# Quote editor UX follow-ups (from two design reviews)

**Status**: 2026-07-21 — Tasks A, C, D, E, F, B1 DONE (uncommitted in the shared worktree, 530 web + shared tests green; B1 also fixed a bulk-markup bug that zeroed prices on explicit-0-cost lines). **Only B2 (unit column, item 4) remains — HELD** because it needs `quoteService.ts`/PDF/portal, which the concurrent portal-render-parity session still has uncommitted. Resume B2 once that session's work is committed. Item 18 resolved as measure-only: contrast is 4.65–5.92:1, all AA-pass, token unchanged. Item 16's "clipped dark button" was a stale screenshot artifact — nothing to fix. · **Owner**: Todd · **Branch context**: builds on PR #2711 (`ToddHebebrand/quoting-mcp`).

Source: an impeccable-skill critique (snapshot `.impeccable/critique/2026-07-21T20-02-29Z__web-src-components-billing-quotes-quoteeditor-tsx.md`, 23/40 baseline) plus an independent unstructured model review of the same screenshot. Items below are everything **not** addressed by #2711. Tags: [I] impeccable, [F] independent review.

Verified facts (2026-07-21): totals rail is already `xl:sticky` with a `quote-totals-sticky` mobile bar — do not re-add. Markup input is still `type="number" step="0.1"` (price/cost were converted to format-on-blur text in #2711). Block "Show subtotal row" writes `content.showSubtotal`, which the expanded editor table never renders (document/PDF only).

## Task A — rail money display (high value)
1. [F] Grand total stack in the rail: Subtotal → Tax → **Total** (total visually dominant); label one-time as pre-tax. Mirror in the `quote-totals-sticky` mobile bar.
2. [F] Profit as percent alongside dollars in MarginPanel ("Profit $2,292.36 (37.2%)"); visually separate from the tax-rate figure so 8.95% can't be misread as margin.

## Task B — line semantics (full-stack: shared validators + API + web; maybe migration)
3. [F] "No cost" designation for labor/service lines so they're deliberately excluded from the "N lines missing a cost" warning (distinguish explicit cost=0 from cost-unknown null; UI affordance on the internal band).
4. [F] Optional unit label on qty (hrs/ea/drops) rendered in editor + document/PDF/portal ("18 hrs × $115.00"). Likely a nullable `unit` column on quote_lines (idempotent migration, no RLS change — existing table).

## Task C — editor chrome
5. [F] "Show subtotal row": render the subtotal row in the expanded editor table, or relabel to "Show subtotal on proposal".
6. [F] Markup input → text/`inputMode="decimal"` pattern matching price/cost (kill the spinner).
7. [F] "Last saved 2:41 PM" / sync indicator near the autosave notice.
8. [F] Quote status (draft/sent) in the editor header next to Send proposal.

## Task D — bulk edit (large)
9. [I] Multi-select lines → bulk set markup / cost / taxable. Batch through existing per-line PATCH or a bulk endpoint; single undo-able action preferred.

## Task E — undo (large)
10. [I] Undo for line/block deletion (toast with Undo, or soft-delete grace window).

## Task F — polish sweep
11. [I] Section header typographic weight (headers barely heavier than item names).
12. [I] SKU vs PN confusion — help text or merge (users enter identical values).
13. [I/F] Tooltip on item-name inputs when value exceeds width.
14. [F] Sticky per-block column headers (ITEM/QTY/…).
15. [F] Auto-grow description textareas; remove manual resize handle.
16. [F] ADD SECTION bar: heading-text input only for the "Heading" chip; investigate clipped dark button bottom-left of screenshot.
17. [F] "Showing all organizations" banner clipped at top edge.
18. [I] Measure `text-muted-foreground` contrast on card bg; adjust token if <4.5:1 (repo-wide impact — measure first, discuss before changing).
19. [I] Keyboard shortcuts (add line, jump between blocks).

## Not code
20. [F] Data fixes in the demo quote: "Corfigure" typo, "OliveTech" internal-tooling leak in customer-visible description — run "Tidy all descriptions" on that quote in-app.

## Conventions for implementers (learned in #2711)
- Shared worktree possible; targeted edits only, no git stash/checkout, re-read before editing.
- i18n: every new string in all five locales (en, de-DE, es-419, fr-FR, pt-BR), real translations (translationCoverage duplicate-baseline gate).
- Preserve: amber dirty ring + SrSaved, per-line internal-band collapse (pins open when dirty), format-on-blur money inputs, revealRequest plumbing, block collapse + Contents outline.
- Verify per task: `cd apps/web && npx vitest run src/components/billing/` + `src/lib/i18n/`, `npx astro check`, eslint (no react-hooks plugin — no disable comments).

# Selectable Pricing Tiers — Design Sketch (Spec B)

**Date:** 2026-08-13
**Status:** Sketch — intentionally lighter than Spec A; gets its own full
brainstorm + plan before implementation
**Depends on:** Spec A (`2026-08-13-proposal-presentation-system-design.md`) for
block plumbing, renderers, and theme
**Risk class:** HIGH — touches money math, acceptance immutability, and a
public unauthenticated endpoint. Deserves the heavier review; do not fold into
Spec A's implementation.

## Problem

The reference proposal presents Good/Better/Best plans and hedges with "reply
and I'll reissue at that price." The client cannot *choose* a tier and accept in
one step; the MSP re-edits the quote per negotiation round. This spec makes the
tier choice part of acceptance.

**Decision already made (Todd):** tiers are **selectable and drive acceptance**
— the client picks a tier on the public proposal page; acceptance records it;
conversion uses that tier's lines. Not merely presentational.

## Shape

New `tiers` block (added to the same union/enum/renderer set Spec A establishes):

```ts
tiers: {
  tiers: [{
    key: string,                            // stable unique id — what acceptance records
    name: string, badge?: string,           // "Better", "Recommended"
    priceLabel: string, unit?: string,      // display only — money truth lives in lines
    features: string[],                     // inline-HTML subset, sanitized like table cells
  }],
  recommendedTierKey?: string,              // stable key, not an array index
}
```

- **One canonical membership source:** `quote_lines.tier_key` (nullable). The
  block does NOT also carry `lineIds` — dual membership sources would drift.
  Lines with a `tier_key` are **excluded from totals unless their tier is the
  active one**; untiered lines (onboarding, VPN) are always active.
- Given the billing/legal role, a normalized `quote_tiers` table +
  `quote_lines.tier_id` FK (instead of block-embedded tiers + string keys) is a
  live alternative — codex advisor leans that way; decide in Spec B's own
  brainstorm.
- One tiers block per quote (validation), else "active tier" is ambiguous.
- Server-side referential validation: every `quote_lines.tier_key` must match a
  tier in the block (or `quote_tiers` row), checked at write and at send.

## Touch points (from code, verified 2026-08-13)

| Area | File | Change |
|---|---|---|
| Totals | `packages/shared/src/utils/quoteMath.ts` (shim: `apps/api/src/services/quoteMath.ts`) | `computeQuoteTotals` gains active-tier filtering; deposits and tax follow the chosen tier. Consumed by `quoteService.ts`, `quoteLifecycle.ts`, `quotesPublic.ts`, `routes/portal/quotes.ts` — all four re-verified |
| Accept | `apps/api/src/routes/quotesPublic.ts:136` (`POST /:token/accept`) **and the authenticated portal accept route** (`apps/api/src/routes/portal/quotes.ts:193`) + `quoteAcceptService.ts` | Both accept paths gain `tierKey`; **server-side validation that the key exists on the quote** — never trust the client's tier contents, only its choice. Bound to the existing one-shot JTI (`quoteAcceptToken.ts`); recorded on the acceptance record |
| Convert | `quoteAcceptService.ts` (conversion is folded into accept — there is no separate route) | **One server-side `activeLines` computation feeds all three consumers:** invoice creation (`:168`), `buildContractSpecsFromQuote` (`:311-317`), **and Pax8 fulfillment staging (`:371`)** — missing any one bills/provisions the wrong tier |
| Content hash | `quoteContentHash.ts:42-48`, sole caller `quoteAcceptService.ts:140` | Today's hash does NOT attest the full quote: line hashing omits `name`, `blockId`, `termMonths`, `billingFrequency` (and would omit `tier_key`), and it's computed at accept, not stored at send. Spec B's contract: (1) a **send-time stored canonical `quoteContentSha256`** covering all offered tiers + membership, (2) an **acceptance digest** over `{ quoteContentSha256, selectedTierKey, acceptedTotals }`. Selection stays outside the content hash |
| Pre-selection totals | `packages/shared/src/utils/quoteMath.ts:118`, `quoteLifecycle.ts:377` | `computeQuoteTotals` sums all visible lines and the send email shows persisted `quote.total` — **undefined for a tiered quote.** Must define what header totals, deposits, and the send email show before the customer picks (recommended tier vs "starting at") |
| Portal UI | `apps/portal/.../PublicQuoteView.tsx` + `quoteBlocks.tsx` | Tier cards (Spec A theme), selection state, totals re-render on selection, selected tier passed to accept |
| PDF / print | `quotePdf.ts` | Tiers render as comparison cards (the reference PDF's plan-cards page); PDF is static — shows all tiers + recommended badge |
| Send flow / re-send | `quoteLifecycle.ts` | Send-time snapshot PDF shows all tiers; no per-tier PDFs |

## Known hard questions (answer in Spec B's own brainstorm, not now)

0. **Block-embedded tiers vs normalized `quote_tiers` table** (see Shape above)
   — the structural fork everything else depends on.
1. **Post-send mutation surface.** Acceptance currently attests an immutable
   quote. Tier selection introduces a legitimate post-send variable. Where is it
   stored (acceptance record vs quote), and how do re-send/reissue interact with
   a recorded selection? Related pre-existing gap: acceptance hashes raw DB
   blocks while customer routes display read-sanitized blocks
   (`quoteAcceptService.ts:114` vs `quoteService.ts:80`) — displayed content can
   differ from attested content; fix or accept explicitly here.
2. **Partial-tier edits after send.** MSP edits a tier's lines after sending —
   today that's caught by the content hash. Keep that behavior (edit ⇒ re-send)
   — confirm no new bypass.
3. **Deposits.** `validateQuoteDeposit` semantics when the deposit-eligible line
   set differs per tier.
4. **Tax + recurrence mixing** per tier (monthly vs one-time within a tier).
5. **MCP/AI write surface** — do agent tools get tier-aware quote authoring, and
   does #3521's array truncation interact with large tiers blocks?

## Why this is split from Spec A

Spec A is renderers and typography — worst case a document looks wrong. Spec B
changes **what a customer legally accepts and what gets invoiced** through an
unauthenticated public endpoint. Different blast radius, different review
depth, different release gate.

# AI Catalog Enrichment — Design

**Date:** 2026-06-25
**Status:** Approved (brainstorming) — pending implementation plan
**Branch:** `catalog-item-autofill`

## Summary

Let an MSP create a catalog item by typing a product **name or SKU** and having
the system pre-fill a draft (descriptive fields + pricing *guidance*) for review
before save. Built as a pluggable **enrichment provider** seam, with an
AI-backed provider as the only implementation today.

This is a convenience layer on top of the existing catalog create flow — it is
distinct from the existing *distributor* lookups (TD SYNNEX EC Express / Digital
Bridge) and Pax8 sync, which cover clean B2B procurement feeds. AI enrichment
targets the "one-off thing bought off Amazon/Best Buy that needs to be billed to
a client" case, where no distributor SKU exists.

## Decisions (from brainstorming)

1. **Source:** AI-enrich from a product name/SKU (not Amazon PA-API, not page
   scraping). Amazon's PA-API needs an Associates account with qualifying sales
   most MSPs lack; scraping violates ToS and is high-maintenance. The flow is
   already human-in-the-loop (user reviews every field before save), so
   approximate AI data + easy editing is the right ergonomic fit.
2. **Provider seam:** `EnrichmentProvider` interface; `AiEnrichmentProvider` is
   the only implementation now. A future `UpcEnrichmentProvider` drops in behind
   the same route/UI with no rework.
3. **Entry points:** Both the catalog item editor drawer (Settings → Catalog)
   **and** the quote/invoice line editor, via one shared web component (mirrors
   how `DistributorLookup` is reused).
4. **Price honesty:** AI returns a price **range as guidance text only**
   (`"typically $80–120"`). `unitPrice` is **never** auto-populated; the user
   must type the real number.
5. **AI wiring:** Reuse the existing AI agent layer (web search + per-org cost
   tracking + guardrails) rather than a standalone LLM call. All AI spend stays
   visible in one place.
6. **Provenance:** Full provenance recorded in `catalog_items.attributes` jsonb,
   stored explicitly as the AI **suggestion** (not the final values).

## Architecture

```
Web (shared CatalogEnrichButton / CatalogEnrichField)
        │  POST /catalog/enrich  { query, hint? }
        ▼
catalog/enrich.ts route  ──►  catalogEnrichmentService.ts
                                   │  EnrichmentProvider interface
                                   ▼
                              AiEnrichmentProvider  ──► existing AI agent layer
                                                        (web search + cost tracking + guardrails)
        ◄── { draft: {name, description, itemType, unitOfMeasure, taxable, taxCategory},
              priceGuidance: "typically $80–120",
              provenance: {source:'ai_enrich', model, query, suggestion, enrichedAt, enrichedBy} }
```

### Key boundary decisions

- The endpoint **only returns a draft** — it never writes to `catalog_items`.
  Saving still goes through the existing `POST /catalog`, reusing all existing
  validation and RLS. Enrich is side-effect-free.
- `unitPrice` is **never** populated by enrich. Price comes back as a
  human-readable `priceGuidance` string only.
- Partner-scoped, same auth as catalog create. **No MFA** — it stores no
  credentials and writes nothing (unlike the distributor config endpoints).
- No new DB table → no RLS migration. `attributes` is an existing column on the
  already-RLS'd `catalog_items` table.

## Data flow & the AI call

### Request

- Web sends `{ query: string, hint?: 'hardware'|'software'|'service' }`.
  - `query` — the product name or SKU the user typed.
  - `hint` — optional item-type bias. The catalog drawer passes the currently
    selected item type; the quote line editor leaves it unset.

### Inside `AiEnrichmentProvider`

- Builds a tight, purpose-specific prompt (not a free-form agent chat):
  *"Given this product, return structured catalog fields. Use web search for
  current details. Return price as a typical range, never a single committed
  number."*
- Calls through the existing AI agent pipeline with the **web-search tool
  enabled**, so cost is logged per-org and guardrails/rate-limits apply
  automatically.
- Forces a **structured response** (JSON schema / tool-call) — typed fields, not
  prose:
  `name`, `description`, `itemType`, `unitOfMeasure`, `taxable`, `taxCategory`,
  `priceLow`, `priceHigh`, `currency`, `confidence`, `notes`.

### Response mapping

- Descriptive fields → draft form values.
- `priceLow`/`priceHigh` → rendered as guidance text (`"typically $80–120"`),
  **not** into `unitPrice`.
- Everything the model returned (raw) + model id + query + timestamp + actor →
  `provenance` object.

### Failure handling

(per the `runAction` / no-silent-mutations conventions)

- AI error, timeout, or guardrail rejection → endpoint returns a **typed
  error**; the button surfaces a toast ("Couldn't auto-fill — enter details
  manually"). The form stays usable; enrich is purely additive.
- Low confidence → draft still returned, but the UI shows a "low confidence,
  double-check fields" note rather than failing.

## Provenance storage

When the user saves an enriched draft, the web client includes a `provenance`
object in the normal `POST /catalog` body. The route writes it into the existing
`attributes` jsonb:

```jsonc
attributes: {
  enrichment: {
    source: 'ai_enrich',
    model: 'claude-...',
    query: 'APC Back-UPS 600VA',
    suggestion: { /* exactly what the AI returned, incl. priceLow/High */ },
    enrichedAt: '2026-06-25T...Z',
    enrichedBy: '<userId>'
  }
}
```

Stored explicitly as **`suggestion`** — "what the AI proposed," not "the final
values." If the user edits fields before saving, the saved columns are the
truth and `suggestion` remains the auditable original.

Requires a small extension to `createCatalogItemSchema` to accept an optional,
well-typed `attributes.enrichment` shape, with **bounded sizes** so a large raw
blob can't bloat the row.

## Shared UI

**`CatalogEnrichButton` / `CatalogEnrichField`:**

- A compact input + "✨ Auto-fill from web" button. User types a name/SKU,
  clicks, sees a brief loading state.
- On success: fills the descriptive fields in the parent form and shows the
  **price guidance as a dismissible hint near the price field** (`"AI estimate:
  typically $80–120 — enter your price"`). The price field stays empty and
  required.
- A small "AI-filled" chip indicates which fields were populated.
- Wrapped in `runAction` so success/failure always surfaces a toast (per
  CLAUDE.md mutation-feedback rule, even though this is a read-style call).

**Two mount points, one component:**

1. `CatalogItemEditorDrawer.tsx` — at the top of the form; passes the selected
   `itemType` as `hint`.
2. The quote/invoice line editor — next to the existing `DistributorLookup`, so
   a tech can enrich-and-add a one-off line item.

## Testing

(per the `breeze-testing` skill)

- **API:** `enrich.ts` route test with the AI layer mocked — asserts structured
  mapping, that `unitPrice` is **never** set, error → typed failure, and the
  provenance shape.
- **Shared:** validator test for the extended `attributes.enrichment` bounds.
- **Web:** `CatalogEnrichButton` test — fills fields, shows price hint, leaves
  price empty, toasts on failure.
- No new DB table → no RLS migration.

## Files (anticipated)

| Area | Path | Change |
|---|---|---|
| API route | `apps/api/src/routes/catalog/enrich.ts` | new — `POST /catalog/enrich` |
| API route mount | `apps/api/src/routes/catalog/catalog.ts` (or index) | mount enrich route |
| API service | `apps/api/src/services/catalogEnrichmentService.ts` | new — provider seam + `AiEnrichmentProvider` |
| API route | `apps/api/src/routes/catalog/catalog.ts` | accept `attributes.enrichment` on create |
| Validators | `packages/shared/src/validators/catalog.ts` | extend `createCatalogItemSchema`; add enrich request/response schemas |
| Web component | `apps/web/src/components/catalog/CatalogEnrichButton.tsx` | new — shared enrich UI |
| Web API | `apps/web/src/lib/api/catalog.ts` (or new) | `enrichCatalogItem(query, hint)` wrapper |
| Web mount 1 | `apps/web/src/components/settings/CatalogItemEditorDrawer.tsx` | add enrich button |
| Web mount 2 | quote/invoice line editor (near `DistributorLookup`) | add enrich button |

## Out of scope (YAGNI)

- Amazon PA-API / page scraping / UPC database integration (provider seam keeps
  the door open; not built now).
- Auto-populating `unitPrice` from AI.
- Bulk / batch enrichment.
- Background re-enrichment or price refresh.

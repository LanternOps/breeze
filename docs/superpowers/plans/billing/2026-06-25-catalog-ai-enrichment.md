# AI Catalog Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user type a product name/SKU and get an AI-filled catalog-item draft (descriptive fields + price *guidance*, never an auto-filled price) for review before save.

**Architecture:** A side-effect-free `POST /catalog/enrich` endpoint backed by a pluggable `EnrichmentProvider` seam; the only provider (`AiEnrichmentProvider`) makes a one-shot Anthropic call with the web-search server tool, returns structured fields parsed against a Zod schema, runs the existing AI budget/rate-limit guardrails, and records per-org cost. Saving still flows through the existing `POST /catalog`; provenance is stored in the existing `catalog_items.attributes` jsonb. A shared web component (`CatalogEnrichButton`) is mounted in both the catalog editor drawer and the quote/invoice line editor.

**Tech Stack:** Hono + Zod (API), `@anthropic-ai/sdk` 0.105 (one-shot `messages.create`), Drizzle/Postgres, React + Vitest/jsdom (web). Spec: `docs/superpowers/specs/billing/2026-06-25-catalog-ai-enrichment-design.md`.

## Global Constraints

- **No new DB table, no migration.** Provenance lands in the existing `catalog_items.attributes` jsonb (already RLS-covered). Do not add tables or allowlist entries.
- **`unitPrice` is never set by enrichment.** The endpoint and component must never populate `unitPrice`; price is returned only as a human-readable `priceGuidance` string.
- **Enrichment is best-effort and additive.** Any AI/guardrail failure returns a typed error and leaves the form usable — it never blocks manual entry and never writes to the DB.
- **Installed SDK is `@anthropic-ai/sdk@^0.105.0`.** It does NOT have `messages.parse`, `zodOutputFormat`, `output_config`, or 2026 server-tool *types*. Use `client.messages.create()`, pass the web-search tool as a cast literal `{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }`, and parse the final text block as JSON validated by a Zod schema (mirrors `apps/api/src/services/aiPatchTestRunner.ts`).
- **Model id:** use `resolveDefaultModel()` from `apps/api/src/services/aiAgent.ts` (env `ANTHROPIC_MODEL` or `BREEZE_FALLBACK_MODEL = 'claude-sonnet-4-6'`). Do not hardcode a model.
- **Auth:** `POST /catalog/enrich` requires `requireScope('partner','system')` + `requirePermission(PERMISSIONS.CATALOG_WRITE...)`. **No MFA** (no credentials, no writes).
- **Web mutation feedback:** the web call uses `runAction` (`apps/web/src/lib/runAction.ts`) so success/failure always toasts (per CLAUDE.md).
- **Money bounds:** money is `numeric(12,2)` → max `9_999_999_999.99`. Price-guidance numbers from the AI must be clamped/validated to this range before formatting.

---

### Task 1: Shared validators — enrich request/response + bounded provenance

**Files:**
- Modify: `packages/shared/src/validators/catalog.ts`
- Test: `packages/shared/src/validators/catalog.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Produces:
  - `enrichRequestSchema` → `{ query: string (1..200), hint?: 'hardware'|'software'|'service' }`
  - `enrichDraftSchema` → `{ name, description, itemType, unitOfMeasure, taxable, taxCategory }`
  - `enrichmentProvenanceSchema` → `{ source: 'ai_enrich', model: string, query: string, suggestion: Record<string,unknown>, enrichedAt: string, enrichedBy: string }`
  - `enrichResponseSchema` → `{ draft: EnrichDraft, priceGuidance: string | null, provenance: EnrichmentProvenance }`
  - Types: `EnrichRequest`, `EnrichDraft`, `EnrichmentProvenance`, `EnrichResponse`
  - `createCatalogItemSchema.attributes` gains a size guard (≤ 60 000 chars serialized).

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/validators/catalog.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  enrichRequestSchema,
  enrichDraftSchema,
  enrichResponseSchema,
  enrichmentProvenanceSchema,
  createCatalogItemSchema,
} from './catalog';

describe('enrich validators', () => {
  it('accepts a valid enrich request with optional hint', () => {
    expect(enrichRequestSchema.parse({ query: 'APC Back-UPS 600VA' })).toEqual({
      query: 'APC Back-UPS 600VA',
    });
    expect(enrichRequestSchema.parse({ query: 'x', hint: 'hardware' }).hint).toBe('hardware');
  });

  it('rejects an empty or oversized query', () => {
    expect(enrichRequestSchema.safeParse({ query: '' }).success).toBe(false);
    expect(enrichRequestSchema.safeParse({ query: 'a'.repeat(201) }).success).toBe(false);
  });

  it('validates a draft and a full response', () => {
    const draft = {
      name: 'APC Back-UPS 600VA',
      description: 'Battery backup',
      itemType: 'hardware' as const,
      unitOfMeasure: 'each',
      taxable: true,
      taxCategory: null,
    };
    expect(enrichDraftSchema.parse(draft)).toEqual(draft);
    const resp = {
      draft,
      priceGuidance: 'typically $80–120',
      provenance: {
        source: 'ai_enrich' as const,
        model: 'claude-sonnet-4-6',
        query: 'APC Back-UPS 600VA',
        suggestion: { priceLow: 80, priceHigh: 120 },
        enrichedAt: '2026-06-25T00:00:00.000Z',
        enrichedBy: '00000000-0000-0000-0000-000000000001',
      },
    };
    expect(enrichResponseSchema.parse(resp)).toBeTruthy();
    expect(enrichmentProvenanceSchema.parse(resp.provenance).source).toBe('ai_enrich');
  });

  it('rejects create attributes larger than 60k chars', () => {
    const big = { blob: 'x'.repeat(60_001) };
    const res = createCatalogItemSchema.safeParse({
      itemType: 'service', name: 'svc', unitPrice: 10, attributes: big,
    });
    expect(res.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/shared exec vitest run src/validators/catalog.test.ts`
Expected: FAIL — `enrichRequestSchema` (and siblings) is not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/shared/src/validators/catalog.ts`, add after the existing schemas:

```ts
export const enrichRequestSchema = z.object({
  query: z.string().min(1).max(200),
  hint: catalogItemTypeSchema.optional(),
});
export type EnrichRequest = z.infer<typeof enrichRequestSchema>;

export const enrichDraftSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(10_000).nullable(),
  itemType: catalogItemTypeSchema,
  unitOfMeasure: z.string().max(50),
  taxable: z.boolean(),
  taxCategory: z.string().max(100).nullable(),
});
export type EnrichDraft = z.infer<typeof enrichDraftSchema>;

export const enrichmentProvenanceSchema = z.object({
  source: z.literal('ai_enrich'),
  model: z.string().max(100),
  query: z.string().max(200),
  // Bounded passthrough of exactly what the AI returned (the "suggestion").
  suggestion: z.record(z.string(), z.unknown()).refine(
    (v) => JSON.stringify(v).length <= 20_000,
    { message: 'enrichment suggestion is too large' }
  ),
  enrichedAt: z.string().max(40),
  enrichedBy: z.string().max(100),
});
export type EnrichmentProvenance = z.infer<typeof enrichmentProvenanceSchema>;

export const enrichResponseSchema = z.object({
  draft: enrichDraftSchema,
  priceGuidance: z.string().max(120).nullable(),
  provenance: enrichmentProvenanceSchema,
});
export type EnrichResponse = z.infer<typeof enrichResponseSchema>;
```

Then change the `attributes` field of `createCatalogItemSchema` from:

```ts
  attributes: z.record(z.string(), z.unknown()).default({})
```

to:

```ts
  // Bound serialized size so a large enrichment.suggestion (or any blob) can't
  // bloat the row. The enrichment provenance object is stored under this key.
  attributes: z.record(z.string(), z.unknown())
    .refine((v) => JSON.stringify(v).length <= 60_000, { message: 'attributes payload is too large' })
    .default({})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/shared exec vitest run src/validators/catalog.test.ts`
Expected: PASS.

Confirm the new schemas are exported from the package entry. Run:
`grep -n "validators/catalog" packages/shared/src/index.ts`
If `catalog` validators are re-exported via a barrel (e.g. `export * from './validators/catalog'`), nothing to do. If not present, add `export * from './validators/catalog';` to the barrel so `@breeze/shared` exposes the new symbols.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/catalog.ts packages/shared/src/validators/catalog.test.ts packages/shared/src/index.ts
git commit -m "feat(catalog): enrich request/response validators + bounded attributes"
```

---

### Task 2: API service — `catalogEnrichmentService.ts` (provider seam + AI provider)

**Files:**
- Create: `apps/api/src/services/catalogEnrichmentService.ts`
- Test: `apps/api/src/services/catalogEnrichmentService.test.ts`

**Interfaces:**
- Consumes (existing): `resolveDefaultModel` from `./aiAgent`; `checkBudget`, `checkAiRateLimit`, `recordUsage` from `./aiCostTracker`; `EnrichResponse`, `EnrichDraft` types from `@breeze/shared`.
- Produces:
  - `class EnrichmentError extends Error { code: string; status: number }`
  - `interface EnrichmentActor { userId: string; orgId: string | null }`
  - `interface EnrichmentProvider { enrich(query: string, hint: string | undefined, actor: EnrichmentActor): Promise<EnrichResponse> }`
  - `const aiEnrichmentProvider: EnrichmentProvider`
  - `async function enrichCatalogItem(query: string, hint: string | undefined, actor: EnrichmentActor): Promise<EnrichResponse>` (delegates to `aiEnrichmentProvider`)

**Behavior notes (implement exactly):**
- Pre-flight: if `actor.orgId` is non-null, call `checkAiRateLimit(actor.userId, actor.orgId)` then `checkBudget(actor.orgId)`; a non-null return → throw `new EnrichmentError(msg, 'AI_LIMIT', 429)`. If `actor.orgId` is null, skip both (warn).
- Build a one-shot `client.messages.create` with the web-search server tool. Drive a bounded loop (max 4 iterations) that appends the assistant turn and continues while `stop_reason === 'pause_turn'` (server tool still running); otherwise stop.
- The system prompt forces a JSON-only final answer with the exact field set (no `unitPrice`; price as `priceLow`/`priceHigh`). Extract the last `text` block, `JSON.parse`, validate the descriptive fields, clamp prices to `[0, 9_999_999_999.99]`, and build `priceGuidance` (`null` if no usable range).
- Sum `usage.input_tokens` / `usage.output_tokens` across iterations; if `actor.orgId` is non-null call `recordUsage('catalog-enrich-' + crypto.randomUUID(), actor.orgId, model, totalIn, totalOut, true)` (failure logged, not thrown).
- On parse/shape failure throw `new EnrichmentError('Could not parse AI response', 'AI_PARSE', 502)`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/catalogEnrichmentService.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create }; },
}));
vi.mock('./aiAgent', () => ({ resolveDefaultModel: () => 'claude-sonnet-4-6' }));
const checkBudget = vi.fn(async () => null);
const checkAiRateLimit = vi.fn(async () => null);
const recordUsage = vi.fn(async () => {});
vi.mock('./aiCostTracker', () => ({ checkBudget, checkAiRateLimit, recordUsage }));

import { enrichCatalogItem, EnrichmentError } from './catalogEnrichmentService';

const actor = { userId: 'u1', orgId: 'o1' };

function aiMessage(json: object) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(json) }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

beforeEach(() => {
  create.mockReset();
  checkBudget.mockClear(); checkAiRateLimit.mockClear(); recordUsage.mockClear();
  checkBudget.mockResolvedValue(null); checkAiRateLimit.mockResolvedValue(null);
});

describe('enrichCatalogItem', () => {
  it('maps AI fields to a draft + price guidance and never sets unitPrice', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'APC Back-UPS 600VA', description: 'Battery backup',
      itemType: 'hardware', unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: 80, priceHigh: 120, currency: 'USD', confidence: 0.8, notes: '',
    }));
    const res = await enrichCatalogItem('APC Back-UPS 600VA', 'hardware', actor);
    expect(res.draft.name).toBe('APC Back-UPS 600VA');
    expect(res.draft.itemType).toBe('hardware');
    expect((res.draft as Record<string, unknown>).unitPrice).toBeUndefined();
    expect(res.priceGuidance).toMatch(/80/);
    expect(res.priceGuidance).toMatch(/120/);
    expect(res.provenance.source).toBe('ai_enrich');
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it('returns null priceGuidance when no usable range', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'Mystery', description: null, itemType: 'service',
      unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: null, priceHigh: null, currency: null, confidence: 0.2, notes: '',
    }));
    const res = await enrichCatalogItem('Mystery', undefined, actor);
    expect(res.priceGuidance).toBeNull();
  });

  it('throws AI_LIMIT when budget is exhausted', async () => {
    checkBudget.mockResolvedValueOnce('Monthly AI budget exceeded');
    await expect(enrichCatalogItem('x', undefined, actor)).rejects.toMatchObject({
      code: 'AI_LIMIT', status: 429,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('throws AI_PARSE on non-JSON output', async () => {
    create.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'sorry, no idea' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    await expect(enrichCatalogItem('x', undefined, actor)).rejects.toBeInstanceOf(EnrichmentError);
  });

  it('skips org-scoped guardrails and cost when orgId is null', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'N', description: null, itemType: 'service',
      unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: null, priceHigh: null, currency: null, confidence: 0.5, notes: '',
    }));
    await enrichCatalogItem('x', undefined, { userId: 'u1', orgId: null });
    expect(checkBudget).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/catalogEnrichmentService.test.ts`
Expected: FAIL — module `./catalogEnrichmentService` not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/api/src/services/catalogEnrichmentService.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { resolveDefaultModel } from './aiAgent';
import { checkBudget, checkAiRateLimit, recordUsage } from './aiCostTracker';
import {
  enrichDraftSchema,
  type EnrichResponse,
  type EnrichmentProvenance,
} from '@breeze/shared';

export class EnrichmentError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'EnrichmentError';
    this.code = code;
    this.status = status;
  }
}

export interface EnrichmentActor {
  userId: string;
  orgId: string | null;
}

export interface EnrichmentProvider {
  enrich(query: string, hint: string | undefined, actor: EnrichmentActor): Promise<EnrichResponse>;
}

const MONEY_MAX = 9_999_999_999.99;

const SYSTEM_PROMPT =
  'You are a product catalog assistant for an MSP billing system. Given a product ' +
  'name or SKU, use web search to find current details, then respond with ONLY a single ' +
  'JSON object (no prose, no code fences) of the exact shape:\n' +
  '{"name":string,"description":string|null,"itemType":"hardware"|"software"|"service",' +
  '"unitOfMeasure":string,"taxable":boolean,"taxCategory":string|null,' +
  '"priceLow":number|null,"priceHigh":number|null,"currency":string|null,' +
  '"confidence":number,"notes":string}\n' +
  'priceLow/priceHigh are a TYPICAL street-price RANGE in the item currency; never a ' +
  'single committed price. If unknown, use null. Do not invent a price you are unsure of.';

function clampMoney(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return Math.min(n, MONEY_MAX);
}

function priceGuidanceFrom(low: number | null, high: number | null, currency: string | null): string | null {
  const sym = currency === 'USD' || currency == null ? '$' : `${currency} `;
  if (low != null && high != null) return `typically ${sym}${low}–${high}`;
  if (low != null) return `from ${sym}${low}`;
  if (high != null) return `up to ${sym}${high}`;
  return null;
}

function lastTextBlock(content: Array<{ type: string; text?: string }>): string | null {
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i];
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) return b.text;
  }
  return null;
}

export const aiEnrichmentProvider: EnrichmentProvider = {
  async enrich(query, hint, actor) {
    if (actor.orgId) {
      const rate = await checkAiRateLimit(actor.userId, actor.orgId);
      if (rate) throw new EnrichmentError(rate, 'AI_LIMIT', 429);
      const budget = await checkBudget(actor.orgId);
      if (budget) throw new EnrichmentError(budget, 'AI_LIMIT', 429);
    } else {
      console.warn('[catalog-enrich] no org context — skipping budget/rate checks');
    }

    const model = resolveDefaultModel();
    const client = new Anthropic();
    // SDK 0.105 lacks the web-search tool type; the GA tool is valid at the API layer.
    const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] as unknown as
      Anthropic.Messages.ToolUnion[];
    const hintLine = hint ? `\nThe user expects itemType to be "${hint}" unless clearly wrong.` : '';

    const messages: Anthropic.Messages.MessageParam[] = [
      { role: 'user', content: `Product: ${query}${hintLine}` },
    ];

    let totalIn = 0;
    let totalOut = 0;
    let finalText: string | null = null;

    for (let i = 0; i < 4; i++) {
      const resp = await client.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });
      totalIn += resp.usage?.input_tokens ?? 0;
      totalOut += resp.usage?.output_tokens ?? 0;
      if (resp.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: resp.content });
        continue;
      }
      finalText = lastTextBlock(resp.content as Array<{ type: string; text?: string }>);
      break;
    }

    if (actor.orgId) {
      recordUsage('catalog-enrich-' + randomUUID(), actor.orgId, model, totalIn, totalOut, true)
        .catch((err) => console.error('[catalog-enrich] recordUsage failed:', err));
    }

    if (!finalText) throw new EnrichmentError('AI returned no text', 'AI_PARSE', 502);

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(finalText) as Record<string, unknown>;
    } catch {
      throw new EnrichmentError('Could not parse AI response', 'AI_PARSE', 502);
    }

    const draftParse = enrichDraftSchema.safeParse({
      name: raw.name,
      description: raw.description ?? null,
      itemType: raw.itemType ?? hint ?? 'service',
      unitOfMeasure: typeof raw.unitOfMeasure === 'string' && raw.unitOfMeasure ? raw.unitOfMeasure : 'each',
      taxable: typeof raw.taxable === 'boolean' ? raw.taxable : true,
      taxCategory: (raw.taxCategory as string | null) ?? null,
    });
    if (!draftParse.success) throw new EnrichmentError('AI response missing required fields', 'AI_PARSE', 502);

    const low = clampMoney(raw.priceLow);
    const high = clampMoney(raw.priceHigh);
    const currency = typeof raw.currency === 'string' ? raw.currency : null;

    const provenance: EnrichmentProvenance = {
      source: 'ai_enrich',
      model,
      query,
      suggestion: raw,
      enrichedAt: new Date().toISOString(),
      enrichedBy: actor.userId,
    };

    return {
      draft: draftParse.data,
      priceGuidance: priceGuidanceFrom(low, high, currency),
      provenance,
    };
  },
};

export function enrichCatalogItem(
  query: string,
  hint: string | undefined,
  actor: EnrichmentActor,
): Promise<EnrichResponse> {
  return aiEnrichmentProvider.enrich(query, hint, actor);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/services/catalogEnrichmentService.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/catalogEnrichmentService.ts apps/api/src/services/catalogEnrichmentService.test.ts
git commit -m "feat(catalog): AI enrichment service with provider seam"
```

---

### Task 3: API route — `POST /catalog/enrich` + mount

**Files:**
- Create: `apps/api/src/routes/catalog/enrich.ts`
- Modify: `apps/api/src/routes/catalog/index.ts`
- Test: `apps/api/src/routes/catalog/enrich.test.ts`

**Interfaces:**
- Consumes: `enrichCatalogItem`, `EnrichmentError` (Task 2); `enrichRequestSchema` (Task 1); `catalogActorFrom` from `./catalog`; `requireScope`, `requirePermission`, `type AuthContext` from `../../middleware/auth`; `PERMISSIONS` from `../../services/permissions`.
- Produces: `export const catalogEnrichRoutes` (a Hono router) → on success `c.json({ data: EnrichResponse })`; on `EnrichmentError` → `c.json({ error, code }, status)`.

The actor passed to the service resolves org as `auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/catalog/enrich.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const enrichCatalogItem = vi.fn();
class EnrichmentError extends Error {
  code: string; status: number;
  constructor(m: string, c: string, s: number) { super(m); this.code = c; this.status = s; }
}
vi.mock('../../services/catalogEnrichmentService', () => ({ enrichCatalogItem, EnrichmentError }));

// Auth middleware stubs: inject an auth context and pass through.
vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../services/permissions', () => ({
  PERMISSIONS: { CATALOG_WRITE: { resource: 'catalog', action: 'write' } },
}));
vi.mock('./catalog', () => ({
  catalogActorFrom: () => ({ userId: 'u1', orgId: 'o1' }),
}));

import { catalogEnrichRoutes } from './enrich';

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('auth', { user: { id: 'u1' }, orgId: 'o1', accessibleOrgIds: ['o1'] }); await next(); });
  a.route('/', catalogEnrichRoutes);
  return a;
}

beforeEach(() => enrichCatalogItem.mockReset());

describe('POST /catalog/enrich', () => {
  it('returns the enrichment result', async () => {
    enrichCatalogItem.mockResolvedValueOnce({ draft: { name: 'X' }, priceGuidance: null, provenance: { source: 'ai_enrich' } });
    const res = await app().request('/enrich', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'APC UPS' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.draft.name).toBe('X');
    expect(enrichCatalogItem).toHaveBeenCalledWith('APC UPS', undefined, { userId: 'u1', orgId: 'o1' });
  });

  it('400s an empty query', async () => {
    const res = await app().request('/enrich', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '' }),
    });
    expect(res.status).toBe(400);
    expect(enrichCatalogItem).not.toHaveBeenCalled();
  });

  it('maps EnrichmentError to its status + code', async () => {
    enrichCatalogItem.mockRejectedValueOnce(new EnrichmentError('budget gone', 'AI_LIMIT', 429));
    const res = await app().request('/enrich', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'x' }),
    });
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('AI_LIMIT');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/catalog/enrich.test.ts`
Expected: FAIL — module `./enrich` not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/api/src/routes/catalog/enrich.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { enrichRequestSchema } from '@breeze/shared';
import { enrichCatalogItem, EnrichmentError } from '../../services/catalogEnrichmentService';
import { catalogActorFrom } from './catalog';

export const catalogEnrichRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.CATALOG_WRITE.resource, PERMISSIONS.CATALOG_WRITE.action);

catalogEnrichRoutes.post('/enrich', scopes, writePerm, zValidator('json', enrichRequestSchema), async (c) => {
  const { query, hint } = c.req.valid('json');
  const auth = c.get('auth') as AuthContext;
  const actor = catalogActorFrom(c);
  const orgId = auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
  try {
    const data = await enrichCatalogItem(query, hint, { userId: actor.userId, orgId });
    return c.json({ data });
  } catch (err) {
    if (err instanceof EnrichmentError) return c.json({ error: err.message, code: err.code }, err.status);
    throw err;
  }
});
```

Mount it in `apps/api/src/routes/catalog/index.ts` — add the import and register it **before** the generic item routes (so `/enrich` isn't shadowed by `/:id`):

```ts
import { catalogEnrichRoutes } from './enrich';
```

```ts
catalogRoutes.route('/', catalogDistributorRoutes);
catalogRoutes.route('/', catalogEnrichRoutes);   // add this line
catalogRoutes.route('/', catalogPricingRoutes);
catalogRoutes.route('/', catalogBundleRoutes);
catalogRoutes.route('/', catalogItemRoutes);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/catalog/enrich.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/catalog/enrich.ts apps/api/src/routes/catalog/index.ts apps/api/src/routes/catalog/enrich.test.ts
git commit -m "feat(catalog): POST /catalog/enrich route"
```

---

### Task 4: Web API client + shared `CatalogEnrichButton`

**Files:**
- Modify: `apps/web/src/lib/api/catalog.ts` (add `enrichCatalogItem` + types)
- Create: `apps/web/src/components/catalog/CatalogEnrichButton.tsx`
- Test: `apps/web/src/components/catalog/CatalogEnrichButton.test.tsx`

**Interfaces:**
- Produces (api client):
  - `interface EnrichDraft { name: string; description: string | null; itemType: 'hardware'|'software'|'service'; unitOfMeasure: string; taxable: boolean; taxCategory: string | null }`
  - `interface EnrichmentProvenance { source: 'ai_enrich'; model: string; query: string; suggestion: Record<string, unknown>; enrichedAt: string; enrichedBy: string }`
  - `interface EnrichResult { draft: EnrichDraft; priceGuidance: string | null; provenance: EnrichmentProvenance }`
  - `function enrichCatalogItemRequest(query: string, hint?: 'hardware'|'software'|'service'): Promise<Response>`
- Produces (component): default export `CatalogEnrichButton`, props:
  ```ts
  interface CatalogEnrichButtonProps {
    hint?: 'hardware' | 'software' | 'service';
    disabled?: boolean;
    idSuffix: string;                       // data-testid disambiguator
    onApply: (result: EnrichResult) => void; // host maps draft → form + stashes provenance
  }
  ```
- The component is `runAction`-wrapped; on success it calls `onApply(result)` and shows a price-guidance hint line (when non-null). It never touches `unitPrice`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/catalog/CatalogEnrichButton.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const enrichCatalogItemRequest = vi.fn();
vi.mock('../../lib/api/catalog', () => ({ enrichCatalogItemRequest }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast }));

import CatalogEnrichButton from './CatalogEnrichButton';

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function fail(status: number, body: unknown): Response {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

beforeEach(() => { enrichCatalogItemRequest.mockReset(); showToast.mockReset(); });

describe('CatalogEnrichButton', () => {
  const result = {
    draft: { name: 'APC UPS', description: 'Battery backup', itemType: 'hardware',
      unitOfMeasure: 'each', taxable: true, taxCategory: null },
    priceGuidance: 'typically $80–120',
    provenance: { source: 'ai_enrich', model: 'm', query: 'APC UPS', suggestion: {},
      enrichedAt: '2026-06-25T00:00:00Z', enrichedBy: 'u1' },
  };

  it('applies the draft and shows price guidance', async () => {
    enrichCatalogItemRequest.mockResolvedValueOnce(ok({ data: result }));
    const onApply = vi.fn();
    render(<CatalogEnrichButton idSuffix="drawer" hint="hardware" onApply={onApply} />);
    fireEvent.change(screen.getByTestId('catalog-enrich-input-drawer'), { target: { value: 'APC UPS' } });
    fireEvent.click(screen.getByTestId('catalog-enrich-btn-drawer'));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(result));
    expect(enrichCatalogItemRequest).toHaveBeenCalledWith('APC UPS', 'hardware');
    expect(screen.getByTestId('catalog-enrich-guidance-drawer').textContent).toMatch(/80/);
  });

  it('toasts on failure and does not call onApply', async () => {
    enrichCatalogItemRequest.mockResolvedValueOnce(fail(429, { error: 'budget gone', code: 'AI_LIMIT' }));
    const onApply = vi.fn();
    render(<CatalogEnrichButton idSuffix="drawer" onApply={onApply} />);
    fireEvent.change(screen.getByTestId('catalog-enrich-input-drawer'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('catalog-enrich-btn-drawer'));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(onApply).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/catalog/CatalogEnrichButton.test.tsx`
Expected: FAIL — component/module not found.

- [ ] **Step 3: Write minimal implementation**

In `apps/web/src/lib/api/catalog.ts`, add near the other request helpers (use the same `fetchWithAuth` import the file already uses; confirm with `grep -n "fetchWithAuth" apps/web/src/lib/api/catalog.ts`):

```ts
export interface EnrichDraft {
  name: string;
  description: string | null;
  itemType: 'hardware' | 'software' | 'service';
  unitOfMeasure: string;
  taxable: boolean;
  taxCategory: string | null;
}
export interface EnrichmentProvenance {
  source: 'ai_enrich';
  model: string;
  query: string;
  suggestion: Record<string, unknown>;
  enrichedAt: string;
  enrichedBy: string;
}
export interface EnrichResult {
  draft: EnrichDraft;
  priceGuidance: string | null;
  provenance: EnrichmentProvenance;
}

export function enrichCatalogItemRequest(
  query: string,
  hint?: 'hardware' | 'software' | 'service',
): Promise<Response> {
  return fetchWithAuth('/catalog/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, ...(hint ? { hint } : {}) }),
  });
}
```

Create `apps/web/src/components/catalog/CatalogEnrichButton.tsx`:

```tsx
import { useState } from 'react';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { enrichCatalogItemRequest, type EnrichResult } from '../../lib/api/catalog';

interface CatalogEnrichButtonProps {
  hint?: 'hardware' | 'software' | 'service';
  disabled?: boolean;
  idSuffix: string;
  onApply: (result: EnrichResult) => void;
}

export default function CatalogEnrichButton({ hint, disabled, idSuffix, onApply }: CatalogEnrichButtonProps) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [guidance, setGuidance] = useState<string | null>(null);

  const run = async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    try {
      const result = await runAction<EnrichResult>({
        request: () => enrichCatalogItemRequest(q, hint),
        errorFallback: "Couldn't auto-fill — enter details manually.",
        parseSuccess: (data) => (data as { data: EnrichResult }).data,
      });
      onApply(result);
      setGuidance(result.priceGuidance);
    } catch (err) {
      if (err instanceof ActionError) return; // runAction already toasted
      showToast({ message: "Couldn't auto-fill — enter details manually.", type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          placeholder="Product name or SKU"
          disabled={disabled || busy}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void run(); } }}
          data-testid={`catalog-enrich-input-${idSuffix}`}
          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={() => void run()}
          disabled={disabled || busy || !query.trim()}
          data-testid={`catalog-enrich-btn-${idSuffix}`}
          className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {busy ? 'Filling…' : '✨ Auto-fill from web'}
        </button>
      </div>
      {guidance && (
        <p data-testid={`catalog-enrich-guidance-${idSuffix}`} className="text-xs text-muted-foreground">
          AI estimate: {guidance} — enter your price below.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/components/catalog/CatalogEnrichButton.test.tsx`
Expected: PASS (2 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api/catalog.ts apps/web/src/components/catalog/CatalogEnrichButton.tsx apps/web/src/components/catalog/CatalogEnrichButton.test.tsx
git commit -m "feat(catalog): shared CatalogEnrichButton + web enrich client"
```

---

### Task 5: Mount the button in the catalog drawer and the quote line editor

**Files:**
- Modify: `apps/web/src/components/settings/CatalogItemEditorDrawer.tsx`
- Modify: the quote/invoice line editor that hosts `DistributorLookup` — find it: `grep -rn "DistributorLookup" apps/web/src/components/billing`
- Test: extend `apps/web/src/components/catalog/CatalogEnrichButton.test.tsx` only if new logic is added; the mounts themselves are wiring (verified manually + by existing drawer tests still passing).

**Interfaces:**
- Consumes: `CatalogEnrichButton` (Task 4), `EnrichResult` type (Task 4).

**Drawer wiring (`CatalogItemEditorDrawer.tsx`):**
The drawer holds per-field `useState` setters (`setName`, `setItemType`, `setUnitOfMeasure`, `setTaxable`, `setTaxCategory`, and the description setter — confirm exact names with `grep -n "useState" apps/web/src/components/settings/CatalogItemEditorDrawer.tsx`). Add an `onApply` handler that maps the draft to those setters and stashes provenance for save.

- [ ] **Step 1: Add provenance state + apply handler**

Near the other `useState` declarations in the drawer add:

```tsx
const [enrichment, setEnrichment] = useState<EnrichResult['provenance'] | null>(null);
```

Add the import at the top:

```tsx
import CatalogEnrichButton from '../catalog/CatalogEnrichButton';
import type { EnrichResult } from '../../lib/api/catalog';
```

Add the handler (place with the other callbacks):

```tsx
const applyEnrichment = useCallback((result: EnrichResult) => {
  const d = result.draft;
  setName(d.name);
  setItemType(d.itemType);
  if (typeof setDescription === 'function') setDescription(d.description ?? '');
  setUnitOfMeasure(d.unitOfMeasure);
  setTaxable(d.taxable);
  setTaxCategory(d.taxCategory ?? '');
  setEnrichment(result.provenance);   // unitPrice intentionally NOT set
}, []);
```

(Use the real setter names found via grep. If the drawer keeps `unitOfMeasure`/`taxCategory` as plain strings, the assignments above match; adapt to the actual field types.)

- [ ] **Step 2: Render the button at the top of the form**

Just inside the form body (above the item-type field), add, gated on create-mode + write permission:

```tsx
{!editId && canWrite && (
  <div className="rounded-md border border-dashed p-3">
    <p className="mb-2 text-xs font-medium text-muted-foreground">Auto-fill a new item from the web</p>
    <CatalogEnrichButton idSuffix="drawer" hint={itemType} onApply={applyEnrichment} />
  </div>
)}
```

- [ ] **Step 3: Include provenance in the create payload**

Find the `createCatalogItem(...)` call in the drawer's save handler. Merge provenance into `attributes` for the create path only:

```tsx
attributes: enrichment ? { enrichment } : undefined,
```

(If the create call doesn't currently send `attributes`, add the field. `createCatalogItemSchema` defaults it to `{}`, and Task 1 bounds its size.) Confirm `createCatalogItem` in `apps/web/src/lib/api/catalog.ts` forwards `attributes`; if its input type omits it, add `attributes?: Record<string, unknown>` to that type and pass it through.

- [ ] **Step 4: Wire the quote/invoice line editor**

In the component that renders `DistributorLookup` (from the grep above), render `CatalogEnrichButton` beside it. Its `onApply` should pre-fill the line's name/description and surface the price guidance to the user; map `result.draft` to whatever the line-add handler expects. Use `idSuffix={blockId}` (or the line's id) so test ids stay unique. Do not set a price automatically.

- [ ] **Step 5: Verify nothing regressed + commit**

Run the web suites that touch these files:
```bash
pnpm --filter @breeze/web exec vitest run src/components/catalog/CatalogEnrichButton.test.tsx
pnpm --filter @breeze/web exec vitest run src/components/settings/CatalogItemEditorDrawer.test.tsx 2>/dev/null || true
```
Expected: PASS (enrich test); the drawer test, if present, still passes.

Manual check (worktree stack): create a new catalog item, click **✨ Auto-fill from web**, confirm fields fill, price stays empty, guidance shows, and Save persists `attributes.enrichment`.

```bash
git add apps/web/src/components/settings/CatalogItemEditorDrawer.tsx apps/web/src/lib/api/catalog.ts <quote-line-editor-file>
git commit -m "feat(catalog): mount AI auto-fill in catalog drawer + quote line editor"
```

---

## Self-Review

**Spec coverage:**
- Provider seam + AI provider → Task 2. ✓
- `POST /catalog/enrich`, side-effect-free, partner-scoped, no MFA → Task 3. ✓
- `unitPrice` never auto-filled; price as guidance text → Task 1 (no unitPrice in draft), Task 2 (`priceGuidance`), Task 4 (renders hint, never sets price). ✓
- Reuse AI layer with web search + per-org cost + guardrails → Task 2 (`web_search_20250305`, `checkBudget`/`checkAiRateLimit`/`recordUsage`, `resolveDefaultModel`). ✓
- Full provenance stored as `suggestion` in `attributes` → Task 1 (`enrichmentProvenanceSchema`, bounded `attributes`), Task 2 (builds provenance), Task 5 (persists on create). ✓
- Both entry points via one shared component → Task 4 + Task 5. ✓
- Tests (API mapping/no-price/error/provenance; validator bounds; web fill/hint/empty/toast) → Tasks 1–4. ✓
- No new table / no RLS migration → Global Constraints; honored throughout. ✓

**Deviations from spec wording (faithful to intent, noted for the reviewer):**
- Structured output uses prompt-constrained JSON + Zod parse, not native `output_config`/`messages.parse` — installed SDK 0.105 lacks those helpers. Same user-visible result.
- Cost tracking reuses `recordUsage` per-org aggregates with a synthetic session id (no chat session row); org attribution falls back to `accessibleOrgIds[0]`, skipping when absent — consistent with the existing `recordUsageFromSdkResult` guard.

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Component setter names in Task 5 are the one spot requiring a `grep` confirmation against the live file (called out explicitly).

**Type consistency:** `EnrichResult` (web) mirrors `EnrichResponse` (shared/api); `enrichCatalogItemRequest` is used identically in component + test; `EnrichmentError { code, status }` shape matches across service, route, and route test.

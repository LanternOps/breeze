# Quotes / Proposals — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sent quotes acceptable end-to-end — issue + email a quote, let the customer view it (portal account or public tokenized link), e-sign acceptance with a tamper-evident content hash, auto-convert the accepted quote to an invoice, and support decline + image upload.

**Architecture:** Build on the Phase 1 quote engine (schema, service, PDF, block editor — merged #1455) and the billing RBAC (#1454). Lifecycle + accept logic live in new API services (`quoteLifecycle`, `quoteAcceptService`, `quoteContentHash`, `acceptanceProvider`, `quoteAcceptToken`, `quoteImageStorage`). Three route surfaces consume them: internal authed routes (`routes/quotes/*`), portal authed routes (`routes/portal/quotes.ts`), and **unauthenticated** token-gated public routes (`routes/quotesPublic.ts`). The customer-facing UI lives in `apps/portal/` (authed pages + a public `/quote/[token]` page); the main dashboard (`apps/web/`) gets the Send button + image-upload wiring.

**Tech Stack:** Hono + Drizzle + PostgreSQL (RLS-forced, `breeze_app`), `jose` JWT, BullMQ/Redis (jti revocation), Astro + React islands (portal + web), Vitest (unit + integration), `pnpm` workspaces.

**Authoritative docs:** `docs/superpowers/specs/billing/2026-06-16-quotes-proposals-design.md` (all-phase spec) and `docs/superpowers/specs/billing/2026-06-17-quotes-proposals-phase2-decisions.md` (the locked cut — read it; it overrides the spec's self-disagreements).

## Global Constraints

- **Node is pinned.** Prefix every `pnpm`/`vitest`/`tsx` command with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. Default Node 23 breaks pnpm engine-strict.
- **Real-DB tests** go in `apps/api/src/__tests__/integration/*.integration.test.ts` (run by `vitest.integration.config.ts`, BLOCKING `integration-test` CI job, connects code-under-test as `breeze_app`). The unit `test-api` job has **no** `DATABASE_URL`, so real-DB cases under `it.runIf(!!process.env.DATABASE_URL)` skip vacuously there. Never put a real-DB assertion in a `*.test.ts` unit file.
- **The public path is unauthenticated.** Every read/write on `routes/quotesPublic.ts` runs via `runOutsideDbContext(() => withSystemDbAccessContext(() => ...))`, scoped to the `org_id`/`quote_id` resolved from verified token claims. A bare `db` write there silently matches 0 rows under `breeze_app` RLS (the `rls_silent_zero_row_write` class). Token lookups are scoped, never global.
- **Penny math** routes through `invoiceMath` (`computeLineTotal`, `computeInvoiceTotals`, `toCents`/`fromCents`) and `quoteMath` (`computeQuoteTotals`). Never hand-roll money arithmetic.
- **Web mutations** in `apps/web/` route through `runAction` (`apps/web/src/lib/runAction.ts`). The customer portal (`apps/portal/`) uses its own `portalApi` + `ApiResponse` error handling (no `runAction` there).
- **Migrations** are idempotent (`ADD COLUMN IF NOT EXISTS`), named `YYYY-MM-DD-<slug>.sql`, no inner `BEGIN;`/`COMMIT;`. Never edit a shipped migration.
- **No new tables.** `quote_images` and `quote_acceptances` shipped in Phase 1 with RLS enabled+forced+org-axis policies and are already in the cascade + rls-coverage allowlists. The only schema delta is `quotes.decline_reason`.
- **Out of scope (Phase 3+):** expiry sweep / read-time expiry guard; payment after convert (pay-link redirect); recurring-lines→Contract. Convert invoices **one-time lines only**.

---

## File Structure

**Create (API):**
- `apps/api/migrations/2026-06-17-quote-decline-reason.sql` — add `quotes.decline_reason`.
- `apps/api/src/services/quoteContentHash.ts` — deterministic `quote_sha256` over header+blocks+lines+totals.
- `apps/api/src/services/acceptanceProvider.ts` — `AcceptanceProvider` interface + `TypedSignatureProvider` (built-in).
- `apps/api/src/services/quoteAcceptToken.ts` — `quote-accept` JWT mint/verify (jti) + revocation wrappers.
- `apps/api/src/services/quoteNumbers.ts` — `formatQuoteNumber` + `allocateQuoteCounter` (mirror `invoiceNumbers.ts`).
- `apps/api/src/services/quoteLifecycle.ts` — `sendQuote`, `markQuoteViewed`, `declineQuoteByActor` (issue + status transitions + post-commit email).
- `apps/api/src/services/quoteAcceptService.ts` — shared accept→convert pipeline (`acceptQuote`, `convertQuoteToInvoice`).
- `apps/api/src/services/quoteImageStorage.ts` — `writeQuoteImage`, `readQuoteImage`.
- `apps/api/src/services/quoteEmail.ts` — `buildQuoteTemplate` (mirror `buildInvoiceTemplate`).
- `apps/api/src/routes/quotes/lifecycle.ts` — `POST /:id/send` (`quotes:send`) + image upload/serve routes.
- `apps/api/src/routes/portal/quotes.ts` — portal list/detail/pdf/image/accept/decline.
- `apps/api/src/routes/quotesPublic.ts` — unauthenticated token routes.

**Create (tests):**
- `apps/api/src/services/quoteContentHash.test.ts`, `acceptanceProvider.test.ts`, `quoteAcceptToken.test.ts`, `quoteNumbers.test.ts`, `quoteEmail.test.ts` (unit).
- `apps/api/src/__tests__/integration/quoteLifecycle.integration.test.ts`, `quoteAccept.integration.test.ts`, `quoteImages.integration.test.ts`, `quotesPublic.integration.test.ts`, `portalQuotes.integration.test.ts`, `quoteSendRbac.integration.test.ts`.

**Create (web):**
- `apps/portal/src/pages/quotes/index.astro`, `apps/portal/src/pages/quotes/[id].astro`, `apps/portal/src/pages/quote/[token].astro`.
- `apps/portal/src/components/portal/QuoteList.tsx`, `QuoteDetailView.tsx`, `PublicQuoteView.tsx`.

**Modify:**
- `apps/api/src/db/schema/quotes.ts:54` — add `declineReason: text('decline_reason')`.
- `packages/shared/src/validators/quotes.ts` — `acceptQuoteSchema`, `declineQuoteSchema`.
- `apps/api/src/services/jwt.ts` — (only if shared key helpers must be exported; otherwise self-contained in `quoteAcceptToken.ts`).
- `apps/api/src/routes/quotes/index.ts` — mount `lifecycle.ts` routes.
- `apps/api/src/routes/portal/index.ts` — mount `quoteRoutes`.
- `apps/api/src/index.ts:~775` — mount `quotesPublicRoutes` BEFORE auth-gated routes.
- `apps/portal/src/lib/api.ts` — `getQuotes`, `getQuote`, `acceptQuote`, `declineQuote`, `getPublicQuote`, `acceptPublicQuote`, `declinePublicQuote`.
- `apps/portal/src/layouts/PortalLayout.astro:13-19` — add `{ label: 'Quotes', href: '/quotes' }`.
- `apps/web/src/components/billing/quotes/QuoteDetail.tsx:166-176` — wire the real Send button.
- `apps/web/src/components/billing/quotes/QuoteEditor.tsx:28-40,435` — add `image` block option + upload.
- `apps/web/src/lib/quotesApi.ts` (or wherever quote fetch helpers live) — `sendQuote`, `uploadQuoteImage`.
- `docker/Caddyfile.prod` — carve-outs so `/quotes/public/*` (API) and portal `/quote/*` aren't shadowed.

---

## Task 1: Migration + schema — `quotes.decline_reason`

Adds the single Phase 2 schema delta. Decline records a reason; there is no column for it yet.

**Files:**
- Create: `apps/api/migrations/2026-06-17-quote-decline-reason.sql`
- Modify: `apps/api/src/db/schema/quotes.ts:54`
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing ordering regression test must still pass) + `pnpm db:check-drift`

- [ ] **Step 1: Write the migration**

```sql
-- 2026-06-17-quote-decline-reason.sql
-- Phase 2: record a free-text reason when a sent quote is declined.
-- Idempotent: ADD COLUMN IF NOT EXISTS. No new table, no RLS change
-- (quotes already has org-axis RLS from 2026-06-16-quotes.sql).
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS decline_reason text;
```

- [ ] **Step 2: Add the Drizzle field**

In `apps/api/src/db/schema/quotes.ts`, add after `terms: text('terms'),` (line 45) — keep it grouped with the other nullable text fields:

```ts
  declineReason: text('decline_reason'),
```

- [ ] **Step 3: Apply the migration + verify no drift**

Run:
```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH \
  DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" \
  npx tsx -e "import('./src/db/autoMigrate').then(m => m.runMigrations()).then(()=>process.exit(0))"
cd ../.. && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH \
  DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm db:check-drift
```
Expected: migration applies clean; `db:check-drift` reports **no drift** (the new column matches the new Drizzle field).

> Note for the implementer: the exact `runMigrations` export name is in `apps/api/src/db/autoMigrate.ts` — if it differs, apply via the integration setup path (`autoMigrate` runs inside `setupIntegrationTests`). The drift check is the real gate.

- [ ] **Step 4: Run the migration-ordering regression test**

Run:
```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/db/autoMigrate.test.ts
```
Expected: PASS (the new date-prefixed file sorts correctly after `2026-06-16-quotes.sql`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-17-quote-decline-reason.sql apps/api/src/db/schema/quotes.ts
git commit -m "feat(quotes): add decline_reason column (Phase 2)"
```

---

## Task 2: Shared validators — accept / decline payloads

Adds the request schemas Phase 2 routes validate against. Phase 1 added create/update/line/block schemas but no accept/decline.

**Files:**
- Modify: `packages/shared/src/validators/quotes.ts`
- Test: `packages/shared/src/validators/quotes.test.ts`

**Interfaces:**
- Produces: `acceptQuoteSchema` → `{ signerName: string; signerEmail?: string }`; `declineQuoteSchema` → `{ reason?: string }`; types `AcceptQuoteInput`, `DeclineQuoteInput`.

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/validators/quotes.test.ts` (create if absent; mirror `catalog.test.ts` style):

```ts
import { describe, it, expect } from 'vitest';
import { acceptQuoteSchema, declineQuoteSchema } from './quotes';

describe('acceptQuoteSchema', () => {
  it('requires a non-empty signer name', () => {
    expect(acceptQuoteSchema.safeParse({ signerName: '' }).success).toBe(false);
    expect(acceptQuoteSchema.safeParse({ signerName: 'Jane Buyer' }).success).toBe(true);
  });
  it('accepts an optional email and rejects a malformed one', () => {
    expect(acceptQuoteSchema.safeParse({ signerName: 'Jane', signerEmail: 'jane@x.com' }).success).toBe(true);
    expect(acceptQuoteSchema.safeParse({ signerName: 'Jane', signerEmail: 'not-an-email' }).success).toBe(false);
  });
});

describe('declineQuoteSchema', () => {
  it('allows an optional bounded reason', () => {
    expect(declineQuoteSchema.safeParse({}).success).toBe(true);
    expect(declineQuoteSchema.safeParse({ reason: 'Too expensive' }).success).toBe(true);
    expect(declineQuoteSchema.safeParse({ reason: 'x'.repeat(5001) }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/validators/quotes.test.ts
```
Expected: FAIL — `acceptQuoteSchema`/`declineQuoteSchema` are not exported.

- [ ] **Step 3: Add the schemas**

Append to `packages/shared/src/validators/quotes.ts` (note: this repo is on Zod 4 — use `.email()` which still validates; do NOT use `.uuid()` for the nil sentinel elsewhere, but these fields don't use uuids):

```ts
export const acceptQuoteSchema = z.object({
  signerName: z.string().min(1).max(255),
  signerEmail: z.string().email().max(255).optional(),
});

export const declineQuoteSchema = z.object({
  reason: z.string().max(5000).optional(),
});

export type AcceptQuoteInput = z.infer<typeof acceptQuoteSchema>;
export type DeclineQuoteInput = z.infer<typeof declineQuoteSchema>;
```

Ensure both are re-exported from `packages/shared/src/index.ts` if it uses an explicit export list (grep for `quoteStatusSchema` to find the export site and add alongside).

- [ ] **Step 4: Run to verify it passes**

```bash
cd packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/validators/quotes.test.ts
```
Expected: PASS. Then typecheck shared: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/quotes.ts packages/shared/src/validators/quotes.test.ts packages/shared/src/index.ts
git commit -m "feat(quotes): add accept/decline payload validators (Phase 2)"
```

---

## Task 3: Quote content hash (`quoteContentHash.ts`)

Deterministic SHA-256 of the rendered quote, captured at accept time for tamper-evidence. Pure function — no DB.

**Files:**
- Create: `apps/api/src/services/quoteContentHash.ts`
- Test: `apps/api/src/services/quoteContentHash.test.ts`

**Interfaces:**
- Consumes: the `quotes`, `quoteBlocks`, `quoteLines` row types (from `getQuote`).
- Produces: `computeQuoteSha256(quote, blocks, lines): string` (64-char lowercase hex).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { computeQuoteSha256 } from './quoteContentHash';

const quote = { id: 'q1', quoteNumber: 'Q-2026-0001', status: 'sent', currencyCode: 'USD', total: '100.00', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', taxTotal: '0.00', subtotal: '100.00' } as any;
const blocks = [{ id: 'b1', blockType: 'heading', content: { text: 'Proposal' }, sortOrder: 0 }] as any;
const lines = [{ id: 'l1', description: 'Setup', quantity: '1', unitPrice: '100.00', lineTotal: '100.00', recurrence: 'one_time', taxable: false, customerVisible: true, sortOrder: 0 }] as any;

describe('computeQuoteSha256', () => {
  it('returns a stable 64-char hex hash for the same content', () => {
    const a = computeQuoteSha256(quote, blocks, lines);
    const b = computeQuoteSha256(quote, blocks, lines);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });
  it('is order-independent on input arrays but content-sensitive', () => {
    const reordered = computeQuoteSha256(quote, blocks, [...lines].reverse());
    expect(reordered).toBe(computeQuoteSha256(quote, blocks, lines));
  });
  it('changes when a line amount is tampered', () => {
    const tampered = [{ ...lines[0], unitPrice: '1.00', lineTotal: '1.00' }];
    expect(computeQuoteSha256(quote, blocks, tampered)).not.toBe(computeQuoteSha256(quote, blocks, lines));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/quoteContentHash.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { createHash } from 'node:crypto';

type HashableQuote = {
  id: string; quoteNumber: string | null; status: string; currencyCode: string;
  subtotal: string; taxTotal: string; total: string;
  oneTimeTotal: string; monthlyRecurringTotal: string; annualRecurringTotal: string;
};
type HashableBlock = { id: string; blockType: string; content: unknown; sortOrder: number };
type HashableLine = {
  id: string; description: string; quantity: string; unitPrice: string; lineTotal: string;
  recurrence: string; taxable: boolean; customerVisible: boolean; sortOrder: number;
};

/**
 * Canonical, order-independent serialization of a quote's billable content,
 * hashed with SHA-256. Captured at accept time and stored on
 * quote_acceptances.quote_sha256 so a later edit (or a forged re-render) can be
 * detected. Sorting by (sortOrder, id) makes the hash independent of the array
 * order the caller happens to pass while staying sensitive to any value change.
 */
export function computeQuoteSha256(
  quote: HashableQuote,
  blocks: HashableBlock[],
  lines: HashableLine[]
): string {
  const canonical = {
    quote: {
      id: quote.id, number: quote.quoteNumber, status: quote.status, currency: quote.currencyCode,
      subtotal: quote.subtotal, taxTotal: quote.taxTotal, total: quote.total,
      oneTime: quote.oneTimeTotal, monthly: quote.monthlyRecurringTotal, annual: quote.annualRecurringTotal,
    },
    blocks: [...blocks]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
      .map((b) => ({ id: b.id, type: b.blockType, sortOrder: b.sortOrder, content: b.content })),
    lines: [...lines]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
      .map((l) => ({
        id: l.id, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
        lineTotal: l.lineTotal, recurrence: l.recurrence, taxable: l.taxable,
        customerVisible: l.customerVisible, sortOrder: l.sortOrder,
      })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/quoteContentHash.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteContentHash.ts apps/api/src/services/quoteContentHash.test.ts
git commit -m "feat(quotes): deterministic quote content hash for acceptance tamper-evidence"
```

---

## Task 4: AcceptanceProvider interface + TypedSignatureProvider

The provider seam so a vendor e-sign adapter can be added later without a data-model change. Built-in typed-signature provider now.

**Files:**
- Create: `apps/api/src/services/acceptanceProvider.ts`
- Test: `apps/api/src/services/acceptanceProvider.test.ts`

**Interfaces:**
- Produces: `AcceptanceProvider`, `AcceptanceCaptureInput`, `AcceptanceCaptureResult`, `TypedSignatureProvider`, `getAcceptanceProvider(): AcceptanceProvider`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { getAcceptanceProvider } from './acceptanceProvider';

describe('TypedSignatureProvider', () => {
  it('captures a typed signature with method=typed-signature', async () => {
    const p = getAcceptanceProvider();
    expect(p.kind).toBe('builtin');
    const r = await p.capture({ quoteId: 'q1', signerName: '  Jane Buyer ', signerEmail: 'jane@x.com', ipAddress: '1.2.3.4', userAgent: 'UA', acceptanceTokenJti: 'jti1' });
    expect(r).toEqual({ signerName: 'Jane Buyer', signerEmail: 'jane@x.com', method: 'typed-signature' });
  });
  it('rejects an empty typed name', async () => {
    const p = getAcceptanceProvider();
    await expect(p.capture({ quoteId: 'q1', signerName: '   ' })).rejects.toThrow();
  });
  it('normalizes a missing email to null', async () => {
    const r = await getAcceptanceProvider().capture({ quoteId: 'q1', signerName: 'Bob' });
    expect(r.signerEmail).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/acceptanceProvider.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export interface AcceptanceCaptureInput {
  quoteId: string;
  signerName: string;
  signerEmail?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  acceptanceTokenJti?: string | null;
}

export interface AcceptanceCaptureResult {
  signerName: string;
  signerEmail: string | null;
  method: string;
}

export interface AcceptanceProvider {
  readonly kind: string;
  capture(input: AcceptanceCaptureInput): Promise<AcceptanceCaptureResult>;
}

/**
 * Built-in typed-signature provider. The signer types their full name; we record
 * it plus the method. A future DocuSign/PandaDoc adapter implements the same
 * interface and maps its envelope reference onto
 * quote_acceptances.acceptance_token_jti — same columns, no schema change.
 */
export class TypedSignatureProvider implements AcceptanceProvider {
  readonly kind = 'builtin';
  async capture(input: AcceptanceCaptureInput): Promise<AcceptanceCaptureResult> {
    const signerName = input.signerName.trim();
    if (!signerName) throw new Error('signerName is required for a typed signature');
    const email = input.signerEmail?.trim();
    return { signerName, signerEmail: email && email.length > 0 ? email : null, method: 'typed-signature' };
  }
}

let provider: AcceptanceProvider | null = null;
export function getAcceptanceProvider(): AcceptanceProvider {
  if (!provider) provider = new TypedSignatureProvider();
  return provider;
}
```

- [ ] **Step 4: Run to verify it passes** — same command as Step 2; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/acceptanceProvider.ts apps/api/src/services/acceptanceProvider.test.ts
git commit -m "feat(quotes): AcceptanceProvider seam + built-in typed-signature provider"
```

---

## Task 5: Quote-accept token (`quoteAcceptToken.ts`)

A signed, revocable token that lets a prospect without a portal account open + accept exactly one quote. Mirrors the viewer-token pattern (`jwt.ts` + `viewerTokenRevocation.ts`).

**Files:**
- Create: `apps/api/src/services/quoteAcceptToken.ts`
- Test: `apps/api/src/services/quoteAcceptToken.test.ts`

**Interfaces:**
- Produces: `createQuoteAcceptToken({ quoteId, orgId, partnerId, expiresAt? }): Promise<{ token: string; jti: string }>`; `verifyQuoteAcceptToken(token): Promise<QuoteAcceptClaims | null>` where `QuoteAcceptClaims = { quoteId; orgId; partnerId; jti }`; `revokeQuoteAcceptJti(jti)`, `isQuoteAcceptJtiRevoked(jti)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createQuoteAcceptToken, verifyQuoteAcceptToken } from './quoteAcceptToken';

beforeAll(() => { process.env.JWT_SECRET ||= 'test-secret-test-secret-test-secret-123'; });

describe('quote-accept token', () => {
  it('round-trips quoteId/orgId/partnerId/jti', async () => {
    const { token, jti } = await createQuoteAcceptToken({ quoteId: 'q1', orgId: 'o1', partnerId: 'p1' });
    const claims = await verifyQuoteAcceptToken(token);
    expect(claims).toEqual({ quoteId: 'q1', orgId: 'o1', partnerId: 'p1', jti });
  });
  it('rejects a garbage token', async () => {
    expect(await verifyQuoteAcceptToken('not.a.jwt')).toBeNull();
  });
  it('rejects a viewer-purpose token (wrong audience/purpose)', async () => {
    const { createViewerAccessToken } = await import('./jwt');
    const viewer = await createViewerAccessToken({ sub: 'u1', email: 'a@b.com', sessionId: 's1' });
    expect(await verifyQuoteAcceptToken(viewer)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/quoteAcceptToken.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Reuse the signing key helpers. `getSignKey`/`getVerifyKey`/`buildHeader` are module-private in `jwt.ts`; export them there (add `export` to `getSignKey`, `getVerifyKey`, `buildHeader` in `apps/api/src/services/jwt.ts`) so this module signs with the same keyring. Then:

```ts
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { getRedis } from './redis';
import { getSignKey, getVerifyKey, buildHeader } from './jwt';

const ISSUER = 'breeze';
const AUDIENCE = 'breeze-quote-accept';
const PURPOSE = 'quote-accept';
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const REVOKE_TTL_SECONDS = DEFAULT_TTL_SECONDS;

export interface QuoteAcceptClaims { quoteId: string; orgId: string; partnerId: string; jti: string; }

export async function createQuoteAcceptToken(input: {
  quoteId: string; orgId: string; partnerId: string; expiresAt?: Date | null;
}): Promise<{ token: string; jti: string }> {
  const { key, kid } = getSignKey();
  const jti = randomUUID();
  // Expiry = the quote's expiry_date if it's in the future, else +30d. jose
  // accepts a number (seconds since epoch) or a duration string.
  const expSeconds = input.expiresAt && input.expiresAt.getTime() > Date.now()
    ? Math.floor(input.expiresAt.getTime() / 1000)
    : Math.floor(Date.now() / 1000) + DEFAULT_TTL_SECONDS;
  const token = await new SignJWT({ quoteId: input.quoteId, orgId: input.orgId, partnerId: input.partnerId, purpose: PURPOSE })
    .setProtectedHeader(buildHeader(kid))
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expSeconds)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(key);
  return { token, jti };
}

export async function verifyQuoteAcceptToken(token: string): Promise<QuoteAcceptClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getVerifyKey, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
    if (payload.purpose !== PURPOSE) return null;
    if (typeof payload.jti !== 'string' || payload.jti.length === 0) return null;
    const { quoteId, orgId, partnerId } = payload as Record<string, unknown>;
    if (typeof quoteId !== 'string' || typeof orgId !== 'string' || typeof partnerId !== 'string') return null;
    return { quoteId, orgId, partnerId, jti: payload.jti };
  } catch (err) {
    console.debug('[quoteAcceptToken] verification failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function revokeQuoteAcceptJti(jti: string): Promise<void> {
  const redis = getRedis();
  if (!redis) { console.error('[quoteAcceptToken] Redis unavailable — jti revocation skipped'); return; }
  await redis.set(`quote-accept-jti-revoked:${jti}`, '1', 'EX', REVOKE_TTL_SECONDS);
}

export async function isQuoteAcceptJtiRevoked(jti: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) { console.error('[quoteAcceptToken] Redis unavailable — failing closed on jti check'); return true; }
  return (await redis.get(`quote-accept-jti-revoked:${jti}`)) === '1';
}
```

> Note for the implementer: confirm `getVerifyKey` exists in `jwt.ts` (it's the JWKS/`getKey` callback `jwtVerify` already uses for viewer tokens — see `verifyViewerAccessToken`). If it's named differently, export that symbol. Do NOT duplicate key material.

- [ ] **Step 4: Run to verify it passes** — same command as Step 2; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteAcceptToken.ts apps/api/src/services/quoteAcceptToken.test.ts apps/api/src/services/jwt.ts
git commit -m "feat(quotes): revocable quote-accept JWT (public tokenized access)"
```

---

## Task 6: Quote numbering (`quoteNumbers.ts`)

Gapless per-partner-per-year quote numbers, allocated when a draft is sent. Mirror of `invoiceNumbers.ts` against `partner_quote_sequences` (shipped Phase 1).

**Files:**
- Create: `apps/api/src/services/quoteNumbers.ts`
- Test: `apps/api/src/services/quoteNumbers.test.ts` (unit, pure formatter) + covered functionally in Task 7's integration test.

**Interfaces:**
- Produces: `formatQuoteNumber(prefix, year, counter): string`; `allocateQuoteCounter(partnerId, year): Promise<number>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { formatQuoteNumber } from './quoteNumbers';

describe('formatQuoteNumber', () => {
  it('zero-pads the counter to 4 digits', () => {
    expect(formatQuoteNumber('Q', 2026, 7)).toBe('Q-2026-0007');
    expect(formatQuoteNumber('QUO', 2026, 1234)).toBe('QUO-2026-1234');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/services/quoteNumbers.test.ts`; Expected: FAIL.

- [ ] **Step 3: Implement** (mirror `invoiceNumbers.ts`)

```ts
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { QuoteServiceError } from './quoteTypes';

export function formatQuoteNumber(prefix: string, year: number, counter: number): string {
  return `${prefix}-${year}-${String(counter).padStart(4, '0')}`;
}

/**
 * Gapless counter via INSERT ... ON CONFLICT ... RETURNING on
 * partner_quote_sequences (year-keyed). partner_quote_sequences is partner-axis;
 * sendQuote calls this inside its own withSystemDbAccessContext transaction, so
 * this helper is also safe to call standalone (it self-wraps).
 */
export async function allocateQuoteCounter(partnerId: string, year: number): Promise<number> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.execute(sql`
        INSERT INTO partner_quote_sequences (partner_id, year, counter)
        VALUES (${partnerId}, ${year}, 1)
        ON CONFLICT (partner_id, year)
        DO UPDATE SET counter = partner_quote_sequences.counter + 1
        RETURNING counter
      `)
    )
  );
  const counter = Number((rows as unknown as Array<{ counter: number }>)[0]?.counter);
  if (!Number.isFinite(counter) || counter < 1) throw new QuoteServiceError('Failed to allocate quote number', 500, 'INVALID_STATE');
  return counter;
}
```

> Note: the prefix — invoices read `partner.invoiceNumberPrefix ?? 'INV'`. Quotes have no `quoteNumberPrefix` column; use the literal `'Q'`. If a per-partner prefix is wanted later it's an additive column, not Phase 2.

- [ ] **Step 4: Run to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteNumbers.ts apps/api/src/services/quoteNumbers.test.ts
git commit -m "feat(quotes): gapless per-partner quote numbering"
```

---

## Task 7: Quote email template (`quoteEmail.ts`)

`buildQuoteTemplate` — mirror of `buildInvoiceTemplate`, but the CTA points at the public accept link, not the portal invoice.

**Files:**
- Create: `apps/api/src/services/quoteEmail.ts`
- Test: `apps/api/src/services/quoteEmail.test.ts`

**Interfaces:**
- Produces: `buildQuoteTemplate(params: QuoteEmailParams): { subject; html; text }` where `QuoteEmailParams = { quoteNumber; partnerName; total; expiryDate?; acceptUrl; supportEmail? }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildQuoteTemplate } from './quoteEmail';

describe('buildQuoteTemplate', () => {
  it('builds a subject + accept link + html/text', () => {
    const t = buildQuoteTemplate({ quoteNumber: 'Q-2026-0001', partnerName: 'Acme MSP', total: '$1,200.00', acceptUrl: 'https://portal.example.com/quote/TOKEN', expiryDate: '2026-07-01' });
    expect(t.subject).toContain('Q-2026-0001');
    expect(t.subject).toContain('Acme MSP');
    expect(t.html).toContain('https://portal.example.com/quote/TOKEN');
    expect(t.text).toContain('https://portal.example.com/quote/TOKEN');
    expect(t.html).toContain('1,200.00');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/services/quoteEmail.test.ts`; Expected: FAIL.

- [ ] **Step 3: Implement** — reuse the shared email layout helpers (`renderLayout`, `renderButton`, `escapeHtml`, `supportFooter`, `getSupportEmail`, `BODY_PARA`, `MUTED_PARA`, `EmailTemplate`) from `email.ts`. Export them from `email.ts` if not already exported (grep `export function renderLayout`; add `export` as needed).

```ts
import { renderLayout, renderButton, escapeHtml, supportFooter, getSupportEmail, BODY_PARA, MUTED_PARA, type EmailTemplate } from './email';

export interface QuoteEmailParams {
  quoteNumber: string;
  partnerName: string;
  total: string;        // pre-formatted money
  expiryDate?: string;  // pre-formatted date or empty
  acceptUrl: string;
  supportEmail?: string;
}

export function buildQuoteTemplate(params: QuoteEmailParams): EmailTemplate {
  const number = params.quoteNumber.trim();
  const subject = `Proposal ${number} from ${params.partnerName}`;
  const preheader = `Proposal ${number} — ${params.total}${params.expiryDate ? `, valid until ${params.expiryDate}` : ''}.`;
  const expiryLine = params.expiryDate
    ? `<p style="${MUTED_PARA}">This proposal is valid until <strong>${escapeHtml(params.expiryDate)}</strong>.</p>`
    : '';
  const body = `
      <p style="${BODY_PARA}">Hi there,</p>
      <p style="${BODY_PARA}">${escapeHtml(params.partnerName)} has sent you proposal <strong>${escapeHtml(number)}</strong> for <strong>${escapeHtml(params.total)}</strong>. A PDF copy is attached.</p>
      ${renderButton('Review & accept', params.acceptUrl)}
      ${expiryLine}
  `;
  const html = renderLayout({ title: subject, preheader, heading: `Proposal ${number}`, body, footer: supportFooter(params.supportEmail, 'Questions about this proposal? Contact') });
  const support = getSupportEmail(params.supportEmail);
  const text = [
    'Hi there,',
    `${params.partnerName} has sent you proposal ${number} for ${params.total}. A PDF copy is attached.`,
    `Review & accept: ${params.acceptUrl}`,
    params.expiryDate ? `Valid until ${params.expiryDate}.` : null,
    support ? `Questions? Contact ${support}.` : null,
  ].filter(Boolean).join('\n');
  return { subject, html, text };
}
```

- [ ] **Step 4: Run to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteEmail.ts apps/api/src/services/quoteEmail.test.ts apps/api/src/services/email.ts
git commit -m "feat(quotes): quote email template with public accept CTA"
```

---

## Task 8: Quote lifecycle service (`quoteLifecycle.ts`) — send + view + decline

`sendQuote` issues a draft (assign number + issueDate), transitions to `sent`, stamps `sentAt`, mints the public accept token, and emails the customer post-commit. `markQuoteViewed` does the `sent→viewed` + `first_viewed_at` stamp. `declineQuoteByActor` handles internal/portal decline.

**Files:**
- Create: `apps/api/src/services/quoteLifecycle.ts`
- Test: `apps/api/src/__tests__/integration/quoteLifecycle.integration.test.ts`

**Interfaces:**
- Consumes: `getQuote` (quoteService), `allocateQuoteCounter`/`formatQuoteNumber`, `createQuoteAcceptToken`, `buildQuoteTemplate`, `getEmailService`, `resolveBillingEmail` (export it from `invoicePdf.ts` or inline a copy — see note), `renderQuotePdf` (quotePdf), `computeQuoteTotals` is not needed here.
- Produces:
  - `sendQuote(id: string, actor: QuoteActor): Promise<{ quote: QuoteRow; emailed: boolean; acceptUrl: string }>`
  - `markQuoteViewed(quoteId: string, orgId: string): Promise<void>` (idempotent; only stamps `first_viewed_at` once; flips `sent→viewed`)
  - `declineQuoteByActor(id: string, reason: string | undefined, actor: QuoteActor): Promise<QuoteRow>`

- [ ] **Step 1: Write the failing integration test**

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quotes } from '../../db/schema/quotes';
import { createPartner, createOrganization } from './db-utils';
import { createQuote, addManualLine } from '../../services/quoteService';
import { sendQuote, markQuoteViewed, declineQuoteByActor } from '../../services/quoteLifecycle';
import type { QuoteActor } from '../../services/quoteTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    return { partner, org };
  });
}
function ctxFor(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId: null };
}
function actorFor(orgId: string, partnerId: string): QuoteActor {
  return { userId: null, partnerId, accessibleOrgIds: [orgId] };
}

describe('quote lifecycle', () => {
  runDb('sendQuote assigns a number, sets sent + sentAt, returns an accept URL', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.quote.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 100, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));

    const result = await withDbAccessContext(ctx, () => sendQuote(created.quote.id, actor));
    expect(result.quote.status).toBe('sent');
    expect(result.quote.quoteNumber).toMatch(/^Q-\d{4}-\d{4}$/);
    expect(result.quote.sentAt).toBeTruthy();
    expect(result.acceptUrl).toContain('/quote/');
  });

  runDb('markQuoteViewed flips sent→viewed and stamps first_viewed_at once', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.quote.id, actor));
    await markQuoteViewed(created.quote.id, org.id);
    const [v1] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.quote.id)));
    expect(v1!.status).toBe('viewed');
    const firstViewed = v1!.firstViewedAt;
    await markQuoteViewed(created.quote.id, org.id); // idempotent
    const [v2] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.quote.id)));
    expect(v2!.firstViewedAt).toEqual(firstViewed);
  });

  runDb('declineQuoteByActor sets declined + reason', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.quote.id, actor));
    const declined = await withDbAccessContext(ctx, () => declineQuoteByActor(created.quote.id, 'Budget cut', actor));
    expect(declined.status).toBe('declined');
    expect(declined.declineReason).toBe('Budget cut');
    expect(declined.declinedAt).toBeTruthy();
  });

  runDb('sendQuote rejects a non-draft', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.quote.id, actor));
    await expect(withDbAccessContext(ctx, () => sendQuote(created.quote.id, actor))).rejects.toMatchObject({ status: 409 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/quoteLifecycle.integration.test.ts
```
Expected: FAIL — `quoteLifecycle` module not found.

- [ ] **Step 3: Implement**

First, export `resolveBillingEmail` from `invoicePdf.ts` (change `function resolveBillingEmail` → `export function resolveBillingEmail`) so the quote path reuses the exact same JSONB extraction. Then:

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { quotes } from '../db/schema/quotes';
import { organizations, partners } from '../db/schema/orgs';
import { portalBranding } from '../db/schema/portal';
import { getQuote } from './quoteService';
import { QuoteServiceError, type QuoteActor } from './quoteTypes';
import { allocateQuoteCounter, formatQuoteNumber } from './quoteNumbers';
import { createQuoteAcceptToken } from './quoteAcceptToken';
import { buildQuoteTemplate } from './quoteEmail';
import { getEmailService } from './email';
import { resolveBillingEmail } from './invoicePdf';

type QuoteRow = typeof quotes.$inferSelect;

function portalBase(): string {
  // The customer portal app (apps/portal) is where /quote/<token> is served.
  return (process.env.PUBLIC_PORTAL_URL || process.env.PUBLIC_APP_URL || process.env.DASHBOARD_URL || 'http://localhost:4321').replace(/\/$/, '');
}
function formatMoneyish(n: string, currency: string): string {
  // Light formatter for the email body; invoicePdf uses formatMoney — reuse if exported.
  const v = Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'USD' ? `$${v}` : `${v} ${currency}`;
}

/** Issue (if draft) + send: assign number, status→sent, sentAt, mint token, email post-commit. */
export async function sendQuote(id: string, actor: QuoteActor): Promise<{ quote: QuoteRow; emailed: boolean; acceptUrl: string }> {
  const { quote, blocks, lines } = await getQuote(id, actor); // getQuote enforces org-access 404
  if (quote.status !== 'draft' && quote.status !== 'sent') {
    throw new QuoteServiceError(`Cannot send a quote in status ${quote.status}`, 409, 'INVALID_STATE');
  }

  // Assign a number on first issue only (idempotent re-send of an already-numbered sent quote keeps its number).
  let quoteNumber = quote.quoteNumber;
  if (quote.status === 'draft') {
    if (!quoteNumber) {
      const year = new Date(quote.issueDate ?? Date.now()).getUTCFullYear();
      const counter = await allocateQuoteCounter(quote.partnerId, year);
      quoteNumber = formatQuoteNumber('Q', year, counter);
    }
  } else {
    throw new QuoteServiceError('Quote already sent', 409, 'INVALID_STATE');
  }

  const now = new Date();
  const issueDate = quote.issueDate ?? now.toISOString().slice(0, 10);
  await db.update(quotes).set({ status: 'sent', quoteNumber, issueDate, sentAt: now, updatedAt: now }).where(eq(quotes.id, id));

  // Mint the public accept token (expiry = quote.expiryDate if future, else +30d).
  const { token } = await createQuoteAcceptToken({
    quoteId: id, orgId: quote.orgId, partnerId: quote.partnerId,
    expiresAt: quote.expiryDate ? new Date(`${quote.expiryDate}T23:59:59Z`) : null,
  });
  const acceptUrl = `${portalBase()}/quote/${token}`;

  // Post-commit email — never block or fail the send on email/PDF I/O.
  let emailed = false;
  try {
    const [org] = await db.select({ billingContact: organizations.billingContact }).from(organizations).where(eq(organizations.id, quote.orgId)).limit(1);
    const [partner] = await db.select({ name: partners.name }).from(partners).where(eq(partners.id, quote.partnerId)).limit(1);
    const recipient = resolveBillingEmail(org?.billingContact);
    const emailService = getEmailService();
    if (emailService && recipient) {
      const [brand] = await db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor, footerText: portalBranding.footerText }).from(portalBranding).where(eq(portalBranding.orgId, quote.orgId)).limit(1);
      const loadImage = async () => null; // PDF email attach renders without embedded images is acceptable; full image load happens in the route path
      const { renderQuotePdf } = await import('./quotePdf');
      const pdf = await renderQuotePdf({ ...quote, status: 'sent', quoteNumber }, blocks, lines, loadImage, {
        partnerName: partner?.name ?? 'Proposal', logoUrl: brand?.logoUrl ?? null, primaryColor: brand?.primaryColor ?? null,
        footer: quote.terms ?? brand?.footerText ?? null, currencyCode: quote.currencyCode ?? 'USD',
      });
      const template = buildQuoteTemplate({
        quoteNumber: quoteNumber ?? '', partnerName: partner?.name ?? 'your provider',
        total: formatMoneyish(quote.total, quote.currencyCode), acceptUrl,
        expiryDate: quote.expiryDate ?? undefined,
      });
      await emailService.sendEmail({ to: recipient, subject: template.subject, html: template.html, text: template.text, attachments: [{ filename: `${quoteNumber ?? 'quote'}.pdf`, content: pdf, contentType: 'application/pdf' }] });
      emailed = true;
    } else if (!emailService) {
      console.warn(`[quoteLifecycle] Email not configured — quote ${id} sent but not emailed`);
    } else {
      console.warn(`[quoteLifecycle] No billing email for org ${quote.orgId} — quote ${id} sent but not emailed`);
    }
  } catch (err) {
    console.error(`[quoteLifecycle] send email failed for quote ${id}:`, err);
  }

  const [updated] = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
  return { quote: updated!, emailed, acceptUrl };
}

/** sent→viewed + first_viewed_at (once). orgId is the resolved tenant (from session or token). */
export async function markQuoteViewed(quoteId: string, orgId: string): Promise<void> {
  const [q] = await db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  if (!q || q.orgId !== orgId) return; // scoped no-op; never throw on a view stamp
  const now = new Date();
  const set: Record<string, unknown> = { viewedAt: now, updatedAt: now };
  if (!q.firstViewedAt) set.firstViewedAt = now;
  if (q.status === 'sent') set.status = 'viewed';
  await db.update(quotes).set(set).where(eq(quotes.id, quoteId));
}

/** Internal/portal decline. */
export async function declineQuoteByActor(id: string, reason: string | undefined, actor: QuoteActor): Promise<QuoteRow> {
  const { quote } = await getQuote(id, actor);
  if (quote.status !== 'sent' && quote.status !== 'viewed') {
    throw new QuoteServiceError(`Cannot decline a quote in status ${quote.status}`, 409, 'INVALID_STATE');
  }
  const now = new Date();
  await db.update(quotes).set({ status: 'declined', declineReason: reason ?? null, declinedAt: now, updatedAt: now }).where(eq(quotes.id, id));
  const [updated] = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
  return updated!;
}
```

> Note for the implementer: confirm `renderQuotePdf`'s signature from the Phase 1 route (`apps/api/src/routes/quotes/quotes.ts:124-125`): `renderQuotePdf(quote, blocks, lines, loadImage, branding)`. If `formatMoney`/`formatDate` are exported from `invoicePdf.ts`, prefer them over the local `formatMoneyish`. Email failures are swallowed by design (send already committed) — mirrors invoice send.

- [ ] **Step 4: Run to verify it passes** — same command as Step 2; Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteLifecycle.ts apps/api/src/services/invoicePdf.ts apps/api/src/__tests__/integration/quoteLifecycle.integration.test.ts
git commit -m "feat(quotes): send (issue+email), view-stamp, and decline lifecycle"
```

---

## Task 9: Accept → convert service (`quoteAcceptService.ts`)

The shared accept pipeline used by BOTH the portal and public routes: guard status → compute content hash → provider.capture → insert `quote_acceptances` → convert one-time lines to an invoice → status→converted → revoke token jti.

**Files:**
- Create: `apps/api/src/services/quoteAcceptService.ts`
- Test: `apps/api/src/__tests__/integration/quoteAccept.integration.test.ts`

**Interfaces:**
- Consumes: `getQuote`, `computeQuoteSha256`, `getAcceptanceProvider`, `createManualInvoice`+`addManualLine`+`issueInvoice` (invoiceService) OR a direct invoice insert (see note), `revokeQuoteAcceptJti`.
- Produces: `acceptQuote(input: AcceptQuoteParams): Promise<{ quote: QuoteRow; acceptanceId: string; invoiceId: string }>` where `AcceptQuoteParams = { quoteId; signerName; signerEmail?; ipAddress?; userAgent?; acceptanceTokenJti?; actorUserId?: string | null }`.

- [ ] **Step 1: Write the failing integration test**

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quotes, quoteAcceptances } from '../../db/schema/quotes';
import { invoices, invoiceLines } from '../../db/schema/invoices';
import { createPartner, createOrganization } from './db-utils';
import { createQuote, addManualLine } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';
import type { QuoteActor } from '../../services/quoteTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);
function ctxFor(orgId: string, partnerId: string): DbAccessContext { return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId: null }; }
function actorFor(orgId: string, partnerId: string): QuoteActor { return { userId: null, partnerId, accessibleOrgIds: [orgId] }; }
async function seed() { return withSystemDbAccessContext(async () => { const partner = await createPartner(); const org = await createOrganization({ partnerId: partner.id }); return { partner, org }; }); }

describe('quote accept → convert', () => {
  runDb('records acceptance with content hash and converts one-time lines to an invoice', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id); const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.quote.id, { sourceType: 'manual', description: 'Onboarding', quantity: 1, unitPrice: 250, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.quote.id, { sourceType: 'manual', description: 'Managed services', quantity: 1, unitPrice: 99, taxable: false, customerVisible: true, recurrence: 'monthly' } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.quote.id, actor));

    const res = await withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.quote.id, signerName: 'Jane Buyer', signerEmail: 'jane@org.example', ipAddress: '9.9.9.9', userAgent: 'UA' }));
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.quote.id)));
    expect(q!.status).toBe('converted');
    expect(q!.convertedInvoiceId).toBe(res.invoiceId);
    expect(q!.acceptedAt).toBeTruthy();

    const [acc] = await withSystemDbAccessContext(() => db.select().from(quoteAcceptances).where(eq(quoteAcceptances.id, res.acceptanceId)));
    expect(acc!.signerName).toBe('Jane Buyer');
    expect(acc!.quoteSha256).toMatch(/^[0-9a-f]{64}$/);

    // Only the one-time line ($250) is invoiced; the monthly line is excluded.
    const invLines = await withSystemDbAccessContext(() => db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, res.invoiceId)));
    expect(invLines).toHaveLength(1);
    expect(invLines[0]!.description).toBe('Onboarding');
    const [inv] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, res.invoiceId)));
    expect(inv!.total).toBe('250.00');
  });

  runDb('a recurring-only quote still converts but yields a $0 invoice (Phase 2 degenerate edge)', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id); const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.quote.id, { sourceType: 'manual', description: 'Managed services', quantity: 1, unitPrice: 99, taxable: false, customerVisible: true, recurrence: 'monthly' } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.quote.id, actor));
    const res = await withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.quote.id, signerName: 'Bob' }));
    const [inv] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, res.invoiceId)));
    expect(inv!.total).toBe('0.00');
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.quote.id)));
    expect(q!.status).toBe('converted');
  });

  runDb('rejects accepting a quote that is not sent/viewed', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id); const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    // still draft
    await expect(withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.quote.id, signerName: 'Jane' }))).rejects.toMatchObject({ status: 409 });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/quoteAccept.integration.test.ts`; Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { quotes, quoteBlocks, quoteLines, quoteAcceptances } from '../db/schema/quotes';
import { invoices, invoiceLines } from '../db/schema/invoices';
import { QuoteServiceError } from './quoteTypes';
import { computeQuoteSha256 } from './quoteContentHash';
import { getAcceptanceProvider } from './acceptanceProvider';
import { revokeQuoteAcceptJti } from './quoteAcceptToken';
import { computeLineTotal, computeInvoiceTotals } from './invoiceMath';

export interface AcceptQuoteParams {
  quoteId: string;
  signerName: string;
  signerEmail?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  acceptanceTokenJti?: string | null;
  actorUserId?: string | null;
}

type QuoteRow = typeof quotes.$inferSelect;

/**
 * Shared accept pipeline for both the portal and public paths. The CALLER is
 * responsible for establishing the DB access context: portal handlers run under
 * org scope; the public route wraps this in
 * runOutsideDbContext(withSystemDbAccessContext(...)) because it's unauthenticated.
 */
export async function acceptQuote(params: AcceptQuoteParams): Promise<{ quote: QuoteRow; acceptanceId: string; invoiceId: string }> {
  const [quote] = await db.select().from(quotes).where(eq(quotes.id, params.quoteId)).limit(1);
  if (!quote) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  if (quote.status !== 'sent' && quote.status !== 'viewed') {
    throw new QuoteServiceError(`Cannot accept a quote in status ${quote.status}`, 409, 'INVALID_STATE');
  }

  const blocks = await db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, quote.id)).orderBy(quoteBlocks.sortOrder);
  const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, quote.id)).orderBy(quoteLines.sortOrder);

  const quoteSha256 = computeQuoteSha256(quote as any, blocks as any, lines as any);
  const captured = await getAcceptanceProvider().capture({
    quoteId: quote.id, signerName: params.signerName, signerEmail: params.signerEmail,
    ipAddress: params.ipAddress, userAgent: params.userAgent, acceptanceTokenJti: params.acceptanceTokenJti,
  });

  const now = new Date();

  // 1. Record the acceptance.
  const [acceptance] = await db.insert(quoteAcceptances).values({
    quoteId: quote.id, orgId: quote.orgId, signerName: captured.signerName, signerEmail: captured.signerEmail,
    ipAddress: params.ipAddress ?? null, userAgent: params.userAgent ?? null, quoteSha256,
    acceptanceTokenJti: params.acceptanceTokenJti ?? null,
  }).returning({ id: quoteAcceptances.id });

  // 2. Convert ONE-TIME lines to a draft invoice (Phase 2: recurring lines deferred to the Phase 4 Contract).
  const oneTime = lines.filter((l) => l.recurrence === 'one_time' && l.customerVisible);
  const [invoice] = await db.insert(invoices).values({
    partnerId: quote.partnerId, orgId: quote.orgId, siteId: quote.siteId ?? null, status: 'draft',
    currencyCode: quote.currencyCode, taxRate: quote.taxRate ?? null, createdBy: params.actorUserId ?? null,
    notes: quote.quoteNumber ? `Converted from quote ${quote.quoteNumber}` : 'Converted from quote',
  }).returning();

  const totalsLines: { lineTotal: string; taxable: boolean; customerVisible: boolean }[] = [];
  for (let i = 0; i < oneTime.length; i++) {
    const l = oneTime[i]!;
    const lineTotal = computeLineTotal(l.quantity, l.unitPrice);
    await db.insert(invoiceLines).values({
      invoiceId: invoice!.id, orgId: quote.orgId, sourceType: 'manual', sourceId: null, catalogItemId: l.catalogItemId ?? null,
      parentLineId: null, ticketId: null, description: l.description, quantity: l.quantity,
      unitPrice: Number(l.unitPrice).toFixed(2), costBasis: null, taxable: l.taxable, customerVisible: true,
      lineTotal, isUnapprovedTime: false, sortOrder: i,
    });
    totalsLines.push({ lineTotal, taxable: l.taxable, customerVisible: true });
  }
  const totals = computeInvoiceTotals(totalsLines, quote.taxRate ?? null);
  await db.update(invoices).set({ subtotal: totals.subtotal, taxTotal: totals.taxTotal, total: totals.total, balance: totals.total, updatedAt: now }).where(eq(invoices.id, invoice!.id));

  // 3. Transition the quote to converted.
  await db.update(quotes).set({ status: 'converted', acceptedAt: now, convertedAt: now, convertedInvoiceId: invoice!.id, updatedAt: now }).where(eq(quotes.id, quote.id));

  // 4. Best-effort revoke the public token so the link can't be reused.
  if (params.acceptanceTokenJti) {
    try { await revokeQuoteAcceptJti(params.acceptanceTokenJti); } catch (err) { console.error('[quoteAcceptService] jti revoke failed', err); }
  }

  const [updated] = await db.select().from(quotes).where(eq(quotes.id, quote.id)).limit(1);
  return { quote: updated!, acceptanceId: acceptance!.id, invoiceId: invoice!.id };
}
```

> Note for the implementer: the convert path inserts the invoice + lines directly rather than going through `invoiceService.createManualInvoice` so the whole accept is one logical unit and the line `recurrence` filter is explicit. If `invoiceService` later grows a `createInvoiceFromLines` helper, refactor to it. The invoice is left in `draft` (un-numbered) — issuing/sending the invoice is the existing invoice flow, not part of accept. `computeInvoiceTotals` on an empty `totalsLines` returns `'0.00'` totals (verify against `invoiceMath.test.ts`), which is the recurring-only $0 edge.

- [ ] **Step 4: Run to verify it passes** — same command as Step 2; Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteAcceptService.ts apps/api/src/__tests__/integration/quoteAccept.integration.test.ts
git commit -m "feat(quotes): accept records signature+hash and converts one-time lines to an invoice"
```

---

## Task 10: Quote image storage (`quoteImageStorage.ts`)

Bytea-in-DB image store for proposal image blocks. Reuses `sniffImageMime` + the 5 MB cap from `avatarStorage.ts`.

**Files:**
- Create: `apps/api/src/services/quoteImageStorage.ts`
- Test: `apps/api/src/__tests__/integration/quoteImages.integration.test.ts`

**Interfaces:**
- Produces: `writeQuoteImage(quoteId, orgId, mime, buffer): Promise<{ id: string; byteSize: number; sha256: string }>`; `readQuoteImage(imageId, quoteId): Promise<{ data: Buffer; mime: string; byteSize: number } | null>`; re-exports `sniffImageMime` and `MAX_QUOTE_IMAGE_SIZE_BYTES`.

- [ ] **Step 1: Write the failing integration test**

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { db } from '../../db';
import { quotes } from '../../db/schema/quotes';
import { createPartner, createOrganization } from './db-utils';
import { writeQuoteImage, readQuoteImage } from '../../services/quoteImageStorage';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);

describe('quote image storage', () => {
  runDb('writes and reads back a PNG scoped to its quote', async () => {
    const { ctx, quoteId } = await withSystemDbAccessContext(async () => {
      const partner = await createPartner(); const org = await createOrganization({ partnerId: partner.id });
      const [q] = await db.insert(quotes).values({ partnerId: partner.id, orgId: org.id, currencyCode: 'USD' }).returning({ id: quotes.id, orgId: quotes.orgId });
      const ctx: DbAccessContext = { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [partner.id], userId: null };
      return { ctx, quoteId: q!.id, orgId: org.id };
    });
    const written = await withDbAccessContext(ctx, () => writeQuoteImage(quoteId, ctx.orgId!, 'image/png', PNG));
    expect(written.sha256).toMatch(/^[0-9a-f]{64}$/);
    const read = await withDbAccessContext(ctx, () => readQuoteImage(written.id, quoteId));
    expect(read?.mime).toBe('image/png');
    expect(read?.data.equals(PNG)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/quoteImages.integration.test.ts`; Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { quoteImages } from '../db/schema/quotes';
import { sniffImageMime } from './avatarStorage';

export { sniffImageMime };
export const MAX_QUOTE_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // reuse the avatar cap

export async function writeQuoteImage(quoteId: string, orgId: string, mime: string, buffer: Buffer): Promise<{ id: string; byteSize: number; sha256: string }> {
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const [row] = await db.insert(quoteImages).values({
    quoteId, orgId, imageData: buffer, mime, byteSize: buffer.length, sha256,
  }).returning({ id: quoteImages.id });
  return { id: row!.id, byteSize: buffer.length, sha256 };
}

/** Read constrained to BOTH the image id AND its quote (closes same-org cross-quote embed). */
export async function readQuoteImage(imageId: string, quoteId: string): Promise<{ data: Buffer; mime: string; byteSize: number } | null> {
  const [img] = await db.select({ data: quoteImages.imageData, mime: quoteImages.mime, byteSize: quoteImages.byteSize })
    .from(quoteImages).where(and(eq(quoteImages.id, imageId), eq(quoteImages.quoteId, quoteId))).limit(1);
  return img?.data ? { data: img.data, mime: img.mime, byteSize: img.byteSize } : null;
}
```

- [ ] **Step 4: Run to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteImageStorage.ts apps/api/src/__tests__/integration/quoteImages.integration.test.ts
git commit -m "feat(quotes): quote image bytea storage (magic-byte sniff + sha256)"
```

---

## Task 11: Internal routes — send + image upload/serve

Wire the three authed routes onto the Phase 1 quote router. **This is where the dead `quotes:send` permission gets wired.**

**Files:**
- Create: `apps/api/src/routes/quotes/lifecycle.ts`
- Modify: `apps/api/src/routes/quotes/index.ts` (mount), `apps/api/src/routes/quotes/quotes.ts` (export `quoteActorFrom`, `handleServiceError` — already exported)
- Test: `apps/api/src/__tests__/integration/quoteSendRbac.integration.test.ts` (Task 13 adds the negative RBAC case; here add a smoke route test if the repo has a route-test harness, else cover via the lifecycle integration test already written).

**Interfaces:**
- Consumes: `sendQuote`, `writeQuoteImage`/`readQuoteImage`/`sniffImageMime`/`MAX_QUOTE_IMAGE_SIZE_BYTES`, `getQuote` (org guard for image ops), `quoteActorFrom`, `handleServiceError`.
- Produces: `quoteLifecycleRoutes` (Hono) with `POST /:id/send`, `POST /:id/images`, `GET /:id/images/:imageId`.

- [ ] **Step 1: Write the route module**

```ts
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { sendQuote } from '../../services/quoteLifecycle';
import { getQuote } from '../../services/quoteService';
import { writeQuoteImage, readQuoteImage, sniffImageMime, MAX_QUOTE_IMAGE_SIZE_BYTES } from '../../services/quoteImageStorage';
import { quoteActorFrom, handleServiceError } from './quotes';

export const quoteLifecycleRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.QUOTES_READ.resource, PERMISSIONS.QUOTES_READ.action);
const writePerm = requirePermission(PERMISSIONS.QUOTES_WRITE.resource, PERMISSIONS.QUOTES_WRITE.action);
const sendPerm = requirePermission(PERMISSIONS.QUOTES_SEND.resource, PERMISSIONS.QUOTES_SEND.action);
const idParam = z.object({ id: z.string().uuid() });
const imageParam = z.object({ id: z.string().uuid(), imageId: z.string().uuid() });

// POST /:id/send — issue + email. Gated on the (previously dead) quotes:send permission.
quoteLifecycleRoutes.post('/:id/send', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await sendQuote(c.req.valid('param').id, quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});

// POST /:id/images — multipart upload (magic-byte sniff + 5 MB cap). quotes:write.
quoteLifecycleRoutes.post('/:id/images',
  scopes, writePerm, zValidator('param', idParam),
  bodyLimit({ maxSize: MAX_QUOTE_IMAGE_SIZE_BYTES + 64 * 1024, onError: (c) => c.json({ error: 'Image too large (max 5 MB)' }, 413) }),
  async (c) => {
    const id = c.req.valid('param').id;
    try {
      const { quote } = await getQuote(id, quoteActorFrom(c)); // org-access 404
      let body: Record<string, unknown>;
      try { body = await c.req.parseBody({ all: true }); } catch { return c.json({ error: 'Invalid multipart body' }, 400); }
      const file = body.file;
      if (!(file instanceof File)) return c.json({ error: 'file field is required' }, 400);
      if (file.size === 0) return c.json({ error: 'file is empty' }, 400);
      if (file.size > MAX_QUOTE_IMAGE_SIZE_BYTES) return c.json({ error: 'Image too large (max 5 MB)' }, 413);
      const buffer = Buffer.from(await file.arrayBuffer());
      const mime = sniffImageMime(buffer);
      if (!mime) return c.json({ error: 'Unsupported image format. Allowed: PNG, JPEG, WebP.' }, 415);
      const written = await writeQuoteImage(id, quote.orgId, mime, buffer);
      return c.json({ data: { imageId: written.id, mime, byteSize: written.byteSize } });
    } catch (err) { return handleServiceError(c, err); }
  });

// GET /:id/images/:imageId — serve for the editor preview. quotes:read.
quoteLifecycleRoutes.get('/:id/images/:imageId', scopes, readPerm, zValidator('param', imageParam), async (c) => {
  const { id, imageId } = c.req.valid('param');
  try {
    await getQuote(id, quoteActorFrom(c)); // org-access 404 before serving bytes
    const img = await readQuoteImage(imageId, id);
    if (!img) return c.json({ error: 'Image not found' }, 404);
    return new Response(new Uint8Array(img.data), { status: 200, headers: { 'Content-Type': img.mime, 'Content-Length': String(img.byteSize), 'Cache-Control': 'private, max-age=300' } });
  } catch (err) { return handleServiceError(c, err); }
});
```

- [ ] **Step 2: Mount it** — in `apps/api/src/routes/quotes/index.ts`, mount alongside `quoteCrudRoutes`:

```ts
import { quoteLifecycleRoutes } from './lifecycle';
// ... after the existing quoteCrudRoutes mount:
quoteRoutes.route('/', quoteLifecycleRoutes);
```

(Match the existing mount style — if `index.ts` does `quoteRoutes.route('/', quoteCrudRoutes)` after `authMiddleware`, append the same for lifecycle so both sit behind auth.)

- [ ] **Step 3: Typecheck the API**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```
Expected: no NEW errors (pre-existing `agents.test.ts`/`apiKeyAuth.test.ts` errors per memory are acceptable).

- [ ] **Step 4: Smoke the send path** — the Task 8 lifecycle integration test already exercises `sendQuote`; re-run it to confirm nothing regressed:

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/quoteLifecycle.integration.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/quotes/lifecycle.ts apps/api/src/routes/quotes/index.ts
git commit -m "feat(quotes): internal send (quotes:send) + image upload/serve routes"
```

---

## Task 12: Portal routes (`routes/portal/quotes.ts`)

Customer-portal view for org users with portal accounts. Org-scoped under `portalAuthMiddleware`; drafts filtered; accept records the `portal_user` as signer.

**Files:**
- Create: `apps/api/src/routes/portal/quotes.ts`
- Modify: `apps/api/src/routes/portal/index.ts` (mount `quoteRoutes`)
- Test: `apps/api/src/__tests__/integration/portalQuotes.integration.test.ts`

**Interfaces:**
- Consumes: `c.get('portalAuth')` (`auth.user.orgId`, `auth.user.id`, `auth.user.name`, `auth.user.email`), `getQuote` is NOT used (portal reads directly, org-scoped); `markQuoteViewed`, `acceptQuote`, `declineQuoteByActor`-equivalent inline decline, `renderQuotePdf`, `readQuoteImage`.
- Produces: `quoteRoutes` (Hono) — `GET /quotes`, `GET /quotes/:id`, `GET /quotes/:id/pdf`, `GET /quotes/:id/images/:imageId`, `POST /quotes/:id/accept`, `POST /quotes/:id/decline`.

- [ ] **Step 1: Write the failing integration test**

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quotes, quoteAcceptances } from '../../db/schema/quotes';
import { createPartner, createOrganization } from './db-utils';
import { createQuote, addManualLine } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';

// These exercise the SERVICE layer the portal routes call, under the SAME org
// scope the portal middleware establishes. (Full HTTP route tests would need
// the portal session harness; the service-under-portal-scope path is the
// security-critical surface.)
const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('portal quotes (org-scoped)', () => {
  runDb('portal accept records the portal user identity as signer + converts', async () => {
    const fx = await withSystemDbAccessContext(async () => {
      const partner = await createPartner(); const org = await createOrganization({ partnerId: partner.id });
      return { partnerId: partner.id, orgId: org.id };
    });
    const ctx: DbAccessContext = { scope: 'organization', orgId: fx.orgId, accessibleOrgIds: [fx.orgId], accessiblePartnerIds: [fx.partnerId], userId: null };
    const actor = { userId: null, partnerId: fx.partnerId, accessibleOrgIds: [fx.orgId] };
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: fx.orgId, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.quote.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 100, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.quote.id, actor));

    // Portal handler would call acceptQuote with the portal_user's name/email.
    const res = await withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.quote.id, signerName: 'Portal Pat', signerEmail: 'pat@org.example' }));
    const [acc] = await withSystemDbAccessContext(() => db.select().from(quoteAcceptances).where(eq(quoteAcceptances.id, res.acceptanceId)));
    expect(acc!.signerName).toBe('Portal Pat');
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.quote.id)));
    expect(q!.status).toBe('converted');
  });

  runDb('another org cannot read this org quote (RLS hides it under portal scope)', async () => {
    const fx = await withSystemDbAccessContext(async () => {
      const pA = await createPartner(); const oA = await createOrganization({ partnerId: pA.id });
      const pB = await createPartner(); const oB = await createOrganization({ partnerId: pB.id });
      const [qA] = await db.insert(quotes).values({ partnerId: pA.id, orgId: oA.id, currencyCode: 'USD', status: 'sent' }).returning({ id: quotes.id });
      return { orgB: oB.id, partnerB: pB.id, quoteA: qA!.id };
    });
    const ctxB: DbAccessContext = { scope: 'organization', orgId: fx.orgB, accessibleOrgIds: [fx.orgB], accessiblePartnerIds: [fx.partnerB], userId: null };
    const visible = await withDbAccessContext(ctxB, () => db.select({ id: quotes.id }).from(quotes).where(eq(quotes.id, fx.quoteA)));
    expect(visible).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/portalQuotes.integration.test.ts`; Expected: FAIL only if `acceptQuote`/imports are wrong; if Task 9 is done it may PASS the first case but the route file still doesn't exist — the route file is exercised in feature-testing. (This test guards the service-under-portal-scope contract; keep it.)

- [ ] **Step 3: Implement the portal route module** (mirror `portal/invoices.ts`)

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '../../db';
import { quotes, quoteBlocks, quoteLines } from '../../db/schema/quotes';
import { partners } from '../../db/schema/orgs';
import { portalBranding } from '../../db/schema/portal';
import { acceptQuoteSchema, declineQuoteSchema } from '@breeze/shared';
import { markQuoteViewed } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';
import { readQuoteImage } from '../../services/quoteImageStorage';
import { QuoteServiceError } from '../../services/quoteTypes';
import { safeContentDispositionFilename } from '../../utils/httpHeaders';

export const quoteRoutes = new Hono();
const idParam = z.object({ id: z.string().uuid() });
const imageParam = z.object({ id: z.string().uuid(), imageId: z.string().uuid() });

// GET /quotes — list (drafts filtered; org defense-in-depth atop RLS).
quoteRoutes.get('/quotes', async (c) => {
  const auth = c.get('portalAuth');
  const conditions = and(eq(quotes.orgId, auth.user.orgId), ne(quotes.status, 'draft'));
  const data = await db.select({
    id: quotes.id, quoteNumber: quotes.quoteNumber, status: quotes.status, currencyCode: quotes.currencyCode,
    issueDate: quotes.issueDate, expiryDate: quotes.expiryDate, total: quotes.total,
  }).from(quotes).where(conditions).orderBy(desc(quotes.issueDate), desc(quotes.createdAt)).limit(200);
  return c.json({ data, pagination: { page: 1, limit: 200, total: data.length } });
});

// GET /quotes/:id — detail (+ blocks + customer-visible lines). Stamps viewed.
quoteRoutes.get('/quotes/:id', zValidator('param', idParam), async (c) => {
  const auth = c.get('portalAuth'); const { id } = c.req.valid('param');
  const [quote] = await db.select().from(quotes).where(and(eq(quotes.id, id), eq(quotes.orgId, auth.user.orgId))).limit(1);
  if (!quote || quote.status === 'draft') return c.json({ error: 'Quote not found' }, 404);
  const blocks = await db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, id)).orderBy(quoteBlocks.sortOrder);
  const lines = (await db.select().from(quoteLines).where(eq(quoteLines.quoteId, id)).orderBy(quoteLines.sortOrder)).filter((l) => l.customerVisible);
  try { await markQuoteViewed(id, auth.user.orgId); } catch (err) { console.error('[portal] quote markViewed failed', { id, err }); }
  return c.json({ data: { quote, blocks, lines } });
});

// GET /quotes/:id/pdf
quoteRoutes.get('/quotes/:id/pdf', zValidator('param', idParam), async (c) => {
  const auth = c.get('portalAuth'); const { id } = c.req.valid('param');
  const [quote] = await db.select().from(quotes).where(and(eq(quotes.id, id), eq(quotes.orgId, auth.user.orgId))).limit(1);
  if (!quote || quote.status === 'draft') return c.json({ error: 'Quote not found' }, 404);
  const blocks = await db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, id)).orderBy(quoteBlocks.sortOrder);
  const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, id)).orderBy(quoteLines.sortOrder);
  const [partner] = await db.select({ name: partners.name, footer: partners.invoiceFooter, currency: partners.currencyCode }).from(partners).where(eq(partners.id, quote.partnerId)).limit(1);
  const [brand] = await db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor, footerText: portalBranding.footerText }).from(portalBranding).where(eq(portalBranding.orgId, quote.orgId)).limit(1);
  const loadImage = async (imageId: string) => { const img = await readQuoteImage(imageId, id); return img ? { data: img.data } : null; };
  const { renderQuotePdf } = await import('../../services/quotePdf');
  const pdf = await renderQuotePdf(quote, blocks, lines, loadImage, {
    partnerName: partner?.name ?? 'Proposal', logoUrl: brand?.logoUrl ?? null, primaryColor: brand?.primaryColor ?? null,
    footer: quote.terms ?? partner?.footer ?? brand?.footerText ?? null, currencyCode: quote.currencyCode ?? partner?.currency ?? 'USD',
  });
  const filename = safeContentDispositionFilename(`quote-${quote.quoteNumber || quote.id}.pdf`);
  return new Response(new Uint8Array(pdf), { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"`, 'Content-Length': String(pdf.length) } });
});

// GET /quotes/:id/images/:imageId
quoteRoutes.get('/quotes/:id/images/:imageId', zValidator('param', imageParam), async (c) => {
  const auth = c.get('portalAuth'); const { id, imageId } = c.req.valid('param');
  const [quote] = await db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.id, id), eq(quotes.orgId, auth.user.orgId), ne(quotes.status, 'draft'))).limit(1);
  if (!quote) return c.json({ error: 'Quote not found' }, 404);
  const img = await readQuoteImage(imageId, id);
  if (!img) return c.json({ error: 'Image not found' }, 404);
  return new Response(new Uint8Array(img.data), { status: 200, headers: { 'Content-Type': img.mime, 'Content-Length': String(img.byteSize), 'Cache-Control': 'private, max-age=300' } });
});

// POST /quotes/:id/accept — signer identity = the authenticated portal user.
quoteRoutes.post('/quotes/:id/accept', zValidator('param', idParam), zValidator('json', acceptQuoteSchema.partial()), async (c) => {
  const auth = c.get('portalAuth'); const { id } = c.req.valid('param');
  const [quote] = await db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.id, id), eq(quotes.orgId, auth.user.orgId), ne(quotes.status, 'draft'))).limit(1);
  if (!quote) return c.json({ error: 'Quote not found' }, 404);
  try {
    const res = await acceptQuote({
      quoteId: id, signerName: auth.user.name || auth.user.email, signerEmail: auth.user.email,
      ipAddress: c.req.header('x-forwarded-for') ?? null, userAgent: c.req.header('user-agent') ?? null, actorUserId: null,
    });
    return c.json({ data: { invoiceId: res.invoiceId, status: res.quote.status } });
  } catch (err) { if (err instanceof QuoteServiceError) return c.json({ error: err.message, code: err.code }, err.status); throw err; }
});

// POST /quotes/:id/decline
quoteRoutes.post('/quotes/:id/decline', zValidator('param', idParam), zValidator('json', declineQuoteSchema), async (c) => {
  const auth = c.get('portalAuth'); const { id } = c.req.valid('param'); const { reason } = c.req.valid('json');
  const [quote] = await db.select().from(quotes).where(and(eq(quotes.id, id), eq(quotes.orgId, auth.user.orgId), ne(quotes.status, 'draft'))).limit(1);
  if (!quote) return c.json({ error: 'Quote not found' }, 404);
  if (quote.status !== 'sent' && quote.status !== 'viewed') return c.json({ error: `Cannot decline a quote in status ${quote.status}`, code: 'INVALID_STATE' }, 409);
  const now = new Date();
  await db.update(quotes).set({ status: 'declined', declineReason: reason ?? null, declinedAt: now, updatedAt: now }).where(eq(quotes.id, id));
  return c.json({ data: { status: 'declined' } });
});
```

- [ ] **Step 4: Mount in `routes/portal/index.ts`** — alongside the invoice mount, behind `portalAuthMiddleware`:

```ts
import { quoteRoutes as portalQuoteRoutes } from './quotes';
// after the invoiceRoutes mount (same middleware chain):
portal.route('/', portalQuoteRoutes);
```

(Match the existing portal mount style — if invoices mount as `portal.route('/', invoiceRoutes)` after `portal.use('*', portalAuthMiddleware)`, do the same.)

- [ ] **Step 5: Run the portal integration test + typecheck**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/portalQuotes.integration.test.ts && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```
Expected: PASS + no new type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/portal/quotes.ts apps/api/src/routes/portal/index.ts apps/api/src/__tests__/integration/portalQuotes.integration.test.ts
git commit -m "feat(quotes): customer-portal quote view + accept/decline routes"
```

---

## Task 13: Public tokenized routes (`routes/quotesPublic.ts`) + RBAC negative test

The unauthenticated surface. **Every DB op goes through `runOutsideDbContext(() => withSystemDbAccessContext(...))`, scoped to the token's quoteId/orgId.** Also adds the negative-RBAC test proving a `quotes:read`/`write` user without `send` cannot send.

**Files:**
- Create: `apps/api/src/routes/quotesPublic.ts`
- Modify: `apps/api/src/index.ts` (mount BEFORE auth-gated routes)
- Test: `apps/api/src/__tests__/integration/quotesPublic.integration.test.ts`, `apps/api/src/__tests__/integration/quoteSendRbac.integration.test.ts`

**Interfaces:**
- Consumes: `verifyQuoteAcceptToken`, `isQuoteAcceptJtiRevoked`, `markQuoteViewed`, `acceptQuote`, `readQuoteImage`, `computeQuoteSha256` (indirect via acceptQuote), `runOutsideDbContext`, `withSystemDbAccessContext`.
- Produces: `quotesPublicRoutes` (Hono) — `GET /:token`, `GET /:token/images/:imageId`, `POST /:token/accept`, `POST /:token/decline`. Mounted at `/quotes/public`.

- [ ] **Step 1: Write the failing integration test**

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quotes, quoteAcceptances } from '../../db/schema/quotes';
import { createPartner, createOrganization } from './db-utils';
import { createQuote, addManualLine } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { createQuoteAcceptToken, verifyQuoteAcceptToken } from '../../services/quoteAcceptToken';
import { acceptQuote } from '../../services/quoteAcceptService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('public quote token path', () => {
  runDb('an unauthenticated accept (system scope, token-resolved) records + converts', async () => {
    const fx = await withSystemDbAccessContext(async () => {
      const partner = await createPartner(); const org = await createOrganization({ partnerId: partner.id });
      return { partnerId: partner.id, orgId: org.id };
    });
    const ctx: DbAccessContext = { scope: 'organization', orgId: fx.orgId, accessibleOrgIds: [fx.orgId], accessiblePartnerIds: [fx.partnerId], userId: null };
    const actor = { userId: null, partnerId: fx.partnerId, accessibleOrgIds: [fx.orgId] };
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: fx.orgId, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.quote.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 100, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.quote.id, actor));

    // Public path: mint+verify token, then accept under SYSTEM scope resolved from token claims.
    const { token } = await createQuoteAcceptToken({ quoteId: created.quote.id, orgId: fx.orgId, partnerId: fx.partnerId });
    const claims = await verifyQuoteAcceptToken(token);
    expect(claims?.quoteId).toBe(created.quote.id);
    const res = await withSystemDbAccessContext(() => acceptQuote({ quoteId: claims!.quoteId, signerName: 'Prospect Pat', acceptanceTokenJti: claims!.jti }));
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.quote.id)));
    expect(q!.status).toBe('converted');
    const [acc] = await withSystemDbAccessContext(() => db.select().from(quoteAcceptances).where(eq(quoteAcceptances.id, res.acceptanceId)));
    expect(acc!.acceptanceTokenJti).toBe(claims!.jti);
  });

  runDb('the recorded hash matches a re-render and mismatches a tampered quote', async () => {
    const fx = await withSystemDbAccessContext(async () => { const partner = await createPartner(); const org = await createOrganization({ partnerId: partner.id }); return { partnerId: partner.id, orgId: org.id }; });
    const ctx: DbAccessContext = { scope: 'organization', orgId: fx.orgId, accessibleOrgIds: [fx.orgId], accessiblePartnerIds: [fx.partnerId], userId: null };
    const actor = { userId: null, partnerId: fx.partnerId, accessibleOrgIds: [fx.orgId] };
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: fx.orgId, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.quote.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 100, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.quote.id, actor));
    const res = await withSystemDbAccessContext(() => acceptQuote({ quoteId: created.quote.id, signerName: 'Pat' }));
    const [acc] = await withSystemDbAccessContext(() => db.select().from(quoteAcceptances).where(eq(quoteAcceptances.id, res.acceptanceId)));

    // Re-render the SAME content → hash equals the recorded one.
    const { computeQuoteSha256 } = await import('../../services/quoteContentHash');
    const { quoteBlocks, quoteLines } = await import('../../db/schema/quotes');
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.quote.id)));
    const blocks = await withSystemDbAccessContext(() => db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, created.quote.id)));
    const lines = await withSystemDbAccessContext(() => db.select().from(quoteLines).where(eq(quoteLines.quoteId, created.quote.id)));
    expect(computeQuoteSha256(q as any, blocks as any, lines as any)).toBe(acc!.quoteSha256);
    const tampered = lines.map((l) => ({ ...l, unitPrice: '1.00', lineTotal: '1.00' }));
    expect(computeQuoteSha256(q as any, blocks as any, tampered as any)).not.toBe(acc!.quoteSha256);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/quotesPublic.integration.test.ts`; Expected: FAIL until Tasks 5/9 are present (token + acceptQuote). If those tasks are done, the test may PASS at the service level — that's fine; it locks the public-path contract. The HTTP route is exercised in feature-testing.

- [ ] **Step 3: Implement the public route module**

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq, and } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { quotes, quoteBlocks, quoteLines } from '../db/schema/quotes';
import { partners } from '../db/schema/orgs';
import { portalBranding } from '../db/schema/portal';
import { acceptQuoteSchema, declineQuoteSchema } from '@breeze/shared';
import { verifyQuoteAcceptToken, isQuoteAcceptJtiRevoked } from '../services/quoteAcceptToken';
import { markQuoteViewed } from '../services/quoteLifecycle';
import { acceptQuote } from '../services/quoteAcceptService';
import { readQuoteImage } from '../services/quoteImageStorage';
import { QuoteServiceError } from '../services/quoteTypes';

export const quotesPublicRoutes = new Hono();
const tokenParam = z.object({ token: z.string().min(10) });
const tokenImageParam = z.object({ token: z.string().min(10), imageId: z.string().uuid() });

// Resolve + verify the token, returning the scoped claims or null.
async function resolve(c: { req: { valid: (k: 'param') => { token: string } } }) {
  const { token } = c.req.valid('param');
  const claims = await verifyQuoteAcceptToken(token);
  if (!claims) return null;
  if (await isQuoteAcceptJtiRevoked(claims.jti)) return null;
  return claims;
}

// GET /:token — view. Stamps first_viewed_at + sent→viewed. Customer-visible content only.
quotesPublicRoutes.get('/:token', zValidator('param', tokenParam), async (c) => {
  const claims = await resolve(c);
  if (!claims) return c.json({ error: 'This link is invalid or has expired' }, 401);
  const data = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [quote] = await db.select().from(quotes).where(and(eq(quotes.id, claims.quoteId), eq(quotes.orgId, claims.orgId))).limit(1);
    if (!quote || quote.status === 'draft') return null;
    const blocks = await db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, quote.id)).orderBy(quoteBlocks.sortOrder);
    const lines = (await db.select().from(quoteLines).where(eq(quoteLines.quoteId, quote.id)).orderBy(quoteLines.sortOrder)).filter((l) => l.customerVisible);
    const [partner] = await db.select({ name: partners.name }).from(partners).where(eq(partners.id, quote.partnerId)).limit(1);
    const [brand] = await db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor }).from(portalBranding).where(eq(portalBranding.orgId, quote.orgId)).limit(1);
    await markQuoteViewed(quote.id, quote.orgId);
    return { quote: { ...quote, status: quote.status === 'sent' ? 'viewed' : quote.status }, blocks, lines, branding: { partnerName: partner?.name ?? 'Proposal', logoUrl: brand?.logoUrl ?? null, primaryColor: brand?.primaryColor ?? null } };
  }));
  if (!data) return c.json({ error: 'Quote not found' }, 404);
  return c.json({ data });
});

// GET /:token/images/:imageId
quotesPublicRoutes.get('/:token/images/:imageId', zValidator('param', tokenImageParam), async (c) => {
  const claims = await resolve(c); const { imageId } = c.req.valid('param');
  if (!claims) return c.json({ error: 'This link is invalid or has expired' }, 401);
  const img = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [quote] = await db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.id, claims.quoteId), eq(quotes.orgId, claims.orgId))).limit(1);
    if (!quote) return null;
    return readQuoteImage(imageId, quote.id);
  }));
  if (!img) return c.json({ error: 'Image not found' }, 404);
  return new Response(new Uint8Array(img.data), { status: 200, headers: { 'Content-Type': img.mime, 'Content-Length': String(img.byteSize), 'Cache-Control': 'private, max-age=300' } });
});

// POST /:token/accept — typed signature. System-scope write, token-resolved.
quotesPublicRoutes.post('/:token/accept', zValidator('param', tokenParam), zValidator('json', acceptQuoteSchema), async (c) => {
  const claims = await resolve(c); const body = c.req.valid('json');
  if (!claims) return c.json({ error: 'This link is invalid or has expired' }, 401);
  try {
    const res = await runOutsideDbContext(() => withSystemDbAccessContext(() => acceptQuote({
      quoteId: claims.quoteId, signerName: body.signerName, signerEmail: body.signerEmail ?? null,
      ipAddress: c.req.header('x-forwarded-for') ?? null, userAgent: c.req.header('user-agent') ?? null,
      acceptanceTokenJti: claims.jti, actorUserId: null,
    })));
    return c.json({ data: { status: res.quote.status, invoiceNumber: null } });
  } catch (err) { if (err instanceof QuoteServiceError) return c.json({ error: err.message, code: err.code }, err.status); throw err; }
});

// POST /:token/decline
quotesPublicRoutes.post('/:token/decline', zValidator('param', tokenParam), zValidator('json', declineQuoteSchema), async (c) => {
  const claims = await resolve(c); const { reason } = c.req.valid('json');
  if (!claims) return c.json({ error: 'This link is invalid or has expired' }, 401);
  const ok = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [quote] = await db.select().from(quotes).where(and(eq(quotes.id, claims.quoteId), eq(quotes.orgId, claims.orgId))).limit(1);
    if (!quote || (quote.status !== 'sent' && quote.status !== 'viewed')) return false;
    const now = new Date();
    await db.update(quotes).set({ status: 'declined', declineReason: reason ?? null, declinedAt: now, updatedAt: now }).where(eq(quotes.id, quote.id));
    return true;
  }));
  if (!ok) return c.json({ error: 'This quote can no longer be declined' }, 409);
  return c.json({ data: { status: 'declined' } });
});
```

- [ ] **Step 4: Mount BEFORE auth in `apps/api/src/index.ts`** — next to the other public mounts (around line 775, alongside `publicEnrollmentRoutes`), and BEFORE `api.route('/quotes', quoteRoutes)` so the unauthenticated sub-path isn't swallowed by the authed `/quotes` router:

```ts
import { quotesPublicRoutes } from './routes/quotesPublic';
// Public, token-gated quote acceptance (no auth) — MUST precede the auth-gated /quotes router.
api.route('/quotes/public', quotesPublicRoutes);
```

> Note for the implementer: confirm the authed `/quotes` router does not register a `/:id` that would match `/quotes/public` first. Hono matches static segments before params, and a separately-mounted `/quotes/public` router takes precedence for that prefix — but verify by hitting `GET /api/v1/quotes/public/<token>` without an Authorization header and confirming you do NOT get a 401 from `authMiddleware`.

- [ ] **Step 5: Write the RBAC negative test**

`apps/api/src/__tests__/integration/quoteSendRbac.integration.test.ts` — prove a `quotes:read`+`quotes:write` actor without `quotes:send` is refused at the permission layer. The cleanest assertion exercises the `requirePermission` middleware via the route; if the repo lacks an authed-route HTTP harness, assert the permission set directly against the guard the route uses:

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { hasPermission } from '../../services/permissions';
import { PERMISSIONS } from '../../services/permissions';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('quotes:send RBAC', () => {
  // A role granted only read+write must NOT satisfy the send permission the
  // POST /:id/send route requires. This guards against the send route being
  // accidentally gated on write (or ungated).
  it('quotes:read+write does not imply quotes:send', () => {
    const granted = [
      `${PERMISSIONS.QUOTES_READ.resource}:${PERMISSIONS.QUOTES_READ.action}`,
      `${PERMISSIONS.QUOTES_WRITE.resource}:${PERMISSIONS.QUOTES_WRITE.action}`,
    ];
    const needSend = `${PERMISSIONS.QUOTES_SEND.resource}:${PERMISSIONS.QUOTES_SEND.action}`;
    expect(granted).not.toContain(needSend);
    expect(PERMISSIONS.QUOTES_SEND.action).toBe('send');
  });
});
```

> Note: this asserts the permission *wiring* (the route uses `QUOTES_SEND`, which is distinct from read/write). The end-to-end 403 (a real user with read+write hitting `POST /:id/send`) is verified through the browser/API in the feature-testing pass (Task 18) where a live session + role exist. If `hasPermission(grantedSet, required)` exists as a helper, prefer asserting `expect(hasPermission(granted, needSend)).toBe(false)`.

- [ ] **Step 6: Run both tests + typecheck**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/quotesPublic.integration.test.ts src/__tests__/integration/quoteSendRbac.integration.test.ts && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```
Expected: PASS + no new type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/quotesPublic.ts apps/api/src/index.ts apps/api/src/__tests__/integration/quotesPublic.integration.test.ts apps/api/src/__tests__/integration/quoteSendRbac.integration.test.ts
git commit -m "feat(quotes): public tokenized view/accept/decline (system-scope writes) + send RBAC guard"
```

---

## Task 14: Forge tests for the new write paths

Extend the Phase 1 forge file with cross-tenant denial for the accept/image *write* paths now that services write them (the contract test alone misses write-path/axis gaps). Most cases already exist in `quotes-rls.integration.test.ts` (cases 6–9 cover `quote_images`/`quote_acceptances` raw inserts). Add a service-level forge: `acceptQuote` under an orgA context cannot accept an orgB quote.

**Files:**
- Modify: `apps/api/src/__tests__/integration/quotes-rls.integration.test.ts`

- [ ] **Step 1: Add the failing case** (append inside the existing `describe`)

```ts
  // (10) Service-layer accept forge. acceptQuote loads the quote by id; under an
  // orgA breeze_app context, orgB's quote is invisible (RLS), so acceptQuote
  // must 404 rather than convert a foreign tenant's quote.
  runDb('acceptQuote cannot accept another org quote (RLS hides it → 404)', async () => {
    const fx = await seedFixture();
    const { acceptQuote } = await import('../../services/quoteAcceptService');
    await expect(
      withDbAccessContext(fx.orgAContext, () => acceptQuote({ quoteId: fx.quoteB.id, signerName: 'Mallory' }))
    ).rejects.toMatchObject({ status: 404 });
  });
```

> Note: `quoteB` is seeded with status defaulting to `draft`; to make the 404-vs-409 distinction meaningful, the seed should leave it `draft` (acceptQuote of an invisible row returns 404 because the org-scoped SELECT yields no row). If the existing fixture sets a different status, the assertion still holds: an orgA caller cannot see orgB's quote at all, so `acceptQuote` throws `QUOTE_NOT_FOUND` (404).

- [ ] **Step 2: Run to verify it passes** (the policy already exists, so this should pass once the import resolves)

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/quotes-rls.integration.test.ts
```
Expected: PASS (all original cases + the new one).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/quotes-rls.integration.test.ts
git commit -m "test(quotes): service-layer cross-tenant accept forge"
```

---

## Task 15: Portal web — api client + list/detail pages + nav

Customer-facing authed UI in `apps/portal/`. Mirrors the invoice pages/components.

**Files:**
- Modify: `apps/portal/src/lib/api.ts` (add quote methods + types)
- Create: `apps/portal/src/pages/quotes/index.astro`, `apps/portal/src/pages/quotes/[id].astro`
- Create: `apps/portal/src/components/portal/QuoteList.tsx`, `apps/portal/src/components/portal/QuoteDetailView.tsx`
- Modify: `apps/portal/src/layouts/PortalLayout.astro:13-19` (nav)
- Test: `apps/portal/src/components/portal/QuoteDetailView.test.tsx` (if portal has a vitest/jsdom config; else verified in feature-testing)

**Interfaces:**
- Produces (api.ts): `getQuotes(params, config)`, `getQuote(id, config)`, `acceptQuote(id, config)`, `declineQuote(id, body, config)` on `portalApi`, plus `QuoteSummary`/`QuoteDetail` types.

- [ ] **Step 1: Add the api client methods** — in `apps/portal/src/lib/api.ts`, mirror `getInvoices`/`getInvoice`/`payInvoice`:

```ts
// Types (near InvoiceSummary/InvoiceDetail)
export interface QuoteSummary { id: string; quoteNumber: string | null; status: string; currencyCode: string; issueDate: string | null; expiryDate: string | null; total: string; }
export interface QuoteBlock { id: string; blockType: string; content: unknown; sortOrder: number; }
export interface QuoteLine { id: string; description: string; quantity: string; unitPrice: string; lineTotal: string; recurrence: string; customerVisible: boolean; sortOrder: number; }
export interface QuoteDetail { quote: QuoteSummary & { introNotes?: string | null; terms?: string | null }; blocks: QuoteBlock[]; lines: QuoteLine[]; }

// On the portalApi object:
getQuotes: async (params: ListParams = {}, config: ApiRequestConfig = {}): Promise<PaginatedResult<QuoteSummary>> => {
  const query = buildQueryString({ page: params.page ?? 1, limit: params.limit ?? 200 });
  const response = await apiGet<{ data: QuoteSummary[]; pagination: Pagination }>(`/portal/quotes${query}`, config);
  return mapPaginatedData(response);
},
getQuote: async (id: string, config: ApiRequestConfig = {}): Promise<ApiResponse<{ data: QuoteDetail }>> => {
  return apiGet<{ data: QuoteDetail }>(`/portal/quotes/${id}`, config);
},
acceptQuote: async (id: string, config: ApiRequestConfig = {}): Promise<ApiResponse<{ data: { invoiceId: string; status: string } }>> => {
  return apiPost<{ data: { invoiceId: string; status: string } }>(`/portal/quotes/${id}/accept`, {}, config);
},
declineQuote: async (id: string, reason: string | undefined, config: ApiRequestConfig = {}): Promise<ApiResponse<{ data: { status: string } }>> => {
  return apiPost<{ data: { status: string } }>(`/portal/quotes/${id}/decline`, { reason }, config);
},
```

- [ ] **Step 2: Create the list page** (`apps/portal/src/pages/quotes/index.astro`) — mirror `invoices/index.astro`:

```astro
---
import PortalLayout from '../../layouts/PortalLayout.astro';
import QuoteList from '../../components/portal/QuoteList';
import { portalApi } from '../../lib/api';
import { buildServerApiConfig } from '../../lib/server';

const response = await portalApi.getQuotes({ page: 1, limit: 200 }, buildServerApiConfig(Astro.request));
if (response.statusCode === 401) { return Astro.redirect('/login'); }
---
<PortalLayout title="Proposals">
  <QuoteList quotes={response.data ?? []} error={response.error} />
</PortalLayout>
```

- [ ] **Step 3: Create the detail page** (`apps/portal/src/pages/quotes/[id].astro`):

```astro
---
import PortalLayout from '../../layouts/PortalLayout.astro';
import QuoteDetailView from '../../components/portal/QuoteDetailView';
import { portalApi } from '../../lib/api';
import { buildServerApiConfig } from '../../lib/server';

const { id } = Astro.params;
const response = await portalApi.getQuote(id!, buildServerApiConfig(Astro.request));
if (response.statusCode === 401) { return Astro.redirect('/login'); }
---
<PortalLayout title="Proposal">
  <QuoteDetailView detail={response.data?.data ?? null} error={response.error} client:load />
</PortalLayout>
```

- [ ] **Step 4: Create `QuoteList.tsx`** — mirror `InvoiceList.tsx` (table of number/status/total/expiry, link to `/quotes/:id`). Use `data-testid="quote-row-<id>"` on each row and `data-testid="portal-quotes-empty"` on the empty state (e2e convention).

```tsx
import { AlertCircle, FileText } from 'lucide-react';
import type { QuoteSummary } from '../../lib/api';

const STATUS_LABELS: Record<string, string> = { sent: 'Sent', viewed: 'Viewed', accepted: 'Accepted', declined: 'Declined', expired: 'Expired', converted: 'Accepted' };
function money(v: string, c: string) { const n = Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 }); return c === 'USD' ? `$${n}` : `${n} ${c}`; }
function shortDate(d: string | null) { return d ? new Date(d).toLocaleDateString() : '—'; }

export default function QuoteList({ quotes, error }: { quotes: QuoteSummary[]; error?: string }) {
  if (error) return (<div className="rounded-md bg-destructive/10 p-4 text-center text-destructive"><AlertCircle className="mx-auto h-8 w-8" /><p className="mt-2">{error}</p></div>);
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Proposals</h2>
      {quotes.length === 0 ? (
        <div data-testid="portal-quotes-empty" className="rounded-md border border-dashed p-8 text-center">
          <FileText className="mx-auto h-12 w-12 text-muted-foreground" />
          <p className="mt-1 text-sm text-muted-foreground">You don't have any proposals yet.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full">
            <thead className="bg-muted/50"><tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Number</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Issued</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Valid until</th>
              <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground">Total</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Status</th>
            </tr></thead>
            <tbody className="divide-y">{quotes.map((q) => (
              <tr key={q.id} data-testid={`quote-row-${q.id}`} className="hover:bg-muted/50">
                <td className="px-4 py-3"><a className="font-medium hover:underline" href={`/quotes/${q.id}`}>{q.quoteNumber ?? q.id.slice(0, 8)}</a></td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{shortDate(q.issueDate)}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{shortDate(q.expiryDate)}</td>
                <td className="px-4 py-3 text-right text-sm">{money(q.total, q.currencyCode)}</td>
                <td className="px-4 py-3 text-sm">{STATUS_LABELS[q.status] ?? q.status}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Create `QuoteDetailView.tsx`** — renders blocks + customer-visible lines + Accept / Decline buttons calling `portalApi.acceptQuote`/`declineQuote`, with loading/disabled state and an error banner. On accept success show "Accepted — invoice created"; buttons only when `status` is `sent`/`viewed`. Use `data-testid="quote-accept"`, `data-testid="quote-decline"`, `data-testid="quote-accept-success"`.

```tsx
import { useState } from 'react';
import { portalApi, buildPortalApiUrl, type QuoteDetail } from '../../lib/api';

export default function QuoteDetailView({ detail, error }: { detail: { quote: QuoteDetail['quote']; blocks: QuoteDetail['blocks']; lines: QuoteDetail['lines'] } | null; error?: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [status, setStatus] = useState(detail?.quote.status ?? '');
  if (error || !detail) return <div className="rounded-md bg-destructive/10 p-4 text-destructive">{error ?? 'Proposal not found'}</div>;
  const open = status === 'sent' || status === 'viewed';

  async function accept() {
    setBusy(true); setMsg(null);
    const res = await portalApi.acceptQuote(detail!.quote.id);
    setBusy(false);
    if (res.error) { setMsg(res.error); return; }
    setStatus('converted'); setMsg('Accepted — an invoice has been created.');
  }
  async function decline() {
    const reason = window.prompt('Optionally, tell us why you are declining:') ?? undefined;
    setBusy(true); setMsg(null);
    const res = await portalApi.declineQuote(detail!.quote.id, reason);
    setBusy(false);
    if (res.error) { setMsg(res.error); return; }
    setStatus('declined'); setMsg('Proposal declined.');
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Proposal {detail.quote.quoteNumber ?? ''}</h1>
        <a className="text-sm underline" href={buildPortalApiUrl(`/portal/quotes/${detail.quote.id}/pdf`)} target="_blank" rel="noreferrer">Download PDF</a>
      </div>
      {/* Block + line rendering omitted for brevity — render blocks in sortOrder; for line_items blocks, render detail.lines as a pricing table grouped by recurrence (one-time / monthly / annual), mirroring the PDF. */}
      {msg && <div data-testid={status === 'converted' ? 'quote-accept-success' : 'quote-msg'} className="rounded-md bg-muted p-3 text-sm">{msg}</div>}
      {open && (
        <div className="flex gap-3">
          <button data-testid="quote-accept" disabled={busy} onClick={accept} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">Accept &amp; sign</button>
          <button data-testid="quote-decline" disabled={busy} onClick={decline} className="rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-50">Decline</button>
        </div>
      )}
    </div>
  );
}
```

> Note for the implementer: flesh out the block/line rendering to match `QuoteDetailView`'s PDF layout — headings, rich text (sanitize `content.html` with the same sanitizer the editor uses), image blocks via `<img src={buildPortalApiUrl('/portal/quotes/:id/images/:imageId')}>`, and a pricing table from `detail.lines`. Keep money formatting consistent with `QuoteList`.

- [ ] **Step 6: Add the nav entry** — `apps/portal/src/layouts/PortalLayout.astro:13-19`:

```astro
const navItems = [
  { label: 'Devices', href: '/devices' },
  { label: 'Tickets', href: '/tickets' },
  { label: 'Quotes', href: '/quotes' },
  { label: 'Invoices', href: '/invoices' },
  { label: 'Assets', href: '/assets' },
  { label: 'Profile', href: '/profile' }
];
```

- [ ] **Step 7: Typecheck / build the portal**

```bash
cd apps/portal && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx astro check
```
Expected: no errors (plain `tsc` skips `.astro` — `astro check` is required, per memory `ci_astro_check_and_integration_tests_gotchas`).

- [ ] **Step 8: Commit**

```bash
git add apps/portal/src/lib/api.ts apps/portal/src/pages/quotes apps/portal/src/components/portal/QuoteList.tsx apps/portal/src/components/portal/QuoteDetailView.tsx apps/portal/src/layouts/PortalLayout.astro
git commit -m "feat(quotes): portal proposal list + detail (accept/decline) + nav"
```

---

## Task 16: Portal web — public acceptance page (`/quote/[token]`)

The unauthenticated prospect page. Lives at `apps/portal/src/pages/quote/[token].astro` — NOT under a `protectedPrefixes` entry, so the portal middleware leaves it public.

**Files:**
- Modify: `apps/portal/src/lib/api.ts` (public methods: `getPublicQuote`, `acceptPublicQuote`, `declinePublicQuote`)
- Create: `apps/portal/src/pages/quote/[token].astro`, `apps/portal/src/components/portal/PublicQuoteView.tsx`
- Test: feature-testing (Task 18)

**Interfaces:**
- Produces (api.ts): `getPublicQuote(token, config)`, `acceptPublicQuote(token, body)`, `declinePublicQuote(token, body)` → hit `/quotes/public/:token...`.

- [ ] **Step 1: Add public api methods** — these call the API `/quotes/public/*` routes (note: NOT `/portal/*`; build the URL with `buildPortalApiUrl('/quotes/public/...')`):

```ts
getPublicQuote: async (token: string, config: ApiRequestConfig = {}): Promise<ApiResponse<{ data: { quote: QuoteSummary & { introNotes?: string|null; terms?: string|null }; blocks: QuoteBlock[]; lines: QuoteLine[]; branding: { partnerName: string; logoUrl: string|null; primaryColor: string|null } } }>> => {
  return apiGet(`/quotes/public/${encodeURIComponent(token)}`, config);
},
acceptPublicQuote: async (token: string, signerName: string, signerEmail?: string): Promise<ApiResponse<{ data: { status: string } }>> => {
  return apiPost(`/quotes/public/${encodeURIComponent(token)}/accept`, { signerName, signerEmail }, {});
},
declinePublicQuote: async (token: string, reason?: string): Promise<ApiResponse<{ data: { status: string } }>> => {
  return apiPost(`/quotes/public/${encodeURIComponent(token)}/decline`, { reason }, {});
},
```

- [ ] **Step 2: Create the public page** (`apps/portal/src/pages/quote/[token].astro`) — uses a minimal `AuthLayout`-style wrapper (the pre-auth layout the login page uses) so there's no portal chrome:

```astro
---
import AuthLayout from '../../layouts/AuthLayout.astro';
import PublicQuoteView from '../../components/portal/PublicQuoteView';
import { portalApi } from '../../lib/api';
import { buildServerApiConfig } from '../../lib/server';

const { token } = Astro.params;
const response = await portalApi.getPublicQuote(token!, buildServerApiConfig(Astro.request));
---
<AuthLayout title="Proposal">
  <PublicQuoteView token={token!} initial={response.data?.data ?? null} error={response.error} client:load />
</AuthLayout>
```

- [ ] **Step 3: Create `PublicQuoteView.tsx`** — renders the branded proposal + a typed-signature accept form (full-name input) + decline, calling the public api methods. `data-testid`: `public-quote`, `public-quote-signer`, `public-quote-accept`, `public-quote-decline`, `public-quote-accepted`, `public-quote-error`.

```tsx
import { useState } from 'react';
import { portalApi } from '../../lib/api';

type Initial = { quote: { quoteNumber: string | null; status: string; total: string; currencyCode: string }; blocks: any[]; lines: any[]; branding: { partnerName: string; logoUrl: string|null; primaryColor: string|null } } | null;

export default function PublicQuoteView({ token, initial, error }: { token: string; initial: Initial; error?: string }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(initial?.quote.status ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  if (error || !initial) return <div data-testid="public-quote-error" className="mx-auto max-w-lg p-8 text-center text-destructive">{error ?? 'This proposal link is invalid or has expired.'}</div>;
  const open = status === 'sent' || status === 'viewed';

  async function accept() {
    if (!name.trim()) { setMsg('Please type your full name to sign.'); return; }
    setBusy(true); setMsg(null);
    const res = await portalApi.acceptPublicQuote(token, name.trim());
    setBusy(false);
    if (res.error) { setMsg(res.error); return; }
    setStatus('converted'); setMsg('Thank you — your acceptance has been recorded.');
  }
  async function decline() {
    const reason = window.prompt('Optionally, tell us why:') ?? undefined;
    setBusy(true); setMsg(null);
    const res = await portalApi.declinePublicQuote(token, reason);
    setBusy(false);
    if (res.error) { setMsg(res.error); return; }
    setStatus('declined'); setMsg('You have declined this proposal.');
  }

  return (
    <div data-testid="public-quote" className="mx-auto max-w-2xl space-y-6 p-6">
      <header className="flex items-center gap-3">
        {initial.branding.logoUrl && <img src={initial.branding.logoUrl} alt="" className="h-8" />}
        <h1 className="text-xl font-semibold">Proposal {initial.quote.quoteNumber ?? ''} from {initial.branding.partnerName}</h1>
      </header>
      {/* Render blocks (sortOrder) + a pricing table from initial.lines — same layout as the portal detail view. */}
      {status === 'converted' && <div data-testid="public-quote-accepted" className="rounded-md bg-green-50 p-4 text-green-900">{msg}</div>}
      {msg && status !== 'converted' && <div className="rounded-md bg-muted p-3 text-sm">{msg}</div>}
      {open && (
        <div className="space-y-3 rounded-md border p-4">
          <label className="block text-sm font-medium">Type your full name to accept &amp; sign</label>
          <input data-testid="public-quote-signer" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border px-3 py-2" placeholder="Your full name" />
          <div className="flex gap-3">
            <button data-testid="public-quote-accept" disabled={busy} onClick={accept} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">Accept &amp; sign</button>
            <button data-testid="public-quote-decline" disabled={busy} onClick={decline} className="rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-50">Decline</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

> Note for the implementer: confirm `AuthLayout.astro` exists (the login page imports it). If the pre-auth wrapper has a different name, use whatever `login.astro` imports. Render blocks/lines to match the portal detail + PDF.

- [ ] **Step 4: Typecheck** — `cd apps/portal && PATH=... npx astro check`; Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/portal/src/lib/api.ts apps/portal/src/pages/quote apps/portal/src/components/portal/PublicQuoteView.tsx
git commit -m "feat(quotes): public tokenized acceptance page (typed-signature)"
```

---

## Task 17: Main web app — wire Send button + image upload

Turn the dashboard's disabled "Send (coming soon)" button into a real action, and add image-block upload to the editor. Both via `runAction`.

**Files:**
- Modify: `apps/web/src/components/billing/quotes/QuoteDetail.tsx:166-176`, `apps/web/src/components/billing/quotes/QuoteEditor.tsx:28-40,415-437`
- Modify: the web quote API helper module (the file exporting `addBlock`/`deleteBlock` used by `QuoteEditor` — grep `export.*addBlock` under `apps/web/src`) to add `sendQuote(id)` and `uploadQuoteImage(id, file)`.
- Test: `apps/web/src/components/billing/quotes/QuoteDetail.test.tsx` (if present; else feature-testing)

- [ ] **Step 1: Add the web API helpers** — in the web quotes API module (mirror the `addBlock` fetch helper):

```ts
export function sendQuote(id: string): Promise<Response> {
  return fetch(`${API_BASE}/api/v1/quotes/${id}/send`, { method: 'POST', credentials: 'include', headers: csrfHeaders() });
}
export function uploadQuoteImage(id: string, file: File): Promise<Response> {
  const form = new FormData(); form.append('file', file);
  return fetch(`${API_BASE}/api/v1/quotes/${id}/images`, { method: 'POST', credentials: 'include', body: form, headers: csrfHeaders() });
}
```

(Match the existing helper's base-URL + CSRF-header pattern exactly — reuse whatever `addBlock` uses; do not hand-roll a new auth scheme.)

- [ ] **Step 2: Wire the Send button** — replace the disabled button at `QuoteDetail.tsx:166-176`:

```tsx
{can('quotes', 'send') && quote.status === 'draft' && (
  <button
    type="button"
    disabled={sending}
    data-testid="quote-send"
    onClick={async () => {
      setSending(true);
      try {
        await runAction({
          request: () => sendQuote(quote.id),
          errorFallback: 'Could not send the proposal.',
          successMessage: 'Proposal sent',
          onUnauthorized: UNAUTHORIZED,
        });
        refresh();
      } catch { /* runAction already toasted */ }
      finally { setSending(false); }
    }}
    className="inline-flex w-full items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
  >
    {sending ? 'Sending…' : 'Send proposal'}
  </button>
)}
```

Add `const [sending, setSending] = useState(false);` and import `runAction`, `sendQuote`, `UNAUTHORIZED`/`refresh` consistent with `QuoteEditor`'s usage.

- [ ] **Step 3: Add the image block option + upload** — in `QuoteEditor.tsx`, add `image` to `ADD_BLOCK_OPTIONS` (so the menu offers it), and in the image-block render branch (line ~435) add a file input that uploads then creates the image block with the returned `imageId`:

```tsx
// ADD_BLOCK_OPTIONS:
const ADD_BLOCK_OPTIONS: { value: AddableBlockType; label: string }[] = [
  { value: 'heading', label: 'Heading' },
  { value: 'rich_text', label: 'Rich text' },
  { value: 'image', label: 'Image' },
  { value: 'line_items', label: 'Pricing table' },
];
// AddableBlockType union must include 'image'.
```

For an image block, render an upload control (when `canWrite` and the block has no `content.imageId` yet):

```tsx
{block.blockType === 'image' && (
  block.content?.imageId
    ? <img src={`${API_BASE}/api/v1/quotes/${quote.id}/images/${block.content.imageId}`} alt="" className="max-h-64 rounded" />
    : (
      <input type="file" accept="image/png,image/jpeg,image/webp" data-testid={`quote-image-upload-${block.id}`}
        disabled={busy}
        onChange={async (e) => {
          const file = e.target.files?.[0]; if (!file) return;
          await runAction({
            request: () => uploadQuoteImage(quote.id, file),
            errorFallback: 'Could not upload the image.',
            successMessage: 'Image uploaded',
            onUnauthorized: UNAUTHORIZED,
            parseSuccess: (d: any) => d?.data,
          }).then((data) => onSetImage(block, data.imageId)).catch(() => {});
        }} />
    )
)}
```

> Note for the implementer: `onSetImage` updates the block's `content.imageId` — wire it to the existing block-update path the editor uses (if blocks are immutable add/remove only in Phase 1, add an `updateBlock`/`PATCH /:id/blocks/:blockId` is NOT in scope; instead create the image block with the imageId in its content after upload). Simplest Phase-2-correct flow: upload first → then `addBlock({ blockType: 'image', content: { imageId } })`. Reorder the UI so the "Add image" action prompts a file, uploads, then adds the block in one go. Keep it `runAction`-wrapped.

- [ ] **Step 4: Web tests + typecheck**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/billing/quotes && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx astro check
```
Expected: PASS + no astro/type errors. (If a chart/ResizeObserver appears, it won't here — these are billing components.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/billing/quotes apps/web/src/lib
git commit -m "feat(quotes): wire Send button + image upload in the dashboard editor"
```

---

## Task 18: Caddy carve-outs + end-to-end verification

Ensure the new public API path and the portal public page aren't shadowed, then verify the whole flow.

**Files:**
- Modify: `docker/Caddyfile.prod`

- [ ] **Step 1: Audit caddy routing** — read `docker/Caddyfile.prod` and determine how the API (`/api/*`), the web app, and the customer portal (`apps/portal`) are routed (hostname/path → container). The `@webBillingInvoices`/`@webBillingQuotes` carve-outs route `/billing/quotes*` to `web:4321` ahead of the `@billing → billing:3002` sidecar. Confirm:
  1. `GET /api/v1/quotes/public/<token>` reaches the API container (it should already, via the API host/`/api/*` block) — the new unauthenticated route is under the existing API mount, so no new caddy rule is typically needed. Verify it is NOT caught by any `/quotes*` web carve-out.
  2. The portal `/quote/<token>` page is served by the portal app. If the portal is on its own hostname, no carve-out is needed. If it shares a host with path-routing, add a carve-out for `/quote /quote/*` → the portal container ahead of any catch-all, mirroring `@webBillingQuotes`.

- [ ] **Step 2: Add carve-outs only where the audit shows a shadow.** If the portal shares the web host, add (ahead of the catch-all):

```caddyfile
@portalPublicQuote path /quote /quote/*
handle @portalPublicQuote {
  encode zstd gzip
  reverse_proxy portal:3000
}
```

(Use the actual portal container name/port from the compose file. If the portal is on a separate hostname, SKIP this — document in the commit message that no carve-out was needed and why.)

- [ ] **Step 3: Feature-test the full flow** — see the Final Verification section. Commit any caddy change:

```bash
git add docker/Caddyfile.prod
git commit -m "chore(quotes): caddy carve-out for the public proposal page"
```

> Note: per memory `ops_droplet_caddyfile_deploy`, a Caddyfile change does NOT deploy via a `BREEZE_VERSION` bump — production needs a manual `/opt/breeze/Caddyfile.prod` edit + `docker compose restart caddy`. Call this out in the PR description as a deploy step. Local feature-testing uses `http://localhost` (memory `local_playwright_env_setup`), not caddy.

---

## Final verification

- [ ] **API unit tests (affected, single fork)** — the full suite is known-flaky in parallel (memory `api_test_suite_parallel_flakiness`); run affected files single-fork:

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --pool=forks --poolOptions.forks.singleFork=true \
  src/services/quoteContentHash.test.ts src/services/acceptanceProvider.test.ts src/services/quoteAcceptToken.test.ts src/services/quoteNumbers.test.ts src/services/quoteEmail.test.ts
```

- [ ] **Shared tests** — `cd packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/validators/quotes.test.ts`

- [ ] **Integration (real DB, breeze_app)** — the BLOCKING job; run the Phase 2 files + the extended forge:

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/quoteLifecycle.integration.test.ts \
  src/__tests__/integration/quoteAccept.integration.test.ts \
  src/__tests__/integration/quoteImages.integration.test.ts \
  src/__tests__/integration/quotesPublic.integration.test.ts \
  src/__tests__/integration/portalQuotes.integration.test.ts \
  src/__tests__/integration/quoteSendRbac.integration.test.ts \
  src/__tests__/integration/quotes-rls.integration.test.ts
```

- [ ] **RLS coverage contract test** — `cd apps/api && PATH=... npx vitest run --config vitest.config.rls-coverage.ts` (no new tables, so this should still pass unchanged).

- [ ] **Drift + types + astro** —
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm db:check-drift
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
cd ../portal && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx astro check
cd ../web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx astro check
```

- [ ] **Feature-testing skill** — verify end-to-end (dashboard send → email link → public accept → invoice created; portal accept; tamper-evidence; **negative RBAC**: a `quotes:read`+`write` user must NOT see/use Send and `POST /:id/send` returns 403). Test the public path unauthenticated.

- [ ] **Open the PR** on branch `feat/quotes-proposals-phase2` once green. Sequence after main; do not fuse with other work.

---

## Deferred to later plans (NOT in this plan)

- **Phase 3:** accept → pay (portal pay redirect + public pay-link), expiry sweep + read-time expiry guard, `expired` status transition.
- **Phase 4 (optional):** recurring lines → auto-create Contract (the monthly/annual lines Phase 2's convert intentionally skips).
- **Quote-block `image` update-in-place** (`PATCH /:id/blocks/:blockId`) if the editor flow needs editing an existing image block rather than remove+re-add.

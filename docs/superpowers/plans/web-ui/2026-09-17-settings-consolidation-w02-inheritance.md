---
tracking_issue: LanternOps/breeze#6223
---
# Settings Consolidation W02: One Way to Inherit — Implementation Plan

> Wave mapping: W01 = #6224, W02-API = #6225, W02-WEB = #6226 (this plan spans both).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make billing/ticketing inheritance behave the same way everywhere — one shared `InheritedField` control that always shows the inherited value (not just the word "inherit"), one tax-rate resolver and one invoice-footer resolver each used by every reader, and one save pattern per screen type — without changing what any existing document, invoice, or quote renders today (Wave 1 of the audit is **behaviour-preserving**; no migration, no new settings).

**Architecture:** Two independent halves, because #4628 (billing profiles, tracked separately) rewrites `OrgTicketSettingsEditor.tsx` and `OrgBillingSettings.tsx` in its own cut-over wave:
- **W02-API** (M11 + M12 + M14): pure backend — a shared `resolveOrgTaxRate` async resolver used by quote creation (and available for invoice drafts in a later wave), a shared invoice-footer resolver used by issue and render, and two `partners.settings` jsonb sub-objects (`ticketing.inbound`, `timeTracking.sessionSuggestions`) promoted from a route-local zod object into `packages/shared/src/validators/` with tolerant reads. No dependency on #4628. Ships any time.
- **W02-WEB** (M10 + M13): a shared `InheritedField` component adopted by org tax rate and org SLA overrides, an SLA-direction note on both the partner Categories screen and the org Ticketing tab, and a save-pattern cleanup of `InboundEmailCard.tsx`. This half is written against the **post-#4628-W02** shape of `OrgTicketSettingsEditor.tsx` (SLA section only — the labour-rate section is gone) and must not be started until #4628 W02 has merged. Its first task is a precondition check that stops the executor if the merge hasn't landed.

Neither half is on the critical path for #4628 or block-hours (#4547, p1) — they can be scheduled independently of that feature's timeline; W02-WEB simply cannot *start* until #4628 W02's file shape exists.

**Tech Stack:** Hono + Drizzle (API), Astro + React 19 islands + react-i18next (web), Vitest (both), the RLS/tenancy contract in `CLAUDE.md` (`withDbAccessContext`, `readWithPartnerAxisVisibility`), `runAction` for all web mutations.

**Spec:** `docs/superpowers/specs/web-ui/2026-09-17-billing-ticketing-settings-audit.md` §2.D findings 20–26, §3 rules 3–7, §5 Wave 1 (M10–M14), §8 decisions.

## Global Constraints

- **Behaviour-preserving.** Every already-issued invoice, already-created quote, and already-stored settings row must render/resolve identically after this plan lands. Where a task changes behaviour for *future* rows only (M11's footer resolver — see Task 6), the plan says so explicitly; nothing here changes what an *existing* row produces.
- **One resolver per concept** (rule 5): M11 and M12 each produce exactly one exported, DB-touching resolver function used by every reader in scope. No second implementation of the same precedence chain.
- **RLS/tenancy discipline (CLAUDE.md):** the `organizations` row is always read in the ambient request context (RLS-enforced); the `partners` row (partner-axis table) is read via `readWithPartnerAxisVisibility` (`apps/api/src/db/partnerAxisRead.ts`), never a hand-rolled `runOutsideDbContext(() => withSystemDbAccessContext(...))`. `assertOrg` (or equivalent membership check) must run before any tax read in every caller.
- **Eight-locale parity with real translations** for every new UI string: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/`. `localeParity`/`translationCoverage`/`keyUsage` tests (`apps/web/src/lib/i18n/*.test.ts`) must stay green.
- **All web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`).
- Test commands: `cd apps/api && npx vitest run <explicit file paths>` / `cd apps/web && npx vitest run <explicit paths>` — never `pnpm --filter … test -- --run`, never a trailing-slash directory filter (see CLAUDE.md's two scoped-test traps).
- Integration tests need real Postgres: `pnpm test-stack up` first, then `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`; `pnpm test-stack down` when finished.
- Never catch-and-swallow a 23505/23503 inside `withDbAccessContext` — that aborts the request transaction; this plan introduces no new insert/update paths that need this warning, but reviewers should still check.

---

## File structure

| Path | Responsibility | Half |
|---|---|---|
| `apps/api/src/services/taxRateResolver.ts` (+ `.test.ts`) | New. `resolveOrgTaxRate({ orgId, partnerId })`: org read in ambient context, `partners.defaultTaxRate` read via `readWithPartnerAxisVisibility`, calls `resolveEffectiveTaxRate` | API |
| `apps/api/src/services/quoteService.ts` | `resolveQuoteTaxRate` becomes a thin wrapper over `resolveOrgTaxRate` | API |
| `apps/api/src/services/quoteService.test.ts` | Mocks updated: `resolveOrgTaxRate` mocked directly instead of raw `db.select` sequences | API |
| `apps/api/src/__tests__/integration/quoteTaxRatePartnerAxis.integration.test.ts` | New. Real-Postgres proof: org-scoped token gets partner default; cross-tenant orgId rejected (with a system-scope control proving the row exists); cross-partner orgId rejected | API |
| `apps/api/src/services/invoicePdf.ts` | New exported `resolveInvoiceFooter({ invoiceTerms, partnerFooter, brandingFooter })`; `loadInvoiceForRender` and (new) the issue path both call it | API |
| `apps/api/src/services/invoicePdf.test.ts` | Table-driven pin tests for the four footer combinations | API |
| `apps/api/src/services/invoiceService.ts` | Issue path (`issueInvoice`, ~line 1301–1345) loads `portalBranding.footerText` and calls `resolveInvoiceFooter` instead of `partner?.invoiceFooter ?? null` | API |
| `apps/api/src/services/invoiceService.test.ts` | New cases pinning `terms` at issue for all four combinations | API |
| `packages/shared/src/validators/partnerTicketingSettings.ts` (+ `.test.ts`) | New. `ticketingInboundSettingsSchema`, `timeTrackingSessionSuggestionsSchema` extracted from `apps/api/src/routes/orgs.ts`'s route-local `partnerSettingsSchema` | API |
| `apps/api/src/routes/orgs.ts` | `partnerSettingsSchema`'s `ticketing.inbound` / `timeTracking.sessionSuggestions` sub-schemas replaced by imports from the new shared module; `GET /organizations/:id` gains a `partnerDefaultTaxRate` field | API |
| `apps/api/src/routes/orgs.test.ts` | Existing `GET /orgs/organizations/:id` tests updated for the second `db.select` call; new test asserting `partnerDefaultTaxRate` | API |
| `apps/api/src/services/partnerDefaultSettings.ts` | Inbound-config read uses `ticketingInboundSettingsSchema.safeParse` (tolerant — never throws on legacy data) | API |
| `apps/api/src/services/ticketConfigService.ts` | Same tolerant-parse treatment for the inbound sub-object it reads | API |
| `apps/api/src/services/timeSuggestionSettings.ts` | Same tolerant-parse treatment for `timeTracking.sessionSuggestions` | API |
| `apps/web/src/components/shared/InheritedField.tsx` (+ `.test.tsx`) | New. Blank-means-inherit input that always shows the inherited value and its source | WEB |
| `apps/web/src/components/billing/OrgBillingSettings.tsx` | Tax-rate field adopts `InheritedField`; reads the new `partnerDefaultTaxRate` field | WEB |
| `apps/web/src/components/billing/OrgBillingSettings.test.tsx` | Updated/added cases for the inherited-value display | WEB |
| `apps/web/src/components/settings/OrgTicketSettingsEditor.tsx` | SLA rows adopt `InheritedField`; SLA-direction note added | WEB |
| `apps/web/src/components/settings/OrgTicketSettingsEditor.test.tsx` | Updated for `InheritedField` markup; new direction-note assertion | WEB |
| `apps/web/src/components/settings/TicketCategoriesPage.tsx` | SLA-direction note added next to the category SLA fields | WEB |
| `apps/web/src/components/settings/TicketCategoriesPage.test.tsx` | New direction-note assertion | WEB |
| `apps/web/src/components/settings/InboundEmailCard.tsx` | Split into an autosaving toggle section and a page-Save autoresponder form, in visually separate cards | WEB |
| `apps/web/src/components/settings/InboundEmailCard.test.tsx` | Updated for the split structure | WEB |
| `apps/web/src/locales/*/settings.json`, `apps/web/src/locales/*/billing.json` | New keys: `inheritedField.*`, `orgTicketSettingsEditor.slaDirection`, `ticketCategoriesPage.slaDirection`, `orgBillingSettings.tax.partnerDefaultValue` | WEB |

---

# Part A — W02-API (M11, M12, M14)

No dependency on #4628. Can be its own PR, reviewed and merged independently.

### Task 1: `resolveOrgTaxRate` — the shared tax resolver (M12, full rigor)

**Files:**
- Create: `apps/api/src/services/taxRateResolver.ts`
- Test: `apps/api/src/services/taxRateResolver.test.ts`

**Interfaces:**
- Consumes: `db`, `getCurrentDbAccessContext`/`runOutsideDbContext`/`withSystemDbAccessContext` indirectly via `readWithPartnerAxisVisibility` (`apps/api/src/db/partnerAxisRead.ts`); `organizations`, `partners` (`apps/api/src/db/schema/orgs.ts`); `resolveEffectiveTaxRate` (`apps/api/src/services/invoiceMath.ts`).
- Produces: `export async function resolveOrgTaxRate(input: { orgId: string; partnerId: string }): Promise<string | null>` — returns `null` when there is no tax (mirrors the old `resolveQuoteTaxRate`'s "null, not an all-zero fraction" contract so a no-tax quote stays visually clean). `export class OrgNotVisibleForTaxError extends Error` — thrown, never swallowed, when the org row is not visible in the caller's ambient context.

This module is placed beside `invoiceMath.ts` rather than inside it: `invoiceMath.ts`'s own header describes it as pure math with no DB or IO ("Cents helpers…", no imports beyond `@breeze/shared`), and every function in it is synchronous. `resolveOrgTaxRate` is async and touches the database (two selects), so it does not belong there — a new small service module keeps the pure/impure boundary the file already established.

**Fail-closed contract (code review finding, addressed here):** the OLD implementation read the org row under `withSystemDbAccessContext`, which bypasses RLS — so the row always existed for any real orgId, and a missing row could only mean "not a real UUID." Under the new implementation the org read runs in the caller's AMBIENT context, so a missing row is now a REALISTIC state: wrong tenant, or an org RLS hides because it's suspended/archived/cross-partner. `org?.taxExempt ?? false` on a missing row would silently apply the PARTNER's rate to what might be a tax-exempt customer the caller simply couldn't see — a real tax-computation bug, not a cosmetic one. So the org row's VISIBILITY is checked first, before any partner read: if the org row does not come back, `resolveOrgTaxRate` throws `OrgNotVisibleForTaxError` and never reads the partner rate at all.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/taxRateResolver.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const queue: unknown[][] = [];
function queueResult(rows: unknown[]) { queue.push(rows); }

// Tracks whether each db.select() call happened INSIDE the mocked
// readWithPartnerAxisVisibility wrapper, so the "org read is not wrapped,
// partner read is" claim is actually verified per-call, not just counted.
let insideWrapper = false;
const wrapperFlagPerCall: boolean[] = [];

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      wrapperFlagPerCall.push(insideWrapper);
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve(queue.shift() ?? []) }) }) };
    }),
  },
}));
vi.mock('../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: vi.fn(async (fn: () => unknown) => {
    insideWrapper = true;
    try { return await fn(); } finally { insideWrapper = false; }
  }),
}));

import { resolveOrgTaxRate, OrgNotVisibleForTaxError } from './taxRateResolver';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';

const ORG_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const PARTNER_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

beforeEach(() => { queue.length = 0; wrapperFlagPerCall.length = 0; insideWrapper = false; vi.clearAllMocks(); });

describe('resolveOrgTaxRate', () => {
  it('returns the org rate when the org has one, ignoring the partner default', async () => {
    queueResult([{ taxExempt: false, taxRate: '0.08000' }]); // org
    queueResult([{ defaultTaxRate: '0.05000' }]); // partner
    const rate = await resolveOrgTaxRate({ orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(rate).toBe('0.08000');
  });

  it('falls back to the partner default when the org has no rate', async () => {
    queueResult([{ taxExempt: false, taxRate: null }]);
    queueResult([{ defaultTaxRate: '0.06000' }]);
    const rate = await resolveOrgTaxRate({ orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(rate).toBe('0.06000');
  });

  it('returns null (not "0.00000") when neither level has a rate', async () => {
    queueResult([{ taxExempt: false, taxRate: null }]);
    queueResult([{ defaultTaxRate: null }]);
    const rate = await resolveOrgTaxRate({ orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(rate).toBeNull();
  });

  it('a tax-exempt org returns null regardless of any configured rate', async () => {
    queueResult([{ taxExempt: true, taxRate: '0.08000' }]);
    queueResult([{ defaultTaxRate: '0.05000' }]);
    const rate = await resolveOrgTaxRate({ orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(rate).toBeNull();
  });

  it('FAILS CLOSED: throws OrgNotVisibleForTaxError when the org row is not visible, and never reads the partner rate', async () => {
    queueResult([]); // org read returns nothing — not visible in the ambient context
    await expect(resolveOrgTaxRate({ orgId: ORG_ID, partnerId: PARTNER_ID })).rejects.toThrow(OrgNotVisibleForTaxError);
    // The partner read must never have been queued/consumed — only one
    // db.select() call happened (the org read), proving the function returned
    // before attempting readWithPartnerAxisVisibility at all.
    expect(readWithPartnerAxisVisibility).not.toHaveBeenCalled();
  });

  it('reads the partner row through readWithPartnerAxisVisibility ONLY — the org read runs outside it', async () => {
    queueResult([{ taxExempt: false, taxRate: null }]); // org — call 1
    queueResult([{ defaultTaxRate: null }]); // partner — call 2
    await resolveOrgTaxRate({ orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(readWithPartnerAxisVisibility).toHaveBeenCalledTimes(1);
    // Per-call proof: the FIRST db.select() (org) happened with insideWrapper
    // false, the SECOND (partner) happened with insideWrapper true. A prior
    // version of this test only asserted the call COUNT, which would also
    // pass if both reads were wrapped — this asserts the SHAPE.
    expect(wrapperFlagPerCall).toEqual([false, true]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/taxRateResolver.test.ts`
Expected: FAIL — `Cannot find module './taxRateResolver'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/taxRateResolver.ts
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { organizations, partners } from '../db/schema/orgs';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { resolveEffectiveTaxRate } from './invoiceMath';

/**
 * Thrown by resolveOrgTaxRate when the org row is not visible in the caller's
 * ambient RLS context (wrong tenant, or an org that's suspended/archived/
 * cross-partner and therefore hidden by breeze_has_org_access). Callers MUST
 * NOT catch this and fall through to the partner rate — that would silently
 * tax an invisible (possibly tax-exempt) org at the partner default. Map it
 * to a proper 404/403 at the service boundary instead (see quoteService's
 * resolveQuoteTaxRate wrapper, Task 2).
 */
export class OrgNotVisibleForTaxError extends Error {
  constructor(public readonly orgId: string) {
    super(`Organization ${orgId} is not visible for tax resolution`);
    this.name = 'OrgNotVisibleForTaxError';
  }
}

/**
 * The ONE tax-rate resolver (audit rule 5) — used today by quote creation,
 * quote org-reassignment and quote update (via quoteService.resolveQuoteTaxRate,
 * a thin wrapper). A later wave (M18) will route draft-invoice tax resolution
 * through this same function; the issued-invoice path keeps its own read
 * (invoiceService.ts ~1303) because it runs inside an already-open system
 * transaction with the invoice/lines rows locked — see that file's comment on
 * why it cannot call a helper that opens a second transaction.
 *
 * Tenancy contract (CLAUDE.md): `organizations` is read in the caller's
 * AMBIENT request context so RLS enforces org access — never escalated, and
 * checked BEFORE any partner read (fail-closed: see OrgNotVisibleForTaxError
 * above). The `partners` row is a partner-AXIS table (`PARTNER_TENANT_TABLES`),
 * so the read goes through `readWithPartnerAxisVisibility`, which only
 * escalates when the ambient scope isn't already 'system'. Callers MUST have
 * already verified the caller may access `orgId` (assertOrg or equivalent)
 * before calling this — `partnerId` must come from the verified auth context
 * (`resolvePartner(actor)` / `requirePartner(actor)`), never a client-supplied
 * value, and the caller must have already confirmed the org belongs to that
 * partner.
 */
export async function resolveOrgTaxRate(input: { orgId: string; partnerId: string }): Promise<string | null> {
  const [org] = await db
    .select({ taxExempt: organizations.taxExempt, taxRate: organizations.taxRate })
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
    .limit(1);

  // Fail closed. A missing row under the caller's ambient context is either a
  // wrong/forged orgId or a real org RLS is hiding — never fall through to
  // the partner default for either case.
  if (!org) {
    throw new OrgNotVisibleForTaxError(input.orgId);
  }

  const [partner] = await readWithPartnerAxisVisibility(() =>
    db.select({ defaultTaxRate: partners.defaultTaxRate })
      .from(partners)
      .where(eq(partners.id, input.partnerId))
      .limit(1)
  );

  const rate = resolveEffectiveTaxRate({
    taxExempt: org.taxExempt,
    orgRate: org.taxRate,
    partnerRate: partner?.defaultTaxRate ?? null,
  });
  return Number(rate) > 0 ? rate : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/taxRateResolver.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/taxRateResolver.ts apps/api/src/services/taxRateResolver.test.ts
git commit -m "feat(api): add shared resolveOrgTaxRate resolver, fail-closed on an invisible org

Extracted from quoteService.resolveQuoteTaxRate. Reads the org row in the
ambient request context (throwing OrgNotVisibleForTaxError if it's not
visible, BEFORE any partner read) and the partner default via
readWithPartnerAxisVisibility instead of a hand-rolled runOutsideDbContext
escalation."
```

---

### Task 2: `quoteService.resolveQuoteTaxRate` becomes a thin wrapper

**Files:**
- Modify: `apps/api/src/services/quoteService.ts:1-20` (imports), `:391-404` (function body)
- Modify: `apps/api/src/services/quoteService.test.ts`

**Interfaces:**
- Consumes: `resolveOrgTaxRate`, `OrgNotVisibleForTaxError` from Task 1.
- Produces: `resolveQuoteTaxRate(orgId: string, partnerId: string): Promise<string | null>` — same signature as before, so all three call sites (`createQuote` ~line 410, the clone/revise path ~line 556, `updateQuote` ~line 1153) are untouched. On `OrgNotVisibleForTaxError` it now throws `QuoteServiceError('Organization not found', 404, 'ORG_NOT_FOUND')` — reusing the existing `ORG_NOT_FOUND` member of `QuoteServiceErrorCode` (`apps/api/src/services/quoteTypes.ts:36`, already used by this same file's own-partner org lookups, e.g. the `if (!target) throw new QuoteServiceError('Organization not found', 404, 'ORG_NOT_FOUND')` checks at ~line 539 and ~line 1143) rather than inventing a new code.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/quoteService.test.ts` (near the existing `resolveQuoteTaxRate` coverage — search the file for `// resolveQuoteTaxRate` comments to find the right describe block):

```ts
// Add near the top of quoteService.test.ts, alongside the other vi.mock calls:
vi.mock('./taxRateResolver', () => ({
  resolveOrgTaxRate: vi.fn(),
  OrgNotVisibleForTaxError: class OrgNotVisibleForTaxError extends Error {
    constructor(public readonly orgId: string) { super(`not visible: ${orgId}`); this.name = 'OrgNotVisibleForTaxError'; }
  },
}));
```

```ts
import { resolveOrgTaxRate, OrgNotVisibleForTaxError } from './taxRateResolver';

it('createQuote resolves tax through the shared resolveOrgTaxRate, not a local implementation', async () => {
  vi.mocked(resolveOrgTaxRate).mockResolvedValue('0.07500');
  // ... existing createQuote test setup (actor, input, queued db results for the
  // rest of createQuote) — the assertion below is the new one to add:
  await createQuote(/* existing input */ input, actor);
  expect(resolveOrgTaxRate).toHaveBeenCalledWith({ orgId: input.orgId, partnerId: actor.partnerId });
});

it('createQuote maps OrgNotVisibleForTaxError to QuoteServiceError(404, ORG_NOT_FOUND)', async () => {
  vi.mocked(resolveOrgTaxRate).mockRejectedValue(new OrgNotVisibleForTaxError(input.orgId));
  // ... existing createQuote test setup up through the point where assertOrg
  // passes (this error surfaces AFTER assertOrg, from the tax read itself).
  await expect(createQuote(input, actor)).rejects.toMatchObject({
    status: 404,
    code: 'ORG_NOT_FOUND',
  });
});
```

Note for the implementer: the file already has three existing tests that queue raw `db.select` results for `resolveQuoteTaxRate`'s org/partner reads (search for the comments `// resolveQuoteTaxRate org` and `// resolveQuoteTaxRate partner`, e.g. around lines 204–205, 258–259, 278–279). Those must be rewritten to `vi.mocked(resolveOrgTaxRate).mockResolvedValue(...)` instead of `queueResult(...)`, because the raw `db.select` calls move into the mocked `taxRateResolver` module and are no longer visible to `quoteService.test.ts`'s own `db` mock.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/quoteService.test.ts`
Expected: FAIL — the rewritten tests fail because `resolveQuoteTaxRate` still does its own `db.select` calls (the mocked `resolveOrgTaxRate` is never invoked, `queue` still has leftover items, and the old `queueResult(...)` calls that were deleted leave the mock db out of sync for those tests); the new mapping test fails because the current code has no `catch` at all around the tax read, so the raw `OrgNotVisibleForTaxError` (not a `QuoteServiceError`) propagates instead

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/quoteService.ts — replace the resolveQuoteTaxRate body (~line 381-404)
import { resolveOrgTaxRate, OrgNotVisibleForTaxError } from './taxRateResolver';
// (add to the existing import block near the top of the file, alongside the
// other './...' service imports)

/**
 * Thin wrapper: quote creation/reassignment tax resolution now goes through
 * the shared resolveOrgTaxRate (taxRateResolver.ts) — the ONE resolver per
 * concept (audit rule 5). Kept as a named function (not inlined at each call
 * site) so the three call sites don't each re-derive the null-vs-zero contract
 * and the OrgNotVisibleForTaxError → QuoteServiceError mapping below.
 *
 * The mapping exists because resolveOrgTaxRate fails closed (Task 1): a
 * caller that somehow reaches this function with an orgId RLS no longer
 * considers visible (e.g. a race with a concurrent org suspend/archive
 * between assertOrg and this call) gets a proper 404 instead of an unhandled
 * throw — reusing ORG_NOT_FOUND, the same code this file already raises for
 * "target organization not found" in the reassignment paths.
 */
async function resolveQuoteTaxRate(orgId: string, partnerId: string): Promise<string | null> {
  try {
    return await resolveOrgTaxRate({ orgId, partnerId });
  } catch (err) {
    if (err instanceof OrgNotVisibleForTaxError) {
      throw new QuoteServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
    }
    throw err;
  }
}
```

Delete the old body (the `runOutsideDbContext(() => withSystemDbAccessContext(...))` block and its two inline `db.select` calls) and the now-unused `organizations`/`partners` references *only if* nothing else in the file still needs them (grep the file first — both are used elsewhere in `quoteService.ts`, e.g. `assertContractBlocksValidForOrg`, the currency-match checks, so do not remove the imports). `QuoteServiceError` is already imported in this file (it's used throughout) — no new import needed for it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/quoteService.test.ts`
Expected: PASS (full file — this test file also covers `quoteService.clone.test.ts`-adjacent behaviour indirectly, but only `quoteService.test.ts` itself needs to be run here; `quoteService.clone.test.ts`, `quoteService.revise.test.ts` etc. are separate files, run them too if the previous run reveals cross-file mock bleed)

Run also: `cd apps/api && npx vitest run src/services/quoteService.clone.test.ts src/services/quoteService.revise.test.ts src/services/quoteService.customerLines.test.ts src/services/quoteService.deviceSet.test.ts src/services/quoteService.siteScope.test.ts`
Expected: PASS (these files may also reference `resolveQuoteTaxRate`'s db reads and need the same `queueResult` → `vi.mocked(resolveOrgTaxRate)` treatment wherever they exercise the clone/revise/update paths that call it)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteService.ts apps/api/src/services/quoteService.test.ts apps/api/src/services/quoteService.clone.test.ts apps/api/src/services/quoteService.revise.test.ts
git commit -m "refactor(api): quoteService.resolveQuoteTaxRate delegates to shared resolveOrgTaxRate

Maps the resolver's fail-closed OrgNotVisibleForTaxError to the existing
ORG_NOT_FOUND QuoteServiceError code."
```

---

### Task 3: Integration test proving the tenancy contract (M12)

**Files:**
- Create: `apps/api/src/__tests__/integration/quoteTaxRatePartnerAxis.integration.test.ts`

**Interfaces:**
- Consumes: `resolveOrgTaxRate`, `OrgNotVisibleForTaxError` (Task 1), real Postgres via the integration vitest config, `buildDbAccessContext` (`apps/api/src/middleware/auth.ts:457`) — the PRODUCTION context builder, not a hand-rolled literal, following the pattern and rationale in `apps/api/src/__tests__/integration/partnerAxisSystemContext.integration.test.ts:56-81` (its `orgContext(orgId, partnerId)` helper and its comment on why a hand-rolled literal would drift from what `authMiddleware` actually produces). Seed shape (required NOT NULL columns) follows the same file's `beforeEach` (`partnerAxisSystemContext.integration.test.ts:100-133`) — `organizations.currencyCode` has no default and is NOT NULL, `partners`/`organizations` both require `slug`, `type`/`plan`, `status`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/__tests__/integration/quoteTaxRatePartnerAxis.integration.test.ts
import './setup';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, runOutsideDbContext, type DbAccessContext } from '../../db';
import { organizations, partners } from '../../db/schema/orgs';
import { resolveOrgTaxRate, OrgNotVisibleForTaxError } from '../../services/taxRateResolver';
import { buildDbAccessContext } from '../../middleware/auth';

// Built with the PRODUCTION builder, exactly as partnerAxisSystemContext's
// own orgContext() does — see that file's comment on why a hand-rolled
// literal would silently drift from what authMiddleware actually produces.
function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return buildDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId], partnerId, userId: null });
}
function partnerContext(partnerId: string, accessibleOrgIds: string[]): DbAccessContext {
  return buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds, partnerId, userId: null });
}

describe('resolveOrgTaxRate — partner-axis tenancy contract (integration)', () => {
  const runDb = it.runIf(!!process.env.DATABASE_URL);
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let partnerAId: string;
  let partnerBId: string;
  let orgAId: string;
  let orgBId: string;

  beforeAll(async () => {
    await withSystemDbAccessContext(async () => {
      const [partnerA] = await db.insert(partners).values({
        name: `Tax Partner A ${unique}`, slug: `tax-partner-a-${unique}`,
        type: 'msp', plan: 'pro', status: 'active', defaultTaxRate: '0.06500',
      }).returning({ id: partners.id });
      const [partnerB] = await db.insert(partners).values({
        name: `Tax Partner B ${unique}`, slug: `tax-partner-b-${unique}`,
        type: 'msp', plan: 'pro', status: 'active', defaultTaxRate: '0.01000',
      }).returning({ id: partners.id });
      partnerAId = partnerA!.id;
      partnerBId = partnerB!.id;

      const [orgA] = await db.insert(organizations).values({
        currencyCode: 'USD', partnerId: partnerAId, name: `Tax Org A ${unique}`,
        slug: `tax-org-a-${unique}`, type: 'customer', status: 'active',
        taxExempt: false, taxRate: null, settings: {},
      }).returning({ id: organizations.id });
      // Org B: under partner B, TAX-EXEMPT with a distinctive stored rate —
      // if the fail-closed contract (Task 1) ever regressed to fail-OPEN, an
      // org-A-scoped read of orgB would silently return partner A's default
      // instead of rejecting, which is exactly the bug this file exists to catch.
      const [orgB] = await db.insert(organizations).values({
        currencyCode: 'USD', partnerId: partnerBId, name: `Tax Org B ${unique}`,
        slug: `tax-org-b-${unique}`, type: 'customer', status: 'active',
        taxExempt: true, taxRate: '0.09900', settings: {},
      }).returning({ id: organizations.id });
      orgAId = orgA!.id;
      orgBId = orgB!.id;
    });
  });

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      await db.delete(organizations).where(inArray(organizations.id, [orgAId, orgBId]));
      await db.delete(partners).where(inArray(partners.id, [partnerAId, partnerBId]));
    });
  });

  runDb('an org-scoped token for org A gets partner A\'s default rate', async () => {
    const rate = await runOutsideDbContext(() => withDbAccessContext(
      orgContext(orgAId, partnerAId),
      () => resolveOrgTaxRate({ orgId: orgAId, partnerId: partnerAId })
    ));
    expect(rate).toBe('0.06500');
  });

  runDb('an org-A-scoped context reading org B (a real, cross-tenant row) is DENIED by RLS, not silently defaulted', async () => {
    // Discriminating test: under the OLD implementation (org read under
    // withSystemDbAccessContext, bypassing RLS) this would have returned org
    // B's row, seen taxExempt: true, and returned null — a WRONG but
    // superficially plausible answer that would never have been caught by a
    // shape-only assertion. The NEW contract must instead reject outright,
    // because org B is genuinely invisible to an org-A-scoped context.
    await expect(
      runOutsideDbContext(() => withDbAccessContext(
        orgContext(orgAId, partnerAId),
        () => resolveOrgTaxRate({ orgId: orgBId, partnerId: partnerAId })
      ))
    ).rejects.toThrow(OrgNotVisibleForTaxError);

    // CONTROL: org B is a REAL row, not a nonexistent id — read under system
    // scope (which bypasses RLS) to prove the rejection above came from RLS
    // denying visibility, not from the row being absent.
    const [controlRow] = await withSystemDbAccessContext(() =>
      db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgBId)).limit(1)
    );
    expect(controlRow?.id).toBe(orgBId);
  });

  runDb('a partner-B-scoped context reading org A (belongs to a different partner) is DENIED by RLS', async () => {
    await expect(
      runOutsideDbContext(() => withDbAccessContext(
        partnerContext(partnerBId, [orgBId]),
        () => resolveOrgTaxRate({ orgId: orgAId, partnerId: partnerBId })
      ))
    ).rejects.toThrow(OrgNotVisibleForTaxError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/quoteTaxRatePartnerAxis.integration.test.ts
```
Expected: FAIL if Task 1 is not yet merged in this branch (module not found — `OrgNotVisibleForTaxError` doesn't exist yet). If Task 1 already landed, this file should PASS on first run since it exercises already-implemented code — in that case, prove it is actually discriminating (not vacuously green) by temporarily reverting `taxRateResolver.ts` to the OLD hand-rolled `runOutsideDbContext(() => withSystemDbAccessContext(...))` implementation and re-running: the second and third tests here MUST fail against that old code (the org-B read would succeed under system scope instead of rejecting, and the partner-B read of org A would likewise succeed), and the control assertion inside the second test must still pass either way (it is deliberately independent of which implementation is under test). Revert the temporary change before continuing.

- [ ] **Step 3: (No new implementation — this test exercises Task 1's code.) Run test to verify it passes**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/quoteTaxRatePartnerAxis.integration.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 4: Tear down the stack**

```bash
pnpm test-stack down
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/quoteTaxRatePartnerAxis.integration.test.ts
git commit -m "test(api): integration proof for resolveOrgTaxRate's tenancy contract"
```

**Other hand-rolled `runOutsideDbContext(() => withSystemDbAccessContext(...))` reads found in the billing/ticketing domain (M12's "find every other one" instruction) — left untouched, with reasons:**

| File | Line | Verdict |
|---|---|---|
| `apps/api/src/services/invoiceService.ts` | ~1210 (`issueInvoice`'s whole transaction) | Not analogous — deliberate, documented (comment cites "B10"): the entire issue transaction runs under one system-scoped `baseDb.transaction` to hold row locks across `invoices` → `invoice_lines` → `contracts`/`time_entries`/`ticket_parts` atomically with the gapless counter allocation. `allocateInvoiceCounter()`'s own `runOutsideDbContext` is deliberately NOT reused here for the same reason. Not a "plain config read" — out of scope. |
| `apps/api/src/routes/quotesPublic.ts` | several | Public, unauthenticated quote-link routes — there is no request-scoped RLS context to begin with (no bearer, no session), so this is the "genuine cross-org worker/public read" case CLAUDE.md explicitly reserves the escalation for, not a hand-rolled shortcut around an available context. |
| `apps/api/src/services/quoteAcceptService.ts`, `quoteOutcomeNotify.ts` | several | Same public-token-path justification as `quotesPublic.ts` — invoked from the same unauthenticated accept flow. |
| `apps/api/src/services/ticketFormService.ts` | 220 | A **write** path (`write` helper), not a read; out of scope for this instruction (which is about reads). |
| `apps/api/src/services/serviceDeliverableService.ts` | 840, 857, 1024 | Background sweep/scheduler code with no request context at all (cron-triggered), not a request-path settings read — legitimate cross-org worker reads. |

No other billing/ticketing settings **read**, reached from an authenticated request context, was found using the hand-rolled pattern.

---

### Task 4: `resolveInvoiceFooter` — the shared footer/terms resolver (M11)

**Files:**
- Modify: `apps/api/src/services/invoicePdf.ts` (add the exported function near `loadInvoiceForRender`, ~line 580)
- Test: `apps/api/src/services/invoicePdf.test.ts`

**Interfaces:**
- Produces: `export function resolveInvoiceFooter(input: { invoiceTerms: string | null; partnerFooter: string | null; brandingFooter: string | null }): string | null` — pure, no DB. Chain: `invoiceTerms ?? partnerFooter ?? brandingFooter ?? null`.
- Consumed by: `loadInvoiceForRender` (render, Task 5) and `issueInvoice` (issue-time snapshot, Task 6).

Re-read of the audit's finding 22 ("resolved twice, differently"): on closer inspection there is only **one** render-time computation site — `loadInvoiceForRender` (`invoicePdf.ts:626`) computes `branding.footerText` ONCE; the two renderers that use it (`renderInvoiceHtml` at line 232, and the PDF drawer at line 476) both just read `invoice.terms ?? branding.footerText` again, which is redundant (branding.footerText already folds in `invoice.terms`) but not a SECOND independent resolution — email and the public/portal routes all go through `renderInvoiceHtml`, which only ever receives the branding object `loadInvoiceForRender` built. So the actual defect is narrower than "resolved twice": it is **issue time never considering `portal_branding.footerText`**, which this task and Task 6 fix by extracting the one shared chain and calling it from both places.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/invoicePdf.test.ts — add near the existing branding tests
import { resolveInvoiceFooter } from './invoicePdf';

describe('resolveInvoiceFooter', () => {
  it.each<[string, { invoiceTerms: string | null; partnerFooter: string | null; brandingFooter: string | null }, string | null]>([
    ['invoice terms set — wins over everything', { invoiceTerms: 'Net 30, invoice terms', partnerFooter: 'Partner footer', brandingFooter: 'Portal footer' }, 'Net 30, invoice terms'],
    ['invoice terms null, partner footer set — partner wins over portal', { invoiceTerms: null, partnerFooter: 'Partner footer', brandingFooter: 'Portal footer' }, 'Partner footer'],
    ['invoice terms null, partner footer null, portal footer set — portal is the last resort', { invoiceTerms: null, partnerFooter: null, brandingFooter: 'Portal footer' }, 'Portal footer'],
    ['all three null — no footer at all', { invoiceTerms: null, partnerFooter: null, brandingFooter: null }, null],
  ])('%s', (_name, input, expected) => {
    expect(resolveInvoiceFooter(input)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/invoicePdf.test.ts`
Expected: FAIL — `resolveInvoiceFooter is not exported from './invoicePdf'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/invoicePdf.ts — add near loadInvoiceForRender (~line 580),
// exported so both render (this file) and issue (invoiceService.ts) call the
// same chain. Pure — no DB access, easy to unit-test in isolation from the
// two DB-backed readers that feed it.
/**
 * The ONE footer/terms resolver (audit rule 5, finding 22). `invoiceTerms` is
 * the invoice's own stamped `terms` column (set once, at issue — see
 * invoiceService.issueInvoice); `partnerFooter` is `partners.invoiceFooter`;
 * `brandingFooter` is `portal_branding.footerText` for the invoice's org.
 * Precedence matches the render-time chain that already existed at
 * loadInvoiceForRender before this extraction — issue time is the one being
 * brought into line with it (see invoiceService.ts's issueInvoice comment).
 */
export function resolveInvoiceFooter(input: {
  invoiceTerms: string | null;
  partnerFooter: string | null;
  brandingFooter: string | null;
}): string | null {
  return input.invoiceTerms ?? input.partnerFooter ?? input.brandingFooter ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/invoicePdf.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/invoicePdf.ts apps/api/src/services/invoicePdf.test.ts
git commit -m "feat(api): extract resolveInvoiceFooter as the one footer/terms resolver"
```

---

### Task 5: Wire the render path through `resolveInvoiceFooter`

**Files:**
- Modify: `apps/api/src/services/invoicePdf.ts:626` (`loadInvoiceForRender`)
- Test: `apps/api/src/services/invoicePdf.test.ts`

**Interfaces:**
- Consumes: `resolveInvoiceFooter` (Task 4).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/invoicePdf.test.ts — extend the existing
// loadInvoiceForRender / renderInvoiceHtml test setup (find the existing
// describe block that mocks db.select for invoice/lines/partner/portalBranding
// — it already has a fixture close to this shape per the earlier grep hit at
// line 69, `footerText: 'Powered by Lantern'`).
it('branding.footerText follows the shared resolver chain (partner over portal)', async () => {
  // Existing fixture setup: invoice.terms = null, partner.invoiceFooter = 'Partner footer',
  // portalBranding.footerText = 'Powered by Lantern' — reuse whatever queueResult/
  // mock-chain helper this file's existing tests already use for these four tables.
  const { branding } = (await loadInvoiceForRenderForTest())!; // use the file's existing test entry point for loadInvoiceForRender
  expect(branding.footerText).toBe('Partner footer');
});
```

NOT VERIFIED: the exact internal test helper/entry point `invoicePdf.test.ts` already uses to reach `loadInvoiceForRender` (it is not itself exported today). The implementer should match this test to whatever existing indirect entry point the file uses (candidates: `renderInvoicePdf`/`getInvoicePdf`) and mirror its existing mock-setup style exactly rather than inventing a new one — confirm by reading the file before writing this step's test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/invoicePdf.test.ts`
Expected: FAIL only if the assertion differs from current behaviour — since the render chain is UNCHANGED by this task (only the code path is refactored to call the shared function), this step should actually show the test PASSING immediately once written against current behaviour. Confirm this explicitly: run the test against the pre-Step-3 code first — it must pass unchanged, proving Task 5 is a pure refactor with no behaviour change at render time. If it fails at this point, the test itself is wrong — fix the test, not the code.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/invoicePdf.ts:626 — replace:
//   footerText: invoice.terms ?? partner?.invoiceFooter ?? branding?.footerText ?? null,
// with:
      footerText: resolveInvoiceFooter({
        invoiceTerms: invoice.terms,
        partnerFooter: partner?.invoiceFooter ?? null,
        brandingFooter: branding?.footerText ?? null,
      }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/invoicePdf.test.ts`
Expected: PASS — identical output to before the refactor (this is the point: render-time behaviour is provably unchanged)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/invoicePdf.ts apps/api/src/services/invoicePdf.test.ts
git commit -m "refactor(api): loadInvoiceForRender calls the shared resolveInvoiceFooter

No behaviour change — same precedence chain, now shared with issue time."
```

---

### Task 6: Wire the issue-time snapshot through `resolveInvoiceFooter` (behaviour note: future invoices only)

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts:1301-1345` (`issueInvoice`), import block near the top
- Test: `apps/api/src/services/invoiceService.test.ts`, `apps/api/src/services/invoiceService.issue.integration.test.ts`

**Interfaces:**
- Consumes: `resolveInvoiceFooter` (Task 4), `portalBranding` schema (`apps/api/src/db/schema/portal.ts` — confirm the exact export name by grepping `invoicePdf.ts`'s import of it: `import { ..., portalBranding } from '../db/schema'`).

**Behaviour note (must be called out in the PR description, not silently folded in):** this task is NOT behaviour-preserving for *future* invoices, only for *already-issued* ones. Today, `issueInvoice` stamps `terms: partner?.invoiceFooter ?? null` — if the partner has no footer configured, the stamp is `null` and every later render falls through to whatever `portal_branding.footerText` happens to be AT RENDER TIME (i.e., a live-updating value, even after issue). After this task, a newly-issued invoice stamps `partner.invoiceFooter ?? portal_branding.footerText` at issue — so if only the portal branding footer is set, future invoices freeze it forever instead of tracking later portal-branding edits. This is the direction rule 6 ("one snapshot moment") wants, and it produces byte-identical output for the invoice AT THE MOMENT OF ISSUE (nothing visibly changes right away) — but it is a real behaviour change for that invoice's *future* renders if the org's portal branding footer changes afterward. Existing already-issued invoices are completely unaffected (their `terms` column is already written and this code path never re-runs against them).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/invoiceService.test.ts — add near the existing issueInvoice
// tests (search for the queueResult sequence that sets up org/partner rows for
// issueInvoice's locked-row reads).
it('issueInvoice stamps terms from the shared resolver, including the portal-branding fallback', async () => {
  // Existing issueInvoice test scaffolding: locked invoice row (status 'draft'),
  // locked lines, org row, partner row with invoiceFooter: null — ADD a queued
  // portalBranding row with footerText: 'Powered by Acme Portal'.
  // (Match the existing mock-chain style in this file's issueInvoice describe block.)
  const result = await issueInvoice(invoiceId, actor);
  expect(result.terms).toBe('Powered by Acme Portal');
});

it('issueInvoice prefers the partner footer over portal branding when both are set', async () => {
  // partner.invoiceFooter: 'Partner footer', portalBranding.footerText: 'Portal footer'
  const result = await issueInvoice(invoiceId, actor);
  expect(result.terms).toBe('Partner footer');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/invoiceService.test.ts`
Expected: FAIL — current code stamps `terms: partner?.invoiceFooter ?? null`, so the first new test gets `terms: null`, not the portal-branding fallback

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/invoiceService.ts — add to the import block near the top:
import { resolveInvoiceFooter } from './invoicePdf';
import { portalBranding } from '../db/schema/portal'; // confirm exact schema module path by grepping invoicePdf.ts's import

// Inside issueInvoice's system transaction, after the existing org/partner reads
// (~line 1301-1303), add a portalBranding read for the invoice's org:
    const [branding] = await db.select({ footerText: portalBranding.footerText })
      .from(portalBranding).where(eq(portalBranding.orgId, inv.orgId)).limit(1);

// Replace the existing line (~1338):
//   terms: partner?.invoiceFooter ?? null,
// with:
      terms: resolveInvoiceFooter({
        invoiceTerms: null, // a draft's `terms` is not yet stamped — this call establishes it
        partnerFooter: partner?.invoiceFooter ?? null,
        brandingFooter: branding?.footerText ?? null,
      }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/invoiceService.test.ts`
Expected: PASS

- [ ] **Step 5: Run the issue integration test**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/invoiceService.issue.integration.test.ts
pnpm test-stack down
```
Expected: PASS — no existing assertion in this file pins the OLD (no-portal-fallback) behaviour as a hard requirement; if one does, update it to reflect the new chain and note the behaviour-note above in that test's comment.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/invoiceService.ts apps/api/src/services/invoiceService.test.ts apps/api/src/services/invoiceService.issue.integration.test.ts
git commit -m "feat(api): issueInvoice snapshots terms through the shared resolveInvoiceFooter

Adds the portal-branding fallback at issue time that render already had.
Existing issued invoices are unaffected (their terms column is already
written); future invoices now freeze whichever footer would have rendered
at issue, instead of a partner-only stamp that could silently diverge from
render for orgs whose only configured footer is the portal branding one."
```

---

### Task 7: Extract `ticketing.inbound` / `timeTracking.sessionSuggestions` into shared validators (M14)

**Files:**
- Create: `packages/shared/src/validators/partnerTicketingSettings.ts`
- Test: `packages/shared/src/validators/partnerTicketingSettings.test.ts`
- Modify: `packages/shared/src/validators/index.ts` (barrel export — NOT VERIFIED: the exact export pattern this barrel uses; confirm by checking how `ticketConfig.ts` is currently exported from it before writing this step)
- Modify: `apps/api/src/routes/orgs.ts:802-841` (`partnerSettingsSchema`'s `ticketing`/`timeTracking` sub-schemas replaced by imports)

**Interfaces:**
- Produces: `export const ticketingInboundSettingsSchema` (the object currently inline at `orgs.ts:822-841`, `.optional()` semantics preserved verbatim — every field stays optional, `unknownSenderMode` enum values unchanged, `triageUnknownSenders` legacy boolean kept for back-compat exactly as today), `export const timeTrackingSessionSuggestionsSchema` (the object at `orgs.ts:809-815`, keeping its `.strict()` inner object / `.passthrough()` wrapper semantics).

**Scope correction from the audit (finding 32):** re-reading the code, `org_ticket_settings.slaOverrides` (`packages/shared/src/validators/ticketConfig.ts:60-68`, `orgTicketSettingsSchema`) and `ticket_forms.fields` (`packages/shared/src/validators/ticketForms.ts`, `ticketFormFieldsSchema`, enforced by `createTicketFormSchema`/`updateTicketFormSchema` at `apps/api/src/routes/tickets/forms.ts`) **already have full, enforced zod schemas in `packages/shared/src/validators/`.** The audit's finding 32 is correct only about `partners.settings`'s `ticketing.inbound` and `timeTracking.sessionSuggestions`: these ARE fully typed today, but the schema lives as a route-local, unexported `const partnerSettingsSchema` inside `apps/api/src/routes/orgs.ts` (line 605) rather than in `packages/shared/src/validators/` — so it validates the PATCH write boundary but is unavailable to the three read sites (Task 8) and unavailable to the web app. This task's real work is promotion + reuse, not "adding a schema where none existed."

**#4628 exclusion (per addendum):** `orgTicketSettingsSchema`'s `defaultHourlyRate`/`defaultBillable` fields (`ticketConfig.ts:65-66`) are NOT touched — #4628 W02 removes them from `org_ticket_settings` entirely; adding new schema coverage around fields about to be deleted would be wasted work and a merge hazard.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/validators/partnerTicketingSettings.test.ts
import { describe, expect, it } from 'vitest';
import { ticketingInboundSettingsSchema, timeTrackingSessionSuggestionsSchema } from './partnerTicketingSettings';

describe('ticketingInboundSettingsSchema', () => {
  it('accepts a full valid config', () => {
    const result = ticketingInboundSettingsSchema.safeParse({
      enabled: true,
      address: 'support@example.com',
      defaultTriageOrgId: null,
      autoresponderEnabled: false,
      unknownSenderMode: 'quarantine',
      dropUnverifiedSenders: true,
      autoresponseSubject: null,
      autoresponseBody: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts the empty object — every field is optional', () => {
    expect(ticketingInboundSettingsSchema.safeParse({}).success).toBe(true);
  });

  it('still accepts the legacy triageUnknownSenders boolean for back-compat', () => {
    expect(ticketingInboundSettingsSchema.safeParse({ triageUnknownSenders: true }).success).toBe(true);
  });

  it('rejects an invalid unknownSenderMode', () => {
    expect(ticketingInboundSettingsSchema.safeParse({ unknownSenderMode: 'bogus' }).success).toBe(false);
  });

  it('accepts an empty-string address (the UI\'s cleared state)', () => {
    expect(ticketingInboundSettingsSchema.safeParse({ address: '' }).success).toBe(true);
  });
});

describe('timeTrackingSessionSuggestionsSchema', () => {
  it('accepts a full valid config', () => {
    const result = timeTrackingSessionSuggestionsSchema.safeParse({
      sessionSuggestions: { enabled: true, minSessionSeconds: 60, mergeGapMinutes: 5 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown key inside sessionSuggestions (strict)', () => {
    const result = timeTrackingSessionSuggestionsSchema.safeParse({
      sessionSuggestions: { enabledd: true },
    });
    expect(result.success).toBe(false);
  });

  it('passes through an unrecognized sibling key at the wrapper level', () => {
    const result = timeTrackingSessionSuggestionsSchema.safeParse({
      sessionSuggestions: { enabled: true },
      locationSuggestions: { enabled: true }, // owned by a different wave; must survive
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/validators/partnerTicketingSettings.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/validators/partnerTicketingSettings.ts
import { z } from 'zod';

// Extracted verbatim from apps/api/src/routes/orgs.ts's route-local
// partnerSettingsSchema (2026-09-17, settings-consolidation W02-API) so the
// contract is shared between the write boundary (PATCH /orgs/partners/me) and
// the tolerant reads in partnerDefaultSettings.ts, ticketConfigService.ts and
// timeSuggestionSettings.ts — audit finding 32 / M14.

// PATCH /partners/me deep-merges `ticketing` one level, but the `inbound`
// sub-object is replaced wholesale — callers must send the COMPLETE object.
export const ticketingInboundSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  address: z.string().email().optional().or(z.literal('')),
  defaultTriageOrgId: z.string().guid().nullable().optional(),
  autoresponderEnabled: z.boolean().optional(),
  // Unknown-sender routing. `unknownSenderMode` is the current 3-way control;
  // `triageUnknownSenders` is the legacy boolean still accepted for back-compat
  // (loadPartnerInboundPolicy maps it true→'triage').
  unknownSenderMode: z.enum(['quarantine', 'triage', 'drop']).optional(),
  triageUnknownSenders: z.boolean().optional(),
  dropUnverifiedSenders: z.boolean().optional(),
  autoresponseSubject: z.string().max(200).nullable().optional(),
  autoresponseBody: z.string().max(5000).nullable().optional(),
});
export type TicketingInboundSettings = z.infer<typeof ticketingInboundSettingsSchema>;

// W06 (#3900): partner-wide time-tracking suggestion flags. `.strict()` on the
// inner object so a typo is a 400 rather than a silently stored no-op;
// `.passthrough()` on the wrapper so a sibling block this schema does not own
// (e.g. `timeTracking.locationSuggestions`) is neither rejected nor stripped.
export const timeTrackingSessionSuggestionsSchema = z.object({
  sessionSuggestions: z.object({
    enabled: z.boolean().optional(),
    minSessionSeconds: z.number().int().min(30).max(3600).optional(),
    mergeGapMinutes: z.number().int().min(0).max(120).optional(),
  }).strict().optional(),
}).passthrough();
export type TimeTrackingSessionSuggestionsSettings = z.infer<typeof timeTrackingSessionSuggestionsSchema>;
```

Add the barrel export (match whichever pattern `packages/shared/src/validators/ticketConfig.ts` uses — check `packages/shared/src/index.ts` or a `validators/index.ts` for `export * from './ticketConfig'` and add `export * from './partnerTicketingSettings'` next to it).

Now update `apps/api/src/routes/orgs.ts`:

```ts
// apps/api/src/routes/orgs.ts — add to the @breeze/shared import near the top:
import { ticketingInboundSettingsSchema, timeTrackingSessionSuggestionsSchema } from '@breeze/shared';

// Replace lines 809-815 (the timeTracking: z.object({...}) block) with:
  timeTracking: timeTrackingSessionSuggestionsSchema.optional(),

// Replace lines 822-841 (the ticketing: z.object({ inbound: z.object({...}) }) block) with:
  ticketing: z.object({
    inbound: ticketingInboundSettingsSchema.optional(),
  }).optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/validators/partnerTicketingSettings.test.ts`
Expected: PASS

Run: `cd apps/api && npx vitest run src/routes/orgs.test.ts`
Expected: PASS — no assertion in this file should change, since the schema's accepted/rejected shapes are unchanged, only its location moved.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/partnerTicketingSettings.ts packages/shared/src/validators/partnerTicketingSettings.test.ts packages/shared/src/validators/index.ts apps/api/src/routes/orgs.ts
git commit -m "refactor(shared): promote partner ticketing/time-tracking settings schemas to packages/shared

No behaviour change at the write boundary — same accepted/rejected shapes,
now reusable by the tolerant reads added next."
```

---

### Task 8: Tolerant reads at the three sites that parse these jsonb sub-objects

**Files:**
- Modify: `apps/api/src/services/partnerDefaultSettings.ts` (~line 37-49)
- Modify: `apps/api/src/services/ticketConfigService.ts` (~line 401)
- Modify: `apps/api/src/services/timeSuggestionSettings.ts` (~line 28)
- Test: `apps/api/src/services/partnerDefaultSettings.test.ts`, `apps/api/src/services/ticketConfigService.test.ts`, `apps/api/src/services/timeSuggestionSettings.test.ts` (confirm these test files exist; if a given service has no existing test file, create one following the pattern of its sibling in the same directory)

**Interfaces:**
- Consumes: `ticketingInboundSettingsSchema`, `timeTrackingSessionSuggestionsSchema` (Task 7).

Reads must TOLERATE existing stored data — `safeParse` + log, never throw. This matters because `partners.settings` is jsonb written over years by earlier, looser code paths (including the legacy `triageUnknownSenders`-only shape); a strict `.parse()` that throws on read would turn one bad historical row into a 500 for every request that touches that partner's settings.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/partnerDefaultSettings.test.ts — add near existing
// inbound-config tests
it('tolerates a malformed stored inbound sub-object instead of throwing', () => {
  const malformedSettings = { ticketing: { inbound: { unknownSenderMode: 'not-a-real-mode', enabled: 'yes' } } };
  // Existing function under test — adjust the call to match its real signature
  // (grep the file for the exported function name around line 37-49).
  expect(() => loadInboundConfigDefaults(malformedSettings)).not.toThrow();
});
```

```ts
// apps/api/src/services/ticketConfigService.test.ts — mirror for the inbound read at ~line 401
it('safe-parses the stored inbound config and falls back on a malformed row', () => {
  // Construct a settings object whose ticketing.inbound fails validation and
  // assert the function under test returns its documented fallback instead of throwing.
});
```

```ts
// apps/api/src/services/timeSuggestionSettings.test.ts — mirror for ~line 28
it('safe-parses timeTracking.sessionSuggestions and falls back on a malformed row', () => {
  // Same shape: a malformed sessionSuggestions block must not throw.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/partnerDefaultSettings.test.ts src/services/ticketConfigService.test.ts src/services/timeSuggestionSettings.test.ts`
Expected: FAIL — either these tests throw (current code does a plain cast, `isPlainObject(...)`/`asRecord(...)`, not a zod parse, so a malformed shape currently passes through unvalidated rather than throwing — in that case the "not.toThrow()" assertion trivially passes and the real assertion to add is that the function now REJECTS a value that doesn't match the schema shape the same way for all three read sites; write the test to assert the specific fallback value the function is documented to return, which will fail before Step 3 wires in the schema)

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/partnerDefaultSettings.ts — near line 37-49, replace the
// isPlainObject(ticketing.inbound) cast with a safeParse:
import { ticketingInboundSettingsSchema } from '@breeze/shared';

// ... inside the existing function, replacing:
//   const inbound = isPlainObject(ticketing.inbound) ? { ...ticketing.inbound } : {};
// with:
  const parsedInbound = ticketingInboundSettingsSchema.safeParse(ticketing.inbound);
  if (!parsedInbound.success) {
    console.warn('[partnerDefaultSettings] stored ticketing.inbound failed validation, using empty defaults', parsedInbound.error.flatten());
  }
  const inbound = parsedInbound.success ? parsedInbound.data : {};
```

```ts
// apps/api/src/services/ticketConfigService.ts — near line 401, apply the same
// safeParse + warn-and-fallback treatment to the inboundCfg read.
import { ticketingInboundSettingsSchema } from '@breeze/shared';
// ... wrap the existing cast in a safeParse, matching the pattern above.
```

```ts
// apps/api/src/services/timeSuggestionSettings.ts — near line 28, apply the same
// treatment to the sessionSuggestions read.
import { timeTrackingSessionSuggestionsSchema } from '@breeze/shared';
// ... wrap the existing asRecord(...) chain in a safeParse, matching the pattern above.
```

Match each file's existing return-shape/fallback contract exactly (do not change what a caller receives on the happy path — only make the malformed-data path tolerant instead of blindly casting).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/partnerDefaultSettings.test.ts src/services/ticketConfigService.test.ts src/services/timeSuggestionSettings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/partnerDefaultSettings.ts apps/api/src/services/ticketConfigService.ts apps/api/src/services/timeSuggestionSettings.ts apps/api/src/services/partnerDefaultSettings.test.ts apps/api/src/services/ticketConfigService.test.ts apps/api/src/services/timeSuggestionSettings.test.ts
git commit -m "feat(api): tolerant safeParse reads for partner ticketing/time-tracking settings"
```

---

### Task 9: Extend `GET /orgs/organizations/:id` with `partnerDefaultTaxRate` (for W02-WEB's M10 to consume)

**Files:**
- Modify: `apps/api/src/routes/orgs.ts:1923-1976`
- Modify: `apps/api/src/routes/orgs.test.ts:2898-2944` (existing tests) + new test

**Interfaces:**
- Produces: the JSON body of `GET /orgs/organizations/:id` gains `partnerDefaultTaxRate: string | null`, read from `partners.defaultTaxRate` for the org's own partner, in the ambient request context (no escalation — the route already requires `partner` or `system` scope, and RLS on `partners` grants a partner-scoped actor their own partner row).

This is placed in W02-API (not W02-WEB) even though only the web side of M10 consumes it, because it has zero dependency on #4628 and can ship ahead of the web work that needs it — the field is additive and ignored by every existing consumer until W02-WEB reads it.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/routes/orgs.test.ts — add a new case in the existing
// "GET /orgs/organizations/:id" describe block (~line 2898)
it('includes the partner default tax rate', async () => {
  const orgId = '33333333-3333-3333-3333-333333333333';
  setAuthContext({ scope: 'partner', partnerId: 'partner-123', accessibleOrgIds: [orgId] });
  vi.mocked(db.select)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: orgId, name: 'Org', partnerId: 'partner-123' }]) })
      })
    } as any)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ defaultTaxRate: '0.07250' }]) })
      })
    } as any);

  const res = await app.request(`/orgs/organizations/${orgId}`);

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.partnerDefaultTaxRate).toBe('0.07250');
});
```

Also update the two existing tests in this block (`'should return an organization'` and `'should return 404 when organization not found'`) — both use `vi.mocked(db.select).mockReturnValue(...)` (not `Once`), which now applies to BOTH the org select and the new partner select. For the 404 case this is harmless (the handler returns before the second select ever runs). For the happy-path case, add `.mockReturnValueOnce(...)` for the org select followed by a second `.mockReturnValueOnce(...)` returning `[{ defaultTaxRate: null }]` for the partner select, so the test does not rely on the single shared mock silently applying to a second, different query.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/orgs.test.ts`
Expected: FAIL — `body.partnerDefaultTaxRate` is `undefined`

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/routes/orgs.ts — inside GET /organizations/:id, after the
// existing organization lookup (~line 1959) and BEFORE the two return
// branches (archive-lifecycle and plain), add:
  const [partnerRow] = await db
    .select({ defaultTaxRate: partners.defaultTaxRate })
    .from(partners)
    .where(eq(partners.id, organization.partnerId))
    .limit(1);
  const partnerDefaultTaxRate = partnerRow?.defaultTaxRate ?? null;

  if (isArchiveLifecycleRow(organization)) {
    return c.json({ ...organization, archived: true as const, partnerDefaultTaxRate });
  }

  return c.json({ ...organization, partnerDefaultTaxRate });
```

(`partners` is already imported in `orgs.ts` — confirm at the top of the file; it is used extensively elsewhere in this route module.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/orgs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/orgs.ts apps/api/src/routes/orgs.test.ts
git commit -m "feat(api): GET /orgs/organizations/:id returns partnerDefaultTaxRate

Additive field for the org billing settings screen's InheritedField adoption
(W02-WEB, M10) — no existing consumer reads it yet."
```

---

### Task 10: W02-API verification

**Files:** none (verification only)

- [ ] **Step 1: Run every unit file touched in Part A**

```bash
cd apps/api && npx vitest run \
  src/services/taxRateResolver.test.ts \
  src/services/quoteService.test.ts \
  src/services/quoteService.clone.test.ts \
  src/services/quoteService.revise.test.ts \
  src/services/invoicePdf.test.ts \
  src/services/invoiceService.test.ts \
  src/routes/orgs.test.ts \
  src/services/partnerDefaultSettings.test.ts \
  src/services/ticketConfigService.test.ts \
  src/services/timeSuggestionSettings.test.ts
cd packages/shared && npx vitest run src/validators/partnerTicketingSettings.test.ts
```
Expected: all PASS

- [ ] **Step 2: Run the integration files**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/quoteTaxRatePartnerAxis.integration.test.ts \
  src/services/invoiceService.issue.integration.test.ts
pnpm test-stack down
```
Expected: all PASS

- [ ] **Step 3: Typecheck and lint**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
cd packages/shared && npx tsc --noEmit -p tsconfig.json
pnpm lint
```
Expected: no errors

- [ ] **Step 4: Open the PR**

Branch: `feature/6164-settings-consolidation/wave-<W02-API-sub-issue>` (orchestrator fills in the sub-issue number after `feature-lifecycle` registration). PR body:

```
Closes #<W02-API sub-issue>

Audit rule 9: this PR adds no new setting — it consolidates two existing
resolution chains (tax rate, invoice footer) into one implementation each, and
promotes an existing-but-unshared zod contract for two partner-settings
sub-objects into packages/shared.

- Tax rate: 1 resolver (was 1 hand-rolled implementation + 1 escalation
  pattern flagged by CLAUDE.md) → 1 shared resolver used by quote create,
  quote reassignment, quote update. Tenancy-sensitive — reviewed at full rigor.
- Invoice footer: 1 render-time chain (already shared across HTML/PDF/email/
  portal via loadInvoiceForRender) + issue time gains the portal-branding
  fallback render already had. Existing issued invoices unaffected; behaviour
  note for future invoices in the PR body (see Task 6).
- ticketing.inbound / timeTracking.sessionSuggestions: promoted from a
  route-local schema to packages/shared/src/validators, with tolerant reads
  at the three sites that previously cast without validating.
```

Review sizing: M12 (Task 1-3) gets a Sonnet/Opus tenancy review per CLAUDE.md's blast-radius rule (RLS/tenancy-sensitive). M11 and M14 (Tasks 4-9) get the default review pass.

---

# Part B — W02-WEB (M10, M13)

Lands **after #4628 W02 merges**. Written against the post-cut-over shape: `OrgTicketSettingsEditor.tsx` has an SLA section only (the billing/labour-rate section — currently lines ~238-286 of the pre-#4628 file — is gone), `TicketCategoriesPage.tsx` no longer has the three pricing fields #4628 removes, and `packages/shared/src/validators/ticketConfig.ts`'s `orgTicketSettingsSchema` no longer has `defaultHourlyRate`/`defaultBillable`.

### Task 11: Precondition check — confirm #4628 W02 is merged

**Files:** none (verification only; this is the first task and it gates every later task in Part B)

- [ ] **Step 1: Confirm the pre-cutover billing section is gone**

```bash
grep -n "defaultHourlyRate\|Billing\b" apps/web/src/components/settings/OrgTicketSettingsEditor.tsx
```

Expected: NO match for a "Billing" section heading or `hourlyRate`/`defaultHourlyRate` state in this file. If either is still present, **STOP** — #4628 W02 has not merged into this branch's base. Rebase onto latest `main` (or wait) before starting any other task in Part B; every code excerpt below assumes the post-cutover shape and will not apply cleanly otherwise.

- [ ] **Step 2: Confirm the shared validator no longer carries the legacy fields**

```bash
grep -n "defaultHourlyRate\|defaultBillable" packages/shared/src/validators/ticketConfig.ts
```

Expected: NO match. If found, STOP for the same reason as Step 1.

---

### Task 12: `InheritedField` — the shared inheritance component (M10)

**Files:**
- Create: `apps/web/src/components/shared/InheritedField.tsx`
- Test: `apps/web/src/components/shared/InheritedField.test.tsx`

**Interfaces:**
- Produces:
```ts
interface InheritedFieldProps {
  id: string;
  label: string;
  /** The org's own override value, or '' when blank (= inherit). */
  value: string;
  onChange: (value: string) => void;
  /** The resolved inherited value to DISPLAY when value is blank — never just
   *  the word "inherit". null = no inherited value is configured either. */
  inheritedValue: string | null;
  /** Where the inherited value comes from, e.g. "Partner default", "Category default". */
  inheritedSource: string;
  disabled?: boolean;
  type?: 'text' | 'number';
  min?: number;
  max?: number;
  step?: string;
  'data-testid'?: string;
}
export default function InheritedField(props: InheritedFieldProps): JSX.Element;
```
Rule 4: "Blank = inherit; the field always shows the inherited value and where it comes from." When `value` is blank, the input's placeholder shows the inherited value (not the word "inherit") when `inheritedValue !== null`, and a small helper line below always names `inheritedSource` — so a blank org tax field shows placeholder `7.25` with helper text "Inherits from Partner default", not placeholder "Partner default" with no number (today's `OrgBillingSettings.tsx` behaviour, audit finding 25).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/shared/InheritedField.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InheritedField from './InheritedField';

describe('InheritedField', () => {
  it('shows the inherited VALUE as the placeholder when blank, not just the source label', () => {
    render(
      <InheritedField
        id="tax" label="Tax rate" value="" onChange={() => {}}
        inheritedValue="7.25" inheritedSource="Partner default"
        data-testid="tax-field"
      />
    );
    const input = screen.getByTestId('tax-field') as HTMLInputElement;
    expect(input.placeholder).toBe('7.25');
    expect(screen.getByText(/inherits from partner default/i)).toBeInTheDocument();
  });

  it('shows a "no inherited value configured" note when inheritedValue is null', () => {
    render(
      <InheritedField
        id="tax" label="Tax rate" value="" onChange={() => {}}
        inheritedValue={null} inheritedSource="Partner default"
        data-testid="tax-field"
      />
    );
    expect(screen.getByText(/no partner default configured/i)).toBeInTheDocument();
  });

  it('calls onChange with the typed value', async () => {
    const onChange = vi.fn();
    render(
      <InheritedField
        id="tax" label="Tax rate" value="" onChange={onChange}
        inheritedValue="7.25" inheritedSource="Partner default"
        data-testid="tax-field"
      />
    );
    await userEvent.type(screen.getByTestId('tax-field'), '5');
    expect(onChange).toHaveBeenCalledWith('5');
  });

  it('an explicit override value hides the inherited-value helper text but keeps the source note', () => {
    render(
      <InheritedField
        id="tax" label="Tax rate" value="9.5" onChange={() => {}}
        inheritedValue="7.25" inheritedSource="Partner default"
        data-testid="tax-field"
      />
    );
    const input = screen.getByTestId('tax-field') as HTMLInputElement;
    expect(input.value).toBe('9.5');
    expect(screen.queryByText(/inherits from partner default/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/shared/InheritedField.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```tsx
// apps/web/src/components/shared/InheritedField.tsx
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

interface InheritedFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  inheritedValue: string | null;
  inheritedSource: string;
  disabled?: boolean;
  type?: 'text' | 'number';
  min?: number;
  max?: number;
  step?: string;
  'data-testid'?: string;
}

export default function InheritedField({
  id, label, value, onChange, inheritedValue, inheritedSource, disabled, type = 'text', min, max, step, ...rest
}: InheritedFieldProps) {
  const { t } = useTranslation('common');
  const testId = rest['data-testid'];
  const isInheriting = value.trim() === '';
  return (
    <div>
      <label className="text-sm font-medium" htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={inheritedValue ?? undefined}
        data-testid={testId}
        className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm disabled:opacity-50"
      />
      {isInheriting ? (
        inheritedValue !== null ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('inheritedField.inheritsFrom', { source: inheritedSource })}
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('inheritedField.noneConfigured', { source: inheritedSource })}
          </p>
        )
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('inheritedField.overriding', { source: inheritedSource })}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add the locale keys (eight locales)**

Add to `apps/web/src/locales/en/common.json` under a new `inheritedField` block. NOT VERIFIED: whether `common.json` is the right namespace for `components/shared/*` — `useTranslation('common')` above assumes it; check how other cross-cutting shared components source their translations before writing this step, and if the codebase convention differs, use that namespace instead and adjust the component's `useTranslation` call to match:

```json
"inheritedField": {
  "inheritsFrom": "Inherits from {{source}}",
  "noneConfigured": "No {{source}} configured",
  "overriding": "Overrides {{source}}"
}
```

Real translations for the other seven locales:

```json
// de-DE
"inheritedField": {
  "inheritsFrom": "Erbt von {{source}}",
  "noneConfigured": "Kein {{source}} konfiguriert",
  "overriding": "Überschreibt {{source}}"
}
// es-419
"inheritedField": {
  "inheritsFrom": "Hereda de {{source}}",
  "noneConfigured": "No hay {{source}} configurado",
  "overriding": "Anula {{source}}"
}
// fr-CA / fr-FR (identical strings; both locale files get their own copy)
"inheritedField": {
  "inheritsFrom": "Hérite de {{source}}",
  "noneConfigured": "Aucun {{source}} configuré",
  "overriding": "Remplace {{source}}"
}
// it-IT
"inheritedField": {
  "inheritsFrom": "Eredita da {{source}}",
  "noneConfigured": "Nessun {{source}} configurato",
  "overriding": "Sovrascrive {{source}}"
}
// pt-BR
"inheritedField": {
  "inheritsFrom": "Herda de {{source}}",
  "noneConfigured": "Nenhum {{source}} configurado",
  "overriding": "Substitui {{source}}"
}
// tr-TR
"inheritedField": {
  "inheritsFrom": "{{source}} değerinden devralır",
  "noneConfigured": "Yapılandırılmış {{source}} yok",
  "overriding": "{{source}} değerini geçersiz kılıyor"
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/shared/InheritedField.test.tsx`
Expected: PASS

NOT VERIFIED: the exact file names of the i18n contract tests — run `ls apps/web/src/lib/i18n/*.test.ts` first and substitute the real names for `localeParity.test.ts`/`translationCoverage.test.ts`/`keyUsage.test.ts` below if they differ.
Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/shared/InheritedField.tsx apps/web/src/components/shared/InheritedField.test.tsx apps/web/src/locales/*/common.json
git commit -m "feat(web): add shared InheritedField component

Blank = inherit; always shows the inherited VALUE and its source (audit rule 4)."
```

---

### Task 13: Adopt `InheritedField` in `OrgBillingSettings.tsx` (org tax rate)

**Files:**
- Modify: `apps/web/src/components/billing/OrgBillingSettings.tsx` (interface `OrgBilling` ~line 56-68, state/load ~line 93-131, JSX ~line 435-457)
- Test: `apps/web/src/components/billing/OrgBillingSettings.test.tsx`

**Interfaces:**
- Consumes: `InheritedField` (Task 12), the new `partnerDefaultTaxRate` field from `GET /orgs/organizations/:id` (Task 9, W02-API — confirm merged first).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/billing/OrgBillingSettings.test.tsx — add near the
// existing tax-rate test setup
it('shows the partner default tax rate as the placeholder, not the words "Partner default"', async () => {
  // Existing fixture pattern: mock GET /orgs/organizations/:id to resolve with
  // { ...existing org fixture, taxRate: null, partnerDefaultTaxRate: '0.07250' }
  render(<OrgBillingSettings orgId="org-1" />);
  await screen.findByTestId('org-billing-taxrate');
  const input = screen.getByTestId('org-billing-taxrate') as HTMLInputElement;
  expect(input.placeholder).toBe('7.25');
  expect(screen.getByText(/inherits from partner default/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/billing/OrgBillingSettings.test.tsx`
Expected: FAIL — the current placeholder is the literal translated string "Partner default", not "7.25"

- [ ] **Step 3: Write the implementation**

```tsx
// apps/web/src/components/billing/OrgBillingSettings.tsx
// 1. Extend the OrgBilling interface (~line 56):
interface OrgBilling {
  // ...existing fields...
  partnerDefaultTaxRate: string | null; // fraction, e.g. "0.07250" — new field from Task 9
}

// 2. Add state (~near line 95, alongside taxPercent):
const [partnerDefaultTaxRate, setPartnerDefaultTaxRate] = useState<string | null>(null);

// 3. In load() (~line 117, after setTaxPercent):
setPartnerDefaultTaxRate(o.partnerDefaultTaxRate ?? null);

// 4. Replace the tax-rate <input> block (~lines 442-451) with:
<div>
  <InheritedField
    id="ob-taxrate"
    label={t('orgBillingSettings.tax.taxRate')}
    value={taxPercent}
    onChange={setTaxPercent}
    inheritedValue={partnerDefaultTaxRate !== null ? pctFromFraction(partnerDefaultTaxRate) : null}
    inheritedSource={t('orgBillingSettings.tax.partnerDefault')}
    disabled={taxExempt}
    type="number"
    min={0}
    max={100}
    step="0.001"
    data-testid="org-billing-taxrate"
  />
</div>
```

Add the `import InheritedField from '@/components/shared/InheritedField';` line near the top of the file, and remove the now-unused `placeholder={t('orgBillingSettings.tax.partnerDefault')}` prop that used to sit directly on the raw `<input>`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/billing/OrgBillingSettings.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/billing/OrgBillingSettings.tsx apps/web/src/components/billing/OrgBillingSettings.test.tsx
git commit -m "feat(web): org tax rate shows the partner's actual number via InheritedField"
```

---

### Task 14: Adopt `InheritedField` in `OrgTicketSettingsEditor.tsx` (SLA overrides)

**Files:**
- Modify: `apps/web/src/components/settings/OrgTicketSettingsEditor.tsx` (SLA table, ~line 187-236 in the pre-#4628 numbering — re-locate by the `data-testid="org-ticket-settings"` section and the `slaRows` table; the file is SLA-only post-#4628, so exact line numbers will have shifted)
- Test: `apps/web/src/components/settings/OrgTicketSettingsEditor.test.tsx`

**Interfaces:**
- Consumes: `InheritedField` (Task 12). The existing `getPlaceholder(priority, field)` helper already resolves the numeric partner value when available (see its body: `if (!partnerConfig) return t('orgTicketSettingsEditor.partnerDefault'); ...; return val != null ? String(val) : t('orgTicketSettingsEditor.partnerDefault');`) — unlike the tax-rate case, **this one is already correct today**: when the partner has a configured SLA minute value, `getPlaceholder` already returns the number, not the words "Partner default" (it only falls back to the words when there is truly no partner value). So this task is markup unification (replace the raw `<input placeholder=...>` with `InheritedField` for consistency and to pick up the standard "Inherits from / Overrides" helper text), not a data-availability fix like Task 13.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/settings/OrgTicketSettingsEditor.test.tsx — replace/
// extend the existing "Partner default" placeholder assertions (search for
// `getByTestId('org-ticket-sla-low-response')`)
it('shows the partner SLA number as the placeholder and a standard "inherits from" helper', async () => {
  // Existing fixture: partnerConfig.priorities.low = { responseSlaMinutes: 240, resolutionSlaMinutes: null }
  const input = screen.getByTestId('org-ticket-sla-low-response') as HTMLInputElement;
  expect(input.placeholder).toBe('240');
  expect(screen.getByText(/inherits from partner default/i)).toBeInTheDocument();
});

it('shows "no partner default configured" when the partner has no SLA for this priority/field', async () => {
  // Existing fixture: partnerConfig.priorities.low has no resolutionSlaMinutes (null)
  const input = screen.getByTestId('org-ticket-sla-low-resolution') as HTMLInputElement;
  expect(input.placeholder).toBe('');
  expect(screen.getByText(/no partner default configured/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/settings/OrgTicketSettingsEditor.test.tsx`
Expected: FAIL — the current markup has a raw `<input placeholder={getPlaceholder(...)}>` with no adjacent helper text element

- [ ] **Step 3: Write the implementation**

```tsx
// apps/web/src/components/settings/OrgTicketSettingsEditor.tsx
// Add near the top: import InheritedField from '@/components/shared/InheritedField';

// Replace getPlaceholder's string-returning contract with two small helpers
// that separate "the number, if any" from "the localized source label", so
// InheritedField's inheritedValue/inheritedSource props get the right shape:
const partnerSlaValue = (priority: TicketPriority, field: 'response' | 'resolution'): string | null => {
  const pSetting = partnerConfig?.priorities[priority];
  if (!pSetting) return null;
  const val = field === 'response' ? pSetting.responseSlaMinutes : pSetting.resolutionSlaMinutes;
  return val != null ? String(val) : null;
};

// Replace the two <input> cells inside the SLA table body (the response and
// resolution <td>s) with:
<td className="py-1.5 pr-4">
  <InheritedField
    id={`org-ticket-sla-${p}-response`}
    label="" // the row's leading cell already carries the priority label; an
             // empty label keeps this a compact table cell, not a full form row
    value={slaRows[p].responseMinutes}
    onChange={(v) => updateSlaRow(p, 'responseMinutes', v)}
    inheritedValue={partnerSlaValue(p, 'response')}
    inheritedSource={t('orgTicketSettingsEditor.partnerDefault')}
    type="number"
    min={1}
    data-testid={`org-ticket-sla-${p}-response`}
  />
</td>
<td className="py-1.5">
  <InheritedField
    id={`org-ticket-sla-${p}-resolution`}
    label=""
    value={slaRows[p].resolutionMinutes}
    onChange={(v) => updateSlaRow(p, 'resolutionMinutes', v)}
    inheritedValue={partnerSlaValue(p, 'resolution')}
    inheritedSource={t('orgTicketSettingsEditor.partnerDefault')}
    type="number"
    min={1}
    data-testid={`org-ticket-sla-${p}-resolution`}
  />
</td>
```

Delete the now-unused `getPlaceholder` function. `InheritedField`'s markup includes a `<label>` even when empty (`htmlFor={id}`) — check `InheritedField.tsx`'s render for an empty-string label; if it renders a visible empty `<label>` element that breaks the table's compact layout, add an `hideLabel?: boolean` prop to `InheritedField` (Task 12) that skips rendering the `<label>` while keeping `aria-label={label || undefined}` as a fallback, and pass `hideLabel` here. Prefer this over duplicating InheritedField's logic in a table-specific variant.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/settings/OrgTicketSettingsEditor.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/OrgTicketSettingsEditor.tsx apps/web/src/components/settings/OrgTicketSettingsEditor.test.tsx apps/web/src/components/shared/InheritedField.tsx
git commit -m "feat(web): org SLA overrides adopt the shared InheritedField markup"
```

---

### Task 15: SLA-direction note on the org Ticketing tab

**Files:**
- Modify: `apps/web/src/components/settings/OrgTicketSettingsEditor.tsx` (SLA section header, near the existing `t('orgTicketSettingsEditor.sla.description')` paragraph)
- Test: `apps/web/src/components/settings/OrgTicketSettingsEditor.test.tsx`

**Interfaces:** none beyond the locale keys below.

Audit finding 20: SLA is the one place category still beats org (`ticketSla.ts:40-47`); rule 3 requires this stated in the UI wherever it applies. This is a plain static note, not new logic.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/settings/OrgTicketSettingsEditor.test.tsx
it('states that a ticket category SLA overrides this org-level SLA', async () => {
  render(<OrgTicketSettingsEditor orgId="org-1" onDirty={() => {}} onSave={() => {}} />);
  await screen.findByTestId('org-ticket-settings');
  expect(screen.getByTestId('org-ticket-sla-direction-note')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/settings/OrgTicketSettingsEditor.test.tsx`
Expected: FAIL — no such element

- [ ] **Step 3: Write the implementation**

```tsx
// apps/web/src/components/settings/OrgTicketSettingsEditor.tsx — in the SLA
// section, directly under the existing t('orgTicketSettingsEditor.sla.description')
// paragraph:
<p className="mt-1 text-xs text-amber-700" data-testid="org-ticket-sla-direction-note">
  {t('orgTicketSettingsEditor.sla.categoryOverridesNote')}
</p>
```

Add the locale key to all eight locale files under `orgTicketSettingsEditor.sla`:

```json
// en
"categoryOverridesNote": "A ticket's category SLA takes priority over these org-level overrides when both are set."
// de-DE
"categoryOverridesNote": "Das SLA der Ticket-Kategorie hat Vorrang vor diesen organisationsweiten Überschreibungen, wenn beide festgelegt sind."
// es-419
"categoryOverridesNote": "El SLA de la categoría del ticket tiene prioridad sobre estas anulaciones a nivel de organización cuando ambos están configurados."
// fr-CA
"categoryOverridesNote": "Le SLA de la catégorie du billet a préséance sur ces remplacements au niveau de l'organisation lorsque les deux sont définis."
// fr-FR
"categoryOverridesNote": "Le SLA de la catégorie du ticket est prioritaire sur ces surcharges au niveau de l'organisation lorsque les deux sont définis."
// it-IT
"categoryOverridesNote": "L'SLA della categoria del ticket ha la priorità su queste sostituzioni a livello di organizzazione quando entrambe sono impostate."
// pt-BR
"categoryOverridesNote": "O SLA da categoria do chamado tem prioridade sobre essas substituições em nível de organização quando ambos estão definidos."
// tr-TR
"categoryOverridesNote": "Her ikisi de ayarlandığında, bilet kategorisinin SLA'sı bu kuruluş düzeyindeki geçersiz kılmalara göre önceliklidir."
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/settings/OrgTicketSettingsEditor.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/OrgTicketSettingsEditor.tsx apps/web/src/components/settings/OrgTicketSettingsEditor.test.tsx apps/web/src/locales/*/settings.json
git commit -m "feat(web): state the SLA category-beats-org direction on the org Ticketing tab"
```

---

### Task 16: SLA-direction note on the partner Categories screen

**Files:**
- Modify: `apps/web/src/components/settings/TicketCategoriesPage.tsx` (row-drawer SLA fields, ~lines 468-486)
- Test: `apps/web/src/components/settings/TicketCategoriesPage.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/settings/TicketCategoriesPage.test.tsx
it('states that this category SLA overrides an org-level SLA override', async () => {
  // Existing test scaffolding: open the edit drawer for a category (find the
  // existing test that reaches the response/resolution SLA fields, e.g. via
  // getByTestId('ticket-category-edit-response-sla')).
  expect(screen.getByTestId('ticket-category-sla-direction-note')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/settings/TicketCategoriesPage.test.tsx`
Expected: FAIL — no such element

- [ ] **Step 3: Write the implementation**

```tsx
// apps/web/src/components/settings/TicketCategoriesPage.tsx — directly above
// the response-SLA field (~line 468, before the "edit-response-sla" label):
<p className="mb-2 text-xs text-amber-700" data-testid="ticket-category-sla-direction-note">
  {t('ticketCategoriesPage.categorySlaOverridesOrgNote')}
</p>
```

Add the locale key to all eight locale files under `ticketCategoriesPage`:

```json
// en
"categorySlaOverridesOrgNote": "This SLA takes priority over any org-level SLA override for tickets in this category."
// de-DE
"categorySlaOverridesOrgNote": "Dieses SLA hat Vorrang vor jeder organisationsweiten SLA-Überschreibung für Tickets in dieser Kategorie."
// es-419
"categorySlaOverridesOrgNote": "Este SLA tiene prioridad sobre cualquier anulación de SLA a nivel de organización para tickets en esta categoría."
// fr-CA
"categorySlaOverridesOrgNote": "Ce SLA a préséance sur tout remplacement de SLA au niveau de l'organisation pour les billets de cette catégorie."
// fr-FR
"categorySlaOverridesOrgNote": "Ce SLA est prioritaire sur toute surcharge de SLA au niveau de l'organisation pour les tickets de cette catégorie."
// it-IT
"categorySlaOverridesOrgNote": "Questo SLA ha la priorità su qualsiasi sostituzione dell'SLA a livello di organizzazione per i ticket in questa categoria."
// pt-BR
"categorySlaOverridesOrgNote": "Este SLA tem prioridade sobre qualquer substituição de SLA em nível de organização para chamados nesta categoria."
// tr-TR
"categorySlaOverridesOrgNote": "Bu SLA, bu kategorideki biletler için herhangi bir kuruluş düzeyi SLA geçersiz kılmasına göre önceliklidir."
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/settings/TicketCategoriesPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/TicketCategoriesPage.tsx apps/web/src/components/settings/TicketCategoriesPage.test.tsx apps/web/src/locales/*/settings.json
git commit -m "feat(web): state the SLA category-beats-org direction on the partner Categories screen"
```

---

### Task 17: Mount/composition check — both SLA-direction notes and InheritedField render together

**Files:**
- Test: `apps/web/src/components/settings/OrgTicketSettingsEditor.render.test.tsx` (new — or add to the existing test file if it already has a top-level "renders the whole page" test; check first)
- Test: `apps/web/src/components/settings/TicketCategoriesPage.render.test.tsx` (new, same caveat)
- Test: `apps/web/src/components/billing/OrgBillingSettings.render.test.tsx` (new, same caveat)

This is the composition task the executor (Codex) must not skip: each of the three components above must be asserted, in ONE test per page, to render its Task 12/15/16 `data-testid`s together — not just that the individual pieces exist in isolation (which Tasks 13-16 already proved), but that the actual mounted page shows them.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/settings/OrgTicketSettingsEditor.render.test.tsx
// (skip creating this file if OrgTicketSettingsEditor.test.tsx already has an
// equivalent "renders the full SLA section" test — add these assertions to it
// instead of duplicating render setup)
it('renders InheritedField SLA cells and the direction note together', async () => {
  render(<OrgTicketSettingsEditor orgId="org-1" onDirty={() => {}} onSave={() => {}} />);
  await screen.findByTestId('org-ticket-settings');
  expect(screen.getByTestId('org-ticket-sla-low-response')).toBeInTheDocument();
  expect(screen.getByTestId('org-ticket-sla-direction-note')).toBeInTheDocument();
});
```

```tsx
// apps/web/src/components/settings/TicketCategoriesPage.render.test.tsx (or appended)
it('renders the SLA direction note inside the category edit drawer', async () => {
  // Existing scaffolding: render the page, open the edit drawer for a seeded category.
  expect(screen.getByTestId('ticket-category-sla-direction-note')).toBeInTheDocument();
  expect(screen.getByTestId('ticket-category-edit-response-sla')).toBeInTheDocument();
});
```

```tsx
// apps/web/src/components/billing/OrgBillingSettings.render.test.tsx (or appended)
it('renders the InheritedField tax-rate control on the mounted billing page', async () => {
  render(<OrgBillingSettings orgId="org-1" />);
  await screen.findByTestId('org-billing-taxrate');
  expect(screen.getByTestId('org-billing-taxrate')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail (only if new files) or already pass (if folded into existing suites)**

Run: `cd apps/web && npx vitest run src/components/settings/OrgTicketSettingsEditor.test.tsx src/components/settings/TicketCategoriesPage.test.tsx src/components/billing/OrgBillingSettings.test.tsx`

If these assertions were added to Tasks 13-16's own test files rather than new files, they should already PASS at this point (Tasks 13-16 already implemented the underlying markup) — in that case this task is a composition PROOF, not new red/green work; still run it explicitly and record the result before moving on, per the plan's verification discipline.

- [ ] **Step 3: (No new implementation expected — if a failure appears here, it means Task 13/15/16's markup is not actually reachable from the full mounted component; fix the mount wiring, not the test.)**

- [ ] **Step 4: Commit (only if new files were created)**

```bash
git add apps/web/src/components/settings/OrgTicketSettingsEditor.render.test.tsx apps/web/src/components/settings/TicketCategoriesPage.render.test.tsx apps/web/src/components/billing/OrgBillingSettings.render.test.tsx
git commit -m "test(web): composition proof — InheritedField and SLA-direction notes render on the mounted pages"
```

---

### Task 18: Split `InboundEmailCard.tsx` into an autosaving toggle section and a page-Save autoresponder form (M13)

**Files:**
- Modify: `apps/web/src/components/settings/InboundEmailCard.tsx`
- Test: `apps/web/src/components/settings/InboundEmailCard.test.tsx`

**Rule 7 violation confirmed on re-read** (audit finding 29): the current single `<section data-testid="inbound-email-card">` mixes three save patterns in one card — (a) immediate-effect toggles/radios (`enabled`, triage-org select, unknown-sender-mode radios, `dropUnverifiedSenders`, `autoresponderEnabled`) that already correctly autosave via `saveConfig` (which already uses `runAction` and toasts), (b) the local-part address field with its own explicit Save button plus a `window.confirm` — a deliberate, consequential-action pattern, not a plain form field, and (c) the autoresponse subject/body fields with a THIRD, separate explicit Save button. (b) and (c) are each internally rule-7-compliant (explicit Save for form-shaped fields), but rule 7 says "never mixed in a card" — today all three sit inside the same `<section>`.

Fix: split into three visually distinct `<section>`s (already structurally close — `CustomerDomainsCard` is already its own section at the bottom) so each save pattern reads as its own screen-type, not a description of the existing save logic (which is not incorrect) but a visual/structural correction.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/settings/InboundEmailCard.test.tsx
it('separates the autosaving toggles, the address change form, and the autoresponse form into distinct sections', async () => {
  render(<InboundEmailCard />);
  await screen.findByTestId('inbound-email-card');
  const toggles = screen.getByTestId('inbound-toggles-section');
  const addressForm = screen.getByTestId('inbound-address-section');
  const autoreplyForm = screen.getByTestId('inbound-autoreply-editor'); // pre-existing testid
  // Assert they are three DIFFERENT ancestor <section> elements, not one shared container.
  expect(toggles.closest('section')).not.toBe(addressForm.closest('section'));
  expect(addressForm.closest('section')).not.toBe(autoreplyForm.closest('section'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/settings/InboundEmailCard.test.tsx`
Expected: FAIL — `getByTestId('inbound-toggles-section')` / `getByTestId('inbound-address-section')` do not exist yet (everything is inside the single `data-testid="inbound-email-card"` `<section>`)

- [ ] **Step 3: Write the implementation**

Restructure the JSX (the logic inside each block — `saveConfig`, `saveLocalPart`, the autoreply save handler — is unchanged; only the section boundaries move):

```tsx
// apps/web/src/components/settings/InboundEmailCard.tsx — replace the single
// <section className="rounded-lg border p-4"> ... </section> (lines ~241-517)
// with three sibling sections:
return (
  <div className="max-w-3xl space-y-6" data-testid="inbound-email-card">
    <section className="rounded-lg border p-4" data-testid="inbound-toggles-section">
      <h2 className="mb-1 text-sm font-semibold">{t('inboundEmail.title')}</h2>
      <p className="mb-3 text-xs text-muted-foreground">{t('inboundEmail.description')}</p>
      {/* enabled toggle, triage-org select, unknown-sender-mode fieldset,
          dropUnverifiedSenders toggle, autoresponderEnabled toggle — unchanged
          JSX, all still calling saveConfig(...) directly on change (autosave
          is correct here — these are immediate-effect switches, rule 7). */}
    </section>

    <section className="rounded-lg border p-4" data-testid="inbound-address-section">
      <h2 className="mb-1 text-sm font-semibold">{t('inboundEmail.address')}</h2>
      {/* the existing domainConfigured / connectedMailboxCount / unconfigured
          branches, the localPartDraft input, Save + Copy buttons — unchanged
          JSX and unchanged saveLocalPart logic (explicit Save + confirm is
          correct here — this is a consequential action, not a plain field). */}
    </section>

    {cfg.autoresponderEnabled && (
      <div className="rounded-md border bg-muted/20 p-3" data-testid="inbound-autoreply-editor">
        {/* unchanged autoresponse subject/body/preview/Save JSX — this is a
            form; page-level (card-level) Save is correct here, rule 7. */}
      </div>
    )}

    <CustomerDomainsCard />
  </div>
);
```

Move the `<section>` open/close tags exactly as shown; do not touch any handler logic (`saveConfig`, `saveLocalPart`, the inline autoreply save `onClick`) — this task is markup-only.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/settings/InboundEmailCard.test.tsx`
Expected: PASS

Also run the full existing file to confirm nothing else broke from the JSX move:
Run: `cd apps/web && npx vitest run src/components/settings/InboundEmailCard.test.tsx`
Expected: all pre-existing tests still PASS (they query by `data-testid`s that are unchanged — `inbound-enabled-toggle`, `inbound-localpart`, `inbound-autoreply-subject`, etc. — only their ancestor `<section>` moved)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/InboundEmailCard.tsx apps/web/src/components/settings/InboundEmailCard.test.tsx
git commit -m "refactor(web): split InboundEmailCard into three save-pattern-pure sections

No save-logic change — autosave toggles, the explicit-Save address form and
the explicit-Save autoresponder form each get their own section instead of
sharing one card (audit rule 7 / finding 29)."
```

---

### Task 19: Document why the partner hub and the org ticket editor need no M13 change

**Files:** none (this task records findings; no code changes)

Two of the three M13 targets named by the audit turn out, on re-read, to need no change:

- **Partner hub** (`apps/web/src/components/settings/PartnerSettingsPage.tsx`): finding 29 says "the partner hub mixes a page-level Save with three self-saving tabs." Re-reading `TAB_GROUPS` (~lines 95-128), the three `selfSaving: true` tabs are `ticketing`, `aiProvider`, `loginBranding`. Only `ticketing` is in the billing/ticketing domain this plan covers — and Wave 0's M0 (a *prior*, separately-planned wave, assumed merged per this plan's header) turns the partner hub's `ticketing` tab into a plain link to the new standalone `/settings/ticketing` page, removing it from `TAB_GROUPS` entirely. `aiProvider` and `loginBranding` are outside this plan's domain (AI provider keys, login branding — not billing/ticketing settings). **No file in this plan's scope needs to change for this finding.**
- **Org ticket editor** (`apps/web/src/components/settings/OrgTicketSettingsEditor.tsx`): finding 29's "bespoke send-only-if-changed rule (#3776)" is a **correctness** safeguard (the dirty-diff on the hourly-rate field, which #4628 W02 has now removed anyway per this plan's Task 11 precondition), not a save-PATTERN violation. The component already has exactly one save pattern for its own form: a single page-level Save button (`data-testid="org-ticket-save"`) with consistent `onDirty()` wiring across every field, including the SLA table. This matches rule 7 ("Forms: page Save") already. **No save-pattern change needed here beyond Tasks 14-15's InheritedField/direction-note work, which are M10, not M13.**

- [ ] **Step 1: No test to write — this is a documentation-only task.** Record the finding above verbatim in the PR description for this half (Task 20's checklist references it).

---

### Task 20: W02-WEB verification

**Files:** none (verification only)

- [ ] **Step 1: Run every unit file touched in Part B**

```bash
cd apps/web && npx vitest run \
  src/components/shared/InheritedField.test.tsx \
  src/components/billing/OrgBillingSettings.test.tsx \
  src/components/settings/OrgTicketSettingsEditor.test.tsx \
  src/components/settings/TicketCategoriesPage.test.tsx \
  src/components/settings/InboundEmailCard.test.tsx
```
Expected: all PASS

(Also run any `.render.test.tsx` files Task 17 created as separate files.)

- [ ] **Step 2: i18n contract tests**

```bash
cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts
```
Expected: all PASS (confirm exact file names via `ls apps/web/src/lib/i18n/*.test.ts` first — file names above are the CLAUDE.md-documented tests; verify before running)

- [ ] **Step 3: Typecheck and lint**

```bash
cd apps/web && npx tsc --noEmit -p tsconfig.json
pnpm lint
```
Expected: no errors

- [ ] **Step 4: Open the PR**

Branch: `feature/6164-settings-consolidation/wave-<W02-WEB-sub-issue>`. PR body:

```
Closes #<W02-WEB sub-issue>

Depends on #4628 W02 (merged) for OrgTicketSettingsEditor's post-cut-over
shape — see Task 11's precondition check.

Audit rule 9: no new setting. InheritedField unifies how org tax rate and
org SLA overrides show inherited values (rule 4); the SLA category-beats-org
direction (the one remaining exception, finding 20) is now stated on both
screens that need it (rule 3); InboundEmailCard's three existing save
behaviours are separated into distinct sections instead of one mixed card
(rule 7) — no save LOGIC changed, only section boundaries.

Partner-hub and org-ticket-editor M13 findings needed no code change on
re-read — see Task 19.
```

Review sizing: default review (no tenancy/auth/migration surface touched in this half).

---

## Split recommendation

Confirmed as the right split, matching the size hint in the audit's own §5 table (M10 = S, M13 = M, M11 = S, M12 = S, M14 = M):

- **W02-API** (Tasks 1-10): `taxRateResolver.ts`, `invoicePdf.ts`/`invoiceService.ts` footer resolver, `orgs.ts` schema promotion + `partnerDefaultTaxRate` field. Backend-only, no #4628 dependency, ships any time. M12 (Tasks 1-3) is the one high-blast-radius surface — gets its own tenancy review per CLAUDE.md.
- **W02-WEB** (Tasks 11-20): `InheritedField`, its two adoptions, two SLA-direction notes, `InboundEmailCard` split. Web-only, no backend risk, but gated on #4628 W02's file shape by Task 11's precondition check.

`InboundEmailCard`'s split (M13) has zero `#4628` overlap and is web-only/independent, as the addendum allowed moving into W02-API's PR — kept in W02-WEB instead, because W02-API is otherwise pure backend (no `.tsx` files) and mixing in one web component there would blur that PR's review surface for no benefit; W02-WEB is not blocked on anything InboundEmailCard needs, so there is no cost to leaving it there.

## Self-review

**Spec coverage:** M10 (Tasks 12-17), M11 (Tasks 4-6), M12 (Tasks 1-3), M13 (Tasks 18-19), M14 (Tasks 7-8) — all five Wave-1 moves have at least one task. Rule 3 (SLA direction stated in UI) → Tasks 15-16. Rule 4 (blank=inherit, show value+source) → Task 12. Rule 5 (one resolver per concept) → Tasks 1-6. Rule 7 (one save pattern per screen, never mixed) → Task 18 (fix) + Task 19 (two targets that needed no fix, documented instead of silently dropped).

**Placeholder scan:** every step has real code or an explicit "no new implementation, verification only" step; every "confirm X first" instruction names the exact grep/file to check, not a vague TODO.

**Type consistency:** `InheritedField`'s prop names (`inheritedValue`, `inheritedSource`, `onChange: (value: string) => void`) are used identically across Tasks 12, 13, 14, 17. `resolveOrgTaxRate({ orgId, partnerId })` and `resolveInvoiceFooter({ invoiceTerms, partnerFooter, brandingFooter })` keep the same parameter names from their defining task through every consuming task.

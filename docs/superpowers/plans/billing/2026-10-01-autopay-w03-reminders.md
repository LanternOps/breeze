# Autopay W03: Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send opt-in, deduplicated upcoming and overdue reminders for every eligible unpaid invoice and expose inherited reminder settings to every partner.
**Architecture:** A UTC calendar-day evaluator feeds a system-scoped, org-paged sweep, which freezes reminder content into W1's durable outbox. The existing autopay worker schedules the sweep; W2b's Payments shells render shared reminder fields independently of the autopay rollout switch.
**Tech Stack:** TypeScript, PostgreSQL/Drizzle with RLS, BullMQ, Hono, React/Astro, react-i18next, Vitest, Playwright.
**Spec:** docs/superpowers/specs/billing/2026-10-01-autopay-design.md · **Index:** docs/superpowers/plans/billing/2026-10-01-autopay-index.md

## Preconditions

1. Merge W1 before implementing Tasks 1–5. C2 schema exports, C3 types, C4 settings/outbox/rendering and C5 `autopay-jobs` worker must exist and their own tenancy/concurrency tests must pass. None exists in this checkout at plan-authoring time. Do not recreate W1's schema or dispatcher in W03.
2. Merge W2b before Tasks 6–7: `PaymentsSettingsTab.tsx` and `OrgPaymentsSettingsSection.tsx` must be mounted by `PartnerBillingSettingsPage` and `OrgBillingSettings`. Preserve enrollment controls and their permission checks.
3. W1/W2b implementation files are absent. Their sibling plan documents appeared during this planning session and were read for composition: W1 `BillingNoticeContext` has `{ partnerId, orgId, data, frozen, mandatory }` and a `registerBillingNoticeRenderer` registry; W2b exposes settings `{ values, effective, inherited, autopayEnabled }` and a controlled org payments section. The snippets below compose with those planned interfaces. Verify the landed code still matches before implementing; these are planned dependencies, not verified existing exports.
4. W1's enrollment requires a real `stripeConnectAccounts` row plus `stripeConnectionId`/`stripeAccountId`; the integration fixture supplies them. W2b's `paymentSettingsView` only supplies autopay fields in partner `inherited`; Task 7 adds the four reminder defaults there without changing a binding C4 signature.
5. One PR, `feat/autopay-reminders`, Tasks 1–8 together. Settings home: Billing settings → Payments, and org Billing → Payments; partner default → org override; resolver `resolveBillingPaymentSettings`; configuration locations 0 → 1 per level. This document is the only planning-session write. Commands to stage/commit below are instructions for the later implementer, not commands executed while authoring this plan.

## Where this plan corrects or refines the spec/index

1. **Cadence boundaries and sequence are explicit.** Upcoming reminders run on `due − beforeDueDays`, then exact repeat ticks strictly before due. There is no due-day email. Overdue reminders first run on `due + overdueEveryDays`, then its multiples. No missed-tick backfill. Sequences start at 1 independently for each kind; `lastSentSeq` is the greatest durable outbox sequence for that same invoice/kind, including pending/failed/cancelled rows. A due-date/cadence edit never resets that high-water mark: already allocated ordinals are not reused, and some new ticks can therefore be suppressed. This conservative behavior avoids replaying a series after an edit; a new series-generation model is outside C4/C2.
2. **Exactly once means one durable enqueue identity.** C4 `enqueueBillingNotice` promises conflict-safe insertion, not transactional delivery with an external mail provider. Task 3 proves one real row and one observed transport call per sequence under concurrent sweeps/dispatchers. Actual transport retry semantics remain W1's responsibility; do not claim external email exactly-once across a provider-accepted/process-crashed gap.
3. **Current paths and registration differ from shorthand.** `EmailTemplatesTab` is in `apps/web/src/components/settings/EmailTemplatesTab.tsx`. `partnerSettingsSchema` in `apps/api/src/routes/orgs.ts` already uses `z.partialRecord(z.enum(EMAIL_TEMPLATE_IDS), emailTemplateOverrideSchema)`: new shared IDs enable route validation automatically. Test that path; do not introduce a second enum. `startRegisteredWorkers` in `apps/api/src/worker.ts` loads the global registry, so no duplicate worker initializer belongs in the entrypoint.
4. **Integration tests are not discovered just by suffix.** `defineConfig` in `apps/api/vitest.integration.config.ts` has explicit co-located includes; `apps/api/vitest.config.ts` excludes corresponding real-DB suites. Tasks 3–4 register their co-located files in both runners.
5. **NULL repeat semantics.** Spec §5.1 says both NULL=no-repeat and org NULL=inherit. Preserve the ownership rule: partner NULL resolves to the no-repeat code default; org NULL inherits. An org cannot explicitly turn repetition off while its partner repeats with the existing schema. The UI says so; no 0 sentinel, new column or retyped patch is introduced.
6. **CTA infrastructure and text rendering.** `varsForEmailTemplate` in `packages/shared/src/utils/emailTemplates.ts` requires `cta_button` for CTA templates. Add it as renderer infrastructure alongside common partner/org variables; the C6 business-variable lists remain exact. `renderPartnerEmail` returns subject/html only; Task 2 derives text with the existing `htmlToText` and explicitly includes the pay URL.
7. **Status and currency are existing primitives.** Use `sqlOpenAr` in `apps/api/src/db/schema/invoices.ts`, and `buildAutomationEligibleOrgPredicate` in `apps/api/src/services/tenantStatus.ts`, not an active-only approximation. `invoices.dueDate` is nullable; skip null dates. `formatMoney` in `packages/shared/src/utils/currency.ts` receives the decimal balance and invoice currency, never total or partner currency.
8. **No new settings URL or schema.** `SETTINGS_CATALOG` in `apps/web/src/lib/settingsCatalog.ts` already points at `/settings/billing`; W2b plans a separate `billing-payments` hash entry. Task 7 removes its `requiresAutopay` gate and updates the reachability assertion in `settingsPageRegistry.test.ts`. W03 creates no table, column, token type or route. C1 reserves no W03 migration. Cascade, merge, export, RLS, audit-admin and encryption registrations belong to W1 and are verified again in Task 8, not duplicated here.

## Global Constraints

- Money: `numeric(12,2)` decimal strings in services; Stripe in integer minor units via the existing
  `services/stripeMoney.ts` helpers. Never floats.
- Every Stripe call goes through `getPartnerStripeClient` and runs **outside** any DB transaction
  (`runOutsideDbContext`).
- Checkout **payment** sessions stay `payment_method_types: ['card']` (#5611). ACH only via setup
  sessions + PaymentIntents.
- No-login token routes: GET renders and never mutates; every state change is a POST.
- Tenancy: every new org-scoped table has RLS enabled + forced in its creating migration, composite
  `org_id` FKs `DEFERRABLE INITIALLY IMMEDIATE`, and is registered in cascade, merge and export per
  spec §5.9. Run `pnpm test-stack up` and the integration + `test:rls-coverage` suites before the
  PR.
- Migrations: idempotent, `SELECT set_config('breeze.scope','system',true)` before any write, never
  added to the `migrationRlsScope` baseline, C1 slots.
- Tests are co-located; the API uses Vitest with Drizzle mocks per the `breeze-testing` skill.
  Real-DB behaviour gets `*.integration.test.ts`. Run single files with
  `cd apps/api && npx vitest run <path>` (never `pnpm … test -- --run`).
- Web: `runAction` for mutations, `data-testid` on interactive elements, `window.location.hash`
  for tab state, i18n keys.
- No internal infrastructure details, customer names or real keys in code, tests or docs.


- Reminder fields: `remindersEnabled=false`, `reminderBeforeDueDays=3`, `reminderRepeatDays=null`, `overdueReminderEveryDays=7` by default; every non-null day interval is an integer in 1–31.
- Schedule key `invoice-reminder-sweep`, cron `18 6 * * *`, job `reminder-sweep`, queue `autopay-jobs`; the existing overdue key is `invoice-overdue-sweep`, cron `8 6 * * *`. Follow the registry's deployment-UTC timezone convention; do not independently change only this job's timezone.
- Eligible invoice states are exactly `sent|partially_paid|overdue`, balance SQL `> 0`; exclude schedule states exactly `awaiting_notice|scheduled|collecting|retry_scheduled`. Neither eligibility nor scheduling checks `autopayEnabled`.
- Key format is exactly `invoice:${invoiceId}:${kind}:${seq}`. Amount, currency, due date, days overdue and recipient are frozen at enqueue. Existing pending notices retain their frozen payload and W1 dispatch policy.
- Org pages are 100 rows, invoice-ID pages are 250 rows, both keyset-paged by UUID. Resolve settings once per org per sweep. Use short system transactions and an invoice row lock when rechecking and enqueuing; perform no network delivery inside those transactions.
- Preserve `getOrMintInvoiceLink` / `buildPublicInvoiceUrl` in `apps/api/src/services/invoiceLinkToken.ts`, including its persisted expiry and encrypted-token behavior. Missing/invalid billing email skips the org and consumes no sequence. Per-invoice failures do not block later invoices; report aggregate failure after processing so BullMQ records failure and retry is safe.

## Review Focus

1. **A partial payment in another currency** produces a reminder for balance, not original total; later payment/void wins the row-lock recheck. Tasks 2–4 pin decimal `25.05 EUR`, zero balance, paid and void rows.
2. **UTC boundaries, leap days and edited cadence** produce stable kind-local sequences, no due-day/early-overdue send, no replay of pending/failed ordinals. Task 1 pins dates/validation; Task 3 pins high-water dedupe.
3. **A worker retry or two concurrent sweeps** must not double-enqueue or hold a fleet-wide transaction; a failed invoice must not starve its neighbor. Tasks 3–4 cover failure isolation, scoped transactions, and real concurrent insertion.
4. **Lifecycle fences and fallback** must exclude archived/purging/merging orgs and all four active schedule states, while failed/action-required/skipped schedules and autopay-disabled partners still receive reminders. Tasks 3–4 cover both SQL and real fixtures.
5. **False and blank overrides, failed saves and permissions** must preserve explicit false, show actual inherited values, retain unsaved input on failure, preserve tax/address saves when payment settings cannot load, and leave Payments reachable with autopay off. Tasks 4, 6 and 7 own these assertions.

## File map

Paths marked W1/W2b are future prerequisite files, not existing files verified in this checkout.

- Create `apps/api/src/services/autopay/reminderSweep.ts` — calendar evaluation and paged system sweep.
- Create `apps/api/src/services/autopay/reminderSweep.test.ts` — pure cadence and mocked sweep tests.
- Create `apps/api/src/services/autopay/reminderSweep.integration.test.ts` — real settings, outbox, eligibility and concurrent sweep proof.
- Create `apps/api/src/services/autopay/reminderSettings.integration.test.ts` — partner/org updates, inheritance and RLS through W1 services.
- Modify `apps/api/vitest.integration.config.ts` and `apps/api/vitest.config.ts` — integration ownership.
- Modify `packages/shared/src/utils/emailTemplates.ts` and `packages/shared/src/utils/emailTemplates.test.ts` — catalog IDs, variables and defaults.
- Modify `apps/api/src/services/emailTemplates/defaults.ts` — exhaustive preheader/footer maps.
- Modify `apps/api/src/services/autopay/renderBillingNotice.ts` (W1) and create `apps/api/src/services/autopay/renderBillingNotice.reminders.test.ts` — reminder renderer registrations and frozen render tests.
- Modify `apps/api/src/routes/orgs.test.ts` — actual template-ID validation regression.
- Modify `apps/api/src/services/autopay/paymentSettingsView.ts` and `apps/api/src/services/autopay/paymentSettingsView.test.ts` (W2b), and `apps/api/src/index.autopayRoutes.test.ts` (W1) — inherited reminder projection and app-level reminder update coverage.
- Modify `apps/api/src/jobs/autopayWorker.ts` (W1), `apps/api/src/jobs/scheduleRegistry.ts`; create `apps/api/src/jobs/autopayWorker.reminders.test.ts` and `apps/api/src/services/workerRegistry.autopayWorker.test.ts` — dispatch, schedule and registry proof.
- Create `apps/web/src/components/billing/RemindersSettingsSection.tsx` and `apps/web/src/components/billing/RemindersSettingsSection.test.tsx` — controlled inherited fields.
- Modify `apps/web/src/components/billing/PaymentsSettingsTab.tsx` and `apps/web/src/components/billing/OrgPaymentsSettingsSection.tsx` (W2b), plus `apps/web/src/components/billing/PaymentsSettingsTab.test.tsx` (W2b) — shared form composition and existing Save integration.
- Modify `apps/web/src/lib/settingsCatalog.ts` and `apps/web/src/lib/__tests__/settingsPageRegistry.test.ts` — remove the W2b Payments navigation rollout gate.
- Modify `apps/web/src/components/billing/PartnerBillingSettingsPage.tsx` and `apps/web/src/components/billing/OrgBillingSettings.tsx`, plus their `.test.tsx` siblings — unconditional Payments reachability and conditional Autopay.
- Modify `apps/web/src/components/settings/EmailTemplatesTab.tsx` and `apps/web/src/components/settings/EmailTemplatesTab.test.tsx` — reminder editor entries under Billing & payments.
- Modify `apps/web/src/locales/en/billing.json`, `apps/web/src/locales/de-DE/billing.json`, `apps/web/src/locales/es-419/billing.json`, `apps/web/src/locales/fr-CA/billing.json`, `apps/web/src/locales/fr-FR/billing.json`, `apps/web/src/locales/it-IT/billing.json`, `apps/web/src/locales/pt-BR/billing.json`, `apps/web/src/locales/tr-TR/billing.json` — identical new key structure, English fallbacks outside English.
- Create `e2e-tests/tests/autopay-reminders.spec.ts` — real-stack settings smoke.

---

### Task 1: Pure calendar cadence

**Files:** Create `apps/api/src/services/autopay/reminderSweep.ts`; Test/Create `apps/api/src/services/autopay/reminderSweep.test.ts`.
**Interfaces:** Consumes C4's exact input `{ dueDate: string; today: string; beforeDueDays: number; repeatDays: number | null; overdueEveryDays: number; lastSentSeq: number }` · Produces `reminderDueToday(input): { kind: 'payment_reminder' | 'payment_overdue'; seq: number } | null`.

- [ ] **Step 1: Write the failing test** — create the test file:

```ts
import { describe, expect, it } from 'vitest';
import { reminderDueToday } from './reminderSweep';

const input = {
  dueDate: '2026-10-08', today: '2026-10-05', beforeDueDays: 3,
  repeatDays: null, overdueEveryDays: 7, lastSentSeq: 0,
};

describe('reminderDueToday', () => {
  it.each([
    ['2026-10-04', null],
    ['2026-10-05', { kind: 'payment_reminder', seq: 1 }],
    ['2026-10-06', null],
    ['2026-10-08', null],
    ['2026-10-09', null],
    ['2026-10-14', null],
    ['2026-10-15', { kind: 'payment_overdue', seq: 1 }],
    ['2026-10-22', { kind: 'payment_overdue', seq: 2 }],
  ])('evaluates %s with no upcoming repeats', (today, expected) => {
    expect(reminderDueToday({ ...input, today: today as string })).toEqual(expected);
  });
  it.each([
    ['2026-10-01', 1], ['2026-10-03', 2], ['2026-10-05', 3], ['2026-10-07', 4],
  ])('numbers upcoming repeats on %s', (today, seq) => {
    expect(reminderDueToday({ ...input, today, beforeDueDays: 7, repeatDays: 2 }))
      .toEqual({ kind: 'payment_reminder', seq });
  });
  it('does not backfill a missed tick or send on the due date', () => {
    expect(reminderDueToday({ ...input, today: '2026-10-04', beforeDueDays: 7, repeatDays: 2 })).toBeNull();
    expect(reminderDueToday({ ...input, today: input.dueDate, repeatDays: 1 })).toBeNull();
  });
  it('suppresses allocated sequences after retry or cadence edits', () => {
    expect(reminderDueToday({ ...input, lastSentSeq: 1 })).toBeNull();
    expect(reminderDueToday({ ...input, today: '2026-10-15', lastSentSeq: 2 })).toBeNull();
    expect(reminderDueToday({ ...input, today: '2026-10-29', lastSentSeq: 2 }))
      .toEqual({ kind: 'payment_overdue', seq: 3 });
  });
  it.each([
    ['2028-03-01', '2028-02-29'],
    ['2026-11-02', '2026-11-01'],
    ['2027-01-01', '2026-12-31'],
  ])('uses UTC calendar days across %s', (dueDate, today) => {
    expect(reminderDueToday({ ...input, dueDate, today, beforeDueDays: 1 }))
      .toEqual({ kind: 'payment_reminder', seq: 1 });
  });
  it.each([
    { dueDate: '2026-02-30' }, { today: '2026-10-05T00:00:00Z' },
    { beforeDueDays: 0 }, { beforeDueDays: 32 }, { repeatDays: 0 },
    { repeatDays: 1.5 }, { overdueEveryDays: 32 }, { lastSentSeq: -1 },
  ])('rejects corrupt inputs %j', (patch) => {
    expect(() => reminderDueToday({ ...input, ...patch })).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/reminderSweep.test.ts`. Expected: missing module/export, then cadence assertions fail until implementation.
- [ ] **Step 3: Implement** — create the module with this code. The private date helper is reused by the sweep added later in this same file.

```ts
const DAY_MS = 86_400_000;

function utcDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Expected YYYY-MM-DD');
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new RangeError('Invalid calendar date');
  }
  return ms / DAY_MS;
}

export function reminderDueToday(input: {
  dueDate: string; today: string; beforeDueDays: number; repeatDays: number | null;
  overdueEveryDays: number; lastSentSeq: number;
}): { kind: 'payment_reminder' | 'payment_overdue'; seq: number } | null {
  for (const interval of [input.beforeDueDays, input.repeatDays, input.overdueEveryDays]) {
    if (interval !== null && (!Number.isInteger(interval) || interval < 1 || interval > 31)) {
      throw new RangeError('Reminder intervals must be integers in 1–31');
    }
  }
  if (!Number.isSafeInteger(input.lastSentSeq) || input.lastSentSeq < 0) {
    throw new RangeError('Invalid lastSentSeq');
  }
  const delta = utcDay(input.today) - utcDay(input.dueDate);
  let kind: 'payment_reminder' | 'payment_overdue';
  let seq: number;
  if (delta < 0) {
    const elapsed = delta + input.beforeDueDays;
    if (elapsed < 0) return null;
    if (elapsed === 0) seq = 1;
    else {
      if (input.repeatDays === null || elapsed % input.repeatDays !== 0) return null;
      seq = 1 + elapsed / input.repeatDays;
    }
    kind = 'payment_reminder';
  } else {
    if (delta === 0 || delta % input.overdueEveryDays !== 0) return null;
    kind = 'payment_overdue';
    seq = delta / input.overdueEveryDays;
  }
  return seq > input.lastSentSeq ? { kind, seq } : null;
}
```

- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/reminderSweep.test.ts`.
- [ ] **Step 5: Commit** — from the repository root:

```sh
git add apps/api/src/services/autopay/reminderSweep.ts apps/api/src/services/autopay/reminderSweep.test.ts
git commit -m "feat(billing): define deterministic reminder cadence"
```

### Task 2: Reminder catalog and frozen rendering

**Files:** Modify `packages/shared/src/utils/emailTemplates.ts`, `packages/shared/src/utils/emailTemplates.test.ts`, `apps/api/src/services/emailTemplates/defaults.ts`, `apps/api/src/services/autopay/renderBillingNotice.ts` (W1), `apps/api/src/routes/orgs.test.ts`; Create/Test `apps/api/src/services/autopay/renderBillingNotice.reminders.test.ts`.
**Interfaces:** Consumes `renderPartnerEmail(args: RenderPartnerEmailArgs): { subject: string; html: string }`, `partnerEmailCustomFromSettings(settings: unknown, id: EmailTemplateId): PartnerEmailCustom | null`, `htmlToText(html: string): string`, `formatMoney(value: string | number | null | undefined, currency: string, locale?: string): string` · Produces both C6 IDs, their exact business variables, and reminder branches of C4 `renderBillingNotice(kind: BillingNoticeKind, ctx: BillingNoticeContext): Promise<RenderedNotice>`.

- [ ] **Step 1: Write the failing test** — append this catalog test with its existing Vitest imports:

```ts
it.each([
  ['payment_reminder', ['invoice_number', 'amount_due', 'due_date', 'pay_link']],
  ['payment_overdue', ['invoice_number', 'amount_due', 'due_date', 'days_overdue', 'pay_link']],
] as const)('registers the closed %s variable set', (id, businessVars) => {
  expect(EMAIL_TEMPLATE_IDS).toContain(id);
  expect([...varsForEmailTemplate(id)].sort()).toEqual(
    [...businessVars, 'org_name', 'partner_name', 'cta_button'].sort(),
  );
  expect(emailTemplateHasCta(id)).toBe(true);
  expect(emailTemplateFieldDefaults(id).html).toContain('{{amount_due}}');
  expect(emailTemplateFieldDefaults(id).html).not.toContain('PDF');
});
```

Add `emailTemplateFieldDefaults`, `emailTemplateHasCta` and `varsForEmailTemplate` to the test's existing shared-module imports if absent. Extend the existing exact catalog-array assertion by inserting the two IDs after all currently landed IDs; do not remove older IDs.

Create the renderer test:

```ts
import { describe, expect, it } from 'vitest';
import { renderBillingNotice } from './renderBillingNotice';

const ctx = {
  partnerId: '11111111-1111-4111-8111-111111111111', orgId: '22222222-2222-4222-8222-222222222222',
  frozen: { amount: '25.05', currency: 'EUR', dueDate: '2026-10-08', daysOverdue: 7 }, mandatory: {},
  data: {
    invoiceNumber: 'INV-1', balance: '25.05', currency: 'EUR', dueDate: '2026-10-08',
    daysOverdue: 7, payLink: 'https://portal.example.test/invoice/opaque-token',
    partnerName: 'Example MSP', orgName: 'Example Org', partnerSettings: {},
  },
};

describe('reminder rendering', () => {
  it.each(['payment_reminder', 'payment_overdue'] as const)('renders %s with balance and invoice currency', async (kind) => {
    const rendered = await renderBillingNotice(kind, ctx);
    expect(rendered.html).toContain('25.05');
    expect(rendered.html).toContain('€');
    expect(rendered.html).not.toContain('100.00');
    expect(rendered.html).toContain(ctx.data.payLink);
    expect(rendered.text).toContain(ctx.data.payLink);
    expect(rendered.text).toContain(kind === 'payment_overdue' ? 'was due by' : 'is due by');
    expect(rendered.frozen).toEqual({
      amount: '25.05', currency: 'EUR', dueDate: '2026-10-08', daysOverdue: 7,
    });
  });
  it('renders partner overrides safely and preserves the CTA if the body omits it', async () => {
    const rendered = await renderBillingNotice('payment_reminder', {
      ...ctx, data: { ...ctx.data, invoiceNumber: '<img src=x onerror=bad()>',
        partnerSettings: { emailTemplates: { payment_reminder: {
          subject: '{{invoice_number}}\r\nReminder', heading: 'Invoice', buttonLabel: 'Pay',
          html: '<p>Custom {{amount_due}} {{invoice_number}}</p>',
        } } },
      },
    });
    expect(rendered.subject).not.toMatch(/[\r\n]/);
    expect(rendered.html).toContain('&lt;img');
    expect(rendered.html).not.toContain('<img src=x');
    expect(rendered.html).toContain(ctx.data.payLink);
    expect(rendered.text).toContain('Custom');
  });
  it('refuses a non-HTTP pay link instead of freezing an unsafe email', async () => {
    await expect(renderBillingNotice('payment_overdue', {
      ...ctx, data: { ...ctx.data, payLink: 'javascript:alert(1)' },
    })).rejects.toThrow('Invalid reminder pay URL');
  });
});
```

Inside the existing `describe('PATCH /orgs/partners/me — emailTemplates', ...)` in `orgs.test.ts`, use its verified local helpers:

```ts
it.each(['payment_reminder', 'payment_overdue'])('accepts %s', async (id) => {
  setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
  mockCurrentPartnerSelect({});
  const captured = mockUpdateCapture();
  const fields = {
    subject: 'Invoice {{invoice_number}}', heading: 'Payment reminder',
    buttonLabel: 'Pay invoice', html: '<p>{{amount_due}} by {{due_date}}</p>',
  };
  const response = await patchMe({ settings: { emailTemplates: { [id]: fields } } });
  expect(response.status).toBe(200);
  expect(captured().settings.emailTemplates[id]).toEqual(fields);
});
```

- [ ] **Step 2: Run it, expect FAIL** — run each command from the repository root:

```sh
(cd packages/shared && npx vitest run src/utils/emailTemplates.test.ts)
(cd apps/api && npx vitest run src/services/autopay/renderBillingNotice.reminders.test.ts src/routes/orgs.test.ts)
```

Expected: missing IDs/registered renderer and route validation 400 before the shared catalog addition.

- [ ] **Step 3: Implement** — make these exact additive entries, preserving every W2 member. In `emailTemplates.ts`, append `'payment_reminder'` and `'payment_overdue'` to `EMAIL_TEMPLATE_IDS`; append `'amount_due' | 'pay_link' | 'days_overdue'` to `EmailTemplateVarKey`. Add these map entries:

```ts
// VARS_BY_ID
payment_reminder: ['org_name', 'partner_name', 'invoice_number', 'amount_due', 'due_date', 'pay_link', 'cta_button'],
payment_overdue: ['org_name', 'partner_name', 'invoice_number', 'amount_due', 'due_date', 'days_overdue', 'pay_link', 'cta_button'],
// LABEL_BY_ID
payment_reminder: 'Payment reminder',
payment_overdue: 'Overdue payment reminder',
// HAS_CTA_BY_ID
payment_reminder: true,
payment_overdue: true,
// FIELD_DEFAULTS_BY_ID
payment_reminder: {
  subject: 'Payment reminder: invoice {{invoice_number}}',
  heading: 'Payment reminder', buttonLabel: 'View & pay invoice',
  html: `<p>This is a reminder about invoice <strong>{{invoice_number}}</strong> with a total payable of <strong>{{amount_due}}</strong>. Payment is due by <strong>{{due_date}}</strong>.</p>
<p>{{cta_button}}</p>`,
},
payment_overdue: {
  subject: 'OVERDUE payment reminder: invoice {{invoice_number}}',
  heading: 'Overdue payment reminder', buttonLabel: 'View & pay invoice',
  html: `<p>This is an OVERDUE reminder about invoice <strong>{{invoice_number}}</strong> with a total payable of <strong>{{amount_due}}</strong>. Payment was due by <strong>{{due_date}}</strong>.</p>
<p>This invoice is {{days_overdue}} days overdue.</p>
<p>{{cta_button}}</p>`,
},
```

Add exhaustive entries to `defaults.ts`:

```ts
// PREHEADER_BY_ID
payment_reminder: 'A payment is coming due.',
payment_overdue: 'An invoice payment is overdue.',
// FOOTER_BY_ID
payment_reminder: undefined,
payment_overdue: undefined,
```

In W1 `renderBillingNotice.ts`, retain the context and registry exactly as planned by W1. Add these imports and the complete private renderer; register both kinds once at module initialization. No registry side-effect import is required in the worker because the existing sweep imports `renderBillingNotice` itself.

```ts
import { z } from 'zod';
import { formatMoney } from '@breeze/shared';
import { htmlToText } from '../inboundEmail/htmlToText';
import { partnerEmailCustomFromSettings } from '../emailTemplates/renderPartnerEmail';

const reminderRenderData = z.object({
  invoiceNumber: z.string(), balance: z.string(), currency: z.string(), dueDate: z.string(),
  daysOverdue: z.number().int().nonnegative(), payLink: z.string(),
  partnerName: z.string(), orgName: z.string(), partnerSettings: z.unknown(),
});
async function renderReminder(
  kind: 'payment_reminder' | 'payment_overdue', ctx: Parameters<BillingNoticeRenderer>[0],
): ReturnType<BillingNoticeRenderer> {
  const r = reminderRenderData.parse(ctx.data);
  let url: URL;
  try { url = new URL(r.payLink); } catch { throw new Error('Invalid reminder pay URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid reminder pay URL');
  }
  const email: RenderPartnerEmailArgs = {
    id: kind, custom: partnerEmailCustomFromSettings(r.partnerSettings, kind),
    brandName: r.partnerName, ctaUrl: r.payLink,
    vars: {
      org_name: r.orgName, partner_name: r.partnerName, invoice_number: r.invoiceNumber,
      amount_due: formatMoney(r.balance, r.currency, 'en-US'), due_date: r.dueDate,
      days_overdue: String(r.daysOverdue), pay_link: r.payLink,
    },
  };
  return { email, text: `${htmlToText(renderPartnerEmail(email).html)}\n\n${r.payLink}` };
}
registerBillingNoticeRenderer('payment_reminder', ctx => renderReminder('payment_reminder', ctx));
registerBillingNoticeRenderer('payment_overdue', ctx => renderReminder('payment_overdue', ctx));
```

`RenderPartnerEmailArgs`, `renderPartnerEmail`, `BillingNoticeContext`, `BillingNoticeRenderer` and `registerBillingNoticeRenderer` are the W1 module's existing planned imports/types/functions. The W1 dispatcher preserves `ctx.frozen`; Task 3 supplies that complete snapshot. `orgs.ts` needs no production edit because its shared-ID validator already accepts both entries. Billing-stream/reply-to behavior remains W1's dispatcher contract.

- [ ] **Step 4: Run it, expect PASS**:

```sh
(cd packages/shared && npx vitest run src/utils/emailTemplates.test.ts)
(cd apps/api && npx vitest run src/services/autopay/renderBillingNotice.reminders.test.ts src/services/emailTemplates/renderPartnerEmail.test.ts src/services/emailTemplates/defaults.test.ts src/routes/orgs.test.ts)
```

- [ ] **Step 5: Commit**:

```sh
git add packages/shared/src/utils/emailTemplates.ts packages/shared/src/utils/emailTemplates.test.ts apps/api/src/services/emailTemplates/defaults.ts apps/api/src/services/autopay/renderBillingNotice.ts apps/api/src/services/autopay/renderBillingNotice.reminders.test.ts apps/api/src/routes/orgs.test.ts
git commit -m "feat(billing): render editable payment reminders"
```

### Task 3: Paged reminder sweep and retry isolation

**Files:** Modify `apps/api/src/services/autopay/reminderSweep.ts`; Test/Modify `apps/api/src/services/autopay/reminderSweep.test.ts`; Create/Test `apps/api/src/services/autopay/reminderSweep.integration.test.ts`; Modify `apps/api/vitest.integration.config.ts`, `apps/api/vitest.config.ts`.
**Interfaces:** Consumes `resolveBillingPaymentSettings(db: Tx, args: { partnerId: string; orgId?: string | null }): Promise<EffectiveBillingPaymentSettings>`; `enqueueBillingNotice(tx: Tx, input: { orgId: string; partnerId: string; invoiceId?: string; enrollmentId?: string; kind: BillingNoticeKind; seq: number; dedupeKey: string; toEmail: string; rendered: RenderedNotice }): Promise<{ id: string; created: boolean }>`; `renderBillingNotice(kind: BillingNoticeKind, ctx: BillingNoticeContext): Promise<RenderedNotice>`; `getOrMintInvoiceLink(row: LinkColumns): Promise<InvoiceLinkResult>`; `buildPublicInvoiceUrl(token: string): string` · Produces C4 `runInvoiceReminderSweep(now?: Date): Promise<{ enqueued: number }>`.

- [ ] **Step 1: Write the failing test** — add `beforeEach` and `vi` to the existing Vitest import and `runInvoiceReminderSweep` to the module import. Append this code; all mocks are hoist-safe and the query builder is awaitable, matching `.limit().for()` as well as `.limit()`:

```ts
import { PgDialect } from 'drizzle-orm/pg-core';

const mock = vi.hoisted(() => ({
  results: [] as unknown[][], predicates: [] as unknown[], locks: vi.fn(),
  settings: vi.fn(), enqueue: vi.fn(), render: vi.fn(), link: vi.fn(), system: vi.fn(),
}));
vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => { mock.system(); return fn(); },
  db: { select: () => {
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'innerJoin', 'orderBy', 'limit']) chain[method] = () => chain;
    chain.where = (predicate: unknown) => { mock.predicates.push(predicate); return chain; };
    chain.for = (...args: unknown[]) => { mock.locks(...args); return chain; };
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(mock.results.shift() ?? []).then(resolve, reject);
    return chain;
  } },
}));
vi.mock('./billingPaymentSettings', () => ({ resolveBillingPaymentSettings: mock.settings }));
vi.mock('./noticeOutbox', () => ({ enqueueBillingNotice: mock.enqueue }));
vi.mock('./renderBillingNotice', () => ({ renderBillingNotice: mock.render }));
vi.mock('../invoiceLinkToken', () => ({
  getOrMintInvoiceLink: mock.link,
  buildPublicInvoiceUrl: (token: string) => `https://portal.example.test/invoice/${token}`,
}));
vi.mock('../invoicePdf', () => ({
  resolveBillingEmail: (raw: { email?: string } | null) => raw?.email ?? null,
}));

const org = {
  id: '11111111-1111-4111-8111-111111111111',
  partnerId: '22222222-2222-4222-8222-222222222222',
  name: 'Org', partnerName: 'MSP', partnerSettings: {}, billingContact: { email: 'billing@example.test' },
};
const invoice = {
  id: '33333333-3333-4333-8333-333333333333', orgId: org.id, partnerId: org.partnerId,
  dueDate: '2026-10-08', invoiceNumber: 'INV-1', balance: '25.05', currencyCode: 'EUR',
};
const now = new Date('2026-10-05T06:18:00Z');
function seedMock(rows = [invoice], maxSeq = 0) {
  mock.results.push([org], rows.map(({ id }) => ({ id })));
  for (const row of rows) mock.results.push([row], [{ seq: maxSeq }]);
  mock.results.push([], []); // final invoice page, final org page
}

describe('runInvoiceReminderSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mock.results.length = 0; mock.predicates.length = 0;
    mock.settings.mockResolvedValue({
      remindersEnabled: { value: true, source: 'partner' },
      reminderBeforeDueDays: { value: 3, source: 'default' },
      reminderRepeatDays: { value: null, source: 'default' },
      overdueReminderEveryDays: { value: 7, source: 'default' },
    });
    mock.enqueue.mockResolvedValue({ id: 'outbox', created: true });
    mock.render.mockResolvedValue({ subject: 'Reminder', html: '<p>Reminder</p>', text: 'Reminder', frozen: {} });
    mock.link.mockResolvedValue({ token: 'opaque', expiresAt: new Date('2030-01-01'), origin: 'minted' });
  });
  it('resolves once per org and enqueues both partial balances', async () => {
    seedMock([invoice, { ...invoice, id: '44444444-4444-4444-8444-444444444444' }]);
    await expect(runInvoiceReminderSweep(now)).resolves.toEqual({ enqueued: 2 });
    expect(mock.settings).toHaveBeenCalledTimes(1);
    expect(mock.settings).toHaveBeenCalledWith(expect.anything(), { partnerId: org.partnerId, orgId: org.id });
    expect(mock.locks).toHaveBeenCalledWith('update');
    expect(mock.system.mock.calls.length).toBeGreaterThan(2);
    expect(mock.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: org.id, partnerId: org.partnerId, invoiceId: invoice.id,
      kind: 'payment_reminder', seq: 1, toEmail: 'billing@example.test',
      dedupeKey: `invoice:${invoice.id}:payment_reminder:1`,
    }));
    expect(mock.render).toHaveBeenCalledWith('payment_reminder', expect.objectContaining({
      data: expect.objectContaining({ balance: '25.05', currency: 'EUR' }),
    }));
  });
  it('compiles open-AR, lifecycle, balance and all active-schedule exclusions without a rollout gate', async () => {
    seedMock(); await runInvoiceReminderSweep(now);
    const dialect = new PgDialect();
    const queries = mock.predicates.map((where) => dialect.sqlToQuery(where as Parameters<PgDialect['sqlToQuery']>[0]));
    const text = queries.map(q => q.sql).join('\n');
    const params = queries.flatMap(q => q.params);
    expect(text).toContain('automation_eligible_org');
    expect(text).toContain("IN ('sent','partially_paid','overdue')");
    expect(text).toContain('invoice_autopay_schedules');
    expect(text).toMatch(/NOT EXISTS/i);
    expect(text).toContain('balance');
    for (const state of ['awaiting_notice', 'scheduled', 'collecting', 'retry_scheduled']) {
      expect(params).toContain(state);
    }
    expect(text).not.toContain('autopay_enabled');
  });
  it('counts conflict insertion as zero and does not count an allocated sequence again', async () => {
    seedMock(); mock.enqueue.mockResolvedValue({ id: 'existing', created: false });
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0 });
    mock.enqueue.mockClear(); seedMock([invoice], 1);
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0 });
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it('skips a disabled override and a missing contact without minting links', async () => {
    mock.results.push([org], []);
    mock.settings.mockResolvedValueOnce({ remindersEnabled: { value: false, source: 'org' } });
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0 });
    mock.results.push([{ ...org, billingContact: null }], []);
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0 });
    mock.results.push([{ ...org, billingContact: { email: '@' } }], []);
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0 });
    expect(mock.link).not.toHaveBeenCalled();
  });
  it('rechecks after a payment removes the locked candidate', async () => {
    mock.results.push([org], [{ id: invoice.id }], [], [], []);
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0 });
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it('continues after a failed invoice, then rejects for a safe job retry', async () => {
    seedMock([invoice, { ...invoice, id: '44444444-4444-4444-8444-444444444444' }]);
    mock.enqueue.mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(runInvoiceReminderSweep(now)).rejects.toThrow('Invoice reminder sweep failed');
    expect(mock.enqueue).toHaveBeenCalledTimes(2);
  });
  it('handles an empty fleet', async () => {
    mock.results.push([]);
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0 });
    expect(mock.settings).not.toHaveBeenCalled();
  });
});
```

Still in Step 1, create `reminderSweep.integration.test.ts` with this complete real-DB fixture and concurrency/dispatch test. Only the mail transport is mocked; `getEmailService`/`EmailService.sendEmail` are the existing boundary in `apps/api/src/services/email.ts`. The standard integration setup owns cleanup.

```ts
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  partners, organizations, invoices, billingPaymentSettings,
  orgAutopayEnrollments, invoiceAutopaySchedules, billingNoticeOutbox, stripeConnectAccounts,
} from '../../db/schema';
import { runInvoiceReminderSweep } from './reminderSweep';
import { dispatchPendingBillingNotices } from './noticeOutbox';
const { send } = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../email', () => ({ getEmailService: () => ({ sendEmail: send }) }));
beforeEach(() => send.mockClear());

async function fixture() {
  return withSystemDbAccessContext(async () => {
    const suffix = randomUUID();
    const [partner] = await db.insert(partners).values({
      name: 'Reminder Lab', slug: `reminder-${suffix}`, type: 'msp', plan: 'pro',
      status: 'active', currencyCode: 'USD', autopayEnabled: false,
    }).returning();
    await db.insert(billingPaymentSettings).values({
      partnerId: partner!.id, orgId: null, remindersEnabled: true,
      reminderBeforeDueDays: 3, reminderRepeatDays: 1, overdueReminderEveryDays: 7,
    });
    const [connection] = await db.insert(stripeConnectAccounts).values({
      partnerId: partner!.id, stripeAccountId: `acct_${suffix}`, apiKey: 'enc:synthetic',
      status: 'connected', livemode: false,
    }).returning();
    const created: { id: string; orgId: string; label: string }[] = [];
    const cases = [
      'sent', 'partially_paid', 'overdue', 'archived', 'purging', 'merging',
      'disabled', 'missing-contact', 'paid', 'void', 'zero', 'null-date',
      'awaiting_notice', 'scheduled', 'collecting', 'retry_scheduled',
      'failed', 'action_required', 'skipped_by_client',
    ];
    for (const label of cases) {
      const lifecycle = ['archived', 'purging', 'merging'].includes(label);
      const [org] = await db.insert(organizations).values({
        partnerId: partner!.id, currencyCode: 'EUR', name: label, slug: `${label}-${suffix}`,
        status: lifecycle ? label as 'archived' | 'purging' | 'merging' : 'active',
        billingContact: label === 'missing-contact' ? null : { email: `${label}@example.test` },
      }).returning();
      if (label === 'disabled') await db.insert(billingPaymentSettings).values({
        orgId: org!.id, partnerId: null, remindersEnabled: false,
      });
      const [invoice] = await db.insert(invoices).values({
        partnerId: partner!.id, orgId: org!.id, invoiceNumber: `INV-${created.length}`,
        currencyCode: 'EUR', issueDate: '2026-09-01',
        dueDate: label === 'null-date' ? null : label === 'overdue' ? '2026-09-28' : '2026-10-08',
        status: ['sent', 'partially_paid', 'overdue', 'paid', 'void'].includes(label)
          ? label as 'sent' | 'partially_paid' | 'overdue' | 'paid' | 'void' : 'sent',
        subtotal: '100.00', total: '100.00',
        amountPaid: label === 'partially_paid' ? '74.95' : ['zero', 'paid'].includes(label) ? '100.00' : '0.00',
        balance: ['zero', 'paid'].includes(label) ? '0.00' : label === 'partially_paid' ? '25.05' : '100.00',
      }).returning();
      if (['awaiting_notice', 'scheduled', 'collecting', 'retry_scheduled', 'failed', 'action_required', 'skipped_by_client'].includes(label)) {
        const [enrollment] = await db.insert(orgAutopayEnrollments).values({
          partnerId: partner!.id, orgId: org!.id, status: 'requested', generation: 1,
          stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId,
        }).returning();
        await db.insert(invoiceAutopaySchedules).values({
          orgId: org!.id, invoiceId: invoice!.id, enrollmentId: enrollment!.id,
          enrollmentGeneration: 1, eligible: true, collectOn: '2026-10-08', termsSnapshot: {},
          state: label as 'awaiting_notice' | 'scheduled' | 'collecting' | 'retry_scheduled' | 'failed' | 'action_required' | 'skipped_by_client',
        });
      }
      created.push({ id: invoice!.id, orgId: org!.id, label });
    }
    return { created, partnerId: partner!.id };
  });
}

describe('invoice reminder sweep against PostgreSQL', () => {
  it('allocates exactly one outbox row per kind/seq across concurrent sweeps', async () => {
    const f = await fixture();
    const now = new Date('2026-10-05T06:18:00Z');
    // Separate connections/transactions: never put Promise.all inside one system scope.
    const results = await Promise.all([runInvoiceReminderSweep(now), runInvoiceReminderSweep(now)]);
    expect(results.reduce((sum, result) => sum + result.enqueued, 0)).toBe(6);
    const rows = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox)
      .where(inArray(billingNoticeOutbox.invoiceId, f.created.map(row => row.id))));
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map(row => row.dedupeKey)).size).toBe(6);
    const sentLabels = rows.map(row => f.created.find(i => i.id === row.invoiceId)!.label).sort();
    expect(sentLabels).toEqual(['action_required', 'failed', 'overdue', 'partially_paid', 'sent', 'skipped_by_client']);
    for (const row of rows) {
      expect(row.seq).toBe(1);
      expect(row.dedupeKey).toBe(`invoice:${row.invoiceId}:${row.kind}:1`);
      expect(row.toEmail).toBe(`${f.created.find(i => i.id === row.invoiceId)!.label}@example.test`);
      expect(row.status).toBe('pending');
    }
    const partial = rows.find(row => row.invoiceId === f.created.find(i => i.label === 'partially_paid')!.id)!;
    expect(partial.rendered).toMatchObject({ frozen: { amount: '25.05', currency: 'EUR' } });
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0 });

    // Pending/failed are already allocated, even though not yet sent.
    await withSystemDbAccessContext(() => db.update(billingNoticeOutbox).set({ status: 'failed' })
      .where(eq(billingNoticeOutbox.id, partial.id)));
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0 });
    await withSystemDbAccessContext(() => db.update(billingNoticeOutbox).set({ status: 'pending' })
      .where(eq(billingNoticeOutbox.id, partial.id)));
    const dispatched = await Promise.all([
      dispatchPendingBillingNotices(new Date(Date.now() + 1000)),
      dispatchPendingBillingNotices(new Date(Date.now() + 1000)),
    ]);
    expect(dispatched.reduce((sum, result) => sum + result.sent, 0)).toBe(6);
    expect(send).toHaveBeenCalledTimes(6);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'billing.notice' }));
    await dispatchPendingBillingNotices(new Date(Date.now() + 1000));
    expect(send).toHaveBeenCalledTimes(6);

    const next = await Promise.all([
      runInvoiceReminderSweep(new Date('2026-10-06T06:18:00Z')),
      runInvoiceReminderSweep(new Date('2026-10-06T06:18:00Z')),
    ]);
    expect(next.reduce((sum, result) => sum + result.enqueued, 0)).toBe(5);
    const second = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox)
      .where(eq(billingNoticeOutbox.seq, 2)));
    expect(second).toHaveLength(5);
    expect(second.every(row => row.kind === 'payment_reminder')).toBe(true);
    await dispatchPendingBillingNotices(new Date(Date.now() + 1000));
    expect(send).toHaveBeenCalledTimes(11);
  });
  it('stops allocating after payment', async () => {
    const f = await fixture();
    await runInvoiceReminderSweep(new Date('2026-10-05T06:18:00Z'));
    await withSystemDbAccessContext(() => db.update(invoices)
      .set({ status: 'paid', amountPaid: '100.00', balance: '0.00' })
      .where(inArray(invoices.id, f.created.map(row => row.id))));
    expect(await runInvoiceReminderSweep(new Date('2026-10-06T06:18:00Z'))).toEqual({ enqueued: 0 });
  });
});
```

Register the new test as test scaffolding before running red. Add the following literal path to `test.include` in `apps/api/vitest.integration.config.ts` and `test.exclude` in `apps/api/vitest.config.ts` (omit the duplicate if W1 already owns the directory with an integration glob):

```ts
'src/services/autopay/reminderSweep.integration.test.ts',
```

- [ ] **Step 2: Run it, expect FAIL** — before adding the sweep implementation:

```sh
(cd apps/api && npx vitest run src/services/autopay/reminderSweep.test.ts)
pnpm test-stack up
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/reminderSweep.integration.test.ts)
```

Expected: missing `runInvoiceReminderSweep`; neither mock nor real-DB assertions can pass until the implementation exists.
- [ ] **Step 3: Implement** — keep Task 1's evaluator; prepend these imports and append the remaining code to `reminderSweep.ts`:

```ts
import { and, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { invoices, organizations, partners, invoiceAutopaySchedules, billingNoticeOutbox } from '../../db/schema';
import { sqlOpenAr } from '../../db/schema/invoices';
import { buildAutomationEligibleOrgPredicate } from '../tenantStatus';
import { resolveBillingEmail } from '../invoicePdf';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl } from '../invoiceLinkToken';
import { resolveBillingPaymentSettings } from './billingPaymentSettings';
import { renderBillingNotice } from './renderBillingNotice';
import { enqueueBillingNotice } from './noticeOutbox';

const ACTIVE_SCHEDULES = ['awaiting_notice', 'scheduled', 'collecting', 'retry_scheduled'] as const;
const ORG_PAGE = 100;
const INVOICE_PAGE = 250;

function system<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}
function invoiceCandidate() {
  return and(
    sqlOpenAr(invoices), gt(invoices.balance, '0'), isNotNull(invoices.dueDate),
    buildAutomationEligibleOrgPredicate(invoices.orgId),
    sql`NOT EXISTS (
      SELECT 1 FROM ${invoiceAutopaySchedules}
      WHERE ${invoiceAutopaySchedules.invoiceId} = ${invoices.id}
        AND ${invoiceAutopaySchedules.orgId} = ${invoices.orgId}
        AND ${inArray(invoiceAutopaySchedules.state, [...ACTIVE_SCHEDULES])}
    )`,
  );
}

export async function runInvoiceReminderSweep(now = new Date()): Promise<{ enqueued: number }> {
  const today = now.toISOString().slice(0, 10);
  utcDay(today);
  let orgCursor: string | undefined;
  let enqueued = 0;
  const errors: unknown[] = [];
  for (;;) {
    const orgs = await system(() => db.select({
      id: organizations.id, partnerId: organizations.partnerId, name: organizations.name,
      billingContact: organizations.billingContact,
      partnerName: partners.name, partnerSettings: partners.settings,
    }).from(organizations).innerJoin(partners, eq(partners.id, organizations.partnerId))
      .where(and(
        orgCursor ? gt(organizations.id, orgCursor) : undefined,
        buildAutomationEligibleOrgPredicate(organizations.id),
        sql`EXISTS (SELECT 1 FROM ${invoices}
          WHERE ${invoices.orgId} = ${organizations.id} AND ${invoiceCandidate()})`,
      )).orderBy(organizations.id).limit(ORG_PAGE));
    if (orgs.length === 0) break;
    for (const org of orgs) {
      orgCursor = org.id;
      const recipient = resolveBillingEmail(org.billingContact)?.trim();
      if (!recipient || !z.string().email().safeParse(recipient).success) continue;
      try {
        const settings = await system(() => resolveBillingPaymentSettings(db, {
          partnerId: org.partnerId, orgId: org.id,
        }));
        if (!settings.remindersEnabled.value) continue;
        let invoiceCursor: string | undefined;
        for (;;) {
          const ids = await system(() => db.select({ id: invoices.id }).from(invoices).where(and(
            eq(invoices.orgId, org.id), eq(invoices.partnerId, org.partnerId), invoiceCandidate(),
            invoiceCursor ? gt(invoices.id, invoiceCursor) : undefined,
          )).orderBy(invoices.id).limit(INVOICE_PAGE));
          if (ids.length === 0) break;
          for (const { id } of ids) {
            invoiceCursor = id;
            try {
              const created = await system(async () => {
                const [invoice] = await db.select().from(invoices).where(and(
                  eq(invoices.id, id), eq(invoices.orgId, org.id),
                  eq(invoices.partnerId, org.partnerId), invoiceCandidate(),
                )).limit(1).for('update');
                if (!invoice?.dueDate || !invoice.invoiceNumber) return false;
                const cadence = {
                  dueDate: invoice.dueDate, today,
                  beforeDueDays: settings.reminderBeforeDueDays.value,
                  repeatDays: settings.reminderRepeatDays.value,
                  overdueEveryDays: settings.overdueReminderEveryDays.value,
                  lastSentSeq: 0,
                };
                const due = reminderDueToday(cadence);
                if (!due) return false;
                const [history] = await db.select({ seq: sql<number>`coalesce(max(${billingNoticeOutbox.seq}), 0)::int` })
                  .from(billingNoticeOutbox).where(and(
                    eq(billingNoticeOutbox.invoiceId, id), eq(billingNoticeOutbox.orgId, org.id),
                    eq(billingNoticeOutbox.kind, due.kind),
                  )).limit(1);
                if (!reminderDueToday({ ...cadence, lastSentSeq: history?.seq ?? 0 })) return false;
                const link = await getOrMintInvoiceLink(invoice);
                const rendered = await renderBillingNotice(due.kind, {
                  partnerId: org.partnerId, orgId: org.id, mandatory: {},
                  frozen: { amount: invoice.balance, currency: invoice.currencyCode,
                    dueDate: invoice.dueDate, daysOverdue: Math.max(0, utcDay(today) - utcDay(invoice.dueDate)) },
                  data: {
                    invoiceNumber: invoice.invoiceNumber, balance: invoice.balance,
                    currency: invoice.currencyCode, dueDate: invoice.dueDate,
                    daysOverdue: Math.max(0, utcDay(today) - utcDay(invoice.dueDate)),
                    payLink: buildPublicInvoiceUrl(link.token), partnerName: org.partnerName,
                    orgName: org.name, partnerSettings: org.partnerSettings,
                  },
                });
                const result = await enqueueBillingNotice(db, {
                  orgId: org.id, partnerId: org.partnerId, invoiceId: id,
                  kind: due.kind, seq: due.seq, dedupeKey: `invoice:${id}:${due.kind}:${due.seq}`,
                  toEmail: recipient, rendered,
                });
                return result.created;
              });
              if (created) enqueued += 1;
            } catch (error) { errors.push(error); }
          }
        }
      } catch (error) { errors.push(error); }
    }
  }
  if (errors.length) throw new AggregateError(errors, `Invoice reminder sweep failed for ${errors.length} items`);
  return { enqueued };
}
```

The invoice lock serializes concurrent sweep allocation and existing payment updates. It does not claim to serialize arbitrary edits to org settings or lifecycle state: each org's effective settings are a sweep snapshot, and the current automation predicate is checked again for each invoice. Enqueue failure rolls back that invoice's token mint and outbox insert together. Failures are retried by the job; committed neighbors retain their dedupe identity. Reaching a new UTC day does not backfill a missed cadence tick.

- [ ] **Step 4: Run it, expect PASS**:

```sh
(cd apps/api && npx vitest run src/services/autopay/reminderSweep.test.ts)
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/reminderSweep.integration.test.ts)
```

Expected: one durable row and one observed transport call per allocated sequence under these concurrent runs, zero skipped tests. This does not assert delivery exactly-once across an external-send/process-crash gap. Keep the stack only while actively implementing Tasks 4 and 8; otherwise tear it down.
- [ ] **Step 5: Commit**:

```sh
git add apps/api/src/services/autopay/reminderSweep.ts apps/api/src/services/autopay/reminderSweep.test.ts apps/api/src/services/autopay/reminderSweep.integration.test.ts apps/api/vitest.integration.config.ts apps/api/vitest.config.ts
git commit -m "feat(billing): enqueue invoice reminders in scoped batches"
```

### Task 4: Register the real settings inheritance regression

**Files:** Create/Test `apps/api/src/services/autopay/reminderSettings.integration.test.ts`; Modify `apps/api/vitest.integration.config.ts`, `apps/api/vitest.config.ts`.
**Interfaces:** Consumes C4 `updatePartnerPaymentSettings(db: Tx, partnerId: string, patch: PartnerPaymentSettingsPatch, actorUserId: string): Promise<void>`, `updateOrgPaymentSettings(db: Tx, orgId: string, patch: OrgPaymentSettingsPatch, actorUserId: string): Promise<void>`, and `resolveBillingPaymentSettings(db: Tx, args: { partnerId: string; orgId?: string | null }): Promise<EffectiveBillingPaymentSettings>` · Produces registered real-DB coverage of existing W1 reminder updates, source labels, defaults and tenant isolation. The reminder API already exists; no new runtime implementation is required in this regression-only task.

- [ ] **Step 1: Write the failing test** — Create `reminderSettings.integration.test.ts`. W1's API owns validation/auth; this regression exercises its real update functions plus RLS and resolution, without adding a duplicate route. Run W1's app-level route tests in Task 8 as well.

```ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { partners, organizations, users } from '../../db/schema';
import { resolveBillingPaymentSettings, updatePartnerPaymentSettings, updateOrgPaymentSettings } from './billingPaymentSettings';

async function seedSettings() {
  return withSystemDbAccessContext(async () => {
    const suffix = randomUUID();
    const [partner] = await db.insert(partners).values({
      name: 'Settings Lab', slug: `settings-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
    }).returning();
    const [org] = await db.insert(organizations).values({
      partnerId: partner!.id, name: 'Settings Org', slug: `settings-org-${suffix}`, currencyCode: 'USD',
    }).returning();
    const [user] = await db.insert(users).values({
      partnerId: partner!.id, orgId: org!.id, email: `${suffix}@example.test`, name: 'Operator', status: 'active',
    }).returning();
    return { partnerId: partner!.id, orgId: org!.id, userId: user!.id };
  });
}

describe('reminder updates and inheritance', () => {
  it('starts off, updates partner and org independently, and restores inheritance', async () => {
    const f = await seedSettings();
    const read = () => withSystemDbAccessContext(() => resolveBillingPaymentSettings(db, f));
    const initial = await read();
    expect(initial.remindersEnabled).toEqual({ value: false, source: 'default' });
    expect(initial.reminderBeforeDueDays.value).toBe(3);
    expect(initial.reminderRepeatDays.value).toBeNull();
    expect(initial.overdueReminderEveryDays.value).toBe(7);
    await withSystemDbAccessContext(() => updatePartnerPaymentSettings(db, f.partnerId, {
      remindersEnabled: true, reminderBeforeDueDays: 5, reminderRepeatDays: 2, overdueReminderEveryDays: 4,
    }, f.userId));
    const inherited = await read();
    expect(inherited.remindersEnabled).toEqual({ value: true, source: 'partner' });
    expect(inherited.reminderRepeatDays).toEqual({ value: 2, source: 'partner' });
    await withSystemDbAccessContext(() => updateOrgPaymentSettings(db, f.orgId, {
      remindersEnabled: false, reminderBeforeDueDays: 1, reminderRepeatDays: 3, overdueReminderEveryDays: 31,
    }, f.userId));
    const overridden = await read();
    expect(overridden.remindersEnabled).toEqual({ value: false, source: 'org' });
    expect(overridden.reminderBeforeDueDays).toEqual({ value: 1, source: 'org' });
    expect(overridden.reminderRepeatDays).toEqual({ value: 3, source: 'org' });
    expect(overridden.overdueReminderEveryDays).toEqual({ value: 31, source: 'org' });
    await withSystemDbAccessContext(() => updateOrgPaymentSettings(db, f.orgId, {
      remindersEnabled: null, reminderBeforeDueDays: null, reminderRepeatDays: null, overdueReminderEveryDays: null,
    }, f.userId));
    expect((await read()).reminderRepeatDays).toEqual({ value: 2, source: 'partner' });
    expect((await read()).remindersEnabled).toEqual({ value: true, source: 'partner' });
    const orgRead = await withDbAccessContext({
      scope: 'organization', orgId: f.orgId, userId: f.userId, currentPartnerId: f.partnerId,
      accessibleOrgIds: [f.orgId], accessiblePartnerIds: [],
    }, () => resolveBillingPaymentSettings(db, f));
    expect(orgRead.reminderBeforeDueDays).toEqual({ value: 5, source: 'partner' });
    await withSystemDbAccessContext(() => updatePartnerPaymentSettings(db, f.partnerId, {
      reminderRepeatDays: null,
    }, f.userId));
    expect((await read()).reminderRepeatDays.value).toBeNull();
  });
  it('cannot write another partner org through an org-scoped update', async () => {
    const a = await seedSettings(); const b = await seedSettings();
    await withDbAccessContext({
      scope: 'organization', orgId: a.orgId, userId: a.userId, currentPartnerId: a.partnerId,
      accessibleOrgIds: [a.orgId], accessiblePartnerIds: [],
    }, async () => {
      await expect(updateOrgPaymentSettings(db, b.orgId, { remindersEnabled: true }, a.userId))
        .rejects.toThrow();
    });
    const after = await withSystemDbAccessContext(() => resolveBillingPaymentSettings(db, b));
    expect(after.remindersEnabled.value).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — with the Task 3 test stack running:

```sh
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/reminderSettings.integration.test.ts
```

Expected before runner registration: `No test files found` (exit 1). This is a discovery failure, not a claim that the already-shipped W1 resolver should fail. If W1 already registered an autopay integration glob, the regression should pass immediately; record that honestly and do not break correct code to manufacture red.

- [ ] **Step 3: Implement** — register this exact path in integration `test.include` and unit `test.exclude` unless an existing W1 glob already owns it:

```ts
'src/services/autopay/reminderSettings.integration.test.ts',
```

The full test code above is the only new behavior in this task. W1's real resolver remains the single implementation. A failing value/source/isolation assertion blocks W03 until corrected in the W1 prerequisite; never bypass RLS or weaken the assertion.

- [ ] **Step 4: Run it, expect PASS**:

```sh
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/reminderSettings.integration.test.ts
```

Expected: the file executes, both tests pass, zero skips.

- [ ] **Step 5: Commit**:

```sh
git add apps/api/src/services/autopay/reminderSettings.integration.test.ts apps/api/vitest.integration.config.ts apps/api/vitest.config.ts
git commit -m "test(billing): prove reminder settings inheritance"
```

### Task 5: Schedule and register the reminder job

**Files:** Modify `apps/api/src/jobs/autopayWorker.ts` (W1), `apps/api/src/jobs/scheduleRegistry.ts`; Create/Test `apps/api/src/jobs/autopayWorker.reminders.test.ts`, `apps/api/src/services/workerRegistry.autopayWorker.test.ts`. Verify existing `apps/api/src/services/workerRegistry.ts`, `apps/api/src/jobs/workerReadinessManifest.ts`, `apps/api/src/worker.ts` without duplicate registration.
**Interfaces:** Consumes `runInvoiceReminderSweep(now?: Date): Promise<{ enqueued: number }>` and `jobSchedule(key: JobScheduleKey): string` · Produces job `reminder-sweep` on existing queue `autopay-jobs`, scheduled by `invoice-reminder-sweep` at `18 6 * * *`; private worker branch `processReminderSweep(): Promise<{ enqueued: number }>`.

- [ ] **Step 1: Write the failing test** — create the worker test. The lifecycle export names are the explicit W1 precondition above. Preserve W2's worker mocks if its card-expiry module has import-time dependencies.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  sweep: vi.fn(), add: vi.fn(), repeat: vi.fn(), remove: vi.fn(), close: vi.fn(),
  processor: null as null | ((job: { data: { type: string } }) => Promise<unknown>),
  queueNames: [] as string[], workerNames: [] as string[],
}));
vi.mock('../services/autopay/reminderSweep', () => ({ runInvoiceReminderSweep: mocks.sweep }));
vi.mock('../services/redis', async original => ({
  ...(await original<typeof import('../services/redis')>()), getBullMQConnection: () => ({}),
}));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('bullmq', () => ({
  Queue: class {
    constructor(name: string) { mocks.queueNames.push(name); }
    add = mocks.add; getRepeatableJobs = mocks.repeat; removeRepeatableByKey = mocks.remove; close = mocks.close;
  },
  Worker: class {
    constructor(name: string, processor: typeof mocks.processor) {
      mocks.workerNames.push(name); mocks.processor = processor;
    }
    on = vi.fn().mockReturnThis(); close = mocks.close;
  },
}));
import { initializeAutopayWorkers, shutdownAutopayWorkers } from './autopayWorker';
import { jobSchedule } from './scheduleRegistry';

beforeEach(() => {
  vi.clearAllMocks(); mocks.queueNames.length = 0; mocks.workerNames.length = 0;
  mocks.repeat.mockResolvedValue([]); mocks.add.mockResolvedValue({ id: 'job' });
  mocks.close.mockResolvedValue(undefined); mocks.sweep.mockResolvedValue({ enqueued: 2 });
});
describe('reminder job', () => {
  it('registers 06:18 on autopay-jobs and routes the actual worker processor', async () => {
    try {
      await initializeAutopayWorkers();
      expect(mocks.queueNames).toContain('autopay-jobs');
      expect(mocks.workerNames).toContain('autopay-jobs');
      expect(jobSchedule('invoice-overdue-sweep')).toBe('8 6 * * *');
      expect(jobSchedule('invoice-reminder-sweep')).toBe('18 6 * * *');
      expect(mocks.add).toHaveBeenCalledWith('reminder-sweep', { type: 'reminder-sweep' },
        expect.objectContaining({ repeat: { pattern: '18 6 * * *' } }));
      await expect(mocks.processor!({ data: { type: 'reminder-sweep' } })).resolves.toEqual({ enqueued: 2 });
      expect(mocks.sweep).toHaveBeenCalledOnce();
      mocks.sweep.mockRejectedValue(new Error('sweep unavailable'));
      await expect(mocks.processor!({ data: { type: 'reminder-sweep' } })).rejects.toThrow('sweep unavailable');
    } finally { await shutdownAutopayWorkers(); }
  });
});
```

Create the registry proof (verified registry/readiness symbols):

```ts
import { describe, expect, it } from 'vitest';
import { WORKER_REGISTRY } from './workerRegistry';
import { WORKER_READINESS_MANIFEST } from '../jobs/workerReadinessManifest';

describe('autopay reminder worker registration', () => {
  it('has exactly one global worker with lifecycle exports', async () => {
    const entries = WORKER_REGISTRY.filter(row => row.name === 'autopayWorker');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.placement).toBe('global');
    const loaded = await entries[0]!.load();
    expect(typeof loaded.init).toBe('function');
    expect(typeof loaded.shutdown).toBe('function');
  });
  it('is available whenever Redis is available', () => {
    expect(WORKER_READINESS_MANIFEST.find(entry =>
      entry.kind === 'consumers' && entry.initializer === 'autopayWorker',
    )).toMatchObject({ consumers: ['autopayWorker'], requiredWhen: 'redis' });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/jobs/autopayWorker.reminders.test.ts src/services/workerRegistry.autopayWorker.test.ts`. Expected: missing schedule/worker case. W1 registry assertions should already pass.
- [ ] **Step 3: Implement** — insert immediately after the overdue entry in `JOB_SCHEDULES`:

```ts
'invoice-reminder-sweep': '18 6 * * *',
```

Add to W1 `autopayWorker.ts`:

```ts
import { runInvoiceReminderSweep } from '../services/autopay/reminderSweep';

interface ReminderSweepJobData { type: 'reminder-sweep' }

export async function processReminderSweep(): Promise<{ enqueued: number }> {
  return runInvoiceReminderSweep();
}
```

Include `ReminderSweepJobData` in the worker's existing job-data union. On the W2 worker, insert this complete case in `processAutopayJob(data)`'s `switch (data.type)`. If doing API work on W1 before W2, insert `if (job.data.type === 'reminder-sweep') return processReminderSweep();` before its existing notice-dispatch type guard; the W2 integration must preserve it in the common dispatcher:

```ts
case 'reminder-sweep':
  return processReminderSweep();
```

On the W2 worker, add to `initializeAutopayWorkers` after its `const q = getAutopayQueue()` statement and before returning. On a W1-only base, the same block uses its already-created `queue` instead of `q`; these are private local names, not another queue registration:

```ts
await q.add('reminder-sweep', { type: 'reminder-sweep' }, {
  repeat: { pattern: jobSchedule('invoice-reminder-sweep') },
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { count: 10 },
  removeOnFail: { count: 50 },
});
```

Preserve existing notice-dispatch and card-expiry registrations. Do not introduce a per-partner rollout check or swallow errors. Verify W1's registration is this shape, exactly once:

```ts
// WORKER_REGISTRY in services/workerRegistry.ts (W1-owned)
{
  name: 'autopayWorker', placement: 'global',
  load: async () => {
    const m = await import('../jobs/autopayWorker');
    return { init: m.initializeAutopayWorkers, shutdown: m.shutdownAutopayWorkers };
  },
},
// WORKER_READINESS_MANIFEST in jobs/workerReadinessManifest.ts (W1-owned)
consumers('autopayWorker'),
```

`EXPECTED_WORKER_NAMES` in `workerRegistry.test.ts` and `EXPECTED_NAMES` in `workerEntrypointClosure.contract.test.ts` must already include `'autopayWorker'` at W1's registry position. A missing W1 registration fails the precondition; do not add a second initializer to `worker.ts`, whose `startRegisteredWorkers('worker', …)` already reaches the global entry.

- [ ] **Step 4: Run it, expect PASS**:

```sh
cd apps/api && npx vitest run src/jobs/autopayWorker.reminders.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerRegistry.test.ts src/services/workerRegistry.autopayWorker.test.ts src/services/workerEntrypointClosure.contract.test.ts src/jobs/workerReadinessCoverage.test.ts
```

- [ ] **Step 5: Commit**:

```sh
git add apps/api/src/jobs/autopayWorker.ts apps/api/src/jobs/scheduleRegistry.ts apps/api/src/jobs/autopayWorker.reminders.test.ts apps/api/src/services/workerRegistry.autopayWorker.test.ts
git commit -m "feat(billing): schedule the daily invoice reminder sweep"
```

### Task 6: Controlled reminder settings fields

**Files:** Create `apps/web/src/components/billing/RemindersSettingsSection.tsx`; Create/Test `apps/web/src/components/billing/RemindersSettingsSection.test.tsx`; Modify all eight `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json` files listed individually in the file map.
**Interfaces:** Consumes effective reminder values and sources from C4, plus W2b's existing form draft/Save lifecycle · Produces `ReminderDraft`, `ReminderEffective`, `reminderDraft`, `reminderPatch`, `reminderDraftInvalid`, and default component `RemindersSettingsSection({ scope, value, inherited, onChange, disabled })`. These are local web interfaces, not changes to C3/C4 types. All mutations remain in the parent form's `runAction` Save.

- [ ] **Step 1: Write the failing test**:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import RemindersSettingsSection, {
  reminderDraft, reminderPatch, reminderDraftInvalid, type ReminderEffective,
} from './RemindersSettingsSection';

const inherited: ReminderEffective = {
  remindersEnabled: { value: true, source: 'partner' },
  reminderBeforeDueDays: { value: 3, source: 'partner' },
  reminderRepeatDays: { value: 2, source: 'partner' },
  overdueReminderEveryDays: { value: 7, source: 'default' },
};
describe('RemindersSettingsSection', () => {
  it('keeps explicit false distinct from blank and shows inherited values', () => {
    const value = reminderDraft({ ...inherited, remindersEnabled: { value: false, source: 'org' } }, 'org');
    const onChange = vi.fn();
    render(<I18nextProvider i18n={i18n}><RemindersSettingsSection scope="org" value={value}
      inherited={inherited} onChange={onChange} /></I18nextProvider>);
    expect(screen.getByTestId('autopay-reminders-enabled')).toHaveValue('false');
    expect(screen.getByTestId('autopay-reminders-before')).toHaveAttribute('placeholder', '3');
    expect(screen.getByTestId('autopay-reminders-repeat')).toHaveAttribute('placeholder', '2');
    fireEvent.change(screen.getByTestId('autopay-reminders-enabled'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ ...value, remindersEnabled: '' });
    expect(reminderPatch(value).remindersEnabled).toBe(false);
    expect(reminderPatch({ ...value, remindersEnabled: '' }).remindersEnabled).toBeNull();
    expect(screen.getByTestId('autopay-reminders-repeat-help')).toHaveTextContent('cannot disable');
  });
  it('uses one form save pattern: fields do not send requests or expose a second Save', () => {
    render(<I18nextProvider i18n={i18n}><RemindersSettingsSection scope="partner"
      value={reminderDraft(inherited, 'partner')} inherited={inherited} onChange={vi.fn()} disabled /></I18nextProvider>);
    expect(screen.getByTestId('autopay-reminders-enabled')).toBeDisabled();
    expect(screen.getByTestId('autopay-reminders-before')).toBeDisabled();
    expect(screen.queryByTestId('autopay-reminders-save')).toBeNull();
  });
  it.each(['0', '32', '1.5', '-1', 'NaN'])('rejects an invalid interval %s', (value) => {
    const draft = { ...reminderDraft(inherited, 'org'), reminderBeforeDueDays: value };
    expect(reminderDraftInvalid(draft)).toBe(true);
    expect(() => reminderPatch(draft)).toThrow(RangeError);
  });
  it.each(['', '1', '31'])('accepts blank inheritance or boundary %s', value => {
    const draft = { ...reminderDraft(inherited, 'org'), reminderRepeatDays: value };
    expect(reminderDraftInvalid(draft)).toBe(false);
    expect(reminderPatch(draft).reminderRepeatDays).toBe(value === '' ? null : Number(value));
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/web && npx vitest run src/components/billing/RemindersSettingsSection.test.tsx`. Expected: missing component/helpers.
- [ ] **Step 3: Implement** — create the complete component:

```tsx
import { useTranslation } from 'react-i18next';
import InheritedField from '../shared/InheritedField';

type Source = 'org' | 'partner' | 'default';
type Effective<T> = { value: T; source: Source };
export interface ReminderEffective {
  remindersEnabled: Effective<boolean>;
  reminderBeforeDueDays: Effective<number>;
  reminderRepeatDays: Effective<number | null>;
  overdueReminderEveryDays: Effective<number>;
}
export interface ReminderDraft {
  remindersEnabled: '' | 'true' | 'false';
  reminderBeforeDueDays: string;
  reminderRepeatDays: string;
  overdueReminderEveryDays: string;
}
const dayKeys = ['reminderBeforeDueDays', 'reminderRepeatDays', 'overdueReminderEveryDays'] as const;
export function reminderDraft(effective: ReminderEffective, scope: 'partner' | 'org'): ReminderDraft {
  const own = <T,>(field: Effective<T>) => field.source === scope && field.value !== null ? String(field.value) : '';
  return {
    remindersEnabled: own(effective.remindersEnabled) as ReminderDraft['remindersEnabled'],
    reminderBeforeDueDays: own(effective.reminderBeforeDueDays),
    reminderRepeatDays: own(effective.reminderRepeatDays),
    overdueReminderEveryDays: own(effective.overdueReminderEveryDays),
  };
}
export function reminderDraftInvalid(value: ReminderDraft): boolean {
  return dayKeys.some(key => value[key] !== '' &&
    (!/^\d+$/.test(value[key]) || Number(value[key]) < 1 || Number(value[key]) > 31));
}
export function reminderPatch(value: ReminderDraft) {
  if (reminderDraftInvalid(value)) throw new RangeError('Invalid reminder interval');
  const day = (text: string) => text === '' ? null : Number(text);
  return {
    remindersEnabled: value.remindersEnabled === '' ? null : value.remindersEnabled === 'true',
    reminderBeforeDueDays: day(value.reminderBeforeDueDays),
    reminderRepeatDays: day(value.reminderRepeatDays),
    overdueReminderEveryDays: day(value.overdueReminderEveryDays),
  };
}
export default function RemindersSettingsSection({ scope, value, inherited, onChange, disabled = false }: {
  scope: 'partner' | 'org'; value: ReminderDraft; inherited: ReminderEffective;
  onChange: (value: ReminderDraft) => void; disabled?: boolean;
}) {
  const { t } = useTranslation('billing');
  const fields = [
    ['reminderBeforeDueDays', 'before'], ['reminderRepeatDays', 'repeat'], ['overdueReminderEveryDays', 'overdue'],
  ] as const;
  const source = (key: keyof ReminderEffective) => t(/* i18n-dynamic */ `reminders.sources.${inherited[key].source}`);
  return <section className="space-y-4 rounded-lg border bg-card p-6" data-testid="autopay-reminders-section">
    <h2 className="text-lg font-semibold">{t('reminders.title')}</h2>
    <p className="text-sm text-muted-foreground">{t('reminders.description')}</p>
    <div>
      <label htmlFor={`reminders-${scope}-enabled`} className="text-sm font-medium">{t('reminders.enabled')}</label>
      <select id={`reminders-${scope}-enabled`} data-testid="autopay-reminders-enabled"
        className="mt-1 block rounded-md border bg-background px-3 py-2 text-sm"
        value={value.remindersEnabled} disabled={disabled}
        onChange={event => onChange({ ...value, remindersEnabled: event.target.value as ReminderDraft['remindersEnabled'] })}>
        <option value="">{t('reminders.inherit', {
          value: t(inherited.remindersEnabled.value ? 'reminders.on' : 'reminders.off'), source: source('remindersEnabled'),
        })}</option>
        <option value="true">{t('reminders.on')}</option>
        <option value="false">{t('reminders.off')}</option>
      </select>
    </div>
    <div className="grid gap-4 sm:grid-cols-3">
      {fields.map(([key, id]) => <InheritedField key={key} id={`reminders-${scope}-${id}`}
        data-testid={`autopay-reminders-${id}`} label={t(/* i18n-dynamic */ `reminders.${id}`)} value={value[key]}
        onChange={text => onChange({ ...value, [key]: text })} disabled={disabled}
        inheritedValue={inherited[key].value === null ? t('reminders.noRepeat') : String(inherited[key].value)}
        inheritedSource={source(key)} type="number" min={1} max={31} step="1" />)}
    </div>
    <p className="text-xs text-muted-foreground" data-testid="autopay-reminders-repeat-help">
      {t(scope === 'org' ? 'reminders.orgRepeatHelp' : 'reminders.partnerRepeatHelp')}
    </p>
    <p className="text-xs text-muted-foreground">{t('reminders.cadenceHelp')}</p>
    {reminderDraftInvalid(value) && <p role="alert" className="text-sm text-destructive"
      data-testid="autopay-reminders-validation">{t('reminders.invalid')}</p>}
  </section>;
}
```

Add this exact top-level object to each of the eight billing catalogs, preserving existing keys. English values in the other seven locales are intentional fallbacks and pass the repository's exact-key/interpolation parity test:

```json
"reminders": {
  "title": "Payment reminders",
  "description": "Send reminders to the organization's billing contact for unpaid invoices. Reminders work without automatic payments.",
  "enabled": "Send payment reminders",
  "on": "Enabled",
  "off": "Disabled",
  "inherit": "Use {{source}}: {{value}}",
  "before": "Days before the due date",
  "repeat": "Repeat before due every (days)",
  "overdue": "Remind overdue every (days)",
  "noRepeat": "No repeat",
  "orgRepeatHelp": "Blank inherits the partner setting. You cannot disable only upcoming repeats here when the partner repeats them; disable reminders for this organization to stop all reminders.",
  "partnerRepeatHelp": "Leave the repeat interval blank for one upcoming reminder. Blank in the other fields uses the displayed default.",
  "cadenceHelp": "No reminder is sent on the due date. The first overdue reminder is sent one overdue interval later. Changing dates or intervals does not resend already allocated reminders.",
  "invalid": "Enter whole days from 1 to 31, or leave blank to inherit.",
  "sources": { "org": "organization", "partner": "partner default", "default": "system default" }
}
```

- [ ] **Step 4: Run it, expect PASS**:

```sh
cd apps/web && npx vitest run src/components/billing/RemindersSettingsSection.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts
```

- [ ] **Step 5: Commit**:

```sh
git add apps/web/src/components/billing/RemindersSettingsSection.tsx apps/web/src/components/billing/RemindersSettingsSection.test.tsx apps/web/src/locales/en/billing.json apps/web/src/locales/de-DE/billing.json apps/web/src/locales/es-419/billing.json apps/web/src/locales/fr-CA/billing.json apps/web/src/locales/fr-FR/billing.json apps/web/src/locales/it-IT/billing.json apps/web/src/locales/pt-BR/billing.json apps/web/src/locales/tr-TR/billing.json
git commit -m "feat(web): add inherited reminder cadence fields"
```

### Task 7: Compose Payments shells, inherited API projection and page behavior

**Files:** Modify W2b `apps/api/src/services/autopay/paymentSettingsView.ts` and `apps/api/src/services/autopay/paymentSettingsView.test.ts`, W1 `apps/api/src/index.autopayRoutes.test.ts`, W2b `apps/web/src/components/billing/PaymentsSettingsTab.tsx` and `PaymentsSettingsTab.test.tsx`, W2b `apps/web/src/components/billing/OrgPaymentsSettingsSection.tsx`, page/shell `apps/web/src/components/billing/PartnerBillingSettingsPage.tsx` and its `.test.tsx`, page/shell `apps/web/src/components/billing/OrgBillingSettings.tsx` and its `.test.tsx`, `apps/web/src/lib/settingsCatalog.ts`, `apps/web/src/lib/__tests__/settingsPageRegistry.test.ts`, `apps/web/src/components/settings/EmailTemplatesTab.tsx` and its `.test.tsx`, and the eight billing catalogs; Create/Test `e2e-tests/tests/autopay-reminders.spec.ts`.
**Interfaces:** Consumes W2b's planned `usePaymentSettings(orgId?: string)`, `PaymentSettingsView`, `PaymentValues`, `PaymentFields`, and C7 `{ values, effective, inherited, autopayEnabled }` GET view; consumes Task 6 `ReminderDraft`/`ReminderEffective` helpers · Produces the same settings model with `reminders` and `setReminders`, mounted Reminders modules in both C8 shells, one existing Save per page, and unconditional Payments navigation. No new API route.

- [ ] **Step 1: Write the failing test** — add this standalone block to W2b `PaymentsSettingsTab.test.tsx` using its existing `fetchWithAuth` mock and Vitest/RTL imports. Add `renderHook` and `act` from RTL and import `usePaymentSettings` from the component. Each test supplies a fresh Response.

```tsx
const reminderView = () => {
  const effective = {
    autopayOffsetDays: { value: 0, source: 'default' }, autopayOffsetRule: { value: 'later', source: 'default' },
    autopayCap: { value: { enabled: false }, source: 'default' }, achMode: { value: 'ach_preferred', source: 'default' },
    cardFeeBps: { value: 0, source: 'default' }, achFeeAmount: { value: '0.00', source: 'default' }, feeAttested: false,
    remindersEnabled: { value: false, source: 'default' }, reminderBeforeDueDays: { value: 3, source: 'default' },
    reminderRepeatDays: { value: null, source: 'default' }, overdueReminderEveryDays: { value: 7, source: 'default' },
  };
  return { autopayEnabled: false, effective, inherited: effective, values: {
    autopayOffsetDays: null, autopayOffsetRule: null, autopayCapEnabled: null,
    autopayCapAmount: null, autopayCapCurrency: null, achMode: null,
  } };
};
it('saves reminder-only payload when rollout is off and retains draft after failure', async () => {
  const fetch = vi.mocked(fetchWithAuth);
  fetch.mockImplementation(async (_url, init) => Response.json(init?.method === 'PUT'
    ? { error: 'Save failed' } : reminderView(), { status: init?.method === 'PUT' ? 500 : 200 }));
  const { result } = renderHook(() => usePaymentSettings());
  await waitFor(() => expect(result.current.reminders).not.toBeNull());
  act(() => result.current.setReminders({ ...result.current.reminders!, reminderBeforeDueDays: '9', remindersEnabled: 'false' }));
  await act(async () => { await expect(result.current.save()).rejects.toThrow(); });
  expect(result.current.reminders?.reminderBeforeDueDays).toBe('9');
  const call = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({
    remindersEnabled: false, reminderBeforeDueDays: 9, reminderRepeatDays: null, overdueReminderEveryDays: null,
  });
});
it('does not let a late org-A load overwrite org-B and then save to B', async () => {
  let finishA!: (response: Response) => void;
  const fetch = vi.mocked(fetchWithAuth);
  fetch.mockImplementation(async url => String(url).includes('/orgs/a/')
    ? new Promise<Response>(resolve => { finishA = resolve; }) : Response.json(reminderView()));
  const { result, rerender } = renderHook(({ id }) => usePaymentSettings(id), { initialProps: { id: 'a' } });
  rerender({ id: 'b' });
  await waitFor(() => expect(result.current.reminders).not.toBeNull());
  act(() => result.current.setReminders({ ...result.current.reminders!, reminderBeforeDueDays: '8' }));
  await act(async () => { finishA(Response.json(reminderView())); });
  expect(result.current.reminders?.reminderBeforeDueDays).toBe('8');
});
it('saves blanks as null for an org then displays the inherited partner value', async () => {
  const data = reminderView();
  data.effective.reminderBeforeDueDays = { value: 5, source: 'partner' };
  data.inherited.reminderBeforeDueDays = { value: 5, source: 'partner' };
  const fetch = vi.mocked(fetchWithAuth); fetch.mockImplementation(async () => Response.json(data));
  const { result } = renderHook(() => usePaymentSettings('11111111-1111-4111-8111-111111111111'));
  await waitFor(() => expect(result.current.reminders).not.toBeNull());
  await act(async () => { await result.current.save(); });
  const call = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(JSON.parse(call[1]!.body as string).reminderBeforeDueDays).toBeNull();
  expect(result.current.view?.inherited.reminderBeforeDueDays.value).toBe(5);
});
```

Before running red, extend every existing W2b `PaymentSettingsView` fixture in `PaymentsSettingsTab.test.tsx` with the same four `ReminderEffective` fields in both `effective` and `inherited` (the complete `reminderView()` above supplies the exact values). Preserve its existing raw cap/offset/ACH inputs. Existing enabled-partner Save assertions now expect the old raw autopay fields plus these four reminder patch fields:

```ts
remindersEnabled: null,
reminderBeforeDueDays: null,
reminderRepeatDays: null,
overdueReminderEveryDays: null,
```

Replace W2b's old “fails closed when autopay is disabled” component assertion with: render the complete `reminderView()`; `expect(await screen.findByTestId('autopay-reminders-section')).toBeInTheDocument(); expect(screen.queryByTestId('autopay-settings-section')).toBeNull();`. Add this full test to W1's existing app-level describe block (`m`, `request`, `partnerPath`, `orgPath` are the verified planned helpers in W1's Task 7):

```ts
it('returns reminder inheritance through the app and accepts all reminder fields with rollout off', async () => {
  m.enabled = false;
  const partner = await request(partnerPath);
  expect(partner.status).toBe(200);
  expect((await partner.json()).inherited).toMatchObject({
    remindersEnabled: { value: false, source: 'default' },
    reminderBeforeDueDays: { value: 3, source: 'default' },
    reminderRepeatDays: { value: null, source: 'default' },
    overdueReminderEveryDays: { value: 7, source: 'default' },
  });
  const patch = { remindersEnabled: false, reminderBeforeDueDays: 31, reminderRepeatDays: null, overdueReminderEveryDays: 1 };
  expect((await request(partnerPath, 'PUT', patch)).status).toBe(200);
  expect(m.partnerWrite).toHaveBeenCalledWith(expect.anything(), partnerId, patch, m.auth.user.id);
  expect((await request(orgPath, 'PUT', patch)).status).toBe(200);
  expect(m.orgWrite).toHaveBeenCalledWith(expect.anything(), orgId, patch, m.auth.user.id);
  expect((await request(orgPath, 'PUT', { reminderRepeatDays: 0 })).status).toBe(400);
  expect((await request(partnerPath, 'PUT', { reminderBeforeDueDays: 32 })).status).toBe(400);
});
```

Extend W2b's `settingsPageRegistry.test.ts` Payments assertion to expect the existing `billing-payments` entry with `requiresAutopay` absent (and unchanged `billing:manage` permission). Use this full replacement assertion:

```ts
it('Payments is reachable independently of autopay rollout', () => {
  const entry = SETTINGS_CATALOG.find(entry => entry.id === 'billing-payments');
  expect(entry).toMatchObject({ href: '/settings/billing#payments', requiredPermission: { resource: 'billing', action: 'manage' } });
  expect(entry?.requiresAutopay).toBeUndefined();
});
```

Append to the existing `PartnerBillingSettingsPage.test.tsx` describe block, using its verified `fetchMock`, `json`, `renderPage` and `selectTab` helpers. The inherited object is defined locally so the test is self-contained:

```tsx
it.each([false, true])('mounts Payments when autopayEnabled=%s', async autopayEnabled => {
  const fields = {
    autopayOffsetDays: { value: 0, source: 'default' }, autopayOffsetRule: { value: 'later', source: 'default' },
    autopayCap: { value: { enabled: false }, source: 'default' }, achMode: { value: 'ach_preferred', source: 'default' },
    cardFeeBps: { value: 0, source: 'default' }, achFeeAmount: { value: '0.00', source: 'default' }, feeAttested: false,
    remindersEnabled: { value: false, source: 'default' },
    reminderBeforeDueDays: { value: 3, source: 'default' },
    reminderRepeatDays: { value: null, source: 'default' },
    overdueReminderEveryDays: { value: 7, source: 'default' },
  };
  fetchMock.mockImplementation(async url => {
    if (String(url).endsWith('/billing/payment-settings')) return json({
      effective: fields, inherited: fields, autopayEnabled,
      values: { autopayOffsetDays: null, autopayOffsetRule: null, autopayCapEnabled: null, autopayCapAmount: null, autopayCapCurrency: null, achMode: null },
    });
    return json({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 });
  });
  window.location.hash = '#payments';
  renderPage();
  expect(await screen.findByTestId('autopay-payments-shell')).toBeInTheDocument();
  expect(await screen.findByTestId('autopay-reminders-section')).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-settings-section') !== null).toBe(autopayEnabled);
  expect(window.location.hash).toBe('#payments');
  await selectTab('defaults');
  await selectTab('payments');
  expect(await screen.findByTestId('autopay-reminders-section')).toBeInTheDocument();
});
```

In W2b's `paymentSettingsView.test.ts`, replace the existing exact-default test with this complete test. Keep the other raw-override tests. Its `connection`, `mocks` and `partnerId` are defined in W2b's test and were read in its prerequisite plan:

```ts
it('exposes reminder defaults even with autopay rollout disabled', async () => {
  const cx = connection(null); mocks.enabled.mockResolvedValue(false);
  const view = await paymentSettingsView(cx.value, partnerId);
  expect(view.autopayEnabled).toBe(false);
  expect(view.inherited).toEqual({
    autopayOffsetDays: { value: 0, source: 'default' },
    autopayOffsetRule: { value: 'later', source: 'default' },
    autopayCap: { value: { enabled: false }, source: 'default' },
    achMode: { value: 'ach_preferred', source: 'default' },
    remindersEnabled: { value: false, source: 'default' },
    reminderBeforeDueDays: { value: 3, source: 'default' },
    reminderRepeatDays: { value: null, source: 'default' },
    overdueReminderEveryDays: { value: 7, source: 'default' },
  });
  expect(view.values).toEqual({ autopayOffsetDays: null, autopayOffsetRule: null,
    autopayCapEnabled: null, autopayCapAmount: null, autopayCapCurrency: null, achMode: null });
});
```

Append this org composition test to `OrgBillingSettings.test.tsx`, whose existing imports include `render`, `screen`, `fetchMock` and `json`:

```tsx
it('mounts org reminders independently of enrollment rollout', async () => {
  const fields = {
    autopayOffsetDays: { value: 0, source: 'default' }, autopayOffsetRule: { value: 'later', source: 'default' },
    autopayCap: { value: { enabled: false }, source: 'default' }, achMode: { value: 'ach_preferred', source: 'default' },
    cardFeeBps: { value: 0, source: 'default' }, achFeeAmount: { value: '0.00', source: 'default' }, feeAttested: false,
    remindersEnabled: { value: false, source: 'default' },
    reminderBeforeDueDays: { value: 3, source: 'default' },
    reminderRepeatDays: { value: null, source: 'default' },
    overdueReminderEveryDays: { value: 7, source: 'default' },
  };
  fetchMock.mockImplementation(async url => {
    if (String(url).endsWith('/billing/payment-settings')) return json({
      effective: fields, inherited: fields, autopayEnabled: false,
      values: { autopayOffsetDays: null, autopayOffsetRule: null, autopayCapEnabled: null, autopayCapAmount: null, autopayCapCurrency: null, achMode: null },
    });
    if (url === '/billing-profiles') return json({ profiles: [] });
    return json({ id: '11111111-1111-4111-8111-111111111111', currencyCode: 'USD', billingContact: null });
  });
  render(<OrgBillingSettings orgId="11111111-1111-4111-8111-111111111111" />);
  expect(await screen.findByTestId('autopay-payments-shell')).toBeInTheDocument();
  expect(await screen.findByTestId('autopay-reminders-section')).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-settings-section')).toBeNull();
});
```

In `OrgBillingSettings.test.tsx`, replace the existing always-true permissions mock with the following hoisted mock and reset it in a file-level `beforeEach`. Add this regression beside the composition test; `orgPayload`, `findPatch`, `fetchMock` and `json` are existing helpers in that file:

```tsx
const reminderPermissions = vi.hoisted(() => ({ canManagePayments: true }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({
  can: (resource: string, action: string) => resource === 'billing' && action === 'manage'
    ? reminderPermissions.canManagePayments : true,
}) }));
beforeEach(() => { reminderPermissions.canManagePayments = true; });
it.each([true, false])('preserves tax/address Save when payments cannot load (permission=%s)', async allowed => {
  reminderPermissions.canManagePayments = allowed;
  fetchMock.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/billing/payment-settings')) return json({ error: 'Unavailable' }, false, 403);
    if (url === '/billing-profiles') return json({ profiles: [] });
    if (url === '/billing-profiles/work-types') return json({ workTypes: [] });
    if (String(url).endsWith('/billing-profile')) return json({ assignment: null });
    return orgPayload();
  });
  render(<OrgBillingSettings orgId="org-1" />);
  fireEvent.change(await screen.findByTestId('org-billing-taxid'), { target: { value: 'TEST-TAX' } });
  await waitFor(() => expect(screen.getByTestId('org-billing-save')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('org-billing-save'));
  await waitFor(() => expect(findPatch()).toBeDefined());
  expect(JSON.parse(findPatch()![1]!.body as string)).toMatchObject({ taxId: 'TEST-TAX' });
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
});
```

Append to `EmailTemplatesTab.test.tsx` with its existing `routeFetch` helper:

```tsx
it.each(['payment_reminder', 'payment_overdue'])('opens the %s editor from Billing & payments', async id => {
  routeFetch(); render(<EmailTemplatesTab />);
  const row = await screen.findByTestId(`autopay-template-${id}`);
  expect(screen.getByTestId('autopay-template-group-billing')).toContainElement(row);
  fireEvent.click(row);
  expect(await screen.findByTestId('email-template-editor')).toBeTruthy();
});
```

Extend its existing exact catalog-array assertion with the two IDs, preserving W2's entries. In the existing loop, compute the new reminder-button test ID as `id === 'payment_reminder' || id === 'payment_overdue' ? \`autopay-template-${id}\` : \`email-template-row-${id}\``; legacy IDs stay unchanged.

Create the Playwright test before the mounts. It uses the verified `authedPage` fixture from `e2e-tests/fixtures.ts` and only `data-testid` DOM selectors. Run it only on the disposable worktree stack with mail transport configured as a sink. It preserves and restores the original form values and never enables reminders.

```ts
import { test, expect } from '../fixtures';

test('reminder settings save and reload on the Payments tab', async ({ authedPage: page }) => {
  await page.goto('/settings/billing#payments');
  const before = page.getByTestId('autopay-reminders-before');
  const enabled = page.getByTestId('autopay-reminders-enabled');
  await expect(page.getByTestId('autopay-reminders-section')).toBeVisible();
  const originalBefore = await before.inputValue();
  const originalEnabled = await enabled.inputValue();
  try {
    await enabled.selectOption('false');
    await before.fill('5');
    const saved = page.waitForResponse(response => response.url().endsWith('/partner/billing/payment-settings')
      && response.request().method() === 'PUT');
    await page.getByTestId('autopay-settings-save').click();
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await expect(before).toHaveValue('5');
    await expect(enabled).toHaveValue('false');
  } finally {
    await before.fill(originalBefore);
    await enabled.selectOption(originalEnabled);
    const restored = page.waitForResponse(response => response.url().endsWith('/partner/billing/payment-settings')
      && response.request().method() === 'PUT');
    await page.getByTestId('autopay-settings-save').click();
    expect((await restored).ok()).toBe(true);
  }
});
```


- [ ] **Step 2: Run it, expect FAIL**:

```sh
(cd apps/api && npx vitest run src/services/autopay/paymentSettingsView.test.ts src/index.autopayRoutes.test.ts)
(cd apps/web && npx vitest run src/components/billing/PaymentsSettingsTab.test.tsx src/components/billing/PartnerBillingSettingsPage.test.tsx src/components/billing/OrgBillingSettings.test.tsx src/components/settings/EmailTemplatesTab.test.tsx src/lib/__tests__/settingsPageRegistry.test.ts)
```

Expected: partner inherited reminder fields absent; disabled rollout prevents Save and Payments mounts; stale org result overwrites current view; editor grouping absent.

- [ ] **Step 3: Implement** — in W2b's `paymentSettingsView` in `apps/api/src/services/autopay/paymentSettingsView.ts`, append these four entries to its partner/default `inherited` object. The org branch already invokes the complete C4 resolver and needs no second reader. Preserve `values` and `effective` fields and all auth middleware.

```ts
remindersEnabled: { value: false, source: 'default' },
reminderBeforeDueDays: { value: 3, source: 'default' },
reminderRepeatDays: { value: null, source: 'default' },
overdueReminderEveryDays: { value: 7, source: 'default' },
```

In `PaymentsSettingsTab.tsx`, add these imports (merge React named imports):

```tsx
import { useRef } from 'react';
import RemindersSettingsSection, {
  reminderDraft, reminderPatch, reminderDraftInvalid, type ReminderDraft, type ReminderEffective,
} from './RemindersSettingsSection';
```

Extend the existing local `Resolved` type with `& ReminderEffective`; retain every autopay field. Replace the complete `usePaymentSettings` function with this implementation. It keeps W2b's public model members, adds reminder draft fields, and uses the existing single Save:

```tsx
export function usePaymentSettings(orgId?: string) {
  const { t } = useTranslation('billing');
  const [view, setView] = useState<PaymentSettingsView | null>(null);
  const [reminders, setReminders] = useState<ReminderDraft | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const path = orgId ? `/orgs/${orgId}/billing/payment-settings` : '/partner/billing/payment-settings';
  const currentPath = useRef(path); currentPath.current = path;
  const generation = useRef(0);
  const load = useCallback(async () => {
    if (currentPath.current !== path) return;
    const mine = ++generation.current;
    setLoading(true); setError(false);
    try {
      const response = await fetchWithAuth(path);
      if (!response.ok) throw new Error('load');
      const data = await response.json() as PaymentSettingsView;
      if (!data.values || !data.effective?.remindersEnabled || !data.inherited?.remindersEnabled) throw new Error('shape');
      if (mine !== generation.current || currentPath.current !== path) return;
      setView(data); setLoadedPath(path);
      setReminders(reminderDraft(data.effective, orgId ? 'org' : 'partner'));
    } catch {
      if (mine === generation.current && currentPath.current === path) {
        setView(null); setReminders(null); setLoadedPath(null); setError(true);
      }
    } finally {
      if (mine === generation.current && currentPath.current === path) setLoading(false);
    }
  }, [path, orgId]);
  useEffect(() => {
    setView(null); setReminders(null); setLoadedPath(null);
    void load();
    return () => { generation.current += 1; };
  }, [load]);
  const values = view?.values;
  const autopayInvalid = !!view?.autopayEnabled && !!values && (
    (values.autopayOffsetDays !== null && (!Number.isInteger(values.autopayOffsetDays) || values.autopayOffsetDays < 0 || values.autopayOffsetDays > 60)) ||
    (values.autopayCapEnabled === true && (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(values.autopayCapAmount ?? '') ||
      !/[1-9]/.test(values.autopayCapAmount ?? '') || !/^[A-Z]{3}$/.test(values.autopayCapCurrency ?? ''))));
  const invalid = loadedPath !== path || !reminders || reminderDraftInvalid(reminders) || autopayInvalid;
  const save = async () => {
    if (!view || !reminders || invalid || saving) return;
    const body = { ...(view.autopayEnabled ? view.values : {}), ...reminderPatch(reminders) };
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        errorFallback: t('reminders.saveFailed'), successMessage: t('reminders.saved'),
      });
      if (currentPath.current === path) await load();
    } finally { setSaving(false); }
  };
  return {
    view: loadedPath === path ? view : null,
    reminders: loadedPath === path ? reminders : null,
    setReminders, loading, saving, invalid, error, load, save,
    setValues: (patch: Partial<PaymentValues>) => setView(current => current ? {
      ...current, values: { ...current.values, ...patch },
    } : current),
  };
}
```

Keep W2b's `PaymentFields` implementation intact. Replace the default partner component with this complete body:

```tsx
export default function PaymentsSettingsTab({ orgId }: { orgId?: string }) {
  const model = usePaymentSettings(orgId); const { t } = useTranslation('billing');
  const { can } = usePermissions(); const canManage = can('billing', 'manage');
  if (model.loading) return <p data-testid="autopay-settings-loading">{t('autopay.loading')}</p>;
  if (model.error) return <p role="alert" data-testid="autopay-settings-error">{t('autopay.error')}</p>;
  if (!model.view || !model.reminders) return null;
  return <div className="space-y-6" data-testid="autopay-payments-shell">
    <RemindersSettingsSection scope={orgId ? 'org' : 'partner'} value={model.reminders}
      inherited={model.view.inherited} onChange={model.setReminders} disabled={!canManage || model.saving} />
    {model.view.autopayEnabled && <section data-testid="autopay-settings-section" className="space-y-4">
      <h2>{t('autopay.title')}</h2>
      <PaymentFields view={model.view} setValues={model.setValues} disabled={!canManage || model.saving} />
    </section>}
    {model.invalid && <p role="alert">{t('autopay.invalid')}</p>}
    {canManage && <button data-testid="autopay-settings-save" disabled={model.invalid || model.saving}
      onClick={() => void model.save().catch(e => handleActionError(e, t('reminders.saveFailed')))}>
      {t(model.saving ? 'reminders.saving' : 'reminders.save')}
    </button>}
  </div>;
}
```

Replace `OrgPaymentsSettingsSection.tsx` with this complete controlled composition (it never fetches or saves independently of the org page):

```tsx
import { useTranslation } from 'react-i18next';
import { PaymentFields, type PaymentSettingsView, type PaymentValues } from './PaymentsSettingsTab';
import RemindersSettingsSection, { type ReminderDraft } from './RemindersSettingsSection';
export default function OrgPaymentsSettingsSection({ view, setValues, reminders, setReminders, disabled }: {
  view: PaymentSettingsView; setValues: (patch: Partial<PaymentValues>) => void;
  reminders: ReminderDraft; setReminders: (value: ReminderDraft) => void; disabled: boolean;
}) {
  const { t } = useTranslation('billing');
  return <div className="space-y-6" data-testid="autopay-payments-shell">
    <RemindersSettingsSection scope="org" value={reminders} inherited={view.inherited}
      onChange={setReminders} disabled={disabled} />
    {view.autopayEnabled && <section data-testid="autopay-settings-section" className="rounded-lg border bg-card p-6 space-y-4">
      <h2>{t('autopay.title')}</h2><PaymentFields view={view} setValues={setValues} disabled={disabled} />
    </section>}
  </div>;
}
```

In `PartnerBillingSettingsPage`, replace W2b's filtered tabs and panel expression with these exact expressions; keep its existing five-key `BILLING_TABS`, `TABS` and `useHashTab` definitions and preserve the existing page Save exclusion for Payments:

```tsx
const renderedTabs = TABS.filter(tab => !tab.reserved);
// Inside the existing tabpanel:
{activeTab === 'payments' && <PaymentsSettingsTab />}
```

Remove the now-unused `useAutopayEnabled` import and hook call from this page if it has no remaining consumers. In `OrgBillingSettings`, replace W2b's Payments mount block and change the added save condition from `if (canManageAutopay && paymentSettings.view?.autopayEnabled)` to `if (canManageAutopay && paymentSettings.view && paymentSettings.reminders)`. Keep its existing call to `paymentSettings.save()` and error handling. Replace W2b's unconditional payment guards with the following scoped value, declared before the `save` callback; include `paymentSettingsBlockSave` in the callback dependencies. This permits existing tax/address saves when payment settings cannot load or the user lacks payment-edit permission. It is still one org-page Save across the two existing endpoints, not an atomic transaction.

```tsx
const paymentSettingsBlockSave = canManageAutopay && !!paymentSettings.view &&
  (paymentSettings.invalid || paymentSettings.saving);
// First statement of the existing save callback:
if (saving || termsDaysInvalid || paymentSettingsBlockSave) return;
// Existing org-billing-save button disabled prop:
disabled={saving || termsDaysInvalid || paymentSettingsBlockSave}
```

```tsx
{paymentSettings.view && paymentSettings.reminders && <>
  <OrgPaymentsSettingsSection view={paymentSettings.view} setValues={paymentSettings.setValues}
    reminders={paymentSettings.reminders} setReminders={paymentSettings.setReminders}
    disabled={saving || paymentSettings.saving || !canManageAutopay} />
  {paymentSettings.view.autopayEnabled && canManageAutopay && <OrgAutopayCard orgId={orgId} />}
</>}
```

Replace W2b's `billing-payments` entry in `SETTINGS_CATALOG` with the complete entry below; this removes the rollout gate while retaining the actual permission gate:

```ts
{ id: 'billing-payments', name: 'Payments', labelKey: 'nav.payments', href: '/settings/billing#payments',
  icon: CreditCard, group: 'billing', partnerScopeOnly: true,
  requiredPermission: { resource: 'billing', action: 'manage' } },
```

In `EmailTemplatesTab`, replace the existing catalog `<ul>` block with this complete block; it preserves the existing editor, loading and saving paths. Common group labels use billing locale keys so only the listed catalogs change:

```tsx
<div data-testid="email-templates-list" className="space-y-4">
  {([
    { id: 'billing', label: 'billing:reminders.templateGroup', ids: EMAIL_TEMPLATE_IDS.filter(id =>
      ['quote_send', 'invoice_send', 'autopay_request', 'autopay_enrolled', 'autopay_stopped', 'card_expiring',
        'payment_reminder', 'payment_overdue', 'invoice_autopay', 'payment_receipt', 'payment_failed'].includes(id)) },
    { id: 'other', label: 'billing:reminders.otherTemplates', ids: EMAIL_TEMPLATE_IDS.filter(id =>
      !['quote_send', 'invoice_send', 'autopay_request', 'autopay_enrolled', 'autopay_stopped', 'card_expiring',
        'payment_reminder', 'payment_overdue', 'invoice_autopay', 'payment_receipt', 'payment_failed'].includes(id)) },
  ]).map(group => <section key={group.id} data-testid={`autopay-template-group-${group.id}`}>
    <h3 className="mb-2 text-sm font-semibold">{t(/* i18n-dynamic */ group.label)}</h3>
    <ul className="divide-y rounded-lg border">{group.ids.map(id => <li key={id}>
      <button type="button" onClick={() => setSelectedId(id)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/40"
        data-testid={id === 'payment_reminder' || id === 'payment_overdue' ? `autopay-template-${id}` : `email-template-row-${id}`}>
        <span className="text-sm font-medium">{emailTemplateLabel(id)}</span>
        <span className="text-xs text-muted-foreground" data-testid={`email-template-status-${id}`}>
          {isCustom(templates[id]) ? t('emailTemplates.custom') : t('emailTemplates.usingDefault')}
        </span>
      </button>
    </li>)}</ul>
  </section>)}
</div>
```

Add these exact fields to `reminders` in all eight billing catalogs:

```json
"save": "Save payment settings",
"saving": "Saving…",
"saved": "Reminder settings saved",
"saveFailed": "Could not save reminder settings",
"loadFailed": "Could not load reminder settings",
"retry": "Retry",
"loading": "Loading payment settings…",
"templateGroup": "Billing & payments",
"otherTemplates": "Tickets & portal"
```


- [ ] **Step 4: Run it, expect PASS**:

```sh
(cd apps/api && npx vitest run src/services/autopay/paymentSettingsView.test.ts src/index.autopayRoutes.test.ts)
(cd apps/web && npx vitest run src/components/billing/PaymentsSettingsTab.test.tsx src/components/billing/RemindersSettingsSection.test.tsx src/components/billing/PartnerBillingSettingsPage.test.tsx src/components/billing/OrgBillingSettings.test.tsx src/components/settings/EmailTemplatesTab.test.tsx src/lib/__tests__/settingsPageRegistry.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts src/lib/__tests__/no-silent-mutations.test.ts)
```

- [ ] **Step 5: Commit**:

```sh
git add apps/api/src/services/autopay/paymentSettingsView.ts apps/api/src/services/autopay/paymentSettingsView.test.ts apps/api/src/index.autopayRoutes.test.ts apps/web/src/components/billing/PaymentsSettingsTab.tsx apps/web/src/components/billing/PaymentsSettingsTab.test.tsx apps/web/src/components/billing/OrgPaymentsSettingsSection.tsx apps/web/src/components/billing/PartnerBillingSettingsPage.tsx apps/web/src/components/billing/OrgBillingSettings.tsx apps/web/src/components/billing/PartnerBillingSettingsPage.test.tsx apps/web/src/components/billing/OrgBillingSettings.test.tsx apps/web/src/lib/settingsCatalog.ts apps/web/src/lib/__tests__/settingsPageRegistry.test.ts apps/web/src/components/settings/EmailTemplatesTab.tsx apps/web/src/components/settings/EmailTemplatesTab.test.tsx apps/web/src/locales/en/billing.json apps/web/src/locales/de-DE/billing.json apps/web/src/locales/es-419/billing.json apps/web/src/locales/fr-CA/billing.json apps/web/src/locales/fr-FR/billing.json apps/web/src/locales/it-IT/billing.json apps/web/src/locales/pt-BR/billing.json apps/web/src/locales/tr-TR/billing.json e2e-tests/tests/autopay-reminders.spec.ts
git commit -m "feat(web): expose payment reminders independently of autopay"
```

### Task 8: Verification

**Files:** Test all files named below; no new production files or migrations.
**Interfaces:** Consumes the complete W03 change plus landed W1/W2b · Produces the one-PR verification record, test counts, stack cleanup and explicit rollout evidence. This is an acceptance gate over tests written before implementation in Tasks 1–7, not a new test-after-code task.

- [ ] **Step 1: Establish the assertions** — verify the prewritten tests are present and that the integration runner owns both real-DB suites. Do not add skips to make this gate green. The acceptance assertions are: both kinds render; partner and org updates retain inheritance; all four active schedules and frozen orgs are skipped; concurrent sweeps/dispatchers allocate/send once in the tested no-crash case; Payments remains reachable when autopay is off; every new mounted module has its page-level marker. Review the W1/W2b integration assumptions against the landed source before declaring the gate runnable.
- [ ] **Step 2: Run the required checks** — from the repository root, use subshells so each command has an unambiguous working directory:

```sh
pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/web exec astro check
(cd packages/shared && npx vitest run src/utils/emailTemplates.test.ts)
(cd apps/api && npx vitest run src/services/autopay/reminderSweep.test.ts src/services/autopay/renderBillingNotice.reminders.test.ts src/services/emailTemplates/renderPartnerEmail.test.ts src/services/emailTemplates/defaults.test.ts src/routes/orgs.test.ts src/services/autopay/paymentSettingsView.test.ts src/index.autopayRoutes.test.ts src/jobs/autopayWorker.reminders.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerRegistry.test.ts src/services/workerRegistry.autopayWorker.test.ts src/services/workerEntrypointClosure.contract.test.ts src/jobs/workerReadinessCoverage.test.ts)
(cd apps/web && npx vitest run src/components/billing/RemindersSettingsSection.test.tsx src/components/billing/PaymentsSettingsTab.test.tsx src/components/billing/PartnerBillingSettingsPage.test.tsx src/components/billing/OrgBillingSettings.test.tsx src/components/settings/EmailTemplatesTab.test.tsx src/lib/__tests__/settingsPageRegistry.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts)
pnpm test-stack up
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/reminderSweep.integration.test.ts src/services/autopay/reminderSettings.integration.test.ts src/services/autopay/noticeOutbox.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts)
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm --filter @breeze/api test:integration-suite-coverage
(cd apps/api && npx vitest run src/services/orgMerge.test.ts)
pnpm test-stack down
pnpm wt-stack up --rebuild
pnpm wt-stack test tests/autopay-reminders.spec.ts --project=chromium
pnpm wt-stack down
```

`noticeOutbox.integration.test.ts` and `index.autopayRoutes.test.ts` are verified W1-plan prerequisite paths, not existing implementation files on this checkout. All other existing contract paths above were read in the current repository. The root `wt-stack test` command is implemented by `scripts/dev/wt-stack/cli.ts`; it supplies the private stack descriptor, credentials and Redis settings to the real Playwright runner. Do not replace it with an invented test fixture or production URL.

- [ ] **Step 3: Resolve failures in their owning task** — a missing test file or `No test files found` is a failure of this gate. Fix runner registration or the prerequisite; an integration test must execute against PostgreSQL with RLS, not against a mocked DB. Capture the actual file/test counts and commands in the PR description. Verify W1 table registrations still pass: `CORE_ORG_CASCADE_DELETE_ORDER`/`AUDIT_ADMIN_REQUIRED_TABLES` in `tenantCascade.ts`, policy entries in `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY` in `tenantExportPolicyRegistry.ts`, coverage allowlists in `rls-coverage.integration.test.ts`, and `encryptedColumnRegistry` in `encryptedColumnRegistry.ts`. W03 adds no table/column, so no registration edits or SQL belong in this PR.
- [ ] **Step 4: Confirm PASS and smoke behavior** — all targeted and integration checks above must pass with zero skipped W03 cases. On the disposable stack, confirm `#payments` survives reload, partner and org forms show inherited value/source, a disabled rollout hides only Autopay controls, and the template editor shows both kinds under Billing & payments. Verify the jobs list contains one `reminder-sweep` registration at `18 6 * * *` on `autopay-jobs`. Tear down both stacks even if a check fails; no process or container is intentionally left running.
- [ ] **Step 5: Commit and open one reviewable PR** — no verification-only empty commit. If a check required a fix, commit only its exact owning task paths with that task's conventional message after rerunning the relevant checks. The PR description states the home, level, resolver and 0 → 1 configuration-location count, and records the deliberate cadence refinements. All eight tasks ship together; do not split the job from its templates or the visibility change from inherited settings.

**Stripe test-mode lab checklist**

W03 introduces no Stripe call and requires no new Stripe capability or charge simulator. The reminder's existing public pay link is the only Stripe-adjacent surface. Run this limited regression on a disposable stack and synthetic invoices; use the existing partner test-mode connection and mail sink, never a live key or customer recipient.

- [ ] With `autopayEnabled=false`, enable reminders for the synthetic partner; create a sent invoice whose next tick is today and run the reminder job. Confirm one billing-stream email, correct billing-contact recipient, remaining balance/currency, due date and public pay URL.
- [ ] Open the reminder URL and complete an ordinary card payment through the existing test-mode Checkout path. Confirm it remains a card-only, fee-free one-time payment and does not enroll the org.
- [ ] After the existing settlement path records payment, run the next reminder tick. Confirm the paid invoice receives no new notice. With a partial manual payment instead, confirm the next notice displays only the remaining balance.
- [ ] Re-run the same tick and run two sweeps concurrently. Confirm one outbox identity and one observed delivery per sequence under normal execution; do not interpret this as a crash-proof email-provider guarantee.
- [ ] Restore reminders to their initial settings and tear down the disposable stack. No new Stripe lab scenarios for ACH, SetupIntents, retries or fees belong to W03.

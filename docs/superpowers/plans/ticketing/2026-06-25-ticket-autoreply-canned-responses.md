# Ticket Auto-Reply Customization + Canned Responses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let partners customize the inbound-ticket auto-reply email, and give technicians a partner-wide library of reusable canned reply templates — both powered by one shared `{{variable}}` substitution engine.

**Architecture:** A pure `renderTemplate()` engine + variable registry in `packages/shared` is consumed by the API (server-side auto-reply render) and the web app (client-side composer insert). The auto-reply template is stored in `partners.settings.ticketing.inbound` jsonb (one per partner, no new table). Canned responses are a list, so they get a new partner-axis (RLS shape #3) `ticket_response_templates` table with CRUD routes mirroring `alertTemplates`/`ticketCategories`. The composer gets a picker that substitutes variables from the loaded ticket and inserts at the cursor.

**Tech Stack:** TypeScript, Vitest (+ jsdom for web), Drizzle ORM, Hono, PostgreSQL with RLS, React, Zod.

## Global Constraints

- **Tenancy:** `ticket_response_templates` is partner-axis (tenancy shape #3, `breeze_has_partner_access(partner_id)`). RLS enabled + forced + policy in the SAME migration that creates the table; added to `PARTNER_TENANT_TABLES` in `rls-coverage.integration.test.ts` in this PR. Migration must be idempotent (`CREATE TABLE IF NOT EXISTS`, `pg_policies` existence check via `DO $$ ... EXCEPTION WHEN duplicate_object`).
- **Migration naming:** `YYYY-MM-DD-<slug>.sql` (e.g. `2026-06-25-ticket-response-templates.sql`). No inner `BEGIN;`/`COMMIT;` (autoMigrate wraps each file in a transaction).
- **Web mutations:** every POST/PATCH/DELETE handler wraps the request in `runAction` (`apps/web/src/lib/runAction.ts`).
- **HTML safety:** auto-reply variable values AND the admin-authored body are treated as PLAIN TEXT — HTML-escaped before substitution (the auto-reply email is customer-facing). The composer inserts plain text (no escaping).
- **Unknown variables render to empty string** — never leak a raw `{{foo}}` token to a customer.
- **Zero behavior change for existing partners:** absent/`null` auto-reply subject/body falls through to the exact current hardcoded default.
- **Zod 4:** use `.guid()` (not `.uuid()`) for UUID validation, matching the codebase.
- **Frontend work holds for Todd's review** — open the PR, do not auto-merge.

---

## File Structure

**New files:**
- `packages/shared/src/utils/ticketTemplate.ts` — `renderTemplate()` + variable registry
- `packages/shared/src/utils/ticketTemplate.test.ts`
- `apps/api/src/db/schema/ticketResponseTemplates.ts` — new Drizzle table (or add to `tickets.ts`; see Task 4)
- `apps/api/migrations/2026-06-25-ticket-response-templates.sql`
- `apps/api/src/routes/tickets/ticketResponseTemplates.ts` — CRUD routes
- `apps/api/src/routes/tickets/ticketResponseTemplates.test.ts`
- `apps/web/src/lib/ticketResponseTemplatesApi.ts` — web fetch helper (list + CRUD)
- `apps/web/src/components/settings/CannedResponsesCard.tsx` — settings CRUD UI
- `apps/web/src/components/settings/CannedResponsesCard.test.tsx`
- `apps/web/src/components/tickets/CannedResponsePicker.tsx` — composer dropdown
- `apps/web/src/components/tickets/CannedResponsePicker.test.tsx`

**Modified files:**
- `packages/shared/src/utils/index.ts` — export the new module
- `apps/api/src/services/inboundEmail/autoresponseTemplate.ts` — accept custom subject/body + vars
- `apps/api/src/jobs/ticketNotifyWorker.ts` — `collectAutoresponse` loads custom template + builds vars
- `apps/api/src/routes/orgs.ts` — add auto-reply fields to `partnerSettingsSchema.ticketing.inbound`
- `apps/api/src/services/ticketConfigService.ts` — surface auto-reply fields in `getTicketConfig().inbound`
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — allowlist the new table
- `apps/api/src/db/schema/index.ts` — export the new schema (if a new file)
- `apps/web/src/components/settings/InboundEmailCard.tsx` — auto-reply subject/body fields + preview
- `apps/web/src/components/settings/TicketingSettingsTabs.tsx` — add "Canned responses" subtab
- `apps/web/src/components/tickets/TicketComposer.tsx` — render the picker, insert-at-cursor
- `apps/web/src/components/tickets/TicketWorkbench.tsx` — load templates, build vars, pass to composer

---

## Task 1: Shared merge-variable engine

**Files:**
- Create: `packages/shared/src/utils/ticketTemplate.ts`
- Test: `packages/shared/src/utils/ticketTemplate.test.ts`
- Modify: `packages/shared/src/utils/index.ts`

**Interfaces:**
- Produces:
  - `renderTemplate(template: string, vars: Record<string, string>): string`
  - `type TicketTemplateContext = 'autoreply' | 'canned'`
  - `interface TicketTemplateVariable { key: string; label: string; contexts: TicketTemplateContext[] }`
  - `const TICKET_TEMPLATE_VARIABLES: readonly TicketTemplateVariable[]`
  - `variablesForContext(ctx: TicketTemplateContext): TicketTemplateVariable[]`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/utils/ticketTemplate.test.ts
import { describe, it, expect } from 'vitest';
import {
  renderTemplate,
  TICKET_TEMPLATE_VARIABLES,
  variablesForContext,
} from './ticketTemplate';

describe('renderTemplate', () => {
  it('substitutes a known token', () => {
    expect(renderTemplate('Hi {{requester_name}}', { requester_name: 'Ada' })).toBe('Hi Ada');
  });

  it('renders unknown tokens as empty string (no raw token leak)', () => {
    expect(renderTemplate('Ticket {{missing}}!', {})).toBe('Ticket !');
  });

  it('tolerates inner whitespace and repeats a token', () => {
    expect(renderTemplate('{{ a }} {{a}}', { a: 'x' })).toBe('x x');
  });

  it('handles adjacent tokens', () => {
    expect(renderTemplate('{{a}}{{b}}', { a: '1', b: '2' })).toBe('12');
  });

  it('leaves an unclosed brace untouched', () => {
    expect(renderTemplate('a {{ b', { b: 'x' })).toBe('a {{ b');
  });

  it('passes through a template with no tokens', () => {
    expect(renderTemplate('plain text', { a: 'x' })).toBe('plain text');
  });

  it('returns empty for an empty template', () => {
    expect(renderTemplate('', { a: 'x' })).toBe('');
  });

  it('does not recursively expand substituted values', () => {
    expect(renderTemplate('{{a}}', { a: '{{b}}', b: 'NO' })).toBe('{{b}}');
  });
});

describe('variable registry', () => {
  it('exposes the canned-only variables to the canned context but not autoreply', () => {
    const autoKeys = variablesForContext('autoreply').map((v) => v.key);
    const cannedKeys = variablesForContext('canned').map((v) => v.key);
    expect(autoKeys).not.toContain('agent_name');
    expect(cannedKeys).toContain('agent_name');
    expect(autoKeys).toContain('ticket_number');
    expect(cannedKeys).toContain('ticket_number');
  });

  it('every variable declares at least one context', () => {
    for (const v of TICKET_TEMPLATE_VARIABLES) {
      expect(v.contexts.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm exec vitest run src/utils/ticketTemplate.test.ts`
Expected: FAIL — `Cannot find module './ticketTemplate'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/shared/src/utils/ticketTemplate.ts
/**
 * Shared {{variable}} substitution for ticket templates (auto-reply emails and
 * canned responses). Pure and context-agnostic: callers escape values for their
 * output format (the auto-reply path HTML-escapes; the composer inserts plain text).
 * Unknown tokens render to '' so a raw {{foo}} never reaches a customer.
 * Substitution is single-pass — values are NOT re-scanned for tokens.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (_match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '',
  );
}

export type TicketTemplateContext = 'autoreply' | 'canned';

export interface TicketTemplateVariable {
  key: string;
  label: string;
  contexts: TicketTemplateContext[];
}

const BOTH: TicketTemplateContext[] = ['autoreply', 'canned'];
const CANNED_ONLY: TicketTemplateContext[] = ['canned'];

export const TICKET_TEMPLATE_VARIABLES: readonly TicketTemplateVariable[] = [
  { key: 'ticket_number', label: 'Ticket number', contexts: BOTH },
  { key: 'ticket_subject', label: 'Ticket subject', contexts: BOTH },
  { key: 'requester_name', label: 'Requester name', contexts: BOTH },
  { key: 'requester_email', label: 'Requester email', contexts: BOTH },
  { key: 'org_name', label: 'Organization name', contexts: BOTH },
  { key: 'partner_name', label: 'Company name', contexts: BOTH },
  { key: 'agent_name', label: 'Your name', contexts: CANNED_ONLY },
  { key: 'current_status', label: 'Current status', contexts: CANNED_ONLY },
  { key: 'current_priority', label: 'Current priority', contexts: CANNED_ONLY },
];

export function variablesForContext(ctx: TicketTemplateContext): TicketTemplateVariable[] {
  return TICKET_TEMPLATE_VARIABLES.filter((v) => v.contexts.includes(ctx));
}
```

- [ ] **Step 4: Export from the utils barrel**

Add to `packages/shared/src/utils/index.ts`:

```ts
export * from './ticketTemplate';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/shared && pnpm exec vitest run src/utils/ticketTemplate.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/utils/ticketTemplate.ts packages/shared/src/utils/ticketTemplate.test.ts packages/shared/src/utils/index.ts
git commit -m "feat(shared): ticket template merge-variable engine + registry"
```

---

## Task 2: Persist + surface the auto-reply template fields (backend wiring)

This task makes `autoresponseSubject`/`autoresponseBody` (a) survive the partner-settings PATCH (the schema is a CLOSED Zod object that strips unknown keys) and (b) read back from `GET /ticket-config`.

**Files:**
- Modify: `apps/api/src/routes/orgs.ts:433-440` (the `ticketing.inbound` schema)
- Modify: `apps/api/src/services/ticketConfigService.ts:366-382`
- Test: `apps/api/src/services/ticketConfigService.test.ts` (add cases; create if absent)

**Interfaces:**
- Produces: `getTicketConfig().inbound` now includes `autoresponseSubject: string | null` and `autoresponseBody: string | null`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/ticketConfigService.test.ts` (follow the file's existing mock style for `db`/`partners`; if the file does not exist, model it on a sibling service test). The assertion that matters:

```ts
it('surfaces auto-reply subject/body from partner settings, defaulting to null', async () => {
  // Arrange: partner.settings.ticketing.inbound = { autoresponseSubject: 'Hi {{ticket_number}}', autoresponseBody: 'Body' }
  // (mock db.select(...).from(partners) to return that settings object + a slug)
  const cfg = await getTicketConfig(PARTNER_ID);
  expect(cfg.inbound.autoresponseSubject).toBe('Hi {{ticket_number}}');
  expect(cfg.inbound.autoresponseBody).toBe('Body');
});

it('defaults auto-reply subject/body to null when unset', async () => {
  // Arrange: partner.settings.ticketing.inbound = {} (or undefined)
  const cfg = await getTicketConfig(PARTNER_ID);
  expect(cfg.inbound.autoresponseSubject).toBeNull();
  expect(cfg.inbound.autoresponseBody).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm exec vitest run src/services/ticketConfigService.test.ts`
Expected: FAIL — `autoresponseSubject` is `undefined`, not the expected value/null.

- [ ] **Step 3: Extend the service's inbound type + response**

In `apps/api/src/services/ticketConfigService.ts`, widen the `inboundCfg` cast (line 366-367) and the returned `inbound` object (line 373-382):

```ts
  const inboundCfg = (((settings.ticketing as Record<string, unknown> | undefined)?.inbound) as
    {
      enabled?: boolean; address?: string; defaultTriageOrgId?: string | null;
      autoresponderEnabled?: boolean; triageUnknownSenders?: boolean;
      autoresponseSubject?: string | null; autoresponseBody?: string | null;
    } | undefined) ?? {};
```

```ts
  const inbound = {
    enabled: inboundCfg.enabled ?? false,
    address: addressOverride ?? derived,
    addressOverride,
    defaultTriageOrgId: inboundCfg.defaultTriageOrgId ?? null,
    autoresponderEnabled: inboundCfg.autoresponderEnabled ?? true,
    triageUnknownSenders: inboundCfg.triageUnknownSenders ?? false,
    autoresponseSubject: inboundCfg.autoresponseSubject ?? null,
    autoresponseBody: inboundCfg.autoresponseBody ?? null,
    slug,
    domainConfigured,
  };
```

- [ ] **Step 4: Add the fields to the partner-settings Zod schema**

In `apps/api/src/routes/orgs.ts`, extend the closed `ticketing.inbound` object (lines 433-440). **Without this, the PATCH silently strips the fields and nothing persists.**

```ts
  ticketing: z.object({
    inbound: z.object({
      enabled: z.boolean().optional(),
      address: z.string().email().optional().or(z.literal('')),
      defaultTriageOrgId: z.string().guid().nullable().optional(),
      autoresponderEnabled: z.boolean().optional(),
      // NOTE: triageUnknownSenders was already sent by InboundEmailCard but missing
      // from this schema (closed object → stripped). Add it here while we're in the
      // object so it actually persists, alongside the new auto-reply fields.
      triageUnknownSenders: z.boolean().optional(),
      autoresponseSubject: z.string().max(200).nullable().optional(),
      autoresponseBody: z.string().max(5000).nullable().optional(),
    }).optional(),
  }).optional(),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && pnpm exec vitest run src/services/ticketConfigService.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/ticketConfigService.ts apps/api/src/routes/orgs.ts apps/api/src/services/ticketConfigService.test.ts
git commit -m "feat(api): persist + surface custom ticket auto-reply subject/body"
```

---

## Task 3: Render the custom auto-reply (engine integration)

**Files:**
- Modify: `apps/api/src/services/inboundEmail/autoresponseTemplate.ts`
- Modify: `apps/api/src/jobs/ticketNotifyWorker.ts:197-230` (`collectAutoresponse`)
- Test: `apps/api/src/services/inboundEmail/autoresponseTemplate.test.ts` (create)

**Interfaces:**
- Consumes: `renderTemplate` from `@breeze/shared`; `escapeHtml` from `../emailLayout`.
- Produces (new `buildAutoresponseEmail` signature):
  ```ts
  buildAutoresponseEmail(args: {
    internalNumber: string | null;
    subject: string;
    custom?: { subject: string | null; body: string | null };
    vars?: Record<string, string>;
  }): { subject: string; html: string }
  ```
  When `custom.subject`/`custom.body` are non-empty, they are rendered via `renderTemplate` (subject plain; body HTML-escaped then `{{vars}}` substituted with already-escaped values, newlines → `<br>`). When absent, output is byte-for-byte the current default.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/inboundEmail/autoresponseTemplate.test.ts
import { describe, it, expect } from 'vitest';
import { buildAutoresponseEmail } from './autoresponseTemplate';

describe('buildAutoresponseEmail', () => {
  it('falls back to the exact default when no custom template is set', () => {
    const out = buildAutoresponseEmail({ internalNumber: 'T-2026-0001', subject: 'Printer' });
    expect(out.subject).toBe('[T-2026-0001] We received your request: Printer');
    expect(out.html).toContain('opened ticket <strong>T-2026-0001</strong>');
  });

  it('degrades the default subject token when internalNumber is null', () => {
    const out = buildAutoresponseEmail({ internalNumber: null, subject: 'Printer' });
    expect(out.subject).toBe('We received your request: Printer');
    expect(out.html).toContain('<strong>your request</strong>');
  });

  it('renders a custom subject and body with substituted variables', () => {
    const out = buildAutoresponseEmail({
      internalNumber: 'T-2026-0002',
      subject: 'VPN',
      custom: { subject: 'Re: {{ticket_subject}} ({{ticket_number}})', body: 'Hi {{requester_name}}' },
      vars: { ticket_subject: 'VPN', ticket_number: 'T-2026-0002', requester_name: 'Ada' },
    });
    expect(out.subject).toBe('Re: VPN (T-2026-0002)');
    expect(out.html).toContain('Hi Ada');
  });

  it('HTML-escapes variable values in the custom body (no injection)', () => {
    const out = buildAutoresponseEmail({
      internalNumber: 'T-2026-0003',
      subject: 'x',
      custom: { subject: null, body: 'Hello {{requester_name}}' },
      vars: { requester_name: '<script>alert(1)</script>' },
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('uses the default subject when only a custom body is set', () => {
    const out = buildAutoresponseEmail({
      internalNumber: 'T-2026-0004',
      subject: 'x',
      custom: { subject: null, body: 'Custom body' },
      vars: {},
    });
    expect(out.subject).toBe('[T-2026-0004] We received your request: x');
    expect(out.html).toContain('Custom body');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm exec vitest run src/services/inboundEmail/autoresponseTemplate.test.ts`
Expected: FAIL — custom rendering not implemented (extra `custom`/`vars` args ignored).

- [ ] **Step 3: Implement custom rendering with safe fallback**

Replace `apps/api/src/services/inboundEmail/autoresponseTemplate.ts` with:

```ts
import { escapeHtml } from '../emailLayout';
import { renderTemplate } from '@breeze/shared';

/** Acknowledgement email for an email-created ticket (spec §5). When a partner
 *  has customized the template, render it; otherwise emit the original hardcoded
 *  default byte-for-byte so existing partners see no change.
 *  Body is treated as PLAIN TEXT: the literal body and every variable value are
 *  HTML-escaped before substitution (customer-facing), then newlines → <br>. */
export function buildAutoresponseEmail(args: {
  internalNumber: string | null;
  subject: string;
  custom?: { subject: string | null; body: string | null };
  vars?: Record<string, string>;
}): { subject: string; html: string } {
  const label = args.internalNumber ?? 'your request';
  const tokenPrefix = args.internalNumber ? `[${args.internalNumber}] ` : '';
  const defaultSubject = `${tokenPrefix}We received your request: ${args.subject}`;

  const vars = args.vars ?? {};
  const customSubject = args.custom?.subject?.trim() ? args.custom.subject : null;
  const customBody = args.custom?.body?.trim() ? args.custom.body : null;

  const subject = customSubject
    ? renderTemplate(customSubject, vars).replace(/[\r\n]+/g, ' ').trim()
    : defaultSubject;

  let html: string;
  if (customBody) {
    const escapedVars = Object.fromEntries(
      Object.entries(vars).map(([k, v]) => [k, escapeHtml(v)]),
    );
    const rendered = renderTemplate(escapeHtml(customBody), escapedVars).replace(/\r?\n/g, '<br>');
    html = `<p>${rendered}</p>`;
  } else {
    html =
      `<p>Thanks — we've received your request and opened ticket <strong>${escapeHtml(label)}</strong>.</p>` +
      `<p>Reply to this email to add more detail; our team will follow up.</p>`;
  }

  return { subject, html };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && pnpm exec vitest run src/services/inboundEmail/autoresponseTemplate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire `collectAutoresponse` to load the custom template + build vars**

In `apps/api/src/jobs/ticketNotifyWorker.ts`, the `collectAutoresponse` function already fetches the partner row for `replyTo`. Extend that select to also read settings + name, fetch the org name, build the variable map, and pass `custom` + `vars` into `buildAutoresponseEmail`. Replace the body of `collectAutoresponse` (lines ~197-230) with:

```ts
async function collectAutoresponse(
  event: Extract<TicketEvent, { type: 'ticket.autoresponse' }>
): Promise<EmailPayload[]> {
  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  }

  let replyTo: string | undefined;
  let custom: { subject: string | null; body: string | null } | undefined;
  let partnerName = '';
  if (ticket.partnerId) {
    const partnerRows = await db
      .select({ slug: partners.slug, name: partners.name, settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, ticket.partnerId))
      .limit(1);
    const slug = partnerRows[0]?.slug;
    partnerName = partnerRows[0]?.name ?? '';
    const inbound = (partnerRows[0]?.settings as
      | { ticketing?: { inbound?: { address?: string; autoresponseSubject?: string | null; autoresponseBody?: string | null } } }
      | undefined)?.ticketing?.inbound;
    if (slug) replyTo = partnerInboundAddress(slug, inbound?.address) ?? undefined;
    custom = { subject: inbound?.autoresponseSubject ?? null, body: inbound?.autoresponseBody ?? null };
  }

  let orgName = '';
  if (ticket.orgId) {
    const orgRows = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, ticket.orgId))
      .limit(1);
    orgName = orgRows[0]?.name ?? '';
  }

  const vars: Record<string, string> = {
    ticket_number: ticket.internalNumber ?? '',
    ticket_subject: ticket.subject ?? event.payload.subject,
    requester_name: ticket.submitterName ?? '',
    requester_email: event.payload.to,
    org_name: orgName,
    partner_name: partnerName,
  };

  const tpl = buildAutoresponseEmail({
    internalNumber: event.payload.internalNumber,
    subject: event.payload.subject,
    custom,
    vars,
  });

  const headers: Record<string, string> = { 'Auto-Submitted': 'auto-replied' };
  const anchor = ticketThreadAnchor(ticket.id);
  if (anchor) headers['Message-ID'] = anchor;

  return [{ to: event.payload.to, subject: tpl.subject, html: tpl.html, replyTo, headers, bestEffort: true }];
}
```

Add `organizations` to the schema imports at the top of `ticketNotifyWorker.ts` if not already imported (it imports `partners`, `tickets`; add `organizations` from `../db/schema`). Confirm `partners.name` and `tickets.submitterName` exist (they do — see `apps/api/src/db/schema/portal.ts` and `orgs.ts`).

- [ ] **Step 6: Run the worker's existing tests**

Run: `cd apps/api && pnpm exec vitest run src/jobs/ticketNotifyWorker.test.ts`
Expected: PASS (existing autoresponse tests still green — default path unchanged). If a test asserts the exact `db.select` shape for the partner row, update its mock to include `name`/`settings` and to answer the new `organizations` select.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/inboundEmail/autoresponseTemplate.ts apps/api/src/services/inboundEmail/autoresponseTemplate.test.ts apps/api/src/jobs/ticketNotifyWorker.ts apps/api/src/jobs/ticketNotifyWorker.test.ts
git commit -m "feat(api): render partner-customized ticket auto-reply with merge variables"
```

---

## Task 4: Canned responses — schema + migration + RLS

**Files:**
- Create: `apps/api/src/db/schema/ticketResponseTemplates.ts`
- Modify: `apps/api/src/db/schema/index.ts` (export the new table)
- Create: `apps/api/migrations/2026-06-25-ticket-response-templates.sql`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (allowlist)

**Interfaces:**
- Produces: `ticketResponseTemplates` Drizzle table with columns `id, partnerId, name, body, category, sortOrder, isActive, createdBy, createdAt, updatedAt`.

- [ ] **Step 1: Write the Drizzle schema**

```ts
// apps/api/src/db/schema/ticketResponseTemplates.ts
import { pgTable, uuid, varchar, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';

/** Partner-wide library of reusable ticket reply templates (canned responses).
 *  RLS shape #3 (partner-axis). `createdBy` is audit-only — NOT a scope axis;
 *  it leaves room for personal snippets later via an isPersonal flag. */
export const ticketResponseTemplates = pgTable('ticket_response_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  name: varchar('name', { length: 200 }).notNull(),
  body: text('body').notNull(),
  category: varchar('category', { length: 100 }),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [index('ticket_response_templates_partner_idx').on(t.partnerId)]);
```

- [ ] **Step 2: Export from the schema barrel**

Add to `apps/api/src/db/schema/index.ts` (match the existing export style):

```ts
export * from './ticketResponseTemplates';
```

- [ ] **Step 3: Write the idempotent migration with RLS**

```sql
-- apps/api/migrations/2026-06-25-ticket-response-templates.sql
-- Canned ticket responses: partner-wide reusable reply templates.
-- RLS shape 3 (partner-axis), mirroring ticket_categories.

CREATE TABLE IF NOT EXISTS ticket_response_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  name VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  category VARCHAR(100),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ticket_response_templates_partner_idx
  ON ticket_response_templates (partner_id);

ALTER TABLE ticket_response_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_response_templates FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY ticket_response_templates_partner_access ON ticket_response_templates
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

- [ ] **Step 4: Allowlist the table in the RLS contract test**

In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, add to `PARTNER_TENANT_TABLES` (near the other ticket tables):

```ts
  ['ticket_response_templates', 'partner_id'],
```

- [ ] **Step 5: Apply migration + verify no drift**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && pnpm exec vitest run src/db/autoMigrate.test.ts
cd /Users/toddhebebrand/conductor/workspaces/breeze/surat && pnpm db:check-drift
```
Expected: autoMigrate ordering test PASS; drift check reports no drift.

- [ ] **Step 6: Verify RLS isolation as `breeze_app` (real DB)**

Run the RLS coverage integration test (needs the :5433 test DB up):
```bash
cd apps/api && EXPORT_TEST_ENV=1 pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: PASS — `ticket_response_templates` is recognized as partner-axis covered. (If the harness isn't running, note it and rely on CI.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema/ticketResponseTemplates.ts apps/api/src/db/schema/index.ts apps/api/migrations/2026-06-25-ticket-response-templates.sql apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(api): ticket_response_templates table + partner-axis RLS"
```

---

## Task 5: Canned responses — CRUD routes

**Files:**
- Create: `apps/api/src/routes/tickets/ticketResponseTemplates.ts`
- Test: `apps/api/src/routes/tickets/ticketResponseTemplates.test.ts`
- Modify: wherever ticket routes are mounted (search for where `ticketConfigRoutes` / `ticketRoutes` mount in `apps/api/src/routes/index.ts` and mount the new router on the same base path the web client expects: `/ticket-response-templates`).

**Interfaces:**
- Consumes: `ticketResponseTemplates` from `../../db/schema`; `requireScope`, `requirePermission`, `requireMfa` from `../../middleware/auth`.
- Produces these endpoints (all partner-scoped):
  - `GET /ticket-response-templates` → `{ data: TemplateRow[] }`, active rows ordered by `category` then `sortOrder` then `name`.
  - `POST /ticket-response-templates` → `{ data: TemplateRow }` (201).
  - `PATCH /ticket-response-templates/:id` → `{ data: TemplateRow }`.
  - `DELETE /ticket-response-templates/:id` → `{ success: true }` (hard delete).

- [ ] **Step 1: Write the failing test**

Model the test on `apps/api/src/routes/alertTemplates/templates.test.ts` (same Drizzle-mock + Hono test-client style). Cover:

```ts
// apps/api/src/routes/tickets/ticketResponseTemplates.test.ts
// - GET returns only the caller's partner rows, ordered category→sortOrder→name
// - POST creates with partnerId from auth.partnerId, name+body required (400 on missing)
// - POST trims name, defaults sortOrder=0, isActive=true, sets createdBy=auth.userId
// - PATCH updates name/body/category/sortOrder/isActive of an existing row
// - DELETE removes the row, returns { success: true }
// - partner scoping: a request without partner context → 403
```

Write at least the GET-list and POST-create-validation cases as concrete assertions against the mounted router using the project's existing route-test harness (copy the harness setup verbatim from `alertTemplates/templates.test.ts`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm exec vitest run src/routes/tickets/ticketResponseTemplates.test.ts`
Expected: FAIL — module/router does not exist.

- [ ] **Step 3: Implement the router**

```ts
// apps/api/src/routes/tickets/ticketResponseTemplates.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, asc } from 'drizzle-orm';
import { db } from '../../db';
import { ticketResponseTemplates } from '../../db/schema';
import { requireScope, requireMfa, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';

export const ticketResponseTemplateRoutes = new Hono();

// Reuse the tickets-write permission (same admin surface that manages ticket config).
const requireTicketWrite = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);

const scopes = requireScope('partner', 'system');

const createSchema = z.object({
  name: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  category: z.string().max(100).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

const updateSchema = createSchema.partial();
const idParam = z.object({ id: z.string().guid() });

ticketResponseTemplateRoutes.get('/ticket-response-templates', scopes, async (c) => {
  const auth = c.get('auth');
  const partnerId = auth.partnerId;
  if (!partnerId) return c.json({ error: 'Partner context required' }, 403);
  const rows = await db
    .select()
    .from(ticketResponseTemplates)
    .where(and(eq(ticketResponseTemplates.partnerId, partnerId), eq(ticketResponseTemplates.isActive, true)))
    .orderBy(asc(ticketResponseTemplates.category), asc(ticketResponseTemplates.sortOrder), asc(ticketResponseTemplates.name));
  return c.json({ data: rows });
});

ticketResponseTemplateRoutes.post('/ticket-response-templates', scopes, requireTicketWrite, requireMfa(), zValidator('json', createSchema), async (c) => {
  const auth = c.get('auth');
  const partnerId = auth.partnerId;
  if (!partnerId) return c.json({ error: 'Partner context required' }, 403);
  const data = c.req.valid('json');
  const [row] = await db.insert(ticketResponseTemplates).values({
    partnerId,
    name: data.name.trim(),
    body: data.body,
    category: data.category ?? null,
    sortOrder: data.sortOrder ?? 0,
    isActive: data.isActive ?? true,
    createdBy: auth.userId ?? null,
  }).returning();
  if (!row) return c.json({ error: 'Failed to create template' }, 500);
  writeRouteAudit(c, { action: 'ticket_response_template.create', resourceType: 'ticket_response_template', resourceId: row.id, resourceName: row.name });
  return c.json({ data: row }, 201);
});

ticketResponseTemplateRoutes.patch('/ticket-response-templates/:id', scopes, requireTicketWrite, requireMfa(), zValidator('param', idParam), zValidator('json', updateSchema), async (c) => {
  const auth = c.get('auth');
  const partnerId = auth.partnerId;
  if (!partnerId) return c.json({ error: 'Partner context required' }, 403);
  const { id } = c.req.valid('param');
  const data = c.req.valid('json');
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) patch.name = data.name.trim();
  if (data.body !== undefined) patch.body = data.body;
  if (data.category !== undefined) patch.category = data.category;
  if (data.sortOrder !== undefined) patch.sortOrder = data.sortOrder;
  if (data.isActive !== undefined) patch.isActive = data.isActive;
  const [row] = await db.update(ticketResponseTemplates)
    .set(patch)
    .where(and(eq(ticketResponseTemplates.id, id), eq(ticketResponseTemplates.partnerId, partnerId)))
    .returning();
  if (!row) return c.json({ error: 'Template not found' }, 404);
  writeRouteAudit(c, { action: 'ticket_response_template.update', resourceType: 'ticket_response_template', resourceId: row.id, resourceName: row.name });
  return c.json({ data: row });
});

ticketResponseTemplateRoutes.delete('/ticket-response-templates/:id', scopes, requireTicketWrite, requireMfa(), zValidator('param', idParam), async (c) => {
  const auth = c.get('auth');
  const partnerId = auth.partnerId;
  if (!partnerId) return c.json({ error: 'Partner context required' }, 403);
  const { id } = c.req.valid('param');
  const [row] = await db.delete(ticketResponseTemplates)
    .where(and(eq(ticketResponseTemplates.id, id), eq(ticketResponseTemplates.partnerId, partnerId)))
    .returning();
  if (!row) return c.json({ error: 'Template not found' }, 404);
  writeRouteAudit(c, { action: 'ticket_response_template.delete', resourceType: 'ticket_response_template', resourceId: id, resourceName: row.name });
  return c.json({ success: true });
});
```

NOTE: confirm `PERMISSIONS.TICKETS_WRITE` exists (grep `apps/api/src/services/permissions.ts` for the tickets permission constant; use the exact name — it may be `TICKETS_MANAGE` or similar). Use the same permission `ticketConfig.ts` uses for writes (`writePerm` there resolves a specific constant — reuse that one for consistency).

- [ ] **Step 4: Mount the router**

In `apps/api/src/routes/index.ts`, mount alongside the other ticket routers (match the existing `app.route('/', ticketConfigRoutes)` style — these routers define absolute paths, so mount at `'/'`):

```ts
import { ticketResponseTemplateRoutes } from './tickets/ticketResponseTemplates';
// ...
app.route('/', ticketResponseTemplateRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && pnpm exec vitest run src/routes/tickets/ticketResponseTemplates.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/tickets/ticketResponseTemplates.ts apps/api/src/routes/tickets/ticketResponseTemplates.test.ts apps/api/src/routes/index.ts
git commit -m "feat(api): CRUD routes for ticket canned responses"
```

---

## Task 6: Web — auto-reply settings UI (InboundEmailCard)

**Files:**
- Modify: `apps/web/src/components/settings/InboundEmailCard.tsx`
- Test: `apps/web/src/components/settings/InboundEmailCard.test.tsx` (add cases)

**Interfaces:**
- Consumes: `GET /ticket-config` (now returns `inbound.autoresponseSubject`/`autoresponseBody`); `variablesForContext` from `@breeze/shared`; `renderTemplate` from `@breeze/shared`.
- Produces: persisted `autoresponseSubject`/`autoresponseBody` via the existing `saveConfig` PATCH.

- [ ] **Step 1: Write the failing test**

Add to `InboundEmailCard.test.tsx` (mirror the file's existing fetch-mocking style — route mocks by URL, per the UserRiskPage lesson, not call order):

```ts
it('shows a live preview of the custom auto-reply body with sample variables', async () => {
  // Arrange: /ticket-config returns inbound.autoresponseBody = 'Hi {{requester_name}}'
  // Act: render, switch to / reveal the auto-reply editor
  // Assert: a preview node contains 'Hi Sample Requester' (sample value for requester_name)
});

it('saves the complete inbound object including auto-reply fields', async () => {
  // Arrange: render, type into the auto-reply subject/body inputs, blur/save
  // Assert: the PATCH /orgs/partners/me body.settings.ticketing.inbound includes
  //         autoresponseSubject + autoresponseBody AND still includes enabled,
  //         autoresponderEnabled, triageUnknownSenders (no field destroyed).
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/components/settings/InboundEmailCard.test.tsx`
Expected: FAIL — preview / new fields absent.

- [ ] **Step 3: Add fields, preview, and persistence**

In `InboundEmailCard.tsx`:

1. Extend the `InboundConfig` interface:
```ts
  autoresponseSubject: string | null;
  autoresponseBody: string | null;
```

2. Extend `saveConfig`'s `patch` Pick type and the `inbound` payload object so the new fields are always sent (the PATCH shallow-replaces `ticketing`, so omitting them destroys them):
```ts
      patch: Partial<
        Pick<InboundConfig, 'enabled' | 'defaultTriageOrgId' | 'autoresponderEnabled' | 'triageUnknownSenders' | 'autoresponseSubject' | 'autoresponseBody'>
      >,
```
```ts
      const inbound: Record<string, unknown> = {
        enabled: next.enabled,
        defaultTriageOrgId: next.defaultTriageOrgId,
        autoresponderEnabled: next.autoresponderEnabled,
        triageUnknownSenders: next.triageUnknownSenders,
        autoresponseSubject: next.autoresponseSubject,
        autoresponseBody: next.autoresponseBody,
      };
```

3. Below the autoresponder toggle, add (only meaningful when `cfg.autoresponderEnabled`) a subject input + body textarea with local draft state, an "insert variable" menu driven by `variablesForContext('autoreply')`, a Save button calling `saveConfig({ autoresponseSubject, autoresponseBody })`, and a live preview built with `renderTemplate(draftBody, SAMPLE)` where:
```ts
const SAMPLE: Record<string, string> = {
  ticket_number: 'T-2026-0001', ticket_subject: 'Email not syncing',
  requester_name: 'Sample Requester', requester_email: 'user@example.com',
  org_name: 'Acme Corp', partner_name: 'Your Company',
};
```
Use `data-testid` attributes (`inbound-autoreply-subject`, `inbound-autoreply-body`, `inbound-autoreply-preview`, `inbound-autoreply-save`, `inbound-autoreply-var-<key>`). Show a "Leave blank to use the default acknowledgement" hint when both are empty.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && pnpm exec vitest run src/components/settings/InboundEmailCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/InboundEmailCard.tsx apps/web/src/components/settings/InboundEmailCard.test.tsx
git commit -m "feat(web): customize ticket auto-reply subject/body in inbound settings"
```

---

## Task 7: Web — canned responses settings CRUD card + API helper

**Files:**
- Create: `apps/web/src/lib/ticketResponseTemplatesApi.ts`
- Create: `apps/web/src/components/settings/CannedResponsesCard.tsx`
- Test: `apps/web/src/components/settings/CannedResponsesCard.test.tsx`
- Modify: `apps/web/src/components/settings/TicketingSettingsTabs.tsx` (add subtab)

**Interfaces:**
- Produces (web API helper):
  ```ts
  interface CannedResponse { id: string; name: string; body: string; category: string | null; sortOrder: number; isActive: boolean; }
  listCannedResponses(): Promise<CannedResponse[]>
  createCannedResponse(input: { name: string; body: string; category?: string | null }): Promise<CannedResponse>
  updateCannedResponse(id: string, patch: Partial<Pick<CannedResponse,'name'|'body'|'category'|'sortOrder'|'isActive'>>): Promise<CannedResponse>
  deleteCannedResponse(id: string): Promise<void>
  ```
  Mutations use `runAction`; list uses `fetchWithAuth` directly.

- [ ] **Step 1: Write the API helper**

```ts
// apps/web/src/lib/ticketResponseTemplatesApi.ts
import { fetchWithAuth } from '../stores/auth';
import { runAction } from './runAction';
import { navigateTo } from './navigation';
import { loginPathWithNext } from './authScope';

export interface CannedResponse {
  id: string; name: string; body: string; category: string | null; sortOrder: number; isActive: boolean;
}
const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

export async function listCannedResponses(): Promise<CannedResponse[]> {
  const res = await fetchWithAuth('/ticket-response-templates');
  if (!res.ok) throw new Error('Failed to load canned responses');
  const body = (await res.json()) as { data: CannedResponse[] };
  return body.data;
}

export function createCannedResponse(input: { name: string; body: string; category?: string | null }): Promise<CannedResponse> {
  return runAction<CannedResponse>({
    request: () => fetchWithAuth('/ticket-response-templates', { method: 'POST', body: JSON.stringify(input) }),
    successMessage: 'Canned response created',
    errorFallback: 'Failed to create canned response',
    parseSuccess: (d) => (d as { data: CannedResponse }).data,
    onUnauthorized: UNAUTHORIZED,
  });
}

export function updateCannedResponse(id: string, patch: Partial<Pick<CannedResponse,'name'|'body'|'category'|'sortOrder'|'isActive'>>): Promise<CannedResponse> {
  return runAction<CannedResponse>({
    request: () => fetchWithAuth(`/ticket-response-templates/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    successMessage: 'Canned response saved',
    errorFallback: 'Failed to save canned response',
    parseSuccess: (d) => (d as { data: CannedResponse }).data,
    onUnauthorized: UNAUTHORIZED,
  });
}

export function deleteCannedResponse(id: string): Promise<void> {
  return runAction<void>({
    request: () => fetchWithAuth(`/ticket-response-templates/${id}`, { method: 'DELETE' }),
    successMessage: 'Canned response deleted',
    errorFallback: 'Failed to delete canned response',
    parseSuccess: () => undefined,
    onUnauthorized: UNAUTHORIZED,
  });
}
```

- [ ] **Step 2: Write the failing card test**

```ts
// apps/web/src/components/settings/CannedResponsesCard.test.tsx
// - lists existing templates from GET /ticket-response-templates
// - "New" form creates a template (POST) and shows it in the list
// - editing a template PATCHes it
// - delete removes it (DELETE)
// - the body editor's "insert variable" menu offers the full canned variable set
```

Mock fetch by URL+method (not call order). Assert at least: list render + create POST body shape.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/components/settings/CannedResponsesCard.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 4: Implement `CannedResponsesCard.tsx`**

Build a card matching the existing settings-card styling (see `InboundEmailCard.tsx` for the `rounded-lg border p-4` section pattern). Load via `listCannedResponses()` in a `useEffect`. Render a list grouped by `category`; each row has Edit/Delete. A "New canned response" inline form (name, optional category, body textarea with an "insert variable" menu from `variablesForContext('canned')`). Wire create/update/delete to the helper functions; on success, reload the list. Use `data-testid`s: `canned-responses-card`, `canned-response-row-<id>`, `canned-response-new`, `canned-response-name`, `canned-response-body`, `canned-response-category`, `canned-response-save`, `canned-response-delete-<id>`, `canned-response-var-<key>`.

- [ ] **Step 5: Add the "Canned responses" subtab**

In `TicketingSettingsTabs.tsx`, add a tab entry (partner-scope, same gating as the other partner tabs) and render the card:

```tsx
{activeTab === 'canned' && (
  <div data-testid="ticketing-tab-panel-canned">
    <CannedResponsesCard />
  </div>
)}
```
Add `'canned'` (label "Canned responses") to the tab list array near the existing `statuses`/`priorities`/`categories` entries, and import `CannedResponsesCard`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/web && pnpm exec vitest run src/components/settings/CannedResponsesCard.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/ticketResponseTemplatesApi.ts apps/web/src/components/settings/CannedResponsesCard.tsx apps/web/src/components/settings/CannedResponsesCard.test.tsx apps/web/src/components/settings/TicketingSettingsTabs.tsx
git commit -m "feat(web): canned responses management card in ticketing settings"
```

---

## Task 8: Web — composer canned-response picker + insert-at-cursor

**Files:**
- Create: `apps/web/src/components/tickets/CannedResponsePicker.tsx`
- Test: `apps/web/src/components/tickets/CannedResponsePicker.test.tsx`
- Modify: `apps/web/src/components/tickets/TicketComposer.tsx`
- Modify: `apps/web/src/components/tickets/TicketWorkbench.tsx`

**Interfaces:**
- Consumes: `CannedResponse` + `listCannedResponses` from `../../lib/ticketResponseTemplatesApi`; `renderTemplate` from `@breeze/shared`; `useAuthStore` (`user.name`) from `../../stores/auth`.
- `CannedResponsePicker` props: `{ templates: CannedResponse[]; vars: Record<string,string>; onInsert: (text: string) => void; disabled?: boolean }`.
- `TicketComposer` gains props: `templates?: CannedResponse[]; templateVars?: Record<string,string>`.

- [ ] **Step 1: Write the failing picker test**

```ts
// apps/web/src/components/tickets/CannedResponsePicker.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import CannedResponsePicker from './CannedResponsePicker';

it('renders nothing when there are no templates', () => {
  const { container } = render(<CannedResponsePicker templates={[]} vars={{}} onInsert={() => {}} />);
  expect(container.firstChild).toBeNull();
});

it('inserts the selected template with variables substituted', () => {
  const onInsert = vi.fn();
  render(
    <CannedResponsePicker
      templates={[{ id: '1', name: 'Greeting', body: 'Hi {{requester_name}}', category: null, sortOrder: 0, isActive: true }]}
      vars={{ requester_name: 'Ada' }}
      onInsert={onInsert}
    />
  );
  fireEvent.click(screen.getByTestId('canned-picker-button'));
  fireEvent.click(screen.getByTestId('canned-picker-option-1'));
  expect(onInsert).toHaveBeenCalledWith('Hi Ada');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/components/tickets/CannedResponsePicker.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the picker**

```tsx
// apps/web/src/components/tickets/CannedResponsePicker.tsx
import { useState } from 'react';
import { renderTemplate } from '@breeze/shared';
import type { CannedResponse } from '../../lib/ticketResponseTemplatesApi';

interface Props {
  templates: CannedResponse[];
  vars: Record<string, string>;
  onInsert: (text: string) => void;
  disabled?: boolean;
}

export default function CannedResponsePicker({ templates, vars, onInsert, disabled }: Props) {
  const [open, setOpen] = useState(false);
  if (templates.length === 0) return null;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        data-testid="canned-picker-button"
        className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        Canned response
      </button>
      {open && (
        <div
          className="absolute z-10 mt-1 max-h-64 w-64 overflow-auto rounded-md border bg-background py-1 shadow-md"
          data-testid="canned-picker-menu"
        >
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => { onInsert(renderTemplate(t.body, vars)); setOpen(false); }}
              data-testid={`canned-picker-option-${t.id}`}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
            >
              {t.category ? <span className="text-muted-foreground">{t.category} · </span> : null}
              {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the picker test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run src/components/tickets/CannedResponsePicker.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire the picker into `TicketComposer` with insert-at-cursor**

In `TicketComposer.tsx`:
1. Add props `templates?: CannedResponse[]` and `templateVars?: Record<string, string>` (import the `CannedResponse` type).
2. Add a `textareaRef` (`useRef<HTMLTextAreaElement>(null)`) on the textarea.
3. Add an `insertText` callback that splices at the caret:
```ts
const insertText = useCallback((text: string) => {
  const el = textareaRef.current;
  if (!el) { setContent((c) => c + text); return; }
  const start = el.selectionStart ?? content.length;
  const end = el.selectionEnd ?? content.length;
  const next = content.slice(0, start) + text + content.slice(end);
  setContent(next);
  // restore caret after the inserted text on next tick
  requestAnimationFrame(() => { el.focus(); const pos = start + text.length; el.setSelectionRange(pos, pos); });
}, [content]);
```
4. Render `<CannedResponsePicker templates={templates ?? []} vars={templateVars ?? {}} onInsert={insertText} disabled={disabled || sending} />` in the toolbar row (next to the Reply / Internal note tabs). The picker self-hides when `templates` is empty, so no conditional needed.

- [ ] **Step 6: Load templates + build vars in `TicketWorkbench`**

In `TicketWorkbench.tsx`:
1. `import { listCannedResponses, type CannedResponse } from '../../lib/ticketResponseTemplatesApi';`
2. `import { useAuthStore } from '../../stores/auth';`
3. Add state `const [cannedTemplates, setCannedTemplates] = useState<CannedResponse[]>([]);` and load once in a `useEffect`:
```ts
useEffect(() => { listCannedResponses().then(setCannedTemplates).catch(() => setCannedTemplates([])); }, []);
```
4. Build the variable map from the loaded `ticket` + current user, memoized:
```ts
const agentName = useAuthStore.getState().user?.name ?? '';
const templateVars = useMemo<Record<string, string>>(() => ticket ? ({
  ticket_number: ticket.internalNumber ?? '',
  ticket_subject: ticket.subject ?? '',
  requester_name: ticket.submitterName ?? '',
  requester_email: ticket.submitterEmail ?? '',
  org_name: ticket.orgName ?? '',
  partner_name: '',
  agent_name: agentName,
  current_status: String(ticket.status ?? ''),
  current_priority: String(ticket.priority ?? ''),
}) : {}, [ticket, agentName]);
```
(`partner_name` is left blank client-side — it isn't on the ticket payload and isn't worth an extra fetch in v1; the registry still lists it for auto-reply where the server fills it.)
5. Pass to the composer:
```tsx
<TicketComposer requesterName={ticket.submitterName} onSend={sendComment} templates={cannedTemplates} templateVars={templateVars} />
```

- [ ] **Step 7: Run the composer + workbench tests**

Run: `cd apps/web && pnpm exec vitest run src/components/tickets/TicketComposer.test.tsx src/components/tickets/CannedResponsePicker.test.tsx`
Expected: PASS. If `TicketComposer.test.tsx` doesn't exist, add a focused test asserting that selecting a canned response inserts substituted text into the textarea.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/tickets/CannedResponsePicker.tsx apps/web/src/components/tickets/CannedResponsePicker.test.tsx apps/web/src/components/tickets/TicketComposer.tsx apps/web/src/components/tickets/TicketWorkbench.tsx
git commit -m "feat(web): insert canned responses into the ticket reply composer"
```

---

## Task 9: Full-suite verification + open PR

- [ ] **Step 1: Run the affected suites**

```bash
cd packages/shared && pnpm exec vitest run src/utils/ticketTemplate.test.ts
cd ../../apps/api && pnpm exec vitest run src/services/ticketConfigService.test.ts src/services/inboundEmail/autoresponseTemplate.test.ts src/jobs/ticketNotifyWorker.test.ts src/routes/tickets/ticketResponseTemplates.test.ts
cd ../web && pnpm exec vitest run src/components/settings/InboundEmailCard.test.tsx src/components/settings/CannedResponsesCard.test.tsx src/components/tickets/CannedResponsePicker.test.tsx
```
Expected: all PASS.

- [ ] **Step 2: Drift + typecheck**

```bash
cd /Users/toddhebebrand/conductor/workspaces/breeze/surat
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
pnpm -w typecheck   # or the repo's typecheck script (astro check / tsc)
```
Expected: no drift; no type errors.

- [ ] **Step 3: Open the PR (hold for Todd's review — frontend work)**

```bash
gh pr create --base main --title "feat(tickets): customizable auto-reply + canned responses" --body "$(cat <<'EOF'
## Summary
- Partners can customize the inbound-ticket auto-reply email (subject/body with merge variables); blank falls back to the existing default.
- New partner-wide canned-response library; technicians insert templates into the reply composer with variables substituted from the ticket.
- One shared `{{variable}}` engine in `@breeze/shared` powers both.

## Notes
- New table `ticket_response_templates` (partner-axis RLS, allowlisted in the contract test).
- No behavior change for existing partners (auto-reply default preserved).
- Frontend — holding for Todd's review before merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes (addressed)

- **Spec coverage:** §1 engine → Task 1; §2 auto-reply storage+render → Tasks 2–3; §3 canned schema/routes → Tasks 4–5; §4 web (composer + settings) → Tasks 6–8; §5 testing → folded into each task + Task 9. All covered.
- **Discovered gotcha (added):** `partnerSettingsSchema.ticketing.inbound` is a closed Zod object — new fields stripped without Task 2 Step 4. Also flagged the pre-existing `triageUnknownSenders` omission there (fixed in the same step).
- **Type consistency:** `renderTemplate(template, vars)` signature identical across Tasks 1/3/6/7/8; `CannedResponse` shape identical in the API helper (Task 7) and picker (Task 8); `buildAutoresponseEmail` new signature defined in Task 3 and consumed only there.
- **Verify-before-implement reminders:** Task 5 Step 3 says to confirm the exact `PERMISSIONS.TICKETS_*` constant and reuse `ticketConfig.ts`'s write permission; Task 3 Step 5 says to confirm `partners.name`/`tickets.submitterName`/`organizations` imports.
```

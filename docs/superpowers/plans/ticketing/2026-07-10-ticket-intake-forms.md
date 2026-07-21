# Ticket Intake Forms — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin-defined ticket intake forms (dual-axis org/partner config table) that pre-structure ticket creation — shared field-schema validators, `ticket_forms` table + RLS, CRUD API, `createTicket` integration, partner-settings builder UI, and a "Start from a form" picker on the staff Create Ticket page.

**Architecture:** A form is a self-contained row: field definitions live in a `fields` jsonb column validated by shared Zod schemas; on ticket creation the service validates responses, composes subject/description via pure shared helpers, and snapshots structured responses into the existing (unused) `tickets.custom_fields` jsonb. Ownership follows the Partner-Wide First playbook (`org_id XOR partner_id`, single dual-axis RLS policy, `canManagePartnerWidePolicies` write gate). Reads that must see partner-owned rows from org-scoped RLS contexts go through a small system-context service (`ticketFormService`), mirroring `assertCategoryInPartner`.

**Tech Stack:** Hono + zValidator, Drizzle ORM, hand-written SQL migration, Zod 4 (`packages/shared`), React (apps/web) with `runAction`/`fetchWithAuth`, Vitest.

**Spec:** `docs/superpowers/specs/ticketing/2026-07-10-ticket-intake-forms-design.md` (this plan = Phase 1 only; portal + AI are later plans).

## Global Constraints

- Zod 4 everywhere: `.guid()` NOT `.uuid()` (`packages/shared` has `"zod": "^4.4.3"`).
- Migration file `apps/api/migrations/2026-07-10-ticket-forms.sql`: idempotent (`IF NOT EXISTS`, guarded CHECK, `DROP POLICY IF EXISTS` then `CREATE`), NO inner `BEGIN;`/`COMMIT;`, RLS in the SAME file as the table.
- New `org_id` column ⇒ register `'ticket_forms'` in `ORG_CASCADE_DELETE_ORDER` (**alphabetical**) AND in the partner-cascade list in `apps/api/src/services/tenantCascade.ts` (mirror how `software_policies` is registered) AND in `DUAL_AXIS_TENANT_TABLES` in `rls-coverage.integration.test.ts` — all in this same PR.
- Never trust a client-supplied partner id: partner-wide writes derive `partner_id` from the caller's token (`auth.partnerId`).
- App-layer dual-axis read branches must be gated on `auth.scope === 'partner'` (org tokens carry a partnerId but never pass `breeze_has_partner_access`).
- Web mutations wrap requests in `runAction` (`apps/web/src/lib/runAction.ts`); catch pattern: rethrow non-`ActionError`, swallow `ActionError`.
- All interactive web elements get `data-testid` attributes (e2e queries by testid only).
- Route files mounted at `/` carry absolute paths and per-route `authMiddleware` (NOT `.use('*', ...)`) — the #1383 footgun documented in `ticketResponseTemplates.ts`.
- No `device` field type, no drag-and-drop, no conditional field logic, no file uploads (spec §8).
- Work on branch `feat/ticket-intake-forms` (create from `main` in an isolated worktree at execution start).

---

### Task 1: Shared validators, response validation, and composition helpers

**Files:**
- Create: `packages/shared/src/validators/ticketForms.ts`
- Create: `packages/shared/src/validators/ticketForms.test.ts`
- Modify: `packages/shared/src/validators/index.ts` (add one line: `export * from './ticketForms';` — the barrel already has `export * from './tickets';` at line ~770)

**Interfaces:**
- Consumes: `ticketPrioritySchema` from `./tickets` (already exists).
- Produces (used by Tasks 4–8):
  - `ticketFormFieldSchema`, `ticketFormFieldsSchema` (array, max 30, unique keys)
  - `createTicketFormSchema` (has `ownerScope: z.enum(['organization','partner']).optional()`, `orgId` optional guid)
  - `updateTicketFormSchema` = `createTicketFormSchema.partial().omit({ ownerScope: true, orgId: true })`
  - `type TicketFormField`, `type CreateTicketFormInput`, `type TicketFormLike`
  - `buildResponseValidator(fields: TicketFormField[]): z.ZodObject` — strict object; required checkbox = must be `true`
  - `coerceFormResponses(fields: TicketFormField[], raw: Record<string, unknown>): Record<string, unknown>` — `'' → undefined`, number strings → numbers
  - `renderTitleTemplate(template: string | null | undefined, formName: string, responses: Record<string, unknown>): string` — `{{key}}` interpolation, missing key → `''`, blank result → formName
  - `renderFormResponses(form: TicketFormLike, responses: Record<string, unknown>): string` — markdown block (intro + `**Form name** (form)` + `- **Label:** value` lines)

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/validators/ticketForms.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  ticketFormFieldsSchema,
  createTicketFormSchema,
  updateTicketFormSchema,
  buildResponseValidator,
  coerceFormResponses,
  renderTitleTemplate,
  renderFormResponses,
  type TicketFormField
} from './ticketForms';

const fields: TicketFormField[] = [
  { key: 'affected_user', label: 'Affected user', type: 'text', required: true },
  { key: 'start_date', label: 'Start date', type: 'date', required: true },
  { key: 'needs_vpn', label: 'Needs VPN', type: 'checkbox', required: false },
  { key: 'license_count', label: 'License count', type: 'number', required: false },
  { key: 'department', label: 'Department', type: 'select', required: true, options: ['Sales', 'Ops'] }
];

describe('ticketFormFieldsSchema', () => {
  it('accepts a valid field list and rejects duplicate keys', () => {
    expect(ticketFormFieldsSchema.safeParse(fields).success).toBe(true);
    expect(ticketFormFieldsSchema.safeParse([fields[0], fields[0]]).success).toBe(false);
  });

  it('rejects select without options, options on non-select, bad keys, >30 fields', () => {
    expect(ticketFormFieldsSchema.safeParse([{ key: 'a', label: 'A', type: 'select', required: false }]).success).toBe(false);
    expect(ticketFormFieldsSchema.safeParse([{ key: 'a', label: 'A', type: 'text', required: false, options: ['x'] }]).success).toBe(false);
    expect(ticketFormFieldsSchema.safeParse([{ key: 'Bad-Key', label: 'A', type: 'text', required: false }]).success).toBe(false);
    const many = Array.from({ length: 31 }, (_, i) => ({ key: `f_${i}`, label: `F${i}`, type: 'text' as const, required: false }));
    expect(ticketFormFieldsSchema.safeParse(many).success).toBe(false);
  });
});

describe('createTicketFormSchema / updateTicketFormSchema', () => {
  it('accepts a minimal create payload and defaults', () => {
    const r = createTicketFormSchema.safeParse({ name: 'New user onboarding', fields });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.isActive).toBe(true);
      expect(r.data.showInPortal).toBe(true);
      expect(r.data.defaultTags).toEqual([]);
      expect(r.data.sortOrder).toBe(0);
    }
  });

  it('update schema refuses ownerScope and orgId', () => {
    const r = updateTicketFormSchema.safeParse({ ownerScope: 'partner', orgId: '3f2f1d8e-1111-4222-8333-444455556666', name: 'x' });
    // .omit() strips the keys from the schema; strict() makes them errors — we use strip semantics, so keys are silently dropped
    expect(r.success).toBe(true);
    if (r.success) {
      expect('ownerScope' in r.data).toBe(false);
      expect('orgId' in r.data).toBe(false);
    }
  });
});

describe('buildResponseValidator', () => {
  const v = buildResponseValidator(fields);

  it('accepts valid responses', () => {
    const r = v.safeParse({ affected_user: 'jdoe@client.example', start_date: '2026-07-14', needs_vpn: true, license_count: 3, department: 'Sales' });
    expect(r.success).toBe(true);
  });

  it('rejects missing required, unknown keys, bad select option, bad date', () => {
    expect(v.safeParse({ start_date: '2026-07-14', department: 'Sales' }).success).toBe(false); // missing affected_user
    expect(v.safeParse({ affected_user: 'x', start_date: '2026-07-14', department: 'Sales', extra: 1 }).success).toBe(false);
    expect(v.safeParse({ affected_user: 'x', start_date: '2026-07-14', department: 'HR' }).success).toBe(false);
    expect(v.safeParse({ affected_user: 'x', start_date: 'tomorrow', department: 'Sales' }).success).toBe(false);
  });

  it('required checkbox must be true', () => {
    const consent = buildResponseValidator([{ key: 'confirmed', label: 'I rebooted', type: 'checkbox', required: true }]);
    expect(consent.safeParse({ confirmed: true }).success).toBe(true);
    expect(consent.safeParse({ confirmed: false }).success).toBe(false);
  });
});

describe('coerceFormResponses', () => {
  it('coerces number strings, drops empty strings, passes booleans', () => {
    expect(coerceFormResponses(fields, { affected_user: 'x', license_count: '4', needs_vpn: false, department: '' }))
      .toEqual({ affected_user: 'x', license_count: 4, needs_vpn: false });
  });
});

describe('rendering', () => {
  it('interpolates title template, blanks missing keys, falls back to form name', () => {
    expect(renderTitleTemplate('Onboard {{affected_user}} ({{missing}})', 'New user', { affected_user: 'jdoe' })).toBe('Onboard jdoe ()');
    expect(renderTitleTemplate('   ', 'New user', {})).toBe('New user');
    expect(renderTitleTemplate(null, 'New user', {})).toBe('New user');
  });

  it('renders a markdown block with intro, Yes/No checkboxes, and em-dash for blanks', () => {
    const out = renderFormResponses(
      { name: 'New user onboarding', descriptionIntro: 'HR request.', fields },
      { affected_user: 'jdoe@client.example', start_date: '2026-07-14', needs_vpn: true, department: 'Sales' }
    );
    expect(out).toContain('HR request.');
    expect(out).toContain('**New user onboarding** (form)');
    expect(out).toContain('- **Affected user:** jdoe@client.example');
    expect(out).toContain('- **Needs VPN:** Yes');
    expect(out).toContain('- **License count:** —');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/shared test -- ticketForms`
Expected: FAIL — `Cannot find module './ticketForms'` (or equivalent resolution error).

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/validators/ticketForms.ts`:

```ts
import { z } from 'zod';
import { ticketPrioritySchema } from './tickets';

export const TICKET_FORM_FIELD_TYPES = ['text', 'textarea', 'select', 'checkbox', 'date', 'number'] as const;
export type TicketFormFieldType = (typeof TICKET_FORM_FIELD_TYPES)[number];

const fieldKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,49}$/, 'lowercase letters, digits and underscores; must start with a letter');

export const ticketFormFieldSchema = z
  .object({
    key: fieldKeySchema,
    label: z.string().min(1).max(200),
    type: z.enum(TICKET_FORM_FIELD_TYPES),
    required: z.boolean(),
    helpText: z.string().max(500).optional(),
    placeholder: z.string().max(200).optional(),
    options: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
    defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional()
  })
  .superRefine((f, ctx) => {
    if (f.type === 'select' && (!f.options || f.options.length === 0)) {
      ctx.addIssue({ code: 'custom', message: 'select fields require options', path: ['options'] });
    }
    if (f.type !== 'select' && f.options !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'options are only valid on select fields', path: ['options'] });
    }
  });

export type TicketFormField = z.infer<typeof ticketFormFieldSchema>;

export const ticketFormFieldsSchema = z
  .array(ticketFormFieldSchema)
  .max(30)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    for (const f of fields) {
      if (seen.has(f.key)) ctx.addIssue({ code: 'custom', message: `duplicate field key: ${f.key}` });
      seen.add(f.key);
    }
  });

export const createTicketFormSchema = z.object({
  // Ownership axis (Partner-Wide First, epic #2135, mirrors software policies
  // #2126): 'partner' = all-orgs form; the server derives the partner from the
  // caller's own token — a client-supplied partner id is NEVER trusted.
  // orgId is only consulted when ownerScope is 'organization' (or absent).
  ownerScope: z.enum(['organization', 'partner']).optional(),
  orgId: z.string().guid().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  categoryId: z.string().guid().nullable().optional(),
  fields: ticketFormFieldsSchema,
  titleTemplate: z.string().max(300).optional(),
  descriptionIntro: z.string().max(5000).optional(),
  defaultPriority: ticketPrioritySchema.optional(),
  defaultTags: z.array(z.string().min(1).max(100)).max(20).default([]),
  showInPortal: z.boolean().default(true),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0)
});

export const updateTicketFormSchema = createTicketFormSchema.partial().omit({ ownerScope: true, orgId: true });

export type CreateTicketFormInput = z.infer<typeof createTicketFormSchema>;
export type UpdateTicketFormInput = z.infer<typeof updateTicketFormSchema>;

/** The subset of a ticket_forms row the rendering/validation helpers need. */
export interface TicketFormLike {
  name: string;
  descriptionIntro?: string | null;
  fields: TicketFormField[];
}

/**
 * Strict runtime validator for a submission against a form's field list.
 * Shared by web (inline errors), API (authoritative), and later the portal.
 * Required checkbox = consent-style: must be exactly true.
 */
export function buildResponseValidator(fields: TicketFormField[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) {
    let s: z.ZodType;
    switch (f.type) {
      case 'text':
        s = f.required ? z.string().min(1).max(1000) : z.string().max(1000);
        break;
      case 'textarea':
        s = f.required ? z.string().min(1).max(10_000) : z.string().max(10_000);
        break;
      case 'select':
        s = z.enum(f.options as [string, ...string[]]);
        break;
      case 'checkbox':
        s = f.required ? z.literal(true) : z.boolean();
        break;
      case 'date':
        s = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
        break;
      case 'number':
        s = z.number().finite();
        break;
    }
    shape[f.key] = f.required ? s : s.optional();
  }
  return z.object(shape).strict();
}

/**
 * Normalize raw UI values before validation: empty strings become undefined
 * (so optional fields don't fail), number-field strings become numbers.
 */
export function coerceFormResponses(
  fields: TicketFormField[],
  raw: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = raw[f.key];
    if (v === undefined || v === null || v === '') continue;
    if (f.type === 'number' && typeof v === 'string') {
      const n = Number(v);
      out[f.key] = Number.isNaN(n) ? v : n;
      continue;
    }
    out[f.key] = v;
  }
  return out;
}

/** {{key}} interpolation; unknown keys render as ''. Blank result falls back to the form name. */
export function renderTitleTemplate(
  template: string | null | undefined,
  formName: string,
  responses: Record<string, unknown>
): string {
  if (!template || !template.trim()) return formName;
  const rendered = template
    .replace(/\{\{\s*([a-z][a-z0-9_]{0,49})\s*\}\}/g, (_m, key: string) => {
      const v = responses[key];
      return v === undefined || v === null ? '' : String(v);
    })
    .trim();
  return rendered.length > 0 ? rendered : formName;
}

export function formatFormResponseValue(field: TicketFormField, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (field.type === 'checkbox') return value === true ? 'Yes' : 'No';
  return String(value);
}

/**
 * Deterministic markdown block appended to the ticket description. The
 * rendered ticket must stand alone: every consumer (workbench, email, AI,
 * PSA sync) reads this without knowing forms exist.
 */
export function renderFormResponses(form: TicketFormLike, responses: Record<string, unknown>): string {
  const lines: string[] = [];
  if (form.descriptionIntro && form.descriptionIntro.trim()) {
    lines.push(form.descriptionIntro.trim(), '');
  }
  lines.push(`**${form.name}** (form)`);
  for (const f of form.fields) {
    lines.push(`- **${f.label}:** ${formatFormResponseValue(f, responses[f.key])}`);
  }
  return lines.join('\n');
}
```

Then add to `packages/shared/src/validators/index.ts`, alphabetically near the existing `export * from './tickets';` line:

```ts
export * from './ticketForms';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/shared test -- ticketForms`
Expected: PASS (all describe blocks green). Also run `pnpm --filter @breeze/shared test` to confirm no barrel-export name collisions.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/ticketForms.ts packages/shared/src/validators/ticketForms.test.ts packages/shared/src/validators/index.ts
git commit -m "feat(shared): ticket intake form validators, response validation, and rendering helpers"
```

---

### Task 2: Drizzle schema + SQL migration

**Files:**
- Create: `apps/api/src/db/schema/ticketForms.ts`
- Modify: `apps/api/src/db/schema/index.ts` (add `export * from './ticketForms';` — mirror how `./ticketResponseTemplates` is exported)
- Create: `apps/api/migrations/2026-07-10-ticket-forms.sql`

**Interfaces:**
- Consumes: `partners` / `organizations` / `users` / `ticketCategories` table objects and `ticketPriorityEnum` — copy the exact import paths used at the top of `apps/api/src/db/schema/tickets.ts` and `apps/api/src/db/schema/portal.ts` (open both; `ticketPriorityEnum` is defined in `portal.ts`, `ticketCategories` in `tickets.ts`).
- Produces: `ticketForms` Drizzle table (columns exactly as below) — used by Tasks 3–6.

- [ ] **Step 1: Confirm the pg enum name and column idioms**

Open `apps/api/src/db/schema/portal.ts` and note (a) the first argument of `pgEnum(...)` for `ticketPriorityEnum` (expected `'ticket_priority'` — the migration SQL below assumes this; adjust if different), and (b) the exact Drizzle expression used for the `tickets.tags` text-array column and `tickets.customFields` jsonb column. Reuse those idioms verbatim for `default_tags` and `fields`.

- [ ] **Step 2: Write the Drizzle schema**

Create `apps/api/src/db/schema/ticketForms.ts` (fix import paths per Step 1):

```ts
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import type { TicketFormField } from '@breeze/shared';
import { organizations } from './organizations';
import { partners } from './partners';
import { users } from './users';
import { ticketCategories } from './tickets';
import { ticketPriorityEnum } from './portal';

/**
 * Ticket intake forms (spec: docs/superpowers/specs/ticketing/2026-07-10-ticket-intake-forms-design.md).
 * Dual-axis ownership (Partner-Wide First, epic #2135): org_id XOR partner_id,
 * enforced by ticket_forms_one_owner_chk in the migration. Field definitions
 * are a self-contained jsonb document validated by ticketFormFieldsSchema in
 * packages/shared — NOT rows in custom_field_definitions (device-only system).
 */
export const ticketForms = pgTable(
  'ticket_forms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    // Plain FK; partner ownership of the category is validated app-side
    // (assertCategoryInPartner), same as tickets.category_id.
    categoryId: uuid('category_id').references(() => ticketCategories.id, { onDelete: 'set null' }),
    fields: jsonb('fields').$type<TicketFormField[]>().notNull().default([]),
    titleTemplate: varchar('title_template', { length: 300 }),
    descriptionIntro: text('description_intro'),
    defaultPriority: ticketPriorityEnum('default_priority'),
    defaultTags: text('default_tags').array().notNull().default([]),
    showInPortal: boolean('show_in_portal').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull()
  },
  (t) => [index('ticket_forms_partner_id_idx').on(t.partnerId), index('ticket_forms_org_id_idx').on(t.orgId)]
);
```

Add `export * from './ticketForms';` to `apps/api/src/db/schema/index.ts`.

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/2026-07-10-ticket-forms.sql`:

```sql
-- Ticket intake forms (spec: docs/superpowers/specs/ticketing/2026-07-10-ticket-intake-forms-design.md).
-- Dual-axis config table (Partner-Wide First, epic #2135): org_id XOR partner_id.
-- Idempotent: CREATE IF NOT EXISTS, guarded CHECK, DROP POLICY IF EXISTS then CREATE.
-- No inner BEGIN/COMMIT (autoMigrate wraps each file in a transaction).

CREATE TABLE IF NOT EXISTS ticket_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(200) NOT NULL,
  description text,
  category_id uuid REFERENCES ticket_categories(id) ON DELETE SET NULL,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  title_template varchar(300),
  description_intro text,
  default_priority ticket_priority,
  default_tags text[] NOT NULL DEFAULT '{}',
  show_in_portal boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- Exactly one owner: org-scoped XOR partner-wide.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ticket_forms_one_owner_chk'
      AND conrelid = 'ticket_forms'::regclass
  ) THEN
    ALTER TABLE ticket_forms
      ADD CONSTRAINT ticket_forms_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ticket_forms_partner_id_idx ON ticket_forms(partner_id);
CREATE INDEX IF NOT EXISTS ticket_forms_org_id_idx ON ticket_forms(org_id);

-- RLS: dual-axis (shape: org-access OR partner-access OR system), one policy
-- for all commands — mirrors 2026-07-01-maintenance-windows-partner-ownership.sql.
ALTER TABLE ticket_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_forms FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ticket_forms_isolation ON ticket_forms;
CREATE POLICY ticket_forms_isolation
  ON ticket_forms
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
```

- [ ] **Step 4: Apply and verify no drift**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
```

Expected: migration applies cleanly and drift check reports no differences. If drift complains about the jsonb/array defaults, adjust the Drizzle `.default(...)` expressions to whatever idiom `portal.ts` uses for `tickets.customFields`/`tags` (Step 1) — the SQL file is the source of truth, the schema file must match it.

- [ ] **Step 5: Verify re-apply is a no-op**

Re-run the migration runner (start the API once, or run the migration test): `pnpm --filter @breeze/api test -- autoMigrate`
Expected: PASS — ordering/idempotency regression suite green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema/ticketForms.ts apps/api/src/db/schema/index.ts apps/api/migrations/2026-07-10-ticket-forms.sql
git commit -m "feat(api): ticket_forms table — dual-axis schema, migration, RLS policy"
```

---

### Task 3: Tenancy registrations + RLS integration test

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`DUAL_AXIS_TENANT_TABLES`, ~line 208)
- Modify: `apps/api/src/services/tenantCascade.ts` (`ORG_CASCADE_DELETE_ORDER`, ~line 63, alphabetical; plus the partner-cascade list — find how `'software_policies'` is registered in this file and mirror both registrations)
- Create: `apps/api/src/__tests__/integration/ticketFormsPartnerRls.integration.test.ts`

**Interfaces:**
- Consumes: `ticketForms` from Task 2; `createPartner`, `createOrganization` from `apps/api/src/__tests__/integration/db-utils.ts` (open the file to confirm signatures — `ssoProvidersPartnerRls.integration.test.ts` uses them; mirror exactly how that suite creates a partner-owned org).
- Produces: contract-test registrations that keep CI green; a partner-RLS suite proving isolation.

- [ ] **Step 1: Register in DUAL_AXIS_TENANT_TABLES**

In `rls-coverage.integration.test.ts`, add to the set (alphabetical placement among entries):

```ts
  // ticket_forms (spec 2026-07-10): an intake form is org-owned (org_id set,
  // partner_id NULL) OR a partner-wide form (partner_id set, org_id NULL) —
  // XOR-enforced by ticket_forms_one_owner_chk. First dual-axis table in the
  // ticketing domain (ticket_categories / ticket_response_templates are
  // partner-axis-only).
  'ticket_forms',
```

- [ ] **Step 2: Register in the cascade lists**

In `apps/api/src/services/tenantCascade.ts`: insert `'ticket_forms',` into `ORG_CASCADE_DELETE_ORDER` alphabetically (between `'ticket_alert_links'` and `'ticket_parts'`). Then grep the same file for `software_policies` — every list it appears in (org cascade AND the partner-side cascade list), add `'ticket_forms'` in the same alphabetical style.

- [ ] **Step 3: Write the RLS integration test**

Create `apps/api/src/__tests__/integration/ticketFormsPartnerRls.integration.test.ts` (modeled line-for-line on `ssoProvidersPartnerRls.integration.test.ts` — reuse its context helpers verbatim):

```ts
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { ticketForms } from '../../db/schema';
import { listTicketFormsForOrg } from '../../services/ticketFormService';
import { createOrganization, createPartner } from './db-utils';

const created: string[] = [];

afterEach(async () => {
  if (created.length === 0) return;
  await withDbAccessContext(
    { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null },
    async () => {
      for (const id of created) {
        await db.delete(ticketForms).where(eq(ticketForms.id, id));
      }
    }
  );
  created.length = 0;
});

function systemContext(): DbAccessContext {
  return { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
}

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null };
}

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

const baseForm = { name: 'Onboarding', fields: [], defaultTags: [] };

describe('ticket_forms partner RLS', () => {
  it('partner B forging partner A partner_id is rejected (42501)', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db.insert(ticketForms).values({ ...baseForm, partnerId: partnerA.id, orgId: null }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('XOR owner check: both or neither owner violates 23514', async () => {
    const partner = await createPartner();
    const org = await createOrganization(partner.id);
    await expect(
      withDbAccessContext(systemContext(), () =>
        db.insert(ticketForms).values({ ...baseForm, partnerId: partner.id, orgId: org.id }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(
      withDbAccessContext(systemContext(), () =>
        db.insert(ticketForms).values({ ...baseForm, partnerId: null, orgId: null }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('org B cannot read org A forms; org tokens cannot read partner-wide forms', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization(partner.id);
    const orgB = await createOrganization(partner.id);

    const [orgForm] = await withDbAccessContext(systemContext(), () =>
      db.insert(ticketForms).values({ ...baseForm, orgId: orgA.id, partnerId: null }).returning()
    );
    const [partnerForm] = await withDbAccessContext(systemContext(), () =>
      db.insert(ticketForms).values({ ...baseForm, name: 'Partner-wide', partnerId: partner.id, orgId: null }).returning()
    );
    created.push(orgForm.id, partnerForm.id);

    const visibleToOrgB = await withDbAccessContext(orgContext(orgB.id), () =>
      db.select().from(ticketForms).where(eq(ticketForms.id, orgForm.id))
    );
    expect(visibleToOrgB).toEqual([]);

    // Org-scoped RLS context: partner-wide rows are invisible even though the
    // org belongs to that partner — this is WHY listTicketFormsForOrg reads
    // under a system context (heartbeat/#1105 pattern).
    const partnerRowsFromOrgCtx = await withDbAccessContext(orgContext(orgA.id), () =>
      db.select().from(ticketForms).where(eq(ticketForms.id, partnerForm.id))
    );
    expect(partnerRowsFromOrgCtx).toEqual([]);
  });

  it('fan-out equivalent: listTicketFormsForOrg resolves org-owned + partner-wide, never cross-partner', async () => {
    const partner = await createPartner();
    const otherPartner = await createPartner();
    const org = await createOrganization(partner.id);
    const otherOrg = await createOrganization(otherPartner.id);

    const rows = await withDbAccessContext(systemContext(), () =>
      db
        .insert(ticketForms)
        .values([
          { ...baseForm, name: 'Org-owned', orgId: org.id, partnerId: null },
          { ...baseForm, name: 'Partner-wide', partnerId: partner.id, orgId: null },
          { ...baseForm, name: 'Other partner', partnerId: otherPartner.id, orgId: null },
          { ...baseForm, name: 'Inactive', partnerId: partner.id, orgId: null, isActive: false }
        ])
        .returning()
    );
    created.push(...rows.map((r) => r.id));

    // Service manages its own system context — call it from OUTSIDE any request context.
    const forOrg = await listTicketFormsForOrg({ id: org.id, partnerId: partner.id });
    expect(forOrg.map((f) => f.name).sort()).toEqual(['Org-owned', 'Partner-wide']);

    const forOtherOrg = await listTicketFormsForOrg({ id: otherOrg.id, partnerId: otherPartner.id });
    expect(forOtherOrg.map((f) => f.name)).toEqual(['Other partner']);
  });
});
```

Note: `listTicketFormsForOrg` is implemented in Task 4. Write this file now; the last test stays red until Task 4 lands — run only the first three tests in this task if executing strictly sequentially, or defer this task's final run until after Task 4.

- [ ] **Step 4: Run the contract + suite against the integration DB**

Integration tests need the real Postgres from the integration compose setup (port 5433 — check `apps/api/vitest.integration.config.ts` and the `test:integration` script in `apps/api/package.json` for the exact invocation). Run:

```bash
cd apps/api && pnpm vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/ticketFormsPartnerRls.integration.test.ts
```

Expected: rls-coverage PASS (ticket_forms recognized as dual-axis), tenantCascade PASS (list complete), ticketFormsPartnerRls — first three tests PASS, fan-out test fails until Task 4 (acceptable; re-run in Task 4 Step 4).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/services/tenantCascade.ts apps/api/src/__tests__/integration/ticketFormsPartnerRls.integration.test.ts
git commit -m "test(api): register ticket_forms in tenancy contracts + partner RLS suite"
```

---

### Task 4: ticketFormService — system-context reads + pure intake application

**Files:**
- Create: `apps/api/src/services/ticketFormService.ts`
- Create: `apps/api/src/services/ticketFormService.test.ts`

**Interfaces:**
- Consumes: `db`, `runOutsideDbContext`, `withSystemDbAccessContext` from `../db`; `ticketForms` from `../db/schema`; shared helpers from Task 1.
- Produces (used by Tasks 5–6):
  - `class TicketFormError extends Error { status: number }` — deliberately its OWN error class, not `TicketServiceError`, to avoid a ticketService↔ticketFormService import cycle (cycles break vi.mock — see repo memory `cross_layer_import_cycle_breaks_mocked_tests`). `createTicket` maps it.
  - `listTicketFormsForOrg(org: { id: string; partnerId: string }, opts?: { portalOnly?: boolean }): Promise<TicketFormRow[]>`
  - `getTicketFormForOrg(formId: string, org: { id: string; partnerId: string }): Promise<TicketFormRow>` — throws `TicketFormError` 404 (missing) / 400 (wrong tenant or inactive)
  - `applyIntakeForm(form, rawResponses): { responses; subjectFromForm: string; descriptionBlock: string; categoryId: string | null; defaultPriority: TicketPriority | null; defaultTags: string[]; intakeSnapshot }` — PURE (no db), throws `TicketFormError` 400 on validation failure
  - `type TicketFormRow = typeof ticketForms.$inferSelect`

- [ ] **Step 1: Write the failing unit test (pure logic + guard logic with mocked db)**

Create `apps/api/src/services/ticketFormService.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbSelectMock } = vi.hoisted(() => ({ dbSelectMock: vi.fn() }));

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => dbSelectMock()),
          orderBy: vi.fn(() => dbSelectMock())
        }))
      }))
    }))
  }
}));

import { applyIntakeForm, getTicketFormForOrg, TicketFormError } from './ticketFormService';

const form = {
  id: 'form-1',
  orgId: null,
  partnerId: 'p-1',
  name: 'New user onboarding',
  description: null,
  categoryId: 'cat-1',
  fields: [
    { key: 'affected_user', label: 'Affected user', type: 'text', required: true },
    { key: 'needs_vpn', label: 'Needs VPN', type: 'checkbox', required: false }
  ],
  titleTemplate: 'Onboard {{affected_user}}',
  descriptionIntro: 'HR request.',
  defaultPriority: 'high',
  defaultTags: ['onboarding'],
  showInPortal: true,
  isActive: true,
  sortOrder: 0,
  version: 2,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date()
} as never;

describe('applyIntakeForm', () => {
  it('validates, composes subject/description, and snapshots responses', () => {
    const r = applyIntakeForm(form, { affected_user: 'jdoe@client.example', needs_vpn: true });
    expect(r.subjectFromForm).toBe('Onboard jdoe@client.example');
    expect(r.descriptionBlock).toContain('HR request.');
    expect(r.descriptionBlock).toContain('- **Affected user:** jdoe@client.example');
    expect(r.categoryId).toBe('cat-1');
    expect(r.defaultPriority).toBe('high');
    expect(r.defaultTags).toEqual(['onboarding']);
    expect(r.intakeSnapshot).toEqual({
      intakeForm: {
        formId: 'form-1',
        formName: 'New user onboarding',
        formVersion: 2,
        responses: { affected_user: 'jdoe@client.example', needs_vpn: true }
      }
    });
  });

  it('throws TicketFormError 400 with field detail on invalid responses', () => {
    try {
      applyIntakeForm(form, { needs_vpn: 'yes' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TicketFormError);
      expect((err as TicketFormError).status).toBe(400);
      expect((err as TicketFormError).message).toContain('affected_user');
    }
  });
});

describe('getTicketFormForOrg', () => {
  beforeEach(() => vi.clearAllMocks());

  it('404 when missing', async () => {
    dbSelectMock.mockResolvedValue([]);
    await expect(getTicketFormForOrg('nope', { id: 'org-1', partnerId: 'p-1' })).rejects.toMatchObject({ status: 404 });
  });

  it('400 when the form belongs to another tenant', async () => {
    dbSelectMock.mockResolvedValue([{ ...(form as object), partnerId: 'p-OTHER' }]);
    await expect(getTicketFormForOrg('form-1', { id: 'org-1', partnerId: 'p-1' })).rejects.toMatchObject({ status: 400 });
  });

  it('400 when inactive; resolves when partner-wide matches the org partner', async () => {
    dbSelectMock.mockResolvedValue([{ ...(form as object), isActive: false }]);
    await expect(getTicketFormForOrg('form-1', { id: 'org-1', partnerId: 'p-1' })).rejects.toMatchObject({ status: 400 });
    dbSelectMock.mockResolvedValue([form]);
    await expect(getTicketFormForOrg('form-1', { id: 'org-1', partnerId: 'p-1' })).resolves.toMatchObject({ id: 'form-1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test -- ticketFormService`
Expected: FAIL — module `./ticketFormService` not found.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/ticketFormService.ts`:

```ts
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  buildResponseValidator,
  renderFormResponses,
  renderTitleTemplate,
  type TicketFormField,
  type TicketPriority
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { ticketForms } from '../db/schema';

export type TicketFormRow = typeof ticketForms.$inferSelect;

/**
 * Own error class (NOT TicketServiceError) to keep ticketFormService free of
 * an import cycle with ticketService — createTicket maps this to
 * TicketServiceError at the call site.
 */
export class TicketFormError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = 'TicketFormError';
  }
}

interface OrgRef {
  id: string;
  partnerId: string;
}

/**
 * Forms visible to an org: org-owned rows plus the org's partner's
 * partner-wide rows. Partner-owned rows are INVISIBLE to org-scoped RLS
 * contexts (heartbeat/#1105 pattern), so this reads under a system context
 * and filters explicitly. Callers MUST have already authorized the org
 * (route: auth.canAccessOrg; service: the ticket's resolved org).
 */
export async function listTicketFormsForOrg(org: OrgRef, opts?: { portalOnly?: boolean }): Promise<TicketFormRow[]> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select()
        .from(ticketForms)
        .where(
          and(
            eq(ticketForms.isActive, true),
            opts?.portalOnly ? eq(ticketForms.showInPortal, true) : undefined,
            sql`(${ticketForms.orgId} = ${org.id} OR (${ticketForms.orgId} IS NULL AND ${ticketForms.partnerId} = ${org.partnerId}))`
          )
        )
        .orderBy(asc(ticketForms.sortOrder), asc(ticketForms.name))
    )
  );
}

/** Load a form and verify it is usable for the given org (tenant + active). */
export async function getTicketFormForOrg(formId: string, org: OrgRef): Promise<TicketFormRow> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => db.select().from(ticketForms).where(eq(ticketForms.id, formId)).limit(1))
  );
  const form = rows[0];
  if (!form) throw new TicketFormError('Ticket form not found', 404);
  const ownedByOrg = form.orgId === org.id;
  const partnerWide = form.orgId === null && form.partnerId === org.partnerId;
  if (!ownedByOrg && !partnerWide) {
    throw new TicketFormError('Ticket form is not available for this organization', 400);
  }
  if (!form.isActive) throw new TicketFormError('Ticket form is inactive', 400);
  return form;
}

export interface AppliedIntakeForm {
  responses: Record<string, unknown>;
  subjectFromForm: string;
  descriptionBlock: string;
  categoryId: string | null;
  defaultPriority: TicketPriority | null;
  defaultTags: string[];
  intakeSnapshot: {
    intakeForm: { formId: string; formName: string; formVersion: number; responses: Record<string, unknown> };
  };
}

/** Pure: validate raw responses against the form and compose ticket pieces. */
export function applyIntakeForm(form: TicketFormRow, rawResponses: Record<string, unknown>): AppliedIntakeForm {
  const fields = (form.fields ?? []) as TicketFormField[];
  const parsed = buildResponseValidator(fields).safeParse(rawResponses ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new TicketFormError(`Form responses failed validation: ${detail}`, 400);
  }
  const responses = parsed.data as Record<string, unknown>;
  return {
    responses,
    subjectFromForm: renderTitleTemplate(form.titleTemplate, form.name, responses),
    descriptionBlock: renderFormResponses(
      { name: form.name, descriptionIntro: form.descriptionIntro, fields },
      responses
    ),
    categoryId: form.categoryId ?? null,
    defaultPriority: (form.defaultPriority as TicketPriority | null) ?? null,
    defaultTags: form.defaultTags ?? [],
    intakeSnapshot: {
      intakeForm: { formId: form.id, formName: form.name, formVersion: form.version, responses }
    }
  };
}
```

Note: Drizzle's `and(...)` ignores `undefined` members, so the `portalOnly` conditional is safe.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/api test -- ticketFormService`
Expected: PASS. Then re-run the Task 3 integration suite (fan-out test now implemented):

```bash
cd apps/api && pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/ticketFormsPartnerRls.integration.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketFormService.ts apps/api/src/services/ticketFormService.test.ts
git commit -m "feat(api): ticketFormService — system-context form resolution + pure intake application"
```

---

### Task 5: createTicket integration (formId + formResponses)

**Files:**
- Modify: `packages/shared/src/validators/tickets.ts` (`createTicketSchema`: subject becomes optional-with-refinement, priority loses `.default('normal')`, add `formId`/`formResponses`)
- Modify: `packages/shared/src/validators/tickets.test.ts` (new cases)
- Modify: `apps/api/src/services/ticketService.ts` (`BaseCreateTicketInput` + `createTicket`)
- Modify: `apps/api/src/routes/tickets/tickets.test.ts` (POST passthrough case)

**Interfaces:**
- Consumes: `getTicketFormForOrg`, `applyIntakeForm`, `TicketFormError` from Task 4.
- Produces: `createTicketSchema` accepting `{ formId?: guid, formResponses?: Record<string, unknown> }` with `subject` optional **only when** `formId` is present; `createTicket` composing subject/description/category/priority/tags/customFields from the form. Precedence: explicit caller value → form default → existing fallback.

- [ ] **Step 1: Write failing validator tests**

Append to `packages/shared/src/validators/tickets.test.ts`:

```ts
  it('createTicketSchema: subject optional only when formId present; formResponses passthrough', () => {
    const orgId = '3f2f1d8e-1111-4222-8333-444455556666';
    const formId = '9a8b7c6d-1111-4222-8333-444455556666';
    expect(createTicketSchema.safeParse({ orgId }).success).toBe(false); // no subject, no form
    expect(createTicketSchema.safeParse({ orgId, formId }).success).toBe(true);
    const r = createTicketSchema.safeParse({ orgId, formId, formResponses: { affected_user: 'jdoe' } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.formResponses).toEqual({ affected_user: 'jdoe' });
  });

  it('createTicketSchema: priority no longer injects a default', () => {
    const r = createTicketSchema.safeParse({ orgId: '3f2f1d8e-1111-4222-8333-444455556666', subject: 'x' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.priority).toBeUndefined();
  });
```

Also UPDATE the existing "accepts a minimal valid create payload" test: it currently asserts `r.data.priority` is `'normal'` — change that assertion to `toBeUndefined()` (the service, not the schema, owns the `'normal'` fallback and already does `input.priority ?? 'normal'`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/shared test -- tickets`
Expected: FAIL — `formId` unknown key stripped / subject required / priority default present.

- [ ] **Step 3: Update createTicketSchema**

In `packages/shared/src/validators/tickets.ts`, replace the `createTicketSchema` definition:

```ts
export const createTicketSchema = z
  .object({
    orgId: z.string().guid(),
    // Optional when an intake form composes it server-side (formId present).
    subject: z.string().min(1).max(255).optional(),
    description: z.string().max(50_000).optional(),
    deviceId: z.string().guid().optional(),
    categoryId: z.string().guid().optional(),
    // No .default('normal') — the service already falls back to 'normal', and
    // a schema default would make explicit-vs-absent indistinguishable, which
    // breaks intake-form defaultPriority precedence.
    priority: ticketPrioritySchema.optional(),
    dueDate: z.coerce.date().optional(),
    assigneeId: z.string().guid().optional(),
    // Intake form (spec 2026-07-10): responses are validated server-side
    // against the form's field schema in ticketService.
    formId: z.string().guid().optional(),
    formResponses: z.record(z.string(), z.unknown()).optional(),
    // Requester: pick an existing portal user (submittedBy) and/or supply a
    // free-text name/email. When all three are absent the service falls back to
    // the acting staff member's name (legacy behaviour). Picking a portal user
    // backfills name/email from that row when they aren't supplied here.
    submittedBy: z.string().guid().optional(),
    submitterName: z.string().min(1).max(255).optional(),
    submitterEmail: z.string().email().max(255).optional()
  })
  .superRefine((v, ctx) => {
    if (!v.formId && (!v.subject || v.subject.trim().length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['subject'], message: 'subject is required unless a formId is provided' });
    }
  });
```

Run: `pnpm --filter @breeze/shared test -- tickets` → Expected: PASS.

**Ripple check (do now, same step):** grep for `createTicketSchema` consumers and `\.priority` reads of its output — `apps/api/src/routes/tickets/tickets.ts` (POST handler passes `payload.priority` to the service, which does `?? 'normal'` — fine) and any test fixture asserting the default. Also `pnpm --filter @breeze/api exec tsc --noEmit` will surface `subject` now being `string | undefined` at the service call site — fixed in Step 4.

- [ ] **Step 4: Extend createTicket**

In `apps/api/src/services/ticketService.ts`:

(a) Add imports:

```ts
import { applyIntakeForm, getTicketFormForOrg, TicketFormError } from './ticketFormService';
```

(b) In `BaseCreateTicketInput`, change `subject: string;` to `subject?: string;` and add:

```ts
  formId?: string;
  formResponses?: Record<string, unknown>;
```

(c) In `createTicket`, immediately AFTER the org lookup (`if (!org) throw ...`) and BEFORE the device/assignee/category guards, insert:

```ts
  // Intake form (spec 2026-07-10): resolve + validate first so the composed
  // category feeds the existing assertCategoryInPartner guard below.
  let intake: ReturnType<typeof applyIntakeForm> | null = null;
  if (input.formId) {
    try {
      const form = await getTicketFormForOrg(input.formId, { id: org.id, partnerId: org.partnerId });
      intake = applyIntakeForm(form, input.formResponses ?? {});
    } catch (err) {
      if (err instanceof TicketFormError) throw new TicketServiceError(err.message, err.status);
      throw err;
    }
  }

  const subject = input.subject?.trim() || intake?.subjectFromForm;
  if (!subject) throw new TicketServiceError('Subject is required', 400);
```

(d) Where the function currently resolves the category (`if (input.categoryId) { category = await assertCategoryInPartner(...) }`), switch the source to the effective id:

```ts
  const effectiveCategoryId = input.categoryId ?? intake?.categoryId ?? undefined;
  ...
  if (effectiveCategoryId) {
    category = await assertCategoryInPartner(effectiveCategoryId, org.partnerId);
  }
```

(e) Where priority is resolved (`const priority = input.priority ?? 'normal';`):

```ts
  const priority = input.priority ?? intake?.defaultPriority ?? 'normal';
```

(f) In the `db.insert(tickets).values({...})` call: use `subject` (the resolved const) instead of `input.subject`; use `effectiveCategoryId` for `categoryId`; and add:

```ts
      description: [input.description?.trim(), intake?.descriptionBlock].filter(Boolean).join('\n\n') || null,
      tags: intake?.defaultTags.length ? intake.defaultTags : undefined,
      customFields: intake ? intake.intakeSnapshot : undefined,
```

(Match the existing `values({...})` style — if `description` is already built there, merge the intake block into that expression rather than duplicating the key. If the insert currently omits `tags`/`customFields`, adding them with `undefined` fallback is a no-op for non-form tickets.)

- [ ] **Step 5: Add the route passthrough test**

In `apps/api/src/routes/tickets/tickets.test.ts`, add to the POST `/tickets` describe block (mirror the existing create case's arrange/act style — `serviceMocks.createTicket` is already mocked):

```ts
  it('passes formId and formResponses through to createTicket', async () => {
    serviceMocks.createTicket.mockResolvedValue({ id: 't-9', internalNumber: 'T-2026-0009' });
    const res = await makeApp().request('/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: '3f2f1d8e-1111-4222-8333-444455556666',
        formId: '9a8b7c6d-1111-4222-8333-444455556666',
        formResponses: { affected_user: 'jdoe@client.example' }
      })
    });
    expect(res.status).toBe(201);
    expect(serviceMocks.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        formId: '9a8b7c6d-1111-4222-8333-444455556666',
        formResponses: { affected_user: 'jdoe@client.example' }
      }),
      expect.anything()
    );
  });
```

Note: if the existing POST handler destructures specific payload keys before calling the service, add `formId: payload.formId, formResponses: payload.formResponses` to that call in `apps/api/src/routes/tickets/tickets.ts` (and `subject: payload.subject` may now be `undefined` — the service handles it). Check the actual handler at `apps/api/src/routes/tickets/tickets.ts:400`. If the create response status differs from 201 in the existing tests, match theirs.

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @breeze/shared test -- tickets
pnpm --filter @breeze/api test -- "tickets|ticketService|ticketFormService"
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: all PASS, no type errors (Type Check in CI includes test files — fix any fixture that still passes `subject` as required-missing or asserts the old priority default).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/validators/tickets.ts packages/shared/src/validators/tickets.test.ts apps/api/src/services/ticketService.ts apps/api/src/routes/tickets/tickets.ts apps/api/src/routes/tickets/tickets.test.ts
git commit -m "feat(api): createTicket accepts intake form submissions (formId + formResponses)"
```

---

### Task 6: CRUD + available routes

**Files:**
- Create: `apps/api/src/routes/tickets/forms.ts`
- Create: `apps/api/src/routes/tickets/forms.test.ts`
- Modify: `apps/api/src/index.ts` (import + mount)

**Interfaces:**
- Consumes: `ticketForms` schema; `createTicketFormSchema`/`updateTicketFormSchema` (Task 1); `listTicketFormsForOrg` (Task 4); `canManagePartnerWidePolicies`, `PARTNER_WIDE_WRITE_DENIED_MESSAGE` from `../../services/partnerWideAccess`; `writeRouteAudit` from `../../services/auditEvents`; `authMiddleware`, `requireScope`, `requirePermission`, `PERMISSIONS.TICKETS_READ/WRITE`. Category-ownership validation: `assertCategoryInPartner` from `../../services/ticketService` — if it is not currently exported, export it (it's a standalone async function at ticketService.ts ~line 206; adding `export` is safe).
- Produces: `ticketFormRoutes` (root-mounted, absolute paths):
  - `GET /ticket-forms` → `{ data: TicketFormRow[] }` (management list, dual-axis app condition)
  - `GET /ticket-forms/available?orgId=<guid>` → `{ data: TicketFormRow[] }` (resolved picker list)
  - `POST /ticket-forms` → 201 `{ data: TicketFormRow }`
  - `PUT /ticket-forms/:id` → `{ data: TicketFormRow }`
  - `DELETE /ticket-forms/:id` → `{ success: true }`

- [ ] **Step 1: Write the failing route test**

Create `apps/api/src/routes/tickets/forms.test.ts` — copy the mock boilerplate style of `apps/api/src/routes/tickets/tickets.test.ts` (authRef + middleware mock + db mock), then:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, dbRowsMock, insertReturningMock, updateReturningMock, deleteWhereMock, listForOrgMock, writeRouteAuditMock } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      partnerOrgAccess: 'all' as string,
      orgId: null as string | null,
      accessibleOrgIds: ['org-1'] as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean
    }
  },
  dbRowsMock: vi.fn(),
  insertReturningMock: vi.fn(),
  updateReturningMock: vi.fn(),
  deleteWhereMock: vi.fn(),
  listForOrgMock: vi.fn(),
  writeRouteAuditMock: vi.fn()
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));
vi.mock('../../services/ticketFormService', () => ({ listTicketFormsForOrg: listForOrgMock }));
vi.mock('../../services/ticketService', async () => {
  const actual = await vi.importActual<typeof import('../../services/ticketService')>('../../services/ticketService');
  return { ...actual, assertCategoryInPartner: vi.fn().mockResolvedValue({ id: 'cat-1', partnerId: 'p-1' }) };
});
// partnerWideAccess is PURE — use the real implementation so gate tests are honest.

vi.mock('../../middleware/auth', async () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: () => async (c: any, next: any) => {
    if (!c.get('auth')) return c.json({ error: 'Not authenticated' }, 401);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next()
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve(dbRowsMock()), {
          orderBy: vi.fn(() => dbRowsMock()),
          limit: vi.fn(() => dbRowsMock())
        }))
      }))
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(() => insertReturningMock()) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => updateReturningMock()) })) })) })),
    delete: vi.fn(() => ({ where: vi.fn((...a) => { deleteWhereMock(...a); return Promise.resolve(); } ) }))
  }
}));

import { ticketFormRoutes } from './forms';

function makeApp() {
  const app = new Hono();
  app.route('/', ticketFormRoutes);
  return app;
}

const ORG_ID = '3f2f1d8e-1111-4222-8333-444455556666';
const validBody = {
  name: 'New user onboarding',
  fields: [{ key: 'affected_user', label: 'Affected user', type: 'text', required: true }]
};

beforeEach(() => {
  vi.clearAllMocks();
  authRef.current = { ...authRef.current, scope: 'partner', partnerId: 'p-1', partnerOrgAccess: 'all', orgId: null, canAccessOrg: () => true };
});

describe('POST /ticket-forms', () => {
  it('creates an org-owned form by default', async () => {
    insertReturningMock.mockResolvedValue([{ id: 'f-1', orgId: ORG_ID, partnerId: null, ...validBody }]);
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'organization', orgId: ORG_ID })
    });
    expect(res.status).toBe(201);
    expect(writeRouteAuditMock).toHaveBeenCalled();
  });

  it('creates a partner-wide form with org_id NULL and token-derived partner', async () => {
    insertReturningMock.mockResolvedValue([{ id: 'f-2', orgId: null, partnerId: 'p-1', ...validBody }]);
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'partner' })
    });
    expect(res.status).toBe(201);
  });

  it('403s partner-wide create without full partner org access', async () => {
    authRef.current = { ...authRef.current, partnerOrgAccess: 'selected' };
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerScope: 'partner' })
    });
    expect(res.status).toBe(403);
  });

  it('400s invalid field definitions', async () => {
    const res = await makeApp().request('/ticket-forms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', orgId: ORG_ID, fields: [{ key: 'BAD KEY', label: 'x', type: 'text', required: false }] })
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /ticket-forms/available', () => {
  it('403s when the caller cannot access the org', async () => {
    authRef.current = { ...authRef.current, canAccessOrg: () => false };
    const res = await makeApp().request(`/ticket-forms/available?orgId=${ORG_ID}`);
    expect(res.status).toBe(403);
  });

  it('returns resolved forms from the system-context service', async () => {
    dbRowsMock.mockResolvedValue([{ id: ORG_ID, partnerId: 'p-1' }]); // org lookup
    listForOrgMock.mockResolvedValue([{ id: 'f-1', name: 'Onboarding' }]);
    const res = await makeApp().request(`/ticket-forms/available?orgId=${ORG_ID}`);
    expect(res.status).toBe(200);
    expect(listForOrgMock).toHaveBeenCalledWith({ id: ORG_ID, partnerId: 'p-1' });
  });
});

describe('PUT/DELETE partner-wide gating', () => {
  it('403s update of a partner-wide form without the capability', async () => {
    authRef.current = { ...authRef.current, partnerOrgAccess: 'selected' };
    dbRowsMock.mockResolvedValue([{ id: 'f-2', orgId: null, partnerId: 'p-1', version: 1, fields: [] }]);
    const res = await makeApp().request('/ticket-forms/f-2', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' })
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api test -- routes/tickets/forms`
Expected: FAIL — `./forms` module not found.

- [ ] **Step 3: Implement the routes**

Create `apps/api/src/routes/tickets/forms.ts`. Root-mounted (absolute paths), per-route `authMiddleware` — copy the mount-safety comment from `ticketResponseTemplates.ts`. Structure:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { createTicketFormSchema, updateTicketFormSchema } from '@breeze/shared';
import { db } from '../../db';
import { organizations, ticketForms } from '../../db/schema';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { listTicketFormsForOrg } from '../../services/ticketFormService';
import { assertCategoryInPartner } from '../../services/ticketService';
import { PERMISSIONS } from '../../services/permissions';

export const ticketFormRoutes = new Hono();

// Root-mounted router (absolute paths): authMiddleware must lead EACH route's
// middleware chain — a router-level .use('*') here would attach auth to every
// sibling api route, including public ones (the #1383 footgun).
const requireTicketRead = requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
const requireTicketWrite = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);
const scopes = requireScope('organization', 'partner', 'system');

// Dual-axis app-layer read condition (mirrors softwarePolicyAccessCondition,
// #2126): org rows the caller can reach OR the caller's own partner's
// partner-wide rows. RLS is STRICTER — org tokens never see partner rows —
// so the partner branch is gated on partner scope to keep app and DB agreeing.
function ticketFormAccessCondition(auth: AuthContext): SQL | undefined {
  const orgCond = auth.orgCondition(ticketForms.orgId);
  if (!orgCond) return undefined; // system scope
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${orgCond} OR (${ticketForms.orgId} IS NULL AND ${ticketForms.partnerId} = ${auth.partnerId}))`;
  }
  return orgCond;
}
```

Handlers (all following the exact softwarePolicies patterns):

1. **`GET /ticket-forms`** — `authMiddleware, scopes, requireTicketRead`; `db.select().from(ticketForms).where(ticketFormAccessCondition(auth)).orderBy(asc(ticketForms.sortOrder), asc(ticketForms.name))`; return `{ data: rows }`.

2. **`GET /ticket-forms/available`** — `authMiddleware, scopes, requireTicketRead, zValidator('query', z.object({ orgId: z.string().guid() }))`:

```ts
    const auth = c.get('auth');
    const { orgId } = c.req.valid('query');
    if (!auth.canAccessOrg(orgId)) return c.json({ error: 'Access denied to this organization' }, 403);
    const orgRows = await db
      .select({ id: organizations.id, partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    const org = orgRows[0];
    if (!org) return c.json({ error: 'Organization not found' }, 404);
    const forms = await listTicketFormsForOrg({ id: org.id, partnerId: org.partnerId });
    return c.json({ data: forms });
```

3. **`POST /ticket-forms`** — `authMiddleware, scopes, requireTicketWrite, zValidator('json', createTicketFormSchema)`. Owner resolution copied from softwarePolicies POST:

```ts
    let owner: { orgId: string | null; partnerId: string | null };
    if (payload.ownerScope === 'partner') {
      if (!auth.partnerId) return c.json({ error: 'Partner-wide forms require partner scope' }, 403);
      if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      owner = { orgId: null, partnerId: auth.partnerId };
    } else {
      const requestedOrgId = payload.orgId ?? c.req.query('orgId') ?? undefined;
      if (auth.scope === 'organization') {
        if (!auth.orgId || (requestedOrgId && requestedOrgId !== auth.orgId)) {
          return c.json({ error: 'Organization context required' }, 403);
        }
        owner = { orgId: auth.orgId, partnerId: null };
      } else {
        if (!requestedOrgId || !auth.canAccessOrg(requestedOrgId)) {
          return c.json({ error: 'orgId is required and must be accessible' }, 400);
        }
        owner = { orgId: requestedOrgId, partnerId: null };
      }
    }
```

Category ownership: if `payload.categoryId`, resolve the effective partner (partner-wide: `auth.partnerId`; org-owned: read the org row's `partnerId`) and `await assertCategoryInPartner(payload.categoryId, effectivePartnerId)` inside try/catch mapping its error to a 400 JSON response. Insert with `createdBy: auth.user.id`, `version: 1`. `writeRouteAudit(c, { orgId: owner.orgId, action: 'ticket_form.create', details: { formId: row.id, name: row.name, partnerWide: owner.orgId === null } })` (match the exact writeRouteAudit call signature used in `ticketResponseTemplates.ts`). Return `c.json({ data: row }, 201)`.

4. **`PUT /ticket-forms/:id`** — `authMiddleware, scopes, requireTicketWrite, zValidator('json', updateTicketFormSchema)`. Fetch the row via `db.select().from(ticketForms).where(eq(ticketForms.id, id)).limit(1)` (request context — RLS already scopes visibility; 404 if absent). Gate: `if (row.orgId === null && !canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);`. Category revalidation as in POST when `payload.categoryId` is set. Update:

```ts
    const bumpVersion = payload.fields !== undefined || payload.titleTemplate !== undefined;
    const [updated] = await db
      .update(ticketForms)
      .set({
        ...payload,
        ...(bumpVersion ? { version: row.version + 1 } : {}),
        updatedAt: new Date()
      })
      .where(eq(ticketForms.id, id))
      .returning();
```

Audit `'ticket_form.update'`; return `{ data: updated }`.

5. **`DELETE /ticket-forms/:id`** — same fetch + partner-wide gate; `db.delete(ticketForms).where(eq(ticketForms.id, id))`; audit `'ticket_form.delete'`; return `{ success: true }`. (Hard delete per spec — existing tickets keep the rendered description + jsonb snapshot.)

Mount in `apps/api/src/index.ts` next to the response-templates mount:

```ts
import { ticketFormRoutes } from './routes/tickets/forms';
...
api.route('/', ticketFormRoutes);
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/api test -- routes/tickets/forms` → Expected: PASS.
Run: `pnpm --filter @breeze/api exec tsc --noEmit` → Expected: clean (exporting `assertCategoryInPartner` must not break existing ticketService tests — run `pnpm --filter @breeze/api test -- ticketService` too).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/tickets/forms.ts apps/api/src/routes/tickets/forms.test.ts apps/api/src/index.ts apps/api/src/services/ticketService.ts
git commit -m "feat(api): /ticket-forms CRUD + available resolver with partner-wide gating"
```

---

### Task 7: Web — shared field renderer + admin builder in Ticketing settings

**Files:**
- Create: `apps/web/src/components/tickets/TicketFormFields.tsx`
- Create: `apps/web/src/components/settings/TicketFormsCard.tsx`
- Create: `apps/web/src/components/settings/TicketFormsCard.test.tsx`
- Modify: `apps/web/src/components/settings/TicketingSettingsTabs.tsx` (register the sub-tab)

**Interfaces:**
- Consumes: `TicketFormField`, `ticketFormFieldsSchema` from `@breeze/shared`; `fetchWithAuth` from `../../stores/auth`; `runAction`, `ActionError` from `@/lib/runAction`; `showToast` from `../shared/Toast`.
- Produces:
  - `TicketFormFields` component: `({ fields, values, errors, onChange }: { fields: TicketFormField[]; values: Record<string, unknown>; errors: Record<string, string>; onChange: (key: string, value: unknown) => void })` — renders one labeled input per field, `data-testid="ticket-form-field-<key>"`, inline error text under invalid fields. Used by BOTH the builder preview and Task 8's create page (preview cannot drift).
  - `TicketFormsCard` default export, rendered by the new `forms` sub-tab.

- [ ] **Step 1: Implement TicketFormFields (renderer first — it's a dependency of both surfaces)**

```tsx
import type { TicketFormField } from '@breeze/shared';

interface Props {
  fields: TicketFormField[];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  onChange: (key: string, value: unknown) => void;
}

export default function TicketFormFields({ fields, values, errors, onChange }: Props) {
  return (
    <div className="space-y-3">
      {fields.map((f) => {
        const err = errors[f.key];
        const common = {
          id: `tf-${f.key}`,
          'data-testid': `ticket-form-field-${f.key}`,
          className: 'w-full rounded-md border px-3 py-2 text-sm'
        } as const;
        return (
          <div key={f.key}>
            <label htmlFor={`tf-${f.key}`} className="mb-1 block text-sm font-medium">
              {f.label}
              {f.required && <span className="text-destructive"> *</span>}
            </label>
            {f.type === 'textarea' && (
              <textarea {...common} rows={3} placeholder={f.placeholder}
                value={(values[f.key] as string) ?? ''} onChange={(e) => onChange(f.key, e.target.value)} />
            )}
            {(f.type === 'text' || f.type === 'date' || f.type === 'number') && (
              <input {...common}
                type={f.type === 'text' ? 'text' : f.type}
                placeholder={f.placeholder}
                value={(values[f.key] as string | number) ?? ''}
                onChange={(e) => onChange(f.key, e.target.value)} />
            )}
            {f.type === 'select' && (
              <select {...common} value={(values[f.key] as string) ?? ''} onChange={(e) => onChange(f.key, e.target.value)}>
                <option value="">Select…</option>
                {(f.options ?? []).map((o) => (<option key={o} value={o}>{o}</option>))}
              </select>
            )}
            {f.type === 'checkbox' && (
              <input {...common} type="checkbox" className="h-4 w-4 rounded border"
                checked={values[f.key] === true} onChange={(e) => onChange(f.key, e.target.checked)} />
            )}
            {f.helpText && <p className="mt-1 text-xs text-muted-foreground">{f.helpText}</p>}
            {err && <p className="mt-1 text-xs text-destructive" data-testid={`ticket-form-field-error-${f.key}`}>{err}</p>}
          </div>
        );
      })}
    </div>
  );
}
```

(Match class names to the surrounding tickets components — open `CreateTicketPage.tsx` and reuse its input/label classes verbatim if they differ.)

- [ ] **Step 2: Write the failing builder test**

Create `apps/web/src/components/settings/TicketFormsCard.test.tsx` — reuse the exact mock conventions from `apps/web/src/components/tickets/CreateTicketPage.test.tsx` (`vi.mock('../../stores/auth')`, `makeJsonResponse`, toast mock). Cases:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TicketFormsCard from './TicketFormsCard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);
const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const FORM = {
  id: 'f-1', orgId: null, partnerId: 'p-1', name: 'Onboarding', description: null, categoryId: null,
  fields: [{ key: 'affected_user', label: 'Affected user', type: 'text', required: true }],
  titleTemplate: null, descriptionIntro: null, defaultPriority: null, defaultTags: [],
  showInPortal: true, isActive: true, sortOrder: 0, version: 1
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/ticket-forms' && (!init || !init.method)) return makeJsonResponse({ data: [FORM] });
    if (url === '/ticket-forms' && init?.method === 'POST') return makeJsonResponse({ data: { ...FORM, id: 'f-2', name: 'Offboarding' } });
    if (url === '/orgs/organizations?limit=100') return makeJsonResponse({ data: [{ id: 'org-a', name: 'Org A' }] });
    if (url === '/ticket-categories') return makeJsonResponse({ data: [{ id: 'cat-1', name: 'Hardware', isActive: true }] });
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
});

describe('TicketFormsCard', () => {
  it('lists forms with an All orgs badge for partner-wide rows', async () => {
    render(<TicketFormsCard />);
    expect(await screen.findByTestId('ticket-form-row-f-1')).toBeTruthy();
    expect(screen.getByTestId('ticket-form-row-f-1').textContent).toContain('All orgs');
  });

  it('opens the editor, adds a field, and creates a partner-wide form', async () => {
    render(<TicketFormsCard />);
    await screen.findByTestId('ticket-form-row-f-1');
    fireEvent.click(screen.getByTestId('ticket-form-create'));
    fireEvent.change(screen.getByTestId('ticket-form-name'), { target: { value: 'Offboarding' } });
    fireEvent.click(screen.getByTestId('ticket-form-owner-partner'));
    fireEvent.click(screen.getByTestId('ticket-form-field-add'));
    fireEvent.change(screen.getByTestId('ticket-form-field-label-0'), { target: { value: 'Affected user' } });
    fireEvent.click(screen.getByTestId('ticket-form-save'));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u, i]) => String(u) === '/ticket-forms' && (i as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body.ownerScope).toBe('partner');
      expect(body.fields[0].key).toBe('affected_user');
    });
  });
});
```

Run: `pnpm --filter @breeze/web test -- TicketFormsCard` → Expected: FAIL (module not found).

- [ ] **Step 3: Implement TicketFormsCard**

Create `apps/web/src/components/settings/TicketFormsCard.tsx`. Shape (follow `CannedResponsesCard.tsx` for card/list chrome — open it and reuse its layout classes and empty-state pattern):

- **State:** `forms` (list), `editing: null | { id?: string; draft: FormDraft }`, `saving`. `FormDraft` = `{ name, description, categoryId, ownerScope: 'partner' | 'organization', orgId, fields: DraftField[], titleTemplate, descriptionIntro, defaultPriority, showInPortal, isActive, sortOrder }`; `DraftField` = `TicketFormField`.
- **Load:** on mount fetch `/ticket-forms`, `/ticket-categories` (active only, for the category select), `/orgs/organizations?limit=100` (for the org select when ownerScope = organization). Non-OK list responses render an inline error with a Retry button (not a toast).
- **List rows:** `data-testid="ticket-form-row-<id>"` — name, field count, category name, `Portal` chip when `showInPortal`, `Inactive` chip when `!isActive`, and an **"All orgs"** badge when `orgId === null` (same badge styling as the software policies list). Edit + Delete buttons (`ticket-form-edit-<id>`, `ticket-form-delete-<id>`). "New form" button: `data-testid="ticket-form-create"`.
- **Editor** (inline panel below the list, not a modal — matches settings-card conventions):
  - Name (`ticket-form-name`), description, category select (`ticket-form-category`), title template input with helper text "Use {{field_key}} to insert responses", description intro textarea, default priority select, Show in portal checkbox, Active checkbox.
  - **Create-only ownerScope fieldset** — copy the PolicyForm fieldset verbatim (radios `ticket-form-owner-partner` / `ticket-form-owner-org`, legend "Scope", labels "All organizations (partner-wide)" / "This organization only"), plus an org `<select data-testid="ticket-form-owner-org-select">` shown only when `ownerScope === 'organization'`. Hidden entirely when editing (ownership is immutable).
  - **Field editor:** vertical rows, each with label input (`ticket-form-field-label-<i>`), type select (`ticket-form-field-type-<i>`), required checkbox, expandable extras (help text, placeholder, options textarea — one option per line, shown only for select), up/down buttons (`ticket-form-field-up-<i>` / `-down-<i>`), remove button. "Add field" button `ticket-form-field-add`. **Field `key` is derived from the label** (`label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 50)` with a numeric suffix on collision) and shown read-only next to the label — admins never hand-author keys.
  - **Live preview:** right column (or below on narrow) rendering `<TicketFormFields fields={draft.fields} values={previewValues} errors={{}} onChange={...} />` under a "Preview" heading — the exact renderer end users get.
  - Client-side validation before save: `ticketFormFieldsSchema.safeParse(draft.fields)` + non-empty name; render issues inline.
- **Save** (`ticket-form-save`): POST `/ticket-forms` (create — body includes `ownerScope`, and `orgId` only when `ownerScope === 'organization'`) or PUT `/ticket-forms/:id` (update — body excludes `ownerScope`/`orgId`), via `runAction` with `successMessage` "Form saved" / errorFallback "Failed to save form. Retry.". On success: refresh list, close editor. Catch: `if (!(err instanceof ActionError)) throw err;`.
- **Delete:** `runAction` DELETE with a `window.confirm`-free inline confirm (two-click "Delete" → "Confirm delete" button state, matching whatever `CannedResponsesCard` does — mirror it).

- [ ] **Step 4: Register the sub-tab**

In `apps/web/src/components/settings/TicketingSettingsTabs.tsx`:

```ts
import TicketFormsCard from './TicketFormsCard';
// VALID_TABS gains 'forms':
const VALID_TABS = ['statuses', 'priorities', 'categories', 'forms', 'export', 'inbound', 'canned'] as const;
// BASE_TABS gains (after 'categories'):
  { id: 'forms', label: 'Intake Forms' },
```

and render `<TicketFormsCard />` in the `forms` panel (`data-testid="ticketing-tab-panel-forms"`), following the exact pattern of the `categories` panel. Placement in `BASE_TABS` (not the partner-only appended set) is fine — the whole `PartnerSettingsPage` surface is already partner-scope; org-owned forms are created from here via the org selector. (Verify `BASE_TABS` visibility assumptions by checking how the component gates `inbound`/`canned` with `getJwtClaims()` — if `BASE_TABS` renders for org-scope users anywhere, move `forms` to the partner-appended set instead.)

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @breeze/web test -- TicketFormsCard
pnpm --filter @breeze/web test
```

Expected: new suite PASS, no regressions (TicketingSettingsTabs has existing tests — update its VALID_TABS expectations if it asserts the tab list).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/tickets/TicketFormFields.tsx apps/web/src/components/settings/TicketFormsCard.tsx apps/web/src/components/settings/TicketFormsCard.test.tsx apps/web/src/components/settings/TicketingSettingsTabs.tsx
git commit -m "feat(web): ticket intake forms builder in Ticketing settings + shared field renderer"
```

---

### Task 8: Web — "Start from a form" on CreateTicketPage

**Files:**
- Modify: `apps/web/src/components/tickets/CreateTicketPage.tsx`
- Modify: `apps/web/src/components/tickets/CreateTicketPage.test.tsx`

**Interfaces:**
- Consumes: `GET /ticket-forms/available?orgId=` (Task 6); `TicketFormFields` (Task 7); `buildResponseValidator`, `coerceFormResponses`, type `TicketFormField` from `@breeze/shared`.
- Produces: POST `/tickets` body optionally carrying `formId` + `formResponses`; `subject` omitted when blank and a form is selected.

- [ ] **Step 1: Write the failing test additions**

Add to `CreateTicketPage.test.tsx` (extend `mockOptionsApi` with the new endpoint):

```tsx
// inside mockOptionsApi():
    if (url.startsWith('/ticket-forms/available')) {
      return makeJsonResponse({
        data: [{
          id: 'form-1', name: 'New user onboarding', description: 'HR intake', categoryId: 'cat-1',
          fields: [
            { key: 'affected_user', label: 'Affected user', type: 'text', required: true },
            { key: 'needs_vpn', label: 'Needs VPN', type: 'checkbox', required: false }
          ],
          defaultPriority: 'high', defaultTags: ['onboarding'], titleTemplate: 'Onboard {{affected_user}}'
        }]
      });
    }

// new tests:
  it('selecting a form renders its fields and prefills category + priority', async () => {
    mockOptionsApi();
    render(<CreateTicketPage />);
    fireEvent.change(await screen.findByTestId('create-ticket-org'), { target: { value: 'org-a' } });
    const picker = await screen.findByTestId('create-ticket-form-picker');
    fireEvent.change(picker, { target: { value: 'form-1' } });
    expect(await screen.findByTestId('ticket-form-field-affected_user')).toBeTruthy();
    expect((screen.getByTestId('create-ticket-category') as HTMLSelectElement).value).toBe('cat-1');
    expect((screen.getByTestId('create-ticket-priority') as HTMLSelectElement).value).toBe('high');
  });

  it('blocks submit with inline error when a required form field is empty', async () => {
    mockOptionsApi();
    render(<CreateTicketPage />);
    fireEvent.change(await screen.findByTestId('create-ticket-org'), { target: { value: 'org-a' } });
    fireEvent.change(await screen.findByTestId('create-ticket-form-picker'), { target: { value: 'form-1' } });
    fireEvent.click(screen.getByTestId('create-ticket-submit'));
    expect(await screen.findByTestId('ticket-form-field-error-affected_user')).toBeTruthy();
    expect(fetchMock.mock.calls.find(([u, i]) => String(u) === '/tickets' && (i as RequestInit)?.method === 'POST')).toBeFalsy();
  });

  it('submits formId + coerced formResponses and allows an empty subject', async () => {
    mockOptionsApi();
    render(<CreateTicketPage />);
    fireEvent.change(await screen.findByTestId('create-ticket-org'), { target: { value: 'org-a' } });
    fireEvent.change(await screen.findByTestId('create-ticket-form-picker'), { target: { value: 'form-1' } });
    fireEvent.change(screen.getByTestId('ticket-form-field-affected_user'), { target: { value: 'jdoe@client.example' } });
    fireEvent.click(screen.getByTestId('create-ticket-submit'));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u, i]) => String(u) === '/tickets' && (i as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body.formId).toBe('form-1');
      expect(body.formResponses).toEqual({ affected_user: 'jdoe@client.example' });
      expect(body.subject).toBeUndefined();
    });
  });
```

**Testid audit:** the assertions above assume `create-ticket-org`, `create-ticket-category`, `create-ticket-priority`, `create-ticket-submit` testids. Open `CreateTicketPage.tsx` and its existing test to find the real selectors already in use (the existing test drives these controls somehow — reuse ITS selectors verbatim and only add `data-testid="create-ticket-form-picker"` as new).

Run: `pnpm --filter @breeze/web test -- CreateTicketPage` → Expected: new tests FAIL (picker not rendered).

- [ ] **Step 2: Implement**

In `CreateTicketPage.tsx`:

(a) New imports + state:

```tsx
import { buildResponseValidator, coerceFormResponses, type TicketFormField } from '@breeze/shared';
import TicketFormFields from './TicketFormFields';

interface AvailableTicketForm {
  id: string; name: string; description: string | null; categoryId: string | null;
  fields: TicketFormField[]; defaultPriority: TicketPriority | null; titleTemplate: string | null;
}

const [forms, setForms] = useState<AvailableTicketForm[]>([]);
const [formId, setFormId] = useState('');
const [formValues, setFormValues] = useState<Record<string, unknown>>({});
const [formErrors, setFormErrors] = useState<Record<string, string>>({});
const selectedForm = forms.find((f) => f.id === formId) ?? null;
```

(b) Fetch on org change (forms are optional — silent degrade, same philosophy as the categories fetch):

```tsx
useEffect(() => {
  setForms([]); setFormId(''); setFormValues({}); setFormErrors({});
  if (!orgId) return;
  let cancelled = false;
  (async () => {
    try {
      const res = await fetchWithAuth(`/ticket-forms/available?orgId=${encodeURIComponent(orgId)}`);
      if (res.ok && !cancelled) {
        const body = await res.json();
        setForms(body.data ?? []);
      }
    } catch { /* forms are additive — degrade to a blank ticket */ }
  })();
  return () => { cancelled = true; };
}, [orgId]);
```

(c) Picker + fields, rendered between the org select and the subject input, only when `forms.length > 0`:

```tsx
<div>
  <label className="mb-1 block text-sm font-medium" htmlFor="ticket-form-picker">Start from a form <span className="text-muted-foreground">(optional)</span></label>
  <select
    id="ticket-form-picker"
    data-testid="create-ticket-form-picker"
    className={/* same select classes as the category select */}
    value={formId}
    onChange={(e) => {
      const next = forms.find((f) => f.id === e.target.value) ?? null;
      setFormId(e.target.value);
      setFormErrors({});
      if (next) {
        const defaults: Record<string, unknown> = {};
        for (const f of next.fields) if (f.defaultValue !== undefined) defaults[f.key] = f.defaultValue;
        setFormValues(defaults);
        if (next.categoryId) setCategoryId(next.categoryId);
        if (next.defaultPriority) setPriority(next.defaultPriority);
      } else {
        setFormValues({});
      }
    }}
  >
    <option value="">Blank ticket</option>
    {forms.map((f) => (<option key={f.id} value={f.id}>{f.name}</option>))}
  </select>
  {selectedForm?.description && <p className="mt-1 text-xs text-muted-foreground">{selectedForm.description}</p>}
</div>
{selectedForm && (
  <TicketFormFields
    fields={selectedForm.fields}
    values={formValues}
    errors={formErrors}
    onChange={(key, value) => setFormValues((v) => ({ ...v, [key]: value }))}
  />
)}
```

(d) Submit changes: relax the guard `if (!orgId || !subject.trim()) return;` to `if (!orgId || (!subject.trim() && !selectedForm)) return;`. Before the `runAction` call, validate:

```tsx
let responses: Record<string, unknown> | undefined;
if (selectedForm) {
  const coerced = coerceFormResponses(selectedForm.fields, formValues);
  const parsed = buildResponseValidator(selectedForm.fields).safeParse(coerced);
  if (!parsed.success) {
    const errs: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '');
      // 'invalid_type: received undefined' on a missing required field reads badly — normalize.
      if (key && !errs[key]) errs[key] = issue.code === 'invalid_type' && coerced[key] === undefined ? 'This field is required' : issue.message;
    }
    setFormErrors(errs);
    return;
  }
  setFormErrors({});
  responses = parsed.data as Record<string, unknown>;
}
```

and extend the POST body:

```tsx
  subject: subject.trim() || undefined,
  ...(selectedForm ? { formId: selectedForm.id, formResponses: responses } : {}),
```

Also update the submit `useCallback` dependency array with `selectedForm, formValues`.

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @breeze/web test -- CreateTicketPage
pnpm --filter @breeze/web test
```

Expected: all PASS, including the pre-existing CreateTicketPage cases (the blank-ticket path must be byte-identical in behavior except `subject: undefined` never happens there — the guard still requires a subject without a form).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/tickets/CreateTicketPage.tsx apps/web/src/components/tickets/CreateTicketPage.test.tsx
git commit -m "feat(web): Start-from-a-form picker on the create-ticket page"
```

---

### Task 9: Repo-wide sweep + full verification

**Files:**
- Possibly modify: `apps/web/src/lib/runActionAllowlist.ts` (only if the `no-silent-mutations` test flags the new components — it should NOT, since all mutations use `runAction`)

- [ ] **Step 1: Hidden-consumer sweep (playbook item 7)**

```bash
grep -rn "ticketForms\|ticket_forms\|ticket-forms" apps/ packages/ --include='*.ts' --include='*.tsx' -l
```

Review every hit: confirm no reader filters `eq(ticketForms.orgId, ...)` without the partner-wide branch, and no path reads the table from an org-scoped RLS context except through `ticketFormService`. Also grep `aiToolsTicketing.ts` and `apps/api/src/routes/portal/` to confirm neither references the table yet (Phase 2/3 — intentionally absent).

- [ ] **Step 2: Full test run**

```bash
pnpm --filter @breeze/shared test
pnpm --filter @breeze/api test
pnpm --filter @breeze/web test
pnpm --filter @breeze/api exec tsc --noEmit
pnpm db:check-drift
cd apps/api && pnpm vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/ticketFormsPartnerRls.integration.test.ts
```

Expected: everything green. Known trap: `apps/web` runs `astro check` in CI and Type Check includes test files — run `pnpm --filter @breeze/web exec astro check` if the repo's web CI job does.

- [ ] **Step 3: Manual RLS forge check (playbook item 5)**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c \
  "INSERT INTO ticket_forms (partner_id, org_id, name, fields) VALUES ('<other-partner-uuid>', NULL, 'forged', '[]');"
```

(with an org-scoped `breeze.*` GUC context set, or simply confirm via the integration suite if a live forge is impractical in the worktree stack). Expected: `new row violates row-level security policy`.

- [ ] **Step 4: Commit any sweep fixes, then finish**

```bash
git add -A && git commit -m "chore: ticket intake forms — sweep fixes and verification" # only if changes exist
```

Then follow superpowers:finishing-a-development-branch (PR against `main`; PR body links the spec and notes: new table `ticket_forms` w/ RLS, `createTicketSchema` subject/priority contract change and why it's behavior-neutral, and the org-scoped-RLS/portal caveat for Phase 2).

---

## Self-Review Notes

- **Spec coverage:** §2.1 table → Task 2; §2.2 response storage → Task 5(f); §2.3 validators/renderers → Task 1; §3 routes incl. `available` + partner gates → Task 6; system-context read caveat → Tasks 3/4; §4.1 builder → Task 7; §4.2 picker → Task 8; §7 compliance checklist → Tasks 3, 6, 9. Portal (§4.3), org allowlist (§5 Phase 2), AI (§6 Phase 3) intentionally out of scope.
- **Contract-change risk (`createTicketSchema`):** subject optional-with-refinement + priority default removal are the only public-contract edits; Task 5 Steps 1/3 pin the new behavior and the ripple-check step covers out-of-PR consumers (AI tools pass explicit subjects; portal has its own schema).
- **Known verify-at-execution points (deliberate, cheap to confirm in place):** exact import paths in `schema/ticketForms.ts` (Task 2 Step 1), `createOrganization` signature (Task 3), `writeRouteAudit` call signature (Task 6 Step 3), existing CreateTicketPage testids (Task 8 Step 1), `BASE_TABS` scope gating (Task 7 Step 4).

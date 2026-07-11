# Ticket Intake Forms — Design Spec

**Date:** 2026-07-10
**Source:** Discord feature request (CillianTheIrishWolf, 6/13/26) — "custom forms so users can click a button, get brought to that form, fill it out, so uniform tickets can be created … ability to assign one form or form category to multiple tenants would also be wonderful."
**Status:** Implemented (Phase 1) — portal + AI phases pending

## 1. Problem & positioning

MSPs field the same ticket shapes over and over (new-user onboarding, password reset, hardware request, offboarding). Free-text subject/description means every submission arrives differently and techs burn time on intake back-and-forth. The ask is a lightweight **service-catalog**: admin-defined intake forms that produce uniform, complete tickets.

This is *not* the existing `ticket_response_templates` (canned replies — outbound). It is structured **inbound** intake. Naming everywhere: **Ticket Forms** (table `ticket_forms`), to avoid "template" collision with response templates.

**Opinionated framing decisions:**

- **Don't invent a second taxonomy.** The requester asked for "template categories" — we already have `ticket_categories` (partner-scoped, hierarchical, carrying default priority/SLA/billable). A form *links to* a ticket category; the category both groups forms in the picker and stamps the created ticket. One taxonomy, two jobs. No `ticket_form_categories` table.
- **Forms are self-contained documents.** Field definitions live in a `fields` jsonb column on the form, validated by a shared Zod schema — NOT rows in `custom_field_definitions`. That table is device-only (no `entityType`, `deviceTypes` semantics, values denormalized onto `devices.customFields`); retrofitting it buys joins and migration risk for zero user value. A form is authored, versioned, and rendered as one unit.
- **The rendered ticket must stand alone.** Form responses are written twice: structured into the (currently unused) `tickets.custom_fields` jsonb, AND rendered as a markdown definition list into `tickets.description`. Every existing consumer — ticket workbench, email notifications, AI tools, external PSA sync — keeps working with zero knowledge of forms. The jsonb is for future reporting/automation, not for display correctness.
- **Forms are the bridge to the AI intake vision, not a competitor to it.** Todd's instinct (AI helper collects the right info) and this request (deterministic forms, no AI spend) converge: a form's field schema is a machine-readable contract. Phase 3 hands the same form definitions to the AI agent / desktop helper as a structured elicitation script. Build the contract first; AI consumes it later.

## 2. Data model

### 2.1 `ticket_forms` (new table — dual-axis, Partner-Wide First per epic #2135)

```
id                uuid pk default gen_random_uuid()
partner_id        uuid null → partners(id)
org_id            uuid null → organizations(id)
                  CHECK ticket_forms_one_owner_chk ((org_id IS NULL) <> (partner_id IS NULL))
name              varchar(200) not null
description       text null                 -- shown under the name in pickers
category_id       uuid null                 -- plain FK → ticket_categories; category/partner match enforced app-side via assertCategoryInPartner; groups picker + stamps ticket
fields            jsonb not null default '[]'   -- ordered array of field defs (see 2.3)
title_template    varchar(300) null         -- "{{summary}} — new user request"; fallback = form name
description_intro text null                 -- optional preamble above rendered responses
default_priority  ticket_priority null      -- overrides category default when set
default_tags      text[] not null default '{}'
show_in_portal    boolean not null default true    -- false = tech-facing only (internal runbook forms)
is_active         boolean not null default true
sort_order        integer not null default 0
version           integer not null default 1      -- bumped on any change to fields/title_template
created_by        uuid null → users(id)     -- audit only
created_at / updated_at
```

Indexes: `ticket_forms_partner_id_idx`, `ticket_forms_org_id_idx`.

**Migration** (`2026-07-XX-ticket-forms.sql`): create table + XOR CHECK + ENABLE/FORCE RLS + single three-branch policy in the same file, mirroring `2026-07-01-maintenance-windows-partner-ownership.sql`:

```sql
CREATE POLICY ticket_forms_isolation ON ticket_forms
  USING (public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id)))
  WITH CHECK ( /* identical */ );
```

Category FK note: `ticket_categories.partner_id` is NOT NULL, so an org-owned form referencing a category still resolves through the org's partner. Validate app-side that `category_id` belongs to the effective partner (same check ticket creation already does).

### 2.2 Response storage — no new table

On submission, `tickets.custom_fields` (now written by `createTicket` when a form is applied) gets:

```json
{ "intakeForm": { "formId": "…", "formName": "…", "formVersion": 3,
    "responses": { "affected_user": "jdoe@client.example", "start_date": "2026-07-14" } } }
```

No `ticket_form_submissions` table in v1 — the ticket IS the submission. Add a table only if/when reporting over responses demands SQL-queryable rows.

### 2.3 Field definitions (`packages/shared/src/validators/ticketForms.ts`)

```ts
type TicketFormField = {
  key: string;          // /^[a-z][a-z0-9_]{0,49}$/, unique within form
  label: string;        // 1..200
  type: 'text' | 'textarea' | 'select' | 'checkbox' | 'date' | 'number';
  required: boolean;
  helpText?: string;
  placeholder?: string;
  options?: string[];   // select only, 1..50 entries
  defaultValue?: string | number | boolean;
};
```

Limits: ≤ 30 fields per form. Deliberately **no** `device` field type in v1 — the existing standalone device selector on `CreateTicketPage` stays as-is, and portal users have no device visibility; don't entangle the two.

Shared exports (used by API, web, portal — one source of truth):
- `ticketFormFieldSchema`; a default-free base object schema; `createTicketFormSchema = base.extend({ …create defaults, ownerScope, orgId })` (includes `ownerScope: z.enum(['organization','partner'])`); `updateTicketFormSchema = base.partial()`. The base carries NO `.default()` and NO `ownerScope`/`orgId`, so ownership is immutable by construction and a partial update never materializes create-time defaults (a `.partial()` of a schema with `.default()` keys re-applies those defaults in this zod version).
- `buildResponseValidator(fields)` → a Zod object schema enforcing required/type/options for a submission — the SAME validator runs client-side (inline errors) and server-side (authoritative).
- `renderFormResponses(form, responses)` → deterministic markdown block appended to the ticket description:

```markdown
{description_intro}

**New User Onboarding** (form)
- **Affected user:** jdoe@client.example
- **Start date:** 2026-07-14
- **Needs VPN:** Yes
```

## 3. API surface (`apps/api/src/routes/tickets/forms.ts`, mounted under `/ticket-forms`)

| Route | Notes |
|---|---|
| `GET /ticket-forms` | List for management UI. Dual-axis read: `orgCondition OR (org_id IS NULL AND partner_id = auth.partnerId)` — partner branch gated on `auth.scope === 'partner'` (org tokens never pass `breeze_has_partner_access`; app layer must not claim parity with RLS). |
| `GET /ticket-forms/available?orgId=` | Resolved picker list for ticket creation: active forms visible to that org (org-owned ∪ partner-owned of the org's partner), returned as a flat list ordered by `sort_order` then `name`. Grouping is a client concern; the category-grouped picker is deferred to the Phase 2 portal. Used by web create page. |
| `POST /ticket-forms` | Create. `ownerScope: 'partner'` requires `canManagePartnerWidePolicies(auth)` → 403 `PARTNER_WIDE_WRITE_DENIED_MESSAGE` otherwise. |
| `PUT /ticket-forms/:id` | Update; ownerScope immutable; bumps `version` when `fields`/`title_template` change. Partner-owned rows gated on `canManagePartnerWidePolicies`. |
| `DELETE /ticket-forms/:id` | Hard delete (forms are config; the rendered description + jsonb snapshot on existing tickets survives deletion by design). Same partner-wide gate. |

**Submission is not a new endpoint.** `createTicketSchema` gains optional `formId` + `formResponses: Record<string, unknown>`. `createTicket` in `ticketService.ts`: load form → verify active + visible to target org → `buildResponseValidator(form.fields).parse(responses)` → compose subject from `title_template` (missing-key interpolation = empty string), append rendered block to description, apply `category_id`/`default_priority`/`default_tags` (explicit caller values win), stamp `custom_fields.intakeForm`. Every creation path (staff route, portal route, AI tools) flows through this one service function — no drift.

**Portal read path — the one sharp edge.** Portal routes run under an **org-scoped** RLS context (`routes/portal/auth.ts` wraps requests in `withDbAccessContext({scope:'organization', …})`), so partner-owned form rows are invisible there by RLS. The portal `GET /portal/ticket-forms` handler must fetch via `runOutsideDbContext(() => withSystemDbAccessContext(...))`, filtered app-side to `show_in_portal AND is_active AND (org_id = user.orgId OR partner_id = <org's partner>)` — the established heartbeat/#1105 pattern. Same for the portal submit path when it loads the form to validate. Flag this in the PR description; it's the most likely silent failure ("portal shows no forms" with everything else green).

## 4. UI

### 4.1 Admin builder — Settings → Ticketing → "Intake Forms" tab

Sits beside the existing response-templates management. List (name, owner badge, category, field count, portal toggle, active toggle) + editor:

- Create-only ownerScope radio, verbatim pattern from `apps/web/src/components/software/PolicyForm.tsx:88-111` ("All organizations (partner-wide)" / "This organization only"), with the standard "All orgs" badge on partner-owned rows in the list.
- Field editor: vertical list of rows (label, type select, required checkbox, expandable help-text/placeholder/options). Reorder via up/down buttons — **no drag-and-drop in v1**; it's the classic scope sink and up/down covers 30-field forms fine.
- Live preview pane rendering the form exactly as the picker will (reuses the same renderer component — preview can't drift).
- All mutations through `runAction`.

### 4.2 Tech-facing — `CreateTicketPage.tsx`

After org selection, if `GET /ticket-forms/available` returns anything: a "Start from a form" section (category-grouped). Picking one injects the dynamic field block above the existing description textarea and pre-fills category/priority/tags (still editable — techs get defaults, not handcuffs). "Blank ticket" remains the default path; forms are additive.

### 4.3 Portal — `NewTicketForm.tsx` (this is the requester's actual scenario)

Portal today collects subject/description/priority only. New flow: if the org has portal-visible forms, the New Ticket screen first shows a **card grid grouped by category** ("What do you need?"); picking a card renders that form's fields; "Something else" falls through to the current free-text form. `portalBranding.enableTickets` continues to gate the whole feature. Client-side validation via the shared `buildResponseValidator`; server re-validates.

## 5. Multi-tenant assignment semantics

- **v1:** partner-owned form = visible to **all** the partner's orgs (this is the Partner-Wide First default and covers "assign to multiple tenants" for the common case). Org-owned form = that org only.
- **Phase 2 (the "some orgs but not all" refinement):** `ticket_form_org_links(form_id, org_id)` join table — partner-axis RLS as an FK-child of the partner-owned form (register it; FK children get NO policy for free). Semantics: no rows = all orgs (unchanged default), rows present = allowlist. Deliberately deferred: the requester marked it "would be wonderful," and shipping v1 without it changes nothing about the schema.

## 6. Phasing

**Phase 1 — core (one PR train):** migration + schema + shared validators, `/ticket-forms` CRUD with partner-wide gates, `createTicket` formId/formResponses handling, admin builder, CreateTicketPage picker.
**Phase 2 — portal:** portal card-grid intake + system-context read path + org-allowlist join table.
**Phase 3 — AI convergence:** `manage_tickets` gains `list_forms` / `create` accepting `formId+formResponses`; desktop helper + AI agent use the field schema as an elicitation contract ("collect these fields, then file the ticket"). Zero new schema.

## 7. Compliance checklist (Partner-Wide First playbook)

- [ ] Migration creates table + XOR CHECK + RLS policy in one idempotent file; policy is the single three-branch dual-axis form.
- [ ] `DUAL_AXIS_TENANT_TABLES` registration in `rls-coverage.integration.test.ts` (same PR).
- [ ] `ticketFormsPartnerRls.integration.test.ts`: cross-partner forge → 42501; both/neither owner → 23514; org isolation; org-token cannot read sibling-org rows.
- [ ] Writes gated on `canManagePartnerWidePolicies`; `ownerScope` omitted from the update schema.
- [ ] Org-scoped cascade registration: `org_id` column → add to `ORG_CASCADE_DELETE_ORDER` (alpha position — localeCompare); partner delete cascade covered by FK.
- [ ] No worker/scheduler evaluates this table against devices → no fan-out clause needed; the visibility resolution in `GET /ticket-forms/available` and the portal system-context read are the fan-out-equivalents and each gets an integration test against real Postgres (partner-owned form visible to child org; invisible to other partner's org).
- [ ] Repo-wide sweep of `ticketForms.orgId` call sites before calling it done (AI tools, portal, stats — the hidden-second-reader trap).
- [ ] `runAction` on all web mutations; `data-testid` on picker cards / builder rows for e2e.

## 8. Explicitly out of scope

- Conditional/branching field logic ("show X when Y = Z") — the #1 scope-creep vector in form builders; revisit only with demand.
- File-upload fields (ticket attachments are their own workstream).
- Editing responses after submission (the ticket description is the record; edit the ticket).
- Email-to-ticket form mapping.
- Retrofitting `custom_field_definitions` with `entityType='ticket'` — revisit only if ticket-level ad-hoc custom fields (outside forms) become a requested feature; forms don't need it.

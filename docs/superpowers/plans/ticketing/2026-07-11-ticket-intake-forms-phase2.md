# Ticket Intake Forms Phase 2 (Portal Intake + Org Allowlist) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End users submit uniform tickets through intake forms in the client portal (card grid on New Ticket), and partner-wide forms can be limited to a subset of orgs via an allowlist join table.

**Architecture:** Phase 1 (merged, `2b7c10ed3`) built the dual-axis `ticket_forms` table, shared Zod validators, `ticketFormService` (system-context reads), and `createTicket` intake handling. Phase 2 adds: `ticket_form_org_links` (FK-child allowlist; no rows = all orgs), allowlist-aware resolution in `ticketFormService`, a `showInPortal` enforcement guard on portal-sourced creates, a portal read route + extended portal create schema, an org multi-select in the web builder, and a portal-native form renderer + card grid. The portal deliberately duplicates React components (no runtime sharing with apps/web — repo convention); only the pure Zod logic from `@breeze/shared` is imported.

**Tech Stack:** Hono, Drizzle, hand-written SQL migration, Zod 4, React 19 (portal: react-hook-form), Vitest.

**Spec:** `docs/superpowers/specs/ticketing/2026-07-10-ticket-intake-forms-design.md` §4.3 (portal card grid) + §5 Phase 2 (org allowlist). Phase 1 plan (patterns/reference): `docs/superpowers/plans/ticketing/2026-07-10-ticket-intake-forms.md`.

## Global Constraints

- Zod 4: `.guid()` not `.uuid()`. NEVER derive an update schema via `.partial()` over `.default()`-carrying fields (repo-wide hardened bug class — `ticket_forms` uses the base/extend pattern in `packages/shared/src/validators/ticketForms.ts`; extend that base, don't fork it).
- Migration `apps/api/migrations/2026-07-11-ticket-form-org-links.sql`: idempotent, NO inner `BEGIN;`, RLS in the same file. Never edit shipped migrations (incl. `2026-07-10-ticket-forms.sql`).
- `ticket_form_org_links` registrations (same PR): `PARENT_FK_JOIN_POLICY_TABLES` gets `['ticket_form_org_links', ['ticket_forms']]` (`rls-coverage.integration.test.ts:~359`; precedent `maintenance_occurrences`); `ORG_CASCADE_DELETE_ORDER` in `apps/api/src/services/tenantCascade.ts` (alphabetical; it has an `org_id` column); partner side is covered by the dynamic `information_schema` sweep (documented in that file) — no static partner list exists.
- The FK-child RLS policy must join through the DUAL-AXIS parent predicate (system OR org-access OR partner-access on the `ticket_forms` row), mirroring how `2026-07-01-maintenance-windows-partner-ownership.sql` re-issued `maintenance_occurrences` policies. A plain `breeze_has_org_access(parent.org_id)` join is WRONG here — the parent's org_id is NULL for partner-wide forms.
- Allowlist semantics (spec §5): **no link rows = visible to all the partner's orgs; rows present = allowlist.** Applies to BOTH `listTicketFormsForOrg` and the `getTicketFormForOrg` usability guard. `visibleOrgIds` is only valid on partner-wide forms (org-owned → 400).
- Portal routes run under an org-scoped RLS context (`routes/portal/auth.ts` wraps requests); partner-owned rows are invisible there. New portal reads use `runOutsideDbContext(() => withSystemDbAccessContext(...))` — copy the in-router precedent at `apps/api/src/routes/portal/quotes.ts:70`.
- Portal-sourced creates must enforce `showInPortal` (Phase 1 gap: `getTicketFormForOrg` doesn't check it, so a portal user replaying an internal form's UUID would succeed today-after-portal-wiring).
- The portal CANNOT import React components from apps/web or carry them in packages/shared (plain TS/Zod only — verified, and `apps/web/src/components/billing/invoiceTypes.ts:5` documents the deliberate-duplication convention). The portal gets its own `TicketFormFields.tsx`; only `buildResponseValidator`/`coerceFormResponses`/`TicketFormField` come from `@breeze/shared`.
- Portal POST /tickets keeps its OWN schema (`apps/api/src/routes/portal/schemas.ts`) — extend it there; do not switch it to the shared `createTicketSchema`.
- `formResponses` without `formId` must be rejected (mirror the shared-schema superRefine added post-Phase-1).
- Web mutations via `runAction`; `data-testid` on every interactive element. Portal components follow portal conventions (react-hook-form + inline error strings — see `NewTicketForm.tsx`), NOT apps/web's runAction (portal has no runAction).
- Deferred PR-review debt this plan must pay: integration assertions for `portalOnly` filtering AND `sortOrder,name` ordering of `listTicketFormsForOrg` (previously dead code / unasserted).
- Do not run `*.integration.test.ts` against the shared :5433 Postgres — use a throwaway container (recipe proven in Phase 1; see `2026-07-10` plan Task 3 environment guidance).
- Placeholder emails in docs/tests: never real domains — use `*.example` (customer-PII CI guard).
- Work on branch `feat/ticket-forms-portal-phase2`.

---

### Task 1: `ticket_form_org_links` — migration, schema, registrations, RLS tests

**Files:**
- Create: `apps/api/migrations/2026-07-11-ticket-form-org-links.sql`
- Create: `apps/api/src/db/schema/ticketFormOrgLinks.ts` (+ barrel line in `apps/api/src/db/schema/index.ts`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (PARENT_FK_JOIN_POLICY_TABLES)
- Modify: `apps/api/src/services/tenantCascade.ts` (ORG_CASCADE_DELETE_ORDER, alphabetical: between `'ticket_categories'`-adjacent entries — exact spot: after `'ticket_forms'`, before `'ticket_parts'`)
- Modify: `apps/api/src/__tests__/integration/ticketFormsPartnerRls.integration.test.ts` (allowlist cases)

**Interfaces:**
- Produces: `ticketFormOrgLinks` Drizzle table `{ id uuid pk, formId uuid NOT NULL → ticket_forms ON DELETE CASCADE, orgId uuid NOT NULL → organizations ON DELETE CASCADE, createdAt }`, unique index on `(form_id, org_id)`.

- [ ] **Step 1: Migration** — `CREATE TABLE IF NOT EXISTS ticket_form_org_links` with the columns above, `CREATE UNIQUE INDEX IF NOT EXISTS ticket_form_org_links_form_org_uq ON ticket_form_org_links(form_id, org_id)`, plus `ticket_form_org_links_form_id_idx` and `_org_id_idx`. RLS: ENABLE + FORCE, `DROP POLICY IF EXISTS ticket_form_org_links_isolation` then CREATE with USING/WITH CHECK both:

```sql
EXISTS (
  SELECT 1 FROM ticket_forms tf
  WHERE tf.id = ticket_form_org_links.form_id
    AND (
      public.breeze_current_scope() = 'system'
      OR (tf.org_id IS NOT NULL AND public.breeze_has_org_access(tf.org_id))
      OR (tf.partner_id IS NOT NULL AND public.breeze_has_partner_access(tf.partner_id))
    )
)
```

- [ ] **Step 2: Drizzle schema** — mirror `apps/api/src/db/schema/ticketForms.ts` idioms (imports from `./orgs`, timestamp defaults); `uniqueIndex` for the pair. Barrel export. Run `pnpm db:check-drift` against a local/throwaway DB.
- [ ] **Step 3: Registrations** — `['ticket_form_org_links', ['ticket_forms']]` in `PARENT_FK_JOIN_POLICY_TABLES`; `'ticket_form_org_links'` in `ORG_CASCADE_DELETE_ORDER` (alphabetical). Comment each with one line referencing the dual-axis parent.
- [ ] **Step 4: RLS integration tests (extend the Phase 1 suite, TDD against throwaway DB)** — new cases in `ticketFormsPartnerRls.integration.test.ts`:

```ts
it('org link rows are invisible cross-partner and writable only by the owning partner (42501)', ...)
// partner A creates partner-wide form + link to its org; partner B context: select → [], forge insert link on A's form → 42501
it('link unique constraint rejects duplicates (23505)', ...)
```

- [ ] **Step 5: Run** rls-coverage + tenantCascade + the extended suite on a throwaway Postgres (Phase 1 recipe). All green (new allowlist-resolution cases land in Task 2's step).
- [ ] **Step 6: Commit** `feat(api): ticket_form_org_links allowlist table — schema, migration, FK-child RLS`

---

### Task 2: Shared `visibleOrgIds` + allowlist/portal-visibility logic in `ticketFormService`

**Files:**
- Modify: `packages/shared/src/validators/ticketForms.ts` + `.test.ts`
- Modify: `apps/api/src/services/ticketFormService.ts` + `.test.ts`
- Modify: `apps/api/src/services/ticketService.ts` (portal-source guard) + `.test.ts`
- Modify: `apps/api/src/__tests__/integration/ticketFormsPartnerRls.integration.test.ts` (fan-out + portalOnly + ordering assertions)

**Interfaces (produced):**
- Shared: `createTicketFormSchema`/`updateTicketFormSchema` gain `visibleOrgIds: z.array(z.string().guid()).max(500).nullable().optional()` — added to the DEFAULT-FREE BASE schema (null/absent = all orgs). Semantics comment required.
- Service: `listTicketFormsForOrg(org, opts?)` — partner-wide branch additionally requires `(no links OR link for org.id)`; implement with SQL `NOT EXISTS`/`EXISTS` subqueries on `ticket_form_org_links`. Ordering unchanged (`sortOrder, name`).
- Service: `getTicketFormForOrg(formId, org, opts?: { requirePortalVisible?: boolean })` — partner-wide rows additionally pass the allowlist check (400 `'Ticket form is not available for this organization'` on miss); `requirePortalVisible && !form.showInPortal` → 400 `'Ticket form is not available in the portal'`.
- Service: `syncTicketFormOrgLinks(formId: string, orgIds: string[] | null, partnerId: string): Promise<void>` — system-context; validates every org belongs to `partnerId` (read orgs, compare partner ids; throw `TicketFormError(400, 'visibleOrgIds must reference organizations of the owning partner')`); `null` → delete all rows; array → delete + insert (replace semantics). Also `getTicketFormOrgLinkMap(formIds: string[]): Promise<Map<string, string[]>>` for list responses.
- `createTicket` (`ticketService.ts`): pass `{ requirePortalVisible: input.source === 'portal' }` to `getTicketFormForOrg`.

- [ ] **Step 1 (TDD):** shared tests — visibleOrgIds accepted (array/null/absent) on create+update, rejected >500, guid-validated; base/extend construction untouched (update parse of `{name}` still yields only `{name}`).
- [ ] **Step 2 (TDD):** ticketFormService unit tests (mocked db, Phase 1 conventions) — `getTicketFormForOrg` 400 on `requirePortalVisible` + `showInPortal:false`; org-owned forms skip allowlist; `syncTicketFormOrgLinks` throws on cross-partner org.
- [ ] **Step 3 (TDD):** ticketService test — portal-source create with internal-only form mock → `TicketServiceError` 400, no insert; non-portal source unaffected.
- [ ] **Step 4: Integration (the real proof + PR-review debt):** extend the fan-out test file:

```ts
it('allowlist: partner-wide form with links visible ONLY to linked orgs', ...)
// form P linked to orgA: listTicketFormsForOrg(orgA) includes it; (orgB of same partner) excludes it; unlinked partner-wide form Q visible to both
it('portalOnly filters showInPortal=false rows', ...)
it('ordering: sortOrder then name', ...) // create 3 forms with sortOrder 2/1/1 and names, assert exact order — no .sort() masking
```

- [ ] **Step 5:** Run shared + api unit suites, tsc, integration suite on throwaway DB. Commit `feat(api): allowlist + portal-visibility resolution for ticket forms`

---

### Task 3: Staff routes — `visibleOrgIds` round-trip

**Files:**
- Modify: `apps/api/src/routes/tickets/forms.ts` + `forms.test.ts`

**Interfaces:**
- POST: `visibleOrgIds` only when `ownerScope === 'partner'` (else 400 `'visibleOrgIds is only valid on partner-wide forms'`); after insert, `syncTicketFormOrgLinks(row.id, payload.visibleOrgIds ?? null, auth.partnerId)`.
- PUT: only when row is partner-wide (else 400); `visibleOrgIds === undefined` → links untouched; `null` → clear; array → replace. Does NOT bump `version` (visibility isn't part of the response contract).
- GET list + available: responses gain `visibleOrgIds: string[] | null` via `getTicketFormOrgLinkMap` (null when no rows). `available` needs no change to its filtering (service handles it) — but add the field for symmetry only on the management list, NOT on `available` (pickers don't need it).
- Strip `visibleOrgIds` from the `.set()` spread on PUT (it's not a column): `const { visibleOrgIds, ...columns } = payload;`.

- [ ] **Step 1 (TDD):** route tests — create partner-wide with visibleOrgIds calls sync with token partner; create org-owned with visibleOrgIds → 400; PUT undefined/null/array semantics (sync called correctly, set() never receives the key); management list carries the field.
- [ ] **Step 2:** implement; run forms suite + tsc. Commit `feat(api): visibleOrgIds round-trip on /ticket-forms`

---

### Task 4: Portal API — forms read + form-aware create

**Files:**
- Modify: `apps/api/src/routes/portal/tickets.ts` + `tickets.test.ts`
- Modify: `apps/api/src/routes/portal/schemas.ts`

**Interfaces:**
- `GET /ticket-forms` (portal router, same mount as portal ticket routes; auth from `portalAuth`): resolve `{ id: user.orgId, partnerId }` — read the org's partnerId the same way `routes/portal/quotes.ts` resolves partner context (system-context read, `runOutsideDbContext(() => withSystemDbAccessContext(...))`); return `{ data: forms.map(slim) }` where slim = `{ id, name, description, categoryId, fields, defaultPriority }` from `listTicketFormsForOrg(org, { portalOnly: true })`. No titleTemplate (server composes subjects).
- Portal `createTicketSchema` (`schemas.ts`) becomes:

```ts
export const createTicketSchema = z
  .object({
    subject: z.string().min(1).max(255).optional(),
    description: z.string().min(1).optional(),
    priority: ticketPrioritySchema.optional().default('normal'),
    formId: z.string().guid().optional(),
    formResponses: z.record(z.string(), z.unknown()).optional()
  })
  .superRefine((v, ctx) => {
    if (!v.formId && (!v.subject || !v.subject.trim())) {
      ctx.addIssue({ code: 'custom', path: ['subject'], message: 'subject is required unless a formId is provided' });
    }
    if (!v.formId && (!v.description || !v.description.trim())) {
      ctx.addIssue({ code: 'custom', path: ['description'], message: 'description is required unless a formId is provided' });
    }
    if (v.formResponses && !v.formId) {
      ctx.addIssue({ code: 'custom', path: ['formResponses'], message: 'formResponses requires formId' });
    }
  });
```

(Keeping `priority.default('normal')` here is fine: the portal UI has no per-form priority prefill; forms' `defaultPriority` losing to the portal's explicit `'normal'` is acceptable Phase 2 behavior — note it in the PR body. If the executor disagrees, the alternative is dropping the default and letting the service chain resolve — either is acceptable, but then update the handler's typing accordingly and say so in the report.)
- POST handler passes `formId`/`formResponses` through to `createTicket` (which already validates, composes, and — from Task 2 — enforces `showInPortal` + allowlist for `source: 'portal'`).

- [ ] **Step 1 (TDD):** portal route tests (mock `ticketService`/`ticketFormService` per `portal/tickets.test.ts` conventions) — GET returns slim forms for the session org; POST passes formId/formResponses; POST with formResponses-sans-formId → 400; POST form-only (no subject/description) accepted by schema.
- [ ] **Step 2:** implement; run portal route tests + tsc. Commit `feat(api): portal ticket-forms read + form-aware portal ticket create`

---

### Task 5: Web builder — org allowlist multi-select

**Files:**
- Modify: `apps/web/src/components/settings/TicketFormsCard.tsx` + `.test.tsx`

**Interfaces:**
- Editor (partner-wide scope only, both create and edit): checkbox "Limit to specific organizations" (`ticket-form-limit-orgs`); when checked, a multi-select of the partner's orgs (`ticket-form-visible-orgs`, reuse the orgs list already fetched). Unchecked → `visibleOrgIds: null` on save; checked → selected ids (min 1 — inline issue otherwise).
- List rows: partner-wide forms show `All orgs` badge when `visibleOrgIds` is null, else `N orgs` (`ticket-form-org-count-<id>`).
- Edit hydration: seed the control from the row's `visibleOrgIds`.

- [ ] **Step 1 (TDD):** tests — create partner-wide with 2 orgs selected → POST body `visibleOrgIds: [a, b]`; unchecking sends `null` on edit; badge renders `2 orgs`; checked-with-zero-selection blocks save with inline issue.
- [ ] **Step 2:** implement (existing editor patterns; all mutations already runAction). Run TicketFormsCard tests + full web suite. Commit `feat(web): org allowlist selector on partner-wide intake forms`

---

### Task 6: Portal UI — form renderer + card grid

**Files:**
- Create: `apps/portal/src/components/portal/TicketFormFields.tsx` (portal-native duplicate — header comment MUST note "Deliberate duplicate of apps/web/src/components/tickets/TicketFormFields.tsx (portal cannot share web React components); keep in sync", matching the `invoiceTypes.ts:5` convention)
- Create: `apps/portal/src/components/portal/TicketFormFields.test.tsx`
- Modify: `apps/portal/src/components/portal/NewTicketForm.tsx` + create `NewTicketForm.test.tsx` (if none exists)
- Modify: `apps/portal/src/components/portal/index.ts` (barrel)
- Modify: `apps/portal/src/lib/api.ts` (`getTicketForms()` → `GET /portal/ticket-forms` — confirm the exact portal API mount prefix by reading how `createTicket` builds its path in that file)
- Possibly modify: `apps/portal/package.json` (devDeps)

**Interfaces:**
- `TicketFormFields` props identical to the web version: `{ fields, values, errors, onChange }`, testids `ticket-form-field-<key>` / `ticket-form-field-error-<key>`; styling per portal conventions (copy input classes from `NewTicketForm.tsx`).
- `NewTicketForm` flow: on mount also fetch forms (silent-degrade with `console.warn` breadcrumb). If forms exist → card grid first (`portal-ticket-form-card-<id>`, name + description), plus a "Something else" card (`portal-ticket-form-card-blank`) falling through to today's subject/description/priority form. Selecting a form renders `TicketFormFields` (+ optional extra-details textarea mapped to `description`), validates via `coerceFormResponses` + `buildResponseValidator` from `@breeze/shared` (missing-required → "This field is required"), submits `{ formId, formResponses, description? , priority }` — no subject. Back link returns to the grid and clears state.
- Test environment: portal vitest is `environment: 'node'` — add `// @vitest-environment jsdom` per component test file. Check `apps/portal/package.json` devDeps for `@testing-library/react` + `jsdom`; if absent, add the same versions apps/web uses (workspace-consistent; `pnpm install` after). This is the one lockfile-touching step — isolate it in its own commit if added.

- [ ] **Step 1:** deps check/add (own commit if needed: `chore(portal): component-test tooling`)
- [ ] **Step 2 (TDD):** renderer test — all six field types render with testids; error line renders.
- [ ] **Step 3 (TDD):** NewTicketForm tests — grid renders from mocked `portalApi.getTicketForms`; blank card → legacy form; form card → fields; invalid required blocks submit with inline error and no API call; valid submit posts formId+coerced responses without subject; forms-fetch failure degrades to legacy form.
- [ ] **Step 4:** implement; run portal tests (`pnpm --filter @breeze/portal test` — confirm the actual package name in apps/portal/package.json) + `astro check` if portal CI runs it (check `.github/workflows/ci.yml` for the portal job's commands and run those). Commit `feat(portal): intake-form card grid on New Ticket`

---

### Task 7: Verification gate + sweep

- [ ] **Step 1:** Sweep `ticket_form_org_links|visibleOrgIds|getTicketForms` repo-wide — every reader/writer goes through the service/routes above; no bare org filtering.
- [ ] **Step 2:** Full suites: shared, api (compare failures to known-flake list only), web, portal; tsc api; `pnpm db:check-drift`; integration trio + extended allowlist/ordering cases on a throwaway DB (unprivileged `breeze_app`, prove non-vacuous per Phase 1 recipe).
- [ ] **Step 3:** Manual live check (optional but preferred): worktree-stack up, create a partner-wide form limited to one org, verify portal of that org shows the card and a sibling org's portal doesn't, submit a ticket, confirm rendered description + `custom_fields.intakeForm`.
- [ ] **Step 4:** Commit any sweep fixes; PR body: allowlist semantics (no rows = all orgs), the new `showInPortal` enforcement on portal creates (Phase 1 gap closed), portal priority-default note (Task 4), lockfile change if Task 6 added devDeps, and a `Refs` note that `portalBranding.enableTickets` remains un-enforced (tracked as a separate issue).

## Self-Review Notes

- Spec coverage: §4.3 card grid → Tasks 4+6; §5 allowlist → Tasks 1-3+5; portal RLS caveat → Tasks 2/4 (system-context reads); PR-review debt (portalOnly/ordering assertions) → Task 2 Step 4.
- Deliberate scope exclusions: `portalBranding.enableTickets` enforcement (pre-existing silent-toggle gap — separate issue, since enforcing it changes behavior for orgs that toggled it off believing it worked); AI phase (Phase 3); e2e portal specs (no portal Playwright scaffolding exists — net-new rig, separate effort).
- Verify-at-execution points: portal package name for test filter (Task 6), portal API mount prefix (Task 6 api.ts), portal CI commands (Task 6 Step 4), exact `PARENT_FK_JOIN_POLICY_TABLES` entry format (Task 1 Step 3 — read neighbors first).

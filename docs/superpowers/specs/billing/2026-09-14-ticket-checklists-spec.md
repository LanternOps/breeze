# Ticket checklists + internal instructions on deliverable templates — design

Status: **draft, awaiting Todd's approval**.
Issue: LanternOps/breeze#5783. Parent feature: #5573 (service deliverables), spec
`docs/superpowers/specs/billing/2026-09-10-service-deliverables-portal-design.md`.
Advisor quorum: Fable position formed first, Codex `gpt-6-astra` `xhigh` read-only
review received. See §10 "Quorum record".

Two product decisions were made by Todd before this spec and are **not open**:

1. Template-item / deliverable `instructions` are **internal only**. They are never
   rendered in the customer portal.
2. Onboarding is modelled with the existing `one_time` deliverable template sets.
   No new onboarding entity.

---

## 1. Problem

Service deliverables shipped in v0.113.0. The daily sweep materializes an
occurrence, opens a ticket through `createPlannedWorkTicket`
(`apps/api/src/services/serviceDeliverableService.ts`, `openOneOccurrence` ~line 822)
and hands the technician a subject, a due date and — at best — the deliverable's
prose `description`.

That `description` is **customer-facing** by the parent spec (§4.1: "customer-facing
sentence"; §8 publishes it on the portal service scorecard). It therefore cannot
carry internal procedure. The result:

- Nothing tells the technician *what to check*. "Monthly sign-in log review" is a
  title, not a runbook.
- Nothing makes two technicians perform the same review the same way.
- Nothing shows partial progress. An occurrence is `open` whether one step or six
  of seven are done.
- The MSP cannot encode a service tier's procedure once and have every customer's
  occurrence inherit it — which is the whole reason deliverable template sets exist.

Breeze has **no checklist primitive at all**. Verified: no checklist/task rows on
`tickets` (`apps/api/src/db/schema/portal.ts` ~line 114 — nothing between
`tags text[]` and `custom_fields jsonb`), nothing on occurrences
(`apps/api/src/db/schema/serviceDeliverables.ts`). The two adjacent things are not
substitutes: `ticket_response_templates`
(`apps/api/src/db/schema/ticketResponseTemplates.ts`) is a canned *reply body*
library, and `playbook_definitions` is automation, not human steps.

Goal: an ordered, tickable checklist on a ticket; a reusable, partner-wide library
of checklist templates; and internal instructions on deliverables and deliverable
template items that seed that checklist when the sweep opens an occurrence — with
nothing of it ever reaching the customer portal.

## 2. Users and scope

| Actor | What they get |
|---|---|
| **Partner (MSP) admin** with full org access | Authors partner-wide checklist templates that apply to every org the MSP manages, present and future. Attaches one to a deliverable template item so a whole service tier inherits it. |
| **Partner technician** | Sees the checklist on the ticket and in the occurrence drawer; ticks steps; adds ad-hoc steps; applies a checklist template to any ticket (device onboarding, user offboarding). Reads the internal instructions. |
| **Org-scoped API token / org user** | **Nothing.** The checklist routes are `requireScope('partner', 'system')`, the same internal-only posture `apps/api/src/routes/tickets/parts.ts` takes for parts and per-ticket time. |
| **Customer (portal)** | **Nothing.** No steps, no instructions, no progress count. See §5. |

In scope: one new ticket-child table, two new dual-owned template tables, four new
columns on two existing deliverable tables, seeding at occurrence open, REST, the
ticket-detail and occurrence-drawer UI, a settings page for templates, read-only
AI exposure.

Out of scope: §7.

## 3. Proposed design

### 3.1 Three primitives, cleanly separated

| Primitive | What it is | Where it lives |
|---|---|---|
| **Checklist item** | One tickable step on one ticket. Carries `done_at` / `done_by_user_id`. | `ticket_checklist_items` (new, shape 1) |
| **Checklist template** | A reusable, ordered list of step labels. Org-owned or partner-wide. | `ticket_checklist_templates` + `ticket_checklist_template_items` (new, dual-axis `org_id XOR partner_id`) |
| **Instructions** | Free internal prose — the runbook, the gotchas, "check X before Y". Never parsed, never a step list. | `instructions text` on `service_deliverables`, `deliverable_template_items` and `ticket_checklist_templates` |

The separation of the last two is the load-bearing decision. Conflating them —
"markdown, one step per line, split at seed time" — makes the checklist a function
of prose formatting: reflowing a sentence silently changes the steps, and a bullet
that wraps becomes two steps. It is also the shape that has to be retrofitted the
moment anyone wants a per-step note, a required flag or a stable step identity,
which is exactly the "works now, retrofit later" pattern CLAUDE.md records as
having cost more every time (#1724, #2126–#2129).

### 3.2 The seeding chain

```
deliverable_template_items.checklist_template_id ─┐  (applyTemplateSet copies the id)
                                                  ▼
                    service_deliverables.checklist_template_id
                                                  │  (sweep: openOneOccurrence)
                                                  ▼
       ticket_checklist_templates → _template_items ──copy──▶ ticket_checklist_items
                                                                 (on the new ticket)
```

`instructions` rides the same chain (template item → deliverable) and is delivered
to the technician as an **internal ticket comment** posted in the same transaction
as the ticket creation: `ticket_comments` with `is_public = false`,
`comment_type = 'system'`, author = the sweep actor. Reasons:

- It is the existing internal channel, and the sweep already posts exactly this
  kind of comment ("Report attached, review and resolve", parent spec §5.3 step 3),
  so the notification and portal-exclusion behaviour is already proven.
- It is a point-in-time **snapshot**, matching the `name_snapshot` precedent
  (parent §4.2: later renames do not rewrite history). Editing the deliverable's
  instructions tomorrow must not silently rewrite what a technician was told to do
  last month.
- Zero new columns, and it survives the deliverable being edited or deactivated.

### 3.3 Applying a template by hand

A technician can apply a checklist template to **any** ticket
(`POST /tickets/:id/checklist/apply-template`), which is how "onboard a device" and
"offboard a user" work without a new entity. Two modes: `append` (default) and
`replace_unticked` (drops items with `done_at IS NULL`, keeps completed history).
Never a destructive replace of ticked rows.

### 3.4 Completion is informational

Ticking every box changes nothing automatically. Parent spec D4 established that
ticket closure is not delivery, precisely because closing a ticket requires neither
an artifact nor a note. A checkbox is weaker evidence than a ticket closure, so
letting it close a ticket — and thereby, under
`completion_mode = 'on_ticket_resolve'` with `artifact_required`, push the
occurrence to `awaiting_evidence` — would reintroduce the exact softness D4
removed, one level lower and with less ceremony. (To be precise, and per Codex:
D4 governs how *delivery* is recorded; the ban on a checklist actuator is an
additional product policy this spec proposes, argued by analogy to D4, not a
consequence of it.)

v1 ships:

- a derived progress counter (`3 / 7`) on the ticket and in the occurrence drawer;
- a **soft** confirmation in the web UI when a technician moves a ticket to
  `resolved` **or `closed`** with unticked items ("3 of 7 steps are unticked —
  resolve anyway?"). Both transitions matter: the `deliverable-status` subscriber
  treats `resolved` and `closed` identically
  (`services/serviceDeliverableService.ts:685`, `:715`).

The confirmation is **client-side only** and therefore bypassable through the API,
an AI tool or a bulk status update. That is accepted for v1: it is a nudge, not a
control. A real control is the sanctioned future extension — a **blocking guard**
(`checklist_required` boolean on the deliverable; resolve refused with 409
`CHECKLIST_INCOMPLETE` in `changeTicketStatus`), never an actuator. See Open
Decision 4.

## 4. Tenancy and data model impact

Rules this design is bound by, quoted from the root `CLAUDE.md`:

> Every tenant-scoped table MUST have RLS enabled + forced + policies — no
> app-layer-only fallback.

> Pick a shape; add policies in the same migration that creates the table — never
> defer. **Every composite FK that references an `org_id` column
> (`(x, org_id) → parent(id, org_id)`) MUST be `DEFERRABLE INITIALLY IMMEDIATE`.**

> Register the table in every cascade list that applies. **RLS coverage does NOT
> imply cascade coverage — they are separate contracts, and this step is the one
> that gets missed.**

> `excludedOpen` — **any `json`/`jsonb`/`bytea` column.**

> **Every new config-ish table (policies, templates, rules, windows, baselines)
> defaults to dual-ownership: `org_id` XOR `partner_id`, both nullable, exactly one
> set.**

### 4.1 `ticket_checklist_items` — shape 1 (direct `org_id`)

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `org_id` | uuid NOT NULL | FK `organizations`; **denormalized from the ticket** (§4.6 is the consequence) |
| `ticket_id` | uuid NOT NULL | composite FK `(ticket_id, org_id) → tickets(id, org_id)` **DEFERRABLE INITIALLY IMMEDIATE**, `ON DELETE CASCADE`. `tickets_id_org_uq` already exists (`apps/api/migrations/2026-09-25-ai-agents-ticket-triage.sql:34`). Constraint name: `ticket_checklist_items_ticket_org_fk`. |
| `label` | varchar(500) NOT NULL | the step. Plain text; rendered as text, never as HTML. |
| `detail` | text NULL | optional per-step internal note ("compare against the baseline export") |
| `position` | integer NOT NULL | sort key. **No unique constraint** — a whole-list reorder writes every row in one statement (§5.1), and a partial unique would force deferral machinery for no benefit. Ordering is `(position, created_at, id)` so it is total even on a tie. |
| `done_at` | timestamptz NULL | **the authority for "done"** |
| `done_by_user_id` | uuid NULL | FK `users` `ON DELETE SET NULL` — best-effort attribution only. Deliberately **no** `CHECK ((done_at IS NULL) = (done_by_user_id IS NULL))`: deleting the user would then break the check on a legitimately-done row. |
| `source` | enum `ticket_checklist_item_source` | `manual \| deliverable \| checklist_template` |
| `source_template_item_id` | uuid NULL | provenance, **no FK** — the source template may be partner-wide (`org_id IS NULL`), so no composite org FK is expressible, and the template item may later be deleted. Audit only; never joined for authorization. |
| `created_by` | uuid NULL | FK `users` `ON DELETE SET NULL`. **Left NULL for sweep-created rows** — `DELIVERABLE_SWEEP_ACTOR.userId` is the nil UUID `00000000-…-0000` (`serviceDeliverableService.ts:781`) and is *not* a real `users` row, so writing it would 23503. Nullability is the system-provenance marker; `source` says where the row came from. |
| `created_at`, `updated_at` | timestamptz NOT NULL | |

Indexes: `ticket_checklist_items_ticket_pos_idx (ticket_id, position)`,
`ticket_checklist_items_org_idx (org_id)`.

**Attestation rules** (Codex finding 1):

- Ticking is **idempotent and first-writer-wins**: `PATCH { done: true }` on an
  already-done item leaves the original `done_at` and `done_by_user_id` untouched.
  A duplicate request must never re-attribute the step to whoever clicked second.
- `PATCH { done: false }` clears **both** columns.
- Editing the `label` or `detail` of a completed item **clears the attestation**
  (`done_at`, `done_by_user_id` → NULL) and returns the cleared row. The tick
  attested to the old text; silently carrying it onto new text is a falsified
  record. The UI warns before the edit.
- Both are computed **server-side** from the authenticated principal and
  `now()`; neither is ever accepted from the request body.

RLS: `ENABLE` + `FORCE`, one `FOR ALL` policy
`breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id)`.
Shape 1, so `rls-coverage.integration.test.ts` auto-discovers it — no allowlist
entry.

**No counter column on `tickets`.** Progress is `COUNT(*) FILTER (WHERE done_at IS
NOT NULL)`, computed on read. A denormalized counter is a drift bug waiting for the
first bulk delete.

### 4.2 `ticket_checklist_templates` — dual-axis, `org_id XOR partner_id`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `org_id` | uuid NULL | FK `organizations` |
| `partner_id` | uuid NULL | FK `partners` |
| `name` | varchar(200) NOT NULL | |
| `description` | text NULL | |
| `instructions` | text NULL | internal runbook prose for the whole checklist |
| `is_active` | boolean NOT NULL DEFAULT true | |
| `created_by` | uuid NULL | FK `users` `ON DELETE SET NULL` |
| `created_at`, `updated_at` | timestamptz NOT NULL | |

- `ticket_checklist_templates_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL))`
- `UNIQUE (id, org_id)` and `UNIQUE (id, partner_id)` — the two branch-FK targets
  for the items table (same construction as
  `deliverable_template_sets_id_org_uq` / `_id_partner_uq`,
  `apps/api/src/db/schema/deliverableTemplates.ts`)
- `UNIQUE (partner_id, name) WHERE partner_id IS NOT NULL`,
  `UNIQUE (org_id, name) WHERE org_id IS NOT NULL`
- indexes on `org_id` and on `partner_id`

RLS, both in the creating migration:

1. one dual-axis `FOR ALL` policy —
   `breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id)`;
2. a **separate, additive, SELECT-only** partner-wide branch
   `ticket_checklist_templates_partner_wide_select`
   `USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())`.
   Template: `apps/api/migrations/2026-10-05-110000-config-policy-partner-wide-select.sql`.
   Never appended to the `FOR ALL` policy — that would widen UPDATE/DELETE row
   targeting to partner-wide rows and let an org admin delete their MSP's shared
   template (the migration header spells this out).

Writes to partner-wide rows gate on `canManagePartnerWidePolicies(auth)`
(`apps/api/src/services/partnerWideAccess.ts` — `auth.scope === 'system' ||
(auth.scope === 'partner' && auth.partnerOrgAccess === 'all')`); the service throws
`PartnerWideWriteDeniedError`, routes map it to 403.

### 4.3 `ticket_checklist_template_items` — dual-axis, owner columns copied

`id`, `template_id` NOT NULL, `org_id` NULL, `partner_id` NULL (copied from the
template, same XOR check), `label varchar(500)` NOT NULL, `detail text` NULL,
`sort_order integer NOT NULL DEFAULT 0`, `created_at`, `updated_at`.

Two branch FKs, both **DEFERRABLE INITIALLY IMMEDIATE**, `ON DELETE CASCADE`:
`(template_id, org_id) → ticket_checklist_templates(id, org_id)` and
`(template_id, partner_id) → ticket_checklist_templates(id, partner_id)`. Exactly
the `deliverable_template_items` construction. Unique `(template_id, label)`;
index `(template_id, sort_order)`.

Same two RLS policies as §4.2.

### 4.4 New columns on existing tables

| table | column | notes |
|---|---|---|
| `service_deliverables` | `instructions text NULL` | internal only; never entered into the portal read model (§5) |
| `service_deliverables` | `checklist_template_id uuid NULL` | single-column FK `→ ticket_checklist_templates(id) ON DELETE SET NULL` |
| `deliverable_template_items` | `instructions text NULL` | copied to the deliverable by `applyTemplateSet` |
| `deliverable_template_items` | `checklist_template_id uuid NULL` | same single-column FK |

**Why these two FKs are single-column, and how that is made safe.** A composite
`(checklist_template_id, org_id) → ticket_checklist_templates(id, org_id)` would
make a **partner-wide** template unreferenceable: `service_deliverables.org_id` is
`NOT NULL` while a partner-wide template's `org_id` is `NULL`, so no row could ever
match — which would defeat the entire Partner-Wide-First point of the feature. The
repo's established answer for "an org-scoped row references a possibly-partner-wide
config row" is app-layer validation, the same shape as
`validateFeaturePolicyExists` / `PARTNER_LINKABLE_FEATURE_TYPES` in
`apps/api/src/services/configurationPolicy.ts`. So:

- The service validates on write that the referenced template is either
  (a) owned by the same `org_id`, or (b) partner-wide and owned by the org's
  partner. Failure → **404**, never 403 (a template of another tenant and a
  non-existent template must be indistinguishable).
- For `deliverable_template_items` the owner axis must not narrow: a **partner-wide**
  template item may only reference a **partner-wide** checklist template of the same
  partner (an org-owned one would be invisible to every other org the set is applied
  to, and a silent no-op is the worst outcome). An **org-owned** item may reference
  its own org's template or its partner's partner-wide one.
- Both rules get a real-Postgres integration test that forges the cross-partner
  link (§9). This is recorded as a deliberate deviation from "every FK to a tenant
  row is composite with `org_id`", with the reason, in the migration header.

**Nothing is copied by reference at seed time.** `openOneOccurrence` copies the
template's *item labels* into `ticket_checklist_items` rows stamped with the
**deliverable's org** — never the template's owner, which may be NULL. A
partner-wide template therefore produces org-scoped rows in each customer's tenant,
and no cross-tenant row is ever created. This mirrors the parent spec's §11 rule
that worker-created child rows always take the subject's org.

**Two guards the pointer needs** (both from Codex, both real):

1. **Delete guard.** Deleting a checklist template that any deliverable or
   deliverable template item references would `SET NULL` the pointer and silently
   empty every future occurrence's checklist — no error, no signal. Deletion is
   therefore refused with **409 `CHECKLIST_TEMPLATE_IN_USE`**, listing the
   referencing rows; `is_active = false` is the supported retirement path (existing
   references keep working, the template stops appearing in pickers).
2. **Cross-org apply guard.** `applyTemplateSet`
   (`services/deliverableTemplateService.ts:313`) authorizes the *source* set with
   `loadSetOr404(setId, actor)` and the *target* with `requireOrgAccess(actor, orgId)`
   — an actor holding both may apply **org A's** set to **org B**. Copying a
   `checklist_template_id` that points at org A's private checklist template into an
   org-B deliverable would create a cross-org pointer that RLS makes invisible to
   org B and that the system-context sweep would nonetheless read. Applying such a
   set is refused with **409 `CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG`** unless the
   referenced template is partner-wide (visible to both) or owned by the target org.

### 4.5 Registration lists — a new table is not done until it is in all of these

| # | List | File | Entries | Enforced by |
|---|---|---|---|---|
| 1 | RLS shapes | `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | `ticket_checklist_items`: auto-discovered (shape 1), no entry. `ticket_checklist_templates` + `ticket_checklist_template_items` → **`DUAL_AXIS_TENANT_TABLES`** *and* **`XOR_OWNERSHIP_DUAL_AXIS_TABLES`**. Neither needs `PARTNER_WIDE_SELECT_BRANCH_EXEMPT` — both ship the SELECT branch in their creating migration. | Integration Tests |
| 2 | Org cascade | `CORE_ORG_CASCADE_DELETE_ORDER`, `apps/api/src/services/tenantCascade.ts` | all three, alphabetical, children before parents — see below | `tenantCascade.integration.test.ts` (Integration Tests) |
| 3 | Export policy | `CORE_TENANT_EXPORT_POLICY`, `apps/api/src/services/tenantExportPolicyRegistry.ts` | three new `tablePolicy("org_id", …)` entries **plus** the four new columns appended to the existing `service_deliverables` and `deliverable_template_items` entries — this is the row that fires on a new **column** | `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts` (Integration Tests) |
| 4 | Org merge | `apps/api/src/services/orgMergeRegistry.ts` | `ticket_checklist_items` → `{ kind: 'repoint' }`; `ticket_checklist_template_items` → `{ kind: 'repoint' }` (mirrors `deliverable_template_items`, line 450); `ticket_checklist_templates` → **`{ kind: 'custom' }` rename-on-collision**, *not* `repoint-dedupe` — see below | `orgLifecycleFoundations.integration.test.ts` |
| 5 | **Ticket org-move** | `apps/api/src/services/ticketOrgMoveLockOrder.ts` **and** `apps/api/src/routes/devices/core.ts` | `ticket_checklist_items` → **`TICKET_ORG_DENORMALIZED_TABLES`**, **`TICKET_CHILD_ORG_REWRITE_LOCK_ORDER`** and **`CUSTOM_ORG_REWRITE_TABLES`**, appended last after `ticket_email_links` on every list | see the warning below |

Device cascade lists (`CORE_DEVICE_CASCADE_DELETE_TABLES`,
`CORE_DEVICE_ORG_DENORMALIZED_TABLES`) do **not** apply: no new table has a
`device_id` column.

**Cascade order (list 2), verified with `localeCompare`, not assumed:**

```
… ticket_attachments
    ticket_checklist_items            ← new
    ticket_checklist_template_items   ← new
    ticket_checklist_templates        ← new
  ticket_drafts …  ticket_parts, tickets (last of the ticket_* block)
```

`'ticket_checklist_template_items'.localeCompare('ticket_checklist_templates') === -1`,
so the child lands before its parent by alphabetical luck — verified in node, not
assumed, exactly as the file's own warning near line 368 demands. `ticket_checklist_items`
precedes `tickets`. `service_deliverables` (line 670) and `deliverable_template_items`
(line 427) both precede `ticket_checklist_templates`, so their new
`checklist_template_id` references are cleared first — and the FK is
`ON DELETE SET NULL` anyway.

Codex's correction, adopted: the *literal array* is alphabetical, but the **actual
deletion order is computed from the FK graph** by `topologicalCascadeOrder()`
(`tenantCascade.ts:214`). The alphabetical property is what the contract test
asserts about the array; it is not, by itself, what makes the delete safe. Both
must hold.

**Why `ticket_checklist_templates` is `custom`, not `repoint-dedupe`.** Copying
`deliverable_template_sets`' `repoint-dedupe` (`orgMergeRegistry.ts:445`) would be
wrong here: that entry's justification is that an *applied* deliverable holds no
live reference back to the set, so deleting a duplicate loser is harmless. A
checklist template **is** live-referenced by `service_deliverables.checklist_template_id`
and `deliverable_template_items.checklist_template_id`, so deleting a loser would
null those pointers and silently empty future checklists — the same failure the
delete guard in §4.4 exists to prevent. The entry therefore mirrors
`service_deliverables`' own `custom` note (line 458): rename colliding losers with a
`' (merged <org8>)'` suffix, then repoint every row; **never delete**.

**List 5 is the one that will be missed, and nothing in CI will catch it.**
`ticket_checklist_items` denormalizes `org_id` from its ticket, so both org-move
paths must re-stamp it:

- **Ticket axis** — `moveTicketOrg` (`apps/api/src/services/ticketService.ts:2649`)
  loops `TICKET_ORG_DENORMALIZED_TABLES` with
  `UPDATE <t> SET org_id = … WHERE ticket_id = …`.
- **Device axis** — a device move re-stamps `tickets.org_id` for every ticket with
  that `device_id` (via `breeze_cascade_device_org_id()`, whose table discovery
  keys on the `device_id` column). `ticket_checklist_items` has no `device_id`, so
  neither the trigger nor the generic loop reaches it; it needs a hand-written
  `UPDATE ticket_checklist_items SET org_id = … WHERE ticket_id IN (SELECT id FROM
  tickets WHERE device_id = …)` in `apps/api/src/routes/devices/moveOrg.ts`, exactly
  as `ticket_attachments` gets at line 828.
- **Both paths must add `ticket_checklist_items_ticket_org_fk` to their
  `SET CONSTRAINTS … DEFERRED` list** (`ticketService.ts:2413`,
  `routes/devices/moveOrg.ts:247`). The comment at `ticketService.ts:2393` is
  explicit: the composite FK is DEFERRABLE INITIALLY IMMEDIATE, so
  `UPDATE tickets SET org_id` 23503s *the instant the statement completes* while the
  children still point at the old org. Those lists name constraints **individually,
  never `ALL`**, on purpose.

`ticketOrgMoveLockOrder.test.ts` today asserts only *internal consistency* — that
the two lists agree and document nothing neither mover rewrites. **No test asserts
completeness**, so a new ticket-child table with a denormalized `org_id` that is
left out of list 5 fails at runtime on an admin action, not in CI. This spec
therefore also requires a new schema-derived guard (§9).

### 4.6 Migration filenames

The newest migration committed on `origin/main` is
`apps/api/migrations/2026-10-16-181500-portal-lifecycle-flag.sql`. Filenames must
sort **after** it under `localeCompare` — the repo's filename dates run ahead of
real time (CLAUDE.md: 169 of 466 dated migrations are named ahead of the day they
landed), so today's date does **not** sort last.

| Wave | Filename |
|---|---|
| W01 | `2026-10-16-190000-ticket-checklist-items.sql` |
| W02 | `2026-10-16-190100-ticket-checklist-templates.sql` |
| W03 | `2026-10-16-190200-deliverable-checklist-wiring.sql` |

Re-check against `origin/main` before pushing each wave: the pre-push hook runs
`check-migration-naming.sh --against-ref origin/main`, and a migration that sorted
fine at commit time fails at push time if `origin/main` has since gained one that
sorts after it. Every file is idempotent (`CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`, `pg_policies` existence checks, `DROP POLICY IF EXISTS`
then `CREATE`), carries no inner `BEGIN;`/`COMMIT;`, and — W03, which backfills
nothing today but may in future — elects `SELECT set_config('breeze.scope',
'system', true);` before any row write.

## 5. Portal: nothing, deliberately

The customer portal shows **no checklist, no instructions and no progress count**.

- Parent spec D10 is categorical: "The portal never shows or links a ticket. It
  shows the delivery record (date, lateness, note) and evidence." A checklist is
  ticket state.
- Todd's decision makes instructions internal-only; a progress counter is derived
  *from* internal items, and its denominator leaks the internal decomposition of
  work the MSP never promised to itemize.
- A stalled counter ("2 of 9" for three weeks) is a customer-relations liability
  with no compensating upside. The honest signals already exist and are already
  published: occurrence `status`, `due_at`, and the delivery record with evidence.
- Portal flags in this repo fail closed. Adding a surface later behind a new strict
  flag is purely additive; removing one after customers have seen it is not.

Enforcement, not just intent:

- `serviceReadModel.ts` never selects the new columns, and the checklist routes are
  `requireScope('partner', 'system')`, so no org-scoped token can reach them.
- The assertion covers **three** portal surfaces, not two: `GET /portal/service`,
  `GET /portal/service/:deliverableId/occurrences`, and **portal ticket detail**
  (`apps/api/src/routes/portal/tickets.ts`) — a manual checklist can be added to an
  ordinary support ticket, which the portal *does* expose (Codex finding 5).
- **The narrative leak, which is the one that would actually have shipped.** When a
  technician resolves a deliverable ticket, `resolutionNote` is copied verbatim into
  `serviceDeliverableOccurrences.deliveryNote`
  (`services/serviceDeliverableService.ts:737`), and the portal publishes
  `deliveryNote` as `note` on both the scorecard and the occurrence list
  (`services/portal/serviceReadModel.ts:337`, `:466`). **Nothing may ever
  auto-append a checklist summary, a step label or instructions text to a resolution
  note or a delivery note** — not the UI's "resolve" dialog, not an AI draft, not a
  bulk action. A test asserts the resolve path writes only what the technician
  typed.

## 6. API surface

### 6.1 Checklist on a ticket — `apps/api/src/routes/tickets/checklist.ts`

Mounted in `routes/tickets/index.ts` **before** the hub's `/:id` routes, the same
ordering `parts.ts` documents. Guards on every route:
`requireScope('partner', 'system')` + `requirePermission(PERMISSIONS.TICKETS_READ …)`
or `TICKETS_WRITE`. Ticket resolution goes through `getScopedTicketOr404`, so a
soft-deleted or cross-org ticket is a bare 404.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/tickets/:id/checklist` | `{ items: [...], done: n, total: m }`, ordered `(position, created_at, id)` |
| POST | `/tickets/:id/checklist` | `{ label, detail? }` → appended at `max(position) + 1`, `source: 'manual'` |
| POST | `/tickets/:id/checklist/apply-template` | `{ templateId, mode?: 'append' \| 'replace_unticked' }`; 404 on a template outside the caller's org/partner |
| PATCH | `/tickets/checklist/:itemId` | `{ label?, detail?, done? }`; `done: true` stamps `done_at = now()` and `done_by_user_id = actor` (idempotent, first-writer-wins), `done: false` clears **both**, a `label`/`detail` change on a done item clears both (§4.1). **`done` additionally requires `isInteractiveUserSession(auth)`** — see below. |
| POST | `/tickets/:id/checklist/reorder` | `{ itemIds: [...] }` — the **complete** ordered id list. One `UPDATE … FROM (VALUES …)` statement; 400 `CHECKLIST_REORDER_MISMATCH` if the set differs from the ticket's current items. Whole-list, so two concurrent reorders cannot interleave into a half-order. |
| DELETE | `/tickets/checklist/:itemId` | |

**Ticking requires an interactive human session** (Codex finding 7, and this is the
part that actually enforces §6.5, not the absence of an AI tool). An MCP API key
carries its creator's real `userId` while acting autonomously
(`apps/api/src/middleware/auth.ts:30`, `:58`), so simply not shipping a tick-off
tool would leave `PATCH … { done: true }` reachable by an agent under a human's id —
the exact falsified attestation §6.5 refuses. The `done` branch therefore gates on
`isInteractiveUserSession(auth)` (`middleware/auth.ts:66`) and returns **403
`CHECKLIST_TICK_REQUIRES_USER`** for an API-key, agent or helper principal. Reads,
adds, edits, reorders and deletes are not gated this way.

**Soft-deleted tickets keep their checklist rows** (no cascade on `deleted_at`), but
every read and mutation goes through `getScopedTicketOr404`, so a soft-deleted
ticket is a 404 until an admin restores it — history preserved, access denied.

**Permissions do not leak across features.** The occurrence-drawer checklist read is
still a *ticket* read: deliverable endpoints authorize on `contracts:*`
(`routes/serviceDeliverables.ts`), which must not implicitly grant ticket access. The
drawer's checklist calls hit the ticket routes and are gated on `tickets:read`; a
user with `contracts:read` but not `tickets:read` sees the occurrence without its
checklist rather than an error.

### 6.2 Checklist templates — `apps/api/src/routes/ticketChecklistTemplates.ts`

`GET/POST /ticket-checklist-templates`, `PATCH/DELETE /ticket-checklist-templates/:id`,
plus nested `POST /:id/items`, `PATCH /items/:itemId`, `DELETE /items/:itemId`,
`POST /:id/items/reorder`.

- Create takes `ownerScope: 'organization' | 'partner'` (with `orgId` required for
  `organization`). The update schema is derived `.partial().omit({ ownerScope: true })`
  — ownership is create-only, per the Partner-Wide First playbook.
- Reads are app-layer dual-axis:
  `orgCondition OR (org_id IS NULL AND partner_id = auth.partnerId)`, and the
  partner-wide arm is **gated on `auth.scope === 'partner'`**. RLS is stricter than
  the app layer; this never claims parity.
- Every partner-wide create/update/delete gates on `canManagePartnerWidePolicies`.
  **Applying** a partner-wide template to a ticket does **not** — applying is a read
  of the source plus a write to the target, not partner-wide administration
  (Codex finding 12). Requiring `partnerOrgAccess === 'all'` to *use* a shared
  checklist would make partner-wide templates useless to the technicians they exist
  for.
- Deleting a referenced template → 409 `CHECKLIST_TEMPLATE_IN_USE` (§4.4).
- Permissions: reuse the `tickets` resource (`tickets:read` / `tickets:write`).
  Partner-wide authoring additionally needs `partnerOrgAccess === 'all'`.

### 6.3 Deliverable surfaces

`instructions` and `checklistTemplateId` are added to the existing create/update
payloads of `routes/serviceDeliverables.ts` and `routes/deliverableTemplates.ts`,
and to `applyTemplateSet` (`services/deliverableTemplateService.ts:367`, which
already copies `description`, `cadence`, `leadDays`, `graceDays`,
`artifactRequired`, `completionMode`, `sortOrder` onto the new deliverable).

### 6.4 Sweep change

`openOneOccurrence` (`services/serviceDeliverableService.ts` ~line 822) already
re-selects `ownerUserId`, `ticketCategoryId`, `description` from the deliverable
after claiming the occurrence. It additionally selects `instructions` and
`checklistTemplateId`, and after `createPlannedWorkTicket` returns
`{ kind: 'created' }`:

1. inserts the template's items as `ticket_checklist_items`
   (`source: 'deliverable'`, `source_template_item_id` stamped,
   `org_id = d.orgId` — the **deliverable's** org, never the template's);
2. posts the `instructions` snapshot as an internal system comment (§3.2).

Both happen **inside the same per-occurrence transaction** as the claim and the
ticket creation, so a failure rolls the claim back and the occurrence retries
tomorrow rather than being stranded `open` with a ticket and no checklist. When
`created.kind === 'service_management_off'` there is no ticket, so neither step
runs — the occurrence is fulfilled by hand, unchanged from today.

### 6.5 AI / MCP

**Read-only in v1.** The checklist (`done`, `total`, the ordered labels) is added to
the payload the existing ticket-reading AI tools return, and
`list_deliverable_templates` gains `checklistTemplateId` / `instructions`. A
partner-wide checklist-template listing joins `list_deliverable_templates` rather
than getting its own tool.

**No tick-off tool.** `done_by_user_id` is a human attestation that a step was
performed; an agent ticking a box it did not perform is a falsified record in a
compliance artifact. If tick-off is ever wanted, the right change is a
`done_by_kind ('user' | 'ai_agent')` discriminator plus `done_by_agent_id`, not
laundering an agent through a user id. Open Decision 7.

## 7. Web UI

- **`apps/web/src/components/tickets/TicketChecklistCard.tsx`** — progress header
  (`3 / 7`), tickable rows, inline add, up/down reorder, delete, and an "Apply
  template" picker. Hidden entirely when the list is empty and the ticket is not
  deliverable-linked, so support tickets gain no clutter.

  **Not in the right rail** (Codex finding 6). `TicketWorkbench.tsx:1498` is
  `className="w-64 shrink-0 … hidden lg:block"`, so the rail disappears below the
  `lg` breakpoint — a technician on a tablet or a half-width desktop window would
  lose the checklist with no affordance telling them it exists. Time entries and
  parts survive that because they are reference data; a checklist is the thing the
  technician is *working from*. It goes in the ticket's **main column**, under the
  description and above the comment feed, at every breakpoint.
- **`OccurrenceDrawer.tsx`** lists up to 24 occurrences
  (`OccurrenceDrawer.tsx:96`, `:219`), not one — mounting 24 self-fetching checklist
  cards would be 24 requests on drawer open. Instead: the occurrence list route
  returns a per-occurrence `{ done, total }` summary in its existing payload
  (one grouped count, no extra round trip) rendered as a chip, and expanding a single
  row lazily loads that occurrence's checklist into the shared component in
  `compact` mode (tick + read; add/reorder stay on the ticket).
- **Instructions panel** — a collapsed "Internal instructions" block on the ticket
  detail, fed from the snapshot comment, labelled *Internal — never shown to the
  customer*. The same label sits under the `instructions` textarea on
  `DeliverableForm.tsx` and the deliverable-template item form.
- **Settings → Ticket checklist templates** — list + editor with a create-only
  `ownerScope` selector and an "All orgs" badge on partner-wide rows (pattern:
  `apps/web/src/components/software/PolicyForm.tsx`). The selector is hidden for a
  user who fails `canManagePartnerWidePolicies`.
- Every mutation goes through `runAction` / `runClientAction`
  (`apps/web/src/lib/runAction.ts`); no entry is added to
  `runActionAllowlist.ts`. `data-testid` on every interactive element.
- New i18n keys with **real** translations in every locale, not English fallbacks.

**Mobile app: out of scope.** Nothing here is trivial to port — the mobile ticket
view has no rail and no drawer.

## 8. Out of scope

- Any portal exposure of steps, instructions or progress (§5).
- Auto-resolve or auto-deliver on completion (§3.4) — permanently rejected, not
  deferred.
- A blocking `checklist_required` guard — deferred, Open Decision 4.
- AI tick-off (§6.5) — deferred, Open Decision 7.
- Mobile app.
- Per-step assignee, due date, time tracking or dependencies. A checklist is a
  checklist; anything with its own owner and date is a ticket, and parent spec D14
  ("occurrences stay flat: no dependencies, phases or estimates") applies here too.
- Nested / hierarchical checklists.
- Checklist templates on `playbook_definitions` or automations.
- Backfilling checklists onto occurrences that are already `open`. Existing tickets
  keep their prose; the next occurrence gets the checklist.
- A `n / m` badge in the ticket **list** — deferred until someone asks and the
  lateral count is measured.

## 9. Test and rollout notes

Unit (Vitest + Drizzle mocks):

- Seeding: template items → `ticket_checklist_items` in `sort_order`, `source` and
  `source_template_item_id` stamped, `org_id` = the deliverable's org even for a
  partner-wide template.
- `done: false` clears **both** `done_at` and `done_by_user_id`.
- Reorder: whole-list rewrite; mismatched id set → 400.
- `apply-template` `replace_unticked` keeps ticked rows and drops only unticked.
- `applyTemplateSet` copies `instructions` and `checklistTemplateId`.
- Owner-axis validation: a partner-wide deliverable template item may not reference
  an org-owned checklist template; `applyTemplateSet` from org A to org B refuses an
  org-A-private checklist reference (409 `CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG`).
- Ticking is idempotent and first-writer-wins; a label edit on a done item clears
  `done_at` and `done_by_user_id`.
- Deleting a referenced checklist template → 409 `CHECKLIST_TEMPLATE_IN_USE`.
- Sweep-created rows carry `created_by IS NULL` (the nil-UUID actor is not a users
  row) and `source = 'deliverable'`.
- A ticketless occurrence (Service Management `off`) gets no checklist and no
  instructions comment, and does not throw.

Route tests: every new route, including 404-not-403 for a cross-tenant `templateId`
and for a soft-deleted ticket, and 403 `CHECKLIST_TICK_REQUIRES_USER` when an
API-key principal tries to tick.

Integration (real Postgres — these are the ones that actually hold the contract):

- `ticketChecklistRls.integration.test.ts` — cross-org forge → 42501; a checklist
  item cannot be inserted against another org's ticket.
- `ticketChecklistTemplatesPartnerRls.integration.test.ts` — cross-partner forge
  → 42501; XOR violation → 23514; org isolation; and the partner-wide SELECT branch
  **is visible to an org-scoped context** (the branch is load-bearing: without it an
  org token is silently blind to partner-wide templates, with no error).
- `ticketChecklistOrgMove.integration.test.ts` — a ticket move **and** a device move
  both re-stamp `ticket_checklist_items.org_id`, and the deferred
  `ticket_checklist_items_ticket_org_fk` does not 23503 mid-transaction.
- `ticketChecklistPortalNonDisclosure.integration.test.ts` — `GET /portal/service`,
  `GET /portal/service/:id/occurrences` and portal ticket detail expose no step
  text, instructions or progress; and resolving a deliverable ticket writes only the
  technician's typed note into `delivery_note`.
- Standing suites, all of which must be run locally before the PR because the
  registration lists only fail here: `rls-coverage`, `tenantCascade`,
  `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgLifecycleFoundations`
  (the deferrable-FK merge contract).

**New completeness guard (required, W01).** `ticketOrgMoveLockOrder.test.ts` gains a
schema-derived assertion: every Drizzle table carrying **both** `ticket_id` and
`org_id` is either in `TICKET_ORG_DENORMALIZED_TABLES` or in a small documented
exemption set (`invoice_lines`, `ticket_comments`, and the tombstoned
`ticket_drafts` / `action_intents`, each with the reason already written in that
file). It reads the schema statically, so it fails in the **Test API** unit job —
moving list 5 from "runtime 500 on an admin action" into CI, which is the whole
lesson of the cascade-list history (contract tests 5/5, code review 0/5).

Web: component tests for `TicketChecklistCard` (tick, add, reorder, apply
template, empty state), the settings page, `no-silent-mutations`, and locale
coverage.

Rollout: no feature flag. Every wave is additive; an empty checklist renders
nothing. W01 alone is useful on its own (ad-hoc steps on any ticket), which is the
reason for the split below.

| Wave | Content | Depends on |
|---|---|---|
| **W01** | `ticket_checklist_items` migration + schema + registration lists 1–5 + the completeness guard + REST §6.1 (minus `apply-template`) + `TicketChecklistCard` in the ticket rail | — |
| **W02** | `ticket_checklist_templates` / `_template_items` migration + dual-axis RLS + partner-wide SELECT branch + registrations + REST §6.2 + `apply-template` + settings page | W01 |
| **W03** | The four deliverable columns + export-policy column additions + sweep seeding + instructions snapshot comment + `applyTemplateSet` + `DeliverableForm` / template-item form + `OccurrenceDrawer` panel + AI read-only exposure + the portal no-leak assertion | W01, W02 |

## 10. Open Decisions

> **Gate A resolution — 2026-09-14 (Todd: "as recommended").** Every decision below
> is approved as recommended. The one genuine split, **OD-3, is settled as A (live
> `checklist_template_id`, delete of an in-use template refused with 409
> `CHECKLIST_TEMPLATE_IN_USE`)**; Codex's snapshot position (B) is retained below
> for the record. Upstream constraints restated: instructions are internal-only,
> the portal shows nothing (§5); onboarding stays a `one_time` deliverable set.
> Status: `spec-approved` → Stage 3 (plan).


Numbered for Todd. Each carries a recommendation; Codex's position is recorded
where it differed.

**1. Checklist storage — own table or jsonb on `tickets`?**
- **A — `ticket_checklist_items` table**: pro — survives the tenant export (a jsonb
  column is forced to `excludedOpen`, so a jsonb checklist would silently vanish
  from a customer's GDPR export); per-row ticking has no lost-update window; can FK
  `done_by_user_id` to `users`; reusable by Projects via `tickets.work_kind`. Con —
  three registration lists it would otherwise skip, and a join on read.
- **B — jsonb column on `tickets`**: pro — no migration beyond one column, no
  cascade/merge/move-org registration. Con — everything in A's pro column, plus
  read-modify-write of the whole array to tick one box.

**Recommend A** — the export-policy rule alone settles it: `excludedOpen` would make
the checklist unexportable by contract, not by oversight.

**2. Seeding shape — parsed markdown, or structured steps?**
- **A — separate `instructions` prose + structured template items**: pro — editing a
  sentence can never change the steps; per-step `detail` and stable step identity
  come free; no parser to get wrong. Con — two fields to author.
- **B — one markdown field, split one step per line**: pro — one field, zero new
  tables for the source. Con — the checklist becomes a function of prose formatting;
  a wrapped bullet becomes two steps; the retrofit to structure later is a migration
  + backfill + code sweep.

**Recommend A**, and explicitly reject parsing.

**3. Reusable checklist templates — and does the deliverable hold a live pointer or
a frozen snapshot? ⚠️ Codex disagreed here.**

Both of us want the template tables in v1, `org_id XOR partner_id`. The split is on
what `service_deliverables` stores.

- **A — live pointer** (`checklist_template_id`, Fable): pro — the MSP improves the
  runbook once and every customer's *next* occurrence gets the better procedure,
  which is the point of a shared library; delivery *history* is already frozen one
  level down, because an opened occurrence's `ticket_checklist_items` are real rows
  that no later template edit can touch. Con — a template edit silently changes
  future work with no re-apply step, and a template delete would empty future
  checklists (closed by the 409 `CHECKLIST_TEMPLATE_IN_USE` guard added in §4.4).
- **B — snapshot at apply** (copy the ordered steps onto the deliverable, e.g.
  `checklist_steps text[]`, or immutable template revisions — **Codex's position**):
  pro — matches parent spec D9 verbatim, "Copy-on-apply keeps a customer's schedule
  stable when the template later changes"; a *snapshot* array never needs
  deprecating, and Codex is right that `text[]` does not inherit jsonb's
  `excludedOpen` rule (`tickets.tags` is plain `included`,
  `tenantExportPolicyRegistry.ts:598`), which retires my original objection to
  arrays. Con — improving a shared runbook then requires re-applying to every
  customer one at a time, which for a 40-org MSP means the library decays; and the
  snapshot loses per-step `detail` unless it becomes a fourth table.

**Recommend A, and this is a genuine split, not a resolved one.** My tie-break:
D9's copy-on-apply protects the deliverable's *contractual terms* — cadence,
`artifact_required`, grace — because those are what the customer bought and a
silent change is a contract change. Internal procedure is not sold and is not
visible to the customer at all (§5), so the same argument does not carry over; and
the history-stability D9 wants is already delivered by the ticket-level copy.
Codex's deletion hazard was real and is now guarded. **Todd should overrule to B if
he wants a deliverable's procedure to be contractually frozen at sale time rather
than centrally improvable.**

**4. Completion semantics — informational, or an actuator?**
- **A — informational only** (+ a soft UI confirm on resolve-with-unticked): pro —
  parent D4 already established closure ≠ delivery because closure requires no
  artifact; a checkbox is weaker evidence still, and auto-resolve would push an
  occurrence to `awaiting_evidence` off a tick. Con — a technician can resolve with
  work unticked.
- **B — all-ticked auto-resolves the ticket / delivers the occurrence**: pro — one
  fewer click. Con — reintroduces exactly the softness D4 removed; a mis-tick
  becomes a state change on a compliance record.
- **C — blocking guard** (`checklist_required`; resolve refused with 409
  `CHECKLIST_INCOMPLETE`): pro — enforces the procedure without inventing evidence.
  Con — a behaviour change on the shared `changeTicketStatus` path; needs its own
  column, UI and override story.

**Recommend A for v1, C as the sanctioned follow-up, B permanently rejected.**

**5. Portal — hidden, or "n of m" progress?**
- **A — hidden entirely**: pro — parent D10 says the portal shows the delivery
  record, never the ticket; the denominator leaks an internal work decomposition;
  portal flags fail closed and adding a surface later is additive. Con — no
  in-progress transparency between "open" and "delivered".
- **B — "n of m steps complete", no step text**: pro — a live trust signal for the
  customer between occurrences. Con — a stalled counter is a liability; the
  denominator is internal information; it is irreversible once customers see it.

**Recommend A.**

**6. Where tick-off lives — ticket detail, occurrence drawer, or both?**
- **A — both, one shared component** (`TicketChecklistCard`, `compact` mode in the
  drawer): pro — the drawer is where the deliverable owner works and the ticket is
  where the technician works; one component, one set of tests. Con — two mount
  points to keep in sync.
- **B — ticket detail only**: pro — smallest surface. Con — the occurrence drawer
  is the deliverable feature's own UI; sending its owner to the ticket to see
  progress defeats the drawer.

**Recommend A**, with Codex's two placement corrections adopted (main column, not
the `hidden lg:block` rail; a progress chip per occurrence with one lazy expansion,
not 24 mounted cards). Mobile stays out either way.

**7. AI / MCP — read, tick, or nothing, in v1?**
- **A — read-only in v1**: pro — "summarise where this ticket stands" is the highest
  value and carries no attestation risk; near-zero cost on the existing tools. Con —
  an agent cannot close out steps it genuinely performed.
- **B — read + tick in v1**: pro — an agent that ran a check could record it. Con —
  `done_by_user_id` is a human attestation; ticking without a
  `done_by_kind` discriminator falsifies a compliance record.
- **C — nothing in v1**: pro — smallest surface. Con — leaves the AI ticket summary
  blind to half the ticket's state.

**Recommend A.** Codex agreed on read-only and corrected the enforcement: omitting
the tool is *not* what makes ticking human-only, because an MCP API key already
carries its creator's real user id (`middleware/auth.ts:30`, `:58`). The
`isInteractiveUserSession` gate in §6.1 is the actual control. Any future B needs
`done_by_kind ('user' | 'ai_agent')` **plus** agent/run ids — the auth principal
already models both (`middleware/auth.ts:54`), so the future shape is available, not
invented.

**8. Migration slots.**
Newest committed on `origin/main` is `2026-10-16-181500-portal-lifecycle-flag.sql`.
Proposed: `2026-10-16-190000-ticket-checklist-items.sql` (W01),
`2026-10-16-190100-ticket-checklist-templates.sql` (W02),
`2026-10-16-190200-deliverable-checklist-wiring.sql` (W03). Re-verify against
`origin/main` at push time — the pre-push guard compares against the remote, and
the repo's filename dates run ahead of real time, so "today's date" does not sort
last.

**Recommend as proposed.**

## 11. Quorum record (2026-09-14)

Fable position formed first from the repo; Codex `gpt-6-astra`, `xhigh`, read-only,
given the issue text, the eight draft decisions and the file list. Thirteen numbered
findings. Every claim below was re-read against the repo before adoption (Codex
misreads happen; none did here — all eight file:line citations checked out).

| # | Codex finding | Verified | Resolution |
|---|---|---|---|
| 1 | D1 **agree**; rows alone do not settle concurrent toggles — specify idempotent set-complete, preserve the original completer, define whether a label edit clears the attestation, and let the `users` FK `SET NULL` without clearing `done_at` | Yes | **Adopted** — §4.1 "Attestation rules". First-writer-wins, label edit clears the tick, `done_at` is the authority and survives a user delete (which is also why there is no `CHECK` tying the two columns). |
| 2 | D2 **agree**, but propagation is missing: `applyTemplateSet` copies an explicit field list (`deliverableTemplateService.ts:367`) and `openOneOccurrence` selects only description/owner/category (`serviceDeliverableService.ts:830`) | Yes | **Adopted** — §6.3 and §6.4 name both mappings explicitly; the instructions snapshot comment (§3.2) is the "ticket-owned display path" Codex asked for. |
| 3 | D3 **disagree**: a mutable pointer contradicts parent D9's copy-on-apply; snapshot the steps or use immutable revisions. `text[]` does **not** inherit jsonb's `excludedOpen` (`tickets.tags` is `included`, `tenantExportPolicyRegistry.ts:598`) | Yes on both facts | **Unresolved — recorded as Open Decision 3 with both positions.** The array fact retires my original objection to `text[]`; I still recommend the pointer because D9 protects *contractual terms*, not internal procedure, and the ticket-level copy already freezes history. Codex's deletion hazard was real → 409 `CHECKLIST_TEMPLATE_IN_USE` guard added (§4.4). Todd decides. |
| 4 | D4 **agree** for v1; cover `closed` as well as `resolved` (`serviceDeliverableService.ts:685`, `:715`); a UI confirm is bypassable via API/AI/bulk; and the permanent ban on actuators is a *new product policy*, not something D4 establishes | Yes | **Adopted** — §3.4 rewritten on all three points. |
| 5 | D5 **agree**, and the missed leak is narrative: `resolutionNote` → `deliveryNote` → published by the portal (`serviceDeliverableService.ts:733`, `serviceReadModel.ts:466`). Also cover ordinary portal *support-ticket* detail | Yes — verified `patch.deliveryNote = args.resolutionNote` at :737 and `note: row.deliveryNote` at `serviceReadModel.ts:466`/`:337` | **Adopted** — §5 now bans auto-appending any checklist text to a resolution or delivery note, and extends the no-leak assertion to `routes/portal/tickets.ts`. This is the finding most likely to have shipped a real leak. |
| 6 | D6 **disagree on placement**: the rail is `hidden lg:block` (`TicketWorkbench.tsx:1498`), excluding tablets and narrow desktop; and `OccurrenceDrawer` renders up to 24 occurrences (`:96`, `:219`), so 24 self-fetching cards is wrong | Yes | **Adopted** — §7 moves the card to the ticket's main column and replaces per-occurrence cards with a counted chip plus one lazy expansion. |
| 7 | D7 **agree** on read-only, but the enforcement is incomplete: an MCP API key carries its creator's real user id (`middleware/auth.ts:30`, `:58`), so omitting the tool does not make the REST mutation human-only. Gate on `isInteractiveUserSession` (`:66`) | Yes — helper exists at `middleware/auth.ts:66` | **Adopted** — §6.1 gates the `done` branch, 403 `CHECKLIST_TICK_REQUIRES_USER`. Corrects a real hole in my draft. |
| 8 | D8 **agree**; add template-reference FKs only after their targets exist | Yes | **Adopted** — W03 (the FK columns) follows W02 (the tables) in the wave table. |
| 9 | (a) Seed inside the existing occurrence transaction; the sweep actor's nil UUID is **not a valid `users` FK**; Service Management `off` legitimately yields ticketless occurrences; ticket soft-delete must keep rows but deny access; `contracts:*` must not imply ticket access | Yes — `DELIVERABLE_SWEEP_ACTOR.userId` is `'00000000-…'` | **Adopted** — `created_by` NULL for sweep rows (§4.1), transaction rule (§6.4), soft-delete and permission rules (§6.1). |
| 10 | (a) The new composite FK breaks both org-move paths unless named in **both** `SET CONSTRAINTS … DEFERRED` lists and added to `TICKET_ORG_DENORMALIZED_TABLES`, the shared lock order, and the device mover's custom rewrite list *and its SQL* | Yes — independently found by Fable before the quorum | **Agreement.** §4.5 list 5, including the point that `DEFERRABLE` alone is insufficient because both movers name constraints individually. |
| 11 | (b) Insertion order matches; but the literal list is alphabetical while the **actual delete order comes from the FK graph** (`tenantCascade.ts:214`); and **do not copy `repoint-dedupe`** from `deliverable_template_sets` — its justification depends on there being no live reference, and a checklist template *is* live-referenced | Yes | **Adopted** — both corrections in §4.5; the merge entry became `custom` rename-on-collision. A copy-the-neighbour mistake caught before it shipped. |
| 12 | (c) Applying a template is read-source + write-target, **not** partner-wide administration; derive the copied `org_id` from the destination, never the template's nullable owner; and `applyTemplateSet` already allows org-A → org-B, so persisting A's private checklist reference is a new cross-org dependency | Yes — `loadSetOr404(setId, actor)` + `requireOrgAccess(actor, orgId)` are independent | **Adopted** — §6.2 exempts apply from `canManagePartnerWidePolicies`; §4.4 adds 409 `CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG`. |
| 13 | (d) Wave split | — | Codex's W01/W02/W03 split is the same as the draft's; its "settle snapshot/revision/delete semantics in W02" is folded into Open Decision 3 and the §4.4 delete guard. |

Net: Codex agreed with D1, D2, D4, D5, D7, D8; disagreed with **D3** (unresolved,
surfaced to Todd) and with **D6's placement** (adopted). It independently confirmed
the org-move finding (10) and caught three defects the draft would have shipped —
the `deliveryNote` leak (5), the `isInteractiveUserSession` hole (7) and the wrong
merge kind (11).

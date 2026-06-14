# Ticketing Configuration — Custom Statuses, Priority SLA Defaults, Org Overrides (Design)

Date: 2026-06-12
Status: Approved pending Todd's spec review (decisions made interactively 2026-06-12)
Parent spec: `2026-06-09-native-ticketing-design.md` (§8a extensibility constraints apply verbatim)
Prior phases: Phase 1 core+UI, Phase 2 SLA engine (#1250), Phase 3 time tracking+parts (#1276/#1285)

## 1. Scope & Decisions

Partner-configurable ticketing: custom status names mapped to core states, renameable priorities with configurable SLA defaults, per-org SLA tiers and billing defaults, and consolidation of all ticket configuration on one Partner-admin settings surface.

- **D1 — Custom statuses are mapped, not free-form.** Partners define named statuses (e.g. "Waiting on vendor"); each maps to exactly one of the six core states (`new/open/pending/on_hold/resolved/closed`). All logic — SLA pause, transitions, triage, filters, stats, automations, AI tools — continues to key off the core state. The custom name is display.
- **D2 — No separate "type" concept.** Categories are the classification axis; nothing new.
- **D3 — Priorities stay the fixed four.** `low/normal/high/urgent` keep their enum values, sort weights, and colors. Partners can rename the labels and set per-priority response/resolution SLA defaults (closes the deferred "configurable priority SLA defaults" item from #1250).
- **D4 — Settings home.** `/settings/ticketing` becomes a tabbed page (Statuses, Priorities, Categories, Export); its entry in the settings index moves into the Partner setup/admin grouping. Existing category manager and billables export card move into tabs unchanged.
- **D5 — Org overrides ship in this phase.** One `org_ticket_settings` row per org: per-priority SLA minute overrides + `default_hourly_rate` + `default_billable`. UI is a "Ticketing" tab on the existing org settings page (sibling of the Customer Portal tab from #1251).
- **D6 — Rate default chain: org wins.** Time-entry rate/billable defaulting becomes: per-entry override → **org default** → category default → null. The customer's contracted rate is a contract term; category rates are the generic fallback.
- **D7 — SLA stamping chain:** ticket explicit override → category SLA → **org per-priority override** → partner per-priority setting → hardcoded `PRIORITY_SLA_DEFAULTS`. Category stays above org (a deliberately configured per-work-type SLA beats the customer's generic tier), consistent with #1250's category-first chain. *Flagged alternative:* PSA tools often put the customer agreement above work type; flipping org above category later is a one-line change in `resolveSlaTargets` and is explicitly allowed by this design. Reviewer call-out: confirm ordering at spec review.
- **D8 — Delivery: two-PR chain** (backend, then frontend), mirroring Phases 1/3.

## 2. Data Model

One migration `2026-06-13-<x>-ticketing-configuration.sql` (idempotent; RLS enabled+forced+policies in the same migration; no inner BEGIN/COMMIT; seeded backfills report row counts via `RAISE WARNING`). Schema additions in `apps/api/src/db/schema/tickets.ts` (or a new `ticketConfig.ts` if tickets.ts is crowded).

### `ticket_statuses` — Shape 3 (partner-axis)

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| partner_id | uuid NOT NULL → partners | RLS: `breeze_has_partner_access(partner_id)` |
| name | varchar(60) NOT NULL | unique per partner (case-insensitive unique index on `(partner_id, lower(name))`) |
| core_status | `ticket_status` enum NOT NULL | the mapping target |
| color | varchar(7) NULL | hex; null = inherit core-state color |
| sort_order | integer NOT NULL default 0 | within pickers |
| is_system | boolean NOT NULL default false | the six seeded rows; renameable/recolorable but cannot be deactivated, deleted, or re-mapped |
| is_active | boolean NOT NULL default true | deactivation hides from pickers; **no hard delete in v1** (tickets reference rows historically) |
| created_at / updated_at | timestamptz | |

- **Seeding:** six `is_system` rows per partner (one per core state, name = current `statusConfig` labels). Backfill migration creates them for existing partners; partner-registration flow seeds them for new partners (service-level, not trigger).
- **Invariant (service-enforced):** at least one active status per core state per partner. `is_system` rows satisfy this trivially since they can't be deactivated.
- Allowlist: `PARTNER_TENANT_TABLES` in `rls-coverage.integration.test.ts`, same PR, **plus a functional `breeze_app` cross-partner insert/select test** (the [[rls-dual-axis-contract-test-blindspot]] lesson: the contract test alone doesn't prove the policy works for the rows routes actually write).

### `ticket_priority_settings` — Shape 3 (partner-axis)

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| partner_id | uuid NOT NULL → partners | |
| priority | `ticket_priority` enum NOT NULL | unique `(partner_id, priority)` |
| label | varchar(40) NULL | null = default label |
| response_sla_minutes / resolution_sla_minutes | integer NULL | null = fall through to hardcoded defaults |
| created_at / updated_at | timestamptz | |

Rows are created lazily on first save (no seed needed — absence means "all defaults").

### `org_ticket_settings` — Shape 1 (direct org_id, auto-discovered RLS)

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| org_id | uuid NOT NULL UNIQUE → organizations | one row per org, upsert semantics (mirrors portal_branding) |
| sla_overrides | jsonb NOT NULL default '{}' | `{ "<priority>": { "responseMinutes": n\|null, "resolutionMinutes": n\|null } }` — validated by shared Zod schema, never free-form |
| default_hourly_rate | numeric(10,2) NULL | D6 chain |
| default_billable | boolean NULL | null = no opinion (fall through) |
| created_at / updated_at | timestamptz | |

jsonb (not four columns) because the override matrix is sparse and per-priority; the Zod schema is the contract. Partner-side reads resolve org rows through normal org access (`breeze_has_org_access`).

### `tickets.status_id`

- `ADD COLUMN status_id uuid NULL REFERENCES ticket_statuses(id) ON DELETE SET NULL` + index.
- Backfill: set to the partner's `is_system` row matching `tickets.status` (count-reporting UPDATE). NULL-`partner_id` legacy tickets stay NULL.
- **`tickets.status` (core enum) remains the source of truth for ALL logic.** `status_id` is display/selection state. The two are stamped together in `changeTicketStatus`; drift is impossible through the service layer, and a NULL/missing `status_id` degrades to core-state display.

## 3. Service Layer

New `apps/api/src/services/ticketConfigService.ts` (routes/AI tools/web are equal consumers, §8a):

- `getTicketConfig(partnerId)` → `{ statuses: [...], priorities: { low: {label, responseSlaMinutes, resolutionSlaMinutes}, ... } }` — single read for pickers/decoration. Per-request; no cross-request cache in v1 (config reads are cheap; revisit if hot).
- `createTicketStatus / updateTicketStatus / setStatusActive / reorderStatuses` — enforce: same-partner, name uniqueness, `is_system` protections (no deactivate/re-map), ≥1 active status per core state.
- `upsertPrioritySettings(partnerId, rows)` — lazy rows, validates minutes ≥ 0.
- `getOrgTicketSettings(orgId)` / `upsertOrgTicketSettings(orgId, input)` — portal_branding upsert pattern.

Changes to existing services:

- **`ticketService.changeTicketStatus`**: accepts `statusId` (preferred) or legacy `status` core value (maps to the partner's `is_system` row). Resolves `core_status`, validates the transition against the existing `TICKET_STATUS_TRANSITIONS` on core states, stamps both columns, writes the feed comment with the custom name (`oldValue/newValue` keep CORE values — feed history and event payloads stay schema-stable; the custom name goes in `content`). `TicketEvent` payloads unchanged (core states), additive `statusName` field allowed.
- **`ticketSla.resolveSlaTargets`** (stamping at create, per #1250): chain per D7. Org overrides read via the ticket's `org_id`; system DB context for the config reads (org-scope RLS hides partner rows — #1243 lesson).
- **`timeEntryService`** defaulting (create + startTimer): chain per D6 — entry input → `org_ticket_settings.default_hourly_rate/default_billable` → category defaults → null/false. The org row is read in the same `resolveTicketLink` pass.
- **Validation reads in system DB context** wherever org-scoped requests must see partner config (#1243).

## 4. Routes & Validators

`apps/api/src/routes/ticketConfig.ts` mounted at `/ticket-config` (auth at hub; partner+system scope):

| Route | Perm | Notes |
|---|---|---|
| `GET /ticket-config` | `tickets:read` | statuses + priorities, the one call web makes |
| `POST /ticket-config/statuses` | `tickets:write` + partner-admin proxy (`hasPermission(perms,'*','*')`, the Phase 3 D5 pattern) | |
| `PATCH /ticket-config/statuses/:id` / `POST /statuses/reorder` | same | reorder = bulk sortOrder=index (#1251 pattern) |
| `PUT /ticket-config/priorities` | same | full upsert of the four rows |
| `GET/PATCH /orgs/organizations/:id/ticket-settings` | org-write + MFA + audit (portal-settings pattern from #1251) | strict shared validator |

Shared validators in `packages/shared/src/validators/ticketConfig.ts`: `ticketStatusSchema` (name 1-60, hex color, core_status enum), `prioritySettingsSchema`, `orgTicketSettingsSchema` (sla_overrides shape, minutes int ≥ 0 ≤ 525600, rate ≥ 0 multipleOf 0.01). Tests alongside.

**Decoration:** ticket list/detail/portal responses gain `statusName` + `statusColor` (join through `status_id`, fallback to core label). Additive, Phase 1b pattern.

**AI tools:** `manage_tickets` status inputs keep accepting core values; additionally accept a custom status name (resolved per-partner, ambiguous → error listing options). Registered schemas stay enum-of-core + free-text `statusName` param — no dynamic schema generation in v1.

## 5. Frontend (PR 2)

- **`/settings/ticketing`** → tabbed page (hash-based tab state per project convention): **Statuses** (list grouped by core state, add/rename/recolor/reorder arrows/deactivate toggle; `is_system` rows show a lock on deactivate/re-map), **Priorities** (four rows: label input + response/resolution minutes), **Categories** (existing `TicketCategoriesPage` content as a tab), **Export** (existing `BillablesExportCard`). All mutations through `runAction`; enroll new files in `no-silent-mutations`.
- **Settings index nav:** move the Ticketing card into the Partner setup/admin grouping.
- **Org settings page:** new "Ticketing" tab — per-priority SLA override grid (placeholder shows the effective partner default) + default hourly rate + default billable. Portal-settings tab is the pattern to mirror.
- **Ticket UI:** workbench status select lists active custom statuses grouped by core state (resolve/pending forms keyed off the target's core state, unchanged); queue chips/feed show `statusName`/`statusColor` with `statusConfig` as fallback; priority selects/chips show custom labels via the fetched config. `ticketConfig.ts` static records stay as fallbacks — they are not removed.
- Config fetched once per island via `GET /ticket-config` (module-level promise cache is fine for an MPA page load).
- **Portal:** displays `statusName` (decorated server-side); portal logic untouched.

## 6. Testing

Per breeze-testing checklist: route tests alongside files (Drizzle mocks — feed the config lookup selects); validator tests in shared; component tests for the three new settings surfaces + workbench select grouping. Real-driver integration tests: cross-partner `ticket_statuses` isolation as `breeze_app` (forged insert fails), rls-coverage allowlist entries, seeded-backfill idempotency, `changeTicketStatus` by statusId stamps both columns + rejects cross-partner statusId, SLA chain resolution order (org override beats partner setting; category beats org), time-entry org-rate defaulting beats category. Contract tests for any `TicketEvent` additions.

## 7. Explicitly Out of Scope (v1)

Free-form statuses with behavior flags; custom priority lists; per-status automation hooks; business-hours SLA calendars; escalation policies; org×category rate matrices; time-rounding rules; hard-deleting statuses; per-status portal visibility. All extend from this model without core-table changes (§8a).

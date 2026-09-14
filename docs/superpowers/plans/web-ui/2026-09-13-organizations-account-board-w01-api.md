---
tracking_issue: LanternOps/breeze#5721
---
# Organizations Account Board W01: `GET /orgs/account-readiness` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the bulk read behind the Organizations account board — one request that computes every W02 Setup, Account-data and Open-tickets signal for up to 200 of a partner's organizations, with explicit capability metadata, accepted-id resolution against organization rows, and measured query plans — so W02 (the web board) builds on fixed names and W03 (integrations) only adds fields.

**Architecture:** A new service `apps/api/src/services/orgAccountReadiness.ts` owns every query: `resolveAcceptedOrgs` turns the requested ids into the rows the caller may see, and `loadAccountReadiness` runs one grouped aggregate per domain (sites, devices, policy assignments, contacts, portal users, tickets, invoices) under `Promise.all` inside the request's own `withDbAccessContext` transaction. A thin sibling router `apps/api/src/routes/orgAccountReadiness.ts` validates the query string, pins the partner (token's for partner scope, `partnerId` query for system scope), derives `capabilities` from the caller's grants and the partner's service-management mode, and shapes the response. It is mounted under `/orgs` after `orgSummaryRoutes`, at `/orgs/account-readiness` — never under `/organizations/…`, which `orgRoutes`' `/organizations/:id` would capture. The "open" status vocabularies are lifted out of `routes/orgSummary.ts` into `services/openWorkStatuses.ts` so the record Overview and the board can never disagree.

**Tech Stack:** Hono, Drizzle ORM (raw `sql` aggregates with `FILTER`, `bool_or`, `max`), PostgreSQL under forced RLS (`breeze_app`), Vitest (route/service unit tests with a table-keyed Drizzle chain mock that compiles captured predicates through `PgDialect`; integration tests on real Postgres via `createIntegrationTestClient`), `psql` `EXPLAIN (ANALYZE, BUFFERS)` as `breeze_app` for the plan evidence.

**Spec:** `docs/superpowers/specs/web-ui/2026-09-13-organizations-account-board-design.md` (design approved 2026-09-13, Codex xhigh quorum applied). This plan is the **W01** row of its "Rollout / waves" table: the API only. Sections implemented here: "API: `GET /orgs/account-readiness`" (whole section), the Setup / Account data / Open tickets cell definitions (the API must compute exactly those inputs), "Applicability" only insofar as the API carries `type`, `status` and `serviceManagementMode` for the web to apply the rules, and "Testing" → API unit + API integration + `EXPLAIN ANALYZE` evidence. `integrations` and `connectors` are **W03** and are not computed here; the response type leaves them optional. Where this plan is more specific than the spec (function names, response ordering, dedupe, the contacts single-query shape, the mode read path) the plan wins — the list of resolved ambiguities is at the end of this document.

## Global Constraints

- **No new tables, columns, migrations or indexes in this wave.** Every signal is derived from existing rows (spec "Non-goals"). Therefore no `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`, RLS-allowlist or `orgMergeRegistry` registration is needed or permitted. If the plan evidence (Task 7) shows a table without an `org_id` index sequential-scanning, file a follow-up issue; do not add a migration here.
- **Every read runs under the request's `withDbAccessContext`** (opened by `authMiddleware`) as `breeze_app` under forced RLS. Never wrap any query in `withSystemDbAccessContext` or `runOutsideDbContext` (spec: "the code must not escape the request context"; #2417, #1105). `Promise.all` is orchestration only — the statements execute one after another on the transaction's single connection.
- **Route path is `/orgs/account-readiness`**, exported as `orgAccountReadinessRoutes` from `apps/api/src/routes/orgAccountReadiness.ts`, mounted in `apps/api/src/index.ts` with `api.route('/orgs', orgAccountReadinessRoutes)` immediately after `api.route('/orgs', orgSummaryRoutes)`. The composed path is proven with a router owning `/organizations/:id` mounted first (unit: a stand-in; integration: the real `orgRoutes`).
- **Scope `partner` or `system`; permission `PERMISSIONS.ORGS_READ`.** `orgIds` = comma-separated UUIDs, 1–200 (400 on missing, malformed, or more than 200). `partnerId` is **required for system scope** (400 `partnerId is required for system scope` — the wording `routes/orgs.ts` already uses) and **ignored for partner scope**, whose partner is the token's.
- **Accepted ids are resolved against organization rows before any aggregate:** `organizations.id IN (ids) AND partner_id = partner AND deleted_at IS NULL AND type <> 'quick_support'`, plus `id IN (auth.accessibleOrgIds)` for partner scope. Ids that do not survive are silently absent from `orgs` — never 403 — matching `auth.canAccessOrg` semantics. Every aggregate is keyed on the accepted list.
- **Capabilities, verbatim from the spec:** `sites` ← `sites:read`; `devices` ← `devices:read`; `policies` and `contacts` ← always `true` (the route is gated on `organizations:read`); `portalUsers` ← `users:read`; `invoices` ← `invoices:read AND service_management_mode = 'native'`; `tickets` ← `tickets:read AND service_management_mode = 'native'`; `integrations` ← `false` in W01. A section that is not computed is absent from the response and its query is never issued.
- **One grouped aggregate per independent domain** over `WHERE org_id IN (ids) GROUP BY org_id` (or `bool_or`/`EXISTS`-shaped), with only the parent join each domain needs (assignments → active policy). Never one giant join that multiplies counts. **No `audit_logs` read.**
- **Signal definitions (must match the spec's cell tables exactly):** devices and `lastSeenAt` over `status <> 'decommissioned'`; `policyAssigned` = an org-level assignment for the org **or** a partner-level assignment for the partner, joined to a `configuration_policies` row with `status = 'active'`; `primaryContact` = the `contacts` row with `is_primary AND site_id IS NULL`; `billingRoleContact` = any contact whose `roles @> '{billing}'`; `billingAddress` = `billing_address_line1`, `_city` and `_country` all non-null; `pendingInvitations` = `portal_users` with `status <> 'disabled' AND invited_at < now() - 7 days AND last_login_at IS NULL`; `tickets` = `status IN ('new','open','pending','on_hold') AND deleted_at IS NULL`, `awaitingCustomer` = `status = 'pending'`, `slaBreached` = `sla_breached_at IS NOT NULL` among those; `overdueInvoices` = `status IN ('sent','partially_paid','overdue') AND due_date < CURRENT_DATE`.
- **Reason codes, not sentences.** W01 carries no `reason` field yet; the response is enums, counts, ISO timestamps and nulls only. The only English strings the endpoint emits are `{ error }` bodies on 4xx.
- **Response shape** is the spec's `AccountReadinessResponse` exactly (`partnerId`, `capabilities`, `serviceManagementMode`, `orgs[].{orgId,type,status,setup,account,tickets?}`); `connectors` and `orgs[].integrations` are typed but never populated.
- **Measured, not promised** (spec): Task 7 seeds 200 orgs with fan-out and records `EXPLAIN (ANALYZE, BUFFERS)` for every aggregate as `breeze_app`; devices, invoices and tickets must show an index scan keyed on `org_id`.
- **Tests live beside their sources** (`routes/orgAccountReadiness.test.ts`, `services/orgAccountReadiness.test.ts`, `services/openWorkStatuses.test.ts`); integration under `apps/api/src/__tests__/integration/orgAccountReadiness.integration.test.ts`. Run one unit file as `cd apps/api && npx vitest run <path>` (never `pnpm … test -- --run`). Integration: `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>` after `pnpm test-stack up` at the repo root; `pnpm test-stack down` when finished — nothing tears it down for you.
- **Typecheck:** `cd apps/api && npx tsc --noEmit` (there is no `typecheck` script in `apps/api/package.json`). Lint: `cd apps/api && npx eslint src/routes/orgAccountReadiness.ts src/services/orgAccountReadiness.ts src/services/openWorkStatuses.ts`.
- **Branch:** `feature/5721-organizations-account-board/wave-5722` (the numbers come from `register_feature`; `get_feature_status` first, then `start_wave`). PR body: `Closes #5722`. Commit trailers per the session's attribution reminder.
- **No web changes in this wave.** Nothing consumes the endpoint until W02.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/src/services/openWorkStatuses.ts` (+ `.test.ts`) | `TICKET_OPEN_STATUSES`, `INVOICE_OPEN_STATUSES`, `sqlStatusList()` — shared by orgSummary and the board |
| `apps/api/src/routes/orgSummary.ts` | import the vocabulary from the module above (behaviour-preserving refactor) |
| `apps/api/src/services/orgAccountReadiness.ts` (+ `.test.ts`) | `resolveAcceptedOrgs`, `loadAccountReadiness`, the signal types; every query |
| `apps/api/src/routes/orgAccountReadiness.ts` (+ `.test.ts`) | `GET /orgs/account-readiness`: validation, partner pinning, capabilities, shaping; response types |
| `apps/api/src/index.ts` | import + mount after `orgSummaryRoutes` |
| `apps/api/src/__tests__/integration/orgAccountReadiness.integration.test.ts` | real-Postgres signals, rules, access resolution, system scope, mode gate, composed app |

---

### Task 1: Shared open-status vocabulary

**Files:**
- Create: `apps/api/src/services/openWorkStatuses.ts`
- Create: `apps/api/src/services/openWorkStatuses.test.ts`
- Modify: `apps/api/src/routes/orgSummary.ts` (the `INVOICE_STATUSES` import at the top; the `TICKET_OPEN_STATUSES` / `INVOICE_OPEN_STATUSES` / `invoiceOpenStatusesSql` block after `requireOrgRead`; the `openStatusesSql` const inside the `TICKETS_READ` section)

**Interfaces:**
- Produces: `TICKET_OPEN_STATUSES: readonly ['new','open','pending','on_hold']`, `INVOICE_OPEN_STATUSES: readonly InvoiceStatus[]` (`['sent','partially_paid','overdue']`), `sqlStatusList(statuses: readonly string[]): SQL` — a `$1, $2, …` parameter list for use inside `IN (…)`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/openWorkStatuses.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { INVOICE_OPEN_STATUSES, TICKET_OPEN_STATUSES, sqlStatusList } from './openWorkStatuses';

describe('openWorkStatuses', () => {
  it('pins the open-ticket vocabulary (mirrors OPEN_STATUSES in routes/tickets/tickets.ts)', () => {
    expect([...TICKET_OPEN_STATUSES]).toEqual(['new', 'open', 'pending', 'on_hold']);
  });

  it('treats every non-draft, non-terminal invoice status as outstanding', () => {
    expect([...INVOICE_OPEN_STATUSES]).toEqual(['sent', 'partially_paid', 'overdue']);
  });

  it('renders a status list as bound parameters, never as literals', () => {
    const query = new PgDialect().sqlToQuery(sql`status in (${sqlStatusList(TICKET_OPEN_STATUSES)})`);
    expect(query.sql).toBe('status in ($1, $2, $3, $4)');
    expect(query.params).toEqual(['new', 'open', 'pending', 'on_hold']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/openWorkStatuses.test.ts`
Expected: FAIL — `Cannot find module './openWorkStatuses'`.

- [ ] **Step 3: Create the module**

`apps/api/src/services/openWorkStatuses.ts`:

```ts
/**
 * "Still open" status vocabularies shared by the org-scoped aggregates —
 * the record Overview (routes/orgSummary.ts) and the Organizations account
 * board (services/orgAccountReadiness.ts). One definition, so the two
 * surfaces can never disagree about what counts as an open ticket or an
 * outstanding invoice.
 */
import { sql, type SQL } from 'drizzle-orm';
import { INVOICE_STATUSES } from '@breeze/shared';

// Mirrors OPEN_STATUSES in routes/tickets/tickets.ts. Kept local — that
// constant scopes the ticketing queue routes, and importing that whole
// module here for one array would be a needless coupling.
export const TICKET_OPEN_STATUSES = ['new', 'open', 'pending', 'on_hold'] as const;

// Every invoice status the billing program still considers "outstanding" —
// i.e. everything except the two terminal states (paid, void) and the
// pre-issuance draft state.
export const INVOICE_OPEN_STATUSES = INVOICE_STATUSES.filter(
  (status) => status !== 'draft' && status !== 'paid' && status !== 'void',
);

/** `$1, $2, …` — a bound-parameter list for use inside `IN (…)`. */
export function sqlStatusList(statuses: readonly string[]): SQL {
  return sql.join(
    statuses.map((status) => sql`${status}`),
    sql`, `,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/openWorkStatuses.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Point orgSummary.ts at the module**

In `apps/api/src/routes/orgSummary.ts`, replace the import

```ts
import { INVOICE_STATUSES } from '@breeze/shared';
```

with

```ts
import { INVOICE_OPEN_STATUSES, TICKET_OPEN_STATUSES, sqlStatusList } from '../services/openWorkStatuses';
```

Replace the block that follows `const requireOrgRead = …` —

```ts
// Mirrors OPEN_STATUSES in routes/tickets/tickets.ts. Kept local — that
// constant scopes the ticketing queue routes, and importing that whole
// module here for one array would be a needless coupling.
const TICKET_OPEN_STATUSES = ['new', 'open', 'pending', 'on_hold'] as const;

// Every invoice status the billing program still considers "outstanding" —
// i.e. everything except the two terminal states (paid, void) and the
// pre-issuance draft state.
const INVOICE_OPEN_STATUSES = INVOICE_STATUSES.filter(
  (status) => status !== 'draft' && status !== 'paid' && status !== 'void',
);
const invoiceOpenStatusesSql = sql.join(
  INVOICE_OPEN_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);
```

— with

```ts
// Shared with services/orgAccountReadiness.ts so the record Overview and the
// Organizations board agree on what "open" means (services/openWorkStatuses.ts).
const invoiceOpenStatusesSql = sqlStatusList(INVOICE_OPEN_STATUSES);
```

Inside the `if (can(PERMISSIONS.TICKETS_READ)) {` section, replace

```ts
      const openStatusesSql = sql.join(
        TICKET_OPEN_STATUSES.map((status) => sql`${status}`),
        sql`, `,
      );
```

with

```ts
      const openStatusesSql = sqlStatusList(TICKET_OPEN_STATUSES);
```

Nothing else in the file changes; `sql` stays imported (every aggregate uses it).

- [ ] **Step 6: Prove the refactor is behaviour-preserving**

Run: `cd apps/api && npx vitest run src/routes/orgSummary.test.ts src/services/openWorkStatuses.test.ts && npx tsc --noEmit`
Expected: both files PASS (orgSummary: 10 tests), tsc clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/openWorkStatuses.ts apps/api/src/services/openWorkStatuses.test.ts apps/api/src/routes/orgSummary.ts
git commit -m "refactor(api): share the open ticket/invoice status vocabulary (#5721 W01)"
```

---

### Task 2: Service — accepted-id resolution

**Files:**
- Create: `apps/api/src/services/orgAccountReadiness.ts`
- Create: `apps/api/src/services/orgAccountReadiness.test.ts`

**Interfaces:**
- Consumes: `db` from `../db`; `organizations` from `../db/schema`.
- Produces:
  - `type OrgType = 'customer' | 'internal' | 'quick_support'`
  - `interface AcceptedOrg { id: string; type: OrgType; status: string; billingAddress: boolean }`
  - `interface ResolveAcceptedOrgsInput { orgIds: string[]; partnerId: string; accessibleOrgIds: string[] | null }`
  - `resolveAcceptedOrgs(input: ResolveAcceptedOrgsInput): Promise<AcceptedOrg[]>` — rows in **request order**; ids that do not resolve are absent.
  - Test helpers reused by Task 3 in the same test file: `setupDb(rowsByTable: Map<unknown, unknown[]>)`, `captured: CapturedQuery[]`, `callsFor(table): CapturedQuery[]`, `compiledWhere(table): { sql: string; params: unknown[] }`, `occurrences(haystack, needle): number`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/orgAccountReadiness.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

import { db } from '../db';
import {
  configPolicyAssignments,
  configurationPolicies,
  contacts,
  devices,
  invoices,
  organizations,
  portalUsers,
  sites,
  tickets,
} from '../db/schema';
import { loadAccountReadiness, resolveAcceptedOrgs } from './orgAccountReadiness';

const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '11111111-1111-4111-8111-222222222222';
const ORG_C = '11111111-1111-4111-8111-333333333333';

interface CapturedQuery {
  table: unknown;
  joins: Array<{ table: unknown; on: unknown }>;
  where?: unknown;
  groupBy?: unknown[];
}

/** Every `db.select().from(table)` chain the code under test built, in order. */
const captured: CapturedQuery[] = [];

/**
 * Table-keyed row stubs behind a thenable query-builder chain. The service
 * chains `.from().innerJoin()?.where().groupBy()` and then awaits the builder,
 * so the stub records each call and resolves to the rows registered for the
 * `.from()` table. Looking rows up by table (not by call order) keeps these
 * tests readable when a section is switched off and its query disappears.
 */
function setupDb(rowsByTable: Map<unknown, unknown[]>) {
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: (table: unknown) => {
          const call: CapturedQuery = { table, joins: [] };
          captured.push(call);
          const rows = rowsByTable.get(table) ?? [];
          const chain = {
            innerJoin(joined: unknown, on: unknown) {
              call.joins.push({ table: joined, on });
              return chain;
            },
            where(condition: unknown) {
              call.where = condition;
              return chain;
            },
            groupBy(...columns: unknown[]) {
              call.groupBy = columns;
              return chain;
            },
            then(resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) {
              return Promise.resolve(rows).then(resolve, reject);
            },
          };
          return chain;
        },
      }) as any,
  );
}

function callsFor(table: unknown): CapturedQuery[] {
  return captured.filter((call) => call.table === table);
}

/**
 * Compile a captured WHERE into the SQL text and parameters Postgres would
 * receive. A JSON dump of the Drizzle tree is not a substitute: column objects
 * embed their enum values (e.g. 'decommissioned'), so a substring check on the
 * dump can pass against unfixed code.
 */
function compiledWhere(table: unknown): { sql: string; params: unknown[] } {
  const call = callsFor(table)[0];
  if (!call?.where) throw new Error('no WHERE captured for that table');
  const query = new PgDialect().sqlToQuery(call.where as SQL);
  return { sql: query.sql, params: query.params as unknown[] };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('resolveAcceptedOrgs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.length = 0;
  });

  it('returns nothing, without a query, when a partner token has no accessible orgs', async () => {
    setupDb(new Map());
    const accepted = await resolveAcceptedOrgs({ orgIds: [ORG_A], partnerId: PARTNER_ID, accessibleOrgIds: [] });
    expect(accepted).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns nothing, without a query, for an empty id list', async () => {
    setupDb(new Map());
    const accepted = await resolveAcceptedOrgs({ orgIds: [], partnerId: PARTNER_ID, accessibleOrgIds: null });
    expect(accepted).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('system scope (null list) filters on the ids, the partner, liveness and type only', async () => {
    setupDb(new Map([[organizations, []]]));
    await resolveAcceptedOrgs({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, accessibleOrgIds: null });

    const where = compiledWhere(organizations);
    expect(occurrences(where.sql, '"organizations"."id" in (')).toBe(1);
    expect(where.sql).toContain('"organizations"."partner_id" = ');
    expect(where.sql).toContain('"organizations"."deleted_at" is null');
    expect(where.sql).toContain('"organizations"."type" <> ');
    expect(where.params).toEqual([ORG_A, ORG_B, PARTNER_ID, 'quick_support']);
  });

  it("partner scope also intersects with the token's accessible orgs", async () => {
    setupDb(new Map([[organizations, []]]));
    await resolveAcceptedOrgs({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, accessibleOrgIds: [ORG_A, ORG_C] });

    const where = compiledWhere(organizations);
    expect(occurrences(where.sql, '"organizations"."id" in (')).toBe(2);
    expect(where.params).toEqual([ORG_A, ORG_B, PARTNER_ID, 'quick_support', ORG_A, ORG_C]);
  });

  it('keeps request order, omits ids the query did not return, and derives billingAddress', async () => {
    setupDb(
      new Map([
        [
          organizations,
          [
            // Returned out of request order, and B is missing its city.
            { id: ORG_B, type: 'internal', status: 'trial', billingAddressLine1: '1 Main St', billingAddressCity: null, billingAddressCountry: 'US' },
            { id: ORG_A, type: 'customer', status: 'active', billingAddressLine1: '1 Main St', billingAddressCity: 'Springfield', billingAddressCountry: 'US' },
          ],
        ],
      ]),
    );
    const accepted = await resolveAcceptedOrgs({ orgIds: [ORG_A, ORG_C, ORG_B], partnerId: PARTNER_ID, accessibleOrgIds: null });
    expect(accepted).toEqual([
      { id: ORG_A, type: 'customer', status: 'active', billingAddress: true },
      { id: ORG_B, type: 'internal', status: 'trial', billingAddress: false },
    ]);
  });
});
```

(`loadAccountReadiness` is imported now so Task 3 only appends a `describe`; until Task 3 lands, the import resolves to the stub below.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/orgAccountReadiness.test.ts`
Expected: FAIL — `Cannot find module './orgAccountReadiness'`.

- [ ] **Step 3: Create the service with `resolveAcceptedOrgs` and a stub `loadAccountReadiness`**

`apps/api/src/services/orgAccountReadiness.ts`:

```ts
/**
 * Organizations account board — readiness signals (spec
 * docs/superpowers/specs/web-ui/2026-09-13-organizations-account-board-design.md,
 * "API: GET /orgs/account-readiness"). Feature #5721, W01.
 *
 * Owns every query behind the endpoint. The route
 * (routes/orgAccountReadiness.ts) validates, gates and shapes; nothing here
 * knows about permissions or HTTP.
 *
 * Tenancy: every read runs inside the request's `withDbAccessContext`
 * transaction (opened by authMiddleware) under forced RLS as breeze_app. `db`
 * is the request-bound proxy, so the `Promise.all` in loadAccountReadiness is
 * orchestration only — the statements execute one after another on the
 * transaction's single connection. Never wrap any of these in
 * `withSystemDbAccessContext` / `runOutsideDbContext` to "parallelise" them:
 * that double-holds a pooled connection under the request transaction and
 * bypasses RLS (#2417, #1105).
 */
import { and, eq, inArray, isNull, max, ne, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  configPolicyAssignments,
  configurationPolicies,
  contacts,
  devices,
  invoices,
  organizations,
  portalUsers,
  sites,
  tickets,
} from '../db/schema';
import { INVOICE_OPEN_STATUSES, TICKET_OPEN_STATUSES, sqlStatusList } from './openWorkStatuses';

export type OrgType = 'customer' | 'internal' | 'quick_support';

export interface AcceptedOrg {
  id: string;
  type: OrgType;
  status: string;
  /** billing_address_line1, _city and _country are all present. */
  billingAddress: boolean;
}

export interface ResolveAcceptedOrgsInput {
  /** Deduplicated, UUID-shaped ids from the query string, in request order. */
  orgIds: string[];
  partnerId: string;
  /** `null` = unrestricted (system scope). A partner token passes its own list. */
  accessibleOrgIds: string[] | null;
}

/**
 * The organizations the caller may see among the ids it asked for — resolved
 * against organization rows BEFORE any aggregate runs, so every later query is
 * keyed on ids that are live, this partner's, not the hidden quick_support org,
 * and (partner scope) inside the token's accessible list. Ids that do not
 * survive are simply absent: the endpoint never answers 403 for one of them,
 * matching `auth.canAccessOrg` semantics on GET /organizations/:id.
 */
export async function resolveAcceptedOrgs(input: ResolveAcceptedOrgsInput): Promise<AcceptedOrg[]> {
  if (input.orgIds.length === 0) return [];
  // A partner token with nothing accessible gets nothing — and no query. An
  // empty `inArray` would compile to `false` anyway; this keeps it explicit.
  if (input.accessibleOrgIds !== null && input.accessibleOrgIds.length === 0) return [];

  const rows = await db
    .select({
      id: organizations.id,
      type: organizations.type,
      status: organizations.status,
      billingAddressLine1: organizations.billingAddressLine1,
      billingAddressCity: organizations.billingAddressCity,
      billingAddressCountry: organizations.billingAddressCountry,
    })
    .from(organizations)
    .where(
      and(
        inArray(organizations.id, input.orgIds),
        eq(organizations.partnerId, input.partnerId),
        isNull(organizations.deletedAt),
        // Inside accessibleOrgIds by design (RLS lets a tech reach their own
        // support session) but never enumerated — same rule as GET /orgs.
        ne(organizations.type, 'quick_support'),
        input.accessibleOrgIds === null ? undefined : inArray(organizations.id, input.accessibleOrgIds),
      ),
    );

  const byId = new Map(rows.map((row) => [row.id, row]));
  const accepted: AcceptedOrg[] = [];
  for (const id of input.orgIds) {
    const row = byId.get(id);
    if (!row) continue;
    accepted.push({
      id: row.id,
      type: row.type,
      status: row.status,
      billingAddress: Boolean(row.billingAddressLine1 && row.billingAddressCity && row.billingAddressCountry),
    });
  }
  return accepted;
}

// ---------------------------------------------------------------------------
// Signals (filled in by Task 3)
// ---------------------------------------------------------------------------

export interface ReadinessSections {
  sites: boolean;
  devices: boolean;
  portalUsers: boolean;
  invoices: boolean;
  tickets: boolean;
}

export interface PrimaryContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
}

export interface TicketCounts {
  open: number;
  awaitingCustomer: number;
  slaBreached: number;
}

/** One org's computed signals. Optional fields are present iff their section was requested. */
export interface OrgReadinessSignals {
  sites?: number;
  devices?: number;
  /** ISO timestamp of the freshest check-in over the non-decommissioned population; null = never. */
  lastSeenAt?: string | null;
  policyAssigned: boolean;
  primaryContact: PrimaryContact | null;
  billingRoleContact: boolean;
  pendingInvitations?: number;
  overdueInvoices?: number;
  tickets?: TicketCounts;
}

export interface LoadAccountReadinessInput {
  /** Accepted ids only (from resolveAcceptedOrgs). */
  orgIds: string[];
  partnerId: string;
  sections: ReadinessSections;
}

export async function loadAccountReadiness(_input: LoadAccountReadinessInput): Promise<Map<string, OrgReadinessSignals>> {
  // Task 3 replaces this body. Referencing the imports keeps tsc/eslint quiet
  // until then; none of them is used by resolveAcceptedOrgs.
  void [configPolicyAssignments, configurationPolicies, contacts, devices, invoices, portalUsers, sites, tickets];
  void [max, or, sql, INVOICE_OPEN_STATUSES, TICKET_OPEN_STATUSES, sqlStatusList];
  return new Map();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/orgAccountReadiness.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/orgAccountReadiness.ts apps/api/src/services/orgAccountReadiness.test.ts
git commit -m "feat(api): account readiness — resolve accepted org ids against organization rows (#5721 W01)"
```

---

### Task 3: Service — the seven grouped aggregates

**Files:**
- Modify: `apps/api/src/services/orgAccountReadiness.ts` (replace the stub `loadAccountReadiness` and everything under the "Signals" banner; the types stay exactly as declared in Task 2)
- Modify: `apps/api/src/services/orgAccountReadiness.test.ts` (append a `describe('loadAccountReadiness')`)

**Interfaces:**
- Consumes: `setupDb`, `captured`, `callsFor`, `compiledWhere` from the test file (Task 2); `sqlStatusList`, `TICKET_OPEN_STATUSES`, `INVOICE_OPEN_STATUSES` (Task 1).
- Produces: `loadAccountReadiness(input: LoadAccountReadinessInput): Promise<Map<string, OrgReadinessSignals>>` — one entry per input id (never a missing key), section fields present iff `input.sections.<section>` is true, `policyAssigned` / `primaryContact` / `billingRoleContact` always present. Query order under `Promise.all`: sites, devices, policy assignments, contacts, portal users, tickets, invoices (disabled sections are skipped, not reordered).

- [ ] **Step 1: Append the failing tests**

Append to `apps/api/src/services/orgAccountReadiness.test.ts`:

```ts
describe('loadAccountReadiness', () => {
  const ALL_SECTIONS = { sites: true, devices: true, portalUsers: true, invoices: true, tickets: true };
  const NO_SECTIONS = { sites: false, devices: false, portalUsers: false, invoices: false, tickets: false };

  beforeEach(() => {
    vi.clearAllMocks();
    captured.length = 0;
  });

  it('returns nothing, without a query, for an empty id list', async () => {
    setupDb(new Map());
    const result = await loadAccountReadiness({ orgIds: [], partnerId: PARTNER_ID, sections: ALL_SECTIONS });
    expect(result.size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('issues one grouped query per enabled domain and none for a disabled one', async () => {
    setupDb(new Map());
    await loadAccountReadiness({ orgIds: [ORG_A], partnerId: PARTNER_ID, sections: ALL_SECTIONS });
    expect(captured.map((call) => call.table)).toEqual([
      sites,
      devices,
      configPolicyAssignments,
      contacts,
      portalUsers,
      tickets,
      invoices,
    ]);

    captured.length = 0;
    await loadAccountReadiness({ orgIds: [ORG_A], partnerId: PARTNER_ID, sections: NO_SECTIONS });
    // policies and contacts ride on organizations:read — always computed.
    expect(captured.map((call) => call.table)).toEqual([configPolicyAssignments, contacts]);
  });

  it('omits every gated field when its section is disabled', async () => {
    setupDb(new Map());
    const result = await loadAccountReadiness({ orgIds: [ORG_A], partnerId: PARTNER_ID, sections: NO_SECTIONS });
    expect(result.get(ORG_A)).toEqual({ policyAssigned: false, primaryContact: null, billingRoleContact: false });
  });

  it('sites: grouped count, zero for an org with none', async () => {
    setupDb(new Map([[sites, [{ orgId: ORG_A, count: '2' }]]]));
    const result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, sections: { ...NO_SECTIONS, sites: true } });

    const where = compiledWhere(sites);
    expect(where.sql).toContain('"sites"."org_id" in (');
    expect(where.params).toEqual([ORG_A, ORG_B]);
    expect(callsFor(sites)[0]?.groupBy).toEqual([sites.orgId]);
    expect(result.get(ORG_A)?.sites).toBe(2);
    expect(result.get(ORG_B)?.sites).toBe(0);
  });

  it('devices: counts the non-decommissioned population and its freshest check-in', async () => {
    setupDb(new Map([[devices, [{ orgId: ORG_A, count: '3', lastSeenAt: new Date('2026-09-01T00:00:00.000Z') }]]]));
    const result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, sections: { ...NO_SECTIONS, devices: true } });

    const where = compiledWhere(devices);
    expect(where.sql).toContain('"devices"."org_id" in (');
    expect(where.sql).toContain('"devices"."status" <> ');
    expect(where.params).toEqual([ORG_A, ORG_B, 'decommissioned']);
    expect(callsFor(devices)[0]?.groupBy).toEqual([devices.orgId]);
    expect(result.get(ORG_A)).toMatchObject({ devices: 3, lastSeenAt: '2026-09-01T00:00:00.000Z' });
    expect(result.get(ORG_B)).toMatchObject({ devices: 0, lastSeenAt: null });
  });

  it('devices: a naive timestamp string from the driver is read as UTC', async () => {
    setupDb(new Map([[devices, [{ orgId: ORG_A, count: '1', lastSeenAt: '2026-09-01 12:30:00' }]]]));
    const result = await loadAccountReadiness({ orgIds: [ORG_A], partnerId: PARTNER_ID, sections: { ...NO_SECTIONS, devices: true } });
    expect(result.get(ORG_A)?.lastSeenAt).toBe('2026-09-01T12:30:00.000Z');
  });

  it('policies: one query over org-level ids and the partner-level target, joined to active policies', async () => {
    setupDb(new Map([[configPolicyAssignments, []]]));
    await loadAccountReadiness({ orgIds: [ORG_A], partnerId: PARTNER_ID, sections: NO_SECTIONS });

    const call = callsFor(configPolicyAssignments)[0]!;
    expect(call.joins.map((join) => join.table)).toEqual([configurationPolicies]);
    const where = compiledWhere(configPolicyAssignments);
    expect(where.sql).toContain('"configuration_policies"."status" = ');
    expect(where.sql).toContain('"config_policy_assignments"."level" = ');
    expect(where.sql).toContain('"config_policy_assignments"."target_id" in (');
    expect(where.params).toEqual(['active', 'organization', ORG_A, 'partner', PARTNER_ID]);
    expect(call.groupBy).toEqual([configPolicyAssignments.level, configPolicyAssignments.targetId]);
  });

  it('policies: a partner-level assignment covers every org; an org-level one only its target', async () => {
    setupDb(new Map([[configPolicyAssignments, [{ level: 'organization', targetId: ORG_A }]]]));
    let result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, sections: NO_SECTIONS });
    expect(result.get(ORG_A)?.policyAssigned).toBe(true);
    expect(result.get(ORG_B)?.policyAssigned).toBe(false);

    setupDb(new Map([[configPolicyAssignments, [{ level: 'partner', targetId: PARTNER_ID }]]]));
    result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, sections: NO_SECTIONS });
    expect(result.get(ORG_A)?.policyAssigned).toBe(true);
    expect(result.get(ORG_B)?.policyAssigned).toBe(true);
  });

  it('contacts: maps the org-level primary and the billing role from one grouped row', async () => {
    setupDb(
      new Map([
        [
          contacts,
          [
            { orgId: ORG_A, hasPrimary: true, primaryName: 'Ada', primaryEmail: 'ada@x.example', primaryPhone: null, primaryMobile: '555-0199', billingRole: true },
            { orgId: ORG_B, hasPrimary: false, primaryName: null, primaryEmail: null, primaryPhone: null, primaryMobile: null, billingRole: false },
          ],
        ],
      ]),
    );
    const result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B, ORG_C], partnerId: PARTNER_ID, sections: NO_SECTIONS });

    const where = compiledWhere(contacts);
    expect(where.sql).toContain('"contacts"."org_id" in (');
    expect(where.params).toEqual([ORG_A, ORG_B, ORG_C]);
    expect(callsFor(contacts)[0]?.groupBy).toEqual([contacts.orgId]);
    expect(result.get(ORG_A)).toMatchObject({
      primaryContact: { name: 'Ada', email: 'ada@x.example', phone: null, mobile: '555-0199' },
      billingRoleContact: true,
    });
    expect(result.get(ORG_B)).toMatchObject({ primaryContact: null, billingRoleContact: false });
    // No contacts at all: same answer as "contacts but no primary".
    expect(result.get(ORG_C)).toMatchObject({ primaryContact: null, billingRoleContact: false });
  });

  it('portal users: pending = not disabled, never signed in, invited at least 7 days ago', async () => {
    setupDb(new Map([[portalUsers, [{ orgId: ORG_A, count: '2' }]]]));
    const result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, sections: { ...NO_SECTIONS, portalUsers: true } });

    const where = compiledWhere(portalUsers);
    expect(where.sql).toContain('"portal_users"."org_id" in (');
    expect(where.sql).toContain('"portal_users"."status" <> ');
    expect(where.sql).toContain('"portal_users"."last_login_at" is null');
    expect(where.sql).toContain(`"portal_users"."invited_at" < (now() AT TIME ZONE 'utc') - interval '7 days'`);
    expect(where.params).toEqual([ORG_A, ORG_B, 'disabled']);
    expect(result.get(ORG_A)?.pendingInvitations).toBe(2);
    expect(result.get(ORG_B)?.pendingInvitations).toBe(0);
  });

  it('tickets: open, non-deleted rows only; awaiting-customer and SLA-breached as filtered counts', async () => {
    setupDb(new Map([[tickets, [{ orgId: ORG_A, open: '4', awaitingCustomer: '1', slaBreached: '2' }]]]));
    const result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, sections: { ...NO_SECTIONS, tickets: true } });

    const where = compiledWhere(tickets);
    expect(where.sql).toContain('"tickets"."org_id" in (');
    expect(where.sql).toContain('"tickets"."deleted_at" is null');
    expect(where.sql).toContain('"tickets"."status" in (');
    expect(where.params).toEqual([ORG_A, ORG_B, 'new', 'open', 'pending', 'on_hold']);
    expect(result.get(ORG_A)?.tickets).toEqual({ open: 4, awaitingCustomer: 1, slaBreached: 2 });
    expect(result.get(ORG_B)?.tickets).toEqual({ open: 0, awaitingCustomer: 0, slaBreached: 0 });
  });

  it('invoices: outstanding statuses due before today', async () => {
    setupDb(new Map([[invoices, [{ orgId: ORG_A, count: '2' }]]]));
    const result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, sections: { ...NO_SECTIONS, invoices: true } });

    const where = compiledWhere(invoices);
    expect(where.sql).toContain('"invoices"."org_id" in (');
    expect(where.sql).toContain('"invoices"."status" in (');
    expect(where.sql).toContain('"invoices"."due_date" < CURRENT_DATE');
    expect(where.params).toEqual([ORG_A, ORG_B, 'sent', 'partially_paid', 'overdue']);
    expect(result.get(ORG_A)?.overdueInvoices).toBe(2);
    expect(result.get(ORG_B)?.overdueInvoices).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd apps/api && npx vitest run src/services/orgAccountReadiness.test.ts`
Expected: the five `resolveAcceptedOrgs` tests PASS; the `loadAccountReadiness` tests FAIL (the stub returns an empty map and issues no queries — e.g. `expected [] to deeply equal [sites, devices, …]`).

- [ ] **Step 3: Implement the aggregates**

In `apps/api/src/services/orgAccountReadiness.ts`, replace everything from the line `export async function loadAccountReadiness(_input: LoadAccountReadinessInput)` to the end of the file with:

```ts
/**
 * Every W02 signal for the accepted ids, one grouped statement per domain.
 * Sections the caller may not see are never queried (`sections`), so an
 * ungated request costs no more than the sections it is allowed to read.
 */
export async function loadAccountReadiness(input: LoadAccountReadinessInput): Promise<Map<string, OrgReadinessSignals>> {
  const ids = input.orgIds;
  const result = new Map<string, OrgReadinessSignals>();
  if (ids.length === 0) return result;

  const { sections } = input;
  const [siteRows, deviceRows, policyRows, contactRows, portalRows, ticketRows, invoiceRows] = await Promise.all([
    sections.sites ? querySiteCounts(ids) : null,
    sections.devices ? queryDeviceSignals(ids) : null,
    queryPolicyAssignments(ids, input.partnerId),
    queryContactSignals(ids),
    sections.portalUsers ? queryPendingInvitations(ids) : null,
    sections.tickets ? queryTicketCounts(ids) : null,
    sections.invoices ? queryOverdueInvoices(ids) : null,
  ]);

  const siteCount = new Map<string, number>(siteRows?.map((row) => [row.orgId, toCount(row.count)]) ?? []);
  const deviceSignal = new Map<string, { count: number; lastSeenAt: string | null }>(
    deviceRows?.map((row) => [row.orgId, { count: toCount(row.count), lastSeenAt: toIsoOrNull(row.lastSeenAt) }]) ?? [],
  );
  // A partner-level assignment of an active policy covers every org of the
  // partner; an org-level one covers its target only (spec: "No policy assigned").
  const partnerAssigned = policyRows.some((row) => row.level === 'partner');
  const orgAssigned = new Set(policyRows.filter((row) => row.level === 'organization').map((row) => row.targetId));
  const contactSignal = new Map(contactRows.map((row) => [row.orgId, row]));
  const pendingInvitations = new Map<string, number>(portalRows?.map((row) => [row.orgId, toCount(row.count)]) ?? []);
  const ticketCounts = new Map<string, TicketCounts>(
    ticketRows?.map((row) => [
      row.orgId,
      { open: toCount(row.open), awaitingCustomer: toCount(row.awaitingCustomer), slaBreached: toCount(row.slaBreached) },
    ]) ?? [],
  );
  const overdueInvoices = new Map<string, number>(invoiceRows?.map((row) => [row.orgId, toCount(row.count)]) ?? []);

  for (const id of ids) {
    const contact = contactSignal.get(id);
    const signals: OrgReadinessSignals = {
      policyAssigned: partnerAssigned || orgAssigned.has(id),
      primaryContact:
        contact && toBool(contact.hasPrimary)
          ? {
              name: contact.primaryName ?? null,
              email: contact.primaryEmail ?? null,
              phone: contact.primaryPhone ?? null,
              mobile: contact.primaryMobile ?? null,
            }
          : null,
      billingRoleContact: contact ? toBool(contact.billingRole) : false,
    };
    if (sections.sites) signals.sites = siteCount.get(id) ?? 0;
    if (sections.devices) {
      const device = deviceSignal.get(id);
      signals.devices = device?.count ?? 0;
      signals.lastSeenAt = device?.lastSeenAt ?? null;
    }
    if (sections.portalUsers) signals.pendingInvitations = pendingInvitations.get(id) ?? 0;
    if (sections.invoices) signals.overdueInvoices = overdueInvoices.get(id) ?? 0;
    if (sections.tickets) signals.tickets = ticketCounts.get(id) ?? { open: 0, awaitingCustomer: 0, slaBreached: 0 };
    result.set(id, signals);
  }
  return result;
}

// ---------------------------------------------------------------------------
// One grouped statement per domain. Each is index-backed on org_id where an
// index exists (devices_org_id_status_idx / devices_org_id_last_seen_at_idx,
// contacts_org_idx, tickets_org_status_idx, invoices_org_status_idx,
// config_assignments_level_target_idx); the measured plans live in the W01
// PR ("Query plan evidence").
// ---------------------------------------------------------------------------

function querySiteCounts(ids: string[]) {
  return db
    .select({ orgId: sites.orgId, count: sql<string>`count(*)` })
    .from(sites)
    .where(inArray(sites.orgId, ids))
    .groupBy(sites.orgId);
}

// Removed (decommissioned) devices are excluded from BOTH the count and the
// freshness max (#5315 — every device surface hides them). `max()` maps the
// timestamp through the column decoder, so the driver's naive UTC text comes
// back as a Date; toIsoOrNull still normalises a raw string defensively.
function queryDeviceSignals(ids: string[]) {
  return db
    .select({
      orgId: devices.orgId,
      count: sql<string>`count(*)`,
      lastSeenAt: max(devices.lastSeenAt),
    })
    .from(devices)
    .where(and(inArray(devices.orgId, ids), ne(devices.status, 'decommissioned')))
    .groupBy(devices.orgId);
}

// "Assigned", deliberately not "covered": site, device-group and device-level
// assignments are not counted, and an assignment does not prove the policy's
// feature links apply to this org's devices (spec "No policy assigned").
function queryPolicyAssignments(ids: string[], partnerId: string) {
  return db
    .select({ level: configPolicyAssignments.level, targetId: configPolicyAssignments.targetId })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configurationPolicies.id, configPolicyAssignments.configPolicyId))
    .where(
      and(
        eq(configurationPolicies.status, 'active'),
        or(
          and(eq(configPolicyAssignments.level, 'organization'), inArray(configPolicyAssignments.targetId, ids)),
          and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, partnerId)),
        ),
      ),
    )
    .groupBy(configPolicyAssignments.level, configPolicyAssignments.targetId);
}

// One grouped pass over the org's contacts. The org-level primary is unique
// per org (partial unique index contacts_org_primary_uniq, db/schema/contacts.ts),
// so `max(col) FILTER (WHERE is_primary AND site_id IS NULL)` reads exactly
// that row's field. Contact data comes from the canonical `contacts` table,
// never from organizations.billing_contact (spec "Account data cell").
function queryContactSignals(ids: string[]) {
  const primary = sql`FILTER (WHERE ${contacts.isPrimary} AND ${contacts.siteId} IS NULL)`;
  return db
    .select({
      orgId: contacts.orgId,
      hasPrimary: sql<boolean>`bool_or(${contacts.isPrimary} AND ${contacts.siteId} IS NULL)`,
      primaryName: sql<string | null>`max(${contacts.name}) ${primary}`,
      primaryEmail: sql<string | null>`max(${contacts.email}) ${primary}`,
      primaryPhone: sql<string | null>`max(${contacts.phone}) ${primary}`,
      primaryMobile: sql<string | null>`max(${contacts.mobile}) ${primary}`,
      billingRole: sql<boolean>`bool_or(${contacts.roles} @> ARRAY['billing']::text[])`,
    })
    .from(contacts)
    .where(inArray(contacts.orgId, ids))
    .groupBy(contacts.orgId);
}

// portal_users.invited_at is a naive UTC `timestamp`; compare against a naive
// UTC clock rather than `now()` so the session time zone cannot shift the
// 7-day boundary.
function queryPendingInvitations(ids: string[]) {
  return db
    .select({ orgId: portalUsers.orgId, count: sql<string>`count(*)` })
    .from(portalUsers)
    .where(
      and(
        inArray(portalUsers.orgId, ids),
        ne(portalUsers.status, 'disabled'),
        isNull(portalUsers.lastLoginAt),
        sql`${portalUsers.invitedAt} < (now() AT TIME ZONE 'utc') - interval '7 days'`,
      ),
    )
    .groupBy(portalUsers.orgId);
}

function queryTicketCounts(ids: string[]) {
  return db
    .select({
      orgId: tickets.orgId,
      open: sql<string>`count(*)`,
      awaitingCustomer: sql<string>`count(*) FILTER (WHERE ${tickets.status} = 'pending')`,
      slaBreached: sql<string>`count(*) FILTER (WHERE ${tickets.slaBreachedAt} IS NOT NULL)`,
    })
    .from(tickets)
    .where(
      and(
        inArray(tickets.orgId, ids),
        isNull(tickets.deletedAt),
        sql`${tickets.status} IN (${sqlStatusList(TICKET_OPEN_STATUSES)})`,
      ),
    )
    .groupBy(tickets.orgId);
}

function queryOverdueInvoices(ids: string[]) {
  return db
    .select({ orgId: invoices.orgId, count: sql<string>`count(*)` })
    .from(invoices)
    .where(
      and(
        inArray(invoices.orgId, ids),
        sql`${invoices.status} IN (${sqlStatusList(INVOICE_OPEN_STATUSES)})`,
        sql`${invoices.dueDate} < CURRENT_DATE`,
      ),
    )
    .groupBy(invoices.orgId);
}

// ---------------------------------------------------------------------------
// Driver coercions. count()/count() FILTER come back as strings (bigint);
// bool_or as a boolean (kept tolerant of a 't'/'f' text form).
// ---------------------------------------------------------------------------

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toBool(value: unknown): boolean {
  return value === true || value === 't' || value === 'true';
}

// Matches a trailing UTC 'Z'/'z' or an explicit +HH:MM / +HHMM offset.
const HAS_TZ_OFFSET = /[Zz]$|[+-]\d\d:?\d\d$/;

// A raw timestamp string without an offset is parsed by ECMA-262 as HOST
// local time; every timestamp column here is written and read as UTC, so a
// naive date-time is given an explicit 'Z' before parsing (same rule as
// routes/orgSummary.ts).
function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const raw = String(value);
  const needsUtcSuffix = !HAS_TZ_OFFSET.test(raw) && raw.includes(':');
  const date = new Date(needsUtcSuffix ? `${raw.replace(' ', 'T')}Z` : raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
```

- [ ] **Step 4: Run the service tests, typecheck and lint**

Run: `cd apps/api && npx vitest run src/services/orgAccountReadiness.test.ts && npx tsc --noEmit && npx eslint src/services/orgAccountReadiness.ts`
Expected: PASS (17 tests), tsc clean, eslint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/orgAccountReadiness.ts apps/api/src/services/orgAccountReadiness.test.ts
git commit -m "feat(api): account readiness — one grouped aggregate per domain, gated by section (#5721 W01)"
```

---

### Task 4: Route — validation, partner pinning, capabilities, shaping

**Files:**
- Create: `apps/api/src/routes/orgAccountReadiness.ts`
- Create: `apps/api/src/routes/orgAccountReadiness.test.ts`

**Interfaces:**
- Consumes: `resolveAcceptedOrgs`, `loadAccountReadiness`, `AcceptedOrg`, `OrgReadinessSignals`, `OrgType`, `PrimaryContact`, `ReadinessSections`, `TicketCounts` (Tasks 2–3); `getServiceManagementMode(partnerId): Promise<ServiceManagementMode>` and `type ServiceManagementMode = 'native' | 'external' | 'off'` from `../services/serviceManagement` (existing; fails open to `'native'`; its `partners` read passes the table's `breeze_has_partner_access(id)` SELECT policy for the caller's own partner); `authMiddleware`, `requireScope`, `requirePermission`, `AuthContext` from `../middleware/auth`; `hasPermission`, `PERMISSIONS`, `UserPermissions` from `../services/permissions`; `PG_UUID_REGEX` from `../utils/uuid`.
- Produces: `orgAccountReadinessRoutes: Hono` (route `GET /account-readiness`, to be mounted under `/orgs`); `MAX_ACCOUNT_READINESS_ORG_IDS = 200`; `parseOrgIdsParam(raw: string | undefined): { ok: true; orgIds: string[] } | { ok: false; error: string }`; exported response types `AccountReadinessResponse`, `AccountReadinessOrg`, `AccountReadinessCapabilities`, `AccountReadinessConnector`, `AccountReadinessIntegration` (W02 imports these for the web client; W03 fills the last two).

- [ ] **Step 1: Write the failing tests**

`apps/api/src/routes/orgAccountReadiness.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Real (unmocked) permission catalogue + matcher — pure, DB-free helpers; the
// real constants keep the granted lists honest against the strings the route
// checks (a typo'd literal in the route fails here instead of never matching).
import { PERMISSIONS } from '../services/permissions';
import type { AcceptedOrg, OrgReadinessSignals } from '../services/orgAccountReadiness';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((_c: any, next: any) => next()),
  requireScope: vi.fn((...scopes: string[]) => (c: any, next: any) => {
    const auth = c.get('auth');
    if (!scopes.includes(auth?.scope)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
  requirePermission: vi.fn((resource: string, action: string) => (c: any, next: any) => {
    const perms = c.get('permissions');
    const granted = Array.isArray(perms?.permissions) && perms.permissions.some(
      (p: { resource: string; action: string }) =>
        (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*'),
    );
    if (!granted) {
      return c.json({ error: 'Permission denied' }, 403);
    }
    return next();
  }),
}));

// services/permissions imports ../db; keep the pool out of the unit run.
vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../services/serviceManagement', () => ({
  getServiceManagementMode: vi.fn(),
}));

vi.mock('../services/orgAccountReadiness', () => ({
  resolveAcceptedOrgs: vi.fn(),
  loadAccountReadiness: vi.fn(),
}));

import { getServiceManagementMode } from '../services/serviceManagement';
import { loadAccountReadiness, resolveAcceptedOrgs } from '../services/orgAccountReadiness';
import { MAX_ACCOUNT_READINESS_ORG_IDS, orgAccountReadinessRoutes, parseOrgIdsParam } from './orgAccountReadiness';

const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '11111111-1111-4111-8111-222222222222';
const WILDCARD_GRANTS = [{ resource: '*', action: '*' }];

/** Deterministic, UUID-shaped ids for the cap tests. */
function uuidAt(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function acceptedOrg(id: string, overrides: Partial<AcceptedOrg> = {}): AcceptedOrg {
  return { id, type: 'customer', status: 'active', billingAddress: true, ...overrides };
}

function fullSignals(overrides: Partial<OrgReadinessSignals> = {}): OrgReadinessSignals {
  return {
    sites: 2,
    devices: 5,
    lastSeenAt: '2026-09-01T00:00:00.000Z',
    policyAssigned: true,
    primaryContact: { name: 'Jane Doe', email: 'jane@x.example', phone: '555-0100', mobile: null },
    billingRoleContact: true,
    pendingInvitations: 1,
    overdueInvoices: 2,
    tickets: { open: 4, awaitingCustomer: 1, slaBreached: 1 },
    ...overrides,
  };
}

function buildApp(opts: {
  scope?: 'system' | 'partner' | 'organization';
  partnerId?: string | null;
  accessibleOrgIds?: string[] | null;
  grants?: Array<{ resource: string; action: string }>;
  /** Mount something under /orgs BEFORE the readiness router (composed-app tests). */
  before?: (app: Hono) => void;
}) {
  const scope = opts.scope ?? 'partner';
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'tech@example.com', name: 'Tech', isPlatformAdmin: scope === 'system' },
      scope,
      partnerId: opts.partnerId === undefined ? (scope === 'system' ? null : PARTNER_ID) : opts.partnerId,
      orgId: null,
      accessibleOrgIds:
        opts.accessibleOrgIds === undefined ? (scope === 'system' ? null : [ORG_A, ORG_B]) : opts.accessibleOrgIds,
      canAccessOrg: () => true,
    } as any);
    c.set('permissions', {
      permissions: opts.grants ?? [],
      scope,
      partnerId: PARTNER_ID,
      orgId: null,
      roleId: 'role-1',
    } as any);
    await next();
  });
  opts.before?.(app);
  app.route('/orgs', orgAccountReadinessRoutes);
  return app;
}

function path(orgIds: string[], extra: Record<string, string> = {}): string {
  const query = [`orgIds=${orgIds.join(',')}`, ...Object.entries(extra).map(([k, v]) => `${k}=${v}`)];
  return `/orgs/account-readiness?${query.join('&')}`;
}

describe('parseOrgIdsParam', () => {
  it('rejects a missing or blank value', () => {
    expect(parseOrgIdsParam(undefined)).toEqual({ ok: false, error: 'orgIds is required' });
    expect(parseOrgIdsParam('  ')).toEqual({ ok: false, error: 'orgIds is required' });
    expect(parseOrgIdsParam(',,')).toEqual({ ok: false, error: 'orgIds is required' });
  });

  it('rejects any non-UUID entry', () => {
    expect(parseOrgIdsParam(`${ORG_A},not-a-uuid`)).toEqual({ ok: false, error: 'orgIds must be comma-separated UUIDs' });
  });

  it('caps at 200 entries as sent (before de-duplication)', () => {
    const ids = Array.from({ length: MAX_ACCOUNT_READINESS_ORG_IDS + 1 }, (_, i) => uuidAt(i));
    expect(parseOrgIdsParam(ids.join(','))).toEqual({ ok: false, error: 'orgIds accepts at most 200 ids' });
    expect(parseOrgIdsParam(ids.slice(0, MAX_ACCOUNT_READINESS_ORG_IDS).join(',')).ok).toBe(true);
  });

  it('trims, lower-cases and de-duplicates while keeping first-seen order', () => {
    expect(parseOrgIdsParam(` ${ORG_B.toUpperCase()}, ${ORG_A} ,${ORG_B}`)).toEqual({ ok: true, orgIds: [ORG_B, ORG_A] });
  });
});

describe('GET /orgs/account-readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServiceManagementMode).mockResolvedValue('native');
    vi.mocked(resolveAcceptedOrgs).mockResolvedValue([acceptedOrg(ORG_A)]);
    vi.mocked(loadAccountReadiness).mockResolvedValue(new Map([[ORG_A, fullSignals()]]));
  });

  it('400s without orgIds and never touches the services', async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const res = await app.request('/orgs/account-readiness');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'orgIds is required' });
    expect(getServiceManagementMode).not.toHaveBeenCalled();
    expect(resolveAcceptedOrgs).not.toHaveBeenCalled();
  });

  it('400s on a malformed id', async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const res = await app.request(path([ORG_A, 'nope']));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'orgIds must be comma-separated UUIDs' });
    expect(resolveAcceptedOrgs).not.toHaveBeenCalled();
  });

  it('400s above the 200-id cap and accepts exactly 200', async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const ids = Array.from({ length: 201 }, (_, i) => uuidAt(i));
    const over = await app.request(path(ids));
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual({ error: 'orgIds accepts at most 200 ids' });

    const exact = await app.request(path(ids.slice(0, 200)));
    expect(exact.status).toBe(200);
    expect(vi.mocked(resolveAcceptedOrgs).mock.calls[0]?.[0].orgIds).toHaveLength(200);
  });

  it('de-duplicates repeated ids before resolution', async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const res = await app.request(path([ORG_A, ORG_A, ORG_B, ORG_A]));
    expect(res.status).toBe(200);
    expect(vi.mocked(resolveAcceptedOrgs).mock.calls[0]?.[0].orgIds).toEqual([ORG_A, ORG_B]);
  });

  it('system scope: 400s without partnerId, and on a malformed one', async () => {
    const app = buildApp({ scope: 'system', grants: WILDCARD_GRANTS });
    const missing = await app.request(path([ORG_A]));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'partnerId is required for system scope' });

    const malformed = await app.request(path([ORG_A], { partnerId: 'nope' }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'partnerId must be a UUID' });
    expect(resolveAcceptedOrgs).not.toHaveBeenCalled();
  });

  it('system scope: resolves against the named partner with unrestricted access', async () => {
    const app = buildApp({ scope: 'system', grants: WILDCARD_GRANTS });
    const res = await app.request(path([ORG_A], { partnerId: OTHER_PARTNER_ID }));
    expect(res.status).toBe(200);
    expect(resolveAcceptedOrgs).toHaveBeenCalledWith({ orgIds: [ORG_A], partnerId: OTHER_PARTNER_ID, accessibleOrgIds: null });
    expect(getServiceManagementMode).toHaveBeenCalledWith(OTHER_PARTNER_ID);
    expect((await res.json()).partnerId).toBe(OTHER_PARTNER_ID);
  });

  it("partner scope: ignores a partnerId query and passes the token's partner and accessible list", async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS, accessibleOrgIds: [ORG_A, ORG_B] });
    const res = await app.request(path([ORG_A, ORG_B], { partnerId: OTHER_PARTNER_ID }));
    expect(res.status).toBe(200);
    expect(resolveAcceptedOrgs).toHaveBeenCalledWith({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, accessibleOrgIds: [ORG_A, ORG_B] });
    expect(getServiceManagementMode).toHaveBeenCalledWith(PARTNER_ID);
    expect((await res.json()).partnerId).toBe(PARTNER_ID);
  });

  it('partner scope: an unresolved accessible list fails closed (empty, not null)', async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS, accessibleOrgIds: null });
    await app.request(path([ORG_A]));
    expect(vi.mocked(resolveAcceptedOrgs).mock.calls[0]?.[0].accessibleOrgIds).toEqual([]);
  });

  it('partner scope: 400s when the token carries no partner', async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS, partnerId: null });
    const res = await app.request(path([ORG_A]));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Partner context required' });
  });

  it('silently omits ids the resolver dropped and loads only the accepted ones', async () => {
    // A sibling org of the same partner that the token cannot access: the
    // resolver (tested on its own SQL) leaves it out; the route must not 403.
    vi.mocked(resolveAcceptedOrgs).mockResolvedValue([acceptedOrg(ORG_A)]);
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const res = await app.request(path([ORG_A, ORG_B]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orgs.map((org: { orgId: string }) => org.orgId)).toEqual([ORG_A]);
    expect(vi.mocked(loadAccountReadiness).mock.calls[0]?.[0].orgIds).toEqual([ORG_A]);
  });

  it('skips the readiness load when nothing was accepted, but still reports capabilities', async () => {
    vi.mocked(resolveAcceptedOrgs).mockResolvedValue([]);
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const res = await app.request(path([ORG_A]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orgs).toEqual([]);
    expect(body.capabilities.sites).toBe(true);
    expect(loadAccountReadiness).not.toHaveBeenCalled();
  });

  it('shapes every section for a wildcard caller in native mode', async () => {
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const res = await app.request(path([ORG_A]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      partnerId: PARTNER_ID,
      capabilities: {
        sites: true,
        devices: true,
        policies: true,
        contacts: true,
        portalUsers: true,
        invoices: true,
        tickets: true,
        integrations: false,
      },
      serviceManagementMode: 'native',
      orgs: [
        {
          orgId: ORG_A,
          type: 'customer',
          status: 'active',
          setup: { sites: 2, devices: 5, lastSeenAt: '2026-09-01T00:00:00.000Z', policyAssigned: true },
          account: {
            primaryContact: { name: 'Jane Doe', email: 'jane@x.example', phone: '555-0100', mobile: null },
            billingRoleContact: true,
            billingAddress: true,
            pendingInvitations: 1,
            overdueInvoices: 2,
          },
          tickets: { open: 4, awaitingCustomer: 1, slaBreached: 1 },
        },
      ],
    });
    expect(loadAccountReadiness).toHaveBeenCalledWith({
      orgIds: [ORG_A],
      partnerId: PARTNER_ID,
      sections: { sites: true, devices: true, portalUsers: true, invoices: true, tickets: true },
    });
  });

  it('carries the accepted org type, status and billingAddress through unchanged', async () => {
    vi.mocked(resolveAcceptedOrgs).mockResolvedValue([acceptedOrg(ORG_A, { type: 'internal', status: 'trial', billingAddress: false })]);
    const app = buildApp({ grants: WILDCARD_GRANTS });
    const body = await (await app.request(path([ORG_A]))).json();
    expect(body.orgs[0]).toMatchObject({ type: 'internal', status: 'trial', account: { billingAddress: false } });
  });

  const ALL_FALSE = { sites: false, devices: false, policies: true, contacts: true, portalUsers: false, invoices: false, tickets: false, integrations: false };
  const gateCases: Array<{
    name: string;
    grants: Array<{ resource: string; action: string }>;
    mode: 'native' | 'external' | 'off';
    capabilities: Record<string, boolean>;
  }> = [
    { name: 'organizations:read only', grants: [PERMISSIONS.ORGS_READ], mode: 'native', capabilities: ALL_FALSE },
    { name: '+ sites:read', grants: [PERMISSIONS.ORGS_READ, PERMISSIONS.SITES_READ], mode: 'native', capabilities: { ...ALL_FALSE, sites: true } },
    { name: '+ devices:read', grants: [PERMISSIONS.ORGS_READ, PERMISSIONS.DEVICES_READ], mode: 'native', capabilities: { ...ALL_FALSE, devices: true } },
    { name: '+ users:read', grants: [PERMISSIONS.ORGS_READ, PERMISSIONS.USERS_READ], mode: 'native', capabilities: { ...ALL_FALSE, portalUsers: true } },
    { name: '+ invoices:read (native)', grants: [PERMISSIONS.ORGS_READ, PERMISSIONS.INVOICES_READ], mode: 'native', capabilities: { ...ALL_FALSE, invoices: true } },
    { name: '+ tickets:read (native)', grants: [PERMISSIONS.ORGS_READ, PERMISSIONS.TICKETS_READ], mode: 'native', capabilities: { ...ALL_FALSE, tickets: true } },
    { name: '+ invoices:read + tickets:read but external mode', grants: [PERMISSIONS.ORGS_READ, PERMISSIONS.INVOICES_READ, PERMISSIONS.TICKETS_READ], mode: 'external', capabilities: ALL_FALSE },
    { name: 'wildcard but mode off', grants: WILDCARD_GRANTS, mode: 'off', capabilities: { ...ALL_FALSE, sites: true, devices: true, portalUsers: true } },
    // connected_apps:read / accounting:read are W03 inputs — never a W01 capability.
    { name: '+ connected_apps:read + accounting:read (W03 only)', grants: [PERMISSIONS.ORGS_READ, PERMISSIONS.CONNECTED_APPS_READ, PERMISSIONS.ACCOUNTING_READ], mode: 'native', capabilities: ALL_FALSE },
  ];

  it.each(gateCases)('gates sections by grant and mode: $name', async ({ grants, mode, capabilities }) => {
    vi.mocked(getServiceManagementMode).mockResolvedValue(mode);
    const app = buildApp({ grants });
    const res = await app.request(path([ORG_A]));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.capabilities).toEqual(capabilities);
    expect(body.serviceManagementMode).toBe(mode);
    expect(vi.mocked(loadAccountReadiness).mock.calls[0]?.[0].sections).toEqual({
      sites: capabilities.sites,
      devices: capabilities.devices,
      portalUsers: capabilities.portalUsers,
      invoices: capabilities.invoices,
      tickets: capabilities.tickets,
    });

    const org = body.orgs[0];
    expect(org.setup).toHaveProperty('policyAssigned');
    expect(org.account).toHaveProperty('primaryContact');
    expect(org.account).toHaveProperty('billingRoleContact');
    expect(org.account).toHaveProperty('billingAddress');
    expect('sites' in org.setup).toBe(capabilities.sites);
    expect('devices' in org.setup).toBe(capabilities.devices);
    expect('lastSeenAt' in org.setup).toBe(capabilities.devices);
    expect('pendingInvitations' in org.account).toBe(capabilities.portalUsers);
    expect('overdueInvoices' in org.account).toBe(capabilities.invoices);
    expect('tickets' in org).toBe(capabilities.tickets);
    expect(org).not.toHaveProperty('integrations');
    expect(body).not.toHaveProperty('connectors');
  });

  it('403s an organization-scoped token before any lookup', async () => {
    const app = buildApp({ scope: 'organization', grants: WILDCARD_GRANTS });
    const res = await app.request(path([ORG_A]));
    expect(res.status).toBe(403);
    expect(getServiceManagementMode).not.toHaveBeenCalled();
  });

  it('403s without organizations:read', async () => {
    const app = buildApp({ grants: [PERMISSIONS.SITES_READ, PERMISSIONS.DEVICES_READ] });
    const res = await app.request(path([ORG_A]));
    expect(res.status).toBe(403);
    expect(resolveAcceptedOrgs).not.toHaveBeenCalled();
  });

  // Spec "Decisions recorded": the path lives at /orgs/account-readiness, not
  // /orgs/organizations/account-readiness, because orgRoutes is mounted first
  // and its `/organizations/:id` captures any literal in that position.
  it('is reachable when a router owning /organizations/:id is mounted first (composed-app path)', async () => {
    const app = buildApp({
      grants: WILDCARD_GRANTS,
      before: (composed) => {
        const standInOrgRoutes = new Hono();
        standInOrgRoutes.get('/', (c) => c.json({ route: 'list' }));
        standInOrgRoutes.get('/organizations/:id', (c) => c.json({ route: 'record', id: c.req.param('id') }));
        composed.route('/orgs', standInOrgRoutes);
      },
    });

    const res = await app.request(path([ORG_A]));
    expect(res.status).toBe(200);
    expect((await res.json()).partnerId).toBe(PARTNER_ID);

    // And the shape the spec ruled out really is captured by the earlier router.
    const shadowed = await app.request(`/orgs/organizations/account-readiness?orgIds=${ORG_A}`);
    expect(await shadowed.json()).toEqual({ route: 'record', id: 'account-readiness' });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/orgAccountReadiness.test.ts`
Expected: FAIL — `Cannot find module './orgAccountReadiness'`.

- [ ] **Step 3: Write the route**

`apps/api/src/routes/orgAccountReadiness.ts`:

```ts
/**
 * GET /orgs/account-readiness — the Organizations account board's bulk read
 * (spec docs/superpowers/specs/web-ui/2026-09-13-organizations-account-board-design.md,
 * "API: GET /orgs/account-readiness"). Feature #5721, W01.
 *
 * Sibling router mounted under `/orgs` next to orgSummaryRoutes. The path is
 * deliberately NOT `/organizations/account-readiness`: orgRoutes is mounted
 * first and its `/organizations/:id` would capture that literal and answer
 * 404 from its UUID guard.
 *
 * The route validates, pins the partner, gates and shapes. Every query lives
 * in services/orgAccountReadiness.ts. Each optional section is present ONLY
 * when the caller holds the matching `<resource>:read` grant — and, for
 * tickets and invoices, only when the partner runs the native service desk
 * (mirrors OrgOverviewTab's rule). `capabilities` tells the web which sections
 * were computed so it hides those columns rather than rendering zeros.
 * `policies` and `contacts` ride on the `organizations:read` grant the whole
 * route is gated on, so they are always present.
 */
import { Hono } from 'hono';
import { authMiddleware, requireScope, requirePermission, type AuthContext } from '../middleware/auth';
import { hasPermission, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { getServiceManagementMode, type ServiceManagementMode } from '../services/serviceManagement';
import {
  loadAccountReadiness,
  resolveAcceptedOrgs,
  type AcceptedOrg,
  type OrgReadinessSignals,
  type OrgType,
  type PrimaryContact,
  type ReadinessSections,
  type TicketCounts,
} from '../services/orgAccountReadiness';
import { PG_UUID_REGEX } from '../utils/uuid';

/** The web batches by this many ids (spec "States": per 200-id batch). */
export const MAX_ACCOUNT_READINESS_ORG_IDS = 200;

export interface AccountReadinessCapabilities {
  /** sites:read */
  sites: boolean;
  /** devices:read */
  devices: boolean;
  /** organizations:read — always true */
  policies: boolean;
  /** organizations:read — always true */
  contacts: boolean;
  /** users:read */
  portalUsers: boolean;
  /** invoices:read AND service_management_mode = 'native' */
  invoices: boolean;
  /** tickets:read AND service_management_mode = 'native' */
  tickets: boolean;
  /** W03: connected_apps:read. Always false in W01. */
  integrations: boolean;
}

// W03 shapes, declared now so W02's client types and W03's fill-in share one
// definition. Nothing in W01 produces them.
export type ConnectorSystem = 'quickbooks' | 'xero' | 'psa' | 'pax8' | 'huntress' | 'sentinelone';
export type ConnectorState = 'connected' | 'reauth_required' | 'disconnected' | 'error' | 'disabled';
export interface AccountReadinessConnector {
  system: ConnectorSystem;
  state: ConnectorState;
  /** PSA provider name */
  provider?: string;
}
export type IntegrationSystem = ConnectorSystem | 'm365' | 'dns_filter' | 'external';
export type IntegrationState = 'linked' | 'pending' | 'error' | 'identity';
export type IntegrationReason =
  | 'suggested_match'
  | 'sync_error'
  | 'consent_pending'
  | 'expired'
  | 'degraded'
  | 'suspended'
  | 'error'
  | 'never_synced'
  | 'sync_failed'
  | 'disabled'
  | 'connector_error';
export interface AccountReadinessIntegration {
  system: IntegrationSystem;
  state: IntegrationState;
  /** A code — the web translates it. No English sentence crosses the API. */
  reason?: IntegrationReason;
  /** For 'external' rows: the system name from organization_external_links. */
  label?: string;
}

export interface AccountReadinessOrg {
  orgId: string;
  type: OrgType;
  status: string;
  setup: {
    /** capabilities.sites */
    sites?: number;
    /** capabilities.devices, non-decommissioned */
    devices?: number;
    /** capabilities.devices, max over the same population; null = never */
    lastSeenAt?: string | null;
    /** org- or partner-level assignment of an active policy */
    policyAssigned: boolean;
  };
  account: {
    primaryContact: PrimaryContact | null;
    /** any contact with roles ⊇ {'billing'} */
    billingRoleContact: boolean;
    billingAddress: boolean;
    /** capabilities.portalUsers; invited ≥ 7 days ago, never signed in */
    pendingInvitations?: number;
    /** capabilities.invoices */
    overdueInvoices?: number;
  };
  /** W03. Present only with capabilities.integrations. */
  integrations?: AccountReadinessIntegration[];
  /** capabilities.tickets */
  tickets?: TicketCounts;
}

export interface AccountReadinessResponse {
  partnerId: string;
  /** Which sections were computed for this caller. Absent sections were withheld by permission or mode. */
  capabilities: AccountReadinessCapabilities;
  serviceManagementMode: ServiceManagementMode;
  /** W03. Present only with capabilities.integrations. */
  connectors?: AccountReadinessConnector[];
  orgs: AccountReadinessOrg[];
}

export type OrgIdsParse = { ok: true; orgIds: string[] } | { ok: false; error: string };

/**
 * `orgIds` = comma-separated UUIDs, 1–200. The cap counts entries as sent;
 * duplicates are then collapsed (first occurrence wins) and ids lower-cased so
 * they compare equal to the uuid column's text form.
 */
export function parseOrgIdsParam(raw: string | undefined): OrgIdsParse {
  const parts = (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return { ok: false, error: 'orgIds is required' };
  if (parts.length > MAX_ACCOUNT_READINESS_ORG_IDS) {
    return { ok: false, error: `orgIds accepts at most ${MAX_ACCOUNT_READINESS_ORG_IDS} ids` };
  }
  if (parts.some((part) => !PG_UUID_REGEX.test(part))) {
    return { ok: false, error: 'orgIds must be comma-separated UUIDs' };
  }
  return { ok: true, orgIds: Array.from(new Set(parts.map((part) => part.toLowerCase()))) };
}

export const orgAccountReadinessRoutes = new Hono();

orgAccountReadinessRoutes.use('*', authMiddleware);

const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);

const EMPTY_TICKETS: TicketCounts = { open: 0, awaitingCustomer: 0, slaBreached: 0 };

function shapeOrg(
  org: AcceptedOrg,
  signals: OrgReadinessSignals | undefined,
  capabilities: AccountReadinessCapabilities,
): AccountReadinessOrg {
  const setup: AccountReadinessOrg['setup'] = { policyAssigned: signals?.policyAssigned ?? false };
  if (capabilities.sites) setup.sites = signals?.sites ?? 0;
  if (capabilities.devices) {
    setup.devices = signals?.devices ?? 0;
    setup.lastSeenAt = signals?.lastSeenAt ?? null;
  }

  const account: AccountReadinessOrg['account'] = {
    primaryContact: signals?.primaryContact ?? null,
    billingRoleContact: signals?.billingRoleContact ?? false,
    billingAddress: org.billingAddress,
  };
  if (capabilities.portalUsers) account.pendingInvitations = signals?.pendingInvitations ?? 0;
  if (capabilities.invoices) account.overdueInvoices = signals?.overdueInvoices ?? 0;

  const shaped: AccountReadinessOrg = { orgId: org.id, type: org.type, status: org.status, setup, account };
  if (capabilities.tickets) shaped.tickets = signals?.tickets ?? EMPTY_TICKETS;
  return shaped;
}

orgAccountReadinessRoutes.get(
  '/account-readiness',
  requireScope('partner', 'system'),
  requireOrgRead,
  async (c) => {
    const auth = c.get('auth') as AuthContext;

    // Shape-check BEFORE any DB access (same rule as GET /organizations/:id):
    // a non-UUID reaching a uuid column raises Postgres 22P02, an uncaught 500.
    const parsed = parseOrgIdsParam(c.req.query('orgIds'));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    // Whose orgs. Same contract as GET /orgs: a partner token is pinned to its
    // own partner (a `partnerId` query is ignored); system scope must name one.
    let partnerId: string;
    if (auth.scope === 'system') {
      const queryPartnerId = c.req.query('partnerId');
      if (!queryPartnerId) return c.json({ error: 'partnerId is required for system scope' }, 400);
      if (!PG_UUID_REGEX.test(queryPartnerId)) return c.json({ error: 'partnerId must be a UUID' }, 400);
      partnerId = queryPartnerId;
    } else {
      if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);
      partnerId = auth.partnerId;
    }

    const permissions = c.get('permissions') as UserPermissions | undefined;
    const can = (grant: { resource: string; action: string }) =>
      Boolean(permissions && hasPermission(permissions, grant.resource, grant.action));

    // Fails open to 'native' (services/serviceManagement.ts); its partners read
    // runs under this request's context and passes the table's own-partner
    // SELECT policy.
    const serviceManagementMode = await getServiceManagementMode(partnerId);
    const native = serviceManagementMode === 'native';
    const capabilities: AccountReadinessCapabilities = {
      sites: can(PERMISSIONS.SITES_READ),
      devices: can(PERMISSIONS.DEVICES_READ),
      policies: true,
      contacts: true,
      portalUsers: can(PERMISSIONS.USERS_READ),
      invoices: can(PERMISSIONS.INVOICES_READ) && native,
      tickets: can(PERMISSIONS.TICKETS_READ) && native,
      integrations: false,
    };

    const accepted = await resolveAcceptedOrgs({
      orgIds: parsed.orgIds,
      partnerId,
      // A partner token whose list never resolved gets nothing, not everything.
      accessibleOrgIds: auth.scope === 'system' ? null : (auth.accessibleOrgIds ?? []),
    });

    const sections: ReadinessSections = {
      sites: capabilities.sites,
      devices: capabilities.devices,
      portalUsers: capabilities.portalUsers,
      invoices: capabilities.invoices,
      tickets: capabilities.tickets,
    };
    const signals =
      accepted.length > 0
        ? await loadAccountReadiness({ orgIds: accepted.map((org) => org.id), partnerId, sections })
        : new Map<string, OrgReadinessSignals>();

    const response: AccountReadinessResponse = {
      partnerId,
      capabilities,
      serviceManagementMode,
      orgs: accepted.map((org) => shapeOrg(org, signals.get(org.id), capabilities)),
    };
    return c.json(response);
  },
);
```

- [ ] **Step 4: Run the route tests, typecheck and lint**

Run: `cd apps/api && npx vitest run src/routes/orgAccountReadiness.test.ts && npx tsc --noEmit && npx eslint src/routes/orgAccountReadiness.ts`
Expected: PASS (4 `parseOrgIdsParam` + 25 route tests, the `it.each` counting nine), tsc clean, eslint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/orgAccountReadiness.ts apps/api/src/routes/orgAccountReadiness.test.ts
git commit -m "feat(api): GET /orgs/account-readiness — validation, partner pinning, capabilities, shaping (#5721 W01)"
```

---

### Task 5: Mount in the composed app + real-Postgres signal matrix

**Files:**
- Modify: `apps/api/src/index.ts` (the import block around line 55 and the `/orgs` mount block around lines 847–854)
- Create: `apps/api/src/__tests__/integration/orgAccountReadiness.integration.test.ts`

**Interfaces:**
- Consumes: `orgAccountReadinessRoutes` (Task 4); `orgRoutes` from `routes/orgs`; `createIntegrationTestClient`, `createOrganization`, `createUser`, `createRole`, `grantRolePermissions`, `assignUserToPartner`, `IntegrationTestClient` from `__tests__/integration/db-utils.ts`; `getTestDb` from `./setup`; `db`, `withSystemDbAccessContext` from `db/index.ts`.
- Produces: the mounted route in the real app; the integration file's shared helpers `buildApp(): Hono`, `seedBoard(): Promise<Board>`, `readinessPath(orgIds: string[], partnerId?: string): string`, `ZERO_TICKETS` and the `Board` interface, which Task 6 appends tests against.

- [ ] **Step 1: Mount the router**

In `apps/api/src/index.ts`, directly after

```ts
import { orgSummaryRoutes } from './routes/orgSummary';
```

add

```ts
import { orgAccountReadinessRoutes } from './routes/orgAccountReadiness';
```

and directly after

```ts
api.route('/orgs', orgSummaryRoutes);
```

add

```ts
api.route('/orgs', orgAccountReadinessRoutes); // GET /orgs/account-readiness — Organizations board bulk read (#5721 W01)
```

Run: `cd apps/api && npx tsc --noEmit && grep -n "orgAccountReadinessRoutes" src/index.ts`
Expected: tsc clean; two lines (import + mount), the mount on the line after `orgSummaryRoutes`.

- [ ] **Step 2: Bring up a private test stack**

Run (repo root): `pnpm test-stack up`
Expected: a worktree-local `.env.test` with `DATABASE_URL=…@localhost:<port>/breeze_test` and `DATABASE_URL_APP=postgresql://breeze_app:…`. (If Docker hangs after a host sleep: `orb stop && orb start`.)

- [ ] **Step 3: Write the failing integration test (composed app + signal matrix)**

`apps/api/src/__tests__/integration/orgAccountReadiness.integration.test.ts`:

```ts
/**
 * Real-Postgres coverage for GET /orgs/account-readiness (Organizations
 * account board, feature #5721 W01). routes/orgAccountReadiness.test.ts
 * pins validation, gating and shaping with the service mocked;
 * services/orgAccountReadiness.test.ts pins the compiled predicates. This file
 * proves the grouped SQL, the accepted-id resolution and the composed-app
 * path against genuine rows under forced RLS as breeze_app.
 *
 * The app mounts the REAL orgRoutes before orgAccountReadinessRoutes, in the
 * same order as apps/api/src/index.ts, so a regression that moved the path
 * under `/organizations/…` (captured by orgRoutes' `/organizations/:id`)
 * fails here rather than in production.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { orgRoutes } from '../../routes/orgs';
import { orgAccountReadinessRoutes } from '../../routes/orgAccountReadiness';
import { db, withSystemDbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configurationPolicies,
  contacts,
  devices,
  invoices,
  organizations,
  partners,
  partnerUsers,
  portalUsers,
  tickets,
  users,
} from '../../db/schema';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { clearPermissionCache, PERMISSIONS } from '../../services/permissions';
import {
  assignUserToPartner,
  createIntegrationTestClient,
  createOrganization,
  createRole,
  createUser,
  grantRolePermissions,
  type IntegrationTestClient,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  // index.ts order: orgRoutes owns `/orgs/organizations/:id`; the readiness
  // router must still answer `/orgs/account-readiness` behind it.
  app.route('/orgs', orgRoutes);
  app.route('/orgs', orgAccountReadinessRoutes);
  return app;
}

interface Board {
  app: Hono;
  /** Partner P1's wildcard-permission, orgAccess=all client. */
  client: IntegrationTestClient;
  partnerId: string;
  /** client.env.organization: customer, active, owns client.env.site. */
  orgA: string;
  /** internal, trial, no site. */
  orgB: string;
  /** customer, active, nothing seeded. */
  orgC: string;
  quickSupportId: string;
  deletedId: string;
  /** A second partner (P2) with its own client and org D. */
  other: IntegrationTestClient;
  otherPartnerId: string;
  orgD: string;
  suffix: string;
}

async function seedBoard(): Promise<Board> {
  const app = buildApp();
  const client = await createIntegrationTestClient(app, { scope: 'partner' });
  const partnerId = client.env.partner.id;
  const suffix = randomUUID().slice(0, 8);

  const orgB = await createOrganization({ partnerId, type: 'internal', status: 'trial', name: `Board internal ${suffix}` });
  const orgC = await createOrganization({ partnerId, name: `Board bare ${suffix}` });
  const deleted = await createOrganization({ partnerId, name: `Board deleted ${suffix}`, deletedAt: new Date() });
  // createOrganization's option type stops at customer/internal; the hidden
  // per-partner support org goes in through the privileged test handle, like
  // every other db-utils fixture (RLS-bypassing scaffolding).
  const [quickSupport] = await getTestDb()
    .insert(organizations)
    .values({ partnerId, name: `Quick Support ${suffix}`, slug: `quick-support-${suffix}`, type: 'quick_support' })
    .returning({ id: organizations.id });

  const other = await createIntegrationTestClient(app, { scope: 'partner' });

  return {
    app,
    client,
    partnerId,
    orgA: client.env.organization.id,
    orgB: orgB.id,
    orgC: orgC.id,
    quickSupportId: quickSupport!.id,
    deletedId: deleted.id,
    other,
    otherPartnerId: other.env.partner.id,
    orgD: other.env.organization.id,
    suffix,
  };
}

function readinessPath(orgIds: string[], partnerId?: string): string {
  const query = `orgIds=${orgIds.join(',')}` + (partnerId ? `&partnerId=${partnerId}` : '');
  return `/orgs/account-readiness?${query}`;
}

const ZERO_TICKETS = { open: 0, awaitingCustomer: 0, slaBreached: 0 };
const ALL_CAPABILITIES = {
  sites: true,
  devices: true,
  policies: true,
  contacts: true,
  portalUsers: true,
  invoices: true,
  tickets: true,
  integrations: false,
};

describe('GET /orgs/account-readiness', () => {
  runDb('computes every W02 signal for a partner token through the composed app', async () => {
    const board = await seedBoard();
    const { client, partnerId, orgA, orgB, orgC, suffix } = board;
    const site = client.env.site;
    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * 86_400_000);

    await getTestDb()
      .update(organizations)
      .set({ billingAddressLine1: '1 Main St', billingAddressCity: 'Springfield', billingAddressCountry: 'US' })
      .where(eq(organizations.id, orgA));

    // Seeds go through breeze_app's FORCE-RLS tables, so they run under system
    // scope on the app handle (same as orgSummary.integration.test.ts).
    const onlineDevice = await withSystemDbAccessContext(async () => {
      const [online] = await db
        .insert(devices)
        .values({
          orgId: orgA,
          siteId: site.id,
          agentId: `ar-online-${suffix}`,
          hostname: 'online-01',
          status: 'online',
          osType: 'linux',
          osVersion: '22.04',
          architecture: 'x86_64',
          agentVersion: '0.113.0',
          lastSeenAt: new Date('2026-08-01T00:00:00.000Z'),
        })
        .returning({ lastSeenAt: devices.lastSeenAt });
      await db.insert(devices).values([
        {
          orgId: orgA,
          siteId: site.id,
          agentId: `ar-offline-${suffix}`,
          hostname: 'offline-01',
          status: 'offline',
          osType: 'linux',
          osVersion: '22.04',
          architecture: 'x86_64',
          agentVersion: '0.113.0',
          lastSeenAt: null,
        },
        // Removed device with the FRESHEST check-in: must count for nothing.
        {
          orgId: orgA,
          siteId: site.id,
          agentId: `ar-gone-${suffix}`,
          hostname: 'gone-01',
          status: 'decommissioned',
          osType: 'linux',
          osVersion: '22.04',
          architecture: 'x86_64',
          agentVersion: '0.113.0',
          lastSeenAt: new Date(now),
        },
      ]);

      // Policies: A has an ACTIVE org-owned policy assigned at organization
      // level; B has an INACTIVE one assigned — which must not count.
      const [activePolicy] = await db
        .insert(configurationPolicies)
        .values({ orgId: orgA, partnerId: null, name: `Board active ${suffix}` })
        .returning({ id: configurationPolicies.id });
      const [inactivePolicy] = await db
        .insert(configurationPolicies)
        .values({ orgId: orgB, partnerId: null, name: `Board inactive ${suffix}`, status: 'inactive' })
        .returning({ id: configurationPolicies.id });
      await db.insert(configPolicyAssignments).values([
        { configPolicyId: activePolicy!.id, level: 'organization', targetId: orgA },
        { configPolicyId: inactivePolicy!.id, level: 'organization', targetId: orgB },
      ]);

      await db.insert(contacts).values([
        { orgId: orgA, name: `Ada Primary ${suffix}`, email: `ada-${suffix}@example.com`, phone: '555-0100', isPrimary: true, siteId: null },
        { orgId: orgA, name: `Bill Billing ${suffix}`, email: `bill-${suffix}@example.com`, roles: ['billing'] },
        // A site-level primary is never the org's primary contact.
        { orgId: orgA, siteId: site.id, name: `Site Primary ${suffix}`, email: `site-${suffix}@example.com`, isPrimary: true },
        // Org B: a primary with a name only — reachable by nothing; no billing role anywhere.
        { orgId: orgB, name: `Nameless Reach ${suffix}`, isPrimary: true, siteId: null },
        { orgId: orgB, name: `Tech ${suffix}`, email: `tech-${suffix}@example.com`, roles: ['technical'] },
      ]);

      await db.insert(portalUsers).values([
        { orgId: orgA, email: `stale-${suffix}@example.com`, status: 'active', invitedAt: daysAgo(10), lastLoginAt: null }, // counts
        { orgId: orgA, email: `fresh-${suffix}@example.com`, status: 'active', invitedAt: daysAgo(2), lastLoginAt: null }, // too recent
        { orgId: orgA, email: `signed-${suffix}@example.com`, status: 'active', invitedAt: daysAgo(10), lastLoginAt: daysAgo(1) }, // accepted
        { orgId: orgA, email: `off-${suffix}@example.com`, status: 'disabled', invitedAt: daysAgo(10), lastLoginAt: null }, // disabled
        { orgId: orgB, email: `off-b-${suffix}@example.com`, status: 'disabled', invitedAt: daysAgo(10), lastLoginAt: null },
      ]);

      const ticket = (n: number, extra: Partial<typeof tickets.$inferInsert>) => ({
        orgId: orgA,
        partnerId,
        ticketNumber: `AR-${suffix}-${n}`,
        subject: `Board ticket ${n}`,
        source: 'manual' as const,
        ...extra,
      });
      await db.insert(tickets).values([
        ticket(1, { status: 'new' }),
        ticket(2, { status: 'pending', slaBreachedAt: daysAgo(1) }),
        ticket(3, { status: 'on_hold' }),
        ticket(4, { status: 'closed', slaBreachedAt: daysAgo(1) }), // closed: excluded, breach and all
        ticket(5, { status: 'open', deletedAt: daysAgo(1) }), // soft-deleted: excluded
      ]);

      const invoice = (status: (typeof invoices.$inferInsert)['status'], dueDate: string, orgId = orgA) => ({
        partnerId,
        orgId,
        currencyCode: 'USD',
        status,
        dueDate,
        total: '100.00',
        amountPaid: '0.00',
      });
      await db.insert(invoices).values([
        invoice('sent', '2020-01-01'), // overdue
        invoice('overdue', '2020-02-01'), // overdue
        invoice('partially_paid', '2099-01-01'), // outstanding, not yet due
        invoice('paid', '2020-01-01'), // terminal
        invoice('void', '2020-01-01'), // terminal
        invoice('draft', '2020-01-01'), // never issued
        invoice('draft', '2020-01-01', orgB),
      ]);
      return online!;
    });

    const res = await client.get(readinessPath([orgA, orgB, orgC]));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json();

    expect(body.partnerId).toBe(partnerId);
    expect(body.serviceManagementMode).toBe('native');
    expect(body.capabilities).toEqual(ALL_CAPABILITIES);
    expect(body).not.toHaveProperty('connectors');
    expect(body.orgs.map((org: { orgId: string }) => org.orgId)).toEqual([orgA, orgB, orgC]);

    const [a, b, c] = body.orgs;
    expect(a).toEqual({
      orgId: orgA,
      type: 'customer',
      status: 'active',
      setup: { sites: 1, devices: 2, lastSeenAt: new Date(onlineDevice.lastSeenAt!).toISOString(), policyAssigned: true },
      account: {
        primaryContact: { name: `Ada Primary ${suffix}`, email: `ada-${suffix}@example.com`, phone: '555-0100', mobile: null },
        billingRoleContact: true,
        billingAddress: true,
        pendingInvitations: 1,
        overdueInvoices: 2,
      },
      tickets: { open: 3, awaitingCustomer: 1, slaBreached: 1 },
    });
    expect(a).not.toHaveProperty('integrations');
    expect(b).toEqual({
      orgId: orgB,
      type: 'internal',
      status: 'trial',
      setup: { sites: 0, devices: 0, lastSeenAt: null, policyAssigned: false },
      account: {
        primaryContact: { name: `Nameless Reach ${suffix}`, email: null, phone: null, mobile: null },
        billingRoleContact: false,
        billingAddress: false,
        pendingInvitations: 0,
        overdueInvoices: 0,
      },
      tickets: ZERO_TICKETS,
    });
    expect(c).toEqual({
      orgId: orgC,
      type: 'customer',
      status: 'active',
      setup: { sites: 0, devices: 0, lastSeenAt: null, policyAssigned: false },
      account: { primaryContact: null, billingRoleContact: false, billingAddress: false, pendingInvitations: 0, overdueInvoices: 0 },
      tickets: ZERO_TICKETS,
    });

    // The shape the spec ruled out is captured by orgRoutes' UUID guard —
    // the reason the path lives at /orgs/account-readiness.
    const shadowed = await client.get(`/orgs/organizations/account-readiness?orgIds=${orgA}`);
    expect(shadowed.status).toBe(404);
    expect(await shadowed.json()).toEqual({ error: 'Organization not found' });
  });
});
```

(The imports `partners`, `partnerUsers`, `users`, `createAccessToken`, `TokenPayload`, `clearPermissionCache`, `PERMISSIONS`, `and`, `assignUserToPartner`, `createRole`, `createUser`, `grantRolePermissions` are used by Task 6's tests; eslint's unused-import rule is satisfied once Task 6 lands. Keep them: `eslint` reports them as unused only until Task 6 is appended in the same PR.)

- [ ] **Step 4: Run it to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgAccountReadiness.integration.test.ts`
Expected: FAIL only if the route or service is wrong — this is the first real-SQL run. A typical first red is a seed-row constraint (e.g. a missing NOT NULL column); fix the seed, not the assertion. If everything is right on the first run, it passes — that is acceptable for an integration proof of already-unit-tested code; do NOT loosen an assertion to see red.

- [ ] **Step 5: Make it pass**

Adjust the route/service only if the SQL behaves differently from the unit-mocked expectation (e.g. `bool_or` arriving as `'t'` — `toBool` already tolerates it). Re-run until green.

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgAccountReadiness.integration.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/index.ts apps/api/src/__tests__/integration/orgAccountReadiness.integration.test.ts
git commit -m "feat(api): mount /orgs/account-readiness; real-Postgres signal matrix through the composed app (#5721 W01)"
```

---

### Task 6: Integration — access resolution, partner-level policy rule, system scope, mode and permission gates

**Files:**
- Modify: `apps/api/src/__tests__/integration/orgAccountReadiness.integration.test.ts` (append five `runDb` cases inside the existing `describe`)

**Interfaces:**
- Consumes: `seedBoard`, `readinessPath`, `buildApp`, `ZERO_TICKETS`, `ALL_CAPABILITIES`, the `Board` fields (Task 5); `partnerUsers.orgIds` (uuid[] on `partner_users`) — how `authMiddleware` derives `accessibleOrgIds` for `org_access = 'selected'`; `users.isPlatformAdmin` — `authMiddleware` rejects a `scope: 'system'` token unless the live user row is a platform admin; `partners.serviceManagementMode`.
- Produces: nothing new — coverage.

- [ ] **Step 1: Append the failing tests**

Inside `describe('GET /orgs/account-readiness', …)`, after the Task 5 case, add:

```ts
  runDb('a partner-level assignment of an ACTIVE policy marks every org of that partner only', async () => {
    const board = await seedBoard();
    const { client, other, partnerId, orgA, orgB, orgD, suffix } = board;

    const assigned = async () => {
      const res = await client.get(readinessPath([orgA, orgB]));
      expect(res.status).toBe(200);
      return (await res.json()).orgs.map((org: { setup: { policyAssigned: boolean } }) => org.setup.policyAssigned);
    };

    expect(await assigned()).toEqual([false, false]);

    // An inactive partner-wide policy assigned at partner level counts for nothing.
    const inactiveId = await withSystemDbAccessContext(async () => {
      const [policy] = await db
        .insert(configurationPolicies)
        .values({ orgId: null, partnerId, name: `Board partner-wide inactive ${suffix}`, status: 'inactive' })
        .returning({ id: configurationPolicies.id });
      await db.insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level: 'partner', targetId: partnerId });
      return policy!.id;
    });
    expect(await assigned()).toEqual([false, false]);

    // Activating it flips every org of the partner at once.
    await withSystemDbAccessContext(() =>
      db.update(configurationPolicies).set({ status: 'active' }).where(eq(configurationPolicies.id, inactiveId)),
    );
    expect(await assigned()).toEqual([true, true]);

    // The other partner's org is untouched by this partner's rule.
    const otherRes = await other.get(readinessPath([orgD]));
    expect((await otherRes.json()).orgs[0].setup.policyAssigned).toBe(false);
  });

  runDb('drops unknown, deleted, quick_support and foreign-partner ids silently; a selected-access colleague loses the sibling too', async () => {
    const board = await seedBoard();
    const { app, client, other, partnerId, orgA, orgB, orgC, orgD, quickSupportId, deletedId, suffix } = board;
    const unknownId = randomUUID();

    const res = await client.get(readinessPath([orgD, unknownId, deletedId, quickSupportId, orgC, orgA]));
    expect(res.status).toBe(200);
    // Request order is kept; everything that did not resolve is simply absent.
    expect((await res.json()).orgs.map((org: { orgId: string }) => org.orgId)).toEqual([orgC, orgA]);

    // A colleague at the same partner whose org_access is 'selected' = {A}.
    const restricted = await createUser({ partnerId, email: `restricted-${suffix}@example.com` });
    const role = await createRole({ scope: 'partner', partnerId });
    await grantRolePermissions(role.id, [{ resource: '*', action: '*' }]);
    await assignUserToPartner(restricted.id, partnerId, role.id, 'selected');
    await getTestDb()
      .update(partnerUsers)
      .set({ orgIds: [orgA] })
      .where(and(eq(partnerUsers.userId, restricted.id), eq(partnerUsers.partnerId, partnerId)));
    const restrictedToken = await createAccessToken({
      sub: restricted.id,
      email: restricted.email,
      roleId: role.id,
      orgId: null,
      partnerId,
      scope: 'partner',
      mfa: false,
      aep: 1,
      mep: 1,
      sid: randomUUID(),
    } satisfies Omit<TokenPayload, 'type'>);

    const restrictedRes = await app.request(readinessPath([orgA, orgB, orgC]), {
      headers: { Authorization: `Bearer ${restrictedToken}` },
    });
    expect(restrictedRes.status).toBe(200); // never 403 for a dropped sibling
    expect((await restrictedRes.json()).orgs.map((org: { orgId: string }) => org.orgId)).toEqual([orgA]);

    // The foreign partner's own token sees only its own org, whatever it asks for.
    const otherRes = await other.get(readinessPath([orgA, orgD]));
    expect(otherRes.status).toBe(200);
    expect((await otherRes.json()).orgs.map((org: { orgId: string }) => org.orgId)).toEqual([orgD]);
  });

  runDb("system scope requires partnerId and returns only the named partner's orgs", async () => {
    const board = await seedBoard();
    const { app, client, partnerId, otherPartnerId, orgA, orgB, orgC, orgD } = board;
    const { user, role } = client.env;

    // authMiddleware binds scope='system' to the LIVE is_platform_admin flag
    // (SR2-02), so promote the fixture user before minting the token.
    await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, user.id));
    await clearPermissionCache(user.id);
    const systemToken = await createAccessToken({
      sub: user.id,
      email: user.email,
      roleId: role.id,
      orgId: null,
      partnerId: null,
      scope: 'system',
      mfa: false,
      aep: 1,
      mep: 1,
      sid: randomUUID(),
    } satisfies Omit<TokenPayload, 'type'>);
    const get = (path: string) => app.request(path, { headers: { Authorization: `Bearer ${systemToken}` } });

    const missing = await get(readinessPath([orgA]));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'partnerId is required for system scope' });

    const mixed = await get(readinessPath([orgD, orgA, orgB, orgC], partnerId));
    expect(mixed.status, await mixed.clone().text()).toBe(200);
    const mixedBody = await mixed.json();
    expect(mixedBody.partnerId).toBe(partnerId);
    expect(mixedBody.orgs.map((org: { orgId: string }) => org.orgId)).toEqual([orgA, orgB, orgC]);

    const otherOnly = await get(readinessPath([orgD, orgA], otherPartnerId));
    expect(otherOnly.status).toBe(200);
    expect((await otherOnly.json()).orgs.map((org: { orgId: string }) => org.orgId)).toEqual([orgD]);
  });

  runDb('withholds tickets and invoices when the partner is not in native service-management mode', async () => {
    const board = await seedBoard();
    const { client, partnerId, orgA } = board;
    // 'off' rather than 'external': partners_service_management_connection_chk
    // requires a PSA connection id whenever the mode is 'external'.
    await getTestDb().update(partners).set({ serviceManagementMode: 'off' }).where(eq(partners.id, partnerId));

    const res = await client.get(readinessPath([orgA]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.serviceManagementMode).toBe('off');
    expect(body.capabilities).toEqual({ ...ALL_CAPABILITIES, invoices: false, tickets: false });
    expect(body.orgs[0]).not.toHaveProperty('tickets');
    expect(body.orgs[0].account).not.toHaveProperty('overdueInvoices');
    expect(body.orgs[0].account).toHaveProperty('pendingInvitations');
  });

  runDb('a caller with only organizations:read gets policies and contacts, nothing else', async () => {
    const app = buildApp();
    const client = await createIntegrationTestClient(app, { scope: 'partner', rolePermissions: [PERMISSIONS.ORGS_READ] });
    const orgId = client.env.organization.id;

    const res = await client.get(readinessPath([orgId]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.capabilities).toEqual({
      sites: false,
      devices: false,
      policies: true,
      contacts: true,
      portalUsers: false,
      invoices: false,
      tickets: false,
      integrations: false,
    });
    expect(body.orgs[0]).toEqual({
      orgId,
      type: 'customer',
      status: 'active',
      setup: { policyAssigned: false },
      account: { primaryContact: null, billingRoleContact: false, billingAddress: false },
    });
  });
```

- [ ] **Step 2: Run to verify the new cases fail or pass for the right reason**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgAccountReadiness.integration.test.ts`
Expected: 6 tests run. Each new case exercises code that Tasks 2–5 already implemented, so a green run is the expected outcome; a red one names a real defect (most likely candidates: the restricted user's token rejected by `authMiddleware` — check `assignUserToPartner` ran before `partnerUsers.orgIds` was set; or the system token 403ing — check the `isPlatformAdmin` update landed before the request). Fix the defect, never the assertion.

- [ ] **Step 3: Run the whole W01 test set once more**

Run:
```bash
cd apps/api \
  && npx vitest run src/services/openWorkStatuses.test.ts src/services/orgAccountReadiness.test.ts src/routes/orgAccountReadiness.test.ts src/routes/orgSummary.test.ts \
  && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgAccountReadiness.integration.test.ts src/__tests__/integration/orgSummary.integration.test.ts \
  && npx tsc --noEmit \
  && npx eslint src/routes/orgAccountReadiness.ts src/services/orgAccountReadiness.ts src/services/openWorkStatuses.ts src/__tests__/integration/orgAccountReadiness.integration.test.ts
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/orgAccountReadiness.integration.test.ts
git commit -m "test(api): account readiness — access resolution, partner-level policy rule, system scope, mode and permission gates (#5721 W01)"
```

---

### Task 7: Verification — 200-org fan-out, `EXPLAIN ANALYZE` as `breeze_app`, full suites, PR

**Files:**
- No source changes. Evidence goes into the PR description under `## Query plan evidence`; follow-up issues are filed for any expected-but-unindexed scan.

**Interfaces:**
- Consumes: the private test stack from Task 5 (`.env.test` at the repo root), the migrated `breeze_test` database (migrations were applied by the integration `setup.ts` in Tasks 5–6).

- [ ] **Step 1: Run the complete unit suite (the fixer-sweep trap: touched files ≠ CI)**

Run: `cd apps/api && npx vitest run`
Expected: green. Pay attention to `partner-wide-write-coverage.test.ts` (W01 has no writers — must stay green without an allowlist change), `composeBindMounts.test.ts` and `migrationRlsScope.test.ts` (no migration in this wave — nothing to add to any baseline).

- [ ] **Step 2: Seed the fan-out as the privileged test role**

Run **after** the integration suite (its `beforeEach` truncates the tenant tables, so the seed must come last and nothing may run tests in between):

```bash
cd "$(git rev-parse --show-toplevel)"
PGPORT=$(sed -n 's#^DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:\([0-9]*\)/breeze_test$#\1#p' .env.test)
SUPER_URL="postgresql://breeze_test:breeze_test@localhost:${PGPORT}/breeze_test"
APP_URL="postgresql://breeze_app:breeze_test@localhost:${PGPORT}/breeze_test"
echo "port=$PGPORT"
# No local psql? Use the stack's own: docker compose -p "$(sed -n 's/^# compose project: \([^ ]*\).*/\1/p' .env.test)" -f docker-compose.test.yml exec -T postgres-test psql -U breeze_test -d breeze_test   (and -U breeze_app for the EXPLAIN session)

psql "$SUPER_URL" -v ON_ERROR_STOP=1 <<'SQL'
-- 10 partners x 200 orgs = 2,000 orgs. Partner 1 is the measured one; the
-- other nine are selectivity noise so the planner has a real reason to prefer
-- an org_id index over a sequential scan on a table it would otherwise read
-- whole. Elect system scope first: 425 of 442 tables FORCE RLS on the owner.
SELECT set_config('breeze.scope', 'system', false);

INSERT INTO partners (id, name, slug, type, plan, status)
SELECT ('00000000-0000-4000-8000-' || lpad(p::text, 12, '0'))::uuid,
       'Plan evidence partner ' || p, 'plan-evidence-' || p, 'msp', 'pro', 'active'
FROM generate_series(1, 10) p;

INSERT INTO organizations (partner_id, name, slug, type, status,
                           billing_address_line1, billing_address_city, billing_address_country)
SELECT ('00000000-0000-4000-8000-' || lpad(p::text, 12, '0'))::uuid,
       'Evidence org ' || p || '-' || o, 'evidence-org-' || p || '-' || o, 'customer', 'active',
       CASE WHEN o % 3 = 0 THEN NULL ELSE '1 Main St' END, 'Springfield', 'US'
FROM generate_series(1, 10) p, generate_series(1, 200) o;

CREATE TEMP TABLE ev_orgs AS
  SELECT o.id, o.partner_id, row_number() OVER (ORDER BY o.id) AS n
  FROM organizations o JOIN partners p ON p.id = o.partner_id
  WHERE p.slug LIKE 'plan-evidence-%';

INSERT INTO sites (org_id, name)
SELECT o.id, 'Site ' || s FROM ev_orgs o, generate_series(1, 2) s;

CREATE TEMP TABLE ev_sites AS
  SELECT DISTINCT ON (org_id) id, org_id FROM sites
  WHERE org_id IN (SELECT id FROM ev_orgs) ORDER BY org_id, id;

-- 25 devices per org (50,000 rows): every 10th decommissioned (with the
-- freshest check-in, so a wrong population would show), every 4th never seen.
INSERT INTO devices (org_id, site_id, agent_id, hostname, status, os_type, os_version, architecture, agent_version, last_seen_at)
SELECT s.org_id, s.id, 'ev-' || s.org_id || '-' || d, 'host-' || d,
       CASE WHEN d % 10 = 0 THEN 'decommissioned' ELSE 'online' END::device_status,
       'linux'::os_type, '22.04', 'x86_64', '0.113.0',
       CASE WHEN d % 10 = 0 THEN now()
            WHEN d % 4 = 0 THEN NULL
            ELSE now() - (d || ' days')::interval END
FROM ev_sites s, generate_series(1, 25) d;

-- 4 contacts per org: #1 is the org-level primary (every 5th org unreachable), #2 carries the billing role.
INSERT INTO contacts (org_id, name, email, phone, is_primary, roles)
SELECT o.id, 'Contact ' || c, 'c' || c || '-' || o.n || '@example.com',
       CASE WHEN c = 1 AND o.n % 5 = 0 THEN NULL ELSE '555-0100' END,
       c = 1,
       CASE WHEN c = 2 THEN ARRAY['billing'] ELSE ARRAY[]::text[] END
FROM ev_orgs o, generate_series(1, 4) c;

INSERT INTO portal_users (org_id, email, status, invited_at, last_login_at)
SELECT o.id, 'pu' || u || '-' || o.n || '@example.com', 'active',
       now() - interval '10 days', CASE WHEN u = 1 THEN NULL ELSE now() END
FROM ev_orgs o, generate_series(1, 3) u;

-- 15 tickets per org (30,000 rows) across every status; every 5th SLA-breached.
INSERT INTO tickets (org_id, partner_id, ticket_number, subject, source, status, sla_breached_at)
SELECT o.id, o.partner_id, 'EV-' || o.n || '-' || t, 'Ticket ' || t, 'manual',
       (ARRAY['new','open','pending','on_hold','resolved','closed'])[1 + t % 6]::ticket_status,
       CASE WHEN t % 5 = 0 THEN now() ELSE NULL END
FROM ev_orgs o, generate_series(1, 15) t;

-- 10 invoices per org (20,000 rows) across every status; due dates straddle today.
INSERT INTO invoices (org_id, partner_id, invoice_number, currency_code, status, due_date, total, amount_paid)
SELECT o.id, o.partner_id, 'EV-' || o.n || '-' || i, 'USD',
       (ARRAY['draft','sent','partially_paid','overdue','paid','void'])[1 + i % 6]::invoice_status,
       CURRENT_DATE + 30 - (i * 10), 100.00, 0.00
FROM ev_orgs o, generate_series(1, 10) i;

-- One partner-wide policy per partner; org-level assignments for every even
-- org; partner-level assignments for partners 2..10 only, so partner 1's
-- per-org branch is what gets measured.
INSERT INTO configuration_policies (id, partner_id, org_id, name, status)
SELECT ('00000000-0000-4000-a000-' || lpad(p::text, 12, '0'))::uuid,
       ('00000000-0000-4000-8000-' || lpad(p::text, 12, '0'))::uuid, NULL,
       'Evidence baseline ' || p, 'active'
FROM generate_series(1, 10) p;

INSERT INTO config_policy_assignments (config_policy_id, level, target_id)
SELECT ('00000000-0000-4000-a000-' || lpad(p::text, 12, '0'))::uuid, 'organization', o.id
FROM ev_orgs o
JOIN generate_series(1, 10) p ON o.partner_id = ('00000000-0000-4000-8000-' || lpad(p::text, 12, '0'))::uuid
WHERE o.n % 2 = 0;

INSERT INTO config_policy_assignments (config_policy_id, level, target_id)
SELECT ('00000000-0000-4000-a000-' || lpad(p::text, 12, '0'))::uuid, 'partner',
       ('00000000-0000-4000-8000-' || lpad(p::text, 12, '0'))::uuid
FROM generate_series(2, 10) p;

ANALYZE;
SELECT (SELECT count(*) FROM devices) AS devices, (SELECT count(*) FROM tickets) AS tickets,
       (SELECT count(*) FROM invoices) AS invoices, (SELECT count(*) FROM contacts) AS contacts;
SQL
```

Expected: the final line reports `devices ≥ 50000`, `tickets ≥ 30000`, `invoices ≥ 20000`, `contacts ≥ 8000`. If an INSERT fails on a NOT NULL / CHECK constraint that a later migration added, supply that column in the seed (do not touch a migration).

- [ ] **Step 3: Record the plans as `breeze_app` under a partner-scope RLS context**

The GUCs below are exactly what `applyAccessContextGucs` (`apps/api/src/db/index.ts`) sets for a partner request: comma-joined ids, `'*'` never (that is system scope).

```bash
PARTNER='00000000-0000-4000-8000-000000000001'
ORG_IDS=$(psql "$SUPER_URL" -At -c "SELECT string_agg(id::text, ',' ORDER BY id) FROM organizations WHERE partner_id = '$PARTNER'")
echo "$ORG_IDS" | tr ',' '\n' | wc -l   # must print 200
OUT="${TMPDIR:-/tmp}/account-readiness-plans.txt"

psql "$APP_URL" -v ON_ERROR_STOP=1 -v org_ids="$ORG_IDS" -v partner="$PARTNER" <<'SQL' | tee "$OUT"
BEGIN;
SELECT set_config('breeze.scope', 'partner', true);
SELECT set_config('breeze.org_id', '', true);
SELECT set_config('breeze.accessible_org_ids', :'org_ids', true);
SELECT set_config('breeze.accessible_partner_ids', :'partner', true);
SELECT set_config('breeze.user_id', '', true);
SELECT set_config('breeze.current_partner_id', :'partner', true);
SELECT current_user, public.breeze_current_scope(), cardinality(public.breeze_accessible_org_ids()) AS accessible;

\echo === sites
EXPLAIN (ANALYZE, BUFFERS)
SELECT org_id, count(*) FROM sites
WHERE org_id = ANY (string_to_array(:'org_ids', ',')::uuid[])
GROUP BY org_id;

\echo === devices
EXPLAIN (ANALYZE, BUFFERS)
SELECT org_id, count(*), max(last_seen_at) FROM devices
WHERE org_id = ANY (string_to_array(:'org_ids', ',')::uuid[]) AND status <> 'decommissioned'
GROUP BY org_id;

\echo === config_policy_assignments
EXPLAIN (ANALYZE, BUFFERS)
SELECT a.level, a.target_id
FROM config_policy_assignments a
JOIN configuration_policies p ON p.id = a.config_policy_id
WHERE p.status = 'active'
  AND ((a.level = 'organization' AND a.target_id = ANY (string_to_array(:'org_ids', ',')::uuid[]))
    OR (a.level = 'partner' AND a.target_id = :'partner'::uuid))
GROUP BY a.level, a.target_id;

\echo === contacts
EXPLAIN (ANALYZE, BUFFERS)
SELECT org_id,
       bool_or(is_primary AND site_id IS NULL),
       max(name)   FILTER (WHERE is_primary AND site_id IS NULL),
       max(email)  FILTER (WHERE is_primary AND site_id IS NULL),
       max(phone)  FILTER (WHERE is_primary AND site_id IS NULL),
       max(mobile) FILTER (WHERE is_primary AND site_id IS NULL),
       bool_or(roles @> ARRAY['billing']::text[])
FROM contacts
WHERE org_id = ANY (string_to_array(:'org_ids', ',')::uuid[])
GROUP BY org_id;

\echo === portal_users
EXPLAIN (ANALYZE, BUFFERS)
SELECT org_id, count(*) FROM portal_users
WHERE org_id = ANY (string_to_array(:'org_ids', ',')::uuid[])
  AND status <> 'disabled' AND last_login_at IS NULL
  AND invited_at < (now() AT TIME ZONE 'utc') - interval '7 days'
GROUP BY org_id;

\echo === tickets
EXPLAIN (ANALYZE, BUFFERS)
SELECT org_id, count(*),
       count(*) FILTER (WHERE status = 'pending'),
       count(*) FILTER (WHERE sla_breached_at IS NOT NULL)
FROM tickets
WHERE org_id = ANY (string_to_array(:'org_ids', ',')::uuid[])
  AND deleted_at IS NULL
  AND status IN ('new', 'open', 'pending', 'on_hold')
GROUP BY org_id;

\echo === invoices
EXPLAIN (ANALYZE, BUFFERS)
SELECT org_id, count(*) FROM invoices
WHERE org_id = ANY (string_to_array(:'org_ids', ',')::uuid[])
  AND status IN ('sent', 'partially_paid', 'overdue')
  AND due_date < CURRENT_DATE
GROUP BY org_id;

ROLLBACK;
SQL
```

Expected: the header row prints `breeze_app | partner | 200`. Seven plans follow.

- [ ] **Step 4: Read the plans against the gate**

For each `=== <table>` block, find the node that scans that table:

- **Passes** when it is `Index Scan using <index> on <table>`, `Index Only Scan using <index> on <table>`, or a `Bitmap Heap Scan on <table>` fed by `Bitmap Index Scan on <index>` — and the index line carries `Index Cond: (org_id = ANY ('{…}'::uuid[]))` (for `config_policy_assignments`: `Index Cond: ((level = …) AND (target_id = ANY …))` on `config_assignments_level_target_idx`). The RLS predicate shows up as `Filter: breeze_has_org_access(org_id)` (leakproof, so it never blocks the index condition) — that is expected.
- **Fails** when the scanning node is `Seq Scan on <table>` with `org_id` only in a `Filter:` line.

The gate (spec "Measured, not promised"): **devices, invoices and tickets must pass** — they are the per-row histories. Expected indexes: `devices_org_id_status_idx` or `devices_org_id_last_seen_at_idx` (either is keyed on `org_id`; record which one the planner picked), `invoices_org_status_idx`, `tickets_org_status_idx`. `contacts` is expected to pass on `contacts_org_idx` and `config_policy_assignments` on `config_assignments_level_target_idx`. **`sites` and `portal_users` have no `org_id`-leading index today** (`sites_id_org_id_uniq` leads with `id`); a `Seq Scan` there is the expected result at this size and is not gated. Record it, and open one follow-up issue titled "sites / portal_users: org_id index for the account-readiness aggregates" quoting the two plans — a migration belongs to a later wave, not W01.

If devices, invoices or tickets fail the gate, do not tune the seed and do not set `enable_seqscan`; re-check the row counts from Step 2 (the noise partners must be present), re-run `ANALYZE`, and if it still sequential-scans, that is a finding: report it in the PR and stop — do not merge on a failed gate.

- [ ] **Step 5: Tear down the stack**

Run (repo root): `pnpm test-stack down`
Expected: the private compose project is gone (`pnpm test-stack ls` no longer lists it; `docker compose ls -a` shows nothing for this worktree).

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feature/5721-organizations-account-board/wave-5722
gh pr create --title "feat(api): GET /orgs/account-readiness — Organizations account board W01" --body-file - <<'BODY'
## Summary

`GET /orgs/account-readiness` — the bulk read behind the Organizations account board (spec `docs/superpowers/specs/web-ui/2026-09-13-organizations-account-board-design.md`, W01 row). One request computes every W02 Setup / Account-data / Open-tickets signal for up to 200 of a partner's orgs.

- `services/orgAccountReadiness.ts`: `resolveAcceptedOrgs` (ids resolved against organization rows: partner, live, not quick_support, partner-scope intersection) and `loadAccountReadiness` (one grouped aggregate per domain under `Promise.all` inside the request context; ungated sections cost no query).
- `routes/orgAccountReadiness.ts`: `orgIds` 1–200 UUIDs, `partnerId` required for system scope / ignored for partner scope, capabilities from grants + service-management mode, spec-exact response shape (`integrations`/`connectors` typed, W03).
- Mounted at `/orgs/account-readiness` after `orgSummaryRoutes`; composed-app path proven with the real `orgRoutes` mounted first.
- `services/openWorkStatuses.ts`: the open ticket/invoice vocabulary shared with `orgSummary.ts`.
- No new tables, columns, migrations or indexes.

## Tests

- Unit: `services/openWorkStatuses.test.ts`, `services/orgAccountReadiness.test.ts` (compiled-predicate assertions), `routes/orgAccountReadiness.test.ts` (validation, cap, dedupe, scope/partner pinning, every capability gate, shaping, composed-app path).
- Integration (real Postgres): signal matrix, inactive/active partner-level policy rule, site-level-primary exclusion, invitation aging, invoice statuses, decommissioned exclusion, unknown/deleted/quick_support/foreign-partner ids dropped, selected-access sibling dropped without 403, system scope `partnerId`, mode gate, permission-trimmed caller.

## Query plan evidence (breeze_app, partner scope, 200 accepted ids, 2,000-org / 50k-device seed)

| Domain | Scan node | Index | Actual rows | Time |
|---|---|---|---|---|
| sites | <paste> | <paste or "none (Seq Scan, expected — follow-up #…)"> | | |
| devices | | | | |
| config_policy_assignments | | | | |
| contacts | | | | |
| portal_users | | | | |
| tickets | | | | |
| invoices | | | | |

<details><summary>Full EXPLAIN (ANALYZE, BUFFERS) output</summary>

```
<paste the contents of $OUT>
```

</details>

Closes #5722

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01XwpzwosHy6AMBfaR6owRjN
BODY
```

Fill the table from `$OUT` before submitting. Then run the review pass (`/pr-review-toolkit:review-pr`, one round), act only on confirmed findings, and enqueue with `gh pr merge <N>` once `CI Success` is green — never `--admin`. When it lands: `complete_wave` for `5722`.

---

## Self-review notes

**Spec coverage.** API section: path + sibling router + mount + composed-app test (Tasks 4–5); scope/permission (Task 4); `orgIds` 1–200 + 400s (Task 4); `partnerId` system/partner rule (Task 4, integration Task 6); accepted-id resolution incl. partner-scope intersection and `quick_support` (Task 2, integration Task 6); response shape and capabilities (Task 4); implementation rules — service owns queries, one aggregate per domain, `Promise.all` orchestration only, freshness over the non-decommissioned population, no `audit_logs`, request context only, no new tables (Task 3 + Global Constraints); measured plans (Task 7); route-test list — malformed ids, cap, partner-scope intersection, system scope without `partnerId`, mixed partners, unknown/deleted ids, `quick_support` exclusion, every capability gate, composed-app path (Tasks 4 and 6). Setup cell inputs: sites, devices, `lastSeenAt`, `policyAssigned` with the org-or-partner-level active-policy rule (Task 3). Account cell inputs: primary contact fields incl. `mobile`, billing role via `roles @> '{billing}'`, billing address triple, overdue invoices with the exact status set, invitation aging (Task 3). Tickets cell: open set, `pending`, `sla_breached_at` (Task 3). Testing section: API unit + integration (seeded partner with three orgs plus a second partner, each rule asserted, restricted sibling and foreign-partner dropped) + `EXPLAIN ANALYZE` evidence (Tasks 5–7). Applicability rules themselves are W02 client logic; the API carries `type`, `status` and `serviceManagementMode` for it. Integrations/connectors: typed, not implemented — W03.

**Placeholder scan.** The only placeholders are `5721` / `5722` (issue numbers `register_feature` assigns) and the PR-body cells the executor fills from `$OUT`. No "TBD", no "similar to".

**Type consistency.** `AcceptedOrg`, `ResolveAcceptedOrgsInput`, `ReadinessSections`, `PrimaryContact`, `TicketCounts`, `OrgReadinessSignals`, `LoadAccountReadinessInput`, `OrgType` are declared once in Task 2 and consumed unchanged in Tasks 3–4; `sqlStatusList` / `TICKET_OPEN_STATUSES` / `INVOICE_OPEN_STATUSES` (Task 1) are the names Task 3 imports; `parseOrgIdsParam`, `MAX_ACCOUNT_READINESS_ORG_IDS`, `orgAccountReadinessRoutes` (Task 4) are the names Tasks 5–6 import; the integration helpers `seedBoard`, `readinessPath`, `buildApp`, `ZERO_TICKETS`, `ALL_CAPABILITIES` (Task 5) are the names Task 6 uses.

## Ambiguities resolved (plan wins over spec where it is more specific)

1. **Order of `orgs`:** the spec is silent; the response keeps the request order after de-duplication, so the web can zip a batch back onto its rows.
2. **Repeated ids:** collapsed (first occurrence wins, lower-cased); the 200 cap counts entries as sent.
3. **Malformed `partnerId` (system scope):** 400 `partnerId must be a UUID`, distinct from the missing-case wording the list endpoint already uses.
4. **"One grouped query per domain" for contacts:** a single `GROUP BY org_id` statement using `bool_or` and `max(col) FILTER (WHERE is_primary AND site_id IS NULL)`; correctness rests on the existing partial unique index `contacts_org_primary_uniq`. Policies likewise use one statement covering both assignment levels, grouped by `(level, target_id)`.
5. **Service-management mode read:** the existing `getServiceManagementMode` (fails open to `native`, reads `partners` under the request context — the table's SELECT policy admits the caller's own partner), rather than a new system-context read.
6. **Invitation clock:** `invited_at < (now() AT TIME ZONE 'utc') - interval '7 days'` because `portal_users.invited_at` is a naive UTC `timestamp`; comparing against `now()` would let the session time zone move the boundary.
7. **Device freshness index:** the spec names `devices_org_id_last_seen_at_idx`; with `status <> 'decommissioned'` in the predicate the planner may pick `devices_org_id_status_idx` instead. Both are keyed on `org_id`; the gate is "index scan keyed on org_id" and the evidence records which one was chosen.
8. **`sites` / `portal_users` plans:** neither table has an `org_id`-leading index, so a sequential scan is expected and not gated; a follow-up issue is filed rather than a migration (no migrations in W01).
9. **Open-status vocabulary:** extracted into `services/openWorkStatuses.ts` and imported by `orgSummary.ts` (behaviour-preserving) instead of duplicating the arrays.
10. **Mode-gate integration case uses `'off'`, not `'external'`:** `partners_service_management_connection_chk` requires a PSA connection id whenever the mode is `'external'`; `'off'` exercises the same `!= 'native'` branch without a fixture connection.
11. **Composed-app proof:** `apps/api/src/index.ts` exports nothing importable, so the unit test mounts a stand-in router owning `/organizations/:id` first and the integration test mounts the real `orgRoutes` first (index.ts order); both prove `/orgs/account-readiness` is not shadowed and pin that `/orgs/organizations/account-readiness` would be.
12. **Partner-scope token with an unresolved `accessibleOrgIds`:** treated as an empty list (nothing accepted), never as unrestricted.

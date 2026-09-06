# QuickBooks Customer and Item Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable, tenant-safe QuickBooks Customer and Item reconciliation so a partner can confirm an existing QuickBooks match or create/update the remote entity before invoice push is enabled.

**Architecture:** Add a provider-neutral `accounting_entity_mappings` table beside `accounting_connections`, with partner-axis RLS, two-way uniqueness, SyncToken persistence, and a database trigger that rejects cross-partner polymorphic entity references. A focused reconciliation service compares Breeze organizations/catalog items with QuickBooks Customers/Items, preserves existing `organization_external_links` imports as confirmed mappings, and performs explicit upserts only after user confirmation. The existing QuickBooks integration page gains a mapping workbench and default-income-account selector; Phase C will consume the confirmed mapping service without changing core billing tables.

**Tech Stack:** PostgreSQL + hand-written SQL migrations, Drizzle ORM, Hono + Zod, TypeScript, Vitest, React, i18next, QuickBooks Online Accounting API v3.

## Global Constraints

- `accounting_entity_mappings` is partner-axis RLS shape 3: enable and force RLS in the creating migration and use `breeze_has_partner_access(partner_id)` for SELECT/INSERT/UPDATE/DELETE.
- Never add QuickBooks IDs or sync fields to `organizations`, `catalog_items`, `invoices`, or `invoice_payments`.
- Keep `organization_external_links` as generic import provenance; seed a confirmed accounting mapping from a same-partner `system='quickbooks'` link when reconciliation first sees it.
- Enforce uniqueness on both `(integration_id, breeze_entity_type, breeze_entity_id)` and the non-null remote key `(integration_id, remote_entity_type, remote_entity_id)`.
- The database must reject a mapping whose Breeze entity belongs to another partner; service-layer checks are not sufficient.
- A suggested match never writes to QuickBooks. Only an explicit `confirmed` or `create_new` user decision may call `upsertCustomer` or `upsertItem`.
- Resolve every QBO data call through `getValidAccessToken`; run network calls through `runOutsideDbContext` so no database connection is held across HTTP.
- QuickBooks sparse updates must send the current `Id` and `SyncToken`; persist the response SyncToken after every create/update.
- Creating a QuickBooks Item requires `accounting_connections.default_income_account_ref`; return a user-facing 409 when it is missing.
- Map Breeze `service` catalog items to QBO `Service`; map `hardware` and `software` to `NonInventory`. Inventory tracking is out of scope.
- Mutating routes require partner/system scope, MFA, and the entity-specific permission: `ORGS_WRITE` for Customer mappings and `CATALOG_WRITE` for Item mappings; all web mutations use `runAction`.
- Hand-write migrations in `apps/api/migrations/` using `YYYY-MM-DD-<slug>.sql`; make every statement idempotent and never add inner `BEGIN`/`COMMIT`.
- Tests must cover happy path, auth/authz, validation, cross-partner isolation, conflict/error behavior, idempotency, and empty/ambiguous matches.
- UI selectors use kebab-case `data-testid` attributes.
- Phase B does not enqueue invoice jobs, push invoices, void invoices, process webhooks, or reconcile payments.

---

## File Structure

- `apps/api/migrations/2026-08-29-quickbooks-entity-mappings.sql` — create the mapping table, indexes, entity-ownership trigger, RLS policies, grants, and existing-link backfill.
- `apps/api/src/db/schema/accounting.ts` — declare `accountingEntityMappings` and its inferred types.
- `apps/api/src/__tests__/integration/accounting-entity-mappings-rls.integration.test.ts` — prove same-partner access, cross-partner forge rejection, uniqueness, and cascade behavior using real Postgres.
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — register the new shape-3 table.
- `apps/api/src/services/accounting/types.ts` — replace variadic provider stubs with typed customer/item/account inputs and outputs.
- `apps/api/src/services/accounting/quickbooksProvider.ts` — list QBO Items/income Accounts and create/sparse-update Customers and Items.
- `apps/api/src/services/accounting/quickbooksProvider.test.ts` — verify paging, payload mapping, SyncToken updates, API errors, and no DB work during HTTP.
- `apps/api/src/services/accounting/accountingMappingService.ts` — deterministic proposal, confirmation, create/update, mapping persistence, and imported-customer compatibility.
- `apps/api/src/services/accounting/accountingMappingService.test.ts` — unit-test matching, ownership checks, state transitions, and idempotency.
- `apps/api/src/routes/accounting/index.ts` — mount read/propose/confirm/sync/account endpoints with validation and authorization.
- `apps/api/src/routes/accounting/mappings.test.ts` — route tests for scope, permission, MFA, validation, and service error mapping.
- `apps/web/src/components/integrations/QuickbooksMappingWorkbench.tsx` — customer/item tabs, suggestions, decisions, sync actions, status/error display, and income-account selector.
- `apps/web/src/components/integrations/QuickbooksMappingWorkbench.test.tsx` — component behavior and `runAction` mutation tests.
- `apps/web/src/components/integrations/QuickbooksIntegration.tsx` — render the workbench for connected partners and update saved account settings.
- `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/integrations.json` — add parity-safe mapping copy.
- `docs/integrations/quickbooks-sandbox-verification.md` — reproducible Phase B sandbox checklist and evidence fields.

---

### Task 1: Persist tenant-safe accounting entity mappings

**Files:**
- Create: `apps/api/migrations/2026-08-29-quickbooks-entity-mappings.sql`
- Modify: `apps/api/src/db/schema/accounting.ts:1-31`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:168-208`
- Create: `apps/api/src/__tests__/integration/accounting-entity-mappings-rls.integration.test.ts`

**Interfaces:**
- Consumes: `accounting_connections(id, partner_id)`, `organizations(id, partner_id)`, `catalog_items(id, partner_id)`, `invoices(id, partner_id)`, and `invoice_payments(invoice_id)`.
- Produces: `accountingEntityMappings`, `AccountingEntityMapping`, and `NewAccountingEntityMapping`; later tasks use these exact Drizzle exports.

- [ ] **Step 1: Write the failing real-Postgres integration tests**

Create fixtures for two partners, one connection per partner, one organization and catalog item for partner A, and assert the following concrete cases:

```ts
describe('accounting_entity_mappings RLS and integrity', () => {
  it.runIf(!!process.env.DATABASE_URL)('allows partner A to map its own organization', async () => {
    const [mapping] = await withDbAccessContext(partnerContext(partnerA.id), () =>
      db.insert(accountingEntityMappings).values({
        integrationId: connectionA.id,
        partnerId: partnerA.id,
        breezeEntityType: 'org',
        breezeEntityId: orgA.id,
        remoteEntityType: 'Customer',
        remoteEntityId: 'qbo-customer-1',
        remoteSyncToken: '0',
        linkStatus: 'confirmed',
        syncStatus: 'synced',
      }).returning(),
    );
    expect(mapping?.remoteEntityId).toBe('qbo-customer-1');
  });

  it.runIf(!!process.env.DATABASE_URL)('rejects partner B forging a mapping to partner A', async () => {
    await expect(withDbAccessContext(partnerContext(partnerB.id), () =>
      db.insert(accountingEntityMappings).values({
        integrationId: connectionB.id,
        partnerId: partnerB.id,
        breezeEntityType: 'org',
        breezeEntityId: orgA.id,
        remoteEntityType: 'Customer',
        linkStatus: 'suggested',
        syncStatus: 'pending',
      }),
    )).rejects.toThrow(/does not belong to partner/i);
  });

  it.runIf(!!process.env.DATABASE_URL)('prevents two Breeze entities claiming one remote item', async () => {
    await seedTwoCatalogMappingsWithRemoteId('qbo-item-9');
    await expect(insertSecondClaim()).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it.runIf(!!process.env.DATABASE_URL)('cascades mappings when the connection is deleted', async () => {
    await deleteConnectionFixture(connectionA.id);
    expect(await mappingsFor(connectionA.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify the table is absent**

Run:

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls.ts src/__tests__/integration/accounting-entity-mappings-rls.integration.test.ts
```

Expected: FAIL because `accountingEntityMappings` is not exported and the table does not exist.

- [ ] **Step 3: Add the Drizzle schema**

Append this provider-neutral shape to `schema/accounting.ts` and import `sql`, `index`, and `foreignKey`:

```ts
export const accountingEntityMappings = pgTable('accounting_entity_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  breezeEntityType: varchar('breeze_entity_type', { length: 20 }).notNull(),
  breezeEntityId: uuid('breeze_entity_id').notNull(),
  remoteEntityType: varchar('remote_entity_type', { length: 20 }).notNull(),
  remoteEntityId: text('remote_entity_id'),
  remoteSyncToken: varchar('remote_sync_token', { length: 64 }),
  linkStatus: varchar('link_status', { length: 20 }).notNull().default('suggested'),
  syncStatus: varchar('sync_status', { length: 30 }).notNull().default('pending'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  connectionPartnerFk: foreignKey({
    columns: [table.integrationId, table.partnerId],
    foreignColumns: [accountingConnections.id, accountingConnections.partnerId],
    name: 'accounting_entity_mappings_connection_partner_fk',
  }).onDelete('cascade'),
  breezeEntityUniq: uniqueIndex('accounting_entity_mappings_breeze_uniq')
    .on(table.integrationId, table.breezeEntityType, table.breezeEntityId),
  remoteEntityUniq: uniqueIndex('accounting_entity_mappings_remote_uniq')
    .on(table.integrationId, table.remoteEntityType, table.remoteEntityId)
    .where(sql`${table.remoteEntityId} IS NOT NULL`),
  partnerStatusIdx: index('accounting_entity_mappings_partner_status_idx')
    .on(table.partnerId, table.syncStatus),
}));

export type AccountingEntityMapping = typeof accountingEntityMappings.$inferSelect;
export type NewAccountingEntityMapping = typeof accountingEntityMappings.$inferInsert;
```

- [ ] **Step 4: Write the idempotent migration with database-enforced ownership**

Create the same columns, CHECK constraints for the four entity-type pairs and four status values, both unique indexes, and the composite connection FK. Add a `BEFORE INSERT OR UPDATE` trigger whose body is explicit for every supported Breeze type:

```sql
CREATE OR REPLACE FUNCTION validate_accounting_mapping_entity_partner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.breeze_entity_type = 'org' AND NOT EXISTS (
    SELECT 1 FROM organizations WHERE id = NEW.breeze_entity_id AND partner_id = NEW.partner_id
  ) THEN
    RAISE EXCEPTION 'organization % does not belong to partner %', NEW.breeze_entity_id, NEW.partner_id USING ERRCODE = '23514';
  ELSIF NEW.breeze_entity_type = 'catalog_item' AND NOT EXISTS (
    SELECT 1 FROM catalog_items WHERE id = NEW.breeze_entity_id AND partner_id = NEW.partner_id
  ) THEN
    RAISE EXCEPTION 'catalog item % does not belong to partner %', NEW.breeze_entity_id, NEW.partner_id USING ERRCODE = '23514';
  ELSIF NEW.breeze_entity_type = 'invoice' AND NOT EXISTS (
    SELECT 1 FROM invoices WHERE id = NEW.breeze_entity_id AND partner_id = NEW.partner_id
  ) THEN
    RAISE EXCEPTION 'invoice % does not belong to partner %', NEW.breeze_entity_id, NEW.partner_id USING ERRCODE = '23514';
  ELSIF NEW.breeze_entity_type = 'payment' AND NOT EXISTS (
    SELECT 1 FROM invoice_payments p
    JOIN invoices i ON i.id = p.invoice_id
    WHERE p.id = NEW.breeze_entity_id AND i.partner_id = NEW.partner_id
  ) THEN
    RAISE EXCEPTION 'payment % does not belong to partner %', NEW.breeze_entity_id, NEW.partner_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
```

Run the imported-customer backfill before enabling the ownership trigger, then use `DROP TRIGGER IF EXISTS` and recreate it. Add four policies using `public.breeze_has_partner_access(partner_id)`, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and `GRANT SELECT, INSERT, UPDATE, DELETE TO breeze_app`.

Backfill imported customers without inventing connections or overwriting a conflict:

```sql
INSERT INTO accounting_entity_mappings (
  integration_id, partner_id, breeze_entity_type, breeze_entity_id,
  remote_entity_type, remote_entity_id, link_status, sync_status
)
SELECT c.id, l.partner_id, 'org', l.org_id, 'Customer', l.external_id, 'confirmed', 'pending'
FROM organization_external_links l
JOIN accounting_connections c
  ON c.partner_id = l.partner_id AND c.provider = 'quickbooks'
WHERE l.system = 'quickbooks'
ON CONFLICT DO NOTHING;
```

Wrap the backfill in `DO $$` with `GET DIAGNOSTICS inserted = ROW_COUNT` and emit `RAISE WARNING 'backfilled % QuickBooks customer accounting mappings', inserted` when the count is nonzero.

- [ ] **Step 5: Register RLS coverage and run migration checks**

Add:

```ts
['accounting_entity_mappings', 'partner_id'],
```

to `PARTNER_TENANT_TABLES` beside `accounting_connections`.

Run:

```bash
pnpm db:check-drift
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls.ts src/__tests__/integration/accounting-entity-mappings-rls.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
```

Expected: schema drift check passes; both integration files pass, including cross-partner forge rejection.

- [ ] **Step 6: Commit the persistence layer**

```bash
git add apps/api/migrations/2026-08-29-quickbooks-entity-mappings.sql apps/api/src/db/schema/accounting.ts apps/api/src/__tests__/integration/accounting-entity-mappings-rls.integration.test.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(accounting): add tenant-safe entity mappings"
```

---

### Task 2: Implement typed QuickBooks Customer, Item, and income-account operations

**Files:**
- Modify: `apps/api/src/services/accounting/types.ts:13-67`
- Modify: `apps/api/src/services/accounting/quickbooksProvider.ts:27-177`
- Modify: `apps/api/src/services/accounting/quickbooksProvider.test.ts`

**Interfaces:**
- Consumes: a connection whose `accessToken` has already been refreshed by `getValidAccessToken`.
- Produces: `RemoteItem`, `RemoteIncomeAccount`, `CustomerUpsertInput`, `ItemUpsertInput`, and typed provider methods shown below.

- [ ] **Step 1: Replace variadic provider methods with exact contracts**

Add these types and signatures in `types.ts`:

```ts
export interface RemoteItem extends RemoteEntity {
  sku?: string;
  description?: string;
  type?: 'Service' | 'NonInventory' | 'Inventory' | 'Category' | string;
  unitPrice?: number;
  active?: boolean;
  syncToken?: string;
}

export interface RemoteCustomer extends RemoteEntity {
  companyName?: string;
  phone?: string;
  contactName?: string;
  billAddr?: RemoteAddress;
  shipAddr?: RemoteAddress;
  active?: boolean;
  syncToken?: string;
}

export interface RemoteIncomeAccount extends RemoteEntity {
  accountType: string;
  accountSubType?: string;
}

export interface CustomerUpsertInput {
  displayName: string;
  companyName?: string;
  email?: string;
  phone?: string;
  taxId?: string;
  billingAddress?: RemoteAddress;
  existing?: RemoteRef;
}

export interface ItemUpsertInput {
  name: string;
  sku?: string;
  description?: string;
  type: 'Service' | 'NonInventory';
  unitPrice: number;
  taxable: boolean;
  incomeAccountRef: string;
  active: boolean;
  existing?: RemoteRef;
}

listRemoteItems(conn: AccountingConnection, query?: string): Promise<RemoteItem[]>;
listRemoteIncomeAccounts(conn: AccountingConnection): Promise<RemoteIncomeAccount[]>;
upsertCustomer(conn: AccountingConnection, input: CustomerUpsertInput): Promise<RemoteRef>;
upsertItem(conn: AccountingConnection, input: ItemUpsertInput): Promise<RemoteRef>;
```

- [ ] **Step 2: Write failing provider tests for mapping and HTTP payloads**

Cover these exact assertions with mocked `fetch`:

```ts
it('creates a customer without sparse update fields', async () => {
  fetchMock.mockResolvedValue(qboJson({ Customer: { Id: '12', SyncToken: '0' } }));
  await provider.upsertCustomer(conn(), { displayName: 'Acme', email: 'ap@acme.test' });
  expect(requestBody()).toEqual({
    DisplayName: 'Acme',
    PrimaryEmailAddr: { Address: 'ap@acme.test' },
  });
});

it('sparse-updates a customer with Id and current SyncToken', async () => {
  fetchMock.mockResolvedValue(qboJson({ Customer: { Id: '12', SyncToken: '8' } }));
  await provider.upsertCustomer(conn(), {
    displayName: 'Acme LLC', existing: { id: '12', syncToken: '7' },
  });
  expect(requestBody()).toMatchObject({ sparse: true, Id: '12', SyncToken: '7', DisplayName: 'Acme LLC' });
});

it('requires a SyncToken before updating', async () => {
  await expect(provider.upsertItem(conn(), itemInput({ existing: { id: '9' } })))
    .rejects.toThrow(/SyncToken/);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('pages Items and maps Sku, Type, UnitPrice, Active and SyncToken', async () => {
  fetchMock.mockResolvedValueOnce(qboItemPage(1000)).mockResolvedValueOnce(qboItemPage(1));
  const items = await provider.listRemoteItems(conn());
  expect(items).toHaveLength(1001);
  expect(items[0]).toMatchObject({ sku: 'SKU-1', type: 'Service', syncToken: '0' });
});

it('lists active income accounts only', async () => {
  fetchMock.mockResolvedValue(qboJson({ QueryResponse: { Account: [
    { Id: '79', Name: 'Services', AccountType: 'Income', Active: true },
  ] } }));
  await expect(provider.listRemoteIncomeAccounts(conn())).resolves.toEqual([
    { id: '79', displayName: 'Services', accountType: 'Income', accountSubType: undefined },
  ]);
});
```

Also assert sandbox/production base URL selection, missing realm/token errors, non-2xx response status/body capture, malformed response rejection, `Service`/`NonInventory` payloads, and omission of undefined nested fields.

- [ ] **Step 3: Run the provider tests to verify the stubs fail**

```bash
pnpm --filter @breeze/api exec vitest run src/services/accounting/quickbooksProvider.test.ts
```

Expected: FAIL on the Phase B `NotImplemented` methods and missing typed interface members.

- [ ] **Step 4: Implement one shared QBO request helper and entity mappers**

Add a private helper that keeps error behavior uniform and never exposes tokens:

```ts
private async qboRequest<T>(
  conn: AccountingConnection,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!conn.realmId) throw new Error('QuickBooks connection is missing a realmId');
  if (!conn.accessToken) throw new Error('QuickBooks connection is missing an access token');
  const response = await runOutsideDbContext(() => fetch(
    `${qboApiBase(conn.environment)}/v3/company/${conn.realmId}/${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${conn.accessToken}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    },
  ));
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`QuickBooks API request failed with ${response.status}`);
    Object.assign(error, { status: response.status, body: text.slice(0, 500) });
    throw error;
  }
  return JSON.parse(text) as T;
}
```

Use `SELECT * FROM Item STARTPOSITION n MAXRESULTS 1000` and `SELECT * FROM Account WHERE AccountType = 'Income' AND Active = true STARTPOSITION n MAXRESULTS 1000`. Use `POST customer?minorversion=70` and `POST item?minorversion=70`. For updates include `{ sparse: true, Id, SyncToken }`; for Item creation include `{ Name, Sku, Description, Type, UnitPrice, Taxable, IncomeAccountRef: { value } }`.

- [ ] **Step 5: Run provider tests and typecheck**

```bash
pnpm --filter @breeze/api exec vitest run src/services/accounting/quickbooksProvider.test.ts
pnpm --filter @breeze/api typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the provider operations**

```bash
git add apps/api/src/services/accounting/types.ts apps/api/src/services/accounting/quickbooksProvider.ts apps/api/src/services/accounting/quickbooksProvider.test.ts
git commit -m "feat(accounting): implement QuickBooks customer and item operations"
```

---

### Task 3: Build deterministic reconciliation proposals

**Files:**
- Create: `apps/api/src/services/accounting/accountingMappingService.ts`
- Create: `apps/api/src/services/accounting/accountingMappingService.test.ts`

**Interfaces:**
- Consumes: Task 1 mappings and Task 2 provider list methods.
- Produces: `listMappingProposals(input: ListMappingProposalsInput): Promise<MappingProposal[]>` and `AccountingMappingError`.

- [ ] **Step 1: Define proposal types and deterministic normalization**

```ts
export type MappingEntityType = 'org' | 'catalog_item';
export type MappingDecision = 'confirmed' | 'create_new' | 'unlinked';

export interface ListMappingProposalsInput {
  partnerId: string;
  provider: 'quickbooks';
  entityType: MappingEntityType;
}

export type AccountingMappingErrorCode =
  | 'not_connected'
  | 'reauth_required'
  | 'quickbooks_error'
  | 'mapping_conflict'
  | 'entity_not_found'
  | 'income_account_required'
  | 'mapping_not_ready';

export class AccountingMappingError extends Error {
  constructor(
    public readonly code: AccountingMappingErrorCode,
    public readonly status: 404 | 409 | 502,
    message: string,
  ) {
    super(message);
    this.name = 'AccountingMappingError';
  }
}

export interface MappingProposal {
  breezeEntityType: MappingEntityType;
  breezeEntityId: string;
  breezeDisplayName: string;
  remoteEntityType: 'Customer' | 'Item';
  proposedRemoteId: string | null;
  proposedRemoteName: string | null;
  confidence: 'existing_link' | 'exact_email' | 'exact_sku' | 'exact_name' | 'none' | 'ambiguous';
  linkStatus: 'suggested' | 'confirmed' | 'create_new' | 'unlinked';
  syncStatus: 'pending' | 'synced' | 'error';
  lastError: string | null;
}

export function normalizeMatchValue(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export async function listRemoteIncomeAccountsForPartner(input: {
  partnerId: string;
  provider: 'quickbooks';
}): Promise<RemoteIncomeAccount[]>;
```

- [ ] **Step 2: Write failing matching tests**

Test the priority order exactly:

```ts
it('treats an existing QuickBooks organization link as a confirmed mapping', async () => {
  seedOrgLink({ orgId: ORG_A, externalId: 'qb-12' });
  remoteCustomers([{ id: 'qb-12', displayName: 'Renamed in QBO' }]);
  await expect(listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' }))
    .resolves.toContainEqual(expect.objectContaining({
      breezeEntityId: ORG_A, proposedRemoteId: 'qb-12', confidence: 'existing_link', linkStatus: 'confirmed',
    }));
});

it('prefers one exact email match over a name match', async () => {
  localOrg({ name: 'Acme', email: 'billing@acme.test' });
  remoteCustomers([
    { id: '1', displayName: 'Acme', email: 'other@acme.test' },
    { id: '2', displayName: 'Acme Holdings', email: 'BILLING@ACME.TEST' },
  ]);
  expect((await proposals())[0]).toMatchObject({ proposedRemoteId: '2', confidence: 'exact_email' });
});

it('marks duplicate exact names ambiguous instead of picking by array order', async () => {
  localOrg({ name: 'Acme' });
  remoteCustomers([{ id: '1', displayName: 'Acme' }, { id: '2', displayName: ' ACME ' }]);
  expect((await proposals())[0]).toMatchObject({ proposedRemoteId: null, confidence: 'ambiguous' });
});

it('matches catalog items by unique exact SKU before name', async () => {
  localCatalog({ name: 'Managed Service', sku: 'MS-1' });
  remoteItems([{ id: '9', displayName: 'Old Name', sku: 'ms-1' }]);
  expect((await itemProposals())[0]).toMatchObject({ proposedRemoteId: '9', confidence: 'exact_sku' });
});
```

Also test no match, inactive remote entities excluded from new proposals, an already-claimed remote ID excluded, soft-deleted orgs excluded, partner scoping on every DB query, token refresh use, reauth conversion to a typed 409, and QBO failures converted to 502 without leaking response bodies.

- [ ] **Step 3: Run tests to verify the service is missing**

```bash
pnpm --filter @breeze/api exec vitest run src/services/accounting/accountingMappingService.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 4: Implement proposal generation without remote writes**

For each request:

1. Load the partner connection and reject disconnected/reauth states.
2. Resolve and persist a rotated access token with `getValidAccessToken` under system context.
3. Fetch remote Customers or Items outside DB context.
4. Load only same-partner active Breeze entities, current mappings, and for customers the same-partner `organization_external_links` rows where `system='quickbooks'`.
5. Insert missing imported-customer mappings as `confirmed/pending` with `ON CONFLICT DO NOTHING`.
6. Return proposals using this strict priority: current mapping → existing external link → one exact email/SKU → one exact normalized name → ambiguous/none.
7. Do not persist ordinary suggestions; they are recomputable and must not become stale rows merely because the user opened the screen.

Use `runOutsideDbContext(() => withSystemDbAccessContext(...))` only where a background/system escape is genuinely needed for token rotation. Request route reads/writes otherwise stay in the caller's partner RLS context.

- [ ] **Step 5: Run service tests**

```bash
pnpm --filter @breeze/api exec vitest run src/services/accounting/accountingMappingService.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit reconciliation proposals**

```bash
git add apps/api/src/services/accounting/accountingMappingService.ts apps/api/src/services/accounting/accountingMappingService.test.ts
git commit -m "feat(accounting): propose QuickBooks entity mappings"
```

---

### Task 4: Confirm mappings and explicitly sync Customers and Items

**Files:**
- Modify: `apps/api/src/services/accounting/accountingMappingService.ts`
- Modify: `apps/api/src/services/accounting/accountingMappingService.test.ts`

**Interfaces:**
- Consumes: Task 2 upsert methods and Task 3 proposal state.
- Produces: `saveMappingDecision(input: SaveMappingDecisionInput): Promise<AccountingEntityMapping>` and `syncMappedEntity(input: SyncMappedEntityInput): Promise<AccountingEntityMapping>`.

- [ ] **Step 1: Add exact mutation contracts**

```ts
export interface SaveMappingDecisionInput {
  partnerId: string;
  provider: 'quickbooks';
  breezeEntityType: 'org' | 'catalog_item';
  breezeEntityId: string;
  decision: 'confirmed' | 'create_new' | 'unlinked';
  remoteEntityId?: string;
}

export interface SyncMappedEntityInput {
  partnerId: string;
  provider: 'quickbooks';
  breezeEntityType: 'org' | 'catalog_item';
  breezeEntityId: string;
}
```

- [ ] **Step 2: Write failing lifecycle tests**

```ts
it('confirms a remote Customer only when it exists and is unclaimed', async () => {
  remoteCustomers([{ id: 'qb-1', displayName: 'Acme', syncToken: '3' }]);
  const row = await saveMappingDecision(confirmOrg('qb-1'));
  expect(row).toMatchObject({ remoteEntityId: 'qb-1', linkStatus: 'confirmed', syncStatus: 'pending' });
});

it('rejects a remote ID already claimed by another Breeze entity', async () => {
  existingClaim({ breezeEntityId: ORG_B, remoteEntityId: 'qb-1' });
  await expect(saveMappingDecision(confirmOrg('qb-1'))).rejects.toMatchObject({ code: 'mapping_conflict', status: 409 });
});

it('create_new sync creates once and retries as sparse update', async () => {
  mapping({ linkStatus: 'create_new', remoteEntityId: null });
  upsertCustomerMock.mockResolvedValueOnce({ id: 'qb-new', syncToken: '0' });
  await syncMappedEntity(syncOrg());
  upsertCustomerMock.mockResolvedValueOnce({ id: 'qb-new', syncToken: '1' });
  await syncMappedEntity(syncOrg());
  expect(upsertCustomerMock.mock.calls[1]?.[1]).toMatchObject({ existing: { id: 'qb-new', syncToken: '0' } });
});

it('blocks Item creation until an income account is configured', async () => {
  connection({ defaultIncomeAccountRef: null });
  await expect(syncMappedEntity(syncCatalogItem())).rejects.toMatchObject({
    code: 'income_account_required', status: 409,
  });
  expect(upsertItemMock).not.toHaveBeenCalled();
});
```

Also cover wrong-partner Breeze IDs, wrong remote entity type, missing mapping, `unlinked` refusing sync, decimal `unitPrice` conversion, catalog type mapping, billing contact/address/tax ID mapping, optimistic concurrency failures recorded as `sync_status='error'`, successful response clearing `last_error`, and DB persistence failure after a remote create surfacing a non-retry-safe error with the remote ID captured in Sentry metadata.

- [ ] **Step 3: Run tests to verify lifecycle functions are absent**

```bash
pnpm --filter @breeze/api exec vitest run src/services/accounting/accountingMappingService.test.ts
```

Expected: FAIL on missing exports.

- [ ] **Step 4: Implement decision persistence and sync orchestration**

`saveMappingDecision` must verify the local entity belongs to `partnerId`; for `confirmed`, fetch the selected remote list and verify the ID exists before upserting the mapping. `create_new` stores a null remote ID. `unlinked` clears remote ID/token and leaves a durable explicit decision.

`syncMappedEntity` must:

```ts
const accessToken = await runOutsideDbContext(() =>
  withSystemDbAccessContext(() => getValidAccessToken(db, connection)),
);
const liveConnection = { ...connection, accessToken };
const remote = mapping.breezeEntityType === 'org'
  ? await provider.upsertCustomer(liveConnection, customerInput(localOrg, mapping))
  : await provider.upsertItem(liveConnection, itemInput(localItem, connection, mapping));
await persistRemoteRef({
  mappingId: mapping.id,
  partnerId,
  remoteEntityId: remote.id,
  remoteSyncToken: remote.syncToken ?? null,
  linkStatus: 'confirmed',
  syncStatus: 'synced',
  lastSyncedAt: new Date(),
  lastError: null,
});
```

Every UPDATE uses both mapping ID and partner ID and checks `returning()` for zero rows. On an HTTP/provider failure, persist `sync_status='error'` and a sanitized message, then rethrow the typed error.

- [ ] **Step 5: Run mapping tests and API typecheck**

```bash
pnpm --filter @breeze/api exec vitest run src/services/accounting/accountingMappingService.test.ts src/services/accounting/quickbooksProvider.test.ts
pnpm --filter @breeze/api typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the mapping lifecycle**

```bash
git add apps/api/src/services/accounting/accountingMappingService.ts apps/api/src/services/accounting/accountingMappingService.test.ts
git commit -m "feat(accounting): confirm and sync QuickBooks mappings"
```

---

### Task 5: Expose authorized mapping and income-account routes

**Files:**
- Modify: `apps/api/src/routes/accounting/index.ts:27-383`
- Create: `apps/api/src/routes/accounting/mappings.test.ts`

**Interfaces:**
- Consumes: Task 3/4 service functions and Task 2 `listRemoteIncomeAccounts`.
- Produces: five endpoints under `/accounting/:provider`.

- [ ] **Step 1: Define route schemas and error mapping**

```ts
const mappingEntityQuerySchema = partnerQuerySchema.extend({
  entityType: z.enum(['org', 'catalog_item']),
});
const mappingDecisionSchema = z.object({
  breezeEntityType: z.enum(['org', 'catalog_item']),
  breezeEntityId: z.string().guid(),
  decision: z.enum(['confirmed', 'create_new', 'unlinked']),
  remoteEntityId: z.string().min(1).max(255).optional(),
}).superRefine((value, ctx) => {
  if (value.decision === 'confirmed' && !value.remoteEntityId) {
    ctx.addIssue({ code: 'custom', path: ['remoteEntityId'], message: 'remoteEntityId is required when confirming a match' });
  }
  if (value.decision !== 'confirmed' && value.remoteEntityId) {
    ctx.addIssue({ code: 'custom', path: ['remoteEntityId'], message: 'remoteEntityId is only valid for confirmed matches' });
  }
});
const mappingSyncSchema = z.object({
  breezeEntityType: z.enum(['org', 'catalog_item']),
  breezeEntityId: z.string().guid(),
});
```

- [ ] **Step 2: Write failing route tests**

Test:

- `GET /quickbooks/mappings?entityType=org` returns proposals for the authenticated partner.
- system scope requires `partnerId`; partner scope cannot request another partner.
- `GET /quickbooks/income-accounts` is read-only partner/system scope and returns sanitized account fields.
- `PUT /quickbooks/mappings` requires MFA plus `ORGS_WRITE` for `org` or `CATALOG_WRITE` for `catalog_item`.
- `POST /quickbooks/mappings/sync` requires MFA plus `ORGS_WRITE` for `org` or `CATALOG_WRITE` for `catalog_item`.
- invalid GUID/decision combinations return 400 before service invocation.
- service `not_connected` → 404, `reauth_required`/conflict/income-account-required → 409, QBO error → 502.
- no response contains access token, refresh token, realm ID, or raw QuickBooks error body.

Use the existing auth mocks from `customers.test.ts` and assert the route service receives `auth.partnerId`, never a body-supplied partner ID.

- [ ] **Step 3: Run route tests to verify 404/missing handlers**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/accounting/mappings.test.ts
```

Expected: FAIL because the endpoints are not mounted.

- [ ] **Step 4: Add the endpoints**

Mount:

```text
GET  /:provider/mappings?entityType=org|catalog_item
GET  /:provider/income-accounts
PUT  /:provider/mappings
POST /:provider/mappings/sync
```

The proposal and income-account endpoints use `authMiddleware`, `partnerScopes`, provider/query validation, and no MFA because they are read-only. The two mutation endpoints additionally use `requireMfa()` and this post-validation entity-aware guard (system scope bypasses the role lookup, matching the existing accounting permission wrapper):

```ts
const requireCustomerMappingWrite = requirePermission(
  PERMISSIONS.ORGS_WRITE.resource,
  PERMISSIONS.ORGS_WRITE.action,
);
const requireItemMappingWrite = requirePermission(
  PERMISSIONS.CATALOG_WRITE.resource,
  PERMISSIONS.CATALOG_WRITE.action,
);

const requireMappingWrite: MiddlewareHandler = async (c, next) => {
  if (c.get('auth')?.scope === 'system') return next();
  const body = c.req.valid('json') as { breezeEntityType: 'org' | 'catalog_item' };
  const guard = body.breezeEntityType === 'org'
    ? requireCustomerMappingWrite
    : requireItemMappingWrite;
  return guard(c, next);
};
```

Place `zValidator('json', ...)` before `requireMappingWrite` in each mutation route so the guard only sees validated input.

For the income-account route, call `listRemoteIncomeAccountsForPartner({ partnerId, provider })` and return `{ data }`; that Task 3 service function owns connection lookup, token refresh, and the provider call. For mutations, call `writeRouteAudit` with action `accounting.mapping.update` or `accounting.entity.sync`, resource type `accounting_mapping`, and details containing only entity type, Breeze entity ID, decision, remote entity type, and result status.

- [ ] **Step 5: Run route and existing accounting regression tests**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/accounting/mappings.test.ts src/routes/accounting/index.test.ts src/routes/accounting/customers.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the API surface**

```bash
git add apps/api/src/routes/accounting/index.ts apps/api/src/routes/accounting/mappings.test.ts
git commit -m "feat(accounting): expose QuickBooks mapping routes"
```

---

### Task 6: Add the customer/item mapping workbench

**Files:**
- Create: `apps/web/src/components/integrations/QuickbooksMappingWorkbench.tsx`
- Create: `apps/web/src/components/integrations/QuickbooksMappingWorkbench.test.tsx`
- Modify: `apps/web/src/components/integrations/QuickbooksIntegration.tsx:27-405`
- Modify: `apps/web/src/locales/en/integrations.json:694-738`
- Modify: `apps/web/src/locales/de-DE/integrations.json`
- Modify: `apps/web/src/locales/es-419/integrations.json`
- Modify: `apps/web/src/locales/fr-CA/integrations.json`
- Modify: `apps/web/src/locales/fr-FR/integrations.json`
- Modify: `apps/web/src/locales/it-IT/integrations.json`
- Modify: `apps/web/src/locales/pt-BR/integrations.json`
- Modify: `apps/web/src/locales/tr-TR/integrations.json`

**Interfaces:**
- Consumes: Task 5 endpoints and the existing `runAction`, toast, auth, and i18n helpers.
- Produces: a connected-only `QuickbooksMappingWorkbench` with customer/item tabs and status controls.

- [ ] **Step 1: Write failing component tests**

Mock `fetchWithAuth` and assert:

```tsx
it('loads customer proposals and marks ambiguous rows for manual selection', async () => {
  fetchWithAuthMock.mockResolvedValue(ok({ data: [ambiguousOrgProposal] }));
  render(<QuickbooksMappingWorkbench onUnauthorized={vi.fn()} />);
  fireEvent.click(screen.getByTestId('quickbooks-mapping-load'));
  expect(await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`)).toBeInTheDocument();
  expect(screen.getByTestId(`quickbooks-mapping-confidence-${ORG_ID}`)).toHaveTextContent(/ambiguous/i);
});

it('confirms a proposal through runAction and reloads the list', async () => {
  chooseRemoteCustomer('qb-12');
  fireEvent.click(screen.getByTestId(`quickbooks-mapping-confirm-${ORG_ID}`));
  expect(runActionMock).toHaveBeenCalledWith(expect.objectContaining({ successMessage: expect.any(String) }));
  expect(lastRequest()).toMatchObject({ method: 'PUT' });
});

it('disables item creation until an income account is saved', async () => {
  renderWorkbench({ defaultIncomeAccountRef: null, itemProposal });
  expect(screen.getByTestId(`quickbooks-mapping-create-${ITEM_ID}`)).toBeDisabled();
  expect(screen.getByTestId('quickbooks-income-account-required')).toBeInTheDocument();
});

it('surfaces sync errors on the affected row', async () => {
  fetchWithAuthMock.mockResolvedValue(error(409, { error: 'QuickBooks mapping is stale' }));
  fireEvent.click(screen.getByTestId(`quickbooks-mapping-sync-${ORG_ID}`));
  expect(await screen.findByTestId(`quickbooks-mapping-error-${ORG_ID}`)).toHaveTextContent(/stale/i);
});
```

Also test customer/item tab switching through `window.location.hash` (`#quickbooks-customers` / `#quickbooks-items`), read-only loading, create-new decision, unlink, income-account save, unauthorized redirect, loading/empty states, and no optimistic green status before the API succeeds.

- [ ] **Step 2: Run component tests to verify the component is missing**

```bash
pnpm --filter @breeze/web exec vitest run src/components/integrations/QuickbooksMappingWorkbench.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the workbench with explicit outcomes**

Use these UI contracts:

- `quickbooks-mapping-tab-customers`, `quickbooks-mapping-tab-items`
- `quickbooks-mapping-load`
- `quickbooks-mapping-row-${breezeEntityId}`
- `quickbooks-mapping-remote-${breezeEntityId}` select
- `quickbooks-mapping-confirm-${breezeEntityId}`
- `quickbooks-mapping-create-${breezeEntityId}`
- `quickbooks-mapping-unlink-${breezeEntityId}`
- `quickbooks-mapping-sync-${breezeEntityId}`
- `quickbooks-mapping-status-${breezeEntityId}`
- `quickbooks-mapping-error-${breezeEntityId}`
- `quickbooks-income-account-select`, `quickbooks-income-account-save`

All PUT/POST/PATCH actions must use `runAction`. Catch 401 `ActionError` only to let `onUnauthorized` own navigation; do not emit duplicate toasts for other `ActionError` instances. Keep the current customer-import panel below the mapping workbench because it solves the reverse onboarding flow (QBO Customer → new Breeze org/site).

Render the workbench from `QuickbooksIntegration` only when `status.status === 'connected'`, passing `defaultIncomeAccountRef` and an `onSettingsChanged` callback so saving the account updates the parent status without a full page reload.

- [ ] **Step 4: Add locale keys with parity**

Add a `quickbooksMapping` object to all eight `integrations.json` files with the same keys. English values must include: `mappingTitle`, `customers`, `items`, `loadMappings`, `refreshMappings`, `suggestedMatch`, `ambiguousMatch`, `noMatch`, `confirmed`, `createNew`, `unlink`, `syncNow`, `pending`, `synced`, `syncError`, `incomeAccount`, `incomeAccountRequired`, `saveIncomeAccount`, `mappingSaved`, and `entitySynced`. Translate the seven non-English files rather than copying English values, because `translationCoverage.test.ts` checks copied-English thresholds.

- [ ] **Step 5: Run web tests, locale checks, and typecheck**

```bash
pnpm --filter @breeze/web exec vitest run src/components/integrations/QuickbooksMappingWorkbench.test.tsx src/components/integrations/QuickbooksCustomerImport.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts
pnpm --filter @breeze/web typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the workbench**

```bash
git add apps/web/src/components/integrations/QuickbooksMappingWorkbench.tsx apps/web/src/components/integrations/QuickbooksMappingWorkbench.test.tsx apps/web/src/components/integrations/QuickbooksIntegration.tsx apps/web/src/locales/*/integrations.json
git commit -m "feat(accounting): add QuickBooks mapping workbench"
```

---

### Task 7: Verify Phase B end to end and document the sandbox evidence

**Files:**
- Create: `docs/integrations/quickbooks-sandbox-verification.md`
- Modify only if failures require fixes: files from Tasks 1-6 and their adjacent tests.

**Interfaces:**
- Consumes: the complete Phase B API/UI.
- Produces: a repeatable evidence record and a verified mapping contract for Phase C.

- [ ] **Step 1: Write the sandbox checklist**

The document must record date, Breeze build SHA, hosted region, Intuit app environment, sandbox company realm label (not realm ID), tester, and pass/fail evidence for:

```markdown
1. Connect the sandbox company and verify no credentials appear in UI/API logs.
2. Select and save an active QuickBooks income account.
3. Reconcile one existing customer by email and confirm it; verify QBO is unchanged.
4. Choose create-new for a second organization; sync twice; verify one QBO Customer exists and the second sync updates it without duplication.
5. Reconcile one existing Item by SKU and confirm it.
6. Choose create-new for a second catalog item; verify Service or NonInventory type, price, taxability, SKU, income account, remote ID, and SyncToken.
7. Change the Breeze org/item, sync again, and verify a sparse QBO update plus incremented persisted SyncToken.
8. Attempt a duplicate remote claim and verify Breeze returns a visible conflict without changing QBO.
9. Disconnect/reconnect the same sandbox and verify mappings remain tied to the connection lifecycle as designed.
```

- [ ] **Step 2: Run the complete automated Phase B gate**

```bash
pnpm db:check-drift
pnpm --filter @breeze/api exec vitest run src/services/accounting/quickbooksProvider.test.ts src/services/accounting/accountingMappingService.test.ts src/routes/accounting/mappings.test.ts src/routes/accounting/index.test.ts src/routes/accounting/customers.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls.ts src/__tests__/integration/accounting-entity-mappings-rls.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
pnpm --filter @breeze/api typecheck
pnpm --filter @breeze/web exec vitest run src/components/integrations/QuickbooksMappingWorkbench.test.tsx src/components/integrations/QuickbooksCustomerImport.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts
pnpm --filter @breeze/web typecheck
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Perform the sandbox walkthrough**

Use a dedicated sandbox organization/customer and catalog item. Do not use production books. Capture QBO entity IDs only in the private test record, not in the repository. Mark each checklist item pass/fail and include the visible Breeze status after each action.

- [ ] **Step 4: Verify Phase C’s dependency contract**

From the API service, prove an issued-invoice worker will be able to query one confirmed Customer mapping and zero-or-more confirmed Item mappings by `(integrationId, breezeEntityType, breezeEntityId)`, obtaining `remoteEntityId` and `remoteSyncToken` without reading `organization_external_links` or any QuickBooks fields from core billing tables.

- [ ] **Step 5: Commit the verification guide and any test-only corrections**

```bash
git add docs/integrations/quickbooks-sandbox-verification.md
git commit -m "docs(accounting): add QuickBooks mapping sandbox verification"
```

---

## Phase B Exit Criteria

- The database rejects cross-partner mapping forgeries and duplicate local/remote claims.
- Existing QuickBooks customer imports appear as confirmed mappings without rewriting import provenance.
- Suggested matches are deterministic and never cause remote writes.
- A user can explicitly confirm, create, unlink, and resync Customers and Items with visible outcomes.
- Item creation cannot proceed without a selected income account.
- QBO create/update responses persist both remote ID and current SyncToken.
- All mapping mutations are permission-checked, MFA-gated, audited, and surfaced through `runAction`.
- Automated tests, RLS tests, drift check, typechecks, locale parity, and sandbox walkthrough pass.
- No invoice, void, webhook, or payment behavior is introduced in this phase.

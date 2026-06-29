# QuickBooks Customer Import → Orgs + Sites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a partner browse their QuickBooks customers and import selected ones into Breeze as Organizations, each with one default Site, carrying contact + address data, idempotently.

**Architecture:** Implement the stubbed `QuickbooksProvider.listRemoteCustomers` against the QBO query API. A new service (`quickbooksCustomerImport.ts`) fetches customers (handling token refresh) and creates org+site rows under the tenant-create RLS escape (`runOutsideDbContext(() => withSystemDbAccessContext(...))`). Two new routes under `/accounting/:provider` (list + import) mirror the catalog distributor import pattern. A new web component renders a selectable table inside the existing QuickBooks integration panel.

**Tech Stack:** Hono + Zod (API), Drizzle ORM, Postgres (hand-written SQL migration), Vitest (API + web), React island (Astro web).

## Global Constraints

- **Migrations:** hand-written SQL in `apps/api/migrations/`, filename `2026-06-29-org-accounting-external-id.sql`. Idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`). No inner `BEGIN;`/`COMMIT;`. Never edit a shipped migration.
- **RLS:** `organizations`/`sites` already have RLS; the new columns do not change org tenancy shape, so **no** `rls-coverage` allowlist changes. Org+site inserts for tenant-create must run inside `runOutsideDbContext(() => withSystemDbAccessContext(...))` — a request-scoped insert of a brand-new org matches 0 rows under `breeze_app` RLS.
- **Connection scope:** accounting connections are keyed by `partnerId` (one QB realm per partner). Imports create orgs under that partner.
- **Token access:** never call the QBO data API with a raw stored token — always resolve via `getValidAccessToken(db, conn)` (rotates + persists the refresh token). Run it under system context so the rotation write succeeds.
- **Web mutations:** the import POST MUST be wrapped in `runAction` (`apps/web/src/lib/runAction.ts`).
- **data-testid:** kebab-case `quickbooks-import-*` (no text/role/CSS selectors in e2e).
- **Node:** v22.20.0 (worktrees need `pnpm install`).
- **Provider param enum:** routes are locked to `z.enum(['quickbooks'])` today; keep that.

---

## File Structure

- `apps/api/migrations/2026-06-29-org-accounting-external-id.sql` — new columns + partial unique index (CREATE).
- `apps/api/src/db/schema/orgs.ts` — add `accountingProvider`, `accountingExternalId` to the `organizations` table + partial unique index (MODIFY).
- `apps/api/src/services/accounting/types.ts` — add `RemoteAddress`, `RemoteCustomer`; widen `listRemoteCustomers` return type (MODIFY).
- `apps/api/src/services/accounting/quickbooksProvider.ts` — implement `listRemoteCustomers` + exported mapping helpers (MODIFY).
- `apps/api/src/services/accounting/quickbooksProvider.test.ts` — mapping + pagination tests (CREATE).
- `apps/api/src/services/accounting/quickbooksCustomerImport.ts` — slug helpers + `listQuickbooksCustomersAnnotated` + `importQuickbooksCustomers` (CREATE).
- `apps/api/src/services/accounting/quickbooksCustomerImport.test.ts` — service tests (CREATE).
- `apps/api/src/routes/accounting/index.ts` — add GET `/customers` + POST `/customers/import` (MODIFY).
- `apps/api/src/routes/accounting/customers.test.ts` — route tests (CREATE).
- `apps/web/src/components/integrations/QuickbooksCustomerImport.tsx` — import panel (CREATE).
- `apps/web/src/components/integrations/QuickbooksCustomerImport.test.tsx` — component test (CREATE).
- `apps/web/src/components/integrations/QuickbooksIntegration.tsx` — render the import panel when connected (MODIFY).

---

## Task 1: Migration + schema columns

**Files:**
- Create: `apps/api/migrations/2026-06-29-org-accounting-external-id.sql`
- Modify: `apps/api/src/db/schema/orgs.ts:67-94`

**Interfaces:**
- Produces: `organizations.accounting_provider` (text, nullable), `organizations.accounting_external_id` (text, nullable), partial unique index `organizations_accounting_external_uniq` on `(partner_id, accounting_provider, accounting_external_id) WHERE accounting_external_id IS NOT NULL`. Drizzle columns `accountingProvider`, `accountingExternalId`.

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-29-org-accounting-external-id.sql`:

```sql
-- Link Breeze organizations back to the external accounting customer they were
-- imported from, so re-imports are idempotent. Generic (provider, external_id)
-- so Xero can reuse it later. Partial unique index enforces "skip dupes" even
-- under concurrent imports. Does not change the org RLS tenancy shape.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS accounting_provider text;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS accounting_external_id text;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_accounting_external_uniq
  ON organizations (partner_id, accounting_provider, accounting_external_id)
  WHERE accounting_external_id IS NOT NULL;
```

- [ ] **Step 2: Add the columns to the Drizzle schema**

In `apps/api/src/db/schema/orgs.ts`, add inside the `organizations` `pgTable` column list (after `billingAddressCountry` at line 88, before `createdAt`):

```ts
  accountingProvider: text('accounting_provider'),
  accountingExternalId: text('accounting_external_id'),
```

Then add the partial unique index to the table's index callback (line 92-94), so it reads:

```ts
}, (table) => ({
  orgPartnerUnique: uniqueIndex('organizations_id_partner_id_unique').on(table.id, table.partnerId),
  accountingExternalUnique: uniqueIndex('organizations_accounting_external_uniq')
    .on(table.partnerId, table.accountingProvider, table.accountingExternalId)
    .where(sql`accounting_external_id IS NOT NULL`),
}));
```

Add `sql` to the `drizzle-orm` import at the top of the file if not present:

```ts
import { sql } from 'drizzle-orm';
```

(`text` is already imported on line 1.)

- [ ] **Step 3: Apply the migration and verify no drift**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
pnpm db:check-drift
```
Expected: autoMigrate test passes (migration applies + is ordered correctly); `db:check-drift` reports no drift between schema and migrations.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-06-29-org-accounting-external-id.sql apps/api/src/db/schema/orgs.ts
git commit -m "feat(api): add accounting external-id link columns to organizations"
```

---

## Task 2: RemoteCustomer types + QBO listRemoteCustomers

**Files:**
- Modify: `apps/api/src/services/accounting/types.ts:13-17,41-42`
- Modify: `apps/api/src/services/accounting/quickbooksProvider.ts`
- Test: `apps/api/src/services/accounting/quickbooksProvider.test.ts`

**Interfaces:**
- Consumes: `AccountingConnection` (`accountingConnectionService.ts:10`) — uses `realmId`, `accessToken`, `environment`.
- Produces:
  - `RemoteAddress { line1?, line2?, city?, region?, postalCode?, country? }`
  - `RemoteCustomer extends RemoteEntity { companyName?, phone?, contactName?, billAddr?: RemoteAddress, shipAddr?: RemoteAddress, active?: boolean }`
  - `QuickbooksProvider.listRemoteCustomers(conn): Promise<RemoteCustomer[]>` — uses `conn.accessToken` directly (caller pre-resolves a valid token), pages the QBO query API.
  - Exported pure helpers `mapQboAddress(raw): RemoteAddress | undefined` and `mapQboCustomer(raw): RemoteCustomer`.

- [ ] **Step 1: Add the types**

In `apps/api/src/services/accounting/types.ts`, after `RemoteEntity` (line 17) add:

```ts
export interface RemoteAddress {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

export interface RemoteCustomer extends RemoteEntity {
  companyName?: string;
  phone?: string;
  contactName?: string;
  billAddr?: RemoteAddress;
  shipAddr?: RemoteAddress;
  active?: boolean;
}
```

Then widen the interface method (line 41) to:

```ts
  listRemoteCustomers(conn: AccountingConnection, query?: string): Promise<RemoteCustomer[]>;
```

(`RemoteCustomer extends RemoteEntity`, so this stays compatible with the unimplemented Xero path.)

- [ ] **Step 2: Write the failing mapping + pagination tests**

Create `apps/api/src/services/accounting/quickbooksProvider.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { quickbooksProvider, mapQboCustomer, mapQboAddress } from './quickbooksProvider';
import type { AccountingConnection } from './accountingConnectionService';

function conn(overrides: Partial<AccountingConnection> = {}): AccountingConnection {
  return {
    id: 'c1', partnerId: 'p1', provider: 'quickbooks',
    realmId: 'realm123', accessToken: 'tok', refreshToken: 'r',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    environment: 'sandbox', homeCurrency: 'USD',
    defaultIncomeAccountRef: null, defaultTaxCodeRef: null,
    pushMode: 'auto', status: 'connected',
    createdAt: null, updatedAt: null, lastError: null,
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('mapQboAddress', () => {
  it('maps QBO address fields, including CountrySubDivisionCode -> region', () => {
    expect(mapQboAddress({
      Line1: '123 Main', Line2: 'Suite 4', City: 'Austin',
      CountrySubDivisionCode: 'TX', PostalCode: '78701', Country: 'US',
    })).toEqual({
      line1: '123 Main', line2: 'Suite 4', city: 'Austin',
      region: 'TX', postalCode: '78701', country: 'US',
    });
  });

  it('returns undefined when the address is empty/missing', () => {
    expect(mapQboAddress(undefined)).toBeUndefined();
    expect(mapQboAddress({})).toBeUndefined();
  });
});

describe('mapQboCustomer', () => {
  it('maps display name, company, email, phone, contact name, addresses, active', () => {
    const c = mapQboCustomer({
      Id: '42', DisplayName: 'Acme Co', CompanyName: 'Acme Inc',
      PrimaryEmailAddr: { Address: 'ap@acme.test' },
      PrimaryPhone: { FreeFormNumber: '555-1212' },
      GivenName: 'Jane', FamilyName: 'Doe', Active: true,
      BillAddr: { Line1: '1 Bill St', City: 'Austin' },
      ShipAddr: { Line1: '2 Ship Rd', City: 'Dallas' },
    });
    expect(c).toMatchObject({
      id: '42', displayName: 'Acme Co', companyName: 'Acme Inc',
      email: 'ap@acme.test', phone: '555-1212', contactName: 'Jane Doe',
      active: true,
      billAddr: { line1: '1 Bill St', city: 'Austin' },
      shipAddr: { line1: '2 Ship Rd', city: 'Dallas' },
    });
  });

  it('falls back to CompanyName when DisplayName is missing, and tolerates missing optionals', () => {
    const c = mapQboCustomer({ Id: '7', CompanyName: 'Solo LLC' });
    expect(c.id).toBe('7');
    expect(c.displayName).toBe('Solo LLC');
    expect(c.email).toBeUndefined();
    expect(c.billAddr).toBeUndefined();
  });
});

describe('listRemoteCustomers', () => {
  it('pages through the QBO query API until a short page is returned', async () => {
    const page1 = { QueryResponse: { Customer: Array.from({ length: 1000 }, (_, i) => ({ Id: String(i), DisplayName: `C${i}` })) } };
    const page2 = { QueryResponse: { Customer: [{ Id: '1000', DisplayName: 'last' }] } };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page2), { status: 200 }));

    const result = await quickbooksProvider.listRemoteCustomers(conn());

    expect(result).toHaveLength(1001);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = String(fetchMock.mock.calls[0]![0]);
    expect(firstUrl).toContain('sandbox-quickbooks.api.intuit.com');
    expect(firstUrl).toContain('STARTPOSITION%201'); // url-encoded space
    const secondUrl = String(fetchMock.mock.calls[1]![0]);
    expect(secondUrl).toContain('STARTPOSITION%201001');
  });

  it('uses the production base URL when environment is production', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ QueryResponse: {} }), { status: 200 }));
    await quickbooksProvider.listRemoteCustomers(conn({ environment: 'production' }));
    expect(String(fetchMock.mock.calls[0]![0])).toContain('https://quickbooks.api.intuit.com');
  });

  it('throws when the QBO API returns a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 401 }));
    await expect(quickbooksProvider.listRemoteCustomers(conn())).rejects.toThrow(/QuickBooks customer query failed/);
  });

  it('throws when the connection has no realmId or access token', async () => {
    await expect(quickbooksProvider.listRemoteCustomers(conn({ realmId: null }))).rejects.toThrow(/realm/i);
    await expect(quickbooksProvider.listRemoteCustomers(conn({ accessToken: null }))).rejects.toThrow(/access token/i);
  });
});
```

- [ ] **Step 2b: Run the test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/accounting/quickbooksProvider.test.ts`
Expected: FAIL — `mapQboCustomer`/`mapQboAddress` are not exported and `listRemoteCustomers` throws `NotImplemented: Phase B`.

- [ ] **Step 3: Implement the mapping helpers + listRemoteCustomers**

In `apps/api/src/services/accounting/quickbooksProvider.ts`:

Update the type import (line 4-10) to add `RemoteAddress`, `RemoteCustomer`:

```ts
import type {
  AccountingProvider,
  ChangeSet,
  ConnectionTokens,
  RemoteAddress,
  RemoteCustomer,
  RemoteEntity,
  RemoteRef,
} from './types';
```

Add base-URL + minor-version constants near the other constants (line 15):

```ts
const QBO_API_MINOR_VERSION = '70';
const QBO_CUSTOMER_PAGE_SIZE = 1000; // QBO hard cap per query page

function qboApiBase(environment: 'sandbox' | 'production'): string {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}
```

Add the exported mapping helpers (module scope, e.g. just below the constants):

```ts
interface QboRawAddress {
  Line1?: string; Line2?: string; City?: string;
  CountrySubDivisionCode?: string; PostalCode?: string; Country?: string;
}

interface QboRawCustomer {
  Id: string;
  DisplayName?: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  GivenName?: string;
  FamilyName?: string;
  Active?: boolean;
  BillAddr?: QboRawAddress;
  ShipAddr?: QboRawAddress;
}

export function mapQboAddress(raw: QboRawAddress | undefined): RemoteAddress | undefined {
  if (!raw) return undefined;
  const addr: RemoteAddress = {
    line1: raw.Line1 || undefined,
    line2: raw.Line2 || undefined,
    city: raw.City || undefined,
    region: raw.CountrySubDivisionCode || undefined,
    postalCode: raw.PostalCode || undefined,
    country: raw.Country || undefined,
  };
  return Object.values(addr).some((v) => v !== undefined) ? addr : undefined;
}

export function mapQboCustomer(raw: QboRawCustomer): RemoteCustomer {
  const contactName = [raw.GivenName, raw.FamilyName].filter(Boolean).join(' ').trim();
  return {
    id: raw.Id,
    displayName: raw.DisplayName || raw.CompanyName || raw.Id,
    companyName: raw.CompanyName || undefined,
    email: raw.PrimaryEmailAddr?.Address || undefined,
    phone: raw.PrimaryPhone?.FreeFormNumber || undefined,
    contactName: contactName || undefined,
    active: raw.Active,
    billAddr: mapQboAddress(raw.BillAddr),
    shipAddr: mapQboAddress(raw.ShipAddr),
  };
}
```

Replace the `listRemoteCustomers` stub (line 47-49) with:

```ts
  // NOTE: assumes `conn.accessToken` is already a VALID token. Callers must
  // resolve it via getValidAccessToken(db, conn) first (which refreshes +
  // persists rotation) — this method stays pure HTTP with no db dependency.
  async listRemoteCustomers(conn: AccountingConnection): Promise<RemoteCustomer[]> {
    if (!conn.realmId) throw new Error('QuickBooks connection is missing a realmId');
    if (!conn.accessToken) throw new Error('QuickBooks connection is missing an access token');

    const base = qboApiBase(conn.environment);
    const customers: RemoteCustomer[] = [];
    let startPosition = 1;

    // Page until a short page (< page size) signals the end.
    for (;;) {
      const query = `SELECT * FROM Customer STARTPOSITION ${startPosition} MAXRESULTS ${QBO_CUSTOMER_PAGE_SIZE}`;
      const url = `${base}/v3/company/${conn.realmId}/query?query=${encodeURIComponent(query)}&minorversion=${QBO_API_MINOR_VERSION}`;
      const response = await runOutsideDbContext(() =>
        fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${conn.accessToken}`,
            Accept: 'application/json',
          },
        })
      );

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const err = new Error(`QuickBooks customer query failed with ${response.status}`);
        (err as Error & { status?: number; body?: string }).status = response.status;
        (err as Error & { status?: number; body?: string }).body = body.slice(0, 500);
        throw err;
      }

      const parsed = await response.json() as { QueryResponse?: { Customer?: QboRawCustomer[] } };
      const page = parsed.QueryResponse?.Customer ?? [];
      for (const raw of page) customers.push(mapQboCustomer(raw));
      if (page.length < QBO_CUSTOMER_PAGE_SIZE) break;
      startPosition += QBO_CUSTOMER_PAGE_SIZE;
    }

    return customers;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @breeze/api exec vitest run src/services/accounting/quickbooksProvider.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/types.ts apps/api/src/services/accounting/quickbooksProvider.ts apps/api/src/services/accounting/quickbooksProvider.test.ts
git commit -m "feat(api): implement QuickBooks listRemoteCustomers + customer mapping"
```

---

## Task 3: Import service (slug helpers + list/annotate + import)

**Files:**
- Create: `apps/api/src/services/accounting/quickbooksCustomerImport.ts`
- Test: `apps/api/src/services/accounting/quickbooksCustomerImport.test.ts`

**Interfaces:**
- Consumes: `getConnection` (`accountingConnectionService.ts:103`), `getValidAccessToken` (`accountingTokens.ts:29`), `getAccountingProvider` (`providerRegistry.ts`), `db`/`runOutsideDbContext`/`withSystemDbAccessContext` (`../../db`), `organizations`/`sites` schema.
- Produces:
  - `slugify(name: string): string`
  - `generateUniqueSlug(base: string, taken: Set<string>): string`
  - `class QbImportError extends Error { code: string; status: number }`
  - `interface AnnotatedCustomer extends RemoteCustomer { alreadyImported: boolean; organizationId: string | null }`
  - `listQuickbooksCustomersAnnotated(partnerId: string): Promise<AnnotatedCustomer[]>`
  - `interface QbImportSummary { imported: Array<{ customerId; displayName; organizationId; siteId }>; skipped: Array<{ customerId; displayName; organizationId; reason: 'already_imported' }>; errors: Array<{ customerId; displayName?; error }> }`
  - `importQuickbooksCustomers(input: { partnerId: string; customerIds: string[] }): Promise<QbImportSummary>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/accounting/quickbooksCustomerImport.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module: provide db (select/insert), and pass-through context helpers.
const selectMock = vi.fn();
const insertMock = vi.fn();
vi.mock('../../db', () => ({
  db: { select: selectMock, insert: insertMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

const getConnectionMock = vi.fn();
vi.mock('./accountingConnectionService', () => ({
  getConnection: getConnectionMock,
}));

const getValidAccessTokenMock = vi.fn();
vi.mock('./accountingTokens', () => ({
  getValidAccessToken: getValidAccessTokenMock,
}));

const listRemoteCustomersMock = vi.fn();
vi.mock('./providerRegistry', () => ({
  getAccountingProvider: () => ({ listRemoteCustomers: listRemoteCustomersMock }),
}));

import {
  slugify, generateUniqueSlug, importQuickbooksCustomers,
  listQuickbooksCustomersAnnotated, QbImportError,
} from './quickbooksCustomerImport';

function connectedConn() {
  return { id: 'c1', partnerId: 'p1', provider: 'quickbooks', realmId: 'r1', accessToken: 'tok', environment: 'sandbox', status: 'connected' };
}

// Helper to stub `db.select(...).from(...).where(...)` returning `rows`.
function stubSelect(rows: unknown[]) {
  selectMock.mockReturnValue({ from: () => ({ where: () => Promise.resolve(rows) }) });
}

// Captures the object passed to each `db.insert(...).values(OBJ)` call, in order,
// without any production-code instrumentation.
const valuesSpy = vi.fn();
function stubInserts(rowsInOrder: unknown[][]) {
  let call = 0;
  insertMock.mockImplementation(() => ({
    values: (v: unknown) => { valuesSpy(v); return { returning: () => Promise.resolve(rowsInOrder[call++] ?? []) }; },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  valuesSpy.mockClear();
  getConnectionMock.mockResolvedValue(connectedConn());
  getValidAccessTokenMock.mockResolvedValue('fresh-token');
});

describe('slugify', () => {
  it('lowercases, strips punctuation, hyphenates spaces', () => {
    expect(slugify('Acme Co., Inc.')).toBe('acme-co-inc');
    expect(slugify('  Multiple   Spaces  ')).toBe('multiple-spaces');
  });
  it('falls back to "org" for empty/punctuation-only input', () => {
    expect(slugify('!!!')).toBe('org');
    expect(slugify('')).toBe('org');
  });
});

describe('generateUniqueSlug', () => {
  it('returns the base when free', () => {
    expect(generateUniqueSlug('acme', new Set())).toBe('acme');
  });
  it('appends an incrementing suffix on collision', () => {
    expect(generateUniqueSlug('acme', new Set(['acme', 'acme-2']))).toBe('acme-3');
  });
});

describe('listQuickbooksCustomersAnnotated', () => {
  it('annotates already-imported customers from existing org external ids', async () => {
    listRemoteCustomersMock.mockResolvedValue([
      { id: '1', displayName: 'A' }, { id: '2', displayName: 'B' },
    ]);
    stubSelect([{ id: 'org-1', accountingExternalId: '1' }]);

    const result = await listQuickbooksCustomersAnnotated('p1');

    expect(result).toEqual([
      expect.objectContaining({ id: '1', alreadyImported: true, organizationId: 'org-1' }),
      expect.objectContaining({ id: '2', alreadyImported: false, organizationId: null }),
    ]);
    expect(getValidAccessTokenMock).toHaveBeenCalled();
  });

  it('throws QbImportError(not_connected) when no connection exists', async () => {
    getConnectionMock.mockResolvedValue(null);
    await expect(listQuickbooksCustomersAnnotated('p1')).rejects.toMatchObject({ code: 'not_connected', status: 404 });
  });
});

describe('importQuickbooksCustomers', () => {
  it('creates an org + site for a new customer, mapping billing + shipping data', async () => {
    listRemoteCustomersMock.mockResolvedValue([{
      id: '1', displayName: 'Acme Co', email: 'ap@acme.test', phone: '555', contactName: 'Jane Doe',
      billAddr: { line1: '1 Bill St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' },
      shipAddr: { line1: '2 Ship Rd', city: 'Dallas' },
    }]);
    stubSelect([]); // no existing orgs
    stubInserts([[{ id: 'org-1', name: 'Acme Co', partnerId: 'p1' }], [{ id: 'site-1', orgId: 'org-1', name: 'Acme Co' }]]);

    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });

    expect(summary.imported).toEqual([{ customerId: '1', displayName: 'Acme Co', organizationId: 'org-1', siteId: 'site-1' }]);
    expect(summary.skipped).toEqual([]);
    expect(summary.errors).toEqual([]);

    // Org insert (first values() call) got billing address + accounting link.
    const orgInsertArg = valuesSpy.mock.calls[0]![0];
    expect(orgInsertArg).toMatchObject({
      partnerId: 'p1', name: 'Acme Co', slug: 'acme-co',
      accountingProvider: 'quickbooks', accountingExternalId: '1',
      billingContact: { name: 'Jane Doe', email: 'ap@acme.test', phone: '555' },
      billingAddressLine1: '1 Bill St', billingAddressCity: 'Austin',
      billingAddressRegion: 'TX', billingAddressPostalCode: '78701', billingAddressCountry: 'US',
    });
    // Site insert (second values() call) used shipping address.
    const siteInsertArg = valuesSpy.mock.calls[1]![0];
    expect(siteInsertArg).toMatchObject({
      orgId: 'org-1', name: 'Acme Co',
      address: { addressLine1: '2 Ship Rd', city: 'Dallas' },
      contact: { name: 'Jane Doe', email: 'ap@acme.test', phone: '555' },
    });
  });

  it('falls back to billing address for the site when shipping is absent', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme', billAddr: { line1: '1 Bill St', city: 'Austin' } }]);
    stubSelect([]);
    stubInserts([[{ id: 'org-1' }], [{ id: 'site-1' }]]);
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(valuesSpy.mock.calls[1]![0]).toMatchObject({ address: { addressLine1: '1 Bill St', city: 'Austin' } });
  });

  it('skips customers already linked to an org', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    stubSelect([{ id: 'org-9', accountingExternalId: '1' }]);
    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(summary.imported).toEqual([]);
    expect(summary.skipped).toEqual([{ customerId: '1', displayName: 'Acme', organizationId: 'org-9', reason: 'already_imported' }]);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('suffixes the slug when the base collides with an existing org slug', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    stubSelect([{ id: 'org-x', accountingExternalId: '99', slug: 'acme' }]);
    stubInserts([[{ id: 'org-1' }], [{ id: 'site-1' }]]);
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(valuesSpy.mock.calls[0]![0]).toMatchObject({ slug: 'acme-2' });
  });

  it('records a per-customer error and continues with the rest (partial success)', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Bad' }, { id: '2', displayName: 'Good' }]);
    stubSelect([]);
    let call = 0;
    insertMock.mockImplementation(() => ({
      values: (v: any) => ({
        returning: () => {
          call++;
          if (call === 1) return Promise.reject(new Error('boom')); // org insert for customer 1
          return Promise.resolve([{ id: `row-${call}` }]);
        },
      }),
    }));
    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1', '2'] });
    expect(summary.errors).toEqual([{ customerId: '1', displayName: 'Bad', error: 'boom' }]);
    expect(summary.imported).toHaveLength(1);
    expect(summary.imported[0]!.customerId).toBe('2');
  });

  it('reports requested ids not present in QuickBooks as errors', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    stubSelect([]);
    stubInserts([[{ id: 'org-1' }], [{ id: 'site-1' }]]);
    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1', 'missing'] });
    expect(summary.errors).toContainEqual({ customerId: 'missing', error: 'Customer not found in QuickBooks' });
    expect(summary.imported).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @breeze/api exec vitest run src/services/accounting/quickbooksCustomerImport.test.ts`
Expected: FAIL — module `./quickbooksCustomerImport` does not exist.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/accounting/quickbooksCustomerImport.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, sites } from '../../db/schema';
import { getConnection } from './accountingConnectionService';
import { getValidAccessToken } from './accountingTokens';
import { getAccountingProvider } from './providerRegistry';
import type { RemoteAddress, RemoteCustomer } from './types';

const PROVIDER = 'quickbooks' as const;

export class QbImportError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'QbImportError';
    this.code = code;
    this.status = status;
  }
}

export interface AnnotatedCustomer extends RemoteCustomer {
  alreadyImported: boolean;
  organizationId: string | null;
}

export interface QbImportSummary {
  imported: Array<{ customerId: string; displayName: string; organizationId: string; siteId: string }>;
  skipped: Array<{ customerId: string; displayName: string; organizationId: string; reason: 'already_imported' }>;
  errors: Array<{ customerId: string; displayName?: string; error: string }>;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return slug || 'org';
}

export function generateUniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Resolve the partner's QB connection + a fresh access token, then fetch all
// customers from QuickBooks. Token resolution runs in system context so the
// refresh-token rotation write succeeds (request context has no auth here).
async function fetchCustomers(partnerId: string): Promise<RemoteCustomer[]> {
  const conn = await withSystemDbAccessContext(() => getConnection(db, partnerId, PROVIDER));
  if (!conn || conn.status === 'disconnected') {
    throw new QbImportError('QuickBooks is not connected for this partner', 'not_connected', 404);
  }
  const accessToken = await withSystemDbAccessContext(() => getValidAccessToken(db, conn));
  const customers = await getAccountingProvider(PROVIDER).listRemoteCustomers({ ...conn, accessToken });
  return customers;
}

// Map external id -> { organizationId, slug } for every org already linked to
// this partner's QB realm. Used for dedup + slug-uniqueness.
async function loadExistingOrgs(partnerId: string): Promise<{ byExternalId: Map<string, string>; slugs: Set<string> }> {
  const rows = await withSystemDbAccessContext(() =>
    db.select({ id: organizations.id, accountingExternalId: organizations.accountingExternalId, slug: organizations.slug })
      .from(organizations)
      .where(and(eq(organizations.partnerId, partnerId), eq(organizations.accountingProvider, PROVIDER)))
  ) as Array<{ id: string; accountingExternalId: string | null; slug: string | null }>;

  const byExternalId = new Map<string, string>();
  const slugs = new Set<string>();
  for (const row of rows) {
    if (row.accountingExternalId) byExternalId.set(row.accountingExternalId, row.id);
    if (row.slug) slugs.add(row.slug);
  }
  return { byExternalId, slugs };
}

export async function listQuickbooksCustomersAnnotated(partnerId: string): Promise<AnnotatedCustomer[]> {
  const customers = await fetchCustomers(partnerId);
  const { byExternalId } = await loadExistingOrgs(partnerId);
  return customers.map((c) => ({
    ...c,
    alreadyImported: byExternalId.has(c.id),
    organizationId: byExternalId.get(c.id) ?? null,
  }));
}

function siteAddressFrom(addr: RemoteAddress | undefined): Record<string, string> | undefined {
  if (!addr) return undefined;
  // Match the web SiteForm convention so imported sites render correctly.
  const out: Record<string, string> = {};
  if (addr.line1) out.addressLine1 = addr.line1;
  if (addr.line2) out.addressLine2 = addr.line2;
  if (addr.city) out.city = addr.city;
  if (addr.region) out.state = addr.region;
  if (addr.postalCode) out.postalCode = addr.postalCode;
  if (addr.country) out.country = addr.country;
  return Object.keys(out).length ? out : undefined;
}

export async function importQuickbooksCustomers(
  input: { partnerId: string; customerIds: string[] }
): Promise<QbImportSummary> {
  const { partnerId, customerIds } = input;
  const customers = await fetchCustomers(partnerId);
  const byId = new Map(customers.map((c) => [c.id, c]));
  const { byExternalId, slugs } = await loadExistingOrgs(partnerId);

  const summary: QbImportSummary = { imported: [], skipped: [], errors: [] };

  for (const customerId of customerIds) {
    const customer = byId.get(customerId);
    if (!customer) {
      summary.errors.push({ customerId, error: 'Customer not found in QuickBooks' });
      continue;
    }

    const existingOrgId = byExternalId.get(customerId);
    if (existingOrgId) {
      summary.skipped.push({ customerId, displayName: customer.displayName, organizationId: existingOrgId, reason: 'already_imported' });
      continue;
    }

    try {
      const slug = generateUniqueSlug(slugify(customer.displayName), slugs);
      slugs.add(slug); // reserve within this batch

      const contact = {
        name: customer.contactName,
        email: customer.email,
        phone: customer.phone,
      };

      const { orgId, siteId } = await runOutsideDbContext(() =>
        withSystemDbAccessContext(async () => {
          const [org] = await db.insert(organizations).values({
            partnerId,
            name: customer.displayName,
            slug,
            type: 'customer' as const,
            billingContact: contact,
            billingAddressLine1: customer.billAddr?.line1 ?? null,
            billingAddressLine2: customer.billAddr?.line2 ?? null,
            billingAddressCity: customer.billAddr?.city ?? null,
            billingAddressRegion: customer.billAddr?.region ?? null,
            billingAddressPostalCode: customer.billAddr?.postalCode ?? null,
            billingAddressCountry: customer.billAddr?.country ?? null,
            accountingProvider: PROVIDER,
            accountingExternalId: customerId,
          }).returning();
          const [site] = await db.insert(sites).values({
            orgId: org!.id,
            name: customer.displayName,
            address: siteAddressFrom(customer.shipAddr ?? customer.billAddr),
            contact,
          }).returning();
          return { orgId: org!.id as string, siteId: site!.id as string };
        })
      );

      byExternalId.set(customerId, orgId);
      summary.imported.push({ customerId, displayName: customer.displayName, organizationId: orgId, siteId });
    } catch (err) {
      summary.errors.push({ customerId, displayName: customer.displayName, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return summary;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @breeze/api exec vitest run src/services/accounting/quickbooksCustomerImport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/quickbooksCustomerImport.ts apps/api/src/services/accounting/quickbooksCustomerImport.test.ts
git commit -m "feat(api): QuickBooks customer import service (orgs + sites, idempotent)"
```

---

## Task 4: Routes — list + import

**Files:**
- Modify: `apps/api/src/routes/accounting/index.ts`
- Test: `apps/api/src/routes/accounting/customers.test.ts`

**Interfaces:**
- Consumes: `listQuickbooksCustomersAnnotated`, `importQuickbooksCustomers`, `QbImportError` (Task 3); existing `resolvePartnerId`, `partnerScopes`, `providerParamSchema`, `partnerQuerySchema`, `validateProviderConfig`, `writeRouteAudit`.
- Produces:
  - `GET /accounting/:provider/customers?partnerId=` → `{ data: AnnotatedCustomer[] }`
  - `POST /accounting/:provider/customers/import` (body `{ customerIds: string[] }`, optional `?partnerId=`) → `{ data: QbImportSummary }`

- [ ] **Step 1: Write the failing route tests**

Create `apps/api/src/routes/accounting/customers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const listAnnotatedMock = vi.fn();
const importMock = vi.fn();
class QbImportError extends Error { code: string; status: number; constructor(m: string, c: string, s: number) { super(m); this.code = c; this.status = s; } }
vi.mock('../../services/accounting/quickbooksCustomerImport', () => ({
  listQuickbooksCustomersAnnotated: listAnnotatedMock,
  importQuickbooksCustomers: importMock,
  QbImportError,
}));

// Auth middleware stubs: inject a partner-scoped auth context.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => { c.set('auth', { scope: 'partner', partnerId: 'p1', user: { id: 'u1' } }); await next(); },
  requireScope: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { accountingRoutes } from './index';

function app() {
  const a = new Hono();
  a.route('/accounting', accountingRoutes);
  return a;
}

beforeEach(() => vi.clearAllMocks());

describe('GET /accounting/:provider/customers', () => {
  it('returns annotated customers', async () => {
    listAnnotatedMock.mockResolvedValue([{ id: '1', displayName: 'Acme', alreadyImported: false, organizationId: null }]);
    const res = await app().request('/accounting/quickbooks/customers');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: '1', displayName: 'Acme', alreadyImported: false, organizationId: null }] });
    expect(listAnnotatedMock).toHaveBeenCalledWith('p1');
  });

  it('maps QbImportError(not_connected) to 404', async () => {
    listAnnotatedMock.mockRejectedValue(new QbImportError('nope', 'not_connected', 404));
    const res = await app().request('/accounting/quickbooks/customers');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not_connected' });
  });
});

describe('POST /accounting/:provider/customers/import', () => {
  it('imports selected customers and returns the summary', async () => {
    importMock.mockResolvedValue({
      imported: [{ customerId: '1', displayName: 'Acme', organizationId: 'org-1', siteId: 'site-1' }],
      skipped: [], errors: [],
    });
    const res = await app().request('/accounting/quickbooks/customers/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerIds: ['1'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.imported).toHaveLength(1);
    expect(importMock).toHaveBeenCalledWith({ partnerId: 'p1', customerIds: ['1'] });
  });

  it('rejects an empty customerIds array with 400', async () => {
    const res = await app().request('/accounting/quickbooks/customers/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerIds: [] }),
    });
    expect(res.status).toBe(400);
    expect(importMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/accounting/customers.test.ts`
Expected: FAIL — routes not defined (404 for both).

- [ ] **Step 3: Implement the routes**

In `apps/api/src/routes/accounting/index.ts`:

Add imports near the existing service imports (after line 16):

```ts
import {
  importQuickbooksCustomers,
  listQuickbooksCustomersAnnotated,
  QbImportError,
} from '../../services/accounting/quickbooksCustomerImport';
import { writeRouteAudit } from '../../services/auditEvents';
```

Add an import-body schema near the other schemas (after `settingsSchema`, line 36):

```ts
const importCustomersSchema = z.object({
  customerIds: z.array(z.string().min(1)).min(1).max(500),
});

function handleImportError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof QbImportError) return c.json({ error: err.message, code: err.code }, err.status as 400 | 404);
  throw err;
}
```

Add the two routes (place them after the `GET /:provider` status route, before `PATCH /:provider/settings`):

```ts
// List remote QuickBooks customers, annotated with whether each is already
// imported. Read-only but partner-privileged, so partner/system scope.
accountingRoutes.get('/:provider/customers', authMiddleware, partnerScopes, zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const configError = validateProviderConfig(provider);
  if (configError) return c.json({ error: configError }, 400);
  const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  try {
    const data = await listQuickbooksCustomersAnnotated(partner.partnerId);
    return c.json({ data });
  } catch (err) {
    return handleImportError(c, err);
  }
});

// Import selected QuickBooks customers as orgs + sites. Write + MFA-gated.
accountingRoutes.post('/:provider/customers/import', authMiddleware, partnerScopes, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), zValidator('json', importCustomersSchema), async (c) => {
  const { provider } = c.req.valid('param');
  const configError = validateProviderConfig(provider);
  if (configError) return c.json({ error: configError }, 400);
  const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);

  let summary;
  try {
    summary = await importQuickbooksCustomers({ partnerId: partner.partnerId, customerIds: c.req.valid('json').customerIds });
  } catch (err) {
    return handleImportError(c, err);
  }

  // Audit each created org + site (the import itself ran in system context).
  for (const item of summary.imported) {
    writeRouteAudit(c, {
      orgId: item.organizationId,
      action: 'organization.create',
      resourceType: 'organization',
      resourceId: item.organizationId,
      resourceName: item.displayName,
      details: { source: 'quickbooks_import', quickbooksCustomerId: item.customerId, siteId: item.siteId },
    });
  }

  return c.json({ data: summary });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/accounting/customers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/accounting/index.ts apps/api/src/routes/accounting/customers.test.ts
git commit -m "feat(api): add QuickBooks customers list + import routes"
```

---

## Task 5: Web import panel

**Files:**
- Create: `apps/web/src/components/integrations/QuickbooksCustomerImport.tsx`
- Test: `apps/web/src/components/integrations/QuickbooksCustomerImport.test.tsx`
- Modify: `apps/web/src/components/integrations/QuickbooksIntegration.tsx`

**Interfaces:**
- Consumes: `fetchWithAuth` (`../../stores/auth`), `runAction` (`../../lib/runAction`), `useBulkSelection` (`../billing/bulk/useBulkSelection`), the API routes from Task 4.
- Produces: default-exported `<QuickbooksCustomerImport onUnauthorized?={() => void} />`, rendered by `QuickbooksIntegration` when connected.

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/components/integrations/QuickbooksCustomerImport.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import QuickbooksCustomerImport from './QuickbooksCustomerImport';

const fetchWithAuthMock = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a) }));

const showToastMock = vi.fn();
vi.mock('../../lib/toast', () => ({ showToast: (...a: unknown[]) => showToastMock(...a) }));

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('QuickbooksCustomerImport', () => {
  it('loads customers and disables already-imported rows', async () => {
    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({ data: [
      { id: '1', displayName: 'Acme', email: 'a@acme.test', alreadyImported: false, organizationId: null },
      { id: '2', displayName: 'Imported Inc', alreadyImported: true, organizationId: 'org-2' },
    ] }));

    render(<QuickbooksCustomerImport />);
    fireEvent.click(screen.getByTestId('quickbooks-import-load'));

    await waitFor(() => expect(screen.getByTestId('quickbooks-import-row-1')).toBeInTheDocument());
    expect(screen.getByTestId('quickbooks-import-select-1')).not.toBeDisabled();
    expect(screen.getByTestId('quickbooks-import-select-2')).toBeDisabled();
  });

  it('imports selected customers and surfaces the summary via runAction', async () => {
    fetchWithAuthMock
      .mockReturnValueOnce(jsonResponse({ data: [{ id: '1', displayName: 'Acme', alreadyImported: false, organizationId: null }] }))
      .mockReturnValueOnce(jsonResponse({ data: { imported: [{ customerId: '1', organizationId: 'org-1', siteId: 's1' }], skipped: [], errors: [] } }))
      .mockReturnValueOnce(jsonResponse({ data: [{ id: '1', displayName: 'Acme', alreadyImported: true, organizationId: 'org-1' }] }));

    render(<QuickbooksCustomerImport />);
    fireEvent.click(screen.getByTestId('quickbooks-import-load'));
    await waitFor(() => expect(screen.getByTestId('quickbooks-import-select-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quickbooks-import-select-1'));
    fireEvent.click(screen.getByTestId('quickbooks-import-submit'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
    // POST body carried the selected id.
    const postCall = fetchWithAuthMock.mock.calls[1]!;
    expect(postCall[0]).toBe('/accounting/quickbooks/customers/import');
    expect(JSON.parse((postCall[1] as RequestInit).body as string)).toEqual({ customerIds: ['1'] });
  });

  it('shows an error toast when loading fails', async () => {
    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({ error: 'not connected' }, 404));
    render(<QuickbooksCustomerImport />);
    fireEvent.click(screen.getByTestId('quickbooks-import-load'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/integrations/QuickbooksCustomerImport.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/integrations/QuickbooksCustomerImport.tsx`:

```tsx
import { useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '../../lib/runAction';
import { showToast } from '../../lib/toast';
import { useBulkSelection } from '../billing/bulk/useBulkSelection';

interface AnnotatedCustomer {
  id: string;
  displayName: string;
  email?: string;
  companyName?: string;
  alreadyImported: boolean;
  organizationId: string | null;
}

interface ImportSummary {
  imported: unknown[];
  skipped: unknown[];
  errors: Array<{ customerId: string; error: string }>;
}

interface Props {
  onUnauthorized?: () => void;
}

export default function QuickbooksCustomerImport({ onUnauthorized }: Props) {
  const [customers, setCustomers] = useState<AnnotatedCustomer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const selection = useBulkSelection();

  const importable = (customers ?? []).filter((c) => !c.alreadyImported);

  async function load() {
    setLoading(true);
    selection.clear();
    try {
      const data = await runAction<{ data: AnnotatedCustomer[] }>({
        request: () => fetchWithAuth('/accounting/quickbooks/customers'),
        errorFallback: 'Failed to load QuickBooks customers.',
        onUnauthorized,
      });
      setCustomers(data.data);
    } catch {
      // runAction already toasted; leave the list as-is.
    } finally {
      setLoading(false);
    }
  }

  async function importSelected() {
    const customerIds = Array.from(selection.selectedIds);
    if (customerIds.length === 0) return;
    setImporting(true);
    try {
      await runAction<{ data: ImportSummary }>({
        request: () => fetchWithAuth('/accounting/quickbooks/customers/import', {
          method: 'POST',
          body: JSON.stringify({ customerIds }),
        }),
        errorFallback: 'Failed to import customers.',
        successMessage: (res) => {
          const s = res.data;
          const parts = [`${s.imported.length} imported`];
          if (s.skipped.length) parts.push(`${s.skipped.length} skipped`);
          if (s.errors.length) parts.push(`${s.errors.length} failed`);
          return parts.join(', ');
        },
        onUnauthorized,
      });
      await load(); // refresh so imported rows flip to "already imported"
    } catch {
      // already toasted
    } finally {
      setImporting(false);
    }
  }

  function toggleSelectAll() {
    if (importable.every((c) => selection.has(c.id))) {
      selection.clear();
    } else {
      selection.selectAll(importable.map((c) => c.id));
    }
  }

  return (
    <div data-testid="quickbooks-import-panel" className="mt-6 border-t border-gray-200 pt-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Import customers</h3>
        <button
          type="button"
          data-testid="quickbooks-import-load"
          onClick={load}
          disabled={loading}
          className="rounded-md bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50"
        >
          {loading ? 'Loading…' : customers ? 'Refresh' : 'Load customers'}
        </button>
      </div>

      {customers && customers.length === 0 && (
        <p className="mt-4 text-sm text-gray-500" data-testid="quickbooks-import-empty">No customers found in QuickBooks.</p>
      )}

      {customers && customers.length > 0 && (
        <>
          <table className="mt-4 w-full text-sm" data-testid="quickbooks-import-table">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="w-8">
                  <input
                    type="checkbox"
                    data-testid="quickbooks-import-select-all"
                    aria-label="Select all"
                    checked={importable.length > 0 && importable.every((c) => selection.has(c.id))}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th>Name</th>
                <th>Email</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} data-testid={`quickbooks-import-row-${c.id}`} className="border-t border-gray-100">
                  <td>
                    <input
                      type="checkbox"
                      data-testid={`quickbooks-import-select-${c.id}`}
                      checked={selection.has(c.id)}
                      disabled={c.alreadyImported}
                      onChange={() => selection.toggle(c.id)}
                    />
                  </td>
                  <td className="py-1.5 text-gray-900">{c.displayName}</td>
                  <td className="py-1.5 text-gray-500">{c.email ?? '—'}</td>
                  <td className="py-1.5">
                    {c.alreadyImported && (
                      <span data-testid={`quickbooks-import-badge-${c.id}`} className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
                        Already imported
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4">
            <button
              type="button"
              data-testid="quickbooks-import-submit"
              onClick={importSelected}
              disabled={importing || selection.size === 0}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {importing ? 'Importing…' : `Import ${selection.size} selected`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
```

> Before implementing, open `apps/web/src/components/billing/bulk/useBulkSelection.ts` to confirm the exact `selectAll` signature. If `selectAll` takes no args (selects from an internal set) rather than an id array, adapt `toggleSelectAll`/`load` to call `selection.toggle` per id instead. Also confirm `showToast` is exported from `apps/web/src/lib/toast` (used by the test mock); if the project's toast helper lives elsewhere, mock that module path in the test instead.

- [ ] **Step 4: Render it from the QuickBooks panel**

In `apps/web/src/components/integrations/QuickbooksIntegration.tsx`, add the import near the other imports (line ~10):

```ts
import QuickbooksCustomerImport from './QuickbooksCustomerImport';
```

Then render it inside the connected state. Find where the panel shows connected content (it gates on an `isConnected`/status value — search for `status === 'connected'` or the disconnect button around line 161-230) and add, just before the panel's closing container tag:

```tsx
{isConnected && <QuickbooksCustomerImport onUnauthorized={onUnauthorized} />}
```

(Use whatever the local connected boolean + `onUnauthorized` handler are named in that file — match the existing `runAction` calls' `onUnauthorized`.)

- [ ] **Step 5: Run the web tests**

Run:
```bash
pnpm --filter @breeze/web exec vitest run src/components/integrations/QuickbooksCustomerImport.test.tsx
pnpm --filter @breeze/web exec vitest run src/components/integrations/QuickbooksIntegration.test.tsx
```
Expected: both PASS (the existing QB integration test should be unaffected; if it asserts an exact subtree, update it to tolerate the new child panel).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/integrations/QuickbooksCustomerImport.tsx apps/web/src/components/integrations/QuickbooksCustomerImport.test.tsx apps/web/src/components/integrations/QuickbooksIntegration.tsx
git commit -m "feat(web): QuickBooks customer import panel"
```

---

## Task 6: Full-suite verification

- [ ] **Step 1: Run the API + web suites for touched areas**

Run:
```bash
pnpm --filter @breeze/api exec vitest run src/services/accounting src/routes/accounting src/db/autoMigrate.test.ts
pnpm --filter @breeze/web exec vitest run src/components/integrations
```
Expected: all PASS.

- [ ] **Step 2: Verify RLS contract is unaffected**

Run the org RLS coverage contract (needs a real DB; see CLAUDE.md for the integration config):
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: PASS with no new allowlist entries required (the new columns don't change the org tenancy shape). If it can't run locally (no DB), note that CI's smoke-test job covers it.

- [ ] **Step 3: Drift check + typecheck**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/web exec tsc --noEmit
```
Expected: no drift, no type errors.

- [ ] **Step 4: Commit any fixes, then open the PR per repo workflow**

Use the repo's normal PR flow (`gh pr create`, squash-merge with `--admin` when CI is green).

---

## Self-Review Notes (addressed)

- **Spec §1 migration** → Task 1. **§2 client** → Task 2. **§3 routes** → Task 4. **§4 import service** → Task 3. **§5 web UI** → Task 5. **§6 testing** → tests in each task + Task 6.
- **Idempotency** enforced two ways: dedup pre-check in the service (Task 3) AND the partial unique index (Task 1) as the concurrency backstop.
- **Token handling**: `getValidAccessToken` is called in the service (under system context) and the provider receives a pre-resolved token — keeping the provider pure HTTP and unit-testable (Task 2/3).
- **RLS**: org+site inserts run under `runOutsideDbContext(() => withSystemDbAccessContext(...))` (Task 3), matching the tenant-create escape in `orgs.ts:1037`.
- **Type consistency**: `RemoteCustomer`/`RemoteAddress` defined in Task 2 are consumed by Task 3; `QbImportSummary`/`AnnotatedCustomer`/`QbImportError` defined in Task 3 are consumed by Task 4; the web `AnnotatedCustomer`/`ImportSummary` shapes in Task 5 mirror the API response `{ data }` envelopes.
```

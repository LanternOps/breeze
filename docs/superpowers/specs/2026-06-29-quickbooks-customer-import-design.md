# QuickBooks Customer Import → Orgs + Sites — Design

**Date:** 2026-06-29
**Status:** Approved (pending spec review)
**Branch:** ToddHebebrand/QB-Import

## Summary

Add the ability to import QuickBooks customers into Breeze as Organizations, each
with one default Site, carrying contact and address information. The flow is
interactive **browse → select → import**, modeled on the existing catalog
distributor import. Re-imports are idempotent via a QuickBooks customer-id link
stored on the organization.

## Context

The accounting integration (`apps/api/src/services/accounting/`) is a
partner-scoped, provider-seam architecture. OAuth + token lifecycle is built
(Phase A); customer/item/invoice operations are stubbed
(`listRemoteCustomers` throws `NotImplemented: Phase B`).

Key existing facts this design builds on:

- **Connection is partner-scoped.** `accounting_connections` is keyed by
  `partnerId` (one QB realm per MSP partner). Imported customers become orgs
  under that partner. Tokens are encrypted at rest; use
  `getValidAccessToken(db, conn)` (`accountingTokens.ts:29`) for a usable bearer.
- **Provider seam.** `AccountingProvider` (`services/accounting/types.ts:36`)
  already declares `listRemoteCustomers(conn, query?)`. Registry:
  `getAccountingProvider(id)` (`providerRegistry.ts`). Implementation lives in
  `quickbooksProvider.ts` (stub at `:47`).
- **Org/Site model** (`db/schema/orgs.ts`): no separate `contacts` table.
  - `organizations`: `billingContact` JSONB, flat `billingAddressLine1/Line2/
    City/Region/PostalCode` + `billingAddressCountry` (char(2)). `slug` is
    **not** DB-unique. Only unique index is `(id, partnerId)`.
  - `sites`: `address` JSONB, `contact` JSONB (`{name?,email?,phone?}`),
    `timezone` (default UTC).
  - Tenant-create RLS escape: org/site inserts run inside
    `runOutsideDbContext(() => withSystemDbAccessContext(...))`
    (`orgs.ts:1037`).
- **Import analog.** Catalog distributor import (commit `c29a228fb`): per-provider
  `…/customers` (read) + `…/import` (write, MFA-gated) routes →
  `importXxx(input, actor)` service with a `catalogActorFrom(c)` actor seam.

## Design Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Mapping model | Each QB customer → one **Org + one default Site** |
| Import flow | **Browse & select** (live list, checkboxes, Import button) |
| Duplicates | **Track QB id on the org; skip already-linked** customers |
| Field mapping | **Both org & site**: org billing addr+contact, site shipping addr+contact |

## 1. Data Model / Migration

Add two nullable columns to `organizations`:

- `accounting_provider` text — `'quickbooks' | 'xero'`
- `accounting_external_id` text — the remote customer id

Plus a **partial unique index** enforcing idempotency:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS organizations_accounting_external_uniq
  ON organizations (partner_id, accounting_provider, accounting_external_id)
  WHERE accounting_external_id IS NOT NULL;
```

Rationale:
- Generic `(provider, external_id)` rather than `quickbooks_customer_id` because
  the seam already anticipates Xero.
- The partial unique index makes "skip dupes" correct even under concurrent
  imports (DB-enforced, not just a pre-check).
- `organizations` already has RLS; these columns do not change its tenancy
  shape (still `org_id`/id-keyed under a partner), so **no RLS contract changes**
  and no new allowlist entries.

Migration `apps/api/migrations/2026-06-29-org-accounting-external-id.sql`,
following repo conventions: hand-written SQL, idempotent (`ADD COLUMN IF NOT EXISTS`,
`CREATE UNIQUE INDEX IF NOT EXISTS`), no inner `BEGIN/COMMIT`. Update the Drizzle
schema in `db/schema/orgs.ts` to match. Run `pnpm db:check-drift`.

## 2. QuickBooks Client

Implement `QuickbooksProvider.listRemoteCustomers` (`quickbooksProvider.ts:47`):

- Call the QBO query API:
  `GET {base}/v3/company/{realmId}/query?query=SELECT * FROM Customer STARTPOSITION {n} MAXRESULTS 1000`
  - `{base}` chosen by `conn.environment`: sandbox
    (`https://sandbox-quickbooks.api.intuit.com`) vs production
    (`https://quickbooks.api.intuit.com`).
  - Bearer token via `getValidAccessToken(db, conn)`.
  - `realmId` from the decrypted connection.
  - `Accept: application/json`.
- Paginate via `STARTPOSITION`/`MAXRESULTS` until a short page is returned.

Add a richer return type (the current `RemoteEntity` only has
`{id, displayName, email}`):

```ts
interface RemoteCustomer {
  id: string;            // QBO Customer.Id
  displayName: string;   // DisplayName (fallback CompanyName)
  companyName?: string;
  email?: string;        // PrimaryEmailAddr.Address
  phone?: string;        // PrimaryPhone.FreeFormNumber
  contactName?: string;  // GivenName + FamilyName
  billAddr?: RemoteAddress;  // BillAddr
  shipAddr?: RemoteAddress;  // ShipAddr
  active?: boolean;
}

interface RemoteAddress {
  line1?: string; line2?: string;
  city?: string; region?: string;     // CountrySubDivisionCode
  postalCode?: string; country?: string;
}
```

Mapping notes: QBO addresses use `Line1`, `City`, `CountrySubDivisionCode`
(region/state), `PostalCode`, `Country`. Tolerate missing fields. Inactive
customers are included but flagged `active:false` (UI may filter).

## 3. Routes

Under the existing `/accounting/:provider` router (`routes/accounting/index.ts`),
`provider` enum-locked, gated `requireScope('partner','system')` + `requireMfa()`
(matching the OAuth routes):

- `GET /accounting/:provider/customers`
  - Fetches remote customers via the provider client.
  - Left-joins `organizations.accounting_external_id` (for this partner+provider)
    to annotate each row with `alreadyImported: boolean` and, when present, the
    existing `organizationId`.
  - Returns `{ data: AnnotatedCustomer[] }`.
- `POST /accounting/:provider/customers/import`
  - Body (zod-validated): `{ customerIds: string[] }` (bounded length).
  - Delegates to the import service.
  - Returns `{ data: { imported: ImportResult[], skipped: SkipResult[], errors: ErrorResult[] } }`.

Error handling mirrors `distributors.ts`: a typed service error mapped to HTTP
in the route handler. Responses POSTed from web are consumed via `runAction`.

## 4. Import Service

`importQuickbooksCustomers(input, actor)` (new file under
`services/accounting/`), actor seam modeled on `catalogActorFrom`/
`importPax8CatalogItem`:

1. Resolve the connection for the actor's partner → `partnerId`, `realmId`,
   provider id. (Reuse `getConnection`.)
2. Fetch the selected customers (by id) from the provider, or accept already-
   fetched payloads — fetch is preferred so the import is authoritative.
3. For each customer:
   - If an org already exists with `(partner_id, provider, external_id)` →
     record as **skipped** (`alreadyImported`).
   - Else create, inside `runOutsideDbContext(() => withSystemDbAccessContext(...))`:
     - **Org**: `name = displayName`, `slug = uniqueSlug(displayName, partner)`,
       `type = 'customer'`, `billingContact = {name: contactName, email, phone}`,
       flat `billingAddress*` from `billAddr`,
       `accounting_provider`, `accounting_external_id = id`.
     - **Default Site**: `name` (e.g. "Main" or the customer name),
       `address` JSONB from `shipAddr ?? billAddr`,
       `contact` JSONB `{name: contactName, email, phone}`,
       `timezone` default UTC.
     - `writeRouteAudit` for org-create and site-create.
   - Record as **imported** (`organizationId`, `siteId`).
   - On per-customer failure, record an **error** and continue (partial success).
4. Return the aggregate `{ imported, skipped, errors }`.

**Slug uniqueness:** slugify `displayName`; if a same-slug org exists in the
partner, append `-2`, `-3`, … Best-effort (slug isn't DB-unique); the DB unique
index on the QB external id is the real idempotency guard.

**Address JSONB shape:** match the web convention
`{ addressLine1, addressLine2, city, state, postalCode, country }` used by
`SiteForm.tsx`, so imported sites render correctly in the existing UI.

## 5. Web UI

An "Import from QuickBooks" screen in the accounting/integrations area:

- On open, `GET …/customers`; render a checkbox table: name, email, address
  preview, and an **Already imported** badge (row checkbox disabled) for linked
  customers.
- Select-all (excludes already-imported), and an **Import** button.
- Import POST wrapped in `runAction` so success, failure, and partial results
  ("8 imported, 2 skipped") always surface via toast.
- After import, refresh the list so newly-imported rows show as imported.

## 6. Testing

- **Provider client** (`quickbooksProvider.test.ts`): QBO Customer →
  `RemoteCustomer` mapping (BillAddr/ShipAddr/phone/contact, missing fields,
  inactive flag); pagination across `STARTPOSITION` pages.
- **Import service**: dedup-skip on already-linked; org+site field mapping;
  `shipAddr → billAddr` fallback; slug-collision suffixing; partial-success
  (one customer errors, others import).
- **Routes** (style of `distributors.test.ts`): list annotation correctness;
  import happy path; MFA + scope gating.
- **Web**: component test for selection, already-imported disabling, and
  `runAction` error surfacing.
- **RLS**: no new contract entries — columns don't change org tenancy shape.
  Run the existing org RLS coverage to confirm no regression.

## Out of Scope (YAGNI)

- Background/scheduled sync of customers (interactive import only).
- Two-way push (Breeze org → QB customer); that's the separate `upsertCustomer`
  seam.
- Sub-customer → Site hierarchy (each QB customer gets exactly one default Site).
- Updating existing orgs from QB on re-import (skipped, not updated). Can be a
  follow-up.
- Xero customer import (schema is generic to allow it later; client not built).

## Files (anticipated)

- `apps/api/migrations/2026-06-29-org-accounting-external-id.sql` — new columns + partial unique index
- `apps/api/src/db/schema/orgs.ts` — add columns to Drizzle schema
- `apps/api/src/services/accounting/types.ts` — `RemoteCustomer`/`RemoteAddress`
- `apps/api/src/services/accounting/quickbooksProvider.ts` — implement
  `listRemoteCustomers`
- `apps/api/src/services/accounting/quickbooksCustomerImport.ts` (new) —
  `importQuickbooksCustomers`
- `apps/api/src/routes/accounting/index.ts` (or a new `customers.ts` sub-route) —
  list + import endpoints
- `apps/web/src/components/...` — import screen
- Co-located `*.test.ts` files for each of the above

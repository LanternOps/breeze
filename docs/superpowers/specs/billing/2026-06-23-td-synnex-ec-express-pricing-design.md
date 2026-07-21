# TD SYNNEX EC Express Pricing Connector — Design Spec

**Status:** Design proposed 2026-06-23.
**Program:** Billing & Invoicing → Product Catalog → Distributor connectors.
**Relates to:** `2026-06-14-product-catalog-design.md` (the `catalog_items` master this feeds),
`2026-06-14-billing-architecture-overview.md` (§7 external-integration conventions:
connection + mapping tables, encrypted creds, never external-ref columns on core tables).

## 1. Purpose & scope

Give partners a **TD SYNNEX EC Express** distributor connector that fetches **real-time
price & availability** for a known SYNNEX SKU or manufacturer part number and lets a
technician import that item into the partner price book (`catalog_items`) with live
reseller cost and a suggested sell price — the "add-to-quote" lookup model used by
Zomentum/D-Tools.

This exists because the already-shipped **Digital Bridge** connector
(`td_synnex_digital_bridge_integrations`) is **transactional only** (orders, invoices,
shipments) and exposes **no catalog / price-availability** surface — verified live
2026-06-23. EC Express's Price & Availability (PA) SOAP service is the real catalog
source and was verified end-to-end against the sandbox the same day (real data returned).

### In scope (v1)
- New partner-scoped connector: config (credentials), connection test, SKU/MPN lookup,
  import-to-catalog.
- New table `td_synnex_ec_express_integrations` (partner-axis, RLS shape 3, encrypted creds).
- Service module wrapping the PA SOAP call (`fast-xml-parser` for parsing).
- Routes under the existing catalog distributors router; settings UI panel + sub-tab.
- Reuse of `createCatalogItem` for import; full PA detail snapshotted in
  `catalog_items.attributes.distributor`.
- Unit + integration tests; idempotent migration with RLS in the creating migration.

### Out of scope (documented; additive later)
- **Phase 2 "full search" / catalog browse** — keyword/category browse over the whole
  SYNNEX catalog. PA has **no keyword search**; browse requires the separate TD SYNNEX
  **Product Data / catalog FTP feed**. **Parked pending confirmation of FTP entitlement.**
  Intended shape: a **global/shared** product-master index (the SYNNEX catalog is identical
  across partners; only cost differs and stays live via PA) refreshed nightly, mirroring the
  BE-16 `software_products` global-table pattern. No code in v1.
- Order/PO submission, order status, invoices (Digital Bridge territory; not this connector).
- Canada/other regions beyond a US default + a region→endpoint map stub.
- Any change to the existing Digital Bridge connector (left fully intact).

## 2. Verified API contract (the implementer builds to this)

Live-verified 2026-06-23. Also recorded in agent memory `td_synnex_ec_express_pa_contract`.

```
POST https://ws.synnex.com/webservice/pnaserviceV05      (SOAP 1.1)
  Content-Type: text/xml; charset=utf-8
  SOAPAction: ""
WSDL: https://ws.synnex.com/webservice/pnaserviceV05?wsdl
Operation: getPriceAvailability   ns=http://pnaV05.model.ws.synnex.com/
Body elements are UNqualified (elementFormDefault=unqualified).
```

**Auth = WS-Security `UsernameToken` in the SOAP header** (NOT HTTP Basic — Basic yields
fault `Security data is not provided`):
- `Username` = `"<ecexpress-email>;<customerNo>"` — **semicolon-joined**. Wrong format →
  fault `Bad username format. Should be in "Username;Customer#"`.
- `Password` = EC Express **API** password (PasswordText). Note the web-portal password and
  the API password can differ / go stale — wrong creds → fault `user login failed` (000000).

**Request** (`arg0` = `pnaRequest`):
- `skuList` (repeatable): each has `synnexSku` (int) **or** `mfgPartNo` (string).
- `warehouse` (repeatable): enum `ANY | CLOSEST | MULTIPLE | DTN | DSW | DIN | …`.
- `hideZeroInv` (boolean).

**Response** (`return` → repeated `priceAvail` = `pnaDetail`):
`synnexSku`, `mfgPartNo`, `status` (`ACTIVE|DISCONTINUED|INACTIVE|NOTAUTHORIZED|NOTSETUP|NOTFOUND`),
`description`, `currency`, `price` (reseller cost), `discount`, `discountEnd`,
`totalQty`/`totalOnOrder`/`totalBO`, per-warehouse `stock code=…` (`available`/`onOrder`/`bo`/`eta`),
`msrp`, `parcelShippable` (**two p's in the live response**; the WSDL XSD spells it
`parcelShipable` — trust the live response and tolerate both), `weight`.

Example (abridged real response):
```xml
<priceAvail>
  <synnexSku>8938995</synnexSku><mfgPartNo>DELL-U2724D</mfgPartNo>
  <status>ACTIVE</status><description>DELL ULTRASHARP 27 MONITOR - U2724D</description>
  <currency>USD</currency><price>381.35</price><discount>23.81</discount>
  <totalQty>1437</totalQty>
  <stock code="DSW"><available>1112</available><onOrder>1009</onOrder><bo>0</bo>
    <eta>2026-06-11T00:00:00.000-07:00</eta></stock>
  <msrp>549.99</msrp><parcelShippable>Y</parcelShippable><weight>20.50</weight>
</priceAvail>
```

A sanitized copy of the full 3-SKU response is committed as the unit-test fixture.

## 3. Data model — `td_synnex_ec_express_integrations` (RLS shape 3, partner-axis)

One row per partner (`UNIQUE(partner_id)`).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `partner_id` | uuid NOT NULL | FK → partners; RLS axis (`breeze_has_partner_access`); `UNIQUE` |
| `region` | varchar(8) NOT NULL | default `US`; maps to endpoint host server-side |
| `credentials` | jsonb NOT NULL | **encrypted** fields `{ email, password, customerNo }` (see §6) |
| `settings` | jsonb NOT NULL | `{ defaultWarehouse: 'ANY', hideZeroInv: false, defaultMarkupPercent?: number }` |
| `enabled` | boolean NOT NULL | default `false` |
| `last_test_status` | varchar(16) | `success` / `failed` / null |
| `last_test_at` | timestamptz | |
| `last_test_error` | text | |
| `created_by` | uuid | FK → users (nullable, like Digital Bridge) |
| `created_at` / `updated_at` | timestamptz | |

**RLS:** enabled + forced; policy `breeze_has_partner_access(partner_id)` for all commands,
added **in the creating migration**. Same-PR allowlist work:
- add to `PARTNER_TENANT_TABLES` in `rls-coverage.integration.test.ts`;
- add an `ec_express` row to the `catalog-rls.integration.test.ts` fixture and assert
  partner-B cannot read partner-A's row + a forged cross-partner insert fails;
- register `credentials` in `encryptedColumnRegistry.ts` (`kind: 'json'`).
- Cascade parity: mirror whatever the Digital Bridge table does (partner FK
  `ON DELETE CASCADE`); confirm no org-cascade list applies (partner-axis, not org-axis).

## 4. Service — `apps/api/src/services/tdSynnexEcExpress.ts`

Mirrors `tdSynnexDigitalBridge.ts` structure (status/config/test/lookup/import + masking),
adapted to SOAP. Key differences from Digital Bridge: **fixed endpoint host** (region map,
not a user-supplied base URL → no SSRF-config surface) and **SOAP/XML** transport.

- `getEcExpressStatus(actor)` / `saveEcExpressConfig(input, actor)` — upsert by `partner_id`;
  encrypt + merge `{email,password,customerNo}`; `maskConfig` returns `********` for any set
  secret (mirror Digital Bridge masking exactly).
- `endpointForRegion(region)` — `US → https://ws.synnex.com/webservice/pnaserviceV05`;
  other regions throw "unsupported region" until added. Host is a constant allowlist, not
  user input.
- `buildSoapEnvelope(items, settings)` — string template with **XML-escaping** of all
  interpolated values; WS-Security header username `${email};${customerNo}`.
- `lookupProducts(query, actor)` — `query` is one or more exact SKU/MPN tokens (numeric →
  `synnexSku`, else `mfgPartNo`); POST via `safeFetch` with timeout (env-tunable, default
  15s); parse with `fast-xml-parser`; detect `soap:Fault` → typed error
  (`user login failed`→`EC_AUTH_FAILED`, else `EC_PROVIDER_ERROR`); normalize to the product
  shape below. Empty/`NOTFOUND` → `EC_NO_RESULTS`.
- `importCatalogItem(input, actor)` — reuse `createCatalogItem`; store full PA detail in
  `attributes.distributor`.

**New dependency:** `fast-xml-parser` (zero-runtime-dep). Request is built by templating;
only the response is parsed.

**Typed errors** (`TdSynnexEcExpressError` + status map, mirroring the Digital Bridge enum):
`EC_PARTNER_REQUIRED` 400, `EC_NOT_CONFIGURED` 404, `EC_DISABLED` 400,
`EC_CREDENTIALS_INVALID` 400, `EC_AUTH_FAILED` 401, `EC_PROVIDER_ERROR` 502,
`EC_NO_RESULTS` 404, `EC_DUPLICATE_SKU` 409.

### Normalized product → catalog mapping

```
source          = 'td_synnex_ec_express'
sourceProductId = synnexSku                 → catalog sku (canonical, stable, PA-keyed)
mfgPartNo       → attributes.distributor.mfgPartNo (human-facing mfr part #)
description     → catalog name
price           → catalog cost_basis        (reseller cost)
msrp            → suggested unit_price       (fallback: cost × (1 + defaultMarkupPercent))
status, totalQty, stock[], currency, weight, parcelShippable, discount → attributes.distributor (+ availability UI)
raw             → attributes.distributor.raw (full snapshot for audit)
```

Suggested sell price at import = `msrp` when present, else `price × (1 + defaultMarkupPercent)`;
**always editable** in the UI before the item is created.

## 5. Routes — extend `apps/api/src/routes/catalog/distributors.ts`

Same guard trio as the Digital Bridge routes: `requireScope('partner','system')` +
`requirePermission(CATALOG_READ|CATALOG_WRITE)` + `requireMfa` on writes. Zod schemas in
`@breeze/shared`.

| Method | Path | Guard | Body/Query |
|---|---|---|---|
| GET | `/distributors/td-synnex-ec/status` | read | — |
| PUT | `/distributors/td-synnex-ec/config` | MFA + write | region, enabled, credentials{email,password,customerNo}, settings |
| POST | `/distributors/td-synnex-ec/test` | MFA + write | — (PA call for a sentinel SKU; auth fault = fail) |
| GET | `/distributors/td-synnex-ec/lookup` | read | `q` = SKU/MPN (1–40 chars), optional `warehouse` |
| POST | `/distributors/td-synnex-ec/import` | write | product + item{name,sku,unitPrice,costBasis,markupPercent,taxable} |

Credentials in `PUT` accept `null`/omit to preserve, `********` sentinel ignored (mirror
Digital Bridge merge semantics). No `baseUrl` field (host is server-controlled).

## 6. Security

- **Credentials encrypted** at rest (`encryptedColumnRegistry` → `encryptSecret`/
  `decryptForColumn`); `email`, `password`, `customerNo` all encrypted in the `credentials`
  jsonb. Masked (`********`) in all status responses.
- **Partner-axis RLS** enabled + forced; functional `breeze_app` forge test in integration.
- **MFA** required on config/test writes; `CATALOG_READ`/`CATALOG_WRITE` permissions enforced.
- **Fixed endpoint host** per region (no user-supplied URL) — removes the SSRF-config surface
  Digital Bridge needs. Still use `safeFetch` + timeout.
- WS-Security password never logged; SOAP request bodies must be redacted in any debug logging.

## 7. UI — `apps/web/src/components/settings/TdSynnexEcExpressPanel.tsx`

New "TD SYNNEX Pricing" sub-tab under Integrations → Distributors (alongside Pax8 and the
existing Digital Bridge "TD SYNNEX" tab), id `tdsynnex-ec`, deep-linkable via hash.

- **Config:** region, customerNo, email, password (masked), enabled; Save / Test buttons
  surfacing `last_test_*`. All mutations via `runAction` (success/failure always shown).
- **Lookup:** input a SYNNEX SKU or mfg part # → card shows description, status, your cost
  (`price`), MSRP, total available + per-warehouse stock/ETA → **Import to catalog** with an
  editable sell price (prefilled per §4). Reuse `TdSynnexCatalogPanel` patterns; charts/tables
  scoped per existing jsdom conventions.
- Empty/`NOTFOUND` and auth-failure states render explicit messages (no silent no-op).

## 8. Testing

- **Service unit** (`tdSynnexEcExpress.test.ts`): config save/mask/merge; SOAP envelope build
  (XML-escaping, `email;customerNo` username); response parse using the **captured real XML
  fixture** incl. multi-warehouse stock, missing-`discount`, and the `parcelShippable`
  two-p spelling; `soap:Fault` → typed error mapping (`user login failed`→auth, bad-format,
  provider); region→endpoint; import maps fields correctly (add a re-read-the-row assertion).
- **Route unit** (`distributors.test.ts` additions): all five endpoints, Zod validation,
  guard/permission/MFA enforcement, auth-fault → 401 surfacing.
- **Integration** (`catalog-rls.integration.test.ts`): partner isolation + forged-insert
  failure for the new table (BLOCKING job, real `breeze_app`).
- Mock `fetch` with the fixture; no live SYNNEX calls in CI.

## 9. Migration

`apps/api/migrations/2026-06-23-td-synnex-ec-express.sql` — idempotent
(`CREATE TABLE IF NOT EXISTS`, `pg_policies` existence checks), RLS enable+force+policies in
the same file, no inner `BEGIN/COMMIT`. If a same-day dependent migration is added, use the
`-a-`/`-b-` infix. Run `pnpm db:check-drift`; verify a cross-tenant insert fails as
`breeze_app`. Add the RLS-coverage allowlist entry in the same PR.

## 10. Build sequence

1. Migration + schema (`apps/api/src/db/schema/catalog.ts` add table) + encrypted-column
   registry + RLS allowlists/fixtures.
2. Service module + `fast-xml-parser` dependency + unit tests (fixture-driven).
3. Shared Zod schemas + routes + route tests.
4. UI panel + sub-tab + web tests.
5. Integration RLS test; `db:check-drift`; full test pass.

## 11. Open items (non-blocking, decided defaults stand)

- `defaultMarkupPercent` default value (proposed: unset → fall back to `msrp`; if no msrp and
  no markup, leave `unit_price` = `cost` and flag in UI).
- Canada endpoint host (confirm before enabling `region=CA`).
- Phase 2 FTP entitlement (gates all of §1 "full search").

# TD SYNNEX EC Express Pricing Connector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a partner-scoped TD SYNNEX **EC Express** distributor connector that fetches real-time price & availability for a known SYNNEX SKU / mfg part # and imports it into the partner catalog.

**Architecture:** Mirrors the existing Digital Bridge connector but targets the verified EC Express **Price & Availability SOAP** service (`getPriceAvailability` at `ws.synnex.com`, WS-Security `UsernameToken` auth). New partner-axis table `td_synnex_ec_express_integrations` (RLS shape 3, encrypted creds), new service module, routes appended to the existing catalog distributors router, new settings UI sub-tab. Digital Bridge is left untouched.

**Tech Stack:** Hono, Drizzle ORM (PostgreSQL), Zod 4, Vitest, `fast-xml-parser` (new dep), React/Astro (web), pnpm, Node 22.20.0.

**Design spec:** `docs/superpowers/specs/billing/2026-06-23-td-synnex-ec-express-pricing-design.md` (read §2 verified-contract before Task 3).

## Global Constraints

- **Node** pinned to `22.20.0`. Prefix every pnpm/vitest command: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. Fresh worktree needs `pnpm install` first.
- **RLS:** new tenant table gets RLS enabled + forced + partner-axis policy **in the creating migration**; add to `PARTNER_TENANT_TABLES` allowlist in the same PR. Policy predicate: `public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id)`.
- **Migrations:** filename `YYYY-MM-DD-<slug>.sql`; idempotent (`IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`); no inner `BEGIN/COMMIT`; never edit a shipped migration.
- **Secrets:** credential values encrypted via `encryptedColumnRegistry` + `encryptSecret`/`decryptForColumn`; never logged; masked (`********`) in API responses.
- **Auth on routes:** `requireScope('partner','system')` + `requirePermission(CATALOG_READ|CATALOG_WRITE)` + `requireMfa()` on writes.
- **Web mutations** go through `runAction` (success/failure always surfaced).
- **Real-DB tests** live in `src/__tests__/integration/*.integration.test.ts` (BLOCKING job, runs as `breeze_app`); run with `--config vitest.integration.config.ts` and an exported `DATABASE_URL` (test DB on :5433). Unit tests run via `pnpm --filter @breeze/api exec vitest run <path>`.
- **Endpoint host is server-controlled** (region→URL map). There is **no user-supplied base URL** — do not add an SSRF-config field.
- **Verified contract (do not deviate):** `POST https://ws.synnex.com/webservice/pnaserviceV05`, SOAP 1.1, `SOAPAction: ""`, WS-Security `UsernameToken` with `Username = "<email>;<customerNo>"` (semicolon-joined), `Password` = EC Express API password. Live response spells the flag `parcelShippable` (two p's); WSDL says `parcelShipable` — tolerate both.

---

## File Structure

**Create:**
- `apps/api/migrations/2026-06-23-td-synnex-ec-express.sql` — table + RLS.
- `apps/api/src/services/tdSynnexEcExpress.ts` — service (config, SOAP build/parse, lookup, test, import).
- `apps/api/src/services/tdSynnexEcExpress.test.ts` — service unit tests.
- `apps/api/src/services/__fixtures__/ec-express-pna-response.xml` — captured real PA response (test fixture).
- `apps/web/src/components/settings/TdSynnexEcExpressPanel.tsx` — settings UI.
- `apps/web/src/components/settings/TdSynnexEcExpressPanel.test.tsx` — web test.

**Modify:**
- `apps/api/src/db/schema/catalog.ts` — add `tdSynnexEcExpressIntegrations` table.
- `apps/api/src/services/encryptedColumnRegistry.ts` — register `credentials`.
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — add to `PARTNER_TENANT_TABLES`.
- `apps/api/src/__tests__/integration/catalog-rls.integration.test.ts` — seed + isolation asserts.
- `apps/api/src/routes/catalog/distributors.ts` — append EC Express endpoints.
- `apps/api/package.json` — add `fast-xml-parser`.
- `apps/web/src/components/integrations/IntegrationsPage.tsx` — add `tdsynnex-ec` sub-tab.

---

## Task 0: Workspace setup & baseline

**Files:** none (environment only).

- [ ] **Step 1: Install deps in the worktree**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm install`
Expected: completes without engine-strict errors.

- [ ] **Step 2: Baseline the catalog tests pass before changes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/catalog`
Expected: PASS (establishes a clean baseline).

---

## Task 1: Schema, migration, RLS, registry, allowlist + RLS integration test

**Files:**
- Create: `apps/api/migrations/2026-06-23-td-synnex-ec-express.sql`
- Create: `apps/api/src/services/__fixtures__/ec-express-pna-response.xml`
- Modify: `apps/api/src/db/schema/catalog.ts`
- Modify: `apps/api/src/services/encryptedColumnRegistry.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Test: `apps/api/src/__tests__/integration/catalog-rls.integration.test.ts`

**Interfaces:**
- Produces: Drizzle table `tdSynnexEcExpressIntegrations` (columns: `id, partnerId, region, credentials(jsonb), settings(jsonb), enabled, lastTestStatus, lastTestAt, lastTestError, createdBy, createdAt, updatedAt`), exported from `apps/api/src/db/schema/catalog.ts` and re-exported via `db/schema`.

- [ ] **Step 1: Write the failing RLS integration asserts**

In `apps/api/src/__tests__/integration/catalog-rls.integration.test.ts`, add `tdSynnexEcExpressIntegrations` to the schema import, seed it in the fixture (next to `tdSynnexA`), and add three asserts (mirror the existing Digital Bridge ones):

```typescript
// in seedFixture(), after the tdSynnexA insert:
const [ecExpressA] = await db
  .insert(tdSynnexEcExpressIntegrations)
  .values({
    partnerId: partnerA.id,
    region: 'US',
    credentials: {},
    settings: {},
    enabled: true,
  })
  .returning({ id: tdSynnexEcExpressIntegrations.id });
if (!ecExpressA) throw new Error('failed to seed EC Express integration A');
// return ecExpressA from seedFixture alongside the existing returns.

runDb('partner B context cannot read partner A EC Express integration', async () => {
  const { ecExpressA, partnerBContext } = await seedFixture();
  const rowsB = await withDbAccessContext(partnerBContext, () =>
    db.select({ id: tdSynnexEcExpressIntegrations.id })
      .from(tdSynnexEcExpressIntegrations)
      .where(eq(tdSynnexEcExpressIntegrations.id, ecExpressA.id))
  );
  expect(rowsB).toHaveLength(0);
});

runDb('a forged cross-partner EC Express integration insert is rejected by RLS', async () => {
  const { partnerA, partnerBContext } = await seedFixture();
  await expect(
    withDbAccessContext(partnerBContext, () =>
      db.insert(tdSynnexEcExpressIntegrations).values({
        partnerId: partnerA.id, region: 'US', credentials: {}, settings: {}, enabled: true,
      })
    )
  ).rejects.toMatchObject({ cause: { code: '42501' } });
});
```

- [ ] **Step 2: Run the test to confirm it fails (compile error — table undefined)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json`
Expected: FAIL — `tdSynnexEcExpressIntegrations` is not exported.

- [ ] **Step 3: Add the Drizzle table** to `apps/api/src/db/schema/catalog.ts` (after `tdSynnexDigitalBridgeIntegrations`):

```typescript
// Partner-axis (RLS shape 3). TD SYNNEX EC Express Price & Availability SOAP
// connector config for a partner. Secret-bearing values (email, password,
// customerNo) live encrypted in credentials. No base_url: the endpoint host is
// server-controlled via a region map.
export const tdSynnexEcExpressIntegrations = pgTable('td_synnex_ec_express_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  region: varchar('region', { length: 8 }).notNull().default('US'),
  credentials: jsonb('credentials').notNull().default({}),
  settings: jsonb('settings').notNull().default({}),
  enabled: boolean('enabled').notNull().default(false),
  lastTestStatus: varchar('last_test_status', { length: 30 }),
  lastTestAt: timestamp('last_test_at'),
  lastTestError: text('last_test_error'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('td_synnex_ec_express_partner_uq').on(t.partnerId)
]);
```

Confirm `db/schema` barrel re-exports `catalog.ts` (it already exports `tdSynnexDigitalBridgeIntegrations` — same file, so no change needed).

- [ ] **Step 4: Write the migration** `apps/api/migrations/2026-06-23-td-synnex-ec-express.sql`:

```sql
-- TD SYNNEX EC Express Price & Availability connector.
-- Partner-axis (RLS shape 3) with encrypted credential JSON. No base_url:
-- the SOAP endpoint host is server-controlled via a region map.

CREATE TABLE IF NOT EXISTS td_synnex_ec_express_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  region VARCHAR(8) NOT NULL DEFAULT 'US',
  credentials JSONB NOT NULL DEFAULT '{}'::jsonb,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_test_status VARCHAR(30),
  last_test_at TIMESTAMP,
  last_test_error TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS td_synnex_ec_express_partner_uq
  ON td_synnex_ec_express_integrations (partner_id);

ALTER TABLE td_synnex_ec_express_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE td_synnex_ec_express_integrations FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY td_synnex_ec_express_partner_access
    ON td_synnex_ec_express_integrations
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

- [ ] **Step 5: Register the encrypted column** — add to the `encryptedColumnRegistry` array in `apps/api/src/services/encryptedColumnRegistry.ts` (next to the digital bridge entry):

```typescript
{ table: 'td_synnex_ec_express_integrations', column: 'credentials', kind: 'json', description: 'TD SYNNEX EC Express API credentials' },
```

- [ ] **Step 6: Add to the RLS coverage allowlist** — in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, add to `PARTNER_TENANT_TABLES` (next to the digital bridge entry):

```typescript
  ['td_synnex_ec_express_integrations', 'partner_id'],
```

(Do NOT add to `ORG_AXIS_POLICY_EXCLUDED_TABLES` — there is no `org_id` column, so auto-discovery never reaches it.)

- [ ] **Step 7: Save the test fixture** — create `apps/api/src/services/__fixtures__/ec-express-pna-response.xml` with the captured real response (two SKUs is enough to cover array + multi-warehouse + missing-discount):

```xml
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:getPriceAvailabilityResponse xmlns:ns2="http://pnaV05.model.ws.synnex.com/"><return><priceAvail><synnexSku>8938995</synnexSku><mfgPartNo>DELL-U2724D</mfgPartNo><status>ACTIVE</status><description>DELL ULTRASHARP 27 MONITOR - U2724D</description><currency>USD</currency><price>381.35</price><discount>23.81</discount><totalQty>1437</totalQty><totalOnOrder>4377</totalOnOrder><totalBO>204</totalBO><stock code="DSW"><available>1112</available><onOrder>1009</onOrder><bo>0</bo><eta>2026-06-11T00:00:00.000-07:00</eta></stock><stock code="DIN"><available>325</available><onOrder>2537</onOrder><bo>0</bo></stock><msrp>549.99</msrp><parcelShippable>Y</parcelShippable><weight>20.50</weight></priceAvail><priceAvail><synnexSku>9188575</synnexSku><mfgPartNo>8X8-00164</mfgPartNo><status>ACTIVE</status><description>Microsoft Surface Pro Keyboard w/slim pen platinum commercial 1 license</description><currency>USD</currency><price>209.08</price><totalQty>201</totalQty><totalOnOrder>1050</totalOnOrder><totalBO>5</totalBO><stock code="DON"><available>27</available><onOrder>130</onOrder><bo>1</bo></stock><msrp>0</msrp><parcelShippable>Y</parcelShippable><weight>1.20</weight></priceAvail></return></ns2:getPriceAvailabilityResponse></soap:Body></soap:Envelope>
```

- [ ] **Step 8: Apply the migration to the local test DB and check drift**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift`
Expected: no drift (schema matches migrations).

- [ ] **Step 9: Run the RLS integration test (real DB)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/catalog-rls.integration.test.ts`
Expected: PASS including the 2 new EC Express asserts. (Requires the test DB on :5433; if unavailable locally, note it and rely on the BLOCKING CI Integration job.)

- [ ] **Step 10: Commit**

```bash
git add apps/api/migrations/2026-06-23-td-synnex-ec-express.sql apps/api/src/db/schema/catalog.ts apps/api/src/services/encryptedColumnRegistry.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/catalog-rls.integration.test.ts apps/api/src/services/__fixtures__/ec-express-pna-response.xml
git commit -m "feat(catalog): add td_synnex_ec_express_integrations table + RLS"
```

---

## Task 2: Service — types, errors, config CRUD + masking

**Files:**
- Create: `apps/api/src/services/tdSynnexEcExpress.ts`
- Test: `apps/api/src/services/tdSynnexEcExpress.test.ts`

**Interfaces:**
- Produces: `getEcExpressStatus(actor)`, `saveEcExpressConfig(input, actor)`, `EC_MASKED_SECRET`, `TdSynnexEcExpressError`, types `TdSynnexEcExpressConfigInput`, `TdSynnexEcExpressCredentials`, `TdSynnexEcExpressSettings`, `TdSynnexEcProduct`.
- Consumes: `db`, `tdSynnexEcExpressIntegrations` (Task 1), `encryptSecret`/`decryptForColumn`, `CatalogActor`.

- [ ] **Step 1: Write failing config unit tests** in `apps/api/src/services/tdSynnexEcExpress.test.ts` (mock `../db` and `./secretCrypto` exactly as `tdSynnexDigitalBridge.test.ts` does):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../db', () => ({ db: { select: vi.fn(), insert: vi.fn() } }));
vi.mock('./secretCrypto', () => ({
  encryptSecret: vi.fn((v: string) => `enc(${v})`),
  decryptForColumn: vi.fn((_t, _c, v: string) => (v?.startsWith('enc(') ? v.slice(4, -1) : v)),
}));
// ... mock createCatalogItem from ./catalogService as a no-op spy.

import { getEcExpressStatus, saveEcExpressConfig, EC_MASKED_SECRET } from './tdSynnexEcExpress';

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };

it('masks secrets in status output', async () => {
  // arrange db.select to return a row with credentials { email:'enc(a@b.co)', password:'enc(pw)', customerNo:'enc(123)' }
  const status = await getEcExpressStatus(actor);
  expect(status.credentials).toEqual({ email: EC_MASKED_SECRET, password: EC_MASKED_SECRET, customerNo: EC_MASKED_SECRET });
  expect(status.configured).toBe(true);
});

it('ignores the masked sentinel on save (preserves existing secret)', async () => {
  // arrange existing row with encrypted password; save with password = EC_MASKED_SECRET
  // assert the upserted credentials still contain the original enc(pw), not enc(********)
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/tdSynnexEcExpress.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the config half of the service** — create `apps/api/src/services/tdSynnexEcExpress.ts`:

```typescript
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { tdSynnexEcExpressIntegrations } from '../db/schema';
import { encryptSecret, decryptForColumn } from './secretCrypto';
import { createCatalogItem, type CatalogActor } from './catalogService';
import type { CreateCatalogItemInput } from '@breeze/shared';

const TABLE = 'td_synnex_ec_express_integrations';
const CREDENTIALS_COLUMN = 'credentials';
export const EC_MASKED_SECRET = '********';

const REGION_ENDPOINTS: Record<string, string> = {
  US: 'https://ws.synnex.com/webservice/pnaserviceV05',
};

const EC_ERROR_STATUS = {
  EC_PARTNER_REQUIRED: 400,
  EC_NOT_CONFIGURED: 404,
  EC_DISABLED: 400,
  EC_CREDENTIALS_INVALID: 400,
  EC_AUTH_FAILED: 401,
  EC_PROVIDER_ERROR: 502,
  EC_NO_RESULTS: 404,
  EC_DUPLICATE_SKU: 409,
  EC_UNSUPPORTED_REGION: 400,
} as const;
export type TdSynnexEcExpressErrorCode = keyof typeof EC_ERROR_STATUS;

export class TdSynnexEcExpressError extends Error {
  public readonly status: number;
  constructor(message: string, public readonly code: TdSynnexEcExpressErrorCode = 'EC_PROVIDER_ERROR') {
    super(message);
    this.name = 'TdSynnexEcExpressError';
    this.status = EC_ERROR_STATUS[code];
  }
}

export interface TdSynnexEcExpressCredentials { email?: string | null; password?: string | null; customerNo?: string | null; }
export interface TdSynnexEcExpressSettings { defaultWarehouse?: string; hideZeroInv?: boolean; defaultMarkupPercent?: number; }
export interface TdSynnexEcExpressConfigInput { region: string; enabled: boolean; credentials?: TdSynnexEcExpressCredentials; settings?: TdSynnexEcExpressSettings; }

export interface TdSynnexEcProduct {
  source: 'td_synnex_ec_express';
  synnexSku: string;
  mfgPartNo: string | null;
  status: string | null;
  name: string;
  description: string | null;
  currency: string | null;
  cost: string | null;       // <price> = reseller cost
  msrp: string | null;
  discount: string | null;
  totalQty: number | null;
  warehouses: Array<{ code: string | null; available: number; onOrder: number; bo: number; eta: string | null }>;
  weight: string | null;
  parcelShippable: string | null;
  raw: Record<string, unknown>;
}

function requirePartner(actor: CatalogActor): string {
  if (!actor.partnerId) throw new TdSynnexEcExpressError('EC Express integration is partner-scoped', 'EC_PARTNER_REQUIRED');
  return actor.partnerId;
}
function asRecord(v: unknown): Record<string, unknown> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; }
function decryptCredential(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new TdSynnexEcExpressError('Stored EC Express credentials are corrupt — re-enter them', 'EC_CREDENTIALS_INVALID');
  if (v.length === 0) return null;
  return decryptForColumn(TABLE, CREDENTIALS_COLUMN, v);
}
function mergeCredentialField(out: Record<string, unknown>, key: 'email' | 'password' | 'customerNo', v: unknown) {
  if (v === undefined || v === EC_MASKED_SECRET) return;
  if (v === null || (typeof v === 'string' && v.trim().length === 0)) { delete out[key]; return; }
  if (typeof v === 'string') out[key] = encryptSecret(v.trim());
}
function mergeCredentials(existing: unknown, next: TdSynnexEcExpressCredentials | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...asRecord(existing) };
  if (!next) return out;
  mergeCredentialField(out, 'email', next.email);
  mergeCredentialField(out, 'password', next.password);
  mergeCredentialField(out, 'customerNo', next.customerNo);
  return out;
}
function maskConfig(row: typeof tdSynnexEcExpressIntegrations.$inferSelect | null) {
  if (!row) return { configured: false, enabled: false };
  const c = asRecord(row.credentials);
  const hasEmail = typeof c.email === 'string' && c.email.length > 0;
  const hasPassword = typeof c.password === 'string' && c.password.length > 0;
  const hasCustomerNo = typeof c.customerNo === 'string' && c.customerNo.length > 0;
  return {
    configured: hasEmail && hasPassword && hasCustomerNo,
    id: row.id, region: row.region, enabled: row.enabled,
    credentials: {
      email: hasEmail ? EC_MASKED_SECRET : '',
      password: hasPassword ? EC_MASKED_SECRET : '',
      customerNo: hasCustomerNo ? EC_MASKED_SECRET : '',
    },
    settings: asRecord(row.settings),
    lastTestStatus: row.lastTestStatus, lastTestAt: row.lastTestAt, lastTestError: row.lastTestError,
  };
}

export async function getEcExpressStatus(actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const [row] = await db.select().from(tdSynnexEcExpressIntegrations).where(eq(tdSynnexEcExpressIntegrations.partnerId, partnerId)).limit(1);
  return maskConfig(row ?? null);
}

export async function saveEcExpressConfig(input: TdSynnexEcExpressConfigInput, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  if (!REGION_ENDPOINTS[input.region]) throw new TdSynnexEcExpressError(`Unsupported region: ${input.region}`, 'EC_UNSUPPORTED_REGION');
  const [current] = await db.select().from(tdSynnexEcExpressIntegrations).where(eq(tdSynnexEcExpressIntegrations.partnerId, partnerId)).limit(1);
  const credentials = mergeCredentials(current?.credentials, input.credentials);
  const settings = { defaultWarehouse: 'ANY', hideZeroInv: false, ...asRecord(current?.settings), ...asRecord(input.settings) };
  const [row] = await db.insert(tdSynnexEcExpressIntegrations)
    .values({ partnerId, region: input.region, credentials, settings, enabled: input.enabled, createdBy: actor.userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: tdSynnexEcExpressIntegrations.partnerId, set: { region: input.region, credentials, settings, enabled: input.enabled, updatedAt: new Date() } })
    .returning();
  return maskConfig(row ?? null);
}

// --- internal helpers reused by Task 3/4 ---
export function endpointForRegion(region: string): string {
  const url = REGION_ENDPOINTS[region];
  if (!url) throw new TdSynnexEcExpressError(`Unsupported region: ${region}`, 'EC_UNSUPPORTED_REGION');
  return url;
}
export function decryptCredentials(row: typeof tdSynnexEcExpressIntegrations.$inferSelect): { email: string; password: string; customerNo: string } {
  const c = asRecord(row.credentials);
  const email = decryptCredential(c.email), password = decryptCredential(c.password), customerNo = decryptCredential(c.customerNo);
  if (!email || !password || !customerNo) throw new TdSynnexEcExpressError('EC Express credentials are not fully configured', 'EC_CREDENTIALS_INVALID');
  return { email, password, customerNo };
}
```

- [ ] **Step 4: Run the config tests**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/tdSynnexEcExpress.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/tdSynnexEcExpress.ts apps/api/src/services/tdSynnexEcExpress.test.ts
git commit -m "feat(catalog): EC Express service config + credential masking"
```

---

## Task 3: Service — SOAP envelope build, response parse, lookup + test connection

**Files:**
- Modify: `apps/api/src/services/tdSynnexEcExpress.ts`
- Modify: `apps/api/src/services/tdSynnexEcExpress.test.ts`
- Modify: `apps/api/package.json` (add `fast-xml-parser`)

**Interfaces:**
- Produces: `lookupEcExpressProducts(query: string, actor): Promise<TdSynnexEcProduct[]>`, `testEcExpressConnection(actor): Promise<{ ok: boolean; error?: string }>`, and internal `buildSoapEnvelope`, `parsePnaResponse` (exported for unit test).

- [ ] **Step 1: Add the dependency**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api add fast-xml-parser`
Expected: adds `fast-xml-parser` to `apps/api/package.json` and updates the lockfile.

- [ ] **Step 2: Write failing build/parse unit tests** (append to `tdSynnexEcExpress.test.ts`):

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSoapEnvelope, parsePnaResponse } from './tdSynnexEcExpress';

it('builds a WS-Security envelope with semicolon-joined username and escaped values', () => {
  const xml = buildSoapEnvelope({ email: 'a@b.co', password: 'p<w&d', customerNo: '654906' },
    [{ kind: 'sku', value: '8938995' }], { defaultWarehouse: 'ANY', hideZeroInv: false });
  expect(xml).toContain('<wsse:Username>a@b.co;654906</wsse:Username>');
  expect(xml).toContain('<wsse:Password>p&lt;w&amp;d</wsse:Password>');
  expect(xml).toContain('<synnexSku>8938995</synnexSku>');
  expect(xml).toContain('<warehouse>ANY</warehouse>');
});

it('parses a real multi-SKU PA response into products', () => {
  const xml = readFileSync(join(__dirname, '__fixtures__/ec-express-pna-response.xml'), 'utf8');
  const products = parsePnaResponse(xml);
  expect(products).toHaveLength(2);
  expect(products[0]).toMatchObject({ synnexSku: '8938995', mfgPartNo: 'DELL-U2724D', cost: '381.35', msrp: '549.99', totalQty: 1437, parcelShippable: 'Y' });
  expect(products[0].warehouses).toHaveLength(2);
  expect(products[1].discount).toBeNull(); // missing <discount> tolerated
});

it('maps soap:Fault "user login failed" to EC_AUTH_FAILED', () => {
  const fault = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:000000</faultcode><faultstring>user login failed</faultstring></soap:Fault></soap:Body></soap:Envelope>';
  expect(() => parsePnaResponse(fault)).toThrow(/login failed/i);
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/tdSynnexEcExpress.test.ts`
Expected: FAIL — `buildSoapEnvelope`/`parsePnaResponse` not exported.

- [ ] **Step 4: Implement SOAP build, parse, lookup, test** — append to `tdSynnexEcExpress.ts`:

```typescript
import { XMLParser } from 'fast-xml-parser';
import { safeFetch } from './urlSafety';
import { eq as _eq } from 'drizzle-orm'; // already imported as eq above; reuse it

const WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const PNA_NS = 'http://pnaV05.model.ws.synnex.com/';
const REQUEST_TIMEOUT_MS = 15_000;

export type LookupItem = { kind: 'sku' | 'mpn'; value: string };

function xmlEscape(v: string): string {
  return v.replace(/[<>&'"]/g, (ch) => ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch === "'" ? '&apos;' : '&quot;');
}

export function buildSoapEnvelope(creds: { email: string; password: string; customerNo: string }, items: LookupItem[], settings: TdSynnexEcExpressSettings): string {
  const username = xmlEscape(`${creds.email};${creds.customerNo}`);
  const password = xmlEscape(creds.password);
  const warehouse = xmlEscape(settings.defaultWarehouse ?? 'ANY');
  const hideZeroInv = settings.hideZeroInv ? 'true' : 'false';
  const skuXml = items.map((it) => it.kind === 'sku'
    ? `<skuList><synnexSku>${xmlEscape(it.value)}</synnexSku></skuList>`
    : `<skuList><mfgPartNo>${xmlEscape(it.value)}</mfgPartNo></skuList>`).join('');
  return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:pna="${PNA_NS}">`
    + `<soapenv:Header><wsse:Security xmlns:wsse="${WSSE}"><wsse:UsernameToken>`
    + `<wsse:Username>${username}</wsse:Username><wsse:Password>${password}</wsse:Password>`
    + `</wsse:UsernameToken></wsse:Security></soapenv:Header>`
    + `<soapenv:Body><pna:getPriceAvailability><arg0>${skuXml}`
    + `<warehouse>${warehouse}</warehouse><hideZeroInv>${hideZeroInv}</hideZeroInv>`
    + `</arg0></pna:getPriceAvailability></soapenv:Body></soapenv:Envelope>`;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false });

function num(v: unknown): number | null { const n = Number(v); return Number.isFinite(n) ? n : null; }
function str(v: unknown): string | null { return v === undefined || v === null || v === '' ? null : String(v); }

function normalizeDetail(d: Record<string, unknown>): TdSynnexEcProduct {
  const rawStock = d.stock === undefined ? [] : Array.isArray(d.stock) ? d.stock : [d.stock];
  const warehouses = (rawStock as Record<string, unknown>[]).map((s) => ({
    code: str(s['@_code']), available: num(s.available) ?? 0, onOrder: num(s.onOrder) ?? 0, bo: num(s.bo) ?? 0, eta: str(s.eta),
  }));
  // live response spells it parcelShippable (two p's); WSDL says parcelShipable — accept both.
  const parcel = str(d.parcelShippable) ?? str(d.parcelShipable);
  const msrp = str(d.msrp);
  return {
    source: 'td_synnex_ec_express',
    synnexSku: String(d.synnexSku ?? ''),
    mfgPartNo: str(d.mfgPartNo),
    status: str(d.status),
    name: str(d.description) ?? String(d.synnexSku ?? ''),
    description: str(d.description),
    currency: str(d.currency),
    cost: str(d.price),
    msrp: msrp === '0' ? null : msrp,
    discount: str(d.discount),
    totalQty: num(d.totalQty),
    warehouses,
    weight: str(d.weight),
    parcelShippable: parcel,
    raw: d,
  };
}

export function parsePnaResponse(xml: string): TdSynnexEcProduct[] {
  const doc = parser.parse(xml) as Record<string, any>;
  const body = doc?.Envelope?.Body;
  if (!body) throw new TdSynnexEcExpressError('Malformed TD SYNNEX response', 'EC_PROVIDER_ERROR');
  const fault = body.Fault;
  if (fault) {
    const msg = String(fault.faultstring ?? 'TD SYNNEX PA fault');
    if (/login failed/i.test(msg)) throw new TdSynnexEcExpressError(msg, 'EC_AUTH_FAILED');
    throw new TdSynnexEcExpressError(msg, 'EC_PROVIDER_ERROR');
  }
  const ret = body.getPriceAvailabilityResponse?.return;
  if (ret?.errorMessage) throw new TdSynnexEcExpressError(String(ret.errorMessage), 'EC_PROVIDER_ERROR');
  if (!ret?.priceAvail) return [];
  const details = Array.isArray(ret.priceAvail) ? ret.priceAvail : [ret.priceAvail];
  return (details as Record<string, unknown>[]).map(normalizeDetail);
}

async function getActiveIntegration(actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const [row] = await db.select().from(tdSynnexEcExpressIntegrations).where(eq(tdSynnexEcExpressIntegrations.partnerId, partnerId)).limit(1);
  if (!row) throw new TdSynnexEcExpressError('EC Express is not configured', 'EC_NOT_CONFIGURED');
  if (!row.enabled) throw new TdSynnexEcExpressError('EC Express is disabled', 'EC_DISABLED');
  return row;
}

async function callPna(row: typeof tdSynnexEcExpressIntegrations.$inferSelect, items: LookupItem[]): Promise<TdSynnexEcProduct[]> {
  const creds = decryptCredentials(row);
  const url = endpointForRegion(row.region);
  const envelope = buildSoapEnvelope(creds, items, asRecord(row.settings) as TdSynnexEcExpressSettings);
  let res: Response;
  try {
    res = await safeFetch(url, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: '""' }, body: envelope, timeoutMs: REQUEST_TIMEOUT_MS });
  } catch {
    throw new TdSynnexEcExpressError('Could not reach TD SYNNEX', 'EC_PROVIDER_ERROR');
  }
  const text = await res.text();
  return parsePnaResponse(text); // parse handles soap:Fault even on HTTP 500
}

export async function lookupEcExpressProducts(query: string, actor: CatalogActor): Promise<TdSynnexEcProduct[]> {
  const row = await getActiveIntegration(actor);
  const token = query.trim();
  if (!token) throw new TdSynnexEcExpressError('Provide a SYNNEX SKU or mfg part #', 'EC_NO_RESULTS');
  const item: LookupItem = /^\d+$/.test(token) ? { kind: 'sku', value: token } : { kind: 'mpn', value: token };
  const products = await callPna(row, [item]);
  const found = products.filter((p) => p.status !== 'NOTFOUND');
  if (found.length === 0) throw new TdSynnexEcExpressError('No results for that SKU/part #', 'EC_NO_RESULTS');
  return found;
}

export async function testEcExpressConnection(actor: CatalogActor): Promise<{ ok: boolean; error?: string }> {
  const partnerId = requirePartner(actor);
  const [row] = await db.select().from(tdSynnexEcExpressIntegrations).where(eq(tdSynnexEcExpressIntegrations.partnerId, partnerId)).limit(1);
  if (!row) throw new TdSynnexEcExpressError('EC Express is not configured', 'EC_NOT_CONFIGURED');
  const finish = async (status: 'ok' | 'error', error?: string) => {
    await db.update(tdSynnexEcExpressIntegrations).set({ lastTestStatus: status, lastTestAt: new Date(), lastTestError: error ?? null, updatedAt: new Date() }).where(eq(tdSynnexEcExpressIntegrations.partnerId, partnerId));
  };
  try {
    await callPna(row, [{ kind: 'sku', value: '1' }]); // any non-fault response = auth OK (NOTFOUND is fine)
    await finish('ok');
    return { ok: true };
  } catch (err) {
    const msg = err instanceof TdSynnexEcExpressError ? err.message : 'Connection failed';
    if (err instanceof TdSynnexEcExpressError && err.code === 'EC_AUTH_FAILED') { await finish('error', msg); return { ok: false, error: msg }; }
    if (err instanceof TdSynnexEcExpressError && (err.code === 'EC_NO_RESULTS' || err.code === 'EC_PROVIDER_ERROR')) { await finish('ok'); return { ok: true }; }
    await finish('error', msg);
    return { ok: false, error: msg };
  }
}
```

Note: remove the bogus `import { eq as _eq }` line — `eq` is already imported in Task 2's top block. (Listed here only to flag the dependency; do not duplicate the import.)

- [ ] **Step 5: Run the tests**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/tdSynnexEcExpress.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/tdSynnexEcExpress.ts apps/api/src/services/tdSynnexEcExpress.test.ts apps/api/package.json ../../pnpm-lock.yaml
git commit -m "feat(catalog): EC Express PA SOAP lookup + connection test"
```

---

## Task 4: Service — import a looked-up product into the catalog

**Files:**
- Modify: `apps/api/src/services/tdSynnexEcExpress.ts`
- Modify: `apps/api/src/services/tdSynnexEcExpress.test.ts`

**Interfaces:**
- Produces: `importEcExpressCatalogItem(input: EcImportInput, actor): Promise<...>` where `EcImportInput = { product: TdSynnexEcProduct; item: { name: string; sku?: string | null; description?: string | null; unitPrice: number; costBasis?: number | null; markupPercent?: number | null; taxable?: boolean } }`.
- Consumes: `createCatalogItem` from `./catalogService`, `CreateCatalogItemInput` from `@breeze/shared`.

- [ ] **Step 1: Write the failing import test** (append):

```typescript
it('imports a product into the catalog with a distributor snapshot', async () => {
  const createSpy = vi.mocked(createCatalogItem).mockResolvedValue({ id: 'item1' } as any);
  const product = { source: 'td_synnex_ec_express', synnexSku: '8938995', mfgPartNo: 'DELL-U2724D', status: 'ACTIVE', name: 'Dell U2724D', description: 'Dell U2724D', currency: 'USD', cost: '381.35', msrp: '549.99', discount: null, totalQty: 1437, warehouses: [], weight: '20.50', parcelShippable: 'Y', raw: {} };
  await importEcExpressCatalogItem({ product, item: { name: 'Dell U2724D', sku: '8938995', unitPrice: 549.99, costBasis: 381.35, taxable: true } }, actor);
  const arg = createSpy.mock.calls[0][0];
  expect(arg).toMatchObject({ itemType: 'hardware', name: 'Dell U2724D', sku: '8938995', unitPrice: 549.99, costBasis: 381.35 });
  expect((arg.attributes as any).distributor.source).toBe('td_synnex_ec_express');
  expect((arg.attributes as any).distributor.synnexSku).toBe('8938995');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/tdSynnexEcExpress.test.ts`
Expected: FAIL — `importEcExpressCatalogItem` not defined.

- [ ] **Step 3: Implement import** (append to `tdSynnexEcExpress.ts`):

```typescript
export interface EcImportInput {
  product: TdSynnexEcProduct;
  item: { name: string; sku?: string | null; description?: string | null; unitPrice: number; costBasis?: number | null; markupPercent?: number | null; taxable?: boolean };
}

export async function importEcExpressCatalogItem(input: EcImportInput, actor: CatalogActor) {
  const { product, item } = input;
  const payload: CreateCatalogItemInput = {
    itemType: 'hardware',
    name: item.name,
    sku: item.sku ?? product.synnexSku,
    description: item.description ?? product.description ?? undefined,
    billingType: 'one_time',
    unitPrice: item.unitPrice,
    costBasis: item.costBasis ?? (product.cost ? Number(product.cost) : undefined),
    markupPercent: item.markupPercent ?? undefined,
    unitOfMeasure: 'each',
    taxable: item.taxable ?? true,
    isBundle: false,
    attributes: {
      distributor: {
        source: product.source, synnexSku: product.synnexSku, mfgPartNo: product.mfgPartNo,
        status: product.status, currency: product.currency, cost: product.cost, msrp: product.msrp,
        totalQty: product.totalQty, weight: product.weight, parcelShippable: product.parcelShippable,
        warehouses: product.warehouses, raw: product.raw, importedAt: new Date().toISOString(),
      },
    },
  };
  return createCatalogItem(payload, actor);
}
```

- [ ] **Step 4: Run the tests**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/tdSynnexEcExpress.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/tdSynnexEcExpress.ts apps/api/src/services/tdSynnexEcExpress.test.ts
git commit -m "feat(catalog): import EC Express product into catalog"
```

---

## Task 5: Routes — status / config / test / lookup / import

**Files:**
- Modify: `apps/api/src/routes/catalog/distributors.ts`
- Test: `apps/api/src/routes/catalog/distributors.test.ts`

**Interfaces:**
- Consumes the Task 2–4 service exports. Adds 5 routes under `catalogDistributorRoutes`:
  `GET /distributors/td-synnex-ec/status`, `PUT /distributors/td-synnex-ec/config`, `POST /distributors/td-synnex-ec/test`, `GET /distributors/td-synnex-ec/lookup`, `POST /distributors/td-synnex-ec/import`.

- [ ] **Step 1: Write failing route tests** (append to `distributors.test.ts`, mirroring the existing TD SYNNEX route suite; mock `../../services/tdSynnexEcExpress`):

```typescript
describe('catalog EC Express distributor routes', () => {
  it('GET /distributors/td-synnex-ec/status returns masked status', async () => {
    vi.mocked(getEcExpressStatus).mockResolvedValue({ configured: true, enabled: true } as any);
    const res = await app.request('/distributors/td-synnex-ec/status', { headers: partnerAuthHeaders });
    expect(res.status).toBe(200);
  });
  it('PUT config rejects an unknown region with 400', async () => {
    const res = await app.request('/distributors/td-synnex-ec/config', { method: 'PUT', headers: jsonPartnerHeaders, body: JSON.stringify({ region: 'XX', enabled: true }) });
    expect(res.status).toBe(400);
  });
  it('GET lookup surfaces EC_AUTH_FAILED as 401', async () => {
    vi.mocked(lookupEcExpressProducts).mockRejectedValue(new TdSynnexEcExpressError('user login failed', 'EC_AUTH_FAILED'));
    const res = await app.request('/distributors/td-synnex-ec/lookup?q=8938995', { headers: partnerAuthHeaders });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/catalog/distributors.test.ts`
Expected: FAIL — routes 404 / imports missing.

- [ ] **Step 3: Add imports + schemas + handlers** to `apps/api/src/routes/catalog/distributors.ts`.

Imports (add to the existing service import block):
```typescript
import {
  getEcExpressStatus, saveEcExpressConfig, testEcExpressConnection,
  lookupEcExpressProducts, importEcExpressCatalogItem, TdSynnexEcExpressError,
  type TdSynnexEcProduct,
} from '../../services/tdSynnexEcExpress';
```

Schemas + error handler:
```typescript
const ecConfigSchema = z.object({
  region: z.string().min(1).max(8).default('US'),
  enabled: z.boolean().default(false),
  credentials: z.object({
    email: z.string().max(320).nullable().optional(),
    password: z.string().max(1000).nullable().optional(),
    customerNo: z.string().max(64).nullable().optional(),
  }).optional(),
  settings: z.object({
    defaultWarehouse: z.string().max(16).optional(),
    hideZeroInv: z.boolean().optional(),
    defaultMarkupPercent: z.number().min(0).max(9999.99).optional(),
  }).optional(),
});
const ecLookupSchema = z.object({ q: z.string().min(1).max(40) });
const ecImportSchema = z.object({
  product: z.record(z.string(), z.unknown()),
  item: z.object({
    name: z.string().min(1).max(255),
    sku: z.string().max(100).nullable().optional(),
    description: z.string().max(10_000).nullable().optional(),
    unitPrice: z.number().nonnegative().max(9_999_999_999.99).multipleOf(0.01),
    costBasis: z.number().nonnegative().max(9_999_999_999.99).multipleOf(0.01).nullable().optional(),
    markupPercent: z.number().min(0).max(9999.99).multipleOf(0.01).nullable().optional(),
    taxable: z.boolean().optional(),
  }),
});

function handleEcError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof TdSynnexEcExpressError) return c.json({ error: err.message, code: err.code }, err.status);
  if (err instanceof CatalogServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  console.error('[td-synnex-ec] unexpected error', err);
  throw err;
}
```

Handlers:
```typescript
catalogDistributorRoutes.get('/distributors/td-synnex-ec/status', scopes, readPerm, async (c) => {
  try { return c.json({ data: await getEcExpressStatus(catalogActorFrom(c)) }); } catch (err) { return handleEcError(c, err); }
});
catalogDistributorRoutes.put('/distributors/td-synnex-ec/config', scopes, writePerm, requireMfa(), zValidator('json', ecConfigSchema), async (c) => {
  try { return c.json({ data: await saveEcExpressConfig(c.req.valid('json'), catalogActorFrom(c)) }); } catch (err) { return handleEcError(c, err); }
});
catalogDistributorRoutes.post('/distributors/td-synnex-ec/test', scopes, writePerm, requireMfa(), async (c) => {
  try { return c.json({ data: await testEcExpressConnection(catalogActorFrom(c)) }); } catch (err) { return handleEcError(c, err); }
});
catalogDistributorRoutes.get('/distributors/td-synnex-ec/lookup', scopes, readPerm, zValidator('query', ecLookupSchema), async (c) => {
  try { return c.json({ data: await lookupEcExpressProducts(c.req.valid('query').q, catalogActorFrom(c)) }); } catch (err) { return handleEcError(c, err); }
});
catalogDistributorRoutes.post('/distributors/td-synnex-ec/import', scopes, writePerm, zValidator('json', ecImportSchema), async (c) => {
  try {
    const body = c.req.valid('json');
    const data = await importEcExpressCatalogItem({ product: body.product as unknown as TdSynnexEcProduct, item: body.item }, catalogActorFrom(c));
    return c.json({ data });
  } catch (err) { return handleEcError(c, err); }
});
```

- [ ] **Step 4: Run the route tests**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/catalog/distributors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/catalog/distributors.ts apps/api/src/routes/catalog/distributors.test.ts
git commit -m "feat(catalog): EC Express distributor routes"
```

---

## Task 6: Web UI — EC Express settings panel + Distributors sub-tab

**Files:**
- Create: `apps/web/src/components/settings/TdSynnexEcExpressPanel.tsx`
- Test: `apps/web/src/components/settings/TdSynnexEcExpressPanel.test.tsx`
- Modify: `apps/web/src/components/integrations/IntegrationsPage.tsx`

**Interfaces:**
- Consumes the Task 5 routes via `fetchWithAuth` + `runAction`. The panel calls: GET `/catalog/distributors/td-synnex-ec/status`, PUT `…/config`, POST `…/test`, GET `…/lookup?q=`, POST `…/import`.

- [ ] **Step 1: Write a failing web test** `TdSynnexEcExpressPanel.test.tsx` (mirror `TdSynnexCatalogPanel.test.tsx`; stub `fetchWithAuth`):

```typescript
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
// mock ../../stores/auth fetchWithAuth to return a configured status
import { TdSynnexEcExpressPanel } from './TdSynnexEcExpressPanel';

it('renders config fields and the SKU lookup box after loading status', async () => {
  render(<TdSynnexEcExpressPanel />);
  await waitFor(() => expect(screen.getByLabelText(/Customer No/i)).toBeInTheDocument());
  expect(screen.getByPlaceholderText(/SYNNEX SKU or mfg part/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/settings/TdSynnexEcExpressPanel.test.tsx`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement `TdSynnexEcExpressPanel.tsx`.** Model it on `TdSynnexCatalogPanel.tsx`: load status on mount; a config form with `region`, `customerNo`, `email`, `password` (masked, sentinel `********`), `enabled`, Save + Test buttons; a lookup input (`placeholder="SYNNEX SKU or mfg part #"`) that GETs `…/lookup?q=`; render result card(s) showing description, status, your cost (`cost`), MSRP, `totalQty` + per-warehouse stock; an "Import to catalog" action that POSTs `…/import` with an editable sell price prefilled from `msrp` (fallback `cost`). All mutations wrapped in `runAction`. Field labels must include `Customer No`, `Email`, `Password`. Status type:

```typescript
interface EcStatus {
  configured: boolean; enabled: boolean; region?: string;
  credentials?: { email?: string; password?: string; customerNo?: string };
  settings?: { defaultWarehouse?: string; hideZeroInv?: boolean; defaultMarkupPercent?: number };
  lastTestStatus?: string | null; lastTestAt?: string | null; lastTestError?: string | null;
}
interface EcProduct {
  source: 'td_synnex_ec_express'; synnexSku: string; mfgPartNo: string | null; status: string | null;
  name: string; description: string | null; currency: string | null; cost: string | null; msrp: string | null;
  discount: string | null; totalQty: number | null;
  warehouses: Array<{ code: string | null; available: number; onOrder: number; bo: number; eta: string | null }>;
  weight: string | null; parcelShippable: string | null; raw: Record<string, unknown>;
}
export function TdSynnexEcExpressPanel() { /* … */ }
```

- [ ] **Step 4: Wire the sub-tab into `IntegrationsPage.tsx`:**

```typescript
// 1) widen the type:
type DistributorSubTab = 'pax8' | 'tdsynnex' | 'tdsynnex-ec';
// 2) add to distributorSubTabs:
const distributorSubTabs: { id: DistributorSubTab; label: string }[] = [
  { id: 'pax8', label: 'Pax8' },
  { id: 'tdsynnex', label: 'TD SYNNEX' },
  { id: 'tdsynnex-ec', label: 'TD SYNNEX Pricing' },
];
// 3) import the panel and render it where the distributor panels are switched:
{activeTab === 'distributors' && !isOrgScoped && distributorSubTab === 'tdsynnex-ec' && <TdSynnexEcExpressPanel />}
```

(Match the existing render pattern for the `tdsynnex`/`pax8` panels in this file — render the EC panel under the same `activeTab === 'distributors'` block, guarded by `distributorSubTab === 'tdsynnex-ec'`.)

- [ ] **Step 5: Run the web test**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/settings/TdSynnexEcExpressPanel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/settings/TdSynnexEcExpressPanel.tsx apps/web/src/components/settings/TdSynnexEcExpressPanel.test.tsx apps/web/src/components/integrations/IntegrationsPage.tsx
git commit -m "feat(web): TD SYNNEX Pricing (EC Express) settings panel"
```

---

## Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: API unit + type check**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/tdSynnexEcExpress.test.ts src/routes/catalog/distributors.test.ts`
Then: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json`
Expected: all PASS, no type errors.

- [ ] **Step 2: Web test + astro check**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/settings/TdSynnexEcExpressPanel.test.tsx`
Then: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec astro check` (catches `.astro` type issues `tsc` skips).
Expected: PASS.

- [ ] **Step 3: Drift check**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift`
Expected: no drift.

- [ ] **Step 4: Integration RLS (real DB; or rely on CI Integration job)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/catalog-rls.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts`
Expected: PASS (the new table appears in coverage and passes partner isolation).

- [ ] **Step 5: Manual sanity (optional, live creds in scratchpad)** — verify a real lookup still returns data via the service path; do NOT commit creds.

---

## Self-Review (completed by plan author)

- **Spec coverage:** §3 data model → Task 1; §4 service (config/SOAP/lookup/test/import) → Tasks 2–4; §5 routes → Task 5; §6 security (encrypted creds, MFA, masking, fixed host, timeout) → Tasks 1/2/3/5; §7 UI → Task 6; §8 testing → every task + Task 7; §9 migration → Task 1. Phase-2/full-search explicitly out of scope (no task) — correct.
- **Placeholder scan:** all code steps contain complete code; the one prose UI step (Task 6 Step 3) lists exact labels/placeholders/endpoints and the types it must use.
- **Type consistency:** `TdSynnexEcProduct`, `lookupEcExpressProducts`, `importEcExpressCatalogItem`, `saveEcExpressConfig`, `getEcExpressStatus`, `testEcExpressConnection`, `buildSoapEnvelope`, `parsePnaResponse`, `endpointForRegion`, `decryptCredentials`, `EC_MASKED_SECRET`, `TdSynnexEcExpressError` are used consistently across Tasks 2–6. Route paths `/distributors/td-synnex-ec/*` consistent across Tasks 5–6. Sub-tab id `tdsynnex-ec` consistent in Task 6.
- **Note for implementer:** in Task 3 Step 4, do not duplicate the `eq` import (already imported in Task 2); the `import { eq as _eq }` line is illustrative only.

# Breeze Partner Integration API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give external documentation systems one secure, partner-wide, read-only Breeze contract for every durable, non-secret reconstruction fact owned by that partner.

**Architecture:** Add general partner-owned service principals and independently rotatable hashed keys rather than widening organization-scoped human API keys. Dedicated middleware authenticates the machine principal in a short system context, resolves its partner and organizations, then opens the request under Breeze’s normal partner RLS context. A separate `/api/v1/partner-api` router returns explicit version-1 export DTOs with HMAC-bound keyset cursors and a recursive secret-safety gate.

**Tech Stack:** Hono, TypeScript, Drizzle ORM, PostgreSQL with forced RLS, Redis rate limiting, Zod, Vitest, Astro + React.

## Global Constraints

- **Node 22.20.0:** prefix every `pnpm`/`node` command with `export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"`.
- **Do not retrofit `api_keys`:** current keys require `org_id` and a human creator. Preserve that contract and add dedicated partner-service-principal/key tables.
- **RLS shape 3:** both new tables carry direct `partner_id`, enable and force RLS in their creating migration, use flat `breeze_has_partner_access(partner_id)` policies, and join `PARTNER_TENANT_TABLES` in the same change.
- **Hand-written migration only:** use `apps/api/migrations/2026-07-16-partner-service-principals.sql`; make it idempotent; do not add inner transaction blocks; do not use `drizzle-kit generate` or `push`.
- **Request query context:** perform only the credential lookup and organization-resolution bootstrap under `withSystemDbAccessContext`; close it before `withDbAccessContext`. Export queries run under the unprivileged application role and the partner RLS context.
- **No long work in an RLS transaction:** Redis calls, outbound I/O, and asynchronous audit writes happen before or after the held request DB context.
- **Trusted source IP:** store optional CIDRs now, but do not claim secure allowlist enforcement through raw forwarded headers. Enabling `sourceCidrs` in production depends on the canonical trusted-client-IP resolver from core-auth hardening PR 6; if that resolver is unavailable/configured ambiguously, a principal with CIDRs fails closed.
- **Explicit DTO allowlists:** never serialize Drizzle rows or `providerConfig`. Successful data and blocked metadata both pass the recursive export guard.
- **Dedicated cursor key:** add required `PARTNER_API_CURSOR_SIGNING_KEY` configuration (at least 32 random bytes encoded as base64). Do not reuse `JWT_SECRET`; validate it at boot and map it explicitly through every tracked API compose service.
- **Durable reconstruction only:** no status/last-seen/uptime, alerts, vulnerabilities, patch state, metrics, logs, commands, sessions, live connections, backup executions/snapshots, or remote-control state.
- **Partner-owned definitions:** definitions with `org_id = null` are emitted once for each organization to which they effectively apply. Preserve the source UUID; use `(sourceId, orgId)` as the pagination key.
- **Commit after every green task.** Each task starts with a failing test and records the reviewed failure before implementation.

## Public Contract

```ts
export const PARTNER_SERVICE_PRINCIPAL_SCOPES = [
  'organizations:read',
  'sites:read',
  'devices:read',
  'inventory:read',
  'configuration:read',
  'scripts:read',
  'backup-configuration:read',
  'custom-fields:read',
] as const;

export type PartnerServicePrincipalScope =
  (typeof PARTNER_SERVICE_PRINCIPAL_SCOPES)[number];

export interface PartnerExportEnvelope<T> {
  schemaVersion: '1';
  snapshotAt: string;
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
  blocked?: PartnerExportBlockedRecord[];
}

export interface PartnerExportRecordBase {
  id: string;
  orgId: string;
  siteId: string | null;
  sourceUpdatedAt: string;
  revision: string;
}
```

The initial routes and exact scopes are:

| Route | Scope |
|---|---|
| `GET /api/v1/partner-api/organizations` | `organizations:read` |
| `GET /api/v1/partner-api/sites` | `sites:read` |
| `GET /api/v1/partner-api/devices` | `devices:read` |
| `GET /api/v1/partner-api/device-inventory` | `inventory:read` |
| `GET /api/v1/partner-api/device-software` | `inventory:read` |
| `GET /api/v1/partner-api/device-relationships` | `inventory:read` |
| `GET /api/v1/partner-api/configuration-policies` | `configuration:read` |
| `GET /api/v1/partner-api/configuration-assignments` | `configuration:read` |
| `GET /api/v1/partner-api/scripts` | `scripts:read` |
| `GET /api/v1/partner-api/automations` | `configuration:read` |
| `GET /api/v1/partner-api/backup-configurations` | `backup-configuration:read` |
| `GET /api/v1/partner-api/custom-fields` | `custom-fields:read` |
| `GET /api/v1/partner-api/custom-field-values` | `custom-fields:read` |

---

### Task 1: Service-principal schema, migration, scopes, and RLS contract

**Files:**

- Create: `apps/api/migrations/2026-07-16-partner-service-principals.sql`
- Create: `apps/api/src/db/schema/partnerServicePrincipals.ts`
- Create: `apps/api/src/services/partnerServicePrincipalScopes.ts`
- Create: `apps/api/src/services/partnerServicePrincipalScopes.test.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/partnerServicePrincipalRls.integration.test.ts`

**Produces:** `partner_service_principals`, `partner_service_principal_keys`, the eight-scope union above, forced partner-axis RLS, and database constraints that reject unknown scopes/status values.

- [ ] **Step 1: Write the failing scope and RLS tests**

Test valid/invalid scopes, duplicates, empty scope arrays, and delegation validation. Add both table names to `PARTNER_TENANT_TABLES`. In the real-PostgreSQL test, seed Partner A and Partner B; as `breeze_app` in Partner A context, assert Partner B select is invisible and forged inserts/updates fail with `new row violates row-level security policy`.

- [ ] **Step 2: Run the focused tests and confirm failure**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
pnpm --filter=@breeze/api test:run -- src/services/partnerServicePrincipalScopes.test.ts
pnpm --filter=@breeze/api test:rls-coverage
```

Expected failure: missing scope module/schema tables and missing RLS coverage entries.

- [ ] **Step 3: Add the migration and Drizzle schema**

The migration contract is:

```sql
CREATE TABLE IF NOT EXISTS partner_service_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  source_cidrs text[] NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partner_service_principal_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  partner_service_principal_id uuid NOT NULL REFERENCES partner_service_principals(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at timestamptz,
  rate_limit integer NOT NULL DEFAULT 600 CHECK (rate_limit BETWEEN 1 AND 10000),
  last_used_at timestamptz,
  revoked_at timestamptz,
  rotated_from_id uuid REFERENCES partner_service_principal_keys(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Add composite uniqueness/ownership protection so a key cannot reference a principal from another partner. Add `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and SELECT/INSERT/UPDATE/DELETE policies for both tables using the established `breeze_current_scope() = 'system' OR breeze_has_partner_access(partner_id)` pattern. Guard policies through `pg_policies`/duplicate-object-safe blocks.

- [ ] **Step 4: Implement the scope module and exports**

Expose `validatePartnerServicePrincipalScopes`, `hasPartnerServicePrincipalScope`, and an immutable default Weavestream scope set containing all eight read scopes. Do not add these scopes to `apiKeyScopes.ts`.

- [ ] **Step 5: Run schema, unit, RLS, and drift verification**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm --filter=@breeze/api test:run -- src/services/partnerServicePrincipalScopes.test.ts
pnpm --filter=@breeze/api test:rls-coverage
pnpm --filter=@breeze/api test:integration -- src/__tests__/integration/partnerServicePrincipalRls.integration.test.ts
pnpm --filter=@breeze/api db:check-drift
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-07-16-partner-service-principals.sql apps/api/src/db/schema apps/api/src/services/partnerServicePrincipalScopes.ts apps/api/src/services/partnerServicePrincipalScopes.test.ts apps/api/src/__tests__/integration
git commit -m "feat(auth): add partner service principals"
```

---

### Task 2: Key issuance, rotation, revocation, lifecycle API, and settings UI

**Files:**

- Create: `apps/api/src/services/partnerServicePrincipalKeys.ts`
- Create: `apps/api/src/services/partnerServicePrincipalKeys.test.ts`
- Create: `apps/api/src/routes/partnerServicePrincipals.ts`
- Create: `apps/api/src/routes/partnerServicePrincipals.test.ts`
- Modify: `apps/api/src/index.ts`
- Create: `apps/web/src/components/settings/PartnerServicePrincipalsPage.tsx`
- Create: `apps/web/src/components/settings/PartnerServicePrincipalsPage.test.tsx`
- Create: `apps/web/src/pages/settings/partner-service-principals.astro`
- Modify: `apps/web/src/components/layout/Header.tsx`

**Interfaces:**

```ts
export async function issuePartnerServicePrincipalKey(
  tx: Database,
  input: {
    partnerServicePrincipalId: string;
    partnerId: string;
    name: string;
    actorId: string;
    expiresAt?: Date | null;
    rateLimit?: number;
  },
): Promise<{ keyId: string; rawKey: string; keyPrefix: string }>;

export async function rotatePartnerServicePrincipalKey(
  tx: Database,
  input: {
    partnerServicePrincipalId: string;
    keyId: string;
    partnerId: string;
    actorId: string;
  },
): Promise<{ keyId: string; rawKey: string; keyPrefix: string }>;
```

Generate at least 256 random bits and format plaintext keys as `brz_sp_<base64url>`. Persist SHA-256 only. The management routes are `GET|POST /api/v1/partner-service-principals`, `PATCH /:id`, `POST /:id/keys`, `POST /:id/keys/:keyId/rotate`, and `DELETE /:id/keys/:keyId`.

- [ ] **Step 1: Write failing service and route tests**

Cover one-time plaintext reveal, hash/prefix persistence, duplicate name, key rotation revoking the predecessor, revocation idempotency, expiry, principal disablement, invalid scopes/CIDRs, wrong partner, missing permission, missing MFA, and sanitized audit payloads containing no plaintext key/hash.

- [ ] **Step 2: Run tests and confirm the missing implementation failure**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
pnpm --filter=@breeze/api test:run -- src/services/partnerServicePrincipalKeys.test.ts src/routes/partnerServicePrincipals.test.ts
```

- [ ] **Step 3: Implement service and routes**

Mirror the human-management gates in `apps/api/src/routes/apiKeys.ts`: `authMiddleware`, partner/system scope, existing administrator permission, `requireMfa`, `withDbAccessContext`, and `writeAuditEvent`. Use `actorType: 'api_key'` for machine-use audit rows in this release and include sanitized `principalType: 'partner_service_principal'`, `partnerId`, and `keyId` details; do not migrate the audit enum in this integration plan.

- [ ] **Step 4: Implement the settings page with `runAction`**

List principals and masked key prefixes, create/edit/disable principals, issue/rotate/revoke keys, and display newly issued plaintext exactly once. Every POST/PATCH/DELETE action uses `runAction`; add the page to the existing settings navigation. Never store plaintext in browser storage or re-fetch it.

- [ ] **Step 5: Run API/web tests and builds**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
pnpm --filter=@breeze/api test:run -- src/services/partnerServicePrincipalKeys.test.ts src/routes/partnerServicePrincipals.test.ts
pnpm --filter=@breeze/web test --run src/components/settings/PartnerServicePrincipalsPage.test.tsx
pnpm --filter=@breeze/api build
pnpm --filter=@breeze/web build
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/partnerServicePrincipalKeys* apps/api/src/routes/partnerServicePrincipals* apps/api/src/index.ts apps/web/src/components/settings/PartnerServicePrincipalsPage* apps/web/src/pages/settings/partner-service-principals.astro apps/web/src/components/layout/Header.tsx
git commit -m "feat(auth): manage service principal keys"
```

---

### Task 3: Dedicated partner API authentication and scope enforcement

**Files:**

- Create: `apps/api/src/middleware/partnerApiAuth.ts`
- Create: `apps/api/src/middleware/partnerApiAuth.test.ts`
- Create: `apps/api/src/routes/partnerApi/index.ts`
- Modify: `apps/api/src/index.ts`

**Context contract:**

```ts
export interface PartnerApiPrincipalContext {
  partnerServicePrincipalId: string;
  keyId: string;
  partnerId: string;
  name: string;
  scopes: PartnerServicePrincipalScope[];
  accessibleOrgIds: string[];
  rateLimit: number;
}

export function requirePartnerApiScope(
  ...required: PartnerServicePrincipalScope[]
): MiddlewareHandler;
```

- [ ] **Step 1: Write failing middleware tests**

Cover missing/malformed `X-API-Key`, probe throttling, wrong prefix, unknown hash, revoked/expired key, disabled/expired principal, inactive partner, configured CIDRs without trusted IP, trusted IP outside CIDRs, missing scope, exact-scope success, organization discovery, and guaranteed closure of system context before the downstream callback.

- [ ] **Step 2: Run and confirm failure**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
pnpm --filter=@breeze/api test:run -- src/middleware/partnerApiAuth.test.ts
```

- [ ] **Step 3: Implement authentication in this order**

1. Apply the pre-lookup probe limiter used by `apiKeyAuth.ts`.
2. Parse and hash the key.
3. In a short `withSystemDbAccessContext`, load the key/principal/partner, validate status/expiry/scopes/CIDRs, resolve active organization UUIDs, and snapshot audit facts.
4. Leave the system context.
5. Apply the principal-specific Redis limiter.
6. Set the typed Hono context value.
7. Invoke downstream routing within:

```ts
withDbAccessContext({
  scope: 'partner',
  orgId: null,
  accessibleOrgIds,
  accessiblePartnerIds: [partnerId],
  currentPartnerId: partnerId,
  userId: null,
}, next);
```

8. Update `lastUsedAt` and write sanitized audit outside the request transaction.

- [ ] **Step 4: Mount only the empty protected router**

Mount `api.route('/partner-api', partnerApiRoutes)` below `/api/v1`. Apply `partnerApiAuthMiddleware` within that router. Add a temporary authenticated schema/version probe only if required by connection testing; do not expose an unscoped catch-all.

- [ ] **Step 5: Run middleware and existing API-key regression tests**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
pnpm --filter=@breeze/api test:run -- src/middleware/partnerApiAuth.test.ts src/middleware/apiKeyAuth.test.ts src/routes/apiKeys.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/middleware/partnerApiAuth* apps/api/src/routes/partnerApi/index.ts apps/api/src/index.ts
git commit -m "feat(api): authenticate partner integrations"
```

---

### Task 4: Versioned schemas, safe revisions, and HMAC-bound pagination

**Files:**

- Create: `apps/api/src/routes/partnerApi/schemas.ts`
- Create: `apps/api/src/routes/partnerApi/schemas.test.ts`
- Create: `apps/api/src/routes/partnerApi/cursor.ts`
- Create: `apps/api/src/routes/partnerApi/cursor.test.ts`
- Create: `apps/api/src/routes/partnerApi/pagination.ts`
- Create: `apps/api/src/routes/partnerApi/exportSafety.ts`
- Create: `apps/api/src/routes/partnerApi/exportSafety.test.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `apps/api/src/config/validate.ts`
- Modify: `apps/api/src/config/validate.test.ts`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `deploy/docker-compose.prod.yml`

**Cursor contract:**

```ts
export interface PartnerExportCursor {
  v: 1;
  resource: PartnerExportResource;
  partnerId: string;
  snapshotAt: string;
  updatedSince: string | null;
  lastUpdatedAt: string | null;
  lastId: string;
  lastOrgId: string | null;
  expiresAt: string;
}
```

Sign `base64url(payload)` with HMAC-SHA-256 using `PARTNER_API_CURSOR_SIGNING_KEY` and a `breeze-partner-export-cursor-v1` domain prefix. Bind partner, resource, `updatedSince`, snapshot, ordering key, and expiry. Fetch `limit + 1`; cap `limit` at 500. Production boot fails if the decoded key is shorter than 32 bytes; tests use a deterministic 32-byte fixture key.

- [ ] **Step 1: Write failing cursor/safety/schema tests**

Cover round-trip, tampering, wrong partner/resource/filter, expiry, invalid base64/JSON, page boundaries, non-advancing keys, canonical revision stability, forbidden field names at arbitrary depth, secret patterns, bounded blocked metadata, and a safe ordinary configuration definition.

- [ ] **Step 2: Run and confirm failure**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
pnpm --filter=@breeze/api test:run -- src/routes/partnerApi/cursor.test.ts src/routes/partnerApi/exportSafety.test.ts src/routes/partnerApi/schemas.test.ts
```

- [ ] **Step 3: Add and validate the cursor signing key**

Export the decoded key from `config/env.ts`, validate presence/length in `config/validate.ts`, add positive/missing/short-key tests, add a generic base64 placeholder to `.env.example`, and map `${PARTNER_API_CURSOR_SIGNING_KEY:?Set PARTNER_API_CURSOR_SIGNING_KEY in .env}` into the API services in both tracked production compose files.

- [ ] **Step 4: Implement canonical DTO helpers**

Implement deterministic JSON key ordering and SHA-256 revisions. Implement `inspectDefinitionForSecrets` as a reject-or-allow decision: do not redact a definition and then pretend it is complete. Return only record ID, org ID, resource, safe reason code, and bounded field paths for blocked records.

- [ ] **Step 5: Implement snapshot/keyset rules**

- First request fixes `snapshotAt = now`.
- Incremental: `updatedAt > updatedSince AND updatedAt <= snapshotAt`, ordered `(updatedAt, id, orgId)`.
- Full: stable `(id, orgId)` traversal with `createdAt <= snapshotAt`; retain updated values but do not infer disappearance until all pages succeed.
- Invalid/expired cursor returns a structured 400 and never silently restarts.

- [ ] **Step 6: Run tests and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
pnpm --filter=@breeze/api test:run -- src/routes/partnerApi/cursor.test.ts src/routes/partnerApi/exportSafety.test.ts src/routes/partnerApi/schemas.test.ts
git add apps/api/src/routes/partnerApi apps/api/src/config .env.example docker-compose.yml deploy/docker-compose.prod.yml
git commit -m "feat(api): define partner export contract"
```

---

### Task 5: Organizations, sites, and foundational devices

**Files:**

- Create: `apps/api/src/routes/partnerApi/organizations.ts`
- Create: `apps/api/src/routes/partnerApi/organizations.test.ts`
- Create: `apps/api/src/routes/partnerApi/devices.ts`
- Create: `apps/api/src/routes/partnerApi/devices.test.ts`
- Modify: `apps/api/src/routes/partnerApi/index.ts`
- Modify: `apps/api/src/routes/partnerApi/schemas.ts`

- [ ] **Step 1: Write failing route tests**

For every route cover unauthenticated, wrong scope, invalid filters/cursors, empty data, one/multiple pages, `updatedSince`, stable `snapshotAt`, cross-partner filter attempts, not-found organization filters, query failure, and response schema validation. Assert that device DTOs exclude online/offline state, last-seen/heartbeat, health, alerts, patch posture, vulnerabilities, agent tokens, commands, and remote-access fields.

- [ ] **Step 2: Run and confirm 404/missing schema failures**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
pnpm --filter=@breeze/api test:run -- src/routes/partnerApi/organizations.test.ts src/routes/partnerApi/devices.test.ts
```

- [ ] **Step 3: Implement narrow Drizzle projections**

Export organizations as mapping candidates; sites as durable location/contact/address/timezone facts; devices as identity, type/role, site/group/tag, OS edition/build/architecture, installation facts, serial/model/vendor, and stable custom identifiers. Do not call JWT route handlers or open a system DB context.

- [ ] **Step 4: Run tests and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
pnpm --filter=@breeze/api test:run -- src/routes/partnerApi/organizations.test.ts src/routes/partnerApi/devices.test.ts
git add apps/api/src/routes/partnerApi
git commit -m "feat(api): export partner organizations and devices"
```

---

### Task 6: Inventory, software, warranty, network, virtualization, and relationships

**Files:**

- Create: `apps/api/src/routes/partnerApi/inventory.ts`
- Create: `apps/api/src/routes/partnerApi/inventory.test.ts`
- Create: `apps/api/src/routes/partnerApi/relationships.ts`
- Create: `apps/api/src/routes/partnerApi/relationships.test.ts`
- Modify: `apps/api/src/routes/partnerApi/index.ts`
- Modify: `apps/api/src/routes/partnerApi/schemas.ts`

- [ ] **Step 1: Write failing transformation/route tests**

Use fixtures containing CPUs, memory, firmware, disks, interfaces, static/dynamic address history, gateways/DNS, installed software, warranty, discovered durable network equipment, VLAN/topology, Hyper-V hosts/VMs, sites, groups, and link groups. Assert dynamic addresses are informational rather than reservations and event-only peripherals/clients are not emitted as authoritative relationships.

- [ ] **Step 2: Run and confirm failure**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
pnpm --filter=@breeze/api test:run -- src/routes/partnerApi/inventory.test.ts src/routes/partnerApi/relationships.test.ts
```

- [ ] **Step 3: Implement explicit DTO projections**

Use schema sources `devices.ts`, `software.ts`, `warranty.ts`, `discovery.ts`, and `hypervVms.ts`. Emit stable edges for company→site, site→device, host→VM, device→interface, interface→durable IP, network topology, and other durable links with stable edge keys. Missing source endpoints remain absent and are documented for Weavestream completeness evaluation.

- [ ] **Step 4: Run tests and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
pnpm --filter=@breeze/api test:run -- src/routes/partnerApi/inventory.test.ts src/routes/partnerApi/relationships.test.ts
git add apps/api/src/routes/partnerApi
git commit -m "feat(api): export reconstruction inventory"
```

---

### Task 7: Desired configuration, procedures, backup metadata, and custom fields

**Files:**

- Create: `apps/api/src/routes/partnerApi/configuration.ts`
- Create: `apps/api/src/routes/partnerApi/configuration.test.ts`
- Create: `apps/api/src/routes/partnerApi/dtoSafety.test.ts`
- Modify: `apps/api/src/routes/partnerApi/index.ts`
- Modify: `apps/api/src/routes/partnerApi/schemas.ts`

- [ ] **Step 1: Write failing route and leakage tests**

Cover org-owned and partner-owned definitions, effective-organization fan-out, policies/assignments, rebuild-safe scripts and parameters, automation steps/dependencies, backup destinations/schedules/retention/exclusions/restore completeness, and custom-field definitions/values. `/custom-fields` pages definition identity `(definitionId, orgId)`; `/custom-field-values` emits one scalar value per `(deviceId, definitionId, orgId)` with a stable derived value UUID as `id`, plus explicit `deviceId`, `definitionId`, and `target`. Both endpoints use the same exact scope and standard signed cursor/snapshot contract. This split keeps every row bounded and permits complete traversal beyond 500 definitions on one device without hidden inner caps, mixed identities, or duplicate page identities. Add malicious fixtures with `password`, `token`, `privateKey`, `authorization`, `providerConfig`, `encryptionKey`, embedded credentials, and bounded high-entropy secret patterns. Script `content` is intentionally conservative: any bounded credential-semantic identifier token, including quoted or CLI-prefixed forms, blocks the whole record even in comments or help text; callers receive the explicit `blocked` completeness signal instead of potentially secret-bearing content.

> **Breeze-to-Weavestream handoff:** The downstream Weavestream implementation must consume `/custom-field-values` as scalar value records, cursor-walk every page, and key each value by the supplied stable `id` while retaining the explicit `deviceId`/`definitionId` binding. It must not assume one device row contains a nested values array or impose a 500-definition inner cap. This repository task implements only the Breeze producer contract; the separate Weavestream session owns its consumer changes.

- [ ] **Step 2: Run and confirm failure**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
pnpm --filter=@breeze/api test:run -- src/routes/partnerApi/configuration.test.ts src/routes/partnerApi/dtoSafety.test.ts
```

- [ ] **Step 3: Implement safe definition exporters**

Project only reconstruction-relevant fields from `configurationPolicies.ts`, `scripts.ts`, `automations.ts`, `backup.ts`, and `customFields.ts`. If a source definition cannot be separated safely from inline secret material, omit the definition from `data` and add one `blocked` item with stable identity and a safe reason. Never include partial script/policy content that a technician could mistake for complete desired state.

- [ ] **Step 4: Add recursive contract snapshots**

For every endpoint, validate the response with the Zod DTO, recursively reject forbidden keys/values, and snapshot the allowed field set. This test must fail whenever a future query adds an unreviewed field.

- [ ] **Step 5: Run tests and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
pnpm --filter=@breeze/api test:run -- src/routes/partnerApi/configuration.test.ts src/routes/partnerApi/dtoSafety.test.ts
git add apps/api/src/routes/partnerApi
git commit -m "feat(api): export safe desired configuration"
```

---

### Task 8: Export audit, real-RLS end-to-end coverage, load scenario, and operator docs

**Files:**

- Create: `apps/api/src/routes/partnerApi/audit.ts`
- Create: `apps/api/src/routes/partnerApi/audit.test.ts`
- Create: `apps/api/src/__tests__/integration/partnerApiRls.integration.test.ts`
- Create: `load-tests/scenarios/partner-api-export.js`
- Modify: `load-tests/config.js`
- Modify: `load-tests/README.md`
- Create: `docs/integrations/partner-api.md`
- Modify: `.env.example` to document the already-required `PARTNER_API_CURSOR_SIGNING_KEY`

- [ ] **Step 1: Write failing audit and RLS integration tests**

Audit fields: partner-service-principal UUID, key UUID, partner UUID, route/resource, result, schema version, record count, duration, and HTTP status. Explicitly assert absence of keys, hashes, cursors, response bodies, rejected values, definitions, and error stacks. The RLS test authenticates through real middleware as Partner A, walks every page across interleaved Partner A/B data, forges filters/cursors, and proves all export queries execute under `breeze_app` after bootstrap.

- [ ] **Step 2: Run focused tests and observe failures**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
pnpm --filter=@breeze/api test:run -- src/routes/partnerApi/audit.test.ts
pnpm --filter=@breeze/api test:integration -- src/__tests__/integration/partnerApiRls.integration.test.ts
```

- [ ] **Step 3: Implement the route audit wrapper**

Capture counts/duration in the route, leave the held request DB context, then call `writeAuditEvent`. Bound all errors to a stable public error code and sanitized short message.

- [ ] **Step 4: Add the 10,000-device k6 traversal**

Cursor-walk every resource, including definition-only `custom-fields` and scalar per-device/per-definition `custom-field-values`, require one stable `snapshotAt` per traversal, reject duplicate `(resource, id, orgId)` tuples, record bytes/pages/retries/duration, and fail when the 15-minute incremental budget is exceeded or runs overlap indefinitely. Record 429/5xx and pool saturation separately.

Use the seeded load run and `EXPLAIN (ANALYZE, BUFFERS)` to measure the new material-watermark predicates, including the device/hardware `GREATEST` expression. Add dedicated incremental indexes only where the Task 8 query evidence shows a material scan or sort bottleneck; do not guess at expression or partial indexes before the representative 10,000-device traversal exists.

- [ ] **Step 5: Document setup and recovery**

Document principal creation, the exact minimum scopes, one-time key capture, rotation overlap procedure, revocation, optional trusted source-CIDR behavior, pagination/versioning, blocked-record semantics, rate limits, and disaster recovery. Examples use only placeholders such as `https://breeze.example.com`.

- [ ] **Step 6: Run complete Breeze verification**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm --filter=@breeze/api test:run -- src/services/partnerServicePrincipalScopes.test.ts src/services/partnerServicePrincipalKeys.test.ts src/middleware/partnerApiAuth.test.ts src/routes/partnerServicePrincipals.test.ts src/routes/partnerApi
pnpm --filter=@breeze/api test:rls-coverage
pnpm --filter=@breeze/api test:integration -- src/__tests__/integration/partnerServicePrincipalRls.integration.test.ts src/__tests__/integration/partnerApiRls.integration.test.ts
pnpm --filter=@breeze/api db:check-drift
pnpm --filter=@breeze/api lint
pnpm --filter=@breeze/api build
pnpm --filter=@breeze/web test --run src/components/settings/PartnerServicePrincipalsPage.test.tsx
pnpm --filter=@breeze/web lint
pnpm --filter=@breeze/web build
```

- [ ] **Step 7: Run load verification against the seeded stack**

```bash
k6 run -e BASE_URL=http://localhost:3001 -e PARTNER_API_KEY=brz_sp_test_fixture_key load-tests/scenarios/partner-api-export.js
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/partnerApi apps/api/src/__tests__/integration/partnerApiRls.integration.test.ts load-tests docs/integrations/partner-api.md .env.example
git commit -m "test(api): harden partner reconstruction export"
```

## Completion Checklist

- [ ] No existing human API-key path or scope behavior changed.
- [ ] Both new tables pass coverage and functional cross-partner RLS tests.
- [ ] Every endpoint has auth, exact-scope, validation, empty, pagination, error, and cross-partner tests.
- [ ] Cursor signatures bind partner/resource/filter/snapshot and reject tampering/expiry.
- [ ] DTOs exclude all monitoring/control-plane and secret-bearing fields.
- [ ] Partner-owned definitions are fanned out only to effective organizations with stable composite cursor identity.
- [ ] Partial pages and exporter errors cannot imply deletion or disappearance.
- [ ] Audit contains bounded metadata only.
- [ ] The 10,000-device traversal stays inside the agreed cadence envelope.

---
spec: docs/superpowers/specs/integrations/2026-11-09-credential-fill-hudu-design.md
wave: W01
---
# Credential fill W01 — credential source framework + Hudu adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A partner admin can, through the API only, connect a Hudu instance, test it, sync its companies, map each one to a Breeze org by hand, choose the exposure mode and folder rules. Server code in later waves can then call `resolveCredentialSource(...)` and get a ready adapter.

**Architecture:** This copies the backup-provider framework. Three partner-axis tables carry RLS, composite FKs and the full cascade, merge and export registration. There is a vendor-neutral adapter interface plus a registry under `apps/api/src/services/credentialSources/`, with one adapter in `hudu/`. The routes live under `/api/v1/credential-sources`, are partner-scope and human-only, and need fresh MFA for every change. The adapter makes outbound calls through `safeFetch`, never inside a held DB transaction.

**Tech Stack:** Hono, Drizzle (queries only), hand-written SQL migration, PostgreSQL RLS, Redis (request budget, step-up grants), Zod, Vitest.

**Spec:** `docs/superpowers/specs/integrations/2026-11-09-credential-fill-hudu-design.md` §1 (Credential sources), §5 (Permissions + MFA rule), §6 (audit: management changes only in W01), §7 (status flips), Constraints. Waves: W01 is this plan (API only). W02 is the settings UI. W03 is the session list, fill/copy API and attempt audit. W04 is the agent `credential_fill` handler. W05 is the viewer panel. W06 is the proxy-window panel. W07 is relevance sorting, audit views and docs. The spec's own "Suggested waves" list puts the settings UI in wave 1. This split moves it to W02.

**Rigor: high.** This is credential handling and a new tenancy shape. Use full TDD and one independent review round. It needs the contract suites as well as unit runs (`docs/agents/testing.md`).

**PR hold.** The PR stays unmerged until Task 10 (live Hudu verification) is recorded. Until then the migration and the sub-scope rule shape can still change without a fix-forward.

## Global Constraints

- **Names later waves depend on (exact):** `CredentialSourceAdapter`, `CredentialField`, `CredentialMetadata`, `FetchedSecret`, `getCredentialSourceAdapter`, `resolveCredentialSource`, `credentialPassesExposure`, `recordCredentialSourceOutcome`. They are defined in Task 3 and Task 6.
- **Generic words outside `hudu/`:** "container" (a Hudu company) and "sub-scope" (a Hudu password folder). No file outside `services/credentialSources/hudu/` and the two registry/label maps names Hudu.
- **No secret leaves the adapter except through `fetchSecret`.** List results are built by copying named fields one by one. Never use spread, `Object.assign` or `...record`.
- **No route ever returns, logs or audits** `auth_encrypted`, the API key, a password or an OTP seed. Error strings carry the method, the HTTP status and the path *template* (`/api/v1/asset_passwords/{id}`). They never carry a query value, an id, a key or a body.
- **Outbound:** HTTPS only (adapter-enforced, because `safeFetch` also allows `http:`, `urlSafety.ts:551`). Use `safeFetch` (DNS pinned, redirects never followed, `urlSafety.ts:730`, certificate checks always on, `urlSafety.ts:684`) with `allowPrivateNetwork: selfHostAllowsPrivateNetwork()` (`config/env.ts:755`). Treat any 3xx as an error. A request is never re-sent to a `Location`.
- **No pooled DB connection is held across vendor HTTP** (#1105). Every route that calls a vendor is registered in `SELF_MANAGED_DB_CONTEXT_ROUTES` (`middleware/selfManagedDbContextRoutes.ts`). It does its DB work in short `withAuthDbAccessContext(auth, …)` blocks with the network call between them, as `routes/backup/providers.ts:198-312` does.
- **Strict at-rest format:** `auth_encrypted` is written only as `enc:v3:` ciphertext (row-bound AAD). The write is refused when no active key id is configured (pattern: `scriptSecretEnvelope.ts:120-131`). It is decrypted with `strict: true`. A DB CHECK backs this up.
- **Partner level only, no org override.** Settings home (for W02's PR, rule 9): Settings → Integrations → Credential sources. Partner level, no resolver chain. The concept is configured in 0 places before and 1 after.
- **Permissions are partner-scope only:** `credential_sources:manage`, `credentials:fill`, `credentials:copy`. No system role grants them by name. Partner Admin matches them through `*:*`.
- **MFA:** every route here requires a factor-proven session. Every change, and every call that uses the stored key (test, sync, live sub-scope list), also requires a fresh step-up grant (Task 7, Open Decision 1). An instance with `ENABLE_2FA` off cannot use any of these routes.
- **Mapping is never automatic.** Name suggestions are returned as suggestions only. The holding org (`isUnassignedPoolOrgType`, `services/unassignedPool/orgType.ts:24`) is never a target.
- **Synthetic fixtures only:** `example.test` hosts, RFC 5737 IPs, made-up company names. There must be no real key material anywhere, including PR text.
- **Tests:** `cd apps/api && npx vitest run <files>` (never `--` before flags; list sibling files explicitly). Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .; echo exit=$?`, then read the exit code and never pipe it to `tail`. Do the same in `packages/shared`. Integration suites need `pnpm test-stack up` first and `pnpm test-stack down` after.

## Open decisions (resolve before Task 7; defaults are what the plan builds)

1. **What "fresh proof within 15 minutes" looks like.** The existing step-up grant (`services/mfaStepUpGrant.ts`) is bound to one operation, the session `sid`, the auth/MFA epochs and a resource digest. Its default TTL is 300 s (`:191`) and it is single-use (`consumeStepUpGrant`, GETDEL). Per-operation TTLs exist (`OPERATION_TTL_SECONDS`, `:203`). One multi-use precedent exists, `approval_decide`, redeemed with the non-consuming `validateStepUpGrant` (`:94-113`). The module calls that operation *the only* multi-use one. Nothing expresses "any factor proof in the last 15 minutes" today.
   **Default (smallest extension):** add the operation `credential_source_manage` with TTL 900 s. It is bound to `{ partnerId }` and redeemed with `validateStepUpGrant` (multi-use inside its window). It is minted through the existing `POST /auth/mfa/step-up`, so the existing web step-up prompt is reused. Because `sid` and the epochs are bound, a factor change or a session switch kills the grant. The module comment at `:94` must be updated to say there are two.
   **Alternative:** single-use per mutation (`consumeStepUpGrant`, TTL 900 s), which means one prompt per change. The defaults conflict with a repo invariant ("only multi-use operation"), so get an independent advisor opinion (`codex exec`, xhigh, read-only) before Task 7 lands. If the opinions differ, raise it with Todd.
2. **Reads by a partner user with `orgAccess: 'selected'`.** The default refuses every route in this group, reads included, through `canManagePartnerWidePolicies` (`services/partnerWideAccess.ts:26`). The container list is the partner's whole customer directory, and the backup precedent's read-for-selected exception does not carry over to a credential store.

## Review Focus

1. **The base URL is changed without the key being re-entered, or the `base_url` column is edited directly in the DB.** Expected: the stored key never reaches the new host. The route refuses with 400 `AUTH_REQUIRED_FOR_BASE_URL_CHANGE`. `resolveCredentialSource` also refuses with `auth_unreadable` when the base URL sealed inside the blob differs from the row. Pinned in Task 3 (`openCredentialSourceAuth` mismatch) and Task 8 (PATCH without auth).
2. **A Hudu company is renamed or deleted after it was mapped.** Expected: a rename updates `vendor_container_name` and keeps the mapping. A company that is gone gets `vendor_missing_since` set and keeps its mapping (no automatic unmap, no automatic remap). If it reappears, `vendor_missing_since` clears. Pinned in Task 9 (`upsertContainers` cases).
3. **The Hudu pager misbehaves.** For example, `page_size` is ignored and the same page comes back forever, or the instance has more records than the cap. Expected: `too_many_pages` / `malformed_response`, never a truncated or duplicated list. Pinned in Task 4.
4. **Folder names differ only in case, whitespace or Unicode form** ("Network Devices " vs "network devices", or NFD vs NFC). A near name such as "Network Devices Old" must not match. Pinned in Task 3 (`normalizeSubScopeName`, `credentialPassesExposure`).
5. **A partner user with `orgAccess: 'selected'`, or the holding org as a target.** Expected: a 403 with `PARTNER_WIDE_WRITE_DENIED_MESSAGE` on every route, and a 422 `ORG_NOT_IN_PARTNER` when mapping to the holding org, with nothing written. Pinned in Task 8 and Task 9.

---

## File Structure

| File | Responsibility |
|---|---|
| Create `apps/api/migrations/2027-01-22-233700-credential-source-framework.sql` | Three tables, CHECKs, composite FKs, RLS. DDL only |
| Create `apps/api/migrations/2027-01-22-233800-credential-source-permissions.sql` | Three `permissions` rows (system scope elected) |
| Create `apps/api/src/db/schema/credentialSources.ts`; Modify `apps/api/src/db/schema/index.ts` | Drizzle tables + row types |
| Modify `packages/shared/src/constants/permissions.ts` | Three grants + `PARTNER_SCOPE_ONLY_PERMISSION_GRANTS` |
| Modify `apps/api/src/db/seed.ts`, `apps/api/src/services/permissions.ts`, `apps/api/src/routes/roles.ts`, `apps/api/src/routes/permissionsCatalog.ts` | Seed, partner-only predicate, org-role refusal, catalog flag + labels |
| Create `apps/api/src/services/credentialSources/{types,registry,credentials,exposure,status,resolve,store}.ts` | Framework core |
| Create `apps/api/src/services/credentialSources/hudu/{client,adapter}.ts` + `__fixtures__/` | Hudu transport + mapping |
| Create `apps/api/src/services/credentialSources/noAiSurface.contract.test.ts` | Nothing on the AI or MCP surfaces imports the framework |
| Modify `apps/api/src/middleware/auth.ts` | `requireFactorProvenSession()` |
| Modify `apps/api/src/services/mfaStepUpGrant.ts`, `apps/api/src/routes/auth/schemas.ts`, `apps/api/src/routes/auth/mfa.ts` | `credential_source_manage` step-up operation |
| Create `apps/api/src/routes/credentialSources/{index,access,stepUp,audit,connections,containers,exposure}.ts`; Modify `apps/api/src/index.ts` | Routes, mounted at `/credential-sources` |
| Modify `apps/api/src/middleware/selfManagedDbContextRoutes.ts` | Five vendor-calling routes |
| Modify registration files (Task 2 table) | RLS, cascade, merge, export, encrypted columns, write coverage |
| Create `apps/api/src/__tests__/integration/credentialSourceRls.integration.test.ts` | Live-catalog invariants, cross-partner forge, lifecycle, HTTP mapping |

---

### Task 1: Permissions — three grants, partner-scope only

**Files:**
- Modify: `packages/shared/src/constants/permissions.ts` (add after `ACCOUNTING_MANAGE`, `:282`)
- Modify: `apps/api/src/db/seed.ts` (`DEFAULT_PERMISSIONS`, `:122`; add next to the `ai_workspace` entry at `:287`)
- Create: `apps/api/migrations/2027-01-22-233800-credential-source-permissions.sql`
- Modify: `apps/api/src/services/permissions.ts` (next to `isAssignablePermission`, `:482`)
- Modify: `apps/api/src/routes/roles.ts` (`validateAssignablePermissions`, `:214`; all five call sites `:418, :429, :560, :603, :907`)
- Modify: `apps/api/src/routes/permissionsCatalog.ts` (`RESOURCE_LABELS`, `ACTION_LABELS`, `GET /catalog` `:91`)
- Test: Create `apps/api/src/db/credentialSourcePermissionsMigration.test.ts` (copy the shape of `aiWorkspaceExecutePermissionMigration.test.ts`); Modify `apps/api/src/routes/roles.test.ts`, `apps/api/src/routes/permissionsCatalog.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // packages/shared
  CREDENTIAL_SOURCES_MANAGE: { resource: 'credential_sources', action: 'manage' },
  CREDENTIALS_FILL: { resource: 'credentials', action: 'fill' },
  CREDENTIALS_COPY: { resource: 'credentials', action: 'copy' },
  export const PARTNER_SCOPE_ONLY_PERMISSION_GRANTS: readonly PermissionGrant[]; // exactly the three above
  // services/permissions.ts
  export function isPartnerScopeOnlyPermission(permission: Permission): boolean;
  // routes/roles.ts
  function validateAssignablePermissions(requested, callerPermissions, roleScope: 'partner' | 'organization'): string | null;
  ```
- Descriptions (byte-identical in seed and migration): `'Connect credential sources, map their containers to organizations and set exposure rules'`, `'List credential-source logins and fill them into remote desktop sessions'`, `'List credential-source logins and copy them in proxy windows (reveals the secret)'`.

There is no existing way to mark a permission partner-scope-only. `ASSIGNABLE_PERMISSIONS` (`permissions.ts:467`) and `GET /permissions/catalog` (`permissionsCatalog.ts:91`) are scope-blind. This task adds the smallest mechanism that does it: a shared list, a refusal on organization-scope roles, and a catalog field that W02 uses to hide the keys in the org role editor. The routes (Tasks 8–9, and W03) still enforce partner scope themselves with `requireScope('partner')`.

- [ ] **Step 1: Write the failing tests**
  - Migration test file: `'elects system scope before any write'`; `'carries the same description strings as DEFAULT_PERMISSIONS'` (all three); `'uses an explicit existence check, not ON CONFLICT'`; `'grants the permissions to no role and has no inner transaction'`; `'no SYSTEM_ROLES entry names credential_sources:manage, credentials:fill or credentials:copy'`.
  - `roles.test.ts`: `'refuses credentials:fill on an organization-scope role create with 400 "credentials:fill can only be granted to partner-scope roles"'`; the same for update and clone; `'accepts credentials:fill on a partner-scope role when the caller holds it'`.
  - `permissionsCatalog.test.ts`: `expect(body.partnerScopeOnly).toEqual(['credential_sources:manage', 'credentials:fill', 'credentials:copy'])`; `expect(body.resourceLabels.credential_sources).toBe('Credential Sources')`; `expect(body.actionLabels.copy).toBe('Copy (reveals the secret)')`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/db/credentialSourcePermissionsMigration.test.ts src/routes/roles.test.ts src/routes/permissionsCatalog.test.ts`. Expected: FAIL (missing grants and field).
- [ ] **Step 3: Implement.** The migration follows `2027-01-04-100110-ai-workspace-execute-permission.sql`: one `DO $$` block per row with an `IF NOT EXISTS (SELECT 1 FROM permissions …)` guard and a `RAISE NOTICE` count. Labels: `credential_sources: 'Credential Sources'`, `credentials: 'Credentials'`, `fill: 'Fill'`, `copy: 'Copy (reveals the secret)'`.
- [ ] **Step 4: Run** the same three files plus `src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/seed.test.ts`. Expected: PASS. Run the api and shared `tsc` and read the exit codes: 0.
- [ ] **Step 5: Commit** `feat(credential-sources): partner-scope-only credential permissions`

---

### Task 2: Migration, Drizzle schema and every tenancy registration

**Files:**
- Create: `apps/api/migrations/2027-01-22-233700-credential-source-framework.sql`. The newest committed migration today is `2027-01-22-233600-wisp-check-ins-run-mode.sql`. **Re-check at implementation time** with the `git ls-tree … localeCompare` one-liner in `apps/api/migrations/README.md` §Rule 3, and rename both Task 1 and Task 2 files so they sort after it. Task 1's file must sort after this one.
- Create: `apps/api/src/db/schema/credentialSources.ts`; Modify: `apps/api/src/db/schema/index.ts` (next to `export * from './backupProviders'`, `:220`)
- Modify (registrations, each found by grepping `backup_provider_customers` / `backup_provider_connections`):

| File | Constant | Entry |
|---|---|---|
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | `PARTNER_TENANT_TABLES` (`:258`) | `['credential_source_connections','partner_id']`, `['credential_source_containers','partner_id']`, `['credential_source_allowed_sub_scopes','partner_id']` |
| same | `ORG_AXIS_POLICY_EXCLUDED_TABLES` (`:139`) | `'credential_source_containers'` (its `org_id` is the mapping target, as for `backup_provider_customers` `:214-222`) |
| `apps/api/src/services/tenantCascade.ts` | `CORE_ORG_CASCADE_DELETE_ORDER` | `'credential_source_containers'` (alphabetical by `localeCompare`; the other two have no `org_id` and are swept by the partner cascade, same comment as `:461`) |
| `apps/api/src/services/orgMergeRegistry.ts` | `REPOINT_TABLES` (`:845`) | `"credential_source_containers"`, plus a comment that `(connection_id, vendor_container_id)` is org-independent, so a repoint cannot raise 23505 |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | `CORE_TENANT_EXPORT_POLICY` | `"credential_source_containers": tablePolicy("org_id", { included: ["id","connection_id","partner_id","vendor_container_id","vendor_container_name","org_id","mapped_by","mapped_at","last_seen_at","vendor_missing_since","created_at","updated_at"], reviewedIncluded: [], excludedSensitive: [], excludedOpen: [] })`, plus a comment that the credential lives on `credential_source_connections`, which has no `org_id` and no entry |
| `apps/api/src/services/encryptedColumnRegistry.ts` | `encryptedColumnRegistry` (`:58`) | `{ table: 'credential_source_connections', column: 'auth_encrypted', kind: 'text', aadBinding: 'row', description: 'credential source auth config JSON (credential fill W01) — AAD bound to the row id; strict v3 only' }` |
| `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` | `ALLOWED_WITHOUT_CAPABILITY_CHECK` (`:64`) | one entry per Task 8–9 file that mutates these tables and does not name `canManagePartnerWidePolicies` itself, with the reason "every write is reached only after `requireCredentialSourcePartnerAdmin` (routes/credentialSources/access.ts) → canManagePartnerWidePolicies". The entries for `services/credentialSources/store.ts` and each route file are added in the task that creates the file |

There are no device lists (no `device_id`), no ticket lists, no `AUDIT_ADMIN_REQUIRED_TABLES` entry (not append-only) and no `DUAL_AXIS_TENANT_TABLES` entry. These hold partner-only credentials, not an org-XOR-partner config table, which is the backup/EDR precedent at `rls-coverage…:520-526`.

- Test: Create `apps/api/src/__tests__/integration/credentialSourceRls.integration.test.ts` (style: `backupProviderRls.integration.test.ts`: `import './setup'`, `runDb = it.runIf(!!process.env.DATABASE_URL)`, a `seedTenant(label)` helper under `withSystemDbAccessContext`)

**Interfaces:**
- Produces Drizzle exports `credentialSourceConnections`, `credentialSourceContainers`, `credentialSourceAllowedSubScopes` and the row types `CredentialSourceConnectionRow`, `CredentialSourceContainerRow`, `CredentialSourceSubScopeRuleRow`.
- Columns (snake_case in SQL, camelCase in Drizzle):
  - `credential_source_connections`: `id uuid PK` (generated by the route, never defaulted, because the AAD binds to it), `partner_id NOT NULL → partners`, `provider varchar(30) NOT NULL` (open string, registry-validated), `name varchar(200) NOT NULL`, `base_url varchar(300) NOT NULL`, `auth_encrypted text NOT NULL`, `sub_scope_mode varchar(20) NULL` (NULL = not chosen yet, and the connection is unusable), `status varchar(20) NOT NULL DEFAULT 'connected'`, `status_code varchar(40) NULL` (a `CredentialSourceErrorCode`, never vendor text), `is_active boolean NOT NULL DEFAULT true`, `last_tested_at`, `last_container_sync_at`, `last_container_sync_status varchar(20)`, `last_container_sync_count integer`, `created_by → users ON DELETE SET NULL`, `created_at`, `updated_at`.
  - CHECKs: `status IN ('connected','error','reauth_required')`, `sub_scope_mode IS NULL OR sub_scope_mode IN ('all','selected')`, `base_url LIKE 'https://%'`, `auth_encrypted LIKE 'enc:v3:%'`, `last_container_sync_status IS NULL OR … IN ('success','error')`. Indexes: unique `(id, partner_id)`, unique `(partner_id, provider, name)`, `(partner_id)`.
  - `credential_source_containers`: `id`, `connection_id NOT NULL`, `partner_id NOT NULL → partners`, `vendor_container_id varchar(128) NOT NULL`, `vendor_container_name varchar(255) NOT NULL`, `org_id NULL → organizations ON DELETE SET NULL`, `mapped_by → users ON DELETE SET NULL`, `mapped_at`, `last_seen_at`, `vendor_missing_since`, `created_at`, `updated_at`. Unique `(connection_id, vendor_container_id)` (one container maps to at most one org). Indexes `(org_id)`, `(partner_id)`, `(connection_id)`. FK `(connection_id, partner_id) → credential_source_connections(id, partner_id) ON DELETE CASCADE`. FK `(org_id, partner_id) → organizations(id, partner_id) DEFERRABLE INITIALLY IMMEDIATE`.
  - `credential_source_allowed_sub_scopes`: `id`, `connection_id NOT NULL`, `partner_id NOT NULL → partners`, `rule_kind varchar(10) NOT NULL`, `vendor_sub_scope_id varchar(128) NULL`, `name_key varchar(255) NULL`, `display_name varchar(255) NOT NULL`, `created_by → users ON DELETE SET NULL`, `created_at`. CHECK `(rule_kind = 'id' AND vendor_sub_scope_id IS NOT NULL AND name_key IS NULL) OR (rule_kind = 'name' AND name_key IS NOT NULL AND vendor_sub_scope_id IS NULL)`. Partial uniques `(connection_id, vendor_sub_scope_id) WHERE rule_kind = 'id'` and `(connection_id, name_key) WHERE rule_kind = 'name'`. FK `(connection_id, partner_id) → connections ON DELETE CASCADE`.
- RLS on all three: `ENABLE` + `FORCE`, then four per-command `breeze_has_partner_access(partner_id)` policies with `DROP POLICY IF EXISTS` before each `CREATE`. On the two child tables, the INSERT and UPDATE `WITH CHECK` also require `EXISTS (SELECT 1 FROM credential_source_connections c WHERE c.id = <t>.connection_id AND c.partner_id = <t>.partner_id)`, copied from `2026-10-26-120000-backup-provider-integration.sql:442-476`. `GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES … TO breeze_app` is unguarded (repo default). The file is DDL only: it has no system-scope preamble and is not added to the `migrationRlsScope.test.ts` baseline. It is idempotent throughout (`IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`) and has no `BEGIN`/`COMMIT`.

- [ ] **Step 1: Write the failing integration tests** (`credentialSourceRls.integration.test.ts`, describe `'credential sources — schema invariants (live catalog)'` and `'… cross-tenant isolation as breeze_app'`):
  - `'all three tables have RLS enabled AND forced'`
  - `'each table carries four breeze_has_partner_access policies'`
  - `'the container org FK is deferrable initially immediate'` (reads `pg_constraint.condeferrable/condeferred` for `credential_source_containers_org_partner_fk`)
  - `'auth_encrypted refuses a non-v3 value with 23514'` (insert `'enc:v2:k:abc'` under system context)
  - `'base_url refuses http:// with 23514'`
  - `'sub_scope_mode refuses an unknown value and accepts NULL'`
  - `'a sub-scope rule with both an id and a name is refused with 23514'`
  - `'refuses a forged cross-partner connection insert with 42501'`
  - `'refuses a forged container whose connection belongs to another partner with 42501'` (partner B context, B's `partner_id`, A's `connection_id`)
  - `'hides another partner connection, container and rule from SELECT'`
  - `'an ORG token reads none of the three tables'`
  - `'a container mapped to a FOREIGN-partner org is rejected with 23503'`
  - `'a second row for the same (connection, vendor container id) is rejected with 23505'`
  - `'deleting a connection cascades containers and rules'`
  - `'org erasure removes that org\'s mapped containers and leaves unmapped and other-org rows'` (`cascadeDeleteOrg`)
  - `'an org merge re-points a mapped container to the survivor'` (`executeOrgMerge`)
- [ ] **Step 2: Run** `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/credentialSourceRls.integration.test.ts`. Expected: FAIL (tables missing).
- [ ] **Step 3: Implement** the migration, the Drizzle file (comment the deferrable FK as "migration is authoritative", as `backupProviders.ts:141-147` does) and every registration in the table above.
- [ ] **Step 4: Verify**
  - `pnpm db:migrate && pnpm db:check-drift`. Expected: no drift.
  - The new integration file. Expected: PASS.
  - `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`. Expected: PASS.
  - `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts`. Expected: PASS.
  - `cd apps/api && npx vitest run src/services/orgMerge.test.ts src/services/tenantCascade.test.ts src/services/encryptedColumnRegistry.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/__tests__/partner-wide-write-coverage.test.ts`. Expected: PASS.
  - api `tsc` exit 0.
  - As a manual forge check (tenancy doc step 6), `psql -U breeze_app` on the test stack: an insert into another partner's container must fail with `new row violates row-level security policy`.
- [ ] **Step 5: Commit** `feat(credential-sources): tables, RLS and tenancy registrations`

---

### Task 3: Framework core — types, sealing, exposure rules

**Files:**
- Create: `apps/api/src/services/credentialSources/types.ts`, `credentials.ts`, `exposure.ts`
- Test: `credentials.test.ts`, `exposure.test.ts` (alongside)

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export type CredentialField = 'username' | 'password' | 'otp';
  export interface CredentialSourceCapabilities { subScopes: boolean; otp: 'none' | 'seed' | 'code'; assetLinks: boolean }
  export interface VendorContainer { vendorContainerId: string; name: string }
  export interface VendorSubScope { vendorSubScopeId: string; name: string; vendorContainerId: string | null }
  export interface CredentialAssetRef { type: string; id: string }
  export interface CredentialMetadata {
    vendorId: string; name: string; username: string | null; urlHost: string | null;
    subScopeId: string | null; subScopeName: string | null; assetRef: CredentialAssetRef | null; hasOtp: boolean;
  }
  export interface FetchedSecret {
    value: string; kind: 'text' | 'otp_seed' | 'otp_code';
    containerId: string; subScopeId: string | null; subScopeName: string | null;
  }
  export type CredentialSourceErrorCode = 'unauthorized' | 'forbidden' | 'not_found' | 'rate_limited'
    | 'redirect_refused' | 'insecure_url' | 'blocked_address' | 'unavailable' | 'malformed_response'
    | 'too_many_pages' | 'response_too_large' | 'field_unavailable';
  export class CredentialSourceRequestError extends Error { readonly code: CredentialSourceErrorCode; readonly reauth: boolean }
  export type CredentialSourceTestResult = { ok: true } | { ok: false; code: CredentialSourceErrorCode; reauth: boolean };
  export interface CredentialSourceAdapter {
    readonly provider: string;
    readonly capabilities: CredentialSourceCapabilities;
    testConnection(): Promise<CredentialSourceTestResult>;
    listContainers(): Promise<VendorContainer[]>;
    listSubScopes(): Promise<VendorSubScope[]>;
    listCredentials(containerId: string): Promise<CredentialMetadata[]>;
    fetchSecret(vendorCredentialId: string, field: CredentialField): Promise<FetchedSecret>;
  }
  export interface CredentialSourceAdapterDefinition {
    readonly key: string; readonly label: string; readonly capabilities: CredentialSourceCapabilities;
    readonly authSchema: z.ZodType<unknown>;
    /** Normalized URL, or a CredentialSourceRequestError('insecure_url' | 'blocked_address'). */
    normalizeBaseUrl(raw: string): string;
    create(config: { connectionId: string; baseUrl: string; auth: unknown }): CredentialSourceAdapter;
  }
  ```
- Produces (`credentials.ts`):
  ```ts
  export function sealCredentialSourceAuth(connectionId: string, baseUrl: string, auth: unknown): string;
  export function openCredentialSourceAuth(connectionId: string, expectedBaseUrl: string, ciphertext: string): unknown;
  export class CredentialSourceSealError extends Error { readonly code: 'no_active_key' | 'not_v3' | 'base_url_mismatch' | 'unreadable' }
  ```
  The sealed plaintext is `JSON.stringify({ boundBaseUrl, auth })`, with AAD `columnAad(spec, connectionId)` (the spec is resolved from `encryptedColumnRegistry` at module load). Seal refuses when `getActiveSecretEncryptionKeyId()` is null or the result does not start with `enc:v3:`. Open refuses a value that is not `enc:v3:` (including plaintext, which `decryptSecret` would otherwise pass through, `secretCrypto.ts:429-431`), decrypts with `{ aad, strict: true }`, and refuses when `boundBaseUrl !== expectedBaseUrl`. No message contains plaintext.
- Produces (`exposure.ts`):
  ```ts
  export type ExposureMode = 'all' | 'selected';
  export interface ExposureRule { kind: 'id' | 'name'; vendorSubScopeId: string | null; nameKey: string | null }
  export function normalizeSubScopeName(name: string): string;  // NFC, trim, collapse internal whitespace, toLowerCase
  export function credentialPassesExposure(mode: ExposureMode, rules: readonly ExposureRule[],
    record: { subScopeId: string | null; subScopeName: string | null }): boolean;
  export function isConnectionUsable(row: { isActive: boolean; subScopeMode: ExposureMode | null; status: string }): boolean;
  ```

- [ ] **Step 1: Write the failing tests**
  - `credentials.test.ts`: `'seal then open round-trips under the same row id and base URL'`; `'open under a different row id throws'`; `'open with a different expected base URL throws base_url_mismatch'`; `'seal throws no_active_key when APP_ENCRYPTION_KEY_ID is unset'`; `'open refuses a v2 blob, a v1 blob and a plaintext string'`; `'no error message contains the auth value'` (seal `{ apiKey: 'sentinel-key-123' }`, force each failure, and assert `!String(err).includes('sentinel-key-123')`).
  - `exposure.test.ts`: `'all mode exposes a record with no sub-scope'`; `'selected mode never exposes a record with no sub-scope'`; `'selected mode with zero rules exposes nothing'`; `'an id rule matches only that id'`; `'a name rule matches across case, surrounding/internal whitespace and NFD/NFC'` (`'Network Devices '`, `'network  devices'`, the decomposed `'Réseau'` vs `'Réseau'`); `'a name rule does not match "Network Devices Old"'`; `'isConnectionUsable is false while subScopeMode is null, when inactive, and when reauth_required'`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/credentialSources/credentials.test.ts src/services/credentialSources/exposure.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS. Run `tsc` and confirm exit 0. Run `npx vitest run src/__tests__/parkedFanout.contract.test.ts`. Expected: PASS (none of these files read `devices`).
- [ ] **Step 5: Commit** `feat(credential-sources): adapter interface, strict auth sealing, exposure rules`

---

### Task 4: Hudu client — transport, paging, budget, error mapping

**Files:**
- Create: `apps/api/src/services/credentialSources/hudu/client.ts`
- Test: `apps/api/src/services/credentialSources/hudu/client.test.ts`

**Interfaces:**
- Consumes: `CredentialSourceRequestError` (Task 3); `safeFetch`, `SsrfBlockedError`, `ResponseTooLargeError` (`services/urlSafety.ts`); `selfHostAllowsPrivateNetwork` (`config/env.ts`); `rateLimiter` (`services/rate-limit.ts:107`); `getRedis` (`services/redis`).
- Produces:
  ```ts
  export const HUDU_PAGE_SIZE = 100;          // [U] confirm the max page_size in Task 10
  export const HUDU_MAX_PAGES = 50;
  export const HUDU_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
  export const HUDU_BUDGET_PER_MINUTE = 240;  // 80% of Hudu's 300/min, shared by every caller of one key
  export type HuduPathTemplate = '/api/v1/companies' | '/api/v1/password_folders'
    | '/api/v1/asset_passwords' | '/api/v1/asset_passwords/{id}';
  export type HuduFetchImpl = (url: string, init: { method: 'GET'; headers: Record<string, string>;
    signal: AbortSignal; timeoutMs: number; maxBytes: number; allowPrivateNetwork: boolean }) =>
    Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;
  export interface HuduRequestBudget { take(): Promise<boolean> }   // false → rate_limited, no request sent
  export function redisHuduBudget(baseUrl: string, apiKey: string): HuduRequestBudget; // key: credential-source:hudu:budget:<sha256(origin|key)>
  export class HuduClient {
    constructor(opts: { baseUrl: string; apiKey: string; fetchImpl?: HuduFetchImpl; budget?: HuduRequestBudget;
      sleepImpl?: (ms: number) => Promise<void>; timeoutMs?: number });
    getJson(path: HuduPathTemplate, params?: { id?: string; query?: Record<string, string | number> }): Promise<unknown>;
    listAll(path: HuduPathTemplate, envelopeKey: string, query?: Record<string, string | number>): Promise<Record<string, unknown>[]>;
  }
  ```
- Status mapping (vendor signal → code / reauth): 2xx → parse JSON (non-JSON → `malformed_response`). 300–399 → `redirect_refused` (false). 401 → `unauthorized` (true). 403 → `forbidden` (true) [U]. 404 → `not_found` (false). 429 → sleep `Retry-After` once if ≤ 10 s, then `rate_limited` (false). 5xx → two retries with backoff, then `unavailable` (false). A thrown network error → `unavailable` with no cause or message kept. `SsrfBlockedError` → `blocked_address`. `ResponseTooLargeError` → `response_too_large`. Redis unavailable → the budget refuses (fail closed, `rate_limited`).
- Paging: `page=N&page_size=HUDU_PAGE_SIZE`. Stop when a page holds fewer than `HUDU_PAGE_SIZE` rows. A page whose ids were all seen before → `malformed_response`. More than `HUDU_MAX_PAGES` → `too_many_pages`. A partial list is never returned.

- [ ] **Step 1: Write the failing tests** (fake `fetchImpl` that records every call; fake budget; `sleepImpl` resolves immediately)
  - `'constructor refuses a non-https base URL with insecure_url'` (`http://hudu.example.test`)
  - `'sends x-api-key and Accept only, never the key in the URL'`
  - `'a 302 is redirect_refused, and the key is sent exactly once'`: the fake returns `302` with `Location: https://other.example.test/…`. Assert `calls.length === 1` and that no call targets `other.example.test`.
  - `'401 → unauthorized reauth; 403 → forbidden reauth; 404 → not_found'`
  - `'429 with Retry-After 2 waits once then succeeds; Retry-After 30 fails rate_limited without a second call'`
  - `'5xx retries twice then unavailable'`
  - `'a thrown fetch error becomes unavailable and its message is not kept'` (the thrown message contains `'sentinel-key-123'`; assert the error string does not)
  - `'budget refusal sends no request'`
  - `'listAll follows pages until a short page'` (fixtures `companies-p1.json` with 100 rows, `companies-p2.json` with 3 rows → 103)
  - `'listAll fails malformed_response when the vendor repeats a page'`; `'listAll fails too_many_pages past HUDU_MAX_PAGES'`
  - `'non-JSON 200 is malformed_response'`
  - `'error messages name the path template, never an id or query value'` (`getJson('/api/v1/asset_passwords/{id}', { id: '9001' })` → 404; the message contains `{id}` and not `9001`)
  - `'default fetchImpl is safeFetch with allowPrivateNetwork from selfHostAllowsPrivateNetwork and maxBytes set'` (`vi.mock('../../urlSafety')`)
  - `'redisHuduBudget keys by origin+key hash and allows 240 per 60 s'` (mock `rateLimiter`; assert args `(redis, /^credential-source:hudu:budget:[0-9a-f]{64}$/, 240, 60)`)
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/credentialSources/hudu/client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Model it on `backupProviders/dropsuite/client.ts:96-200`, the closest precedent (GET, header key, paging, retry).
- [ ] **Step 4: Run** the same file plus `src/services/logRedaction.test.ts`, with a new case `redactLogFields({ 'x-api-key': 'k' })` → `'[REDACTED]'`. `SECRET_KEY_PATTERN` already covers it (`logRedaction.ts:8`). This case pins it. Expected: PASS. Run `tsc` and confirm exit 0.
- [ ] **Step 5: Commit** `feat(credential-sources): Hudu HTTPS client with no-redirect, paging and request budget`

---

### Task 5: Hudu adapter and the provider registry

**Files:**
- Create: `apps/api/src/services/credentialSources/hudu/adapter.ts`, `hudu/__fixtures__/{companies-p1,companies-p2,password-folders,asset-passwords-company-101,asset-password-9001,asset-password-9002-no-otp}.json`, `hudu/__fixtures__/README.md` (states that the fixtures are synthetic)
- Create: `apps/api/src/services/credentialSources/registry.ts`
- Test: `apps/api/src/services/credentialSources/hudu/adapter.test.ts`, `apps/api/src/services/credentialSources/registry.test.ts`

**Interfaces:**
- Consumes: `HuduClient` (Task 4), the types (Task 3).
- Produces (`registry.ts`): `CREDENTIAL_SOURCE_PROVIDER_KEYS = ['hudu'] as const`; `isCredentialSourceProviderKey(key: string): key is CredentialSourceProviderKey`; `getCredentialSourceAdapter(provider: string): CredentialSourceAdapterDefinition`, which throws on an unknown or inherited key, as `backupProviders/registry.ts:38-45` does; `listCredentialSourceAdapters(): CredentialSourceAdapterDefinition[]`.
- Produces `huduAdapterDefinition: CredentialSourceAdapterDefinition` with:
  - `key: 'hudu'`, `label: 'Hudu'`, `capabilities: { subScopes: true, otp: 'seed', assetLinks: true }`
  - `authSchema: z.object({ apiKey: z.string().trim().min(16).max(256) }).strict()` ([U] align the minimum length with a real key in Task 10)
  - `normalizeBaseUrl`: must be `https:`, with no userinfo, query or hash, and pass `checkSsrfSafe` (`services/ssrfGuard.ts:91`) with mode `selfHostAllowsPrivateNetwork() ? 'on-prem-http' : 'strict-https'` (the `ticketImport/sourceFetch.ts:115` pattern). Returns `origin + pathname` without a trailing slash.
- Mapping (Hudu → neutral). Every field is copied one by one and the vendor object is never spread:
  - container: `{ vendorContainerId: String(c.id), name: String(c.name) }`
  - sub-scope: `{ vendorSubScopeId: String(f.id), name: String(f.name), vendorContainerId: f.company_id == null ? null : String(f.company_id) }`
  - credential (`toCredentialMetadata(record: Record<string, unknown>, containerId: string): CredentialMetadata | null`): `vendorId = String(id)`, `name`, `username` (trimmed or null), `urlHost` (`new URL(url)` with an `https://` prefix tried for a bare host, then hostname lower-cased, or null), `subScopeId = password_folder_id`, `subScopeName = password_folder_name`, `assetRef = passwordable_type && passwordable_id ? { type, id: String(id) } : null`, `hasOtp = typeof otp_secret === 'string' && otp_secret.trim() !== ''`. It returns null (the record is dropped) when `String(company_id) !== containerId` or when `id`/`name` are missing.
  - `fetchSecret(id, field)`: GET `/api/v1/asset_passwords/{id}` (envelope [U]). `username` → `kind 'text'`. `password` → `kind 'text'`. `otp` → `kind 'otp_seed'` (the core computes the code in W03). An empty or missing value → `field_unavailable`. A missing `company_id` → `malformed_response`. `containerId`, `subScopeId` and `subScopeName` come from **this response**, never from a cached list.
  - `testConnection()`: `GET /api/v1/companies?page=1&page_size=1`, then `GET /api/v1/asset_passwords?page=1&page_size=1` to prove password access. The body is parsed and discarded. Returns `{ ok: true }`, or `{ ok: false, code, reauth }` from the caught `CredentialSourceRequestError`.

- [ ] **Step 1: Write the failing tests**
  - `'listCredentials result contains no password or otp_secret key even though the vendor returned both'`. The fixture rows carry `password`, `otp_secret` and an extra unknown `notes` field. Assert for every item: `Object.keys(item).sort()` equals exactly `['assetRef','hasOtp','name','subScopeId','subScopeName','urlHost','username','vendorId']`, and `JSON.stringify(result)` does not contain the fixture's password or seed strings.
  - `'hasOtp is true for a seeded record and false for an empty seed'`
  - `'urlHost parses full URLs, bare hosts and IPs, and is null for junk'` (`https://fw.example.test/admin` → `fw.example.test`; `192.0.2.10` → `192.0.2.10`; `'not a url'` → null)
  - `'drops a record whose company_id is not the requested container'`
  - `'fetchSecret password returns kind text and the container/folder from the detail response'`
  - `'fetchSecret otp returns kind otp_seed; on a record without a seed it throws field_unavailable'`
  - `'fetchSecret never includes other secret fields on the returned object'` (keys exactly `['containerId','kind','subScopeId','subScopeName','value']`)
  - `'listSubScopes keeps company_id as vendorContainerId or null'`
  - `'testConnection maps a 401 to { ok: false, code: unauthorized, reauth: true }'`
  - `'normalizeBaseUrl rejects http, userinfo, query, hash and a metadata-IP host; strips the trailing slash'`
  - `'authSchema rejects unknown keys and a short key'`
  - `registry.test.ts`: `'getCredentialSourceAdapter throws on unknown and inherited keys'` (`'nope'`, `'__proto__'`, `'constructor'`); `'every registered key resolves to a definition whose key matches'`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/credentialSources/hudu/adapter.test.ts src/services/credentialSources/registry.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS. Run `tsc` and confirm exit 0.
- [ ] **Step 5: Commit** `feat(credential-sources): Hudu adapter with metadata-only listing`

---

### Task 6: `resolveCredentialSource` and the connection status writer

**Files:**
- Create: `apps/api/src/services/credentialSources/resolve.ts`, `status.ts`
- Test: `resolve.test.ts`, `status.test.ts`; extend `apps/api/src/__tests__/integration/credentialSourceRls.integration.test.ts`

**Interfaces:**
- Consumes: `openCredentialSourceAuth`, `isConnectionUsable` (Task 3); `getCredentialSourceAdapter` (Task 5); `withSystemDbAccessContextIsolated` (`db/index.ts:1224`).
- Produces:
  ```ts
  export interface CredentialSourceConnectionSummary {
    id: string; partnerId: string; provider: string; name: string; baseUrl: string;
    subScopeMode: ExposureMode | null; status: 'connected' | 'error' | 'reauth_required'; isActive: boolean;
  }
  export interface ResolvedCredentialSource { connection: CredentialSourceConnectionSummary; adapter: CredentialSourceAdapter }
  export type CredentialSourceUnavailableCode = 'not_found' | 'inactive' | 'exposure_unset' | 'reauth_required' | 'auth_unreadable' | 'unknown_provider';
  export class CredentialSourceUnavailableError extends Error { readonly code: CredentialSourceUnavailableCode }
  export async function resolveCredentialSource(connectionId: string, partnerId: string,
    opts?: { requireUsable?: boolean }): Promise<ResolvedCredentialSource>;      // requireUsable defaults to true
  export function connectionStatusForError(err: unknown): 'error' | 'reauth_required';
  export async function recordCredentialSourceOutcome(connectionId: string, partnerId: string,
    outcome: { ok: true } | { ok: false; error: unknown }, at?: Date): Promise<void>;
  ```
  `resolveCredentialSource` reads one row with `WHERE id = connectionId AND partner_id = partnerId`, inside `withSystemDbAccessContextIsolated` (safe with or without a held context, per `docs/agents/tenancy-rls.md`). It then decrypts and calls `definition.create(...)`. **`partnerId` must come from the caller's auth gate, never from a request body.** Say so in the JSDoc. It makes no vendor call. The caller makes those outside any held DB context, and `safeFetch` enforces that through `assertOutsideHeldDbContext`. `recordCredentialSourceOutcome` writes `status`, `status_code` (a code, never a message) and `last_tested_at`. A success clears `status_code`.

- [ ] **Step 1: Write the failing tests**
  - `resolve.test.ts` (mocked db + registry): `'not_found when the row belongs to another partner'`; `'exposure_unset when subScopeMode is null and requireUsable is default'`; `'returns an adapter with exposure unset when requireUsable is false'`; `'reauth_required and inactive are refused when requireUsable'`; `'auth_unreadable when the sealed base URL differs from the row'`; `'the returned summary has no auth field'` (keys pinned).
  - `status.test.ts`: `'unauthorized and forbidden map to reauth_required; every other code to error'`; `'a success clears status_code and sets connected'`; `'status_code is the error code, never the error message'`.
  - Integration (`'credential sources — lifecycle against real Postgres'`): `'resolveCredentialSource for partner B cannot load partner A\'s connection'`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/credentialSources/resolve.test.ts src/services/credentialSources/status.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the unit files and the integration file. Expected: PASS. Run `tsc` and confirm exit 0.
- [ ] **Step 5: Commit** `feat(credential-sources): resolveCredentialSource and connection status`

---

### Task 7: Auth gates — factor-proven session, step-up operation, partner-admin gate

**Files:**
- Modify: `apps/api/src/middleware/auth.ts` (after `hasSatisfiedMfa`, `:1134`)
- Modify: `apps/api/src/services/mfaStepUpGrant.ts` (`StepUpOperation` `:34`, `OPERATION_TTL_SECONDS` `:203`, the multi-use comment `:94`, a new digest beside `preAssignmentEnableResourceDigest` `:365`)
- Modify: `apps/api/src/routes/auth/schemas.ts` (`STEP_UP_OPERATIONS` `:165`, a resource schema beside `preAssignmentEnableStepUpResource` `:246`, the `stepUpResource` union `:352`)
- Modify: `apps/api/src/routes/auth/mfa.ts` (`RESOURCE_BOUND_OPERATIONS` `:997`, the `resourceDigest` chain `:1192-1237`)
- Create: `apps/api/src/routes/credentialSources/access.ts`, `stepUp.ts`, `audit.ts`
- Test: `apps/api/src/middleware/auth.factorProven.test.ts`, `apps/api/src/services/mfaStepUpGrant.test.ts`, `apps/api/src/routes/auth/mfa.schemas.test.ts`, `apps/api/src/routes/credentialSources/access.test.ts`, `stepUp.test.ts`, `audit.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // middleware/auth.ts
  /** ENABLE_2FA on, token.mfa === true, and token.mfa_src is 'factor' or 'idp' (absent reads as 'policy', mfaAssuranceSource.ts). */
  export function hasFactorProvenSession(auth: Pick<AuthContext, 'token'>): boolean;
  export function requireFactorProvenSession(): MiddlewareHandler;  // 403 { error, code: 'MFA_FACTOR_REQUIRED' }
  // mfaStepUpGrant.ts
  | 'credential_source_manage'                                        // TTL 900 s (Open Decision 1)
  export function credentialSourceManageResourceDigest(input: { partnerId: string }): `sha256:${string}`;
  // routes/auth/schemas.ts
  export const credentialSourceManageStepUpResource = z.object({ partnerId: z.string().uuid() }).strict();
  // routes/credentialSources/access.ts
  export type CredentialSourceGate = { partnerId: string } | { error: string; status: 403 };
  export function requireCredentialSourcePartnerAdmin(auth: Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess'>): CredentialSourceGate;
  // routes/credentialSources/stepUp.ts
  export async function requireCredentialSourceStepUp(c: Context, grantId: string | undefined, partnerId: string): Promise<Response | null>;
  // routes/credentialSources/audit.ts
  export async function auditCredentialSourceAttempt(c: Context, event: RouteAuditInput): Promise<boolean>; // writeAuditEventStrict, result 'dispatched'
  export function auditCredentialSourceOutcome(c: Context, event: RouteAuditInput, result: 'success' | 'failure' | 'denied'): void; // writeAuditEventAsync
  ```
- The middleware stack for **every** route in this group, in this order: `requireInteractiveSession()` (`auth.ts:114`, which refuses API keys, OAuth grants, service principals, AI agents and flows before any query), `requireScope('partner')`, `requirePermission('credential_sources', 'manage')`, `requireMfa()`, `requireFactorProvenSession()`. Then, in the handler, `requireCredentialSourcePartnerAdmin(auth)`.
- `requireCredentialSourceStepUp`: when `ENABLE_2FA` is off it returns 403 `{ code: 'MFA_UNAVAILABLE' }`. This feature does not run without 2FA (spec §5), unlike `topology/monitoringArms.ts:41`, which skips. Otherwise it builds the binding from `getUserEpochs(auth.user.id)` (`services/authEpochs.ts:15`) and `auth.token.sid` (503 if either is missing) and calls `validateStepUpGrant` (non-consuming, per the Open Decision 1 default). It returns 403 `{ error: 'Step-up required', code: 'STEP_UP_REQUIRED' }` on a miss.
- Audit for management changes: write the attempt with `auditCredentialSourceAttempt` **before** the DB write. If that strict write rejects, return 503 `{ code: 'AUDIT_UNAVAILABLE' }` and change nothing. Write the outcome after. Gate and step-up refusals inside the handler write a `denied` outcome. `details` carries ids, provider, name, mode and rule kind only, and is checked by `sanitizeAuditPayload` (`services/auditPayloadSanitizer.ts:28`) on the way in.

- [ ] **Step 1: Write the failing tests**
  - `auth.factorProven.test.ts`: `'refuses mfa_src policy'`; `'refuses a token with no mfa_src'`; `'admits factor and idp with mfa true'`; `'refuses everything when ENABLE_2FA is off'` (mock `../routes/auth/schemas`).
  - `mfaStepUpGrant.test.ts`: `'credential_source_manage grants live 900 s'` (`stepUpGrantTtlSeconds('credential_source_manage') === 900`); `'the digest canonicalizes partnerId case'`; `'validateStepUpGrant accepts the same grant twice inside the window'`; `'a grant for partner A does not validate for partner B'`.
  - `mfa.schemas.test.ts`: `'credential_source_manage requires a { partnerId } resource and rejects extra keys'`.
  - `access.test.ts`: `'organization scope → 403'`; `'partner with orgAccess selected → 403 PARTNER_WIDE_WRITE_DENIED_MESSAGE'`; `'partner with orgAccess all → { partnerId }'`.
  - `stepUp.test.ts`: `'ENABLE_2FA off → 403 MFA_UNAVAILABLE'`; `'missing grant → 403 STEP_UP_REQUIRED'`; `'missing sid → 503'`; `'valid grant → null, and the grant is not consumed'`.
  - `audit.test.ts`: `'attempt uses writeAuditEventStrict with result dispatched and resolves false when it rejects'`; `'details never carry auth or apiKey even if passed'`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/middleware/auth.factorProven.test.ts src/services/mfaStepUpGrant.test.ts src/routes/auth/mfa.schemas.test.ts src/routes/credentialSources/access.test.ts src/routes/credentialSources/stepUp.test.ts src/routes/credentialSources/audit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Update the `mfaStepUpGrant.ts` header comment so it lists two multi-use operations and gives the bounds for this one: partner-bound, sid/epoch-bound, 900 s, never mints on redeem.
- [ ] **Step 4: Run** the same command plus `src/services/mfaStepUpGrantCanonicalIds.test.ts src/routes/auth/helpers.mfaStepUp.test.ts` and `cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/mfaStepUpGrant.integration.test.ts`. Expected: PASS. Run `tsc` and confirm exit 0.
- [ ] **Step 5: Commit** `feat(credential-sources): factor-proven session gate and credential_source_manage step-up`

---

### Task 8: Connection routes — create, read, update, delete, test

**Files:**
- Create: `apps/api/src/services/credentialSources/store.ts` (connection functions in this task; container and rule functions in Task 9)
- Create: `apps/api/src/routes/credentialSources/index.ts`, `connections.ts`
- Create: `apps/api/src/services/credentialSources/noAiSurface.contract.test.ts`
- Modify: `apps/api/src/index.ts` (beside `api.route('/edr', edrRoutes)`, `:933`): `api.route('/credential-sources', credentialSourceRoutes)`
- Modify: `apps/api/src/middleware/selfManagedDbContextRoutes.ts` (beside the backup-provider entries, `:597-599`)
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` (entries for `services/credentialSources/store.ts`, `routes/credentialSources/connections.ts`)
- Test: `apps/api/src/routes/credentialSources/connections.test.ts` (mock style: `routes/backup/providers.test.ts`), `apps/api/src/services/credentialSources/store.test.ts`, `apps/api/src/middleware/selfManagedDbContextRoutes.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 5, 6, 7.
- Produces (store): `CONNECTION_PUBLIC_SELECT` (every connection column except `authEncrypted`, plus a computed `hasAuth: sql<boolean>`, following the select of the same name in `routes/backup/providerAccess.ts`) and `type ConnectionPublicRow`; `insertConnection(input: { id: string; partnerId: string; provider: string; name: string; baseUrl: string; authEncrypted: string; createdBy: string | null }): Promise<ConnectionPublicRow>`; `updateConnection(id: string, partnerId: string, patch: Partial<{ name: string; baseUrl: string; authEncrypted: string; isActive: boolean }>): Promise<ConnectionPublicRow | null>`; `deleteConnection(id: string, partnerId: string): Promise<boolean>`; `loadConnectionPublic(id: string, partnerId: string): Promise<ConnectionPublicRow | null>`. Only `store.ts` (writes) and `resolve.ts` (reads) reference `authEncrypted`.
- Routes (base `/api/v1/credential-sources`; every mutation body carries `stepUpGrantId: string`):

| Method + path | Body | Behaviour |
|---|---|---|
| `GET /providers` | — | `{ data: [{ key, label, capabilities }] }` |
| `GET /connections` | — | `CONNECTION_PUBLIC_SELECT` rows for the gate's partner |
| `GET /connections/:id` | — | one row or 404 |
| `POST /connections` | `{ provider, name, baseUrl, auth, stepUpGrantId }` | Validate the provider (400), `authSchema` (400) and `normalizeBaseUrl` (400), then step-up and the attempt audit. Generate `id = randomUUID()`, `create(...)` and `testConnection()` outside any DB context. A failed test → 422 `{ success: false, code, reauth }`, nothing stored. Otherwise seal and insert with `sub_scope_mode NULL`. A 23505 → 409 `DUPLICATE_CONNECTION_NAME`. Returns 201 |
| `PATCH /connections/:id` | `{ name?, baseUrl?, auth?, isActive?, stepUpGrantId }` | When `baseUrl` is present and differs from the stored value and `auth` is absent → 400 `AUTH_REQUIRED_FOR_BASE_URL_CHANGE`. When `auth` or `baseUrl` changes: re-test with the **new** pair (422 on failure, nothing stored), re-seal bound to the new URL, set `status 'connected'` |
| `DELETE /connections/:id` | `{ stepUpGrantId }` | Delete, cascading containers and rules. 404 when missing |
| `POST /connections/:id/test` | `{ stepUpGrantId }` | `resolveCredentialSource(id, gate.partnerId, { requireUsable: false })`, then `testConnection()`, then `recordCredentialSourceOutcome`. Returns `{ ok, status, code? }` |

- Self-managed entries (vendor calls in the handler): `POST …/credential-sources/connections`, `PATCH …/connections/[^/]+`, `POST …/connections/[^/]+/test`. Task 9 adds the other two.
- No-AI contract: walk `apps/api/src` (skip tests) and fail if any file matching `services/aiTools*.ts`, `services/ai*/**`, `routes/mcp*`, `services/mcp*` or `routes/ai/**` imports `credentialSources` or names `credential_source_` / `credentials:fill` / `credentials:copy`. Prove it can fail: add a scratch import, see it go red, then delete the scratch file.

- [ ] **Step 1: Write the failing tests** (`connections.test.ts`)
  - `'an api_key principal is refused 403 before any query'` (db mock asserts zero calls); `'an oauth_grant and an ai_agent principal are refused'`
  - `'an organization-scope token is refused 403'`; `'a selected-org partner user is refused 403 on every route'`
  - `'a policy-only MFA session is refused 403 MFA_FACTOR_REQUIRED'`
  - `'POST without a valid step-up grant → 403 STEP_UP_REQUIRED and no vendor call'`
  - `'POST rejects an http:// base URL with 400 and makes no vendor call'`
  - `'POST with a failing test → 422 and no insert'`; `'POST success → 201, subScopeMode null, and the response has no auth/authEncrypted/apiKey anywhere'` (deep key scan plus `JSON.stringify` not containing the key)
  - `'POST writes the dispatched attempt audit before the insert, and a rejected strict audit → 503 with no insert and no vendor call'`
  - `'PATCH with a new baseUrl and no auth → 400 AUTH_REQUIRED_FOR_BASE_URL_CHANGE and no vendor call'`
  - `'PATCH with baseUrl + auth re-tests against the NEW URL with the NEW key only'` (the fake adapter records the `create` config)
  - `'POST /:id/test on reauth flips status to reauth_required with status_code unauthorized'`
  - `'GET /connections never selects authEncrypted'` (the db mock's select-columns spy)
  - `store.test.ts`: `'CONNECTION_PUBLIC_SELECT has no authEncrypted key'`; `'only store.ts and resolve.ts reference authEncrypted'` (source walk over `services/credentialSources` and `routes/credentialSources`, non-test files)
  - `selfManagedDbContextRoutes.test.ts`: `isSelfManagedDbContextRoute('POST', '/api/v1/credential-sources/connections/abc/test') === true`, and the same for the create and PATCH paths.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/credentialSources/connections.test.ts src/services/credentialSources/store.test.ts src/middleware/selfManagedDbContextRoutes.test.ts src/services/credentialSources/noAiSurface.contract.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Do DB work in `withAuthDbAccessContext(auth, …)` blocks (`middleware/auth.ts:648`), with the vendor call between them. Catch a 23505 **outside** that block, as `routes/backup/providers.ts:264-278` does.
- [ ] **Step 4: Run** the same command plus `src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/parkedFanout.contract.test.ts`. Expected: PASS. Run `tsc` and confirm exit 0.
- [ ] **Step 5: Commit** `feat(credential-sources): connection routes with fresh-MFA, strict audit and no auth in any response`

---

### Task 9: Containers, mapping, exposure mode and sub-scope rules

**Files:**
- Modify: `apps/api/src/services/credentialSources/store.ts`
- Create: `apps/api/src/routes/credentialSources/containers.ts`, `exposure.ts`; Modify `routes/credentialSources/index.ts`
- Modify: `apps/api/src/middleware/selfManagedDbContextRoutes.ts`, `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`
- Test: extend `apps/api/src/services/credentialSources/store.test.ts`; Create `apps/api/src/routes/credentialSources/containers.test.ts`, `exposure.test.ts`; extend `credentialSourceRls.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 6, 7, 8; `resolveAutoMapNameSuggestions` (`services/externalTenantMapping.ts:187`); `isUnassignedPoolOrgType`.
- Produces (store):
  ```ts
  export async function upsertContainers(connectionId: string, partnerId: string, vendor: readonly VendorContainer[], seenAt: Date):
    Promise<{ total: number; added: number; renamed: number; missing: number; returned: number }>;
  export class MapContainerError extends Error { readonly code: 'NOT_FOUND' | 'ORG_NOT_IN_PARTNER' }
  export async function mapContainer(containerId: string, orgId: string | null, actor: { userId: string | null; partnerId: string }):
    Promise<{ connectionId: string; vendorContainerId: string; orgId: string | null; previousOrgId: string | null }>;
  export async function setExposureMode(connectionId: string, partnerId: string, mode: ExposureMode): Promise<boolean>;
  export type SubScopeRuleInput = { kind: 'id'; vendorSubScopeId: string; displayName: string } | { kind: 'name'; name: string };
  export async function createSubScopeRule(connectionId: string, partnerId: string, input: SubScopeRuleInput, createdBy: string | null): Promise<CredentialSourceSubScopeRuleRow>;
  export async function deleteSubScopeRule(ruleId: string, partnerId: string): Promise<boolean>;
  export async function listExposureRules(connectionId: string, partnerId: string): Promise<ExposureRule[]>;  // W03 reads this
  ```
  `upsertContainers` upserts on `(connection_id, vendor_container_id)`. It updates the name, sets `last_seen_at` and clears `vendor_missing_since`. Rows not in `vendor` get `vendor_missing_since = seenAt` when it is null. It **never touches `org_id`**. `mapContainer` rejects a target org outside the partner or of holding-org type, before any write, as `backupProviders/mapping.ts:77-95` does. That keeps the request transaction clean instead of letting the composite FK raise 23503. A name rule stores `name_key = normalizeSubScopeName(name)` and `display_name = name.trim()`.
- Routes:

| Method + path | Body | Behaviour |
|---|---|---|
| `POST /connections/:id/containers/sync` | `{ stepUpGrantId }` | resolve (`requireUsable: false`), then `listContainers()` outside any DB context, then `upsertContainers`, then `last_container_sync_*`. A vendor error → `recordCredentialSourceOutcome`, 502 `{ code }` |
| `GET /connections/:id/containers` | — | Rows (with `orgName`), `summary { containers, unmapped, missing }`, and `suggestions: { containerId, orgId }[]` from `resolveAutoMapNameSuggestions` over unmapped, not-missing containers and the partner's orgs with holding-type orgs excluded. **Suggestions are never written** |
| `PUT /containers/:id/mapping` | `{ orgId: uuid \| null, stepUpGrantId }` | `orgId` is required as a key and nullable as a value (`providerCustomers.ts:19-25`). `mapContainer`, then audit `credential_source.container.map` / `.unmap` with `orgId` = the target (or the previous org on unmap), so the entry lands in that org's log |
| `PUT /connections/:id/exposure` | `{ mode: 'all' \| 'selected', stepUpGrantId }` | `selected` is refused 400 when `capabilities.subScopes` is false |
| `GET /connections/:id/sub-scopes` | — | Live `listSubScopes()` (no table) plus the stored rules. No step-up: this is a read, behind the factor-proven gate |
| `POST /connections/:id/sub-scope-rules` | `SubScopeRuleInput & { stepUpGrantId }` | A 23505 → 409 `DUPLICATE_RULE` |
| `DELETE /sub-scope-rules/:id` | `{ stepUpGrantId }` | 404 when missing |

- Self-managed entries: `POST …/connections/[^/]+/containers/sync`, `GET …/connections/[^/]+/sub-scopes`.
- Audit actions: `credential_source.connection.create|update|delete|test`, `credential_source.containers.sync`, `credential_source.container.map|unmap`, `credential_source.exposure.set`, `credential_source.sub_scope_rule.create|delete`. Task 8 uses the first four.

- [ ] **Step 1: Write the failing tests**
  - `store.test.ts`: `'upsert renames, keeps org_id, and clears vendor_missing_since on return'`; `'a container absent from the vendor list gets vendor_missing_since and keeps its mapping'`; `'the same vendor id under two connections is two rows'`; `'mapContainer refuses a foreign-partner org and a holding org with ORG_NOT_IN_PARTNER and writes nothing'`; `'createSubScopeRule stores the normalized name_key and trimmed display_name'`.
  - `containers.test.ts`: `'GET returns suggestions and leaves every container unmapped'` (the db mock asserts no update); `'PUT mapping {} → 400; { orgId: null } → unmap'`; `'PUT mapping to the holding org → 422 ORG_NOT_IN_PARTNER'`; `'sync failure with 401 → 502 { code: unauthorized } and status reauth_required'`; `'every mutating route without a step-up grant → 403 and no vendor call'`; `'selected-org partner user → 403 on every route'`.
  - `exposure.test.ts` (route): `'PUT exposure sets the mode'`; `'PUT exposure selected on a no-sub-scope adapter → 400'`; `'POST a rule with both kinds → 400'`; `'duplicate name rule differing only by case → 409'`; `'GET sub-scopes calls the adapter after the DB block has returned'` (the `withAuthDbAccessContext` mock records that it is not on the stack when the adapter's `listSubScopes` runs).
  - Integration (`'… HTTP-level mapping through the real router'`, modelled on `backupProviderRls.integration.test.ts:587`): `'PUT /credential-sources/containers/:id/mapping to another partner\'s org answers 422, not 500, and writes nothing'`; `'partner B cannot map, read or delete partner A\'s container by id (404)'`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/credentialSources/store.test.ts src/routes/credentialSources/containers.test.ts src/routes/credentialSources/exposure.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** If the org-suggestion query uses `notHiddenOrgType(` or a similar helper, classify `routes/credentialSources/containers.ts` in `VISIBILITY_MODULES` of `__tests__/parkedFanout.contract.test.ts`.
- [ ] **Step 4: Verify**
  - Run the unit files plus `src/routes/credentialSources/connections.test.ts src/middleware/selfManagedDbContextRoutes.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/parkedFanout.contract.test.ts src/services/credentialSources/noAiSurface.contract.test.ts`. Expected: PASS.
  - Run the integration file and `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`. Expected: PASS.
  - Run `tsc` and confirm exit 0.
  - Before the PR, run the full `pnpm --filter @breeze/api test --run`. The org-merge engine reds only in the full suite.
- [ ] **Step 5: Commit** `feat(credential-sources): container sync and manual mapping, exposure mode and sub-scope rules`

---

### Task 10: Live Hudu verification (lab gate, before merge)

**Files:**
- Modify: `apps/api/src/services/credentialSources/hudu/{client,adapter}.ts` and fixtures only where a fact below proves wrong
- Modify: `docs/superpowers/plans/integrations/2026-11-09-credential-fill-w01-source-framework-hudu.md` (record the results under a `## Lab results` heading; no hostnames, keys or customer names)

**Interfaces:**
- Produces: confirmed values for every **[U]**, plus the folder-scope decision that W02's rule UI and W03's exposure check build on.

- [ ] **Step 1: Verify each fact against a lab Hudu instance** with a key that has password access on and destructive actions and export off. Use a scratch script under the session scratchpad that imports the client, never a committed file, and record one line per fact:
  1. Response envelopes: `companies`, `password_folders`, `asset_passwords` (list) and `asset_password` (detail).
  2. The `page`/`page_size` names, the default page size (spec: 25) and the maximum. Set `HUDU_PAGE_SIZE` to the largest accepted value up to 100.
  3. Whether list items include `password` and `otp_secret`. The allowlist test holds either way.
  4. Whether `password_folder_id` / `password_folder_name` are present on list items. If not, `listCredentials` cannot filter by folder without a per-record fetch. Stop and raise it, because it changes W03's cost model.
  5. A key without password access: 403, 401, or 200 with no secret fields. Set the 403 `reauth` flag and `testConnection`'s probe to match.
  6. Archived passwords: whether the list returns them and whether a filter exists. If they are returned, the adapter drops `archived: true` and `fetchSecret` treats them as `not_found`.
  7. Behaviour on `http://` and on a redirecting proxy in front of the instance: confirm the client sends the key once.
  8. Rate limit: 300/min, and the 429 body and headers (`Retry-After` present?).
  9. **Folder scope.** Create one folder with no company and one inside a company, then read `GET /api/v1/password_folders`.
     - **Folders are instance-wide only** (ids are global and none carries `company_id`): id rules are enough. Remove the `name` rule kind from the unmerged migration (CHECK and partial unique), from `SubScopeRuleInput` and from `credentialPassesExposure`, and delete the name-rule tests. Spec §1 "drops the name rule if ids suffice".
     - **Folders are per-company only:** keep both kinds. `listSubScopes` returns `vendorContainerId` on every folder. Record that W02 must group folders by company and offer the name rule as the primary control.
     - **Both exist:** keep both kinds, with no code change.
- [ ] **Step 2: Run** the full set from Tasks 1–9 again after any change. Expected: PASS. `tsc` exit 0.
- [ ] **Step 3: Commit** `test(credential-sources): align the Hudu adapter with the live API (lab results)`. Then open the PR, with the settings rule-9 statement deferred to W02 and the step-up decision (Open Decision 1) and its resolution in the body. Tear down with `pnpm test-stack down`.

---

## Self-review (run against the spec, 2026-11-09)

- **Coverage.** §1 tables, FKs, cardinality and strict AAD are Task 2 + Task 3. Base-URL re-auth is Task 3 + Task 8. Outbound rules are Task 4. The adapter interface is Task 3 + Task 5. Suggestions-only mapping is Task 9. The exposure mode with no default is Task 2 (`NULL`) + Task 3 (`isConnectionUsable`) + Task 9. Name and id rules are Task 9 + Task 10. §5 permissions and partner-only are Task 1 + Task 7. The MFA rule is Task 7. §6 "every change audited" is Tasks 7–9. §7 status flips are Task 6. Constraints: the key is never returned (Task 8) and excluded from export (connections have no `org_id`, so no export entry; Task 2 comment). No AI access is the Task 8 contract. Out of W01: the session list, fill, copy, TOTP, cache, the attempt audit for fill/copy (W03), and the UI and locales (W02).
- **Gaps carried as open decisions, not invented mechanisms:** 15-minute freshness (Open Decision 1) and partner-scope-only permissions (Task 1 adds the minimal mechanism; the web editor hiding is W02).
- **Type consistency.** `ExposureMode`, `ExposureRule`, `CredentialSourceErrorCode` and `ConnectionPublicRow` are each defined once and used under the same names in Tasks 6–9.

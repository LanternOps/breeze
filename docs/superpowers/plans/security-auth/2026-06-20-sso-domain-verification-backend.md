# SSO Domain Verification — Backend (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate SSO provisioning / JIT-linking on a DNS-verified email domain, so an org can only auto-create or first-time-link a user whose email domain it has proven (via DNS TXT) it owns — closing the H-2 root cause from security review #2.

**Architecture:** A new org-scoped `sso_verified_domains` table; a verification service that issues a per-domain token and confirms it via a DNS TXT lookup; `sso:admin`-gated CRUD routes; a callback gate that refuses provisioning/linking for an unverified domain once the org has verified at least one domain (warn-mode otherwise); a daily re-check job that audits drift without un-verifying.

**Tech Stack:** Hono, Drizzle, hand-written SQL migrations, Node `dns/promises`, BullMQ, Vitest. This is **Plan B (backend)** of `docs/superpowers/specs/security-auth/2026-06-20-sso-domain-ownership-design.md`. The **admin UI is a separate follow-up plan** (out of scope here). Plan A (`sso:admin` permission + gating) is already merged.

## Global Constraints

- `sso_verified_domains` is RLS shape 1 (direct `org_id`): policy `USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id))`, ENABLE+FORCE in the creating migration. It is auto-discovered by `rls-coverage.integration.test.ts` (org_id column) — no allowlist entry needed, but a functional cross-org forge test is required.
- Migrations: idempotent (`CREATE TABLE IF NOT EXISTS`, `pg_policies` existence checks), `YYYY-MM-DD-<slug>.sql` sorting after the latest (`2026-06-25-sso-admin-permission-backfill.sql` from Plan A), no inner `BEGIN/COMMIT`, cleanup statements report row counts. Never edit a shipped migration.
- Pre-auth callback DB reads/writes run under `withSystemDbAccessContext` (the established SSO-callback pattern).
- New SSO domain routes are gated `requirePermission(PERMISSIONS.SSO_ADMIN.resource, PERMISSIONS.SSO_ADMIN.action)` + `requireMfa()` + `requireScope('organization','partner','system')`, org-scoped via `auth.canAccessOrg`.
- DNS: use `dns/promises` `resolveTxt` with a short timeout; resolution errors (NXDOMAIN/timeout) → not verified (fail-safe). The TXT lives at `_breeze-verify.<domain>` with value `breeze-domain-verify=<token>`.
- Enforcement is per-org: refuse only once the org has ≥1 verified domain, OR when `SSO_DOMAIN_VERIFICATION_STRICT` is on. Already-linked `(provider, sub)` logins are NEVER domain-checked.
- Node: prefix node commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.
- Integration/real-DB tests live in `src/__tests__/integration/*.integration.test.ts` (validated by CI's Integration Tests job; may not run locally without the breeze_app harness — don't get stuck running them).
- **Worktree discipline (a prior subagent committed to the wrong branch):** every implementer must `cd /Users/toddhebebrand/breeze/.claude/worktrees/sso-domain-verification-impl` first and verify `git rev-parse --show-toplevel` == that path and `git branch --show-current` == `worktree-sso-domain-verification-impl` before running anything; commit only on that branch; no `git pull/rebase/checkout/switch`.

---

### Task 1: `sso_verified_domains` schema + migration + RLS + seed

**Files:**
- Modify: `apps/api/src/db/schema/sso.ts` (add the `ssoVerifiedDomains` table near `ssoProviders`)
- Create: `apps/api/migrations/2026-06-26-sso-verified-domains.sql`
- Create: `apps/api/src/__tests__/integration/ssoVerifiedDomainsRls.integration.test.ts`

**Interfaces:**
- Produces: Drizzle `ssoVerifiedDomains` with columns `{ id, orgId, domain, verificationToken, verifiedAt, lastCheckedAt, createdBy, createdAt, updatedAt }`, consumed by Tasks 2/5/6.

- [ ] **Step 1: Add the Drizzle table** in `apps/api/src/db/schema/sso.ts` (after `ssoProviders`):

```ts
export const ssoVerifiedDomains = pgTable('sso_verified_domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  domain: varchar('domain', { length: 253 }).notNull(),
  verificationToken: varchar('verification_token', { length: 128 }).notNull(),
  verifiedAt: timestamp('verified_at'),
  lastCheckedAt: timestamp('last_checked_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  orgDomainUnique: uniqueIndex('sso_verified_domains_org_domain_idx').on(t.orgId, t.domain),
}));
```
(Ensure `uniqueIndex` is imported from `drizzle-orm/pg-core` in this file.)

- [ ] **Step 2: Write the migration** `apps/api/migrations/2026-06-26-sso-verified-domains.sql`:

```sql
-- Security review #2 (H-2, Plan B): org-scoped verified domains for SSO. An org
-- proves DNS ownership of a domain before SSO may provision/JIT-link an email in
-- it. RLS shape 1 (direct org_id). Idempotent.
CREATE TABLE IF NOT EXISTS sso_verified_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  domain varchar(253) NOT NULL,
  verification_token varchar(128) NOT NULL,
  verified_at timestamp,
  last_checked_at timestamp,
  created_by uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sso_verified_domains_org_domain_idx
  ON sso_verified_domains (org_id, domain);

ALTER TABLE sso_verified_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_verified_domains FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='sso_verified_domains' AND policyname='sso_verified_domains_org_isolation') THEN
    CREATE POLICY sso_verified_domains_org_isolation ON sso_verified_domains
      USING (public.breeze_has_org_access(org_id))
      WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
END $$;

-- Seed PENDING rows from existing providers' allowedDomains so admins see what
-- to verify. token = encode(gen_random_bytes(24),'hex'). Report the count.
DO $$
DECLARE n integer;
BEGIN
  INSERT INTO sso_verified_domains (org_id, domain, verification_token)
  SELECT DISTINCT p.org_id, lower(trim(d.domain)), encode(gen_random_bytes(24), 'hex')
  FROM sso_providers p
  CROSS JOIN LATERAL unnest(string_to_array(coalesce(p.allowed_domains, ''), ',')) AS d(domain)
  WHERE trim(d.domain) <> ''
  ON CONFLICT (org_id, domain) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'seeded % pending sso_verified_domains from allowed_domains', n; END IF;
END $$;
```

- [ ] **Step 3: Write the forge test** `apps/api/src/__tests__/integration/ssoVerifiedDomainsRls.integration.test.ts` — a cross-org INSERT as the breeze_app role must be rejected. Mirror an existing org-scoped forge test (find one under `src/__tests__/integration/` that does a cross-org insert and copy its harness; seed two orgs, set the request context to org A, attempt to insert a `sso_verified_domains` row for org B, expect an RLS rejection). Assert a verified-domain SELECT scoped to org A does not see org B's rows.

- [ ] **Step 4: Run drift + ordering + tsc**

Run: `cd /Users/toddhebebrand/breeze && export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift`
Expected: no drift (schema matches the migration).
Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/db/autoMigrate.test.ts` → PASS.
Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit` → 0 errors.
(The RLS forge test runs in CI's Integration Tests job; note if it can't run locally.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/sso.ts apps/api/migrations/2026-06-26-sso-verified-domains.sql apps/api/src/__tests__/integration/ssoVerifiedDomainsRls.integration.test.ts
git commit -m "feat(security): sso_verified_domains table + RLS + seed (review #2 H-2 Plan B)"
```

---

### Task 2: Domain-verification service

**Files:**
- Create: `apps/api/src/services/ssoDomainVerification.ts`
- Test: `apps/api/src/services/ssoDomainVerification.test.ts`

**Interfaces:**
- Consumes: `ssoVerifiedDomains` (Task 1), `db`, `withSystemDbAccessContext`.
- Produces:
  - `normalizeDomain(input: string): string | null` — lowercase, trim, strip trailing dot; null if invalid (no dot, contains `@`, empty).
  - `createPendingDomain(orgId: string, domain: string, userId: string | null): Promise<{ id: string; domain: string; token: string; recordName: string }>` — inserts a pending row (token = 24 random bytes hex), returns the TXT instruction (`recordName = _breeze-verify.<domain>`, value `breeze-domain-verify=<token>`).
  - `verifyDomain(orgId: string, domainId: string): Promise<{ verified: boolean }>` — resolves TXT at `_breeze-verify.<domain>`; if any record equals `breeze-domain-verify=<token>`, stamp `verifiedAt` + `lastCheckedAt`; else leave pending (still stamp `lastCheckedAt`).
  - `isDomainVerifiedForOrg(orgId: string, emailDomain: string): Promise<boolean>` — true iff a row for `(orgId, emailDomain)` has `verifiedAt` not null.
  - `orgHasAnyVerifiedDomain(orgId: string): Promise<boolean>` — true iff the org has ≥1 verified row.

- [ ] **Step 1: Write the failing tests** `apps/api/src/services/ssoDomainVerification.test.ts` — mock `dns/promises` `resolveTxt` and the db. Cover:
  - `normalizeDomain`: `'Corp.com '`→`'corp.com'`; `'a@b'`→null; `'nodot'`→null; `''`→null.
  - `verifyDomain`: resolveTxt returns `[['breeze-domain-verify=TOKEN']]` → verified true (and `verifiedAt` set); returns `[['other']]` → verified false; resolveTxt throws (NXDOMAIN) → verified false (fail-safe).
  - `isDomainVerifiedForOrg` / `orgHasAnyVerifiedDomain`: true when a verified row exists, false otherwise.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('dns/promises', () => ({ resolveTxt: vi.fn() }));
// ...mock '../db' (db.select/insert/update chains) + './redis' if needed...
import { resolveTxt } from 'dns/promises';
import { normalizeDomain /*, verifyDomain, ... */ } from './ssoDomainVerification';

describe('normalizeDomain', () => {
  it('lowercases and trims', () => { expect(normalizeDomain(' Corp.com ')).toBe('corp.com'); });
  it('rejects invalid', () => { expect(normalizeDomain('a@b')).toBeNull(); expect(normalizeDomain('nodot')).toBeNull(); expect(normalizeDomain('')).toBeNull(); });
});
// + verifyDomain match / no-match / dns-error cases using vi.mocked(resolveTxt)
```
(Define the db mock so `verifyDomain` reads the pending row's token and updates it; assert the update is called with `verifiedAt` set on match and not on no-match. Adjust to the real chain shapes.)

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ssoDomainVerification.test.ts` → FAIL (module/functions missing).

- [ ] **Step 3: Implement `apps/api/src/services/ssoDomainVerification.ts`:**

```ts
import { randomBytes } from 'crypto';
import { resolveTxt } from 'dns/promises';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { ssoVerifiedDomains } from '../db/schema';

const TXT_PREFIX = 'breeze-domain-verify=';
const RESOLVE_TIMEOUT_MS = 5000;

export function normalizeDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/\.$/, '');
  if (!d || d.includes('@') || !d.includes('.') || /\s/.test(d)) return null;
  return d;
}

export async function createPendingDomain(orgId: string, domain: string, userId: string | null) {
  const normalized = normalizeDomain(domain);
  if (!normalized) throw new Error('invalid domain');
  const token = randomBytes(24).toString('hex');
  const [row] = await withSystemDbAccessContext(async () =>
    db.insert(ssoVerifiedDomains).values({ orgId, domain: normalized, verificationToken: token, createdBy: userId }).returning()
  );
  return { id: row.id, domain: normalized, token, recordName: `_breeze-verify.${normalized}` };
}

async function resolveTxtSafe(name: string): Promise<string[]> {
  try {
    const records = (await Promise.race([
      resolveTxt(name),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dns timeout')), RESOLVE_TIMEOUT_MS)),
    ])) as string[][];
    return records.map((chunks) => chunks.join(''));
  } catch {
    return [];
  }
}

export async function verifyDomain(orgId: string, domainId: string): Promise<{ verified: boolean }> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(ssoVerifiedDomains)
      .where(and(eq(ssoVerifiedDomains.id, domainId), eq(ssoVerifiedDomains.orgId, orgId))).limit(1);
    if (!row) return { verified: false };
    const txts = await resolveTxtSafe(`_breeze-verify.${row.domain}`);
    const verified = txts.includes(`${TXT_PREFIX}${row.verificationToken}`);
    await db.update(ssoVerifiedDomains)
      .set({ verifiedAt: verified ? new Date() : row.verifiedAt, lastCheckedAt: new Date(), updatedAt: new Date() })
      .where(eq(ssoVerifiedDomains.id, row.id));
    return { verified };
  });
}

export async function isDomainVerifiedForOrg(orgId: string, emailDomain: string): Promise<boolean> {
  const normalized = normalizeDomain(emailDomain);
  if (!normalized) return false;
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select({ id: ssoVerifiedDomains.id }).from(ssoVerifiedDomains)
      .where(and(eq(ssoVerifiedDomains.orgId, orgId), eq(ssoVerifiedDomains.domain, normalized), isNotNull(ssoVerifiedDomains.verifiedAt)))
      .limit(1);
    return !!row;
  });
}

export async function orgHasAnyVerifiedDomain(orgId: string): Promise<boolean> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select({ id: ssoVerifiedDomains.id }).from(ssoVerifiedDomains)
      .where(and(eq(ssoVerifiedDomains.orgId, orgId), isNotNull(ssoVerifiedDomains.verifiedAt))).limit(1);
    return !!row;
  });
}
```

- [ ] **Step 4: Run, expect PASS + tsc** — `npx vitest run src/services/ssoDomainVerification.test.ts` → PASS; `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ssoDomainVerification.ts apps/api/src/services/ssoDomainVerification.test.ts
git commit -m "feat(security): SSO domain-verification service (review #2 H-2 Plan B)"
```

---

### Task 3: `sso:admin`-gated domain CRUD routes

**Files:**
- Modify: `apps/api/src/routes/sso.ts` (add 4 routes; reuse the `resolveOrgIdForProviderRoute`/`canAccessOrg` org-scoping helpers already in the file)
- Test: `apps/api/src/routes/sso.test.ts`

**Interfaces:**
- Consumes: the Task 2 service.
- Produces: `POST /sso/domains` `{ orgId?, domain }` → `{ id, domain, recordName, token }`; `POST /sso/domains/:id/verify` → `{ verified }`; `GET /sso/domains?orgId=` → list; `DELETE /sso/domains/:id` → `{ ok: true }`. All `requireScope` + `requirePermission(SSO_ADMIN)` + `requireMfa()`, org-scoped.

- [ ] **Step 1: Write failing tests** in `apps/api/src/routes/sso.test.ts`: (a) the new domain routes are registered with the `sso:admin` guard (extend the existing `recordedPermissionGuards` assertion to confirm domain routes are covered — they share the gate); (b) `POST /sso/domains` returns the TXT instruction for a valid domain; (c) a domain in another org cannot be verified/deleted (org-scoping → 403/404). Mock the Task 2 service functions.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement the 4 routes** in `apps/api/src/routes/sso.ts` (place near the provider routes; import the service + a `domainBodySchema = z.object({ orgId: z.string().guid().optional(), domain: z.string().min(1).max(253) })` and a param schema). Each handler resolves the org (reuse `resolveOrgIdForProviderRoute` or the same `canAccessOrg` pattern the provider routes use), then calls the service. `verify`/`DELETE` first load the row scoped to the resolved org (404 if not in the caller's org). Use `withSystemDbAccessContext` for the DELETE/list DB ops consistent with the file's pre-auth/system-scope handling where applicable (these routes ARE authed, so request-scope `db` is fine for list/delete — match how the provider routes query).

- [ ] **Step 4: Run, expect PASS + tsc + whole sso.test file.**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/sso.ts apps/api/src/routes/sso.test.ts
git commit -m "feat(security): sso:admin-gated domain CRUD routes (review #2 H-2 Plan B)"
```

---

### Task 4: `SSO_DOMAIN_VERIFICATION_STRICT` env flag

**Files:**
- Modify: `apps/api/src/config/validate.ts` (add to the env schema near the other optional flags)
- Create or modify: a small reader (follow the `isHosted()` pattern) — add `export function isSsoDomainVerificationStrict(): boolean` somewhere sensible (e.g. a new `apps/api/src/services/ssoConfig.ts`, or alongside the existing config readers).
- Test: a unit test for the reader (true/false/unset/garbage).

**Interfaces:**
- Produces: `isSsoDomainVerificationStrict(): boolean` (default false; true only for affirmative `1|true|yes|on`).

- [ ] **Step 1: Write the failing test** for `isSsoDomainVerificationStrict` — `'true'`/`'1'`→true; unset/`'false'`/garbage→false (toggle `process.env.SSO_DOMAIN_VERIFICATION_STRICT`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the reader + add `SSO_DOMAIN_VERIFICATION_STRICT: z.string().optional()` to the validate.ts env schema.
- [ ] **Step 4: Run, expect PASS + tsc.**
- [ ] **Step 5: Commit** `git commit -m "feat(security): SSO_DOMAIN_VERIFICATION_STRICT flag (review #2 H-2 Plan B)"`

---

### Task 5: Callback enforcement (the gate)

**Files:**
- Modify: `apps/api/src/routes/sso.ts` — the callback's `if (!user)` block (≈ line 1004, after the identity-first lookup, before the byEmail-JIT and autoProvision branches)
- Test: `apps/api/src/routes/sso.test.ts`

**Interfaces:**
- Consumes: `isDomainVerifiedForOrg`, `orgHasAnyVerifiedDomain` (Task 2), `isSsoDomainVerificationStrict` (Task 4), `writeRouteAudit`.

- [ ] **Step 1: Write failing tests** (extend the existing callback test helpers `primeCallback`/`wireLinkedLogin`/`sel`): 
  - provision/link in a **verified** domain (org enforcing) → succeeds (302 ssoCode, createTokenPair called).
  - provision/link in an **unverified** domain with the org **enforcing** (orgHasAnyVerifiedDomain → true) → redirect `error=sso_domain_unverified`, createTokenPair NOT called.
  - same in **warn mode** (orgHasAnyVerifiedDomain → false, strict off) → allowed (302 ssoCode) + audit event written.
  - **already-linked** `(provider, sub)` login in an unverified domain → unaffected (succeeds, gate not consulted).
  (Mock `isDomainVerifiedForOrg`/`orgHasAnyVerifiedDomain`/`isSsoDomainVerificationStrict` per case.)

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement the gate.** In `apps/api/src/routes/sso.ts`, at the very top of the `if (!user) {` block (the branch entered only when no `(provider, sub)` link resolved), before the byEmail lookup:

```ts
    if (!user) {
      // security review #2 (H-2 Plan B): domain-ownership gate on the
      // provision / JIT-link path. Already-linked (provider, sub) users skip
      // this entirely (we're inside `if (!user)`). Enforce once the org has
      // verified a domain (or globally via SSO_DOMAIN_VERIFICATION_STRICT);
      // otherwise warn (allow + audit) so existing auto-provisioning orgs
      // aren't broken before they verify.
      const emailDomain = attrs.email.split('@')[1]?.toLowerCase() ?? '';
      const enforcing = isSsoDomainVerificationStrict() || await orgHasAnyVerifiedDomain(provider.orgId);
      const domainVerified = await isDomainVerifiedForOrg(provider.orgId, emailDomain);
      if (!domainVerified) {
        if (enforcing) {
          clearStateCookie();
          return c.redirect('/login?error=sso_domain_unverified');
        }
        // warn mode: allow, but record it so admins are nudged to verify.
        writeRouteAudit(c, {
          orgId: provider.orgId,
          action: 'sso.provision.unverified_domain',
          resourceType: 'sso_provider',
          resourceId: provider.id,
          details: { emailDomain, mode: 'warn' },
        });
      }
      // ...existing byEmail-JIT-link + autoProvision logic follows unchanged...
```
(Insert before the existing `const [byEmail] = ...` line; keep the rest of the block intact.)

- [ ] **Step 4: Run, expect PASS + tsc + whole sso.test file (54+ tests).**

- [ ] **Step 5: Commit** `git commit -m "feat(security): gate SSO provisioning/linking on verified domain (review #2 H-2 Plan B)"`

---

### Task 6: Daily re-check job

**Files:**
- Create: `apps/api/src/services/ssoDomainReverifyJob.ts` (or add to an existing worker module — follow `apps/api/src/services/warrantyWorker.ts`'s repeatable-job registration)
- Modify: wherever workers/schedulers are initialized (the same place `warrantyWorker` is registered)
- Test: `apps/api/src/services/ssoDomainReverifyJob.test.ts`

**Interfaces:**
- Consumes: `ssoVerifiedDomains`, `verifyDomain`-style TXT resolution, `writeAudit`/notification.
- Produces: a recurring job (cadence ~daily, jobId with `-` separators per the colon rule) that, for each `verifiedAt IS NOT NULL` domain, re-resolves the TXT, updates `last_checked_at`, and on a miss writes an audit event (action `sso.domain.txt_missing`) WITHOUT clearing `verifiedAt` (sticky).

- [ ] **Step 1: Write the failing test** — given a verified domain whose TXT now resolves empty, the re-check writes the drift audit and does NOT null `verifiedAt`; given a still-present TXT, it just updates `last_checked_at`. Mock dns + db + audit.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the job processor + registration (mirror `warrantyWorker.ts`). Sticky: never set `verifiedAt = null`.
- [ ] **Step 4: Run, expect PASS + tsc.**
- [ ] **Step 5: Commit** `git commit -m "feat(security): daily SSO domain re-check job (review #2 H-2 Plan B)"`

---

## Out of scope (this plan)
- **Admin UI** (verified-domains panel + warn banner in `apps/web`) — separate follow-up plan/PR (per the chosen scope).

## Self-Review
- **Spec coverage:** Tasks 1-6 cover the spec's Plan B backend: table+RLS+seed (T1), service (T2), routes (T3), env flag (T4), callback enforcement with warn/enforce rollout (T5), re-check job (T6). Admin UI deferred by decision.
- **Placeholders:** code shown for the load-bearing pieces (schema, migration, service, gate). T3/T6 describe routes/job concretely with exact signatures + templates to mirror (`warrantyWorker`, existing provider routes); no "TODO/handle edge cases".
- **Type consistency:** service function names/signatures in T2 match their uses in T3 (CRUD) and T5 (`isDomainVerifiedForOrg`, `orgHasAnyVerifiedDomain`) and T4 (`isSsoDomainVerificationStrict`). `ssoVerifiedDomains` columns (T1) match the service queries (T2).
